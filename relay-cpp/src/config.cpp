#include "config.hpp"

#include <ifaddrs.h>
#include <netinet/in.h>

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <thread>

#include "dns.hpp"
#include "log.hpp"

namespace wisp {

const char* const kUsage = R"(wisp-server [options]

  --bind ADDR                 address to listen on (default 127.0.0.1; env WISP_BIND)
  --port N                    port (default 8101; env WISP_PORT; 0 = any)
  --origin URL                a web origin allowed to connect; repeatable; '*' = any (required)
  --host-allow PATTERN        destination host: name, *.suffix, or *; repeatable; env WISP_HOSTS comma-separated
  --allow-any-host            OPEN PROXY TO THE INTERNET (ports and address ranges still limited)
  --port-allow 80,443         destination ports (env WISP_PORTS)
  --token SECRET | --token-file FILE   shared secret (env WISP_TOKEN)
  --block CIDR                extra range never connected to; repeatable. Block your network's own NAT64
                              prefix here if it uses a network-specific one (64:ff9b::/96 and 64:ff9b:1::/48 are built in)
  --own-address ADDR          this relay's public IP (or CIDR) so it cannot be used to reach itself; repeatable
                              (this machine's interface addresses are blocked automatically; --no-block-local turns that off)
  --allow-private             DEVELOPMENT ONLY: allow private and loopback destinations
  --max-streams N --max-connects-per-minute N --max-conns-per-ip N --max-connections N --max-kbps N (default 8192 KiB/s per WebSocket; 0 = unlimited)
  --trust-proxy ADDR          reverse proxy address/CIDR whose X-Forwarded-For is believed (repeatable; default none).
                              Without it every client behind a proxy shares the proxy's address and its limit.
  --scan-hosts-per-minute N (at most 4096) --scan-failures-per-minute N --max-concurrent-lookups N
  --connect-timeout S --attempt-timeout S --idle-timeout S
  --motd TEXT
  --log 0|1|2                 0 nothing, 1 connections (default), 2 streams too (never content)

 engine (this server only):
  --threads N                 worker threads, one event loop each (default: one per core)
  --io-uring                  Linux: readiness through io_uring instead of epoll (build with IO_URING=1)
  --dns-server ADDR[:PORT]    name server (repeatable; default: nameserver lines of /etc/resolv.conf)
  --dns-timeout-ms N          per lookup (default 3000)
  --dns-cache N               names cached per worker for min(TTL, 300 s) (default 4096; 0 = off). Every
                              cached address is checked against the block list on every use.
  --max-handshakes N          connections still in the TLS/HTTP upgrade, all together (default 256)
  --max-handshakes-per-ip N   of those, per client address / IPv6 prefix (default 16; --trust-proxy peers exempt)
  --handshake-rate N          new connections per client address per second (default 32 with TLS, unlimited
                              without; 0 = unlimited; --trust-proxy peers exempt)
  --write-stall-ms N          drop a client whose queued replies make no progress this long (default 60000)
  --ipv6-prefix N             IPv6 clients are limited per this many leading bits (default 64)
  --site-read N               largest DATA packet towards the client (default 131072; 1024-131072)
  --buffer-packets N          Wisp CONTINUE window per stream (default 128, at most 4096)
  --max-stream-buffer BYTES --max-connection-buffer BYTES --max-write-buffer BYTES --max-message BYTES
  --reap-interval-ms N --handshake-timeout-ms N
  --pool-mib N                shared 36 KiB buffer pool (default 0: sized from --max-connections x the per-connection
                              budget, address space only; a smaller N scales those budgets down to fit)
  --no-simd --no-writev --malloc-buffers   benchmark stages: scalar unmasking, one write per frame, malloc per buffer

  --tls-cert FILE --tls-key FILE   serve wss:// directly (TLS=1 builds: OpenSSL 3 handshake, kTLS records on
                              Linux when available); repeatable for SNI; SIGHUP reloads the files.
                              Without them: plain ws://, terminate TLS in a reverse proxy.
You are the operator and responsible for the traffic that leaves this machine.
)";

