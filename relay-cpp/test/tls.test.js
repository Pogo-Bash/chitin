// Native wss:// (TLS=1 builds). Run with WISP_CPP_TLS=1 NODE_TLS_REJECT_UNAUTHORIZED=0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCppRelay, TLS } from './cpp-relay.js';
import { connect, startEcho, openStream, sleep } from '../../wisp/testlib/helpers.js';

const maybe = TLS ? test : test.skip;

function cert(dir, cn) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '2', '-subj', `/CN=${cn}`,
    '-addext', `subjectAltName=DNS:${cn},IP:127.0.0.1`, '-keyout', join(dir, `${cn}.key`), '-out', join(dir, `${cn}.pem`)], { stdio: 'ignore' });
}
const handshake = (port, opts = {}) => new Promise((resolve) => {
  const s = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'], ...opts }, () => resolve({ ok: true, s }));
  s.on('error', (e) => resolve({ ok: false, e }));
});

maybe('wss: TLS 1.3 by default with ALPN http/1.1; TLS 1.2 with an AEAD suite; TLS 1.1 refused', async () => {
  const relay = await startCppRelay({ hostAllow: ['*'] });
  try {
    let r = await handshake(relay.port);
    assert.ok(r.ok);
    assert.equal(r.s.getProtocol(), 'TLSv1.3');
    assert.equal(r.s.alpnProtocol, 'http/1.1');
    r.s.destroy();
    r = await handshake(relay.port, { maxVersion: 'TLSv1.2' });
    assert.ok(r.ok);
    assert.match(r.s.getCipher().name, /GCM|CHACHA20/);
    r.s.destroy();
    r = await handshake(relay.port, { minVersion: 'TLSv1', maxVersion: 'TLSv1.1' });
    assert.equal(r.ok, false);
    r = await handshake(relay.port, { maxVersion: 'TLSv1.2', ciphers: 'AES128-SHA' });  // no CBC, no RSA key exchange
    assert.equal(r.ok, false);
  } finally { await relay.close(); }
});

maybe('wss: an echo through a stream; garbage and plain HTTP on the TLS port are dropped (an incomplete handshake when its timeout passes)', async () => {
  const echo = await startEcho();
  const relay = await startCppRelay({ hostAllow: ['*'], allowPrivate: true, portAllow: [echo.port], handshakeTimeout: 400 });
  try {
    const wisp = await connect(relay);
    const r = openStream(wisp, '127.0.0.1', echo.port);
    await r.opened;
    r.stream.write(new TextEncoder().encode('over tls'));
    for (let i = 0; i < 40 && !r.received.length; i++) await sleep(25);
    assert.equal(Buffer.concat(r.received).toString(), 'over tls');
    wisp.close();
    for (const junk of ['GET / HTTP/1.1\r\n\r\n', '\x16\x03\x01\x00\x05hello']) {
      const s = net.connect(relay.port, '127.0.0.1');
      s.on('error', () => {});
      s.resume();  // read the alert, if any: an unread 'data' keeps Node from emitting 'close'
      s.write(junk);
      await new Promise((res) => s.once('close', res));
    }
    const stalled = net.connect(relay.port, '127.0.0.1');  // never says anything
    stalled.on('error', () => {});
    await sleep(100);
    assert.equal((await relay.stats()).handshakes, 2, 'the stalled socket and the stats request itself');
    await new Promise((res) => stalled.once('close', res));  // dropped at the handshake timeout
  } finally { await relay.close(); echo.close(); }
});

