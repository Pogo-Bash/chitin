#include "log.hpp"

#include <unistd.h>

#include <cstdarg>
#include <cstdio>
#include <ctime>

namespace wisp {

int g_log_level = 1;

void log_line(int level, const char* fmt, ...) {
  if (g_log_level < level) return;
  char buf[512];
  time_t t = time(nullptr);
  struct tm tm;
  gmtime_r(&t, &tm);
  int n = int(strftime(buf, sizeof buf, "%Y-%m-%dT%H:%M:%S ", &tm));
  va_list ap;
  va_start(ap, fmt);
  int m = vsnprintf(buf + n, sizeof buf - std::size_t(n) - 1, fmt, ap);
  va_end(ap);
  if (m < 0) return;
  std::size_t len = std::size_t(n) + std::size_t(m);
  if (len > sizeof buf - 2) len = sizeof buf - 2;
  buf[len++] = '\n';
  ssize_t w = write(2, buf, len);
  (void)w;
}

const char* log_text(std::string_view s, char (&buf)[400]) {
  static const char* hex = "0123456789abcdef";
  std::size_t o = 0;
  buf[o++] = '"';
  std::size_t n = s.size() > 96 ? 96 : s.size();
  for (std::size_t i = 0; i < n; i++) {
    unsigned char c = static_cast<unsigned char>(s[i]);
    if (c >= 0x20 && c < 0x7f && c != '"' && c != '\\') buf[o++] = char(c);
    else { buf[o++] = '\\'; buf[o++] = 'x'; buf[o++] = hex[c >> 4]; buf[o++] = hex[c & 15]; }
  }
  if (s.size() > n) { buf[o++] = '.'; buf[o++] = '.'; buf[o++] = '.'; }
  buf[o++] = '"';
  buf[o] = 0;
  return buf;
}

}  // namespace wisp
