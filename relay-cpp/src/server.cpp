// Wisp relay engine. See DESIGN.md for the architecture, memory model and invariants; the
// comments marked INVARIANT are the ones the tests and fuzzers check.
#include "server.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/uio.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <mutex>
#include <thread>

#include "dns.hpp"
#include "hash.hpp"
#include "http.hpp"
#include "limits.hpp"
#include "log.hpp"
#include "loop.hpp"
#include "pool.hpp"
#include "simd.hpp"
#include "tls.hpp"
#include "wisp.hpp"
#include "ws.hpp"

namespace wisp {

namespace {

constexpr u32 kBlockHdr = 64;         // Block descriptor at the start of every pool block
constexpr std::size_t kSmallBlock = 36864;
constexpr std::size_t kBulkBlock = (128 << 10) + kBlockHdr + 64;  // site reads of a busy stream
constexpr u32 kSiteHeadroom = 16;     // ws header (<= 10) + wisp header (5) in front of site bytes
constexpr int kReadBudget = 4;        // reads per readiness before yielding to other sockets
constexpr unsigned kMaxIov = 64;

// ---- per-thread object slabs (Conn, Stream): free lists, grown in chunks, never shrunk ------
template <class T>
struct Slab {
  static void* alloc() {
    auto& fl = free_list();
    if (fl.empty()) {
      constexpr std::size_t kChunk = 32;
      auto* chunk = static_cast<u8*>(::operator new(sizeof(T) * kChunk, std::align_val_t(alignof(T) > 16 ? alignof(T) : 16)));
      for (std::size_t i = 0; i < kChunk; i++) fl.push_back(chunk + i * sizeof(T));
    }
    void* p = fl.back();
    fl.pop_back();
    return p;
  }
  static void free(void* p) { free_list().push_back(p); }
  static std::vector<void*>& free_list() {
    thread_local std::vector<void*> fl;
    return fl;
  }
};

Block* new_block(BufferPool& pool, bool privileged = false) {
  u8* m = pool.acquire(privileged);
  if (!m) return nullptr;
  auto* b = new (m) Block;
  b->data = m + kBlockHdr;
  b->cap = u32(pool.block_size() - kBlockHdr);
  b->pool = &pool;
  return b;
}
void free_block(BufferPool&, Block* b) {  // blocks go back to the pool they came from
  if (!b) return;
  BufferPool* pool = b->pool;
  b->~Block();
  pool->release(reinterpret_cast<u8*>(b));
}

// FIFO of pool blocks. `held` is what the blocks cost the pool (block sizes, not payload bytes:
// a 1-byte site read holds a whole block), added to *charge as well when set (a session's total).
struct ByteQueue {
  Block* head = nullptr;
  Block* tail = nullptr;
  std::size_t bytes = 0;
  std::size_t held = 0;
  std::size_t* charge = nullptr;
  bool empty() const { return !head; }
  void hold(Block* b, bool add) {
    std::size_t k = b->pool->block_size();
    if (add) { held += k; if (charge) *charge += k; }
    else { held -= k; if (charge) *charge -= k; }
  }
  void push(Block* b) {
    b->next = nullptr;
    if (tail) tail->next = b; else head = b;
    tail = b;
    bytes += b->size();
    hold(b, true);
  }
  // Copy n bytes in (into the tail's free room first). False when the pool ran out (nothing
  // partial is left behind: bytes already appended stay, the caller resets the stream).
  // privileged: protocol replies, which may use the pool's reserve.
  bool append(const u8* p, std::size_t n, BufferPool& pool, bool privileged = false) {
    while (n) {
      if (!tail || !tail->room()) {
        Block* b = new_block(pool, privileged);
        if (!b) return false;
        push(b);
      }
      std::size_t k = std::min<std::size_t>(tail->room(), n);
      std::memcpy(tail->data + tail->end, p, k);
      tail->end += u32(k);
      bytes += k;
      p += k;
      n -= k;
    }
    return true;
  }
  void consume(std::size_t n, BufferPool& pool) {
    bytes -= n;
    while (n && head) {
      std::size_t k = std::min<std::size_t>(head->size(), n);
      head->begin += u32(k);
      n -= k;
      if (!head->size()) {
        Block* b = head;
        head = b->next;
        if (!head) tail = nullptr;
        hold(b, false);
        free_block(pool, b);
      }
    }
  }
  int iov(iovec* v, unsigned max) const {
    unsigned c = 0;
    for (Block* b = head; b && c < max; b = b->next)
      if (b->size()) v[c++] = iovec{b->data + b->begin, b->size()};
    return int(c);
  }
  void clear(BufferPool& pool) {
    while (head) {
      Block* b = head;
      head = b->next;
      hold(b, false);
      free_block(pool, b);
    }
    tail = nullptr;
    bytes = 0;
  }
};

socklen_t sa_len(const sockaddr_storage& s) { return s.ss_family == AF_INET6 ? sizeof(sockaddr_in6) : sizeof(sockaddr_in); }

Ip ip_of(const sockaddr_storage& s) {
  if (s.ss_family == AF_INET) {
    auto& a = reinterpret_cast<const sockaddr_in&>(s);
    return Ip{4, ntohl(a.sin_addr.s_addr)};
  }
  auto& a = reinterpret_cast<const sockaddr_in6&>(s);
  u128 v = 0;
  for (int i = 0; i < 16; i++) v = (v << 8) | a.sin6_addr.s6_addr[i];
  return Ip{6, v};
}

sockaddr_storage sockaddr_of(const Ip& ip, u16 port) {
  sockaddr_storage s{};
  if (ip.version == 4) {
    auto& a = reinterpret_cast<sockaddr_in&>(s);
    a.sin_family = AF_INET;
    a.sin_port = htons(port);
    a.sin_addr.s_addr = htonl(u32(ip.value));
#ifdef __APPLE__
    a.sin_len = sizeof a;
#endif
  } else {
    auto& a = reinterpret_cast<sockaddr_in6&>(s);
    a.sin6_family = AF_INET6;
    a.sin6_port = htons(port);
    for (int i = 0; i < 16; i++) a.sin6_addr.s6_addr[i] = u8(ip.value >> (8 * (15 - i)));
#ifdef __APPLE__
    a.sin6_len = sizeof a;
#endif
  }
  return s;
}

void tune_socket(int fd) {
  int one = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
#ifdef SO_NOSIGPIPE
  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
#endif
}

}  // namespace

// ---------------------------------------------------------------------------------------------
// AUDIT A-4. A session's blocks are bounded by its budgets plus a fixed overshoot: the client is
// no longer read once its transmit blocks pass `tx` (one message more at most) or its reply queue
// passes `out + ctl` (replies to one read more at most); its sites are no longer read once the reply
// queue passes `out` (one site read more at most); past out + ctl + max_message + 2 bulk blocks it
// is dropped. So the share is tx + out + ctl + 2 x max_message + 2 bulk + 4 small blocks, and the
// small pool alone holds max_connections shares (site reads fall back to it when bulk is empty)
// plus one reserve block per connection and handshake for protocol replies.
bool plan_pools(const Config& c, PoolPlan& p, std::string& err) {
  const std::size_t MiB = std::size_t(1) << 20;
  std::size_t conns = std::max(1u, c.max_connections);
  std::size_t fixed = 2 * (c.max_message + 64) + 2 * kBulkBlock + 4 * kSmallBlock;
  p.tx = c.max_connection_buffer + 64 * 1024;  // + partly filled tail blocks
  p.out = c.ws_write_high;
  p.ctl = 1 * MiB;
  p.reserve_blocks = std::size_t(c.max_connections) + c.max_handshakes + 64;
  std::size_t reserve = p.reserve_blocks * kSmallBlock;
  std::size_t var = p.tx + p.out + p.ctl;
  p.scaled = false;
  if (c.pool_mib) {
    std::size_t pool = c.pool_mib * MiB;
    std::size_t share = pool > reserve ? (pool - reserve) / conns : 0;
    if (share < fixed + 256 * 1024) {
      err = "--pool-mib " + std::to_string(c.pool_mib) + " leaves " + std::to_string(share >> 10) + " KiB per connection for --max-connections " +
            std::to_string(c.max_connections) + " (" + std::to_string(c.max_handshakes) + " handshakes reserved); need at least " +
            std::to_string((conns * (fixed + 256 * 1024) + reserve + MiB - 1) / MiB) + " MiB, or fewer connections (0 = size it automatically)";
      return false;
    }
    if (share < fixed + var) {  // scale the session's budgets down to fit its share
      double f = double(share - fixed) / double(var);
      p.tx = std::size_t(double(p.tx) * f);
      p.out = std::size_t(double(p.out) * f);
      p.ctl = std::size_t(double(p.ctl) * f);
      p.scaled = true;
    }
    p.small_blocks = std::max<std::size_t>(64, pool / kSmallBlock);
  } else {
    p.small_blocks = (conns * (fixed + var) + reserve) / kSmallBlock + 1;
  }
  p.session_share = fixed + p.tx + p.out + p.ctl;
  // a quarter of the small pool again, in 128 KiB blocks, for streams whose site has more to send
  // (not part of the guarantee: an empty bulk pool falls back to small blocks)
  p.bulk_blocks = std::max<std::size_t>(16, p.small_blocks * kSmallBlock / 4 / kBulkBlock);
  return true;
}

namespace {
PoolPlan plan_of(const Config& c) {
  PoolPlan p;
  std::string err;
  if (!plan_pools(c, p, err)) {  // Server::start checks first; embedded users (the fuzzer) get a hard stop
    std::fprintf(stderr, "wisp: %s\n", err.c_str());
    std::abort();
  }
  return p;
}
}  // namespace

struct Server::Shared {
  explicit Shared(const Config& c)
      : cfg(c),
        plan(plan_of(c)),
        policy(c.policy),
        small(kSmallBlock, plan.small_blocks, c.malloc_buffers),
        bulk(kBulkBlock, plan.bulk_blocks, c.malloc_buffers),
        // rx + reassembly buffers: two per connection at most
        large(c.max_message + 64 + kBlockHdr, std::size_t(c.max_connections + c.max_handshakes) * 2 + 64, c.malloc_buffers) {
    small.set_reserve(plan.reserve_blocks);
    if (c.token) {
      token_digest = sha256(as_bytes(*c.token));
      has_token = true;
    }
    // server INFO payload: version 2.1, password (required) when a token is set, MOTD, open confirm
    auto ext = [&](u8 id, std::string_view data) {
      info.push_back(char(id));
      u8 len[4];
      store_le32(len, u32(data.size()));
      info.append(reinterpret_cast<char*>(len), 4);
      info.append(data);
    };
    info.push_back(2);
    info.push_back(1);
    if (has_token) ext(EXT_PASSWORD, std::string_view("\x01", 1));
    ext(EXT_MOTD, c.motd);
    ext(EXT_OPEN_CONFIRM, "");
  }
  const Config& cfg;
  PoolPlan plan;
  Policy policy;
  std::array<u8, 32> token_digest{};
  bool has_token = false;
  std::string info;
  BufferPool small, bulk, large;
  SharedCounter conns, handshakes;
  PerIpTable per_ip;
  PerIpTable hs_per_ip;  // handshakes in progress per client address (AUDIT A-1)
  PerIpRate hs_rate;     // new connections per address per second (AUDIT A-6)
  SharedCounter site_fds;  // site sockets open (AUDIT A-8: budgeted against RLIMIT_NOFILE)
  PerIpTable fds_per_ip;   // of those, per client address
  std::atomic<bool> stopping{false};
  std::vector<std::thread> threads;
  std::vector<class Worker*> workers;
  std::mutex test_mu;  // test hooks only
  std::vector<std::string> test_connects;
};

class Conn;
class Stream;

class Worker {
 public:
  Worker(Server::Shared& s, unsigned index)
      : sh(s), loop(s.cfg.io_uring), res(loop, s.cfg.dns_servers, s.cfg.dns_timeout_ms, s.cfg.dns_max_inflight, s.cfg.dns_cache), index(index) {
    loop.at_end([this] {
      flush_dirty();
      if (sh.stopping.load(std::memory_order_relaxed)) loop.stop();
    });
  }
  void flush_dirty();
  Server::Shared& sh;
  Loop loop;
  Resolver res;
  unsigned index;
  std::vector<Conn*> dirty;
  std::vector<Stream*> scratch;  // reused snapshot buffer for iterating a connection's streams
};

// Open-addressing map stream id -> Stream*, sized once per connection (2x max_streams).
class StreamMap {
 public:
  // Starts with 8 slots and doubles as streams are added (rehash), up to 2 x max_streams: an idle
  // session costs ~100 bytes here.
  explicit StreamMap(unsigned) { reset(8); }
  Stream* find(u32 id) const {
    for (std::size_t i = slot(id);; i = (i + 1) & mask_) {
      if (!vals_[i]) return nullptr;
      if (keys_[i] == id) return vals_[i];
    }
  }
  void insert(u32 id, Stream* s) {  // caller guarantees size < max_streams
    if ((size_ + 1) * 2 > keys_.size()) grow();
    std::size_t i = slot(id);
    while (vals_[i]) i = (i + 1) & mask_;
    keys_[i] = id;
    vals_[i] = s;
    size_++;
  }
  void erase(u32 id) {
    std::size_t i = slot(id);
    while (vals_[i] && keys_[i] != id) i = (i + 1) & mask_;
    if (!vals_[i]) return;
    vals_[i] = nullptr;
    size_--;
    // backward-shift deletion: no tombstones, probe chains stay short
    std::size_t j = i;
    for (;;) {
      j = (j + 1) & mask_;
      if (!vals_[j]) break;
      std::size_t k = slot(keys_[j]);
      bool movable = (i <= j) ? (k <= i || k > j) : (k <= i && k > j);
      if (movable) {
        keys_[i] = keys_[j];
        vals_[i] = vals_[j];
        vals_[j] = nullptr;
        i = j;
      }
    }
  }
  unsigned size() const { return size_; }
  template <class F>
  void snapshot(std::vector<Stream*>& out, F&&) const {
    out.clear();
    for (Stream* s : vals_)
      if (s) out.push_back(s);
  }