namespace {
bool num(const std::string& s, double& out) {
  if (s.empty()) return false;
  char* end = nullptr;
  errno = 0;
  out = std::strtod(s.c_str(), &end);
  return errno == 0 && end && *end == 0 && std::isfinite(out) && out >= 0;
}
std::vector<std::string> split(const std::string& s, char sep) {
  std::vector<std::string> out;
  std::string cur;
  std::istringstream in(s);
  while (std::getline(in, cur, sep)) {
    std::size_t a = cur.find_first_not_of(" \t"), b = cur.find_last_not_of(" \t");
    if (a != std::string::npos) out.push_back(cur.substr(a, b - a + 1));
  }
  return out;
}
}  // namespace

std::vector<Cidr> interface_addresses() {
  std::vector<Cidr> out;
  ifaddrs* list = nullptr;
  if (getifaddrs(&list) != 0) return out;
  for (ifaddrs* i = list; i; i = i->ifa_next) {
    if (!i->ifa_addr) continue;
    if (i->ifa_addr->sa_family == AF_INET) {
      auto* a = reinterpret_cast<sockaddr_in*>(i->ifa_addr);
      out.push_back(Cidr{4, ntohl(a->sin_addr.s_addr), 32});
    } else if (i->ifa_addr->sa_family == AF_INET6) {
      auto* a = reinterpret_cast<sockaddr_in6*>(i->ifa_addr);
      u128 v = 0;
      for (int k = 0; k < 16; k++) v = (v << 8) | a->sin6_addr.s6_addr[k];
      out.push_back(Cidr{6, v, 128});
    }
  }
  freeifaddrs(list);
  return out;
}

