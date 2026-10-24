import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
// The protocol cases of packages/wisp/test/server.test.js, run against the C++ server. Changes from
// the original are marked "C++:" (a custom `connect` becomes `egress`, server internals become the
// test-build stats endpoints, construction errors become command-line errors).
import { spawnSync } from 'node:child_process';
import { WispClient } from '../../wisp/src/client.js';
import { R, CONTINUE, DATA } from '../../wisp/src/protocol.js';
import { startEcho, connect, openStream, sleep, total, asOrigin, BrowserLike, ORIGIN, TOKEN } from '../../wisp/testlib/helpers.js';
import { startCppRelay as startRelay, BINARY, TLS } from './cpp-relay.js';
// raw-TCP cases speak plain HTTP to the relay: skipped when it serves wss:// (WISP_CPP_TLS=1)
const rawTest = TLS ? test.skip : test;

let echo, dev, strict;
before(async () => {
  echo = await startEcho();
  dev = await startRelay({ hostAllow: ['*'], allowPrivate: true, portAllow: [80, 443, echo.port], token: TOKEN });
  strict = await startRelay({ hostAllow: ['*'], portAllow: [80, 443, echo.port] });
});
after(async () => { await dev.close(); await strict.close(); echo.close(); });

test('handshake with a token, MOTD, and an echo through a stream', async () => {
  const wisp = await connect(dev, { token: TOKEN });
  assert.ok(wisp.connected);
  assert.match(wisp.motd, /Wisp relay/);
  const { stream, opened, received } = openStream(wisp, '127.0.0.1', echo.port);
  await opened;
  stream.write(new TextEncoder().encode('hello relay'));
  await sleep(100);
  assert.equal(Buffer.concat(received).toString(), 'hello relay');
  stream.close();
  wisp.close();
});

test('data written before the socket is confirmed is held and delivered in order', async () => {
  const wisp = await connect(dev, { token: TOKEN });
  const { stream, received } = openStream(wisp, '127.0.0.1', echo.port);
  stream.write(new TextEncoder().encode('one '));
  stream.write(new TextEncoder().encode('two'));
  for (let i = 0; i < 40 && total(received) < 7; i++) await sleep(25);
  assert.equal(Buffer.concat(received).toString(), 'one two');
  wisp.close();
});

test('flow control: more packets than the relay buffers all arrive', async () => {
  const wisp = await connect(dev, { token: TOKEN });
  const { stream, opened, received } = openStream(wisp, '127.0.0.1', echo.port);
  await opened;
  const chunk = new Uint8Array(1000).fill(7);
  for (let i = 0; i < 400; i++) stream.write(chunk);
  for (let i = 0; i < 100 && total(received) < 400000; i++) await sleep(50);
  assert.equal(total(received), 400000);
  wisp.close();
});

test('the wrong token is refused with 0xc0, a missing one with 0xc2', async () => {
  await assert.rejects(new WispClient({ url: dev.url, token: 'nope', WebSocket: BrowserLike }).connect(), /refused the token/);
  await assert.rejects(new WispClient({ url: dev.url, WebSocket: BrowserLike }).connect(), /requires a token/);
});

test('a foreign origin, and a missing origin, get 403 before the upgrade', async () => {
  await assert.rejects(new WispClient({ url: dev.url, token: TOKEN, WebSocket: asOrigin('https://evil.example') }).connect(), /unreachable|closed/);
  await assert.rejects(new WispClient({ url: dev.url, token: TOKEN, WebSocket: asOrigin('') }).connect(), /unreachable|closed/);
});

test("origins ['*'] and [''] are explicit opt-ins", async () => {
  const any = await startRelay({ hostAllow: ['*'], origins: ['*'] });
  const none = await startRelay({ hostAllow: ['*'], origins: [''] });
  try {
    await (await connect(any, { WebSocket: asOrigin('https://whatever.example') })).close();
    await (await connect(none, { WebSocket: asOrigin('') })).close();
  } finally { await any.close(); await none.close(); }
});


