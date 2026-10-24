#include "dns.hpp"
#include "hash.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <unistd.h>

#include <cerrno>
#include <algorithm>
#include <cstdio>
#include <fstream>
#include <string>

namespace wisp {

namespace {
// Query ids from the OS CSPRNG (AUDIT A-11: an mt19937's output can be predicted once observed).
// Buffered per thread so a lookup costs no syscall: 64 ids per refill.
u16 random_id() {
  thread_local u16 buf[64];
  thread_local unsigned left = 0;
  if (!left) { secure_random(buf, sizeof buf); left = 64; }
  return buf[--left];
}
socklen_t sa_len(const sockaddr_storage& s) { return s.ss_family == AF_INET6 ? sizeof(sockaddr_in6) : sizeof(sockaddr_in); }
bool same_addr(const sockaddr_storage& a, const sockaddr_storage& b) {
  if (a.ss_family != b.ss_family) return false;
  if (a.ss_family == AF_INET) {
    auto& x = reinterpret_cast<const sockaddr_in&>(a);
    auto& y = reinterpret_cast<const sockaddr_in&>(b);
    return x.sin_port == y.sin_port && x.sin_addr.s_addr == y.sin_addr.s_addr;
  }
  auto& x = reinterpret_cast<const sockaddr_in6&>(a);
  auto& y = reinterpret_cast<const sockaddr_in6&>(b);
  return x.sin6_port == y.sin6_port && std::memcmp(&x.sin6_addr, &y.sin6_addr, 16) == 0;
}
}  // namespace

bool Resolver::parse_server(std::string_view t, sockaddr_storage& out) {
  std::memset(&out, 0, sizeof out);
  std::string host;
  unsigned port = 53;
  if (!t.empty() && t.front() == '[') {
    std::size_t close = t.find(']');
    if (close == std::string_view::npos) return false;
    host = std::string(t.substr(1, close - 1));
    std::string_view rest = t.substr(close + 1);
    if (!rest.empty()) {
      if (rest.front() != ':') return false;
      port = unsigned(std::atoi(std::string(rest.substr(1)).c_str()));
    }
  } else if (std::count(t.begin(), t.end(), ':') == 1) {
    std::size_t c = t.find(':');
    host = std::string(t.substr(0, c));
    port = unsigned(std::atoi(std::string(t.substr(c + 1)).c_str()));
  } else {
    host = std::string(t);
  }
  if (port == 0 || port > 65535) return false;
  auto* v4 = reinterpret_cast<sockaddr_in*>(&out);
  auto* v6 = reinterpret_cast<sockaddr_in6*>(&out);
  if (inet_pton(AF_INET, host.c_str(), &v4->sin_addr) == 1) {
    v4->sin_family = AF_INET;
    v4->sin_port = htons(u16(port));
    return true;
  }
  if (inet_pton(AF_INET6, host.c_str(), &v6->sin6_addr) == 1) {
    v6->sin6_family = AF_INET6;
    v6->sin6_port = htons(u16(port));
    return true;
  }
  return false;
}

std::vector<sockaddr_storage> Resolver::system_servers() {
  std::vector<sockaddr_storage> out;
  std::ifstream f("/etc/resolv.conf");
  std::string line;
  while (std::getline(f, line)) {
    if (line.rfind("nameserver", 0) != 0) continue;
    std::size_t i = 10;
    while (i < line.size() && (line[i] == ' ' || line[i] == '\t')) i++;
    std::size_t j = i;
    while (j < line.size() && line[j] != ' ' && line[j] != '\t' && line[j] != '#') j++;
    std::string addr = line.substr(i, j - i);
    if (addr.find('%') != std::string::npos) continue;  // scoped addresses are not supported
    sockaddr_storage s;
    if (parse_server(addr.find(':') != std::string::npos ? "[" + addr + "]" : addr, s)) out.push_back(s);
  }
  return out;
}

Resolver::Resolver(Loop& loop, std::vector<sockaddr_storage> servers, int timeout_ms, unsigned max_inflight, unsigned cache_entries)
    : loop_(loop), servers_(std::move(servers)), timeout_ms_(timeout_ms), max_inflight_(max_inflight), cache_max_(cache_entries) {}

void Resolver::remember(std::string_view name, const DnsAnswer& v6, const DnsAnswer& v4) {
  if (!cache_max_ || v6.count + v4.count == 0) return;
  u32 ttl = std::min(v6.count ? v6.ttl : 0xffffffffu, v4.count ? v4.ttl : 0xffffffffu);
  if (ttl == 0) return;
  i64 now = loop_.now();
  if (cache_.size() >= cache_max_) {
    for (auto it = cache_.begin(); it != cache_.end();) it = it->second.expires <= now ? cache_.erase(it) : std::next(it);
    if (cache_.size() >= cache_max_) cache_.erase(cache_.begin());  // full of live entries: drop one
  }
  cache_[std::string(name)] = Cached{v6, v4, now + i64(std::min<u32>(ttl, 300)) * 1000};
}

Lookup* Resolver::resolve(std::string_view name, LookupClient* client, bool& throttled) {
  throttled = false;
  if (name == "localhost" || (name.size() > 10 && name.ends_with(".localhost"))) {
    DnsAnswer v6, v4;
    v6.addrs[v6.count++] = Ip{6, 1};
    v4.addrs[v4.count++] = Ip{4, 0x7f000001};
    client->on_resolved(v6, v4, true);
    return nullptr;
  }
  if (cache_max_) {
    auto it = cache_.find(std::string(name));
    if (it != cache_.end()) {
      if (it->second.expires > loop_.now()) {
        Cached c = it->second;  // copy: the callback may insert into the cache
        client->on_resolved(c.v6, c.v4, true);
        return nullptr;
      }
      cache_.erase(it);
    }
  }
  {
    auto it = pending_.find(std::string(name));
    if (it != pending_.end()) {  // a query for this name is in flight: wait for its answer
      it->second->clients_.push_back(client);
      return it->second;
    }
  }
  if (inflight_ >= max_inflight_) { throttled = true; return nullptr; }
  if (servers_.empty() || name.size() > 253) return nullptr;
  const sockaddr_storage& srv = servers_.front();
  int fd = socket(srv.ss_family, SOCK_DGRAM, 0);
  if (fd < 0) return nullptr;
  if (!set_nonblocking(fd) || connect(fd, reinterpret_cast<const sockaddr*>(&srv), sa_len(srv)) != 0) {
    close(fd);
    return nullptr;
  }
  auto* l = new Lookup();
  l->fd = fd;
  l->res_ = this;
  l->clients_.push_back(client);
  std::memcpy(l->name_, name.data(), name.size());
  l->name_len_ = name.size();
  l->id_a_ = random_id();
  do l->id_aaaa_ = random_id(); while (l->id_aaaa_ == l->id_a_);
  u8 q[600];
  bool sent = false;
  for (u16 type : {DNS_AAAA, DNS_A}) {
    std::size_t n = dns_build_query(q, sizeof q, type == DNS_A ? l->id_a_ : l->id_aaaa_, name, type);
    if (n && send(fd, q, n, 0) == ssize_t(n)) sent = true;
    else if (type == DNS_A) l->got_a_ = true; else l->got_aaaa_ = true;  // count as answered (empty)
  }
  if (!sent || !loop_.add(l)) {
    loop_.remove(l);
    close(fd);
    l->fd = -1;
    delete l;
    return nullptr;
  }
  inflight_++;
  pending_[std::string(name)] = l;
  l->timer_.fn = &Lookup::on_timeout;
  l->timer_.arg = l;
  loop_.arm(l->timer_, timeout_ms_);
  return l;
}

void Lookup::on_io(bool, bool, bool) {
  if (!readable || clients_.empty()) return;
  u8 buf[kMaxDnsMessage + 64];
  sockaddr_storage from;
  for (int i = 0; i < 8; i++) {
    socklen_t fl = sizeof from;
    ssize_t n = recvfrom(fd, buf, sizeof buf, 0, reinterpret_cast<sockaddr*>(&from), &fl);
    if (n < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) { readable = false; return; }
      if (errno == EINTR) continue;
      // ICMP port unreachable etc.: the server is not answering
      got_a_ = got_aaaa_ = true;
      finish();
      return;
    }
    if (!same_addr(from, res_->servers_.front())) continue;  // connected UDP filters this; belt and braces
    std::string_view name(name_, name_len_);
    DnsAnswer tmp;
    bool matched = false;
    if (!got_aaaa_ && dns_parse_response(buf, std::size_t(n), id_aaaa_, name, DNS_AAAA, tmp) != DnsResult::Mismatch) {
      got_aaaa_ = true;
      aaaa_ = tmp;
      matched = true;
    }
    if (!matched && !got_a_) {
      tmp = DnsAnswer{};
      if (dns_parse_response(buf, std::size_t(n), id_a_, name, DNS_A, tmp) != DnsResult::Mismatch) {
        got_a_ = true;
        a_ = tmp;
      }
    }
    if (got_a_ && got_aaaa_) { finish(); return; }
  }
  res_->loop_.defer(this);  // more datagrams may be waiting: come back in this iteration
}