 private:
  void reset(std::size_t cap) {
    keys_.assign(cap, 0);
    vals_.assign(cap, nullptr);
    mask_ = cap - 1;
    size_ = 0;
  }
  void grow() {
    std::vector<u32> k;
    std::vector<Stream*> v;
    k.swap(keys_);
    v.swap(vals_);
    reset(k.size() * 2);  // load stays <= 1/2; max_streams bounds the size
    for (std::size_t i = 0; i < k.size(); i++)
      if (v[i]) insert(k[i], v[i]);
  }
  std::size_t slot(u32 id) const { return std::size_t((id * 0x9E3779B1u) ^ (id >> 16)) & mask_; }
  std::vector<u32> keys_;
  std::vector<Stream*> vals_;
  std::size_t mask_ = 0;
  unsigned size_ = 0;
};

// ---------------------------------------------------------------------------------------------
class Stream final : public Handle, public LookupClient {
 public:
  enum class St { Resolving, Connecting, Open, Draining, Closed };
  Stream(Conn* c, u32 id, std::string_view host, u16 port, unsigned buffer_packets)
      : conn(c), id(id), port(port), ring_(std::size_t(buffer_packets) * 2 + 2) {
    host_len = std::min<std::size_t>(host.size(), sizeof host_ - 1);
    std::memcpy(host_, host.data(), host_len);
  }
  static void* operator new(std::size_t) { return Slab<Stream>::alloc(); }
  static void operator delete(void* p) { Slab<Stream>::free(p); }

  void on_io(bool r, bool w, bool hup) override;
  void on_resolved(const DnsAnswer& v6, const DnsAnswer& v4, bool ok) override;
  std::string_view host() const { return {host_, host_len}; }

  Conn* conn;
  u32 id;
  u16 port;
  St st = St::Resolving;
  Lookup* lookup = nullptr;
  bool lookup_slot = false;
  // connect attempts
  Ip addrs[kMaxAddrs * 2];
  unsigned naddrs = 0, next_addr = 0;
  i64 deadline = 0;
  u8 last_reason = R_TIMEOUT;
  bool t_fd = false;  // holds a site-socket ticket (released when fd is closed)
  std::size_t fd_slot = 0;
  Timer timer;
  // client -> site
  ByteQueue tx;
  std::size_t queued = 0;  // accepted from the client, not yet flushed to the site
  unsigned inflight = 0, since_continue = 0;
  bool bulk = false;  // the last site read filled its block: read the next into a 128 KiB one
  // per-packet unflushed byte counts, FIFO (inflight <= 2 * buffer_packets, so it never overflows)
  std::vector<u32> ring_;
  std::size_t ring_head = 0, ring_count = 0;
  // stats
  u64 bytes_in = 0, bytes_out = 0;
  i64 started = 0, last_activity = 0;
  Stream* drain_next = nullptr;  // conn's list of draining streams

 private:
  char host_[254];
  std::size_t host_len = 0;
};

class Conn final : public Handle, public WsSink {
 public:
  enum class St { Tls, Http, Info, Ready, Closing };
  static constexpr std::size_t kNoSlot = ~std::size_t(0);
  // hs_ip_slot: the per-address handshake ticket the listener took (kNoSlot: none)
  Conn(Worker& w, int fd, const sockaddr_storage& peer, std::size_t hs_ip_slot = kNoSlot);
  static void* operator new(std::size_t) { return Slab<Conn>::alloc(); }
  static void operator delete(void* p) { Slab<Conn>::free(p); }

  void on_io(bool r, bool w, bool hup) override;
  // WsSink
  void on_message(u8 op, mbytes payload) override;
  void on_control(u8 op, mbytes payload) override;
  mbytes frag_acquire(std::size_t max) override;
  void frag_release() override;
  bool want_more() override { return !ended_ && !doomed_ && st_ != St::Closing && !paused_bucket_ && !paused_caps_ && !paused_out_; }

  void end();
  void flush();
#if WISP_FUZZ
  void check_invariants() const;
#endif
  // streams
  void close_stream(Stream* s, u8 reason, bool tell);
  void stream_connect(Stream* s);
  void stream_connected(Stream* s);
  void stream_attempt_failed(Stream* s, u8 reason);
  void stream_read(Stream* s);
  void stream_flush(Stream* s);
  void stream_flushed(Stream* s, std::size_t n);
  void stream_resolved(Stream* s, const DnsAnswer& v6, const DnsAnswer& v4, bool ok);
  void finish_drain(Stream* s);
  static void stream_timer(void* p);

  Worker& w;
  Server::Shared& sh;
  const Config& cfg;
  bool ended_ = false;
  bool doomed_ = false;      // over a cap: ended at the end of this iteration
  bool dirty_ = false;       // in w.dirty
  bool sites_paused_ = false;
  bool paused_bucket_ = false;
  bool paused_caps_ = false;  // client bytes at a cap: the client socket is not read until they flush
  bool paused_out_ = false;   // reply queue past out + ctl (a client that sends but does not read): not read until it drains
  std::size_t tx_held_ = 0;   // block bytes of every stream's transmit queue, draining ones included (AUDIT A-4)
  void maybe_resume_caps(const Stream* s);
  TokenBucket bucket;
  std::size_t pending_ = 0;  // client bytes accepted, not yet flushed, all streams

