// HTTP/1.1 request-head parser for the WebSocket upgrade (RFC 9112 message syntax, RFC 6455 4.2.1).
// Pure function over a byte buffer: no allocation, fuzzed (fuzz/fuzz_http.cpp).
#pragma once
#include <string_view>

#include "common.hpp"

namespace wisp {

constexpr std::size_t kMaxRequestHead = 8192;
constexpr unsigned kMaxHeaders = 64;

struct HttpRequest {
  std::string_view method, target;
  std::string_view upgrade, connection, key, version, origin, protocol;
  // X-Forwarded-For may appear more than once: the first and last occurrence are kept and
  // `xff_count` says how many there were (the server refuses to guess when it is > 2).
  std::string_view xff_first, xff_last;
  unsigned xff_count = 0;
  bool has_origin = false, has_protocol = false;
  bool duplicate_singleton = false;  // a header that must appear once appeared twice
  std::size_t head_len = 0;          // bytes up to and including the blank line
};

enum class HttpParse { NeedMore, Ok, Bad, TooLarge };

// Parse buf[0..n). Ok fills `out` (views into buf). NeedMore when the blank line has not arrived
// and n < kMaxRequestHead; TooLarge when it has not arrived within kMaxRequestHead bytes.
HttpParse parse_request_head(const u8* buf, std::size_t n, HttpRequest& out);

// Case-insensitive ASCII compare and "token appears in a comma-separated list".
bool ieq(std::string_view a, std::string_view b);
bool has_token(std::string_view list, std::string_view token);

}  // namespace wisp
