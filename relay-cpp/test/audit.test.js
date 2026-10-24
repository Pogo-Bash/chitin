// AUDIT.md regression tests: each began as the auditor's reproducer (it passed while the issue
// reproduced) and now asserts the safe behaviour.
// (cross-core limit races, slowloris and slow readers, pool starvation, flow-control abuse,
// fragment growth, the protocol state machine, length overflow). D1 (DNS TOCTOU) and the DNS
// cache re-check are in server.test.js ("rebinding: ...", "C++: DNS answers are cached ...").
// Plain ws:// only (raw sockets speak HTTP and WebSocket frames by hand).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { R, CONNECT, DATA, CONTINUE, CLOSE, INFO, packet, encodeInfo } from '../../wisp/src/protocol.js';
import { startEcho, ORIGIN, sleep } from '../../wisp/testlib/helpers.js';
import { startCppRelay, TLS } from './cpp-relay.js';

const t = TLS ? test.skip : test;

// ---- a raw WebSocket client --------------------------------------------------------------------
function frame(op, payload = Buffer.alloc(0), { fin = true, mask = true, len } = {}) {
  payload = Buffer.from(payload);
  const n = len ?? payload.length;
  let head;
  if (n < 126) head = Buffer.from([(fin ? 0x80 : 0) | op, (mask ? 0x80 : 0) | n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = (fin ? 0x80 : 0) | op; head[1] = (mask ? 0x80 : 0) | 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = (fin ? 0x80 : 0) | op; head[1] = (mask ? 0x80 : 0) | 127; head.writeBigUInt64BE(BigInt(n), 2); }
  if (!mask) return Buffer.concat([head, payload]);
  const key = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  return Buffer.concat([head, key, payload.map((b, i) => b ^ key[i & 3])]);
}

class Raw {
  constructor(s, rest = Buffer.alloc(0)) {
    this.s = s; this.buf = Buffer.from(rest); this.frames = []; this.closed = false; this.waiters = [];
    s.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); this.wake(); });
    s.on('close', () => { this.closed = true; this.wake(); });
    this.frames = []; this.parse();
  }
  parse() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      let n = b[1] & 0x7f, at = 2;
      if (n === 126) { if (b.length < 4) return; n = b.readUInt16BE(2); at = 4; }
      else if (n === 127) { if (b.length < 10) return; n = Number(b.readBigUInt64BE(2)); at = 10; }
      if (b.length < at + n) return;
      this.frames.push({ op: b[0] & 0x0f, payload: b.subarray(at, at + n) });
      this.buf = b.subarray(at + n);
    }
  }
  wake() { for (const w of this.waiters.splice(0)) w(); }
  // Wisp packets received so far
  packets() {
    return this.frames.filter((f) => f.op === 2).map((f) => ({ type: f.payload[0], id: f.payload.readUInt32LE(1), payload: f.payload.subarray(5) }));
  }
  async until(pred, ms = 3000) {
    const end = Date.now() + ms;
    while (!pred(this)) {
      if (Date.now() > end) return false;
      await new Promise((r) => { this.waiters.push(r); setTimeout(r, 50); });
    }
    return true;
  }
  send(...frames) { this.s.write(Buffer.concat(frames)); }
  wisp(type, id, payload) { this.send(frame(2, packet(type, id, payload))); }
  closeCode() { const c = this.frames.find((f) => f.op === 8); return c && c.payload.length >= 2 ? c.payload.readUInt16BE(0) : c ? 1005 : null; }
}

