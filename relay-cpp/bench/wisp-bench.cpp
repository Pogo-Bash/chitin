// wisp-bench: load generator and echo site for Wisp relays (any implementation).
//
//   wisp-bench echo --port P                      TCP echo site (one thread per connection)
//   wisp-bench run --port RELAY --target P [--host 127.0.0.1] [--conns C] [--streams S] [--size N]
//                  [--duration S] [--warmup S] [--v1] [--token T] [--latency] [--window BYTES]
//   wisp-bench idle --port RELAY --conns N --hold S [--v1]   (memory per connection)
//
// Throughput: every stream sends DATA packets of --size bytes as fast as the relay's CONTINUE
// credit allows (Wisp flow control is honoured, so it runs at production limits too), with at
// most --window bytes per stream not yet echoed back. Reports MiB/s echoed (one direction).
// Latency: every stream sends one packet and waits for all of it to come back; p50/p99 of the
// round trips. Client frames are masked with an all-zero key (valid; the relay's unmasking work
// is the same for any key, and the client's CPU is not what is being measured).
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <csignal>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#include "../src/common.hpp"

// gcc 12 reports a false -Warray-bounds inside std::vector::insert for the small CONNECT bodies
#if defined(__GNUC__) && !defined(__clang__)
#pragma GCC diagnostic ignored "-Warray-bounds"
#pragma GCC diagnostic ignored "-Wstringop-overflow"
#pragma GCC diagnostic ignored "-Wstringop-overread"
#endif

using namespace wisp;
using Clock = std::chrono::steady_clock;