 private:
  bool can_read() const { return !ended_ && !doomed_ && !paused_bucket_ && !paused_caps_ && !paused_out_; }
  std::size_t out_drop() const { return sh.plan.out + sh.plan.ctl + cfg.max_message + 2 * kBulkBlock + 2 * kSmallBlock; }
  ssize_t io_read(u8* p, std::size_t n);
  ssize_t io_writev(const iovec* v, int cnt);
  void tls_step();
#if WISP_TLS
  TlsConn tls_;
#endif
  [[maybe_unused]] bool tls_on_ = false;  // used only in TLS builds
  void read_some();
  void process();
  void handle_head(const HttpRequest& r);
  void plain_response(const HttpRequest& r);
  void refuse(const char* status_line, const char* extra = "");
  void start_closing();
  void client_info(mbytes payload);
  void packet(mbytes msg);
  void open_stream(u32 id, const Connect& c);
  void accept_data(Stream* s, mbytes payload);
  bool resolve_peer(const HttpRequest& r, Ip& out);
  void send_raw(std::string_view s);
  void send_ws(u8 op, bytes payload);
  void send_wisp(u8 type, u32 id, bytes payload);
  void send_close(u32 id, u8 reason) { u8 r = reason; send_wisp(PKT_CLOSE, id, bytes(&r, 1)); }
  void send_continue(u32 id, u32 n) { u8 b[4]; store_le32(b, n); send_wisp(PKT_CONTINUE, id, bytes(b, 4)); }
  void queued_out();
  void resume_sites();
  void wait_bucket();
  bool take_site_fd(Stream* s);
  void close_site_fd(Stream* s);
  IpKey client_key_{};
  void forget(Stream* s) { if (streams_.find(s->id) == s) streams_.erase(s->id); }
  static void on_hs_timer(void* p);
  static void on_reap(void* p);
  static void on_close_timer(void* p);
  static void on_bw_timer(void* p);
  static void on_pool_timer(void* p);

  St st_ = St::Http;
  bool v1_ = false;
  bool client_open_confirm_ = false;
  bool shut_wr_ = false;
  Ip peer_;
  char peer_text_[48];
  WsReader reader_;
  Session session_;
  StreamMap streams_;
  Stream* draining_ = nullptr;
  unsigned ndraining_ = 0;
  Block* rx_ = nullptr;
  u32 rx_off_ = 0, rx_len_ = 0;
  Block* frag_ = nullptr;
  ByteQueue out_;
  // tickets for the shared counters, released exactly once in end()
  bool t_handshake_ = false, t_conn_ = false, t_ip_ = false, t_hs_ip_ = false;
  std::size_t ip_slot_ = 0, hs_ip_slot_ = 0;
  void release_handshake() {
    if (t_handshake_) { sh.handshakes.release(); t_handshake_ = false; }
    if (t_hs_ip_) { sh.hs_per_ip.release(hs_ip_slot_); t_hs_ip_ = false; }
  }
  Timer hs_timer_, reap_timer_, close_timer_, bw_timer_, pool_timer_;
  i64 opened_ = 0, last_stream_ = 0, last_write_ = 0;
  i64 high_since_ = 0;  // when the reply queue last went over ws_write_high without draining to half (0: not over)
  u64 bytes_in_ = 0, bytes_out_ = 0, stream_total_ = 0;
  char origin_log_[400];
};

// ---------------------------------------------------------------------------------------------
Conn::Conn(Worker& wk, int fd_, const sockaddr_storage& peer, std::size_t hs_ip_slot)
    : w(wk), sh(wk.sh), cfg(wk.sh.cfg), bucket(double(wk.sh.cfg.max_kbps) * 1024.0),
      reader_(wk.sh.cfg.max_message), session_(wk.sh.policy), streams_(wk.sh.cfg.policy.max_streams) {
  fd = fd_;
  t_handshake_ = true;  // taken by the listener
  if (hs_ip_slot != kNoSlot) { t_hs_ip_ = true; hs_ip_slot_ = hs_ip_slot; }
  peer_ = canonical_probe(ip_of(peer));
  std::snprintf(peer_text_, sizeof peer_text_, "%s", format_ip(peer_).c_str());
  origin_log_[0] = 0;
  opened_ = last_stream_ = last_write_ = w.loop.now();
  hs_timer_.fn = on_hs_timer; hs_timer_.arg = this;
  reap_timer_.fn = on_reap; reap_timer_.arg = this;
  close_timer_.fn = on_close_timer; close_timer_.arg = this;
  bw_timer_.fn = on_bw_timer; bw_timer_.arg = this;
  pool_timer_.fn = on_pool_timer; pool_timer_.arg = this;
  w.loop.arm(hs_timer_, cfg.handshake_timeout_ms);
#if WISP_TLS
  if (!cfg.tls.empty()) {
    st_ = St::Tls;
    tls_on_ = true;
    if (!tls_.open(fd)) doomed_ = true;
  }
#endif
}

void Conn::on_hs_timer(void* p) {
  auto* c = static_cast<Conn*>(p);
  if (c->st_ == St::Tls || c->st_ == St::Http || c->st_ == St::Info) c->end();  // slowloris / never sent INFO
}

ssize_t Conn::io_read(u8* p, std::size_t n) {
#if WISP_TLS
  if (tls_on_) return tls_.read(p, n);  // with kTLS RX, OpenSSL reads records straight from the kernel
#endif
  return read(fd, p, n);
}

ssize_t Conn::io_writev(const iovec* v, int cnt) {
#if WISP_TLS
  if (tls_on_ && !tls_.ktls_tx) return tls_.writev(v, cnt);
#endif
  return cnt == 1 ? write(fd, v[0].iov_base, v[0].iov_len) : writev(fd, v, cnt);  // kTLS TX: the kernel encrypts
}

void Conn::tls_step() {
#if WISP_TLS
  if (doomed_) { end(); return; }
  switch (tls_.handshake()) {
    case TlsStep::Done:
      st_ = St::Http;
      log_line(2, "%s TLS %s, kernel offload tx=%d rx=%d", peer_text_, tls_.version(), tls_.ktls_tx, tls_.ktls_rx);
      return;
    case TlsStep::WantRead: readable = false; return;
    case TlsStep::WantWrite: writable = false; return;
    case TlsStep::Fail: end(); return;
  }
#endif
}
void Conn::on_close_timer(void* p) { static_cast<Conn*>(p)->end(); }
void Conn::on_pool_timer(void* p) {
  auto* c = static_cast<Conn*>(p);
  c->w.loop.defer(c);
  c->resume_sites();
}
void Conn::on_bw_timer(void* p) {
  auto* c = static_cast<Conn*>(p);
  if (!c->bucket.ready(c->w.loop.now())) { c->wait_bucket(); return; }
  c->paused_bucket_ = false;
  c->w.loop.defer(c);
  c->resume_sites();
}
void Conn::wait_bucket() {
  if (!bw_timer_.armed()) w.loop.arm(bw_timer_, bucket.wait_ms());
}

void Conn::on_reap(void* p) {
  auto* c = static_cast<Conn*>(p);
  i64 now = c->w.loop.now();
  // A connection with no streams (PINGs do not count) is not worth a slot.
  if (c->st_ == St::Ready && !c->streams_.size() && now - c->last_stream_ > c->cfg.idle_timeout_ms) return c->end();
  if (c->out_.bytes && now - c->last_write_ > c->cfg.write_stall_timeout_ms) {
    log_line(1, "%s dropped: replies not read for %lld s", c->peer_text_, (long long)((now - c->last_write_) / 1000));
    return c->end();
  }
  // AUDIT A-2: progress alone is not enough (a trickle reader keeps the whole queue forever). Once
  // over the high-water mark the queue must drain to half of it within the stall timeout: a minimum
  // drain rate of ws_write_high / 2 per write_stall_timeout_ms (2 MiB per 60 s by default).
  if (c->high_since_ && now - c->high_since_ > c->cfg.write_stall_timeout_ms) {
    log_line(1, "%s dropped: replies drained too slowly (%zu bytes queued for %lld s)", c->peer_text_, c->out_.bytes,
             (long long)((now - c->high_since_) / 1000));
    return c->end();
  }
  auto& snap = c->w.scratch;
  c->streams_.snapshot(snap, 0);
  std::vector<Stream*> local(snap);  // a copy: close_stream -> resume_sites may reuse w.scratch
  for (Stream* s : local)
    if (s->st == Stream::St::Open && now - s->last_activity > c->cfg.idle_timeout_ms) c->close_stream(s, R_DATA_TIMEOUT, true);
  if (!c->ended_) c->w.loop.arm(c->reap_timer_, c->cfg.reap_interval_ms);
}

void Conn::on_io(bool, bool, bool) {
  if (ended_) return;
  if (st_ == St::Tls) {
    tls_step();
    if (ended_ || st_ == St::Tls) return;
  }
  if (writable && !out_.empty()) flush();
  if (ended_) return;
  if (readable && can_read()) read_some();
}

void Conn::read_some() {
  for (int i = 0; i < kReadBudget; i++) {
    if (!rx_) {
      rx_ = new_block(sh.large);
      if (!rx_) {  // pool exhausted: try again shortly (backpressure, not malloc)
        if (!pool_timer_.armed()) w.loop.arm(pool_timer_, 10);
        return;
      }
      rx_off_ = rx_len_ = 0;
    }
    if (rx_off_ == rx_len_) rx_off_ = rx_len_ = 0;
    // INVARIANT: a frame in progress always fits (needed() <= max_message + 14 < cap), so moving
    // the unparsed tail to the front makes room; it is moved only when it must be (no quadratic copying).
    std::size_t need = st_ == St::Http ? kMaxRequestHead : std::max<std::size_t>(reader_.needed(), 2);
    if (rx_off_ && (rx_->cap - rx_off_ < need || rx_->cap - rx_len_ < 4096)) {
      std::memmove(rx_->data, rx_->data + rx_off_, rx_len_ - rx_off_);
      rx_len_ -= rx_off_;
      rx_off_ = 0;
    }
    std::size_t space = rx_->cap - rx_len_;
    if (!space) { end(); return; }  // unreachable by the invariant above; fail closed
    ssize_t n = io_read(rx_->data + rx_len_, space);
    if (n > 0) {
      rx_len_ += u32(n);
      process();
      if (ended_) return;
      if (rx_ && rx_off_ == rx_len_ && st_ != St::Http) { free_block(sh.large, rx_); rx_ = nullptr; }
      if (!can_read()) return;
      continue;
    }
    if (n == 0) {  // peer closed its side
      end();
      return;
    }
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      readable = false;
      if (rx_ && rx_off_ == rx_len_) { free_block(sh.large, rx_); rx_ = nullptr; }  // idle: hold no buffer
      return;
    }
    if (errno == EINTR) continue;
    end();
    return;
  }
  w.loop.defer(this);  // budget used, more may be waiting
}

