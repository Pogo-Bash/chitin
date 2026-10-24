#!/usr/bin/env python3
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 [OWNER NAME]
# Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
"""The Chitin relay: a Wisp v2 server that people run themselves.

A page cannot open a TCP connection, so Chitin's engine sends each connection it needs to a relay
as one stream inside a WebSocket, and the relay opens the connection to the site. The protocol is
Wisp 2.1 (MercuryWorkshop/wisp-protocol, protocol.md): CONNECT, DATA, CONTINUE, CLOSE and INFO
packets, little-endian, with the server choosing the per-stream buffer. TLS runs inside the engine,
so this relay carries ciphertext to sites and never sees a page.

Safe by default (docs/research/relay.md, docs/legal/relay-operators.md):
  - only ports 80 and 443 (--port-allow);
  - no private, loopback, link-local, carrier-grade NAT, multicast, reserved or cloud-metadata
    destinations, checked on every resolved address, and the connection goes to the address checked;
  - no destination that is this machine itself (its interface addresses, --own-address) or the Azure
    platform address, and only ASCII host names or plain IP literals as destinations;
  - streams and new connections per WebSocket are capped, and a WebSocket that fails many connects or
    touches many hosts in a minute is throttled (a scan looks like that); clients are counted by address
    (IPv6: by /64, or by X-Forwarded-For behind a --trusted-proxy), with a global cap and an idle close;
  - memory is capped in bytes (per stream, per WebSocket, per client that stops reading), name lookups
    are capped per WebSocket and in all, and bandwidth defaults to 8192 KiB/s per WebSocket;
  - only the allowed web origins may connect (a browser safeguard, not authentication);
  - an optional shared secret, sent as Wisp password authentication, never in the URL;
  - no inbound ports: this process listens on its own port and opens outgoing connections only;
  - logs are metadata at most (connections by default, streams on request), never content.

No dependencies: the little of RFC 6455 that a browser needs is here.

    python3 relay/relay.py                               # ws://127.0.0.1:8101/ for http://localhost:8100
    python3 relay/relay.py --origin https://chitin.example --token-file /run/secrets/relay --bind 0.0.0.0
"""
import argparse
import asyncio
import base64
import concurrent.futures
import hashlib
import hmac
import ipaddress
import os
import socket
import ssl
import re
import struct
import subprocess
import sys
import time

WS_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
OP_CONT, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG = 0, 1, 2, 8, 9, 10

# Wisp packet types and the close reasons this relay uses (protocol.md).
CONNECT, DATA, CONTINUE, CLOSE, INFO = 1, 2, 3, 4, 5
STREAM_TCP, STREAM_UDP = 1, 2
R_UNSPECIFIED, R_VOLUNTARY, R_NETWORK, R_EXTENSIONS = 0x01, 0x02, 0x03, 0x04
R_INVALID, R_UNREACHABLE, R_TIMEOUT, R_REFUSED, R_DATA_TIMEOUT, R_BLOCKED, R_THROTTLED = 0x41, 0x42, 0x43, 0x44, 0x47, 0x48, 0x49
R_AUTH_PASSWORD, R_AUTH_MISSING = 0xC0, 0xC2
EXT_UDP, EXT_PASSWORD, EXT_KEY, EXT_MOTD, EXT_OPEN_CONFIRM = 1, 2, 3, 4, 5

VERSION = (2, 1)
BUFFER_PACKETS = 128          # DATA packets the relay buffers per stream before the socket takes them
MAX_WS_MESSAGE = 128 << 10    # one Wisp packet; the engine sends 16 KiB records
MAX_STREAM_BUFFER = 4 << 20   # bytes accepted from the client for one stream and not yet flushed to its site socket
MAX_CONN_BUFFER = 16 << 20    # the same, over all of one WebSocket's streams
WS_WRITE_HIGH = 4 << 20       # pause the sockets of a WebSocket whose client is not reading
MAX_FRAGMENTS = 256           # frames in one message; a browser sends one, tiny fragments are an attack on the CPU
READ_CHUNK = 32768
# Test hook (tests/relay.test.mjs): every name lookup waits this many seconds first, to hold a stream
# in its connecting phase. Unset in production.
TEST_LOOKUP_DELAY = float(os.environ.get("CHITIN_RELAY_TEST_LOOKUP_DELAY", "0") or 0)

# Destinations that are never globally reachable, or ours to protect (IANA special registries,
# OWASP's SSRF list). The relay checks every address a name resolves to, then connects to the one it
# checked, so a name that resolves to 10.0.0.1 is refused and a name that changes its answer between
# the check and the connect (DNS rebinding) does not matter.
BLOCKED_NETWORKS = [ipaddress.ip_network(n) for n in (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
    "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15",
    "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "255.255.255.255/32",
    "168.63.129.16/32",     # Azure's platform address (WireServer, DNS): publicly routable, reachable from Azure VMs
    "::/128", "::1/128", "::ffff:0:0/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/32",
    "2001:db8::/32", "2002::/16", "fc00::/7", "fe80::/10", "ff00::/8",
    "::/96",                # IPv4-compatible (::127.0.0.1): deprecated, but some stacks still map it to IPv4
    "::ffff:0:0:0/96",      # SIIT IPv4-translated
    "fec0::/10",            # deprecated site-local, still routed by some stacks
    "3fff::/20",            # documentation (RFC 9637)
    "5f00::/16",            # SRv6 segment identifiers
)]


