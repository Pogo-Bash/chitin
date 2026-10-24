#include "policy.hpp"

#include <algorithm>
#include <cmath>
#include <random>

namespace wisp {

Policy::Policy(PolicyConfig c) : cfg_(std::move(c)) {
  for (u16 p : cfg_.port_allow) port_ok_.set(p);
  port_ok_.reset(0);
  for (auto& h : cfg_.host_allow) h = normalize_host(h);
  if (cfg_.scan_hosts_per_minute > kMaxScanHosts) cfg_.scan_hosts_per_minute = kMaxScanHosts;
}

DestCheck Policy::check_destination(std::string_view host, u16 port) const {
  if (!port_ok_.test(port)) return DestCheck::BlockedPort;
  if (!valid_host(host)) return DestCheck::InvalidHost;
  if (!host_allowed(host, cfg_.host_allow)) return DestCheck::BlockedHost;
  return DestCheck::Ok;
}

void MinuteCounter::advance(i64 sec) {
  if (head_sec_ < 0 || sec - head_sec_ >= 62) {
    std::fill(std::begin(buckets_), std::end(buckets_), 0u);
    head_sec_ = sec;
    return;
  }
  while (head_sec_ < sec) {
    head_sec_++;
    buckets_[head_sec_ % 62] = 0;
  }
}

void MinuteCounter::add(i64 now_ms) {
  advance(now_ms / 1000);
  buckets_[head_sec_ % 62]++;
}

unsigned MinuteCounter::count(i64 now_ms) {
  advance(now_ms / 1000);
  unsigned n = 0;
  // the current second plus the 60 before it
  for (int k = 0; k <= 60; k++) n += buckets_[(head_sec_ - k + 62 * 2) % 62];
  return n;
}

unsigned DistinctHosts::add(u64 h, i64 now_ms) {
  const i64 cutoff = now_ms - 60000;
  unsigned live = 0;
  bool found = false;
  // compact out expired entries while looking for h
  for (unsigned i = 0; i < n_; i++) {
    if (e_[i].at < cutoff) continue;
    if (e_[i].h == h) { e_[i].at = now_ms; found = true; }
    e_[live++] = e_[i];
  }
  n_ = live;
  if (!found) {
    if (n_ == e_.size() && e_.size() < limit_ + 1) e_.resize(std::min<std::size_t>(e_.size() * 2, limit_ + 1));
    if (n_ < e_.size()) e_[n_++] = Entry{h, now_ms};
    else return limit_ + 1;  // table full of live distinct names: over the limit
  }
  return n_;
}

bool Session::admit(std::string_view host, unsigned open_streams, i64 now) {
  const auto& c = p_.cfg();
  if (open_streams >= c.max_streams) return false;
  if (now < throttled_until_) return false;
  if (connects_.count(now) >= c.max_connects_per_minute) return false;
  connects_.add(now);
  char buf[256];
  unsigned distinct = hosts_.add(host_hash(normalize_host_into(host, buf)), now);
  if (distinct > c.scan_hosts_per_minute || failures_.count(now) > c.scan_failures_per_minute) {
    throttled_until_ = now + 60000;
    return false;
  }
  return true;
}

void TokenBucket::refill(i64 now) {
  if (at_ < 0) { at_ = now; return; }
  if (now > at_) {
    level_ = std::min(rate_, level_ + double(now - at_) / 1000.0 * rate_);
    at_ = now;
  }
}

i64 TokenBucket::wait_ms() const {
  if (rate_ <= 0 || level_ >= 0) return 1;
  return std::max<i64>(1, i64(std::ceil(-level_ / rate_ * 1000.0)));
}

namespace {
u64 seed_key() {
  std::random_device rd;
  return (u64(rd()) << 32) ^ rd();
}
const u64 kHashKey = seed_key();
inline u64 mix(u64 x) {
  x ^= x >> 33; x *= 0xff51afd7ed558ccdull; x ^= x >> 33; x *= 0xc4ceb9fe1a85ec53ull; x ^= x >> 33;
  return x;
}
}  // namespace

// Keyed (per-process random key) so a client cannot choose names that collide in the scan detector.
u64 host_hash(std::string_view s) {
  u64 h = kHashKey ^ (s.size() * 0x9e3779b97f4a7c15ull);
  std::size_t i = 0;
  for (; i + 8 <= s.size(); i += 8) {
    u64 w;
    std::memcpy(&w, s.data() + i, 8);
    h = mix(h ^ w) + 0x9e3779b97f4a7c15ull;
  }
  u64 tail = 0;
  std::memcpy(&tail, s.data() + i, s.size() - i);
  return mix(h ^ tail ^ kHashKey);
}

}  // namespace wisp
