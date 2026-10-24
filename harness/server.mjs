import { statSync } from 'node:fs';
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Chitin phase-0 harness server. Loopback only (127.0.0.1 and ::1), one port, routed by Host:
//
//   http://localhost:PORT/                 the carapace (shell page), and /bench/
//   http://s<hash of the site>.localhost:PORT/   a segment: its own site, so its own process (carapace/guard.mjs segmentLabel)
//   http://origin.localhost:PORT/<site>/   stand-in for the network: the sites' real bytes
//
// Chrome resolves *.localhost to loopback itself (net/dns/host_resolver_manager.cc,
// ResolveLocalHostname) and treats it as a secure context (Secure Contexts, "Is origin potentially
// trustworthy?" step 5), so no /etc/hosts edit is needed. Each <label>.localhost is its own site:
// "localhost" is not in the Public Suffix List, so Chrome takes the last label as the registry and
// <label>.localhost as the registrable domain (net/base/registry_controlled_domains). Any other Host
// header is refused, which also blocks DNS rebinding.
//
// Usage: node harness/server.mjs [--port 8100]
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { segmentHeaders as segmentHeadersFor } from './segment-headers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portArg = process.argv.indexOf('--port');
const PORT = portArg > 0 ? +process.argv[portArg + 1] : 8100;
// The relay the carapace's Spiracle may connect to (relay/relay.py): its origin goes into the
// carapace's connect-src, so a page cannot be made to open any other relay.
const relayArg = process.argv.indexOf('--relay');
const RELAY = relayArg > 0 ? process.argv[relayArg + 1] : 'ws://127.0.0.1:8101/';
const RELAY_ORIGIN = new URL(RELAY).origin;
// Destination ports segments may open streams to (Spiracle's NetGuard). Default 80,443; tests that run their own
// servers on other ports (tools/wpt/run.mjs, WPT's wptserve) widen it with --net-ports 80,443,8460,...
const netPortsArg = process.argv.indexOf('--net-ports');
// A test CA appended to the segments' trust store (tools/wpt/run.mjs: the CA wptserve generated for its https ports).
const extraCaArg = process.argv.indexOf('--extra-ca');
const EXTRA_CA = extraCaArg > 0 ? process.argv[extraCaArg + 1] : null;
const NET_PORTS = netPortsArg > 0 ? process.argv[netPortsArg + 1].split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 65536) : [80, 443];
const CARAPACE = `http://localhost:${PORT}`;
const ORIGIN_HOST = `origin.localhost:${PORT}`;
// Runtime files (ICU data, CA bundle, fonts): $CHITIN_EXT, else the repository's own ext/ (shipped with the public release),
// else ~/dev/chitin-ext.
const EXT = process.env.CHITIN_EXT || [path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'ext'), path.join(process.env.HOME || '', 'dev', 'chitin-ext')]
    .find((d) => { try { return statSync(path.join(d, 'icu')).isDirectory(); } catch { return false; } }) || path.join(process.env.HOME || '', 'dev', 'chitin-ext');

const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.css': 'text/css; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.svg': 'image/svg+xml',
};

// One byte range (`Range: bytes=a-b`, `a-`, `-n`) is answered with 206, as a media element's seeks and progressive loads ask.
// ?rate=<bytes a second> on a site's file sends it at that rate, in pieces every 100 ms (progressive media tests).
function trickle(res, body, rate) {
    if (!rate || !(rate > 0)) {
        res.end(body);
        return;
    }
    const piece = Math.max(1, Math.round(rate / 10));
    let at = 0;
    const next = () => {
        if (res.destroyed)
            return;
        if (at >= body.length) {
            res.end();
            return;
        }
        res.write(body.subarray(at, at + piece));
        at += piece;
        setTimeout(next, 100);
    };
    next();
}

