# Network: real sites through a relay, TLS inside the engine

Status: 2026-10-11, built and measured under Node; the owner's Chrome run is docs/user-tests/network.md.
Chitin loads real sites (en.wikipedia.org first) through a relay the user runs; nothing is rewritten,
the relay carries ciphertext, and the engine checks certificates against Mozilla's CA bundle. What
was built, what was decided and why, what renders, what breaks, and the numbers.

| Item of the brief | State |
|---|---|
| 1. the relay as a Docker image, safe defaults, operator disclaimer, a plain way to run it | done: relay/ (section 2) |
| 2. Spiracle in the carapace: the Wisp client; segments get stream ports, never credentials | done: harness/carapace/spiracle.js, wisp.mjs (section 3) |
| 3. the engine's network: TCP through Spiracle, TLS inside, DNS by the relay, CA bundle, error page | done: engine/platform/Network.cpp (section 4) |
| 4. the address bar loads real URLs; Wikipedia, a news site, docs.python.org | done; what renders and breaks in section 5 |
| 5. numbers | section 6 |
| 6. owner steps | docs/user-tests/network.md |

## 1. The shape

```
carapace (localhost:8100)                                   relay (relay/relay.py, 127.0.0.1:8101)
  Spiracle Worker: 1-4 Wisp v2 sessions ── ws:// ─────────►  Origin check, token, policy,
    ▲ MessagePort per segment (streams only)                   one TCP socket per stream ──► sites
segment Worker (seg-<site>.localhost)
  worker.js: net = { connect, write, close } over that port
  glue: ganglion_host_tcp_* imports, ganglion_tcp_* exports
  ganglion.wasm
    Network.cpp: pool per origin, HTTP/1.1, decoding ─ TlsSession (OpenSSL, memory BIOs)
    ResourceLoader's embedder loader (patch 0011) ─► Fetch stack: subresources, CORS, cookies later
    ganglion_navigate: the document fetch, redirects, then the phase-1 parse path or the error page
```

Every byte between a segment and a site passes through: engine (plaintext) → OpenSSL → the glue
(ciphertext, copied out of linear memory) → the segment's MessagePort → Spiracle → WebSocket →
relay → TCP. The relay and the carapace never hold plaintext for https. For plain http the relay
sees what any router would.

Spiracle checks every stream request of a segment (harness/carapace/guard.mjs): at most 128 streams open, 60 connects a
second (bursts of 120). A connect past those caps is refused with a close (0x49, "too many streams") and costs nothing until
refusals turn into a flood (more than 100, refilling 10 a second); each one past that is a strike, and 20 strikes kill the
segment. A busy page is refused, never killed; a page sending thousands of connects is killed.

## 2. The relay (relay/)

`relay/relay.py`, Python 3.9+ standard library only, 600 lines: the RFC 6455 server a browser needs
(handshake, masked frames, fragmentation, ping, close), then Wisp 2.1 as its spec defines it
([protocol.md](https://github.com/MercuryWorkshop/wisp-protocol/blob/main/protocol.md), read for
this version): the server's INFO first (version 2.1; extensions: password authentication when a token
is set, a message of the day, stream-open confirmation), the client's INFO with its credentials,
CONTINUE on stream 0 with the per-stream buffer (128 packets), then CONNECT / DATA / CONTINUE / CLOSE.
Why Python: rvwasm's net-relay.py is the prior art the owner knows, its operational ideas carry over
(Origin allowlist, per-client write-buffer limits, no dependencies, one file), and a personal relay
is not CPU-bound. What did not carry over is its L2 design: docs/research/relay.md explains why a
public relay must be stream-based, and Wisp is that.

