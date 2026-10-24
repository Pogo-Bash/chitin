#include "ip.hpp"

#include <cstdio>

namespace wisp {

std::optional<u32> parse_ipv4(std::string_view s) {
  u32 value = 0;
  int parts = 0;
  std::size_t i = 0;
  while (true) {
    std::size_t start = i;
    u32 n = 0;
    while (i < s.size() && s[i] >= '0' && s[i] <= '9') {
      n = n * 10 + u32(s[i] - '0');
      i++;
      if (i - start > 3) return std::nullopt;
    }
    std::size_t len = i - start;
    if (len == 0) return std::nullopt;
    if (len > 1 && s[start] == '0') return std::nullopt;  // no leading zeros (octal look-alikes)
    if (n > 255) return std::nullopt;
    value = (value << 8) | n;
    parts++;
    if (parts == 4) break;
    if (i >= s.size() || s[i] != '.') return std::nullopt;
    i++;
  }
  if (i != s.size()) return std::nullopt;
  return value;
}

static int hexval(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

// Groups of one half ("a:b:c" or "a:b:1.2.3.4"); false when malformed.
static bool v6_groups(std::string_view part, u16* out, int& count, bool allow_v4_tail) {
  count = 0;
  if (part.empty()) return true;
  std::size_t i = 0;
  while (true) {
    std::size_t j = part.find(':', i);
    std::string_view g = part.substr(i, j == std::string_view::npos ? std::string_view::npos : j - i);
    bool last = j == std::string_view::npos;
    if (g.find('.') != std::string_view::npos) {
      if (!last || !allow_v4_tail) return false;
      auto v4 = parse_ipv4(g);
      if (!v4 || count + 2 > 8) return false;
      out[count++] = u16(*v4 >> 16);
      out[count++] = u16(*v4 & 0xffff);
      return true;
    }
    if (g.empty() || g.size() > 4) return false;
    u32 v = 0;
    for (char c : g) {
      int h = hexval(c);
      if (h < 0) return false;
      v = v * 16 + u32(h);
    }
    if (count >= 8) return false;
    out[count++] = u16(v);
    if (last) return true;
    i = j + 1;
  }
}

std::optional<u128> parse_ipv6(std::string_view s) {
  if (s.empty() || s.size() > 45) return std::nullopt;
  for (char c : s)
    if (!(hexval(c) >= 0 || c == ':' || c == '.')) return std::nullopt;
  std::size_t dc = s.find("::");
  u16 head[8], tail[8], groups[8];
  int nh = 0, nt = 0;
  if (dc != std::string_view::npos) {
    if (s.find("::", dc + 1) != std::string_view::npos) return std::nullopt;
    if (!v6_groups(s.substr(0, dc), head, nh, false)) return std::nullopt;
    if (!v6_groups(s.substr(dc + 2), tail, nt, true)) return std::nullopt;
    int fill = 8 - nh - nt;
    if (fill < 1) return std::nullopt;  // "::" stands for at least one group
    int k = 0;
    for (int i = 0; i < nh; i++) groups[k++] = head[i];
    for (int i = 0; i < fill; i++) groups[k++] = 0;
    for (int i = 0; i < nt; i++) groups[k++] = tail[i];
  } else {
    if (!v6_groups(s, groups, nh, true) || nh != 8) return std::nullopt;
  }
  u128 v = 0;
  for (int i = 0; i < 8; i++) v = (v << 16) | groups[i];
  return v;
}

std::optional<Ip> parse_ip(std::string_view s) {
  if (auto v4 = parse_ipv4(s)) return Ip{4, *v4};
  if (auto v6 = parse_ipv6(s)) return Ip{6, *v6};
  return std::nullopt;
}

std::string format_ip(const Ip& ip) {
  char buf[48];
  if (ip.version == 4) {
    u32 v = u32(ip.value);
    std::snprintf(buf, sizeof buf, "%u.%u.%u.%u", v >> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255);
    return buf;
  }
  std::string out;
  for (int i = 7; i >= 0; i--) {
    std::snprintf(buf, sizeof buf, "%x", unsigned((ip.value >> (16 * i)) & 0xffff));
    out += buf;
    if (i) out += ':';
  }
  return out;
}

static u128 mask_bits(unsigned width, unsigned prefix) {
  if (prefix == 0) return 0;
  u128 all = width == 128 ? ~u128(0) : ((u128(1) << width) - 1);
  return all & ~((u128(1) << (width - prefix)) - 1) & all;
}

bool Cidr::contains(const Ip& ip) const {
  if (ip.version != version) return false;
  unsigned width = version == 4 ? 32 : 128;
  return (ip.value & mask_bits(width, prefix)) == base;
}

std::string Cidr::text() const { return format_ip(Ip{version, base}) + "/" + std::to_string(prefix); }

std::optional<Cidr> parse_cidr(std::string_view s) {
  while (!s.empty() && (s.front() == ' ' || s.front() == '\t')) s.remove_prefix(1);
  while (!s.empty() && (s.back() == ' ' || s.back() == '\t')) s.remove_suffix(1);
  std::size_t slash = s.find('/');
  std::string_view addr = s.substr(0, slash);
  auto ip = parse_ip(addr);
  if (!ip) return std::nullopt;
  unsigned width = ip->version == 4 ? 32 : 128;
  unsigned prefix = width;
  if (slash != std::string_view::npos) {
    std::string_view bits = s.substr(slash + 1);
    if (bits.empty() || bits.size() > 3) return std::nullopt;
    prefix = 0;
    for (char c : bits) {
      if (c < '0' || c > '9') return std::nullopt;
      prefix = prefix * 10 + unsigned(c - '0');
    }
    if (prefix > width) return std::nullopt;
  }
  return Cidr{ip->version, ip->value & mask_bits(width, prefix), prefix};
}

Ip canonical_probe(const Ip& ip) {
  if (ip.version == 6 && (ip.value >> 32) == 0xffff) return Ip{4, ip.value & 0xffffffffu};
  return ip;
}

static const char* const BUILTIN[] = {
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
    "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15",
    "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "255.255.255.255/32",
    "168.63.129.16/32",
    "::/128", "::1/128", "::ffff:0:0/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64",
    // all of 2001::/23 (IANA IETF protocol assignments: Teredo 2001::/32, PCP/TURN/DNS-SD anycast
    // 2001:1::/32, benchmarking 2001:2::/48, AMT 2001:3::/32, AS112 2001:4:112::/48, ORCHID
    // 2001:10::/28, ORCHIDv2 2001:20::/28, drone remote ID 2001:30::/28): nothing a relay should reach
    "2001::/23",
    "2001:db8::/32", "2002::/16", "fc00::/7", "fe80::/10", "ff00::/8",
    "::/96", "::ffff:0:0:0/96", "fec0::/10", "3fff::/20", "5f00::/16",
};

const std::vector<Cidr>& builtin_blocks() {
  static const std::vector<Cidr> list = [] {
    std::vector<Cidr> v;
    for (const char* s : BUILTIN) v.push_back(*parse_cidr(s));
    return v;
  }();
  return list;
}

const char* blocked_address(const Ip& ip, const std::vector<Cidr>& extra) {
  Ip probe = canonical_probe(ip);
  for (const Cidr& c : builtin_blocks())
    if (c.contains(probe)) return "special-purpose range";
  for (const Cidr& c : extra)
    if (c.contains(probe)) return "operator block";
  return nullptr;
}

// One normalization, in one fixed order, for CONNECT hosts and configuration alike (AUDIT A-13):
// strip surrounding whitespace, '[' / ']' and trailing dots repeatedly until none is left (so the
// order they are nested in does not matter and the result is idempotent), then lowercase ASCII.
static std::string_view normalize_view(std::string_view h) {
  auto ws = [](char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f'; };
  for (;;) {
    std::size_t before = h.size();
    while (!h.empty() && (ws(h.front()) || h.front() == '[')) h.remove_prefix(1);
    while (!h.empty() && (ws(h.back()) || h.back() == ']' || h.back() == '.')) h.remove_suffix(1);
    if (h.size() == before) return h;
  }
}
static char lower(char c) { return (c >= 'A' && c <= 'Z') ? char(c - 'A' + 'a') : c; }

std::string_view normalize_host_into(std::string_view h, char (&buf)[256]) {
  h = normalize_view(h);
  std::size_t n = h.size() < sizeof buf ? h.size() : sizeof buf;
  for (std::size_t i = 0; i < n; i++) buf[i] = lower(h[i]);
  return {buf, n};
}

std::string normalize_host(std::string_view h) {
  // configuration input (any length): the same steps as normalize_host_into, without its size bound
  h = normalize_view(h);
  std::string out(h);
  for (char& c : out) c = lower(c);
  return out;
}

static std::string_view strip_brackets(std::string_view h) {
  while (!h.empty() && h.front() == '[') h.remove_prefix(1);
  while (!h.empty() && h.back() == ']') h.remove_suffix(1);
  return h;
}

bool valid_host(std::string_view host) {
  if (host.empty() || host.size() > 253) return false;
  if (host.find('%') != std::string_view::npos) return false;
  if (parse_ip(strip_brackets(host))) return true;
  for (char c : host) {
    bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '.' || c == '-';
    if (!ok) return false;
  }
  return true;
}

bool host_allowed(std::string_view raw, const std::vector<std::string>& patterns) {
  // does not depend on its caller: a host valid_host refuses is never allowed (AUDIT A-13)
  if (!valid_host(raw)) return false;
  char buf[256];
  std::string_view host = normalize_host_into(raw, buf);
  bool literal = parse_ip(host).has_value();
  for (const std::string& p : patterns) {
    if (p == "*" || p == host) return true;
    if (p.size() >= 2 && p[0] == '*' && p[1] == '.' && !literal) {
      std::string_view suffix = std::string_view(p).substr(1);  // ".example.org"
      if (host.size() > suffix.size() && host.ends_with(suffix)) return true;
    }
  }
  return false;
}

IpKey ip_key(const Ip& ip, unsigned prefix) {
  Ip p = canonical_probe(ip);
  if (p.version == 4) return IpKey{p.value, 4};
  if (prefix > 128) prefix = 128;
  return IpKey{p.value & mask_bits(128, prefix), 6};
}

IpKey ip_key(std::string_view address, unsigned prefix) {
  if (auto ip = parse_ip(address)) return ip_key(*ip, prefix);
  // not an address: FNV-1a of the text (only reachable for odd peer strings; never trusted input)
  u64 h = 1469598103934665603ull;
  for (char c : address) { h ^= u8(c); h *= 1099511628211ull; }
  return IpKey{h, 0};
}

}  // namespace wisp
