// AUDIT A-5 regression: after SSL_write returned WANT_WRITE, the retry must pass OpenSSL the same
// bytes with the same length even if the reply queue's tail block grew in between (ByteQueue::append
// writes into the tail's free room). tls_next_piece with the pending length must give exactly the
// first attempt's bytes, whether they were gathered into the stage or taken in place.
// Pure (no OpenSSL): part of `make test`.
#include <cstdio>
#include <cstring>
#include <vector>
#include "../src/tls.hpp"
using namespace wisp;
static int fails = 0;
#define CHECK(c) do { if (!(c)) { std::printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #c); fails++; } } while (0)
int main() {
  static u8 a[100], b[30000], c[40000], stage[16384], first[16384];
  for (std::size_t k = 0; k < sizeof b; k++) b[k] = u8(k * 7 + 1);
  for (std::size_t k = 0; k < sizeof a; k++) a[k] = u8(k + 100);
  {  // gathered into the stage, then the tail grows past the stage
    iovec v[2] = {{a, 100}, {b, 16000}};
    int i = 0; std::size_t len1 = 0, len2 = 0;
    const u8* p1 = tls_next_piece(v, 2, i, stage, sizeof stage, 0, len1);
    CHECK(len1 == 16100 && p1 == stage);
    std::memcpy(first, p1, len1);
    v[1].iov_len = 16300;
    i = 0;
    std::size_t old = 0;
    tls_gather(v, 2, i, stage, sizeof stage, old);
    CHECK(old == 100);  // the audit's reproducer: plain re-gathering shrinks (16100 -> 100)
    i = 0;
    std::memset(stage, 0, sizeof stage);
    const u8* p2 = tls_next_piece(v, 2, i, stage, sizeof stage, len1, len2);
    CHECK(len2 == len1 && p2 && std::memcmp(p2, first, len1) == 0);
    std::printf("stage retry: first %zu bytes, retry %zu bytes (same bytes)\n", len1, len2);
  }
  {  // a large first iovec taken in place, then it grows
    iovec v[1] = {{c, 20000}};
    int i = 0; std::size_t len1 = 0, len2 = 0;
    const u8* p1 = tls_next_piece(v, 1, i, stage, sizeof stage, 0, len1);
    CHECK(p1 == c && len1 == 20000);
    v[0].iov_len = 39000;
    i = 0;
    const u8* p2 = tls_next_piece(v, 1, i, stage, sizeof stage, len1, len2);
    CHECK(p2 == c && len2 == 20000);
  }
  {  // pending spans several small iovecs that are now followed by more
    iovec v[4] = {{a, 50}, {b, 60}, {a + 50, 50}, {c, 100}};
    int i = 0; std::size_t len1 = 0, len2 = 0;
    iovec v1[3] = {v[0], v[1], v[2]};
    const u8* p1 = tls_next_piece(v1, 3, i, stage, sizeof stage, 0, len1);
    std::memcpy(first, p1, len1);
    i = 0;
    const u8* p2 = tls_next_piece(v, 4, i, stage, sizeof stage, len1, len2);
    CHECK(len1 == 160 && len2 == 160 && std::memcmp(p2, first, 160) == 0);
  }
  {  // nothing queued
    int i = 0; std::size_t len = 1;
    CHECK(!tls_next_piece(nullptr, 0, i, stage, sizeof stage, 0, len) && len == 0);
  }
  std::printf(fails ? "audit_tls_gather: %d failed\n" : "audit_tls_gather: ok\n", fails);
  return fails ? 1 : 0;
}
