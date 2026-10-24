#include "limits.hpp"

#include "hash.hpp"

namespace wisp {

namespace {
inline u64 mix(u64 x) {
  x ^= x >> 33; x *= 0xff51afd7ed558ccdull; x ^= x >> 33; x *= 0xc4ceb9fe1a85ec53ull; x ^= x >> 33;
  return x;
}
}  // namespace

PerIpTable::PerIpTable(unsigned slots_log2) : mask_((std::size_t(1) << slots_log2) - 1), c_(new std::atomic<u32>[mask_ + 1]) {
  for (std::size_t i = 0; i <= mask_; i++) c_[i].store(0, std::memory_order_relaxed);
  u64 k[2];
  secure_random(k, sizeof k);
  k0_ = k[0];
  k1_ = k[1];
}

std::size_t PerIpTable::slot_of(const IpKey& k) const { return hash_of(k) & mask_; }

std::size_t PerIpTable::hash_of(const IpKey& k) const {
  u64 lo = u64(k.v), hi = u64(k.v >> 64);
  u64 h = mix(lo ^ k0_);
  h = mix(h ^ hi ^ k1_);
  h = mix(h ^ (u64(k.kind) << 56) ^ k0_);
  return std::size_t(h);
}

bool PerIpTable::try_acquire(const IpKey& k, u32 limit, std::size_t& slot) {
  slot = slot_of(k);
  return cas_acquire(c_[slot], limit);
}

void PerIpTable::release(std::size_t slot) { c_[slot & mask_].fetch_sub(1, std::memory_order_acq_rel); }

PerIpRate::PerIpRate(unsigned slots_log2) : keyer_(4), mask_((std::size_t(1) << slots_log2) - 1), c_(new std::atomic<u64>[mask_ + 1]) {
  for (std::size_t i = 0; i <= mask_; i++) c_[i].store(0, std::memory_order_relaxed);
}

bool PerIpRate::try_take(const IpKey& k, u32 limit, u32 now_sec) {
  // slot_of masks to the keyer's own (tiny) table; use the full hash instead
  std::size_t h = keyer_.hash_of(k) & mask_;
  std::atomic<u64>& c = c_[h];
  u64 v = c.load(std::memory_order_relaxed);
  for (;;) {
    u32 sec = u32(v >> 32), n = u32(v);
    u64 next;
    if (sec != now_sec) next = (u64(now_sec) << 32) | 1;
    else if (n >= limit) return false;
    else next = v + 1;
    if (c.compare_exchange_weak(v, next, std::memory_order_acq_rel, std::memory_order_relaxed)) return true;
  }
}

u32 PerIpTable::value(const IpKey& k) const { return c_[slot_of(k)].load(std::memory_order_relaxed); }

}  // namespace wisp
