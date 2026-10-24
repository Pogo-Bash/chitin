# wisp-cpp: design, memory model, threat model

A Wisp v1/v2 relay in C++23 with the security rules of `@rvwasm/relay-guard` and `@rvwasm/wisp`
(the Node server). No dependencies beyond the OS, the C++ standard library and the compiler, except
the optional native `wss://` (`make TLS=1`, `--tls-cert/--tls-key`): the system OpenSSL 3 does the
handshake and, on Linux, hands the records to the kernel (kTLS: TX always, RX for TLS 1.2 with OpenSSL 3.0, also TLS 1.3 from 3.2); without kTLS records are encrypted in
user space (`src/tls.*`). Without it, `wss://` is terminated by a reverse proxy in front, as with the
Node server.

This document is written for the security audit. Every rule in "Invariants" names the code that
enforces it and the test or fuzz property that checks it. If code and this document disagree, the
code is wrong.

## 1. Architecture

```
            accept (SO_REUSEPORT on Linux: one listener per worker; elsewhere one shared listener)
              |
   +----------+-----------+  ... one worker thread per core (--threads N), shared nothing except:
   | Worker: Loop (kqueue | epoll | io_uring), Resolver (UDP stub), Conn objects, Stream objects |
   +----------------------+
              |                         shared, lock-free:
              |                           BufferPool small (36 KiB blocks), bulk (128 KiB), large (rx/reassembly)
              |                           SharedCounter conns/handshakes/site_fds, PerIpTable (conns, handshakes,
              |                           site fds per address), PerIpRate (new connections per address per second)
```

- `src/loop.*` - one event loop per worker: edge-triggered readiness (kqueue `EV_CLEAR`, epoll
  `EPOLLET`, or io_uring multishot `POLL_ADD` with raw syscalls, `IO_URING=1` + `--io-uring`), a
  hashed timer wheel (8 ms ticks, 4096 slots), a run queue for handlers that stopped before
  `EAGAIN`, end-of-iteration hooks (write coalescing) and a graveyard (deferred destruction).
- `src/server.cpp` - `Conn` (one client TCP connection: HTTP upgrade, WebSocket, Wisp session) and
  `Stream` (one Wisp stream and its site socket). A connection and all its streams live on one
  worker for their whole life.
- `src/http.*`, `src/ws.*`, `src/wisp.*`, `src/dnsmsg.*` - pure parsers (no I/O, no allocation),
  each fuzzed on its own.
- `src/ip.*`, `src/policy.*` - the relay-guard rules (IP parsing, block list, host allowlist,
  per-session limits, token bucket).
- `src/dns.*` - non-blocking stub resolver on the worker loop (A + AAAA over UDP, one socket per
  lookup, random ids, answers checked against the question and the server address).
- `src/pool.*`, `src/limits.*` - the only state shared between threads.
- `src/simd.*` - unmasking (NEON / AVX2 / SSE2 / scalar, AVX2 chosen at run time) and UTF-8
  validation (vector ASCII fast path + scalar decoder).

### Data path

Client to site: the client socket is read into the connection's receive block (large pool). Frames
are unmasked in place (SIMD). A DATA packet's payload is written to the site socket straight from
that block (zero copy). Only what the site does not take at once is copied into the stream's
transmit queue (small-pool blocks) and flushed with `writev` when the site is writable.

Site to client: the site socket is read into a pool block 16 bytes in (a small block; a 128 KiB
bulk block once a read filled its block, until a read comes back under half full); the Wisp header (5
bytes) and the WebSocket header (2-10 bytes) are written in front of the data in place, and the
block itself is queued on the connection (zero-copy framing). All frames queued during one loop
iteration go out in one `writev` per connection (end-of-iteration flush).