test('C++: configuration errors stop the process (no origins, no destination list)', () => {
  const run = (...args) => spawnSync(BINARY, args, { encoding: 'utf8' });
  let r = run('--host-allow', '*');
  assert.equal(r.status, 2); assert.match(r.stderr, /origins/);
  r = run('--origin', '*');
  assert.equal(r.status, 2); assert.match(r.stderr, /no destinations allowed/);
  r = run('--origin', '*', '--host-allow', '*', '--tls-cert', 'x');
  assert.equal(r.status, 2); assert.match(r.stderr, /no TLS|TLS: certificate x/); // plain builds refuse --tls-*, TLS builds the missing file
});

rawTest('a plain HTTP request gets /healthz ok and 404 for the rest', async () => {
  const get = (path) => new Promise((resolve) => http.get({ port: dev.port, host: '127.0.0.1', path }, (res) => {
    let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve([res.statusCode, body]));
  }));
  assert.deepEqual(await get('/healthz'), [200, 'ok\n']);
  assert.equal((await get('/'))[0], 404);
});

test('a port outside the allowlist is blocked (0x48)', async () => {
  const wisp = await connect(dev, { token: TOKEN });
  const { closed } = openStream(wisp, '127.0.0.1', 25);
  assert.equal((await closed).code, R.BLOCKED);
  wisp.close();
});

test('a UDP stream is invalid (0x41)', async () => {
  const wisp = await connect(dev, { token: TOKEN });
  const code = await new Promise((res) => {
    const t = wisp.open('127.0.0.1', echo.port, { onClose: (c) => res(c) });
    const name = new TextEncoder().encode('127.0.0.1');
    const raw = new Uint8Array(5 + 3 + name.length);
    raw[0] = 1;
    new DataView(raw.buffer).setUint32(1, t.id, true);
    raw[5] = 2; // UDP
    new DataView(raw.buffer).setUint16(6, echo.port, true);
    raw.set(name, 8);
    wisp._send(raw);
  });
  assert.equal(code, R.INVALID);
  wisp.close();
});

test('SSRF: with the shipped defaults loopback, private and metadata destinations are blocked (0x48), a bad name is unreachable (0x42)', async () => {
  const wisp = await connect(strict);
  for (const host of ['127.0.0.1', 'localhost', '[::1]', '10.0.0.1', '192.168.1.1', '169.254.169.254', '172.16.0.1', '100.64.0.1', '::ffff:127.0.0.1', 'fd00::1']) {
    const r = openStream(wisp, host, echo.port);
    assert.equal((await r.closed).code, R.BLOCKED, host);
  }
  // obfuscated spellings are names to the checker; the resolver turns them into 127.0.0.1 and that is what is refused
  for (const host of ['2130706433', '0x7f.1', '127.1']) {
    const r = openStream(wisp, host, echo.port);
    const { code } = await r.closed;
    assert.ok(code === R.BLOCKED || code === R.UNREACHABLE || code === R.INVALID, `${host} -> 0x${code.toString(16)}`);
    assert.equal(r.received.length, 0);
  }
  const c = openStream(wisp, 'no-such-host.invalid', 443);
  assert.equal((await c.closed).code, R.UNREACHABLE);
  wisp.close();
});

test('rebinding: the server connects to the address it checked, never to the name again', async () => {
  let lookups = 0;
  const lookup = async (host) => {
    lookups++;
    // the first answer is public; any later one would be the rebinding payload
    return lookups === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }];
  };
  const relay = await startRelay({ hostAllow: ['rebind.example'], lookup, egress: echo.port, portAllow: [443] }); // C++: egress
  try {
    const wisp = await connect(relay);
    const r = openStream(wisp, 'rebind.example', 443);
    await r.opened;
    assert.deepEqual(await relay.connects(), ['93.184.216.34']);
    assert.equal(lookups, 1);
    wisp.close();
  } finally { await relay.close(); }
});

test('rebinding: a name that resolves to a private address, alone or mixed with a public one, never reaches a private socket', async () => {
  const answers = {
    'bad.example': ['10.0.0.5'], 'meta.example': ['169.254.169.254'],
    'mixed.example': ['127.0.0.1', '93.184.216.34'],
  };
  const lookup = async (h) => answers[h].map((address) => ({ address, family: 4 }));
  const relay = await startRelay({ hostAllow: ['*'], lookup, portAllow: [443], egress: echo.port }); // C++: egress
  try {
    const wisp = await connect(relay);
    assert.equal((await openStream(wisp, 'bad.example', 443).closed).code, R.BLOCKED);
    assert.equal((await openStream(wisp, 'meta.example', 443).closed).code, R.BLOCKED);
    const m = openStream(wisp, 'mixed.example', 443);
    await m.opened;
    assert.deepEqual(await relay.connects(), ['93.184.216.34']);
    wisp.close();
  } finally { await relay.close(); }
});

