# wisp-cpp security audit (2026-10-23)

Target: `packages/wisp-cpp` at `wisp-cpp` c5615c5. Auditor's work is on branch `wisp-cpp-audit`
(reproducers only; the server code is unchanged).

## Scope

All of `src/`, `tests/`, `test/`, `fuzz/`, `tools/`, `DESIGN.md`, judged against Wisp v1.2 and v2
(MercuryWorkshop/wisp-protocol, `main` and `v2` branches), RFC 6455, DESIGN.md sections 3-5, and the
Node server (`packages/wisp/src/server.js`, `packages/relay-guard`).

## Method

- Read every source file line by line: the HTTP, WebSocket, Wisp, INFO, DNS and TLS-gather parsers and their
  length arithmetic, the pool/slab/graveyard lifetimes, the shared counters, the policy/SSRF code,
  the resolver and its cache, TLS loading/reload/SNI/ALPN, and the logging.
- Built and ran on macOS arm64 (kqueue, NEON): `make test` (unit + ASan/UBSan unit, 143640
  checks pass), `test-pool` normally and under ThreadSanitizer (passes), the ASan/UBSan server and the
  TSan server (`wisp-server-tsan`, 2 worker threads) against `test/server.test.js` +
  `test/invariants.test.js`: 50/50 pass, no sanitizer report.
- Fuzzing with the package's own coverage-guided driver (ASan+UBSan): fuzz_session 1800 s,
  fuzz_ws/http/wisp/ip/dns/tls 300 s each (F-0 and A-13 in the table).
- Adversarial reproducers added on this branch:
  - `test/audit.test.js` (node --test, ASan server; each test PASSES when the issue reproduces)
  - `tests/audit_tls_gather.cpp` (`c++ -std=c++23 -o build/audit_tls_gather tests/audit_tls_gather.cpp && build/audit_tls_gather`)

Run: `make build/wisp-server-test && node --test --test-concurrency=1 test/audit.test.js`
(needs `node_modules/@rvwasm/{wisp,relay-guard}` symlinks at the repo root, as in the main checkout).

## Findings

| ID | Severity | Where | Summary | Reproducer |
|----|----------|-------|---------|------------|
| A-1 | Medium | src/server.cpp:1404, src/config.cpp (max_handshakes) | Handshake cap is global with no per-address limit: one host holding 256 idle sockets locks every other client out | `AUDIT A-1` |
| A-2 | Medium | src/server.cpp:549, :859 | Write-stall drop only fires on zero progress: a trickle reader holds ~4 MiB of pool blocks indefinitely (T3 "at most 60 s" does not hold) | `AUDIT A-2` |
| A-3 | Low (Medium with `--max-kbps 0`) | src/server.cpp:1275, :1290 | Draining (client-closed) streams leave the byte caps: one session held 26 MiB against a 4 MiB connection cap | `AUDIT A-3` |
| A-4 | Medium | src/server.cpp:188-190, :647, :808, :817, :1171 | The small/bulk pools are sized by `--pool-mib`, not from max_connections, and nothing is reserved per session: about 128 sessions (16 addresses, or one IPv6 /60) within their caps empty the 1 GiB default pool. Other users' streams are then reset and their whole connections end, because the CLOSE reply itself cannot get a block | `AUDIT A-4` |
| A-5 | Low | src/tls.hpp:45, src/tls.cpp:142-166 | User-space TLS write retry can gather fewer bytes than the pending SSL_write (the tail block grows in between). OpenSSL then fails with BAD_LENGTH and the connection drops (reliability, not memory safety). Not run against OpenSSL here | `tests/audit_tls_gather.cpp` |
| A-6 | Low | src/tls.cpp, src/server.cpp:1404 | No per-address rate limit on TLS handshakes (CPU: one ECDHE + signature per accepted socket) | reasoning |
| A-7 | Low | src/main.cpp:54-63, src/tls.hpp:58 | Each SIGHUP leaks the previous TlsContext with its private keys (an old key stays in memory after rotation). A non-TLS build keeps SIGHUP at its default action, so a habitual `kill -HUP` terminates the relay | reasoning |
| A-8 | Low | src/server.cpp:1394, src/main.cpp:20-28 | Descriptors are not budgeted: 512 conns x (64 streams + 64 draining) is more than RLIMIT_NOFILE (65536 Linux / 10240 macOS), and each address may hold ~1024 site fds. On EMFILE the listener stops until the next connection arrives (no retry timer) | reasoning |
| A-9 | Info | DESIGN.md sections 1, 3, R5, T3 | The doc says "No TLS" / TLS out of scope while `src/tls.cpp` exists. R5 ("pools are sized from max_connections") and T3 ("at most 60 s") are not true (A-2, A-4) | n/a |
| A-10 | Info | src/ip.cpp:159-167 | Blocks 2001::/32 but not the rest of IANA 2001::/23 special space (2001:2::/48, 2001:10::/28, 2001:20::/28); local NAT64 network-specific prefixes need `--block` (document it) | unit-level |
| A-11 | Info | src/dns.cpp:17-26 | Query ids come from a per-thread mt19937 (its output can be predicted after it is observed). The random source port and the connected socket protect it; arc4random/getrandom costs little | n/a |
| A-12 | Info | src/pool.cpp:137-150 | A double release is detected only if it later overflows the ring; a debug-build bitmap of the blocks in use would catch it at once | n/a |
| A-13 | Info | src/ip.cpp:187-246, fuzz/fuzz_ip.cpp:36 | fuzz_ip property abort: `host_allowed` trims whitespace before stripping `[`, so `"\t[\t127.0.0.1\t"` normalizes to a non-literal ending in `.0.0.1` and matches `*.0.0.1`. The config-side `normalize_host` (>= 256 chars) strips them in another order. Not reachable from CONNECT, because `valid_host` refuses whitespace first | `fuzz/audit-crashes/fuzz_ip-wildcard-literal.bin` |
| F-0 | Info | fuzz/ | session 1800 s (174k runs), ws/http/wisp/dns/tls 300 s each: no crash, leak or invariant abort; ip: one property abort (A-13) | build/fuzzlogs |

