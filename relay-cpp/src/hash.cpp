#include "hash.hpp"

#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#if defined(__linux__)
#include <sys/random.h>
#endif

namespace wisp {

namespace {
inline u32 rol(u32 x, int n) { return (x << n) | (x >> (32 - n)); }
inline u32 ror(u32 x, int n) { return (x >> n) | (x << (32 - n)); }
inline u32 be32(const u8* p) { return (u32(p[0]) << 24) | (u32(p[1]) << 16) | (u32(p[2]) << 8) | u32(p[3]); }

constexpr u32 K256[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

// Shared Merkle-Damgard padding: 0x80, zeros, 64-bit big-endian bit length.
template <class H>
void md_update(H& h, u8* buf, std::size_t& used, u64& total, bytes data) {
  total += data.size();
  std::size_t i = 0;
  if (used) {
    std::size_t take = std::min<std::size_t>(64 - used, data.size());
    std::memcpy(buf + used, data.data(), take);
    used += take;
    i = take;
    if (used < 64) return;
    h(buf);
    used = 0;
  }
  for (; i + 64 <= data.size(); i += 64) h(data.data() + i);
  if (i < data.size()) {
    used = data.size() - i;
    std::memcpy(buf, data.data() + i, used);
  }
}

template <class H>
void md_finish(H& h, u8* buf, std::size_t used, u64 total) {
  u64 bits = total * 8;
  buf[used++] = 0x80;
  if (used > 56) {
    std::memset(buf + used, 0, 64 - used);
    h(buf);
    used = 0;
  }
  std::memset(buf + used, 0, 56 - used);
  for (int k = 0; k < 8; k++) buf[56 + k] = u8(bits >> (56 - 8 * k));
  h(buf);
}
}  // namespace

Sha1::Sha1() : h_{0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0} {}

void Sha1::block(const u8* p) {
  u32 w[80];
  for (int i = 0; i < 16; i++) w[i] = be32(p + 4 * i);
  for (int i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
  u32 a = h_[0], b = h_[1], c = h_[2], d = h_[3], e = h_[4];
  for (int i = 0; i < 80; i++) {
    u32 f, k;
    if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
    else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
    else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
    else { f = b ^ c ^ d; k = 0xCA62C1D6; }
    u32 t = rol(a, 5) + f + e + k + w[i];
    e = d; d = c; c = rol(b, 30); b = a; a = t;
  }
  h_[0] += a; h_[1] += b; h_[2] += c; h_[3] += d; h_[4] += e;
}

void Sha1::update(bytes data) {
  auto f = [this](const u8* p) { block(p); };
  md_update(f, buf_, used_, total_, data);
}

std::array<u8, 20> Sha1::finish() {
  auto f = [this](const u8* p) { block(p); };
  md_finish(f, buf_, used_, total_);
  std::array<u8, 20> out;
  for (int i = 0; i < 5; i++) for (int k = 0; k < 4; k++) out[4 * i + k] = u8(h_[i] >> (24 - 8 * k));
  return out;
}

Sha256::Sha256()
    : h_{0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19} {}

void Sha256::block(const u8* p) {
  u32 w[64];
  for (int i = 0; i < 16; i++) w[i] = be32(p + 4 * i);
  for (int i = 16; i < 64; i++) {
    u32 s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >> 3);
    u32 s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  u32 a = h_[0], b = h_[1], c = h_[2], d = h_[3], e = h_[4], f = h_[5], g = h_[6], h = h_[7];
  for (int i = 0; i < 64; i++) {
    u32 S1 = ror(e, 6) ^ ror(e, 11) ^ ror(e, 25);
    u32 ch = (e & f) ^ (~e & g);
    u32 t1 = h + S1 + ch + K256[i] + w[i];
    u32 S0 = ror(a, 2) ^ ror(a, 13) ^ ror(a, 22);
    u32 maj = (a & b) ^ (a & c) ^ (b & c);
    u32 t2 = S0 + maj;
    h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
  }
  h_[0] += a; h_[1] += b; h_[2] += c; h_[3] += d; h_[4] += e; h_[5] += f; h_[6] += g; h_[7] += h;
}

void Sha256::update(bytes data) {
  auto f = [this](const u8* p) { block(p); };
  md_update(f, buf_, used_, total_, data);
}

std::array<u8, 32> Sha256::finish() {
  auto f = [this](const u8* p) { block(p); };
  md_finish(f, buf_, used_, total_);
  std::array<u8, 32> out;
  for (int i = 0; i < 8; i++) for (int k = 0; k < 4; k++) out[4 * i + k] = u8(h_[i] >> (24 - 8 * k));
  return out;
}

std::array<u8, 20> sha1(bytes data) { Sha1 s; s.update(data); return s.finish(); }
std::array<u8, 32> sha256(bytes data) { Sha256 s; s.update(data); return s.finish(); }

static constexpr char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::size_t base64_encode(bytes in, char* out) {
  std::size_t o = 0, i = 0, n = in.size();
  for (; i + 3 <= n; i += 3) {
    u32 v = (u32(in[i]) << 16) | (u32(in[i + 1]) << 8) | in[i + 2];
    out[o++] = B64[v >> 18]; out[o++] = B64[(v >> 12) & 63]; out[o++] = B64[(v >> 6) & 63]; out[o++] = B64[v & 63];
  }
  if (n - i == 1) {
    u32 v = u32(in[i]) << 16;
    out[o++] = B64[v >> 18]; out[o++] = B64[(v >> 12) & 63]; out[o++] = '='; out[o++] = '=';
  } else if (n - i == 2) {
    u32 v = (u32(in[i]) << 16) | (u32(in[i + 1]) << 8);
    out[o++] = B64[v >> 18]; out[o++] = B64[(v >> 12) & 63]; out[o++] = B64[(v >> 6) & 63]; out[o++] = '=';
  }
  return o;
}

std::string base64_encode(bytes in) {
  std::string s(base64_len(in.size()), '\0');
  base64_encode(in, s.data());
  return s;
}

static int b64val(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

bool base64_decode(std::string_view in, std::string& out) {
  out.clear();
  if (in.size() % 4) return false;
  for (std::size_t i = 0; i < in.size(); i += 4) {
    bool last = i + 4 == in.size();
    int v[4];
    int pad = 0;
    for (int k = 0; k < 4; k++) {
      char c = in[i + k];
      if (c == '=') {
        if (!last || k < 2) return false;
        pad++;
        v[k] = 0;
      } else {
        if (pad) return false;  // data after padding
        v[k] = b64val(c);
        if (v[k] < 0) return false;
      }
    }
    u32 w = (u32(v[0]) << 18) | (u32(v[1]) << 12) | (u32(v[2]) << 6) | u32(v[3]);
    // canonical: the unused bits of the last symbol must be zero
    if (pad == 1 && (w & 0xff)) return false;
    if (pad == 2 && (w & 0xffff)) return false;
    out.push_back(char(w >> 16));
    if (pad < 2) out.push_back(char((w >> 8) & 0xff));
    if (pad < 1) out.push_back(char(w & 0xff));
  }
  return true;
}

void websocket_accept(std::string_view key, char out[28]) {
  static constexpr std::string_view GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  Sha1 s;
  s.update(as_bytes(key));
  s.update(as_bytes(GUID));
  auto d = s.finish();
  base64_encode(bytes(d.data(), d.size()), out);
}

bool ct_equal(const u8* a, const u8* b, std::size_t n) {
  volatile u8 acc = 0;
  for (std::size_t i = 0; i < n; i++) acc = acc | u8(a[i] ^ b[i]);
  return acc == 0;
}

void secure_random(void* out, std::size_t n) {
#if defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__) || defined(__NetBSD__)
  arc4random_buf(out, n);
#else
  auto* p = static_cast<unsigned char*>(out);
  while (n) {
    ssize_t k = getrandom(p, n, 0);
    if (k < 0) {
      if (errno == EINTR) continue;
      std::fputs("wisp: getrandom failed\n", stderr);
      std::abort();
    }
    p += k;
    n -= std::size_t(k);
  }
#endif
}

}  // namespace wisp
