// HTTP upgrade request head: no crash, no read outside the input, views inside the buffer,
// and the result does not depend on bytes after the head (prefix stability).
#include <cstdlib>
#include <vector>

#include "../src/http.hpp"

using namespace wisp;

static bool inside(std::string_view v, const u8* b, std::size_t n) {
  if (v.empty()) return true;
  auto* p = reinterpret_cast<const u8*>(v.data());
  return p >= b && p + v.size() <= b + n;
}

extern "C" int LLVMFuzzerTestOneInput(const u8* data, std::size_t n) {
  std::vector<u8> buf(data, data + n);  // exact-size copy: ASan catches any overread
  HttpRequest r;
  HttpParse res = parse_request_head(buf.data(), buf.size(), r);
  if (res == HttpParse::Ok) {
    if (r.head_len > n || r.head_len < 4) std::abort();
    for (auto v : {r.method, r.target, r.upgrade, r.connection, r.key, r.version, r.origin, r.protocol, r.xff_first, r.xff_last})
      if (!inside(v, buf.data(), r.head_len)) std::abort();
    for (auto v : {r.method, r.target, r.upgrade, r.connection, r.key, r.version, r.origin, r.protocol})
      for (char c : v) if (c == '\r' || c == '\n' || c == 0) std::abort();  // nothing that could split a header we echo
    // the same head followed by other bytes parses the same way
    std::vector<u8> longer(buf.begin(), buf.begin() + long(r.head_len));
    longer.push_back('X');
    HttpRequest r2;
    if (parse_request_head(longer.data(), longer.size(), r2) != HttpParse::Ok || r2.head_len != r.head_len || r2.key != r.key) std::abort();
    has_token(r.connection, "upgrade");
    ieq(r.upgrade, "websocket");
  } else if (res == HttpParse::NeedMore) {
    if (n >= kMaxRequestHead) std::abort();
  }
  return 0;
}