Why bulk reads (2026-10-23): with wispmark's wisp-js client the client process is the bottleneck
(`top` in the container: node 100 %, wisp-cpp 1 thread 0.7 cores), and wisp-js pays per WebSocket
message. 32 KiB DATA packets meant 4x the messages epoxy sends (it reads sites with a 128 KiB
`BufReader`). With 128 KiB reads, quiet host (load 3-4), median of 2 x 8 s, MiB/s: wisp-js (10)
3712 -> 4358, wisp-js (5x10) 5114 -> 5645; wisp-mux unchanged within noise. The earlier "trails
epoxy with wisp-js" (0.45-0.82x) was host load: its cells ran at load 20+, epoxy's at 6-13.
macOS (kqueue, wisp-bench echo, load 5-7, 3 x 8 s): 32 KiB 1543-1599 MiB/s, 128 KiB 1623-1663
(+4 %); node at 8.2-8.4 CPU-s of 8.5 s either way. Node `--cpu-prof` of the client: 61 % in
`ws` `Sender.frame` + 11 % `writeBuffer` (masking/copying its own 50 KiB uploads), ~10 % in
receive and Wisp parsing. The client's upload framing is the limit; no server change removes it.
`--site-read N` sets the packet size (1024-131072) for such comparisons.

Profile (macOS `sample`, 1 WebSocket x 10 streams, 16 KiB packets, one worker): of the worker
thread's samples `write` 48 %, `read` 27 %, `writev` 19 %, `unmask` 3.4 %, `kevent` 2.7 %,
everything else under 1 %. The kernel's copy of the bytes dominates; see README for the numbers.

## 2. Memory model

- **Pools.** Three fixed-size block pools reserved with `mmap` (`MAP_NORESERVE`) at start-up: small
  (36 KiB: queues, site reads, control frames), bulk (128 KiB site reads of busy streams; a quarter of
  the small pool again, at least 16 blocks; when it is empty a small block is used) and large
  (`max_message` + 128 bytes: one receive buffer and at most one reassembly buffer per connection;
  `2 x (max_connections + max_handshakes) + 64` blocks). The free list is a bounded lock-free MPMC
  ring of indices (sequence-numbered cells) with a 32-entry per-thread cache. Pages are touched only
  when used, so RSS follows the working set. A bitmap of the blocks handed out catches a double
  release at once: test/fuzz/sanitizer builds abort, release builds log it, count it and ignore the
  second release, so a block never gets two owners (AUDIT A-12).
- **Pool sizing and shares (AUDIT A-4).** `plan_pools` gives every connection a share of the small
  pool: `tx` (client->site transmit queues, draining streams included; `max_connection_buffer` +
  64 KiB), `out` (the reply queue; `ws_write_high`) and `ctl` (1 MiB of protocol-reply headroom), plus
  a fixed overshoot of 2 x `max_message` + 2 bulk + 4 small blocks. Queues are charged in block bytes
  (a 1-byte site read holds a whole 36 KiB block). With `--pool-mib 0` (default) the small pool is
  `max_connections` shares plus a reserve of one block per connection and handshake (+64): about 7 GiB
  of address space at the defaults, touched only as used. An explicit `--pool-mib` that is smaller
  scales `tx`, `out` and `ctl` down to fit (logged), and the relay refuses to start if a share would be
  under the fixed overshoot + 256 KiB. Protocol replies (HTTP status, CLOSE, PONG, CONTINUE, INFO) may
  take blocks from the reserve; data may not.
- **No allocation on the data path.** Reading, unmasking, forwarding, framing, queueing and
  flushing use pool blocks only. When a pool is empty, reads wait (10 ms retry timer: backpressure)
  and a stream that needs a queue block it cannot get is reset (`0x03`) and logged; nothing falls
  back to `malloc`. `--malloc-buffers` replaces the pools with malloc (benchmark stage a), still
  bounded by the same block counts.
- **Per-connection and per-stream objects** come from per-thread slab free lists (`Slab<T>`,
  grown in chunks of 32, never returned to the OS). A connection also allocates, once, its stream
  map (2 x `max_streams` slots) and its scan-detector table (`scan_hosts_per_minute + 1` entries);
  a stream allocates, once, its credit ring (2 x `buffer_packets` + 2 entries). CONNECT handling
  (host normalization, policy checks) uses stack buffers.
