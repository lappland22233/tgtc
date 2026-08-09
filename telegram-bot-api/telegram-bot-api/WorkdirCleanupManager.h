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