namespace {

struct Opts {
  std::string host = "127.0.0.1";
  int port = 0, target = 0;
  int conns = 1, streams = 10, size = 16384;
  double duration = 8, warmup = 1, hold = 10;
  bool v1 = false, latency = false;
  std::string mode = "echo";      // echo | up (site discards) | down (site sends) | streams (open/close rate)
  std::string dest = "127.0.0.1";  // host in CONNECT (a name goes through the relay's resolver)
  int parallel = 8;
  int ttl = 300;                   // dns mode
  int spread = 1;                  // streams mode: consecutive target ports to rotate over                // streams mode: transactions in flight per connection
  std::string token;
  std::size_t window = 1 << 20;
};

int dial(const std::string& host, int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_port = htons(u16(port));
  inet_pton(AF_INET, host.c_str(), &a.sin_addr);
  if (connect(fd, reinterpret_cast<sockaddr*>(&a), sizeof a) != 0) { close(fd); return -1; }
  int one = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
  return fd;
}

bool write_all(int fd, const u8* p, std::size_t n) {
  while (n) {
    ssize_t k = write(fd, p, n);
    if (k <= 0) return false;
    p += k;
    n -= std::size_t(k);
  }
  return true;
}

void wisp_frame(std::vector<u8>& out, u8 type, u32 id, const u8* p, std::size_t n) {
  std::size_t len = 5 + n;
  out.push_back(0x82);
  if (len < 126) out.push_back(u8(0x80 | len));
  else if (len < 65536) { out.push_back(0x80 | 126); out.push_back(u8(len >> 8)); out.push_back(u8(len)); }
  else { out.push_back(0x80 | 127); for (int i = 7; i >= 0; i--) out.push_back(u8(u64(len) >> (8 * i))); }
  out.insert(out.end(), 4, 0);
  out.push_back(type);
  u8 id4[4];
  store_le32(id4, id);
  out.insert(out.end(), id4, id4 + 4);
  if (n) out.insert(out.end(), p, p + n);
}

// Incremental reader of unmasked server frames: calls f(type, id, payload ptr, len) per Wisp packet.
struct Reader {
  std::vector<u8> buf;
  std::size_t off = 0;
  template <class F>
  bool feed(int fd, F&& f) {
    if (buf.size() - off < 65536) {
      if (off) { buf.erase(buf.begin(), buf.begin() + long(off)); off = 0; }
    }
    std::size_t have = buf.size();
    buf.resize(have + 262144);
    ssize_t n = read(fd, buf.data() + have, 262144);
    if (n <= 0) { buf.resize(have); return n < 0 && errno == EAGAIN; }
    buf.resize(have + std::size_t(n));
    for (;;) {
      std::size_t rem = buf.size() - off;
      if (rem < 2) break;
      const u8* p = buf.data() + off;
      u64 len = p[1] & 0x7f;
      std::size_t at = 2;
      if (len == 126) { if (rem < 4) break; len = load_be16(p + 2); at = 4; }
      else if (len == 127) { if (rem < 10) break; len = load_be64(p + 2); at = 10; }
      if (rem < at + len) break;
      u8 op = p[0] & 0x0f;
      if (op == 2 && len >= 5) f(p[at], load_le32(p + at + 1), p + at + 5, std::size_t(len - 5));
      if (op == 8) return false;
      off += at + std::size_t(len);
    }
    return true;
  }
};

// HTTP upgrade + Wisp handshake. Returns the fd (blocking) and the initial credit, or -1.
int open_session(const Opts& o, u32& credit, Reader& rd) {
  int fd = dial(o.host, o.port);
  if (fd < 0) return -1;
  std::string req = "GET / HTTP/1.1\r\nHost: " + o.host + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: http://bench\r\n";
  if (!o.v1) req += "Sec-WebSocket-Protocol: wisp-v2\r\n";
  req += "\r\n";
  if (!write_all(fd, reinterpret_cast<const u8*>(req.data()), req.size())) { close(fd); return -1; }
  // read the response head
  std::string head;
  char c;
  while (head.find("\r\n\r\n") == std::string::npos) {
    if (read(fd, &c, 1) != 1) { close(fd); return -1; }
    head += c;
  }
  if (head.find(" 101 ") == std::string::npos) { std::fprintf(stderr, "upgrade refused: %s\n", head.substr(0, 40).c_str()); close(fd); return -1; }
  bool ready = false;
  credit = 0;
  while (!ready) {
    bool alive = rd.feed(fd, [&](u8 type, u32 id, const u8* p, std::size_t n) {
      if (type == 5 && !o.v1) {  // server INFO: answer with ours
        std::vector<u8> info{2, 1}, out;
        if (!o.token.empty()) {
          std::vector<u8> pw{1, 'b'};
          pw.insert(pw.end(), o.token.begin(), o.token.end());
          info.push_back(2);
          u8 l[4];
          store_le32(l, u32(pw.size()));
          info.insert(info.end(), l, l + 4);
          info.insert(info.end(), pw.begin(), pw.end());
        }
        wisp_frame(out, 5, 0, info.data(), info.size());
        write_all(fd, out.data(), out.size());
      } else if (type == 3 && id == 0 && n >= 4) {
        credit = load_le32(p);
        ready = true;
      } else if (type == 4) {
        std::fprintf(stderr, "relay closed the session: 0x%02x\n", n ? p[0] : 0);
      }
    });
    if (!alive) { close(fd); return -1; }
  }
  return fd;
}

struct Result {
  u64 bytes = 0;
  std::vector<u32> rtt_us;
  bool ok = true;
};

void run_conn(const Opts& o, Result& res, std::atomic<bool>& measuring, std::atomic<bool>& stop) {
  Reader rd;
  u32 credit0;
  int fd = open_session(o, credit0, rd);
  if (fd < 0) { res.ok = false; return; }
  int S = o.streams;
  std::vector<u8> out;
  bool up = o.mode == "up", down = o.mode == "down";
  for (int s = 1; s <= S; s++) {
    const std::string& host = o.dest;
    std::vector<u8> body{1, u8(o.target), u8(o.target >> 8)};
    body.insert(body.end(), host.begin(), host.end());
    wisp_frame(out, 1, u32(s), body.data(), body.size());
  }
  write_all(fd, out.data(), out.size());
  out.clear();
  std::vector<i64> credit(S + 1, credit0), unacked(S + 1, 0);
  std::vector<Clock::time_point> sent_at(S + 1);
  std::vector<u8> payload(std::size_t(o.size), 0x5a);
  std::vector<u8> pkt;
  wisp_frame(pkt, 2, 0, payload.data(), payload.size());  // template; id patched per stream
  std::size_t id_at = pkt.size() - payload.size() - 4;
  std::size_t out_off = 0;
  auto queue_data = [&](int s) {
    store_le32(pkt.data() + id_at, u32(s));
    out.insert(out.end(), pkt.begin(), pkt.end());
    credit[s]--;
    if (up) { if (measuring.load(std::memory_order_relaxed)) res.bytes += std::size_t(o.size); }
    else unacked[s] += o.size;
    if (o.latency) sent_at[s] = Clock::now();
  };
  // non-blocking from here
  fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
  if (o.latency) for (int s = 1; s <= S; s++) if (credit[s] > 0) queue_data(s);
  int rr = 1;
  while (!stop.load(std::memory_order_relaxed)) {
    if (!o.latency && !down && out.size() - out_off < (1 << 20)) {
      for (int k = 0; k < S; k++) {
        int s = rr;
        rr = rr % S + 1;
        if (credit[s] > 0 && unacked[s] + o.size <= i64(o.window)) queue_data(s);
      }
    }
    pollfd p{fd, short(POLLIN | (out.size() > out_off ? POLLOUT : 0)), 0};
    poll(&p, 1, 100);
    if (p.revents & POLLOUT) {
      ssize_t k = write(fd, out.data() + out_off, out.size() - out_off);
      if (k > 0) out_off += std::size_t(k);
      if (out_off == out.size()) { out.clear(); out_off = 0; }
      else if (out_off > (4 << 20)) { out.erase(out.begin(), out.begin() + long(out_off)); out_off = 0; }
    }
    if (p.revents & (POLLIN | POLLHUP | POLLERR)) {
      bool alive = rd.feed(fd, [&](u8 type, u32 id, const u8* q, std::size_t n) {
        if (id == 0 || id > u32(S)) return;
        if (type == 2) {
          unacked[id] -= i64(n);
          if (measuring.load(std::memory_order_relaxed)) res.bytes += n;
          if (o.latency && unacked[id] <= 0) {
            unacked[id] = 0;
            if (measuring.load(std::memory_order_relaxed))
              res.rtt_us.push_back(u32(std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - sent_at[id]).count()));
            if (credit[id] > 0) queue_data(int(id));
          }
        } else if (type == 3 && n >= 4) {
          credit[id] = load_le32(q);
          if (o.latency && unacked[id] == 0 && credit[id] > 0) queue_data(int(id));
        } else if (type == 4) {
          std::fprintf(stderr, "stream %u closed by the relay: 0x%02x\n", id, n ? q[0] : 0);
          res.ok = false;
        }
      });
      if (!alive) { res.ok = false; break; }
    }
  }
  close(fd);
}

