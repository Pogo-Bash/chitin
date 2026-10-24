// The Wisp relay: thread-per-core workers, each with its own event loop, listener (SO_REUSEPORT on
// Linux), resolver and connections. Nothing is shared between workers except the buffer pools and
// the global limit counters, which are lock-free (pool.hpp, limits.hpp).
#pragma once
#include <sys/socket.h>

#include <array>
#include <atomic>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "policy.hpp"
#include "tls.hpp"

namespace wisp {

struct Config {
  // access
  std::vector<std::string> origins;  // "*" any, "" = no Origin header
  std::optional<std::string> token;  // Wisp v2 password; v1 refused when set
  // destinations (relay-guard)
  PolicyConfig policy;
  // limits (packages/wisp DEFAULTS)
  unsigned max_conns_per_ip = 8;
  unsigned max_connections = 512;
  unsigned max_handshakes = 256;  // TCP connections that have not finished the HTTP upgrade
  unsigned max_handshakes_per_ip = 16;  // of those, per client address (IPv6 per ipv6_prefix); trusted proxies exempt
  int handshake_rate = -1;  // accepted connections per address per second; -1 = 32 with TLS, off without; 0 = off
  unsigned ipv6_prefix = 64;
  std::vector<Cidr> trusted_proxies;
  i64 reap_interval_ms = 15000;
  unsigned max_kbps = 8192;  // KiB/s per WebSocket, both directions; 0 = unlimited
  i64 connect_timeout_ms = 15000;
  i64 attempt_timeout_ms = 5000;
  i64 idle_timeout_ms = 300000;
  i64 handshake_timeout_ms = 10000;  // HTTP head and Wisp INFO each
  i64 write_stall_timeout_ms = 60000;  // a client whose queued replies make no progress
  unsigned buffer_packets = 128;
  std::size_t max_stream_buffer = 4 << 20;
  std::size_t max_connection_buffer = 8 << 20;
  std::size_t max_write_buffer = 16 << 20;
  std::size_t max_message = 1 << 17;
  std::size_t ws_write_high = 4 << 20;  // pause the sites of a client that is not reading
  std::string motd;
  // network
  std::string bind = "127.0.0.1";
  u16 port = 8101;
  std::vector<sockaddr_storage> dns_servers;
  int dns_timeout_ms = 3000;
  unsigned dns_max_inflight = 1024;  // per worker (lowered to fit RLIMIT_NOFILE, AUDIT A-8)
  // descriptor budget for site sockets, derived from RLIMIT_NOFILE by Server::start (0 = unlimited)
  std::size_t site_fd_limit = 0, site_fd_per_ip = 0;
  std::size_t test_hold_fds_ms = 0;  // test hooks: hold every free descriptor this long after start
  unsigned dns_cache = 4096;         // cached names per worker (TTL-bounded, <= 300 s); 0 = off
  // engine
  unsigned threads = 1;
  bool io_uring = false;
  bool writev = true;          // stage (e): batch frames into one writev
  bool malloc_buffers = false;  // stage (b) off: malloc per buffer instead of the pools
  std::size_t pool_mib = 0;  // shared 36 KiB block pool; 0 = derived from max_connections x the per-session budget
  std::size_t site_read = 131072;  // at most this many bytes per DATA packet towards the client
  // test-only (compiled in with WISP_TEST_HOOKS): every outbound connect goes here instead,
  // the intended address is recorded and listed at GET /__test/connects
  std::optional<sockaddr_storage> test_egress;
  // native wss:// (builds with WISP_TLS=1): certificate/key pairs; empty = plain ws:// (TLS in a proxy)
  std::vector<TlsFiles> tls;
};

// How the shared small/bulk pools are sized and split between sessions (AUDIT A-4). Every session's
// blocks (its streams' transmit queues, draining ones included, and its reply queue) are charged
// in block bytes and held under `session_share`; the pools hold max_connections shares plus a
// reserve for protocol replies, so no session or address can take another's blocks.
struct PoolPlan {
  std::size_t tx = 0, out = 0, ctl = 0;  // per-session budgets (block bytes): client->site, site->client, control headroom
  std::size_t session_share = 0;          // tx + out + ctl + overshoot headroom
  std::size_t small_blocks = 0, bulk_blocks = 0, reserve_blocks = 0;
  bool scaled = false;  // --pool-mib was smaller than the configured caps need: budgets scaled down
};
// False (with a message) when --pool-mib cannot give every connection a workable share.
bool plan_pools(const Config& c, PoolPlan& p, std::string& err);

class Server {
 public:
  explicit Server(Config c);
  ~Server();
  // Bind and start the workers. Returns false (with a message on stderr) when it cannot listen.
  bool start();
  u16 port() const { return port_; }
  void stop();   // ask every worker to finish
  void wait();   // join them
  const Config& cfg() const { return cfg_; }

  struct Shared;  // pools, global limits, test records

 private:
  Config cfg_;
  std::unique_ptr<Shared> sh_;
  u16 port_ = 0;
  std::vector<int> listen_fds_;
};

}  // namespace wisp