- **Idle connections hold no buffers**: the receive block is returned whenever it holds no
  unparsed bytes; the reply queue is empty when everything was written.
- **Lifetime.** A `Handle` (connection, stream, lookup, listener) is never deleted while an event
  for it may be pending: owners call `Loop::retire()`, the object is deleted after the current
  batch (and, on io_uring, only after its poll's final completion).

## 3. Threat model

Same as `SECURITY-REVIEW.md`: the relay is reachable by attackers who control every byte a client
sends (any Origin, any headers, any timing), DNS answers for their own names, and the servers they
ask the relay to reach (within the host allowlist). The relay must not:

1. connect anywhere the policy forbids (SSRF: loopback, private, link-local/metadata, CGNAT,
   multicast, reserved, documentation, NAT64/6to4/Teredo, own interface addresses, operator CIDRs,
   unlisted ports, unlisted hosts);
2. be used to exceed the operator's limits (connections overall and per address, streams per
   session, connects per minute, scan-like behaviour, bandwidth);
3. let one client exhaust memory, descriptors, pool blocks, name-server capacity or CPU for others;
4. accept unauthenticated sessions when a token is configured (including by downgrading to v1);
5. corrupt memory or crash on any input (parsers fuzzed with ASan/UBSan);
6. log payload bytes, tokens, or client strings unescaped.

Out of scope: attacks on OpenSSL itself (native `wss://` relies on the system libssl), the Wisp key-authentication extension (not implemented: a
client offering only key auth is refused like a missing password), UDP streams (refused `0x41`),
attacks on the reverse proxy, kernel bugs. The Origin check is a browser safeguard, not access
control (as in the Node server).

## 4. Invariants

### Destination (SSRF, TOCTOU)
- **D1 check-then-connect is atomic with respect to DNS.** A name is resolved once per CONNECT;
  every returned address is checked (`Policy::address_ok` -> `blocked_address`, IPv4-mapped IPv6
  checked as IPv4); the stream then connects only to the addresses kept, in RFC 8305 order, and
  never resolves the name again (`Conn::stream_resolved`, `Conn::stream_connect`). Tests:
  `rebinding: ...` (2 cases, real resolver against a fake name server that changes its answer).
- **D2** the port and host allowlists are checked before any lookup (`Conn::open_stream`,
  `Policy::check_destination`). Test: `allowlist: ... before resolution` (lookups == 0).
- **D3** a literal IP never matches a name wildcard; literals skip DNS but not the block list.
  Tests: unit `host_allowed`, fuzz property in `fuzz_ip`.