def local_addresses():
    """This machine's own interface addresses, best effort (the standard library has no getifaddrs): what
    `ip addr` or `ifconfig` list, /proc/net/if_inet6, and the addresses the kernel would use to reach the
    internet. A relay that may connect to itself reaches whatever else listens on its public address."""
    found = set()
    for cmd in (["ip", "-o", "addr"], ["ifconfig", "-a"]):
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout
        except (OSError, subprocess.SubprocessError):
            continue
        found.update(m.group(1) for m in re.finditer(r"\binet6?\s+(?:addr:)?([0-9a-fA-F:.]+)", out))
    try:
        with open("/proc/net/if_inet6") as f:
            for line in f:
                h = line.split()[0]
                found.add(":".join(h[i:i + 4] for i in range(0, 32, 4)))
    except OSError:
        pass
    for family, probe in ((socket.AF_INET, "192.0.2.1"), (socket.AF_INET6, "2001:db8::1")):
        try:
            with socket.socket(family, socket.SOCK_DGRAM) as s:
                s.connect((probe, 9))                  # a UDP connect sends nothing; it only picks a route
                found.add(s.getsockname()[0])
        except OSError:
            pass
    out = []
    for a in sorted(found):
        try:
            out.append(str(ipaddress.ip_address(a.split("%")[0])))
        except ValueError:
            pass
    return out


def parse_peer(text):
    """An address from a peername or a forwarded-for entry (zone and brackets dropped), or None."""
    try:
        ip = ipaddress.ip_address(text.strip().strip("[]").split("%")[0])
    except ValueError:
        return None
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip


def client_key(ip, ipv6_prefix):
    """What one client is counted as: its address, or for IPv6 its /64 (an ordinary customer holds 2^64
    addresses, so counting addresses limits nothing)."""
    if ip.version == 6:
        return str(ipaddress.ip_network((ip, ipv6_prefix), strict=False))
    return str(ip)


PROTOCOL_LIST = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:[ \t]*,[ \t]*[!#$%&'*+.^_`|~0-9A-Za-z-]+)*\Z")
HOST_LABEL = re.compile(r"[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?\Z")


def valid_host(host):
    """A destination the relay will look at at all: an ASCII host name (labels of letters, digits, `-`
    and `_`, one optional trailing dot) or an IP literal (IPv6 in brackets, no zone). Anything else
    (zone ids, control characters, non-ASCII, `127.1`-style numbers that some resolvers expand) is
    refused before it reaches a list, a log line or a resolver."""
    if not host or len(host) > 255 or not host.isascii() or "%" in host:
        return False
    if host.startswith("["):
        if not host.endswith("]") or "%" in host:
            return False
        try:
            return ipaddress.ip_address(host[1:-1]).version == 6
        except ValueError:
            return False
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    name = host[:-1] if host.endswith(".") else host
    labels = name.split(".")
    if len(name) > 253 or not all(HOST_LABEL.match(label) for label in labels):
        return False
    return not (labels[-1].isdigit() or labels[-1].lower().startswith("0x"))   # numbers are not names


def normalize_host(host):
    return host.strip().strip("[]").rstrip(".").lower()


def host_allowed(host, patterns):
    """Whether `host` matches an operator-set pattern: an exact name, `*.example.org` (any subdomain, not
    the bare name), or `*` (anything). A literal IP address matches only an identical pattern."""
    host = normalize_host(host)
    for pattern in patterns:
        if pattern == "*" or pattern == host:
            return True
        if pattern.startswith("*.") and host.endswith(pattern[1:]) and len(host) > len(pattern) - 1:
            try:
                ipaddress.ip_address(host)
            except ValueError:
                return True
    return False


def blocked_address(address, extra):
    """Why a resolved address may not be connected to, or None."""
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return "not an address"
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    for net in BLOCKED_NETWORKS + extra:
        if ip in net:
            return "address in %s" % net
    return None


# Test hook: a small kernel send buffer on client sockets, so a client that does not read shows up in the
# relay's own write buffer (where --max-write-buffer applies) after kilobytes, not megabytes.
TEST_SNDBUF = int(os.environ.get("CHITIN_RELAY_TEST_SNDBUF", "0") or 0)


def blocking_lookup(host, port):
    if TEST_LOOKUP_DELAY:
        time.sleep(TEST_LOOKUP_DELAY)
    return socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)


def token_matches(given, expected):
    """Constant time and length-blind: both sides are hashed first, so neither the content nor the length
    of the secret shows in how long the comparison takes."""
    return hmac.compare_digest(hashlib.sha256(given).digest(), hashlib.sha256(expected).digest())


def encode_frame(opcode, payload):
    """One unmasked WebSocket frame, as a server sends them."""
    head = bytes([0x80 | opcode])
    n = len(payload)
    if n < 126:
        head += bytes([n])
    elif n < 65536:
        head += bytes([126]) + struct.pack(">H", n)
    else:
        head += bytes([127]) + struct.pack(">Q", n)
    return head + payload


class WebSocketClosed(Exception):
    pass


