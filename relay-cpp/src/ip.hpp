// Strict IP literal parsing, CIDR matching and the destination block list: a port of
// packages/relay-guard (src/ip.js, src/index.js). Same rules, two deliberate differences:
//  - zone ids ("fe80::1%en0") are never parsed as addresses here (relay-guard parses and then
//    refuses them in validHost/resolveChecked; the outcome for a CONNECT is the same: invalid host);
//  - addresses are 128-bit integers, never strings, after parsing.
#pragma once
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "common.hpp"

namespace wisp {

using u128 = unsigned __int128;

struct Ip {
  u8 version = 0;  // 4 or 6
  u128 value = 0;  // IPv4 in the low 32 bits
  bool operator==(const Ip&) const = default;
};

std::optional<u32> parse_ipv4(std::string_view s);
std::optional<u128> parse_ipv6(std::string_view s);
std::optional<Ip> parse_ip(std::string_view s);
std::string format_ip(const Ip& ip);

struct Cidr {
  u8 version = 0;
  u128 base = 0;
  unsigned prefix = 0;
  bool contains(const Ip& ip) const;
  std::string text() const;
};
// "a.b.c.d/n", "x::/n" or a bare address. Host bits are masked off. nullopt when malformed.
std::optional<Cidr> parse_cidr(std::string_view s);

// IPv4-mapped IPv6 (::ffff:a.b.c.d) is reported as the IPv4 address it stands for.
Ip canonical_probe(const Ip& ip);

// Reason the address may not be connected to, or nullptr. Checks the built-in special-purpose
// list (relay-guard BLOCKED_CIDRS) and then `extra`.
const char* blocked_address(const Ip& ip, const std::vector<Cidr>& extra);
const std::vector<Cidr>& builtin_blocks();

// "[::1]" -> "::1", "WWW.Example.org." -> "www.example.org" (relay-guard normalizeHost).
std::string normalize_host(std::string_view host);
// The same into a caller buffer (no allocation); inputs over 256 bytes are truncated (callers pass
// only hosts that already passed valid_host, <= 253).
std::string_view normalize_host_into(std::string_view host, char (&buf)[256]);
// relay-guard validHost: <= 253 chars, an IP literal (optionally bracketed) or [A-Za-z0-9_.-]+, no '%'.
bool valid_host(std::string_view host);
// relay-guard hostAllowed: exact, "*.suffix" (never the bare name, never an IP literal), or "*".
// `patterns` must already be normalized.
bool host_allowed(std::string_view host, const std::vector<std::string>& patterns);

// The key a client address is limited under: IPv4 (and IPv4-mapped) as itself, IPv6 by its
// leading `prefix` bits. Returned as a 128-bit value plus a tag folded into the top bits.
struct IpKey {
  u128 v = 0;
  u8 kind = 0;  // 4, 6, or 0 for "not an address" (keyed by a hash of the text)
  bool operator==(const IpKey&) const = default;
};
IpKey ip_key(std::string_view address, unsigned v6_prefix = 64);
IpKey ip_key(const Ip& ip, unsigned v6_prefix = 64);

}  // namespace wisp