// streams mode: each connection keeps --parallel transactions in flight: CONNECT a new stream,
// send --size bytes, wait for the echo, CLOSE; counts completed transactions per second.
void run_streams(const Opts& o, Result& res, std::atomic<bool>& measuring, std::atomic<bool>& stop) {
  Reader rd;
  u32 credit0;
  int fd = open_session(o, credit0, rd);
  if (fd < 0) { res.ok = false; return; }
  fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
  std::vector<u8> out, payload(std::size_t(o.size), 0x33);
  // --target is the first of 16 consecutive echo ports when it is the echo's port+10
  std::vector<u8> body{1, u8(o.target), u8(o.target >> 8)};
  body.insert(body.end(), o.dest.begin(), o.dest.end());
  int nports = o.spread;
  u32 next_id = 1;
  struct Tx { i64 left; Clock::time_point t0; };
  std::vector<std::pair<u32, Tx>> live;
  auto start = [&] {
    u32 id = next_id++;
    u16 port = u16(o.target + int(id % u32(nports)));
    body[1] = u8(port);
    body[2] = u8(port >> 8);
    wisp_frame(out, 1, id, body.data(), body.size());
    wisp_frame(out, 2, id, payload.data(), payload.size());
    live.push_back({id, Tx{o.size, Clock::now()}});
  };
  for (int i = 0; i < o.parallel; i++) start();
  std::size_t off = 0;
  while (!stop.load(std::memory_order_relaxed)) {
    pollfd p{fd, short(POLLIN | (out.size() > off ? POLLOUT : 0)), 0};
    poll(&p, 1, 100);
    if (p.revents & POLLOUT) {
      ssize_t k = write(fd, out.data() + off, out.size() - off);
      if (k > 0) off += std::size_t(k);
      if (off == out.size()) { out.clear(); off = 0; }
    }
    if (p.revents & (POLLIN | POLLHUP | POLLERR)) {
      int done = 0;
      bool alive = rd.feed(fd, [&](u8 type, u32 id, const u8* q, std::size_t n) {
        if (type == 4 && n && q[0] != 2) { static std::atomic<int> shown{0}; if (shown++ < 3) std::fprintf(stderr, "stream %u refused: 0x%02x\n", id, q[0]); }
        for (std::size_t i = 0; i < live.size(); i++) {
          if (live[i].first != id) continue;
          if (type == 2) live[i].second.left -= i64(n);
          if (type == 4) { if (n && q[0] != 2) res.ok = false; live[i].second.left = 0; }
          if (live[i].second.left <= 0) {
            if (type == 2) { u8 r = 2; wisp_frame(out, 4, id, &r, 1); }
            if (measuring.load(std::memory_order_relaxed)) {
              res.bytes++;
              res.rtt_us.push_back(u32(std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - live[i].second.t0).count()));
            }
            live[i] = live.back();
            live.pop_back();
            done++;
          }
          break;
        }
      });
      for (int i = 0; i < done; i++) start();
      if (!alive) { res.ok = false; break; }
    }
  }
  close(fd);
}

