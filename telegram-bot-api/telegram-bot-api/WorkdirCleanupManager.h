//
// Copyright Aliaksei Levin (levlam@telegram.org), Arseny Smirnov (arseny30@gmail.com) 2014-2025
//
// Distributed under the Boost Software License, Version 1.0.
//
#pragma once

#include "td/actor/actor.h"
#include "td/utils/common.h"
#include "td/utils/Slice.h"

#include <functional>
#include <unordered_map>

namespace telegram_bot_api {

struct SharedData;

// Minimum free space (in bytes) that must remain after the configured --workdir-min-free-bytes
// before a download whose exact size is still unknown may create a new local copy. A download with
// a known size is checked against its exact expected increment instead; this margin only covers the
// files whose size TDLib has not reported yet (for example a cold remote file whose first
// downloadFile response is still pending).
constexpr td::int64 DEFAULT_WORKDIR_UNKNOWN_FILE_MIN_FREE_BYTES = 512LL << 20;

struct WorkdirCleanupConfig {
  td::string workdir;
  td::int64 threshold_bytes = 20LL << 30;
  td::int64 target_bytes = 15LL << 30;
  double interval = 3600.0;
  td::int64 file_ttl = 86400;
  td::int64 min_free_bytes = 1LL << 30;
};

struct WorkdirCleanupResult {
  td::int64 scanned_bytes = 0;
  td::int64 scanned_files = 0;
  td::int64 deleted_bytes = 0;
  td::int64 deleted_files = 0;
  td::int64 failed_files = 0;
  td::int64 free_bytes = -1;
  bool threshold_cleanup = false;
  bool disk_emergency = false;
};

using WorkdirDeleteFunction = std::function<bool(const td::string &)>;

// Decision of the pre-write workdir space admission check (see check_workdir_space).
struct WorkdirSpaceCheck {
  // true only when a new local copy may be created.
  bool allowed = false;
  // false when the free space could not be determined; the check then fails closed (allowed=false).
  bool free_space_known = false;
  // true when the download size was unknown and the conservative margin was used.
  bool unknown_size = false;
  // free bytes available on the filesystem, or -1 when unknown.
  td::int64 free_bytes = -1;
  // configured minimum free space that must always remain.
  td::int64 min_free_bytes = 0;
  // free space that must remain after the expected increment (min_free_bytes + increment_bytes).
  td::int64 required_bytes = 0;
  // expected number of bytes the new local copy will add (max(0, size - existing local copy size)).
  td::int64 increment_bytes = 0;
};

// Returns the number of free bytes on the filesystem holding workdir, or -1 if it cannot be
// determined. Callers must treat -1 as "not enough space" (fail closed).
td::int64 get_workdir_free_bytes(td::Slice workdir);

// Pure pre-write admission policy used before starting to write a new local copy of a file.
// file_size is the exact size in bytes, or a negative value when it is unknown; existing_local_size
// is the size of an already present local copy (0 if none). free_bytes < 0 means the disk
// information could not be obtained and is treated as "not enough space" (fail closed).
WorkdirSpaceCheck check_workdir_space(td::int64 free_bytes, td::int64 min_free_bytes, td::int64 file_size,
                                      td::int64 existing_local_size, td::int64 unknown_size_margin);

bool is_workdir_cleanup_candidate(td::Slice workdir, td::Slice path);
bool delete_workdir_file_with_retries(const td::string &path, const WorkdirDeleteFunction &delete_file,
                                      td::int32 max_retries = 3);
WorkdirCleanupResult run_workdir_cleanup(const WorkdirCleanupConfig &config,
                                         const std::unordered_map<td::string, td::int32> &active_files,
                                         const WorkdirDeleteFunction &delete_file = {});

class WorkdirCleanupManager final : public td::Actor {
 public:
  WorkdirCleanupManager(WorkdirCleanupConfig config, std::shared_ptr<SharedData> shared_data)
      : config_(std::move(config)), shared_data_(std::move(shared_data)) {
  }

  void retain_file(td::string path);
  void release_file(td::string path);
  void trigger_threshold_check();

 private:
  WorkdirCleanupConfig config_;
  std::shared_ptr<SharedData> shared_data_;
  std::unordered_map<td::string, td::int32> active_files_;
  double next_periodic_cleanup_ = 0.0;
  double next_threshold_check_ = 0.0;

  void start_up() final;
  void timeout_expired() final;
  void run_cleanup(bool periodic);
  void schedule_next();
};

}  // namespace telegram_bot_api