The defaults are the ones docs/research/relay.md section 3 and docs/legal/relay-operators.md
section 3 ask for; relay/README.md lists each with the flag that loosens it. In short: ports 80 and
443; every resolved address checked against the IANA special-purpose registries (0/8, 10/8, 100.64/10,
127/8, 169.254/16 with the cloud metadata address, 172.16/12, 192.168/16, 198.18/15, 224/4, 240/4,
the documentation nets, and the IPv6 equivalents including mapped and NAT64 forms) and the connection
made to the address that was checked, so a name that changes its answer (rebinding) gains nothing;
64 streams and 120 CONNECTs a minute per session, 8 sessions per client address (Spiracle spreads a carapace's
streams over up to 4 sessions, opening another when the open ones are within 8 streams, 10 connects or 5 new hosts
of those limits, a host staying on a session that already has it; harness/carapace/spiracle.js); a session that
touches 60 distinct hosts or fails 20 connects in a minute is throttled for a minute (close reason
0x49), because that is what a scan looks like and hosting providers close accounts for scanning;
streams idle for 300 s are closed; the Origin allowlist (`http://localhost:8100` by default) as a
browser safeguard and never as authentication; an optional shared secret carried as Wisp password
authentication inside the WebSocket, never in the URL; no inbound ports by construction; logs are
one line per session by default, a line per stream (host, port, bytes, duration, never content) on
request. UDP is not offered: no DNS or QUIC through the relay; the relay resolves names itself for
each CONNECT, which is Wisp's model and keeps the policy check on the resolved address.

`relay/Dockerfile`: `python:3.12-slim`, a system user, one exposed port, `RELAY_BIND=0.0.0.0`. The
image was not built here (no Docker on this Mac; the Lima VM is reserved), so `docker build` is the
owner's first check. `relay/README.md` carries the operator disclaimer (section 1 of
docs/legal/relay-operators.md, verbatim) and none of the words docs/legal/README.md section 3 rules out.

Tests: tests/relay.test.mjs (9) run two relays, one with `--allow-private` for the loopback echo
server and one with the shipped defaults, and check the handshake, flow control beyond the buffer,
the token (0xc0, 0xc2), the Origin check (403), the port allowlist (0x48), UDP (0x41), the private
range block (0x48 for 127.0.0.1 and for `localhost`), an unknown name (0x42) and a site closing (0x02).

## 3. Spiracle (harness/carapace/spiracle.js, wisp.mjs)

A module Worker in the carapace origin. It holds the relay URL and token (from the carapace's two
header fields, kept in sessionStorage), keeps one Wisp session, and serves segments: each segment is
given one MessagePort at init, over which it asks for streams (`connect` host/port, `data`, `close`)
and gets `open`, `data`, `close` back. Spiracle maps (segment, local id) to a Wisp stream id, applies
its own port check (80, 443) before the relay's, reconnects to the relay lazily on the next request
after a drop, and reports the relay's message of the day and its counters to the Segment panel. The
segment never sees the relay URL, the token or another segment's streams: that is the
architecture's "segments get stream ports, never the credentials".

`wisp.mjs` is the client both Spiracle and the Node tests use (it needs only a WebSocket
constructor): the INFO exchange, password authentication, per-stream credit counting from CONTINUE
packets with writes queued at zero, and the stream-open confirmation as `onOpen`.

The carapace's CSP gained `connect-src 'self' <relay origin>` (the harness server's `--relay`
option sets it, default `ws://127.0.0.1:8101/`) and `worker-src 'self'`; the segment Worker's
`connect-src` is unchanged (`'self'` plus the phase-0 stand-in), so the network still fails closed
on the host's own fetch: the only way out of a segment is the MessagePort.

## 4. The engine's network (engine/platform/Network.cpp, Host.cpp)

### Decision: HTTP/1.1 written here, not libcurl

The brief offered curl + OpenSSL if bringing libcurl's HTTP/1.1, HTTP/2, cookies and redirects in
was cheaper than writing HTTP. Reading what the engine already does and what libcurl.js had to do
decided it:

- **Redirects and cookies are already LibWeb's.** The Fetch stack follows redirects itself ("HTTP-redirect
  fetch", Fetching.cpp) and Ladybird's own RequestServer runs curl with `CURLOPT_FOLLOWLOCATION 0`
  (Services/RequestServer/Request.cpp:1317); cookies are appended by Fetch from the page client's
  jar (`page_did_request_cookie` / `page_did_set_cookie`, Page.h:718), which is a phase-2 item
  either way. The only navigation-level redirect handling needed is for the document fetch, which
  in phase 1 bypasses Fetch (phase1.md section 10, risk 3), and that is 25 lines.