int cmd_run(const Opts& o) {
  std::vector<Result> res(std::size_t(o.conns));
  std::atomic<bool> measuring{false}, stop{false};
  std::vector<std::thread> ts;
  for (int i = 0; i < o.conns; i++)
    ts.emplace_back([&, i] {
      if (o.mode == "streams") run_streams(o, res[std::size_t(i)], measuring, stop);
      else run_conn(o, res[std::size_t(i)], measuring, stop);
    });
  std::this_thread::sleep_for(std::chrono::duration<double>(o.warmup));
  measuring = true;
  auto t0 = Clock::now();
  std::this_thread::sleep_for(std::chrono::duration<double>(o.duration));
  measuring = false;
  double el = std::chrono::duration<double>(Clock::now() - t0).count();
  stop = true;
  for (auto& t : ts) t.join();
  u64 bytes = 0;
  std::vector<u32> rtt;
  bool ok = true;
  for (auto& r : res) { bytes += r.bytes; rtt.insert(rtt.end(), r.rtt_us.begin(), r.rtt_us.end()); ok &= r.ok; }
  std::sort(rtt.begin(), rtt.end());
  auto pct = [&](double q) { return rtt.empty() ? 0u : rtt[std::min(rtt.size() - 1, std::size_t(q * double(rtt.size())))]; };
  bool count = o.mode == "streams";
  std::printf("{\"ok\":%s,\"mibps\":%.1f,\"per_s\":%.0f,\"seconds\":%.2f,\"samples\":%zu,\"p50_us\":%u,\"p99_us\":%u}\n", ok ? "true" : "false",
              count ? 0.0 : double(bytes) / el / (1 << 20), double(rtt.size()) / el, el, rtt.size(), pct(0.5), pct(0.99));
  return ok ? 0 : 1;
}

int cmd_idle(const Opts& o) {
  std::vector<int> fds;
  for (int i = 0; i < o.conns; i++) {
    Reader rd;
    u32 credit;
    int fd = open_session(o, credit, rd);
    if (fd < 0) { std::fprintf(stderr, "session %d failed\n", i); break; }
    fds.push_back(fd);
  }
  std::printf("{\"open\":%zu}\n", fds.size());
  std::fflush(stdout);
  std::this_thread::sleep_for(std::chrono::duration<double>(o.hold));
  for (int fd : fds) close(fd);
  return fds.size() == std::size_t(o.conns) ? 0 : 1;
}

// Connection churn from --conns threads for --duration s: sessions opened, a stream opened, some
// data, then closed abruptly or cleanly. Used as a multi-threaded stress (TSan builds).
int cmd_churn(const Opts& o) {
  std::atomic<bool> stop{false};
  std::atomic<u64> sessions{0}, refused{0};
  std::vector<std::thread> ts;
  for (int t = 0; t < o.conns; t++) {
    ts.emplace_back([&, t] {
      u32 k = u32(t) * 2654435761u;
      while (!stop.load()) {
        Reader rd;
        u32 credit;
        int fd = open_session(o, credit, rd);
        if (fd < 0) { refused++; std::this_thread::sleep_for(std::chrono::milliseconds(2)); continue; }
        sessions++;
        std::vector<u8> out;
        std::vector<u8> body{1, u8(o.target), u8(o.target >> 8)};
        const char* h = "127.0.0.1";
        body.insert(body.end(), h, h + 9);
        k = k * 1103515245 + 12345;
        int streams = 1 + int(k >> 28) % 4;
        for (int s = 1; s <= streams; s++) wisp_frame(out, 1, u32(s), body.data(), body.size());
        std::vector<u8> data(std::size_t(1 + (k >> 8) % 20000), 7);
        for (int s = 1; s <= streams; s++) wisp_frame(out, 2, u32(s), data.data(), data.size());
        if (k & 1) { u8 r = 2; wisp_frame(out, 4, 1, &r, 1); }
        write_all(fd, out.data(), out.size());
        if (k & 2) {  // read whatever comes back within 20 ms (a closed single stream sends nothing)
          pollfd p{fd, POLLIN, 0};
          if (poll(&p, 1, 20) > 0) rd.feed(fd, [](u8, u32, const u8*, std::size_t) {});
        }
        close(fd);
      }
    });
  }
  std::this_thread::sleep_for(std::chrono::duration<double>(o.duration));
  stop = true;
  for (auto& t : ts) t.join();
  std::printf("{\"sessions\":%llu,\"refused\":%llu}\n", (unsigned long long)sessions.load(), (unsigned long long)refused.load());
  return 0;
}

