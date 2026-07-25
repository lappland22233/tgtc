//
// Copyright Aliaksei Levin (levlam@telegram.org), Arseny Smirnov (arseny30@gmail.com) 2014-2025
//
// Distributed under the Boost Software License, Version 1.0. (See accompanying
// file LICENSE_1_0.txt or copy at http://www.boost.org/LICENSE_1_0.txt)
//
#pragma once

#include "td/net/HttpInboundConnection.h"

#include "td/actor/actor.h"

#include "td/utils/buffer.h"
#include "td/utils/common.h"
#include "td/utils/port/FileFd.h"
#include "td/utils/port/IPAddress.h"
#include "td/utils/Slice.h"
#include "td/utils/Status.h"

#include <memory>

namespace telegram_bot_api {

class Client;
class ClientManager;

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

struct FileStreamConfig {
  bool enabled = false;
  td::int64 chunk_size = 256 << 10;
  td::int32 max_connections = 100;
  double first_byte_timeout = 30.0;
  double idle_timeout = 60.0;
  td::int64 write_high_watermark = 1 << 20;
};

struct FileStreamRoute {
  td::string token;
  td::string file_id;
  bool is_test_dc = false;
  td::int64 expected_size = -1;
};

td::Result<FileStreamRoute> parse_file_stream_route(td::Slice path);
td::Result<td::int64> parse_file_stream_size_hint(td::Slice value);
td::Result<td::int64> resolve_file_stream_size(td::int64 tdlib_size, td::int64 expected_size);

class FileStreamConnection final : public td::Actor {
 public:
  FileStreamConnection(td::ActorOwn<td::HttpInboundConnection> connection, td::ActorId<ClientManager> client_manager,
                       FileStreamRoute route, FileStreamConfig config, td::IPAddress peer_address);

  void set_client(td::ActorId<Client> client);
  void on_file_ready(td::int32 file_id, td::int64 total_size, td::string local_path,
                     td::int64 download_offset, td::int64 downloaded_prefix_size,
                     bool is_completed, bool is_downloading_active);
  void on_file_progress(td::int64 reported_total_size, td::string local_path,
                        td::int64 download_offset, td::int64 downloaded_prefix_size,
                        bool is_completed, bool is_downloading_active);
  void on_file_data(td::int64 offset, td::Result<td::BufferSlice> result);
  void on_file_error(td::Status error);

  td::int64 next_offset() const {
    return cursor_.next_offset;
  }

 private:
  td::int64 stream_id_ = 0;
  td::ActorOwn<td::HttpInboundConnection> connection_;
  td::ActorId<ClientManager> client_manager_;
  td::ActorId<Client> client_;
  FileStreamRoute route_;
  FileStreamConfig config_;
  td::IPAddress peer_address_;

  td::int32 file_id_ = 0;
  td::string local_path_;
  td::FileFd local_file_;
  FileStreamCursor cursor_;
  bool headers_sent_ = false;
  bool read_in_flight_ = false;
  bool write_in_flight_ = false;
  bool download_completed_ = false;
  bool first_byte_sent_ = false;
  td::int64 pending_write_offset_ = -1;
  td::int64 pending_write_size_ = 0;
  bool finished_ = false;

  void start_up() final;
  void timeout_expired() final;
  void tear_down() final;
  void try_read();
  void on_chunk_flushed(td::Result<td::Unit> result);
  void send_headers();
  void finish();
  void fail(int http_status_code, td::Slice message);
  void abort(td::Status error);
};

}  // namespace telegram_bot_api