async def read_message(reader, on_control=None):
    """The next complete message from a client: (opcode, payload). Clients mask every frame
    (RFC 6455 5.1); a fragmented message is reassembled. Control frames come back on their own, or,
    with `on_control`, are handed to it and the message goes on (RFC 6455 5.4: a control frame may come
    between the fragments of a message, which must not lose the fragments before it)."""
    opcode = None
    parts = []
    total = 0
    while True:
        b0, b1 = await reader.readexactly(2)
        fin = bool(b0 & 0x80)
        op = b0 & 0x0F
        if b0 & 0x70:
            raise WebSocketClosed("reserved bits set")   # no extension negotiated (RFC 6455 5.2)
        length = b1 & 0x7F
        if length == 126:
            (length,) = struct.unpack(">H", await reader.readexactly(2))
        elif length == 127:
            (length,) = struct.unpack(">Q", await reader.readexactly(8))
        if not b1 & 0x80:
            raise WebSocketClosed("unmasked client frame")
        if length > MAX_WS_MESSAGE:
            raise WebSocketClosed("frame too large")
        mask = await reader.readexactly(4)
        payload = bytearray(await reader.readexactly(length))
        # XOR with the mask, four bytes at a time through int arithmetic (bytes(b ^ m) is 50x slower).
        if length:
            full = (mask * (length // 4 + 1))[:length]
            payload = (int.from_bytes(payload, "little") ^ int.from_bytes(full, "little")).to_bytes(length, "little")
        else:
            payload = b""
        if op >= 8:
            # RFC 6455 5.5: a control frame is never fragmented and carries at most 125 bytes.
            if not fin or length > 125:
                raise WebSocketClosed("bad control frame")
            if on_control is None:
                return op, payload
            await on_control(op, payload)
            continue
        if op != OP_CONT:
            opcode = op
        elif opcode is None:
            raise WebSocketClosed("continuation without a start")
        parts.append(payload)
        total += len(payload)                       # a running total: summing the parts each time is quadratic
        if total > MAX_WS_MESSAGE:
            raise WebSocketClosed("message too large")
        if len(parts) > MAX_FRAGMENTS:
            raise WebSocketClosed("message in too many fragments")
        if fin:
            return opcode, b"".join(parts)


def packet(ptype, stream_id, payload=b""):
    return struct.pack("<BI", ptype, stream_id) + payload


class TokenBucket:
    """Bytes per second, both directions together; 0 means unlimited."""

    def __init__(self, per_second):
        self.rate = per_second
        self.level = float(per_second)
        self.at = time.monotonic()

    async def take(self, n):
        if not self.rate:
            return
        while True:
            now = time.monotonic()
            self.level = min(max(self.rate, n), self.level + (now - self.at) * self.rate)   # n may exceed one second's worth
            self.at = now
            if self.level >= n:
                self.level -= n
                return
            await asyncio.sleep((n - self.level) / self.rate)


class Window:
    """Events in the last `seconds`."""

    def __init__(self, seconds=60):
        self.seconds = seconds
        self.items = []

    def add(self, key=None):
        self.items.append((time.monotonic(), key))

    def prune(self):
        cutoff = time.monotonic() - self.seconds
        self.items = [i for i in self.items if i[0] >= cutoff]

    def count(self):
        self.prune()
        return len(self.items)

    def distinct(self):
        self.prune()
        return len({k for _, k in self.items})


class Stream:
    def __init__(self, sid, host, port):
        self.id = sid
        self.host = host
        self.port = port
        self.queue = asyncio.Queue()
        self.pending = 0       # bytes from the client queued or being written, not yet flushed to the site
        self.received_since_continue = 0
        self.reader = None
        self.writer = None
        self.tasks = []
        self.bytes_in = 0      # from the site
        self.bytes_out = 0     # to the site
        self.started = time.monotonic()
        self.last_activity = self.started
        self.closed = False


class Connection:
    """One WebSocket, one Wisp session, many streams."""

    def __init__(self, relay, reader, writer, peer, origin):
        self.relay = relay
        self.reader = reader
        self.writer = writer
        self.peer = peer
        self.origin = origin
        self.streams = {}
        self.client_extensions = set()
        self.connects = Window()          # CONNECTs per minute
        self.failures = Window()          # failed connects per minute
        self.hosts = Window()             # distinct destination hosts per minute
        self.throttled_until = 0.0
        self.bucket = TokenBucket(relay.args.max_kbps * 1024)
        self.bytes_in = 0
        self.bytes_out = 0
        self.send_lock = asyncio.Lock()
        self.opened = time.monotonic()
        self.stream_total = 0
        self.last_stream_end = self.opened      # when this WebSocket last had no stream (or began)
        self.pending = 0       # Stream.pending over all streams
        self.lookups = 0       # name lookups in flight for this WebSocket
        self.inflight_lookups = {}  # (host, port) -> the lookup future several CONNECTs share
        self.opening = set()   # the tasks connecting admitted streams

    # --- sending -----------------------------------------------------------------------------
    def write_raw(self, frame):
        """Queue a frame to the client without waiting. A client that sends but never reads would
        otherwise make the relay buffer its replies without limit: past --max-write-buffer it is dropped."""
        if self.writer.is_closing():
            raise ConnectionError("client gone")
        self.writer.write(frame)
        if self.writer.transport.get_write_buffer_size() > self.relay.args.max_write_buffer:
            self.log(1, "dropped: not reading (%d bytes queued)" % self.writer.transport.get_write_buffer_size())
            self.writer.transport.abort()
            raise ConnectionError("client not reading")

    async def send(self, data):
        async with self.send_lock:
            self.write_raw(encode_frame(OP_BINARY, data))
            await self.writer.drain()

    async def send_close(self, sid, reason):
        try:
            await self.send(packet(CLOSE, sid, bytes([reason])))
        except (ConnectionError, RuntimeError):
            pass

    def log(self, level, text):
        self.relay.log(level, "%s %s" % (self.peer, text))

    # --- the Wisp handshake --------------------------------------------------------------------
    def server_info(self):
        a = self.relay.args
        ext = b""
        if a.token is not None:
            ext += struct.pack("<BI", EXT_PASSWORD, 1) + b"\x01"
        motd = a.motd.encode()
        ext += struct.pack("<BI", EXT_MOTD, len(motd)) + motd
        ext += struct.pack("<BI", EXT_OPEN_CONFIRM, 0)
        return packet(INFO, 0, bytes(VERSION) + ext)

    def parse_client_info(self, payload):
        """The client's INFO: (major, minor, {extension id: payload})."""
        if len(payload) < 2:
            raise ValueError("short INFO")
        major, minor = payload[0], payload[1]
        exts = {}
        i = 2
        while i + 5 <= len(payload):
            eid, n = struct.unpack_from("<BI", payload, i)
            i += 5
            if i + n > len(payload):
                raise ValueError("extension overruns INFO")
            exts[eid] = payload[i:i + n]
            i += n
        return major, minor, exts

    def check_password(self, exts):
        """True when the connection may proceed; else the close reason."""
        token = self.relay.args.token
        if token is None:
            return True
        data = exts.get(EXT_PASSWORD)
        if data is None or len(data) < 1:
            return R_AUTH_MISSING
        n = data[0]
        password = data[1 + n:]
        if token_matches(password, token.encode()):
            return True
        return R_AUTH_PASSWORD

    # --- streams ---------------------------------------------------------------------------------
    def policy_reason(self, sid, stype, port, host):
        """Why a CONNECT is refused before any resolution, or None."""
        a = self.relay.args
        if sid == 0 or sid in self.streams:
            return R_INVALID
        if stype != STREAM_TCP:
            return R_INVALID            # UDP is not offered (no extension advertised)
        if port not in a.port_allow:
            return R_BLOCKED
        if not valid_host(host):
            return R_INVALID
        if not host_allowed(host, a.host_allow):
            return R_BLOCKED            # the operator's destination list, checked before any resolution
        if len(self.streams) >= a.max_streams:
            return R_THROTTLED
        now = time.monotonic()
        if now < self.throttled_until:
            return R_THROTTLED
        if self.connects.count() >= a.max_connects_per_minute:
            return R_THROTTLED
        return None

    async def resolve(self, host, port):
        """The addresses to try, in order, or a close reason."""
        a = self.relay.args
        # A literal address resolves to itself; check it before touching a resolver.
        try:
            literal = ipaddress.ip_address(host.strip("[]"))
        except ValueError:
            literal = None
        if literal is not None:
            if not a.allow_private and blocked_address(str(literal), a.block):
                return R_BLOCKED
            return [str(literal)]
        # getaddrinfo blocks a thread for as long as a name server takes, and the standard library has no
        # non-blocking resolver. So lookups run on this relay's own small pool (never the event loop's
        # default executor, which also carries file and TLS work), and a slot is held until the thread
        # really returns, not until our timeout gives up on it. A client that asks for names whose servers
        # never answer can therefore fill only its own share, then gets 0x49.
        # A page opens several connections to one host at once (dash.cloudflare.com: three fonts, a module and a
        # stylesheet in the same parser pass): those CONNECTs share the lookup in flight for that name instead of
        # each taking a slot, and one that finds the slots taken waits for one (within the lookup's own 10 s)
        # rather than failing at once. A browser waits for its resolver; refusing here broke the page's module
        # script with 0x49. The cap on threads is unchanged: waiting holds no thread.
        deadline = time.monotonic() + 10
        key = (host.lower(), port)
        future = self.inflight_lookups.get(key)
        if future is None:
            slot = self.relay.take_lookup_slot(self)
            while slot is None:
                if time.monotonic() >= deadline:
                    return R_THROTTLED
                await asyncio.sleep(0.05)
                future = self.inflight_lookups.get(key)
                if future is not None:
                    break
                slot = self.relay.take_lookup_slot(self)
            if future is None:
                future = asyncio.get_running_loop().run_in_executor(self.relay.lookups, blocking_lookup, host, port)
                self.inflight_lookups[key] = future

                def done(f, slot=slot, key=key):
                    slot()
                    if self.inflight_lookups.get(key) is f:
                        del self.inflight_lookups[key]
                    f.exception()   # marks it retrieved
                future.add_done_callback(done)
        try:
            infos = await asyncio.wait_for(asyncio.shield(future), max(0.1, deadline - time.monotonic()))
        except (socket.gaierror, asyncio.TimeoutError, UnicodeError, OSError):
            return R_UNREACHABLE
        allowed = []
        for family, _, _, _, sockaddr in infos:
            address = sockaddr[0]
            if a.allow_private or not blocked_address(address, a.block):
                allowed.append((address, 4 if family == socket.AF_INET else 6))
        if not allowed:
            return R_BLOCKED if infos else R_UNREACHABLE
        # Alternate the families, IPv6 first, as RFC 8305 (Happy Eyeballs) sorts them; the attempts
        # below are sequential, so a dead address costs one short timeout, not the whole connect.
        v6 = [x for x, f in allowed if f == 6]
        v4 = [x for x, f in allowed if f == 4]
        ordered = []
        while v6 or v4:
            if v6:
                ordered.append(v6.pop(0))
            if v4:
                ordered.append(v4.pop(0))
        return ordered

    def admit(self, sid, stype, port, host):
        """Decide a CONNECT without waiting: the Stream, registered, or the close reason. Everything that
        can refuse is here and synchronous, so a refused CONNECT costs no task and a flood of them
        cannot pile tasks up behind a client that is not reading; tasks exist only for admitted streams,
        and those are capped by --max-streams."""
        a = self.relay.args
        reason = self.policy_reason(sid, stype, port, host)
        if reason is not None:
            if reason == R_THROTTLED:
                self.log(1, "throttled (streams=%d, connects/min=%d)" % (len(self.streams), self.connects.count()))
            return reason
        self.connects.add()
        self.hosts.add(host.lower())
        if self.hosts.distinct() > a.scan_hosts_per_minute or self.failures.count() > a.scan_failures_per_minute:
            self.throttled_until = time.monotonic() + 60
            self.log(1, "scan-like activity: %d hosts, %d failed connects in a minute; throttled for 60 s"
                     % (self.hosts.distinct(), self.failures.count()))
            return R_THROTTLED
        stream = Stream(sid, host, port)
        self.streams[sid] = stream
        self.stream_total += 1
        return stream

    async def open_stream(self, stream):
        a = self.relay.args
        sid, host, port = stream.id, stream.host, stream.port
        resolved = await self.resolve(host, port)
        if stream.closed:
            # The client closed it while we were resolving, and may have reused the id since: this stream
            # owns nothing any more, and must not touch the map entry or tell the client anything.
            return
        if isinstance(resolved, int):
            if resolved != R_THROTTLED:
                self.failures.add()
            await self.close_stream(stream, resolved, tell_client=True)
            return
        # One address at a time, each with a short timeout inside the overall one (a site with a dead
        # address in its answer is common: neverssl.com had one), connecting to the address checked.
        deadline = time.monotonic() + a.connect_timeout
        reason = R_TIMEOUT
        for address in resolved:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or stream.closed:
                break
            try:
                stream.reader, stream.writer = await asyncio.wait_for(
                    asyncio.open_connection(host=address, port=port, limit=READ_CHUNK * 4), min(remaining, a.attempt_timeout))
            except asyncio.TimeoutError:
                reason = R_TIMEOUT
            except ConnectionRefusedError:
                reason = R_REFUSED
            except OSError:
                reason = R_NETWORK
            else:
                reason = None
                break
        if stream.closed:
            # The client closed it while we were connecting (the id may be someone else's by now).
            if stream.writer:
                stream.writer.close()
            return
        if reason is not None:
            self.failures.add()
            await self.close_stream(stream, reason, tell_client=True)
            return
        if EXT_OPEN_CONFIRM in self.client_extensions:
            await self.send(packet(CONTINUE, sid, struct.pack("<I", BUFFER_PACKETS)))
        stream.tasks = [asyncio.ensure_future(self.pump_to_site(stream)),
                        asyncio.ensure_future(self.pump_from_site(stream))]
        if a.log_level >= 2:
            self.log(2, "stream %d open %s:%d" % (sid, host, port))

    async def pump_to_site(self, stream):
        try:
            while True:
                data = await stream.queue.get()
                if data is None:
                    break
                await self.bucket.take(len(data))
                stream.writer.write(data)
                await stream.writer.drain()
                # Only now, flushed, do the bytes stop counting against the caps and the client get credit back.
                if not stream.closed:
                    stream.pending -= len(data)
                    self.pending -= len(data)
                stream.bytes_out += len(data)
                stream.last_activity = time.monotonic()
                stream.received_since_continue += 1
                if stream.received_since_continue >= BUFFER_PACKETS // 2:
                    stream.received_since_continue = 0
                    await self.send(packet(CONTINUE, stream.id, struct.pack("<I", BUFFER_PACKETS - stream.queue.qsize())))
        except (ConnectionError, OSError, asyncio.CancelledError):
            pass
        finally:
            try:
                if stream.writer and stream.writer.can_write_eof():
                    stream.writer.write_eof()
            except (OSError, RuntimeError):
                pass

    async def pump_from_site(self, stream):
        reason = R_VOLUNTARY
        try:
            while True:
                data = await stream.reader.read(READ_CHUNK)
                if not data:
                    break
                await self.bucket.take(len(data))
                stream.bytes_in += len(data)
                stream.last_activity = time.monotonic()
                # Backpressure: drain() waits while the WebSocket's buffer is above its high-water mark,
                # which pauses this socket's reads until the client catches up.
                await self.send(packet(DATA, stream.id, data))
        except asyncio.CancelledError:
            return
        except (ConnectionError, OSError):
            reason = R_NETWORK
        if not stream.closed:
            await self.close_stream(stream, reason, tell_client=True, from_site=True)

    async def close_stream(self, stream, reason, tell_client, from_site=False):
        if stream.closed:
            return
        stream.closed = True
        if self.streams.get(stream.id) is stream:      # the id may belong to a newer stream by now
            del self.streams[stream.id]
        if not self.streams:
            self.last_stream_end = time.monotonic()
        self.pending -= stream.pending
        stream.pending = 0
        self.bytes_in += stream.bytes_in
        self.bytes_out += stream.bytes_out
        for t in stream.tasks:
            if t is not asyncio.current_task():
                t.cancel()
        if stream.writer:
            stream.writer.close()
        if tell_client:
            await self.send_close(stream.id, reason)
        if self.relay.args.log_level >= 2:
            self.log(2, "stream %d closed %s:%d after %.1f s, %d bytes to the site, %d from it%s" % (
                stream.id, stream.host, stream.port, time.monotonic() - stream.started,
                stream.bytes_out, stream.bytes_in, " (site closed)" if from_site else ""))

    async def idle_reaper(self):
        a = self.relay.args
        while True:
            await asyncio.sleep(min(15, max(0.25, a.conn_idle_timeout / 4)))
            now = time.monotonic()
            if not self.streams and now - self.last_stream_end > a.conn_idle_timeout:
                # Nothing open for a while: a session that holds a place (and a per-address slot) for
                # nothing. A page reconnects when it needs a stream.
                self.log(1, "closed: no streams for %.0f s" % a.conn_idle_timeout)
                self.writer.close()
                return
            for stream in list(self.streams.values()):
                if now - stream.last_activity > a.idle_timeout:
                    await self.close_stream(stream, R_DATA_TIMEOUT, tell_client=True)

    # --- the session -----------------------------------------------------------------------------
    async def run(self):
        reaper = asyncio.ensure_future(self.idle_reaper())
        try:
            await self.send(self.server_info())
            # The client's INFO (with credentials), within a few seconds.
            opcode, payload = await asyncio.wait_for(self.read_binary(), 10)
            if len(payload) < 5 or payload[0] != INFO or struct.unpack_from("<I", payload, 1)[0] != 0:
                await self.send_close(0, R_EXTENSIONS)
                return
            major, minor, exts = self.parse_client_info(payload[5:])
            if major != VERSION[0]:
                await self.send_close(0, R_EXTENSIONS)
                return
            ok = self.check_password(exts)
            if ok is not True:
                self.log(1, "authentication failed")
                await self.send_close(0, ok)
                return
            self.client_extensions = set(exts)
            await self.send(packet(CONTINUE, 0, struct.pack("<I", BUFFER_PACKETS)))
            while True:
                opcode, payload = await self.read_binary()
                if len(payload) < 5:
                    continue
                ptype, sid = struct.unpack_from("<BI", payload, 0)
                body = payload[5:]
                if ptype == CONNECT:
                    if len(body) < 3:
                        await self.send_close(sid, R_INVALID)
                        continue
                    stype, port = struct.unpack_from("<BH", body, 0)
                    try:
                        host = body[3:].decode("utf-8")
                    except UnicodeDecodeError:
                        await self.send_close(sid, R_INVALID)
                        continue
                    admitted = self.admit(sid, stype, port, host)
                    if isinstance(admitted, int):
                        self.write_raw(encode_frame(OP_BINARY, packet(CLOSE, sid, bytes([admitted]))))
                    else:
                        task = asyncio.ensure_future(self.open_stream(admitted))
                        self.opening.add(task)
                        task.add_done_callback(lambda t: (self.opening.discard(t), t.cancelled() or t.exception()))
                elif ptype == DATA:
                    stream = self.streams.get(sid)
                    if stream is None or stream.closed:
                        continue
                    if (stream.queue.qsize() >= BUFFER_PACKETS or stream.pending + len(body) > MAX_STREAM_BUFFER
                            or self.pending + len(body) > MAX_CONN_BUFFER):
                        # The client ignored its buffer count, or is sending faster than the site takes it
                        # (or before the site socket exists): the stream is unusable. Bytes, not packets,
                        # are what memory is made of.
                        await self.close_stream(stream, R_NETWORK, tell_client=True)
                        continue
                    stream.pending += len(body)
                    self.pending += len(body)
                    stream.queue.put_nowait(body)
                elif ptype == CLOSE:
                    stream = self.streams.get(sid)
                    if stream is not None:
                        await self.close_stream(stream, R_VOLUNTARY, tell_client=False)
                # CONTINUE from a client is meaningless; INFO after the handshake is ignored.
        except (asyncio.IncompleteReadError, ConnectionError, WebSocketClosed, asyncio.TimeoutError, ValueError, OSError):
            pass
        finally:
            reaper.cancel()
            for task in list(self.opening):
                task.cancel()
            for stream in list(self.streams.values()):
                await self.close_stream(stream, R_NETWORK, tell_client=False)

    async def on_control(self, opcode, payload):
        """A control frame: pings answered, a close frame ends the session, pongs ignored."""
        if opcode == OP_CLOSE:
            try:
                async with self.send_lock:
                    self.write_raw(encode_frame(OP_CLOSE, payload[:2]))
                    await self.writer.drain()
            except (ConnectionError, OSError):
                pass
            raise WebSocketClosed("client closed")
        if opcode == OP_PING:
            async with self.send_lock:
                self.write_raw(encode_frame(OP_PONG, payload))
                await self.writer.drain()

    async def read_binary(self):
        """The next binary message (control frames, even between fragments, go to on_control)."""
        while True:
            opcode, payload = await read_message(self.reader, self.on_control)
            if opcode == OP_BINARY:
                return opcode, payload
            # text and pong: not part of Wisp


class Relay:
    def __init__(self, args):
        self.args = args
        self.per_ip = {}
        self.connections = 0
        self.trusted = [ipaddress.ip_network(t, strict=False) for t in args.trusted_proxy]
        self.lookups = concurrent.futures.ThreadPoolExecutor(args.max_lookups, thread_name_prefix="lookup")
        self.lookups_busy = 0

    def take_lookup_slot(self, connection):
        """A function that gives the slot back, or None when this WebSocket or the relay is at its cap."""
        a = self.args
        if connection.lookups >= a.max_lookups_per_connection or self.lookups_busy >= a.max_lookups:
            return None
        connection.lookups += 1
        self.lookups_busy += 1

        def give_back():
            connection.lookups -= 1
            self.lookups_busy -= 1
        return give_back

    def client_of(self, peer_ip, headers):
        """(the client's address as text, the key its limits are counted under). The peer is the client
        unless it is a trusted proxy, in which case it is the rightmost X-Forwarded-For entry that is
        not itself a trusted proxy (what a client sends to the left of that is only a claim)."""
        ip = parse_peer(peer_ip)
        if ip is None:
            return peer_ip, peer_ip
        if self.trusted and any(ip in net for net in self.trusted) and headers.get("x-forwarded-for"):
            entries = [e for e in headers["x-forwarded-for"].split(",") if e.strip()]
            for entry in reversed(entries):
                forwarded = parse_peer(entry)
                if forwarded is None:
                    break                      # garbage: fall back to the proxy's own address
                ip = forwarded
                if not any(forwarded in net for net in self.trusted):
                    break
        return str(ip), client_key(ip, self.args.ipv6_prefix)

    def log(self, level, text):
        if self.args.log_level >= level:
            try:
                print(time.strftime("%Y-%m-%dT%H:%M:%S ") + text, flush=True)
            except OSError:
                pass  # whoever read our output has gone (a test runner): the relay carries on

    async def serve(self, reader, writer):
        peer = writer.get_extra_info("peername")
        peer_ip = peer[0] if peer else "?"
        connection = None
        key = peer_ip
        reserved = False
        try:
            request = (await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)).decode("latin-1")
            lines = request.split("\r\n")
            parts = lines[0].split(" ")
            target = parts[1] if len(parts) > 1 else "/"
            headers = {}
            for line in lines[1:]:
                if ":" in line:
                    name, value = line.split(":", 1)
                    headers[name.strip().lower()] = value.strip()
            origin = headers.get("origin", "")
            if "sec-websocket-key" not in headers:
                if target == "/healthz":
                    body = b"ok\n"
                    writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nContent-Length: "
                                 + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body)
                else:
                    body = b"This is a Chitin relay (Wisp v2). Nothing to see here.\n"
                    writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: "
                                 + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body)
                await writer.drain()
                return
            if origin not in self.args.origins:
                self.log(1, "%s refused: origin %r" % (peer_ip, origin))
                writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                await writer.drain()
                return
            # Wisp v2 requires the subprotocol header to be present (its value is unspecified). It is echoed
            # in the reply, so it must be a list of RFC 7230 tokens: a bare LF in it (the request is split on
            # CRLF only) would otherwise end up as a header line of the relay's own response.
            protocol = headers.get("sec-websocket-protocol", "")
            if not protocol or not PROTOCOL_LIST.match(protocol):
                writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                await writer.drain()
                return
            peer_ip, key = self.client_of(peer_ip, headers)
            if self.connections >= self.args.max_connections:
                self.log(1, "%s refused: relay full (%d connections)" % (peer_ip, self.connections))
                writer.write(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                await writer.drain()
                return
            if self.per_ip.get(key, 0) >= self.args.max_conns_per_ip:
                self.log(1, "%s refused: too many connections" % peer_ip)
                writer.write(b"HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                await writer.drain()
                return
            # Reserve the place before the next await, or a burst of handshakes all pass the checks above.
            self.per_ip[key] = self.per_ip.get(key, 0) + 1
            self.connections += 1
            reserved = True
            accept = base64.b64encode(hashlib.sha1(headers["sec-websocket-key"].encode() + WS_GUID).digest())
            chosen = protocol.split(",")[0].strip().encode("latin-1")
            writer.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                         b"Sec-WebSocket-Accept: " + accept + b"\r\nSec-WebSocket-Protocol: " + chosen + b"\r\n\r\n")
            await writer.drain()
            writer.transport.set_write_buffer_limits(high=WS_WRITE_HIGH)
            if TEST_SNDBUF:
                writer.get_extra_info("socket").setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, TEST_SNDBUF)
            connection = Connection(self, reader, writer, peer_ip, origin)
            self.log(1, "%s open (%s), %d connection(s)" % (peer_ip, origin, self.connections))
            await connection.run()
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError, ConnectionError, OSError,
                UnicodeDecodeError):
            pass    # LimitOverrunError: a request head past the stream limit (an uncaught one logged a traceback each)
        finally:
            if reserved:
                self.connections -= 1
                self.per_ip[key] -= 1
                if self.per_ip[key] <= 0:
                    del self.per_ip[key]
            if connection is not None:
                self.log(1, "%s closed after %.0f s: %d stream(s), %d bytes to sites, %d from them" % (
                    peer_ip, time.monotonic() - connection.opened, connection.stream_total,
                    connection.bytes_out + sum(s.bytes_out for s in connection.streams.values()),
                    connection.bytes_in + sum(s.bytes_in for s in connection.streams.values())))
            writer.close()


