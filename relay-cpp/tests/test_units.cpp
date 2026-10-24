// Unit tests for the pure pieces: hashes (RFC/FIPS vectors), base64 (RFC 4648), SIMD kernels
// against the scalar reference, IP/CIDR/host rules (ported from relay-guard's tests), HTTP head,
// WebSocket frames, Wisp packets, limits.
#include <cstdio>
#include <random>
#include <string>
#include <vector>

#include "../src/hash.hpp"
#include "../src/http.hpp"
#include "../src/ip.hpp"
#include "../src/policy.hpp"
#include "../src/simd.hpp"
#include "../src/wisp.hpp"
#include "../src/ws.hpp"

using namespace wisp;

static int g_fail = 0, g_pass = 0;
#define CHECK(cond)                                                              \
  do {                                                                           \
    if (cond) g_pass++;                                                          \
    else { g_fail++; std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); } \
  } while (0)
#define CHECKM(cond, msg)                                                                    \
  do {                                                                                       \
    if (cond) g_pass++;                                                                      \
    else { g_fail++; std::fprintf(stderr, "FAIL %s:%d: %s [%s]\n", __FILE__, __LINE__, #cond, std::string(msg).c_str()); } \
  } while (0)

static std::string hex(const u8* p, std::size_t n) {
  static const char* d = "0123456789abcdef";
  std::string s;
  for (std::size_t i = 0; i < n; i++) { s += d[p[i] >> 4]; s += d[p[i] & 15]; }
  return s;
}
template <std::size_t N>
static std::string hex(const std::array<u8, N>& a) { return hex(a.data(), N); }

static void test_hashes() {
  // RFC 3174 section 7.3 test vectors
  CHECK(hex(sha1(as_bytes("abc"))) == "a9993e364706816aba3e25717850c26c9cd0d89d");
  CHECK(hex(sha1(as_bytes("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))) ==
        "84983e441c3bd26ebaae4aa1f95129e5e54670f1");
  {
    Sha1 s;
    std::string a(1000, 'a');
    for (int i = 0; i < 1000; i++) s.update(as_bytes(a));
    CHECK(hex(s.finish()) == "34aa973cd4c4daa4f61eeb2bdbad27316534016f");
  }
  {
    Sha1 s;  // "0123456701234567..." x 10 (80 chars) repeated 10 times, fed in odd chunks
    std::string t;
    for (int i = 0; i < 80; i++) t += "01234567";
    for (std::size_t i = 0; i < t.size(); i += 7) s.update(as_bytes(std::string_view(t).substr(i, 7)));
    CHECK(hex(s.finish()) == "dea356a2cddd90c7a7ecedc5ebb563934f460452");
  }
  CHECK(hex(sha1(as_bytes(""))) == "da39a3ee5e6b4b0d3255bfef95601890afd80709");
  // FIPS 180-2 appendix B
  CHECK(hex(sha256(as_bytes("abc"))) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  CHECK(hex(sha256(as_bytes("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))) ==
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  {
    Sha256 s;
    std::string a(1000, 'a');
    for (int i = 0; i < 1000; i++) s.update(as_bytes(a));
    CHECK(hex(s.finish()) == "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  }
  CHECK(hex(sha256(as_bytes(""))) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  // padding boundaries: 55, 56, 63, 64 bytes give different digests than their neighbours
  std::string prev;
  for (int n : {55, 56, 63, 64, 65}) {
    std::string h = hex(sha256(as_bytes(std::string(n, 'x'))));
    CHECK(h != prev);
    prev = h;
  }
}

static void test_base64() {
  // RFC 4648 section 10
  const char* in[] = {"", "f", "fo", "foo", "foob", "fooba", "foobar"};
  const char* out[] = {"", "Zg==", "Zm8=", "Zm9v", "Zm9vYg==", "Zm9vYmE=", "Zm9vYmFy"};
  for (int i = 0; i < 7; i++) {
    CHECK(base64_encode(as_bytes(in[i])) == out[i]);
    std::string d;
    CHECK(base64_decode(out[i], d) && d == in[i]);
  }
  std::string d;
  for (const char* bad : {"Zg=", "Z===", "Zg=a", "Zm9v!A==", "Zh==", "Zm9=", "=Zg=", "Zg==Zg=="}) CHECKM(!base64_decode(bad, d), bad);
  // RFC 6455 section 1.3 example
  char acc[29] = {};
  websocket_accept("dGhlIHNhbXBsZSBub25jZQ==", acc);
  CHECK(std::string(acc) == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  u8 a[4] = {1, 2, 3, 4}, b[4] = {1, 2, 3, 4}, c[4] = {1, 2, 3, 5};
  CHECK(ct_equal(a, b, 4));
  CHECK(!ct_equal(a, c, 4));
}

static void test_simd() {
  std::mt19937 rng(1);
  std::vector<u8> a(4200), b;
  for (auto& x : a) x = u8(rng());
  u8 key[4] = {0x37, 0xfa, 0x21, 0x3d};
  for (const char* impl : {"neon", "avx2", "sse2", "scalar"}) {
    if (!force_simd(impl)) continue;
    std::printf("simd: testing %s\n", impl);
    for (std::size_t off = 0; off < 17; off++)
      for (std::size_t n : {0, 1, 3, 4, 5, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 129, 1000, 4096})
        for (unsigned phase = 0; phase < 4; phase++) {
          std::vector<u8> x(a.begin() + off, a.begin() + off + n), y = x;
          unmask(x.data(), n, key, phase);
          for (std::size_t i = 0; i < n; i++) y[i] ^= key[(phase + i) & 3];
          CHECKM(x == y, std::to_string(n) + "/" + std::to_string(phase));
        }
  }
  for (const char* impl : {"neon", "avx2", "sse2", "scalar"}) {
  if (!force_simd(impl)) continue;
  auto ok = [](std::string_view s) { return utf8_valid(reinterpret_cast<const u8*>(s.data()), s.size()); };
  CHECK(ok(""));
  CHECK(ok("hello"));
  CHECK(ok("caf\xc3\xa9"));
  CHECK(ok("\xe2\x82\xac"));
  CHECK(ok("\xf0\x9f\x98\x80"));
  CHECK(ok(std::string(40, 'a') + "\xf4\x8f\xbf\xbf" + std::string(40, 'b')));
  for (std::string_view bad : {"\x80", "\xc0\xaf", "\xc1\xbf", "\xe0\x80\xaf", "\xed\xa0\x80", "\xf4\x90\x80\x80", "\xf5\x80\x80\x80",
                               "\xc3", "\xe2\x82", "\xff", "\xf0\x8f\xbf\xbf"})
    CHECKM(!ok(bad), hex(reinterpret_cast<const u8*>(bad.data()), bad.size()));
  CHECK(!ok(std::string(33, 'a') + "\xc3"));
  CHECK(!ok(std::string(16, 'a') + "\x80" + std::string(16, 'a')));
  }
  set_simd(true);
}

static void test_ip() {
  CHECK(parse_ip("127.0.0.1")->version == 4);
  CHECK(parse_ip("::1")->version == 6);
  CHECK(parse_ip("::ffff:127.0.0.1")->version == 6);
  CHECK(!parse_ip("fe80::1%eth0"));  // stricter than relay-guard: zone ids are never addresses here
  for (const char* bad : {"127.1", "0x7f.0.0.1", "2130706433", "017.0.0.1", "256.0.0.1", "1.2.3", "1.2.3.4.5", "", ":::", "1::2::3", "g::1",
                          "1:2:3:4:5:6:7:8:9", "localhost", "::1%", "1:2:3:4:5:6:7::8", "1.2.3.4::", "::1.2.3", "1..2.3", "01.2.3.4",
                          "12345::", ":1::", "1::2:", "1:2:3:4:5:6:7:8:", "::ffff:1.2.3.4.5"})
    CHECKM(!parse_ip(bad), bad);
  CHECK(parse_ip("1:2:3:4:5:6:7:8"));
  CHECK(parse_ip("1:2:3:4:5:6:1.2.3.4"));
  CHECK(parse_ip("::"));
  CHECK(parse_cidr("10.1.2.3/8")->text() == "10.0.0.0/8");
  CHECK(parse_cidr("::1")->text() == "0:0:0:0:0:0:0:1/128");
  CHECK(parse_cidr("0.0.0.0/0")->contains(*parse_ip("8.8.8.8")));
  CHECK(parse_cidr("::/0")->contains(*parse_ip("2001:db8::1")));
  for (const char* bad : {"10.0.0.0/33", "::/129", "10.0.0.0/x", "10.0.0.0/8/8", "nope", "10.0.0.0/"}) CHECKM(!parse_cidr(bad), bad);

  std::vector<Cidr> none;
  for (const char* a : {"0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254",
                        "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.0.2.1", "192.168.1.1",
                        "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.255", "240.0.0.1",
                        "255.255.255.255", "::", "::1", "64:ff9b::7f00:1", "64:ff9b::808:808", "100::1", "2001::1", "2001:db8::1",
                        "2002:7f00:1::1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "ff02::1", "::ffff:127.0.0.1",
                        "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::FFFF:192.168.0.1", "168.63.129.16",
                        "::127.0.0.1", "::ffff:0:127.0.0.1", "fec0::1", "3fff::1", "5f00::1", "fd00:ec2::254", "100.100.100.200",
                        // AUDIT A-10: the rest of 2001::/23
                        "2001:1::1", "2001:2::1", "2001:2:0:ffff::1", "2001:3::1", "2001:4:112::1", "2001:10::1", "2001:1f:ffff::1",
                        "2001:20::1", "2001:2f::1", "2001:30::1", "2001:1ff:ffff::1"})
    CHECKM(blocked_address(*parse_ip(a), none), a);
  for (const char* a : {"8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.0", "100.63.255.255", "100.128.0.0", "169.253.255.255",
                        "169.255.0.0", "192.0.1.1", "198.17.255.255", "198.20.0.0", "223.255.255.255", "2606:4700:4700::1111",
                        "2a00:1450:4001::200e", "::ffff:8.8.8.8", "2001:200::1", "2001:4860:4860::8888"})
    CHECKM(!blocked_address(*parse_ip(a), none), a);
  std::vector<Cidr> extra{*parse_cidr("8.8.8.0/24"), *parse_cidr("2606:4700::/32")};
  CHECK(blocked_address(*parse_ip("8.8.8.8"), extra));
  CHECK(!blocked_address(*parse_ip("8.8.9.1"), extra));
  CHECK(blocked_address(*parse_ip("2606:4700:4700::1111"), extra));
  CHECK(blocked_address(*parse_ip("::ffff:8.8.8.8"), extra));

  std::vector<std::string> p{"en.wikipedia.org", "*.wikimedia.org"};
  CHECK(host_allowed("en.wikipedia.org", p));
  CHECK(host_allowed("EN.Wikipedia.ORG.", p));
  CHECK(host_allowed("upload.wikimedia.org", p));
  CHECK(host_allowed("a.b.wikimedia.org", p));
  CHECK(!host_allowed("wikimedia.org", p));
  CHECK(!host_allowed("de.wikipedia.org", p));
  CHECK(host_allowed("anything.example", {"*"}));
  CHECK(!host_allowed("x", {}));
  std::vector<std::string> q{"*.allowed.example", "good.example"};
  for (const char* h : {"evil.example/.allowed.example", "good.example@evil.example", "good.example#.allowed.example", "good.example:443",
                        "good.example\\.evil.example", "good.example%00.evil.example", "good.example\xe3\x80\x82" "evil.example"})
    CHECKM(!(valid_host(h) && host_allowed(h, q)), h);
  for (const char* h : {"allowed.example", "xallowed.example", "allowed.example.evil.example", "good.example.evil.example",
                        "evilgood.example", "good.example@evil.example", "good.example:443"})
    CHECKM(!host_allowed(h, q), h);
  for (std::string h : {std::string("evil.example/.allowed.example"), std::string("a b"), std::string("a\tb"), std::string("a\nb"),
                        std::string(""), std::string(254, 'x'), std::string("a@b"), std::string("a:443"), std::string("a\\b"),
                        std::string("caf\xc3\xa9.example"), std::string("a%00b"), std::string("fe80::1%en0"), std::string("a\0b", 3)})
    CHECKM(!valid_host(h), h);
  for (const char* h : {"example.org", "xn--caf-dma.example", "a_b.example", "127.0.0.1", "[::1]", "::1"}) CHECKM(valid_host(h), h);
  CHECK(valid_host(std::string(253, 'x')));
  std::vector<std::string> ipp{"*.0.0.1", "*.1", "*.3.4", "*.8.8", "*.1.2.3.4", "*::1", "*.0.1"};
  for (const char* ip : {"127.0.0.1", "10.0.0.1", "1.2.3.4", "::1", "[::1]", "fe80::1", "::ffff:127.0.0.1", "8.8.8.8"})
    CHECKM(!host_allowed(ip, ipp), ip);
  CHECK(host_allowed("127.0.0.1", {"127.0.0.1"}));
  CHECK(host_allowed("[::1]", {"::1"}));
  CHECK(host_allowed("1.2.3.4", {"*"}));
  CHECK(normalize_host(" [::1] ") == "::1");
  CHECK(normalize_host("Example.ORG..") == "example.org");
  // AUDIT A-13: one order, repeated until stable, for both lengths; whitespace inside brackets is
  // stripped too, and host_allowed refuses what valid_host refuses whoever calls it
  {
    char nb[256];
    for (std::string h : {std::string("\t[\t127.0.0.1\t"), std::string(300, '\t') + "[\t127.0.0.1\t" + std::string(20, ' '),
                          std::string("[ a.example. ]"), std::string(". [a.example] ."), std::string("[[A.Example]]..")}) {
      std::string n = normalize_host(h);
      CHECKM(normalize_host(n) == n, h);
      if (h.size() < 256) CHECKM(std::string(normalize_host_into(h, nb)) == n, h);
    }
    CHECK(normalize_host("\t[\t127.0.0.1\t") == "127.0.0.1");
    CHECK(normalize_host(std::string(300, '\t') + "[\t127.0.0.1\t") == "127.0.0.1");
    CHECK(!host_allowed("\t[\t127.0.0.1\t", {"*.0.0.1"}));
    CHECK(!host_allowed("\t[\t127.0.0.1\t", {"*"}));
    CHECK(!host_allowed(" good.example", {"good.example"}));
  }

  // AUDIT A-11: OS CSPRNG bytes (DNS query ids): not constant, not repeating, both bytes vary
  {
    u8 a[64] = {}, b[64] = {};
    secure_random(a, sizeof a);
    secure_random(b, sizeof b);
    CHECK(std::memcmp(a, b, sizeof a) != 0);
    unsigned zero = 0, hi_or = 0, lo_or = 0;
    for (int i = 0; i < 64; i += 2) { zero += !a[i] && !a[i + 1]; lo_or |= a[i]; hi_or |= a[i + 1]; }
    CHECK(zero < 4 && lo_or > 0x7f && hi_or > 0x7f);
  }

  // per-IP keys (server.test.js finding 5)
  CHECK(ip_key("2001:db8::1") == ip_key("2001:db8::ffff:ffff:ffff:ffff"));
  CHECK(!(ip_key("2001:db8::1") == ip_key("2001:db8:0:1::1")));
  CHECK(ip_key("::ffff:1.2.3.4") == ip_key("1.2.3.4"));
  CHECK(!(ip_key("1.2.3.4") == ip_key("1.2.3.5")));
  CHECK(ip_key("2001:db8:0:0:1::1", 48) == ip_key("2001:db8:0:ffff::9", 48));
}

static void test_limits() {
  PolicyConfig c;
  c.host_allow = {"*"};
  c.max_streams = 2;
  c.max_connects_per_minute = 3;
  c.scan_hosts_per_minute = 2;
  c.scan_failures_per_minute = 1;
  Policy p(c);
  CHECK(p.check_destination("a.example", 443) == DestCheck::Ok);
  CHECK(p.check_destination("a.example", 25) == DestCheck::BlockedPort);
  CHECK(p.check_destination("a.example", 0) == DestCheck::BlockedPort);
  CHECK(p.check_destination("a b", 443) == DestCheck::InvalidHost);
  {
    Session s(p);
    i64 t = 1000000;
    CHECK(!s.admit("a", 2, t));  // stream cap
    CHECK(s.admit("a", 0, t));
    CHECK(s.admit("A.", 0, t + 1));   // same host normalized: still 1 distinct
    CHECK(s.admit("b", 0, t + 2));
    CHECK(!s.admit("b", 0, t + 3));   // 3 connects this minute
    CHECK(s.admit("b", 0, t + 62000));  // a minute later
  }
  {
    Session s(p);
    i64 t = 5000000;
    CHECK(s.admit("a", 0, t));
    CHECK(s.admit("b", 0, t));
    CHECK(!s.admit("c", 0, t));      // 3 distinct > 2: throttled for 60 s
    CHECK(!s.admit("a", 0, t + 59000));
  }
  {
    Session s(p);
    i64 t = 9000000;
    s.record_failure(t);
    s.record_failure(t);
    CHECK(!s.admit("a", 0, t));  // 2 failures > 1
  }
  {
    MinuteCounter m;
    for (int i = 0; i < 10; i++) m.add(1000 * i);
    CHECK(m.count(9000) == 10);
    CHECK(m.count(60000) == 10);   // still within 60 s of the first
    CHECK(m.count(61500) == 9);    // the first second has gone
    CHECK(m.count(10000000) == 0);
  }
  {
    TokenBucket b(1000);
    CHECK(b.ready(0));
    b.take(1500, 0);
    CHECK(!b.ready(0));
    CHECK(b.wait_ms() == 500);
    CHECK(!b.ready(400));
    CHECK(b.ready(500));
    TokenBucket u(0);
    u.take(1 << 30, 0);
    CHECK(u.ready(0));
  }
}

static void test_http() {
  HttpRequest r;
  std::string ok =
      "GET /x/ HTTP/1.1\r\nHost: a\r\nUpgrade: WebSocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
      "Sec-WebSocket-Version: 13\r\nOrigin: https://app.example\r\nSec-WebSocket-Protocol: wisp-v2\r\nX-Forwarded-For: 1.1.1.1\r\n"
      "X-Forwarded-For: 2.2.2.2\r\n\r\nEXTRA";
  auto P = [&](const std::string& s) { return parse_request_head(reinterpret_cast<const u8*>(s.data()), s.size(), r); };
  CHECK(P(ok) == HttpParse::Ok);
  CHECK(r.method == "GET" && r.target == "/x/" && r.key == "dGhlIHNhbXBsZSBub25jZQ==" && r.version == "13");
  CHECK(has_token(r.connection, "upgrade") && ieq(r.upgrade, "websocket"));
  CHECK(r.origin == "https://app.example" && r.has_origin && r.protocol == "wisp-v2");
  CHECK(r.xff_count == 2 && r.xff_first == "1.1.1.1" && r.xff_last == "2.2.2.2");
  CHECK(r.head_len == ok.size() - 5);
  for (std::size_t cut = 0; cut + 5 < ok.size(); cut += 9) CHECK(P(ok.substr(0, cut)) == HttpParse::NeedMore);
  CHECK(P("GET / HTTP/1.1\r\n\r\n") == HttpParse::Ok);
  for (std::string bad : {std::string("GET / HTTP/1.1\r\nHost : a\r\n\r\n"), std::string("GET / HTTP/1.1\r\n folded\r\n\r\n"),
                          std::string("GET  / HTTP/1.1\r\n\r\n"), std::string("GET / HTTP/2\r\n\r\n"), std::string("GET / HTTP/1.1\r\nA\r\n\r\n"),
                          std::string("GET / HTTP/1.1\r\nA: b\nC: d\r\n\r\n"), std::string("GET / HTTP/1.1\r\nA: \x01\r\n\r\n"),
                          std::string("GET / HTTP/1.1\r\nA: b\r\r\n\r\n"), std::string("G(T / HTTP/1.1\r\n\r\n"),
                          std::string("GET / HTTP/1.1\r\nA: \0\r\n\r\n", 24)})
    CHECKM(P(bad) == HttpParse::Bad, bad);
  CHECK(P("GET / HTTP/1.1\r\nSec-WebSocket-Key: a\r\nSec-WebSocket-Key: b\r\n\r\n") == HttpParse::Ok && r.duplicate_singleton);
  CHECK(P("GET / HTTP/1.1\r\nOrigin:\r\nOrigin: x\r\n\r\n") == HttpParse::Ok && r.duplicate_singleton);
  CHECK(P("GET / HTTP/1.1\r\n" + std::string(9000, 'a')) == HttpParse::TooLarge);
  std::string many = "GET / HTTP/1.1\r\n";
  for (int i = 0; i < 65; i++) many += "A: b\r\n";
  CHECK(P(many + "\r\n") == HttpParse::Bad);
}

struct Collect : WsSink {
  std::vector<std::pair<u8, std::vector<u8>>> got;
  std::vector<u8> frag;
  bool refuse_frag = false;
  void on_message(u8 op, mbytes p) override { got.push_back({op, std::vector<u8>(p.begin(), p.end())}); }
  void on_control(u8 op, mbytes p) override { got.push_back({u8(op), std::vector<u8>(p.begin(), p.end())}); }
  mbytes frag_acquire(std::size_t max) override {
    if (refuse_frag) return {};
    frag.resize(max);
    return {frag.data(), max};
  }
  void frag_release() override {}
};

static std::vector<u8> masked(u8 op, std::vector<u8> payload, bool fin = true, std::array<u8, 4> key = {9, 8, 7, 6}) {
  std::vector<u8> f;
  f.push_back(u8((fin ? 0x80 : 0) | op));
  std::size_t n = payload.size();
  if (n < 126) f.push_back(u8(0x80 | n));
  else if (n < 65536) { f.push_back(0x80 | 126); f.push_back(u8(n >> 8)); f.push_back(u8(n)); }
  else { f.push_back(0x80 | 127); for (int i = 7; i >= 0; i--) f.push_back(u8(u64(n) >> (8 * i))); }
  for (u8 k : key) f.push_back(k);
  for (std::size_t i = 0; i < n; i++) f.push_back(payload[i] ^ key[i & 3]);
  return f;
}

static void test_ws() {
  {
    // byte-by-byte delivery, fragments with an interleaved ping, then a 300-byte and a 70000-byte frame
    std::vector<u8> all;
    for (auto& f : {masked(OP_BINARY, {1, 2, 3}, false), masked(OP_PING, {'h', 'i'}), masked(OP_CONT, {4, 5}, true),
                    masked(OP_BINARY, std::vector<u8>(300, 7)), masked(OP_BINARY, std::vector<u8>(70000, 9))})
      all.insert(all.end(), f.begin(), f.end());
    Collect c;
    WsReader r(1 << 17);
    std::vector<u8> buf;
    std::size_t start = 0;
    for (u8 b : all) {
      buf.push_back(b);
      start += r.parse(buf.data() + start, buf.size() - start, c);
      CHECK(r.error() == 0);
      CHECK(buf.size() - start < r.needed() || r.needed() == 2);
    }
    CHECK(c.got.size() == 4);
    CHECK(c.got[0].first == OP_PING && c.got[0].second == (std::vector<u8>{'h', 'i'}));
    CHECK(c.got[1].first == OP_BINARY && c.got[1].second == (std::vector<u8>{1, 2, 3, 4, 5}));
    CHECK(c.got[2].second.size() == 300);
    CHECK(c.got[3].second.size() == 70000 && c.got[3].second[69999] == 9);
  }
  auto err = [](std::vector<u8> bytes, std::size_t max = 1 << 17, bool refuse = false) {
    Collect c;
    c.refuse_frag = refuse;
    WsReader r(max);
    r.parse(bytes.data(), bytes.size(), c);
    return r.error();
  };
  CHECK(err({0x82, 0x05, 1, 2, 3, 4, 5}) == WS_PROTOCOL);  // unmasked
  {
    auto f = masked(OP_BINARY, {1});
    f[0] |= 0x40;  // RSV1
    CHECK(err(f) == WS_PROTOCOL);
  }
  CHECK(err(masked(3, {1})) == WS_PROTOCOL);            // reserved opcode
  CHECK(err(masked(0xB, {1})) == WS_PROTOCOL);
  CHECK(err(masked(OP_PING, {1}, false)) == WS_PROTOCOL);  // fragmented control
  CHECK(err(masked(OP_PING, std::vector<u8>(126, 1))) == WS_PROTOCOL);
  CHECK(err(masked(OP_CONT, {1})) == WS_PROTOCOL);       // continuation without start
  {
    auto a = masked(OP_BINARY, {1}, false), b = masked(OP_BINARY, {2});
    a.insert(a.end(), b.begin(), b.end());
    CHECK(err(a) == WS_PROTOCOL);  // new message inside a fragmented one
  }
  CHECK(err(masked(OP_BINARY, std::vector<u8>(1001, 0)), 1000) == WS_TOO_BIG);
  {
    auto a = masked(OP_BINARY, std::vector<u8>(600, 0), false), b = masked(OP_CONT, std::vector<u8>(600, 0));
    a.insert(a.end(), b.begin(), b.end());
    CHECK(err(a, 1000) == WS_TOO_BIG);  // message cap across fragments
  }
  CHECK(err(masked(OP_BINARY, {1}, false), 1000, true) == WS_POLICY);  // no reassembly buffer
  {
    // 64-bit length with the top bit set, and a huge length below it: refused on the header alone
    std::vector<u8> f{0x82, 0x80 | 127, 0x80, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4};
    CHECK(err(f) == WS_PROTOCOL);
    std::vector<u8> g{0x82, 0x80 | 127, 0, 0, 0, 1, 0, 0, 0, 0};
    CHECK(err(g) == WS_TOO_BIG);
  }
  CHECK(err(masked(OP_TEXT, {0xc3})) == WS_BAD_DATA);
  CHECK(err(masked(OP_TEXT, {'o', 'k'})) == 0);
  CHECK(err(masked(OP_CLOSE, {0x03})) == WS_PROTOCOL);        // 1-byte close
  CHECK(err(masked(OP_CLOSE, {0x03, 0xe8})) == 0);            // 1000
  CHECK(err(masked(OP_CLOSE, {0x03, 0xed})) == WS_PROTOCOL);  // 1005 may not be sent
  CHECK(err(masked(OP_CLOSE, {0x03, 0xe8, 0xff})) == WS_PROTOCOL);
  {
    u8 buf[10];
    CHECK(ws_header(buf, OP_BINARY, 125) == 2 && buf[0] == 0x82 && buf[1] == 125);
    CHECK(ws_header(buf, OP_BINARY, 126) == 4 && buf[1] == 126 && buf[2] == 0 && buf[3] == 126);
    CHECK(ws_header(buf, OP_BINARY, 65536) == 10 && buf[1] == 127 && buf[7] == 1 && buf[9] == 0);
    u8 frame[20];
    CHECK(ws_header_before(frame + 10, OP_PONG, 70000) == 10 && frame[0] == 0x8a);
  }
}

static void test_wisp() {
  std::vector<u8> m{1, 4, 3, 2, 1, 1, 0xbb, 0x01, 'a', '.', 'b'};
  Packet p;
  CHECK(parse_packet(mbytes(m), p) && p.type == 1 && p.id == 0x01020304 && p.payload.size() == 6);
  Connect c;
  CHECK(parse_connect(p.payload, c) && c.stream_type == 1 && c.port == 443 && c.host == "a.b");
  std::vector<u8> shorty{1, 0, 0, 0};
  CHECK(!parse_packet(mbytes(shorty), p));
  std::vector<u8> badutf{1, 80, 0, 0xc3};
  CHECK(!parse_connect(bytes(badutf), c));
  std::vector<u8> two{1, 80};
  CHECK(!parse_connect(bytes(two), c));
  std::vector<u8> info{2, 1, 2, 3, 0, 0, 0, 1, 65, 66, 5, 0, 0, 0, 0};
  Info i;
  CHECK(parse_info(bytes(info), i) && i.major == 2 && i.minor == 1 && i.count == 2);
  CHECK(i.find(2) && i.find(2)->data.size() == 3 && i.find(5) && i.find(5)->data.empty());
  CHECK(password_of(i.find(2)->data) == "B");
  std::vector<u8> s1{2};
  CHECK(!parse_info(bytes(s1), i));
  std::vector<u8> over{2, 1, 4, 99, 0, 0, 0, 1};
  CHECK(!parse_info(bytes(over), i));
  std::vector<u8> huge{2, 1, 4, 0xff, 0xff, 0xff, 0xff};
  CHECK(!parse_info(bytes(huge), i));
  std::vector<u8> pw{9, 'x'};
  CHECK(password_of(bytes(pw)).empty());
}

int main() {
  test_hashes();
  test_base64();
  test_simd();
  test_ip();
  test_limits();
  test_http();
  test_ws();
  test_wisp();
  std::printf("%d passed, %d failed\n", g_pass, g_fail);
  return g_fail ? 1 : 0;
}