function upgrade(port, { protocol = 'wisp-v2', origin = ORIGIN, host = '127.0.0.1' } = {}) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.on('error', () => {});
    let head = Buffer.alloc(0), done = false;
    const finish = (status, rest) => { if (done) return; done = true; resolve({ status, s, raw: status === 101 ? new Raw(s, rest) : null }); };
    s.on('data', function onData(d) {
      head = Buffer.concat([head, d]);
      const i = head.indexOf('\r\n\r\n');
      if (i < 0) return;
      s.off('data', onData);
      finish(Number(head.subarray(9, 12).toString()), head.subarray(i + 4));
    });
    s.on('close', () => finish(0));
    s.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n`
      + (protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : '') + `Origin: ${origin}\r\n\r\n`);
  });
}

// v2 session: upgrade, wait for the server INFO, answer with ours, wait for CONTINUE on stream 0
async function session(port) {
  const u = await upgrade(port);
  assert.equal(u.status, 101);
  const w = u.raw;
  assert.ok(await w.until((x) => x.packets().some((p) => p.type === INFO)), 'server INFO');
  w.wisp(INFO, 0, encodeInfo(2, 0, []));
  return w;
}
const connectPayload = (port, host = '127.0.0.1') => {
  const h = Buffer.from(host);
  const p = Buffer.alloc(3 + h.length);
  p[0] = 1; p.writeUInt16LE(port, 1); h.copy(p, 3);
  return p;
};
const closeOf = (w, id) => w.packets().find((p) => p.type === CLOSE && p.id === id);

// A site that accepts and never reads (its kernel buffers fill, then the relay's tx queue does).
async function sink() {
  const socks = [];
  const srv = net.createServer((c) => { c.on('error', () => {}); c.pause(); socks.push(c); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => { for (const c of socks) c.destroy(); srv.close(); } };
}

// A-1: the handshake cap was global only: one client holding max-handshakes idle sockets locked
// every other client out. Now each address may hold max-handshakes-per-ip of them, and each is
// dropped at the handshake timeout. (::1 and 127.0.0.1 are two client addresses on one machine.)
const idle = (host, port) => { const s = net.connect({ host, port }); s.on('error', () => {}); s.closedAt = null; const t0 = Date.now(); s.on('close', () => { s.closedAt = Date.now() - t0; }); return s; };
t('AUDIT A-1: one address cannot hold the handshake slots; its idle sockets are capped per address and timed out', async () => {
  const relay = await startCppRelay({ hostAllow: ['*'], bind: '::', maxHandshakes: 16, maxHandshakesPerIp: 4, handshakeTimeout: 1500 });
  const hogs = [];
  try {
    for (let i = 0; i < 16; i++) hogs.push(idle('::1', relay.port));
    await sleep(300);
    assert.equal(hogs.filter((s) => s.closedAt !== null).length, 12, 'sockets past the per-address cap are closed at accept');
    const u = await upgrade(relay.port);
    assert.equal(u.status, 101, 'another address still upgrades while the first holds its share');
    u.s.destroy();
    await sleep(1600);
    assert.equal(hogs.filter((s) => s.closedAt === null).length, 0, 'the held sockets are dropped at the handshake timeout');
    const again = idle('::1', relay.port);  // the address got its slots back
    await sleep(200);
    assert.equal(again.closedAt, null);
    again.destroy();
  } finally { for (const s of hogs) s.destroy(); await relay.close(); }
});

// A-6: new connections (TLS handshakes) per address per second are rate limited.
t('AUDIT A-6: at most handshake-rate new connections per address per second', async () => {
  const relay = await startCppRelay({ hostAllow: ['*'], bind: '::', handshakeRate: 5, maxHandshakesPerIp: 100, handshakeTimeout: 5000 });
  const socks = [];
  try {
    // wait for the start of a second so the burst falls in one window
    await sleep(1000 - (Date.now() % 1000) + 50);
    for (let i = 0; i < 20; i++) socks.push(idle('::1', relay.port));
    await sleep(300);
    const open = socks.filter((s) => s.closedAt === null).length;
    assert.ok(open >= 1 && open <= 5, `burst of 20 from one address: ${open} admitted (rate 5/s)`);
    const u = await upgrade(relay.port);  // 127.0.0.1 has its own budget
    assert.equal(u.status, 101);
    u.s.destroy();
    await sleep(1100);
    const later = idle('::1', relay.port);
    await sleep(200);
    assert.equal(later.closedAt, null, 'the next second admits again');
    later.destroy();
  } finally { for (const s of socks) s.destroy(); await relay.close(); }
});

// A-2: the write-stall timer only checked for zero progress; a client that read a trickle kept a
// full reply queue (ws_write_high, ~4 MiB of pool blocks) indefinitely. Now a queue over the
// high-water mark must drain to half of it within the stall timeout.
t('AUDIT A-2: a trickle reader is dropped by the drain-rate rule and its reply blocks come back', async () => {
  const flood = net.createServer((c) => {
    c.on('error', () => {});
    const chunk = Buffer.alloc(64 << 10, 0x5a);
    const pump = () => { while (c.write(chunk)); };
    c.on('drain', pump); pump();
  });
  await new Promise((r) => flood.listen(0, '127.0.0.1', r));
  const relay = await startCppRelay({ hostAllow: ['*'], allowPrivate: true, portAllow: [flood.address().port], writeStall: 5000, reapInterval: 100, maxKbps: 0, logLevel: 1 });
  try {
    const w = await session(relay.port);
    w.s.setNoDelay(true);
    w.wisp(CONNECT, 1, connectPayload(flood.address().port));
    await sleep(300);
    w.s.pause();
    // a real trickle: 16 KiB every 50 ms (~320 KB/s) out of Node's paused buffer, which refills from
    // the kernel only as it is read. Progress every 50 ms (the old zero-progress rule never fires),
    // below the drain rate (2 MiB in 5 s). (The auditor's resume-for-20-ms reader drained at
    // ~150 MB/s on loopback: not a slow reader.)
    let got = 0;
    const tick = setInterval(() => { const d = w.s.read(16384); if (d) got += d.length; w.buf = Buffer.alloc(0); w.frames = []; }, 50);
    await sleep(12000);
    clearInterval(tick);
    assert.equal(await relay.connections(), 0, 'dropped within the stall timeout (+ reap interval) of filling its queue');
    // usually the drain-rate rule; on a slow build (TSan + io_uring) the kernel buffers can leave a
    // 5 s gap with no write progress first, and the old rule drops it: safe either way
    assert.match(relay.stderr(), /drained too slowly|replies not read/);
    assert.ok(got > 0, 'the client was reading');
    const st = await relay.stats();
    assert.equal(st.small_in_use + st.bulk_in_use, 0, `every reply block returned (${JSON.stringify(st)})`);
  } finally { await relay.close(); flood.close(); }
});

// A-3: bytes of a voluntarily closed (Draining) stream used to leave pending_ and the caps, so a
// client could hold max_streams x max_stream_buffer of pool blocks. They now count until freed.
t('AUDIT A-3: draining streams stay under max-connection-buffer', async () => {
  const site = await sink();
  const relay = await startCppRelay({ hostAllow: ['*'], allowPrivate: true, portAllow: [site.port], maxKbps: 0, threads: 1,
    maxStreamBuffer: 4 << 20, maxConnectionBuffer: 4 << 20, maxStreams: 64 });
  try {
    const w = await session(relay.port);
    const chunk = Buffer.alloc(60 << 10, 0x41);
    let peak = 0;
    const sample = async () => { const st = await relay.stats(); peak = Math.max(peak, st.small_in_use * 36 * 1024); };
    for (let id = 1; id <= 24; id++) {
      w.wisp(CONNECT, id, connectPayload(site.port));
      await sleep(40);
      // ~3.4 MiB per stream (under the 4 MiB caps): past the site's socket buffers into the relay's tx queue
      for (let k = 0; k < 58; k++) w.wisp(DATA, id, chunk);
      await sleep(30);
      w.wisp(CLOSE, id, Buffer.from([0x02]));  // voluntary close: the stream drains for 1 s
      await sample();
    }
    for (let k = 0; k < 10; k++) { await sleep(100); await sample(); }
    console.log('A-3 peak MiB', (peak / 1048576).toFixed(1));
    // the 4 MiB cap + one 60 KiB message + partly filled blocks + the stats replies
    assert.ok(peak <= (4 << 20) + (1 << 20), `one session's tx blocks peaked at ${(peak / 1048576).toFixed(1)} MiB (cap 4 MiB)`);
    w.s.destroy();
    for (let i = 0; i < 40 && (await relay.connections()); i++) await sleep(50);
    await sleep(200);
    const end = await relay.stats();
    assert.equal(end.small_in_use, 0, 'every block returned ' + JSON.stringify(end));
  } finally { await relay.close(); site.close(); }
});