- **D4** zone ids, whitespace, `@#/:\`, non-ASCII, > 253 chars are refused before the allowlist
  (`valid_host`), and `host_allowed` refuses them itself whoever calls it. Hosts (CONNECT and
  configuration, any length) are normalized by one routine in one order: whitespace, `[`/`]` and
  trailing dots are stripped repeatedly until none is left, then ASCII is lowercased; idempotent for
  every input (fuzz_ip, AUDIT A-13). Unit tests ported from relay-guard.
- **D5** the resolver accepts an answer only from the configured server's address (connected UDP
  socket, checked again on receive), only with the query's random id (OS CSPRNG: `arc4random_buf` /
  `getrandom`, AUDIT A-11), and only when the question
  section matches name, type and class (`dns_parse_response` returns Mismatch otherwise). Fuzz:
  `fuzz_dns`. Off-path spoofing needs the 16-bit id and the kernel-chosen source port.

### Shared limits under concurrency
- **L1** `SharedCounter::try_acquire` and `PerIpTable::try_acquire` are compare-and-swap loops
  "increment only if below the limit": a counter never exceeds its limit under any interleaving.
  Test: `tests/test_pool.cpp` (`counter_stress`, `per_ip_stress` track the tickets actually held
  with an independent atomic and fail if it ever exceeds the limit), run under ThreadSanitizer. Cross-core: `L1: 120 simultaneous upgrades ...` (test/invariants.test.js, 4 threads, 3 rounds, global cap and per-address cap: exactly the cap admitted, every ticket released).
- **L2** every ticket is released exactly once (a 429 gives its global slot back at once, not after its
  1 s close; found by the L1 test on Linux): the connection holds flags `t_handshake_`,
  `t_conn_`, `t_ip_`, cleared when released (`Conn::handle_head`, `Conn::end`). Fuzz:
  `fuzz_session` aborts if any counter is non-zero after a session.
- **L3** the per-IP table stores no keys: a keyed hash (random per process) picks one of 65536
  counters. Collisions only merge two addresses' limits (stricter, never looser); a client cannot
  insert, delete or fill anything. IPv6 is keyed per /64 (`--ipv6-prefix`), IPv4-mapped as IPv4.
- **L4** per-session limits (stream cap, connects per minute, distinct hosts, failures, lookups in
  flight) are per connection and so per thread: no sharing, no races.

### Timing
- **T1** a connection that has not finished the TLS + HTTP upgrade is dropped after
  `handshake_timeout_ms` (10 s) and counts against `max_handshakes` (256 overall) and
  `max_handshakes_per_ip` (16 per address / IPv6 /64, taken at accept; trusted proxies exempt), so
  slowloris holds at most that many sockets for at most that long, and one address at most 16 of them
  (AUDIT A-1). New connections per address are limited to `--handshake-rate` per second (default 32
  with TLS, where each costs an ECDHE + a signature; off for plain ws://; AUDIT A-6). Wisp INFO has the same 10 s limit. Test: `T1: slowloris ...` (20 sockets dribbling a head one byte per 20 ms against a cap of 8).
- **T2** streams idle for `idle_timeout` are closed `0x47`; a session with no streams is closed after
  `idle_timeout` (PINGs do not count). Test: `finding 5: a connection with no streams is closed`.
- **T3** a client whose queued replies make no progress for `write_stall_timeout_ms` (60 s) is
  dropped; so is one whose reply queue, once over `out` (`ws_write_high`, 4 MiB), does not drain to
  half of it within `write_stall_timeout_ms` (a minimum drain rate of 2 MiB per 60 s: AUDIT A-2), and
  one whose queue passes its share (`out + ctl + max_message` + 2 bulk + 2 small blocks) or
  `max_write_buffer` (16 MiB) at once. So a slow reader holds at most about 5.4 MiB of blocks, for at
  most `write_stall_timeout_ms` + `reap_interval_ms` (75 s by default) after it fills its queue.
  Tests: `AUDIT A-2` (a 320 KB/s reader is dropped and its blocks come back). Test: `finding 6`. `--write-stall-ms` sets the stall timeout. Test: `T3/R3: a client that stops reading ...` (a site that floods, a client that stops reading: the site is paused, reply blocks bounded, the client dropped, every block back).
- **T4** connect attempts are bounded by `attempt_timeout` each and `connect_timeout` overall; name
  lookups by `dns_timeout_ms` (3 s); lookups never block a thread.

### Resource exhaustion
- **R1** bytes accepted from a client and not yet flushed to the site are capped per stream
  (`max_stream_buffer`, 4 MiB) and per connection (`max_connection_buffer`, 8 MiB), plus one
  message. The credit is in packets and the caps in bytes, so a client within its credit can reach a
  cap (128 packets of 50 KiB > 4 MiB; wisp-mux's benchmark client does). Such a client is not reset:
  the packet is taken and the client socket is not read again (TCP backpressure, `paused_caps_`)
  until the bytes are below half the caps; the parser stops after that message. A site that never
  reads ends the stream by the idle timeout. Credit is enforced the same way (R2). Until
  2026-10-23 the stream was reset `0x03` at the cap, which reset conforming wisp-mux clients in
  wispmark (and differs from the Node server, which still resets). `pending_` is the sum of the
  live streams' `queued` (fuzz: `Conn::check_invariants`, caps + one message). Tests: `finding 1` (4 cases).
- **R2** credit (CONTINUE) is returned only for packets whose bytes the site socket has taken
  (`Conn::stream_flushed`, per-packet ring). A client that sends more than 2 x `buffer_packets`
  unacknowledged packets is no longer read (TCP backpressure on its whole WebSocket, like R1) until
  the stream is back under `buffer_packets`. It is not reset: CONTINUE is absolute and several can
  be on the wire, so a client that obeys each one can still pass 2 x the window (wisp-bench did at
  ~1 GB/s; until 2026-10-23 that reset conforming streams). A client that ignores CONTINUE only
  stalls its own session; a stream whose site never reads ends by the idle timeout.
  `ring_count == inflight <= 2 x buffer_packets` (fuzz-checked). Test: `R2: a client that ignores CONTINUE ...`.
- **R3** reading a site pauses while the connection has more than 4 MiB queued to the client and
  resumes below 2 MiB. Test: `T3/R3`.
- **R4** fragmented messages: at most one reassembly block per connection (`frag_`), at most
  `max_message` (128 KiB) per message, checked before copying (`WsReader::frame`). A frame longer than
  `max_message` is refused on its header, before any payload is buffered. Fuzz: `fuzz_ws` (one
  buffer, released by reset), unit tests. Tests: `R4: fragment growth ...` (continuations past the limit -> 1009; 20000 one-byte fragments reassembled).
- **R5** pool starvation: one session can hold at most its receive + reassembly blocks (large pool)
  and its share of small/bulk blocks (memory model above); the small pool holds `max_connections`
  shares + a reply reserve, so no session or address can take another's blocks (AUDIT A-4; test
  `AUDIT A-4`: six sessions parking 10 MiB each in a 16 MiB pool are throttled and a seventh relays
  untouched). Over its `tx` budget a session is no longer read; over `out` its sites are not read;
  over `out + ctl` the client is not read either (a PING flood without reading). Exhaustion degrades to backpressure or a stream reset, never to malloc or a
  crash. Fuzz: `fuzz_session` aborts if any block is still in use after a session (leak check). Test: `R5: pool starvation ...` (automatic pool, 160 sessions each parking a half-received message: a new session still relays, no block leaked, no crash).
- **R6** at most `max_streams` streams per session plus at most `max_streams` draining (a client's
  voluntary close lets queued data reach the site for up to 1 s); a draining stream's bytes stay in
  `pending_` and its blocks in `tx_held_` until they flush, so they count against the caps (AUDIT
  A-3, test `AUDIT A-3`); every site socket is closed when its connection ends (`Conn::end`).
- **R9** descriptors (AUDIT A-8): at start `plan_fds` budgets RLIMIT_NOFILE as a base (32 + 4 per
  thread) + one per handshake and connection + the resolvers' sockets (`dns_max_inflight` per worker,
  lowered to fit) + site sockets; it refuses to start if not even one site socket per connection fits.
  Site sockets take a ticket from a shared counter (when every session's maximum does not fit) and a
  per-address one (at most an eighth of the budget); without one the stream gets `0x49`. After EMFILE
  the listener retries on a 100 ms timer (on Linux the waiting connections stay in the backlog and
  readiness does not fire again for them; XNU drops them). Tests: `AUDIT A-8` (3 cases). Test: `finding 2` (close-then-reuse of ids cannot orphan
  sockets: a stream is only unregistered if the id still maps to it, `Conn::forget`).
- **R7** name lookups: at most `max_concurrent_lookups` per session, at most `dns_max_inflight`
  (1024) per worker; over that, `0x49`. Test: `finding 3`.
- **R8** bandwidth (`max_kbps`, both directions per WebSocket) is enforced by not reading: the
  client socket stops being read while the bucket is in debt, and so do the sites. Nothing is
  buffered because of the limit.

### Protocol state machine
States: `Http -> (Info | Ready) -> Closing -> ended`, v1 goes `Http -> Ready`.
- **P1** in `Http`, only a complete request head (<= 8 KiB, <= 64 headers, CRLF only, no NUL or
  bytes >= 0x7f, no obs-fold, no duplicate singleton headers) is acted on. A request with an
  Upgrade header must be `GET`, `Upgrade: websocket`, `Connection: upgrade`, version 13 (else 426)
  and a key that is base64 of 16 bytes; then Origin, then v1-with-token (400), then the global
  (503) and per-address (429) caps. Any other request gets `/healthz` or 404 and is closed.
- **P2** in `Info`, the only accepted message is a binary INFO on stream 0 with major version 2;
  anything else gets CLOSE `0x04` and `Closing`. With a token: no password extension -> `0xc2`,
  wrong password -> `0xc0` (SHA-256 digests compared in constant time). Text and pong frames are
  ignored, ping is answered, close closes. Test: `P2: before INFO ...`.
- **P3** in `Ready`: CONNECT (id 0 or in use -> `0x41`, UDP -> `0x41`, bad host -> `0x41`, port or
  host not allowed -> `0x48`, limits -> `0x49`, blocked address -> `0x48`, no address -> `0x42`,
  timeout `0x43`, refused `0x44`); DATA for unknown ids is ignored; CLOSE closes the stream (data
  already queued still reaches the site, bounded by R6); CONTINUE and INFO from the client are
  ignored; packets shorter than 5 bytes are ignored. Test: `P3: in Ready ...`.
- **P4** in `Closing` the input is read and discarded until the peer closes or 1 s passes; output is
  flushed, then the write side is shut down (so the last frame is not lost to a reset).
- **P5** WebSocket rules (RFC 6455): client frames must be masked; RSV bits, unknown opcodes,
  fragmented or > 125-byte control frames, a continuation without a start, a new data frame inside
  a fragmented message, a 64-bit length with the top bit set, invalid UTF-8 in text messages or
  close reasons, and invalid close codes all close the connection with 1002/1007/1009 sent first. Test: `P5: unmasked frames ...` (7 cases + invalid UTF-8 -> 1007).
- Fuzz: `fuzz_session` drives the real `Conn` through every state with every packet type
  (structured ops: raw bytes, arbitrary frames, CONNECT/DATA/CLOSE/INFO/unknown packets, fragments,
  control frames, pauses, stopped reading) and checks the invariants after every step.

### Integer arithmetic on lengths
- **I1** WebSocket lengths: the 64-bit length is rejected if its top bit is set and compared with
  `max_message` before it is converted or added (`WsReader::parse`); `at + 4 + len` is computed only
  after `len <= max_message`. Test: `I1: a 64-bit length ...` (top bit -> 1002; 2^63-1, 2^32+5, 2^32-1 -> 1009 on the header alone).
- **I2** reassembly: `payload.size() > max_ - frag_len_` (no addition that could wrap).
- **I3** INFO extensions: `n > p.size() - i` with `i <= p.size()` (no wrap) (`parse_info`).
- **I4** DNS: every offset is checked against the message size before it is read; compression
  pointers must point backwards and at most 16 are followed (`read_name`).
- **I6** TLS (user space): an `SSL_write` that returned WANT_* is retried with exactly the same bytes
  and length (`TlsConn::pending`, `tls_next_piece`), although the reply queue's tail may grow in
  between (AUDIT A-5; `tests/audit_tls_gather.cpp`, `fuzz_tls`). Certificate sets are reference
  counted: a SIGHUP reload frees the old keys once the last connection opened from them ends; SIGHUP
  without TLS is ignored (AUDIT A-7).
- **I5** byte caps: `queued + n` and `pending_ + n` with both bounded by their caps (<= 16 MiB
  configured) plus one message: no wrap on 64-bit `size_t`.

### Logging
- **G1** metadata only: addresses, counts, stream ids, host names and Origin values; never
  payloads or tokens. Client-controlled strings go through `log_text` (quoted, printable ASCII,
  `\xNN` escapes, at most 96 characters). One `write(2)` per line.

## 5. Differences from the Node server (deliberate)

- Zone ids are never parsed as addresses (same outcome for CONNECT: `0x41`).
- Connects-per-minute and failure windows count in 1-second buckets over 60-61 s (never shorter
  than relay-guard's exact 60 s window). The scan detector is exact up to its limit, which is capped
  at 4096.
- More than two `X-Forwarded-For` header lines from a trusted proxy: the proxy's address is used
  (no guessing).
- The bandwidth limit stops reading instead of delaying writes (no buffering because of it).
- HTTP parsing is stricter (version 13 required, `Connection: upgrade` required, valid key, no
  obs-text): standard WebSocket clients send all of these.
- `--max-handshakes`, `--max-handshakes-per-ip`, `--handshake-rate`, `--write-stall` and the pool
  shares exist only here.
- The block list also covers all of 2001::/23 (IETF protocol assignments: benchmarking, ORCHID,
  AMT, AS112, anycast), not only Teredo. A network-specific NAT64 prefix of the local network is not
  known to the relay: block it with `--block` (AUDIT A-10).
- The resolver uses only the first `nameserver` of `/etc/resolv.conf` (or `--dns-server`), one try,
  no TCP fallback (a truncated answer with no usable address fails as unreachable).

## 6. Verification

- `make test`: unit tests (RFC 3174 SHA-1, FIPS 180-2 SHA-256, RFC 4648 base64, RFC 6455 accept
  key, SIMD vs scalar at every length/alignment/phase, UTF-8 edge cases, relay-guard's IP/host
  cases, HTTP, WebSocket, Wisp), also under ASan/UBSan; concurrency stress (`test-pool`).
- `make tsan` (Linux): the stress test and the whole server under ThreadSanitizer.
- `node --test test/server.test.js`: the 39 protocol cases of `packages/wisp/test/server.test.js`
  against the ASan/UBSan server (or `WISP_CPP_BIN=build/wisp-server-tsan`, `WISP_CPP_ARGS=--io-uring`).
- `node --test test/invariants.test.js`: one test per invariant above that memory safety does not cover.
- `node --test --test-concurrency=1 test/audit.test.js`: AUDIT.md regression tests (each began as the
  auditor's reproducer and now asserts the safe behaviour); `make test` runs `tests/audit_tls_gather.cpp`.
- `WISP_CPP_TLS=1 NODE_TLS_REJECT_UNAUTHORIZED=0 node --test test/tls.test.js test/server.test.js` (TLS=1 build): TLS
  versions/suites, ALPN, SNI, SIGHUP reload (good and broken files), kTLS-or-userspace, and the protocol cases over wss.
- `make fuzz` + `tools/fuzz-all.sh`: seven targets (fuzz_tls: the record gathering in front of SSL_write), ASan + UBSan,
  coverage-guided; on Linux with real libFuzzer: `make CXX=clang++-20 FUZZ_ENGINE=libfuzzer BUILD=build-lf fuzz`
  (Ubuntu needs `libclang-rt-20-dev`). 2026-10-24: all seven x 310 s clean after a harness fix (AUDIT.md).
- Real-host results (2026-10-24, Linux 7.0 x86-64, OpenSSL 3.0.13): kTLS TX on every connection, kTLS RX on
  TLS 1.2 only (OpenSSL 3.0 has no TLS 1.3 RX offload; 3.2+ does), confirmed by the `kernel offload tx= rx=`
  log line and `/proc/net/tls_stat`. TSan with 4 threads over all suites: no reports (run under `setarch -R`
  on kernels whose mmap layout TSan rejects: "unexpected memory mapping").
