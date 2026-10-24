// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// The segment Worker: the engine (Ganglion toy, wasm) and the site's JavaScript, in one realm.
//
// This host script runs first. It takes what it needs from the Worker global (ports, fetch,
// importScripts, canvases) into its closure, boots the glue, hides the Worker's own messaging and
// network APIs from page JS, and only then runs the site's scripts. Frames go to the carapace over
// its MessagePort; input comes back on the same port.
'use strict';
(() => {
    const G = self;
    let lastSource = null; // the document's bytes as the engine got them (the context menu's View page source)
    const hostFetch = G.fetch.bind(G);
    const hostImportScripts = G.importScripts.bind(G);
    const hostAddEventListener = G.addEventListener.bind(G);
    const hostRemoveEventListener = G.removeEventListener.bind(G);
    const hostSetTimeout = G.setTimeout.bind(G);
    const hostClearTimeout = G.clearTimeout.bind(G);
    const hostClose = G.close.bind(G);
    const HostOffscreenCanvas = G.OffscreenCanvas;
    // The fallback font subsets (docs/fonts.md) are kept in this origin's Cache Storage, captured before page code can
    // replace or virtualize `caches`.
    const fallbackFontCache = (() => {
        const storage = G.caches;
        if (!storage || !G.CacheStorage || !G.Cache || !G.Response)
            return null;
        const open = G.CacheStorage.prototype.open, match = G.Cache.prototype.match, put = G.Cache.prototype.put;
        const clone = G.Response.prototype.clone, arrayBuffer = G.Response.prototype.arrayBuffer;
        let cache = null;
        return async (url) => {
            const apply = Reflect.apply;
            try {
                cache = cache || await apply(open, storage, ['chitin-fallback-fonts-1']);
            } catch (e) {
                cache = null;
            }
            let response = cache ? await apply(match, cache, [url]) : undefined;
            if (!response) {
                response = await hostFetch(url);
                if (!response.ok)
                    throw new Error('fallback font ' + url + ': HTTP ' + response.status);
                if (cache)
                    await apply(put, cache, [url, apply(clone, response, [])]).catch(() => {});
            }
            return new G.Uint8Array(await apply(arrayBuffer, response, []));
        };
    })();
    const hostLanguages = (() => { try { return Array.from(G.navigator.languages || [G.navigator.language || 'en-US']); } catch (e) { return ['en-US']; } })();
    // A synchronous request to the segment's service worker (staging a classic script, runScript): a fetch event wakes a
    // stopped service worker, a message on its port does not (and is lost with it).
    const stageSync = (() => {
        const X = G.XMLHttpRequest;
        if (!X)
            return null;
        const apply = Reflect.apply, P = X.prototype;
        const open = P.open, send = P.send, setHeader = P.setRequestHeader;
        const d = Object.getOwnPropertyDescriptor(P, 'status');
        if (!d || !d.get || typeof open !== 'function' || typeof send !== 'function' || typeof setHeader !== 'function')
            return null;
        const statusGet = d.get;
        const endpoint = `${location.origin}/__chitin/stage`; // now: the page's location replaces the global's later
        return (url, text) => {
            const x = new X();
            apply(open, x, ['POST', endpoint, false]);
            apply(setHeader, x, ['x-chitin-stage', url]);
            apply(send, x, [text]);
            return apply(statusGet, x, []);
        };
    })();
    // The segment's own persistence (below) uses IndexedDB, which is removed from the global and whose interfaces
    // lose their members before page code exists (removeHostDoors): what is needed is captured here, as functions.
    const IDB = (() => {
        const factory = G.indexedDB;
        if (!factory)
            return null;
        const apply = Reflect.apply;
        const method = (C, n) => { const f = C.prototype[n]; return (self, a, b, c) => apply(f, self, [a, b, c]); };
        const getter = (C, n) => { const g = Object.getOwnPropertyDescriptor(C.prototype, n).get; return (self) => apply(g, self, []); };
        const listen = G.EventTarget.prototype.addEventListener;
        return {
            factory,
            open: method(G.IDBFactory, 'open'),
            result: getter(G.IDBRequest, 'result'),
            error: getter(G.IDBRequest, 'error'),
            transaction: method(G.IDBDatabase, 'transaction'),
            close: method(G.IDBDatabase, 'close'),
            createObjectStore: method(G.IDBDatabase, 'createObjectStore'),
            objectStore: method(G.IDBTransaction, 'objectStore'),
            txError: getter(G.IDBTransaction, 'error'),
            get: method(G.IDBObjectStore, 'get'),
            put: method(G.IDBObjectStore, 'put'),
            delete: method(G.IDBObjectStore, 'delete'),
            add: method(G.IDBObjectStore, 'add'),
            getAll: method(G.IDBObjectStore, 'getAll'),
            clear: method(G.IDBObjectStore, 'clear'),
            on: (target, type, fn) => apply(listen, target, [type, fn]),
        };
    })();
    // Synchronous streams (a synchronous XMLHttpRequest, docs/network.md "Synchronous requests"): the engine blocks this
    // thread, so their events come through a ring in shared memory that the segment document fills from its own port to
    // Spiracle (segment.js). Taken before the surface reshapes Atomics.wait for page code. Needs cross-origin isolation.
    const SyncRing = (() => {
        const SAB = G.SharedArrayBuffer, A = G.Atomics;
        if (!SAB || !A || !G.crossOriginIsolated)
            return null;
        const wait = A.wait, load = A.load, store = A.store, notify = A.notify;
        const CAP = 4 << 20;
        const sab = new SAB(16 + CAP);
        const i32 = new G.Int32Array(sab, 0, 4), bytes = new G.Uint8Array(sab, 16, CAP);
        const read = (pos, n) => { const out = new G.Uint8Array(n); for (let i = 0; i < n; i++) out[i] = bytes[(pos + i) % CAP]; return out; };
        const u32 = (pos) => { const b = read(pos, 4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; };
        const open = new Set();
        return {
            sab,
            opened: (id) => open.add(id),
            // Events written since the last call; while a synchronous stream is open, blocks up to `ms` (-1: in slices) for one.
            take(ms) {
                let w = load(i32, 0) >>> 0, r = load(i32, 1) >>> 0;
                if (w === r) {
                    // Nothing synchronous is open: this nested wait is not a synchronous request's, and blocking would only
                    // delay it (the old behaviour: pump again at once).
                    if (open.size === 0)
                        return null;
                    Reflect.apply(wait, A, [i32, 0, w | 0, ms < 0 ? 100 : ms]);
                    w = load(i32, 0) >>> 0;
                }
                const events = [];
                while (r !== w) {
                    const pos = r % CAP;
                    const kind = u32(pos), id = u32(pos + 4), len = u32(pos + 8);
                    let size = 12;
                    if (kind === 1)
                        events.push({ t: 'open', s: id });
                    else if (kind === 2) {
                        events.push({ t: 'data', s: id, b: read(pos + 12, len) });
                        size += (len + 3) & ~3;
                    } else {
                        events.push({ t: 'close', s: id, code: len });
                        open.delete(id);
                    }
                    r = (r + size) >>> 0;
                }
                store(i32, 1, r | 0);
                notify(i32, 1);
                return events;
            },
        };
    })();
    const hostNow = G.performance.now.bind(G.performance);
    const timeOrigin = G.performance.timeOrigin;
    const ORIGIN = `http://origin.localhost:${location.port}`;
    const WORKER_ORIGIN = location.origin; // before the page's location replaces the global's

    hostImportScripts('/chitin/ganglion.js');
    const boot = G.__chitinBoot;
    delete G.__chitinBoot;
    hostImportScripts('/chitin/ganglion-engine.js');
    const engineBoot = G.__chitinEngineBoot;
    delete G.__chitinEngineBoot;
    const HostWebAssembly = G.WebAssembly;
    const hostCreateImageBitmap = G.createImageBitmap ? G.createImageBitmap.bind(G) : undefined;
    const HostImageDecoder = G.ImageDecoder;
    const HostBlob = G.Blob;
    const hostPromiseAll = G.Promise.all.bind(G.Promise);
    const HostUint8Array = G.Uint8Array;
    const HostMessageChannel = G.MessageChannel; // with page scripting on, the global one is the engine's
    // The jar's changes carry HttpOnly values: posted with the host's own postMessage, taken now (docs/cookies.md).
    const hostPortPost = G.MessagePort ? G.Function.prototype.call.bind(G.MessagePort.prototype.postMessage) : (p, msg) => p.postMessage(msg);
    const hostDigest = G.crypto && G.crypto.subtle ? G.crypto.subtle.digest.bind(G.crypto.subtle) : null; // import maps' integrity (moduleIntegrityOK)
    const HostURL = G.URL;
    const hostBtoa = typeof G.btoa === 'function' ? G.btoa.bind(G) : null;
    const ENGINE_FONTS = ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf', 'NotoSans-Italic.ttf', 'NotoSerif-Regular.ttf', 'NotoSerif-Bold.ttf', 'NotoSansMono-Regular.ttf', 'Cousine-Regular.ttf', 'Cousine-Bold.ttf', 'Cousine-Italic.ttf', 'Cousine-BoldItalic.ttf'];

    // Import maps for classic scripts' import() (docs/architecture.md "Import maps"): the service worker's parser and rule, here
    // because a classic script is staged and run synchronously (the service worker cannot ask this Worker while importScripts
    // blocks it). Taken off the global before page code exists.
    hostImportScripts('/chitin/acorn.js', '/chitin/specifiers.js');
    const Acorn = G.acorn, Specifiers = G.ChitinSpecifiers;
    delete G.acorn;
    delete G.ChitinSpecifiers;

    // Transferable streams between the engine's page and the host (harness/segment/streams.js): the host's own stream classes are
    // taken now, before the engine's replace them on the global.
    hostImportScripts('/chitin/streams.js');
    const Streams = G.__chitinStreams.create({ ReadableStream: G.ReadableStream, WritableStream: G.WritableStream, TransformStream: G.TransformStream, DOMException: G.DOMException });
    delete G.__chitinStreams;
    // Page service workers, the segment's side (harness/segment/pagesw-host.js): it captures what it needs now.
    hostImportScripts('/chitin/pagesw-host.js');
    const PageSW = G.__chitinPageSW;
    delete G.__chitinPageSW;
    // OPFS for the page (harness/segment/opfs.js): it captures the host's file system objects before the doors take them.
    hostImportScripts('/chitin/opfs.js');
    const OPFS = G.__chitinOPFS.create({ sync: false });
    delete G.__chitinOPFS;
    let opfsState = null;
    // WebSocket for the page (harness/segment/websocket.js): the host's WebSocket is a door and goes; this is RFC 6455 over the
    // engine's own network (an upgrade request through Spiracle and the relay's allowlist, TLS in the engine). It captures the
    // host's crypto and timers before the doors.
    hostImportScripts('/chitin/websocket.js');
    const WebSockets = G.__chitinWebSocket.create();
    delete G.__chitinWebSocket;
    let webSocketState = null;
    // WebRTC and capture for the page (harness/segment/rtc.js, docs/webrtc.md): interfaces whose objects are the segment document's
    // host RTCPeerConnections and capture tracks (a Worker has none), over a port of their own.
    hostImportScripts('/chitin/rtc.js');
    const RTC = G.__chitinRTC.create();
    delete G.__chitinRTC;
    let rtcPort = null;
    let rtcState = null;
    // Encrypted Media Extensions for the page (harness/segment/eme.js): forwarded to the segment document's own EME, the
    // host's CDM (docs/eme.md). Loaded before the doors; installed with page scripting.
    hostImportScripts('/chitin/eme.js');
    const EME = G.__chitinEME.create();
    delete G.__chitinEME;
    let emeState = null;
    // What the page's WebSockets did, for the Segment panel: asked for, upgraded, open now, the last transport error.
    const wsCount = { requested: 0, upgraded: 0, open: new Set(), lastError: '' };
    const reportWebSockets = () => status('websockets', `${wsCount.requested} asked for, ${wsCount.upgraded} upgraded, ${wsCount.open.size} open` + (wsCount.lastError ? `, last error: ${wsCount.lastError}` : ''));
    // --- Removing the host's doors before page code exists (harness/segment/doors.js) ---------------
    hostImportScripts('/chitin/doors.js');
    const doors = G.__chitinDoors;
    delete G.__chitinDoors;
    // Names a test runner knows about (Node's gc under --expose-gc); set on the global before this script.
    const surfaceExtra = Array.isArray(G.__chitinSurfaceExtra) ? G.__chitinSurfaceExtra : [];
    delete G.__chitinSurfaceExtra;
    const surfaceProblem = doors.removeHostDoors(G, surfaceExtra);

    let port;          // to the carapace
    let netPort;       // to Spiracle (the carapace's network Worker): TCP streams for the engine
    let swPort;        // to the service worker
    let control;       // to the segment document (it starts the runners of the page's own service workers)
    let pageSW = null; // page service workers (pagesw-host.js), once the engine runs
    let host;          // the toy engine host API (private)
    let engine;        // the Ganglion engine API (private), when the engine is ganglion
    let timerHandle = 0;
    let paint;
    let canvas;
    let ctx2d;
    let state;
    let stopped = false;
    // Ends the segment: tell the carapace why, then close the Worker. Nothing of the page runs after this.
    function stopSegment(reason) {
        stopped = true;
        if (port) {
            port.postMessage({ type: 'status', key: 'segment stopped', value: reason });
            port.postMessage({ type: 'stopped', reason });
        }
        hostClose();
    }
    const report = Object.create(null); // results the carapace shows (harness only)
    // Status lines go to the carapace's guard, which kills a segment that sends more than 40 a second (harness/carapace/guard.mjs).
    // A page that fails in a loop (a timer, a stream, a frame tick: each reports) must not get there, so lines leave through a
    // token bucket under that limit; the ones held back keep only the newest value of each key and go out as tokens return.
    // The Segment panel shows one value per key, so nothing it could show is lost.
    const STATUS_BURST = 20, STATUS_PER_SECOND = 10;
    let statusTokens = STATUS_BURST;
    let statusRefilled = hostNow();
    let statusFlush = 0;
    const heldStatus = new Map();
    const takeStatusToken = () => {
        const t = hostNow();
        statusTokens = Math.min(STATUS_BURST, statusTokens + ((t - statusRefilled) * STATUS_PER_SECOND) / 1000);
        statusRefilled = t;
        if (statusTokens < 1)
            return false;
        statusTokens -= 1;
        return true;
    };
    const flushStatus = () => {
        statusFlush = 0;
        for (const [key, value] of heldStatus) {
            if (!takeStatusToken())
                break;
            heldStatus.delete(key);
            if (port)
                port.postMessage({ type: 'status', key, value });
        }
        if (heldStatus.size > 0)
            statusFlush = hostSetTimeout(flushStatus, 250);
    };
    // Once the engine has stopped (the first trap), every later call into it refuses with the same words; those refusals say nothing
    // new and arrive from every timer, stream and frame tick, so they are not reported again.
    let engineStopped = false;
    const status = (key, value) => {
        if (engineStopped && typeof value === 'string' && value.includes('ganglion: the engine stopped:'))
            return;
        report[key] = value;
        if (!port)
            return;
        if (heldStatus.size === 0 && takeStatusToken()) {
            port.postMessage({ type: 'status', key, value });
            return;
        }
        heldStatus.delete(key); // the newest value of a key goes last
        heldStatus.set(key, value);
        if (!statusFlush)
            statusFlush = hostSetTimeout(flushStatus, 250);
    };

    // --- Service-worker control (docs/security.md, item 3) -------------------------------------------
    // Page scripts may run only while the segment's service worker controls this Worker: otherwise V8
    // would fetch the site's script and module URLs from the host network, with the user's IP, around
    // Spiracle. The probe is an import of a URL only the service worker answers. Each probe has its own
    // URL, because a repeated one is answered from the module map and proves nothing.
    let nonce = '';
    let probes = 0;
    async function controlled() {
        try {
            const hello = await import(`/__chitin/hello.mjs?nonce=${encodeURIComponent(nonce)}&probe=${++probes}`);
            return hello.controlled === true;
        } catch {
            return false;
        }
    }
    // True while it is safe to load page code; otherwise the segment is stopped (not left half-running).
    // A browser terminates an idle service worker (about 30 s) and starts it again for the next fetch: a probe that
    // lands in that window can fail once with the worker back a moment later. Control counts as lost only when
    // several probes in a row, each with its own URL, find nothing answering. The service worker itself re-requests
    // its engine port when a probe finds it restarted (sw.js), so what it holds in memory is rebuilt before the
    // answer. The retry costs a stopped segment at most `attempts` * `gapMs` more before it closes.
    async function stillControlled(attempts = 3, gapMs = 300) {
        if (stopped)
            return false;
        for (let i = 0; i < attempts; i++) {
            if (await controlled())
                return true;
            if (i + 1 < attempts)
                await new Promise((resolve) => hostSetTimeout(resolve, gapMs));
            if (stopped)
                return false;
        }
        stopSegment('the segment\'s service worker no longer controls this Worker: page code would reach the host network, so the segment stopped');
        return false;
    }
    // While the engine runs page scripts there is no hook before a V8 import(), so control is re-checked on a timer.
    function watchControl() {
        hostSetTimeout(async () => {
            if (await stillControlled())
                watchControl();
        }, 5000);
    }

    // --- The engine's network -------------------------------------------------------------------
    // The test sites (*.example) come from the harness's origin stand-in, as in phase 0. Everything
    // else the engine fetches itself: TLS and HTTP inside the engine, TCP streams from Spiracle over
    // netPort (one message per event, stream ids chosen by the engine).
    const isStandIn = (url) => new URL(url).hostname.endsWith('.example');
    const net = {
        connect: (id, host, portNumber) => netPort.postMessage({ t: 'connect', s: id, host, port: portNumber }),
        write: (id, bytes) => { const b = new Uint8Array(bytes); netPort.postMessage({ t: 'data', s: id, b: b.buffer }, [b.buffer]); },
        close: (id) => netPort.postMessage({ t: 'close', s: id }),
        connectSync: (id, host, portNumber) => {
            if (!syncReady)
                return netPort.postMessage({ t: 'connect', s: id, host, port: portNumber });
            SyncRing.opened(id);
            netPort.postMessage({ t: 'connect', s: id, host, port: portNumber, aux: true });
        },
        waitSync: (ms) => (syncReady ? SyncRing.take(ms) : null),
    };
    let syncReady = false;
    // The aux port: Spiracle sends a synchronous stream's events there, and the segment document writes them into the ring.
    function startSyncNet() {
        if (!SyncRing || !netPort || !control)
            return;
        const ch = new HostMessageChannel();
        netPort.postMessage({ t: 'aux' }, [ch.port1]);
        control.postMessage({ type: 'sync-net', id: 0, sab: SyncRing.sab }, [ch.port2]);
        syncReady = true;
    }
    function onNetMessage(e) {
        const m = e.data;
        if (!engine || !m || engineStopped)
            return;
        try {
            if (m.t === 'open')
                engine.tcpOpened(m.s);
            else if (m.t === 'data')
                engine.tcpData(m.s, new HostUint8Array(m.b));
            else if (m.t === 'close')
                engine.tcpClosed(m.s, m.code | 0);
        } catch (err) {
            status('network error', String(err && err.stack || err));
        }
        scheduleTimers();
    }
    const engineCache = new Map();
    // A media file of a stand-in site streams into the engine as it arrives (the element demuxes before the end), with
    // the request's byte range passed on; it is not cached.
    const isStandInMedia = (url) => isStandIn(url) && /\.(webm|mp4|m4a|m4v|mp3|ogg|opus|flac|wav)$/i.test(new URL(url).pathname);
    async function streamedStandIn(url, request) {
        const u = new URL(url);
        const headers = {};
        for (const [name, value] of (request && request.headers) || [])
            if (/^range$/i.test(name))
                headers.Range = value;
        const r = await hostFetch(`${ORIGIN}/${u.host}${u.pathname}${u.search}`, { mode: 'cors', credentials: 'omit', headers });
        const out = { 'content-type': r.headers.get('content-type') || 'application/octet-stream' };
        for (const name of ['content-length', 'content-range', 'accept-ranges'])
            if (r.headers.get(name))
                out[name] = r.headers.get(name);
        const reader = r.body.getReader();
        return { status: r.status, headers: out, read: () => reader.read() };
    }

    const STAND_IN_HEADERS = ['cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'access-control-allow-origin'];
    async function engineFetch(url) {
        const u = new URL(url);
        if (u.protocol !== 'https:')
            return { status: 400, headers: { 'content-type': 'text/plain' }, body: new ArrayBuffer(0) };
        const cached = engineCache.get(u.href);
        if (cached)
            return cached;
        let result;
        if (isStandIn(u.href)) {
            const r = await hostFetch(`${ORIGIN}/${u.host}${u.pathname}${u.search}`, { mode: 'cors', credentials: 'omit' }); // the query too (?delay, ?rate: test knobs)
            const body = await r.arrayBuffer();
            result = { status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'application/octet-stream' }, body };
            // A test site's own policy headers (harness/sites/<site>/_headers.json): COOP, COEP, CORP, as a real site's response has them.
            for (const name of STAND_IN_HEADERS)
                if (r.headers.get(name) !== null && !(name === 'access-control-allow-origin' && /\.localhost(:\d+)?$/.test(r.headers.get(name))))
                    result.headers[name] = r.headers.get(name);
        } else {
            // A real site's file (a module's import, a chunk): the engine fetches it over its own network, like any page fetch.
            const r = await engine.fetchBytes(u.href);
            result = { status: r.status, headers: { 'content-type': r.contentType || 'application/octet-stream' }, body: r.body };
        }
        engineCache.set(u.href, result);
        return result;
    }
    const decoder = new TextDecoder();
    const engineText = async (url) => decoder.decode((await engineFetch(url)).body);

    // Subresource Integrity for a module the import map names ("integrity" in the map): the strongest algorithm the metadata
    // has, any of its digests matching (SRI "do bytes match metadataList"). Unknown algorithms only: it matches.
    const SRI_ALGORITHMS = { sha256: ['SHA-256', 1], sha384: ['SHA-384', 2], sha512: ['SHA-512', 3] };
    async function moduleIntegrityOK(bytes, metadata) {
        const items = [];
        for (const token of String(metadata).split(/[ \t\n\f\r]+/)) {
            const m = /^(sha256|sha384|sha512)-([A-Za-z0-9+/_-]+={0,2})(\?.*)?$/.exec(token);
            if (m)
                items.push({ alg: m[1], digest: m[2].replace(/-/g, '+').replace(/_/g, '/') });
        }
        if (!items.length)
            return true;
        if (!hostDigest || !hostBtoa)
            return false;
        const strongest = Math.max(...items.map((i) => SRI_ALGORITHMS[i.alg][1]));
        for (const item of items.filter((i) => SRI_ALGORITHMS[i.alg][1] === strongest)) {
            const d = new HostUint8Array(await hostDigest(SRI_ALGORITHMS[item.alg][0], bytes));
            let bin = '';
            for (const b of d)
                bin += String.fromCharCode(b);
            if (hostBtoa(bin).replace(/=+$/, '') === item.digest.replace(/=+$/, ''))
                return true;
        }
        return false;
    }

    const stageAcks = new Map();
    function onServiceWorkerMessage(e) {
        const m = e.data;
        if (m && m.type === 'staged') {
            const ack = stageAcks.get(m.ack);
            if (ack) {
                stageAcks.delete(m.ack);
                ack();
            }
            return;
        }
        if (m && m.type === 'resolve') {
            // Import maps (docs/architecture.md): the service worker found these specifiers in a page module at m.base.
            let results = null;
            try { results = engine ? engine.importMapResolve(m.realm || 0, m.base, m.specifiers) : null; } catch (e) { status('import map', String(e && e.message || e)); }
            swPort.postMessage({ id: m.id, results });
            return;
        }
        if (!m || m.type !== 'fetch')
            return;
        // A page module's import (V8's module loading asks with mode cors): whether the document has an import map (the service
        // worker then looks for specifiers to resolve), and the map's integrity for this URL.
        const isModule = m.mode === 'cors' && (m.destination === 'script' || m.destination === 'worker') && !m.bypass;
        // A runner's own load (the page's worker's importScripts): the engine's network, never the page's worker.
        const fetched = m.bypass && !isStandIn(m.url) ? (pageSW ? pageSW.bypassFetch(m.url) : Promise.reject(new Error('no page service worker'))) : engineFetch(m.url);
        fetched.then(
            async (r) => {
                const body = r.body.slice(0); // the cache keeps its copy
                let importMap = false;
                if (isModule && engine && r.status >= 200 && r.status <= 299) {
                    try {
                        importMap = engine.importMapActive(m.realm || 0);
                        const integrity = engine.importMapIntegrity(m.realm || 0, m.url);
                        if (integrity && !(await moduleIntegrityOK(body, integrity))) {
                            swPort.postMessage({ id: m.id, error: 'integrity' });
                            return;
                        }
                    } catch (e) { status('import map', String(e && e.message || e)); }
                }
                // A module of a frame realm's graph: the names its prologue binds (harness/segment/sw.js realmPrologue).
                let bindings;
                if (m.realm && engine && r.status >= 200 && r.status <= 299) {
                    try { bindings = engine.frameModuleBindings(m.realm, new TextDecoder().decode(body)); } catch (e) { status('frame module', String(e && e.message || e)); }
                }
                swPort.postMessage({ id: m.id, status: r.status, headers: r.headers, body, bindings, importMap }, [body]);
            },
            (err) => swPort.postMessage({ id: m.id, error: String(err) }),
        );
    }

    // --- localStorage, persisted ---------------------------------------------------------------------
    // The engine keeps web storage in memory (Host.cpp) and a document is a Worker: the next document of the site
    // starts with nothing unless this Worker keeps it. The segment's origin is the site's, so its IndexedDB is the
    // site's alone (docs/architecture.md, "Storage"); page code never sees it (it is removed from the global below).
    // The engine says when localStorage changed; the copy is taken shortly after (a page changes it in bursts) and
    // always before a navigation request leaves (the next segment may start before this Worker is gone).
    const STORAGE_DB = 'chitin-segment-storage';
    // Chrome's open can fail with UnknownError ("Internal error opening database with version 1", seen once on YouTube in a
    // fresh headless profile, build/live-yt5; not reproduced under open/close churn from several Workers or terminated
    // Workers holding connections): the backing store failed to open, which Chrome documents as transient. The open is
    // retried twice (100 ms, 400 ms) before the error is reported; a blocked or version error is not retried.
    function openStorageDbOnce() {
        return new Promise((resolve, reject) => {
            const request = IDB.open(IDB.factory, STORAGE_DB, 1);
            IDB.on(request, 'upgradeneeded', () => IDB.createObjectStore(IDB.result(request), 'kv'));
            IDB.on(request, 'success', () => resolve(IDB.result(request)));
            IDB.on(request, 'error', () => reject(IDB.error(request)));
        });
    }
    // One connection for the Worker's life, as the journal's (below): opening and closing per operation, thousands of times
    // while the page writes heavily, ended with every later open of the database refused ("Internal error opening database
    // with version 1", in that run and the next segment's: the registrations and localStorage were lost). A connection
    // that is asked to close (Clear-Site-Data, a deletion) or closes is dropped and the next operation opens again.
    let storageDbOpen = null;
    function openStorageDb() {
        if (!storageDbOpen)
            storageDbOpen = openStorageDbRetrying().then((db) => {
                const drop = () => { storageDbOpen = null; };
                IDB.on(db, 'versionchange', () => { drop(); IDB.close(db); });
                IDB.on(db, 'close', drop);
                return db;
            }, (e) => { storageDbOpen = null; throw e; });
        return storageDbOpen;
    }
    const keepStorageDb = () => {}; // the shared connection stays open (callers used to close theirs)
    async function openStorageDbRetrying() {
        for (let attempt = 0; ; attempt++) {
            try {
                return await openStorageDbOnce();
            } catch (e) {
                if (attempt >= 2 || !e || e.name !== 'UnknownError')
                    throw e;
                await new Promise((resolve) => hostSetTimeout(resolve, attempt === 0 ? 100 : 400));
            }
        }
    }
    async function loadLocalStorage() {
        if (!IDB)
            return [];
        try {
            const db = await openStorageDb();
            return await new Promise((resolve) => {
                const request = IDB.get(IDB.objectStore(IDB.transaction(db, 'kv'), 'kv'), 'localStorage');
                IDB.on(request, 'success', () => { const r = IDB.result(request); resolve(Array.isArray(r) ? r : []); });
                IDB.on(request, 'error', () => resolve([]));
            });
        } catch (e) {
            status('storage error', 'restore: ' + String(e && e.message || e));
            return [];
        }
    }
    async function saveLocalStorage(entries) {
        const db = await openStorageDb();
        try {
            await new Promise((resolve, reject) => {
                const tx = IDB.transaction(db, 'kv', 'readwrite');
                IDB.put(IDB.objectStore(tx, 'kv'), entries, 'localStorage');
                IDB.on(tx, 'complete', resolve);
                IDB.on(tx, 'error', () => reject(IDB.txError(tx)));
                IDB.on(tx, 'abort', () => reject(IDB.txError(tx)));
            });
        } finally {
            keepStorageDb(db);
        }
    }
    let storageDirty = false;
    let storageTimer = 0;
    let storageWrites = Promise.resolve();
    function storageChanged() {
        storageDirty = true;
        if (!storageTimer && IDB)
            storageTimer = hostSetTimeout(() => { storageTimer = 0; flushLocalStorage(); }, 50);
    }
    // Takes the engine's copy now, if it changed; resolves when everything taken so far is written.
    function flushLocalStorage() {
        if (storageTimer) {
            hostClearTimeout(storageTimer);
            storageTimer = 0;
        }
        if (storageDirty && IDB && engine) {
            storageDirty = false;
            try {
                engine.storageFlush();
            } catch (e) {
                status('storage error', 'flush: ' + String(e && e.message || e));
            }
        }
        return hostPromiseAll([storageWrites, idbJournalWrites]);
    }
    function storageTaken(entries) {
        storageWrites = storageWrites.then(() => saveLocalStorage(entries)).then(() => status('localStorage saved', entries.length + ' entries')).catch((e) => status('storage error', 'save: ' + String(e && e.message || e)));
    }

    // --- The page's IndexedDB across reloads (docs/architecture.md "IndexedDB across reloads") -------------------------
    // The engine's databases live in its memory; each committed transaction gives a journal entry (LibWeb's
    // IndexedDB/Internal/Persistence.h, patch 0066), appended here to this origin's own database in commit order. The next
    // segment of the site replays the entries before its first page runs and replaces them with one snapshot. One
    // connection stays open (opening per write churns the backing store).
    const IDB_JOURNAL_DB = 'chitin-segment-idb';
    let idbJournalOpen = null;
    let idbJournalWrites = Promise.resolve();
    function idbJournal() {
        if (!idbJournalOpen)
            idbJournalOpen = new Promise((resolve, reject) => {
                const request = IDB.open(IDB.factory, IDB_JOURNAL_DB, 1);
                IDB.on(request, 'upgradeneeded', () => IDB.createObjectStore(IDB.result(request), 'journal', { autoIncrement: true }));
                IDB.on(request, 'success', () => {
                    const db = IDB.result(request);
                    IDB.on(db, 'versionchange', () => { idbJournalOpen = null; IDB.close(db); });
                    IDB.on(db, 'close', () => { idbJournalOpen = null; });
                    resolve(db);
                });
                IDB.on(request, 'error', () => reject(IDB.error(request)));
            }).catch((e) => { idbJournalOpen = null; throw e; });
        return idbJournalOpen;
    }
    function idbJournalTx(mode, fn) {
        return idbJournal().then((db) => new Promise((resolve, reject) => {
            const tx = IDB.transaction(db, 'journal', mode);
            const r = fn(IDB.objectStore(tx, 'journal'));
            IDB.on(tx, 'complete', () => resolve(r ? IDB.result(r) : undefined));
            IDB.on(tx, 'error', () => reject(IDB.txError(tx)));
            IDB.on(tx, 'abort', () => reject(IDB.txError(tx)));
        }));
    }
    function idbPersist(entry) {
        if (!IDB)
            return;
        idbJournalWrites = idbJournalWrites.then(() => idbJournalTx('readwrite', (store) => { IDB.add(store, entry); return null; }))
            .catch((e) => status('IndexedDB persistence', 'save: ' + String(e && e.message || e)));
    }
    async function idbRestore() {
        if (!IDB)
            return;
        let entries;
        try {
            entries = await idbJournalTx('readonly', (store) => IDB.getAll(store));
        } catch (e) {
            status('IndexedDB persistence', 'restore: ' + String(e && e.message || e));
            return;
        }
        if (!entries || !entries.length) {
            status('IndexedDB restored', 'nothing stored');
            return;
        }
        const t = hostNow();
        const r = engine.idbRestore(entries.map((e) => new HostUint8Array(e.buffer || e)));
        let bytes = 0;
        for (const e of entries)
            bytes += e.byteLength;
        status('IndexedDB restored', `${r.applied} journal entries (${(bytes / 1048576).toFixed(1)} MiB) in ${(hostNow() - t).toFixed(0)} ms` + (r.failed ? `, ${r.failed} damaged (skipped)` : ''));
        if (entries.length > 1 || r.failed) {
            const snapshot = engine.idbSnapshot();
            idbJournalWrites = idbJournalWrites.then(() => idbJournalTx('readwrite', (store) => { IDB.clear(store); if (snapshot.length) IDB.add(store, snapshot); return null; }))
                .catch((e) => status('IndexedDB persistence', 'compact: ' + String(e && e.message || e)));
        }
    }

    // --- Page service workers (docs/architecture.md, "Page service workers") ---------------------------------------
    // Registrations and the page worker's CacheStorage persist in this origin's IndexedDB (the site's alone), in the
    // same database as localStorage, one key per record. Runners are started by the segment document (this Worker's CSP
    // has worker-src 'none'); each gets a host MessagePort to this Worker and nothing else.
    async function kvOp(mode, fn) {
        if (!IDB)
            throw new Error('no IndexedDB');
        const db = await openStorageDb();
        try {
            return await new Promise((resolve, reject) => {
                const tx = IDB.transaction(db, 'kv', mode);
                const result = fn(IDB.objectStore(tx, 'kv'));
                IDB.on(tx, 'complete', () => resolve(result ? IDB.result(result) : undefined));
                IDB.on(tx, 'error', () => reject(IDB.txError(tx)));
                IDB.on(tx, 'abort', () => reject(IDB.txError(tx)));
            });
        } finally {
            keepStorageDb(db);
        }
    }
    let runnerSeq = 0;
    function startPageServiceWorkers() {
        return PageSW.create({
            streams: Streams,
            log: (text) => status('page service worker', text),
            status: (key, text) => status(key, text),
            store: {
                get: (key) => kvOp('readonly', (store) => IDB.get(store, key)),
                put: (key, value) => kvOp('readwrite', (store) => { IDB.put(store, value, key); return null; }),
                delete: (key) => kvOp('readwrite', (store) => { IDB.delete(store, key); return null; }),
            },
            isStandIn: (url) => isStandIn(url),
            embedderPolicyOf: (global) => (engine && engine.embedderPolicyOf ? engine.embedderPolicyOf(global === G ? undefined : global) : 'unsafe-none'),
            workerEnvironment: (url) => (engine && engine.workerEnvironment ? engine.workerEnvironment(url) : null),
            standInFetch: (url) => engineFetch(url).then((r) => ({ status: r.status, headers: r.headers, body: r.body.slice(0) })),
            netRequest: (method, url, headers, body, cookies) => engine.netRequest(method, url, headers, body, cookies),
            tunnel: { open: (url, headers, handlers) => engine.tunnelOpen(url, headers, handlers), write: (id, bytes) => engine.tunnelWrite(id, bytes), close: (id) => engine.tunnelClose(id) },
            // The worker's script, staged with the segment's service worker under its mirror URL before the runner imports it.
            stage: (url, text) => new Promise((resolve, reject) => {
                if (!swPort) {
                    reject(new Error('no service worker'));
                    return;
                }
                const m = /^https:\/\/([^?#]*)(\?[^#]*)?/.exec(url);
                const mirrored = `${WORKER_ORIGIN}/__chitin/o/https/${m[1]}${m[2] || ''}`;
                const ack = ++scriptSeq;
                stageAcks.set(ack, resolve);
                swPort.postMessage({ type: 'stage', url: mirrored, ack, status: 200, headers: { 'content-type': 'text/javascript' }, body: text });
            }),
            afterEngineCall: () => scheduleTimers(),
            messageEvent: (C, data, ports) => (engine && engine.messageEvent ? engine.messageEvent(C, data, ports) : new C('message', { data, ports })),
            dispatchTrusted: (target, event) => (engine && engine.dispatchTrusted ? engine.dispatchTrusted(target, event) : target.dispatchEvent(event)),
            startRunner: async () => {
                if (stopped || !control)
                    throw new Error('the segment stopped');
                const channel = new HostMessageChannel();
                const id = ++runnerSeq;
                channel.port1.__runner = id;
                control.postMessage({ type: 'start-page-sw', id, nonce }, [channel.port2]);
                return channel.port1;
            },
            stopRunner: (p) => { if (control && p.__runner) control.postMessage({ type: 'stop-page-sw', id: p.__runner }); },
        });
    }

    // --- Frames ------------------------------------------------------------------------------------
    const rafCallbacks = new Map();
    let rafId = 0;
    let lastInputTs = 0;
    let lastInputSeq = 0;
    const shownVideo = new Map(); // video layer id -> the host frame last sent for it (docs/youtube.md)
    let pendingLayers = null; // the last layered paint, until its reply goes // the carapace's number of the last input applied (its latency benchmark)
    let framesPainted = 0;
    let needsFirstPaint = true;

    function installPageGlobals(withReport) {
        // Page-visible stand-ins for Window APIs the toy does not have. requestAnimationFrame is
        // driven by the carapace's frame messages, not the Worker's own rAF.
        Object.defineProperty(G, 'requestAnimationFrame', { value: (cb) => (rafCallbacks.set(++rafId, cb), rafId), writable: true, configurable: true });
        Object.defineProperty(G, 'cancelAnimationFrame', { value: (id) => rafCallbacks.delete(id), writable: true, configurable: true });
        if (withReport) // a name only the test sites (*.example) know: a real page must not see it (docs/surface.md)
            Object.defineProperty(G, '__chitinReport', { value: (key, value) => status('page: ' + key, value), configurable: true });
        Object.defineProperty(G, 'innerWidth', { get: () => state.width, configurable: true });
        Object.defineProperty(G, 'innerHeight', { get: () => state.height, configurable: true });
    }

    // --- Ganglion: the real engine ---------------------------------------------------------------
    // The image type pattern matching algorithm of MIME Sniffing (section 6.1): the signature decides, never the URL. Bytes
    // with no image signature (a site that answers /favicon.ico with its HTML page) are not an image: null, a broken image,
    // as Chrome treats them, with nothing tried and nothing to report.
    function sniffImageType(bytes) {
        const at = (offset, ...sig) => sig.every((b, i) => bytes[offset + i] === b);
        if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
        if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
        if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
        if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50)) return 'image/webp';
        if (at(0, 0x42, 0x4d)) return 'image/bmp';
        if (at(0, 0x00, 0x00, 0x01, 0x00) || at(0, 0x00, 0x00, 0x02, 0x00)) return 'image/x-icon';
        if (at(4, 0x66, 0x74, 0x79, 0x70) && (at(8, 0x61, 0x76, 0x69, 0x66) || at(8, 0x61, 0x76, 0x69, 0x73))) return 'image/avif';
        return null;
    }
    // Images decode on the host: WebCodecs' ImageDecoder for every frame of an animation, else
    // createImageBitmap. The engine gets RGBA frames and durations.
    let imageFailures = 0;
    async function decodeImage(bytes) {
        const type = sniffImageType(bytes);
        if (!type)
            throw new DOMException('no image signature in the bytes', 'EncodingError');
        const readPixels = (source, width, height) => {
            const c = new HostOffscreenCanvas(width, height);
            const cx = c.getContext('2d', { willReadFrequently: true });
            cx.drawImage(source, 0, 0);
            return cx.getImageData(0, 0, width, height).data;
        };
        if (HostImageDecoder && (type === 'image/gif' || type === 'image/png' || type === 'image/webp' || type === 'image/avif')) {
            try {
                return await decodeFrames(bytes, type, readPixels);
            } catch {
                // WebCodecs refuses some files Chrome's <img> shows (seen: a PNG whose track metadata it could not read):
                // the still decoder below takes them, as the image element's own decoder would.
            }
        }
        const bitmap = await hostCreateImageBitmap(new HostBlob([bytes], { type }));
        // The size is read before close(): a closed ImageBitmap is 0x0 (every JPEG, BMP and ICO came out 0x0, a broken image).
        const width = bitmap.width, height = bitmap.height;
        const rgba = readPixels(bitmap, width, height);
        bitmap.close();
        return { width, height, frames: [{ rgba, duration: 0 }] };
    }
    async function decodeFrames(bytes, type, readPixels) {
        const decoder = new HostImageDecoder({ data: bytes, type });
        await decoder.tracks.ready;
        const count = decoder.tracks.selectedTrack ? decoder.tracks.selectedTrack.frameCount : 1;
        const frames = [];
        for (let i = 0; i < count; i++) {
            const { image } = await decoder.decode({ frameIndex: i });
            frames.push({ rgba: readPixels(image, image.displayWidth, image.displayHeight), duration: Math.round((image.duration || 0) / 1000) });
            if (i === 0)
                var width = image.displayWidth, height = image.displayHeight;
            image.close();
        }
        decoder.close();
        return { width, height, frames };
    }

    // The engine's timers run only when pumped: one chain of host timeouts does it.
    function scheduleTimers() {
        if (timerHandle)
            hostClearTimeout(timerHandle);
        timerHandle = 0;
        if (engineStopped)
            return;
        const ms = engine.pump();
        if (ms >= 0)
            timerHandle = hostSetTimeout(scheduleTimers, ms);
    }

    let navigationStarted = 0;
    let documentNavigated = false; // a document of the site's (not the initial about:blank) is in the engine
    let lastPageURL = '';
    async function loadEngineUrl(url) {
        lastPageURL = url;
        // A registration of the site whose scope holds this URL: its worker answers the navigation (or lets it through).
        let answered = null;
        try {
            answered = pageSW ? await pageSW.navigation(url) : null;
        } catch (e) {
            status('page service worker', 'the navigation\'s fetch event failed, loading from the network: ' + String(e && e.message || e));
        }
        if (answered) {
            const type = (answered.headers.find(([n]) => n.toLowerCase() === 'content-type') || [])[1] || 'text/html';
            const t0 = hostNow();
            engine.load(url, answered.body, type, answered.headers);
            lastSource = { url, type, body: answered.body, via: 'the page\'s service worker' };
            status('navigated', `${url} (HTTP ${answered.status}, from the page's service worker)`);
            status('ganglion parse + first pump', `${(hostNow() - t0).toFixed(1)} ms`);
            scheduleTimers();
            needsFirstPaint = true;
            pageSW.documentLoaded(url);
            return;
        }
        if (!isStandIn(url)) {
            // Over the engine's own network: the outcome arrives through `navigated`.
            navigationStarted = hostNow();
            status('navigating', url);
            engine.navigate(url);
            scheduleTimers();
            needsFirstPaint = true;
            return;
        }
        const r = await engineFetch(url);
        const t0 = hostNow();
        engine.load(url, new HostUint8Array(r.body), r.headers['content-type'] || 'text/html', r.headers);
        lastSource = { url, type: r.headers['content-type'] || 'text/html', body: r.body, via: 'the network' };
        if (pageSW)
            pageSW.documentLoaded(url);
        status('ganglion parse + first pump', `${(hostNow() - t0).toFixed(1)} ms`);
        scheduleTimers();
        needsFirstPaint = true;
    }
    function reportNetwork() {
        const n = engine.netStats();
        status('network', `${n.requests} requests (${n.failures} failed), ${n.connections} connections, ${n.tlsHandshakes} TLS handshakes `
            + `(${n.tlsHandshakeMs.toFixed(0)} ms wall, ${n.tlsHandshakeCpuMs.toFixed(1)} ms in OpenSSL), ${(n.bytesReceived / 1024).toFixed(0)} KiB in, ${(n.bytesSent / 1024).toFixed(0)} KiB out`);
    }

    // Classic scripts as real scripts (docs/security.md 4.1): importScripts runs global code in this
    // Worker's global scope, so top-level let/const/class are shared between the page's scripts, vars are
    // not configurable and a stack has no eval frame. importScripts blocks this thread, so the engine
    // cannot answer the service worker meanwhile: the bytes are staged with it first, under a synthetic
    // https URL in the script's own directory (the service worker answers https URLs only, and never lets one
    // reach the network). The page sees the script's real name through the sourceURL line; the newlines in
    // front put the first line of an inline script on the line of the HTML document it starts on, as
    // Chrome reports it. Fail closed: no script runs once the segment stopped or lost its service worker.
    let scriptSeq = 0;
    function runScript(source, filename, lineOffset) {
        if (stopped || !swPort)
            throw new Error('segment: no page script without the service worker');
        // String work only: URL's accessors are page-reachable prototype members.
        // A script with no https name (an inline script of a document with no URL, a blob: or data: script, one of about:blank) runs
        // as part of the page it belongs to: its staged name is in the page's directory and it keeps its own name for the page.
        let ownName = filename;
        if (!/^https:\/\/[^/?#]+/.test(filename)) {
            if (!/^https:\/\/[^/?#]+/.test(lastPageURL))
                throw new Error('segment: a classic script needs an https name, got ' + filename);
            filename = lastPageURL;
        }
        // The staged name sits in the script's own directory, under this segment's mirror of the site's address space
        // (/__chitin/o/https/<host>/<path>, which the service worker maps back to the site's URL and has the engine answer):
        // a script fetched cross-origin without CORS has about:blank for its base URL, so the relative import("./chunk.js")
        // in a classic script (SvelteKit's start script) failed to resolve; a script of this segment's own origin has its
        // own URL as the base, and the mirror makes that URL lead to the site's file.
        const directory = /^[^?#]*\//.exec(filename)[0].slice('https://'.length);
        const synthetic = `${WORKER_ORIGIN}/__chitin/o/https/${directory}__chitin_script_${++scriptSeq}.js`;
        const text = '\n'.repeat(Math.max(0, lineOffset - 1)) + source + '\n//# sourceURL=' + (ownName || filename);
        // Staged by a synchronous request, not a port message: the service worker may have been stopped since it last
        // heard from us (idle, its port to this Worker gone), and a message on that port is then dropped without a word.
        // The fetch event restarts it, and it answers once the bytes are stored, before the import asks for them.
        const body = importMapActive(0) && /^https:\/\//.test(ownName || '') ? mapClassicSpecifiers(text, ownName) : text;
        let st = 0;
        try {
            st = stageSync ? stageSync(synthetic, body) : 0;
        } catch { st = 0; }
        if (st !== 204)
            swPort.postMessage({ type: 'stage', url: synthetic, status: 200, headers: { 'content-type': 'text/javascript' }, body });
        hostImportScripts(synthetic);
    }

    // A module script: V8 imports it from its real URL (so import.meta.url and relative imports are the site's), and
    // the service worker answers the request with the bytes the engine already fetched, staged first; the import
    // starts when the service worker has them (an import is not blocked, so there is a handshake instead of
    // importScripts' wait). Its own imports are the service worker's ordinary module loading, answered by the engine.
    // Fail closed as classic scripts do.
    // A classic script's text with its mapped import() specifiers replaced (the module rule, parsed as a script).
    function mapClassicSpecifiers(text, base) {
        try {
            const found = Specifiers.find(Acorn, text, false);
            if (!found || !found.length)
                return text;
            const results = engine.importMapResolve(0, base, found.map((f) => f.value));
            return Specifiers.apply(text, Specifiers.plan(found, results, WORKER_ORIGIN, 0, base, true));
        } catch (e) {
            status('import map', String(e && e.message || e));
            return text;
        }
    }
    function importMapActive(realm) {
        try { return !!(engine && engine.importMapActive(realm)); } catch { return false; }
    }
    async function runModule(source, url, lineOffset) {
        if (stopped || !swPort)
            throw new Error('segment: no page script without the service worker');
        if (!/^https:\/\/[^/?#]+/.test(url))
            throw new Error('segment: a module script needs an https name, got ' + url);
        if (!(await stillControlled()))
            throw new Error('segment: lost the service worker');
        const ack = ++scriptSeq;
        const text = '\n'.repeat(Math.max(0, lineOffset - 1)) + source;
        const staged = new Promise((resolve) => stageAcks.set(ack, resolve));
        swPort.postMessage({ type: 'stage', url, ack, status: 200, headers: { 'content-type': 'text/javascript' }, body: text, importMap: importMapActive(0) });
        await staged;
        try {
            await import(url);
        } finally {
            scheduleTimers(); // the engine's continuations of the settled promise are tasks
        }
    }

    // A same-site frame's module script (glue/engine/55-realms.js): imported under the frame realm's mirror name, after the
    // realm's accessor module has the frame's WindowProxy. Its imports stay in that graph (harness/segment/sw.js).
    async function runFrameModule(source, url, realmId, windowProxy, names) {
        if (stopped || !swPort)
            throw new Error('segment: no page script without the service worker');
        if (!/^https:\/\/[^/?#]+/.test(url))
            throw new Error('segment: a module script needs an https name, got ' + url);
        if (!(await stillControlled()))
            throw new Error('segment: lost the service worker');
        const accessor = await import(`${WORKER_ORIGIN}/__chitin/r/${realmId}/realm.mjs`);
        accessor.__chitin_set(windowProxy);
        const mirrorUrl = `${WORKER_ORIGIN}/__chitin/r/${realmId}/o/https/${url.slice('https://'.length)}`;
        const ack = ++scriptSeq;
        const staged = new Promise((resolve) => stageAcks.set(ack, resolve));
        swPort.postMessage({ type: 'stage', url: mirrorUrl, ack, status: 200, headers: { 'content-type': 'text/javascript' }, body: source, bindings: names, importMap: importMapActive(realmId) });
        await staged;
        try {
            await import(mirrorUrl);
        } finally {
            scheduleTimers();
        }
    }

    // Audio: the engine's decoded PCM goes to the carapace's AudioWorklet (harness/carapace/audio-worklet.js) over a port
    // of its own, asked for on first use; the worklet reports what it is playing straight back on it (glue/engine/55-media.js).
    let audioPort = null;
    const audioProgress = { __proto__: null }; // id -> the engine's progress callback (no Map: page JS can patch its prototype)
    const audioCount = { streams: 0, chunks: 0, reports: 0 };
    const audioLineText = () => `${audioCount.streams} streams opened, ${audioCount.chunks} chunks sent, ${audioCount.reports} position reports, last told: ${audioCount.told || 'nothing'}`;
    function audioLine() {
        if (!audioPort) {
            const channel = new HostMessageChannel();
            audioPort = channel.port1;
            audioPort.onmessage = (e) => {
                const r = e.data;
                const onProgress = r && typeof r.id === 'number' ? audioProgress[r.id] : undefined;
                if (onProgress && typeof r.played === 'number' && typeof r.queued === 'number' && typeof r.flags === 'number') {
                    onProgress(r.played, r.queued, r.flags);
                    if (++audioCount.reports % 25 === 1)
                        status('audio', audioLineText());
                }
            };
            port.postMessage({ type: 'audio-port' }, [channel.port2]);
        }
        return audioPort;
    }
    const audioOutput = {
        open: (id, onProgress) => {
            audioProgress[id] = onProgress;
            audioCount.streams++;
            audioLine().postMessage({ type: 'open', id });
            status('audio', audioLineText());
        },
        write: (id, t, sampleRate, planes) => {
            if (!audioProgress[id])
                return;
            audioCount.chunks++;
            const buffers = [];
            for (let i = 0; i < planes.length; i++)
                buffers[i] = planes[i].buffer;
            audioLine().postMessage({ type: 'data', id, t, sampleRate, planes }, buffers);
            if (audioCount.chunks % 50 === 1)
                status('audio', audioLineText());
        },
        control: (id, c) => {
            audioCount.told = `${c.playing ? 'play' : 'pause'} at volume ${c.volume}`;
            if (audioProgress[id])
                audioLine().postMessage({ type: 'control', id, playing: c.playing, volume: c.volume, rate: c.rate, sync: c.syncUs });
        },
        close: (id) => {
            if (!audioProgress[id])
                return;
            delete audioProgress[id];
            audioLine().postMessage({ type: 'close', id });
        },
    };

    async function startEngine(m) {
        const t0 = hostNow();
        const wasmBytes = await (await hostFetch('/chitin/ganglion.wasm')).arrayBuffer();
        const t1 = hostNow();
        const module = await HostWebAssembly.compile(wasmBytes);
        const t2 = hostNow();
        engine = engineBoot({
            wasm: module, width: m.width, height: m.height, dpr: m.dpr,
            // Test rules for the site-compatibility list (?compat.hide=, harness/carapace/carapace.js).
            siteCompatibility: Array.isArray(m.compatHide) && m.compatHide.length
                ? [{ matches: m.compatHide.flatMap((h) => ['https://' + h + '/*', 'https://' + h + ':*/*']), user_agent: ['hide_Chitin'] }] : undefined,
            // The segment's jar (glue/cookies.js, docs/cookies.md): the records the carapace's store gave this segment and its place
            // (its site, a cross-site iframe or not, the top-level site above it, who asked for its first navigation). Changes go
            // back to the store, which checks them and tells the other segments that share them.
            cookies: {
                site: m.cookies && typeof m.cookies.site === 'string' ? m.cookies.site : null,
                nested: m.nested === true,
                topSite: m.cookies && typeof m.cookies.topSite === 'string' ? m.cookies.topSite : null,
                initiator: m.cookies && typeof m.cookies.initiator === 'string' ? m.cookies.initiator : null,
                cookies: m.cookies && Array.isArray(m.cookies.records) ? m.cookies.records : [],
                onChange: (list) => hostPortPost(port, { type: 'cookies', list }),
            },
            log: (text) => status('engine log', text),
            stopped: (reason) => {
                engineStopped = true;
                status('engine stopped', reason);
            },
            fetch: (url, request) => {
                // A URL a frame realm's module made from its import.meta.url (new URL('./x.js', import.meta.url)) is a name in the
                // segment's mirror (harness/segment/sw.js): it stands for the site's own file, and the request is for that file.
                const mirrored = /^[^:]+:\/\/[^/]+\/__chitin\/(?:r\/\d+\/)?o\/https\/([^/?#]+)(\/[^#]*)?$/.exec(url.startsWith(WORKER_ORIGIN + '/') ? url : '');
                if (mirrored) {
                    const target = `https://${mirrored[1]}${mirrored[2] || '/'}`;
                    const hookedTarget = pageSW ? pageSW.fetchHook(target, request) : null;
                    const own = () => engineFetch(target).then((r) => ({ status: r.status, headers: r.headers, body: new HostUint8Array(r.body.slice(0)) }));
                    return hookedTarget ? hookedTarget.then((r) => r || own()) : own();
                }
                const standIn = () => isStandInMedia(url) ? streamedStandIn(url, request) : engineFetch(url).then((r) => ({ status: r.status, headers: r.headers, body: new HostUint8Array(r.body) }));
                // The page's own service worker first, when it controls this document (docs/architecture.md); a request it
                // lets fall through goes where it would have gone without it.
                const hooked = pageSW ? pageSW.fetchHook(url, request) : null;
                if (hooked)
                    return isStandIn(url) ? hooked.then((r) => r || standIn()) : hooked;
                return isStandIn(url) ? standIn() : null;
            },
            documentReset: () => { if (pageSW) pageSW.documentReset(); if (opfsState) opfsState.redefine(); if (webSocketState) { webSocketState.closeAll(); webSocketState.redefine(); } if (emeState) emeState.redefine(); if (rtcState) { rtcState.closeAll(); rtcState.redefine(); } },
            net,
            runScript,
            runModule,
            runFrameModule,
            // A failed decode is a broken image for the page, as in Chrome; the panel says why (the first ones).
            decodeImage: (bytes) => decodeImage(bytes).catch((e) => { const type = sniffImageType(bytes); if (type && imageFailures++ < 3) status('image decode failed', `${type}, ${bytes.length} bytes: ${e && e.name}: ${e && e.message}`); throw e; }),
            // A link or script asks for another document: that is the carapace's to do, with a fresh segment (a new
            // Worker, no binding of this page left). The segment only asks.
            afterMicrotasks: (fn) => hostSetTimeout(fn, 0),
            navigate: (url) => { status('navigation requested', url); (engine.cookies.flush(), flushLocalStorage()).then(() => port.postMessage({ type: 'navigate-request', url })); },
            storageChanged,
            storage: storageTaken,
            scriptError: (file, err) => status('page script error', `${file}: ${err && err.stack || err}`),
            navigated: (url, httpStatus, error) => {
                const ms = navigationStarted ? (hostNow() - navigationStarted).toFixed(0) : '?';
                status('navigated', error ? `FAILED ${url}: ${error} (${ms} ms)` : `${url} (HTTP ${httpStatus}, document in ${ms} ms)`);
                firstPaintAfterNavigation = navigationStarted;
                firstFrames = { t0: hostNow(), list: [] };
                documentNavigated = true;
                reportNetwork();
                // Only documents of this segment's own site are reported as navigated; a redirect to another site
                // is a request for the carapace to perform (it shows the address, it starts the new segment).
                let host = '';
                try { host = new URL(url).hostname.toLowerCase(); } catch { /* reported as is */ }
                const siteHost = String(m.siteHost || '');
                if (host && siteHost && host !== siteHost && !host.endsWith('.' + siteHost))
                    (engine.cookies.flush(), flushLocalStorage()).then(() => port.postMessage({ type: 'navigate-request', url }));
                else {
                    if (!error && pageSW)
                        pageSW.documentLoaded(url);
                    port.postMessage({ type: 'navigated', url, status: httpStatus, error });
                }
            },
            title: (t) => status('page title', t),
            // Fullscreen and the pointer lock are the carapace's (it holds the host's, with its own user activation); gamepad
            // effects go to the host's vibrationActuator (docs/webrtc.md).
            fullscreen: (enter) => port.postMessage({ type: 'fullscreen-request', enter }),
            pointerLock: (kind) => port.postMessage({ type: 'pointer-lock-request', kind }),
            gamepadEffect: (handle, kind, strong, weak, duration) => {
                for (const [index, known] of gamepadHandles)
                    if (known.handle === handle)
                        port.postMessage({ type: 'gamepad-effect', index, kind, strong: strong / 65535, weak: weak / 65535, duration });
            },
            requestFrame: () => { needsFirstPaint = true; },
            idbPersist,
            onMissingImports: (names) => status('imports without an implementation', names.join(', ')),
            // Nested segments (docs/architecture.md): a page's postMessage to a cross-site iframe (`to` its id) or, in a
            // child, to its parent. The carapace decides who gets it and with which origin.
            frames: {
                post: (to, data, targetOrigin, ports, others) => port.postMessage({ type: 'frame-post', to, targetOrigin, data }, [...ports, ...others]),
            },
            // Windows the page opens (glue/engine/52-popups.js, docs/oauth.md): the carapace opens them, or hands them to the
            // user's real browser. In a popup segment, window.close() asks the carapace to close it.
            popups: {
                open: (id, url, noopener) => port.postMessage({ type: 'popup-open', id, url, noopener: noopener === true }),
                navigate: (id, url) => port.postMessage({ type: 'popup-navigate', id, url }),
                close: (id) => port.postMessage({ type: 'popup-close', id }),
                selfClose: () => { (engine.cookies.flush(), flushLocalStorage()).then(() => port.postMessage({ type: 'window-close' })); },
            },
            opener: m.opener === true,
            nested: m.nested === true,
            frameRealms: m.frameRealms !== false,
            debugContexts: m.debugContexts === true ? (message) => { console.error(message); status('execution contexts', message); } : false,
            frameRealmCreated: (W) => { if (pageSW) pageSW.installFrameWorker(W); },
            HostMessageChannel,
            HostURL, // import maps' resolution (glue/engine/57-importmap.js)
            streams: Streams,
            audio: audioOutput,
        });
        const t3 = hostNow();
        status('ganglion download / compile / instantiate', `${(t1 - t0).toFixed(0)} / ${(t2 - t1).toFixed(0)} / ${(t3 - t2).toFixed(1)} ms (${(wasmBytes.byteLength / 1048576).toFixed(1)} MiB)`);
        // Engine memory and the Worker's event-loop lag (the worst lateness of a 1 s timer over the last 5 s): what a
        // long page (a long video) shows first when something grows or blocks.
        {
            let due = hostNow() + 1000, worst = 0, ticks = 0, lastLine = '';
            const bootAt = hostNow(), stalls = [];
            setInterval(() => {
                const now = hostNow();
                worst = Math.max(worst, now - due);
                if (now - due > 300) {
                    stalls.push(`${((now - bootAt) / 1000).toFixed(1)} s: ${(now - due).toFixed(0)} ms`);
                    status('event loop stalls (> 300 ms, the last 10)', stalls.slice(-10).join(', '));
                }
                due = now + 1000;
                if (++ticks % 5)
                    return;
                const line = `${(engine.memoryBytes() / 1048576).toFixed(0)} MiB, event loop late by up to ${worst.toFixed(0)} ms`;
                worst = 0;
                if (line !== lastLine)
                    status('engine memory', (lastLine = line));
            }, 1000);
        }
        pageSW = startPageServiceWorkers();
        const restoredStorage = await loadLocalStorage();
        if (engine.setColorScheme) engine.setColorScheme(state.colorScheme); // prefers-color-scheme, the host browser's (segment.js)
        if (engine.setScreen && state.screen) engine.setScreen(state.screen); // the host browser's screen (segment.js)
        if (engine.setAudioOutput) engine.setAudioOutput(state.audioRate); // Web Audio to the carapace's output, at its rate
        if (engine.setNetworkInformation && state.connection) engine.setNetworkInformation(state.connection); // its navigator.connection
        engine.storageRestore(restoredStorage);
        status('localStorage restored', restoredStorage.length + ' entries');
        engine.setIcuData(new HostUint8Array(await (await hostFetch('/chitin/icudt78l.dat')).arrayBuffer()));
        // The trust store for TLS (Mozilla's CA bundle, served beside the engine).
        const ca = await hostFetch('/chitin/cacert.pem');
        if (ca.ok)
            engine.setCaBundle(new HostUint8Array(await ca.arrayBuffer()));
        else
            status('trust store', 'MISSING: /chitin/cacert.pem (https will fail); see docs/user-tests/network.md');
        for (const name of ENGINE_FONTS)
            engine.addFont(new HostUint8Array(await (await hostFetch('/chitin/fonts/' + name)).arrayBuffer()));
        // The fallback fonts' manifest (74 KB); the subsets themselves load on first need, from the cache or the carapace origin.
        const fallbackManifest = await hostFetch('/chitin/fallback/fallback.bin').catch(() => null);
        if (fallbackManifest && fallbackManifest.ok && engine.setFallbackFonts)
            engine.setFallbackFonts(new HostUint8Array(await fallbackManifest.arrayBuffer()), hostLanguages,
                (file) => (fallbackFontCache ? fallbackFontCache('/chitin/fallback/' + file) : hostFetch('/chitin/fallback/' + file).then(async (r) => new HostUint8Array(await r.arrayBuffer()))));
        else
            status('fallback fonts', 'MISSING: /chitin/fallback/fallback.bin (tools/fallback-fonts.py); text the base fonts lack shows boxes');
        const t4 = hostNow();
        engine.start();
        status('ganglion fonts + start', `${(hostNow() - t4).toFixed(1)} ms`);
        await idbRestore();
        // What the Worker's WebCodecs decodes, before any page asks canPlayType (glue/engine/55-media.js).
        const mediaCodecs = await engine.probeMediaCodecs();
        status('media codecs', mediaCodecs.join(' ') || 'none');
        if (m.scripting !== false) {
            // Page JavaScript on this Worker's V8 (docs/phase2.md): the Window's surface lands on the global.
            const t5 = hostNow();
            engine.enableScripting();
            pageSW.installPage(G, HostMessageChannel);
            if (OPFS.available)
                opfsState = OPFS.install(G, G.Navigator.prototype);
            webSocketState = WebSockets.install(G, {
                transport: {
                    open: (url, headers, handlers) => {
                        wsCount.requested++;
                        reportWebSockets();
                        const id = engine.tunnelOpen(url, headers, {
                            onOpen: (...a) => { wsCount.open.add(id); wsCount.upgraded++; reportWebSockets(); handlers.onOpen(...a); },
                            onData: handlers.onData,
                            onClose: (error) => { wsCount.open.delete(id); if (error) wsCount.lastError = error; reportWebSockets(); handlers.onClose(error); },
                        });
                        return { write: (bytes) => engine.tunnelWrite(id, bytes), close: () => { wsCount.open.delete(id); engine.tunnelClose(id); reportWebSockets(); } };
                    },
                },
                dispatch: (target, event) => engine.dispatchTrusted(target, event),
                origin: () => G.location.origin,
                base: () => G.document.baseURI,
                mixedContent: () => G.location.protocol === 'https:',
            });
            if (rtcPort)
                rtcState = RTC.install(G, { port: rtcPort, dispatch: (target, event) => engine.dispatchTrusted(target, event), enabled: m.rtc !== false });
            if (control) {
                const emeChannel = new HostMessageChannel();
                control.postMessage({ type: 'eme-port', id: 0 }, [emeChannel.port2]);
                const pageURL = (() => { try { return new URL(m.url); } catch { return null; } })();
                emeState = EME.install(G, {
                    port: emeChannel.port1,
                    dispatch: (target, event) => engine.dispatchTrusted(target, event),
                    native: (f) => engine.markNative(f),
                    pump: () => scheduleTimers(),
                    status: (k, v) => status(k, v),
                    secure: !pageURL || pageURL.protocol === 'https:' || /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/.test(pageURL.hostname),
                });
                status('eme', emeState ? 'the host\'s EME, forwarded (docs/eme.md)' : 'not installed: the page\'s media classes are missing');
            } else {
                status('eme', 'not installed: no line to the segment document');
            }
            status('page scripting', `on; the global installed in ${(hostNow() - t5).toFixed(1)} ms`);
        } else {
            status('page scripting', 'off');
        }
        status('engine fingerprint', engine.fingerprint());
        canvas = m.canvas || new HostOffscreenCanvas(Math.round(m.width * m.dpr), Math.round(m.height * m.dpr));
        ctx2d = canvas.getContext('2d');
        // What changed since the last frame: a scroll moves the canvas's own pixels (drawImage of a canvas
        // onto itself copies first, per the 2D context spec), then the repainted rect goes in. The canvas keeps
        // the whole frame between ticks, so a static page costs nothing per tick.
        // The compositor (docs/compositor.md): with layers, a paint gives the layer tree and dirty tile parts, which go to
        // the carapace as ImageBitmaps; the flat canvas below is not used.
        const compositorMode = m.compositor === 'layers' || m.compositor === 'gpu' ? m.compositor : 'flat';
        engine.setCompositor(compositorMode);
        shownVideo.clear();
        // The WebGL2 carapace takes tiles as raw BGRA premultiplied bytes (docs/feel.md "Paint profile").
        if (m.rawTiles === true && engine.setRawTiles)
            rawTiles = engine.setRawTiles(true);
        status('engine compositor', engine.compositor() + (rawTiles ? ', raw tiles' : ''));
        paint = () => {
            const p = engine.paint();
            if (!p)
                return false;
            if (p.layers) {
                pendingLayers = p;
                return true;
            }
            if (p.blit.dx !== 0 || p.blit.dy !== 0)
                ctx2d.drawImage(canvas, p.blit.dx, p.blit.dy);
            if (p.image)
                ctx2d.putImageData(p.image, p.x, p.y);
            return p.image !== null || p.blit.dx !== 0 || p.blit.dy !== 0;
        };
        // A nested segment: what its iframe gives it (referrer, name, ancestor origins), then its parent is told when the
        // document has loaded (the iframe's load event).
        nestedSegment = m.nested === true;
        if (m.nested === true && m.embedder && typeof m.embedder === 'object' && engine.setEmbedder) {
            const em = m.embedder;
            engine.setEmbedder(typeof em.referrer === 'string' ? em.referrer : '', typeof em.name === 'string' ? em.name : '',
                Array.isArray(em.ancestors) ? em.ancestors.filter((o) => typeof o === 'string').slice(0, 8) : []);
            if (engine.setEmbedderIsolation && em.coi && typeof em.coi === 'object')
                engine.setEmbedderIsolation(em.coi.isolated === true, String(em.coi.coep || 'unsafe-none'), Array.isArray(em.ancestors) && typeof em.ancestors[0] === 'string' ? em.ancestors[0] : '');
        }
        if (m.nested === true && engine.documentComplete) {
            const watch = () => {
                if (engineStopped)
                    return;
                if (documentNavigated && engine.documentComplete())
                    port.postMessage({ type: 'loaded' });
                else
                    hostSetTimeout(watch, 20);
            };
            hostSetTimeout(watch, 20);
        }
        firstFrames = { t0: hostNow(), list: [] };
        await loadEngineUrl(m.url || `https://${m.site}/`);
        status('page loaded', `${(hostNow() - t0).toFixed(1)} ms after start`);
        port.postMessage({ type: 'ready' });
    }
    let firstPaintAfterNavigation = 0;
    let nestedSegment = false; // a cross-site frame's segment (unused wheels go back to the carapace)
    let firstFrames = null;

    // Every tick gets exactly one reply, whatever happens: the carapace keeps one tick in flight
    // and sends the next only after the reply (harness/carapace/carapace.js).
    const paintReasons = [];
    let profileOn = false;
    let rawTiles = false;
    async function engineFrame(seq) {
        let reply = { type: 'frame', seq };
        let transfer = [];
        try {
            const t0 = hostNow();
            if (!profileOn && engine.replayProfile) { engine.replayProfile(true); profileOn = true; }
            engine.renderingOpportunity(hostNow()); // the page's requestAnimationFrame callbacks run on this tick
            const reasons = engine.needsPaintReasons ? engine.needsPaintReasons() : 0;
            const dirty = engine.needsPaint() || needsFirstPaint;
            let painted = false;
            if (dirty) {
                painted = paint();
                // The first 4 s after a navigation: per frame [ms since it, render-blocked, painted] (docs/scroll.md "FOUC").
                // Reported once, at the first painted frame or when the 4 s are up (it went out on every frame: dozens
                // of 40-entry status messages per navigation while YouTube stayed render-blocked).
                if (firstFrames && engine.renderBlocked) {
                    const late = hostNow() - firstFrames.t0 >= 4000;
                    if (!late)
                        firstFrames.list.push([Math.round(hostNow() - firstFrames.t0), engine.renderBlocked(), painted ? 1 : 0]);
                    if (painted || late) {
                        status('first frames (ms, render-blocked, painted)', JSON.stringify(firstFrames.list.slice(-40)));
                        firstFrames = null;
                    }
                }
                needsFirstPaint = false;
                if (painted && firstPaintAfterNavigation) {
                    status('first paint after navigation', `${(hostNow() - firstPaintAfterNavigation).toFixed(0)} ms`);
                    firstPaintAfterNavigation = 0;
                }
            }
            // Handed-over videos (eme.js): their boxes as laid out now, for the host's video layer.
            if (emeState)
                emeState.frame();
            reply.paintMs = hostNow() - t0;
            reply.dirty = dirty;
            // Why ticks paint (docs/feel.md): per reason bit, how many of the last 240 painted ticks had it.
            if (dirty) {
                paintReasons.push(reasons);
                if (paintReasons.length >= 60) {
                    const n = [];
                    for (let b = 0; b < 9; b++) n.push(paintReasons.filter((r) => r & (1 << b)).length);
                    status('paint reasons', 'of 60 paints: first requested animations record canvas media frames ahead page = ' + n.join(' '));
                    paintReasons.length = 0;
                }
            }
            reply.inputTs = lastInputTs;
            reply.inputSeq = lastInputSeq;
            lastInputTs = 0;
            if (painted && pendingLayers) {
                // Layers: the tree, and each dirty tile part as an ImageBitmap (transferred; the engine keeps its tiles).
                const p = pendingLayers;
                pendingLayers = null;
                reply.layers = p.layers;
                if (engine.layerStats) {
                    const ls = engine.layerStats();
                    reply.raster = [ls.rasterMs, ls.tilesRastered, ls.tilesRasteredVisible];
                    // Where the paint went (docs/feel.md "Paint profile"): layout, display-list record, raster, and per
                    // command type the painter's ms [type, ms, count] (patch 0085).
                    reply.prof = { layout: ls.layoutMs, record: ls.recordMs, raster: ls.rasterMs, convert: ls.convertMs, cmds: engine.replayProfileTake ? engine.replayProfileTake() : [] };
                }
                const tUp = hostNow();
                reply.tiles = rawTiles
                    ? p.tiles.map((t) => ({ width: t.image.width, height: t.image.height, bgra: t.image.bgra }))
                    : await hostPromiseAll(p.tiles.map((t) => hostCreateImageBitmap(t.image)));
                if (reply.prof) reply.prof.bitmaps = hostNow() - tUp;
                transfer = rawTiles ? reply.tiles.map((t) => t.bgra.buffer) : reply.tiles.slice();
                // Video layers (docs/youtube.md "Video on the host"): the frame of each whose frame changed, as the host
                // decoded it (its display copy, transferred).
                const videos = [];
                for (const l of (p.layers && p.layers.layers) || []) {
                    if (!l.video)
                        continue;
                    if (shownVideo.get(l.id) === l.video[0])
                        continue;
                    // A frame already handed over (a new layer shows it again) comes as the kept bitmap, copied by posting it.
                    const taken = engine.takeHostVideoFrame ? engine.takeHostVideoFrame(l.video[0]) : null;
                    if (!taken)
                        continue;
                    const [bitmap, transferIt] = taken;
                    shownVideo.set(l.id, l.video[0]);
                    videos.push([l.id, bitmap]);
                    if (transferIt)
                        transfer.push(bitmap);
                }
                if (videos.length)
                    reply.videos = videos;
            } else if (painted && state.mode === 'bitmap') {
                // A copy, not a transfer: the canvas keeps the frame for the next partial paint.
                // The captured host function: with page scripting on, the global `createImageBitmap` is the engine's (LibWeb's
                // union of image sources), which rejects an OffscreenCanvas with "No union types matched".
                reply.bitmap = await hostCreateImageBitmap(canvas);
                transfer = [reply.bitmap];
            }
            if (seq % 60 === 0)
                engine.collect(false); // a task boundary: no engine frames on the stack
            reportSubframes();
        } catch (e) {
            reply = { type: 'frame', seq, error: String(e && e.stack || e) };
            transfer = [];
        }
        port.postMessage(reply, transfer);
        // The boxes of the elements that show a stream (the carapace's video layer, docs/webrtc.md), when they change.
        if (rtcState) {
            let boxes = null;
            try { boxes = rtcState.sinkBoxes(); } catch { boxes = null; }
            if (boxes)
                port.postMessage({ type: 'video-sinks', list: boxes });
        }
    }
    // The page's cross-site iframes, sent when they change (the carapace starts, moves and stops the children).
    let lastSubframes = '[]';
    function reportSubframes() {
        const list = engine.subframes();
        const text = JSON.stringify(list);
        if (text === lastSubframes)
            return;
        lastSubframes = text;
        port.postMessage({ type: 'subframes', list });
    }

    function frame(seq, ts) {
        if (engine && paint) {
            engineFrame(seq).catch((e) => port.postMessage({ type: 'frame', seq, error: String(e && e.stack || e) }));
            return;
        }
        if (!paint) {
            // The carapace starts ticking as soon as it has sent init, so the first ticks arrive
            // while the engine is still loading.
            port.postMessage({ type: 'frame', seq, notReady: true });
            return;
        }
        let reply = { type: 'frame', seq };
        let transfer = [];
        try {
            const callbacks = [...rafCallbacks.values()];
            rafCallbacks.clear();
            for (const cb of callbacks) {
                try {
                    cb(ts);
                } catch (e) {
                    status('page error', String(e && e.stack || e));
                }
            }
            const t0 = hostNow();
            const dirty = host.needsPaint();
            // A bitmap is sent only for a frame that was painted: transferToImageBitmap() leaves
            // the canvas transparent, so transferring again without painting would blank the page.
            // Transferred canvases (canvas, direct) keep their picture, so they repaint only if dirty too.
            const painted = dirty || seq <= 2 || needsFirstPaint;
            if (painted) {
                paint(state.width, state.height, state.dpr, '#fdfcf8');
                framesPainted++;
                needsFirstPaint = false;
            }
            reply.paintMs = hostNow() - t0;
            reply.dirty = dirty;
            reply.inputTs = lastInputTs;
            reply.inputSeq = lastInputSeq;
            lastInputTs = 0;
            if (painted && state.mode === 'bitmap') {
                reply.bitmap = canvas.transferToImageBitmap();
                transfer = [reply.bitmap];
            }
            if (seq % 60 === 0)
                host.collect(); // a task boundary: no engine frames on the stack
        } catch (e) {
            reply = { type: 'frame', seq, error: String(e && e.stack || e) };
            transfer = [];
        } finally {
            port.postMessage(reply, transfer);
        }
    }

    // DOM `button` (0 primary, 1 middle, 2 secondary, 3 back, 4 forward) to Ladybird's UIEvents::MouseButton
    // bitmask (Primary 1, Secondary 2, Middle 4, Backward 8, Forward 16); `buttons` is already that mask.
    const ENGINE_BUTTONS = [1, 4, 2, 8, 16];
    const engineButton = (button) => ENGINE_BUTTONS[button] || 0;
    // KeyboardEvent.key of a non-character key to Ladybird's UIEvents::KeyCode (the Windows virtual-key values).
    const ENGINE_KEYS = { __proto__: null, Backspace: 0x08, Tab: 0x09, Enter: 0x0D, Shift: 0x10, Control: 0x11, Alt: 0x12, Pause: 0x13, CapsLock: 0x14, Escape: 0x1B, PageUp: 0x21, PageDown: 0x22, End: 0x23, Home: 0x24, ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28, Delete: 0x2E, Insert: 0x7E, Meta: 0x92, ContextMenu: 0xAB, F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75, F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7A, F12: 0x7B };
    // The key code of a printable key: letters and digits are their own (upper case); the rest the engine finds from the
    // character. Named keys carry no character.
    function engineKeyCode(key) {
        if (!key)
            return 0;
        if (key.length === 1) {
            const c = key.toUpperCase().codePointAt(0);
            return (c >= 0x41 && c <= 0x5A) || (c >= 0x30 && c <= 0x39) || c === 0x20 ? c : 0;
        }
        return ENGINE_KEYS[key] || 0;
    }
    function input(m) {
        if (engine) {
            try {
                if (m.kind === 'key')
                    engine.key(m.down ? 0 : 1, engineKeyCode(m.key), m.mods | 0, m.key && m.key.length === 1 ? m.key.codePointAt(0) : 0);
                else if (m.kind === 'wheel') {
                    // Nothing in a frame's document could use it: the carapace gives it to the parent page (scroll
                    // chaining across frames, docs/scroll.md C1).
                    if (engine.wheel(m.x, m.y, m.dx, m.dy) === 0 && nestedSegment)
                        port.postMessage({ type: 'wheel-unused', x: m.x, y: m.y, dx: m.dx, dy: m.dy, ts: m.ts });
                }
                else if (m.kind === 'scroll-sync')
                    engine.scrollSync(m.seq, m.node, m.x, m.y, m.dx, m.dy); // the carapace already scrolled (docs/compositor.md)
                else if (m.kind === 0 || m.kind === 1 || m.kind === 2)
                    // The pointer first, with the pressure the host reported (a real mouse: 0.5 while a button is down).
                    engine.pointer(m.pointerType, m.pointerId, m.width, m.height, typeof m.pressure === 'number' ? m.pressure : -1, m.isPrimary);
                // Under the pointer lock the carapace sends a screen position of its own (the host's movement summed), so the
                // engine's movementX/Y are the host's while the client position stays where the lock began (docs/webrtc.md).
                const screen = typeof m.sx === 'number' && typeof m.sy === 'number' && engine.mouseScreen;
                const engineKind = m.kind === 0 ? 1 : m.kind === 1 ? 2 : m.kind === 2 ? 0 : -1;
                if (engineKind >= 0 && screen)
                    engine.mouseScreen(engineKind, m.x, m.y, m.sx, m.sy, engineKind === 0 ? 0 : engineButton(m.button), m.buttons, 0);
                else if (engineKind >= 0)
                    engine.mouse(engineKind, m.x, m.y, engineKind === 0 ? 0 : engineButton(m.button), m.buttons, 0);
                scheduleTimers();
            } catch (e) {
                status('input error', String(e && e.stack || e));
            }
            lastInputTs = m.ts;
            if (m.kind !== 'scroll-sync')
                lastInputSeq = m.seq | 0;
            return;
        }
        if (!host)
            return; // input before the engine is up: nothing to hit yet
        try {
            if (m.kind === 'key') {
                host.key(m.down ? 0 : 1, m.key);
            } else {
                host.pointer(m.kind, m.x, m.y, m.button, m.buttons);
            }
        } catch (e) {
            status('input error', String(e && e.stack || e));
        }
        lastInputTs = m.ts;
        lastInputSeq = m.seq | 0;
    }

    // Host gamepads, as the carapace's poll of navigator.getGamepads() saw them: [{ index, id, mapping, axes, buttons }] (values; the
    // carapace sends only while the tab has focus and only after a button was pressed, Chrome's gamepad user gesture).
    const gamepadHandles = new Map(); // host index -> { handle, id }
    let nextGamepadHandle = 1;
    function gamepadsFromHost(pads) {
        if (!Array.isArray(pads) || pads.length > 8)
            return;
        const seen = new Set();
        for (const p of pads) {
            if (!p || !Number.isInteger(p.index) || typeof p.id !== 'string' || !Array.isArray(p.axes) || !Array.isArray(p.buttons))
                continue;
            seen.add(p.index);
            let known = gamepadHandles.get(p.index);
            if (known && known.id !== p.id) {
                engine.gamepadDisconnected(known.handle);
                known = undefined;
            }
            if (!known) {
                known = { handle: nextGamepadHandle++, id: p.id.slice(0, 256) };
                gamepadHandles.set(p.index, known);
                engine.gamepadConnected(known.handle, known.id, p.mapping === 'standard', Math.min(p.axes.length, 8), Math.min(p.buttons.length, 32));
            }
            engine.gamepadState(known.handle, p.axes.slice(0, 8).map(Number), p.buttons.slice(0, 32).map(Number));
        }
        for (const [index, known] of gamepadHandles) {
            if (!seen.has(index)) {
                engine.gamepadDisconnected(known.handle);
                gamepadHandles.delete(index);
            }
        }
    }

    // The carapace's devtools panel: the page's network as its own Resource and Navigation Timing entries record it, and
    // the console, which evaluates in the page's realm as DevTools' console does when the segment Worker is chosen there.
    function devtoolsPreview(v, depth = 0) {
        const t = typeof v;
        if (v === null || t === 'undefined' || t === 'boolean' || t === 'number' || t === 'bigint' || t === 'symbol')
            return String(v) + (t === 'bigint' ? 'n' : '');
        if (t === 'string')
            return depth ? JSON.stringify(v) : v;
        if (t === 'function')
            return 'ƒ ' + (v.name || '(anonymous)') + '()';
        try {
            if (v instanceof Error)
                return String(v.stack || v);
            if (typeof v.nodeName === 'string' && typeof v.nodeType === 'number')
                return '<' + v.nodeName.toLowerCase() + (v.id ? '#' + v.id : '') + (typeof v.className === 'string' && v.className ? '.' + v.className.trim().split(/\s+/).join('.') : '') + '>';
            if (depth > 2)
                return Array.isArray(v) ? `Array(${v.length})` : '{…}';
            if (Array.isArray(v))
                return '[' + v.slice(0, 50).map((x) => devtoolsPreview(x, depth + 1)).join(', ') + (v.length > 50 ? `, … ${v.length - 50} more` : '') + ']';
            const keys = Object.keys(v);
            const tag = Object.prototype.toString.call(v).slice(8, -1);
            const body = keys.slice(0, 30).map((k) => `${k}: ${devtoolsPreview(v[k], depth + 1)}`).join(', ') + (keys.length > 30 ? `, … ${keys.length - 30} more` : '');
            return (tag === 'Object' ? '' : tag + ' ') + '{' + body + '}';
        } catch (err) {
            return '[unreadable: ' + String(err && err.message || err) + ']';
        }
    }
    function devtoolsReply(id, value) {
        let json;
        try { json = JSON.stringify(value); } catch (err) { json = JSON.stringify({ error: String(err) }); }
        if (json.length > 4 * 1024 * 1024)
            json = JSON.stringify({ error: 'answer too large' });
        if (port)
            port.postMessage({ type: 'devtools', id, json });
    }
    async function devtools(m) {
        if (m.op === 'net') {
            const perf = G.performance;
            const pick = (en) => ({ name: en.name, type: en.entryType === 'navigation' ? 'document' : en.initiatorType, protocol: en.nextHopProtocol,
                status: en.responseStatus, contentType: en.contentType, transfer: en.transferSize, encoded: en.encodedBodySize, decoded: en.decodedBodySize,
                start: en.startTime, duration: en.duration, dns: en.domainLookupEnd - en.domainLookupStart, connect: en.connectEnd - en.connectStart,
                tls: en.secureConnectionStart > 0 ? en.connectEnd - en.secureConnectionStart : 0, ttfb: en.responseStart - en.requestStart,
                download: en.responseEnd - en.responseStart, renderBlocking: en.renderBlockingStatus });
            let entries = [];
            try {
                entries = [...perf.getEntriesByType('navigation'), ...perf.getEntriesByType('resource')].map(pick);
            } catch (err) {
                return devtoolsReply(m.id, { error: String(err && err.message || err) });
            }
            let totals = null;
            try { totals = engine && engine.netStats ? { ...engine.netStats() } : null; } catch {}
            return devtoolsReply(m.id, { url: G.location && String(G.location.href), entries, totals });
        }
        if (m.op === 'source') {
            let text = null;
            try {
                if (lastSource)
                    text = new TextDecoder().decode(lastSource.body instanceof ArrayBuffer || ArrayBuffer.isView(lastSource.body) ? lastSource.body : new Uint8Array(lastSource.body));
            } catch (err) {
                text = '[could not decode: ' + String(err) + ']';
            }
            let dom = null;
            try { dom = G.document && G.document.documentElement ? G.document.documentElement.outerHTML : null; } catch {}
            const here = G.location ? String(G.location.href) : null;
            if (lastSource && lastSource.url === here)
                return devtoolsReply(m.id, { url: lastSource.url, type: lastSource.type, via: lastSource.via, source: text, dom });
            // A navigation the engine made over its own network keeps no bytes here: fetch the address again through the
            // engine (its HTTP cache first), and say so.
            let again = null, type = null;
            try {
                const r = await G.fetch(here, { cache: 'force-cache', credentials: 'include' });
                type = r.headers.get('content-type');
                again = await r.text();
            } catch (err) {
                again = '[fetching it again failed: ' + String(err && err.message || err) + ']';
            }
            return devtoolsReply(m.id, { url: here, type, via: 'a second fetch through the engine (its HTTP cache first): the first response was not kept', source: again, dom });
        }
        if (m.op === 'eval') {
            try {
                let v = (0, G.eval)(m.code);
                if (v && typeof v.then === 'function')
                    v = await v;
                devtoolsReply(m.id, { ok: true, text: devtoolsPreview(v) });
            } catch (err) {
                devtoolsReply(m.id, { ok: false, text: devtoolsPreview(err) });
            }
            scheduleTimers();
        }
    }
    function onCarapaceMessage(e) {
        const m = e.data;
        if (m.type === 'devtools') {
            devtools(m);
            return;
        }
        if (m.type === 'message') {
            // From the parent or a child, checked and stamped by the carapace.
            if (engine) {
                try {
                    engine.deliverMessage({ from: m.from, origin: m.origin, data: m.data, ports: e.ports });
                } catch (err) {
                    status('message error', String(err && err.stack || err));
                }
                scheduleTimers();
            }
            return;
        }
        if (m.type === 'popup-state') {
            // A window this page opened (glue/engine/52-popups.js): the page it shows, or closed.
            if (engine && engine.popupState)
                engine.popupState({ id: m.id, closed: m.closed === true, url: typeof m.url === 'string' ? m.url : undefined });
            return;
        }
        if (m.type === 'cookies') {
            // Another segment's changes to cookies this one shares, or a clear (checked by the carapace's store).
            if (engine && Array.isArray(m.list))
                engine.cookies.apply(m.list);
            return;
        }
        if (m.type === 'fullscreen' || m.type === 'pointer-lock' || m.type === 'gamepads') {
            // The carapace's answers and the host's gamepads (docs/webrtc.md, "Fullscreen, pointer lock, gamepads").
            if (engine) {
                try {
                    if (m.type === 'fullscreen')
                        engine.fullscreenChanged(m.on === true);
                    else if (m.type === 'pointer-lock')
                        engine.pointerLockResult(m.ended === true ? 1 : 0, m.error | 0);
                    else
                        gamepadsFromHost(m.pads);
                } catch (err) {
                    status('real-time input error', String(err && err.stack || err));
                }
                scheduleTimers();
            }
            return;
        }
        if (m.type === 'frame')
            frame(m.seq, m.ts);
        else if (m.type === 'input')
            input(m);
        else if (m.type === 'frame-loaded') {
            if (engine && engine.frameLoaded && Number.isInteger(m.id)) {
                engine.frameLoaded(m.id);
                scheduleTimers();
            }
        }
        else if (m.type === 'resize') {
            state.width = m.width;
            state.height = m.height;
            state.dpr = m.dpr;
            if (state.mode === 'bitmap') {
                canvas.width = Math.round(m.width * m.dpr);
                canvas.height = Math.round(m.height * m.dpr);
            }
            if (engine)
                engine.setViewport(m.width, m.height, m.dpr);
            else
                host.setViewport(m.width, m.height);
            needsFirstPaint = true;
        }
    }

    // --- Loading the site -------------------------------------------------------------------------
    async function loadSite(site) {
        const base = `https://${site}/`;
        const manifest = JSON.parse(await engineText(base + 'site.json'));
        for (const rel of manifest.classic || []) {
            const url = new URL(rel, base).href;
            const text = await engineText(url);
            try {
                if (state.classic === 'importScripts') {
                    // Experiment: let V8 load the classic script from its real URL through the
                    // service worker. importScripts blocks this thread, so the engine cannot
                    // answer the service worker then: stage the bytes with it first.
                    if (!(await stillControlled()))
                        return false;
                    const r = await engineFetch(url);
                    const body = r.body.slice(0);
                    swPort.postMessage({ type: 'stage', url, status: r.status, headers: r.headers, body }, [body]);
                    hostImportScripts(url);
                } else {
                    host.evalClassic(text, url); // decision in docs/plan.md
                }
            } catch (e) {
                status('classic script error', `${url}: ${e && e.stack || e}`);
            }
        }
        for (const rel of manifest.modules || []) {
            const url = new URL(rel, base).href;
            // Control is proved again before every module graph, not once at boot.
            if (!(await stillControlled()))
                return false;
            try {
                await import(url);
            } catch (e) {
                status('module error', `${url}: ${e && e.stack || e}`);
            }
        }
        return true;
    }

    async function start(m, ports) {
        port = ports[0];
        netPort = ports[1];
        if (netPort)
            netPort.onmessage = onNetMessage;
        startSyncNet();
        nonce = String(m.nonce || '');
        state = { mode: m.mode, classic: m.classic || 'eval', width: m.width, height: m.height, dpr: m.dpr, colorScheme: m.colorScheme === 'dark' ? 'dark' : 'light', screen: m.screen && typeof m.screen === 'object' ? m.screen : null, connection: m.connection && typeof m.connection === 'object' ? m.connection : null, audioRate: typeof m.audioRate === 'number' ? m.audioRate : 0 };
        port.onmessage = onCarapaceMessage;
        status('segment origin', location.origin);
        status('crossOriginIsolated (segment Worker)', String(G.crossOriginIsolated));
        status('mode', `${m.mode}, classic scripts by ${state.classic}, engine ${m.engine || 'toy'}`);
        // Fail closed: no page script of any kind before the service worker controls this Worker.
        if (!(await stillControlled()))
            return;
        if (m.engine === 'ganglion') {
            installPageGlobals(!m.url || isStandIn(m.url));
            watchControl();
            await startEngine(m);
            return;
        }

        const wasm = await (await hostFetch('/chitin/ganglion-toy.wasm')).arrayBuffer();
        const t0 = hostNow();
        host = boot({ wasm, global: G, width: m.width, height: m.height, reportError: (e) => status('page error', String(e && e.stack || e)) });
        status('engine boot', `${(hostNow() - t0).toFixed(1)} ms (toy, ${(wasm.byteLength / 1024).toFixed(0)} KiB)`);

        canvas = m.canvas || new HostOffscreenCanvas(Math.round(m.width * m.dpr), Math.round(m.height * m.dpr));
        ctx2d = canvas.getContext('2d');
        paint = host.makePainter(ctx2d); // before any page script: it captures the 2D context API

        status('service worker controls the Worker', 'true');
        installPageGlobals(true);
        if (!(await loadSite(m.site)))
            return;
        status('page loaded', `${(hostNow() - t0).toFixed(1)} ms after boot`);
        port.postMessage({ type: 'ready' });
    }

    // --- Message intake (docs/security.md section 2.2, item 2) ----------------------------------------
    // The Worker's global receives exactly one message that matters: the segment document's `init`,
    // which carries the ports (carapace, control, and Spiracle's when there is one). Page JS shares this
    // global and can dispatch events on it, so the listener accepts only a trusted event (one the browser
    // made for a real postMessage), accepts one init, and removes itself in the same turn. Everything
    // after init (the service-worker port, comparison-mode input) arrives on the control port, which
    // only this closure holds.
    let initialised = false;
    function onControlMessage(e) {
        if (!e.isTrusted || stopped)
            return;
        const m = e.data;
        if (!m)
            return;
        if (m.type === 'sw-port' && e.ports[0]) {
            swPort = e.ports[0];
            swPort.onmessage = onServiceWorkerMessage;
        } else if (m.type === 'direct-input' && state && state.mode === 'direct' && host) {
            input(m);
        } else if (m.type === 'connection' && state) {
            state.connection = m.value;
            if (engine && engine.setNetworkInformation)
                engine.setNetworkInformation(state.connection);
        } else if (m.type === 'screen' && state) {
            state.screen = m.value;
            if (engine && engine.setScreen)
                engine.setScreen(state.screen);
        } else if (m.type === 'color-scheme' && state) {
            state.colorScheme = m.value === 'dark' ? 'dark' : 'light';
            if (engine && engine.setColorScheme)
                engine.setColorScheme(state.colorScheme);
        }
    }
    function onGlobalMessage(e) {
        if (!e.isTrusted || initialised)
            return;
        const m = e.data;
        if (!m || m.type !== 'init' || !e.ports || e.ports.length < 2)
            return;
        initialised = true;
        hostRemoveEventListener('message', onGlobalMessage);
        // The page's WebRTC port travels in the message (m.rtcPort), so it is never taken for Spiracle's.
        const [carapacePort, controlPort, ...rest] = e.ports;
        const spiracleNetPort = rest.find((p) => p !== m.rtcPort);
        rtcPort = m.rtcPort && typeof m.rtcPort.postMessage === 'function' ? m.rtcPort : null;
        control = controlPort;
        controlPort.onmessage = onControlMessage;
        if (surfaceProblem) {
            port = carapacePort;
            stopSegment(surfaceProblem);
            return;
        }
        start(m, [carapacePort, spiracleNetPort]).catch((err) => status('start failed', String(err && err.stack || err)));
    }
    hostAddEventListener('message', onGlobalMessage);
    // Uncaught errors (ours or the page's) go to the carapace's Segment panel, so a failure is
    // visible without DevTools.
    hostAddEventListener('error', (e) => status('uncaught error in the segment Worker', String(e.error && e.error.stack || e.message)));
    // The page's promises are this Worker's: its rejections go to the page's window first (HTML "notify about rejected
    // promises"); one the page handles there (preventDefault) is not reported here.
    hostAddEventListener('unhandledrejection', (e) => {
        if (engine && engine.promiseRejection && engine.promiseRejection('unhandledrejection', e.promise, e.reason)) {
            e.preventDefault();
            return;
        }
        status('unhandled rejection in the segment Worker', String(e.reason && e.reason.stack || e.reason) + requestOf(e.reason));
    });
    // An HTTP error a page's client library rejected with (Spotify's HttpResponseError: requestUrl, requestMethod, status), so
    // the panel says which request it was. Own data properties only: no page getter runs.
    function requestOf(reason) {
        try {
            if (reason === null || typeof reason !== 'object')
                return '';
            const own = (k) => { const d = Object.getOwnPropertyDescriptor(reason, k); return d && 'value' in d ? d.value : undefined; };
            const url = own('requestUrl') ?? own('url');
            const st = own('status') ?? own('statusCode');
            if (typeof url !== 'string' && typeof st !== 'number')
                return '';
            const method = own('requestMethod') ?? own('method');
            return ` [request: ${typeof method === 'string' ? method.toUpperCase() + ' ' : ''}${typeof url === 'string' ? url.slice(0, 300) : '?'}${typeof st === 'number' ? ', status ' + st : ''}]`;
        } catch {
            return '';
        }
    }
    hostAddEventListener('rejectionhandled', (e) => {
        if (engine && engine.promiseRejection)
            engine.promiseRejection('rejectionhandled', e.promise, e.reason);
    });
    void hostRemoveEventListener;
    void hostSetTimeout;
    void timeOrigin;
})();