async function sendFile(res, file, headers = {}, req = null, rate = 0) {
    try {
        const info = await stat(file);
        if (!info.isFile())
            throw new Error('not a file');
        let body = await readFile(file);
        const type = { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
        const range = req && /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
        if (range && (range[1] || range[2])) {
            const size = body.length;
            let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
            let end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
            if (start >= size || start > end) {
                res.writeHead(416, { 'Content-Range': `bytes */${size}`, ...type, ...headers });
                res.end();
                return;
            }
            body = body.subarray(start, end + 1);
            res.writeHead(206, { ...type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': body.length, ...headers });
            return trickle(res, body, rate);
        }
        res.writeHead(200, { ...type, 'Content-Length': body.length, ...headers });
        return trickle(res, body, rate);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', ...headers });
        res.end('not found\n');
    }
}

function inside(base, rel) {
    const p = path.resolve(base, '.' + path.posix.normalize('/' + rel));
    return p.startsWith(base + path.sep) || p === base ? p : null;
}

// --- The carapace ----------------------------------------------------------------------------------
const carapaceCSP = [
    "default-src 'self'",
    `frame-src http://*.localhost:${PORT}`,
    "img-src 'self' blob: data:",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self'",
    `connect-src 'self' ${RELAY_ORIGIN} ${RELAY_ORIGIN.replace(/^ws:\/\/127\.0\.0\.1/, 'ws://localhost')}`,
].join('; ');

async function carapace(req, res, url) {
    let p = url.pathname;
    if (p === '/')
        p = '/carapace/index.html';
    if (p === '/bench' || p === '/bench/')
        p = '/bench/index.html';
    // Benchmarks need SharedArrayBuffer (and 5 µs timers): cross-origin isolate that page.
    const isolate = p.startsWith('/bench/') || p.startsWith('/bench-src/') || p.startsWith('/build/');
    const headers = isolate
        ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' }
        : { 'Content-Security-Policy': carapaceCSP };
    if (p === '/carapace/index.html') {
        // The default relay URL rides on the root element for carapace.js.
        const html = (await readFile(path.join(root, 'harness/carapace/index.html'), 'utf8')).replace('<html lang="en">', `<html lang="en" data-relay="${RELAY}" data-net-ports="${NET_PORTS.join(',')}">`);
        res.writeHead(200, { 'Content-Type': types['.html'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
        res.end(html);
        return;
    }
    if (p.startsWith('/carapace/') || p.startsWith('/bench/'))
        return sendFile(res, inside(path.join(root, 'harness'), p.slice(1)), headers);
    if (p.startsWith('/bench-src/'))
        return sendFile(res, inside(path.join(root, 'bench'), p.slice('/bench-src/'.length)), headers);
    if (p.startsWith('/build/'))
        return sendFile(res, inside(path.join(root, 'build'), p.slice('/build/'.length)), headers);
    res.writeHead(404).end();
}

// --- A segment -----------------------------------------------------------------------------------
// The document is isolated by Document-Isolation-Policy (Chrome 137+, desktop), which makes it
// cross-origin isolated on its own although the carapace is not; its dedicated Worker inherits that
// (DIP explainer, "Interactions with workers"). frame-ancestors lets only the carapace embed it.
const segmentHeaders = (kind) => segmentHeadersFor(kind, { CARAPACE, ORIGIN_HOST });

async function segment(req, res, url) {
    const p = url.pathname;
    if (p === '/' || p === '/index.html')
        return sendFile(res, path.join(root, 'harness/segment/index.html'), segmentHeaders('document'));
    if (p === '/sw.js')
        return sendFile(res, path.join(root, 'harness/segment/sw.js'), segmentHeaders('sw'));
    // The carapace's "reset site" (devtools panel): Chrome wipes this segment origin itself (W3C Clear Site Data): its
    // IndexedDB, OPFS, Cache Storage, localStorage, service worker registrations (Chitin's and the page's) and cookies.
    if (p === '/chitin/reset') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Clear-Site-Data': '"cache", "cookies", "storage"', ...segmentHeaders('document') });
        res.end('<!doctype html><title>reset</title>');
        return;
    }
    if (p === '/chitin/worker.js')
        return sendFile(res, path.join(root, 'harness/segment/worker.js'), segmentHeaders('worker'));
    if (p === '/chitin/rtc-host.js')
        return sendFile(res, path.join(root, 'harness/segment/rtc-host.js'), segmentHeaders('script'));
    // A page Worker's runner (pagesw.js) and what it imports are fetched once per runner: they may be kept in the HTTP cache
    // (and their compiled code with them) for the segment's life; the segment document's Clear-Site-Data empties the cache
    // at each segment load, so an edited file is picked up then. (no-store made every runner fetch and compile all four: a
    // quarter of a Worker's start-up, and plasmaontheweb.com starts a Worker per task.)
    const RUNNER_CACHE = { 'Cache-Control': 'private, max-age=3600' };
    if (p === '/chitin/doors.js' || p === '/chitin/opfs.js' || p === '/chitin/websocket.js')
        return sendFile(res, path.join(root, 'harness/segment', p.slice('/chitin/'.length)), { ...segmentHeaders('script'), ...RUNNER_CACHE });
    if (p === '/chitin/rtc.js' || p === '/chitin/pagesw-host.js' || p === '/chitin/streams.js' || p === '/chitin/eme.js' || p === '/chitin/eme-host.js')
        return sendFile(res, path.join(root, 'harness/segment', p.slice('/chitin/'.length)), segmentHeaders('script'));
    // The runner of a page's own service worker (docs/architecture.md, "Page service workers").
    if (p === '/chitin/pagesw.js')
        return sendFile(res, path.join(root, 'harness/segment/pagesw.js'), { ...segmentHeaders('pagesw'), ...RUNNER_CACHE });
    // Import maps (docs/architecture.md): the service worker's JavaScript parser and specifier rule.
    if (p === '/chitin/acorn.js')
        return sendFile(res, path.join(root, 'third_party/acorn/acorn.js'), segmentHeaders('script'));
    if (p === '/chitin/specifiers.js')
        return sendFile(res, path.join(root, 'harness/segment/specifiers.js'), segmentHeaders('script'));
    if (p === '/chitin/segment.js')
        return sendFile(res, path.join(root, 'harness/segment/segment.js'), segmentHeaders('script'));
    if (p === '/chitin/ganglion.js' || p === '/chitin/ganglion-toy.wasm' || p === '/chitin/ganglion.wasm' || p === '/chitin/ganglion-engine.js')
        return sendFile(res, path.join(root, 'build', p.slice('/chitin/'.length)), segmentHeaders('script'));
    // ICU's common data for the engine (ICU licence, from the deps build into $CHITIN_EXT/icu).
    if (p === '/chitin/icudt78l.dat')
        return sendFile(res, path.join(EXT, 'icu', 'icudt78l.dat'), segmentHeaders('script'));
    // The trust store for TLS: Mozilla's CA bundle as curl publishes it (MPL-2.0), tools/ca-bundle.sh.
    if (p === '/chitin/cacert.pem' && EXTRA_CA) {
        const body = Buffer.concat([await readFile(path.join(EXT, 'ca', 'cacert.pem')), Buffer.from('\n'), await readFile(EXTRA_CA)]);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...segmentHeaders('script') });
        return res.end(body);
    }
    if (p === '/chitin/cacert.pem')
        return sendFile(res, path.join(EXT, 'ca', 'cacert.pem'), segmentHeaders('script'));
    // The fallback font subsets and their manifest (OFL, cut by tools/fallback-fonts.py into $CHITIN_EXT/fallback-fonts/out).
    if (/^\/chitin\/fallback\/[A-Za-z0-9-]+\.(woff2|bin|txt)$/.test(p))
        return sendFile(res, path.join(EXT, 'fallback-fonts', 'out', p.slice('/chitin/fallback/'.length)), { ...segmentHeaders('script'), 'Cache-Control': 'max-age=31536000, immutable' });
    // Fonts for the engine (Noto: OFL; Cousine: Apache-2.0; fetched by tools/fonts.sh into $CHITIN_EXT/fonts).
    if (/^\/chitin\/fonts\/[A-Za-z0-9-]+\.ttf$/.test(p))
        return sendFile(res, path.join(EXT, 'fonts', p.slice('/chitin/fonts/'.length)), segmentHeaders('script'));
    // /__chitin/hello.mjs only exists inside the service worker: reaching the server means the
    // Worker is not controlled, and the segment must not load modules.
    res.writeHead(404, { 'Content-Type': 'text/plain', ...segmentHeaders('script') });
    res.end('not found (this path is answered by the segment service worker)\n');
}

async function siteHeaders(p) {
    const slash = p.indexOf('/');
    if (slash < 0 || p.includes('..'))
        return {};
    try {
        const rules = JSON.parse(await readFile(path.join(root, 'harness/sites', p.slice(0, slash), '_headers.json'), 'utf8'));
        return rules[p.slice(slash + 1)] || {};
    } catch {
        return {};
    }
}

// --- The network stand-in --------------------------------------------------------------------
// Real sites' bytes, served to the engine's network stack only (CORS for segment origins).
async function origin(req, res, url) {
    const o = req.headers.origin || '';
    const allowed = /^http:\/\/s[0-9a-f]{32}\.localhost:\d+$/.test(o) ? o : 'null';
    const headers = { 'Access-Control-Allow-Origin': allowed, 'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, Cross-Origin-Opener-Policy, Cross-Origin-Embedder-Policy, Cross-Origin-Resource-Policy, Access-Control-Allow-Origin', Vary: 'Origin', 'Cross-Origin-Resource-Policy': 'cross-origin' };
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...headers, 'Access-Control-Allow-Headers': 'Range' }).end();
        return;
    }
    // fonts.example serves the OFL fonts from outside the repo (tools/fonts.sh), as a site would.
    if (url.pathname.startsWith('/fonts.example/'))
        return sendFile(res, inside(path.join(EXT, 'fonts'), url.pathname.slice('/fonts.example/'.length)), headers);
    let p = url.pathname.slice(1);
    if (p.endsWith('/'))
        p += 'index.html';
    // A site's own response headers (COOP, COEP, CORP, CORS: harness/sites/<site>/_headers.json, file name -> headers; null
    // removes one of the stand-in's defaults), readable by the segment's fetch of the stand-in.
    Object.assign(headers, await siteHeaders(p));
    for (const k of Object.keys(headers))
        if (headers[k] === null)
            delete headers[k];
    // ?delay=ms holds the response back (render-blocking tests, docs/scroll.md "FOUC"), at most 20 s.
    const delay = Math.min(Number(url.searchParams.get('delay')) || 0, 20000);
    if (delay > 0)
        await new Promise((r) => setTimeout(r, delay));
    return sendFile(res, inside(path.join(root, 'harness/sites'), p), headers, req, Math.min(Number(url.searchParams.get('rate')) || 0, 1e8));
}