maybe('wss: SNI picks the matching certificate; SIGHUP reloads the files for new connections', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wisp-sni-'));
  cert(dir, 'a.test'); cert(dir, 'b.test');
  copyFileSync(join(dir, 'a.test.pem'), join(dir, 'live.pem')); copyFileSync(join(dir, 'a.test.key'), join(dir, 'live.key'));
  const { spawn } = await import('node:child_process');
  const { BINARY } = await import('./cpp-relay.js');
  const proc = spawn(BINARY, ['--port', '0', '--origin', '*', '--host-allow', '*', '--log', '1', '--tls-cert', join(dir, 'live.pem'), '--tls-key', join(dir, 'live.key'),
    '--tls-cert', join(dir, 'b.test.pem'), '--tls-key', join(dir, 'b.test.key')], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((res) => { let o = ''; proc.stdout.on('data', (d) => { o += d; const m = o.match(/:(\d+)\//); if (m) res(Number(m[1])); }); });
    const cn = async (servername) => { const r = await handshake(port, { servername }); const c = r.s.getPeerCertificate().subject.CN; r.s.destroy(); return c; };
    assert.equal(await cn('a.test'), 'a.test');
    assert.equal(await cn('b.test'), 'b.test');
    assert.equal(await cn('other.test'), 'a.test', 'no match: the first certificate');
    copyFileSync(join(dir, 'b.test.pem'), join(dir, 'live.pem')); copyFileSync(join(dir, 'b.test.key'), join(dir, 'live.key'));
    proc.kill('SIGHUP');
    await sleep(300);
    assert.equal(await cn('other.test'), 'b.test', 'the reloaded file is served');
  } finally { proc.kill('SIGTERM'); }
});

maybe('wss: ALPN offers only http/1.1 (an h2-only client gets no ALPN, a mixed list gets http/1.1)', async () => {
  const relay = await startCppRelay({ hostAllow: ['*'] });
  try {
    let r = await handshake(relay.port, { ALPNProtocols: ['h2'] });
    assert.ok(r.ok);
    assert.equal(r.s.alpnProtocol, false);
    r.s.destroy();
    r = await handshake(relay.port, { ALPNProtocols: ['h2', 'http/1.1'] });
    assert.equal(r.s.alpnProtocol, 'http/1.1');
    r.s.destroy();
    r = await handshake(relay.port, { ALPNProtocols: [] });
    assert.ok(r.ok, 'no ALPN at all is fine');
    r.s.destroy();
  } finally { await relay.close(); }
});

maybe('wss: a SIGHUP with a broken or mismatched key keeps the old certificates; a SIGHUP with good files takes effect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wisp-reload-'));
  cert(dir, 'a.test'); cert(dir, 'b.test');
  copyFileSync(join(dir, 'a.test.pem'), join(dir, 'live.pem')); copyFileSync(join(dir, 'a.test.key'), join(dir, 'live.key'));
  const { spawn } = await import('node:child_process');
  const { BINARY } = await import('./cpp-relay.js');
  const proc = spawn(BINARY, ['--port', '0', '--origin', '*', '--host-allow', '*', '--log', '1', '--tls-cert', join(dir, 'live.pem'), '--tls-key', join(dir, 'live.key')],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } });
  let out = '';
  try {
    const port = await new Promise((res) => { proc.stdout.on('data', (d) => { out += d; const m = out.match(/:(\d+)\//); if (m) res(Number(m[1])); }); });
    proc.stderr.on('data', (d) => { out += d; });
    const cn = async () => { const r = await handshake(port, { servername: 'x.test' }); assert.ok(r.ok); const c = r.s.getPeerCertificate().subject.CN; r.s.destroy(); return c; };
    copyFileSync(join(dir, 'b.test.pem'), join(dir, 'live.pem'));  // cert b with key a: mismatched
    proc.kill('SIGHUP'); await sleep(300);
    assert.equal(await cn(), 'a.test', 'mismatched pair: the old set is kept');
    writeFileSync(join(dir, 'live.pem'), 'not a certificate');
    proc.kill('SIGHUP'); await sleep(300);
    assert.equal(await cn(), 'a.test', 'unparsable file: the old set is kept');
    assert.match(out, /TLS reload failed, keeping the old certificates/);
    copyFileSync(join(dir, 'b.test.pem'), join(dir, 'live.pem')); copyFileSync(join(dir, 'b.test.key'), join(dir, 'live.key'));
    proc.kill('SIGHUP'); await sleep(300);
    assert.equal(await cn(), 'b.test');
    // AUDIT A-7: an old set (its private key) lives only as long as connections opened from it
    const held = await handshake(port, { servername: 'x.test' });
    assert.ok(held.ok);
    await sleep(200);
    proc.kill('SIGHUP'); await sleep(300);
    assert.match(out, /TLS certificates reloaded \(2 set\(s\) still in use\)/, 'the open connection keeps its set');
    held.s.destroy();
    await sleep(1500);
    for (let k = 0; k < 3; k++) { proc.kill('SIGHUP'); await sleep(300); }
    assert.match(out.trimEnd().split('\n').filter((l) => /reloaded/.test(l)).pop(), /\(1 set\(s\) still in use\)/, 'every old set was freed');
    assert.equal(proc.exitCode, null, 'still running');
  } finally { proc.kill('SIGTERM'); }
});

maybe('wss: kernel TLS offload is used when the kernel offers the tls ULP, otherwise records stay in userspace; both carry a 4 MiB echo', async () => {
  let ulp = '';
  try { ulp = readFileSync('/proc/sys/net/ipv4/tcp_available_ulp', 'utf8'); } catch {}
  const echo = await startEcho();
  const relay = await startCppRelay({ hostAllow: ['*'], allowPrivate: true, portAllow: [echo.port], logLevel: 2 });
  try {
    const wisp = await connect(relay);
    const r = openStream(wisp, '127.0.0.1', echo.port);
    await r.opened;
    const chunk = new Uint8Array(64 * 1024).map((_, i) => i * 7);
    for (let i = 0; i < 64; i++) r.stream.write(chunk);
    let got = 0;
    for (let i = 0; i < 400 && got < 64 * chunk.length; i++) { await sleep(25); got = r.received.reduce((a, b) => a + b.length, 0); }
    assert.equal(got, 64 * chunk.length);
    const all = Buffer.concat(r.received);
    for (let i = 0; i < 64; i++) assert.ok(all.subarray(i * chunk.length, (i + 1) * chunk.length).equals(Buffer.from(chunk)), `chunk ${i}`);
    wisp.close();
    const m = relay.stderr().match(/kernel offload tx=(\d) rx=(\d)/);
    assert.ok(m, 'the handshake logs whether the kernel took the records');
    if (/\btls\b/.test(ulp)) assert.equal(m[1], '1', 'tls ULP available: TX is offloaded');
    else assert.deepEqual([m[1], m[2]], ['0', '0'], 'no tls ULP: userspace records (the fallback)');
  } finally { await relay.close(); echo.close(); }
});

// AUDIT A-5 against real OpenSSL: the reply queue's tail grows (PONGs appended into its free room)
// while an SSL_write is pending on WANT_WRITE; the retry must repeat exactly the pending write, else
// OpenSSL fails it (SSL_R_BAD_LENGTH) and the connection drops. Userspace records only (kTLS TX
// bypasses this path, so the test reports which one ran).
maybe('wss: AUDIT A-5: retries after WANT_WRITE while the queue tail grows keep the connection (userspace TLS)', async () => {
  const flood = net.createServer((c) => {
    c.on('error', () => {});
    const chunk = Buffer.alloc(16 << 10, 0x5a);
    const pump = () => { while (c.write(chunk)); };
    c.on('drain', pump); pump();
  });
  await new Promise((r) => flood.listen(0, '127.0.0.1', r));
  const relay = await startCppRelay({ hostAllow: ['*'], allowPrivate: true, portAllow: [flood.address().port], maxKbps: 0, logLevel: 2, writeStall: 20000 });
  const mask = (op, payload) => {
    const key = Buffer.from([1, 2, 3, 4]);
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, 0x80 | n]) : Buffer.from([0x80 | op, 0x80 | 126, n >> 8, n & 255]);
    return Buffer.concat([head, key, Buffer.from(payload.map((b, i) => b ^ key[i & 3]))]);
  };
  const wisp = (type, id, payload) => { const p = Buffer.alloc(5 + payload.length); p[0] = type; p.writeUInt32LE(id, 1); payload.copy(p, 5); return mask(2, p); };
  try {
    const { ok, s } = await handshake(relay.port, { servername: '127.0.0.1' });
    assert.ok(ok);
    let buf = Buffer.alloc(0), got = 0, upgraded = false, closed = false;
    s.on('close', () => { closed = true; });
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) { const i = buf.indexOf('\r\n\r\n'); if (i < 0) return; upgraded = true; buf = buf.subarray(i + 4); }
      for (;;) {
        if (buf.length < 2) return;
        let n = buf[1] & 0x7f, at = 2;
        if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); at = 4; } else if (n === 127) { if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); at = 10; }
        if (buf.length < at + n) return;
        if ((buf[0] & 15) === 2 && buf[at] === 2) got += n - 5;
        buf = buf.subarray(at + n);
      }
    });
    s.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: wisp-v2\r\nOrigin: https://app.example\r\n\r\n');
    await sleep(200);
    s.write(wisp(5, 0, Buffer.from([2, 0])));  // INFO v2, no extensions
    await sleep(100);
    const port = flood.address().port;
    const c = Buffer.alloc(3 + 9); c[0] = 1; c.writeUInt16LE(port, 1); Buffer.from('127.0.0.1').copy(c, 3);
    s.write(wisp(1, 1, c));
    for (let round = 0; round < 6 && !closed; round++) {
      s.pause();
      for (let k = 0; k < 40; k++) { s.write(mask(9, Buffer.from('ping' + k))); await sleep(10); }  // PONGs grow the tail meanwhile
      s.resume();
      await sleep(300);
    }
    const before = got;
    await sleep(500);
    assert.ok(!closed, `connection kept (${relay.stderr().split('\n').slice(-4).join(' | ')})`);
    assert.ok(got > before && got > (8 << 20), `data kept flowing (${got} bytes)`);
    console.log('A-5 TLS', /kernel offload tx=1/.test(relay.stderr()) ? 'kTLS tx' : 'userspace records', got, 'bytes');
    s.destroy();
  } finally { await relay.close(); flood.close(); }
});
