// SIMD kernels: WebSocket unmasking and UTF-8 validation.
// NEON on ARM64 (always present), AVX2 or SSE2 on x86-64 (AVX2 chosen at run time), scalar elsewhere.
// set_simd(false) forces the scalar code (benchmark stages, differential fuzzing).
#pragma once
#include "common.hpp"

namespace wisp {

// XOR p[0..n) in place with the 4-byte masking key `key` (bytes as sent on the wire),
// where p[0] is at offset `phase` (0..3) within the key's repetition.
void unmask(u8* p, std::size_t n, const u8 key[4], unsigned phase);
void unmask_scalar(u8* p, std::size_t n, const u8 key[4], unsigned phase);

// Strict UTF-8 (RFC 3629): no overlongs, no surrogates, nothing above U+10FFFF.
bool utf8_valid(const u8* p, std::size_t n);
bool utf8_valid_scalar(const u8* p, std::size_t n);

void set_simd(bool on);
// Force one implementation by name ("neon", "avx2", "sse2", "scalar") whatever the CPU reports.
// Tests only (e.g. Rosetta 2 runs AVX2 code but hides it from cpuid). False if not compiled in.
bool force_simd(const char* name);
const char* simd_name();  // "neon", "avx2", "sse2" or "scalar"

}  // namespace wisp
