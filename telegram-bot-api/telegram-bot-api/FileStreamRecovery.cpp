//
// Copyright Aliaksei Levin (levlam@telegram.org), Arseny Smirnov (arseny30@gmail.com) 2014-2025
//
// Distributed under the Boost Software License, Version 1.0. (See accompanying
// file LICENSE_1_0.txt or copy at http://www.boost.org/LICENSE_1_0.txt)
//
#include "telegram-bot-api/FileStreamRecovery.h"

namespace telegram_bot_api {

bool file_stream_waits_for_redownload(bool download_completed, bool first_byte_sent) {
  return download_completed && !first_byte_sent;
}

bool file_stream_fails_on_stopped_download(bool download_completed, bool first_byte_sent) {
  return !download_completed && first_byte_sent;
}

}  // namespace telegram_bot_api