test('the site closing its end closes the stream (0x02)', async () => {
  const closer = net.createServer((s) => s.end('bye'));
  await new Promise((r) => closer.listen(0, '127.0.0.1', r));
  const port = closer.address().port;
  const relay = await startRelay({ hostAllow: ['*'], allowPrivate: true, portAllow: [port] });
  try {
    const wisp = await connect(relay);
    const { closed, received } = openStream(wisp, '127.0.0.1', port);
    assert.equal((await closed).code, R.VOLUNTARY);
    assert.equal(Buffer.concat(received).toString(), 'bye');
    wisp.close();
  } finally { await relay.close(); closer.close(); }
});

test('a refused connection is 0x44', async () => {
  const tmp = net.createServer(); await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
  const port = tmp.address().port; await new Promise((r) => tmp.close(r));
  const relay = await startRelay({ hostAllow: ['*'], allowPrivate: true, portAllow: [port] });
  try {
    const wisp = await connect(relay);
    assert.equal((await openStream(wisp, '127.0.0.1', port).closed).code, R.REFUSED);
    wisp.close();
  } finally { await relay.close(); }
});

test('allowlist: listed names and wildcards connect; everything else is refused (0x48) before resolution', async () => {
  let lookups = 0;
  const relay = await startRelay({
    allowPrivate: true, portAllow: [echo.port], hostAllow: ['127.0.0.1', '*.Allowed.example'],
    lookup: async () => { lookups++; throw new Error('ENOTFOUND'); },
  });
  try {
    const wisp = await connect(relay);
    const ok = openStream(wisp, '127.0.0.1', echo.port);
    await ok.opened;
    ok.stream.close();
    for (const host of ['localhost', 'allowed.example', 'evil.example', 'allowed.example.evil.example', 'xallowed.example', '[::1]',
      'x.allowed.example@evil.example', 'evil.example#.allowed.example', 'evil.example/.allowed.example', '127.0.0.2']) {
      assert.notEqual((await openStream(wisp, host, echo.port).closed).code, 0, host);
    }
    assert.equal(lookups, 0, 'nothing off the list was ever resolved');
    // wildcard match reaches resolution (this lookup fails: unreachable, not blocked)
    const w = openStream(wisp, 'www.ALLOWED.example.', echo.port);
    assert.equal((await w.closed).code, R.UNREACHABLE);
    assert.equal(lookups, 1);
    wisp.close();
  } finally { await relay.close(); }
});

test('allowlist bypass: a literal IP never matches a name pattern even when allowPrivate is off', async () => {
  const relay = await startRelay({ hostAllow: ['*.0.0.1', '*.1'], portAllow: [echo.port] });
  try {
    const wisp = await connect(relay);
    for (const host of ['127.0.0.1', '10.0.0.1', '1.1.1.1']) assert.equal((await openStream(wisp, host, echo.port).closed).code, R.BLOCKED, host);
    wisp.close();
  } finally { await relay.close(); }
});

test('limits: stream cap and per-minute connects answer 0x49', async () => {
  const relay = await startRelay({ hostAllow: ['*'], allowPrivate: true, portAllow: [echo.port], maxStreams: 2, maxConnectsPerMinute: 3 });
  try {
    const wisp = await connect(relay);
    const a = openStream(wisp, '127.0.0.1', echo.port); await a.opened;
    const b = openStream(wisp, '127.0.0.1', echo.port); await b.opened;
    assert.equal((await openStream(wisp, '127.0.0.1', echo.port).closed).code, R.THROTTLED, 'third stream');
    a.stream.close(); b.stream.close(); await sleep(50);
    const c = openStream(wisp, '127.0.0.1', echo.port); await c.opened; c.stream.close(); await sleep(30);
    // 3 admitted connects so far in this minute: the next is refused
    assert.equal((await openStream(wisp, '127.0.0.1', echo.port).closed).code, R.THROTTLED);
    wisp.close();
  } finally { await relay.close(); }
});

