//
// Copyright Aliaksei Levin (levlam@telegram.org), Arseny Smirnov (arseny30@gmail.com) 2014-2025
//
// Distributed under the Boost Software License, Version 1.0. (See accompanying
// file LICENSE_1_0.txt or copy at http://www.boost.org/LICENSE_1_0.txt)
//
#include "telegram-bot-api/FileStream.h"

#include "td/utils/misc.h"
#include "td/utils/Parser.h"

namespace telegram_bot_api {
namespace {

bool is_hex(char c) {
  return ('0' <= c && c <= '9') || ('a' <= c && c <= 'f') || ('A' <= c && c <= 'F');
}

td::Status validate_url_encoding(td::Slice value) {
  for (std::size_t i = 0; i < value.size(); i++) {
    if (value[i] == '%') {
      if (i + 2 >= value.size() || !is_hex(value[i + 1]) || !is_hex(value[i + 2])) {
        return td::Status::Error(400, "Invalid percent-encoding in file_id");
      }
      i += 2;
    }
  }
  return td::Status::OK();
}

}  // namespace

td::Result<FileStreamRoute> parse_file_stream_route(td::Slice path) {
  td::ConstParser parser(path);
  if (!parser.try_skip("/stream/file/bot")) {
    return td::Status::Error(404, "Not Found");
  }
  auto token = parser.read_till('/');
  if (token.empty()) {
    return td::Status::Error(400, "Token is empty");
  }
  parser.skip('/');
  if (parser.status().is_error()) {
    return td::Status::Error(400, "file_id is missing");
  }

  bool is_test_dc = false;
  if (parser.try_skip("test/")) {
    is_test_dc = true;
  }
  auto encoded_file_id = parser.data();
  if (encoded_file_id.empty() || encoded_file_id.find('/') != td::string::npos) {
    return td::Status::Error(400, "Invalid file_id path");
  }
  TRY_STATUS(validate_url_encoding(encoded_file_id));
  auto file_id = td::url_decode(encoded_file_id, false);
  if (file_id.empty() || file_id.size() > 4096u || file_id.find('/') != td::string::npos ||
      file_id.find('\0') != td::string::npos) {
    return td::Status::Error(400, "Invalid file_id specified");
  }
  return FileStreamRoute{token.str(), std::move(file_id), is_test_dc};
}

}  // namespace telegram_bot_api
