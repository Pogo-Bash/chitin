// Non-blocking stub resolver on the worker's event loop (the C++ counterpart of relay-guard's
// c-ares lookup): UDP A + AAAA queries to the configured name server, one socket per lookup
// (kernel-chosen source port) and a random 16-bit id per query, answers accepted only from the
// server's address and only when they match the question. A lookup that is not answered within
// its timeout fails; nothing blocks a thread, so a dead name server cannot stall the relay
// (SECURITY-REVIEW finding 3). /etc/hosts is not read; "localhost" and "*.localhost" answer the
// loopback addresses (which the block list then refuses).
#pragma once
#include <sys/socket.h>

#include <string>
#include <unordered_map>
#include <vector>

#include "dnsmsg.hpp"
#include "loop.hpp"

namespace wisp {

struct LookupClient {
  virtual ~LookupClient() = default;
  // ok: at least one address (IPv6 first, as returned). On failure count == 0.
  virtual void on_resolved(const DnsAnswer& v6, const DnsAnswer& v4, bool ok) = 0;
};

class Resolver;

class Lookup final : public Handle {
 public:
  // `c` no longer wants the answer. The query is dropped when nobody is left waiting.
  void cancel(LookupClient* c);
  void on_io(bool r, bool w, bool hup) override;

 private:
  friend class Resolver;
  void finish();
  void stop();
  static void on_timeout(void* self);
  Resolver* res_ = nullptr;
  std::vector<LookupClient*> clients_;  // CONNECTs to the same name share one query
  char name_[254];
  std::size_t name_len_ = 0;
  u16 id_a_ = 0, id_aaaa_ = 0;
  bool got_a_ = false, got_aaaa_ = false;
  DnsAnswer a_, aaaa_;
  Timer timer_;
};

class Resolver {
 public:
  // cache_entries: positive answers kept per worker for min(TTL, 300 s); 0 disables the cache.
  Resolver(Loop& loop, std::vector<sockaddr_storage> servers, int timeout_ms, unsigned max_inflight, unsigned cache_entries = 4096);
  // Start a lookup for `name` (normalized). Returns nullptr when it could not start (too many in
  // flight, no server, socket failure): the caller treats that as unreachable/throttled.
  // For localhost names the callback runs before resolve() returns and nullptr is returned.
  Lookup* resolve(std::string_view name, LookupClient* client, bool& throttled);
  // True when resolve(name) would not send a query (cached, or a query for it is in flight): such a
  // CONNECT costs the name server nothing and needs no per-session lookup slot.
  bool answered_or_pending(std::string_view name);
  unsigned inflight() const { return inflight_; }

  static std::vector<sockaddr_storage> system_servers();  // nameserver lines of /etc/resolv.conf
  static bool parse_server(std::string_view text, sockaddr_storage& out);  // "1.2.3.4", "[::1]:53", "127.0.0.1:5353"

 private:
  friend class Lookup;
  Loop& loop_;
  std::vector<sockaddr_storage> servers_;
  int timeout_ms_;
  unsigned max_inflight_, inflight_ = 0;
  // A cached answer is the resolver's answer replayed: the caller checks every address against
  // the block list each time, exactly as for a fresh answer, and connects to what it checked.
  struct Cached { DnsAnswer v6, v4; i64 expires; };
  std::unordered_map<std::string, Cached> cache_;
  std::unordered_map<std::string, Lookup*> pending_;
  unsigned cache_max_;
  void remember(std::string_view name, const DnsAnswer& v6, const DnsAnswer& v4);
};

}  // namespace wisp