void Conn::process() {
  if (st_ == St::Closing) {  // draining input until the peer closes or the grace timer fires
    rx_off_ = rx_len_;
    return;
  }
  if (st_ == St::Http) {
    HttpRequest req;
    HttpParse r = parse_request_head(rx_->data + rx_off_, rx_len_ - rx_off_, req);
    if (r == HttpParse::NeedMore) return;
    if (r == HttpParse::TooLarge) return refuse("431 Request Header Fields Too Large");
    if (r == HttpParse::Bad) return refuse("400 Bad Request");
    std::size_t head = req.head_len;
    handle_head(req);  // views into rx_ are valid during this call only
    rx_off_ += u32(head);
    if (ended_ || st_ == St::Closing || st_ == St::Http) return;
  }
  std::size_t used = reader_.parse(rx_->data + rx_off_, rx_len_ - rx_off_, *this);
  if (ended_) return;
  rx_off_ += u32(used);
  if (reader_.error() && st_ != St::Closing) {
    u8 frame[4];
    store_be16(frame, reader_.error());
    send_ws(OP_CLOSE, bytes(frame, 2));
    start_closing();
  }
}

// ---- HTTP ------------------------------------------------------------------------------------
void Conn::send_raw(std::string_view s) {
  if (!out_.append(reinterpret_cast<const u8*>(s.data()), s.size(), sh.small, true)) { doomed_ = true; }
  queued_out();
}

void Conn::refuse(const char* status, const char* extra) {
  char buf[256];
  int n = std::snprintf(buf, sizeof buf, "HTTP/1.1 %s\r\n%sContent-Length: 0\r\nConnection: close\r\n\r\n", status, extra);
  send_raw(std::string_view(buf, std::size_t(n)));
  start_closing();
}

void Conn::start_closing() {
  if (st_ == St::Closing) return;
  st_ = St::Closing;
  w.loop.arm(close_timer_, 1000);
  w.loop.disarm(hs_timer_);
  queued_out();
}

void Conn::plain_response(const HttpRequest& r) {
  std::string_view body;
  const char* status = "404 Not Found";
  std::string tmp;
  if (r.target == "/healthz") {
    status = "200 OK";
    body = "ok\n";
  } else {
    body = "This is a Wisp (v2) relay. Nothing to see here.\n";
  }
#if WISP_TEST_HOOKS
  if (r.target == "/__test/stats") {
    status = "200 OK";
    tmp = "{\"connections\":" + std::to_string(sh.conns.value()) + ",\"handshakes\":" + std::to_string(sh.handshakes.value()) +
          ",\"small_in_use\":" + std::to_string(sh.small.in_use()) + ",\"bulk_in_use\":" + std::to_string(sh.bulk.in_use()) + ",\"large_in_use\":" + std::to_string(sh.large.in_use()) + "}\n";
    body = tmp;
  } else if (r.target == "/__test/connects") {
    status = "200 OK";
    std::lock_guard<std::mutex> g(sh.test_mu);
    tmp = "[";
    for (std::size_t i = 0; i < sh.test_connects.size(); i++) tmp += (i ? ",\"" : "\"") + sh.test_connects[i] + "\"";
    tmp += "]\n";
    body = tmp;
  }
#endif
  char head[256];
  int n = std::snprintf(head, sizeof head, "HTTP/1.1 %s\r\nContent-Type: text/plain\r\nContent-Length: %zu\r\n%sConnection: close\r\n\r\n",
                        status, body.size(), r.target == "/healthz" ? "Cache-Control: no-store\r\n" : "");
  send_raw(std::string_view(head, std::size_t(n)));
  send_raw(body);
  start_closing();
}

bool Conn::resolve_peer(const HttpRequest& r, Ip& out) {
  out = peer_;
  if (cfg.trusted_proxies.empty()) return true;
  auto trusted = [&](const Ip& ip) {
    Ip p = canonical_probe(ip);
    for (const Cidr& c : cfg.trusted_proxies)
      if (c.contains(p)) return true;
    return false;
  };
  if (!trusted(peer_)) return true;
  if (r.xff_count > 2) return true;  // refuse to guess across many header copies: the peer is the key
  // hops, left to right: first header's entries then the last header's (when there are two)
  std::string_view parts[2] = {r.xff_first, r.xff_count == 2 ? r.xff_last : std::string_view{}};
  std::string_view hops[32];
  unsigned n = 0;
  for (auto part : parts) {
    while (!part.empty()) {
      std::size_t c = part.find(',');
      std::string_view h = part.substr(0, c);
      while (!h.empty() && (h.front() == ' ' || h.front() == '\t')) h.remove_prefix(1);
      while (!h.empty() && (h.back() == ' ' || h.back() == '\t')) h.remove_suffix(1);
      if (!h.empty()) {
        if (n == 32) return true;  // absurdly long chain: the peer is the key
        hops[n++] = h;
      }
      if (c == std::string_view::npos) break;
      part.remove_prefix(c + 1);
    }
  }
  for (unsigned i = n; i-- > 0;) {
    auto ip = parse_ip(hops[i]);
    if (!ip) return true;  // garbage from our own proxy: do not guess
    if (!trusted(*ip) || i == 0) { out = canonical_probe(*ip); return true; }
  }
  return true;
}

void Conn::handle_head(const HttpRequest& r) {
  if (r.upgrade.empty() && r.key.empty()) return plain_response(r);
  if (r.duplicate_singleton) return refuse("400 Bad Request");
  if (r.key.empty() || !ieq(r.upgrade, "websocket") || !has_token(r.connection, "upgrade") || r.method != "GET")
    return refuse("400 Bad Request");
  if (r.version != "13") return refuse("426 Upgrade Required", "Sec-WebSocket-Version: 13\r\n");
  std::string raw;
  if (r.key.size() != 24 || !base64_decode(r.key, raw) || raw.size() != 16) return refuse("400 Bad Request");
  std::string_view origin = r.has_origin ? r.origin : std::string_view{};
  log_text(origin, origin_log_);
  bool origin_ok = false;
  for (const auto& o : cfg.origins)
    if (o == "*" || o == origin) { origin_ok = true; break; }
  if (!origin_ok) {
    log_line(1, "%s refused: origin %s", peer_text_, origin_log_);
    return refuse("403 Forbidden");
  }
  // Wisp v2 requires the subprotocol header (its value is unspecified). Without it the client speaks
  // v1, which has no handshake and so no way to authenticate: accepted only when no token is set.
  v1_ = !r.has_protocol || r.protocol.empty();
  if (v1_ && sh.has_token) return refuse("400 Bad Request");
  Ip client;
  resolve_peer(r, client);
  std::snprintf(peer_text_, sizeof peer_text_, "%s", format_ip(client).c_str());
  client_key_ = ip_key(client, cfg.ipv6_prefix);
  // INVARIANT: both counters are taken with CAS "increment if below the limit", released once in end()
  if (!sh.conns.try_acquire(cfg.max_connections)) {
    log_line(1, "%s refused: relay is full", peer_text_);
    return refuse("503 Service Unavailable");
  }
  t_conn_ = true;
  if (!sh.per_ip.try_acquire(ip_key(client, cfg.ipv6_prefix), cfg.max_conns_per_ip, ip_slot_)) {
    log_line(1, "%s refused: too many connections", peer_text_);
    // a refused connection gives its global slot back now, not after its 1 s close (else clients
    // over their per-address cap would hold global slots and crowd others out)
    sh.conns.release();
    t_conn_ = false;
    return refuse("429 Too Many Requests");
  }
  t_ip_ = true;
  release_handshake();
  std::string_view chosen = r.protocol.substr(0, r.protocol.find(','));
  while (!chosen.empty() && (chosen.front() == ' ' || chosen.front() == '\t')) chosen.remove_prefix(1);
  while (!chosen.empty() && (chosen.back() == ' ' || chosen.back() == '\t')) chosen.remove_suffix(1);
  char accept[29] = {};
  websocket_accept(r.key, accept);
  char head[512];
  int n = std::snprintf(head, sizeof head,
                        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n", accept);
  send_raw(std::string_view(head, std::size_t(n)));
  if (!v1_) {
    send_raw("Sec-WebSocket-Protocol: ");
    send_raw(chosen.substr(0, 200));
    send_raw("\r\n");
  }
  send_raw("\r\n");
  log_line(1, "%s open (%s), %u connection(s)", peer_text_, origin_log_, sh.conns.value());
  w.loop.arm(reap_timer_, cfg.reap_interval_ms);
  if (v1_) {  // Wisp v1: no INFO exchange; CONTINUE on stream 0 opens the session
    st_ = St::Ready;
    w.loop.disarm(hs_timer_);
    send_continue(0, cfg.buffer_packets);
  } else {
    st_ = St::Info;
    w.loop.arm(hs_timer_, cfg.handshake_timeout_ms);
    send_wisp(PKT_INFO, 0, as_bytes(sh.info));
  }
}

// ---- sending ---------------------------------------------------------------------------------
void Conn::send_ws(u8 op, bytes payload) {
  u8 h[kMaxServerHeader];
  std::size_t hl = ws_header(h, op, payload.size());
  if (!out_.append(h, hl, sh.small, true) || !out_.append(payload.data(), payload.size(), sh.small, true)) doomed_ = true;
  queued_out();
}

void Conn::send_wisp(u8 type, u32 id, bytes payload) {
  if (ended_) return;
  u8 h[kMaxServerHeader + kWispHeader];
  std::size_t hl = ws_header(h, OP_BINARY, kWispHeader + payload.size());
  wisp_header(h + hl, type, id);
  if (!out_.append(h, hl + kWispHeader, sh.small, true) || !out_.append(payload.data(), payload.size(), sh.small, true)) doomed_ = true;
  queued_out();
}

void Conn::queued_out() {
  // A client that sends but never reads would make every reply (PONG, CLOSE, DATA) pile up here.
  // Block bytes, not payload bytes, are what the pool gives (AUDIT A-4): past its share the session ends.
  if ((out_.bytes > cfg.max_write_buffer || out_.held > out_drop()) && !doomed_) {
    log_line(1, "%s dropped: not reading (%zu bytes queued)", peer_text_, out_.bytes);
    doomed_ = true;
  }
  if (out_.held > sh.plan.out + sh.plan.ctl) paused_out_ = true;  // replies to one more read at most
  if (out_.held > sh.plan.out) {
    sites_paused_ = true;
    if (!high_since_) high_since_ = w.loop.now();
  }
  if (!dirty_) {
    dirty_ = true;
    w.dirty.push_back(this);
  }
}

void Worker::flush_dirty() {
  // Coalesced writes: every frame queued during this iteration goes out in one writev per client.
  for (std::size_t i = 0; i < dirty.size(); i++) {
    Conn* c = dirty[i];
    c->dirty_ = false;
    if (c->ended_) continue;
    if (c->doomed_) { c->end(); continue; }
    c->flush();
  }
  dirty.clear();
}

void Conn::flush() {
  if (ended_) return;
  while (!out_.empty()) {
    if (!writable) return;
    iovec v[kMaxIov];
    int cnt = out_.iov(v, cfg.writev ? kMaxIov : 1);
    ssize_t n = io_writev(v, cnt);
    if (n < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) { writable = false; return; }
      if (errno == EINTR) continue;
      end();
      return;
    }
    last_write_ = w.loop.now();
    out_.consume(std::size_t(n), sh.small);
  }
  if (paused_out_ && out_.held <= sh.plan.out) {
    paused_out_ = false;
    w.loop.defer(this);
  }
  if (out_.held < sh.plan.out / 2) high_since_ = 0;
  if (sites_paused_ && out_.held < sh.plan.out / 2) {
    sites_paused_ = false;
    resume_sites();
  }
  if (st_ == St::Closing && out_.empty() && !shut_wr_) {
    // everything is out: half-close and wait (bounded by close_timer_) for the peer to close,
    // so unread input does not turn our last frames into a reset
    shut_wr_ = true;
#if WISP_TLS
    if (tls_on_) tls_.shutdown();  // close_notify first
#endif
    shutdown(fd, SHUT_WR);
  }
}

