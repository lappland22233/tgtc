//
// Copyright Aliaksei Levin (levlam@telegram.org), Arseny Smirnov (arseny30@gmail.com) 2014-2025
//
// Distributed under the Boost Software License, Version 1.0. (See accompanying
// file LICENSE_1_0.txt or copy at http://www.boost.org/LICENSE_1_0.txt)
//
#pragma once

#include "td/utils/common.h"

namespace telegram_bot_api {

// Policy for a TDLib local file that the streaming endpoint cannot use.
//
// TDLib may report a file as downloaded while its local copy is already gone (workdir cleanup,
// workdir change, a file deleted behind TDLib's back). It only re-validates the local location
// while (re)starting a download, so the first request for such a "cold" file used to abort with an
// HTTP 500 even though TDLib re-downloaded the file a few moments later. What the stream has to do
// depends on whether the response can still be repaired:
//
//   - before the first byte is written the response can still complete, so keep the request open
//     and wait for TDLib to re-download the file (the stream-level timeouts stay the last resort);
//   - after data has been streamed the response cannot be repaired any more, so fail the stream
//     instead of letting it drag on.
bool file_stream_waits_for_redownload(bool download_completed, bool first_byte_sent);
bool file_stream_fails_on_stopped_download(bool download_completed, bool first_byte_sent);

}  // namespace telegram_bot_api
