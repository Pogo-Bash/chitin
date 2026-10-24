// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Page service workers, the segment's side (docs/architecture.md, "Page service workers"). The page's own service
// worker never becomes a real one: its code runs in a runner (harness/segment/pagesw.js) and this file is everything
// around it: navigator.serviceWorker for the page, registrations and the lifecycle, the FetchEvents for the page's
// navigation and requests, the worker's own fetch() over the engine's network with Chitin's CORS, CacheStorage and the
// registrations persisted in the segment origin's storage.
//
// Loaded by worker.js with importScripts before the host's doors are removed; it defines `__chitinPageSW`, which the
// segment Worker takes and deletes. Nothing here is reachable from page code except the objects it hands to the page.
'use strict';
(() => {
    const G = self;
    const HostURL = G.URL;
    const HostPromise = G.Promise;
    const HostUint8Array = G.Uint8Array;
    const HostArrayBuffer = G.ArrayBuffer;
    const HostTextDecoder = G.TextDecoder;
    const HostTextEncoder = G.TextEncoder;
    const hostCrypto = G.crypto;
    const randomUUID = hostCrypto && hostCrypto.randomUUID ? hostCrypto.randomUUID.bind(hostCrypto) : () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const defineProperty = Object.defineProperty;
    const hostSetTimeout = G.setTimeout.bind(G); // with page scripting on, the global one is the engine's
    const ReflectApply = Reflect.apply;
    const hostStructuredClone = G.structuredClone;
    // For a page Worker's synchronous XMLHttpRequest (answerSync): the host's, captured before page scripts can replace them.
    const HostInt32Array = G.Int32Array;
    const AtomicsLoad = Atomics.load, AtomicsStore = Atomics.store, AtomicsNotify = Atomics.notify;
    const JSONStringify = JSON.stringify;
    const hostNow = G.performance ? G.performance.now.bind(G.performance) : Date.now;
    // Where a dedicated Worker's start-up goes (the Segment panel's 'worker start-up', medians in ms over the page's Workers):
    // script fetched, runner port, runner ready, script staged, script run.
    const spawnSteps = { fetched: [], port: [], ready: [], staged: [], started: [] };
    let spawnTimer = 0;
    let spawnStatus = null; // the last segment's deps.status (create)
    const spawnMark = (v, step) => {
        if (!v.t0)
            return;
        spawnSteps[step].push(hostNow() - v.t0);
        if (!spawnTimer && spawnStatus)
            spawnTimer = hostSetTimeout(() => {
                spawnTimer = 0;
                const med = (a) => { const x = a.slice().sort((p, q) => p - q); return x.length ? Math.round(x[x.length >> 1] * 10) / 10 : '-'; };
                spawnStatus('worker start-up', Object.keys(spawnSteps).map((k) => k + ' ' + med(spawnSteps[k])).join(', ') + ' (n ' + spawnSteps.started.length + ')');
            }, 2000);
    };
    const sabProto = G.SharedArrayBuffer ? G.SharedArrayBuffer.prototype : null;
    const sabGrow = sabProto && sabProto.grow;
    const sabLength = sabProto ? Object.getOwnPropertyDescriptor(sabProto, 'byteLength').get : null;

    // Request headers a service worker never sees (they are added on the wire: cookies, the connection's own).
    const HIDDEN_REQUEST_HEADERS = new Set(['cookie', 'cookie2', 'host', 'connection', 'content-length', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'accept-encoding']);
    // Response headers that describe the wire, not the body the worker gets (the engine's network already decoded it).
    const WIRE_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);
    const JS_MIME = /^(text|application)\/(x-)?(javascript|ecmascript)|^text\/(jscript|livescript)/i;
    const toBuffer = (b) => {
        if (!b)
            return new HostArrayBuffer(0);
        if (b instanceof HostArrayBuffer)
            return b;
        const u = b instanceof HostUint8Array ? b : new HostUint8Array(b.buffer || b);
        return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
    };
    const headerGet = (headers, name) => {
        const lower = name.toLowerCase();
        for (const [n, v] of headers)
            if (n.toLowerCase() === lower)
                return v;
        return null;
    };
    // Cross-origin isolation (docs/user-tests/coi.md): a COEP header's value, and whether a value allows isolation.
    const coepValue = (header) => {
        const t = String(header || '').split(';')[0].trim();
        return t === 'require-corp' || t === 'credentialless' ? t : 'unsafe-none';
    };
    const compatibleWithIsolation = (coep) => coep === 'require-corp' || coep === 'credentialless';
    // Whether a message holds shared memory (a SharedArrayBuffer, a view on one, a shared WebAssembly.Memory), which may be
    // posted only from a cross-origin isolated context. Only data properties are followed (a getter is not run twice).
    const SABByteLength = G.SharedArrayBuffer ? Object.getOwnPropertyDescriptor(G.SharedArrayBuffer.prototype, 'byteLength').get : null;
    const ViewBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(G.Uint8Array.prototype), 'buffer').get;
    const DataViewBufferGet = Object.getOwnPropertyDescriptor(G.DataView.prototype, 'buffer').get;
    const WasmMemory = G.WebAssembly ? G.WebAssembly.Memory : null;
    const isSAB = (x) => { if (!SABByteLength) return false; try { ReflectApply(SABByteLength, x, []); return true; } catch { return false; } };
    function containsShared(value) {
        const seen = new Set();
        const stack = [value];
        while (stack.length) {
            const x = stack.pop();
            if (typeof x !== 'object' || x === null || seen.has(x))
                continue;
            seen.add(x);
            if (isSAB(x))
                return true;
            if (ArrayBuffer.isView(x)) {
                let b = null;
                try { b = ReflectApply(ViewBuffer, x, []); } catch { try { b = ReflectApply(DataViewBufferGet, x, []); } catch { b = null; } }
                if (b && isSAB(b))
                    return true;
                continue;
            }
            if (WasmMemory && x instanceof WasmMemory) {
                try { if (isSAB(x.buffer)) return true; } catch { /* detached */ }
                continue;
            }
            if (x instanceof Map) {
                for (const [k, v] of x) stack.push(k, v);
                continue;
            }
            if (x instanceof Set) {
                for (const v of x) stack.push(v);
                continue;
            }
            let keys;
            try { keys = Reflect.ownKeys(x); } catch { continue; }
            for (const k of keys) {
                if (typeof k === 'symbol')
                    continue;
                const d = Object.getOwnPropertyDescriptor(x, k);
                if (d && 'value' in d && typeof d.value === 'object')
                    stack.push(d.value);
            }
        }
        return false;
    }
    const headerPairs = (h) => (Array.isArray(h) ? h.map(([n, v]) => [String(n), String(v)]) : Object.keys(h || {}).map((n) => [n, String(h[n])]));

    // The ports of a message event. Chrome lists only MessagePorts; Node's worker_threads lists every transferred object (a stream).
    // Node's worker_threads also lists the internal port of every transferred stream, so the real ports go first in the transfer
    // list and the message says how many there are (`ports`).
    const portsOf = (e, m) => (e.ports ? Array.from(e.ports).slice(0, m && typeof m.ports === 'number' ? m.ports : undefined) : []);
    const isPort = (x) => x !== null && typeof x === 'object' && typeof x.postMessage === 'function' && typeof x.start === 'function';
    function create(deps) {
        spawnStatus = deps.status || null;
        const log = (text) => deps.log && deps.log('[page sw] ' + text);
        const after = () => deps.afterEngineCall && deps.afterEngineCall();
        const clientId = randomUUID();
        // The documents of same-site frames are clients of their own (Chrome: a nested window client per frame document), so
        // a frame's requests carry its id and clients.get(id).url is the frame's document (Scramjet unrewrites it). Keyed by
        // the document's URL, which is what the engine's loader says of a request's client (Host.cpp); the principal
        // document keeps `clientId`. Forgotten with the principal document.
        const frameClients = new Map(); // a frame document's URL -> { id, url }
        const clientOf = (url) => {
            if (!url || !documentURL || url === documentURL)
                return clientId;
            let c = frameClients.get(url);
            if (!c) {
                if (frameClients.size >= 64)
                    frameClients.delete(frameClients.keys().next().value);
                c = { id: randomUUID(), url };
                frameClients.set(url, c);
            }
            return c.id;
        };
        // Transferable streams (harness/segment/streams.js); without it a message goes as it is.
        const streams = deps.streams || { outbound: (message, transfer) => ({ message, transfer: [...transfer] }), inbound: (m) => m, hostStreamsIn: () => [], isStream: () => false };
        let documentURL = '';
        let siteOrigin = '';
        const registrations = new Map(); // scope -> registration
        let controller = null;           // the version controlling this document
        let nextVersion = 1;
        let restored = null;
        let page = null;                 // the page-facing objects, once installPage ran
        // BroadcastChannel across the site's contexts (harness/segment/pagesw.js has the runners' side): the runners subscribed
        // to each name, and per name one channel of the page's own (the engine's BroadcastChannel) that carries posts between
        // the page and the runners. The engine never delivers a channel's post to itself, so nothing echoes.
        const bcSubs = new Map();        // name -> Set of versions/workers whose runner has a channel of the name
        const bcHubs = new Map();        // name -> the page's channel for it
        let bcHubFor = null;             // name -> a new page channel, once installPage ran
        function bcForward(name, data, except) {
            const set = bcSubs.get(name);
            if (!set)
                return;
            for (const x of [...set]) {
                if (!x.runner) {
                    set.delete(x);
                    continue;
                }
                if (x !== except)
                    x.runner.send({ t: 'bc', name, data });
            }
        }
        function bcHub(name) {
            if (!bcHubs.has(name) && bcHubFor) {
                try {
                    bcHubs.set(name, bcHubFor(name));
                } catch (e) {
                    log('BroadcastChannel ' + name + ': ' + (e && e.message || e));
                }
            }
            return bcHubs.get(name) || null;
        }
        let nestedWorkers = null;        // (parent version, message) -> starts a Worker made by a page's worker (installPage)
        let definePageNames = null;

        // --- Persistence ----------------------------------------------------------------------------------------
        const store = deps.store;
        const REG_KEY = 'pagesw:registrations';
        async function persist() {
            const list = [];
            for (const reg of registrations.values()) {
                if (reg.uninstalling)
                    continue;
                const v = (x) => (x && x.state !== 'redundant' ? { scriptURL: x.scriptURL, type: x.type, text: x.text } : null);
                list.push({ scope: reg.scope, updateViaCache: reg.updateViaCache, active: v(reg.active), waiting: v(reg.waiting) });
            }
            try {
                await store.put(REG_KEY, list);
            } catch (e) {
                log('could not save the registrations: ' + (e && e.message || e));
            }
        }
        function restore() {
            if (!restored)
                restored = (async () => {
                    let list = [];
                    try {
                        list = (await store.get(REG_KEY)) || [];
                    } catch (e) {
                        log('could not read the registrations: ' + (e && e.message || e));
                    }
                    for (const r of list) {
                        const reg = newRegistration(r.scope, r.updateViaCache);
                        if (r.active)
                            reg.active = newVersion(reg, r.active.scriptURL, r.active.type, r.active.text, 'activated');
                        if (r.waiting)
                            reg.waiting = newVersion(reg, r.waiting.scriptURL, r.waiting.type, r.waiting.text, 'installed');
                    }
                })();
            return restored;
        }

        // --- Registrations and versions -------------------------------------------------------------------------
        function newRegistration(scope, updateViaCache) {
            const reg = { scope, updateViaCache: updateViaCache || 'imports', installing: null, waiting: null, active: null, uninstalling: false, page: null, job: HostPromise.resolve() };
            registrations.set(scope, reg);
            return reg;
        }
        function newVersion(reg, scriptURL, type, text, state) {
            return { id: nextVersion++, reg, scriptURL, type: type || 'classic', text, state, runner: null, skip: false, hasFetch: false, page: null };
        }
        const versionView = (v) => (v ? { id: v.id, scriptURL: v.scriptURL, state: v.state } : null);
        const regView = (reg) => ({ scope: reg.scope, updateViaCache: reg.updateViaCache, installing: versionView(reg.installing), waiting: versionView(reg.waiting), active: versionView(reg.active) });
        function matchRegistration(url) {
            let best = null;
            for (const reg of registrations.values())
                if (!reg.uninstalling && url.startsWith(reg.scope) && (!best || reg.scope.length > best.scope.length))
                    best = reg;
            return best;
        }
        function setState(v, state) {
            if (v.state === state)
                return;
            v.state = state;
            if (state === 'redundant' && v.runner) {
                v.runner.close();
                v.runner = null;
            }
            broadcastState(v.reg);
            if (page)
                page.stateChanged(v);
        }
        function broadcastState(reg) {
            for (const v of [reg.installing, reg.waiting, reg.active, controller])
                if (v && v.runner && v.reg === reg)
                    v.runner.send({ t: 'state', registration: regView(reg), version: versionView(v) });
        }

        // --- Runners --------------------------------------------------------------------------------------------
        async function startRunner(v) {
            if (v.runner)
                return v.runner.started;
            const port = await deps.startRunner();
            spawnMark(v, 'port');
            const waiting = new Map();
            let nextId = 1;
            let closed = false;
            let readyResolve;
            const ready = new HostPromise((resolve) => { readyResolve = resolve; });
            const runner = {
                send: (m, transfer) => { if (!closed) port.postMessage(m, transfer || []); },
                ask: (m, transfer) => new HostPromise((resolve, reject) => {
                    if (closed) {
                        reject(new Error('the service worker is gone'));
                        return;
                    }
                    const id = nextId++;
                    waiting.set(id, { resolve, reject });
                    port.postMessage({ ...m, id }, transfer || []);
                }),
                close: () => {
                    closed = true;
                    wsCloseAll(v);
                    if (v.children) {
                        for (const c of v.children.values())
                            c.stop();
                        v.children.clear();
                    }
                    for (const w of waiting.values())
                        w.reject(new Error('the service worker was stopped'));
                    waiting.clear();
                    try { port.close(); } catch { /* gone */ }
                    if (deps.stopRunner)
                        deps.stopRunner(port);
                },
                started: null,
            };
            v.runner = runner;
            port.onmessage = (e) => {
                const m = e.data;
                if (!m || typeof m !== 'object')
                    return;
                if (m.t === 'ready') {
                    spawnMark(v, 'ready');
                    readyResolve();
                    return;
                }
                if (m.t === 'reply') {
                    const w = waiting.get(m.re);
                    if (w) {
                        waiting.delete(m.re);
                        w.resolve(m);
                    }
                    return;
                }
                onRunnerMessage(v, m, portsOf(e, m)).catch((err) => log('runner message ' + m.t + ': ' + (err && err.stack || err)));
            };
            if (typeof port.start === 'function')
                port.start();
            // A dedicated Worker's script is staged while the runner starts (both are round trips of their own).
            const staged = v.dedicated ? deps.stage(v.loadURL, v.text, v.type) : null;
            if (staged)
                staged.catch(() => undefined);
            runner.started = (async () => {
                await ready;
                if (v.dedicated) {
                    // A page's dedicated Worker (harness/segment/pagesw.js, kind 'dedicated'): its script is staged under
                    // loadURL (the script's own URL, or a name under the site for a blob: or data: script).
                    await staged;
                    spawnMark(v, 'staged');
                    const r = await runner.ask({ t: 'start', kind: v.kind || 'dedicated', scriptURL: v.scriptURL, loadURL: v.loadURL, type: v.type, name: v.name, isolated: !!v.isolated });
                    if (!r.ok)
                        throw new Error(r.error);
                    spawnMark(v, 'started');
                    return runner;
                }
                await deps.stage(v.scriptURL, v.text, v.type);
                const r = await runner.ask({ t: 'start', scriptURL: v.scriptURL, type: v.type, registration: regView(v.reg), version: versionView(v), isolated: !!v.isolated });
                if (!r.ok)
                    throw new Error('the service worker script failed: ' + r.error);
                v.hasFetch = !!r.hasFetch;
                return runner;
            })();
            return runner.started;
        }

        // --- WebSockets for the worker (harness/segment/websocket.js runs in the runner; the engine's tunnel is here) -----
        // The runner writes the frames; this side only opens the upgrade on the engine's network and relays bytes. It does not
        // trust the handshake it is given: the URL must be http(s), the headers are the WebSocket handshake's and nothing else,
        // and the Origin is the site's.
        const WS_HEADERS = new Set(['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'cache-control', 'pragma']);
        function wsOpen(v, m) {
            const runner = v.runner;
            const post = (message, transfer) => { if (runner) runner.send({ t: 'ws', wid: m.wid, ...message }, transfer); };
            const fail = (why) => post({ ev: 'close', error: why });
            if (!deps.tunnel) {
                hostSetTimeout(() => fail('this segment has no WebSocket transport'), 0);
                return;
            }
            let url;
            try {
                url = new HostURL(String(m.url));
            } catch {
                hostSetTimeout(() => fail('not a URL'), 0);
                return;
            }
            if (url.protocol !== 'https:' && url.protocol !== 'http:' || url.hash || (url.protocol === 'http:' && siteOrigin.startsWith('https:'))) {
                hostSetTimeout(() => fail('not an allowed WebSocket URL'), 0);
                return;
            }
            const headers = [];
            for (const pair of m.headers || []) {
                const name = String(pair[0]);
                if (WS_HEADERS.has(name.toLowerCase()))
                    headers.push([name, String(pair[1])]);
            }
            headers.push(['Origin', siteOrigin]);
            if (!v.ws)
                v.ws = new Map();
            const wsMap = v.ws;
            const id = deps.tunnel.open(url.href, headers, {
                onOpen: (status, reason, responseHeaders) => post({ ev: 'open', status, reason, headers: responseHeaders }),
                onData: (bytes) => {
                    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                    post({ ev: 'data', bytes: copy }, [copy]);
                },
                onClose: (error) => {
                    wsMap.delete(m.wid);
                    post({ ev: 'close', error });
                },
            });
            wsMap.set(m.wid, id);
        }
        function wsCloseAll(v) {
            if (!v.ws)
                return;
            for (const id of v.ws.values())
                deps.tunnel.close(id);
            v.ws.clear();
        }

        // The page's Workers in the Segment panel: by name, how many messages each sent the page and got from it (a worker that
        // stops talking, or never starts, shows here).
        const workerStats = new Map(); // v -> { name, out, in }
        const statOf = (v) => { let st = workerStats.get(v); if (!st) { st = { name: (v.kind || (v.dedicated ? 'dedicated' : 'service')) + ' ' + (v.name || v.scriptURL.slice(0, 60)), out: 0, in: 0 }; workerStats.set(v, st); } return st; };
        let statTimer = 0;
        const reportStats = () => {
            if (statTimer || !deps.status)
                return;
            statTimer = hostSetTimeout(() => {
                statTimer = 0;
                const rows = [];
                for (const [v, st] of workerStats)
                    rows.push(`${st.name}: ${st.out} sent, ${st.in} received${v.runner ? '' : ' (not started)'}`);
                deps.status('page workers', rows.length + ' workers\n' + rows.slice(0, 64).join('\n'));
            }, 2000);
        };
        async function onRunnerMessage(v, m, ports) {
            const reply = (data) => v.runner && v.runner.send({ re: m.id, ...data });
            if (m.t === 'post') {
                statOf(v).out++;
                reportStats();
            }
            switch (m.t) {
            case 'log':
                log(m.text);
                return;
            case 'fatal':
                log('runner refused: ' + m.error);
                return;
            case 'net':
                try {
                    reply({ response: await netFetch(m.request) });
                } catch (e) {
                    reply({ error: String(e && e.message || e) });
                }
                return;
            case 'net-sync':
                // A synchronous XMLHttpRequest of a page Worker (pagesw.js installXHR): the runner waits in Atomics.wait on
                // m.sab until the answer is written there.
                answerSync(m);
                return;
            case 'ws-open':
                wsOpen(v, m);
                return;
            case 'ws-write': {
                const t = v.ws && v.ws.get(m.wid);
                if (t && m.bytes)
                    deps.tunnel.write(t, new HostUint8Array(m.bytes));
                return;
            }
            case 'ws-close': {
                const t = v.ws && v.ws.get(m.wid);
                if (t) {
                    v.ws.delete(m.wid);
                    deps.tunnel.close(t);
                }
                return;
            }
            case 'idb':
                idbServer(v, m);
                return;
            case 'api':
                storageServer(v, m);
                return;
            case 'store': {
                const key = 'pagesw:' + String(m.key);
                if (m.op === 'get')
                    reply({ value: await store.get(key) });
                else if (m.op === 'put')
                    reply({ ok: await store.put(key, m.value).then(() => true) });
                else if (m.op === 'delete')
                    reply({ ok: await store.delete(key).then(() => true) });
                return;
            }
            case 'clients': {
                const list = [];
                if (documentURL && (m.all || controller === v)) {
                    list.push({ id: clientId, url: documentURL, type: 'window', frameType: 'top-level', focused: true, visibilityState: 'visible' });
                    for (const c of frameClients.values())
                        list.push({ id: c.id, url: c.url, type: 'window', frameType: 'nested', focused: false, visibilityState: 'visible' });
                }
                reply({ clients: list });
                return;
            }
            case 'claim':
                if (v.reg.active === v && documentURL && matchRegistration(documentURL) === v.reg && controller !== v)
                    setController(v);
                reply({ ok: true });
                return;
            case 'skip-waiting':
                v.skip = true;
                reply({ ok: true });
                if (v.state === 'installed')
                    activate(v.reg);
                return;
            case 'update':
                await new HostPromise((resolve) => queue(v.reg, async () => { let u; try { u = await update(v.reg); } finally { resolve(); } if (u && u.installed) await u.installed; })).catch(() => undefined);
                reply({ ok: true });
                return;
            case 'unregister':
                reply({ ok: unregister(v.reg) });
                return;
            case 'nested-create':
                if (v.dedicated && nestedWorkers)
                    nestedWorkers(v, m);
                return;
            case 'nested-post': {
                const c = v.children && v.children.get(m.nid);
                if (c)
                    c.post(m.data, ports, [...ports, ...streams.hostStreamsIn(m.data)]);
                return;
            }
            case 'nested-terminate': {
                const c = v.children && v.children.get(m.nid);
                if (c) {
                    v.children.delete(m.nid);
                    c.stop();
                }
                return;
            }
            case 'post':
                if (v.dedicated)
                    v.onPost(m.data, ports);
                return;
            case 'error':
                if (v.dedicated)
                    v.onError(m);
                return;
            case 'close':
                if (v.dedicated)
                    v.onClose();
                return;
            case 'bc-sub': {
                const name = String(m.name);
                let set = bcSubs.get(name);
                if (!set)
                    bcSubs.set(name, set = new Set());
                set.add(v);
                bcHub(name);
                return;
            }
            case 'bc-unsub': {
                const name = String(m.name), set = bcSubs.get(name);
                if (set) {
                    set.delete(v);
                    if (!set.size) {
                        bcSubs.delete(name);
                        const hub = bcHubs.get(name);
                        bcHubs.delete(name);
                        if (hub)
                            hub.close();
                    }
                }
                return;
            }
            case 'bc-post': {
                const name = String(m.name);
                bcForward(name, m.data, v);
                const hub = bcHub(name);
                if (hub) {
                    try {
                        hub.postMessage(m.data);
                    } catch (e) {
                        log('BroadcastChannel ' + name + ': ' + (e && e.message || e));
                    }
                    after();
                }
                return;
            }
            case 'client-post':
                if (m.clientId === clientId && page)
                    page.deliver(v, m.data, ports);
                return;
            case 'worker-post': {
                const to = [v.reg.installing, v.reg.waiting, v.reg.active].find((x) => x && x.id === m.to);
                if (to)
                    postToWorker(to, m.data, [...ports, ...streams.hostStreamsIn(m.data)], { id: '', url: v.scriptURL, type: 'worker' });
                return;
            }
            default:
                return;
            }
        }

        // --- The lifecycle (Install, Activate; the registration's job queue serialises them) --------------------
        function queue(reg, job) {
            const p = reg.job.then(job, job);
            reg.job = p.catch(() => undefined);
            return p;
        }
        async function install(reg, v) {
            if (reg.installing && reg.installing !== v)
                setState(reg.installing, 'redundant');
            reg.installing = v;
            setState(v, 'installing');
            if (page)
                page.updateFound(reg);
            try {
                const runner = await startRunner(v);
                const r = await runner.ask({ t: 'install' });
                if (!r.ok)
                    throw new Error(r.error || 'install failed');
            } catch (e) {
                log('install of ' + v.scriptURL + ' failed: ' + (e && e.message || e));
                if (reg.installing === v)
                    reg.installing = null;
                setState(v, 'redundant');
                if (!reg.active && !reg.waiting)
                    registrations.delete(reg.scope);
                await persist();
                return false;
            }
            if (reg.waiting && reg.waiting !== v)
                setState(reg.waiting, 'redundant');
            reg.installing = null;
            reg.waiting = v;
            setState(v, 'installed');
            await persist();
            // A waiting version takes over when its predecessor controls no client, or when it skipped waiting.
            if (!reg.active || v.skip || controller !== reg.active)
                await activate(reg);
            return true;
        }
        async function activate(reg) {
            const v = reg.waiting;
            if (!v)
                return;
            const old = reg.active;
            reg.waiting = null;
            reg.active = v;
            if (old && old !== v)
                setState(old, 'redundant');
            setState(v, 'activating');
            if (controller === old && old)
                setController(v);
            try {
                const runner = await startRunner(v);
                const r = await runner.ask({ t: 'activate' });
                if (!r.ok)
                    log('activate handler failed: ' + r.error);
            } catch (e) {
                log('activate of ' + v.scriptURL + ' failed: ' + (e && e.message || e));
            }
            if (reg.active === v)
                setState(v, 'activated');
            await persist();
            if (page)
                page.activated(reg);
        }
        function setController(v) {
            controller = v;
            if (page)
                page.controllerChanged();
        }

        // Fetches the script over the engine's network (the document's Fetch: cookies, CORS for the site) and installs a
        // new version when the bytes changed. Returns the registration.
        async function fetchScript(scriptURL) {
            // The worker's script skips every service worker (the page's own included) and carries `Service-Worker: script`.
            const n = await netFetch({ url: scriptURL, method: 'GET', mode: 'same-origin', redirect: 'error', headers: [['Service-Worker', 'script']] });
            const r = { status: n.status, contentType: headerGet(n.headers, 'content-type'), body: new HostUint8Array(n.body), serviceWorkerAllowed: headerGet(n.headers, 'service-worker-allowed') };
            if (r.status < 200 || r.status > 299)
                throw new TypeError(`Failed to register a ServiceWorker: a bad HTTP response code (${r.status}) was received when fetching the script.`);
            const type = (r.contentType || '').split(';')[0].trim();
            if (!JS_MIME.test(type))
                throw new DOMExceptionLike(`Failed to register a ServiceWorker: the script has an unsupported MIME type ('${type}').`, 'SecurityError');
            return { text: new HostTextDecoder().decode(r.body), allowed: r.serviceWorkerAllowed || null, coep: coepValue(headerGet(n.headers, 'cross-origin-embedder-policy')) };
        }
        async function update(reg, newScriptURL, type) {
            const current = reg.installing || reg.waiting || reg.active;
            const scriptURL = newScriptURL || (current && current.scriptURL);
            const fetched = await fetchScript(scriptURL);
            checkMaxScope(reg.scope, scriptURL, fetched.allowed);
            if (current && current.scriptURL === scriptURL && current.text === fetched.text && (type || current.type) === current.type)
                return reg;
            const v = newVersion(reg, scriptURL, type || (current && current.type) || 'classic', fetched.text, 'parsed');
            // A service worker is cross-origin isolated by its own COEP (Chrome), whatever its clients are.
            v.isolated = compatibleWithIsolation(fetched.coep) && siteOrigin.startsWith('https:');
            const installed = install(reg, v);
            return { reg, installed };
        }
        function checkMaxScope(scope, scriptURL, allowed) {
            const max = allowed ? new HostURL(allowed, scriptURL).href : scriptURL.slice(0, scriptURL.lastIndexOf('/') + 1);
            if (!scope.startsWith(max))
                throw new DOMExceptionLike(`Failed to register a ServiceWorker: the path of the provided scope ('${new HostURL(scope).pathname}') is not under the max scope allowed ('${new HostURL(max).pathname}'). Adjust the scope, move the Service Worker script, or use the Service-Worker-Allowed HTTP header to allow the scope.`, 'SecurityError');
        }
        function unregister(reg) {
            if (registrations.get(reg.scope) !== reg)
                return false;
            reg.uninstalling = true;
            registrations.delete(reg.scope);
            // Service Workers "Unregister": the job promise is resolved first, then Try Clear Registration makes the workers
            // redundant, whose statechange events are tasks of their own. So the page's `await reg.unregister()` goes on
            // before any of them (Chrome: no 'redundant' seen by code that runs right after the await).
            const gone = [reg.installing, reg.waiting];
            if (reg.active && controller !== reg.active)
                gone.push(reg.active);
            reg.installing = reg.waiting = null;
            hostSetTimeout(() => {
                for (const v of gone)
                    if (v)
                        setState(v, 'redundant');
            }, 0);
            persist();
            return true;
        }

        async function register(scriptURL, options = {}) {
            await restore();
            const script = new HostURL(scriptURL, documentURL);
            if (script.protocol !== 'https:' && !(script.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(script.hostname)))
                throw new TypeError('Failed to register a ServiceWorker: the URL protocol of the script (\'' + script.protocol + '\') is not supported.');
            if (script.origin !== siteOrigin)
                throw new DOMExceptionLike('Failed to register a ServiceWorker: the origin of the provided scriptURL (\'' + script.origin + '\') does not match the current origin (\'' + siteOrigin + '\').', 'SecurityError');
            const scope = new HostURL(options.scope !== undefined ? String(options.scope) : './', script.href);
            if (scope.origin !== siteOrigin)
                throw new DOMExceptionLike('Failed to register a ServiceWorker: the origin of the provided scope (\'' + scope.origin + '\') does not match the current origin (\'' + siteOrigin + '\').', 'SecurityError');
            scope.hash = '';
            const type = options.type === 'module' ? 'module' : 'classic';
            let reg = registrations.get(scope.href);
            const fresh = !reg;
            if (!reg)
                reg = newRegistration(scope.href, options.updateViaCache);
            else if (options.updateViaCache)
                reg.updateViaCache = options.updateViaCache;
            // The promise resolves once the job has its installing worker (or found the bytes unchanged); the job itself
            // holds the registration's queue until the install and activation are done.
            return new HostPromise((resolve, reject) => {
                queue(reg, async () => {
                    let u;
                    try {
                        u = await update(reg, script.href, type);
                    } catch (e) {
                        if (fresh && !reg.active && !reg.waiting && !reg.installing)
                            registrations.delete(reg.scope);
                        reject(e);
                        return;
                    }
                    resolve(reg);
                    if (u && u.installed)
                        await u.installed;
                });
            });
        }

        // --- Fetch events -----------------------------------------------------------------------------------------
        // The bytes of a ReadableStream, until it ends.
        async function readAll(stream) {
            const reader = stream.getReader();
            const parts = [];
            let length = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                if (!(value instanceof HostUint8Array))
                    throw new TypeError('the Response body has a chunk that is not a Uint8Array');
                parts.push(value);
                length += value.byteLength;
            }
            const out = new HostUint8Array(length);
            let at = 0;
            for (const part of parts) {
                out.set(part, at);
                at += part.byteLength;
            }
            return out;
        }
        // `wantStream`: the answer's body is handed back as a host ReadableStream (`stream`, chunks as the worker produces them)
        // instead of read to its end first (`body`); the engine's own loader needs the whole body, the page's fetch() does not.
        async function dispatchFetch(v, request, ids, wantStream) {
            const runner = await startRunner(v);
            if (!v.hasFetch)
                return null;
            const r = await runner.ask({ t: 'fetch', request, clientId: ids.clientId || '', resultingClientId: ids.resultingClientId || '' });
            if (r.fallback)
                return null;
            if (r.error)
                throw new TypeError('the service worker answered with a network error: ' + r.error);
            const res = r.response;
            if (res.type === 'error')
                throw new TypeError('the service worker answered with Response.error()');
            const headers = headerPairs(res.headers).filter(([n]) => !WIRE_RESPONSE_HEADERS.has(n.toLowerCase()));
            const meta = { status: res.status, headers, url: res.url || request.url, type: res.type, redirected: !!res.redirected };
            if (res.stream) {
                if (wantStream)
                    return { ...meta, body: null, stream: res.stream };
                try {
                    return { ...meta, body: await readAll(res.stream) };
                } catch (e) {
                    throw new TypeError('the service worker answered with a network error: ' + (e && e.message || e));
                }
            }
            return { ...meta, body: res.body ? new HostUint8Array(toBuffer(res.body)) : new HostUint8Array(0), stream: null };
        }
        const visibleHeaders = (headers) => headerPairs(headers).filter(([n]) => !HIDDEN_REQUEST_HEADERS.has(n.toLowerCase()));

        // A navigation of this segment's document: the controlling registration (if any) is chosen now. Resolves the
        // response the page's worker gave ({ status, headers, body, url }) or null for the engine's own navigation.
        async function navigation(url) {
            await restore();
            documentURL = url;
            siteOrigin = new HostURL(url).origin;
            const reg = matchRegistration(url);
            if (!reg)
                return null;
            // The previous document of the site is gone: a waiting version takes over before this one is controlled.
            if (reg.waiting)
                await activate(reg);
            if (!reg.active)
                return null;
            controller = reg.active;
            try {
                return await dispatchFetch(controller, {
                    url, method: 'GET', mode: 'navigate', credentials: 'include', redirect: 'manual', destination: 'document', body: null,
                    headers: [['accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'], ['upgrade-insecure-requests', '1']],
                }, { resultingClientId: clientId });
            } catch (e) {
                log('navigation fetch event: ' + (e && e.message || e));
                throw e;
            }
        }
        function documentLoaded(finalURL) {
            if (finalURL)
                documentURL = finalURL;
            siteOrigin = new HostURL(documentURL).origin;
            // The soft update a browser runs after a navigation in scope.
            const reg = matchRegistration(documentURL);
            if (reg && reg.active && !reg.installing)
                queue(reg, async () => { const u = await update(reg); if (u && u.installed) await u.installed; }).catch((e) => log('update check: ' + (e && e.message || e)));
        }

        // The engine's loader asks first for every request of this document (glue/engine/30-host.js). null: not ours.
        // fetch() calls the page's wrapper (pageFetch, below) already asked the worker about and then let go to the network: the
        // engine's loader must not ask again (url -> how many).
        const asked = new Map();
        function fetchHook(url, request) {
            if (!controller || controller.state === 'redundant' || !/^https?:/.test(url))
                return null;
            const n = asked.get(url);
            if (n) {
                if (n > 1)
                    asked.set(url, n - 1);
                else
                    asked.delete(url);
                return null;
            }
            if (controller.runner && !controller.hasFetch)
                return null;
            const data = {
                url, method: request.method || 'GET', mode: request.mode || 'no-cors', credentials: request.credentials === 'include' ? 'include' : 'same-origin',
                destination: request.destination || '', redirect: 'follow', headers: visibleHeaders(request.headers || []),
                body: request.body && request.body.length ? toBuffer(request.body) : null,
            };
            // A frame's navigation is a navigation request: no client yet (FetchEvent.clientId is ''), the frame's new document
            // is the resulting client. Everything else is its client's: the principal document's or a frame document's.
            const frameNavigation = request.navigate && (data.destination === 'iframe' || data.destination === 'frame');
            return dispatchFetch(controller, data, frameNavigation ? { clientId: '', resultingClientId: clientOf(url) } : { clientId: clientOf(request.client) });
        }

        // --- The worker's own network: the engine's TCP and TLS, redirects and CORS here -------------------------
        const syncEncoder = new HostTextEncoder();
        async function answerSync(m) {
            const sab = m.sab;
            let length;
            try { length = ReflectApply(sabLength, sab, []); } catch { return; }
            const i32 = new HostInt32Array(sab, 0, 4);
            let state = 1, meta, body = null;
            try {
                const res = await netFetch(m.request);
                meta = { type: res.type, status: res.status, statusText: res.statusText || '', headers: res.headers || [], url: res.url || '' };
                body = res.body ? new HostUint8Array(res.body) : new HostUint8Array(0);
            } catch (e) {
                state = 2;
                meta = { type: 'error', error: String(e && e.message || e) };
            }
            if (AtomicsLoad(i32, 3) !== m.seq)
                return; // the runner gave up on this request (its timeout) and asked another
            const metaBytes = syncEncoder.encode(JSONStringify(meta));
            const need = 16 + metaBytes.length + (body ? body.length : 0);
            try {
                if (need > length)
                    ReflectApply(sabGrow, sab, [need]);
                length = ReflectApply(sabLength, sab, []);
            } catch { /* over the runner's maximum: a network error */ }
            if (need <= length) {
                const bytes = new HostUint8Array(sab);
                bytes.set(metaBytes, 16);
                if (body)
                    bytes.set(body, 16 + metaBytes.length);
                AtomicsStore(i32, 1, metaBytes.length);
                AtomicsStore(i32, 2, body ? body.length : 0);
            } else {
                state = 2;
                AtomicsStore(i32, 1, 0);
                AtomicsStore(i32, 2, 0);
            }
            AtomicsStore(i32, 0, state);
            AtomicsNotify(i32, 0);
        }
        async function netFetch(r) {
            let url = new HostURL(r.url).href;
            let method = String(r.method || 'GET').toUpperCase();
            let body = r.body ? toBuffer(r.body) : null;
            const mode = r.mode || 'cors';
            let headers = visibleHeaders(r.headers || []);
            let redirected = false;
            let tainted = false; // went cross-origin on the way (a later same-origin hop stays cross-origin for CORS)
            for (let hops = 0; ; hops++) {
                const u = new HostURL(url);
                if (u.protocol !== 'https:' && u.protocol !== 'http:')
                    throw new TypeError('only http(s) can be fetched: ' + url);
                const crossOrigin = tainted || u.origin !== siteOrigin;
                if (crossOrigin && mode === 'same-origin')
                    throw new TypeError('a same-origin request to ' + u.origin);
                const sent = headers.slice();
                if (crossOrigin && mode === 'cors' || method !== 'GET' && method !== 'HEAD')
                    if (!headerGet(sent, 'origin'))
                        sent.push(['Origin', tainted ? 'null' : siteOrigin]);
                let res;
                try {
                    // Cookies (docs/cookies.md): the credentials mode decides; the engine adds the jar's and keeps Set-Cookie.
                    const credentials = r.credentials === 'include' || (r.credentials !== 'omit' && !crossOrigin);
                    res = deps.isStandIn && deps.isStandIn(url) ? await deps.standInFetch(url) : await deps.netRequest(method, url, sent, body, credentials);
                } catch (e) {
                    throw new TypeError(String(e && e.message || e) + ' (' + url + ')');
                }
                const resHeaders = headerPairs(res.headers);
                const location = headerGet(resHeaders, 'location');
                if ([301, 302, 303, 307, 308].includes(res.status) && location) {
                    if (r.redirect === 'error')
                        throw new TypeError('a redirect with redirect: error');
                    if (r.redirect === 'manual')
                        return { type: 'opaqueredirect', status: 0, statusText: '', headers: [], body: new HostArrayBuffer(0), url };
                    if (hops >= 20)
                        throw new TypeError('too many redirects');
                    const next = new HostURL(location, url);
                    if (next.origin !== u.origin && mode === 'cors' && crossOrigin)
                        tainted = true;
                    if (next.origin !== siteOrigin)
                        tainted = tainted || mode === 'cors';
                    if (res.status === 303 && method !== 'HEAD' || (res.status === 301 || res.status === 302) && method === 'POST') {
                        method = 'GET';
                        body = null;
                        headers = headers.filter(([n]) => !/^content-/i.test(n));
                    }
                    url = next.href;
                    redirected = true;
                    continue;
                }
                const clean = resHeaders.filter(([n]) => !WIRE_RESPONSE_HEADERS.has(n.toLowerCase()) && n.toLowerCase() !== 'set-cookie' && n.toLowerCase() !== 'set-cookie2');
                const out = { type: 'basic', status: res.status, statusText: '', headers: clean, body: toBuffer(res.body), url, redirected };
                if (!crossOrigin)
                    return out;
                if (mode === 'no-cors')
                    return { ...out, type: 'opaque' };
                const allow = headerGet(resHeaders, 'access-control-allow-origin');
                if (allow !== '*' && allow !== siteOrigin)
                    throw new TypeError('CORS: ' + url + ' does not allow ' + siteOrigin);
                // A credentialed CORS response must name the origin and allow credentials (Fetch, CORS check).
                if (r.credentials === 'include' && (allow === '*' || headerGet(resHeaders, 'access-control-allow-credentials') !== 'true'))
                    throw new TypeError('CORS: ' + url + ' does not allow credentials for ' + siteOrigin);
                const exposed = new Set(['cache-control', 'content-language', 'content-type', 'expires', 'last-modified', 'pragma', 'content-length']);
                for (const n of (headerGet(resHeaders, 'access-control-expose-headers') || '').split(','))
                    if (n.trim())
                        exposed.add(n.trim().toLowerCase());
                return { ...out, type: 'cors', headers: clean.filter(([n]) => exposed.has(n.toLowerCase()) || exposed.has('*')) };
            }
        }
        // A runner's own script load (importScripts) the segment's service worker passes on: never through the page's
        // worker. { status, headers: { 'content-type' }, body: ArrayBuffer }.
        async function bypassFetch(url) {
            const r = await netFetch({ url, method: 'GET', mode: 'no-cors', redirect: 'follow', headers: [] });
            return { status: r.status, headers: { 'content-type': headerGet(r.headers, 'content-type') || 'text/javascript' }, body: r.body };
        }

        // --- Messages -----------------------------------------------------------------------------------------------
        function postToWorker(v, data, transfer, source) {
            const ports = transfer.filter(isPort);
            startRunner(v).then((runner) => {
                runner.send({ t: 'message', data, origin: siteOrigin, ports: ports.length, source: source || { id: clientId, url: documentURL, type: 'window' } }, [...ports, ...transfer.filter((x) => !isPort(x))]);
            }).catch((e) => log('postMessage to the service worker: ' + (e && e.message || e)));
        }

        // --- The page's API -----------------------------------------------------------------------------------------
        // `P` is the page's global (the engine's Window mirrored onto the Worker's global): its EventTarget, Event,
        // MessageEvent and MessageChannel are the engine's, so the page's listeners get the engine's events.

        // --- IndexedDB for the page's workers (docs/architecture.md, "Page service workers") ---------------------------
        // A runner has no engine, and the site's IndexedDB is the page's: the engine's (LibWeb's) databases of this segment.
        // So `indexedDB` in a runner (pagesw.js) is a client of this server, which makes each call on the page's own
        // IDBFactory and sends back what happened, as Chrome's page and service worker share one origin's databases.
        // A transaction stays open while the runner may still add requests to it: the runner says `idle` after it has run
        // the callbacks of an event (and their microtasks); until then a cheap read on the same transaction keeps it from
        // committing between the messages (the engine commits a transaction that has no request pending).
        let pageIDB = null; // { factory, KeyRange }, once installPage ran
        const IDB_KEEP = '__chitin_upgrade';
        const idbDbs = new Map();     // `${runner}:${db}` -> engine IDBDatabase
        const idbTxs = new Map();     // `${runner}:${tx}` -> { tx, busy, pending, done, keepStore }
        const idbCursors = new Map(); // `${runner}:${rid}` -> { cursor, request, tx }
        const idbRunnerIds = new WeakMap();
        let idbNextRunner = 1;
        const idbKey = (v, id) => {
            let r = idbRunnerIds.get(v);
            if (!r)
                idbRunnerIds.set(v, r = idbNextRunner++);
            return r + ':' + id;
        };
        // An engine value as a plain host value the port can clone (the engine's objects reach this realm as mirrors).
        function idbPlain(x, seen) {
            if (x === null || typeof x !== 'object')
                return typeof x === 'function' ? undefined : x;
            seen = seen || new Map();
            if (seen.has(x))
                return seen.get(x);
            const tag = Object.prototype.toString.call(x);
            let out;
            if (tag === '[object Date]')
                out = new Date(+x);
            else if (tag === '[object ArrayBuffer]')
                out = HostUint8Array.from(new HostUint8Array(x)).buffer;
            else if (ArrayBuffer.isView(x))
                out = tag === '[object DataView]' ? new DataView(HostUint8Array.from(new HostUint8Array(x.buffer, x.byteOffset, x.byteLength)).buffer)
                    : new (globalThis[tag.slice(8, -1)] || HostUint8Array)(Array.from(x));
            else if (tag === '[object Blob]' || tag === '[object File]')
                out = x;
            else if (tag === '[object Map]') {
                out = new Map();
                seen.set(x, out);
                for (const [k, v] of x)
                    out.set(idbPlain(k, seen), idbPlain(v, seen));
                return out;
            } else if (tag === '[object Set]') {
                out = new Set();
                seen.set(x, out);
                for (const v of x)
                    out.add(idbPlain(v, seen));
                return out;
            } else if (Array.isArray(x)) {
                out = [];
                seen.set(x, out);
                for (let i = 0; i < x.length; i++)
                    out[i] = idbPlain(x[i], seen);
                return out;
            } else if (tag === '[object Error]' || tag === '[object DOMException]')
                out = { name: String(x.name), message: String(x.message) };
            else {
                out = {};
                seen.set(x, out);
                for (const k of Object.keys(x))
                    out[k] = idbPlain(x[k], seen);
                return out;
            }
            seen.set(x, out);
            return out;
        }
        // A key range or key from the runner ({ __kr: [lower, upper, lowerOpen, upperOpen] } for an IDBKeyRange).
        function idbArg(a) {
            if (a && typeof a === 'object' && Array.isArray(a.__kr)) {
                const [lo, up, lop, uop] = a.__kr, K = pageIDB.KeyRange;
                if (lo === undefined)
                    return K.upperBound(up, uop);
                if (up === undefined)
                    return K.lowerBound(lo, lop);
                return K.bound(lo, up, lop, uop);
            }
            return a;
        }
        const idbErr = (e) => ({ name: String(e && e.name || 'Error'), message: String(e && e.message || e) });
        function idbMeta(db) {
            const stores = [];
            let tx = null;
            const names = Array.from(db.objectStoreNames || []);
            try {
                tx = names.length ? db.transaction(names, 'readonly') : null;
            } catch {
                tx = null; // inside a versionchange transaction: read through it instead (idbMetaOf)
            }
            if (tx) {
                for (const n of names)
                    stores.push(idbStoreMeta(tx.objectStore(n)));
                try { tx.abort(); } catch { /* finished */ }
            }
            return { name: db.name, version: db.version, stores };
        }
        function idbStoreMeta(st) {
            const indexes = [];
            for (const n of Array.from(st.indexNames || [])) {
                const ix = st.index(n);
                indexes.push({ name: ix.name, keyPath: idbPlain(ix.keyPath), unique: !!ix.unique, multiEntry: !!ix.multiEntry });
            }
            return { name: st.name, keyPath: idbPlain(st.keyPath), autoIncrement: !!st.autoIncrement, indexes };
        }
        function idbMetaOf(db, tx) {
            const stores = Array.from(db.objectStoreNames || []).filter((n) => n !== IDB_KEEP).map((n) => idbStoreMeta(tx.objectStore(n)));
            return { name: db.name, version: db.version, stores };
        }
        // The workers' IndexedDB is their environment's (the engine's worker environment of the site's origin, Host.cpp): it works
        // while the page's document does not exist yet (a navigation the worker answers from its database) and across the
        // page's navigations, and shares the origin's databases with the page. The page's own factory without one.
        let workerIDB = null;
        function workerFactory() {
            if (!workerIDB && deps.workerEnvironment && siteOrigin) {
                const W = deps.workerEnvironment(siteOrigin + '/');
                if (W && W.indexedDB)
                    workerIDB = { origin: siteOrigin, factory: W.indexedDB, KeyRange: W.IDBKeyRange };
            }
            return workerIDB && workerIDB.origin === siteOrigin ? workerIDB : pageIDB;
        }
        function idbServer(v, m) {
            const send = (data) => v.runner && v.runner.send({ t: 'idb-ev', ...data });
            const pageIDB = workerFactory();
            if (!pageIDB) {
                if (m.rid)
                    send({ ev: 'error', rid: m.rid, error: { name: 'UnknownError', message: 'IndexedDB is not available yet' } });
                return;
            }
            const T = (id) => idbTxs.get(idbKey(v, id));
            // The engine runs a transaction's requests only while it is active, which is inside the callbacks of its own
            // requests: the runner's operations wait in `t.queue` and run there, at the next success of a request on it. While the
            // runner may still add some (`busy`), a cheap read keeps one request in flight; when it is done and nothing is pending,
            // the chain stops and the engine commits.
            const keepAlive = (t) => {
                if (t.done)
                    return;
                while (t.queue.length) {
                    const op = t.queue.shift();
                    try {
                        op();
                    } catch (e) {
                        log('indexedDB: ' + (e && e.name) + ': ' + (e && e.message));
                    }
                }
                if (t.pending > 0 || t.done)
                    return;
                if (!t.busy) {
                    // Done for now: a store made only to keep an upgrade open goes before the engine commits.
                    if (t.temp) {
                        t.temp = false;
                        try { t.db.deleteObjectStore(IDB_KEEP); } catch { /* gone */ }
                    }
                    if (t.commit) {
                        t.commit = false;
                        try { t.tx.commit(); } catch { /* finished */ }
                    }
                    return;
                }
                if (!t.keepStore)
                    return;
                let r;
                try {
                    r = t.tx.objectStore(t.keepStore).count(pageIDB.KeyRange.only(-Infinity));
                } catch {
                    return;
                }
                t.pending++;
                r.onsuccess = r.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); t.pending--; keepAlive(t); };
            };
            const later = (t, op) => { t.queue.push(op); };
            const track = (t, r, rid, onResult) => {
                t.pending++;
                r.onsuccess = () => {
                    t.pending--;
                    t.out++;
                    t.busy = true;
                    onResult ? onResult(r) : send({ ev: 'success', rid, result: idbPlain(r.result) });
                    keepAlive(t);
                };
                r.onerror = (e) => {
                    // The runner decides whether the error aborts (its handler's preventDefault); it says `abort` if so.
                    e.preventDefault();
                    t.pending--;
                    t.out++;
                    t.busy = true;
                    send({ ev: 'error', rid, error: idbErr(r.error) });
                    keepAlive(t);
                };
            };
            const watchTx = (id, tx, busy) => {
                const t = { tx, busy, out: busy ? 1 : 0, pending: 0, done: false, queue: [], keepStore: Array.from(tx.objectStoreNames || [])[0] || null };
                idbTxs.set(idbKey(v, id), t);
                tx.oncomplete = () => { t.done = true; idbTxs.delete(idbKey(v, id)); send({ ev: 'complete', tx: id }); };
                tx.onabort = () => { t.done = true; idbTxs.delete(idbKey(v, id)); send({ ev: 'abort', tx: id, error: tx.error ? idbErr(tx.error) : null }); };
                return t;
            };
            try {
                switch (m.op) {
                case 'open': {
                    const r = m.version === undefined ? pageIDB.factory.open(m.name) : pageIDB.factory.open(m.name, m.version);
                    let upgradeTx = null;
                    r.onupgradeneeded = (e) => {
                        const db = r.result;
                        idbDbs.set(idbKey(v, m.db), db);
                        upgradeTx = watchTx(m.tx, r.transaction, true);
                        const meta = idbMetaOf(db, r.transaction);
                        upgradeTx.db = db;
                        // A new database has no store to keep the upgrade open with: one of ours, for the upgrade's length.
                        if (!upgradeTx.keepStore) {
                            db.createObjectStore(IDB_KEEP);
                            upgradeTx.keepStore = IDB_KEEP;
                            upgradeTx.temp = true;
                        }
                        send({ ev: 'upgradeneeded', rid: m.rid, oldVersion: e.oldVersion, newVersion: e.newVersion, meta });
                        keepAlive(upgradeTx);
                    };
                    r.onblocked = (e) => send({ ev: 'blocked', rid: m.rid, oldVersion: e.oldVersion, newVersion: e.newVersion });
                    r.onsuccess = () => {
                        const db = r.result;
                        idbDbs.set(idbKey(v, m.db), db);
                        db.onversionchange = (e) => send({ ev: 'versionchange', db: m.db, oldVersion: e.oldVersion, newVersion: e.newVersion });
                        db.onclose = () => send({ ev: 'dbclose', db: m.db });
                        
                        send({ ev: 'success', rid: m.rid, meta: idbMeta(db) });
                    };
                    r.onerror = (e) => { e.preventDefault(); send({ ev: 'error', rid: m.rid, error: idbErr(r.error) }); };
                    void upgradeTx;
                    break;
                }
                case 'delete': {
                    const r = pageIDB.factory.deleteDatabase(m.name);
                    r.onsuccess = (e) => send({ ev: 'success', rid: m.rid, oldVersion: e.oldVersion });
                    r.onblocked = (e) => send({ ev: 'blocked', rid: m.rid, oldVersion: e.oldVersion, newVersion: null });
                    r.onerror = (e) => { e.preventDefault(); send({ ev: 'error', rid: m.rid, error: idbErr(r.error) }); };
                    break;
                }
                case 'databases':
                    HostPromise.resolve(pageIDB.factory.databases()).then((list) => send({ ev: 'success', rid: m.rid, result: idbPlain(list) }),
                        (e) => send({ ev: 'error', rid: m.rid, error: idbErr(e) }));
                    break;
                case 'cmp':
                    send({ ev: 'success', rid: m.rid, result: pageIDB.factory.cmp(idbArg(m.a), idbArg(m.b)) });
                    break;
                case 'close': {
                    const db = idbDbs.get(idbKey(v, m.db));
                    if (db)
                        db.close();
                    idbDbs.delete(idbKey(v, m.db));
                    break;
                }
                case 'tx': {
                    const db = idbDbs.get(idbKey(v, m.db));
                    const tx = m.durability ? db.transaction(m.stores, m.mode, { durability: m.durability }) : db.transaction(m.stores, m.mode);
                    const t = watchTx(m.tx, tx, true);
                    keepAlive(t);
                    break;
                }
                case 'schema': {
                    const t = T(m.tx);
                    const db = idbDbs.get(idbKey(v, m.db));
                    if (!t)
                        break;
                    later(t, () => {
                        try {
                            if (m.action === 'createObjectStore') {
                                db.createObjectStore(m.name, m.options);
                                if (!t.keepStore || t.keepStore === IDB_KEEP)
                                    t.keepStore = m.name;
                            } else if (m.action === 'deleteObjectStore') {
                                db.deleteObjectStore(m.name);
                                if (t.keepStore === m.name)
                                    t.keepStore = Array.from(db.objectStoreNames || [])[0] || null;
                                if (t.keepStore === null) {
                                    db.createObjectStore(IDB_KEEP);
                                    t.keepStore = IDB_KEEP;
                                    t.temp = true;
                                }
                            } else if (m.action === 'createIndex') {
                                t.tx.objectStore(m.store).createIndex(m.name, m.keyPath, m.options);
                            } else if (m.action === 'deleteIndex') {
                                t.tx.objectStore(m.store).deleteIndex(m.name);
                            }
                        } catch (e) {
                            log(`indexedDB ${m.action}: ${e && e.name}: ${e && e.message}`);
                            send({ ev: 'fail', tx: m.tx, op: m.op, error: idbErr(e) });
                        }
                    });
                    break;
                }
                case 'req': {
                    const t = T(m.tx);
                    if (!t || t.done) {
                        send({ ev: 'error', rid: m.rid, error: { name: 'TransactionInactiveError', message: 'The transaction has finished.' } });
                        break;
                    }
                    later(t, () => {
                        let r;
                        try {
                            let target = t.tx.objectStore(m.store);
                            if (m.index !== undefined)
                                target = target.index(m.index);
                            r = target[m.method](...(m.args || []).map(idbArg));
                        } catch (e) {
                            send({ ev: 'error', rid: m.rid, error: idbErr(e) });
                            return;
                        }
                        if (m.method === 'openCursor' || m.method === 'openKeyCursor') {
                            const key = idbKey(v, m.rid);
                            track(t, r, m.rid, (req) => {
                                const c = req.result;
                                if (!c) {
                                    idbCursors.delete(key);
                                    send({ ev: 'success', rid: m.rid, cursor: null });
                                    return;
                                }
                                idbCursors.set(key, { cursor: c, request: req, t });
                                send({ ev: 'success', rid: m.rid, cursor: { key: idbPlain(c.key), primaryKey: idbPlain(c.primaryKey), value: 'value' in c ? idbPlain(c.value) : undefined } });
                            });
                        } else {
                            track(t, r, m.rid);
                        }
                    });
                    break;
                }
                case 'cursor': {
                    const c = idbCursors.get(idbKey(v, m.rid));
                    if (!c)
                        break;
                    // The cursor's request fires again, into the handlers track() gave it.
                    later(c.t, () => {
                        c.cursor[m.method](...(m.args || []).map(idbArg));
                        c.t.pending++;
                    });
                    break;
                }
                case 'cursor-req': {
                    const c = idbCursors.get(idbKey(v, m.rid));
                    if (!c)
                        break;
                    later(c.t, () => {
                        let r;
                        try {
                            r = c.cursor[m.method](...(m.args || []).map(idbArg));
                        } catch (e) {
                            send({ ev: 'error', rid: m.nrid, error: idbErr(e) });
                            return;
                        }
                        track(c.t, r, m.nrid);
                    });
                    break;
                }
                case 'idle': {
                    const t = T(m.tx);
                    // One `idle` per event the runner dispatched (or per transaction it made): busy while any is outstanding,
                    // so an idle that answers an earlier event does not end a chain the runner is still adding to.
                    if (t) {
                        t.out = Math.max(0, t.out - 1);
                        t.busy = t.out > 0;
                    }
                    break;
                }
                case 'commit': {
                    const t = T(m.tx);
                    if (t) {
                        t.out = 0;
                        t.busy = false;
                        t.commit = true;
                    }
                    break;
                }
                case 'abort': {
                    const t = T(m.tx);
                    if (t && !t.done)
                        t.tx.abort();
                    break;
                }
                default:
                    break;
                }
            } catch (e) {
                if (m.rid)
                    send({ ev: 'error', rid: m.rid, error: idbErr(e) });
                else if (m.tx !== undefined) {
                    log(`indexedDB ${m.op} ${m.action || ''}: ${e && e.name}: ${e && e.message}`);
                    send({ ev: 'fail', tx: m.tx, op: m.op, error: idbErr(e) });
                }
                else
                    log('indexedDB: ' + (e && e.message || e));
            } finally {
                after();
            }
        }


        // --- Web Locks and the Cookie Store for the page's workers: the page's own (the engine's), as in Chrome ------------
        let pageStorageAPIs = null;
        const lockReleases = new Map(); // `${runner}:${lid}` -> resolve
        function storageServer(v, m) {
            const send = (data) => v.runner && v.runner.send({ t: 'api-ev', ...data });
            const fail = (e) => send({ rid: m.rid, ok: false, error: idbErr(e) });
            const api = pageStorageAPIs && pageStorageAPIs[m.api];
            if (!api) {
                fail({ name: 'NotSupportedError', message: m.api + ' is not available' });
                return;
            }
            try {
                if (m.api === 'locks' && m.method === 'request') {
                    const key = idbKey(v, m.rid);
                    const p = api.request(m.name, m.options || {}, (lock) => {
                        send({ rid: m.rid, granted: true, lock: lock ? { name: String(lock.name), mode: String(lock.mode) } : null });
                        return new HostPromise((resolve) => lockReleases.set(key, resolve));
                    });
                    HostPromise.resolve(p).then(() => send({ rid: m.rid, done: true }), fail).finally(after);
                } else if (m.api === 'locks' && m.method === 'release') {
                    const key = idbKey(v, m.rid);
                    const release = lockReleases.get(key);
                    lockReleases.delete(key);
                    if (release)
                        release();
                } else {
                    HostPromise.resolve(api[m.method](...(m.args || []))).then((value) => send({ rid: m.rid, ok: true, value: idbPlain(value) }), fail).finally(after);
                }
            } catch (e) {
                fail(e);
            } finally {
                after();
            }
        }

        function installPage(P, HostMessageChannel) {
            pageIDB = P.indexedDB ? { factory: P.indexedDB, KeyRange: P.IDBKeyRange } : null;
            pageStorageAPIs = { locks: P.navigator && P.navigator.locks, cookieStore: P.cookieStore };
            const DOMException = P.DOMException;
            if (typeof P.BroadcastChannel === 'function') {
                const PageBroadcastChannel = P.BroadcastChannel;
                bcHubFor = (name) => {
                    const c = new PageBroadcastChannel(name);
                    c.onmessage = (e) => bcForward(name, e.data, null);
                    return c;
                };
                for (const name of bcSubs.keys())
                    bcHub(name);
            }
            const pageEvent = (type) => new P.Event(type);
            const handlerSlot = new WeakMap();
            function eventHandler(proto, name) {
                defineProperty(proto, 'on' + name, {
                    get() { const s = handlerSlot.get(this); return (s && s[name]) || null; },
                    set(fn) {
                        let s = handlerSlot.get(this);
                        if (!s)
                            handlerSlot.set(this, s = {});
                        if (s['wrap_' + name])
                            P.EventTarget.prototype.removeEventListener.call(this, name, s['wrap_' + name]);
                        s[name] = typeof fn === 'function' ? fn : null;
                        s['wrap_' + name] = null;
                        if (s[name]) {
                            const self = this;
                            s['wrap_' + name] = (e) => s[name] && ReflectApply(s[name], self, [e]);
                            P.EventTarget.prototype.addEventListener.call(this, name, s['wrap_' + name]);
                            if (name === 'message' && this === container)
                                container.startMessages();
                        }
                    },
                    configurable: true, enumerable: true,
                });
            }
            // A browser's event (isTrusted true, as Chrome's Worker message events are).
            const fireTrusted = (target, event) => {
                if (!deps.dispatchTrusted)
                    return fire(target, event);
                try {
                    deps.dispatchTrusted(target, event);
                } finally {
                    after();
                }
            };
            const fire = (target, event) => {
                try {
                    target.dispatchEvent(event);
                } finally {
                    after();
                }
            };

            // Page MessagePorts (the engine's) joined to host MessagePorts, for a reply channel across the runner.
            // Streams ride along: a page stream in a message from the page's port was already moved by the engine (the port's
            // postMessage made a stream of its own), so every one in it goes on to the host; a host stream in a message for
            // the page is handed to the engine port's postMessage as transferred, which makes the page stream.
            function bridgeOut(pagePorts) {
                const out = [];
                for (const p of pagePorts || []) {
                    const ch = new HostMessageChannel();
                    p.onmessage = (e) => {
                        try {
                            const o = streams.outbound(e.data, [], { received: true });
                            ch.port1.postMessage(o.message, o.transfer);
                        } catch (err) {
                            log('a page message to the service worker could not be sent: ' + (err && err.message || err));
                        }
                    };
                    ch.port1.onmessage = (e) => {
                        try {
                            p.postMessage(e.data, streams.hostStreamsIn(e.data));
                        } catch (err) {
                            log('a service worker message to the page could not be delivered: ' + (err && err.message || err));
                        }
                        after();
                    };
                    out.push(ch.port2);
                }
                return out;
            }
            function bridgeIn(hostPorts) {
                const out = [];
                for (const h of hostPorts || []) {
                    const ch = new P.MessageChannel();
                    h.onmessage = (e) => {
                        try {
                            ch.port1.postMessage(e.data, streams.hostStreamsIn(e.data));
                        } catch (err) {
                            log('a service worker message to the page could not be delivered: ' + (err && err.message || err));
                        }
                        after();
                    };
                    ch.port1.onmessage = (e) => {
                        try {
                            const o = streams.outbound(e.data, [], { received: true });
                            h.postMessage(o.message, o.transfer);
                        } catch (err) {
                            log('a page message to the service worker could not be sent: ' + (err && err.message || err));
                        }
                    };
                    out.push(ch.port2);
                }
                return out;
            }
            // A port may be in the message as well as in the transfer list (Comlink sends { value: port2 } with [port2]): the
            // message then holds the port that arrives, as in Chrome, not a copy of the sender's object.
            const swapPorts = (message, from, to) => {
                if (!from.length)
                    return message;
                const isListed = (x) => from.includes(x);
                return streams.containsStream(message, isListed) ? streams.substitute(message, isListed, (x) => to[from.indexOf(x)]) : message;
            };
            function portsOut(message, pagePorts) {
                const hostPorts = bridgeOut(pagePorts);
                return { message: swapPorts(message, pagePorts, hostPorts), hostPorts };
            }
            function portsIn(data, hostPorts) {
                const list = Array.from(hostPorts || []);
                const pagePorts = bridgeIn(list);
                return { data: swapPorts(data, list, pagePorts), ports: pagePorts };
            }
            const transferList = (t) => (Array.isArray(t) ? t : (t && Array.isArray(t.transfer) ? t.transfer : []));

            class ServiceWorker extends P.EventTarget {
                #v;
                constructor(v) { super(); this.#v = v; }
                get scriptURL() { return this.#v.scriptURL; }
                get state() { return this.#v.state; }
                postMessage(message, transfer) {
                    if (this.#v.state === 'redundant')
                        return;
                    const list = transferList(transfer);
                    const pagePorts = list.filter((x) => x instanceof P.MessagePort);
                    // Streams in the transfer list become host streams, in the message and in the transfer list.
                    const out = streams.outbound(message, list.filter((x) => !(x instanceof P.MessagePort)));
                    const po = portsOut(out.message, pagePorts);
                    postToWorker(this.#v, po.message, [...po.hostPorts, ...out.transfer]);
                }
            }
            eventHandler(ServiceWorker.prototype, 'statechange');
            eventHandler(ServiceWorker.prototype, 'error');
            const workerObject = (v) => {
                if (!v)
                    return null;
                if (!v.page)
                    v.page = new ServiceWorker(v);
                return v.page;
            };

            class NavigationPreloadManager {
                async enable() {}
                async disable() {}
                async setHeaderValue() {}
                async getState() { return { enabled: false, headerValue: 'true' }; }
            }
            const preload = new NavigationPreloadManager();
            class ServiceWorkerRegistration extends P.EventTarget {
                #reg;
                constructor(reg) { super(); this.#reg = reg; }
                get scope() { return this.#reg.scope; }
                get installing() { return workerObject(this.#reg.installing); }
                get waiting() { return workerObject(this.#reg.waiting); }
                get active() { return workerObject(this.#reg.active); }
                get updateViaCache() { return this.#reg.updateViaCache; }
                get navigationPreload() { return preload; }
                async update() {
                    const reg = this.#reg;
                    if (reg.uninstalling)
                        throw new DOMException('Failed to update a ServiceWorker: the registration is gone', 'InvalidStateError');
                    await new HostPromise((resolve, reject) => queue(reg, async () => { let u; try { u = await update(reg); } catch (e) { reject(e); return; } resolve(); if (u && u.installed) await u.installed; }));
                    return this;
                }
                async unregister() { return unregister(this.#reg); }
                showNotification() { return HostPromise.reject(new TypeError('notifications are not supported in Chitin')); }
                getNotifications() { return HostPromise.resolve([]); }
            }
            eventHandler(ServiceWorkerRegistration.prototype, 'updatefound');
            const registrationObject = (reg) => {
                if (!reg)
                    return undefined;
                if (!reg.page)
                    reg.page = new ServiceWorkerRegistration(reg);
                return reg.page;
            };

            // --- Dedicated Workers (new Worker(url, options)) ----------------------------------------------------------
            // The page's worker runs in a runner of its own (harness/segment/pagesw.js, kind 'dedicated'): a real Worker on the
            // segment origin with the host's doors removed, its network over the port to this segment (the engine's), its
            // script fetched here with the page's fetch (http(s) same-origin, blob: and data: as in Chrome).
            const JS_MIME_TYPE = /^\s*(text|application)\/(x-)?(javascript|ecmascript)\s*(;|$)|^\s*text\/(jscript|livescript)\s*(;|$)/i;
            let blobSeq = 0;
            const liveWorkers = new Set();
            // W: the global the Worker interface is for (the principal window's, or a same-site frame realm's, whose relative
            // URLs resolve against its own document and whose events are its own).
            function makeWorker(W) {
                class Worker extends W.EventTarget {
                    #v;
                    #terminated = false;
                    constructor(scriptURL, options) {
                        if (new.target === undefined)
                            throw new TypeError("Failed to construct 'Worker': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
                        super();
                        if (arguments.length < 1)
                            throw new TypeError("Failed to construct 'Worker': 1 argument required, but only 0 present.");
                        const opts = options === undefined || options === null ? {} : options;
                        const type = opts.type === undefined ? 'classic' : String(opts.type);
                        if (type !== 'classic' && type !== 'module')
                            throw new TypeError(`Failed to construct 'Worker': The provided value '${type}' is not a valid enum value of type WorkerType.`);
                        const name = opts.name === undefined ? '' : String(opts.name);
                        let url;
                        try {
                            url = new HostURL(typeof scriptURL === 'string' ? scriptURL : String(scriptURL), W.document && W.document.baseURI ? W.document.baseURI : documentURL);
                        } catch {
                            throw new DOMException(`Failed to construct 'Worker': The URL '${String(scriptURL)}' is invalid.`, 'SyntaxError');
                        }
                        const scheme = url.protocol;
                        if (scheme !== 'blob:' && scheme !== 'data:' && url.origin !== siteOrigin)
                            throw new DOMException(`Failed to construct 'Worker': Script at '${url.href}' cannot be accessed from origin '${siteOrigin}'.`, 'SecurityError');
                        const v = { dedicated: true, scriptURL: url.href, loadURL: '', type, name, text: '', runner: null, page: null, ws: null, t0: hostNow() };
                        this.#v = v;
                        liveWorkers.add(this);
                        v.onPost = (data, ports) => {
                            if (!this.#terminated)
                                { const pi = portsIn(streams.inbound(data), ports); fireTrusted(this, deps.messageEvent ? deps.messageEvent(W.MessageEvent, pi.data, pi.ports) : new W.MessageEvent('message', { data: pi.data, ports: pi.ports })); }
                        };
                        v.onError = (m) => {
                            if (this.#terminated)
                                return;
                            const init = { message: String(m.message || ''), filename: String(m.filename || ''), lineno: m.lineno | 0, colno: m.colno | 0, cancelable: true };
                            fire(this, W.ErrorEvent ? new W.ErrorEvent('error', init) : new W.Event('error', { cancelable: true }));
                        };
                        v.onClose = () => {
                            this.#terminated = true;
                            liveWorkers.delete(this);
                            if (v.runner)
                                v.runner.close();
                        };
                        // The script is fetched after the constructor returns, as in Chrome (the page's listeners are set by then).
                        // A blob: URL is resolved now (HTML: the URL record keeps its blob URL entry from parsing), so a page
                        // that revokes it right after `new Worker(url)` still starts the worker, as in Chrome; the fetch of
                        // any other URL starts after the constructor returns.
                        const fetchScript = () => ReflectApply(W === P ? engineFetch || P.fetch : W.fetch, W, [url.href, { credentials: 'same-origin' }]);
                        let early = null;
                        if (scheme === 'blob:') {
                            try { early = fetchScript(); } catch (e) { early = HostPromise.reject(e); }
                            early.catch(() => undefined);
                        }
                        v.ready = (async () => {
                            await null;
                            let response;
                            try {
                                response = await (early || fetchScript());
                            } catch {
                                response = null;
                            }
                            if (!response || !response.ok || (scheme !== 'blob:' && scheme !== 'data:' && !JS_MIME_TYPE.test(response.headers.get('content-type') || ''))) {
                                if (!this.#terminated)
                                    fire(this, new W.Event('error', { cancelable: true }));
                                throw new Error('the worker script could not be loaded: ' + url.href);
                            }
                            // HTML "check a global object's embedder policy": a worker without a COEP compatible with
                            // cross-origin isolation is refused under an owner whose COEP is (a blob: or data: worker has
                            // its owner's); the worker is isolated when its owner is.
                            const ownerCoep = deps.embedderPolicyOf ? deps.embedderPolicyOf(W) : 'unsafe-none';
                            v.coep = scheme === 'blob:' || scheme === 'data:' ? ownerCoep : coepValue(response.headers.get('cross-origin-embedder-policy'));
                            if (compatibleWithIsolation(ownerCoep) && !compatibleWithIsolation(v.coep)) {
                                if (!this.#terminated)
                                    fire(this, new W.Event('error', { cancelable: true }));
                                throw new Error('the worker script has no Cross-Origin-Embedder-Policy and its owner requires one: ' + url.href);
                            }
                            v.isolated = W.crossOriginIsolated === true;
                            v.text = await response.text();
                            spawnMark(v, 'fetched');
                            v.loadURL = scheme === 'blob:' || scheme === 'data:' ? `${siteOrigin}/__chitin_worker/${++blobSeq}-${randomUUID()}.js` : url.href;
                            if (this.#terminated)
                                throw new Error('terminated');
                            return startRunner(v);
                        })();
                        v.ready.then((runner) => { v.live = runner; }, () => undefined);
                        v.ready.catch((e) => { if (!this.#terminated) log('worker ' + url.href.slice(0, 120) + ': ' + (e && e.message || e)); });
                    }
                    postMessage(message, transfer) {
                        if (this.#terminated)
                            return;
                        if (W.crossOriginIsolated !== true && containsShared(message))
                            throw new DOMException("Failed to execute 'postMessage' on 'Worker': SharedArrayBuffer transfer requires self.crossOriginIsolated.", 'DataCloneError');
                        const list = transferList(transfer);
                        const pagePorts = list.filter((x) => x instanceof W.MessagePort);
                        const out = streams.outbound(message, list.filter((x) => !(x instanceof W.MessagePort)));
                        const po = portsOut(out.message, pagePorts);
                        const moved = [...po.hostPorts, ...out.transfer];
                        // Transferred objects are detached now, as in Chrome, even while the runner is still starting.
                        const ports = moved.filter(isPort), others = moved.filter((x) => !isPort(x));
                        statOf(this.#v).in++;
                        reportStats();
                        // Once the runner runs (every earlier message sent), the port's own clone is the only one: a task's
                        // Worker gets its large hand-over messages (Maps of compiled modules) without a second copy.
                        if (this.#v.live) {
                            this.#v.live.send({ t: 'message', data: po.message, origin: '', ports: ports.length }, [...ports, ...others]);
                            return;
                        }
                        const held = hostStructuredClone({ data: po.message, ports, others }, { transfer: [...ports, ...others] });
                        this.#v.ready.then((runner) => runner.send({ t: 'message', data: held.data, origin: '', ports: held.ports.length }, [...held.ports, ...held.others])).catch(() => undefined);
                    }
                    terminate() {
                        if (this.#terminated)
                            return;
                        this.#terminated = true;
                        liveWorkers.delete(this);
                        if (this.#v.runner)
                            this.#v.runner.close();
                        else
                            this.#v.ready.then((runner) => runner.close()).catch(() => undefined);
                    }
                }
                eventHandler(Worker.prototype, 'message');
                eventHandler(Worker.prototype, 'messageerror');
                eventHandler(Worker.prototype, 'error');
                defineProperty(Worker.prototype, Symbol.toStringTag, { value: 'Worker', configurable: true });
                return Worker;
            }
            const PageWorker = makeWorker(P);

            // A Worker made by a page's worker (nested): its own runner, its script resolved against the parent's URL and
            // fetched with the page's fetch (same origin, data:, or a blob: the parent read from its own store), its messages
            // and errors relayed to the parent's Worker object through the parent's runner.
            nestedWorkers = (parent, m) => {
                if (!parent.children)
                    parent.children = new Map();
                const nid = m.nid;
                const toParent = (fields, transfer) => parent.runner && parent.runner.send({ t: 'nested-event', nid, ...fields }, transfer || []);
                const v = { dedicated: true, scriptURL: String(m.url), loadURL: '', type: m.type === 'module' ? 'module' : 'classic', name: String(m.name || ''), text: '', runner: null, page: null, ws: null };
                let stopped = false;
                v.onPost = (data, hostPorts) => toParent({ kind: 'message', data, ports: hostPorts.length }, hostPorts);
                v.onError = (e) => toParent({ kind: 'error', message: String(e.message || ''), filename: String(e.filename || ''), lineno: e.lineno | 0, colno: e.colno | 0 });
                v.onClose = () => { stopped = true; parent.children.delete(nid); if (v.runner) v.runner.close(); toParent({ kind: 'close' }); };
                v.ready = (async () => {
                    const url = new HostURL(v.scriptURL);
                    let text = typeof m.text === 'string' ? m.text : null;
                    if (text === null) {
                        let response = null;
                        try {
                            response = await ReflectApply(engineFetch || P.fetch, P, [url.href, { credentials: 'same-origin' }]);
                        } catch {
                            response = null;
                        }
                        if (!response || !response.ok || (url.protocol !== 'data:' && !JS_MIME_TYPE.test(response.headers.get('content-type') || ''))) {
                            toParent({ kind: 'error', plain: true });
                            throw new Error('the worker script could not be loaded: ' + url.href);
                        }
                        v.coep = url.protocol === 'blob:' || url.protocol === 'data:' ? parent.coep : coepValue(response.headers.get('cross-origin-embedder-policy'));
                        text = await response.text();
                    } else {
                        v.coep = parent.coep;
                    }
                    if (compatibleWithIsolation(parent.coep) && !compatibleWithIsolation(v.coep)) {
                        toParent({ kind: 'error', plain: true });
                        throw new Error('the worker script has no Cross-Origin-Embedder-Policy and its owner requires one: ' + url.href);
                    }
                    v.isolated = !!parent.isolated;
                    v.text = text;
                    v.loadURL = url.protocol === 'blob:' || url.protocol === 'data:' ? `${siteOrigin}/__chitin_worker/${++blobSeq}-${randomUUID()}.js` : url.href;
                    if (stopped)
                        throw new Error('terminated');
                    return startRunner(v);
                })();
                v.ready.catch((e) => { if (!stopped) log('nested worker ' + v.scriptURL.slice(0, 120) + ': ' + (e && e.message || e)); });
                parent.children.set(nid, {
                    post: (data, hostPorts, transfer) => v.ready.then((runner) => runner.send({ t: 'message', data, origin: '', ports: hostPorts.length }, transfer)).catch(() => undefined),
                    stop: () => { if (stopped) return; stopped = true; if (v.runner) v.runner.close(); else v.ready.then((r) => r.close()).catch(() => undefined); },
                });
            };

            // --- SharedWorker (new SharedWorker(url, options)) ---------------------------------------------------------------
            // One runner (harness/segment/pagesw.js, kind 'shared') per script URL and name for this segment's site, shared by
            // the principal window and its same-site frames. Each constructor makes a channel: the page keeps one end (`port`,
            // the engine's MessagePort bridged to a host one), the runner gets the other in a `connect` event.
            const sharedWorkers = new Map(); // url + '\n' + name -> { v, objects }
            function makeSharedWorker(W) {
                class SharedWorker extends W.EventTarget {
                    #port;
                    constructor(scriptURL, options) {
                        if (new.target === undefined)
                            throw new TypeError("Failed to construct 'SharedWorker': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
                        super();
                        if (arguments.length < 1)
                            throw new TypeError("Failed to construct 'SharedWorker': 1 argument required, but only 0 present.");
                        const opts = typeof options === 'string' ? { name: options } : (options === undefined || options === null ? {} : options);
                        const type = opts.type === undefined ? 'classic' : String(opts.type);
                        if (type !== 'classic' && type !== 'module')
                            throw new TypeError(`Failed to construct 'SharedWorker': The provided value '${type}' is not a valid enum value of type WorkerType.`);
                        const name = opts.name === undefined ? '' : String(opts.name);
                        let url;
                        try {
                            url = new HostURL(String(scriptURL), W.document && W.document.baseURI ? W.document.baseURI : documentURL);
                        } catch {
                            throw new DOMException(`Failed to construct 'SharedWorker': The URL '${String(scriptURL)}' is invalid.`, 'SyntaxError');
                        }
                        const scheme = url.protocol;
                        if (scheme !== 'blob:' && scheme !== 'data:' && url.origin !== siteOrigin)
                            throw new DOMException(`Failed to construct 'SharedWorker': Script at '${url.href}' cannot be accessed from origin '${siteOrigin}'.`, 'SecurityError');
                        const ch = new HostMessageChannel();
                        this.#port = bridgeIn([ch.port1])[0];
                        const key = url.href + '\n' + name;
                        let entry = sharedWorkers.get(key);
                        if (!entry) {
                            const v = { dedicated: true, kind: 'shared', scriptURL: url.href, loadURL: '', type, name, text: '', runner: null, page: null, ws: null };
                            entry = { v, objects: new Set(), failed: false };
                            const e = entry;
                            sharedWorkers.set(key, entry);
                            v.onPost = () => undefined;
                            v.onError = () => undefined; // Chrome reports a SharedWorker's runtime errors to its own console only
                            v.onClose = () => { sharedWorkers.delete(key); if (v.runner) v.runner.close(); };
                            v.ready = (async () => {
                                await null;
                                let response;
                                try {
                                    response = await ReflectApply(W === P ? engineFetch || P.fetch : W.fetch, W, [url.href, { credentials: 'same-origin' }]);
                                } catch {
                                    response = null;
                                }
                                if (!response || !response.ok || (scheme !== 'blob:' && scheme !== 'data:' && !JS_MIME_TYPE.test(response.headers.get('content-type') || ''))) {
                                    e.failed = true;
                                    sharedWorkers.delete(key);
                                    for (const o of e.objects)
                                        fire(o, new W.Event('error', { cancelable: true }));
                                    throw new Error('the shared worker script could not be loaded: ' + url.href);
                                }
                                // A SharedWorker is isolated by its own COEP (a blob: or data: one by its creator's), in an
                                // isolated creator's agent cluster.
                                v.coep = scheme === 'blob:' || scheme === 'data:' ? (deps.embedderPolicyOf ? deps.embedderPolicyOf(W) : 'unsafe-none') : coepValue(response.headers.get('cross-origin-embedder-policy'));
                                v.isolated = W.crossOriginIsolated === true && compatibleWithIsolation(v.coep);
                                v.text = await response.text();
                                v.loadURL = scheme === 'blob:' || scheme === 'data:' ? `${siteOrigin}/__chitin_worker/${++blobSeq}-${randomUUID()}.js` : url.href;
                                return startRunner(v);
                            })();
                            v.ready.catch((err) => log('shared worker ' + url.href.slice(0, 120) + ': ' + (err && err.message || err)));
                        }
                        entry.objects.add(this);
                        entry.v.ready.then((runner) => runner.send({ t: 'connect' }, [ch.port2])).catch(() => undefined);
                    }
                    get port() { return this.#port; }
                }
                eventHandler(SharedWorker.prototype, 'error');
                defineProperty(SharedWorker.prototype, Symbol.toStringTag, { value: 'SharedWorker', configurable: true });
                return SharedWorker;
            }
            const PageSharedWorker = makeSharedWorker(P);
            let readyResolve;
            const ready = new HostPromise((resolve) => { readyResolve = resolve; });
            let messagesStarted = false;
            const queued = [];
            class ServiceWorkerContainer extends P.EventTarget {
                get controller() { return controller && controller.state !== 'redundant' ? workerObject(controller) : null; }
                get ready() { return ready; }
                register(scriptURL, options) {
                    return (async () => {
                        try {
                            const reg = await register(String(scriptURL), options || {});
                            checkReady();
                            return registrationObject(reg);
                        } catch (e) {
                            throw e instanceof DOMExceptionLike ? new DOMException(e.message, e.name) : e;
                        }
                    })();
                }
                async getRegistration(clientURL) {
                    await restore();
                    const url = clientURL === undefined ? documentURL : new HostURL(String(clientURL), documentURL).href;
                    if (new HostURL(url).origin !== siteOrigin)
                        throw new DOMException('Failed to get a ServiceWorkerRegistration: the origin of the provided documentURL does not match the current origin.', 'SecurityError');
                    return registrationObject(matchRegistration(url));
                }
                async getRegistrations() {
                    await restore();
                    return [...registrations.values()].filter((r) => !r.uninstalling).map(registrationObject);
                }
                startMessages() {
                    if (messagesStarted)
                        return;
                    messagesStarted = true;
                    for (const m of queued.splice(0))
                        deliverNow(m);
                }
            }
            eventHandler(ServiceWorkerContainer.prototype, 'controllerchange');
            eventHandler(ServiceWorkerContainer.prototype, 'message');
            eventHandler(ServiceWorkerContainer.prototype, 'messageerror');
            const container = new ServiceWorkerContainer();

            function checkReady() {
                const reg = documentURL && matchRegistration(documentURL);
                if (reg && reg.active)
                    readyResolve(registrationObject(reg));
            }
            function deliverNow(m) {
                const pi = portsIn(streams.inbound(m.data), m.ports);
                const event = new P.MessageEvent('message', { data: pi.data, origin: siteOrigin, ports: pi.ports });
                defineProperty(event, 'source', { value: workerObject(m.from), configurable: true, enumerable: true });
                fire(container, event);
            }
            // The page's names: its own interfaces replace the engine's (LibWeb's ServiceWorkerContainer would refuse every
            // registration: its script and referrer origins differ, since the Worker's real origin is the segment's).
            // Again for every new document in the realm (the engine reinstalls the Window's names): documentReset.
            // fetch() of a controlled page: the worker's answer arrives as a stream, so the page's Response has a body that streams
            // (the engine's own loader, which every other request takes, is handed bytes). The decision is made on the request, as
            // the loader's is: not controlled, no fetch listener, another origin, or a scheme other than http(s) take the engine's fetch.
            // A page that replaces window.fetch (a proxy, a polyfill) replaces this one, and calls it as the engine's own.
            let engineFetch = null;
            function installFetch() {
                const current = P.fetch;
                if (typeof current !== 'function' || (engineFetch && current === pageFetch))
                    return;
                engineFetch = current;
                const f = { fetch(input, init) { return pageFetch.apply(this, arguments); } }.fetch;
                defineProperty(f, 'length', { value: 1, configurable: true });
                defineProperty(P, 'fetch', { value: f, writable: true, configurable: true, enumerable: true });
            }
            const eligible = () => !!controller && controller.state !== 'redundant' && !(controller.runner && !controller.hasFetch);
            async function pageFetch(input, init) {
                const self = this === undefined || this === null ? P : this;
                const native = (a, b) => ReflectApply(engineFetch, self, b === undefined ? [a] : [a, b]);
                if (!eligible() || !streams.bound)
                    return ReflectApply(engineFetch, self, [...arguments]);
                const request = new P.Request(input, init);
                let url;
                try { url = new HostURL(request.url); } catch { return native(request); }
                if (!/^https?:$/.test(url.protocol) || url.origin !== siteOrigin || request.mode === 'navigate')
                    return native(request);
                const signal = request.signal;
                const aborted = () => (signal.reason !== undefined ? signal.reason : new DOMException('The user aborted a request.', 'AbortError'));
                if (signal.aborted)
                    throw aborted();
                const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
                const body = hasBody ? await request.arrayBuffer() : null;
                const data = {
                    url: url.href, method: request.method, mode: request.mode, credentials: request.credentials === 'include' ? 'include' : 'same-origin',
                    destination: '', redirect: request.redirect || 'follow', headers: visibleHeaders([...request.headers]), body: body && body.byteLength ? body : null,
                };
                let res;
                try {
                    let onAbort;
                    const gone = new HostPromise((_, reject) => { onAbort = () => reject(aborted()); signal.addEventListener('abort', onAbort, { once: true }); });
                    try {
                        res = await HostPromise.race([dispatchFetch(controller, data, { clientId }, true), gone]);
                    } finally {
                        signal.removeEventListener('abort', onAbort);
                    }
                } catch (e) {
                    if (signal.aborted)
                        throw aborted();
                    throw new TypeError('Failed to fetch');
                }
                if (res === null) {
                    // The worker did not answer it: the network, as the loader would have taken it, without a second fetch event.
                    asked.set(data.url, (asked.get(data.url) || 0) + 1);
                    return native(new P.Request(data.url, { method: data.method, headers: request.headers, body: data.body, credentials: request.credentials, mode: request.mode, redirect: request.redirect, signal }));
                }
                const nullBody = res.status === 101 || res.status === 204 || res.status === 205 || res.status === 304;
                let stream = null;
                if (res.stream && !nullBody)
                    stream = streams.mirror(res.stream, 'page', { signal });
                else if (res.stream)
                    res.stream.cancel().catch(() => undefined);
                else if (!nullBody && res.body.byteLength)
                    stream = res.body;
                const response = new P.Response(stream, { status: res.status, statusText: '', headers: new P.Headers(res.headers) });
                defineProperty(response, 'url', { value: res.url, configurable: true });
                if (res.redirected)
                    defineProperty(response, 'redirected', { value: true, configurable: true });
                if (res.type === 'basic' || res.type === 'cors')
                    defineProperty(response, 'type', { value: res.type, configurable: true });
                return response;
            }
            definePageNames = () => {
                for (const C of [ServiceWorker, ServiceWorkerRegistration, ServiceWorkerContainer, NavigationPreloadManager])
                    defineProperty(P, C.name, { value: C, writable: true, configurable: true });
                defineProperty(P, 'Worker', { value: PageWorker, writable: true, configurable: true });
                defineProperty(P, 'SharedWorker', { value: PageSharedWorker, writable: true, configurable: true });
                defineProperty(P.Navigator.prototype, 'serviceWorker', { get: () => container, configurable: true, enumerable: true });
                installFetch();
            };
            definePageNames();

            page = {
                installFrameWorker(W) {
                    defineProperty(W, 'Worker', { value: makeWorker(W), writable: true, configurable: true });
                    defineProperty(W, 'SharedWorker', { value: makeSharedWorker(W), writable: true, configurable: true });
                },
                stateChanged(v) {
                    if (v.page)
                        fire(v.page, pageEvent('statechange'));
                },
                updateFound(reg) {
                    if (reg.page)
                        fire(reg.page, pageEvent('updatefound'));
                },
                activated() { checkReady(); },
                controllerChanged() {
                    checkReady();
                    fire(container, pageEvent('controllerchange'));
                },
                deliver(v, data, ports) {
                    const m = { from: v, data, ports };
                    // The client message queue: enabled by startMessages(), onmessage, or soon after the document loaded.
                    if (messagesStarted)
                        deliverNow(m);
                    else
                        queued.push(m);
                },
            };
            // Chrome enables the queue when the document finished parsing; the segment's document is past that by the time
            // a worker can answer it, so the queue opens on the next turn.
            hostSetTimeout(() => container.startMessages(), 0);
            checkReady();
            return container;
        }

        return {
            clientId,
            restore,
            navigation,
            documentLoaded,
            fetchHook,
            netFetch,
            bypassFetch,
            installPage,
            installFrameWorker: (W) => { if (page) page.installFrameWorker(W); },
            documentReset: () => { frameClients.clear(); if (definePageNames) definePageNames(); },
            get controlled() { return !!controller; },
            // For tests: the state, plainly.
            debug: () => ({ documentURL, controller: versionView(controller), registrations: [...registrations.values()].map(regView) }),
        };
    }

    // A DOMException-shaped error made before the page's DOMException is known; converted when it reaches the page.
    class DOMExceptionLike extends Error {
        constructor(message, name) { super(message); this.name = name; }
    }
    void HostTextEncoder;
    G.__chitinPageSW = Object.freeze({ create });
})();
