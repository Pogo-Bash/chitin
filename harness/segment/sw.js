// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// The segment's service worker: the module loader. It belongs to one site and changes nothing
// (docs/plan.md). Requests for the segment's own files go to the network as usual; every other
// request from the segment's Worker (the site's modules and scripts, at their real URLs) is
// answered with the bytes the engine fetched, unmodified. It never falls back to the host network.
//
// Why responses synthesised here keep the real URL: Fetch's main fetch sets an empty URL list to
// the request's, so import.meta.url and stack frames name https://site/...; and "the CORS check is
// not to be applied to ... responses from a service worker" (Fetch, HTTP fetch), so no
// Access-Control-Allow-Origin is invented. CORP: cross-origin is added because the segment is
// isolated with isolate-and-require-corp and classic scripts load as no-cors.
'use strict';

// Import maps (docs/architecture.md "Import maps"): a JavaScript parser (Acorn) and the specifier rule.
importScripts('/chitin/acorn.js', '/chitin/specifiers.js');
const acornParser = self.acorn;
const Specifiers = self.ChitinSpecifiers;

const STANDIN_ORIGIN = `http://origin.localhost:${self.location.port}`;
const ports = new Map();       // nonce -> MessagePort to an engine
const clientPorts = new Map(); // FetchEvent.clientId -> MessagePort
const runnerClients = new Set(); // clientIds of runners of a page's own service worker (harness/segment/pagesw.js)
const pending = new Map();
const staged = new Map();      // url -> response staged by a Worker before a blocking importScripts
const stageWaiters = new Map();
const portWaiters = [];        // resolved when an engine port arrives (after a restart asked for one)
let nextId = 1;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'engine-port' || !event.ports[0])
        return;
    const port = event.ports[0];
    port.onmessage = (e) => {
        const reply = e.data;
        if (reply.type === 'stage') {
            // Bytes for a classic script the Worker is about to importScripts (it is blocked then).
            staged.set(reply.url, reply);
            setTimeout(() => { if (staged.get(reply.url) === reply) staged.delete(reply.url); }, 60000);
            if (reply.ack)
                port.postMessage({ type: 'staged', ack: reply.ack });
            const waiter = stageWaiters.get(reply.url);
            if (waiter) {
                stageWaiters.delete(reply.url);
                waiter(reply);
            }
            return;
        }
        const waiter = pending.get(reply.id);
        if (waiter) {
            pending.delete(reply.id);
            waiter(reply);
        }
    };
    ports.set(data.nonce, port);
    for (const waiter of portWaiters.splice(0))
        waiter();
});

// A browser stops an idle service worker and starts it again for the next event; everything held in memory is
// gone (the engine ports, the client map, staged scripts). Ask the segment document(s) for a fresh line and wait
// for it, up to `ms`. Returns whether a port for `nonce` (or any, when nonce is empty) is there.
async function requestPort(nonce, ms) {
    const have = () => (nonce ? ports.has(nonce) : ports.size > 0);
    if (have())
        return true;
    const arrived = new Promise((resolve) => {
        portWaiters.push(resolve);
        setTimeout(resolve, ms);
    });
    const windows = await self.clients.matchAll({ type: 'window' });
    windows.forEach((w) => w.postMessage({ type: 'need-port' }));
    await arrived;
    return have();
}

async function portFor(clientId) {
    let port = clientPorts.get(clientId);
    if (port)
        return port;
    if (ports.size === 1)
        return ports.values().next().value;
    // Restarted and lost our ports: ask the segment document for a new line and wait for it.
    await requestPort('', 3000);
    port = clientPorts.get(clientId);
    return port || (ports.size === 1 ? ports.values().next().value : undefined);
}

function ask(port, request, bypass) {
    const id = nextId++;
    return new Promise((resolve) => {
        pending.set(id, resolve);
        port.postMessage({ type: 'fetch', id, url: request.url, destination: request.destination, mode: request.mode, bypass: bypass === true, realm: request.realm || 0 });
        setTimeout(() => {
            if (pending.delete(id))
                resolve({ status: 504, headers: { 'content-type': 'text/plain' }, body: 'engine timeout' });
        }, 15000);
    });
}

