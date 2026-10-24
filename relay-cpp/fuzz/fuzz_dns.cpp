// DNS responses: arbitrary messages for a query (id, name, type) taken from the input.
#include <cstdlib>
#include <string>
#include <vector>

#include "../src/dnsmsg.hpp"

using namespace wisp;

extern "C" int LLVMFuzzerTestOneInput(const u8* data, std::size_t n) {
  if (n < 4) return 0;
  u16 id = u16(data[0] | (data[1] << 8));
  u16 type = (data[2] & 1) ? DNS_AAAA : DNS_A;
  std::size_t name_len = data[3] % 40;
  data += 4; n -= 4;
  if (name_len > n) return 0;
  std::string name;
  for (std::size_t i = 0; i < name_len; i++) {
    char c = char(data[i]);
    name += (c >= 'a' && c <= 'z') || c == '.' ? c : char('a' + (u8(c) % 26));
  }
  data += name_len; n -= name_len;
  std::vector<u8> msg(data, data + n);
  DnsAnswer a;
  DnsResult r = dns_parse_response(msg.data(), msg.size(), id, name, type, a);
  if (a.count > kMaxAddrs) std::abort();
  for (unsigned i = 0; i < a.count; i++)
    if (a.addrs[i].version != (type == DNS_A ? 4 : 6)) std::abort();
  if (r != DnsResult::Ok && a.count && r != DnsResult::Truncated) {
    // addresses only come with Ok
    if (r == DnsResult::Mismatch || r == DnsResult::NoName) std::abort();
  }
  // round trip: our own query parses as "not a response" (QR clear) for the same id
  u8 q[600];
  std::size_t qn = dns_build_query(q, sizeof q, id, name, type);
  if (qn) {
    DnsAnswer b;
    if (dns_parse_response(q, qn, id, name, type, b) != DnsResult::Mismatch) std::abort();
    q[2] |= 0x80;  // as a response it matches the question
    if (dns_parse_response(q, qn, id, name, type, b) == DnsResult::Mismatch) std::abort();
  }
  return 0;
}
