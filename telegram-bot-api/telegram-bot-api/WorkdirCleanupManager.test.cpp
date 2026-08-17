//
// Copyright Aliaksei Levin (levlam@telegram.org), Arseny Smirnov (arseny30@gmail.com) 2014-2025
//
// Distributed under the Boost Software License, Version 1.0.
//
#include "telegram-bot-api/WorkdirCleanupManager.h"

#include "td/utils/filesystem.h"
#include "td/utils/port/path.h"
#include "td/utils/tests.h"

#include <unordered_map>

namespace {

struct TempWorkdir {
  td::string path;

  TempWorkdir() {
    path = td::mkdtemp(td::get_temporary_dir(), "telegram-workdir-test-").move_as_ok();
    if (path.back() != TD_DIR_SLASH) {
      path += TD_DIR_SLASH;
    }
  }
  ~TempWorkdir() {
    td::rmrf(path).ignore();
  }

  td::string file(td::Slice name, td::Slice content) const {
    auto result = path + name.str();
    td::write_file(result, content).ensure();
    return result;
  }
};

telegram_bot_api::WorkdirCleanupConfig config_for(const TempWorkdir &dir) {
  telegram_bot_api::WorkdirCleanupConfig config;
  config.workdir = dir.path;
  config.threshold_bytes = 1;
  config.target_bytes = 0;
  config.interval = 60;
  config.file_ttl = 0;
  config.min_free_bytes = 1;
  return config;
}

}  // namespace

TEST(WorkdirCleanup, RejectsEscapingPaths) {
  TempWorkdir dir;
  ASSERT_TRUE(telegram_bot_api::is_workdir_cleanup_candidate(dir.path, dir.path + "bot/files/a"));
  ASSERT_FALSE(telegram_bot_api::is_workdir_cleanup_candidate(dir.path, dir.path));
  ASSERT_FALSE(telegram_bot_api::is_workdir_cleanup_candidate(dir.path, dir.path + "../outside"));
  ASSERT_FALSE(telegram_bot_api::is_workdir_cleanup_candidate(dir.path, "outside"));
}

TEST(WorkdirCleanup, RetriesDeletionThreeTimesThenSucceeds) {
  td::int32 attempts = 0;
  ASSERT_TRUE(telegram_bot_api::delete_workdir_file_with_retries(
      "candidate", [&](const td::string &) { return ++attempts == 4; }, 3));
  ASSERT_EQ(4, attempts);
}

TEST(WorkdirCleanup, StopsRoundAfterFourFailedAttempts) {
  TempWorkdir dir;
  dir.file("a", "aaaa");
  dir.file("b", "bbbb");
  td::int32 attempts = 0;
  auto result = telegram_bot_api::run_workdir_cleanup(
      config_for(dir), {}, [&](const td::string &) {
        attempts++;
        return false;
      });
  ASSERT_EQ(4, attempts);
  ASSERT_EQ(1, result.failed_files);
  ASSERT_EQ(0, result.deleted_files);
}

TEST(WorkdirCleanup, SkipsActiveFileUntilNextRound) {
  TempWorkdir dir;
  auto active = dir.file("active", "active-data");
  auto idle = dir.file("idle", "idle-data");
  std::unordered_map<td::string, td::int32> active_files{{active, 1}};
  auto first = telegram_bot_api::run_workdir_cleanup(config_for(dir), active_files);
  ASSERT_EQ(1, first.deleted_files);
  ASSERT_TRUE(td::stat(active).is_ok());
  ASSERT_TRUE(td::stat(idle).is_error());

  auto second = telegram_bot_api::run_workdir_cleanup(config_for(dir), {});
  ASSERT_EQ(1, second.deleted_files);
  ASSERT_TRUE(td::stat(active).is_error());
}

TEST(WorkdirCleanup, ThresholdDoesNotRejectOrDeleteActiveFile) {
  TempWorkdir dir;
  auto active = dir.file("active", "0123456789");
  auto config = config_for(dir);
  config.threshold_bytes = 5;
  config.target_bytes = 1;
  auto result = telegram_bot_api::run_workdir_cleanup(config, {{active, 2}});
  ASSERT_TRUE(result.threshold_cleanup);
  ASSERT_EQ(0, result.deleted_files);
  ASSERT_TRUE(td::stat(active).is_ok());
}

TEST(WorkdirCleanup, PersistentFilesAreNotCandidates) {
  TempWorkdir dir;
  ASSERT_FALSE(telegram_bot_api::is_workdir_cleanup_candidate(dir.path, dir.path + "td.binlog"));
  ASSERT_FALSE(telegram_bot_api::is_workdir_cleanup_candidate(dir.path, dir.path + "td_test.binlog"));
  ASSERT_FALSE(telegram_bot_api::is_workdir_cleanup_candidate(dir.path, dir.path + "td.binlog.new"));
  ASSERT_FALSE(telegram_bot_api::is_workdir_cleanup_candidate(dir.path, dir.path + "db.sqlite"));
  ASSERT_FALSE(telegram_bot_api::is_workdir_cleanup_candidate(dir.path, dir.path + "db.sqlite-wal"));
  ASSERT_FALSE(telegram_bot_api::is_workdir_cleanup_candidate(dir.path, dir.path + "db.sqlite-shm"));
  ASSERT_FALSE(telegram_bot_api::is_workdir_cleanup_candidate(dir.path, dir.path + "db.sqlite-journal"));
  ASSERT_TRUE(telegram_bot_api::is_workdir_cleanup_candidate(dir.path, dir.path + "bot/files/a"));
  ASSERT_TRUE(telegram_bot_api::is_workdir_cleanup_candidate(dir.path, dir.path + "photo.jpg"));
}

TEST(WorkdirCleanup, ProtectsTdlibPersistentFilesWhileCleaningMedia) {
  TempWorkdir dir;
  auto photo = dir.file("photo.jpg", "media-bytes");
  auto binlog = dir.file("td.binlog", "binlog-bytes");
  auto binlog_new = dir.file("td.binlog.new", "binlog-new-bytes");
  auto sqlite = dir.file("db.sqlite", "sqlite-bytes");
  auto sqlite_wal = dir.file("db.sqlite-wal", "wal-bytes");
  auto sqlite_shm = dir.file("db.sqlite-shm", "shm-bytes");

  auto result = telegram_bot_api::run_workdir_cleanup(config_for(dir), {});
  ASSERT_EQ(1, result.deleted_files);
  ASSERT_TRUE(td::stat(photo).is_error());
  ASSERT_TRUE(td::stat(binlog).is_ok());
  ASSERT_TRUE(td::stat(binlog_new).is_ok());
  ASSERT_TRUE(td::stat(sqlite).is_ok());
  ASSERT_TRUE(td::stat(sqlite_wal).is_ok());
  ASSERT_TRUE(td::stat(sqlite_shm).is_ok());
}