// A-4: the small pool was sized by --pool-mib alone and nothing was reserved per session: a few
// sessions within their caps starved everyone else, and even their CLOSE replies found no block.
// Now each connection has a share of the pool (budgets scaled to fit --pool-mib), and protocol
// replies have a reserve.
t('AUDIT A-4: sessions within their caps cannot exhaust the shared pool; another client relays normally', async () => {
  const site = await sink();
  const echo = await startEcho();
  const relay = await startCppRelay({ hostAllow: ['*'], allowPrivate: true, portAllow: [site.port, echo.port], maxKbps: 0, threads: 1, poolMib: 16,
    maxConnections: 8, maxHandshakes: 16, logLevel: 1 });
  try {
    assert.match(relay.stderr(), /scaled to fit/, 'the budgets were scaled to the 16 MiB pool');
    const chunk = Buffer.alloc(60 << 10, 0x41);
    const hogs = [];
    for (let c = 0; c < 6; c++) {
      const w = await session(relay.port);
      for (let id = 1; id <= 3; id++) {
        w.wisp(CONNECT, id, connectPayload(site.port));
        await sleep(30);
        for (let k = 0; k < 60; k++) w.wisp(DATA, id, chunk);  // ~3.5 MiB each, under the 4 MiB stream cap
      }
      hogs.push(w);
    }
    await sleep(500);
    const st = await relay.stats();
    const v = await session(relay.port);
    v.wisp(CONNECT, 1, connectPayload(echo.port));
    await sleep(200);
    let back = 0;
    for (let k = 0; k < 20; k++) v.wisp(DATA, 1, chunk);
    const total = 20 * chunk.length;
    const ok = await v.until((x) => (back = x.packets().filter((p) => p.type === DATA && p.id === 1).reduce((n, p) => n + p.payload.length, 0)) >= total, 10000);
    console.log('A-4', JSON.stringify(st), 'victim got', back, 'of', total);
    assert.ok(ok, `the victim's stream echoes everything (${back} of ${total})`);
    assert.ok(!closeOf(v, 1), 'and is not reset');
    assert.doesNotMatch(relay.stderr(), /relay out of buffers/);
    assert.ok(hogs.every((h) => !h.closed), 'the hogs are held by backpressure, not killed');
    assert.ok(hogs.every((h) => !h.packets().some((p) => p.type === CLOSE && p.id >= 1)), 'nor their streams reset');
  } finally { await relay.close(); site.close(); echo.close?.(); }
});