const server = (req, res) => {
    const host = (req.headers.host || '').toLowerCase();
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/favicon.ico') {
        // An empty icon, so Chrome's automatic request does not log a 404.
        res.writeHead(204, { 'Cache-Control': 'max-age=86400', 'Cross-Origin-Resource-Policy': 'cross-origin' }).end();
        return;
    }
    let route;
    if (host === `localhost:${PORT}`)
        route = carapace;
    else if (host === ORIGIN_HOST || host === `xo.localhost:${PORT}`) // xo: a second origin for Chrome's side of cross-origin tests
        route = origin;
    else if (/^s[0-9a-f]{32}\.localhost:\d+$/.test(host) && host.endsWith(`:${PORT}`))
        route = segment;
    if (!route) {
        res.writeHead(421, { 'Content-Type': 'text/plain' }).end('unknown host\n');
        return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
        res.writeHead(405).end();
        return;
    }
    route(req, res, url).catch((e) => {
        res.writeHead(500).end(String(e));
    });
    if (process.env.CHITIN_LOG)
        console.log(req.method, host, url.pathname);
};

let listening = 0;
for (const address of ['127.0.0.1', '::1']) {
    http.createServer(server)
        .on('error', (e) => console.error(`${address}: ${e.message}`))
        .listen(PORT, address, () => {
            if (++listening === 1)
                console.log(`Chitin harness on loopback only, port ${PORT}:\n  carapace   ${CARAPACE}/\n  benchmarks ${CARAPACE}/bench/\n  relay      ${RELAY} (python3 relay/relay.py; --relay to change)\n  (segments: http://s<hash>.localhost:${PORT}/, network stand-in: http://${ORIGIN_HOST}/)`);
        });
}
