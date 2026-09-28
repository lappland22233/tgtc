//
// Distributed under the Boost Software License, Version 1.0.
//
#pragma once

#include "td/utils/common.h"
#include "td/utils/port/IPAddress.h"
#include "td/utils/Slice.h"
#include "td/utils/Status.h"

namespace telegram_bot_api {

struct FileStreamCursor {
  td::int64 total_size = -1;
  td::int64 next_offset = 0;
  td::int64 contiguous_end = 0;

  td::Status update_progress(td::int64 download_offset, td::int64 downloaded_prefix_size, bool is_completed);
  td::int64 next_read_size(td::int64 chunk_size) const;
  td::Status commit(td::int64 offset, td::int64 size);
  bool is_complete() const {
    return total_size >= 0 && next_offset == total_size;
  }
};

struct FileStreamRoute {
  td::string token;
  td::string file_id;
  bool is_test_dc = false;
  td::int64 expected_size = -1;
  bool no_cache = false;
};

/**
 * What to do with the TDLib local copy after a file stream ends.
 *
 * Pure decision (no side effects) so that it can be unit-tested directly; the caller performs the
 * action and records the matching counter.
 */
enum class FileStreamLocalCopyAction {
  /** Nothing to do: the caller did not ask for removal, or the file is already gone. */
  none,
  /** Issue deleteFile: no other listener holds a reference to the local copy. */
  delete_local_copy,
  /** The stream did not complete, so the copy must be kept: only cancel the pending download. */
  cancel_download,
  /**
   * A concurrent getFile download still holds the copy, so it cannot be deleted now; the copy is
   * left to the workdir TTL cleanup. Reported explicitly so the skip is observable instead of
   * silently inflating workdir usage.
   */
  skip_busy,
};

struct FileStreamLocalCopyDecisionInput {
  /** The caller passed X-Telegram-No-Cache. */
  bool remove_requested = false;
  /** The stream finished normally (no abort/timeout). */
  bool completed_ok = false;
  /** Another file stream still listens to the same file. */
  bool other_stream_listeners = false;
  /** A standard getFile download is currently using the same local copy. */
  bool download_listener_active = false;
};

FileStreamLocalCopyAction decide_file_stream_local_copy_action(const FileStreamLocalCopyDecisionInput &input);

td::Result<FileStreamRoute> parse_file_stream_route(td::Slice path);
td::Result<td::int64> parse_file_stream_size_hint(td::Slice value);
bool parse_file_stream_no_cache(td::Slice value);
td::Result<td::int64> resolve_file_stream_size(td::int64 tdlib_size, td::int64 expected_size);
// Returns true if peer_address is allowed to use the file streaming endpoint under the given
// comma-separated --file-stream-allow-ip allowlist (empty = loopback/private networks only).
bool is_file_stream_ip_allowed(const td::IPAddress &peer_address, td::Slice allow_ip);

}  // namespace telegram_bot_api
