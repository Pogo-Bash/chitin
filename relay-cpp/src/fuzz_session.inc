// Session fuzzer harness, included at the end of server.cpp when WISP_FUZZ is set. It runs the real
// connection code (Conn, Stream, resolver, loop) on one thread against a client that is driven by
// the fuzz input through a socketpair, with a local echo site, a site that never reads, a closed
// port and a name server that does not exist. After every step the connection's invariants are
// checked; after the session, every shared counter and every pool block must be back.
#include <poll.h>
#include <csignal>
#include <sys/un.h>

namespace wisp {
namespace fuzzing {

struct Sites {
  int echo_l = -1, sink_l = -1;
  u16 echo_port = 0, sink_port = 0, closed_port = 0;
  std::thread th;
  static u16 listen_on(int& fd) {
    fd = socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(0x7f000001);
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    bind(fd, reinterpret_cast<sockaddr*>(&a), sizeof a);
    listen(fd, 512);
    socklen_t l = sizeof a;
    getsockname(fd, reinterpret_cast<sockaddr*>(&a), &l);
    return ntohs(a.sin_port);
  }
  void start() {
    echo_port = listen_on(echo_l);
    sink_port = listen_on(sink_l);
    int tmp;
    closed_port = listen_on(tmp);
    close(tmp);
    set_nonblocking(echo_l);
    set_nonblocking(sink_l);
    th = std::thread([this] { serve(); });
    th.detach();
  }
  void serve() {
    std::vector<pollfd> fds{{echo_l, POLLIN, 0}, {sink_l, POLLIN, 0}};
    std::vector<int> sinks;
    for (;;) {
      poll(fds.data(), nfds_t(fds.size()), 50);
      for (std::size_t i = 0; i < fds.size(); i++) {
        if (!fds[i].revents) continue;
        if (i == 0) {
          int c;
          while ((c = accept(echo_l, nullptr, nullptr)) >= 0) { set_nonblocking(c); fds.push_back({c, POLLIN, 0}); }
        } else if (i == 1) {
          int c;
          while ((c = accept(sink_l, nullptr, nullptr)) >= 0) { sinks.push_back(c); if (sinks.size() > 256) { close(sinks.front()); sinks.erase(sinks.begin()); } }
        } else {
          u8 buf[65536];
          ssize_t n = read(fds[i].fd, buf, sizeof buf);
          if (n > 0) { ssize_t w = write(fds[i].fd, buf, std::size_t(n)); (void)w; }
          else if (n == 0 || (errno != EAGAIN && errno != EINTR)) { close(fds[i].fd); fds[i].fd = -1; }
        }
        fds[i].revents = 0;
      }
      fds.erase(std::remove_if(fds.begin() + 2, fds.end(), [](const pollfd& p) { return p.fd < 0; }), fds.end());
    }
  }
};

struct Env {
  Sites sites;
  std::unique_ptr<Config> cfg[2];
  std::unique_ptr<Server::Shared> sh[2];
  std::unique_ptr<Worker> w[2];
  Env() {
    signal(SIGPIPE, SIG_IGN);
    sites.start();
    for (int k = 0; k < 2; k++) {
      auto c = std::make_unique<Config>();
      c->origins = {"*"};
      c->policy.port_allow = {443, sites.echo_port, sites.sink_port, sites.closed_port};
      c->policy.max_streams = 8;
      c->policy.max_connects_per_minute = 1000000;
      c->policy.scan_hosts_per_minute = 50;
      c->policy.scan_failures_per_minute = 1000000;
      c->buffer_packets = 4;
      c->max_message = 4096;
      c->max_stream_buffer = 16384;
      c->max_connection_buffer = 24576;
      c->max_write_buffer = 65536;
      c->ws_write_high = 16384;
      c->max_kbps = k ? 64 : 0;  // the second config exercises the bandwidth pauses
      c->connect_timeout_ms = 60;
      c->attempt_timeout_ms = 20;
      c->idle_timeout_ms = 40;
      c->reap_interval_ms = 10;
      c->handshake_timeout_ms = 50;
      c->write_stall_timeout_ms = 40;
      c->pool_mib = 64;
      c->max_connections = 16;
      c->max_handshakes = 16;
      sockaddr_storage dns;
      Resolver::parse_server("127.0.0.1:" + std::to_string(sites.closed_port), dns);
      c->dns_servers = {dns};
      c->dns_timeout_ms = 30;
      if (k == 0) {  // open relay with a token; private destinations refused
        c->token = "fuzz-token";
        c->policy.host_allow = {"*"};
      } else {       // development relay: loopback allowed, no token (v1 possible)
        c->policy.allow_private = true;
        c->policy.host_allow = {"127.0.0.1", "localhost", "*.example", "::1"};
      }
      c->motd = "fuzz";
      sh[k] = std::make_unique<Server::Shared>(*c);
      w[k] = std::make_unique<Worker>(*sh[k], unsigned(k));
      cfg[k] = std::move(c);
    }
    g_log_level = 0;
  }
};

struct In {
  const u8* p;
  std::size_t n;
  u8 u8_() { if (!n) return 0; n--; return *p++; }
  u16 u16_() { return u16(u8_() | (u16(u8_()) << 8)); }
  bytes take(std::size_t k) { k = std::min(k, n); bytes b(p, k); p += k; n -= k; return b; }
};

struct Client {
  int fd;
  Worker& w;
  Conn* conn;
  bool reading = true;
  void pump(int iters, int timeout_ms = 0) {
    for (int i = 0; i < iters; i++) {
      w.loop.run_once(timeout_ms);
      if (reading) drain();
      if (!conn_alive()) conn = nullptr;
      if (conn) conn->check_invariants();
    }
  }
  bool conn_alive() const;
  void drain() {
    u8 buf[65536];
    for (int i = 0; i < 64; i++) {
      ssize_t n = read(fd, buf, sizeof buf);
      if (n <= 0) return;
    }
  }
  void send(const u8* p, std::size_t n) {
    for (int tries = 0; n && tries < 8; tries++) {
      ssize_t k = write(fd, p, n);
      if (k > 0) { p += k; n -= std::size_t(k); continue; }
      if (k < 0 && errno != EAGAIN) return;
      pump(1);
    }
  }
  void frame(u8 b0, bytes payload, const u8 key[4], bool masked = true) {
    std::vector<u8> f;
    f.push_back(b0);
    std::size_t n = payload.size();
    u8 m = masked ? 0x80 : 0;
    if (n < 126) f.push_back(u8(m | n));
    else if (n < 65536) { f.push_back(m | 126); f.push_back(u8(n >> 8)); f.push_back(u8(n)); }
    else { f.push_back(m | 127); for (int i = 7; i >= 0; i--) f.push_back(u8(u64(n) >> (8 * i))); }
    if (masked) f.insert(f.end(), key, key + 4);
    for (std::size_t i = 0; i < n; i++) f.push_back(masked ? u8(payload[i] ^ key[i & 3]) : payload[i]);
    send(f.data(), f.size());
  }
};

// The Conn pointer stays valid until the loop's graveyard runs; liveness is tracked by the
// shared connection counters instead of touching freed memory.
bool Client::conn_alive() const { return conn && (w.sh.conns.value() > 0 || w.sh.handshakes.value() > 0); }

Env& env() {
  static Env* e = new Env();
  return *e;
}

int one(const u8* data, std::size_t size) {
  Env& e = env();
  In in{data, size};
  u8 flags = in.u8_();
  int k = flags & 1;
  Worker& w = *e.w[k];
  Server::Shared& sh = *e.sh[k];
  int sv[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) return 0;
  set_nonblocking(sv[0]);
  set_nonblocking(sv[1]);
  sockaddr_storage peer = sockaddr_of(Ip{4, 0x7f000001u + (flags >> 4)}, 1234);
  IpKey hs_key = ip_key(Ip{4, 0x7f000001u + (flags >> 4)}, 64);
  std::size_t hs_slot = 0;
  if (!sh.hs_per_ip.try_acquire(hs_key, sh.cfg.max_handshakes_per_ip, hs_slot)) { close(sv[0]); close(sv[1]); return 0; }
  if (!sh.handshakes.try_acquire(sh.cfg.max_handshakes)) { sh.hs_per_ip.release(hs_slot); close(sv[0]); close(sv[1]); return 0; }
  auto* conn = new Conn(w, sv[0], peer, hs_slot);
  w.loop.add(conn);
  Client c{sv[1], w, conn};
  // the upgrade request
  std::string head;
  if (flags & 4) {
    bytes raw = in.take(in.u8_());
    head.assign(reinterpret_cast<const char*>(raw.data()), raw.size());
  } else {
    head = "GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
           "Sec-WebSocket-Version: 13\r\nOrigin: o\r\n";
    if (!(flags & 2)) head += "Sec-WebSocket-Protocol: wisp-v2\r\n";
    head += "\r\n";
  }
  c.send(reinterpret_cast<const u8*>(head.data()), head.size());
  c.pump(2);
  u8 key[4] = {in.u8_(), in.u8_(), in.u8_(), in.u8_()};
  const std::string hosts[] = {"127.0.0.1", "localhost", "a.example", "[::1]", "10.0.0.1", "nx.example", "1.1.1.1"};
  auto port_of = [&](u8 b) -> u16 {
    switch (b % 6) {
      case 0: return e.sites.echo_port;
      case 1: return e.sites.sink_port;
      case 2: return e.sites.closed_port;
      case 3: return 443;
      case 4: return 25;
      default: return u16(b * 257);
    }
  };
  auto wisp_packet = [&](u8 type, u32 id, bytes body) {
    std::vector<u8> p(5 + body.size());
    p[0] = type;
    store_le32(p.data() + 1, id);
    if (!body.empty()) std::memcpy(p.data() + 5, body.data(), body.size());
    return p;
  };
  auto send_packet = [&](const std::vector<u8>& p) { c.frame(0x82, bytes(p), key); };
  int steps = 0;
  while (in.n && steps++ < 200 && c.conn) {
    u8 op = in.u8_();
    switch (op % 12) {
      case 0: { bytes raw = in.take(in.u8_() % 64); c.send(raw.data(), raw.size()); break; }
      case 1: {
        u8 b = in.u8_();
        std::size_t len = in.u16_() % 600;
        bytes pl = in.take(len);
        std::vector<u8> body(pl.begin(), pl.end());
        body.resize(len);
        u8 b0 = u8((b & 0x0f) | ((b & 0x10) ? 0x80 : 0) | ((b & 0x20) ? 0x40 : 0));
        c.frame(b0, bytes(body), key, !(b & 0x40));
        break;
      }
      case 2: {
        u32 id = in.u8_() % 6;
        u8 st = in.u8_() % 4 == 0 ? STREAM_UDP : STREAM_TCP;
        u16 port = port_of(in.u8_());
        u8 hc = in.u8_();
        std::vector<u8> body{st, u8(port), u8(port >> 8)};
        if (hc % 9 < 7) body.insert(body.end(), hosts[hc % 9].begin(), hosts[hc % 9].end());
        else { bytes raw = in.take(in.u8_() % 24); body.insert(body.end(), raw.begin(), raw.end()); }
        send_packet(wisp_packet(PKT_CONNECT, id, bytes(body)));
        break;
      }
      case 3: {
        u32 id = in.u8_() % 6;
        std::size_t len = in.u16_() % 4200;
        std::vector<u8> body(len, u8(len));
        send_packet(wisp_packet(PKT_DATA, id, bytes(body)));
        break;
      }
      case 4: { u32 id = in.u8_() % 6; u8 r = in.u8_(); send_packet(wisp_packet(PKT_CLOSE, id, bytes(&r, 1))); break; }
      case 5: {
        std::vector<u8> body{u8(in.u8_() % 4 ? 2 : in.u8_()), in.u8_()};
        unsigned count = in.u8_() % 4;
        for (unsigned i = 0; i < count; i++) {
          u8 id = in.u8_() % 6;
          std::vector<u8> data;
          if (id == EXT_PASSWORD && in.u8_() & 1) {
            std::string pw = (in.u8_() & 1) ? "fuzz-token" : "wrong";
            data.push_back(1);
            data.push_back('u');
            data.insert(data.end(), pw.begin(), pw.end());
          } else {
            bytes raw = in.take(in.u8_() % 20);
            data.assign(raw.begin(), raw.end());
          }
          body.push_back(id);
          u8 l[4];
          store_le32(l, u32(data.size()) + ((in.u8_() == 0xff) ? 1u : 0u));  // sometimes an overrun
          body.insert(body.end(), l, l + 4);
          body.insert(body.end(), data.begin(), data.end());
        }
        send_packet(wisp_packet(PKT_INFO, in.u8_() == 0xff ? 1 : 0, bytes(body)));
        break;
      }
      case 6: {  // one Wisp packet split over several frames, maybe with a ping in between
        u32 id = in.u8_() % 6;
        std::vector<u8> p = wisp_packet(PKT_DATA, id, bytes(std::vector<u8>(in.u16_() % 5000, 7)));
        unsigned parts = 1 + in.u8_() % 4;
        std::size_t at = 0;
        for (unsigned i = 0; i < parts; i++) {
          std::size_t len = i + 1 == parts ? p.size() - at : std::min<std::size_t>(p.size() - at, in.u16_() % 2000);
          u8 b0 = u8((i == 0 ? OP_BINARY : OP_CONT) | (i + 1 == parts ? 0x80 : 0));
          c.frame(b0, bytes(p.data() + at, len), key);
          at += len;
          if (in.u8_() == 0x42) c.frame(0x89, as_bytes("hi"), key);
        }
        break;
      }
      case 7: {
        u8 b = in.u8_();
        u8 opc = b % 3 == 0 ? OP_PING : b % 3 == 1 ? OP_PONG : OP_CLOSE;
        bytes pl = in.take(in.u8_() % 130);
        c.frame(u8(0x80 | opc), pl, key);
        break;
      }
      case 8: c.pump(1 + in.u8_() % 4); break;
      case 9: c.pump(1, in.u8_() % 12); break;
      case 10: c.reading = !c.reading; break;
      case 11: { u8 t = in.u8_(); u32 id = in.u8_(); send_packet(wisp_packet(t, id, in.take(in.u8_() % 16))); break; }
    }
    c.pump(1);
  }
  // the client goes away; the server must release everything
  close(c.fd);
  for (int i = 0; i < 200 && (sh.conns.value() || sh.handshakes.value()); i++) w.loop.run_once(1);
  for (int i = 0; i < 3; i++) w.loop.run_once(0);  // graveyard
  // INVARIANT: all tickets returned, every pool block back, no lookup left behind
  if (sh.conns.value() || sh.handshakes.value() || sh.hs_per_ip.value(hs_key)) std::abort();
  for (u32 slot = 0; slot < 4; slot++) (void)slot;
  if (sh.small.in_use() || sh.large.in_use()) std::abort();
  if (w.res.inflight()) std::abort();
  return 0;
}

}  // namespace fuzzing

int fuzz_session_one(const u8* data, std::size_t size) { return fuzzing::one(data, size); }

}  // namespace wisp
