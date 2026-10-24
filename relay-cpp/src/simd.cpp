#include "simd.hpp"

#if defined(__aarch64__) || defined(__ARM_NEON)
#include <arm_neon.h>
#define WISP_NEON 1
#elif defined(__x86_64__) || defined(_M_X64)
#include <immintrin.h>
#define WISP_X86 1
#endif

namespace wisp {

namespace {
enum class Impl { Scalar, Neon, Sse2, Avx2 };

Impl detect() {
#if WISP_NEON
  return Impl::Neon;
#elif WISP_X86
  __builtin_cpu_init();
  if (__builtin_cpu_supports("avx2")) return Impl::Avx2;
  return Impl::Sse2;
#else
  return Impl::Scalar;
#endif
}

Impl g_best = detect();
Impl g_impl = g_best;

// The key rotated so that byte 0 of the result applies to an input byte at `phase`.
inline u32 rotated_key(const u8 key[4], unsigned phase) {
  u8 r[4] = {key[phase & 3], key[(phase + 1) & 3], key[(phase + 2) & 3], key[(phase + 3) & 3]};
  u32 k;
  std::memcpy(&k, r, 4);
  return k;
}
}  // namespace

void set_simd(bool on) { g_impl = on ? g_best : Impl::Scalar; }

bool force_simd(const char* n) {
  std::string_view s(n);
  if (s == "scalar") { g_impl = Impl::Scalar; return true; }
#if WISP_NEON
  if (s == "neon") { g_impl = Impl::Neon; return true; }
#endif
#if WISP_X86
  if (s == "avx2") { g_impl = Impl::Avx2; return true; }
  if (s == "sse2") { g_impl = Impl::Sse2; return true; }
#endif
  return false;
}

const char* simd_name() {
  switch (g_impl) {
    case Impl::Neon: return "neon";
    case Impl::Sse2: return "sse2";
    case Impl::Avx2: return "avx2";
    default: return "scalar";
  }
}

void unmask_scalar(u8* p, std::size_t n, const u8 key[4], unsigned phase) {
  // Word-at-a-time scalar: the reference implementation the vector paths are fuzzed against.
  std::size_t i = 0;
  for (; i < n && ((phase + i) & 3); i++) p[i] ^= key[(phase + i) & 3];
  u32 k32;
  std::memcpy(&k32, key, 4);
  u64 k64 = (u64(k32) << 32) | k32;
  for (; i + 8 <= n; i += 8) {
    u64 v;
    std::memcpy(&v, p + i, 8);
    v ^= k64;
    std::memcpy(p + i, &v, 8);
  }
  for (; i < n; i++) p[i] ^= key[(phase + i) & 3];
}

#if WISP_X86
__attribute__((target("avx2"))) static void unmask_avx2(u8* p, std::size_t n, u32 k) {
  __m256i m = _mm256_set1_epi32(int(k));
  std::size_t i = 0;
  for (; i + 128 <= n; i += 128) {
    __m256i a = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(p + i));
    __m256i b = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(p + i + 32));
    __m256i c = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(p + i + 64));
    __m256i d = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(p + i + 96));
    _mm256_storeu_si256(reinterpret_cast<__m256i*>(p + i), _mm256_xor_si256(a, m));
    _mm256_storeu_si256(reinterpret_cast<__m256i*>(p + i + 32), _mm256_xor_si256(b, m));
    _mm256_storeu_si256(reinterpret_cast<__m256i*>(p + i + 64), _mm256_xor_si256(c, m));
    _mm256_storeu_si256(reinterpret_cast<__m256i*>(p + i + 96), _mm256_xor_si256(d, m));
  }
  for (; i + 32 <= n; i += 32) {
    __m256i a = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(p + i));
    _mm256_storeu_si256(reinterpret_cast<__m256i*>(p + i), _mm256_xor_si256(a, m));
  }
  u8 kb[4];
  std::memcpy(kb, &k, 4);
  for (; i < n; i++) p[i] ^= kb[i & 3];
}

static void unmask_sse2(u8* p, std::size_t n, u32 k) {
  __m128i m = _mm_set1_epi32(int(k));
  std::size_t i = 0;
  for (; i + 64 <= n; i += 64) {
    __m128i a = _mm_loadu_si128(reinterpret_cast<const __m128i*>(p + i));
    __m128i b = _mm_loadu_si128(reinterpret_cast<const __m128i*>(p + i + 16));
    __m128i c = _mm_loadu_si128(reinterpret_cast<const __m128i*>(p + i + 32));
    __m128i d = _mm_loadu_si128(reinterpret_cast<const __m128i*>(p + i + 48));
    _mm_storeu_si128(reinterpret_cast<__m128i*>(p + i), _mm_xor_si128(a, m));
    _mm_storeu_si128(reinterpret_cast<__m128i*>(p + i + 16), _mm_xor_si128(b, m));
    _mm_storeu_si128(reinterpret_cast<__m128i*>(p + i + 32), _mm_xor_si128(c, m));
    _mm_storeu_si128(reinterpret_cast<__m128i*>(p + i + 48), _mm_xor_si128(d, m));
  }
  for (; i + 16 <= n; i += 16) {
    __m128i a = _mm_loadu_si128(reinterpret_cast<const __m128i*>(p + i));
    _mm_storeu_si128(reinterpret_cast<__m128i*>(p + i), _mm_xor_si128(a, m));
  }
  u8 kb[4];
  std::memcpy(kb, &k, 4);
  for (; i < n; i++) p[i] ^= kb[i & 3];
}
#endif

