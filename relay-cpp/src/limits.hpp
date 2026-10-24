// Limits shared by every worker thread, lock-free.
//
// Invariant (no bypass under concurrency): try_acquire() is a CAS loop "increment only if the
// value is below the limit", so the counter can never exceed the limit, whatever the interleaving.
// Each successful try_acquire() is paired with exactly one release() (the caller holds a ticket).
#pragma once
#include <atomic>
#include <memory>

#include "ip.hpp"

namespace wisp {

inline bool cas_acquire(std::atomic<u32>& n, u32 limit) {
  u32 v = n.load(std::memory_order_relaxed);
  do {
    if (v >= limit) return false;
  } while (!n.compare_exchange_weak(v, v + 1, std::memory_order_acq_rel, std::memory_order_relaxed));
  return true;
}

class SharedCounter {
 public:
  bool try_acquire(u32 limit) { return cas_acquire(n_, limit); }
  void release() { n_.fetch_sub(1, std::memory_order_acq_rel); }
  u32 value() const { return n_.load(std::memory_order_relaxed); }

 private:
  alignas(64) std::atomic<u32> n_{0};
};

// Per-client-address connection counts: a fixed table of counters indexed by a keyed hash of the
// address key (IPv4 address, IPv6 /prefix). No keys are stored, so there is nothing to insert or
// delete and nothing an attacker can fill up. Two addresses that share a slot share one limit:
// that only ever makes the limit stricter, never looser, and the hash key is random per process
// so a client cannot pick an address that collides with someone else's.
class PerIpTable {
 public:
  explicit PerIpTable(unsigned slots_log2 = 16);
  bool try_acquire(const IpKey& k, u32 limit, std::size_t& slot);
  void release(std::size_t slot);
  u32 value(const IpKey& k) const;
  std::size_t slot_of(const IpKey& k) const;
  std::size_t hash_of(const IpKey& k) const;  // keyed hash, before masking

 private:
  std::size_t mask_;
  std::unique_ptr<std::atomic<u32>[]> c_;  // 4 bytes per slot
  u64 k0_, k1_;
};

// Per-address event rate (AUDIT A-6: TLS handshakes per second): one 64-bit cell per hash slot
// holding (second, count), updated with CAS. At most `limit` events per address per wall second;
// a slot shared by two addresses shares one limit (stricter, never looser), as in PerIpTable.
class PerIpRate {
 public:
  explicit PerIpRate(unsigned slots_log2 = 14);
  bool try_take(const IpKey& k, u32 limit, u32 now_sec);

 private:
  PerIpTable keyer_;  // only its keyed hash is used
  std::size_t mask_;
  std::unique_ptr<std::atomic<u64>[]> c_;
};

}  // namespace wisp
