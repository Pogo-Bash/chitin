// Destination policy and per-session limits: a port of relay-guard's Policy, Session, Window and
// TokenBucket with fixed memory (no allocation after a session is created).
#pragma once
#include <algorithm>
#include <bitset>
#include <string>
#include <vector>

#include "ip.hpp"

namespace wisp {

enum class DestCheck { Ok, BlockedPort, InvalidHost, BlockedHost };

struct PolicyConfig {
  std::vector<u16> port_allow{80, 443};
  std::vector<std::string> host_allow;  // normalized; required non-empty
  std::vector<Cidr> block;              // operator CIDRs + own addresses (+ interfaces)
  bool allow_private = false;
  unsigned max_streams = 64;
  unsigned max_connects_per_minute = 120;
  unsigned scan_hosts_per_minute = 60;     // capped at kMaxScanHosts
  unsigned scan_failures_per_minute = 20;
  unsigned max_concurrent_lookups = 8;
};

constexpr unsigned kMaxScanHosts = 4096;

class Policy {
 public:
  explicit Policy(PolicyConfig c);
  DestCheck check_destination(std::string_view host, u16 port) const;
  // Whether a resolved (or literal) address may be connected to.
  bool address_ok(const Ip& ip) const { return cfg_.allow_private || !blocked_address(ip, cfg_.block); }
  const PolicyConfig& cfg() const { return cfg_; }

 private:
  PolicyConfig cfg_;
  std::bitset<65536> port_ok_;
};

// Counts in a sliding window of 60 s at 1 s resolution. Conservative: an event stays counted for
// 60 to 61 s (never less than relay-guard's exact 60 s window).
class MinuteCounter {
 public:
  void add(i64 now_ms);
  unsigned count(i64 now_ms);

 private:
  void advance(i64 sec);
  unsigned buckets_[62]{};
  i64 head_sec_ = -1;  // second of the newest bucket
};

// Distinct names seen in the last 60 s, exact up to `limit` + 1 (all that is needed to decide
// "more than limit"). Storage of limit + 1 entries, allocated once.
class DistinctHosts {
 public:
  // Starts with room for 8 names and grows (doubling) up to limit + 1, so an idle session costs
  // 128 bytes here rather than the whole table.
  explicit DistinctHosts(unsigned limit) : limit_(limit > kMaxScanHosts ? kMaxScanHosts : limit), e_(std::min(limit_ + 1, 8u)) {}
  // Record `h` and return the number of distinct hashes seen in the window (saturating at limit+1).
  unsigned add(u64 h, i64 now_ms);

 private:
  struct Entry { u64 h; i64 at; };
  unsigned limit_;
  std::vector<Entry> e_;
  unsigned n_ = 0;
};

class Session {
 public:
  explicit Session(const Policy& p) : p_(p), hosts_(p.cfg().scan_hosts_per_minute) {}
  // relay-guard Session.admit: true when admitted (and recorded), false = throttled.
  bool admit(std::string_view host, unsigned open_streams, i64 now_ms);
  void record_failure(i64 now_ms) { failures_.add(now_ms); }
  bool lookup_slot() { if (lookups_ >= p_.cfg().max_concurrent_lookups) return false; lookups_++; return true; }
  void lookup_done() { if (lookups_) lookups_--; }
  unsigned connects(i64 now_ms) { return connects_.count(now_ms); }

 private:
  const Policy& p_;
  MinuteCounter connects_, failures_;
  DistinctHosts hosts_;
  i64 throttled_until_ = 0;
  unsigned lookups_ = 0;
};

// Bytes per second, both directions together; rate 0 = unlimited. Burst = one second's worth.
// Bytes are always taken (the level may go negative: debt); a direction whose bucket is not
// ready() stops reading its socket until wait_ms() has passed. That turns the limit into TCP
// backpressure instead of buffering.
class TokenBucket {
 public:
  explicit TokenBucket(double rate) : rate_(rate), level_(rate) {}
  bool unlimited() const { return rate_ <= 0; }
  bool ready(i64 now_ms) { if (rate_ <= 0) return true; refill(now_ms); return level_ >= 0; }
  void take(std::size_t n, i64 now_ms) { if (rate_ > 0) { refill(now_ms); level_ -= double(n); } }
  // Milliseconds until ready() (>= 1).
  i64 wait_ms() const;

 private:
  void refill(i64 now_ms);
  double rate_, level_;
  i64 at_ = -1;
};

u64 host_hash(std::string_view lowercase_host);

}  // namespace wisp