// --- Import maps: the second fixed exception to "the loader changes nothing" (docs/architecture.md) -----------------------
// A page module's specifier strings (static import / export ... from / import() / import.meta.resolve with a string) that the
// document's import map remaps are replaced by the URL the map gives; nothing else in the text changes. The map and the
// resolution are the engine's (glue/engine/57-importmap.js); the Worker answers a 'resolve' with them. A specifier the map
// blocks (a null entry, backtracking) becomes the name of a module that throws Chrome's TypeError; one the map does not know
// is left alone (V8's error for it is already Chrome's), except in import(), which is resolved when it runs (Specifiers.LATE).
function askResolve(port, base, realm, specifiers) {
    const id = nextId++;
    return new Promise((resolve) => {
        pending.set(id, (reply) => resolve(reply.results || null));
        port.postMessage({ type: 'resolve', id, base, realm: realm || 0, specifiers });
        setTimeout(() => { if (pending.delete(id)) resolve(null); }, 15000);
    });
}
const UNRESOLVABLE = Specifiers.UNRESOLVABLE;
async function mapSpecifiers(port, text, base, realm) {
    const found = Specifiers.find(acornParser, text, true);
    if (!found || !found.length)
        return text;
    const results = await askResolve(port, base, realm, found.map((f) => f.value));
    if (!Array.isArray(results))
        return text;
    return Specifiers.apply(text, Specifiers.plan(found, results, self.location.origin, realm, base));
}
const isModuleRequest = (request) => request.mode === 'cors' && (request.destination === 'script' || request.destination === 'worker');
async function moduleResponse(port, reply, base, realm, prologue) {
    const headers = new Headers(reply.headers);
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    let text = typeof reply.body === 'string' ? reply.body : new TextDecoder().decode(reply.body);
    if (reply.importMap && port)
        text = await mapSpecifiers(port, text, base, realm);
    headers.delete('content-length');
    return new Response(prologue + text, { status: reply.status, headers });
}

// Staged by request (keyed by client): kept until its import takes it, or a minute at most (a Worker that died between the
// stage and the import).
const clientStaged = new Map(); // clientId + ' ' + url -> response
function stage(clientId, url, reply) {
    const key = clientId + ' ' + url;
    clientStaged.set(key, reply);
    setTimeout(() => { if (clientStaged.get(key) === reply) clientStaged.delete(key); }, 60000);
}
function takeStaged(url, waitMs, clientId) {
    const key = clientId + ' ' + url;
    const mine = clientStaged.get(key);
    if (mine) {
        clientStaged.delete(key);
        return Promise.resolve(mine);
    }
    const now = staged.get(url);
    if (now) {
        staged.delete(url);
        return Promise.resolve(now);
    }
    if (!waitMs)
        return Promise.resolve(undefined);
    return new Promise((resolve) => {
        stageWaiters.set(url, (r) => {
            staged.delete(url);
            resolve(r);
        });
        setTimeout(() => {
            if (stageWaiters.delete(url))
                resolve(undefined);
        }, waitMs);
    });
}

