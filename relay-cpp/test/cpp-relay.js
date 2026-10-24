// Test adapter: runs the C++ server (the ASan/UBSan build with test hooks) the way
// packages/wisp/testlib/helpers.js runs the Node one, so the same protocol cases can be run
// against it. Options use the Node server's names and are mapped to command-line flags.
//  - `lookup(host)` (as in relay-guard) is served by a fake DNS server on 127.0.0.1 that the
//    relay is pointed at with --dns-server, so the relay's real resolver code is exercised.
//    One lookup() call per (source port, name): the relay's A and AAAA queries share a socket.
//  - `egress: port` sends every outbound connect to 127.0.0.1:port (test builds only) and
//    records the address the relay meant to reach: `await relay.connects()`.
//  - `await relay.connections()` is the relay's open WebSocket count.
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// WISP_CPP_TLS=1: native wss:// with a throw-away self-signed certificate (Node's WebSocket is told
// to accept it through NODE_TLS_REJECT_UNAUTHORIZED=0, set by the caller)
export const TLS = !!process.env.WISP_CPP_TLS;
let certDir = null;
function testCert() {
  if (certDir) return certDir;
  certDir = mkdtempSync(join(tmpdir(), 'wisp-cpp-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem')], { stdio: 'ignore' });
  return certDir;
}
export const BINARY = process.env.WISP_CPP_BIN || join(here, '..', 'build', 'wisp-server-test');

function dnsReply(query, rcode, answers) {
  // header + the question copied, answers pointing at the question name (0xc00c)
  let off = 12;
  while (query[off] !== 0) off += 1 + query[off];
  const qend = off + 5;
  const qtype = query.readUInt16BE(off + 1);
  const rr = [];
  for (const a of answers) {
    const ip = a.family === 4 ? Buffer.from(a.address.split('.').map(Number)) : v6bytes(a.address);
    const r = Buffer.alloc(12 + ip.length);
    r.writeUInt16BE(0xc00c, 0); r.writeUInt16BE(qtype, 2); r.writeUInt16BE(1, 4); r.writeUInt32BE(60, 6); r.writeUInt16BE(ip.length, 10);
    ip.copy(r, 12);
    rr.push(r);
  }
  const head = Buffer.alloc(12);
  query.copy(head, 0, 0, 2);
  head.writeUInt16BE(0x8180 | rcode, 2);
  head.writeUInt16BE(1, 4); head.writeUInt16BE(rr.length, 6);
  return Buffer.concat([head, query.subarray(12, qend), ...rr]);
}

function v6bytes(text) {
  const [h, t = ''] = text.split('::');
  const parts = (s) => (s ? s.split(':') : []);
  let groups = [...parts(h)];
  const tail = parts(t);
  if (text.includes('::')) groups = [...groups, ...new Array(8 - groups.length - tail.length).fill('0'), ...tail];
  const b = Buffer.alloc(16);
  groups.forEach((g, i) => b.writeUInt16BE(parseInt(g, 16), i * 2));
  return b;
}

async function startDns(lookup) {
  const sock = dgram.createSocket('udp4');
  let closed = false;
  const pending = new Map();  // `${port}/${name}` -> promise of answers (null = NXDOMAIN)
  sock.on('message', (msg, rinfo) => {
    let off = 12;
    const labels = [];
    while (msg[off] !== 0) { labels.push(msg.subarray(off + 1, off + 1 + msg[off]).toString('latin1')); off += 1 + msg[off]; }
    const name = labels.join('.');
    const qtype = msg.readUInt16BE(off + 1);
    const key = `${rinfo.port}/${name}`;
    if (!pending.has(key)) {
      pending.set(key, Promise.resolve().then(() => lookup(name)).then((list) => list, () => null));
      setTimeout(() => pending.delete(key), 30000).unref();
    }
    pending.get(key).then((list) => {
      const family = qtype === 28 ? 6 : 4;
      const reply = list === null ? dnsReply(msg, 3, []) : dnsReply(msg, 0, list.filter((a) => (a.family ?? (a.address.includes(':') ? 6 : 4)) === family));
      if (!closed) sock.send(reply, rinfo.port, rinfo.address, () => {});
    });
  });
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  return { port: sock.address().port, close: () => { if (closed) return; closed = true; sock.close(); } };
}

const nx = async () => { throw new Error('ENOTFOUND'); };

