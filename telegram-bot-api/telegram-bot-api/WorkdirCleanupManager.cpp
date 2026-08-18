//
// Copyright Aliaksei Levin (levlam@telegram.org), Arseny Smirnov (arseny30@gmail.com) 2014-2025
//
// Distributed under the Boost Software License, Version 1.0.
//
#include "telegram-bot-api/WorkdirCleanupManager.h"

#ifndef WORKDIR_CLEANUP_CORE_ONLY
#include "telegram-bot-api/ClientParameters.h"
#endif

#include "td/utils/logging.h"
#include "td/utils/misc.h"
#include "td/utils/PathView.h"
#include "td/utils/port/path.h"
#include "td/utils/port/Stat.h"
#include "td/utils/Time.h"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <system_error>

namespace telegram_bot_api {
namespace {

// G16-09: minimum interval between non-periodic full-workdir scans. A full walk+stat over a large
// workdir is expensive, so the threshold re-check is throttled to this value instead of firing
// every 60s.
constexpr double THRESHOLD_CHECK_INTERVAL = 300.0;

struct Candidate {
  td::string path;
  td::int64 size;
  td::uint64 access_time;
};

bool default_delete_file(const td::string &path) {
  return td::unlink(path).is_ok();
}

td::int64 get_free_space(td::Slice path) {
  std::error_code error;
  auto info = std::filesystem::space(std::filesystem::u8path(path.str()), error);
  if (error || info.available > static_cast<std::uintmax_t>(std::numeric_limits<td::int64>::max())) {
    return -1;
  }
  return static_cast<td::int64>(info.available);
}

// TDLib keeps its per-bot session, binlog and SQLite state files directly inside
// the bot subdirectory of the workdir. These are live database/control files, not
// media cache: removing them (POSIX permits deleting an open file) corrupts the bot
// session and can race with binlog rotation, which aborts the service. Media cache
// files never use these names/suffixes.
bool is_tdlib_persistent_file(td::Slice path) {
  auto file_name = td::PathView(path).file_name();
  if (file_name.empty()) {
    return false;
  }
  if (td::ends_with(file_name, ".binlog") || td::ends_with(file_name, ".binlog.new")) {
    return true;
  }
  return td::ends_with(file_name, ".sqlite") || td::ends_with(file_name, ".sqlite-wal") ||
         td::ends_with(file_name, ".sqlite-shm") || td::ends_with(file_name, ".sqlite-journal");
}

}  // namespace

bool is_workdir_cleanup_candidate(td::Slice workdir, td::Slice path) {
  if (workdir.empty() || path.empty()) {
    return false;
  }
  auto root = workdir.str();
  if (root.back() != TD_DIR_SLASH) {
    root += TD_DIR_SLASH;
  }
  auto candidate = path.str();
  if (!td::begins_with(candidate, root) || candidate == root) {
    return false;
  }
  auto relative = td::Slice(candidate).substr(root.size()).str();
  if (relative.find("..") != td::string::npos) {
    return false;
  }
  // Never treat live TDLib session/binlog/database files as cache candidates.
  if (is_tdlib_persistent_file(candidate)) {
    return false;
  }
  return true;
}

bool delete_workdir_file_with_retries(const td::string &path, const WorkdirDeleteFunction &delete_file,
                                      td::int32 max_retries) {
  auto function = delete_file ? delete_file : WorkdirDeleteFunction(default_delete_file);
  for (td::int32 attempt = 0; attempt <= max_retries; attempt++) {
    if (function(path)) {
      return true;
    }
  }
  return false;
}

WorkdirCleanupResult run_workdir_cleanup(const WorkdirCleanupConfig &config,
                                         const std::unordered_map<td::string, td::int32> &active_files,
                                         const WorkdirDeleteFunction &delete_file) {
  WorkdirCleanupResult result;
  td::vector<Candidate> candidates;
  auto now_nsec = static_cast<td::uint64>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                              std::chrono::system_clock::now().time_since_epoch())
                                              .count());
  auto status = td::walk_path(config.workdir, [&](td::CSlice path, td::WalkPath::Type type) {
    if (type != td::WalkPath::Type::RegularFile || !is_workdir_cleanup_candidate(config.workdir, path)) {
      return td::WalkPath::Action::Continue;
    }
    auto stat = td::stat(path);
    if (stat.is_error() || !stat.ok().is_reg_) {
      return td::WalkPath::Action::Continue;
    }
    result.scanned_files++;
    result.scanned_bytes += td::max<td::int64>(0, stat.ok().size_);
    auto path_string = path.str();
    auto active = active_files.find(path_string);
    if (active == active_files.end() || active->second <= 0) {
      candidates.push_back({std::move(path_string), td::max<td::int64>(0, stat.ok().size_), stat.ok().atime_nsec_});
    }
    return td::WalkPath::Action::Continue;
  });
  if (status.is_error()) {
    LOG(ERROR) << "Failed to scan Telegram workdir: " << status;
  }

  result.threshold_cleanup = config.threshold_bytes > 0 && result.scanned_bytes >= config.threshold_bytes;
  std::sort(candidates.begin(), candidates.end(), [](const Candidate &left, const Candidate &right) {
    return left.access_time < right.access_time;
  });
  auto remaining = result.scanned_bytes;
  auto ttl_nsec = config.file_ttl > 0 ? static_cast<td::uint64>(config.file_ttl) * 1000000000ULL : 0;
  for (const auto &candidate : candidates) {
    auto must_reduce = result.threshold_cleanup && remaining > config.target_bytes;
    auto expired = ttl_nsec > 0 && candidate.access_time <= now_nsec && now_nsec - candidate.access_time >= ttl_nsec;
    if (!must_reduce && !expired) {
      continue;
    }
    auto active = active_files.find(candidate.path);
    if (active != active_files.end() && active->second > 0) {
      continue;
    }
    if (!delete_workdir_file_with_retries(candidate.path, delete_file, 3)) {
      result.failed_files++;
      break;
    }
    result.deleted_files++;
    result.deleted_bytes += candidate.size;
    remaining -= candidate.size;
  }
  result.free_bytes = get_free_space(config.workdir);
  result.disk_emergency = config.min_free_bytes > 0 && result.free_bytes >= 0 && result.free_bytes < config.min_free_bytes;
  return result;
}

