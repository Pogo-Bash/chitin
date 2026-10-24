// Third-party clients against the C++ server: Mercury Workshop's wisp-js client (v2 and v1, with and
// without the password extension) and epoxy-tls's wisp-mux simple-wisp-client (v1 and v2).
//   WISP_JS=/path/to/node_modules/@mercuryworkshop/wisp-js  WISP_MUX=/path/to/simple-wisp-client  node --test test/interop.test.js
// (both are skipped when not given; tools/wispmark_run.py's build directory has them)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startEcho, sleep } from '../../wisp/testlib/helpers.js';
import { startCppRelay, TLS } from './cpp-relay.js';

const JS = process.env.WISP_JS, MUX = process.env.WISP_MUX;
const jsTest = JS && !TLS ? test : test.skip;
const muxTest = MUX && !TLS ? test : test.skip;
const load = async () => {
  const c = await import(pathToFileURL(join(JS, 'src/entrypoints/client.mjs')).href);
  return { ClientConnection: c.client.ClientConnection, ext: c.extensions };
};
const sha = (bufs) => createHash('sha256').update(Buffer.concat(bufs)).digest('hex');

function open(ClientConnection, url, opts) {
  return new Promise((resolve) => {
    const conn = new ClientConnection(url, opts);
    conn.onopen = () => resolve({ conn, ok: true });
    conn.onclose = () => resolve({ conn, ok: false });
    conn.onerror = () => resolve({ conn, ok: false });
  });
}

async function echoStreams(conn, port, n, bytes) {
  return Promise.all(Array.from({ length: n }, () => new Promise((resolve) => {
    const sent = [], got = [];
    let have = 0;
    const s = conn.create_stream('127.0.0.1', port);
    s.onmessage = (d) => { got.push(Buffer.from(d)); have += d.byteLength; if (have >= bytes) { s.close(0x02); resolve({ sent: sha(sent), got: sha(got), have }); } };
    s.onclose = (reason) => resolve({ sent: sha(sent), got: sha(got), have, reason });
    for (let off = 0; off < bytes; off += 16384) { const b = randomBytes(Math.min(16384, bytes - off)); sent.push(b); s.send(new Uint8Array(b)); }
  })));
}

jsTest('wisp-js client, v2: 8 streams x 512 KiB echo byte-exact; the session ends cleanly', async () => {
  const { ClientConnection } = await load();
  const echo = await startEcho();
  const relay = await startCppRelay({ origins: ['*'], hostAllow: ['*'], allowPrivate: true, portAllow: [echo.port] });
  try {
    const { conn, ok } = await open(ClientConnection, relay.url, { wisp_version: 2 });
    assert.ok(ok);
    for (const r of await echoStreams(conn, echo.port, 8, 512 << 10)) { assert.equal(r.have, 512 << 10); assert.equal(r.got, r.sent); }
    conn.close();
    for (let i = 0; i < 40 && (await relay.connections()); i++) await sleep(25);
    assert.equal(await relay.connections(), 0);
  } finally { await relay.close(); echo.close(); }
});

jsTest('wisp-js client, v1 (no auth configured): echo works', async () => {
  const { ClientConnection } = await load();
  const echo = await startEcho();
  const relay = await startCppRelay({ origins: ['*'], hostAllow: ['*'], allowPrivate: true, portAllow: [echo.port] });
  try {
    const { conn, ok } = await open(ClientConnection, relay.url, { wisp_version: 1 });
    assert.ok(ok);
    for (const r of await echoStreams(conn, echo.port, 2, 64 << 10)) assert.equal(r.got, r.sent);
    conn.close();
  } finally { await relay.close(); echo.close(); }
});

// KNOWN INCOMPATIBILITY (owner decision pending): the Wisp v2 spec's password payload is
// u8 username length, username, password (the rest). wisp-js 0.4.1 and wisp-mux send an extra u16
// password length after the u8, so this server (like packages/wisp) reads the password with two
// stray bytes in front and refuses it (0xc0). This test pins today's behaviour.
jsTest('wisp-js client with the password extension: refused (wisp-js adds a u16 length the spec does not have)', async () => {
  const { ClientConnection, ext } = await load();
  const relay = await startCppRelay({ origins: ['*'], hostAllow: ['*'], token: 'interop-secret' });
  try {
    const { ok } = await open(ClientConnection, relay.url, { wisp_version: 2,
      wisp_extensions: [new ext.PasswordAuthExtension({ client_config: { username: 'u', password: 'interop-secret' } })] });
    assert.equal(ok, false);
  } finally { await relay.close(); }
});

// an echo that tolerates resets (the client stops mid-transfer)
async function sturdyEcho() {
  const net = await import('node:net');
  const srv = net.createServer((c) => { c.on('error', () => {}); c.pipe(c); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => srv.close() };
}

function runMux(args, ms) {
  return new Promise((resolve) => {
    const p = spawn(MUX, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => p.kill('SIGTERM'), ms);
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

muxTest('wisp-mux simple-wisp-client, v1 and v2, 10 streams of 50 KiB packets for 2 s: traffic flows, the client exits cleanly', async () => {
  const echo = await sturdyEcho();
  const relay = await startCppRelay({ origins: ['*'], hostAllow: ['*'], allowPrivate: true, portAllow: [echo.port], maxKbps: 0 });
  try {
    for (const extra of [[], ['--wisp-v2']]) {
      const { code, out } = await runMux(['-w', relay.url, '-t', `127.0.0.1:${echo.port}`, '-s', '10', '-p', '50', '-d', '2s', ...extra], 10000);
      const m = out.match(/results: (\d+) packets/);
      assert.ok(m && Number(m[1]) > 100, `packets sent (${extra.join(' ') || 'v1'}): ${out.slice(-300)}`);
      assert.equal(code, 0, out.slice(-300));
    }
    for (let i = 0; i < 40 && (await relay.connections()); i++) await sleep(25);
    assert.equal(await relay.connections(), 0);
  } finally { await relay.close(); echo.close(); }
});

muxTest('wisp-mux with --auth: refused like wisp-js (same u16 length; see above), a wrong one too', async () => {
  const echo = await sturdyEcho();
  const relay = await startCppRelay({ origins: ['*'], hostAllow: ['*'], allowPrivate: true, portAllow: [echo.port], maxKbps: 0, token: 'interop-secret' });
  try {
    let r = await runMux(['-w', relay.url, '-t', `127.0.0.1:${echo.port}`, '-s', '2', '-p', '4', '-d', '1s', '--wisp-v2', '--auth', 'u:interop-secret'], 8000);
    assert.ok(!/results: [1-9]\d* packets/.test(r.out), 'spec-format mismatch: refused');
    r = await runMux(['-w', relay.url, '-t', `127.0.0.1:${echo.port}`, '-s', '2', '-p', '4', '-d', '1s', '--wisp-v2', '--auth', 'u:wrong'], 8000);
    assert.ok(!/results: [1-9]\d* packets/.test(r.out), 'nothing relayed with the wrong password');
  } finally { await relay.close(); echo.close(); }
});