def parse_args(argv):
    p = argparse.ArgumentParser(description="The Chitin relay: a Wisp v2 server with safe defaults.",
                                formatter_class=argparse.RawDescriptionHelpFormatter,
                                epilog="Read relay/README.md before running one for anyone but yourself.")
    p.add_argument("--bind", default=os.environ.get("RELAY_BIND", "127.0.0.1"), help="address to listen on (default 127.0.0.1; 0.0.0.0 in the container)")
    p.add_argument("--port", type=int, default=int(os.environ.get("RELAY_PORT", "8101")))
    p.add_argument("--origin", action="append", help="a web origin allowed to connect; repeatable (default: http://localhost:8100 and http://127.0.0.1:8100)")
    p.add_argument("--token", default=os.environ.get("RELAY_TOKEN"), help="shared secret clients must send (Wisp password authentication); prefer --token-file or RELAY_TOKEN")
    p.add_argument("--token-file", help="file holding the shared secret")
    p.add_argument("--port-allow", default=os.environ.get("RELAY_PORTS", "80,443"), help="destination ports allowed, comma-separated (default 80,443)")
    p.add_argument("--host-allow", action="append", default=[], metavar="PATTERN", help="a destination host the relay may connect to: a name (en.wikipedia.org), a subdomain wildcard (*.wikimedia.org) or * for anything; repeatable, or RELAY_HOSTS comma-separated. Required: with none the relay refuses to start unless --allow-any-host is given")
    p.add_argument("--allow-any-host", action="store_true", help="OPEN PROXY TO THE INTERNET (still ports and address ranges limited): accept every destination host. Only for a relay you run for yourself")
    p.add_argument("--block", action="append", default=[], help="an extra CIDR never connected to (your own ranges); repeatable")
    p.add_argument("--own-address", action="append", default=[], metavar="ADDR", help="this relay's public IP address or CIDR, so it cannot be used to reach itself or other services on its address; repeatable (the machine's interface addresses are blocked automatically; --no-block-local turns that off)")
    p.add_argument("--no-block-local", action="store_true", help="do not block this machine's interface addresses automatically")
    p.add_argument("--allow-private", action="store_true", help="DEVELOPMENT ONLY: allow private and loopback destinations (tests against a local server)")
    p.add_argument("--max-streams", type=int, default=64, help="open streams per WebSocket (default 64)")
    p.add_argument("--max-connects-per-minute", type=int, default=120, help="CONNECTs per WebSocket per minute (default 120)")
    p.add_argument("--max-conns-per-ip", type=int, default=8, help="WebSockets per client address (default 8)")
    p.add_argument("--max-lookups-per-connection", type=int, default=4, help="name lookups in flight per WebSocket (default 4); more wait for a slot (up to 10 s, then 0x49), and CONNECTs to a name already being looked up share that lookup")
    p.add_argument("--max-lookups", type=int, default=32, help="name lookups in flight over all WebSockets (default 32, also the size of the lookup thread pool)")
    p.add_argument("--max-connections", type=int, default=512, help="WebSockets over all clients (default 512)")
    p.add_argument("--trusted-proxy", action="append", default=[], metavar="ADDR", help="a reverse proxy's address or CIDR whose X-Forwarded-For is believed (rightmost entry that is not a trusted proxy); repeatable. Without it every client behind a proxy shares the proxy's address and its limit")
    p.add_argument("--ipv6-prefix", type=int, default=64, help="IPv6 clients are counted per this prefix length (default 64)")
    p.add_argument("--conn-idle-timeout", type=float, default=120.0, help="seconds a WebSocket may have no open stream before it is closed (default 120)")
    p.add_argument("--max-write-buffer", type=int, default=8 << 20, help="bytes queued towards a client that is not reading before its WebSocket is dropped (default 8 MiB)")
    p.add_argument("--max-kbps", type=int, default=8192, help="KiB per second per WebSocket, both directions together (default 8192, about 64 Mbit/s; 0 is unlimited)")
    p.add_argument("--scan-hosts-per-minute", type=int, default=60, help="distinct destination hosts per minute before throttling (default 60)")
    p.add_argument("--scan-failures-per-minute", type=int, default=20, help="failed connects per minute before throttling (default 20)")
    p.add_argument("--connect-timeout", type=float, default=15.0, help="seconds for a stream's connect over all its addresses (default 15)")
    p.add_argument("--attempt-timeout", type=float, default=5.0, help="seconds per address before the next one is tried (default 5)")
    p.add_argument("--idle-timeout", type=float, default=300.0, help="seconds a stream may carry nothing before it is closed (default 300)")
    p.add_argument("--motd", default=None, help="message shown to clients (default: the limits in force)")
    p.add_argument("--tls-cert", help="serve wss:// directly with this certificate (else put a reverse proxy in front)")
    p.add_argument("--tls-key")
    p.add_argument("--log", dest="log_level", type=int, default=1, help="0 nothing, 1 connections (default), 2 streams too (destination host:port, bytes, duration; never content)")
    args = p.parse_args(argv)
    args.origins = set(args.origin or ["http://localhost:8100", "http://127.0.0.1:8100"])
    if args.token_file:
        with open(args.token_file) as f:
            args.token = f.read().strip()
    if args.token == "":
        args.token = None
    args.host_allow = [normalize_host(x) for x in args.host_allow + os.environ.get("RELAY_HOSTS", "").split(",") if x.strip()]
    if args.allow_any_host or os.environ.get("RELAY_ALLOW_ANY_HOST") == "1":
        args.host_allow = ["*"]
    if not args.host_allow:
        p.error("no destinations allowed: give --host-allow PATTERN (or RELAY_HOSTS) for the hosts this relay may reach; --allow-any-host opens it to the internet")
    args.port_allow = {int(x) for x in args.port_allow.split(",") if x.strip()}
    own = list(args.own_address) + ([] if args.no_block_local else local_addresses())
    args.trusted_proxy = [str(ipaddress.ip_network(t, strict=False)) for t in args.trusted_proxy]
    args.block = [ipaddress.ip_network(b, strict=False) for b in list(args.block) + own]
    if args.motd is None:
        args.motd = ("Chitin relay. Ports %s. Up to %d streams and %d new connections a minute per session. "
                     "Private and local addresses are refused. Bandwidth: %s. Logs: metadata only." % (
                         ",".join(str(x) for x in sorted(args.port_allow)), args.max_streams, args.max_connects_per_minute,
                         "unlimited" if not args.max_kbps else "%d KiB/s per WebSocket" % args.max_kbps))
    return args