test('limits: scan-like behaviour (many distinct hosts) throttles the session', async () => {
  const relay = await startRelay({
    hostAllow: ['*'], portAllow: [443], scanHostsPerMinute: 3,
    lookup: async () => { const e = new Error('x'); throw e; },
  });
  try {
    const wisp = await connect(relay);
    for (const h of ['a.example', 'b.example', 'c.example']) assert.equal((await openStream(wisp, h, 443).closed).code, R.UNREACHABLE);
    assert.equal((await openStream(wisp, 'd.example', 443).closed).code, R.THROTTLED);
    assert.equal((await openStream(wisp, 'a.example', 443).closed).code, R.THROTTLED, 'and it stays throttled');
    wisp.close();
  } finally { await relay.close(); }
});

test('limits: WebSockets per client address', async () => {
  const relay = await startRelay({ hostAllow: ['*'], maxConnsPerIp: 2 });
  try {
    const a = await connect(relay), b = await connect(relay);
    await assert.rejects(new WispClient({ url: relay.url, WebSocket: BrowserLike }).connect());
    a.close(); await sleep(100);
    (await connect(relay)).close(); b.close();
  } finally { await relay.close(); }
});

rawTest('a malformed or unmasked client frame ends the session', async () => {
  const sock = net.connect(dev.port, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  sock.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: wisp-v2\r\nOrigin: ${ORIGIN}\r\n\r\n`);
  let out = Buffer.alloc(0);
  sock.on('data', (d) => { out = Buffer.concat([out, d]); });
  await sleep(100);
  assert.match(out.toString('latin1'), /101 Switching Protocols/);
  assert.match(out.toString('latin1'), /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/); // RFC 6455 example
  sock.write(Buffer.from([0x82, 0x05, 1, 2, 3, 4, 5])); // unmasked
  await new Promise((r) => sock.once('close', r));
});

rawTest('a client that never sends INFO is dropped; wrong major version is refused', async () => {
  const sock = net.connect(dev.port, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  sock.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: wisp-v2\r\nOrigin: ${ORIGIN}\r\n\r\n`);
  // masked binary frame with INFO major 1: 05 00000000 | 01 01
  const payload = Buffer.from([5, 0, 0, 0, 0, 1, 1]);
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
  sock.write(Buffer.concat([Buffer.from([0x82, 0x80 | payload.length]), mask, masked]));
  let out = Buffer.alloc(0);
  sock.on('data', (d) => { out = Buffer.concat([out, d]); });
  await new Promise((r) => sock.once('close', r));
  // the last frame sent is CLOSE (type 4) on stream 0 with reason 0x04 (incompatible extensions)
  const text = out.toString('latin1');
  assert.ok(text.includes('\x82\x06\x04\x00\x00\x00\x00\x04'), 'CLOSE 0x04 on stream 0');
});

test('finding 4: a stream to the relay\'s own configured address, or to Azure WireServer, is blocked (0x48)', async () => {
  const relay = await startRelay({ hostAllow: ['*'], portAllow: [80, 443], ownAddresses: ['8.8.4.4'] });
  try {
    const wisp = await connect(relay);
    for (const host of ['8.8.4.4', '168.63.129.16']) assert.equal((await openStream(wisp, host, 80).closed).code, R.BLOCKED, host);
    wisp.close();
  } finally { await relay.close(); }
});

test('finding 3: more concurrent name lookups than maxConcurrentLookups on one connection are throttled (0x49)', async () => {
  const relay = await startRelay({ hostAllow: ['*'], portAllow: [443], maxConcurrentLookups: 2, lookup: () => new Promise(() => {}) });
  try {
    const wisp = await connect(relay);
    openStream(wisp, 'a.example', 443); openStream(wisp, 'b.example', 443);
    await sleep(50);
    assert.equal((await openStream(wisp, 'c.example', 443).closed).code, R.THROTTLED);
    wisp.close();
  } finally { await relay.close(); }
});

