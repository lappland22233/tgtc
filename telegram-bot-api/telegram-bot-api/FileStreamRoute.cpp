//
// Copyright Aliaksei Levin (levlam@telegram.org), Arseny Smirnov (arseny30@gmail.com) 2014-2025
//
// Distributed under the Boost Software License, Version 1.0. (See accompanying
// file LICENSE_1_0.txt or copy at http://www.boost.org/LICENSE_1_0.txt)
//
#include "telegram-bot-api/FileStreamCore.h"

#include "td/utils/misc.h"
#include "td/utils/Parser.h"
#include "td/utils/port/IPAddress.h"

#include <cstring>

namespace telegram_bot_api {
namespace {

// G16-06: a single parsed allowlist entry: a network prefix (address + prefix length in bits).
struct IpPrefix {
  td::uint32 ipv4 = 0;
  unsigned char ipv6[16] = {0};
  bool is_ipv4 = false;
  int prefix_len = 0;
};

bool parse_ipv6_prefix(td::Slice text, unsigned char out[16]) {
  td::IPAddress addr;
  if (addr.init_ipv6_port(text, 0).is_error()) {
    return false;
  }
  // IPAddress does not expose the raw 16-byte v6 address, so fall back to get_ipv6() string form.
  auto v6 = addr.get_ipv6();
  if (v6.size() != 16) {
    return false;
  }
  std::memcpy(out, v6.data(), 16);
  return true;
}

bool parse_allow_ip_entry(td::Slice entry, IpPrefix &result) {
  entry = td::trim(entry);
  if (entry.empty()) {
    return false;
  }
  auto prefix_len = -1;
  auto slash_pos = entry.rfind('/');
  td::Slice addr_part = entry;
  if (slash_pos != td::Slice::npos) {
    addr_part = entry.substr(0, slash_pos);
    auto prefix_part = entry.substr(slash_pos + 1);
    if (prefix_part.empty()) {
      return false;
    }
    for (auto c : prefix_part) {
      if (c < '0' || c > '9') {
        return false;
      }
    }
    auto r_len = td::to_integer_safe<int>(prefix_part);
    if (r_len.is_error()) {
      return false;
    }
    prefix_len = r_len.ok();
  }
  // IPv4 (with optional /prefix)
  {
    td::IPAddress addr;
    if (addr.init_ipv4_port(addr_part, 0).is_ok()) {
      result.is_ipv4 = true;
      result.ipv4 = addr.get_ipv4();
      result.prefix_len = prefix_len < 0 ? 32 : prefix_len;
      return result.prefix_len >= 0 && result.prefix_len <= 32;
    }
  }
  // IPv6 (with optional /prefix)
  {
    unsigned char v6[16];
    if (parse_ipv6_prefix(addr_part, v6)) {
      result.is_ipv4 = false;
      std::memcpy(result.ipv6, v6, 16);
      result.prefix_len = prefix_len < 0 ? 128 : prefix_len;
      return result.prefix_len >= 0 && result.prefix_len <= 128;
    }
  }
  return false;
}

bool is_private_or_loopback(const td::IPAddress &addr) {
  if (!addr.is_valid()) {
    return false;
  }
  if (addr.is_ipv4()) {
    auto ip = addr.get_ipv4();
    // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16
    return (ip >> 24) == 0 || (ip >> 24) == 10 || (ip >> 24) == 127 || (ip >> 16) == 0xA9FE ||
           ((ip >> 20) & 0xFFF) == 0xAC1 || (ip >> 16) == 0xC0A8;
  }
  // IPv6: treat loopback ::1 and unique-local fc00::/7 as private.
  auto v6 = addr.get_ipv6();
  if (v6.size() != 16) {
    return false;
  }
  bool all_zero_except_last = true;
  for (std::size_t i = 0; i < 15; i++) {
    if (v6[i] != 0) {
      all_zero_except_last = false;
      break;
    }
  }
  if (all_zero_except_last && v6[15] == 1) {
    return true;  // ::1
  }
  return (v6[0] & 0xFE) == 0xFC;  // fc00::/7
}

bool ipv4_matches(const IpPrefix &prefix, td::uint32 ip) {
  td::uint32 mask = prefix.prefix_len == 0 ? 0 : (0xFFFFFFFFu << (32 - prefix.prefix_len));
  return (prefix.ipv4 & mask) == (ip & mask);
}

bool ipv6_matches(const IpPrefix &prefix, const unsigned char ip[16]) {
  int full_bytes = prefix.prefix_len / 8;
  int rem_bits = prefix.prefix_len % 8;
  for (int i = 0; i < full_bytes; i++) {
    if (prefix.ipv6[i] != ip[i]) {
      return false;
    }
  }
  if (rem_bits > 0) {
    auto mask = static_cast<unsigned char>(0xFF << (8 - rem_bits));
    if ((prefix.ipv6[full_bytes] & mask) != (ip[full_bytes] & mask)) {
      return false;
    }
  }
  return true;
}

}  // namespace

bool is_file_stream_ip_allowed(const td::IPAddress &peer_address, td::Slice allow_ip) {
  if (!peer_address.is_valid()) {
    return false;
  }
  if (allow_ip.empty()) {
    // Default policy: only loopback and private networks may use the streaming endpoint.
    return is_private_or_loopback(peer_address);
  }
  td::ConstParser parser(allow_ip);
  while (!parser.data().empty()) {
    // read_till_nofail returns the entry up to the next ',' or the end of the string without
    // failing; we consume the optional trailing ',' ourselves so the last entry is not dropped.
    auto entry = parser.read_till_nofail(',');
    parser.skip_nofail(',');
    IpPrefix prefix;
    if (parse_allow_ip_entry(entry, prefix)) {
      if (prefix.is_ipv4 && peer_address.is_ipv4()) {
        if (ipv4_matches(prefix, peer_address.get_ipv4())) {
          return true;
        }
      } else if (!prefix.is_ipv4 && peer_address.is_ipv6()) {
        auto v6 = peer_address.get_ipv6();
        if (v6.size() == 16) {
          const auto *raw = reinterpret_cast<const unsigned char *>(v6.data());
          if (ipv6_matches(prefix, raw)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}


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

td::Result<td::int64> parse_file_stream_size_hint(td::Slice value) {
  if (value.empty()) {
    return static_cast<td::int64>(-1);
  }
  for (auto c : value) {
    if (c < '0' || c > '9') {
      return td::Status::Error(400, "Invalid X-Telegram-File-Size header");
    }
  }
  auto size = td::to_integer_safe<td::int64>(value);
  if (size.is_error() || size.ok() <= 0) {
    return td::Status::Error(400, "Invalid X-Telegram-File-Size header");
  }
  return size.move_as_ok();
}

bool parse_file_stream_no_cache(td::Slice value) {
  value = td::trim(value);
  return value == "1" || td::to_lower(value) == "true";
}

td::Result<td::int64> resolve_file_stream_size(td::int64 tdlib_size, td::int64 expected_size) {
  (void)expected_size;
  if (tdlib_size > 0) {
    return tdlib_size;
  }
  return td::Status::Error(502, "Exact file size is unavailable from Telegram");
}

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