int parse_config(int argc, char** argv, Config& c, std::string& err, bool& simd) {
  std::vector<std::string> hosts, blocks, owns, proxies, dns;
  bool any_host = false, no_block_local = false;
  std::string token, token_file, port_allow = "80,443";
  bool has_token = false, has_token_file = false;
  std::string bind, port;
  if (const char* e = std::getenv("WISP_HOSTS")) for (auto& h : split(e, ',')) hosts.push_back(h);
  if (const char* e = std::getenv("WISP_TOKEN")) { token = e; has_token = true; }
  if (const char* e = std::getenv("WISP_PORTS")) port_allow = e;
  if (const char* e = std::getenv("WISP_BIND")) bind = e;
  if (const char* e = std::getenv("WISP_PORT")) port = e;
  if (const char* e = std::getenv("WISP_ALLOW_ANY_HOST")) any_host = std::string(e) == "1";
  c.threads = std::max(1u, std::thread::hardware_concurrency());
  bool motd_set = false;

  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    std::string v;
    std::size_t eq = a.find('=');
    bool inline_v = a.rfind("--", 0) == 0 && eq != std::string::npos;
    if (inline_v) { v = a.substr(eq + 1); a = a.substr(0, eq); }
    auto need = [&]() -> bool {
      if (inline_v) return true;
      if (i + 1 >= argc) { err = "missing value for " + a; return false; }
      v = argv[++i];
      return true;
    };
    auto number = [&](double& out) -> bool {
      if (!need()) return false;
      if (!num(v, out)) { err = "bad number for " + a + ": " + v; return false; }
      return true;
    };
    double d = 0;
    if (a == "-h" || a == "--help") return 1;
    else if (a == "--bind") { if (!need()) return 2; bind = v; }
    else if (a == "--port") { if (!need()) return 2; port = v; }
    else if (a == "--origin") { if (!need()) return 2; c.origins.push_back(v); }
    else if (a == "--host-allow") { if (!need()) return 2; hosts.push_back(v); }
    else if (a == "--allow-any-host") any_host = true;
    else if (a == "--port-allow") { if (!need()) return 2; port_allow = v; }
    else if (a == "--token") { if (!need()) return 2; token = v; has_token = true; }
    else if (a == "--token-file") { if (!need()) return 2; token_file = v; has_token_file = true; }
    else if (a == "--block") { if (!need()) return 2; blocks.push_back(v); }
    else if (a == "--own-address") { if (!need()) return 2; owns.push_back(v); }
    else if (a == "--no-block-local") no_block_local = true;
    else if (a == "--allow-private") c.policy.allow_private = true;
    else if (a == "--max-streams") { if (!number(d)) return 2; c.policy.max_streams = unsigned(d); }
    else if (a == "--max-connects-per-minute") { if (!number(d)) return 2; c.policy.max_connects_per_minute = unsigned(d); }
    else if (a == "--max-conns-per-ip") { if (!number(d)) return 2; c.max_conns_per_ip = unsigned(d); }
    else if (a == "--max-connections") { if (!number(d)) return 2; c.max_connections = unsigned(d); }
    else if (a == "--max-kbps") { if (!number(d)) return 2; c.max_kbps = unsigned(d); }
    else if (a == "--trust-proxy") { if (!need()) return 2; proxies.push_back(v); }
    else if (a == "--scan-hosts-per-minute") { if (!number(d)) return 2; c.policy.scan_hosts_per_minute = unsigned(d); }
    else if (a == "--scan-failures-per-minute") { if (!number(d)) return 2; c.policy.scan_failures_per_minute = unsigned(d); }
    else if (a == "--max-concurrent-lookups") { if (!number(d)) return 2; c.policy.max_concurrent_lookups = unsigned(d); }
    else if (a == "--connect-timeout") { if (!number(d)) return 2; c.connect_timeout_ms = i64(d * 1000); }
    else if (a == "--attempt-timeout") { if (!number(d)) return 2; c.attempt_timeout_ms = i64(d * 1000); }
    else if (a == "--idle-timeout") { if (!number(d)) return 2; c.idle_timeout_ms = i64(d * 1000); }
    else if (a == "--motd") { if (!need()) return 2; c.motd = v; motd_set = true; }
    else if (a == "--log") { if (!number(d)) return 2; g_log_level = int(d); }
    else if (a == "--threads") { if (!number(d)) return 2; c.threads = std::clamp(unsigned(d), 1u, 256u); }
    else if (a == "--io-uring") {
#if defined(__linux__) && WISP_IO_URING
      c.io_uring = true;
#else
      err = "--io-uring: this build has no io_uring backend (Linux, make IO_URING=1)";
      return 2;
#endif
    }
    else if (a == "--dns-server") { if (!need()) return 2; dns.push_back(v); }
    else if (a == "--dns-cache") { if (!number(d)) return 2; c.dns_cache = unsigned(d); }
    else if (a == "--dns-timeout-ms") { if (!number(d)) return 2; c.dns_timeout_ms = int(d); }
    else if (a == "--write-stall-ms") { if (!number(d)) return 2; c.write_stall_timeout_ms = std::max<i64>(100, i64(d)); }
    else if (a == "--max-handshakes") { if (!number(d)) return 2; c.max_handshakes = unsigned(d); }
    else if (a == "--max-handshakes-per-ip") { if (!number(d)) return 2; c.max_handshakes_per_ip = std::max(1u, unsigned(d)); }
    else if (a == "--handshake-rate") { if (!number(d)) return 2; c.handshake_rate = int(std::min(d, 1e6)); }
    else if (a == "--ipv6-prefix") { if (!number(d)) return 2; c.ipv6_prefix = std::min(128u, unsigned(d)); }
    else if (a == "--site-read") { if (!number(d)) return 2; c.site_read = std::clamp<std::size_t>(std::size_t(d), 1024, 131072); }
    else if (a == "--buffer-packets") { if (!number(d)) return 2; c.buffer_packets = std::clamp(unsigned(d), 1u, 4096u); }
    else if (a == "--max-stream-buffer") { if (!number(d)) return 2; c.max_stream_buffer = std::size_t(d); }
    else if (a == "--max-connection-buffer") { if (!number(d)) return 2; c.max_connection_buffer = std::size_t(d); }
    else if (a == "--max-write-buffer") { if (!number(d)) return 2; c.max_write_buffer = std::size_t(d); }
    else if (a == "--max-message") { if (!number(d)) return 2; c.max_message = std::clamp<std::size_t>(std::size_t(d), 1024, 16 << 20); }
    else if (a == "--reap-interval-ms") { if (!number(d)) return 2; c.reap_interval_ms = std::max<i64>(10, i64(d)); }
    else if (a == "--handshake-timeout-ms") { if (!number(d)) return 2; c.handshake_timeout_ms = std::max<i64>(10, i64(d)); }
    else if (a == "--pool-mib") { if (!number(d)) return 2; c.pool_mib = d == 0 ? 0 : std::max<std::size_t>(4, std::size_t(d)); }
    else if (a == "--no-simd") simd = false;
    else if (a == "--no-writev") c.writev = false;
    else if (a == "--malloc-buffers") c.malloc_buffers = true;
#if WISP_TLS
    else if (a == "--tls-cert") { if (!need()) return 2; c.tls.push_back({v, v}); }
    else if (a == "--tls-key") {
      if (!need()) return 2;
      if (c.tls.empty()) { err = "--tls-key must follow its --tls-cert"; return 2; }
      c.tls.back().key = v;
    }
#else
    else if (a == "--tls-cert" || a == "--tls-key") { err = "no TLS in this build (make TLS=1 with OpenSSL 3): terminate wss:// in a reverse proxy"; return 2; }
#endif
#if WISP_TEST_HOOKS
    else if (a == "--test-hold-fds-ms") { if (!number(d)) return 2; c.test_hold_fds_ms = std::size_t(d); }
    else if (a == "--test-egress") {
      if (!need()) return 2;
      sockaddr_storage s;
      if (!Resolver::parse_server(v, s)) { err = "bad --test-egress"; return 2; }
      c.test_egress = s;
    }
#endif
    else { err = "unknown option " + a; return 2; }
  }

  if (has_token_file) {
    std::ifstream f(token_file);
    if (!f) { err = "cannot read --token-file"; return 2; }
    std::stringstream ss;
    ss << f.rdbuf();
    std::string t = ss.str();
    std::size_t a = t.find_first_not_of(" \t\r\n"), b = t.find_last_not_of(" \t\r\n");
    token = a == std::string::npos ? "" : t.substr(a, b - a + 1);
    has_token = true;
  }
  if (has_token && !token.empty()) c.token = token;

  for (auto& h : hosts) c.policy.host_allow.push_back(normalize_host(h));
  if (any_host) c.policy.host_allow = {"*"};
  if (c.policy.host_allow.empty()) {
    err = "no destinations allowed: give --host-allow PATTERN (or WISP_HOSTS); --allow-any-host opens it to the internet";
    return 2;
  }
  if (c.origins.empty()) { err = "no origins allowed: give --origin URL (repeatable), or --origin '*'"; return 2; }
  c.policy.port_allow.clear();
  for (auto& p : split(port_allow, ',')) {
    double d;
    if (!num(p, d) || d < 1 || d > 65535 || d != std::floor(d)) { err = "bad --port-allow"; return 2; }
    c.policy.port_allow.push_back(u16(d));
  }
  for (auto& b : blocks) {
    auto cidr = parse_cidr(b);
    if (!cidr) { err = "bad CIDR: " + b; return 2; }
    c.policy.block.push_back(*cidr);
  }
  for (auto& b : owns) {
    auto cidr = parse_cidr(b);
    if (!cidr) { err = "bad --own-address: " + b; return 2; }
    c.policy.block.push_back(*cidr);
  }
  if (!no_block_local)
    for (auto& cidr : interface_addresses()) c.policy.block.push_back(cidr);
  for (auto& p : proxies) {
    auto cidr = parse_cidr(p);
    if (!cidr) { err = "bad --trust-proxy: " + p; return 2; }
    c.trusted_proxies.push_back(*cidr);
  }
  for (auto& s : dns) {
    sockaddr_storage a;
    if (!Resolver::parse_server(s, a)) { err = "bad --dns-server: " + s; return 2; }
    c.dns_servers.push_back(a);
  }
  if (c.dns_servers.empty()) c.dns_servers = Resolver::system_servers();
  if (!bind.empty()) c.bind = bind;
  if (!port.empty()) {
    double d;
    if (!num(port, d) || d > 65535) { err = "bad --port"; return 2; }
    c.port = u16(d);
  }
  if (c.policy.scan_hosts_per_minute > kMaxScanHosts) c.policy.scan_hosts_per_minute = kMaxScanHosts;
  if (!motd_set) {
    std::vector<u16> ports = c.policy.port_allow;
    std::sort(ports.begin(), ports.end());
    std::string list;
    for (std::size_t i = 0; i < ports.size(); i++) list += (i ? "," : "") + std::to_string(ports[i]);
    c.motd = "Wisp relay. Ports " + list + ". Up to " + std::to_string(c.policy.max_streams) + " streams and " +
             std::to_string(c.policy.max_connects_per_minute) +
             " new connections a minute per session. Private and local addresses are refused. Logs: metadata only.";
  }
  if (c.motd.size() > 4096) c.motd.resize(4096);
  return 0;
}

}  // namespace wisp
