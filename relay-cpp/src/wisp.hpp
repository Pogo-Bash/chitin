// Wisp v1/v2 packets (https://github.com/MercuryWorkshop/wisp-protocol): type u8, stream id u32 LE,
// payload. Decoding is a pure function over bytes (fuzzed: fuzz/fuzz_wisp.cpp).
#pragma once
#include <string_view>

#include "common.hpp"

namespace wisp {

enum : u8 { PKT_CONNECT = 1, PKT_DATA = 2, PKT_CONTINUE = 3, PKT_CLOSE = 4, PKT_INFO = 5 };
enum : u8 { STREAM_TCP = 1, STREAM_UDP = 2 };
enum : u8 { EXT_UDP = 1, EXT_PASSWORD = 2, EXT_KEY = 3, EXT_MOTD = 4, EXT_OPEN_CONFIRM = 5 };

// Close reasons
enum : u8 {
  R_UNSPECIFIED = 0x01, R_VOLUNTARY = 0x02, R_NETWORK = 0x03, R_EXTENSIONS = 0x04,
  R_INVALID = 0x41, R_UNREACHABLE = 0x42, R_TIMEOUT = 0x43, R_REFUSED = 0x44, R_DATA_TIMEOUT = 0x47,
  R_BLOCKED = 0x48, R_THROTTLED = 0x49, R_CLIENT = 0x81,
  R_AUTH_PASSWORD = 0xc0, R_AUTH_KEY = 0xc1, R_AUTH_MISSING = 0xc2,
};

constexpr std::size_t kWispHeader = 5;

struct Packet {
  u8 type;
  u32 id;
  mbytes payload;
};
// False when shorter than the 5-byte header.
bool parse_packet(mbytes msg, Packet& out);

struct Connect {
  u8 stream_type;
  u16 port;
  std::string_view host;  // valid UTF-8 (checked), not yet policy-checked
};
// False when the payload is shorter than 3 bytes or the host is not valid UTF-8.
bool parse_connect(bytes payload, Connect& out);

// INFO: major, minor, then extensions (id u8, length u32 LE, data). Up to kMaxExtensions are
// recorded; a later duplicate id replaces an earlier one (as a JS Map would).
constexpr unsigned kMaxExtensions = 16;
struct Info {
  u8 major = 0, minor = 0;
  struct Ext { u8 id; bytes data; };
  Ext ext[kMaxExtensions];
  unsigned count = 0;
  const Ext* find(u8 id) const;
};
// False when short (< 2 bytes) or an extension overruns the payload. Trailing bytes too short to
// be an extension header (< 5) are ignored, as in packages/wisp.
bool parse_info(bytes payload, Info& out);

// Password extension payload (client side): username length u8, username, password (the rest).
// The password view is empty when the username length overruns.
std::string_view password_of(bytes ext);

// Wisp header in front of a payload: writes 5 bytes at out.
inline void wisp_header(u8* out, u8 type, u32 id) { out[0] = type; store_le32(out + 1, id); }

}  // namespace wisp
