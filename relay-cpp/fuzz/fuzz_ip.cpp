// IP literals, CIDRs and host rules: parse/format round trips, normalization idempotence, and the
// allowlist rule that a literal IP never matches a wildcard.
#include <cstdlib>
#include <string>

#include "../src/ip.hpp"

using namespace wisp;

extern "C" int LLVMFuzzerTestOneInput(const u8* data, std::size_t n) {
  std::string s(reinterpret_cast<const char*>(data), n);
  if (auto ip = parse_ip(s)) {
    auto again = parse_ip(format_ip(*ip));
    if (!again || !(*again == *ip)) std::abort();
    (void)blocked_address(*ip, {});
    Ip probe = canonical_probe(*ip);
    if (probe.version == 4 && (probe.value >> 32)) std::abort();
    (void)ip_key(*ip, unsigned(n % 130));
  }
  if (auto c = parse_cidr(s)) {
    auto again = parse_cidr(c->text());
    if (!again || again->base != c->base || again->prefix != c->prefix || again->version != c->version) std::abort();
    if (!c->contains(Ip{c->version, c->base})) std::abort();
  }
  std::string norm = normalize_host(s);
  // idempotent for every input (one fixed order of stripping, repeated until stable: AUDIT A-13)
  if (normalize_host(norm) != norm) std::abort();
  char buf[256];
  if (n < 256 && std::string(normalize_host_into(s, buf)) != norm) std::abort();
  bool valid = valid_host(s);
  if (valid && (s.size() > 253 || s.find('%') != std::string::npos)) std::abort();
  // a literal never matches a name wildcard
  if (parse_ip(norm)) {
    std::size_t dot = norm.find('.');
    if (dot != std::string::npos && host_allowed(s, {"*" + norm.substr(dot)})) std::abort();
  }
  // split the input: host | pattern
  std::size_t bar = s.find('|');
  if (bar != std::string::npos) {
    std::string host = s.substr(0, bar), pat = normalize_host(s.substr(bar + 1));
    bool ok = host_allowed(host, {pat});
    if (ok && pat != "*" && pat != normalize_host(host)) {
      // wildcard match: pattern "*.x", host ends with ".x", is longer, and is not a literal
      if (pat.size() < 2 || pat[0] != '*' || pat[1] != '.') std::abort();
      if (parse_ip(normalize_host(host))) std::abort();
    }
  }
  return 0;
}