void Conn::resume_sites() {
  auto& snap = w.scratch;
  streams_.snapshot(snap, 0);
  for (Stream* s : snap)
    if (s->st == Stream::St::Open && s->readable) w.loop.defer(s);
}

// ---- WebSocket sink --------------------------------------------------------------------------
mbytes Conn::frag_acquire(std::size_t max) {
  if (!frag_) frag_ = new_block(sh.large);
  if (!frag_ || frag_->cap < max) return {};
  return mbytes(frag_->data, frag_->cap);
}

void Conn::frag_release() {
  free_block(sh.large, frag_);
  frag_ = nullptr;
}

void Conn::on_control(u8 op, mbytes payload) {
  if (op == OP_CLOSE) {
    send_ws(OP_CLOSE, bytes(payload.data(), std::min<std::size_t>(payload.size(), 2)));
    start_closing();
  } else if (op == OP_PING) {
    send_ws(OP_PONG, payload);
  }
}

void Conn::on_message(u8 op, mbytes payload) {
  if (op != OP_BINARY || st_ == St::Closing) return;  // text frames are not part of Wisp
  if (st_ == St::Info) return client_info(payload);
  packet(payload);
}

void Conn::client_info(mbytes payload) {
  w.loop.disarm(hs_timer_);
  Packet p;
  Info info;
  if (!parse_packet(payload, p) || p.type != PKT_INFO || p.id != 0 || !parse_info(p.payload, info) || info.major != 2) {
    send_close(0, R_EXTENSIONS);
    return start_closing();
  }
  if (sh.has_token) {
    const Info::Ext* e = info.find(EXT_PASSWORD);
    u8 reason = 0;
    if (!e || e->data.empty()) reason = R_AUTH_MISSING;
    else {
      // SHA-256 digests are compared: 32 bytes each, so neither the token's content nor its length
      // shows in the timing.
      auto d = sha256(as_bytes(password_of(e->data)));
      if (!ct_equal(d.data(), sh.token_digest.data(), 32)) reason = R_AUTH_PASSWORD;
    }
    if (reason) {
      log_line(1, "%s authentication failed", peer_text_);
      send_close(0, reason);
      return start_closing();
    }
  }
  client_open_confirm_ = info.find(EXT_OPEN_CONFIRM) != nullptr;
  st_ = St::Ready;
  send_continue(0, cfg.buffer_packets);
}

void Conn::packet(mbytes msg) {
  Packet p;
  if (!parse_packet(msg, p)) return;
  switch (p.type) {
    case PKT_CONNECT: {
      Connect c;
      if (!parse_connect(p.payload, c)) return send_close(p.id, R_INVALID);
      return open_stream(p.id, c);
    }
    case PKT_DATA: {
      Stream* s = streams_.find(p.id);
      if (!s) return;
      // CONTINUE carries an absolute count, and several can be on the wire at once: a client that
      // obeys each one as it arrives can still have more than the window in flight (wisp-bench at
      // 1 GB/s reached 2 x 128 packets). So credit, like the byte caps below, is enforced by
      // backpressure, not by resetting the stream: at 2 x the window the client socket is no longer
      // read. The ring holds 2 x window + 2 sizes, so this check can only fire if that ever breaks.
      if (s->inflight >= 2 * cfg.buffer_packets + 1) return close_stream(s, R_NETWORK, true);
      if (p.payload.empty()) return;
      std::size_t n = p.payload.size();
      // INVARIANT: bytes accepted but not flushed <= max_stream_buffer per stream and
      // <= max_connection_buffer per connection, plus one message (SECURITY-REVIEW finding 1).
      // The credit is in packets and the caps in bytes, so a client within its credit can reach a
      // cap (128 packets of 50 KiB > 4 MiB): it is not reset for that. The packet is taken and the
      // client socket is no longer read (TCP backpressure) until the bytes flush; want_more() stops
      // the parser after this message, so at most one message goes past a cap.
      bucket.take(n, w.loop.now());
      accept_data(s, p.payload);
      if (s->queued > cfg.max_stream_buffer || pending_ > cfg.max_connection_buffer || s->inflight >= 2 * cfg.buffer_packets ||
          tx_held_ > sh.plan.tx)
        paused_caps_ = true;
      if (!bucket.ready(w.loop.now())) {  // out of bandwidth: stop reading this client for a while
        paused_bucket_ = true;
        wait_bucket();
      }
      return;
    }
    case PKT_CLOSE: {
      Stream* s = streams_.find(p.id);
      if (s) close_stream(s, R_VOLUNTARY, false);
      return;
    }
    default:
      return;  // CONTINUE from a client is meaningless; INFO after the handshake is ignored
  }
}

// ---- streams ---------------------------------------------------------------------------------
void Conn::open_stream(u32 id, const Connect& c) {
  if (id == 0 || streams_.find(id)) return send_close(id, R_INVALID);
  if (c.stream_type != STREAM_TCP) return send_close(id, R_INVALID);  // UDP is not offered
  DestCheck why = sh.policy.check_destination(c.host, c.port);
  if (why == DestCheck::InvalidHost) return send_close(id, R_INVALID);
  if (why != DestCheck::Ok) return send_close(id, R_BLOCKED);  // operator lists, before any resolution
  i64 now = w.loop.now();
  if (!session_.admit(c.host, streams_.size(), now)) {
    log_line(1, "%s throttled (streams=%u, connects/min=%u)", peer_text_, streams_.size(), session_.connects(now));
    return send_close(id, R_THROTTLED);
  }
  auto* s = new Stream(this, id, c.host, c.port, cfg.buffer_packets);
  s->tx.charge = &tx_held_;
  s->started = s->last_activity = now;
  s->timer.fn = stream_timer;
  s->timer.arg = s;
  streams_.insert(id, s);
  last_stream_ = now;
  stream_total_++;
  char nb[256];
  std::string_view name = normalize_host_into(c.host, nb);
  if (auto lit = parse_ip(name)) {  // a literal needs no lookup
    if (!sh.policy.address_ok(*lit)) {
      session_.record_failure(now);
      return close_stream(s, R_BLOCKED, true);
    }
    s->addrs[s->naddrs++] = *lit;
    return stream_connect(s);
  }
  // a cached or already pending name sends no query: no lookup slot needed (finding 3 bounds queries)
  if (!w.res.answered_or_pending(name)) {
    if (!session_.lookup_slot()) return close_stream(s, R_THROTTLED, true);
    s->lookup_slot = true;
  }
  bool throttled = false;
  s->lookup = w.res.resolve(name, s, throttled);
  if (s->lookup || s->st != Stream::St::Resolving) return;  // in flight, or answered already (cache, localhost)
  if (s->lookup_slot) { session_.lookup_done(); s->lookup_slot = false; }
  if (!throttled) session_.record_failure(now);
  close_stream(s, throttled ? R_THROTTLED : R_UNREACHABLE, true);
}

void Stream::on_resolved(const DnsAnswer& v6, const DnsAnswer& v4, bool ok) { conn->stream_resolved(this, v6, v4, ok); }

