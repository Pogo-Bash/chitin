// TLS-adjacent: the record gathering in front of SSL_write (tls_gather), driven the way
// TlsConn::writev drives it, with a fake record writer that takes arbitrary amounts or says
// "want write", against a reply queue consumed from the front as Conn::flush consumes it.
// Properties: no memory errors; every piece is at most max(cap, one iovec); a gathered piece is
// a whole number of iovecs; the bytes the writer receives are exactly the queue's bytes in order
// (no loss, duplication or reordering across partial writes and retries); a retry after
// "want write" starts with the same bytes (OpenSSL requires it).
#include <sys/uio.h>

#include <cstdlib>
#include <cstring>
#include <deque>
#include <vector>

#include "../src/tls.hpp"

using namespace wisp;

namespace {
struct In {
  const u8* p; std::size_t n;
  u32 take(u32 mod) {
    if (n < 2) return 0;
    u32 v = u32(p[0]) | u32(p[1]) << 8;
    p += 2; n -= 2;
    return mod ? v % mod : v;
  }
};
}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const u8* data, std::size_t size) {
  In in{data, size};
  const std::size_t cap = 1 + in.take(20000);
  std::vector<u8> src;
  std::deque<std::vector<u8>> q;  // the reply queue: blocks of any size, possibly empty
  int nblocks = int(in.take(48));
  for (int b = 0; b < nblocks; b++) {
    std::size_t len = in.take(4) == 0 ? 0 : in.take(40000);
    std::vector<u8> blk(len);
    for (std::size_t k = 0; k < len; k++) blk[k] = u8(src.size() + k * 131);
    src.insert(src.end(), blk.begin(), blk.end());
    q.push_back(std::move(blk));
  }
  std::size_t front_off = 0;  // bytes of q.front() already sent
  std::vector<u8> out;
  std::vector<u8> stage(cap);
  std::vector<u8> retry_prefix;  // after want-write: the exact bytes the next attempt must pass (AUDIT A-5)
  std::size_t pending = 0;
  for (int round = 0; round < 10000 && !q.empty(); round++) {
    std::vector<iovec> v;
    for (std::size_t k = 0; k < q.size() && v.size() < 64; k++) {
      u8* base = q[k].data() + (k == 0 ? front_off : 0);
      v.push_back({base, q[k].size() - (k == 0 ? front_off : 0)});
    }
    // TlsConn::writev with a fake SSL_write_ex
    std::size_t total = 0;
    int i = 0;
    bool want = false;
    for (;;) {
      std::size_t len;
      int before = i;
      const u8* p = tls_next_piece(v.data(), int(v.size()), i, stage.data(), cap, pending, len);
      if (!len) { if (pending) std::abort(); break; }
      if (pending) {
        if (len != pending || std::memcmp(p, retry_prefix.data(), len)) std::abort();  // same bytes, same length
        pending = 0;
        retry_prefix.clear();
      } else if (p == stage.data()) {
        if (len > cap) std::abort();
        std::size_t sum = 0;
        for (int k = before; k < i; k++) sum += v[k].iov_len;
        if (sum != len) std::abort();  // whole iovecs only
      } else if (i != before + 1 && !(i > before && v[i - 1].iov_len == len)) {
        std::abort();
      }
      u32 mode = in.take(8);
      if (mode == 0 && in.n) {  // want write
        retry_prefix.assign(p, p + len);
        pending = len;
        want = true;
        break;
      }
      std::size_t wrote = mode == 1 ? 1 + in.take(u32(len)) % len : len;
      out.insert(out.end(), p, p + wrote);
      total += wrote;
      if (wrote < len) break;
    }
    (void)want;
    // Conn::flush: consume `total` bytes from the front
    std::size_t n = total;
    while (n && !q.empty()) {
      std::size_t left = q.front().size() - front_off;
      if (n >= left) { n -= left; q.pop_front(); front_off = 0; }
      else { front_off += n; n = 0; }
    }
    while (!q.empty() && q.front().size() == front_off) { q.pop_front(); front_off = 0; }
    // ByteQueue::append grows the tail block in place between attempts
    if (!q.empty() && in.take(3) == 0) {
      std::size_t more = in.take(4096);
      for (std::size_t k = 0; k < more; k++) { u8 b = u8(src.size() * 131 + 7); q.back().push_back(b); src.push_back(b); }
    }
    if (!in.n && total == 0) break;
  }
  // memcmp with size 0 still requires non-null pointers (empty input: both vectors are empty, data() is null)
  if (out.size() > src.size() || (!out.empty() && std::memcmp(out.data(), src.data(), out.size()))) std::abort();
  if (q.empty() && out.size() != src.size()) std::abort();
  return 0;
}
