// DESIGN.md section 4: one test per invariant for the bugs memory safety does not catch
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

function upgrade(port, { protocol = 'wisp-v2', origin = ORIGIN } = {}) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
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

// ---- L1: shared limits under concurrency (cross-core races) -------------------------------------
t('L1: 120 simultaneous upgrades across 4 threads never exceed the global cap or the per-address cap', async () => {
  for (const [opts, cap, refused] of [[{ maxConnections: 20, maxConnsPerIp: 1000 }, 20, 503], [{ maxConnections: 1000, maxConnsPerIp: 7 }, 7, 429]]) {
    const relay = await startCppRelay({ hostAllow: ['*'], threads: 4, maxHandshakes: 1000, maxHandshakesPerIp: 1000, ...opts });
    try {
      for (let round = 0; round < 3; round++) {
        const all = await Promise.all(Array.from({ length: 120 }, () => upgrade(relay.port)));
        const ok = all.filter((u) => u.status === 101).length;
        const hist = JSON.stringify(all.reduce((m, u) => ({ ...m, [u.status]: (m[u.status] || 0) + 1 }), {}));
        assert.equal(ok, cap, `round ${round}: exactly the cap is admitted ${hist}`);
        assert.equal(all.filter((u) => u.status === refused).length, 120 - cap, `the rest get ${refused}`);
        assert.equal(await relay.connections(), cap);
        for (const u of all) u.s.destroy();
        for (let i = 0; i < 120 && (await relay.connections()); i++) await sleep(25);
        assert.equal(await relay.connections(), 0, 'every ticket released once');
      }
    } finally { await relay.close(); }
  }
});

// ---- T1: slowloris -------------------------------------------------------------------------------
t('T1: slowloris: dribbling request heads hold at most max-handshakes sockets, each for at most the handshake timeout', async () => {
  const relay = await startCppRelay({ hostAllow: ['*'], maxHandshakes: 8, handshakeTimeout: 600 });
  try {
    const head = 'GET / HTTP/1.1\r\nHost: x\r\nX-Pad: ' + 'a'.repeat(400);
    const socks = [];
    for (let i = 0; i < 20; i++) {
      const s = net.connect(relay.port, '127.0.0.1');
      s.on('error', () => {});
      s.closedAt = null;
      const t0 = Date.now();
      s.on('close', () => { s.closedAt = Date.now() - t0; });
      let k = 0;
      s.timer = setInterval(() => { if (!s.destroyed && k < head.length) s.write(head[k++]); }, 20);
      socks.push(s);
      await sleep(5);
    }
    await sleep(250);
    const early = socks.filter((s) => s.closedAt !== null).length;
    assert.ok(early >= 12, `sockets over the cap are closed at once (${early} of 20)`);
    await sleep(900);
    assert.equal(socks.filter((s) => s.closedAt === null).length, 0, 'the rest are dropped at the timeout though they keep sending');
    assert.ok(Math.max(...socks.map((s) => s.closedAt)) < 600 + 400, 'no socket outlived the timeout by much');
    for (const s of socks) clearInterval(s.timer);
    assert.equal((await relay.stats()).handshakes, 1, 'only the stats request itself');
  } finally { await relay.close(); }
});

