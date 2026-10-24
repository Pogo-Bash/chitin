// Small shared helpers: fixed-width loads/stores, span aliases, branch hints.
#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <span>
#include <string_view>

namespace wisp {

using u8 = std::uint8_t;
using u16 = std::uint16_t;
using u32 = std::uint32_t;
using u64 = std::uint64_t;
using i64 = std::int64_t;
using bytes = std::span<const u8>;
using mbytes = std::span<u8>;

#define WISP_LIKELY(x) __builtin_expect(!!(x), 1)
#define WISP_UNLIKELY(x) __builtin_expect(!!(x), 0)

inline u16 load_le16(const u8* p) { return u16(p[0] | (u16(p[1]) << 8)); }
inline u32 load_le32(const u8* p) { return u32(p[0]) | (u32(p[1]) << 8) | (u32(p[2]) << 16) | (u32(p[3]) << 24); }
inline u16 load_be16(const u8* p) { return u16((u16(p[0]) << 8) | p[1]); }
inline u64 load_be64(const u8* p) {
  u64 v = 0;
  for (int i = 0; i < 8; i++) v = (v << 8) | p[i];
  return v;
}
inline void store_le32(u8* p, u32 v) { p[0] = u8(v); p[1] = u8(v >> 8); p[2] = u8(v >> 16); p[3] = u8(v >> 24); }
inline void store_be16(u8* p, u16 v) { p[0] = u8(v >> 8); p[1] = u8(v); }
inline void store_be32(u8* p, u32 v) { p[0] = u8(v >> 24); p[1] = u8(v >> 16); p[2] = u8(v >> 8); p[3] = u8(v); }

inline std::string_view as_sv(bytes b) { return {reinterpret_cast<const char*>(b.data()), b.size()}; }
inline bytes as_bytes(std::string_view s) { return {reinterpret_cast<const u8*>(s.data()), s.size()}; }

}  // namespace wisp