void Conn::stream_resolved(Stream* s, const DnsAnswer& v6, const DnsAnswer& v4, bool ok) {
  s->lookup = nullptr;
  if (s->lookup_slot) { session_.lookup_done(); s->lookup_slot = false; }
  if (s->st != Stream::St::Resolving) return;
  i64 now = w.loop.now();
  // INVARIANT (rebinding): only addresses that pass the block list are kept, and the stream later
  // connects to exactly these addresses; the name is never resolved again.
  Ip ok6[kMaxAddrs], ok4[kMaxAddrs];
  unsigned n6 = 0, n4 = 0;
  for (unsigned i = 0; i < v6.count; i++)
    if (sh.policy.address_ok(v6.addrs[i])) ok6[n6++] = v6.addrs[i];
  for (unsigned i = 0; i < v4.count; i++)
    if (sh.policy.address_ok(v4.addrs[i])) ok4[n4++] = v4.addrs[i];
  if (!ok || (n6 + n4) == 0) {
    session_.record_failure(now);
    return close_stream(s, ok ? R_BLOCKED : R_UNREACHABLE, true);
  }
  // alternate the families, IPv6 first (RFC 8305), as relay-guard does
  for (unsigned i = 0; i < std::max(n6, n4); i++) {
    if (i < n6) s->addrs[s->naddrs++] = ok6[i];
    if (i < n4) s->addrs[s->naddrs++] = ok4[i];
  }
  stream_connect(s);
}

void Conn::stream_timer(void* p) {
  auto* s = static_cast<Stream*>(p);
  Conn* c = s->conn;
  if (s->st == Stream::St::Connecting) return c->stream_attempt_failed(s, R_TIMEOUT);
  if (s->st == Stream::St::Draining) return c->finish_drain(s);
}

void Conn::stream_connect(Stream* s) {
  if (s->st == Stream::St::Resolving) {
    s->st = Stream::St::Connecting;
    s->deadline = w.loop.now() + cfg.connect_timeout_ms;
  }
  while (s->next_addr < s->naddrs) {
    i64 remaining = s->deadline - w.loop.now();
    if (remaining <= 0) break;
    const Ip& ip = s->addrs[s->next_addr++];
    sockaddr_storage to = sockaddr_of(ip, s->port);
#if WISP_TEST_HOOKS
    if (cfg.test_egress) {
      {
        std::lock_guard<std::mutex> g(sh.test_mu);
        if (sh.test_connects.size() < 10000) sh.test_connects.push_back(format_ip(ip));
      }
      to = *cfg.test_egress;
    }
#endif
    if (!take_site_fd(s)) {  // out of the descriptor budget (AUDIT A-8): throttled, not a crash or EMFILE
      s->last_reason = R_THROTTLED;
      break;
    }
    int sfd = socket(to.ss_family, SOCK_STREAM, 0);
    if (sfd < 0) { close_site_fd(s); s->last_reason = errno == EMFILE || errno == ENFILE ? R_THROTTLED : R_NETWORK; continue; }
    set_nonblocking(sfd);
    tune_socket(sfd);
    s->fd = sfd;
    s->readable = s->writable = false;
    int r = connect(sfd, reinterpret_cast<sockaddr*>(&to), sa_len(to));
    if (r == 0 || errno == EINPROGRESS) {
      if (!w.loop.add(s)) { close_site_fd(s); s->last_reason = R_NETWORK; continue; }
      w.loop.arm(s->timer, std::min(remaining, cfg.attempt_timeout_ms));
      return;  // completion arrives as writability
    }
    s->last_reason = errno == ECONNREFUSED ? R_REFUSED : R_NETWORK;
    close_site_fd(s);
  }
  session_.record_failure(w.loop.now());
  close_stream(s, s->last_reason, true);
}

// INVARIANT: one site-socket ticket per open site descriptor, released when it is closed
bool Conn::take_site_fd(Stream* s) {
  if (cfg.site_fd_limit && !sh.site_fds.try_acquire(u32(cfg.site_fd_limit))) return false;
  if (cfg.site_fd_per_ip && !sh.fds_per_ip.try_acquire(client_key_, u32(cfg.site_fd_per_ip), s->fd_slot)) {
    if (cfg.site_fd_limit) sh.site_fds.release();
    return false;
  }
  s->t_fd = true;
  return true;
}

void Conn::close_site_fd(Stream* s) {
  if (s->fd >= 0) {
    close(s->fd);
    s->fd = -1;
  }
  if (s->t_fd) {
    if (cfg.site_fd_limit) sh.site_fds.release();
    if (cfg.site_fd_per_ip) sh.fds_per_ip.release(s->fd_slot);
    s->t_fd = false;
  }
}

void Conn::stream_attempt_failed(Stream* s, u8 reason) {
  w.loop.disarm(s->timer);
  if (s->fd >= 0) {
    w.loop.remove(s);
    close_site_fd(s);
  }
  s->last_reason = reason;
  stream_connect(s);  // next address, or fail
}

void Conn::stream_connected(Stream* s) {
  w.loop.disarm(s->timer);
  s->st = Stream::St::Open;
  s->last_activity = w.loop.now();
  stream_flush(s);  // data the client sent before the socket was there, in order
  if (s->st != Stream::St::Open) return;
  if (client_open_confirm_ && !v1_) send_continue(s->id, cfg.buffer_packets);
  if (g_log_level >= 2) {
    char hb[400];
    log_line(2, "%s stream %u open %s:%u", peer_text_, s->id, log_text(s->host(), hb), s->port);
  }
  if (s->readable) stream_read(s);
}

void Stream::on_io(bool, bool, bool) {
  Conn* c = conn;
  if (st == St::Connecting) {
    if (!writable) return;
    int err = 0;
    socklen_t len = sizeof err;
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) != 0) err = errno;
    if (err == 0) {
      // writable can also mean "connect failed" on some stacks; a connected socket has a peer
      sockaddr_storage peer;
      socklen_t pl = sizeof peer;
      if (getpeername(fd, reinterpret_cast<sockaddr*>(&peer), &pl) != 0) err = ECONNREFUSED;
    }
    if (err == EINPROGRESS || err == EALREADY) { writable = false; return; }
    if (err) return c->stream_attempt_failed(this, err == ECONNREFUSED ? R_REFUSED : R_NETWORK);
    return c->stream_connected(this);
  }
  if (st == St::Open || st == St::Draining) {
    if (writable && !tx.empty()) c->stream_flush(this);
    if (st == St::Open && readable) c->stream_read(this);
  }
}

void Conn::accept_data(Stream* s, mbytes payload) {
  std::size_t n = payload.size();
  s->inflight++;
  s->queued += n;
  pending_ += n;
  s->ring_[(s->ring_head + s->ring_count++) % s->ring_.size()] = u32(n);
  s->last_activity = w.loop.now();
  std::size_t done = 0;
  if (s->st == Stream::St::Open && s->tx.empty() && s->writable) {
    // zero-copy fast path: straight from the unmasked receive buffer to the site socket
    ssize_t k = write(s->fd, payload.data(), n);
    if (k < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) s->writable = false;
      else if (errno != EINTR) return close_stream(s, R_NETWORK, true);
      k = 0;
    }
    done = std::size_t(k);
    s->bytes_out += done;
    bytes_out_ += done;
    if (done) stream_flushed(s, done);
    if (done == n || s->st != Stream::St::Open) return;
  }
  // still connecting, or the site is not taking bytes now: keep a copy, in order
  if (!s->tx.append(payload.data() + done, n - done, sh.small)) {
    log_line(1, "%s stream %u: relay out of buffers", peer_text_, s->id);
    return close_stream(s, R_NETWORK, true);
  }
}

void Conn::stream_flush(Stream* s) {
  while (!s->tx.empty()) {
    if (!s->writable) return;
    iovec v[16];
    int cnt = s->tx.iov(v, cfg.writev ? 16 : 1);
    ssize_t n = cnt == 1 ? write(s->fd, v[0].iov_base, v[0].iov_len) : writev(s->fd, v, cnt);
    if (n < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) { s->writable = false; return; }
      if (errno == EINTR) continue;
      if (s->st == Stream::St::Draining) return finish_drain(s);
      return close_stream(s, R_NETWORK, true);
    }
    s->tx.consume(std::size_t(n), sh.small);
    s->bytes_out += std::size_t(n);
    bytes_out_ += std::size_t(n);
    if (s->st == Stream::St::Draining) {  // no credit any more, but the bytes leave the caps
      s->queued -= std::size_t(n);
      pending_ -= std::size_t(n);
      maybe_resume_caps(nullptr);
      continue;
    }
    stream_flushed(s, std::size_t(n));
    if (s->st != Stream::St::Open) return;
  }
  if (s->st == Stream::St::Draining) finish_drain(s);
}

// The site socket took n bytes: only now do they stop counting against the caps, and the client
// gets its credit back per completed packet (SECURITY-REVIEW finding 1).
void Conn::stream_flushed(Stream* s, std::size_t n) {
  s->queued -= n;
  pending_ -= n;
  s->last_activity = w.loop.now();
  while (n && s->ring_count) {
    u32& front = s->ring_[s->ring_head];
    u32 k = u32(std::min<std::size_t>(front, n));
    front -= k;
    n -= k;
    if (front) break;
    s->ring_head = (s->ring_head + 1) % s->ring_.size();
    s->ring_count--;
    s->inflight--;
    if (++s->since_continue >= (cfg.buffer_packets + 1) / 2) {
      s->since_continue = 0;
      send_continue(s->id, cfg.buffer_packets - s->inflight);
    }
  }
  maybe_resume_caps(s);
}

void Conn::maybe_resume_caps(const Stream* s) {
  if (!paused_caps_ || ended_) return;
  if (pending_ > cfg.max_connection_buffer / 2 || tx_held_ > sh.plan.tx / 2 || (s && (s->queued > cfg.max_stream_buffer / 2 || s->inflight > cfg.buffer_packets))) return;
  paused_caps_ = false;  // another stream still over its cap pauses again on its next packet
  w.loop.defer(this);
}