// The mirror of the site's address space under this origin: /__chitin/o/https/<host>/<path> is https://<host>/<path>. A classic
// script is run from a name in it so that its relative import() resolves (worker.js runScript). https only, like every
// URL the engine is asked for.
function mirrorTarget(url) {
    const m = /^\/__chitin\/o\/https\/([^/?#]+)(\/[^?#]*)?$/.exec(url.pathname);
    return m ? `https://${m[1]}${m[2] || '/'}${url.search}` : null;
}

// A same-site frame's module graph (glue/engine/55-realms.js, docs/architecture.md "Frame realms"): the same mirror under the
// frame realm's id, /__chitin/r/<id>/o/https/<host>/<path>, so the frame's modules are a graph of their own in the Worker.
function realmMirror(url) {
    const m = /^\/__chitin\/r\/(\d+)\/o\/https\/([^/?#]+)(\/[^?#]*)?$/.exec(url.pathname);
    return m ? { realm: Number(m[1]), target: `https://${m[2]}${m[3] || '/'}${url.search}`, host: m[2] } : null;
}
// The one change made to a frame's module, approved as the M6 exception to "the loader changes nothing" (docs/architecture.md):
// this fixed line in front of the module's own text. It imports the realm's accessor module and binds the names the module uses
// that are the frame's (or the principal window's) to the frame's values: `const` at module scope, which is where a module's
// free names would otherwise reach the Worker's global (the principal window). The names come from the engine's glue
// (moduleBindings: the module's free names less its own declarations); nothing else is added, removed or reordered.
const BINDING_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function realmPrologue(realm, names) {
    const safe = Array.isArray(names) ? names.filter((n) => typeof n === 'string' && BINDING_NAME.test(n)) : [];
    return `import{__chitin_frame as __chitin_f}from"/__chitin/r/${realm}/realm.mjs";` + (safe.length ? `const{${safe.join(',')}}=__chitin_f;` : '');
}
// The realm's accessor: the segment Worker sets the frame's WindowProxy through it before the frame's first module runs.
const REALM_ACCESSOR = 'export let __chitin_frame;\nexport function __chitin_set(value) { __chitin_frame = value; }\n';
async function fromEngineForRealm(event, mirror) {
    const port = await portFor(event.clientId);
    if (!port)
        return Response.error(); // fail closed
    const reply = (await takeStaged(event.request.url, 0, event.clientId)) || (await ask(port, { url: mirror.target, destination: event.request.destination, mode: event.request.mode, realm: mirror.realm }));
    if (reply.error)
        return Response.error();
    const headers = new Headers(reply.headers);
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    if (reply.status < 200 || reply.status > 299)
        return new Response(reply.body, { status: reply.status, headers });
    return moduleResponse(port, reply, mirror.target, mirror.realm, realmPrologue(mirror.realm, reply.bindings));
}

async function fromEngine(event, target) {
    const mine = clientStaged.has(event.clientId + ' ' + event.request.url);
    const port = mine ? null : await portFor(event.clientId);
    if (!port && !mine)
        return Response.error(); // fail closed
    // A classic script (importScripts, destination "script" from a Worker) may have been staged. A runner of the page's own
    // service worker has its main script staged before it asks and nothing else: no wait, and its loads skip the page's
    // worker (the engine's network directly), which is blocked in that importScripts.
    const runner = runnerClients.has(event.clientId);
    // A staged classic script's synthetic name (worker.js runScript) is no file of the site, and the Worker asking for it is
    // blocked in importScripts: asking its engine would only wait out the engine timeout (15 s a script: the owner's
    // "no frame for 34 s"). Not staged within the wait: fail at once.
    if (!runner && /\/__chitin_script_\d+\.js$/.test(new URL(event.request.url).pathname)) {
        const r = await takeStaged(event.request.url, 3000, event.clientId);
        if (!r)
            return Response.error();
        const h = new Headers(r.headers);
        h.set('Cross-Origin-Resource-Policy', 'cross-origin');
        return new Response(r.body, { status: r.status, headers: h });
    }
    const reply = (await takeStaged(event.request.url, !runner && event.request.destination === 'script' && event.request.mode === 'no-cors' ? 3000 : 0, event.clientId)) || (await ask(port, target ? { url: target, destination: event.request.destination, mode: event.request.mode } : event.request, runner));
    if (reply.error)
        return Response.error();
    if (reply.importMap && !runner && isModuleRequest(event.request) && reply.status >= 200 && reply.status <= 299)
        return moduleResponse(port || (await portFor(event.clientId)), reply, target || event.request.url, 0, '');
    const headers = new Headers(reply.headers);
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return new Response(reply.body, { status: reply.status, headers });
}

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.origin === self.location.origin) {
        if (url.pathname === '/__chitin/hello.mjs') {
            // Proves to the Worker that it is controlled, and tells us which client it is. If this worker was
            // stopped and restarted it has no port for the nonce: get one before answering, so the Worker's
            // next staged script or module request finds the line rebuilt.
            const nonce = url.searchParams.get('nonce');
            const body = `export const controlled = true;\nexport const clientId = ${JSON.stringify(event.clientId)};\n`;
            event.respondWith((async () => {
                if (nonce && !ports.has(nonce))
                    await requestPort(nonce, 2000);
                const port = ports.get(nonce);
                if (port)
                    clientPorts.set(event.clientId, port);
                if (port && url.searchParams.get('role') === 'pagesw')
                    runnerClients.add(event.clientId);
                return new Response(body, { headers: { 'Content-Type': 'text/javascript', 'Cross-Origin-Resource-Policy': 'same-origin' } });
            })());
        }
        if (url.pathname === '/__chitin/stage' && event.request.method === 'POST') {
            // A classic script's bytes, staged by the Worker that will importScripts them next (worker.js runScript). Kept
            // under the client's id and the name, so two Workers of this origin (a navigation's old and new) never take
            // each other's script. A fetch event, so a stopped service worker is started for it, with nothing lost.
            const name = event.request.headers.get('x-chitin-stage') || '';
            event.respondWith((async () => {
                const body = await event.request.text();
                stage(event.clientId, name, { status: 200, headers: { 'content-type': 'text/javascript' }, body });
                return new Response(null, { status: 204, headers: { 'Cross-Origin-Resource-Policy': 'same-origin' } });
            })());
            return;
        }
        if (url.pathname === Specifiers.LATE) {
            // import() of a specifier no import map knew when its module loaded: resolved now, at the import.
            event.respondWith((async () => {
                const spec = url.searchParams.get('s') || '';
                const realm = Number(url.searchParams.get('r')) || 0;
                const port = await portFor(event.clientId);
                const results = port ? await askResolve(port, url.searchParams.get('b') || '', realm, [spec]) : null;
                const r = Array.isArray(results) ? results[0] : null;
                const headers = { 'Content-Type': 'text/javascript', 'Cross-Origin-Resource-Policy': 'same-origin' };
                if (!r || !r.url)
                    return new Response(Specifiers.thrower(r && r.dynamicMessage ? r.dynamicMessage : `Failed to resolve module specifier '${spec}'`), { headers });
                const target = realm && r.url.startsWith('https://') ? `${self.location.origin}/__chitin/r/${realm}/o/https/${r.url.slice('https://'.length)}` : r.url;
                return Response.redirect(target, 302);
            })());
            return;
        }
        if (url.pathname === UNRESOLVABLE) {
            // A specifier the import map blocks: importing it throws Chrome's TypeError (mapSpecifiers).
            const message = url.searchParams.get('m') || 'Failed to resolve module specifier';
            event.respondWith(new Response(Specifiers.thrower(message, url.searchParams.get('n')), { headers: { 'Content-Type': 'text/javascript', 'Cross-Origin-Resource-Policy': 'same-origin' } }));
            return;
        }
        const accessor = /^\/__chitin\/r\/(\d+)\/realm\.mjs$/.exec(url.pathname);
        if (accessor) {
            event.respondWith(new Response(REALM_ACCESSOR, { headers: { 'Content-Type': 'text/javascript', 'Cross-Origin-Resource-Policy': 'same-origin' } }));
            return;
        }
        const mirror = realmMirror(url);
        if (mirror) {
            event.respondWith(fromEngineForRealm(event, mirror));
            return;
        }
        const target = mirrorTarget(url);
        if (target) {
            event.respondWith(fromEngine(event, target));
            return;
        }
        // import() in a classic script resolves against the script's URL, which is a name under this origin's mirror
        // (worker.js runScript): a root-absolute specifier ('/libcurl/index.mjs') lands at this origin's root, not the site's.
        // The request's referrer is the importing script's mirror name; the site's file is the same path on that host. The
        // segment's own files (/chitin/, /__chitin/) never come from a mirrored script and stay ours.
        if (!url.pathname.startsWith('/chitin/') && !url.pathname.startsWith('/__chitin/') && event.request.referrer) {
            let referrer = null;
            try { referrer = new URL(event.request.referrer); } catch { /* none */ }
            // A frame realm's module importing a root-absolute specifier stays in the realm's graph.
            const realm = referrer && referrer.origin === self.location.origin ? /^\/__chitin\/r\/(\d+)\/o\/https\/([^/?#]+)\//.exec(referrer.pathname) : null;
            if (realm) {
                event.respondWith(Response.redirect(`${self.location.origin}/__chitin/r/${realm[1]}/o/https/${realm[2]}${url.pathname}${url.search}`, 302));
                return;
            }
            const host = referrer && referrer.origin === self.location.origin ? /^\/__chitin\/o\/https\/([^/?#]+)\//.exec(referrer.pathname) : null;
            if (host) {
                event.respondWith(fromEngine(event, `https://${host[1]}${url.pathname}${url.search}`));
                return;
            }
        }
        return; // the segment's own files
    }
    // The engine's own network requests (the Worker's fetch to the phase-0 network stand-in) go
    // straight out: answering them from the engine would send the engine its own request back.
    // In phase 1 the engine's network is a MessagePort to Spiracle and this exception goes away.
    if (url.origin === STANDIN_ORIGIN)
        return;
    // Site URLs come from the engine. Anything else (http:, ws:, other local origins) fails
    // closed: it must never reach the host network, around Spiracle and Tor.
    if (url.protocol !== 'https:') {
        event.respondWith(Response.error());
        return;
    }
    event.respondWith(fromEngine(event));
});