- **What curl would add is a socket layer we would have to write anyway.** libcurl.js
  (ading2210, read for this version) builds a patched curl fork (`8.17.0-patched`: `pipe2`
  removed from configure, more in `client/fragments/`) with mbedTLS, nghttp2, zlib and brotli, on
  Emscripten's `-lwebsocket.js` socket emulation, then patches the generated JS so the emulated
  sockets ride Wisp. Ganglion is a standalone wasm module with hand-written WASI glue and no
  Emscripten JS runtime (phase1.md section 5), so the BSD socket calls curl makes (`socket`,
  `connect`, `poll`, `send`, `recv`, `getaddrinfo`, `fcntl`) would become new imports in our glue,
  with name resolution routed to the relay by hand. That is more than the HTTP/1.1 client, and
  curl's HTTP/2 needs nghttp2 on top.
- **Decoding is not Fetch's either.** LibWeb leaves `Content-Encoding` to the request layer
  (FetchedDataReceiver.cpp:93 is a FIXME; RequestServer uses `CURLOPT_ACCEPT_ENCODING ""`), so the
  client here decodes gzip, deflate (with the raw-deflate retry curl's content_encoding.c does)
  and brotli with the zlib and brotli libraries already linked for LibCompress.
- **Size and build.** curl + nghttp2 would be another dependency build and about 1 MB of wasm in a
  60 MB module; the client here is 1,000 lines of C++ compiled with the engine.

HTTP/2 was the one thing lost; it is now built where this paragraph said it would go: nghttp2 (C, no
socket calls of its own, frames in and out of buffers) on the same `TlsSession`, selected by ALPN, behind
the same `Request` and `Sink` types (section "HTTP/2" below).

### What it does

- **TCP** is three imports (`ganglion_host_tcp_connect/write/close`) and three exports
  (`ganglion_tcp_opened/data/closed`), stream ids chosen by the engine. The glue copies bytes both
  ways; page JS never gets a view of linear memory (bindings-and-gc.md, "Security of the glue").
  DNS is by hostname in the CONNECT, resolved by the relay.
- **TLS** (`TlsSession`): OpenSSL 3.6.3 built for wasm32 (`no-sock no-threads no-async`, tools/deps),
  `SSL_set_bio` with two memory BIOs so no socket exists: network bytes go in with `BIO_write(rbio)`,
  OpenSSL's output is drained from `wbio` after every call and written to the stream. TLS 1.2
  minimum, `SSL_VERIFY_PEER`, SNI (not for IP literals, RFC 6066), the hostname check through
  `SSL_set1_host` (X509_VERIFY_PARAM, wildcards without partial matches), ALPN `h2, http/1.1`
  (`http/1.1` alone for a WebSocket tunnel and for an origin that asked for HTTP/1.1), and
  session reuse through `SSL_CTX_sess_set_new_cb` keyed by host:port (TLS 1.3 tickets arrive after
  the handshake; the next connection to the same host resumes). A verification failure is reported
  as "certificate verification failed: <X509_verify_cert_error_string>" ("certificate has expired",
  "hostname mismatch", "self-signed certificate", "unable to get local issuer certificate"), other
  failures with OpenSSL's error string.
- **The seed source.** OpenSSL's `syscall_random` (providers/implementations/rands/seeding/rand_unix.c)
  reaches `getentropy()` only under `__wasi__`; Emscripten defines neither that nor `__ELF__`, so
  the build took the `DSO_global_lookup("getentropy")` branch (nothing: `no-dso`), then
  `/dev/urandom` (nothing: no files), and every handshake would have failed with "error retrieving
  entropy". libcrypto is now compiled with `-D__wasi__` (tools/deps/build.sh), which makes it call
  `getentropy()`; Emscripten's libc implements that as WASI `random_get`, which the glue answers
  with `crypto.getRandomValues`. The other two uses of `__wasi__` in OpenSSL (uid.c, the syslog BIO)
  are harmless.
- **The trust store** is a PEM bundle the host hands over before `start` (`ganglion_set_ca_bundle`):
  Mozilla's CA list as curl publishes it (tools/ca-bundle.sh → `$CHITIN_EXT/ca/cacert.pem`, 121
  certificates, MPL-2.0, served as `/chitin/cacert.pem`), read with `PEM_read_bio_X509` into the
  context's `X509_STORE`. Shipped beside the engine rather than inside it so it updates without a
  relink. Certificate times come from `time()`, which is WASI `clock_time_get` (realtime).