// A-7: without TLS there is nothing to reload: SIGHUP must not terminate the relay.
t('AUDIT A-7: SIGHUP on a plain ws:// relay is a no-op', async () => {
  const relay = await startCppRelay({ hostAllow: ['*'] });
  try {
    for (let k = 0; k < 3; k++) { relay.proc.kill('SIGHUP'); await sleep(100); }
    assert.equal(relay.proc.exitCode, null, 'still running');
    assert.equal(relay.proc.signalCode, null);
    const w = await session(relay.port);
    assert.ok(!w.closed, 'and still serving');
    w.s.destroy();
  } finally { await relay.close(); }
});

// A-8: descriptors are budgeted against RLIMIT_NOFILE: inconsistent settings refuse to start, site
// sockets past the budget are throttled (0x49) instead of failing at random, and the listener keeps
// accepting after EMFILE without waiting for another connection to arrive.
t('AUDIT A-8: a descriptor limit too small for the settings refuses to start', async () => {
  await assert.rejects(startCppRelay({ hostAllow: ['*'], ulimit: 256 }), /RLIMIT_NOFILE is 256.*need at least/);
});

t('AUDIT A-8: site sockets past the descriptor budget are throttled (0x49); the relay keeps serving', async () => {
  const echo = await startEcho();
  // 128 descriptors, 1 thread: base 36, 8 client slots, 16 for DNS: 68 site sockets
  const relay = await startCppRelay({ hostAllow: ['*'], allowPrivate: true, portAllow: [echo.port], ulimit: 128, threads: 1, maxConnections: 4,
    maxHandshakes: 4, maxStreams: 100, maxConnectsPerMinute: 1000, maxKbps: 0 });
  try {
    const w = await session(relay.port);
    for (let id = 1; id <= 90; id++) w.wisp(CONNECT, id, connectPayload(echo.port));
    await sleep(800);
    const throttled = w.packets().filter((p) => p.type === CLOSE && p.payload[0] === R.THROTTLED).length;
    assert.ok(throttled >= 90 - 68 && throttled < 90, `streams past the budget get 0x49 (${throttled} of 90)`);
    for (let id = 1; id <= 90; id++) w.wisp(CLOSE, id, Buffer.from([0x02]));
    await sleep(300);
    const v = await session(relay.port);
    v.wisp(CONNECT, 1, connectPayload(echo.port));
    v.wisp(DATA, 1, Buffer.from('after the budget'));
    assert.ok(await v.until((x) => x.packets().some((p) => p.type === DATA && p.id === 1)), 'descriptors came back');
  } finally { await relay.close(); echo.close?.(); }
});

