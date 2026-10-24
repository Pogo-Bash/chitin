// WebSocket frame parser fed in arbitrary chunks exactly as the connection feeds it (unparsed
// tail moved to the front only when needed). Properties: no memory errors; messages never exceed
// max_message; TEXT messages are valid UTF-8; the parse result does not depend on how the bytes
// were split (chunked vs all at once); SIMD unmasking equals the scalar reference.
#include <algorithm>
#include <cstdlib>
#include <vector>

#include "../src/simd.hpp"
#include "../src/ws.hpp"

using namespace wisp;

namespace {
constexpr std::size_t kMax = 4096;
struct Sink : WsSink {
  std::vector<std::vector<u8>> msgs;
  std::vector<u8> frag;
  bool frag_held = false;
  void on_message(u8 op, mbytes p) override {
    if (p.size() > kMax) std::abort();
    if (op == OP_TEXT && !utf8_valid_scalar(p.data(), p.size())) std::abort();
    std::vector<u8> m(p.begin(), p.end());
    m.push_back(op);
    msgs.push_back(std::move(m));
  }
  void on_control(u8 op, mbytes p) override {
    if (p.size() > 125) std::abort();
    std::vector<u8> m(p.begin(), p.end());
    m.push_back(u8(0x80 | op));
    msgs.push_back(std::move(m));
  }
  mbytes frag_acquire(std::size_t max) override {
    if (frag_held) std::abort();  // INVARIANT: one reassembly buffer per connection
    frag_held = true;
    frag.assign(max, 0);
    return {frag.data(), max};
  }
  void frag_release() override {
    if (!frag_held) std::abort();
    frag_held = false;
  }
};

struct Result { std::vector<std::vector<u8>> msgs; u16 err; };

Result run(const u8* data, std::size_t n, const std::vector<std::size_t>& cuts) {
  Sink s;
  WsReader r(kMax);
  std::vector<u8> rx(kMax + 14 + 4096);
  std::size_t off = 0, len = 0, fed = 0;
  std::size_t ci = 0;
  while (fed < n && !r.error() && !r.closed()) {
    std::size_t chunk = ci < cuts.size() ? cuts[ci++] : n - fed;
    if (chunk == 0) chunk = 1;
    if (off == len) off = len = 0;
    std::size_t need = std::max<std::size_t>(r.needed(), 2);
    if (off && (rx.size() - off < need || rx.size() - len < 4096)) {
      std::memmove(rx.data(), rx.data() + off, len - off);
      len -= off;
      off = 0;
    }
    std::size_t space = rx.size() - len;
    if (!space) std::abort();  // the connection relies on this never happening
    chunk = std::min({chunk, space, n - fed});
    std::memcpy(rx.data() + len, data + fed, chunk);
    len += chunk;
    fed += chunk;
    off += r.parse(rx.data() + off, len - off, s);
    if (r.needed() > kMax + 14) std::abort();
  }
  r.reset(s);
  if (s.frag_held) std::abort();  // reset released it
  return {s.msgs, r.error()};
}
}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const u8* data, std::size_t n) {
  if (n < 2) return 0;
  // first byte: chunking seed; the rest: the byte stream
  unsigned seed = data[0];
  data++; n--;
  std::vector<std::size_t> cuts;
  for (std::size_t i = 0, x = seed; i < 64; i++) { x = x * 1103515245 + 12345; cuts.push_back(1 + (x >> 16) % 300); }
  set_simd(true);
  Result a = run(data, n, {});
  Result b = run(data, n, cuts);
  set_simd(false);
  Result c = run(data, n, cuts);
  set_simd(true);
  if (a.err != b.err || a.msgs != b.msgs || b.err != c.err || b.msgs != c.msgs) std::abort();
  // differential unmasking at an arbitrary phase and alignment
  if (n >= 5) {
    std::vector<u8> x(data + 4, data + n), y = x;
    unsigned phase = data[0] & 3;
    unmask(x.data(), x.size(), data, phase);
    unmask_scalar(y.data(), y.size(), data, phase);
    if (x != y) std::abort();
    if (utf8_valid(x.data(), x.size()) != utf8_valid_scalar(x.data(), x.size())) std::abort();
  }
  return 0;
}