- **HTTP/1.1** (`Request`, `Connection`, a `Pool` per origin): requests are serialised with the
  Fetch stack's headers (User-Agent, Accept, Accept-Language, Referer, Cookie when phase 2 adds the
  jar) plus Host, `Accept-Encoding: gzip, deflate, br`, `Connection: keep-alive` and Content-Length
  for a body; responses are parsed as the bytes arrive: status line, headers (into an
  `HTTP::HeaderList`), then Content-Length, chunked (sizes, extensions ignored, trailers skipped),
  or until-close framing, with HEAD / 1xx / 204 / 304 bodiless and 1xx responses skipped. Decoded
  body bytes reach the sink in the chunks they arrive in, so LibWeb's streams see a stylesheet or an
  image progressively. At most six connections per origin, reused when idle, and at most 60 for the
  segment as a whole (WebSocket tunnels included): past that the least recently used idle connection is
  closed for the new one, or the request waits until one closes, as Chrome's socket pool does at its 256
  (branch regress: aljazeera.com's ad frames had Spiracle kill the segment, "too many streams"). An idempotent request
  whose reused connection died before any response byte is retried once on a new one (browsers do the
  same); idle connections close after 55 s, a connection that is silent for 60 s fails its request,
  a connect or handshake takes at most 30 s (a 1 s `Core::Timer` through the phase-1 event loop).
- **Where LibWeb meets it.** `ResourceLoader`'s embedder loader (patch 0011) first asks the host
  (`ganglion_host_fetch`, now returning whether it took the fetch: the harness and the Node tests
  answer `*.example` from the stand-in), else builds a `RequestSpec` from the `LoadRequest` and
  submits it with a sink whose three callbacks run Fetch's `OnHeadersReceived`, `OnDataReceived` and
  `OnComplete` inside a `TemporaryExecutionContext`, as `ganglion_fetch_done` did. Nothing in LibWeb
  changed for this; there is no new patch.
- **Navigation** (`ganglion_navigate`): a GET with a browser's Accept headers through the same
  client, redirects followed (20 at most; 303, and 301/302 after POST, become GET), then the
  phase-1 parse path (`load_document`, what `ganglion_load` did) with the final URL and the
  response's Content-Type; on failure an error page (`about:error`, generated in Host.cpp: the URL,
  the reason, one line about the relay). The outcome goes to the host through
  `ganglion_host_navigated(final URL, status, error)`, which the Worker reports and the carapace
  uses to update the address bar. Scripting is now disabled on the page
  (`Page::set_is_scripting_enabled(false)`): phase 1 relied on every script failing to parse, and
  Wikipedia's first external script reached `compile_off_thread` and an unimplemented ABI
  function; with scripting disabled the parser never fetches scripts and `<noscript>` renders, until
  phase 2 brings V8.