void Conn::stream_read(Stream* s) {
  for (int i = 0; i < kReadBudget; i++) {
    if (s->st != Stream::St::Open || ended_ || doomed_ || sites_paused_) return;  // resumed by flush()
    i64 now = w.loop.now();
    if (!bucket.ready(now)) { wait_bucket(); return; }
    // Fewer, larger DATA packets for a stream whose site has more ready (a full read): each one is a
    // WebSocket message the client handles, and wisp-js pays per message (epoxy reads 128 KiB too).
    // Quiet streams keep using 36 KiB blocks; an empty bulk pool falls back to them.
    Block* b = s->bulk && cfg.site_read > kSmallBlock - kBlockHdr - kSiteHeadroom ? new_block(sh.bulk) : nullptr;
    if (!b) b = new_block(sh.small);
    if (!b) {
      if (!pool_timer_.armed()) w.loop.arm(pool_timer_, 10);
      return;
    }
    std::size_t room = std::min<std::size_t>(cfg.site_read, b->cap - kSiteHeadroom);
    ssize_t n = read(s->fd, b->data + kSiteHeadroom, room);
    if (n > 0) {
      s->bulk = std::size_t(n) == room ? true : std::size_t(n) < room / 2 ? false : s->bulk;
      // zero-copy framing: the site's bytes were read behind 16 bytes of headroom; the Wisp and
      // WebSocket headers are written in front of them and the block is queued as it is
      u8* wisp_at = b->data + kSiteHeadroom - kWispHeader;
      wisp_header(wisp_at, PKT_DATA, s->id);
      std::size_t hl = ws_header_before(wisp_at, OP_BINARY, kWispHeader + std::size_t(n));
      b->begin = u32(kSiteHeadroom - kWispHeader - hl);
      b->end = u32(kSiteHeadroom + std::size_t(n));
      out_.push(b);
      bucket.take(std::size_t(n), now);
      s->bytes_in += std::size_t(n);
      bytes_in_ += std::size_t(n);
      s->last_activity = now;
      queued_out();
      continue;
    }
    free_block(sh.small, b);
    if (n == 0) return close_stream(s, R_VOLUNTARY, true);  // the site closed its end
    if (errno == EAGAIN || errno == EWOULDBLOCK) { s->readable = false; return; }
    if (errno == EINTR) continue;
    return close_stream(s, R_NETWORK, true);
  }
  w.loop.defer(s);
}

void Conn::close_stream(Stream* s, u8 reason, bool tell) {
  if (s->st == Stream::St::Closed || s->st == Stream::St::Draining) return;
  bool was_open = s->st == Stream::St::Open;
  last_stream_ = w.loop.now();
  forget(s);  // only if the id still belongs to this stream (it may have been closed and reused)
  if (s->lookup) { s->lookup->cancel(s); s->lookup = nullptr; }
  if (s->lookup_slot) { session_.lookup_done(); s->lookup_slot = false; }
  w.loop.disarm(s->timer);
  if (tell) send_close(s->id, reason);
  if (g_log_level >= 2) {
    char hb[400];
    log_line(2, "%s stream %u closed %s:%u after %.1f s, %llu bytes to the site, %llu from it", peer_text_, s->id, log_text(s->host(), hb),
             s->port, double(w.loop.now() - s->started) / 1000.0, (unsigned long long)s->bytes_out, (unsigned long long)s->bytes_in);
  }
  // The client's voluntary close: the site still gets what the client sent before it (bounded:
  // at most max_streams draining per connection, 1 s each), then a FIN.
  // INVARIANT (AUDIT A-3): a draining stream's bytes stay in pending_ (and so under the connection
  // cap and its backpressure) until the site takes them or the drain ends.
  if (reason == R_VOLUNTARY && !tell && was_open && !s->tx.empty() && ndraining_ < cfg.policy.max_streams && !ended_) {
    s->st = Stream::St::Draining;
    s->drain_next = draining_;
    draining_ = s;
    ndraining_++;
    w.loop.arm(s->timer, 1000);
    return;
  }
  pending_ -= s->queued;  // INVARIANT: pending_ is the sum of queued over live and draining streams
  s->queued = 0;
  maybe_resume_caps(nullptr);
  if (s->fd >= 0) {
    if (reason == R_VOLUNTARY && !tell && was_open) shutdown(s->fd, SHUT_WR);
    w.loop.remove(s);
    close_site_fd(s);
  }
  close_site_fd(s);  // a ticket taken for a socket that never opened
  s->tx.clear(sh.small);
  s->st = Stream::St::Closed;
  w.loop.retire(s);
}

void Conn::finish_drain(Stream* s) {
  if (s->st != Stream::St::Draining) return;
  for (Stream** p = &draining_; *p; p = &(*p)->drain_next)
    if (*p == s) { *p = s->drain_next; break; }
  ndraining_--;
  pending_ -= s->queued;
  s->queued = 0;
  maybe_resume_caps(nullptr);
  w.loop.disarm(s->timer);
  if (s->fd >= 0) {
    shutdown(s->fd, SHUT_WR);
    w.loop.remove(s);
    close_site_fd(s);
  }
  s->tx.clear(sh.small);
  s->st = Stream::St::Closed;
  w.loop.retire(s);
}

void Conn::end() {
  if (ended_) return;
  ended_ = true;
  for (Timer* t : {&hs_timer_, &reap_timer_, &close_timer_, &bw_timer_, &pool_timer_}) w.loop.disarm(*t);
  // INVARIANT: every outbound socket this connection opened is closed with it (finding 2)
  std::vector<Stream*> all;
  streams_.snapshot(all, 0);
  for (Stream* s : all) close_stream(s, R_NETWORK, false);
  while (draining_) finish_drain(draining_);
  reader_.reset(*this);
  if (frag_) frag_release();
  if (rx_) { free_block(sh.large, rx_); rx_ = nullptr; }
  out_.clear(sh.small);
  w.loop.remove(this);
#if WISP_TLS
  tls_.free();
#endif
  close(fd);
  fd = -1;
  // INVARIANT: each shared counter ticket is released exactly once
  release_handshake();
  if (t_ip_) { sh.per_ip.release(ip_slot_); t_ip_ = false; }
  if (t_conn_) {
    sh.conns.release();
    t_conn_ = false;
    log_line(1, "%s closed after %lld s: %llu stream(s), %llu bytes to sites, %llu from them", peer_text_,
             (long long)((w.loop.now() - opened_) / 1000), (unsigned long long)stream_total_, (unsigned long long)bytes_out_,
             (unsigned long long)bytes_in_);
  }
  w.loop.retire(this);
}

#if WISP_FUZZ
void Conn::check_invariants() const {
  if (ended_) return;
  // INVARIANT: pending_ is the sum of the live streams' queued bytes, and each is within its cap
  std::vector<Stream*> all;
  streams_.snapshot(all, 0);
  std::size_t sum = 0;
  for (Stream* s : all) {
    if (s->conn != this || s->st == Stream::St::Closed || s->st == Stream::St::Draining) std::abort();
    if (s->queued > cfg.max_stream_buffer + cfg.max_message) std::abort();  // a cap plus one message (backpressure)
    if (s->inflight > 2 * cfg.buffer_packets || s->ring_count != s->inflight) std::abort();
    if (s->tx.bytes != s->queued) std::abort();  // every accepted, unflushed byte is in tx
    sum += s->queued;
  }
  if (streams_.size() > cfg.policy.max_streams || ndraining_ > cfg.policy.max_streams) std::abort();
  unsigned nd = 0;
  for (Stream* d = draining_; d; d = d->drain_next) {
    nd++;
    if (d->st != Stream::St::Draining || d->tx.bytes != d->queued) std::abort();
    sum += d->queued;  // AUDIT A-3: draining bytes still count
  }
  if (nd != ndraining_) std::abort();
  if (sum != pending_ || pending_ > cfg.max_connection_buffer + cfg.max_message) std::abort();
  // the reply queue may pass the cap by at most one site read before the connection is dropped
  if (!doomed_ && out_.bytes > cfg.max_write_buffer + kSmallBlock) std::abort();
  // AUDIT A-4: a session's blocks stay within its pool share
  std::size_t held = 0;
  for (Stream* s : all) held += s->tx.held;
  for (Stream* d = draining_; d; d = d->drain_next) held += d->tx.held;
  if (held != tx_held_ || tx_held_ > sh.plan.tx + cfg.max_message + 2 * kSmallBlock) std::abort();
  if (!doomed_ && out_.held > out_drop()) std::abort();
  if (!doomed_ && tx_held_ + out_.held > sh.plan.session_share) std::abort();
}
#endif