async def main(argv):
    args = parse_args(argv)
    relay = Relay(args)
    tls = None
    if args.tls_cert:
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(args.tls_cert, args.tls_key)
    server = await asyncio.start_server(relay.serve, args.bind, args.port, ssl=tls, limit=MAX_WS_MESSAGE + 64)
    scheme = "wss" if tls else "ws"
    port = server.sockets[0].getsockname()[1] if server.sockets else args.port   # --port 0 asks the OS
    print("Chitin relay on %s://%s:%d/ for %s" % (scheme, args.bind, port, ", ".join(sorted(args.origins))), flush=True)
    print("  ports %s; %s; token %s; streams/session %d; bandwidth %s; log level %d" % (
        ",".join(str(x) for x in sorted(args.port_allow)),
        "PRIVATE AND LOOPBACK DESTINATIONS ALLOWED (development only)" if args.allow_private else "private ranges refused",
        "required" if args.token else "NONE: anyone who can read the page source can use this relay; the Origin check only stops other websites in a browser, it is not access control",
        args.max_streams, "unlimited" if not args.max_kbps else "%d KiB/s per WebSocket" % args.max_kbps, args.log_level), flush=True)
    print("  extra blocked ranges: %s (plus the built-in private and special-purpose list, including the Azure platform address 168.63.129.16)"
          % (", ".join(str(n) for n in args.block) or "none"), flush=True)
    print("  destinations: %s" % ("ANY HOST (open proxy to the internet)" if "*" in args.host_allow else ", ".join(args.host_allow)), flush=True)
    print("  You are the operator and responsible for the traffic that leaves this machine: relay/README.md.", flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main(sys.argv[1:]))
    except KeyboardInterrupt:
        pass
