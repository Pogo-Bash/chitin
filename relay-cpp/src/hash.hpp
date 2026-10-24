// SHA-1 (RFC 3174, only for the WebSocket accept key), SHA-256 (FIPS 180-4, token digests),
// base64 (RFC 4648) and a constant-time compare. Written here: no third-party code.
#pragma once
#include <array>
#include <string>

#include "common.hpp"

namespace wisp {

class Sha1 {
 public:
  Sha1();
  void update(bytes data);
  std::array<u8, 20> finish();

 private:
  void block(const u8* p);
  u32 h_[5];
  u8 buf_[64];
  u64 total_ = 0;
  std::size_t used_ = 0;
};

class Sha256 {
 public:
  Sha256();
  void update(bytes data);
  std::array<u8, 32> finish();

 private:
  void block(const u8* p);
  u32 h_[8];
  u8 buf_[64];
  u64 total_ = 0;
  std::size_t used_ = 0;
};

std::array<u8, 20> sha1(bytes data);
std::array<u8, 32> sha256(bytes data);

// Standard alphabet with '=' padding. `out` must hold base64_len(n) bytes.
constexpr std::size_t base64_len(std::size_t n) { return (n + 2) / 3 * 4; }
std::size_t base64_encode(bytes in, char* out);
std::string base64_encode(bytes in);
// Strict decoder (padding required, no whitespace). Returns false on any malformed input.
bool base64_decode(std::string_view in, std::string& out);

// Sec-WebSocket-Accept for a Sec-WebSocket-Key (RFC 6455 section 4.2.2). Writes 28 chars.
void websocket_accept(std::string_view key, char out[28]);

// Same-length compare whose time does not depend on where the inputs differ.
bool ct_equal(const u8* a, const u8* b, std::size_t n);

// Bytes from the operating system's CSPRNG (arc4random_buf on macOS/BSD, getrandom on Linux).
// Aborts if the kernel cannot supply them (never falls back to a predictable generator).
void secure_random(void* out, std::size_t n);

}  // namespace wisp