// ---- review finding 2: stream-id reuse must not orphan sockets ----------------------------------
const rawConnect = (wisp, id, host, port) => {
  const name = new TextEncoder().encode(host);
  const raw = new Uint8Array(5 + 3 + name.length);
  raw[0] = 1;
  new DataView(raw.buffer).setUint32(1, id, true);
  raw[5] = 1;
  new DataView(raw.buffer).setUint16(6, port, true);
  raw.set(name, 8);
  wisp._send(raw);
};
const rawClose = (wisp, id) => {
  const raw = new Uint8Array(6);
  raw[0] = 4;
  new DataView(raw.buffer).setUint32(1, id, true);
  raw[5] = 0x02;
  wisp._send(raw);
};
const rawData = (wisp, id, bytes) => {
  const raw = new Uint8Array(5 + bytes.length);
  raw[0] = 2;
  new DataView(raw.buffer).setUint32(1, id, true);
  raw.set(bytes, 5);
  wisp._send(raw);
};

async function startCountingSink({ read = true } = {}) {
  const sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => {});
    if (read) s.on('data', (d) => { sink.bytes += d.length; }); else s.pause();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const sink = { bytes: 0, sockets, port: server.address().port, close: () => { for (const s of sockets) s.destroy(); server.close(); } };
  return sink;
}

test('finding 2: close-then-reuse of a stream id cannot orphan sockets, and every socket closes with the connection', async () => {
  const sink = await startCountingSink();
  const lookup = async (host) => {
    if (host === 'slow.example') { await sleep(250); throw new Error('ENOTFOUND'); }
    return [{ address: '93.184.216.34', family: 4 }];
  };
  const relay = await startRelay({ hostAllow: ['*'], portAllow: [443], maxStreams: 4, lookup, egress: sink.port });
  try {
    const wisp = await connect(relay);
    for (let id = 1; id <= 10; id++) {
      rawConnect(wisp, id, 'slow.example', 443);
      rawClose(wisp, id);
      rawConnect(wisp, id, 'good.example', 443);
    }
    await sleep(700);
    assert.ok(sink.sockets.size <= 4, `maxStreams 4 but ${sink.sockets.size} outbound sockets are open`);
    wisp.close();
    await sleep(300);
    assert.equal(sink.sockets.size, 0, 'all site sockets closed when the connection ended');
    assert.equal(await relay.connections(), 0);
  } finally { await relay.close(); sink.close(); }
});

const within = (p, ms = 3000) => Promise.race([p, sleep(ms).then(() => ({ code: 'still open' }))]);

// ---- review finding 1: byte caps and credit only after flush ---------------------------------------
// The credit is in packets and the caps in bytes: a client within its credit can pass a byte cap
// (128 packets of 50 KiB > 4 MiB; wisp-mux's simple-wisp-client does). It is not reset for that: the
// relay stops reading its socket until the bytes flush (TCP backpressure), so memory stays at the cap
// plus one message. A client beyond its credit is still reset (R2 in invariants.test.js).
test('finding 1: data sent before the site socket exists is held at the byte cap by backpressure, then delivered', async () => {
  const sink = await startCountingSink();
  const relay = await startRelay({ hostAllow: ['*'], portAllow: [443], maxStreamBuffer: 256 << 10, lookup: async () => { await sleep(600); return [{ address: '93.184.216.34', family: 4 }]; },
    egress: sink.port });
  try {
    const wisp = await connect(relay);
    const r = openStream(wisp, 'slow.example', 443);
    for (let i = 0; i < 8; i++) rawData(wisp, r.stream.id, new Uint8Array(100 << 10)); // 800 KiB in 8 packets, far under the 128-packet count
    const closed = await within(r.closed, 2500);
    assert.equal(closed.code, 'still open', 'a client within its credit is not reset');
    assert.equal(sink.bytes, 800 << 10, 'every byte reached the site');
    wisp.close();
  } finally { await relay.close(); sink.close(); }
});

test('finding 1: the per-connection byte cap spans streams (backpressure, nothing lost)', async () => {
  const sink = await startCountingSink();
  const relay = await startRelay({ hostAllow: ['*'], portAllow: [443], maxStreamBuffer: 1 << 20, maxConnectionBuffer: 256 << 10,
    lookup: async () => { await sleep(600); return [{ address: '93.184.216.34', family: 4 }]; }, egress: sink.port });
  try {
    const wisp = await connect(relay);
    const rs = [1, 2, 3, 4].map((i) => openStream(wisp, `s${i}.example`, 443));
    for (const r of rs) rawData(wisp, r.stream.id, new Uint8Array(100 << 10)); // each stream is under its own cap, together over the connection's
    const first = await within(Promise.race(rs.map((r) => r.closed)), 2500);
    assert.equal(first.code, 'still open');
    assert.equal(sink.bytes, 400 << 10);
    wisp.close();
  } finally { await relay.close(); sink.close(); }
});