void Lookup::on_timeout(void* self) {
  auto* l = static_cast<Lookup*>(self);
  l->got_a_ = l->got_aaaa_ = true;
  l->finish();
}

void Lookup::finish() {
  bool ok = aaaa_.count + a_.count > 0;
  if (ok) res_->remember(std::string_view(name_, name_len_), aaaa_, a_);
  std::vector<LookupClient*> waiting;
  waiting.swap(clients_);
  DnsAnswer v6 = aaaa_, v4 = a_;  // stop() retires this object; callbacks may start new lookups
  stop();
  for (LookupClient* c : waiting) c->on_resolved(v6, v4, ok);
}

void Lookup::cancel(LookupClient* c) {
  for (std::size_t i = 0; i < clients_.size(); i++)
    if (clients_[i] == c) { clients_.erase(clients_.begin() + long(i)); break; }
  if (clients_.empty()) stop();
}

void Lookup::stop() {
  if (retired) return;
  clients_.clear();
  auto it = res_->pending_.find(std::string(name_, name_len_));
  if (it != res_->pending_.end() && it->second == this) res_->pending_.erase(it);
  res_->loop_.disarm(timer_);
  res_->loop_.remove(this);
  if (fd >= 0) close(fd);
  fd = -1;
  res_->inflight_--;
  res_->loop_.retire(this);
}

bool Resolver::answered_or_pending(std::string_view name) {
  std::string key(name);
  if (pending_.count(key)) return true;
  auto it = cache_.find(key);
  return it != cache_.end() && it->second.expires > loop_.now();
}

}  // namespace wisp