// ---- T3 + R3: slow reader ------------------------------------------------------------------------
t('T3/R3: a client that stops reading while a site floods: the site is paused, memory stays bounded, the client is dropped after the write stall', async () => {
  let sent = 0;
  const flood = net.createServer((c) => {
    c.on('error', () => {});
    const chunk = Buffer.alloc(64 << 10, 0x5a);
    const pump = () => { while (c.write(chunk)) { sent += chunk.length; if (sent > (1 << 30)) return; } sent += chunk.length; };
    c.on('drain', pump); pump();
  });
  await new Promise((r) => flood.listen(0, '127.0.0.1', r));
  const relay = await startCppRelay({ hostAllow: ['*'], allowPrivate: true, portAllow: [flood.address().port], writeStall: 1500, reapInterval: 200 });
  try {
    const w = await session(relay.port);
    w.wisp(CONNECT, 1, connectPayload(flood.address().port));
    await sleep(300);
    w.s.pause();  // stop reading
    await sleep(1000);
    const st = await relay.stats();
    // R3: queued replies stop at ~4 MiB (+ one site read); the kernel buffers hold the rest of `sent`
    assert.ok(st.small_in_use * 2048 <= (6 << 20), `small blocks in use stay bounded (${st.small_in_use})`);
    const sentPaused = sent;
    await sleep(500);
    assert.ok(sent - sentPaused < (8 << 20), 'the site is no longer read while the client is not reading');
    await sleep(1500);
    assert.equal(await relay.connections(), 0, 'dropped after the write stall timeout');
    const after = await relay.stats();
    assert.equal(after.small_in_use, 0, 'every reply block returned');
  } finally { await relay.close(); flood.close(); }
});

// ---- R5: pool starvation -------------------------------------------------------------------------
t('R5: pool starvation: sessions holding large buffers degrade to backpressure; a new client still gets through and every block comes back', async () => {
  const echo = await startEcho();
  const relay = await startCppRelay({ hostAllow: ['*'], allowPrivate: true, portAllow: [echo.port], threads: 1, maxConnections: 1000, maxConnsPerIp: 1000, maxHandshakes: 1000 });
  try {
    // each session parks a half-received 100 KiB message in its receive block (36 KiB large blocks, 4 MiB reserve ~ 110 blocks)
    const hogs = [];
    for (let i = 0; i < 160; i++) {
      const u = await upgrade(relay.port);
      if (u.status !== 101) { u.s.destroy(); continue; }
      u.s.write(frame(2, Buffer.alloc(100 << 10)).subarray(0, 30 << 10));
      hogs.push(u);
    }
    await sleep(300);
    const busy = await relay.stats();
    assert.ok(busy.large_in_use > 0);
    for (const u of hogs.slice(0, 20)) u.s.destroy();
    await sleep(200);
    const w = await session(relay.port);
    w.wisp(CONNECT, 7, connectPayload(echo.port));
    w.wisp(DATA, 7, Buffer.from('still served'));
    assert.ok(await w.until((x) => x.packets().some((p) => p.type === DATA && p.id === 7)), 'a new session works while the pool is under pressure');
    w.s.destroy();
    for (const u of hogs) u.s.destroy();
    await sleep(300);
    const idle = await relay.stats();
    assert.equal(idle.connections, 0);
    assert.equal(idle.small_in_use, 0, 'no small block leaked');
    assert.ok(idle.large_in_use <= 1, `no large block leaked (${idle.large_in_use}; the stats request may hold one)`);
    assert.equal(relay.proc.exitCode, null, 'no crash');
  } finally { await relay.close(); echo.close(); }
});

// ---- R2: flow-control abuse ----------------------------------------------------------------------
t('R2: a client that ignores CONTINUE and floods tiny packets is held at 2 x buffer-packets by backpressure (no growth); the stalled stream ends by idle timeout and the session then works', async () => {
  const sink = net.createServer((c) => { c.on('error', () => {}); c.pause(); });  // never reads
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const echo = await startEcho();
  const relay = await startCppRelay({ hostAllow: ['*'], allowPrivate: true, portAllow: [sink.address().port, echo.port], bufferPackets: 16,
    maxStreamBuffer: 64 << 20, maxConnectionBuffer: 64 << 20, idleTimeout: 1, reapInterval: 200 });  // byte caps out of the way: only the packet window applies
  try {
    const w = await session(relay.port);
    w.wisp(CONNECT, 1, connectPayload(sink.address().port));
    await sleep(200);
    // the site's kernel buffers fill with the first few MiB; after that nothing is flushed, so credit
    // stops and every further packet counts against the window (2 x 16)
    for (let i = 0; i < 40; i++) w.wisp(DATA, 1, Buffer.alloc(120 << 10));
    w.send(Buffer.concat(Array.from({ length: 5000 }, () => frame(2, packet(DATA, 1, Buffer.from('x'))))));
    assert.ok(await w.until(() => closeOf(w, 1)), 'stream 1 closed');
    assert.equal(closeOf(w, 1).payload[0], R.DATA_TIMEOUT, 'held, then ended by the idle timeout (not reset for credit)');
    w.wisp(CONNECT, 2, connectPayload(echo.port));
    w.wisp(DATA, 2, Buffer.from('ok'));
    assert.ok(await w.until((x) => x.packets().some((p) => p.type === DATA && p.id === 2)), 'the session still works');
    w.s.destroy();
  } finally { await relay.close(); sink.close(); echo.close(); }
});