No critical or high findings. No memory-safety defect was found by reading, by the sanitizers or by fuzzing.

## Details

### A-1 Handshake slots are not per address (Medium)
`Listener::on_io` takes a global `handshakes` ticket per accepted socket; the per-address table is
only consulted after a valid upgrade (`handle_head`, server.cpp:766). One client opening
`max_handshakes` (256) sockets and sending nothing gets every new socket from everyone else closed at
accept for up to `handshake_timeout_ms` (10 s), renewable forever. That is a complete denial of service
from a single address. With TLS each slot also costs a handshake.
Reproducer: `AUDIT A-1` (16 slots, idle sockets from one address, a legitimate upgrade refused).
Fix: a per-address handshake counter (same keyed PerIpTable, e.g. 8-16 per address, IPv6 per /64),
taken at accept, released at upgrade/close; optionally a shorter deadline for the first byte.

### A-2 Write-stall timeout is defeated by trickle reading (Medium)
`on_reap` drops a client only if `now - last_write_ > write_stall_timeout_ms`, and `flush()` sets
`last_write_` on any successful write. A client that drains a few KiB every few hundred ms keeps
`ws_write_high` (4 MiB) of small/bulk blocks plus one site read per stream, indefinitely (the test holds
it 4x past a 3 s stall timeout). Combined with A-4 this is a cheap pool-exhaustion vector.
Fix: require a minimum drain rate while `out_.bytes` is above the high-water mark (e.g. it must fall
below `ws_write_high/2` within N seconds), or cap the total time spent above the high-water mark.

### A-3 Draining streams escape the byte caps (Low; Medium if `--max-kbps 0`)
`close_stream` subtracts `s->queued` from `pending_` before deciding to drain (server.cpp:1275), and the
draining stream's `tx` (up to `max_stream_buffer` + one message) is no longer counted anywhere. A client
fills a stream to just under the caps towards a site that does not read, sends CLOSE 0x02, and repeats:
up to `max_streams` (64) draining x 4 MiB per connection for 1 s each. The test held 26 MiB in one
session against a 4 MiB connection cap. The default 8 MiB/s bandwidth bucket limits it to about
8-16 MiB per connection per second. With `--max-kbps 0` only the client's link limits it.
Fix: keep draining bytes in `pending_` (and keep the cap/backpressure) until they flush, or drain only
when `tx.bytes` is small (e.g. <= 64 KiB), or cap draining bytes per connection.