t('AUDIT A-8: after EMFILE the listener retries on its own; a waiting client is accepted once descriptors free up', async () => {
  const relay = await startCppRelay({ hostAllow: ['*'], ulimit: 256, threads: 1, maxConnections: 8, maxHandshakes: 8, testHoldFdsMs: 1500, logLevel: 1 });
  try {
    await sleep(500);  // the hook now holds every free descriptor (from 300 ms to 1800 ms)
    assert.match(relay.stderr(), /test: holding \d+ descriptors/);
    const t0 = Date.now();
    const u = await upgrade(relay.port);  // arrives while accept() fails with EMFILE
    const waited = Date.now() - t0;
    if (process.platform === 'linux') {
      // Linux keeps the connection in the backlog; edge-triggered readiness will not fire for it
      // again, so only the retry timer can pick it up
      assert.equal(u.status, 101, `accepted once the descriptors were released, with no other arrival (${waited} ms)`);
      assert.ok(waited > 800 && waited < 3000, `waited ${waited} ms`);
    } else {
      // XNU drops a connection whose accept() fails for want of a descriptor: the client sees a close, not a hang
      assert.equal(u.status, 0, `${waited} ms`);
      await sleep(1800 - (Date.now() - t0));
    }
    u.s.destroy();
    await sleep(300);
    assert.match(relay.stderr(), /test: released them/);
    const after = await upgrade(relay.port);
    assert.equal(after.status, 101, 'and the listener serves again');
    after.s.destroy();
  } finally { await relay.close(); }
});

// A-4 follow-up (found under TSan on Linux): the automatic pool can exceed the address space the
// process may map (ulimit -v, overcommit 2, sanitizer runtimes); it is halved until it fits instead
// of aborting. Release build, Linux (macOS has no working ulimit -v).
(process.platform === 'linux' ? test : test.skip)('AUDIT A-4: an automatic pool larger than the address space limit shrinks to fit', async () => {
  const { spawn } = await import('node:child_process');
  const { join, dirname } = await import('node:path');
  const bin = join(dirname(new URL(import.meta.url).pathname), '..', process.env.WISP_CPP_RELEASE || 'build/wisp-server');
  const p = spawn('/bin/sh', ['-c', 'ulimit -v 4000000 && exec "$0" "$@"', bin, '--origin', '*', '--host-allow', '*', '--bind', '127.0.0.1', '--port', '0', '--max-connection-buffer', String(64 << 20)],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  try {
    for (let i = 0; i < 50 && !/Wisp relay on/.test(out) && p.exitCode === null; i++) await sleep(100);
    assert.match(out, /not available for the buffer pools; trying/);
    assert.match(out, /Wisp relay on/, out);
  } finally { p.kill('SIGTERM'); }
});