test('finding 1: a destination that never reads cannot make the relay buffer without limit', async () => {
  const sink = await startCountingSink({ read: false });
  const relay = await startRelay({ hostAllow: ['*'], portAllow: [443], maxStreamBuffer: 256 << 10, maxKbps: 0, idleTimeout: 1.5, reapInterval: 200,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }], egress: sink.port });
  try {
    const wisp = await connect(relay);
    const r = openStream(wisp, 'sink.example', 443);
    await r.opened;
    let closed = false;
    r.closed.then(() => { closed = true; });
    const chunk = new Uint8Array(64 << 10);
    // within credit: the relay stops reading this client at the cap; beyond credit it resets the
    // stream; either way the stream ends (credit violation or idle) and memory stays bounded
    for (let i = 0; i < 4000 && !closed; i++) { rawData(wisp, r.stream.id, chunk); if (i % 4 === 0) await sleep(1); }
    const end = await Promise.race([r.closed, sleep(6000).then(() => ({ code: 'still open' }))]);
    assert.ok([R.NETWORK, R.DATA_TIMEOUT ?? 0x47].includes(end.code), `ended: ${end.code}`);
    wisp.close();
  } finally { await relay.close(); sink.close(); }
});

test('finding 1: a large transfer through a well-behaved client still completes (credit returns after each flush)', async () => {
  const wisp = await connect(dev, { token: TOKEN });
  const { stream, opened, received } = openStream(wisp, '127.0.0.1', echo.port);
  await opened;
  const size = 4 << 20;
  for (let i = 0; i < 4; i++) stream.write(new Uint8Array(1 << 20).fill(i + 1)); // 1 MiB writes: the client splits them
  for (let i = 0; i < 400 && total(received) < size; i++) await sleep(25);
  assert.equal(total(received), size);
  wisp.close();
});

// ---- review finding 6: replies to a client that never reads ----------------------------------------
function rawWebSocket(port, origin = ORIGIN) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.on('error', () => {});
    let buf = '';
    s.on('data', function onData(d) {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) { s.off('data', onData); resolve(s); }
    });
    s.on('close', () => reject(new Error('closed during handshake: ' + buf.slice(0, 40))));
    s.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: wisp-v1\r\nOrigin: ${origin}\r\n\r\n`);
  });
}
const maskedPing = (() => {
  const payload = Buffer.alloc(125, 0x41);
  return Buffer.concat([Buffer.from([0x89, 0x80 | 125, 1, 2, 3, 4]), payload.map((b, i) => b ^ [1, 2, 3, 4][i & 3])]);
})();

rawTest('finding 6: a client that floods PINGs and never reads is disconnected once its reply buffer passes the cap', async () => {
  const relay = await startRelay({ hostAllow: ['*'], maxWriteBuffer: 256 << 10 });
  try {
    const s = await rawWebSocket(relay.port);
    s.pause();
    const burst = Buffer.concat(Array.from({ length: 5000 }, () => maskedPing)); // ~650 KB in, ~650 KB of PONGs out
    for (let i = 0; i < 60; i++) s.write(burst);
    await sleep(1500);
    assert.equal(await relay.connections(), 0, 'the relay dropped the connection instead of buffering replies');
    s.destroy();
  } finally { await relay.close(); }
});

// ---- review finding 5: per-IP limits ---------------------------------------------------------------

function upgrade(port, headers = {}) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.on('error', () => {});
    let buf = '';
    const done = () => resolve({ socket: s, status: Number(buf.slice(9, 12)) || 0 });
    s.on('data', (d) => { buf += d.toString('latin1'); if (buf.includes('\r\n\r\n')) { s.removeAllListeners('data'); done(); } });
    s.on('close', done);
    const extra = Object.entries({ Origin: ORIGIN, ...headers }).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    s.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: wisp-v1\r\n${extra}\r\n`);
  });
}

// C++: ipKey is covered by tests/test_units.cpp (ip_key)