#if WISP_NEON
static void unmask_neon(u8* p, std::size_t n, u32 k) {
  uint8x16_t m = vreinterpretq_u8_u32(vdupq_n_u32(k));
  std::size_t i = 0;
  for (; i + 64 <= n; i += 64) {
    uint8x16x4_t v;
    v.val[0] = vld1q_u8(p + i);
    v.val[1] = vld1q_u8(p + i + 16);
    v.val[2] = vld1q_u8(p + i + 32);
    v.val[3] = vld1q_u8(p + i + 48);
    vst1q_u8(p + i, veorq_u8(v.val[0], m));
    vst1q_u8(p + i + 16, veorq_u8(v.val[1], m));
    vst1q_u8(p + i + 32, veorq_u8(v.val[2], m));
    vst1q_u8(p + i + 48, veorq_u8(v.val[3], m));
  }
  for (; i + 16 <= n; i += 16) vst1q_u8(p + i, veorq_u8(vld1q_u8(p + i), m));
  u8 kb[4];
  std::memcpy(kb, &k, 4);
  for (; i < n; i++) p[i] ^= kb[i & 3];
}
#endif

void unmask(u8* p, std::size_t n, const u8 key[4], unsigned phase) {
  if (n < 32 || g_impl == Impl::Scalar) return unmask_scalar(p, n, key, phase);
  u32 k = rotated_key(key, phase);  // after rotation the key repeats from p[0]
  switch (g_impl) {
#if WISP_NEON
    case Impl::Neon: return unmask_neon(p, n, k);
#endif
#if WISP_X86
    case Impl::Avx2: return unmask_avx2(p, n, k);
    case Impl::Sse2: return unmask_sse2(p, n, k);
#endif
    default: return unmask_scalar(p, n, key, phase);
  }
}

// ---- UTF-8 -------------------------------------------------------------------------------
bool utf8_valid_scalar(const u8* p, std::size_t n) {
  std::size_t i = 0;
  while (i < n) {
    u8 c = p[i];
    if (c < 0x80) { i++; continue; }
    std::size_t len;
    u32 cp;
    if (c >= 0xC2 && c <= 0xDF) { len = 2; cp = c & 0x1F; }
    else if (c >= 0xE0 && c <= 0xEF) { len = 3; cp = c & 0x0F; }
    else if (c >= 0xF0 && c <= 0xF4) { len = 4; cp = c & 0x07; }
    else return false;  // continuation byte, C0/C1 overlong lead, or F5..FF
    if (n - i < len) return false;
    for (std::size_t k = 1; k < len; k++) {
      u8 d = p[i + k];
      if ((d & 0xC0) != 0x80) return false;
      cp = (cp << 6) | (d & 0x3F);
    }
    if (len == 3 && (cp < 0x800 || (cp >= 0xD800 && cp <= 0xDFFF))) return false;
    if (len == 4 && (cp < 0x10000 || cp > 0x10FFFF)) return false;
    i += len;
  }
  return true;
}

// Vector ASCII fast path: skip 16-byte blocks with no high bit; validate the rest with the scalar
// decoder from the start of the block (a block start may be inside a multi-byte sequence only if a
// previous non-ASCII run ended inside it, which the scalar decoder resynchronises on by design:
// we hand it the whole remainder from the first non-ASCII block, so it never starts mid-sequence).
bool utf8_valid(const u8* p, std::size_t n) {
  std::size_t i = 0;
  if (g_impl != Impl::Scalar) {
#if WISP_NEON
    for (; i + 16 <= n; i += 16) {
      if (vmaxvq_u8(vld1q_u8(p + i)) >= 0x80) break;
    }
#elif WISP_X86
    for (; i + 16 <= n; i += 16) {
      if (_mm_movemask_epi8(_mm_loadu_si128(reinterpret_cast<const __m128i*>(p + i)))) break;
    }
#endif
  }
  // p[0..i) is pure ASCII, so p+i is at a character boundary.
  return utf8_valid_scalar(p + i, n - i);
}

}  // namespace wisp