export function flagsFor(o) {
  const f = [];
  const many = (flag, list) => { for (const x of list || []) f.push(flag, String(x)); };
  many('--origin', o.origins);
  many('--host-allow', o.hostAllow);
  if (o.portAllow) f.push('--port-allow', o.portAllow.join(','));
  if (o.token) f.push('--token', o.token);
  if (o.allowPrivate) f.push('--allow-private');
  if (o.blockLocalInterfaces === false) f.push('--no-block-local');
  many('--own-address', o.ownAddresses);
  many('--block', o.block);
  many('--trust-proxy', o.trustedProxies);
  const n = { maxStreams: '--max-streams', maxConnectsPerMinute: '--max-connects-per-minute', maxConnsPerIp: '--max-conns-per-ip',
    maxConnections: '--max-connections', maxKbps: '--max-kbps', scanHostsPerMinute: '--scan-hosts-per-minute',
    scanFailuresPerMinute: '--scan-failures-per-minute', maxConcurrentLookups: '--max-concurrent-lookups', connectTimeout: '--connect-timeout',
    attemptTimeout: '--attempt-timeout', idleTimeout: '--idle-timeout', maxStreamBuffer: '--max-stream-buffer',
    maxConnectionBuffer: '--max-connection-buffer', maxWriteBuffer: '--max-write-buffer', maxMessage: '--max-message',
    reapInterval: '--reap-interval-ms', handshakeTimeout: '--handshake-timeout-ms', bufferPackets: '--buffer-packets', threads: '--threads',
    maxHandshakes: '--max-handshakes', writeStall: '--write-stall-ms', poolMib: '--pool-mib', maxHandshakesPerIp: '--max-handshakes-per-ip',
    handshakeRate: '--handshake-rate', bind: '--bind', testHoldFdsMs: '--test-hold-fds-ms' };
  for (const [k, flag] of Object.entries(n)) if (o[k] !== undefined) f.push(flag, String(o[k]));
  return f;
}

export async function startCppRelay(options = {}) {
  const o = { origins: ['https://app.example'], threads: 2, ...options };
  const dns = await startDns(o.lookup || nx);
  const args = ['--bind', '127.0.0.1', '--port', '0', '--log', String(o.logLevel ?? 0), '--dns-server', `127.0.0.1:${dns.port}`, ...flagsFor(o)];
  if (o.egress) args.push('--test-egress', `127.0.0.1:${o.egress}`);
  if (TLS) { const d = testCert(); args.push('--tls-cert', join(d, 'cert.pem'), '--tls-key', join(d, 'key.pem')); }
  if (process.env.WISP_CPP_ARGS) args.push(...process.env.WISP_CPP_ARGS.split(' ').filter(Boolean));  // e.g. --io-uring
  // ulimit: run under that RLIMIT_NOFILE (soft and hard), through sh
  const [cmd, argv] = o.ulimit ? ['/bin/sh', ['-c', `ulimit -n ${o.ulimit} && exec "$0" "$@"`, BINARY, ...args]] : [BINARY, args];
  const proc = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0:abort_on_error=0', UBSAN_OPTIONS: 'print_stacktrace=1:halt_on_error=1' } });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', (d) => { out += d; const m = out.match(/wss?:\/\/\S*:(\d+)\//); if (m) resolve(Number(m[1])); });
    proc.on('exit', (code) => { dns.close(); reject(new Error(`wisp-server exited ${code}: ${stderr}`)); });
  });
  const get = (path) => new Promise((resolve, reject) => (TLS ? https : http).get({ host: '127.0.0.1', port, path, rejectUnauthorized: false }, (res) => {
    let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve(body));
  }).on('error', reject));
  const relay = {
    port, url: `${TLS ? 'wss' : 'ws'}://127.0.0.1:${port}/`, proc,
    stderr: () => stderr,
    connections: async () => JSON.parse(await get('/__test/stats')).connections,
    stats: async () => JSON.parse(await get('/__test/stats')),
    connects: async () => JSON.parse(await get('/__test/connects')),
    close: async () => {
      dns.close();
      if (proc.exitCode === null) {
        proc.kill('SIGTERM');
        await new Promise((r) => proc.once('exit', r));
      }
      if (/AddressSanitizer|runtime error|LeakSanitizer|UndefinedBehaviorSanitizer|ThreadSanitizer/.test(stderr)) throw new Error('sanitizer report:\n' + stderr);
    },
  };
  return relay;
}
