//
// Copyright Aliaksei Levin (levlam@telegram.org), Arseny Smirnov (arseny30@gmail.com) 2014-2025
//
// Distributed under the Boost Software License, Version 1.0. (See accompanying
// file LICENSE_1_0.txt or copy at http://www.boost.org/LICENSE_1_0.txt)
//
#include "telegram-bot-api/FileStream.h"

#include "telegram-bot-api/Client.h"
#include "telegram-bot-api/ClientManager.h"
#include "telegram-bot-api/Query.h"

#include "td/net/HttpHeaderCreator.h"

#include "td/utils/JsonBuilder.h"
#include "td/utils/logging.h"
#include "td/utils/Promise.h"
#include "td/utils/SliceBuilder.h"

#include <atomic>

namespace telegram_bot_api {
namespace {

std::atomic<td::int64> next_file_stream_id{1};

}  // namespace

FileStreamConnection::FileStreamConnection(td::ActorOwn<td::HttpInboundConnection> connection,
                                           td::ActorId<ClientManager> client_manager, FileStreamRoute route,
                                           FileStreamConfig config, td::IPAddress peer_address)
    : stream_id_(next_file_stream_id.fetch_add(1, std::memory_order_relaxed))
    , connection_(std::move(connection))
    , client_manager_(client_manager)
    , route_(std::move(route))
    , config_(config)
    , peer_address_(std::move(peer_address)) {
}

void FileStreamConnection::start_up() {
  set_timeout_in(config_.first_byte_timeout);
  send_closure(client_manager_, &ClientManager::send_file_stream, actor_id(this), stream_id_, std::move(route_.token),
               route_.is_test_dc, std::move(route_.file_id), route_.expected_size, peer_address_.get_ip_str().str());
}

void FileStreamConnection::set_client(td::ActorId<Client> client) {
  client_ = client;
}

void FileStreamConnection::on_file_ready(td::int32 file_id, td::int64 total_size, td::string local_path,
                                         td::int64 download_offset, td::int64 downloaded_prefix_size,
                                         bool is_completed, bool is_downloading_active) {
  if (finished_) {
    return;
  }
  if (file_id <= 0 || total_size < 0) {
    return fail(500, "Invalid file metadata received from TDLib");
  }
  file_id_ = file_id;
  local_path_ = std::move(local_path);
  if (static_cast<td::uint64>(total_size) > static_cast<td::uint64>(std::numeric_limits<std::size_t>::max())) {
    return fail(413, "File is too large for this build");
  }
  cursor_.total_size = total_size;
  auto status = cursor_.update_progress(download_offset, downloaded_prefix_size, is_completed);
  if (status.is_error()) {
    return fail(502, status.public_message());
  }
  download_completed_ = is_completed;
  (void)is_downloading_active;
  if (download_completed_ && cursor_.contiguous_end < cursor_.total_size) {
    return fail(502, "Telegram download completed with an incomplete file");
  }
  send_headers();
  try_read();
}

void FileStreamConnection::on_file_progress(td::int64 reported_total_size, td::string local_path,
                                            td::int64 download_offset, td::int64 downloaded_prefix_size,
                                            bool is_completed, bool is_downloading_active) {
  if (finished_ || cursor_.total_size < 0) {
    return;
  }
  if (reported_total_size > 0 && reported_total_size != cursor_.total_size) {
    return abort(td::Status::Error(502, "File size metadata changed during download"));
  }
  if (!local_path.empty()) {
    if (!local_path_.empty() && local_path_ != local_path) {
      local_file_.close();
    }
    local_path_ = std::move(local_path);
  }
  auto status = cursor_.update_progress(download_offset, downloaded_prefix_size, is_completed);
  if (status.is_error()) {
    return abort(std::move(status));
  }
  download_completed_ = download_completed_ || is_completed;
  if (!download_completed_ && !is_downloading_active) {
    return abort(td::Status::Error(502, "Telegram file download stopped before completion"));
  }
  if (download_completed_ && cursor_.contiguous_end < cursor_.total_size) {
    return abort(td::Status::Error(502, "Telegram download completed with an incomplete file"));
  }
  try_read();
}

void FileStreamConnection::try_read() {
  if (finished_ || read_in_flight_ || write_in_flight_ || cursor_.total_size < 0) {
    return;
  }
  if (cursor_.is_complete()) {
    return finish();
  }
  auto effective_chunk_size = td::min(config_.chunk_size, config_.write_high_watermark);
  auto count = cursor_.next_read_size(effective_chunk_size);
  if (count == 0) {
    return;
  }
  if (count < 0) {
    return abort(td::Status::Error(500, "Invalid stream read size"));
  }
  if (local_path_.empty()) {
    return;
  }
  if (local_file_.empty()) {
    auto file = td::FileFd::open(local_path_, td::FileFd::Read);
    if (file.is_error()) {
      if (!download_completed_) {
        return;
      }
      return abort(td::Status::Error(500, PSTRING() << "Failed to open TDLib local file: "
                                                     << file.error().public_message()));
    }
    local_file_ = file.move_as_ok();
  }

  read_in_flight_ = true;
  td::BufferSlice data(static_cast<std::size_t>(count));
  auto read_size = local_file_.pread(data.as_mutable_slice(), cursor_.next_offset);
  if (read_size.is_error()) {
    read_in_flight_ = false;
    return abort(td::Status::Error(500, PSTRING() << "Failed to read TDLib local file: "
                                                   << read_size.error().public_message()));
  }
  if (read_size.ok() != static_cast<std::size_t>(count)) {
    read_in_flight_ = false;
    if (!download_completed_) {
      local_file_.close();
      return;
    }
    return abort(td::Status::Error(500, "TDLib local file returned an incomplete part"));
  }
  on_file_data(cursor_.next_offset, std::move(data));
}

void FileStreamConnection::on_file_data(td::int64 offset, td::Result<td::BufferSlice> result) {
  read_in_flight_ = false;
  if (finished_) {
    return;
  }
  if (result.is_error()) {
    return abort(td::Status::Error(502, result.error().public_message()));
  }
  auto data = result.move_as_ok();
  auto expected_size = cursor_.next_read_size(td::min(config_.chunk_size, config_.write_high_watermark));
  if (static_cast<td::int64>(data.size()) != expected_size || data.empty()) {
    return abort(td::Status::Error(500, "TDLib local file returned an incomplete part"));
  }
  write_in_flight_ = true;
  pending_write_offset_ = offset;
  pending_write_size_ = data.size();
  auto promise = td::PromiseCreator::lambda(
      [actor_id = actor_id(this)](td::Result<td::Unit> result) mutable {
        send_closure(actor_id, &FileStreamConnection::on_chunk_flushed, std::move(result));
      });
  send_closure(connection_, &td::HttpInboundConnection::write_next_with_promise, std::move(data), std::move(promise));
}

void FileStreamConnection::on_chunk_flushed(td::Result<td::Unit> result) {
  write_in_flight_ = false;
  if (finished_) {
    return;
  }
  if (result.is_error()) {
    return abort(result.move_as_error());
  }
  auto status = cursor_.commit(pending_write_offset_, pending_write_size_);
  pending_write_offset_ = -1;
  pending_write_size_ = 0;
  if (status.is_error()) {
    return abort(std::move(status));
  }
  first_byte_sent_ = true;
  set_timeout_in(config_.idle_timeout);
  try_read();
}

void FileStreamConnection::send_headers() {
  if (headers_sent_) {
    return;
  }
  td::HttpHeaderCreator hc;
  hc.init_status_line(200);
  hc.set_keep_alive();
  hc.set_content_type("application/octet-stream");
  hc.set_content_size(static_cast<std::size_t>(cursor_.total_size));
  hc.add_header("Content-Disposition", "attachment");
  hc.add_header("Cache-Control", "private");
  auto header = hc.finish();
  if (header.is_error()) {
    return fail(500, "Failed to create streaming response headers");
  }
  headers_sent_ = true;
  send_closure(connection_, &td::HttpInboundConnection::write_next_noflush, td::BufferSlice(header.ok()));
}

void FileStreamConnection::finish() {
  if (finished_) {
    return;
  }
  if (!cursor_.is_complete() || read_in_flight_ || write_in_flight_) {
    return abort(td::Status::Error(500, "Attempted to finish an incomplete stream"));
  }
  finished_ = true;
  cancel_timeout();
  if (!connection_.empty()) {
    send_closure(std::move(connection_), &td::HttpInboundConnection::write_ok);
  }
  stop();
}

void FileStreamConnection::on_file_error(td::Status error) {
  if (finished_) {
    return;
  }
  auto code = error.code();
  if (code < 400 || code > 599) {
    code = 502;
  }
  if (!headers_sent_) {
    fail(code, error.public_message());
  } else {
    abort(std::move(error));
  }
}

void FileStreamConnection::fail(int http_status_code, td::Slice message) {
  if (finished_) {
    return;
  }
  if (headers_sent_) {
    return abort(td::Status::Error(http_status_code, message));
  }
  auto content = td::json_encode<td::BufferSlice>(JsonQueryError(http_status_code, message));
  td::HttpHeaderCreator hc;
  hc.init_status_line(http_status_code);
  hc.set_content_type("application/json");
  hc.set_content_size(content.size());
  auto header = hc.finish();
  finished_ = true;
  cancel_timeout();
  if (header.is_error()) {
    send_closure(std::move(connection_), &td::HttpInboundConnection::write_error, header.move_as_error());
  } else {
    send_closure(connection_, &td::HttpInboundConnection::write_next_noflush, td::BufferSlice(header.ok()));
    send_closure(connection_, &td::HttpInboundConnection::write_next_noflush, std::move(content));
    send_closure(std::move(connection_), &td::HttpInboundConnection::write_ok);
  }
  stop();
}

void FileStreamConnection::abort(td::Status error) {
  if (finished_) {
    return;
  }
  finished_ = true;
  cancel_timeout();
  LOG(WARNING) << "Abort file stream at offset " << cursor_.next_offset << " of " << cursor_.total_size << ": "
               << error;
  if (!connection_.empty()) {
    send_closure(std::move(connection_), &td::HttpInboundConnection::write_error, std::move(error));
  }
  stop();
}

void FileStreamConnection::timeout_expired() {
  auto message = first_byte_sent_ ? td::Slice("File stream stalled") : td::Slice("File stream first byte timeout");
  on_file_error(td::Status::Error(504, message));
}

void FileStreamConnection::tear_down() {
  local_file_.close();
  send_closure(client_manager_, &ClientManager::release_file_stream, stream_id_);
  if (!client_.empty()) {
    send_closure(client_, &Client::remove_file_stream, stream_id_, file_id_);
  }
  connection_.release();
}

}  // namespace telegram_bot_api