rawTest('finding 5: X-Forwarded-For is ignored unless the peer is a trusted proxy (a client cannot pick its own key)', async () => {
  const relay = await startRelay({ hostAllow: ['*'], maxConnsPerIp: 2 });
  try {
    const open = [];
    const statuses = [];
    for (const xff of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) { const r = await upgrade(relay.port, { 'X-Forwarded-For': xff }); open.push(r.socket); statuses.push(r.status); }
    assert.deepEqual(statuses, [101, 101, 429]);
    for (const s of open) s.destroy();
  } finally { await relay.close(); }
});

rawTest('finding 5: behind a trusted proxy each client address gets its own limit, taken from the right of X-Forwarded-For', async () => {
  const relay = await startRelay({ hostAllow: ['*'], maxConnsPerIp: 1, trustedProxies: ['127.0.0.1', '::1'] });
  try {
    const open = [];
    const status = async (xff) => { const r = await upgrade(relay.port, { 'X-Forwarded-For': xff }); open.push(r.socket); return r.status; };
    assert.equal(await status('5.5.5.5, 1.2.3.4'), 101);
    assert.equal(await status('6.6.6.6, 1.2.3.4'), 429, 'the left-hand entry is client-supplied and does not choose the key');
    assert.equal(await status('7.7.7.7'), 101, 'another client is not locked out by the first');
    assert.equal(await status('2001:db8::1'), 101);
    assert.equal(await status('2001:db8::2'), 429, 'same /64');
    assert.equal(await status('9.9.9.9, 127.0.0.1'), 101, 'trusted hops on the right are skipped');
    for (const s of open) s.destroy();
  } finally { await relay.close(); }
});

rawTest('finding 5: a global connection cap refuses the connection that would exceed it (503)', async () => {
  const relay = await startRelay({ hostAllow: ['*'], maxConnsPerIp: 10, maxConnections: 2 });
  try {
    const open = [];
    const statuses = [];
    for (let i = 0; i < 3; i++) { const r = await upgrade(relay.port); open.push(r.socket); statuses.push(r.status); }
    assert.deepEqual(statuses, [101, 101, 503]);
    for (const s of open) s.destroy();
  } finally { await relay.close(); }
});

test('finding 5: a connection with no streams is closed after idleTimeout, PINGs do not keep it alive', async () => {
  const relay = await startRelay({ hostAllow: ['*'], idleTimeout: 0.3, reapInterval: 100 });
  try {
    const wisp = await connect(relay);
    assert.equal(await relay.connections(), 1);
    for (let i = 0; i < 8; i++) { await sleep(100); }
    assert.equal(await relay.connections(), 0);
    assert.equal(wisp.connected, false);
  } finally { await relay.close(); }
});

// ---- review finding 10 ---------------------------------------------------------------------------------