Not done, by design or deferred: cookies (phase 2: the jar behind the page client);
a response cache (LibWeb has an HTTP cache behind RequestServer; none here yet, so every navigation
refetches); proxy-side DNS over anything but the relay's own resolver; HSTS and the preload list;
`Upgrade-Insecure-Requests` is sent but nothing upgrades http links; the stream-level backpressure
from the engine to the host (the host queues; the engine's requests are small); certificate
revocation (as in Ladybird: none); WebTransport to the relay (Wisp over WebSocket is the one
transport, per the brief).

### HTTP/2 (built 2026-10-22)

RFC 9113 with HPACK (RFC 7541) through nghttp2 1.69.0 (MIT, the version Ladybird's vcpkg.json pins; built by
tools/deps/build.sh, recorded in docs/toolchain.md). nghttp2 owns framing, HPACK, stream states and flow control;
Network.cpp owns the bytes and the requests: `nghttp2_session_mem_recv2` takes TLS plaintext, `nghttp2_session_mem_send2`
output goes back through the same TLS session. Built to the RFCs, not to look like any browser on the wire.

- **ALPN.** https connections offer `h2` then `http/1.1`; the server's choice decides the connection's protocol
  (`Connection::Protocol`). No ALPN answer, or `http/1.1`, is HTTP/1.1 exactly as before. Plain `http:` is always
  HTTP/1.1 (no h2c, no prior knowledge), and a WebSocket tunnel offers `http/1.1` alone (RFC 8441 is not used: the
  handshake stays HTTP/1.1 on a connection of its own).
- **One connection per origin.** While an origin's first connection is negotiating, the requests behind it wait for the
  answer (an origin that spoke h2 last time, or one never seen); with `h2` they all become streams on that one
  connection, with `http/1.1` the pool opens up to six as before. What each origin chose is remembered for the session
  (`s_speaks_h2`, kept across navigations).
- **Streams.** As many as the server's `SETTINGS_MAX_CONCURRENT_STREAMS` allows (capped at 256 so that the engine, not
  nghttp2's queue, keeps the urgency order); the rest wait in the origin's queue and start as streams close. Request
  fields are the HTTP/1.1 ones lowercased, with `:method`, `:scheme`, `:authority`, `:path`; connection-specific fields
  (`Connection`, `Keep-Alive`, `Proxy-Connection`, `Transfer-Encoding`, `Upgrade`, a `TE` other than `trailers`) are
  dropped (RFC 9113 section 8.2.2). Responses: 1xx (103 Early Hints) skipped, trailers accepted and dropped (Fetch has no
  trailer API), no reason phrase (`statusText` is empty, as in Chrome over h2), content decoding as for HTTP/1.1.
  nghttp2 checks `content-length` against the DATA it receives.
- **SETTINGS and flow control: RFC 9113's defaults.** Header table 4096, initial window 65,535, frame size 16,384, no
  limit on concurrent streams or header list size, all left at their defaults; the SETTINGS frame carries only
  `SETTINGS_ENABLE_PUSH = 0` (server push off, as Chrome has it) and `SETTINGS_NO_RFC7540_PRIORITIES = 1` (RFC 9218
  section 2.1). WINDOW_UPDATE goes out as data is received (nghttp2's automatic mode). The cost, measured below: a
  64 KiB connection window is one round trip per 64 KiB of a large response; larger windows were tried and did not
  change the heavy-page numbers beyond their noise, so the defaults stay.
- **Priorities (RFC 9218).** Each request gets an urgency from its Fetch destination and priority hint
  (`Net::priority_for`): 0 documents, frames and stylesheets; 1 scripts, fonts, JSON modules, workers; 2 `fetch()` /
  XHR; 3 the rest; 4 images, audio and video, incremental. `fetchpriority`/`priority: "high"` moves a request one step
  up, `"low"` one down. Sent as the `priority` field when not the default (`u=0`, `u=4, i`), and used to order each
  origin's waiting requests for both versions. PRIORITY_UPDATE is not sent: nothing in LibWeb changes a request's
  priority after it starts (Chrome sends it when an image enters the viewport; LibWeb has no such signal).
- **GOAWAY, RST_STREAM and retries (RFC 9113 section 8.7).** After a GOAWAY the connection takes no new streams;
  streams the server kept finish, streams above its last stream id were not processed and are retried on a new
  connection whatever their method, as are streams reset with `REFUSED_STREAM` (three times at most).
  `HTTP_1_1_REQUIRED` marks the origin HTTP/1.1-only for the session and retries the request over HTTP/1.1. Any other
  reset fails the request ("the server reset the HTTP/2 stream (INTERNAL_ERROR)"), except an idempotent request that
  had no response byte, which is retried once, as the HTTP/1.1 path does. A connection that ends with streams open
  applies the same rules; an idle one (55 s) closes with GOAWAY(NO_ERROR).
- **Connection pooling, Chrome's rule.** An h2 connection to host A serves host B (same scheme and port) when B's name
  resolves to the address A's connection is connected to and A's certificate is valid for B (`X509_check_host`, no
  partial wildcards). Both halves need information the engine does not have on the real path: names are resolved by the
  relay, and the relay does not say which address it connected to. The engine takes them when a host gives them
  (`ganglion_net_dns` / `api.netDns`, and `tcpOpened(id, peer)` → `ganglion_tcp_peer`); the Node tests do, Spiracle does
  not yet, so in a segment nothing is pooled across hosts (what Chrome does when the answers do not match).
- **Unchanged:** cookies (the Cookie field and Set-Cookie through the jar, hop by hop), Fetch's redirects, CORS and
  credentials, the error texts, the 30/60/55 s timeouts.

**Tests.** tests/engine-h2.test.mjs (in `make engine-net-test`) against Node's http2 server: a page of 26 resources on one
connection with up to 25 streams in flight and the priority fields checked; a server limited to 2 concurrent streams;
5 MB down (plain and gzip) and 5 MB up with the default windows; trailers, 103, HEAD, an empty status text; GOAWAY between
the two halves of responses (the kept streams finish, the refused ones arrive on a second connection); REFUSED_STREAM on a
POST, HTTP_1_1_REQUIRED, a reset after the body began; servers with no ALPN and with `http/1.1` only; pooling with and
without a matching address and certificate. chrome-test's `h2` group (`CHITIN_ONLY=h2`) loads one page of fetches
(statuses, a 3 MB body, gzip, POST/PUT/HEAD, trailers, a redirect, a repeated header, 204, a reset, CORS denied and
allowed, priority hints, 24 in parallel) over an h2 server in Chrome and in Chitin and compares the outcomes; the server
checks that Chitin's requests were all HTTP/2 on one session.

**Measured** (tools/net-page.mjs `--scripting --timeout 30000`, through a local relay, 2026-10-22, the engine before this
change against the one after, two runs each; times from the start of the run):

| page | engine | connections | TLS handshakes | requests (failed) | document | 50 % / 90 % of requests done |
|---|---|---|---|---|---|---|
| chess.com | HTTP/1.1 only | 21, 21 | 21, 21 | 62 (0), 62 (0) | 479, 591 ms | 1.6 / 1.6 s, 1.7 / 2.1 s |
| chess.com | with HTTP/2 | 6, 6 | 6, 6 | 62 (0), 62 (0) | 553, 651 ms | 1.7 / 2.1 s, 2.1 / 2.7 s |
| fiverr.com | HTTP/1.1 only | 102, 117 | 67, 68 | 308 (35), 305 (49) | 651, 633 ms | 7.3 / 10.6 s, 9.0 / 11.4 s |
| fiverr.com | with HTTP/2 | 77, 82 | 62, 62 | 364 (15), 372 (20) | 796, 691 ms | 16.8 / 21.1 s, 9.1 / 14.3 s |

Connections fall (chess.com 21 → 6, all six h2; fiverr.com about 110 → 80, 55 of them h2 across its many hosts) and fewer
requests fail, so more of fiverr.com's scripts run and ask for more (the request totals differ, which is why its
percentile times are not comparable). Time to load did not improve in these runs: the document arrives 50-150 ms later
over h2 (not explained yet; the larger windows did not remove it), and the rest is inside the run-to-run noise. Larger
windows (4 MiB per stream, 16 MiB for the connection) gave fiverr.com 11.8 / 15.4 s and 8.3 / 12.1 s and chess.com
1.5 / 2.2 s and 1.8 / 2.1 s: no clear difference, so they were not kept.

### Synchronous requests (built 2026-10-22, branch wb-frames)

A synchronous `XMLHttpRequest` (`open(..., false)`) blocks page JavaScript until the response is in, and page JavaScript
runs on the segment Worker's thread, which is also the thread every network event arrives on (Spiracle's MessagePort). Before,
Ladybird's `spin_until` pumped the engine's loop forever: the loop ran nothing while the host's turn was pending, no port
message could be delivered under the blocked stack, and the page stalled until the engine's own timeouts failed the request
("connection timed out"). Now:

- **The nested wait** (engine/platform/EventLoop.cpp). Only a nested wait reaches `EventLoopImplementation::pump` (the host's
  turns call the manager directly). Inside it the host's turn is not waited for (the HTML event loop is paused by the caller;
  what must run is the fetch's deferred steps, timers and the network), and when nothing ran the engine calls
  `ganglion_host_wait(ms)`: the host blocks for at most the time to the next timer until a synchronous stream has events,
  delivers them (`ganglion_tcp_*` inside the call) and returns.
- **Synchronous connections** (Network.cpp). A request submitted inside a nested wait gets a connection of its own, outside
  the pool's queue, HTTP/1.1 only, closed after its one response, opened with `ganglion_host_tcp_connect_sync`. Nothing else
  rides it, and it never waits behind the pool's six connections.
- **The ring** (harness/segment/worker.js `SyncRing`, segment.js `startSyncNet`, harness/carapace/spiracle.js). At start the
  Worker gives Spiracle an aux port (`{ t: 'aux' }`) and the segment document the other end plus a 4 MiB SharedArrayBuffer (the
  segment is cross-origin isolated). A connect with `aux: true` has its open, data and close events sent to the aux port;
  the document, whose thread is free, writes them into the ring as records (kind, stream, length or close code, the bytes,
  4-aligned) and `Atomics.notify`s; the Worker `Atomics.wait`s on the write index (Atomics.wait is captured before the page's
  surface makes it throw). Writes and closes still go over the normal port. A host without shared memory (Node, a segment that is
  not isolated) opens the stream as an ordinary one: the old behaviour.