### A-4 Shared pool exhaustion crosses tenants (Medium)
The small pool holds `pool_mib` / 36 KiB blocks (default 1 GiB, about 29k blocks) and bulk a quarter of that again.
Each session may legitimately hold `max_connection_buffer` (8 MiB) client->site plus `ws_write_high` (4 MiB,
held indefinitely by A-2) site->client, with `max_connections` 512: a 6 GiB demand on a 1.25 GiB supply.
Once the pool is empty, any other session's `accept_data` resets the stream (`relay out of buffers`). Its
`send_close`/`send_ws` then cannot append, so `doomed_` ends the victim's whole connection.
`AUDIT A-4` shows this with `--pool-mib 16`: one session parks 8 MiB and every later session is killed.
At the defaults the same takes about 128 sessions, i.e. 16 addresses at 8 per address, or one IPv6 /60.
Fix: (a) size small+bulk from `max_connections x (max_connection_buffer + ws_write_high)` or lower those
caps to fit the pool; (b) per-address byte budgets in the shared table; (c) keep a small reserve of
blocks for control frames (CLOSE/PONG/CONTINUE) so a victim's protocol replies never fail.

### A-5 TLS write retry with a shorter buffer (Low)
`TlsConn::writev` re-gathers `out_` after `WANT_WRITE`. `ByteQueue::append` grows the tail block in
place, so on retry a block that fitted in the 16 KiB stage may no longer fit, and `tls_gather` returns
fewer bytes than the pending `SSL_write_ex`. OpenSSL requires the retry length to be at least the
pending length (`SSL_R_BAD_LENGTH`), so the write fails with EIO and the connection ends. kTLS TX
(Linux) bypasses this path. `tests/audit_tls_gather.cpp` shows the shrink (16100 -> 100 bytes).
Fix: remember the pending (pointer, length) after WANT_WRITE and retry exactly that, or stop
appending to a block that is part of an in-flight write.

### A-13 Host normalization order (Info)
`check_destination` runs `valid_host` (no whitespace, <= 253 chars) before `host_allowed`, so no
CONNECT can reach this. Even so, `host_allowed` should not depend on its caller. Fix: make
`normalize_host_into` and `normalize_host` one implementation, and have `host_allowed` refuse (return
false) any host that `valid_host` refuses. Restrict the fuzz property to valid hosts, or keep it and fix
the normalizer.

### A-6 .. A-12
See the table; each line gives the place and the suggested fix.

## Checked and found sound

- HTTP head: bounded (8 KiB, 64 headers), CR/LF/NUL/obs-text/obs-fold refused, duplicate singleton
  headers refused, subprotocol echo cannot inject headers (visible ASCII only, 200 chars).
- WebSocket: mask required, RSV refused, 64-bit length top bit, `len <= max_` before any addition,
  control frames <= 125 and FIN, continuation rules, close code and UTF-8 checks, reassembly bounded by
  `max_ - frag_len_`, single reassembly block, `needed() <= max_message + 14 < rx cap`. There is no
  permessage-deflate, so there are no compression bombs.
- SIMD unmasking: unaligned loads/stores with exact bounds, scalar tail; phase rotation correct; the
  unit tests compare it with the scalar version at every length, alignment and phase.
- Wisp: header length checked, INFO extension lengths without wrap, the password extension layout
  matches the v2 spec (u8 username length, username, password = rest) and the Node server, and the
  password is compared as SHA-256 digests with `ct_equal`. v1 is refused when a token is set, and v2
  requires INFO major 2 before any CONNECT. Key auth is not offered, so a key-only client is refused.
  CONTINUE credit is tracked per packet in a bounded ring, and a client that ignores it is no longer
  read (backpressure); it cannot overflow the counter.
- SSRF: literal IPv4 is strict dotted-quad (no octal/hex/short forms), so names like `0x7f.1` or
  `2130706433` go to DNS as names and their answers are checked. IPv4-mapped addresses are checked as
  IPv4, and IPv4-compatible (::/96), NAT64 (64:ff9b::/96, /48), 6to4, Teredo, ULA (incl. fd00:ec2::254),
  link-local (incl. 169.254.169.254), multicast, 0.0.0.0/8, CGNAT and this machine's interface addresses
  are blocked. Zone ids, NUL and non-ASCII are refused; trailing dots and brackets are normalized before
  the allowlist; a wildcard never matches a literal. The name is resolved once per CONNECT, every answer
  is filtered and the stream connects only to the kept addresses (no TOCTOU). Cached answers are
  re-checked on each use, the cache TTL is capped at 300 s, and TTL 0 answers are not cached. UDP streams are refused.