test('finding 10: the default bandwidth limit is not unlimited (C++: --help states it)', () => {
  const r = spawnSync(BINARY, ['--help'], { encoding: 'utf8' });
  assert.match(r.stdout, /--max-kbps N \(default 8192 KiB\/s/);
});

test('finding 10: tokens of any length are compared without a length shortcut (prefixes, extensions, empty, huge are all refused)', async () => {
  for (const bad of [TOKEN.slice(0, -1), TOKEN + 'x', 'x', 'y'.repeat(5000), TOKEN.toUpperCase()])
    await assert.rejects(new WispClient({ url: dev.url, token: bad, WebSocket: BrowserLike }).connect(), /refused the token/, bad.slice(0, 20));
  await (await connect(dev, { token: TOKEN })).close();
  const empty = await startRelay({ hostAllow: ['*'], token: 'a' });
  try { await assert.rejects(new WispClient({ url: empty.url, token: '', WebSocket: BrowserLike }).connect(), /refused the token|requires a token/); } finally { await empty.close(); }
});

// ---- Wisp v1 (no Sec-WebSocket-Protocol, no INFO handshake) ------------------------------------------
function v1Handshake(port, extraHeaders = '') {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.on('error', () => {});
    let buf = Buffer.alloc(0);
    const state = { socket: s, status: 0, headers: '', frames: [] };
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!state.status) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        state.headers = buf.subarray(0, end).toString('latin1');
        state.status = Number(state.headers.slice(9, 12));
        buf = buf.subarray(end + 4);
        resolve(state);
      }
      while (buf.length >= 2 && buf.length >= 2 + buf[1]) { // small unmasked server frames only
        state.frames.push(Buffer.from(buf.subarray(2, 2 + buf[1]))); buf = buf.subarray(2 + buf[1]);
      }
    });
    s.on('close', () => resolve(state));
    s.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${ORIGIN}\r\n${extraHeaders}\r\n`);
  });
}
const maskedBinary = (payload) => {
  const mask = [5, 6, 7, 8];
  return Buffer.concat([Buffer.from([0x82, 0x80 | payload.length, ...mask]), Buffer.from(payload.map((b, i) => b ^ mask[i & 3]))]);
};

rawTest('wisp v1: with no auth configured a client without a subprotocol gets CONTINUE and can open a stream', async () => {
  const echo = await startEcho();
  const relay = await startRelay({ hostAllow: ['127.0.0.1'], portAllow: [echo.port], allowPrivate: true, blockLocalInterfaces: false });
  try {
    const c = await v1Handshake(relay.port);
    assert.equal(c.status, 101);
    assert.ok(!/sec-websocket-protocol/i.test(c.headers), 'no subprotocol echoed to a v1 client');
    for (let i = 0; i < 50 && !c.frames.length; i++) await sleep(20);
    assert.equal(c.frames[0][0], CONTINUE, 'first packet is CONTINUE on stream 0, not INFO');
    assert.equal(c.frames[0].readUInt32LE(1), 0);
    const connect = Buffer.alloc(5 + 3 + 9);
    connect[0] = 1; connect.writeUInt32LE(1, 1); connect[5] = 1; connect.writeUInt16LE(echo.port, 6); connect.write('127.0.0.1', 8);
    c.socket.write(maskedBinary(connect));
    const data = Buffer.concat([Buffer.from([2, 1, 0, 0, 0]), Buffer.from('hello')]);
    c.socket.write(maskedBinary(data));
    for (let i = 0; i < 100 && !c.frames.some((f) => f[0] === DATA); i++) await sleep(20);
    const got = c.frames.find((f) => f[0] === DATA);
    assert.ok(got, 'echoed data arrived');
    assert.equal(got.subarray(5).toString(), 'hello');
    assert.ok(!c.frames.some((f) => f[0] === CONTINUE && f.readUInt32LE(1) === 1), 'no open-confirm CONTINUE for v1');
    c.socket.destroy();
  } finally { await relay.close(); echo.close(); }
});

rawTest('wisp v1: refused (400) when a token is configured, so omitting the header cannot bypass auth', async () => {
  const relay = await startRelay({ hostAllow: ['*'], token: TOKEN });
  try {
    const c = await v1Handshake(relay.port);
    assert.equal(c.status, 400);
    assert.equal(await relay.connections(), 0);
  } finally { await relay.close(); }
});

test('wisp v2 with a token still works and a v2 client with the wrong token is refused', async () => {
  const relay = await startRelay({ hostAllow: ['*'], token: TOKEN });
  try {
    const wisp = await connect(relay, { token: TOKEN });
    wisp.close?.();
    await assert.rejects(connect(relay, { token: 'wrong' }));
  } finally { await relay.close(); }
});

// ---- C++ only: the per-worker DNS cache ----------------------------------------------------------
test('C++: DNS answers are cached per worker (TTL-bounded) and every cached address is checked again', async () => {
  let lookups = 0;
  const lookup = async (h) => { lookups++; return h === 'priv.example' ? [{ address: '10.1.2.3', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]; };
  const relay = await startRelay({ hostAllow: ['*'], portAllow: [443], lookup, egress: echo.port, threads: 1 });
  try {
    const wisp = await connect(relay);
    for (let i = 0; i < 3; i++) { const r = openStream(wisp, 'pub.example', 443); await r.opened; r.stream.close(); }
    assert.equal(lookups, 1, 'one lookup for three CONNECTs to the same name');
    for (let i = 0; i < 2; i++) assert.equal((await openStream(wisp, 'priv.example', 443).closed).code, R.BLOCKED);
    assert.equal(lookups, 2, 'the blocked answer came from the cache the second time, and was refused again');
    assert.deepEqual(await relay.connects(), ['93.184.216.34', '93.184.216.34', '93.184.216.34']);
    wisp.close();
  } finally { await relay.close(); }
});
