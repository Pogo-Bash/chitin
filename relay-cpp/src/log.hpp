// Metadata-only logging: one line per event written with a single write(2) to stderr (lines up to
// 512 bytes stay whole when several threads log). Never pass payload bytes; strings that come from
// clients (Origin, host names) go through log_text(), which quotes and escapes them.
#pragma once
#include <string_view>

namespace wisp {

extern int g_log_level;  // 0 nothing, 1 connections, 2 streams too

void log_line(int level, const char* fmt, ...) __attribute__((format(printf, 2, 3)));
// Printable-ASCII copy of s in double quotes, at most 96 characters of s, others as \xNN.
const char* log_text(std::string_view s, char (&buf)[400]);

}  // namespace wisp
