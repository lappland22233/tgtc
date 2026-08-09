//
// Copyright Aliaksei Levin (levlam@telegram.org), Arseny Smirnov (arseny30@gmail.com) 2014-2025
//
// Distributed under the Boost Software License, Version 1.0. (See accompanying
// file LICENSE_1_0.txt or copy at http://www.boost.org/LICENSE_1_0.txt)
//
#include "telegram-bot-api/FileStreamCore.h"

#include "td/utils/tests.h"

#include <algorithm>
#include <cstdint>

TEST(FileStream, Route) {
  auto route = telegram_bot_api::parse_file_stream_route("/stream/file/bot123:token/abc%2Ddef").move_as_ok();
  ASSERT_STREQ("123:token", route.token);
  ASSERT_STREQ("abc-def", route.file_id);
  ASSERT_FALSE(route.is_test_dc);

  route = telegram_bot_api::parse_file_stream_route("/stream/file/bot123:token/test/abc_def").move_as_ok();
  ASSERT_TRUE(route.is_test_dc);
  ASSERT_STREQ("abc_def", route.file_id);
}

TEST(FileStream, InvalidRoute) {
  ASSERT_TRUE(telegram_bot_api::parse_file_stream_route("/bot123:token/getFile").is_error());
  ASSERT_TRUE(telegram_bot_api::parse_file_stream_route("/file/bot123:token/file/path").is_error());
  ASSERT_TRUE(telegram_bot_api::parse_file_stream_route("/stream/file/bot/file").is_error());
  ASSERT_TRUE(telegram_bot_api::parse_file_stream_route("/stream/file/bot123:token/").is_error());
  ASSERT_TRUE(telegram_bot_api::parse_file_stream_route("/stream/file/bot123:token/a/b").is_error());
  ASSERT_TRUE(telegram_bot_api::parse_file_stream_route("/stream/file/bot123:token/%ZZ").is_error());
}

TEST(FileStream, SizeHint) {
  ASSERT_EQ(-1, telegram_bot_api::parse_file_stream_size_hint("").move_as_ok());
  ASSERT_EQ(1, telegram_bot_api::parse_file_stream_size_hint("1").move_as_ok());
  ASSERT_EQ(9223372036854775807LL,
            telegram_bot_api::parse_file_stream_size_hint("9223372036854775807").move_as_ok());
  ASSERT_TRUE(telegram_bot_api::parse_file_stream_size_hint("0").is_error());
  ASSERT_TRUE(telegram_bot_api::parse_file_stream_size_hint("-1").is_error());
  ASSERT_TRUE(telegram_bot_api::parse_file_stream_size_hint("1.0").is_error());
  ASSERT_TRUE(telegram_bot_api::parse_file_stream_size_hint(" 1").is_error());
  ASSERT_TRUE(telegram_bot_api::parse_file_stream_size_hint("9223372036854775808").is_error());
}

TEST(FileStream, NoCacheHeader) {
  ASSERT_TRUE(telegram_bot_api::parse_file_stream_no_cache("1"));
  ASSERT_TRUE(telegram_bot_api::parse_file_stream_no_cache("true"));
  ASSERT_TRUE(telegram_bot_api::parse_file_stream_no_cache("True"));
  ASSERT_TRUE(telegram_bot_api::parse_file_stream_no_cache(" 1 "));
  ASSERT_FALSE(telegram_bot_api::parse_file_stream_no_cache(""));
  ASSERT_FALSE(telegram_bot_api::parse_file_stream_no_cache("0"));
  ASSERT_FALSE(telegram_bot_api::parse_file_stream_no_cache("false"));
  ASSERT_FALSE(telegram_bot_api::parse_file_stream_no_cache("yes"));
}

