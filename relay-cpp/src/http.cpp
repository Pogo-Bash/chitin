#include "http.hpp"

namespace wisp {

namespace {
inline char lower(char c) { return (c >= 'A' && c <= 'Z') ? char(c - 'A' + 'a') : c; }

// RFC 9110 tchar
inline bool tchar(u8 c) {
  if (c >= '0' && c <= '9') return true;
  if ((c | 0x20) >= 'a' && (c | 0x20) <= 'z') return true;
  switch (c) {
    case '!': case '#': case '$': case '%': case '&': case '\'': case '*': case '+': case '-': case '.':
    case '^': case '_': case '`': case '|': case '~': return true;
    default: return false;
  }
}

inline std::string_view trim_ows(std::string_view s) {
  while (!s.empty() && (s.front() == ' ' || s.front() == '\t')) s.remove_prefix(1);
  while (!s.empty() && (s.back() == ' ' || s.back() == '\t')) s.remove_suffix(1);
  return s;
}
}  // namespace

bool ieq(std::string_view a, std::string_view b) {
  if (a.size() != b.size()) return false;
  for (std::size_t i = 0; i < a.size(); i++)
    if (lower(a[i]) != lower(b[i])) return false;
  return true;
}

bool has_token(std::string_view list, std::string_view token) {
  while (!list.empty()) {
    std::size_t comma = list.find(',');
    std::string_view item = trim_ows(list.substr(0, comma));
    if (ieq(item, token)) return true;
    if (comma == std::string_view::npos) break;
    list.remove_prefix(comma + 1);
  }
  return false;
}

HttpParse parse_request_head(const u8* buf, std::size_t n, HttpRequest& out) {
  out = HttpRequest{};
  // Find the end of the head (CRLF CRLF) within the size bound.
  std::size_t limit = n < kMaxRequestHead ? n : kMaxRequestHead;
  std::size_t end = 0;
  for (std::size_t i = 3; i < limit; i++) {
    if (buf[i] == '\n' && buf[i - 1] == '\r' && buf[i - 2] == '\n' && buf[i - 3] == '\r') { end = i + 1; break; }
  }
  if (!end) return n >= kMaxRequestHead ? HttpParse::TooLarge : HttpParse::NeedMore;
  out.head_len = end;
  std::string_view head(reinterpret_cast<const char*>(buf), end - 2);  // keeps the last header's CRLF

  // Every byte of the head must be visible ASCII, SP, HTAB, CR or LF (no NUL, no obs-text in
  // anything we look at; a lone CR or LF is refused below).
  for (char ch : head) {
    u8 c = u8(ch);
    if (c >= 0x7f || (c < 0x20 && c != '\t' && c != '\r' && c != '\n')) return HttpParse::Bad;
  }

  // request-line = method SP request-target SP HTTP-version CRLF
  std::size_t eol = head.find("\r\n");
  if (eol == std::string_view::npos) return HttpParse::Bad;
  std::string_view line = head.substr(0, eol);
  if (line.find('\n') != std::string_view::npos || line.find('\r') != std::string_view::npos) return HttpParse::Bad;  // no lone CR/LF
  std::size_t sp1 = line.find(' ');
  if (sp1 == std::string_view::npos || sp1 == 0) return HttpParse::Bad;
  std::size_t sp2 = line.find(' ', sp1 + 1);
  if (sp2 == std::string_view::npos || sp2 == sp1 + 1) return HttpParse::Bad;
  out.method = line.substr(0, sp1);
  out.target = line.substr(sp1 + 1, sp2 - sp1 - 1);
  std::string_view ver = line.substr(sp2 + 1);
  for (char c : out.method)
    if (!tchar(u8(c))) return HttpParse::Bad;
  for (char c : out.target)
    if (c == ' ' || c == '\t') return HttpParse::Bad;
  if (ver != "HTTP/1.1" && ver != "HTTP/1.0") return HttpParse::Bad;

  // header-field = field-name ":" OWS field-value OWS CRLF
  std::size_t pos = eol + 2;
  unsigned count = 0;
  while (pos < head.size()) {
    std::size_t e = head.find("\r\n", pos);
    if (e == std::string_view::npos) return HttpParse::Bad;
    std::string_view h = head.substr(pos, e - pos);
    pos = e + 2;
    if (h.empty()) return HttpParse::Bad;  // a blank line before the end
    if (h.find('\r') != std::string_view::npos || h.find('\n') != std::string_view::npos) return HttpParse::Bad;
    if (h.front() == ' ' || h.front() == '\t') return HttpParse::Bad;  // obs-fold
    if (++count > kMaxHeaders) return HttpParse::Bad;
    std::size_t colon = h.find(':');
    if (colon == std::string_view::npos || colon == 0) return HttpParse::Bad;
    std::string_view name = h.substr(0, colon);
    for (char c : name)
      if (!tchar(u8(c))) return HttpParse::Bad;  // also refuses "Name :" (RFC 9112 5.1)
    std::string_view value = trim_ows(h.substr(colon + 1));
    auto single = [&](std::string_view& slot, bool* flag = nullptr) {
      if (flag ? *flag : !slot.empty()) out.duplicate_singleton = true;
      slot = value;
      if (flag) *flag = true;
    };
    if (ieq(name, "upgrade")) single(out.upgrade);
    else if (ieq(name, "connection")) single(out.connection);
    else if (ieq(name, "sec-websocket-key")) single(out.key);
    else if (ieq(name, "sec-websocket-version")) single(out.version);
    else if (ieq(name, "origin")) single(out.origin, &out.has_origin);
    else if (ieq(name, "sec-websocket-protocol")) single(out.protocol, &out.has_protocol);
    else if (ieq(name, "x-forwarded-for")) {
      if (!out.xff_count) out.xff_first = value;
      out.xff_last = value;
      out.xff_count++;
    }
  }
  return HttpParse::Ok;
}

}  // namespace wisp
