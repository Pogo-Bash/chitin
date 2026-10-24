// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// The runner of a page's own service worker (docs/architecture.md, "Page service workers"). One dedicated Worker on the
// segment origin per version of the page's worker, with no engine. It never holds a network of its own: the page's
// script and its importScripts come through the segment's service worker from the segment's mirror of the site's
// address space (answered by the engine), its fetch() and its CacheStorage go over one MessagePort to the segment Worker.
//
// In Chrome the segment document starts it and sends { type: 'init', nonce } with the port. Under Node, a test sets
// `__chitinPageSWPlatform` on the global before this script runs (tests/pagesw-run.mjs) and no door is removed there.
'use strict';
(() => {
    const G = self;
    const HostEvent = G.Event;
    const HostRequest = G.Request;
    const HostResponse = G.Response;
    const HostHeaders = G.Headers;
    const HostURL = G.URL;
    const HostPromise = G.Promise;
    const HostDOMException = G.DOMException;
    const HostTextEncoder = G.TextEncoder;
    const HostUint8Array = G.Uint8Array;
    const hostSharedArrayBuffer = G.SharedArrayBuffer; // before a page that is not isolated loses the global
    const ReflectApply = Reflect.apply;
    const defineProperty = Object.defineProperty;
    const ObjectCreate = Object.create;
    let runnerLocks; // navigator.locks of the page's workers (made in main(), shown by the doors' navigator)
    // The blobs behind the blob: URLs this worker made itself, for a nested Worker's script: the runner's CSP lets it fetch
    // none, so the URL's Blob is read instead (URL.createObjectURL and revokeObjectURL keep the map).
    const ownBlobs = new Map();
    const HostURLClass = G.URL;
    if (HostURLClass && typeof HostURLClass.createObjectURL === 'function') {
        const create = HostURLClass.createObjectURL, revoke = HostURLClass.revokeObjectURL;
        defineProperty(HostURLClass, 'createObjectURL', { value: { createObjectURL(obj) {
            const url = ReflectApply(create, HostURLClass, [obj]);
            if (obj instanceof G.Blob)
                ownBlobs.set(url, obj);
            return url;
        } }.createObjectURL, writable: true, configurable: true, enumerable: true });
        defineProperty(HostURLClass, 'revokeObjectURL', { value: { revokeObjectURL(url) {
            ownBlobs.delete(String(url));
            return ReflectApply(revoke, HostURLClass, [url]);
        } }.revokeObjectURL, writable: true, configurable: true, enumerable: true });
    }

    // --- The platform: how this runner starts, runs scripts and talks to the segment ------------------------------
    let platform = G.__chitinPageSWPlatform;
    delete G.__chitinPageSWPlatform;
    if (!platform)
        platform = chromePlatform();

    function chromePlatform() {
        const hostImportScripts = G.importScripts.bind(G);
        const hostAddEventListener = G.addEventListener.bind(G);
        const hostRemoveEventListener = G.removeEventListener.bind(G);
        const SEGMENT_ORIGIN = G.location.origin;
        const mirror = (url) => {
            const m = /^https:\/\/([^?#]*)(\?[^#]*)?/.exec(url);
            if (!m)
                throw new TypeError('a service worker script must be https: ' + url);
            return `${SEGMENT_ORIGIN}/__chitin/o/https/${m[1]}${m[2] || ''}`;
        };
        let doors = null;
        let opfs = null;
        let opfsState = null;
        let webSocket = null;
        return {
            installOPFS: () => { if (opfs && opfs.available) opfsState = opfs.install(G, null); },
            installWebSocket: (options) => webSocket && webSocket.install(G, options),
            start: () => new HostPromise((resolve) => {
                // 'init' carries the segment's nonce and, for a runner started for a Worker, its port. A runner the segment
                // keeps ready ahead (segment.js) gets 'init' without a port, does everything below, and then waits for its
                // port in a 'port' message: the start-up that is not the Worker's own is done before the page asks.
                let port = null;
                let earlyPort = null;
                let setUp = false;
                const onPort = (event) => {
                    if (!event.isTrusted || !event.data || event.data.type !== 'port' || !event.ports[0] || port || earlyPort)
                        return;
                    hostRemoveEventListener('message', onPort);
                    earlyPort = event.ports[0];
                    if (setUp)
                        resolve(earlyPort);
                };
                const onInit = async (event) => {
                    const data = event.data;
                    if (!event.isTrusted || !data || data.type !== 'init')
                        return;
                    hostRemoveEventListener('message', onInit);
                    port = event.ports[0] || null;
                    if (!port)
                        hostAddEventListener('message', onPort);
                    // Before its port arrives, a failure is told to the segment document that started the runner.
                    const selfPost = G.postMessage.bind(G); // (the doors take the global's postMessage)
                    const fatal = (error) => (port ? port.postMessage({ t: 'fatal', error }) : selfPost({ t: 'fatal', error }));
                    // Fail closed: no site code until the segment's service worker is shown to control this Worker (the
                    // probe is answered by it alone); it then knows this client as a runner (no staging wait, the
                    // engine's raw network for its requests so the page's worker never sees its own importScripts).
                    let controlled = false;
                    try {
                        const hello = await import(`/__chitin/hello.mjs?nonce=${encodeURIComponent(data.nonce)}&role=pagesw&probe=${Date.now()}`);
                        controlled = hello.controlled === true;
                    } catch {
                        controlled = false;
                    }
                    if (!controlled) {
                        fatal('the segment\'s service worker does not control the runner: no site code runs');
                        G.close();
                        return;
                    }
                    // OPFS (harness/segment/opfs.js) captures the host's file system objects before the doors take them.
                    hostImportScripts('/chitin/opfs.js');
                    const opfsApi = G.__chitinOPFS;
                    delete G.__chitinOPFS;
                    opfs = opfsApi.create({ sync: false });
                    // WebSocket (harness/segment/websocket.js) captures what it needs of the host before the doors go; the host's
                    // own WebSocket is a door. Its transport is the port to the segment Worker (the engine's network).
                    hostImportScripts('/chitin/websocket.js');
                    webSocket = G.__chitinWebSocket.create();
                    delete G.__chitinWebSocket;
                    hostImportScripts('/chitin/doors.js');
                    doors = G.__chitinDoors;
                    delete G.__chitinDoors;
                    const problem = doors.removeHostDoors(G, [], { storage: () => (opfsState ? opfsState.storage : undefined), locks: () => runnerLocks });
                    if (problem) {
                        fatal(problem);
                        return;
                    }
                    setUp = true;
                    if (port)
                        resolve(port);
                    else if (earlyPort)
                        resolve(earlyPort);
                };
                hostAddEventListener('message', onInit);
            }),
            runClassic: (url) => hostImportScripts(mirror(url)),
            runModule: (url) => import(mirror(url)),
            importScripts: (urls) => hostImportScripts(...urls.map(mirror)),
        };
    }

    let port;
    let onPortMessage;
    function main() {
        // --- Messages to and from the segment Worker -------------------------------------------------------------------
        let nextId = 1;
        const waiting = new Map();
        function ask(message, transfer) {
            const id = nextId++;
            message.id = id;
            return new HostPromise((resolve, reject) => {
                waiting.set(id, { resolve, reject });
                port.postMessage(message, transfer || []);
            });
        }
        const send = (message, transfer) => port.postMessage(message, transfer || []);

        // --- BroadcastChannel (the host's is a door: it would reach the segment origin's other contexts unmediated) --------
        // Same-site contexts by name, as in Chrome: a post goes to this runner's other channels of the name here, and through
        // the segment Worker to its page (the engine's BroadcastChannel) and the site's other runners (pagesw-host.js 'bc').
        // Data is cloned once at the post, as the spec's StructuredSerialize; a closed channel neither sends nor gets.
        const HostBCEventTarget = G.EventTarget;
        const HostBCMessageEvent = G.MessageEvent;
        const hostClone = G.structuredClone;
        const channels = new Map(); // name -> Set of open channels
        const bcHandlers = new WeakMap();
        function deliverBroadcast(name, data, except) {
            const set = channels.get(name);
            if (!set)
                return;
            const origin = scriptURL ? new HostURL(scriptURL).origin : '';
            for (const c of [...set]) {
                if (c === except)
                    continue;
                let copy;
                try {
                    copy = hostClone(data);
                } catch {
                    c.dispatchEvent(new HostBCMessageEvent('messageerror', { origin }));
                    continue;
                }
                c.dispatchEvent(new HostBCMessageEvent('message', { data: copy, origin }));
            }
        }
        if (typeof HostBCEventTarget === 'function' && typeof HostBCMessageEvent === 'function') {
            class BroadcastChannel extends HostBCEventTarget {
                #name;
                #closed = false;
                constructor(name) {
                    if (new.target === undefined)
                        throw new TypeError("Failed to construct 'BroadcastChannel': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
                    if (arguments.length < 1)
                        throw new TypeError("Failed to construct 'BroadcastChannel': 1 argument required, but only 0 present.");
                    super();
                    this.#name = String(name);
                    let set = channels.get(this.#name);
                    if (!set) {
                        channels.set(this.#name, set = new Set());
                        send({ t: 'bc-sub', name: this.#name });
                    }
                    set.add(this);
                }
                get name() { return this.#name; }
                postMessage(message) {
                    if (arguments.length < 1)
                        throw new TypeError("Failed to execute 'postMessage' on 'BroadcastChannel': 1 argument required, but only 0 present.");
                    if (this.#closed)
                        throw new HostDOMException("Failed to execute 'postMessage' on 'BroadcastChannel': Channel is closed", 'InvalidStateError');
                    const data = hostClone(message); // DataCloneError here, as in Chrome
                    // Delivered in a later task, as the spec queues it.
                    HostPromise.resolve().then(() => deliverBroadcast(this.#name, data, this));
                    send({ t: 'bc-post', name: this.#name, data });
                }
                close() {
                    if (this.#closed)
                        return;
                    this.#closed = true;
                    const set = channels.get(this.#name);
                    if (set) {
                        set.delete(this);
                        if (!set.size) {
                            channels.delete(this.#name);
                            send({ t: 'bc-unsub', name: this.#name });
                        }
                    }
                }
            }
            for (const type of ['message', 'messageerror'])
                defineProperty(BroadcastChannel.prototype, 'on' + type, {
                    get() { const h = bcHandlers.get(this); return (h && h[type]) || null; },
                    set(fn) {
                        let h = bcHandlers.get(this);
                        if (!h)
                            bcHandlers.set(this, h = {});
                        if (h['w' + type])
                            this.removeEventListener(type, h['w' + type]);
                        h[type] = typeof fn === 'function' ? fn : null;
                        h['w' + type] = h[type] ? (ev) => ReflectApply(h[type], this, [ev]) : null;
                        if (h['w' + type])
                            this.addEventListener(type, h['w' + type]);
                    },
                    enumerable: true, configurable: true,
                });
            defineProperty(BroadcastChannel.prototype, Symbol.toStringTag, { value: 'BroadcastChannel', configurable: true });
            defineProperty(G, 'BroadcastChannel', { value: BroadcastChannel, writable: true, configurable: true });
        }

        // --- Events, dispatched by this script (the global of a Worker under Node is no EventTarget) --------------------
        const SW_EVENTS = ['install', 'activate', 'fetch', 'message', 'messageerror', 'connect'];
        const listeners = new Map(SW_EVENTS.map((t) => [t, []]));
        const handlers = new Map();
        const nativeAdd = G.addEventListener ? G.addEventListener.bind(G) : null;
        const nativeRemove = G.removeEventListener ? G.removeEventListener.bind(G) : null;
        let evaluating = true;
        let lateFetchListener = false;
        defineProperty(G, 'addEventListener', {
            value: function addEventListener(type, fn, options) {
                if (listeners.has(type)) {
                    if (fn && !listeners.get(type).includes(fn))
                        listeners.get(type).push(fn);
                    if (type === 'fetch' && !evaluating)
                        lateFetchListener = true;
                    return;
                }
                if (nativeAdd)
                    nativeAdd(type, fn, options);
            }, writable: true, configurable: true,
        });
        defineProperty(G, 'removeEventListener', {
            value: function removeEventListener(type, fn, options) {
                if (listeners.has(type)) {
                    const list = listeners.get(type);
                    const at = list.indexOf(fn);
                    if (at >= 0)
                        list.splice(at, 1);
                    return;
                }
                if (nativeRemove)
                    nativeRemove(type, fn, options);
            }, writable: true, configurable: true,
        });
        for (const type of SW_EVENTS)
            defineProperty(G, 'on' + type, {
                get: () => handlers.get(type) || null,
                set: (fn) => { handlers.set(type, typeof fn === 'function' ? fn : null); if (type === 'fetch' && !evaluating) lateFetchListener = true; },
                configurable: true, enumerable: true,
            });
        function reportError(e) {
            if (dedicated) {
                reportUncaught(e, scriptURL);
                return;
            }
            send({ t: 'log', text: 'service worker error: ' + String(e && e.stack || e) });
        }
        function dispatch(event) {
            const type = event.type;
            defineProperty(event, 'target', { value: G, configurable: true });
            defineProperty(event, 'currentTarget', { value: G, configurable: true });
            defineProperty(event, 'srcElement', { value: G, configurable: true });
            const all = [...listeners.get(type)];
            if (handlers.get(type))
                all.push(handlers.get(type));
            for (const fn of all) {
                try {
                    if (typeof fn === 'function')
                        ReflectApply(fn, G, [event]);
                    else if (fn && typeof fn.handleEvent === 'function')
                        fn.handleEvent(event);
                } catch (e) {
                    reportError(e);
                }
                if (event.__stopped)
                    break;
            }
        }
        const hasFetchListener = () => listeners.get('fetch').length > 0 || !!handlers.get('fetch');

        class ExtendableEvent extends HostEvent {
            #promises = [];
            #active = true;
            waitUntil(promise) {
                if (!this.#active)
                    throw new HostDOMException('waitUntil() after the event finished', 'InvalidStateError');
                this.#promises.push(HostPromise.resolve(promise));
            }
            stopImmediatePropagation() { this.__stopped = true; super.stopImmediatePropagation(); }
            // Settles when every promise passed to waitUntil (including ones added while waiting) has settled.
            async __settle() {
                let seen = 0;
                let failed = null;
                while (seen < this.#promises.length) {
                    const batch = this.#promises.slice(seen);
                    seen = this.#promises.length;
                    const results = await HostPromise.allSettled(batch);
                    for (const r of results)
                        if (r.status === 'rejected' && !failed)
                            failed = r.reason;
                }
                this.#active = false;
                if (failed)
                    throw failed;
            }
        }
        class ExtendableMessageEvent extends ExtendableEvent {
            constructor(type, init = {}) {
                super(type, init);
                defineProperty(this, 'data', { value: init.data, enumerable: true });
                defineProperty(this, 'origin', { value: init.origin || '', enumerable: true });
                defineProperty(this, 'lastEventId', { value: init.lastEventId || '', enumerable: true });
                defineProperty(this, 'source', { value: init.source || null, enumerable: true });
                defineProperty(this, 'ports', { value: Object.freeze([...(init.ports || [])]), enumerable: true });
            }
        }
        class FetchEvent extends ExtendableEvent {
            #response = null;
            #dispatching = true;
            constructor(type, init = {}) {
                super(type, init);
                defineProperty(this, 'request', { value: init.request, enumerable: true });
                defineProperty(this, 'clientId', { value: init.clientId || '', enumerable: true });
                defineProperty(this, 'resultingClientId', { value: init.resultingClientId || '', enumerable: true });
                defineProperty(this, 'replacesClientId', { value: '', enumerable: true });
                defineProperty(this, 'preloadResponse', { value: HostPromise.resolve(undefined), enumerable: true });
                defineProperty(this, 'handled', { value: init.handled || HostPromise.resolve(undefined), enumerable: true });
            }
            respondWith(r) {
                if (!this.#dispatching)
                    throw new HostDOMException('respondWith() must be called while the fetch event is dispatched', 'InvalidStateError');
                if (this.#response)
                    throw new HostDOMException('respondWith() was already called', 'InvalidStateError');
                this.#response = HostPromise.resolve(r);
                this.waitUntil(this.#response);
            }
            __done() { this.#dispatching = false; return this.#response; }
        }
        for (const C of [ExtendableEvent, ExtendableMessageEvent, FetchEvent])
            defineProperty(G, C.name, { value: C, writable: true, configurable: true });

        // --- Requests and responses across the port --------------------------------------------------------------------
        const opaqueBodies = new WeakMap(); // an opaque Response -> the bytes behind it (never readable by the worker)
        function makeResponse(r) {
            if (r.type === 'error')
                return HostResponse.error();
            if (r.type === 'opaque' || r.type === 'opaqueredirect') {
                const response = new HostResponse(null, { status: 200 });
                opaqueBodies.set(response, { status: r.status, statusText: r.statusText || '', headers: r.headers, body: r.body, url: r.url });
                defineProperty(response, 'type', { value: r.type });
                defineProperty(response, 'status', { value: 0 });
                defineProperty(response, 'ok', { value: false });
                defineProperty(response, 'statusText', { value: '' });
                defineProperty(response, 'url', { value: '' });
                defineProperty(response, 'headers', { value: new HostHeaders() });
                defineProperty(response, 'clone', { value: () => makeResponse(r) });
                return response;
            }
            const nullBody = r.status === 101 || r.status === 204 || r.status === 205 || r.status === 304;
            const response = new HostResponse(nullBody ? null : r.body, { status: r.status, statusText: r.statusText || '', headers: r.headers });
            if (r.url)
                defineProperty(response, 'url', { value: r.url });
            if (r.redirected)
                defineProperty(response, 'redirected', { value: true });
            if (r.type && r.type !== 'default') {
                defineProperty(response, 'type', { value: r.type });
                const base = response.clone.bind(response);
                defineProperty(response, 'clone', { value: () => { const c = base(); defineProperty(c, 'type', { value: r.type }); if (r.url) defineProperty(c, 'url', { value: r.url }); return c; } });
            }
            return response;
        }
        // A Response as data: { type, status, statusText, headers, body: ArrayBuffer, url, redirected }. Consumes the body.
        // `streaming` true (a fetch event's answer): the body is not read here but handed over as it is, a ReadableStream the
        // segment Worker reads as chunks arrive; `transfer` then lists it.
        async function responseData(response, streaming, transfer) {
            if (!(response instanceof HostResponse))
                throw new TypeError('respondWith() needs a Response');
            const opaque = opaqueBodies.get(response);
            if (opaque)
                return { type: response.type, status: opaque.status, statusText: opaque.statusText, headers: opaque.headers, body: opaque.body, url: opaque.url };
            if (response.type === 'error')
                return { type: 'error' };
            if (response.bodyUsed)
                throw new TypeError('the Response body was already used');
            if (streaming) {
                const own = response.body;
                if (own && own.locked)
                    throw new TypeError('the Response body is locked');
                if (own)
                    transfer.push(own);
                return { type: response.type === 'basic' || response.type === 'cors' ? response.type : 'default', status: response.status, statusText: response.statusText, headers: [...response.headers], body: null, stream: own || null, url: response.url, redirected: response.redirected };
            }
            let body;
            body = await response.arrayBuffer();
            return { type: response.type === 'basic' || response.type === 'cors' ? response.type : 'default', status: response.status, statusText: response.statusText, headers: [...response.headers], body, url: response.url, redirected: response.redirected };
        }
        function makeRequest(r) {
            const init = { method: r.method, headers: r.headers, credentials: r.credentials === 'include' ? 'include' : r.credentials === 'omit' ? 'omit' : 'same-origin', redirect: r.redirect || 'follow' };
            if (r.method !== 'GET' && r.method !== 'HEAD' && r.body && r.body.byteLength)
                init.body = r.body;
            const request = new HostRequest(r.url, init);
            // What a Request constructor cannot be given (mode navigate, the destination) is what the engine said.
            defineProperty(request, 'mode', { value: r.mode || 'no-cors' });
            defineProperty(request, 'destination', { value: r.destination || '' });
            defineProperty(request, 'isReloadNavigation', { value: false });
            defineProperty(request, 'isHistoryNavigation', { value: false });
            return request;
        }
        async function requestData(request) {
            const own = (n, fallback) => Object.prototype.hasOwnProperty.call(request, n) ? request[n] : fallback;
            let body = null;
            if (request.method !== 'GET' && request.method !== 'HEAD')
                body = await request.clone().arrayBuffer();
            return { url: request.url, method: request.method, headers: [...request.headers], body, mode: own('mode', request.mode), credentials: request.credentials, redirect: request.redirect, destination: own('destination', request.destination || '') };
        }

        // fetch() from the page's worker: over the port to the segment Worker, which uses the engine's network.
        async function swFetch(input, init) {
            const request = input instanceof HostRequest && init === undefined ? input : new Request(input, init);
            const data = await requestData(request);
            if (init && init.mode)
                data.mode = init.mode;
            if (data.mode === 'navigate')
                data.mode = 'same-origin';
            const reply = await ask({ t: 'net', request: data });
            if (reply.error)
                throw new TypeError('Failed to fetch: ' + reply.error);
            return makeResponse(reply.response);
        }
        // Relative URLs resolve against the worker's script URL (the site's), not the runner's real location (the
        // segment origin): the Request the worker constructs is this subclass.
        const resolveInput = (input) => (input instanceof HostRequest ? input : new HostURL(String(input), scriptURL).href);
        class Request extends HostRequest {
            constructor(input, init) { super(resolveInput(input), init); }
        }
        defineProperty(G, 'Request', { value: Request, writable: true, configurable: true });
        defineProperty(G, 'fetch', { value: function fetch(input, init) { return swFetch(input, init); }, writable: true, configurable: true });

        // --- CacheStorage, persisted by the segment ---------------------------------------------------------------------
        const storeGet = (key) => ask({ t: 'store', op: 'get', key }).then((r) => r.value);
        const storePut = (key, value) => ask({ t: 'store', op: 'put', key, value });
        const storeDelete = (key) => ask({ t: 'store', op: 'delete', key });
        let cacheNames = null;
        const cacheEntries = new Map(); // name -> entries [{ url, method, reqHeaders, response }]
        async function names() {
            if (!cacheNames)
                cacheNames = (await storeGet('caches')) || [];
            return cacheNames;
        }
        async function entriesOf(name) {
            if (!cacheEntries.has(name))
                cacheEntries.set(name, (await storeGet('cache:' + name)) || []);
            return cacheEntries.get(name);
        }
        // A cache's list ('cache:<name>') holds each entry without its body; each body is a record of its own
        // ('cachebody:<name>:<id>'), written once when the entry is put. Saving the whole list with its bodies on every put
        // was quadratic and made records of hundreds of MB (anura.pro caches 251 chunks), which Chrome refused to store
        // ("Internal error opening database"), losing the registrations and localStorage that share the database.
        // Lists written before that keep their bodies inline and still read.
        let bodySeq = 0;
        const bodyKey = (name, id) => 'cachebody:' + name + ':' + id;
        const saveEntries = (name) => storePut('cache:' + name, cacheEntries.get(name).map(({ response, ...rest }) => {
            const { body, ...meta } = response;
            return { ...rest, response: meta.bodyId !== undefined || body === undefined ? meta : response };
        }));
        async function dropBodies(name, entries) {
            for (const e of entries)
                if (e.response && e.response.bodyId !== undefined)
                    await storeDelete(bodyKey(name, e.response.bodyId));
        }
        async function bodyOf(name, entry) {
            const r = entry.response;
            if (r.body !== undefined || r.bodyId === undefined)
                return r;
            const body = await storeGet(bodyKey(name, r.bodyId));
            return { ...r, body: body === undefined ? null : body };
        }
        const urlKey = (u, ignoreSearch) => { const x = new HostURL(u); x.hash = ''; if (ignoreSearch) x.search = ''; return x.href; };
        function requestOf(input) {
            if (input instanceof HostRequest)
                return input;
            return new HostRequest(new HostURL(String(input), scriptURL).href);
        }
        function matches(entry, request, options = {}) {
            if (!options.ignoreMethod && request.method !== 'GET' && request.method !== 'HEAD')
                return false;
            if (urlKey(entry.url, options.ignoreSearch) !== urlKey(request.url, options.ignoreSearch))
                return false;
            if (options.ignoreVary)
                return true;
            const vary = (entry.response.headers.find(([n]) => n.toLowerCase() === 'vary') || [])[1];
            if (!vary)
                return true;
            for (const field of vary.split(',').map((f) => f.trim().toLowerCase())) {
                if (field === '*')
                    return false;
                const stored = (entry.reqHeaders.find(([n]) => n.toLowerCase() === field) || [])[1] || null;
                if (stored !== request.headers.get(field))
                    return false;
            }
            return true;
        }
        class Cache {
            #name;
            constructor(name) { this.#name = name; }
            async match(input, options) { return (await this.matchAll(input, options))[0]; }
            async matchAll(input, options) {
                const entries = await entriesOf(this.#name);
                const list = input === undefined ? entries : entries.filter((e) => matches(e, requestOf(input), options));
                return HostPromise.all(list.map(async (e) => makeResponse(await bodyOf(this.#name, e))));
            }
            async add(input) { return this.addAll([input]); }
            async addAll(inputs) {
                const requests = inputs.map(requestOf);
                const responses = await HostPromise.all(requests.map((r) => swFetch(r)));
                for (const response of responses)
                    if (!response.ok)
                        throw new TypeError('Cache.addAll: a response was not ok (' + response.status + ' ' + response.url + ')');
                for (let i = 0; i < requests.length; i++)
                    await this.put(requests[i], responses[i]);
            }
            async put(input, response) {
                const request = requestOf(input);
                if (request.method !== 'GET')
                    throw new TypeError('Cache.put: only GET requests can be cached');
                if (!/^https?:$/.test(new HostURL(request.url).protocol))
                    throw new TypeError('Cache.put: only http(s) requests can be cached');
                if (response.status === 206)
                    throw new TypeError('Cache.put: a partial response cannot be cached');
                const vary = response.headers.get('vary');
                if (vary && vary.split(',').some((f) => f.trim() === '*'))
                    throw new TypeError('Cache.put: Vary: * cannot be cached');
                const data = await responseData(response);
                if (!data.url)
                    data.url = request.url;
                const entries = await entriesOf(this.#name);
                const id = Date.now().toString(36) + '-' + (++bodySeq);
                const { body, ...meta } = data;
                await storePut(bodyKey(this.#name, id), body === undefined ? null : body);
                const entry = { url: urlKey(request.url), method: 'GET', reqHeaders: [...request.headers], response: { ...meta, bodyId: id } };
                const replaced = [];
                for (let i = entries.length - 1; i >= 0; i--)
                    if (matches(entries[i], request, { ignoreVary: false }))
                        replaced.push(...entries.splice(i, 1));
                entries.push(entry);
                await saveEntries(this.#name);
                await dropBodies(this.#name, replaced);
            }
            async delete(input, options) {
                const entries = await entriesOf(this.#name);
                const request = requestOf(input);
                const removed = [];
                for (let i = entries.length - 1; i >= 0; i--)
                    if (matches(entries[i], request, options))
                        removed.push(...entries.splice(i, 1));
                if (!removed.length)
                    return false;
                await saveEntries(this.#name);
                await dropBodies(this.#name, removed);
                return true;
            }
            async keys(input, options) {
                const entries = await entriesOf(this.#name);
                const list = input === undefined ? entries : entries.filter((e) => matches(e, requestOf(input), options));
                return list.map((e) => new HostRequest(e.url, { headers: e.reqHeaders }));
            }
        }
        class CacheStorage {
            async open(name) {
                name = String(name);
                const list = await names();
                if (!list.includes(name)) {
                    list.push(name);
                    cacheEntries.set(name, []);
                    await storePut('caches', list);
                    await saveEntries(name);
                }
                return new Cache(name);
            }
            async has(name) { return (await names()).includes(String(name)); }
            async delete(name) {
                name = String(name);
                const list = await names();
                const at = list.indexOf(name);
                if (at < 0)
                    return false;
                list.splice(at, 1);
                const gone = await entriesOf(name);
                cacheEntries.delete(name);
                await storePut('caches', list);
                await storeDelete('cache:' + name);
                await dropBodies(name, gone);
                return true;
            }
            async keys() { return [...(await names())]; }
            async match(input, options = {}) {
                for (const name of options.cacheName !== undefined ? [String(options.cacheName)] : await names()) {
                    if (!(await names()).includes(name))
                        continue;
                    const r = await new Cache(name).match(input, options);
                    if (r)
                        return r;
                }
                return undefined;
            }
        }
        defineProperty(G, 'Cache', { value: Cache, writable: true, configurable: true });
        defineProperty(G, 'CacheStorage', { value: CacheStorage, writable: true, configurable: true });
        const caches = new CacheStorage();
        defineProperty(G, 'caches', { get: () => caches, configurable: true, enumerable: true });
        // --- IndexedDB: the page's databases (harness/segment/pagesw-host.js, idbServer) --------------------------------------
        // The objects are this worker's; every request runs on the engine's IDBFactory of the segment, so the page and its
        // workers see one origin's databases, as in Chrome. Synchronous parts (scopes, names, key paths, schema checks) are
        // answered here from the metadata the segment sends; results and errors arrive as events, in request order.
        const idb = (() => {
            const HostEventTarget = G.EventTarget, HostEventClass = G.Event;
            const setT = G.setTimeout.bind(G);
            const token = Symbol('idb');
            const illegal = () => { throw new TypeError('Illegal constructor'); };
            const dom = (message, name) => new HostDOMException(message, name);
            const idbSend = (m) => send({ t: 'idb', ...m });
            let nextId = 1;
            const requests = new Map(); // rid -> IDBRequest
            const txs = new Map();      // id -> IDBTransaction
            const dbs = new Map();      // id -> IDBDatabase
            const slots = new WeakMap(); // object -> internal state
            const S = (o) => { const s = slots.get(o); if (!s) throw new TypeError('Illegal invocation'); return s; };
            function handlers(proto, names) {
                for (const name of names) {
                    const key = 'on' + name;
                    defineProperty(proto, key, {
                        get() { const s = S(this); return (s.h && s.h[name]) || null; },
                        set(fn) {
                            const s = S(this);
                            s.h = s.h || {};
                            if (s.hw && s.hw[name])
                                this.removeEventListener(name, s.hw[name]);
                            s.h[name] = typeof fn === 'function' ? fn : null;
                            if (s.h[name]) {
                                s.hw = s.hw || {};
                                const f = s.h[name];
                                s.hw[name] = function (e) { return ReflectApply(f, this, [e]); };
                                this.addEventListener(name, s.hw[name]);
                            }
                        },
                        enumerable: true, configurable: true,
                    });
                }
            }
            const getters = (proto, map) => { for (const k of Object.keys(map)) defineProperty(proto, k, { get() { return map[k](S(this), this); }, enumerable: true, configurable: true }); };

            // Keys: compared as the spec says (number < date < string < binary < array).
            const keyType = (k) => typeof k === 'number' ? 1 : k instanceof Date ? 2 : typeof k === 'string' ? 3 : (k instanceof ArrayBuffer || ArrayBuffer.isView(k)) ? 4 : Array.isArray(k) ? 5 : 0;
            function validKey(k, seen) {
                const t = keyType(k);
                if (t === 1) return !Number.isNaN(k);
                if (t === 2) return !Number.isNaN(+k);
                if (t === 3 || t === 4) return true;
                if (t === 5) {
                    seen = seen || new Set();
                    if (seen.has(k)) return false;
                    seen.add(k);
                    for (let i = 0; i < k.length; i++) if (!(i in k) || !validKey(k[i], seen)) return false;
                    return true;
                }
                return false;
            }
            const bytes = (k) => k instanceof ArrayBuffer ? new HostUint8Array(k) : new HostUint8Array(k.buffer, k.byteOffset, k.byteLength);
            function cmp(a, b) {
                const ta = keyType(a), tb = keyType(b);
                if (ta !== tb) return ta < tb ? -1 : 1;
                if (ta === 1 || ta === 2) { const x = +a, y = +b; return x < y ? -1 : x > y ? 1 : 0; }
                if (ta === 3) return a < b ? -1 : a > b ? 1 : 0;
                if (ta === 4) { const x = bytes(a), y = bytes(b); for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return x.length === y.length ? 0 : x.length < y.length ? -1 : 1; }
                for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = cmp(a[i], b[i]); if (c) return c; }
                return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
            }
            const checkKey = (k, what) => { if (!validKey(k)) throw dom(`Failed to execute '${what}': The parameter is not a valid key.`, 'DataError'); return k; };

            class IDBKeyRange {
                constructor() { illegal(); }
                static only(v) { checkKey(v, "only' on 'IDBKeyRange"); return makeRange(v, v, false, false); }
                static lowerBound(v, open = false) { checkKey(v, "lowerBound' on 'IDBKeyRange"); return makeRange(v, undefined, !!open, true); }
                static upperBound(v, open = false) { checkKey(v, "upperBound' on 'IDBKeyRange"); return makeRange(undefined, v, true, !!open); }
                static bound(lo, up, lop = false, uop = false) {
                    checkKey(lo, "bound' on 'IDBKeyRange"); checkKey(up, "bound' on 'IDBKeyRange");
                    const c = cmp(lo, up);
                    if (c > 0 || (c === 0 && (lop || uop)))
                        throw dom("Failed to execute 'bound' on 'IDBKeyRange': The lower key is greater than the upper key.", 'DataError');
                    return makeRange(lo, up, !!lop, !!uop);
                }
                includes(k) {
                    const s = S(this);
                    checkKey(k, "includes' on 'IDBKeyRange");
                    if (s.lower !== undefined) { const c = cmp(s.lower, k); if (c > 0 || (c === 0 && s.lowerOpen)) return false; }
                    if (s.upper !== undefined) { const c = cmp(s.upper, k); if (c < 0 || (c === 0 && s.upperOpen)) return false; }
                    return true;
                }
            }
            function makeRange(lower, upper, lowerOpen, upperOpen) {
                const r = ObjectCreate(IDBKeyRange.prototype);
                slots.set(r, { lower, upper, lowerOpen, upperOpen });
                return r;
            }
            getters(IDBKeyRange.prototype, { lower: (s) => s.lower, upper: (s) => s.upper, lowerOpen: (s) => s.lowerOpen, upperOpen: (s) => s.upperOpen });
            const wireArg = (a) => (a !== null && typeof a === 'object' && slots.has(a) && slots.get(a).lowerOpen !== undefined
                ? { __kr: [slots.get(a).lower, slots.get(a).upper, slots.get(a).lowerOpen, slots.get(a).upperOpen] } : a);

            class DOMStringList {
                constructor() { illegal(); }
                get length() { return S(this).items.length; }
                item(i) { const v = S(this).items[i >>> 0]; return v === undefined ? null : v; }
                contains(s) { return S(this).items.includes(String(s)); }
                [Symbol.iterator]() { return S(this).items.values(); }
            }
            const stringList = (items) => {
                const l = ObjectCreate(DOMStringList.prototype);
                const sorted = [...items].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
                slots.set(l, { items: sorted });
                sorted.forEach((v, i) => defineProperty(l, i, { value: v, enumerable: true }));
                return l;
            };

            class IDBVersionChangeEvent extends HostEventClass {
                constructor(type, init = {}) { super(type, init); slots.set(this, { oldVersion: +init.oldVersion || 0, newVersion: init.newVersion === undefined ? null : init.newVersion }); }
                get oldVersion() { return S(this).oldVersion; }
                get newVersion() { return S(this).newVersion; }
            }

            class IDBRequest extends HostEventTarget {
                constructor(t) { if (t !== token) illegal(); super(); }
            }
            getters(IDBRequest.prototype, {
                result: (s) => { if (s.readyState !== 'done') throw dom("Failed to read the 'result' property from 'IDBRequest': The request has not finished.", 'InvalidStateError'); return s.result; },
                error: (s) => { if (s.readyState !== 'done') throw dom("Failed to read the 'error' property from 'IDBRequest': The request has not finished.", 'InvalidStateError'); return s.error; },
                source: (s) => s.source, transaction: (s) => s.transaction, readyState: (s) => s.readyState,
            });
            handlers(IDBRequest.prototype, ['success', 'error']);
            class IDBOpenDBRequest extends IDBRequest {}
            handlers(IDBOpenDBRequest.prototype, ['blocked', 'upgradeneeded']);
            function newRequest(Cls, source, transaction) {
                const r = new Cls(token);
                const rid = nextId++;
                slots.set(r, { rid, source, transaction, readyState: 'pending', result: undefined, error: null });
                requests.set(rid, r);
                return r;
            }

            // Dispatch with the transaction active, then (after the callbacks' microtasks) inactive and the segment told.
            function dispatch(target, event, tx, bubble) {
                let stopped = false;
                if (bubble) {
                    const stop = event.stopPropagation;
                    defineProperty(event, 'stopPropagation', { value: function stopPropagation() { stopped = true; return ReflectApply(stop, this, []); }, configurable: true });
                }
                const ts = tx ? S(tx) : null;
                if (ts)
                    ts.active = true;
                target.dispatchEvent(event);
                if (bubble && !stopped && ts) {
                    tx.dispatchEvent(event);
                    if (!stopped)
                        ts.db.dispatchEvent(event);
                }
                if (ts)
                    setT(() => deactivate(tx), 0);
            }
            function deactivate(tx) {
                const s = S(tx);
                s.active = false;
                if (!s.finished)
                    idbSend({ op: 'idle', tx: s.id });
            }

            class IDBFactory {
                constructor() { illegal(); }
                open(name, version) {
                    if (arguments.length < 1)
                        throw new TypeError("Failed to execute 'open' on 'IDBFactory': 1 argument required, but only 0 present.");
                    if (version !== undefined) {
                        version = Number(version);
                        if (!Number.isFinite(version) || version < 1 || version > Number.MAX_SAFE_INTEGER)
                            throw new TypeError(`Failed to execute 'open' on 'IDBFactory': Value is outside the 'unsigned long long' value range.`);
                        version = Math.floor(version);
                    }
                    const r = newRequest(IDBOpenDBRequest, null, null);
                    const s = S(r);
                    s.db = nextId++;
                    s.tx = nextId++;
                    s.name = String(name);
                    idbSend({ op: 'open', rid: s.rid, db: s.db, tx: s.tx, name: s.name, version });
                    return r;
                }
                deleteDatabase(name) {
                    const r = newRequest(IDBOpenDBRequest, null, null);
                    idbSend({ op: 'delete', rid: S(r).rid, name: String(name) });
                    return r;
                }
                databases() {
                    return new HostPromise((resolve, reject) => {
                        const r = newRequest(IDBRequest, null, null);
                        S(r).promise = { resolve, reject };
                        idbSend({ op: 'databases', rid: S(r).rid });
                    });
                }
                cmp(a, b) {
                    checkKey(a, "cmp' on 'IDBFactory");
                    checkKey(b, "cmp' on 'IDBFactory");
                    return cmp(a, b);
                }
            }

            class IDBDatabase extends HostEventTarget {
                constructor(t) { if (t !== token) illegal(); super(); }
                transaction(stores, mode = 'readonly', options = {}) {
                    const s = S(this);
                    if (s.closed)
                        throw dom("Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.", 'InvalidStateError');
                    if (s.upgrading)
                        throw dom("Failed to execute 'transaction' on 'IDBDatabase': A version change transaction is running.", 'InvalidStateError');
                    const names = typeof stores === 'string' ? [stores] : Array.from(stores, String);
                    if (names.length === 0)
                        throw dom("Failed to execute 'transaction' on 'IDBDatabase': The transaction scope cannot be empty.", 'InvalidAccessError');
                    for (const n of names)
                        if (!s.meta.stores.some((x) => x.name === n))
                            throw dom("Failed to execute 'transaction' on 'IDBDatabase': One of the specified object stores was not found.", 'NotFoundError');
                    if (mode !== 'readonly' && mode !== 'readwrite')
                        throw new TypeError(`Failed to execute 'transaction' on 'IDBDatabase': The provided value '${mode}' is not a valid enum value of type IDBTransactionMode.`);
                    const tx = newTx(this, [...new Set(names)], mode, options && options.durability || 'default');
                    idbSend({ op: 'tx', db: s.id, tx: S(tx).id, stores: S(tx).scope, mode, durability: options && options.durability });
                    return tx;
                }
                close() {
                    const s = S(this);
                    if (!s.closed) {
                        s.closed = true;
                        idbSend({ op: 'close', db: s.id });
                    }
                }
                createObjectStore(name, options = {}) {
                    const s = S(this), tx = s.upgrading;
                    if (!tx)
                        throw dom("Failed to execute 'createObjectStore' on 'IDBDatabase': The database is not running a version change transaction.", 'InvalidStateError');
                    if (!S(tx).active)
                        throw dom("Failed to execute 'createObjectStore' on 'IDBDatabase': The transaction is not active.", 'TransactionInactiveError');
                    name = String(name);
                    if (s.meta.stores.some((x) => x.name === name))
                        throw dom("Failed to execute 'createObjectStore' on 'IDBDatabase': An object store with the specified name already exists.", 'ConstraintError');
                    const keyPath = options && options.keyPath !== undefined ? options.keyPath : null;
                    const autoIncrement = !!(options && options.autoIncrement);
                    if (autoIncrement && (keyPath === '' || Array.isArray(keyPath)))
                        throw dom("Failed to execute 'createObjectStore' on 'IDBDatabase': The autoIncrement option was set but the keyPath option was empty or an array.", 'InvalidAccessError');
                    const meta = { name, keyPath, autoIncrement, indexes: [] };
                    s.meta.stores.push(meta);
                    S(tx).scope.push(name);
                    idbSend({ op: 'schema', tx: S(tx).id, db: s.id, action: 'createObjectStore', name, options: { keyPath: keyPath === null ? undefined : keyPath, autoIncrement } });
                    return storeOf(tx, name);
                }
                deleteObjectStore(name) {
                    const s = S(this), tx = s.upgrading;
                    if (!tx)
                        throw dom("Failed to execute 'deleteObjectStore' on 'IDBDatabase': The database is not running a version change transaction.", 'InvalidStateError');
                    name = String(name);
                    const i = s.meta.stores.findIndex((x) => x.name === name);
                    if (i < 0)
                        throw dom("Failed to execute 'deleteObjectStore' on 'IDBDatabase': The specified object store was not found.", 'NotFoundError');
                    s.meta.stores.splice(i, 1);
                    S(tx).scope = S(tx).scope.filter((n) => n !== name);
                    idbSend({ op: 'schema', tx: S(tx).id, db: s.id, action: 'deleteObjectStore', name });
                }
            }
            getters(IDBDatabase.prototype, { name: (s) => s.meta.name, version: (s) => s.meta.version, objectStoreNames: (s) => stringList(s.meta.stores.map((x) => x.name)) });
            handlers(IDBDatabase.prototype, ['abort', 'close', 'error', 'versionchange']);
            function newDb(id, meta) {
                const db = new IDBDatabase(token);
                slots.set(db, { id, meta, closed: false, upgrading: null });
                dbs.set(id, db);
                return db;
            }

            class IDBTransaction extends HostEventTarget {
                constructor(t) { if (t !== token) illegal(); super(); }
                objectStore(name) {
                    const s = S(this);
                    if (s.finished)
                        throw dom("Failed to execute 'objectStore' on 'IDBTransaction': The transaction has finished.", 'InvalidStateError');
                    name = String(name);
                    if (!s.scope.includes(name))
                        throw dom("Failed to execute 'objectStore' on 'IDBTransaction': The specified object store was not found.", 'NotFoundError');
                    return storeOf(this, name);
                }
                abort() {
                    const s = S(this);
                    if (s.finished || s.aborting)
                        throw dom("Failed to execute 'abort' on 'IDBTransaction': The transaction has already been committed or aborted.", 'InvalidStateError');
                    s.aborting = true;
                    idbSend({ op: 'abort', tx: s.id });
                }
                commit() {
                    const s = S(this);
                    if (s.finished || !s.active)
                        throw dom("Failed to execute 'commit' on 'IDBTransaction': The transaction is not active.", 'InvalidStateError');
                    idbSend({ op: 'commit', tx: s.id });
                }
            }
            getters(IDBTransaction.prototype, { objectStoreNames: (s) => stringList(s.scope), mode: (s) => s.mode, durability: (s) => s.durability, db: (s) => s.db, error: (s) => s.error });
            handlers(IDBTransaction.prototype, ['abort', 'complete', 'error']);
            function newTx(db, scope, mode, durability, id) {
                const tx = new IDBTransaction(token);
                const s = { id: id || nextId++, db, scope, mode, durability, active: true, finished: false, error: null, stores: new Map() };
                slots.set(tx, s);
                txs.set(s.id, tx);
                if (!id) // an upgrade's transaction is active for its upgradeneeded event instead (dispatch)
                    setT(() => deactivate(tx), 0);
                return tx;
            }

            const metaOf = (tx, name) => S(S(tx).db).meta.stores.find((x) => x.name === name);
            function requestOn(source, tx, fields, args) {
                const ts = S(tx);
                if (ts.finished || !ts.active)
                    throw dom(`Failed to execute '${fields.method}' on '${source instanceof IDBIndex ? 'IDBIndex' : 'IDBObjectStore'}': The transaction is not active.`, 'TransactionInactiveError');
                const r = newRequest(IDBRequest, source, tx);
                idbSend({ op: 'req', tx: ts.id, rid: S(r).rid, ...fields, args: args.map(wireArg) });
                return r;
            }
            const readOnlyCheck = (tx, what) => { if (S(tx).mode === 'readonly') throw dom(`Failed to execute '${what}' on 'IDBObjectStore': The transaction is read-only.`, 'ReadOnlyError'); };
            const trimArgs = (args) => { const a = Array.from(args); while (a.length && a[a.length - 1] === undefined) a.pop(); return a; };

            class IDBObjectStore {
                constructor() { illegal(); }
                put(value, key) { const s = S(this); readOnlyCheck(s.tx, 'put'); return requestOn(this, s.tx, { store: s.name, method: 'put' }, trimArgs([value, key])); }
                add(value, key) { const s = S(this); readOnlyCheck(s.tx, 'add'); return requestOn(this, s.tx, { store: s.name, method: 'add' }, trimArgs([value, key])); }
                delete(query) { const s = S(this); readOnlyCheck(s.tx, 'delete'); return requestOn(this, s.tx, { store: s.name, method: 'delete' }, [query]); }
                clear() { const s = S(this); readOnlyCheck(s.tx, 'clear'); return requestOn(this, s.tx, { store: s.name, method: 'clear' }, []); }
                index(name) {
                    const s = S(this);
                    name = String(name);
                    const meta = metaOf(s.tx, s.name);
                    if (!meta.indexes.some((x) => x.name === name))
                        throw dom("Failed to execute 'index' on 'IDBObjectStore': The specified index was not found.", 'NotFoundError');
                    let ix = s.indexes.get(name);
                    if (!ix) {
                        ix = ObjectCreate(IDBIndex.prototype);
                        slots.set(ix, { store: this, name, tx: s.tx });
                        s.indexes.set(name, ix);
                    }
                    return ix;
                }
                createIndex(name, keyPath, options = {}) {
                    const s = S(this);
                    if (S(s.tx).mode !== 'versionchange')
                        throw dom("Failed to execute 'createIndex' on 'IDBObjectStore': The database is not running a version change transaction.", 'InvalidStateError');
                    name = String(name);
                    const meta = metaOf(s.tx, s.name);
                    if (meta.indexes.some((x) => x.name === name))
                        throw dom("Failed to execute 'createIndex' on 'IDBObjectStore': An index with the specified name already exists.", 'ConstraintError');
                    const ix = { name, keyPath, unique: !!(options && options.unique), multiEntry: !!(options && options.multiEntry) };
                    meta.indexes.push(ix);
                    idbSend({ op: 'schema', tx: S(s.tx).id, db: S(S(s.tx).db).id, action: 'createIndex', store: s.name, name, keyPath, options: { unique: ix.unique, multiEntry: ix.multiEntry } });
                    return this.index(name);
                }
                deleteIndex(name) {
                    const s = S(this);
                    if (S(s.tx).mode !== 'versionchange')
                        throw dom("Failed to execute 'deleteIndex' on 'IDBObjectStore': The database is not running a version change transaction.", 'InvalidStateError');
                    const meta = metaOf(s.tx, s.name);
                    const i = meta.indexes.findIndex((x) => x.name === String(name));
                    if (i < 0)
                        throw dom("Failed to execute 'deleteIndex' on 'IDBObjectStore': The specified index was not found.", 'NotFoundError');
                    meta.indexes.splice(i, 1);
                    s.indexes.delete(String(name));
                    idbSend({ op: 'schema', tx: S(s.tx).id, db: S(S(s.tx).db).id, action: 'deleteIndex', store: s.name, name: String(name) });
                }
            }
            class IDBIndex {
                constructor() { illegal(); }
            }
            for (const [Cls, isIndex] of [[IDBObjectStore, false], [IDBIndex, true]]) {
                for (const method of ['get', 'getKey', 'getAll', 'getAllKeys', 'count', 'openCursor', 'openKeyCursor']) {
                    defineProperty(Cls.prototype, method, {
                        value: { [method](...args) {
                            const s = S(this);
                            const store = isIndex ? S(s.store).name : s.name;
                            const r = requestOn(this, s.tx, isIndex ? { store, index: s.name, method } : { store, method }, trimArgs(args));
                            if (method === 'openCursor' || method === 'openKeyCursor')
                                S(r).cursorKind = { method, source: this, direction: args[1] || 'next' };
                            return r;
                        } }[method],
                        writable: true, enumerable: true, configurable: true,
                    });
                }
            }
            getters(IDBObjectStore.prototype, {
                name: (s) => s.name, keyPath: (s) => { const m = metaOf(s.tx, s.name); return m ? m.keyPath : null; },
                indexNames: (s) => stringList(metaOf(s.tx, s.name).indexes.map((x) => x.name)), transaction: (s) => s.tx,
                autoIncrement: (s) => !!metaOf(s.tx, s.name).autoIncrement,
            });
            const ixMeta = (s) => metaOf(s.tx, S(s.store).name).indexes.find((x) => x.name === s.name);
            getters(IDBIndex.prototype, { name: (s) => s.name, objectStore: (s) => s.store, keyPath: (s) => ixMeta(s).keyPath, unique: (s) => ixMeta(s).unique, multiEntry: (s) => ixMeta(s).multiEntry });
            function storeOf(tx, name) {
                const ts = S(tx);
                let st = ts.stores.get(name);
                if (!st) {
                    st = ObjectCreate(IDBObjectStore.prototype);
                    slots.set(st, { tx, name, indexes: new Map() });
                    ts.stores.set(name, st);
                }
                return st;
            }

            class IDBCursor {
                constructor() { illegal(); }
                continue(key) {
                    const s = S(this);
                    if (s.moving || s.done)
                        throw dom("Failed to execute 'continue' on 'IDBCursor': The cursor is being iterated or has iterated past its end.", 'InvalidStateError');
                    if (!S(s.tx).active)
                        throw dom("Failed to execute 'continue' on 'IDBCursor': The transaction is not active.", 'TransactionInactiveError');
                    if (key !== undefined)
                        checkKey(key, "continue' on 'IDBCursor");
                    move(this, 'continue', key === undefined ? [] : [key]);
                }
                advance(count) {
                    count = Number(count);
                    if (!(count >= 1))
                        throw new TypeError("Failed to execute 'advance' on 'IDBCursor': A count argument with value 0 (zero) was supplied, must be greater than 0.");
                    move(this, 'advance', [count]);
                }
                continuePrimaryKey(key, primaryKey) { move(this, 'continuePrimaryKey', [key, primaryKey]); }
                update(value) {
                    const s = S(this);
                    if (S(s.tx).mode === 'readonly')
                        throw dom("Failed to execute 'update' on 'IDBCursor': The record may not be updated inside a read-only transaction.", 'ReadOnlyError');
                    return cursorRequest(this, 'update', [value]);
                }
                delete() {
                    const s = S(this);
                    if (S(s.tx).mode === 'readonly')
                        throw dom("Failed to execute 'delete' on 'IDBCursor': The record may not be deleted inside a read-only transaction.", 'ReadOnlyError');
                    return cursorRequest(this, 'delete', []);
                }
            }
            class IDBCursorWithValue extends IDBCursor {}
            getters(IDBCursor.prototype, { source: (s) => s.source, direction: (s) => s.direction, key: (s) => s.key, primaryKey: (s) => s.primaryKey, request: (s) => s.request });
            getters(IDBCursorWithValue.prototype, { value: (s) => s.value });
            function move(cursor, method, args) {
                const s = S(cursor);
                if (s.moving)
                    throw dom(`Failed to execute '${method}' on 'IDBCursor': The cursor is being iterated or has iterated past its end.`, 'InvalidStateError');
                s.moving = true;
                const rs = S(s.request);
                rs.readyState = 'pending';
                idbSend({ op: 'cursor', rid: rs.rid, method, args: args.map(wireArg) });
            }
            function cursorRequest(cursor, method, args) {
                const s = S(cursor);
                if (!S(s.tx).active)
                    throw dom(`Failed to execute '${method}' on 'IDBCursor': The transaction is not active.`, 'TransactionInactiveError');
                const r = newRequest(IDBRequest, cursor, s.tx);
                idbSend({ op: 'cursor-req', rid: S(s.request).rid, nrid: S(r).rid, method, args });
                return r;
            }

            const errorOf = (e) => e ? dom(e.message, e.name) : null;
            function finishTx(tx, kind, error) {
                const s = S(tx);
                if (s.finished)
                    return;
                s.finished = true;
                s.active = false;
                txs.delete(s.id);
                const dbs_ = S(s.db);
                if (dbs_.upgrading === tx)
                    dbs_.upgrading = null;
                if (kind === 'complete') {
                    tx.dispatchEvent(new HostEventClass('complete'));
                } else {
                    s.error = s.error || errorOf(error) || (s.aborting ? null : dom('The transaction was aborted.', 'AbortError'));
                    if (s.revert)
                        s.revert();
                    const ev = new HostEventClass('abort', { bubbles: true });
                    dispatch(tx, ev, null, false);
                    s.db.dispatchEvent(ev);
                }
            }
            function onEvent(m) {
                if (m.ev === 'complete' || m.ev === 'abort') {
                    const tx = txs.get(m.tx);
                    if (tx)
                        finishTx(tx, m.ev, m.error);
                    return;
                }
                if (m.ev === 'fail') {
                    const tx = txs.get(m.tx);
                    if (tx && !S(tx).finished)
                        S(tx).error = errorOf(m.error);
                    return;
                }
                if (m.ev === 'versionchange' || m.ev === 'dbclose') {
                    const db = dbs.get(m.db);
                    if (!db)
                        return;
                    if (m.ev === 'dbclose') {
                        S(db).closed = true;
                        db.dispatchEvent(new HostEventClass('close'));
                    } else {
                        db.dispatchEvent(new IDBVersionChangeEvent('versionchange', { oldVersion: m.oldVersion, newVersion: m.newVersion }));
                    }
                    return;
                }
                const r = requests.get(m.rid);
                if (!r)
                    return;
                const s = S(r);
                if (m.ev === 'blocked') {
                    r.dispatchEvent(new IDBVersionChangeEvent('blocked', { oldVersion: m.oldVersion, newVersion: m.newVersion }));
                    return;
                }
                if (m.ev === 'upgradeneeded') {
                    const db = newDb(s.db, m.meta);
                    const before = JSON.stringify(m.meta);
                    const tx = newTx(db, m.meta.stores.map((x) => x.name), 'versionchange', 'default', s.tx);
                    S(tx).revert = () => { S(db).meta = JSON.parse(before); S(db).meta.version = m.oldVersion; };
                    S(db).meta.version = m.newVersion;
                    S(db).upgrading = tx;
                    s.readyState = 'done';
                    s.result = db;
                    s.transaction = tx;
                    dispatch(r, new IDBVersionChangeEvent('upgradeneeded', { oldVersion: m.oldVersion, newVersion: m.newVersion }), tx, false);
                    return;
                }
                if (m.ev === 'success' && s.promise) {
                    requests.delete(m.rid);
                    s.promise.resolve(m.result);
                    return;
                }
                if (m.ev === 'error' && s.promise) {
                    requests.delete(m.rid);
                    s.promise.reject(errorOf(m.error));
                    return;
                }
                const tx = s.transaction;
                s.readyState = 'done';
                if (m.ev === 'success') {
                    if (m.meta) { // open
                        let db = dbs.get(s.db);
                        if (db)
                            S(db).meta = m.meta;
                        else
                            db = newDb(s.db, m.meta);
                        S(db).upgrading = null;
                        s.result = db;
                        s.transaction = null;
                        requests.delete(m.rid);
                        r.dispatchEvent(new HostEventClass('success'));
                        return;
                    }
                    if ('cursor' in m) {
                        const kind = s.cursorKind;
                        if (m.cursor === null) {
                            if (s.cursor) { S(s.cursor).done = true; S(s.cursor).moving = false; }
                            s.result = null;
                            requests.delete(m.rid);
                        } else {
                            if (!s.cursor) {
                                s.cursor = ObjectCreate((kind.method === 'openCursor' ? IDBCursorWithValue : IDBCursor).prototype);
                                slots.set(s.cursor, { tx, source: kind.source, direction: kind.direction, request: r });
                            }
                            const cs = S(s.cursor);
                            cs.key = m.cursor.key;
                            cs.primaryKey = m.cursor.primaryKey;
                            cs.value = m.cursor.value;
                            cs.moving = false;
                            s.result = s.cursor;
                        }
                    } else {
                        s.result = m.oldVersion !== undefined && tx === null && s.source === null ? undefined : m.result;
                        requests.delete(m.rid);
                    }
                    s.error = null;
                    dispatch(r, new HostEventClass('success'), tx, false);
                    return;
                }
                // An error: it bubbles to the transaction and the database; not prevented, the transaction aborts.
                requests.delete(m.rid);
                s.result = undefined;
                s.error = errorOf(m.error);
                const ev = new HostEventClass('error', { bubbles: true, cancelable: true });
                dispatch(r, ev, tx, !!tx);
                if (tx && !ev.defaultPrevented && !S(tx).finished && !S(tx).aborting) {
                    S(tx).error = s.error;
                    S(tx).aborting = true;
                    idbSend({ op: 'abort', tx: S(tx).id });
                }
            }
            const factory = ObjectCreate(IDBFactory.prototype);
            slots.set(factory, {});
            const classes = { IDBFactory, IDBDatabase, IDBTransaction, IDBObjectStore, IDBIndex, IDBCursor, IDBCursorWithValue, IDBKeyRange, IDBRequest, IDBOpenDBRequest, IDBVersionChangeEvent, DOMStringList };
            for (const [n, c] of Object.entries(classes)) {
                defineProperty(c.prototype, Symbol.toStringTag, { value: n, configurable: true });
                defineProperty(G, n, { value: c, writable: true, configurable: true });
            }
            defineProperty(G, 'indexedDB', { get: () => factory, configurable: true, enumerable: true });
            return { onEvent };
        })();

        // --- Web Locks (navigator.locks) and the Cookie Store (cookieStore): the page's, through the segment ------------------
        const storageApis = (() => {
            const pending = new Map();
            let next = 1;
            const call = (api, method, args) => new HostPromise((resolve, reject) => {
                const rid = next++;
                pending.set(rid, { resolve, reject });
                send({ t: 'api', api, method, rid, args });
            });
            const asError = (e) => new HostDOMException(e.message, e.name);
            function onEvent(m) {
                const p = pending.get(m.rid);
                if (!p)
                    return;
                if (m.granted) {
                    // The lock is held (in the page's LockManager) until the callback's promise settles.
                    const lock = m.lock ? makeLock(m.lock) : null;
                    let result;
                    try {
                        result = HostPromise.resolve(p.callback(lock));
                    } catch (e) {
                        result = HostPromise.reject(e);
                    }
                    result.then((v) => { p.value = { ok: true, v }; }, (e) => { p.value = { ok: false, e }; })
                        .then(() => send({ t: 'api', api: 'locks', method: 'release', rid: m.rid }));
                    return;
                }
                pending.delete(m.rid);
                if (m.done)
                    p.value && p.value.ok ? p.resolve(p.value.v) : p.reject(p.value ? p.value.e : undefined);
                else if (m.ok)
                    p.resolve(m.value);
                else
                    p.reject(asError(m.error));
            }
            const slot = new WeakMap();
            class Lock {
                constructor() { throw new TypeError('Illegal constructor'); }
                get name() { return slot.get(this).name; }
                get mode() { return slot.get(this).mode; }
            }
            const makeLock = (l) => { const o = ObjectCreate(Lock.prototype); slot.set(o, l); return o; };
            class LockManager {
                constructor() { throw new TypeError('Illegal constructor'); }
                request(name, options, callback) {
                    if (typeof options === 'function') {
                        callback = options;
                        options = {};
                    }
                    if (typeof callback !== 'function')
                        return HostPromise.reject(new TypeError("Failed to execute 'request' on 'LockManager': parameter 3 is not of type 'Function'."));
                    name = String(name);
                    if (name.startsWith('-'))
                        return HostPromise.reject(new HostDOMException("Failed to execute 'request' on 'LockManager': Names cannot start with '-'.", 'NotSupportedError'));
                    const o = options || {};
                    if (o.signal) // a signal cannot cross to the page's manager; Chrome's own checks first
                        return HostPromise.reject(new HostDOMException("Failed to execute 'request' on 'LockManager': The 'signal' option is not supported here yet.", 'NotSupportedError'));
                    const opts = { mode: o.mode === 'shared' ? 'shared' : 'exclusive', ifAvailable: !!o.ifAvailable, steal: !!o.steal };
                    return new HostPromise((resolve, reject) => {
                        const rid = next++;
                        pending.set(rid, { resolve, reject, callback });
                        send({ t: 'api', api: 'locks', method: 'request', rid, name, options: opts });
                    });
                }
                query() { return call('locks', 'query', []); }
            }
            class CookieStore extends G.EventTarget {
                constructor(t) { if (t !== slot) throw new TypeError('Illegal constructor'); super(); }
                get(...a) { return call('cookieStore', 'get', a); }
                getAll(...a) { return call('cookieStore', 'getAll', a); }
                set(...a) { return call('cookieStore', 'set', a).then(() => undefined); }
                delete(...a) { return call('cookieStore', 'delete', a).then(() => undefined); }
            }
            for (const [n, c] of [['Lock', Lock], ['LockManager', LockManager], ['CookieStore', CookieStore]]) {
                defineProperty(c.prototype, Symbol.toStringTag, { value: n, configurable: true });
                defineProperty(G, n, { value: c, writable: true, configurable: true });
            }
            const locks = ObjectCreate(LockManager.prototype);
            const cookieStore = new CookieStore(slot);
            runnerLocks = locks;
            if (G.navigator && G.navigator.locks !== locks) { // under Node (tests/pagesw-node-runner.mjs) the navigator is not the doors'
                try {
                    defineProperty(G.navigator, 'locks', { get: () => locks, enumerable: true, configurable: true });
                } catch { /* a navigator that keeps its own */ }
            }
            defineProperty(G, 'cookieStore', { get: () => cookieStore, enumerable: true, configurable: true });
            return { onEvent };
        })();
        // OPFS: the same interfaces and the same files as the page's (harness/segment/opfs.js).
        if (platform.installOPFS)
            platform.installOPFS();
        // WebSocket (harness/segment/websocket.js): frames are written here; the bytes go over the port to the segment Worker, which
        // opens the upgrade on the engine's network (through Spiracle and the relay's allowlist), never on the host's.
        const wsHandlers = new Map();
        let wsNext = 1;
        const wsTransport = {
            open: (url, headers, handlers) => {
                const wid = wsNext++;
                wsHandlers.set(wid, handlers);
                send({ t: 'ws-open', wid, url, headers });
                return {
                    write: (bytes) => { send({ t: 'ws-write', wid, bytes: bytes.buffer }, [bytes.buffer]); return true; },
                    close: () => { if (wsHandlers.delete(wid)) send({ t: 'ws-close', wid }); },
                };
            },
        };
        function onWebSocketMessage(m) {
            const h = wsHandlers.get(m.wid);
            if (!h)
                return;
            if (m.ev === 'open')
                h.onOpen(m.status, m.reason, m.headers);
            else if (m.ev === 'data')
                h.onData(new HostUint8Array(m.bytes));
            else if (m.ev === 'close') {
                wsHandlers.delete(m.wid);
                h.onClose(m.error || '');
            }
        }
        if (platform.installWebSocket)
            platform.installWebSocket({
                transport: wsTransport,
                origin: () => new HostURL(scriptURL).origin,
                base: () => scriptURL,
                mixedContent: () => new HostURL(scriptURL).protocol === 'https:',
            });

        // A message for the page: the real ports go first in the transfer list and are counted (`ports`), so the segment Worker
        // can tell them from the streams and buffers that follow (Node lists every transferred object as a port).
        const isPort = (x) => x !== null && typeof x === 'object' && typeof x.postMessage === 'function' && typeof x.start === 'function';
        function postToHost(t, fields, data, list) {
            const ports = list.filter(isPort);
            send({ t, ...fields, data, ports: ports.length }, [...ports, ...list.filter((x) => !isPort(x))]);
        }

        // --- Clients, the registration, this worker ---------------------------------------------------------------------
        class Client {
            constructor(c) {
                defineProperty(this, 'id', { value: c.id, enumerable: true });
                defineProperty(this, 'url', { value: c.url, enumerable: true });
                defineProperty(this, 'type', { value: c.type || 'window', enumerable: true });
                defineProperty(this, 'frameType', { value: c.frameType || 'top-level', enumerable: true });
            }
            postMessage(data, transfer) {
                const list = Array.isArray(transfer) ? transfer : (transfer && transfer.transfer) || [];
                postToHost('client-post', { clientId: this.id }, data, list);
            }
        }
        class WindowClient extends Client {
            constructor(c) {
                super(c);
                defineProperty(this, 'focused', { value: !!c.focused, enumerable: true });
                defineProperty(this, 'visibilityState', { value: c.visibilityState || 'visible', enumerable: true });
                defineProperty(this, 'ancestorOrigins', { value: Object.freeze([]), enumerable: true });
            }
            async focus() { return this; }
            async navigate(url) { send({ t: 'client-navigate', clientId: this.id, url: new HostURL(url, this.url).href }); return null; }
        }
        const makeClient = (c) => (c.type === 'window' || !c.type ? new WindowClient(c) : new Client(c));
        class Clients {
            async get(id) { const r = await ask({ t: 'clients', all: true }); const c = r.clients.find((x) => x.id === id); return c ? makeClient(c) : undefined; }
            async matchAll(options = {}) {
                const r = await ask({ t: 'clients', all: !!options.includeUncontrolled });
                const type = options.type || 'window';
                return r.clients.filter((c) => type === 'all' || (c.type || 'window') === type).map(makeClient);
            }
            async openWindow() { throw new TypeError('clients.openWindow() is not supported in Chitin'); }
            async claim() { await ask({ t: 'claim' }); }
        }
        for (const C of [Client, WindowClient, Clients])
            defineProperty(G, C.name, { value: C, writable: true, configurable: true });
        const clients = new Clients();
        defineProperty(G, 'clients', { get: () => clients, configurable: true, enumerable: true });

        // ServiceWorker objects as this worker sees them (its registration's versions), refreshed by the segment.
        class ServiceWorker {
            constructor(v) { this.__v = v; }
            get scriptURL() { return this.__v.scriptURL; }
            get state() { return this.__v.state; }
            postMessage(data, transfer) {
                const list = Array.isArray(transfer) ? transfer : (transfer && transfer.transfer) || [];
                postToHost('worker-post', { to: this.__v.id }, data, list);
            }
        }
        const workers = new Map(); // version id -> ServiceWorker
        const workerFor = (v) => {
            if (!v)
                return null;
            let w = workers.get(v.id);
            if (!w) {
                w = new ServiceWorker(v);
                workers.set(v.id, w);
            }
            w.__v = v;
            return w;
        };
        let regState = { scope: '', installing: null, waiting: null, active: null, updateViaCache: 'imports' };
        const navigationPreload = Object.freeze({
            enable: async () => undefined,
            disable: async () => undefined,
            setHeaderValue: async () => undefined,
            getState: async () => ({ enabled: false, headerValue: 'true' }),
        });
        const registration = {
            get scope() { return regState.scope; },
            get installing() { return workerFor(regState.installing); },
            get waiting() { return workerFor(regState.waiting); },
            get active() { return workerFor(regState.active); },
            get updateViaCache() { return regState.updateViaCache; },
            get navigationPreload() { return navigationPreload; },
            update: () => ask({ t: 'update' }).then(() => registration),
            unregister: () => ask({ t: 'unregister' }).then((r) => r.ok),
            addEventListener() {},
            removeEventListener() {},
            onupdatefound: null,
        };
        defineProperty(G, 'registration', { get: () => registration, configurable: true, enumerable: true });
        defineProperty(G, 'skipWaiting', { value: function skipWaiting() { return ask({ t: 'skip-waiting' }).then(() => undefined); }, writable: true, configurable: true });
        let moduleWorker = false;
        defineProperty(G, 'importScripts', {
            value: function importScripts(...urls) {
                if (moduleWorker)
                    throw new TypeError("Failed to execute 'importScripts' on 'WorkerGlobalScope': Module scripts don't support importScripts().");
                const resolved = urls.map((u) => new HostURL(String(u), scriptURL).href);
                platform.importScripts(resolved);
            }, writable: true, configurable: true,
        });

        // --- Lifecycle -------------------------------------------------------------------------------------------------
        let scriptURL = '';
        let me = null;
        // A page's dedicated Worker (kind 'dedicated'): the service worker's names go, a DedicatedWorkerGlobalScope's come.
        let dedicated = false;
        const SW_ONLY = ['clients', 'registration', 'skipWaiting', 'caches', 'Cache', 'CacheStorage', 'ExtendableEvent', 'ExtendableMessageEvent',
            'FetchEvent', 'Client', 'WindowClient', 'Clients', 'serviceWorker', 'oninstall', 'onactivate', 'onfetch'];
        // The runner loads the site's scripts under the segment's mirror names: errors name the site's URLs, as in Chrome.
        const MIRROR_NAME = /^https?:\/\/[^/]+\/__chitin\/o\/https\//;
        const siteName = (u) => (typeof u === 'string' ? u.replace(MIRROR_NAME, 'https://') : u);
        function reportUncaught(e, where) {
            let filename = '', lineno = 0, colno = 0;
            const at = e && typeof e.stack === 'string' ? /\(?((?:https?|blob):[^\s)]+?):(\d+):(\d+)\)?/.exec(e.stack) : null;
            if (at) {
                filename = siteName(at[1]);
                lineno = +at[2];
                colno = +at[3];
            }
            const text = e instanceof Error || (e && typeof e === 'object' && 'message' in e) ? `${e.name || 'Error'}: ${e.message}` : String(e);
            send({ t: 'error', message: 'Uncaught ' + text, filename: filename || where || '', lineno, colno });
        }
        // --- Workers made by this worker (nested dedicated Workers) ----------------------------------------------------------
        // The segment starts each one in a runner of its own, as it does a page's (harness/segment/pagesw-host.js); messages
        // go through the segment both ways. A blob: script made here is read here (the segment cannot see this blob store).
        const nested = new Map(); // nid -> { worker, onEvent }
        let nextNested = 1;
        function installNestedWorker() {
            const HostEventTarget = G.EventTarget;
            const HostErrorEvent = G.ErrorEvent;
            const HostMessageEvent = G.MessageEvent;
            class Worker extends HostEventTarget {
                #nid;
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
                        url = new HostURL(String(scriptURL), scriptURL_());
                    } catch {
                        throw new HostDOMException(`Failed to construct 'Worker': The URL '${String(scriptURL)}' is invalid.`, 'SyntaxError');
                    }
                    const base = new HostURL(scriptURL_());
                    if (url.protocol !== 'blob:' && url.protocol !== 'data:' && url.origin !== base.origin)
                        throw new HostDOMException(`Failed to construct 'Worker': Script at '${url.href}' cannot be accessed from origin '${base.origin}'.`, 'SecurityError');
                    const nid = nextNested++;
                    this.#nid = nid;
                    const self_ = this;
                    nested.set(nid, {
                        onEvent(m, ports) {
                            if (self_.#terminated)
                                return;
                            if (m.kind === 'message')
                                self_.dispatchEvent(new HostMessageEvent('message', { data: m.data, ports }));
                            else if (m.kind === 'error' && m.plain)
                                self_.dispatchEvent(new HostEvent('error', { cancelable: true }));
                            else if (m.kind === 'error') {
                                const init = { message: m.message, filename: m.filename, lineno: m.lineno, colno: m.colno, error: null, cancelable: true };
                                let ev;
                                if (typeof HostErrorEvent === 'function')
                                    ev = new HostErrorEvent('error', init);
                                else { // Node's runner (tests) has no ErrorEvent
                                    ev = new HostEvent('error', { cancelable: true });
                                    for (const k of ['message', 'filename', 'lineno', 'colno'])
                                        defineProperty(ev, k, { value: init[k] });
                                }
                                self_.dispatchEvent(ev);
                            }
                            else if (m.kind === 'close') {
                                self_.#terminated = true;
                                nested.delete(nid);
                            }
                        },
                    });
                    (async () => {
                        let text;
                        if (url.protocol === 'blob:') {
                            try {
                                const blob = ownBlobs.get(url.href);
                                if (!blob)
                                    throw new TypeError('not a blob this worker made');
                                text = await blob.text();
                            } catch {
                                this.dispatchEvent(new HostEvent('error', { cancelable: true }));
                                return;
                            }
                        }
                        send({ t: 'nested-create', nid, url: url.href, type, name, text });
                    })();
                }
                postMessage(message, transfer) {
                    if (this.#terminated)
                        return;
                    sharedRefused(message, "postMessage' on 'Worker");
                    const list = Array.isArray(transfer) ? transfer : (transfer && transfer.transfer) || [];
                    postToHost('nested-post', { nid: this.#nid }, message, list);
                }
                terminate() {
                    if (this.#terminated)
                        return;
                    this.#terminated = true;
                    nested.delete(this.#nid);
                    send({ t: 'nested-terminate', nid: this.#nid });
                }
            }
            for (const ev of ['message', 'messageerror', 'error']) {
                const slot = new WeakMap();
                defineProperty(Worker.prototype, 'on' + ev, {
                    get() { return (slot.get(this) || {}).fn || null; },
                    set(fn) {
                        const s = slot.get(this);
                        if (s && s.wrap)
                            this.removeEventListener(ev, s.wrap);
                        const f = typeof fn === 'function' ? fn : null;
                        const wrap = f ? (e) => ReflectApply(f, this, [e]) : null;
                        slot.set(this, { fn: f, wrap });
                        if (wrap)
                            this.addEventListener(ev, wrap);
                    },
                    configurable: true, enumerable: true,
                });
            }
            defineProperty(Worker.prototype, Symbol.toStringTag, { value: 'Worker', configurable: true });
            defineProperty(G, 'Worker', { value: Worker, writable: true, configurable: true });
        }
        const scriptURL_ = () => scriptURL;

        // The global's interface objects (WorkerGlobalScope, DedicatedWorkerGlobalScope or SharedWorkerGlobalScope): the host's
        // were removed with the doors; these stand in over the same prototype objects (the global's own chain), so
        // `self instanceof WorkerGlobalScope` holds and `new WorkerGlobalScope()` is an illegal constructor, as in Chrome.
        function globalInterface(name, proto) {
            const holder = { [name]: function () { throw new TypeError("Failed to construct '" + name + "': Illegal constructor"); } };
            const C = holder[name];
            defineProperty(C, 'prototype', { value: proto, writable: false, enumerable: false, configurable: false });
            defineProperty(proto, 'constructor', { value: C, writable: true, enumerable: false, configurable: true });
            defineProperty(proto, Symbol.toStringTag, { value: name, writable: false, enumerable: false, configurable: true });
            defineProperty(G, name, { value: C, writable: true, enumerable: false, configurable: true });
            return C;
        }
        // --- XMLHttpRequest (dedicated and shared Workers have it in Chrome; a service worker does not) --------------------
        // The host's XHR is a door (doors.js): this one goes over the port to the segment Worker, like fetch(). Asynchronous
        // requests ask 'net' as fetch() does. A synchronous one (a disk Worker that reads a block while the task waits)
        // blocks this runner in Atomics.wait while the segment Worker fetches and writes the answer into a growable
        // SharedArrayBuffer of this runner's (the segment origin is always isolated, whatever the page's own isolation is):
        // [state (0 waiting, 1 answered, 2 failed), meta length, body length, request number], from byte 16 the answer's
        // meta (JSON: status, statusText, headers, url) and then its body.
        function installXHR() {
            const HostSAB = hostSharedArrayBuffer;
            const HostEventTarget = G.EventTarget;
            const HostProgressEvent = G.ProgressEvent;
            const HostBlob = G.Blob;
            const HostTextDecoder = G.TextDecoder;
            const HostFileReaderSync = G.FileReaderSync;
            const encoder = new HostTextEncoder();
            const UNSENT = 0, OPENED = 1, HEADERS_RECEIVED = 2, LOADING = 3, DONE = 4;
            const FORBIDDEN_METHODS = /^(connect|trace|track)$/i;
            const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
            const ehandlers = new WeakMap();
            const eventHandler = (proto, name) => defineProperty(proto, 'on' + name, {
                get() { const h = ehandlers.get(this); return (h && h[name] && h[name].f) || null; },
                set(fn) {
                    let h = ehandlers.get(this);
                    if (!h)
                        ehandlers.set(this, h = {});
                    if (h[name])
                        this.removeEventListener(name, h[name].w);
                    h[name] = null;
                    if (typeof fn === 'function') {
                        const w = function (e) { return ReflectApply(fn, this, [e]); };
                        h[name] = { f: fn, w };
                        this.addEventListener(name, w);
                    }
                },
                enumerable: true, configurable: true,
            });
            let syncSab = null, syncSeq = 0;
            const SYNC_MAX = 1 << 30;
            class XMLHttpRequestEventTarget extends HostEventTarget {}
            for (const n of ['loadstart', 'progress', 'abort', 'error', 'load', 'timeout', 'loadend'])
                eventHandler(XMLHttpRequestEventTarget.prototype, n);
            class XMLHttpRequestUpload extends XMLHttpRequestEventTarget {}
            const bodyOf = (body) => {
                // [bytes, content type] synchronously, as the request's body is extracted at send().
                if (body === null || body === undefined)
                    return [null, null];
                if (body instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && body instanceof SharedArrayBuffer))
                    return [new HostUint8Array(body).slice().buffer, null];
                if (ArrayBuffer.isView(body))
                    return [new HostUint8Array(body.buffer, body.byteOffset, body.byteLength).slice().buffer, null];
                if (body instanceof HostBlob)
                    return [new HostFileReaderSync().readAsArrayBuffer(body), body.type || null];
                if (body instanceof G.URLSearchParams)
                    return [encoder.encode(String(body)).buffer, 'application/x-www-form-urlencoded;charset=UTF-8'];
                if (body instanceof G.FormData) {
                    const r = new HostRequest('https://chitin.invalid/', { method: 'POST', body });
                    return [null, r.headers.get('content-type'), r];
                }
                return [encoder.encode(String(body)).buffer, 'text/plain;charset=UTF-8'];
            };
            class XMLHttpRequest extends XMLHttpRequestEventTarget {
                #s = { state: UNSENT, method: 'GET', url: '', async: true, headers: [], send: false, response: null, error: false, aborted: 0,
                    timeout: 0, withCredentials: false, responseType: '', mime: null, upload: null, cached: undefined, timer: 0 };
                constructor() {
                    super();
                    this.#s.upload = new XMLHttpRequestUpload();
                }
                get readyState() { return this.#s.state; }
                get upload() { return this.#s.upload; }
                get status() { const r = this.#s.response; return r && !this.#s.error ? r.status : 0; }
                get statusText() { const r = this.#s.response; return r && !this.#s.error ? r.statusText || '' : ''; }
                get responseURL() { const r = this.#s.response; return r && !this.#s.error ? String(r.url || '').replace(/#.*$/, '') : ''; }
                get timeout() { return this.#s.timeout; }
                set timeout(v) { this.#s.timeout = Math.max(0, Math.floor(Number(v)) || 0); }
                get withCredentials() { return this.#s.withCredentials; }
                set withCredentials(v) {
                    if (this.#s.state !== UNSENT && this.#s.state !== OPENED || this.#s.send)
                        throw new HostDOMException("Failed to set the 'withCredentials' property on 'XMLHttpRequest': The value may only be set if the object's state is UNSENT or OPENED.", 'InvalidStateError');
                    this.#s.withCredentials = !!v;
                }
                get responseType() { return this.#s.responseType; }
                set responseType(v) {
                    const t = String(v);
                    if (!['', 'arraybuffer', 'blob', 'document', 'json', 'text'].includes(t))
                        return;
                    if (t === 'document')
                        return; // ignored in a Worker, as in Chrome
                    if (this.#s.state === LOADING || this.#s.state === DONE)
                        throw new HostDOMException("Failed to set the 'responseType' property on 'XMLHttpRequest': The response type cannot be set if the object's state is LOADING or DONE.", 'InvalidStateError');
                    this.#s.responseType = t;
                }
                open(method, url, async, user, password) {
                    if (arguments.length < 2)
                        throw new TypeError(`Failed to execute 'open' on 'XMLHttpRequest': 2 arguments required, but only ${arguments.length} present.`);
                    const m = String(method);
                    if (!TOKEN.test(m))
                        throw new HostDOMException(`Failed to execute 'open' on 'XMLHttpRequest': '${m}' is not a valid HTTP method.`, 'SyntaxError');
                    if (FORBIDDEN_METHODS.test(m))
                        throw new HostDOMException(`Failed to execute 'open' on 'XMLHttpRequest': '${m}' HTTP method is unsupported.`, 'SecurityError');
                    let u;
                    try {
                        u = new HostURL(String(url), scriptURL);
                    } catch {
                        throw new HostDOMException(`Failed to execute 'open' on 'XMLHttpRequest': Invalid URL`, 'SyntaxError');
                    }
                    const s = this.#s;
                    this.#abortRunning();
                    s.method = /^(delete|get|head|options|post|put|patch)$/i.test(m) ? m.toUpperCase() : m;
                    s.url = u.href;
                    s.async = arguments.length < 3 ? true : !!async;
                    s.headers = [];
                    s.send = false;
                    s.response = null;
                    s.error = false;
                    s.cached = undefined;
                    if (s.state !== OPENED) {
                        s.state = OPENED;
                        this.dispatchEvent(new HostEvent('readystatechange'));
                    }
                }
                setRequestHeader(name, value) {
                    const s = this.#s;
                    if (s.state !== OPENED || s.send)
                        throw new HostDOMException("Failed to execute 'setRequestHeader' on 'XMLHttpRequest': The object's state must be OPENED.", 'InvalidStateError');
                    const n = String(name);
                    if (!TOKEN.test(n))
                        throw new HostDOMException(`Failed to execute 'setRequestHeader' on 'XMLHttpRequest': '${n}' is not a valid HTTP header field name.`, 'SyntaxError');
                    const v = String(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
                    const at = s.headers.findIndex(([k]) => k.toLowerCase() === n.toLowerCase());
                    if (at >= 0)
                        s.headers[at][1] += ', ' + v;
                    else
                        s.headers.push([n, v]);
                }
                overrideMimeType(mime) {
                    if (this.#s.state === LOADING || this.#s.state === DONE)
                        throw new HostDOMException("Failed to execute 'overrideMimeType' on 'XMLHttpRequest': MimeType cannot be overridden when the state is LOADING or DONE.", 'InvalidStateError');
                    this.#s.mime = String(mime);
                }
                getResponseHeader(name) {
                    const r = this.#s.response;
                    if (!r || this.#s.error || this.#s.state < HEADERS_RECEIVED)
                        return null;
                    const n = String(name).toLowerCase();
                    const vals = r.headers.filter(([k]) => k.toLowerCase() === n).map(([, v]) => v);
                    return vals.length ? vals.join(', ') : null;
                }
                getAllResponseHeaders() {
                    const r = this.#s.response;
                    if (!r || this.#s.error || this.#s.state < HEADERS_RECEIVED)
                        return '';
                    const map = new Map();
                    for (const [k, v] of r.headers) {
                        const n = k.toLowerCase();
                        map.set(n, map.has(n) ? map.get(n) + ', ' + v : v);
                    }
                    return [...map.keys()].sort().map((n) => n + ': ' + map.get(n) + '\r\n').join('');
                }
                get responseText() {
                    if (this.#s.responseType !== '' && this.#s.responseType !== 'text')
                        throw new HostDOMException(`Failed to read the 'responseText' property from 'XMLHttpRequest': The value is only accessible if the object's 'responseType' is '' or 'text' (was '${this.#s.responseType}').`, 'InvalidStateError');
                    if (this.#s.state !== LOADING && this.#s.state !== DONE || this.#s.error || !this.#s.response)
                        return '';
                    return this.#text();
                }
                get response() {
                    const s = this.#s;
                    if (s.responseType === '' || s.responseType === 'text')
                        return this.responseText;
                    if (s.state !== DONE || s.error || !s.response)
                        return null;
                    if (s.cached !== undefined)
                        return s.cached;
                    const body = s.response.body || new ArrayBuffer(0);
                    if (s.responseType === 'arraybuffer')
                        s.cached = body;
                    else if (s.responseType === 'blob')
                        s.cached = new HostBlob([body], { type: this.#mime() || '' });
                    else {
                        try { s.cached = JSON.parse(new HostTextDecoder('utf-8').decode(body)); } catch { s.cached = null; }
                    }
                    return s.cached;
                }
                #mime() {
                    if (this.#s.mime !== null)
                        return this.#s.mime;
                    return this.#s.response ? (this.#s.response.headers.find(([k]) => k.toLowerCase() === 'content-type') || [null, null])[1] : null;
                }
                #text() {
                    const m = /charset\s*=\s*"?([^";\s]+)/i.exec(this.#mime() || '');
                    let label = m ? m[1] : 'utf-8';
                    try { return new HostTextDecoder(label).decode(this.#s.response.body || new ArrayBuffer(0)); } catch { return new HostTextDecoder('utf-8').decode(this.#s.response.body || new ArrayBuffer(0)); }
                }
                #progress(target, type, loaded, total) {
                    target.dispatchEvent(new HostProgressEvent(type, { lengthComputable: total > 0, loaded, total }));
                }
                #abortRunning() {
                    const s = this.#s;
                    if (s.timer) {
                        clearTimeout(s.timer);
                        s.timer = 0;
                    }
                    s.aborted++;
                }
                #request(body, type) {
                    const s = this.#s;
                    const headers = s.headers.slice();
                    if (type && !headers.some(([k]) => k.toLowerCase() === 'content-type'))
                        headers.push(['Content-Type', type]);
                    return { url: s.url, method: s.method, headers, body: s.method === 'GET' || s.method === 'HEAD' ? null : body, mode: 'cors', credentials: s.withCredentials ? 'include' : 'same-origin', redirect: 'follow', destination: '' };
                }
                send(body) {
                    const s = this.#s;
                    if (s.state !== OPENED || s.send)
                        throw new HostDOMException("Failed to execute 'send' on 'XMLHttpRequest': The object's state must be OPENED.", 'InvalidStateError');
                    let [bytes, type, formRequest] = s.method === 'GET' || s.method === 'HEAD' ? [null, null] : bodyOf(body);
                    s.send = true;
                    s.error = false;
                    if (!s.async) {
                        if (formRequest)
                            throw new HostDOMException("Failed to execute 'send' on 'XMLHttpRequest': a synchronous request with FormData is not supported in Chitin.", 'NotSupportedError');
                        return this.#sendSync(this.#request(bytes, type));
                    }
                    const run = ++s.aborted;
                    this.#progress(this, 'loadstart', 0, 0);
                    const upload = bytes && bytes.byteLength ? bytes.byteLength : 0;
                    if (upload)
                        this.#progress(s.upload, 'loadstart', 0, upload);
                    if (s.timeout)
                        s.timer = setTimeout(() => { if (s.aborted === run) this.#fail('timeout', run); }, s.timeout);
                    (async () => {
                        if (formRequest)
                            bytes = await formRequest.arrayBuffer();
                        const reply = await ask({ t: 'net', request: this.#request(bytes, type) });
                        if (s.aborted !== run)
                            return;
                        if (reply.error) {
                            this.#fail('error', run);
                            return;
                        }
                        if (upload) {
                            this.#progress(s.upload, 'progress', upload, upload);
                            this.#progress(s.upload, 'load', upload, upload);
                            this.#progress(s.upload, 'loadend', upload, upload);
                        }
                        this.#arrive(reply.response, run);
                    })().catch(() => { if (s.aborted === run) this.#fail('error', run); });
                }
                #arrive(response, run) {
                    const s = this.#s;
                    if (s.timer) {
                        clearTimeout(s.timer);
                        s.timer = 0;
                    }
                    if (response.type === 'error' || response.type === 'opaque' || response.type === 'opaqueredirect') {
                        this.#fail('error', run);
                        return;
                    }
                    s.response = { status: response.status, statusText: response.statusText || '', headers: response.headers || [], url: response.url || s.url, body: response.body || new ArrayBuffer(0) };
                    const length = s.response.body.byteLength;
                    const steps = [
                        () => { s.state = HEADERS_RECEIVED; this.dispatchEvent(new HostEvent('readystatechange')); },
                        () => { s.state = LOADING; this.dispatchEvent(new HostEvent('readystatechange')); this.#progress(this, 'progress', length, length); },
                        () => { s.state = DONE; s.send = false; this.dispatchEvent(new HostEvent('readystatechange')); },
                        () => this.#progress(this, 'load', length, length),
                        () => this.#progress(this, 'loadend', length, length),
                    ];
                    for (const step of steps) {
                        if (s.aborted !== run)
                            return;
                        step();
                    }
                }
                #fail(kind, run) {
                    const s = this.#s;
                    if (s.timer) {
                        clearTimeout(s.timer);
                        s.timer = 0;
                    }
                    s.aborted++;
                    s.error = true;
                    s.response = null;
                    s.state = DONE;
                    s.send = false;
                    this.dispatchEvent(new HostEvent('readystatechange'));
                    this.#progress(this, kind, 0, 0);
                    this.#progress(this, 'loadend', 0, 0);
                    void run;
                }
                #sendSync(request) {
                    const s = this.#s;
                    if (!HostSAB)
                        throw new HostDOMException("Failed to execute 'send' on 'XMLHttpRequest': synchronous requests need shared memory.", 'NetworkError');
                    if (!syncSab)
                        syncSab = new HostSAB(1 << 16, { maxByteLength: SYNC_MAX });
                    const sab = syncSab;
                    const i32 = new Int32Array(sab, 0, 4);
                    const seq = ++syncSeq;
                    Atomics.store(i32, 0, 0);
                    Atomics.store(i32, 3, seq);
                    send({ t: 'net-sync', request, sab, seq });
                    const deadline = s.timeout ? Date.now() + s.timeout : Infinity;
                    while (Atomics.load(i32, 0) === 0) {
                        const left = deadline - Date.now();
                        if (left <= 0)
                            break;
                        Atomics.wait(i32, 0, 0, left === Infinity ? 60000 : left);
                    }
                    const state = Atomics.load(i32, 0);
                    if (state === 0) {
                        syncSab = null; // the answer may still come: the next request gets a buffer of its own
                        this.#syncError();
                        throw new HostDOMException("Failed to execute 'send' on 'XMLHttpRequest': The request timed out.", 'TimeoutError');
                    }
                    const metaLength = Atomics.load(i32, 1), bodyLength = Atomics.load(i32, 2);
                    const meta = metaLength ? JSON.parse(new HostTextDecoder().decode(new HostUint8Array(sab, 16, metaLength).slice())) : { type: 'error' };
                    if (state !== 1 || meta.type === 'error' || meta.type === 'opaque' || meta.type === 'opaqueredirect') {
                        this.#syncError();
                        throw new HostDOMException(`Failed to execute 'send' on 'XMLHttpRequest': Failed to load '${s.url}'.`, 'NetworkError');
                    }
                    const body = new HostUint8Array(sab, 16 + metaLength, bodyLength).slice().buffer;
                    s.response = { status: meta.status, statusText: meta.statusText || '', headers: meta.headers || [], url: meta.url || s.url, body };
                    s.state = DONE;
                    s.send = false;
                    this.dispatchEvent(new HostEvent('readystatechange'));
                    this.#progress(this, 'load', bodyLength, bodyLength);
                    this.#progress(this, 'loadend', bodyLength, bodyLength);
                }
                #syncError() {
                    const s = this.#s;
                    s.error = true;
                    s.response = null;
                    s.state = DONE;
                    s.send = false;
                    this.dispatchEvent(new HostEvent('readystatechange'));
                }
                abort() {
                    const s = this.#s;
                    this.#abortRunning();
                    if (s.state === OPENED && s.send || s.state === HEADERS_RECEIVED || s.state === LOADING) {
                        s.error = true;
                        s.response = null;
                        s.state = DONE;
                        s.send = false;
                        this.dispatchEvent(new HostEvent('readystatechange'));
                        this.#progress(this, 'abort', 0, 0);
                        this.#progress(this, 'loadend', 0, 0);
                    }
                    if (s.state === DONE) {
                        s.state = UNSENT;
                        s.response = null;
                    }
                }
            }
            eventHandler(XMLHttpRequest.prototype, 'readystatechange');
            for (const [n, v] of [['UNSENT', UNSENT], ['OPENED', OPENED], ['HEADERS_RECEIVED', HEADERS_RECEIVED], ['LOADING', LOADING], ['DONE', DONE]]) {
                defineProperty(XMLHttpRequest, n, { value: v, enumerable: true });
                defineProperty(XMLHttpRequest.prototype, n, { value: v, enumerable: true });
            }
            for (const [n, C] of [['XMLHttpRequest', XMLHttpRequest], ['XMLHttpRequestEventTarget', XMLHttpRequestEventTarget], ['XMLHttpRequestUpload', XMLHttpRequestUpload]]) {
                defineProperty(C.prototype, Symbol.toStringTag, { value: n, configurable: true });
                defineProperty(G, n, { value: C, writable: true, configurable: true });
            }
        }
        function becomeDedicated(m) {
            dedicated = true;
            const shared = m.kind === 'shared';
            moduleWorker = m.type === 'module';
            for (const n of SW_ONLY)
                delete G[n];
            const own = Object.getPrototypeOf(G);
            const workerScope = own && Object.getPrototypeOf(own);
            if (!shared)
                delete G.onconnect;
            if (own && workerScope && workerScope !== Object.prototype) {
                globalInterface('WorkerGlobalScope', workerScope);
                globalInterface(shared ? 'SharedWorkerGlobalScope' : 'DedicatedWorkerGlobalScope', own);
            }
            const name = String(m.name || '');
            defineProperty(G, 'name', { get: () => name, configurable: true, enumerable: true });
            if (!shared) {
                defineProperty(G, 'postMessage', {
                    value: function postMessage(message, transfer) {
                        sharedRefused(message, `postMessage' on '${shared ? 'SharedWorkerGlobalScope' : 'DedicatedWorkerGlobalScope'}`);
                        const list = Array.isArray(transfer) ? transfer : (transfer && transfer.transfer) || [];
                        postToHost('post', {}, message, list);
                    }, writable: true, configurable: true, enumerable: true,
                });
            } else {
                delete G.onmessage;
                delete G.onmessageerror;
            }
            installNestedWorker();
            installXHR();
            defineProperty(G, 'close', { value: function close() { send({ t: 'close' }); }, writable: true, configurable: true, enumerable: true });
            if (nativeAdd)
                nativeAdd('error', (ev) => {
                    reportUncaught(ev.error !== undefined && ev.error !== null ? ev.error : { name: 'Error', message: ev.message }, siteName(ev.filename));
                    ev.preventDefault();
                });
        }
        // Cross-origin isolation (docs/user-tests/coi.md): the runner's host Worker is always isolated (the segment origin's
        // Document-Isolation-Policy); the page's worker is as Chrome would make it (its owner's isolation, its own COEP: decided by
        // pagesw-host.js). Not isolated: crossOriginIsolated false, no SharedArrayBuffer global, shared memory refused by every
        // clone and post (DataCloneError), performance.now() on Chrome's 100 us grid instead of 5 us.
        let sharedRefused = () => undefined;
        function applyIsolation(isolated) {
            const scope = (() => { for (let o = G; o; o = Object.getPrototypeOf(o)) if (Object.prototype.hasOwnProperty.call(o, 'crossOriginIsolated')) return o; return G; })();
            const d = Object.getOwnPropertyDescriptor(scope, 'crossOriginIsolated');
            if (d && d.get) {
                const get = { get crossOriginIsolated() { return isolated; } };
                defineProperty(scope, 'crossOriginIsolated', { get: Object.getOwnPropertyDescriptor(get, 'crossOriginIsolated').get, enumerable: d.enumerable, configurable: true });
            }
            if (isolated)
                return;
            const SAB = G.SharedArrayBuffer;
            delete G.SharedArrayBuffer;
            if (!SAB)
                return;
            const sabLength = Object.getOwnPropertyDescriptor(SAB.prototype, 'byteLength').get;
            const viewBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(G.Uint8Array.prototype), 'buffer').get;
            const dvBuffer = Object.getOwnPropertyDescriptor(G.DataView.prototype, 'buffer').get;
            const WasmMemory = G.WebAssembly ? G.WebAssembly.Memory : null;
            const isSAB = (x) => { try { ReflectApply(sabLength, x, []); return true; } catch { return false; } };
            const containsShared = (value) => {
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
                        try { b = ReflectApply(viewBuffer, x, []); } catch { try { b = ReflectApply(dvBuffer, x, []); } catch { b = null; } }
                        if (b && isSAB(b))
                            return true;
                        continue;
                    }
                    if (WasmMemory && x instanceof WasmMemory) {
                        try { if (isSAB(x.buffer)) return true; } catch { /* detached */ }
                        continue;
                    }
                    if (x instanceof Map) { for (const [k, v] of x) stack.push(k, v); continue; }
                    if (x instanceof Set) { for (const v of x) stack.push(v); continue; }
                    let keys;
                    try { keys = Reflect.ownKeys(x); } catch { continue; }
                    for (const k of keys) {
                        if (typeof k === 'symbol')
                            continue;
                        const pd = Object.getOwnPropertyDescriptor(x, k);
                        if (pd && 'value' in pd && typeof pd.value === 'object')
                            stack.push(pd.value);
                    }
                }
                return false;
            };
            const refuse = (what) => new HostDOMException(`Failed to execute '${what}': SharedArrayBuffer transfer requires self.crossOriginIsolated.`, 'DataCloneError');
            // Every way out of this worker for a page value is a host clone or a host port's postMessage.
            const clone = G.structuredClone;
            if (clone) {
                const wrapped = { structuredClone(value, options) { if (containsShared(value)) throw refuse("structuredClone' on 'WorkerGlobalScope"); return ReflectApply(clone, G, arguments); } }.structuredClone;
                defineProperty(G, 'structuredClone', { value: wrapped, writable: true, enumerable: true, configurable: true });
            }
            for (const C of [G.MessagePort, G.BroadcastChannel]) {
                if (!C || !C.prototype.postMessage)
                    continue;
                const post = C.prototype.postMessage;
                const name = C.name;
                const wrapped = { postMessage(message) { if (containsShared(message)) throw refuse(`postMessage' on '${name}`); return ReflectApply(post, this, arguments); } }.postMessage;
                defineProperty(C.prototype, 'postMessage', { value: wrapped, writable: true, enumerable: true, configurable: true });
            }
            sharedRefused = (message, what) => { if (containsShared(message)) throw refuse(what); };
            const P = G.Performance && G.Performance.prototype;
            const now = P && Object.getOwnPropertyDescriptor(P, 'now');
            if (now && typeof now.value === 'function') {
                const original = now.value;
                const coarse = { now() { return Math.floor(ReflectApply(original, this, []) * 10) / 10; } }.now;
                defineProperty(P, 'now', { value: coarse, writable: now.writable, enumerable: now.enumerable, configurable: true });
            }
        }
        async function startVersion(m) {
            applyIsolation(m.isolated === true);
            if (m.kind === 'dedicated' || m.kind === 'shared') {
                becomeDedicated(m);
                scriptURL = m.scriptURL;
                const u = new HostURL(scriptURL);
                const location = Object.freeze({
                    href: u.href, origin: u.origin, protocol: u.protocol, host: u.host, hostname: u.hostname, port: u.port,
                    pathname: u.pathname, search: u.search, hash: u.hash, toString: () => u.href,
                });
                defineProperty(G, 'location', { get: () => location, configurable: true, enumerable: true });
                defineProperty(G, 'origin', { get: () => u.origin, configurable: true, enumerable: true });
                evaluating = true;
                try {
                    if (m.type === 'module')
                        await platform.runModule(m.loadURL);
                    else
                        platform.runClassic(m.loadURL);
                } catch (e) {
                    reportUncaught(e, scriptURL);
                } finally {
                    evaluating = false;
                }
                return;
            }
            delete G.onconnect;
            // A service worker's global is a ServiceWorkerGlobalScope (libraries test `'ServiceWorkerGlobalScope' in globalThis`
            // to know where they run; anura's bare-mux reached for `window` without it): the same stand-ins over the global's chain.
            {
                const own = Object.getPrototypeOf(G);
                const workerScope = own && Object.getPrototypeOf(own);
                if (own && workerScope && workerScope !== Object.prototype) {
                    globalInterface('WorkerGlobalScope', workerScope);
                    globalInterface('ServiceWorkerGlobalScope', own);
                }
            }
            scriptURL = m.scriptURL;
            regState = m.registration;
            me = m.version;
            const u = new HostURL(scriptURL);
            const location = Object.freeze({
                href: u.href, origin: u.origin, protocol: u.protocol, host: u.host, hostname: u.hostname, port: u.port,
                pathname: u.pathname, search: u.search, hash: u.hash, toString: () => u.href,
            });
            defineProperty(G, 'location', { get: () => location, configurable: true, enumerable: true });
            defineProperty(G, 'origin', { get: () => u.origin, configurable: true, enumerable: true });
            defineProperty(G, 'serviceWorker', { get: () => workerFor(me), configurable: true, enumerable: true });
            evaluating = true;
            try {
                if (m.type === 'module')
                    await platform.runModule(scriptURL);
                else
                    platform.runClassic(scriptURL);
            } finally {
                evaluating = false;
            }
        }
        async function lifecycle(type) {
            const event = new ExtendableEvent(type);
            dispatch(event);
            await event.__settle();
        }
        async function onFetch(m) {
            if (!hasFetchListener())
                return { fallback: true };
            const request = makeRequest(m.request);
            let handledResolve;
            const handled = new HostPromise((resolve) => { handledResolve = resolve; });
            const event = new FetchEvent('fetch', { request, clientId: m.clientId, resultingClientId: m.resultingClientId, handled, cancelable: true });
            dispatch(event);
            const responsePromise = event.__done();
            event.__settle().catch(reportError);
            if (!responsePromise) {
                handledResolve();
                return { fallback: true };
            }
            try {
                const response = await responsePromise;
                const transfer = [];
                const data = await responseData(response, true, transfer);
                if (data.type === 'opaque' && m.request.mode !== 'no-cors')
                    return { error: 'an opaque response for a ' + m.request.mode + ' request' };
                handledResolve();
                return { response: data, transfer };
            } catch (e) {
                handledResolve();
                return { error: String(e && e.message || e) };
            }
        }
        function onMessageEvent(m) {
            if (m.connect) {
                // A SharedWorker's connect event: a MessageEvent whose data is '' and whose ports and source are the new port.
                const p = m.ports[0];
                dispatch(new G.MessageEvent('connect', { data: null, ports: [p], source: p }));
                return;
            }
            if (dedicated) {
                const event = new G.MessageEvent('message', { data: m.data, ports: m.ports || [] });
                dispatch(event);
                return;
            }
            const event = new ExtendableMessageEvent('message', { data: m.data, origin: m.origin, source: m.source ? makeClient(m.source) : null, ports: m.ports || [] });
            dispatch(event);
            event.__settle().catch(reportError);
        }

        async function onPortMessageImpl(e) {
            const m = e.data;
            if (!m || typeof m !== 'object')
                return;
            if (m.re) {
                const w = waiting.get(m.re);
                if (w) {
                    waiting.delete(m.re);
                    w.resolve(m);
                }
                return;
            }
            const reply = (data) => send({ t: 'reply', re: m.id, ...data });
            try {
                switch (m.t) {
                case 'idb-ev':
                    idb.onEvent(m);
                    return;
                case 'api-ev':
                    storageApis.onEvent(m);
                    return;
                case 'start':
                    await startVersion(m);
                    reply({ ok: true, hasFetch: hasFetchListener() });
                    return;
                case 'install':
                case 'activate':
                    await lifecycle(m.t);
                    reply({ ok: true });
                    return;
                case 'fetch': {
                    const answer = await onFetch(m);
                    const { transfer, ...rest } = answer;
                    send({ t: 'reply', re: m.id, ...rest }, transfer || []);
                    return;
                }
                case 'nested-event': {
                    const n = nested.get(m.nid);
                    if (n)
                        n.onEvent(m, e.ports ? Array.from(e.ports).slice(0, typeof m.ports === 'number' ? m.ports : undefined) : []);
                    return;
                }
                case 'connect':
                    onMessageEvent({ connect: true, ports: e.ports ? Array.from(e.ports) : [] });
                    return;
                case 'message':
                    onMessageEvent({ ...m, ports: e.ports ? Array.from(e.ports).slice(0, typeof m.ports === 'number' ? m.ports : undefined) : [] });
                    return;
                case 'ws':
                    onWebSocketMessage(m);
                    return;
                case 'bc':
                    deliverBroadcast(String(m.name), m.data, null);
                    return;
                case 'state':
                    regState = m.registration;
                    if (m.version)
                        me = m.version;
                    for (const w of workers.values()) {
                        const v = [regState.installing, regState.waiting, regState.active].find((x) => x && x.id === w.__v.id);
                        if (v)
                            w.__v = v;
                        else if (w.__v.state !== 'redundant')
                            w.__v = { ...w.__v, state: 'redundant' };
                    }
                    return;
                default:
                    return;
                }
            } catch (err) {
                reply({ ok: false, error: String(err && err.stack || err) });
            }
        }

    onPortMessage = onPortMessageImpl;
    }

    // The service worker's global is made only after the platform removed the host's doors (they would delete this
    // file's fetch, caches and importScripts) and passed its allowlist check (it would not know these names).
    platform.start().then((p) => {
        port = p;
        main();
        if ('onmessage' in port || typeof port.addEventListener !== 'function')
            port.onmessage = onPortMessage;
        else
            port.addEventListener('message', onPortMessage);
        if (typeof port.start === 'function')
            port.start();
        port.postMessage({ t: 'ready' });
    });
    void HostTextEncoder;
})();
