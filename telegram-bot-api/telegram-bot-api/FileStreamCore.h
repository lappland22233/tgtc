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

td::Result<FileStreamRoute> parse_file_stream_route(td::Slice path);
td::Result<td::int64> parse_file_stream_size_hint(td::Slice value);
bool parse_file_stream_no_cache(td::Slice value);
td::Result<td::int64> resolve_file_stream_size(td::int64 tdlib_size, td::int64 expected_size);
// Returns true if peer_address is allowed to use the file streaming endpoint under the given
// comma-separated --file-stream-allow-ip allowlist (empty = loopback/private networks only).
bool is_file_stream_ip_allowed(const td::IPAddress &peer_address, td::Slice allow_ip);

}  // namespace telegram_bot_api
