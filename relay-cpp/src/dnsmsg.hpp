// DNS messages (RFC 1035) for a stub resolver: build an A/AAAA query, parse the answer. Pure
// functions over bytes (fuzzed: fuzz/fuzz_dns.cpp). Only what a relay needs: the addresses of one
// name. Compression pointers are followed with a hop limit and only backwards.
#pragma once
#include <string_view>

#include "ip.hpp"

namespace wisp {

constexpr u16 DNS_A = 1, DNS_AAAA = 28, DNS_CNAME = 5;
constexpr std::size_t kMaxDnsMessage = 1232;  // EDNS-safe UDP size we ask for and accept
constexpr unsigned kMaxAddrs = 16;

// Writes a query for `name` (already normalized, no trailing dot, <= 253 chars, labels <= 63) into
// out (>= 512 bytes). Returns its length, 0 when the name cannot be encoded.
std::size_t dns_build_query(u8* out, std::size_t cap, u16 id, std::string_view name, u16 qtype);

enum class DnsResult { Ok, NoName, Fail, Mismatch, Truncated };

struct DnsAnswer {
  Ip addrs[kMaxAddrs];
  unsigned count = 0;
  u32 ttl = 0xffffffffu;  // smallest TTL of the records taken
};

// Parse a response to the query (id, name, qtype). Mismatch: not an answer to this query (wrong
// id, question, or not a response) - ignore it and keep waiting. Addresses of type qtype in the
// answer section are appended to `out` (up to kMaxAddrs total).
DnsResult dns_parse_response(const u8* msg, std::size_t n, u16 id, std::string_view name, u16 qtype, DnsAnswer& out);

}  // namespace wisp
