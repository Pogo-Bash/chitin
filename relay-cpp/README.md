# relay-cpp: a fast Wisp relay in C++

A Wisp v1/v2 relay (the protocol Chitin's engine uses to open TCP connections) written in C++23: one event loop per core
(kqueue on macOS, epoll or io_uring on Linux), arena allocators and lock-free buffer pools, SIMD WebSocket unmasking
(NEON, AVX2/SSE2, scalar), and optional native `wss://` with the system OpenSSL 3 for the handshake and Linux kernel TLS
(kTLS) for the records. It enforces the same rules as the Python relay in `../relay/`: token auth, private and special
address ranges refused, DNS resolved once and the checked address connected, per-session stream, connect-rate and
bandwidth limits, timeouts and Wisp flow control.

Licence: MIT OR Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE`). The rest of Chitin is GPL-2.0-or-later.

## Build and run

Needs a C++23 compiler (clang 16+ or gcc 13+) and make. For `wss://`, the system OpenSSL 3 headers and library
(Debian/Ubuntu `libssl-dev`, Homebrew `openssl@3`); without them, run plain `ws://` behind a reverse proxy as with the
Python relay.

```bash
make -j4
./build/wisp-server --help
```

Run it in place of `relay/relay.py` for local testing (the harness's default relay address is `ws://127.0.0.1:8101/`):

```bash
./build/wisp-server --port 8101 --allow-any-host
```

`--allow-any-host` is for local testing only; use `--host-allow` lists for anything others can reach, and read
`../relay/README.md` on running a relay before exposing one: whoever runs it is responsible for its traffic.

## Security

An independent audit ([AUDIT.md](AUDIT.md)) found no memory-safety bugs and 13 availability and hardening issues, all
fixed, each with a regression test. Checked: unit tests under ASan/UBSan, a TSan stress test and the protocol suites under
TSan with 4 threads (macOS, a Linux container and a real x86-64 host), every libFuzzer target for 5 minutes, kTLS on a real
kernel. [DESIGN.md](DESIGN.md) has the architecture, memory model, threat model and the invariants the tests check.

Not covered yet: kTLS receive for TLS 1.3 needs OpenSSL 3.2 or later (3.0 offloads only sending there); the two slowest
fuzz targets want longer runs before a release.

## Benchmarks (indicative only)

Measured with Mercury Workshop's wispmark on loopback in Docker (6 CPUs), limits relaxed for throughput as other servers'
published numbers are, on a busy Mac (load 6-15), so the figures are noisy. MiB/s, counting both directions as wispmark
does:

| server | wisp-js 10 | wisp-js 5x10 | wisp-mux 10 | wisp-mux 5x10 |
|---|---|---|---|---|
| epoxy-server, 1 thread | 2726 | 3021 | 2893 | 2534 |
| relay-cpp, 1 thread | 4058 | 5248 | 7168 | 6259 |
| relay-cpp, 2 threads | 4032 | 8512 | 7040 | 11789 |

Memory 16-32 MiB. With the wisp-js client the client itself is the bottleneck. Not yet measured: a quiet re-run, the same
matrix with production limits on, and a small (16 MiB / 1 CPU) container.

## Tests

`make test` (unit tests, pool and limit stress, TLS gather), `make tsan`, `make fuzz` (clang with libFuzzer). The protocol,
invariant, audit and interop suites in `test/` are Node scripts that drive the relay with the Node Wisp client and test
helpers from the project's Wisp package, which is not part of this repository yet.