// A name server for benchmarks: every A query gets --dest as the answer (TTL --ttl s), AAAA gets
// none. Lets the relay's real resolver path, block-list checks and DNS cache run without the
// internet (pair it with a test-hooks build's --test-egress so the connect lands on the echo).
int cmd_dns(const Opts& o, int ttl) {
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_port = htons(u16(o.port));
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(fd, reinterpret_cast<sockaddr*>(&a), sizeof a) != 0) { std::perror("dns"); return 1; }
  u8 ip[4];
  inet_pton(AF_INET, o.dest.c_str(), ip);
  std::printf("dns on 127.0.0.1:%d answering %s\n", o.port, o.dest.c_str());
  std::fflush(stdout);
  u8 q[1500], r[1600];
  for (;;) {
    sockaddr_in from{};
    socklen_t fl = sizeof from;
    ssize_t n = recvfrom(fd, q, sizeof q, 0, reinterpret_cast<sockaddr*>(&from), &fl);
    if (n < 17) continue;
    std::size_t off = 12;
    while (off < std::size_t(n) && q[off]) off += 1 + q[off];
    if (off + 5 > std::size_t(n)) continue;
    std::size_t qend = off + 5;
    u16 type = load_be16(q + off + 1);
    std::memcpy(r, q, qend);
    r[2] = 0x81; r[3] = 0x80;
    r[6] = 0; r[7] = type == 1 ? 1 : 0;  // ANCOUNT
    r[8] = r[9] = r[10] = r[11] = 0;
    std::size_t m = qend;
    if (type == 1) {
      u8 rr[16] = {0xc0, 0x0c, 0, 1, 0, 1, u8(ttl >> 24), u8(ttl >> 16), u8(ttl >> 8), u8(ttl), 0, 4, ip[0], ip[1], ip[2], ip[3]};
      std::memcpy(r + m, rr, 16);
      m += 16;
    }
    sendto(fd, r, m, 0, reinterpret_cast<sockaddr*>(&from), fl);
  }
}