// ---- R4 + I1/I2: fragments and lengths -----------------------------------------------------------
t('R4: fragment growth: continuations past max-message close with 1009; 20000 one-byte fragments within the limit are reassembled', async () => {
  const echo = await startEcho();
  const relay = await startCppRelay({ hostAllow: ['*'], allowPrivate: true, portAllow: [echo.port], maxMessage: 32 << 10 });
  try {
    let w = await session(relay.port);
    const parts = [frame(2, Buffer.alloc(16 << 10), { fin: false })];
    for (let i = 0; i < 3; i++) parts.push(frame(0, Buffer.alloc(8 << 10), { fin: false }));
    parts.push(frame(0, Buffer.alloc(8 << 10)));
    w.send(...parts);  // 48 KiB in total
    assert.ok(await w.until((x) => x.closed || x.closeCode()), 'closed');
    assert.equal(w.closeCode(), 1009);
    w = await session(relay.port);
    w.wisp(CONNECT, 3, connectPayload(echo.port));
    const msg = Buffer.from(packet(DATA, 3, Buffer.alloc(20000 - 5, 0x61)));
    const frs = [frame(2, msg.subarray(0, 1), { fin: false })];
    for (let i = 1; i < msg.length - 1; i++) frs.push(frame(0, msg.subarray(i, i + 1), { fin: false }));
    frs.push(frame(0, msg.subarray(msg.length - 1)));
    w.send(...frs);
    assert.ok(await w.until((x) => x.packets().filter((p) => p.type === DATA && p.id === 3).reduce((n, p) => n + p.payload.length, 0) >= 20000 - 5, 5000));
    w.s.destroy();
    assert.ok((await relay.stats()).large_in_use <= 2);
  } finally { await relay.close(); echo.close(); }
});

t('I1: a 64-bit length with the top bit set closes with 1002; a huge length under 2^63 closes with 1009 on the header, before any payload', async () => {
  const relay = await startCppRelay({ hostAllow: ['*'] });
  try {
    let w = await session(relay.port);
    const h = Buffer.from([0x82, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4]);
    w.send(h);
    assert.ok(await w.until((x) => x.closed || x.closeCode()));
    assert.equal(w.closeCode(), 1002);
    for (const n of [2n ** 63n - 1n, 2n ** 32n + 5n, 2n ** 32n - 1n]) {
      w = await session(relay.port);
      const big = Buffer.alloc(14); big[0] = 0x82; big[1] = 0xff; big.writeBigUInt64BE(n, 2); big.writeUInt32BE(0x01020304, 10);
      w.send(big);  // header only: refused without waiting for the payload
      assert.ok(await w.until((x) => x.closed || x.closeCode(), 1500), `length ${n}`);
      assert.equal(w.closeCode(), 1009);
    }
    assert.equal(relay.proc.exitCode, null);
  } finally { await relay.close(); }
});