#ifndef WORKDIR_CLEANUP_CORE_ONLY
void WorkdirCleanupManager::retain_file(td::string path) {
  if (is_workdir_cleanup_candidate(config_.workdir, path)) {
    active_files_[std::move(path)]++;
  }
}

void WorkdirCleanupManager::release_file(td::string path) {
  auto it = active_files_.find(path);
  if (it == active_files_.end()) {
    return;
  }
  if (--it->second <= 0) {
    active_files_.erase(it);
  }
}

void WorkdirCleanupManager::trigger_threshold_check() {
  run_cleanup(false);
}

void WorkdirCleanupManager::start_up() {
  auto now = td::Time::now();
  next_periodic_cleanup_ = now;
  next_threshold_check_ = now;
  schedule_next();
}

void WorkdirCleanupManager::timeout_expired() {
  auto now = td::Time::now();
  auto periodic = now >= next_periodic_cleanup_;
  run_cleanup(periodic);
  if (periodic) {
    next_periodic_cleanup_ = now + config_.interval;
  }
  // G16-09: every full scan is a walk + stat over the whole workdir, which is expensive on large
  // directories. The non-periodic threshold re-check no longer runs every 60s; it is throttled to
  // THRESHOLD_CHECK_INTERVAL (5 minutes) so a large directory is scanned far less often. The
  // periodic scan (config_.interval, default 1h) still performs the authoritative cleanup.
  next_threshold_check_ = now + td::min(THRESHOLD_CHECK_INTERVAL, config_.interval);
  schedule_next();
}

void WorkdirCleanupManager::run_cleanup(bool periodic) {
  auto result = run_workdir_cleanup(config_, active_files_);
  shared_data_->workdir_bytes_.store(result.scanned_bytes, std::memory_order_relaxed);
  shared_data_->workdir_files_.store(result.scanned_files, std::memory_order_relaxed);
  shared_data_->workdir_cleanup_runs_.fetch_add(1, std::memory_order_relaxed);
  shared_data_->workdir_deleted_bytes_.fetch_add(result.deleted_bytes, std::memory_order_relaxed);
  LOG(INFO) << "Telegram workdir cleanup" << td::tag("periodic", periodic)
            << td::tag("threshold", result.threshold_cleanup) << td::tag("bytes", result.scanned_bytes)
            << td::tag("files", result.scanned_files) << td::tag("deleted_bytes", result.deleted_bytes)
            << td::tag("deleted_files", result.deleted_files) << td::tag("failed_files", result.failed_files)
            << td::tag("free_bytes", result.free_bytes);
  if (result.disk_emergency) {
    shared_data_->workdir_disk_emergency_.store(true, std::memory_order_release);
    shared_data_->workdir_shutdown_requested_.store(true, std::memory_order_release);
    LOG(ERROR) << "Telegram workdir disk space exhausted; service is shutting down"
               << td::tag("free_bytes", result.free_bytes) << td::tag("minimum_free_bytes", config_.min_free_bytes);
  }
}

void WorkdirCleanupManager::schedule_next() {
  set_timeout_at(td::min(next_periodic_cleanup_, next_threshold_check_));
}
#endif

}  // namespace telegram_bot_api