int cmd_echo(const Opts& o) {
  int l = socket(AF_INET, SOCK_STREAM, 0);
  int one = 1;
  setsockopt(l, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_port = htons(u16(o.port));
  inet_pton(AF_INET, o.dest.c_str(), &a.sin_addr);  // --dest: bind address (default 127.0.0.1)
  if (bind(l, reinterpret_cast<sockaddr*>(&a), sizeof a) != 0 || listen(l, 1024) != 0) { std::perror("echo"); return 1; }
  // port+1: a site that reads and discards; port+2: a site that sends without end
  for (int kind = 1; kind <= 2; kind++) {
    std::thread([kind, port = o.port, bind_addr = o.dest] {
      int l2 = socket(AF_INET, SOCK_STREAM, 0);
      int on = 1;
      setsockopt(l2, SOL_SOCKET, SO_REUSEADDR, &on, sizeof on);
      sockaddr_in b{};
      b.sin_family = AF_INET;
      b.sin_port = htons(u16(port + kind));
      inet_pton(AF_INET, bind_addr.c_str(), &b.sin_addr);
      if (bind(l2, reinterpret_cast<sockaddr*>(&b), sizeof b) != 0 || listen(l2, 1024) != 0) return;
      for (;;) {
        int c = accept(l2, nullptr, nullptr);
        if (c < 0) continue;
        std::thread([c, kind] {
          std::vector<u8> buf(262144, 0x61);
          for (;;) {
            if (kind == 1) { if (read(c, buf.data(), buf.size()) <= 0) break; }
            else if (!write_all(c, buf.data(), buf.size())) break;
          }
          close(c);
        }).detach();
      }
    }).detach();
  }
  // port+10 .. port+25: more echo ports, so the streams mode can open many short connections
  // without running out of (address, port) pairs on loopback while closed ones sit in TIME_WAIT
  for (int extra = 10; extra < 26; extra++) {
    std::thread([port = o.port + extra, bind_addr = o.dest] {
      int l2 = socket(AF_INET, SOCK_STREAM, 0);
      int on = 1;
      setsockopt(l2, SOL_SOCKET, SO_REUSEADDR, &on, sizeof on);
      sockaddr_in b{};
      b.sin_family = AF_INET;
      b.sin_port = htons(u16(port));
      inet_pton(AF_INET, bind_addr.c_str(), &b.sin_addr);
      if (bind(l2, reinterpret_cast<sockaddr*>(&b), sizeof b) != 0 || listen(l2, 1024) != 0) return;
      for (;;) {
        int c = accept(l2, nullptr, nullptr);
        if (c < 0) continue;
        std::thread([c] {
          std::vector<u8> buf(65536);
          for (;;) {
            ssize_t n = read(c, buf.data(), buf.size());
            if (n <= 0 || !write_all(c, buf.data(), std::size_t(n))) break;
          }
          close(c);
        }).detach();
      }
    }).detach();
  }
  std::printf("echo on 127.0.0.1:%d (+%d..%d), sink on %d, source on %d\n", o.port, o.port + 10, o.port + 25, o.port + 1, o.port + 2);
  std::fflush(stdout);
  for (;;) {
    int c = accept(l, nullptr, nullptr);
    if (c < 0) continue;
    setsockopt(c, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    std::thread([c] {
      std::vector<u8> buf(262144);
      for (;;) {
        ssize_t n = read(c, buf.data(), buf.size());
        if (n <= 0 || !write_all(c, buf.data(), std::size_t(n))) break;
      }
      close(c);
    }).detach();
  }
}

}  // namespace

int main(int argc, char** argv) {
  {
    rlimit r{};
    getrlimit(RLIMIT_NOFILE, &r);
    r.rlim_cur = std::min<rlim_t>(r.rlim_max, 10240);
    setrlimit(RLIMIT_NOFILE, &r);
  }
  if (argc < 2) { std::fprintf(stderr, "usage: wisp-bench echo|run|idle [options] (see the source header)\n"); return 2; }
  std::string cmd = argv[1];
  Opts o;
  for (int i = 2; i < argc; i++) {
    std::string a = argv[i];
    auto v = [&]() -> std::string { return i + 1 < argc ? argv[++i] : ""; };
    if (a == "--host") o.host = v();
    else if (a == "--port") o.port = std::atoi(v().c_str());
    else if (a == "--target") o.target = std::atoi(v().c_str());
    else if (a == "--conns") o.conns = std::atoi(v().c_str());
    else if (a == "--streams") o.streams = std::atoi(v().c_str());
    else if (a == "--size") o.size = std::atoi(v().c_str());
    else if (a == "--duration") o.duration = std::atof(v().c_str());
    else if (a == "--warmup") o.warmup = std::atof(v().c_str());
    else if (a == "--hold") o.hold = std::atof(v().c_str());
    else if (a == "--window") o.window = std::size_t(std::atoll(v().c_str()));
    else if (a == "--token") o.token = v();
    else if (a == "--v1") o.v1 = true;
    else if (a == "--latency") o.latency = true;
    else if (a == "--mode") o.mode = v();
    else if (a == "--dest") o.dest = v();
    else if (a == "--spread") o.spread = std::max(1, std::atoi(v().c_str()));
    else if (a == "--ttl") o.ttl = std::atoi(v().c_str());
    else if (a == "--parallel") o.parallel = std::atoi(v().c_str());
    else { std::fprintf(stderr, "unknown option %s\n", a.c_str()); return 2; }
  }
  signal(SIGPIPE, SIG_IGN);
  if (cmd == "echo") return cmd_echo(o);
  if (cmd == "run") return cmd_run(o);
  if (cmd == "idle") return cmd_idle(o);
  if (cmd == "churn") return cmd_churn(o);
  if (cmd == "dns") return cmd_dns(o, o.ttl);
  std::fprintf(stderr, "unknown command %s\n", cmd.c_str());
  return 2;
}