- Shared counters: CAS "increment if below" (cannot exceed under races); tickets released once.
  The pool's MPMC ring and per-thread caches are TSan-clean in the stress test. Connections and
  their buffers never leave their worker thread. The graveyard defers deletes past pending events.
- TLS config: TLS >= 1.2, AEAD-only suites, no renegotiation/compression/tickets/cache, ALPN http/1.1
  or none, SNI by X509_check_host with fallback to the first certificate; a failed reload keeps the
  old set.
- Logging: metadata only; client strings escaped and truncated (`log_text`); no payloads or tokens.

## Not covered (and why) - to run later on Linux

Status 2026-10-24 (after the fixes): every item of the original list below has now been run.

- Done on Linux: epoll and io_uring, SO_REUSEPORT listeners, the gcc `-D_GLIBCXX_ASSERTIONS` build, TSan on the
  full server with 4 threads, the TLS suites against OpenSSL 3.0 (OrbStack Debian/Ubuntu, 2026-10-23), and
  x86-64 AVX2 unmasking under Rosetta.
- libFuzzer (clang 20, Ubuntu 24.04 arm64 VM, `make CXX=clang++-20 FUZZ_ENGINE=libfuzzer BUILD=build-lf fuzz`):
  all seven targets 310 s each with corpus + seeds, ASan + UBSan. `fuzz_tls` stopped on its first input: the
  harness called `memcmp(nullptr, nullptr, 0)` on the empty input (UBSan nonnull; harness only, fixed in
  2508e7d, empty input kept in `fuzz/seeds/tls` and `fuzz/audit-crashes`); rerun 310 s clean. Others clean:
  wisp 171.9M runs, dns 98.6M, ip 76.0M, http 74.3M, ws 1.78M, tls 27.5k, session 29.1k (the last two run
  ~90 exec/s, so their 5 minutes are shallow; give them the 45 min of `tools/fuzz-all.sh` before a release).
  `fuzz/audit-crashes/fuzz_ip-wildcard-literal.bin` replays clean.
- kTLS on a real kernel (a 2-vCPU x86-64 cloud VM, Linux 7.0.0-1013-oracle, OpenSSL 3.0.13, `tls` module already
  loaded, `tcp_available_ulp` = `espintcp mptcp tls`; no modprobe needed): `test/tls.test.js` +
  `test/server.test.js` over wss 38 pass / 0 fail / 9 skipped (plain-socket cases); the kTLS case asserted
  TX offload; `/proc/net/tls_stat` TlsTxSw 0 -> 65, TlsRxSw 0 -> 1, TlsCurrTxSw 1 sampled during the run;
  the A-5 transfer (1.21 GB) went through kTLS TX. Direct check: TLS 1.2 handshake logs
  `kernel offload tx=1 rx=1`, TLS 1.3 logs `tx=1 rx=0` - OpenSSL 3.0 has no TLS 1.3 kTLS RX (3.2+ does), so
  TLS 1.3 receive stays in userspace. The A-5 userspace retry path itself was proven on OrbStack (no kTLS).
- TSan on a real x86-64 host (a 2-vCPU x86-64 cloud VM, gcc 13, `setarch -R` because TSan rejects the kernel's ASLR
  layout, 4 server threads, loopback only): test-tsan ok; server 40/40, invariants 10/10, audit 10/10,
  tls+server over wss 38/0/9 skipped; zero TSan reports. Load average stayed <= 0.6 and the live site
  answered in 0.46-0.84 s throughout.
- Still not covered: internet DNS (resolver tested only against the in-test fake name server);
  `bench_linux.py` on the real host (skipped to spare the live site); kTLS RX for TLS 1.3 (needs OpenSSL >= 3.2).

## Verdict

**Ship after fixes.** The parsers and the memory model hold up: no memory-safety issue, SSRF
protections are thorough and the auth/version rules are right. Before facing the internet fix A-1
(per-address handshake cap), A-2 (minimum drain rate) and A-4 (pool sizing / per-address budgets /
control-frame reserve), and fold A-3 into the caps. Fix A-5 before using native wss:// without kTLS. Correct the
DESIGN.md claims (A-9).