// ---- listener --------------------------------------------------------------------------------
class Listener final : public Handle {
  Timer retry_;
 public:
  explicit Listener(Worker& w, int lfd) : w_(w) {
    fd = lfd;
    retry_.fn = [](void* p) {  // AUDIT A-8: after EMFILE, try again without waiting for a new arrival
      auto* l = static_cast<Listener*>(p);
      l->readable = true;
      l->w_.loop.defer(l);
    };
    retry_.arg = this;
  }
  ~Listener() override { w_.loop.disarm(retry_); }
  void on_io(bool, bool, bool) override {
    for (int i = 0; i < 64; i++) {
      sockaddr_storage peer;
      socklen_t len = sizeof peer;
      int c = accept(fd, reinterpret_cast<sockaddr*>(&peer), &len);
      if (c < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) { readable = false; return; }
        if (errno == EINTR || errno == ECONNABORTED) continue;
        if (errno == EMFILE || errno == ENFILE || errno == ENOBUFS || errno == ENOMEM) {
          // out of descriptors: the pending connections stay in the backlog, and edge-triggered
          // readiness will not repeat for them, so retry on a timer (backoff 100 ms)
          readable = false;
          if (!retry_.armed()) w_.loop.arm(retry_, 100);
          return;
        }
        return;
      }
      set_nonblocking(c);
      tune_socket(c);
      // INVARIANT: connections that have not finished the upgrade are capped globally and per
      // client address (AUDIT A-1: one host cannot hold every slot), each is dropped after
      // handshake_timeout_ms (slowloris), and new connections per address are rate limited
      // (AUDIT A-6: each TLS handshake costs an ECDHE + a signature). A trusted proxy is exempt
      // from the per-address rules: its clients' addresses are not known before the HTTP head.
      const Config& cfg = w_.sh.cfg;
      Ip ip = canonical_probe(ip_of(peer));
      bool proxy = false;
      for (const Cidr& p : cfg.trusted_proxies) proxy |= p.contains(ip);
      IpKey key = ip_key(ip, cfg.ipv6_prefix);
      int rate = cfg.handshake_rate < 0 ? (cfg.tls.empty() ? 0 : 32) : cfg.handshake_rate;
      if (!proxy && rate > 0 && !w_.sh.hs_rate.try_take(key, u32(rate), u32(monotonic_ms() / 1000))) { close(c); continue; }
      std::size_t slot = Conn::kNoSlot;
      if (!proxy && !w_.sh.hs_per_ip.try_acquire(key, cfg.max_handshakes_per_ip, slot)) { close(c); continue; }
      if (!w_.sh.handshakes.try_acquire(cfg.max_handshakes)) {
        if (slot != Conn::kNoSlot) w_.sh.hs_per_ip.release(slot);
        close(c);
        continue;
      }
      auto* conn = new Conn(w_, c, peer, slot);
      if (!w_.loop.add(conn)) conn->end();
    }
    w_.loop.defer(this);
  }

 private:
  Worker& w_;
};

// ---- server ----------------------------------------------------------------------------------
Server::Server(Config c) : cfg_(std::move(c)) {}
Server::~Server() {
  stop();
  wait();
  for (int fd : listen_fds_) close(fd);
}

static int make_listener(const sockaddr_storage& addr, bool reuseport) {
  int fd = socket(addr.ss_family, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
#ifdef SO_REUSEPORT
  if (reuseport) setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &one, sizeof one);
#endif
  if (addr.ss_family == AF_INET6) {
    int zero = 0;
    setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &zero, sizeof zero);
  }
  if (bind(fd, reinterpret_cast<const sockaddr*>(&addr), sa_len(addr)) != 0 || listen(fd, 1024) != 0 || !set_nonblocking(fd)) {
    close(fd);
    return -1;
  }
  return fd;
}

// AUDIT A-8: every connection and stream is a descriptor. The budget: a fixed base (listeners,
// event loops, stdio, logs), one per handshake and connection, the resolvers' UDP sockets, and
// what is left for site sockets (a shared counter, plus a per-address share so one client address
// cannot take them all). Refuses to start when not even one site socket per connection fits.
static bool plan_fds(Config& c, std::string& err) {
  rlimit r{};
  if (getrlimit(RLIMIT_NOFILE, &r) != 0 || r.rlim_cur == RLIM_INFINITY) return true;
  std::size_t lim = std::size_t(r.rlim_cur);
  std::size_t threads = std::max(1u, c.threads);
  std::size_t base = 32 + 4 * threads;
  std::size_t clients = std::size_t(c.max_handshakes) + c.max_connections;
  std::size_t need = base + clients + c.max_connections + threads * 16;
  if (lim < need) {
    err = "RLIMIT_NOFILE is " + std::to_string(lim) + ": --max-connections " + std::to_string(c.max_connections) + " and --max-handshakes " +
          std::to_string(c.max_handshakes) + " need at least " + std::to_string(need) + " descriptors (raise ulimit -n or lower them)";
    return false;
  }
  std::size_t rest = lim - base - clients;
  std::size_t dns = std::clamp<std::size_t>(rest / (8 * threads), 16, c.dns_max_inflight);
  if (dns < c.dns_max_inflight) c.dns_max_inflight = unsigned(dns);
  rest -= threads * c.dns_max_inflight;
  std::size_t per_session = 2 * std::size_t(c.policy.max_streams);  // live + draining
  c.site_fd_limit = rest;
  // a client address gets at most its sessions' worth, and at most an eighth of the budget
  c.site_fd_per_ip = std::max<std::size_t>(per_session, std::min<std::size_t>(std::size_t(c.max_conns_per_ip) * per_session, rest / 8));
  if (c.site_fd_per_ip >= rest) c.site_fd_per_ip = 0;  // no tighter than the total
  if (std::size_t(c.max_connections) * per_session <= rest) c.site_fd_limit = 0;  // every session's maximum fits: no shared cap needed
  return true;
}

bool Server::start() {
  {
    std::string err;
    if (!plan_fds(cfg_, err)) { std::fprintf(stderr, "wisp: %s\n", err.c_str()); return false; }
  }
  const bool automatic_pool = cfg_.pool_mib == 0;
  for (;;) {
    PoolPlan p;
    std::string err;
    if (!plan_pools(cfg_, p, err)) { std::fprintf(stderr, "wisp: %s\n", err.c_str()); return false; }
    // The automatic size can exceed the address space a process may map (sanitizer runtimes,
    // vm.overcommit_memory=2, ulimit -v): probe it, and halve the pool (scaling the budgets) until it fits.
    std::size_t bytes = p.small_blocks * kSmallBlock + p.bulk_blocks * kBulkBlock + (std::size_t(1) << 20);
    int flags = MAP_PRIVATE | MAP_ANON;
#ifdef MAP_NORESERVE
    flags |= MAP_NORESERVE;
#endif
    void* probe = cfg_.malloc_buffers ? nullptr : mmap(nullptr, bytes, PROT_NONE, flags, -1, 0);
    if (probe == MAP_FAILED) {
      if (!automatic_pool) {
        std::fprintf(stderr, "wisp: --pool-mib %zu: cannot reserve %zu MiB of address space\n", cfg_.pool_mib, bytes >> 20);
        return false;
      }
      cfg_.pool_mib = std::max<std::size_t>(4, (p.small_blocks * kSmallBlock >> 20) / 2);  // plan_pools refuses once too small
      std::fprintf(stderr, "wisp: %zu MiB of address space not available for the buffer pools; trying %zu MiB\n", bytes >> 20, cfg_.pool_mib);
      continue;
    }
    if (probe) munmap(probe, bytes);
    if (p.scaled)
      std::fprintf(stderr, "wisp: --pool-mib %zu: per-connection buffers scaled to fit (%zu KiB to sites, %zu KiB to the client)\n",
                   cfg_.pool_mib, p.tx >> 10, p.out >> 10);
    break;
  }
  sh_ = std::make_unique<Shared>(cfg_);
  std::string b = cfg_.bind == "localhost" ? "127.0.0.1" : cfg_.bind;
  auto ip = parse_ip(b);
  if (!ip) { std::fprintf(stderr, "wisp: --bind must be an IP address\n"); return false; }
  sockaddr_storage addr = sockaddr_of(*ip, cfg_.port);
  unsigned n = std::max(1u, cfg_.threads);
#if defined(__linux__)
  bool per_thread = n > 1;  // SO_REUSEPORT: the kernel spreads connections over the listeners
#else
  bool per_thread = false;  // macOS/BSD do not balance SO_REUSEPORT: one shared listener
#endif
  int first = make_listener(addr, per_thread);
  if (first < 0) { std::perror("wisp: listen"); return false; }
  listen_fds_.push_back(first);
  sockaddr_storage got;
  socklen_t gl = sizeof got;
  getsockname(first, reinterpret_cast<sockaddr*>(&got), &gl);
  port_ = ntohs(got.ss_family == AF_INET ? reinterpret_cast<sockaddr_in&>(got).sin_port : reinterpret_cast<sockaddr_in6&>(got).sin6_port);
  if (per_thread) {
    addr = sockaddr_of(*ip, port_);
    for (unsigned i = 1; i < n; i++) {
      int fd = make_listener(addr, true);
      if (fd < 0) { std::perror("wisp: listen (SO_REUSEPORT)"); return false; }
      listen_fds_.push_back(fd);
    }
  }
  for (unsigned i = 0; i < n; i++) {
    int lfd = listen_fds_[per_thread ? i : 0];
    sh_->threads.emplace_back([this, i, lfd] {
      auto* wk = new Worker(*sh_, i);
      auto* l = new Listener(*wk, lfd);
      wk->loop.add(l);
      wk->loop.run();
      wk->loop.remove(l);
      sh_->small.flush_thread_cache();
      sh_->bulk.flush_thread_cache();
      sh_->large.flush_thread_cache();
      // the process is exiting: connections are not torn down one by one
    });
  }
#if WISP_TEST_HOOKS
  if (cfg_.test_hold_fds_ms) {  // simulate another user of the descriptors: 300 ms after start, take every free one for a while
    std::thread([ms = cfg_.test_hold_fds_ms] {
      std::this_thread::sleep_for(std::chrono::milliseconds(300));
      std::vector<int> held;
      for (;;) { int f = open("/dev/null", O_RDONLY); if (f < 0) break; held.push_back(f); }
      std::fprintf(stderr, "test: holding %zu descriptors\n", held.size());
      std::this_thread::sleep_for(std::chrono::milliseconds(ms));
      for (int f : held) close(f);
      std::fprintf(stderr, "test: released them\n");
    }).detach();
  }
#endif
  return true;
}

void Server::stop() {
  // Workers poll the flag via their loop timeout (<= 1 s); main() exits the process on a signal
  // anyway, so this is only used by tests that embed the server.
  if (sh_) sh_->stopping = true;
}

void Server::wait() {
  if (!sh_) return;
  for (auto& t : sh_->threads)
    if (t.joinable()) t.join();
  sh_->threads.clear();
}

}  // namespace wisp

#if WISP_FUZZ
#include "fuzz_session.inc"
#endif