TEST(FileStream, ResolvesExactSize) {
  ASSERT_EQ(10, telegram_bot_api::resolve_file_stream_size(10, -1).move_as_ok());
  ASSERT_EQ(10, telegram_bot_api::resolve_file_stream_size(10, 10).move_as_ok());
  ASSERT_EQ(10, telegram_bot_api::resolve_file_stream_size(10, 1).move_as_ok());
  ASSERT_EQ(10, telegram_bot_api::resolve_file_stream_size(10, 1000).move_as_ok());
  ASSERT_TRUE(telegram_bot_api::resolve_file_stream_size(0, 10).is_error());
  ASSERT_TRUE(telegram_bot_api::resolve_file_stream_size(0, -1).is_error());
}

TEST(FileStream, CursorCompleteFile) {
  telegram_bot_api::FileStreamCursor cursor;
  cursor.total_size = 10;
  ASSERT_TRUE(cursor.update_progress(0, 3, false).is_ok());
  ASSERT_EQ(3, cursor.next_read_size(4));
  ASSERT_TRUE(cursor.commit(0, 3).is_ok());
  ASSERT_FALSE(cursor.is_complete());

  ASSERT_TRUE(cursor.update_progress(0, 10, true).is_ok());
  ASSERT_EQ(4, cursor.next_read_size(4));
  ASSERT_TRUE(cursor.commit(3, 4).is_ok());
  ASSERT_TRUE(cursor.commit(7, 3).is_ok());
  ASSERT_TRUE(cursor.is_complete());
  ASSERT_EQ(10, cursor.next_offset);
}

TEST(FileStream, CursorRejectsGapsAndDuplicates) {
  telegram_bot_api::FileStreamCursor cursor;
  cursor.total_size = 8;
  ASSERT_TRUE(cursor.update_progress(4, 4, false).is_ok());
  ASSERT_EQ(0, cursor.next_read_size(4));
  ASSERT_TRUE(cursor.update_progress(0, 4, false).is_ok());
  ASSERT_TRUE(cursor.commit(1, 4).is_error());
  ASSERT_TRUE(cursor.commit(0, 4).is_ok());
  ASSERT_TRUE(cursor.commit(0, 4).is_error());
  ASSERT_TRUE(cursor.update_progress(0, 7, true).is_ok());
  ASSERT_FALSE(cursor.is_complete());
}

TEST(FileStream, CursorChunkBoundaries) {
  for (td::int64 total_size : {0, 1, 255, 256, 257, 1025}) {
    telegram_bot_api::FileStreamCursor cursor;
    cursor.total_size = total_size;
    ASSERT_TRUE(cursor.update_progress(0, total_size, true).is_ok());
    while (!cursor.is_complete()) {
      auto size = cursor.next_read_size(256);
      ASSERT_TRUE(size > 0);
      ASSERT_TRUE(cursor.commit(cursor.next_offset, size).is_ok());
    }
    ASSERT_EQ(total_size, cursor.next_offset);
  }
}

TEST(FileStream, ReassemblesExactBytes) {
  for (td::int64 total_size : {1, 255, 256, 257, 1025, 65537}) {
    td::vector<std::uint8_t> source(static_cast<std::size_t>(total_size));
    for (std::size_t i = 0; i < source.size(); i++) {
      source[i] = static_cast<std::uint8_t>((i * 131 + 17) & 0xff);
    }
    td::vector<std::uint8_t> output;
    telegram_bot_api::FileStreamCursor cursor;
    cursor.total_size = total_size;
    ASSERT_TRUE(cursor.update_progress(0, total_size, true).is_ok());
    while (!cursor.is_complete()) {
      auto offset = cursor.next_offset;
      auto size = cursor.next_read_size(256);
      output.insert(output.end(), source.begin() + offset, source.begin() + offset + size);
      ASSERT_TRUE(cursor.commit(offset, size).is_ok());
    }
    ASSERT_EQ(source.size(), output.size());
    ASSERT_TRUE(std::equal(source.begin(), source.end(), output.begin()));
  }
}
