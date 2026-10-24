# The Chitin relay

A page cannot open a TCP connection. Chitin's engine therefore sends each connection it needs to a
relay as one stream inside a WebSocket, and the relay opens the connection to the site. The protocol
is [Wisp 2.1](https://github.com/MercuryWorkshop/wisp-protocol/blob/main/protocol.md). TLS runs
inside the engine, so the relay carries ciphertext between the user and the site and cannot read or
change a page. The relay's job is to open sockets and to say no to the wrong ones.

**The project does not run any relay.** This directory is software you run yourself.

## Before you run one: the disclaimer

From `docs/legal/relay-operators.md` (draft, not legal advice; read the whole file):

1. **You are the operator, and you are responsible.** Traffic that leaves your relay comes from your
   server and your IP address. Websites, hosting providers, abuse desks, police and courts will see you,
   not the project and not the user.
2. **The project provides software only.** It does not run, monitor, vouch for, certify, insure or
   indemnify your relay or any other. There is no warranty of any kind (see `LICENSE.md` and `TERMS.md`
   sections 10 and 11). The software may have bugs, including security bugs. You run it at your own risk.
3. **The project does not receive your logs, your users' data or any report from you.** You are
   the only one who can answer abuse reports and legal requests aimed at your relay.
4. **You must follow the law** where your server is, where you live and (as far as it applies to you)
   where your users are, and **you must follow your hosting provider's acceptable-use policy.** Many
   providers do not allow public proxies, VPN-like services or anything that looks like scanning, and a
   complaint can get your account locked or closed. Read the policy before you start.
5. **The licence.** The relay is part of Chitin's own code and is under the GNU General Public License,
   version 2 or (at your option) any later version (`LICENSE.md`). You may run it for any purpose,
   including as a paid service. If you distribute it, modified or not, the GPL's terms apply, including
   offering the source.
6. **Do not describe your relay as official** or use Chitin's name or logo in a way that suggests the
   project runs, backs or endorses it (`TRADEMARKS.md`). Do not advertise it as a way to bypass school,
   work or other filters; your wording can create liability for you.
7. **You must not loosen the safe defaults to run an "open" relay for strangers** unless you have taken
   advice and accept the consequences. If you do change them, say so to your users.
8. **If something goes wrong,** that is between you, your users, your host and the authorities. The project
   is not a party and cannot help with legal matters.

Safest: a relay for yourself or a few people you know and can cut off. Do not run one if you are not
willing to answer an abuse email within a day or two.

## Running it

For development, on the machine that serves the carapace (no Docker needed):

```sh
python3 relay/relay.py                      # ws://127.0.0.1:8101/, for http://localhost:8100
```

As a container:

```sh
docker build -t chitin-relay relay/
docker run --rm -p 127.0.0.1:8101:8101 chitin-relay --origin http://localhost:8100
```

For a relay others reach, put it behind a reverse proxy that terminates TLS (Caddy, nginx) so the
URL is `wss://`, or pass `--tls-cert` and `--tls-key`. A page served over https cannot open `ws://`.
Then set a shared secret and the real origin of your Chitin shell:

```sh
docker run --rm -p 8101:8101 -e RELAY_TOKEN="$(openssl rand -hex 24)" chitin-relay \
    --origin https://chitin.example --block 203.0.113.0/24
```

Health check: `GET /healthz` answers `ok`. Everything else that is not a WebSocket upgrade is 404.

## The defaults, and what each flag loosens

| Default | Flag | Why it is the default |
|---|---|---|
| Destination hosts: only the list you give | `--host-allow en.wikipedia.org --host-allow '*.wikimedia.org'` or `RELAY_HOSTS`; `--allow-any-host` to open it | The relay refuses to start with no list. A closed list is the strongest abuse control: it cannot be a scanner or a general proxy. The Docker image defaults to the demo's hosts. |
| Destination ports 80 and 443 only | `--port-allow 80,443,...` | Mail, file sharing and most abuse go elsewhere; sites live on these two. |
| No private, loopback, link-local, carrier-grade NAT, multicast, reserved or cloud-metadata destinations (including Azure's `168.63.129.16` and the IPv6 forms that embed IPv4: `::/96`, SIIT, site-local, `3fff::/20`, `5f00::/16`), checked on every address a name resolves to; the connection goes to the address that was checked | `--block CIDR` adds your own ranges; `--allow-private` is for development only and prints a warning | Stops users reaching your internal network or your cloud credentials (server-side request forgery, DNS rebinding). |
| This machine's own addresses are never connected to | `--own-address ADDR` (your public IP or CIDR; repeatable); `--no-block-local` turns the automatic part off | Otherwise a client reaches the other services on your public address, or loops the relay through itself. The interface addresses are collected from `ip addr`/`ifconfig`, `/proc/net/if_inet6` and the kernel's route to the internet; behind NAT, where the public address is not on an interface, give it with `--own-address`. The start-up banner lists the extra blocks in force. |
| Destinations are an ASCII host name or an IP literal without a zone id; anything else is refused with `0x41` | — | Keeps control characters, zone ids and `127.1`-style numbers out of logs, lists and the resolver. |
| 64 open streams and 120 new connections a minute per WebSocket; 8 WebSockets per client; 512 WebSockets in all | `--max-streams`, `--max-connects-per-minute`, `--max-conns-per-ip`, `--max-connections` | Bounds what one user can do. A page load is 10-30 connections. A client is its address, or its IPv6 `/64` (`--ipv6-prefix`). |
| Behind a reverse proxy: every client looks like the proxy | `--trusted-proxy ADDR` (repeatable): that peer's `X-Forwarded-For` is believed, rightmost entry that is not itself a trusted proxy | Without it all clients share the proxy's 8 sockets. Never trust an address you do not run: anyone else can send any header. |
| A WebSocket with no open stream for 120 s is closed | `--conn-idle-timeout` | Idle sockets do not hold a per-client place. The page reconnects when it needs a stream. |
| At most 4 name lookups in flight per WebSocket and 32 in all; more wait for a slot (up to 10 s, then `0x49`), and CONNECTs to a name already being looked up share that lookup | `--max-lookups-per-connection`, `--max-lookups` | The standard library can only resolve names by blocking a thread. Lookups run on their own pool, and a slot is held until the thread really returns, so a client asking for names whose servers never answer fills its share, not the relay. |
| At most 4 MiB per stream and 16 MiB per WebSocket accepted from a client and not yet written to the site; one packet at most 128 KiB; a client that stops reading is dropped after 8 MiB of replies | `--max-write-buffer` | Memory is bytes, not packets. Credit goes back to the client only after its bytes reached the site socket. |
| Throttled for a minute after 60 distinct hosts or 20 failed connects in a minute | `--scan-hosts-per-minute`, `--scan-failures-per-minute` | That is what a port or host scan looks like, and hosting providers close accounts for scanning. |
| 8192 KiB/s (about 64 Mbit/s) per WebSocket, both directions together | `--max-kbps N`; `0` is unlimited | An open relay is free high-bandwidth egress for whoever finds it. Raise it for yourself, lower it for a shared relay. |
| Streams idle for 300 s are closed | `--idle-timeout` | Keep-alive connections do not pile up. |
| Only `http://localhost:8100` and `http://127.0.0.1:8100` may connect | `--origin URL` (repeat for several) | Otherwise any site open in a user's browser could use the relay through them. This is a browser safeguard, not authentication: anything that is not a browser can send any `Origin`. |
| No shared secret (the banner says so in capitals) | `--token`, `--token-file`, `RELAY_TOKEN` | Set one for any relay reachable from outside your machine. Without one, anyone who reads the page source can use the relay: the Origin check stops other websites from driving a visitor's browser, nothing more. It travels as Wisp password authentication inside the WebSocket, not in the URL, so access logs do not capture it; it is compared as SHA-256 digests. |
| No inbound ports | — | The relay listens on its own port and opens outgoing connections only. It cannot be made to accept connections for a user. |
| Logs: one line per WebSocket (client address, origin, duration, stream count, byte totals) | `--log 0` for none, `--log 2` adds one line per stream with the destination host and port, bytes and duration | Never content. Level 2 records who connected to what; if you keep those lines, write down for how long and tell your users (`docs/legal/relay-operators.md` section 5). |

UDP is not offered (no DNS or QUIC through this relay; names are resolved by the relay itself for
each CONNECT). WebTransport is not offered yet; Wisp over a WebSocket is the one transport.

## What clients see

The relay announces itself with a Wisp INFO packet carrying a message of the day (`--motd`), by
default the limits in force, and the stream-open-confirmation extension, so the client learns
whether each socket connected. Refusals use the protocol's close reasons: `0x48` blocked by policy,
`0x49` throttled, `0x41` invalid, `0x42` unknown host, `0x43` timed out, `0x44` refused, `0xc0`/`0xc2`
token wrong or missing.

## Tests

`node --test tests/relay.test.mjs` (`make relay-test`) starts relays (one with `--allow-private`, one with the
shipped defaults, others per test) and local echo and sink servers, and checks the handshake, flow
control, the token, the Origin check, the port and destination allowlists, the private-range block and
stream closure, and one test per security-review finding (byte caps, stream-id reuse, lookup caps, own
addresses, per-client limits, write-buffer cap, fragments, host validation, IPv6 ranges, banner and
bandwidth default). Three environment variables are test hooks and must stay unset in production:
`CHITIN_RELAY_TEST_LOOKUP_DELAY`, `CHITIN_RELAY_TEST_SNDBUF`.