Matches Chrome 154 for status, headers, POST bodies, 404, a network error (NetworkError), CORS, the event order of a
synchronous send (readystatechange 1, 4, load, loadend, no progress), a 2 s response, a timer and a microtask queued before
the call running after it, and the InvalidAccessError of `timeout` or `responseType` with a synchronous request in a window
(Ladybird's XHR already had those). Not covered: a synchronous request the page's service worker or the harness's stand-in
answers (those answer asynchronously).

## 5. What renders, what breaks

Under Node through the relay (tools/net-page.mjs, 1024x768, Noto fonts, images other than BMP not
decodable there):

- **en.wikipedia.org/wiki/Web_browser**: renders. The Vector 2022 skin in its no-JS form (the
  Contents block inline above the title, the language and menu buttons present but inert), the
  logo (an SVG, drawn by LibWeb), headings in the serif, body text, links, the infobox and its
  caption, the references. 136 requests over 19 TLS connections to en.wikipedia.org,
  upload.wikimedia.org, thumb.wikimedia.org and auth.wikimedia.org; no failures. The infobox photo
  and thumbnails are PNG/JPEG, decoded by Chrome in the segment Worker, missing under Node.
  Found and fixed on this page: a `302` with `Content-Length: 0` (CentralAutoLogin's 1x1) never
  completed, because the parser finished responses only inside its byte loop.
- **docs.python.org/3/tutorial/**: renders as in a browser: the Sphinx theme's header bar with the
  theme select and search field, the sidebar (Previous topic, Next topic, This page), the green
  tip box, headings, links. 9 requests, 6 connections.
- **text.npr.org** (the news site) and one of its articles: the text-only pages render whole:
  masthead, the tricolour rule, the date, the headline list; the article's paragraphs. One request
  each.
- **example.com**: the paragraph. **neverssl.com** over plain http: renders (port 80, no TLS).
- **expired.badssl.com**, **wrong.host.badssl.com**: the error page with OpenSSL's reason; nothing of
  the site. **127.0.0.1:8100** through the relay: the error page, "destination blocked by the relay".
- What breaks: images other than BMP under Node (the Worker decodes them in Chrome; untested there
  as of this writing); Wikipedia's menus, search suggestions and collapsible sections need its
  JavaScript (phase 2); no HTTP cache, so Back or a second visit refetches everything; pages whose
  servers answer only HTTP/2 do not exist in practice (HTTP/1.1 stays mandatory), but sites with
  hundreds of small resources pay for six connections at a time.

## 6. Numbers

Measured under Node v22.14.0 on the M4 Max through relay.py on loopback (so the network round trip
is the real one to the sites; the relay adds nothing measurable). Times from the `navigate` call.

| page | status | document fetched | first paint after the document | settled (all requests done) | requests | connections = TLS handshakes | OpenSSL time in handshakes | bytes in / out (TCP) | memory |
|---|---|---|---|---|---|---|---|---|---|
| en.wikipedia.org/wiki/Web_browser | 200 | 287 ms | 567 ms | 2.0-4.4 s (two runs) | 136 | 17-19 | 63-88 ms (3.4-4.6 ms each; wall 1.1-1.2 s summed over the handshakes) | 597 KiB / 103 KiB | 142 MiB |
| docs.python.org/3/tutorial/ | 200 | 168 ms | 255 ms | 466 ms | 9 | 6 | 13 ms | 40 KiB / 14 KiB | 128 MiB |
| text.npr.org/ (the news site) | 200 | 1113 ms (the site) | +108 ms | 1.2 s | 1 | 1 | 10 ms | 11 KiB / 2 KiB | 128 MiB |
| text.npr.org/g-s1-147267 (an article) | 200 | 510 ms | 573 ms | 571 ms | 1 | 1 | 10 ms | 13 KiB / 2 KiB | 128 MiB |
| example.com | 200 | 165 ms | 196 ms | 194 ms | 1 | 1 | 13 ms | 6 KiB / 2 KiB | 128 MiB |
| neverssl.com (plain http) | 200 | 5.2 s | +66 ms | 5.4 s | 1 | 1, no TLS | 0 | 1 KiB / 1 KiB | 128 MiB |
| expired.badssl.com | error page | 148 ms | | | 1 | 1 (failed) | | 5 KiB / 2 KiB | "certificate verification failed: certificate has expired" |
| wrong.host.badssl.com | error page | 147 ms | | | 1 | 1 (failed) | | 4 KiB / 2 KiB | "certificate verification failed: hostname mismatch" |
| 127.0.0.1:8100 | error page | 124 ms | | | 1 | 1 (refused) | | 0 | "destination blocked by the relay" |

The result files are docs/results/network-node-2026-10-11/net-*.json (tools/net-page.mjs's output).
"Document fetched" is from `ganglion_navigate` to the `navigated` callback: the TLS handshake, the
request, the whole body (Wikipedia's article is 400 KB of HTML after decoding) and any redirect.
"First paint after the document" is from the same start to the first painted frame once the
document arrived, which for Wikipedia includes parsing and its render-blocking stylesheets
(load.php, 6 parallel connections) and under Node has the runner's 20 ms pump interval in it; the
segment Worker ticks at the display rate. "Settled" is when no request is in flight: for Wikipedia
that is every thumbnail, font and icon; its spread between runs is the network's.

What the runs found and fixed: a `302` with `Content-Length: 0` (CentralAutoLogin's 1x1 on every
Wikipedia page) never completed, because the parser finished responses only inside its byte loop;
neverssl.com's one IPv4 address is dead from this network, and the relay connected only to the
first allowed address, so the relay now tries every resolved address in Happy Eyeballs order (IPv6
first, families alternating, 5 s each inside the 15 s total) and connects to the one it checked; the
error page now says what the relay said (blocked, throttled, timed out, refused, host not found)
instead of "the connection closed".

TLS: a handshake costs about 3.4 ms inside OpenSSL on wasm (no assembly, scalar; the
`tlsHandshakeOpenSslMs` counter wraps `SSL_do_handshake`), of a 45-50 ms wall time per handshake
that is mostly the two round trips to the site. The local-server test (tests/engine-net.test.mjs)
shows the same 3.4 ms with a 5 ms wall time.

Sizes: `ganglion.wasm` 61.46 MB linked (+0.65 MB for OpenSSL's TLS, zlib's inflate and brotli's
decoder); the CA bundle 189 KB; the relay 24 KB of Python.

## 7. Files

- relay/relay.py, relay/Dockerfile, relay/README.md
- harness/carapace/wisp.mjs, spiracle.js; carapace.js and index.html (address bar, relay fields);
  harness/segment/worker.js, segment.js (the net port); harness/server.mjs (`--relay`, CSP,
  `/chitin/cacert.pem`)
- engine/platform/Network.h, Network.cpp; Host.cpp (loader dispatch, navigate, error page, exports);
  CMakeLists.txt (OpenSSL, zlib, brotli)
- glue/engine/30-host.js (TCP imports and exports, setCaBundle, navigate, netStats)
- tools/ca-bundle.sh, tools/net-page.mjs, tools/deps/build.sh (OpenSSL `-D__wasi__`)
- tests/relay.test.mjs, tests/engine-net.test.mjs, tests/net.mjs, tests/fixtures/tls/, tests/engine-run.mjs
- Makefile: `relay-test`, `engine-net-test`, `net-page`
