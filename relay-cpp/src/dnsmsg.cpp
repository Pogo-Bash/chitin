#include "dnsmsg.hpp"

namespace wisp {

std::size_t dns_build_query(u8* out, std::size_t cap, u16 id, std::string_view name, u16 qtype) {
  if (name.empty() || name.size() > 253 || cap < 12 + name.size() + 2 + 4 + 11) return 0;
  u8* p = out;
  store_be16(p, id);
  p[2] = 0x01;  // RD
  p[3] = 0x00;
  store_be16(p + 4, 1);   // QDCOUNT
  store_be16(p + 6, 0);
  store_be16(p + 8, 0);
  store_be16(p + 10, 1);  // ARCOUNT: OPT
  p += 12;
  std::size_t start = 0;
  while (start <= name.size()) {
    std::size_t dot = name.find('.', start);
    if (dot == std::string_view::npos) dot = name.size();
    std::size_t len = dot - start;
    if (len == 0 || len > 63) return 0;
    *p++ = u8(len);
    std::memcpy(p, name.data() + start, len);
    p += len;
    start = dot + 1;
    if (dot == name.size()) break;
  }
  *p++ = 0;
  store_be16(p, qtype);
  store_be16(p + 2, 1);  // IN
  p += 4;
  // OPT RR: root name, type 41, UDP size, ext-rcode/version/flags 0, rdlen 0
  *p++ = 0;
  store_be16(p, 41);
  store_be16(p + 2, u16(kMaxDnsMessage));
  std::memset(p + 4, 0, 6);
  p += 10;
  return std::size_t(p - out);
}

namespace {
// Reads a (possibly compressed) name at `off`; writes it lower-cased with dots into buf.
// Returns the offset after the name in the message (not following pointers), 0 on error.
std::size_t read_name(const u8* m, std::size_t n, std::size_t off, char* buf, std::size_t& len) {
  len = 0;
  std::size_t end = 0;
  unsigned hops = 0;
  std::size_t pos = off;
  for (;;) {
    if (pos >= n) return 0;
    u8 l = m[pos];
    if ((l & 0xc0) == 0xc0) {
      if (pos + 1 >= n) return 0;
      std::size_t target = (std::size_t(l & 0x3f) << 8) | m[pos + 1];
      if (!end) end = pos + 2;
      if (target >= pos || ++hops > 16) return 0;  // only backwards, bounded: no loops
      pos = target;
      continue;
    }
    if (l & 0xc0) return 0;  // 0x40/0x80 label types are not used
    if (l == 0) {
      if (!end) end = pos + 1;
      return end;
    }
    if (pos + 1 + l > n) return 0;
    if (len + l + 1 > 255) return 0;
    if (len) buf[len++] = '.';
    for (unsigned i = 0; i < l; i++) {
      char c = char(m[pos + 1 + i]);
      buf[len++] = (c >= 'A' && c <= 'Z') ? char(c - 'A' + 'a') : c;
    }
    pos += 1 + l;
  }
}

bool name_eq(const char* a, std::size_t al, std::string_view b) {
  if (al != b.size()) return false;
  for (std::size_t i = 0; i < al; i++) {
    char c = b[i];
    if (c >= 'A' && c <= 'Z') c = char(c - 'A' + 'a');
    if (a[i] != c) return false;
  }
  return true;
}
}  // namespace

DnsResult dns_parse_response(const u8* m, std::size_t n, u16 id, std::string_view name, u16 qtype, DnsAnswer& out) {
  if (n < 12) return DnsResult::Mismatch;
  if (load_be16(m) != id) return DnsResult::Mismatch;
  if (!(m[2] & 0x80)) return DnsResult::Mismatch;  // not a response
  u16 qd = load_be16(m + 4), an = load_be16(m + 6);
  if (qd != 1) return DnsResult::Mismatch;
  char buf[256];
  std::size_t len;
  std::size_t off = read_name(m, n, 12, buf, len);
  if (!off || off + 4 > n) return DnsResult::Mismatch;
  if (!name_eq(buf, len, name) || load_be16(m + off) != qtype || load_be16(m + off + 2) != 1) return DnsResult::Mismatch;
  off += 4;
  bool tc = m[2] & 0x02;
  u8 rcode = m[3] & 0x0f;
  if (rcode == 3) return DnsResult::NoName;
  if (rcode != 0) return DnsResult::Fail;
  // Answer section. Every A/AAAA record of the asked type is taken, whatever its owner name
  // (CNAME chains are resolved by the recursive server): the relay checks every address against
  // the block list anyway, so a record's owner name grants nothing.
  for (unsigned i = 0; i < an; i++) {
    std::size_t after = read_name(m, n, off, buf, len);
    if (!after || after + 10 > n) return out.count ? DnsResult::Ok : DnsResult::Fail;
    u16 type = load_be16(m + after), cls = load_be16(m + after + 2);
    u16 rdlen = load_be16(m + after + 8);
    u32 rttl = (u32(m[after + 4]) << 24) | (u32(m[after + 5]) << 16) | (u32(m[after + 6]) << 8) | m[after + 7];
    std::size_t rd = after + 10;
    if (rd + rdlen > n) return out.count ? DnsResult::Ok : DnsResult::Fail;
    if (cls == 1 && type == qtype && out.count < kMaxAddrs && (rdlen == 4 || rdlen == 16)) {
      if (rttl < out.ttl) out.ttl = rttl;
      if (type == DNS_A && rdlen == 4) {
        out.addrs[out.count++] = Ip{4, (u32(m[rd]) << 24) | (u32(m[rd + 1]) << 16) | (u32(m[rd + 2]) << 8) | m[rd + 3]};
      } else if (type == DNS_AAAA && rdlen == 16) {
        u128 v = 0;
        for (int k = 0; k < 16; k++) v = (v << 8) | m[rd + k];
        out.addrs[out.count++] = Ip{6, v};
      }
    }
    off = rd + rdlen;
  }
  if (tc && !out.count) return DnsResult::Truncated;
  return DnsResult::Ok;
}

}  // namespace wisp