// ---- P: protocol state machine -------------------------------------------------------------------
t('P2: before INFO, a DATA or CONNECT packet closes the session with 0x04; a v1 INFO major is refused', async () => {
  const relay = await startCppRelay({ hostAllow: ['*'] });
  try {
    for (const bad of [packet(DATA, 0, Buffer.from('x')), packet(CONNECT, 1, connectPayload(80, 'example.com')), packet(INFO, 0, encodeInfo(1, 2, []))]) {
      const u = await upgrade(relay.port);
      const w = u.raw;
      await w.until((x) => x.packets().some((p) => p.type === INFO));
      w.send(frame(2, bad));
      assert.ok(await w.until(() => closeOf(w, 0)), `packet type ${bad[0]}`);
      assert.equal(closeOf(w, 0).payload[0], R.EXTENSIONS);
      w.s.destroy();
    }
  } finally { await relay.close(); }
});

t('P3: in Ready: CONNECT on stream 0 or on an id in use is 0x41; short packets, client CONTINUE and DATA for unknown ids are ignored', async () => {
  const echo = await startEcho();
  const relay = await startCppRelay({ hostAllow: ['*'], allowPrivate: true, portAllow: [echo.port] });
  try {
    const w = await session(relay.port);
    w.wisp(CONNECT, 0, connectPayload(echo.port));
    assert.ok(await w.until(() => closeOf(w, 0)));
    assert.equal(closeOf(w, 0).payload[0], R.INVALID);
    w.wisp(CONNECT, 5, connectPayload(echo.port));
    w.wisp(DATA, 5, Buffer.from('a'));
    assert.ok(await w.until((x) => x.packets().some((p) => p.type === DATA && p.id === 5)));
    w.wisp(CONNECT, 5, connectPayload(echo.port));  // id in use
    assert.ok(await w.until(() => closeOf(w, 5)));
    assert.equal(closeOf(w, 5).payload[0], R.INVALID);
    w.send(frame(2, Buffer.from([2, 9, 0])), frame(2, packet(CONTINUE, 9, Buffer.from([1, 0, 0, 0]))), frame(2, packet(DATA, 12345, Buffer.from('lost'))), frame(2, packet(0x7f, 1)));
    w.wisp(CONNECT, 6, connectPayload(echo.port));
    w.wisp(DATA, 6, Buffer.from('b'));
    assert.ok(await w.until((x) => x.packets().some((p) => p.type === DATA && p.id === 6)), 'the session carries on');
    assert.equal(w.closed, false);
    w.s.destroy();
  } finally { await relay.close(); echo.close(); }
});

t('P5: unmasked frames, RSV bits, unknown opcodes, long or fragmented control frames, a stray continuation, a data frame inside a fragmented message all close with 1002', async () => {
  const relay = await startCppRelay({ hostAllow: ['*'] });
  try {
    const cases = [
      ['unmasked', [frame(2, Buffer.from('abcde'), { mask: false })]],
      ['rsv1', [Buffer.from([0xc2, 0x80, 0, 0, 0, 0])]],
      ['opcode 3', [frame(3, Buffer.alloc(0))]],
      ['long ping', [frame(9, Buffer.alloc(126))]],
      ['fragmented ping', [frame(9, Buffer.alloc(1), { fin: false })]],
      ['stray continuation', [frame(0, Buffer.alloc(3))]],
      ['data inside fragments', [frame(2, Buffer.alloc(3), { fin: false }), frame(2, Buffer.alloc(3))]],
    ];
    for (const [name, frs] of cases) {
      const w = await session(relay.port);
      w.send(...frs);
      assert.ok(await w.until((x) => x.closed || x.closeCode()), name);
      assert.equal(w.closeCode(), 1002, name);
      w.s.destroy();
    }
    const w = await session(relay.port);
    w.send(frame(1, Buffer.from([0xc3, 0x28])));  // invalid UTF-8 text
    assert.ok(await w.until((x) => x.closed || x.closeCode()));
    assert.equal(w.closeCode(), 1007);
  } finally { await relay.close(); }
});
