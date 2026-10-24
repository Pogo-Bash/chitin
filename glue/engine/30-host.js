// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin engine glue: the host side of ganglion.wasm. Holds the instance and its memory privately,
// answers the engine's requests (fetch, image decoding, navigation, title, frame requests) through the
// callbacks the segment host passed to boot(), and offers the segment host the engine's entry points.
// Nothing here is reachable from page JS: the host keeps the returned object in its closure.

const Uint8ClampedArray_ = globalThis.Uint8ClampedArray;
const HostImageData = globalThis.ImageData;
const HostPromise = globalThis.Promise;
const PromisePrototypeThen = uncurryThis(HostPromise.prototype.then);
const ArrayPrototypeShift = uncurryThis(globalThis.Array.prototype.shift);
const TypedArrayPrototypeSet = uncurryThis(Uint8ClampedArray_.prototype.set);
const TypedArrayPrototypeSubarray = uncurryThis(globalThis.Uint8Array.prototype.subarray);

let X;            // the engine's exports
let memory;
let u8, u32, f64; // views over linear memory, refreshed after growth
let viewBuffer;
let callbacks;    // the segment host's callbacks
let instance;
const pendingFetches = { __proto__: null };
let pendingHostFetches = 0; // answered by the host but not yet handed to the engine count as pending
const pendingImages = { __proto__: null };
let engineLog = (text) => { if (hostConsoleError) hostConsoleError(hostConsole, text); };
let lastFatalLog = null; // the VERIFICATION FAILED / FATAL line before a trap, if the engine printed one

function refreshEngineViews() {
    const buffer = WebAssemblyMemoryPrototypeGetBuffer(memory);
    if (buffer === viewBuffer)
        return;
    viewBuffer = buffer;
    u8 = new (globalThis.Uint8Array)(buffer);
    u32 = new Uint32Array(buffer);
    f64 = new Float64Array(buffer);
}

function views() {
    refreshEngineViews();
}

// A C string out of linear memory, by indexing only (a copy, decoded with a captured TextDecoder).
function cString(ptr) {
    views();
    let end = ptr;
    while (u8[end] !== 0)
        end++;
    return bytesToString(ptr, end - ptr);
}

const decoderUtf8 = new TextDecoder('utf-8');
const Uint8ArraySlice = uncurryThis(globalThis.Uint8Array.prototype.slice);
function bytesToString(ptr, len) {
    views();
    const copy = new (globalThis.Uint8Array)(len);
    for (let i = 0; i < len; i++)
        copy[i] = u8[ptr + i];
    return TextDecoderPrototypeDecode(decoderUtf8, copy);
}

function utf16ToString(ptr, len) {
    views();
    let s = '';
    const base = ptr >>> 1;
    const u16 = new Uint16Array(viewBuffer);
    for (let i = 0; i < len; i++)
        s += StringFromCharCode(u16[base + i]);
    return s;
}

// Copies bytes into engine memory the engine owns (ganglion_alloc); the caller frees them after the call.
function copyIn(bytes) {
    const len = bytes.length;
    const ptr = X.ganglion_alloc(len + 1);
    views();
    for (let i = 0; i < len; i++)
        u8[ptr + i] = bytes[i];
    u8[ptr + len] = 0;
    return ptr;
}

const encoderUtf8 = new (globalThis.TextEncoder)();
const TextEncoderPrototypeEncode = uncurryThis(globalThis.TextEncoder.prototype.encode);
function copyInString(s) {
    return copyIn(TextEncoderPrototypeEncode(encoderUtf8, s));
}

function engineState() {
    return {
        __proto__: null,
        u8: () => (views(), u8),
        u32: () => (views(), u32),
        f64: () => (views(), f64),
        buffer: () => (views(), viewBuffer),
        memory: () => memory,
        refreshViews: refreshEngineViews,
        log: (text) => engineLog(text),
        cString,
    };
}

// --- The imports the engine asks the host for ------------------------------------------------------

// One task, then the microtasks (docs/crypto.md). The engine's event loop runs a task and then its microtask checkpoint, but
// page JavaScript is the host's V8 and its promise jobs and queueMicrotask callbacks run only when the host's stack unwinds.
// So once page code has run (a call, a construct, a script, a property access that can reach page code, a promise settled
// by the engine) the engine runs nothing more (ganglion_host_turn_pending) until a host task of ours, which runs after the
// host's microtasks: it clears the mark and pumps again. Before, one pump ran several tasks (two timers, a timer and a
// message, a crypto result) and all their microtasks came after the last of them.
let hostJsTouched = 0;
let hostTurnPosted = false;
let hostTurnPort = null;
function hostTurn() {
    hostTurnPosted = false;
    hostJsTouched = 0;
    if (stoppedReason !== null)
        return;
    try {
        if (callbacks.afterEngineCall)
            callbacks.afterEngineCall();
        else
            api.pump();
    } catch (e) {
        // The engine stopped in this turn: options.stopped has said why, once; the refusal that unwound the turn is not a
        // second error.
        if (stoppedReason === null)
            throw e;
    }
}
function postHostTurn() {
    if (hostTurnPosted)
        return;
    hostTurnPosted = true;
    if (hostTurnPort === null && HostMessageChannel !== null) {
        const channel = new HostMessageChannel();
        const receiver = MessageChannelPort2(channel);
        MessagePortSetOnmessage(receiver, hostTurn);
        hostTurnPort = MessageChannelPort1(channel);
        // Node: an idle channel must not keep the process alive.
        if (typeof receiver.unref === 'function')
            receiver.unref();
        if (typeof hostTurnPort.unref === 'function')
            hostTurnPort.unref();
    }
    if (hostTurnPort !== null)
        MessagePortPostMessage(hostTurnPort, 0);
    else
        hostSetTimeout(hostTurn, 0);
}
function makeHostImports() {
    const env = { __proto__: null };
    env.ganglion_host_turn_pending = () => {
        if (hostJsTouched === 0)
            return 0;
        postHostTurn();
        return 1;
    };
    env.ganglion_host_log = (ptr, len) => {
        const text = bytesToString(ptr, len);
        // The engine's last words before a trap (AK's VERIFY and FATAL print, then hit unreachable).
        if (StringPrototypeIncludes(text, 'VERIFICATION FAILED') || StringPrototypeIncludes(text, 'FATAL'))
            lastFatalLog = text;
        engineLog(text);
    };
    // The host may answer a fetch itself (a promise of { status, headers, body }: the harness's stand-in for
    // the test sites, or a page service worker's response) or decline with null, and then the engine fetches over its own
    // network (TCP below). A promise that resolves to null hands the fetch back to the engine's network then (a page service
    // worker that did not call respondWith). The second argument is the rest of the request (describeRequest).
    env.ganglion_host_fetch = (id, urlPtr, urlLen, requestPtr, requestLen, bodyPtr, bodyLen) => {
        const url = bytesToString(urlPtr, urlLen);
        let promise;
        try {
            promise = callbacks.fetch ? callbacks.fetch(url, describeRequest(requestPtr, requestLen, bodyPtr, bodyLen)) : null;
        } catch (e) {
            pendingFetches[id] = url;
            scheduleFetchFailure(id, String(e));
            return 1;
        }
        if (promise === null || promise === undefined)
            return 0;
        pendingFetches[id] = url;
        pendingHostFetches++;
        // The host's fetch runs outside the engine; its result comes back through fetchDone() in a later task.
        PromisePrototypeThen(promise,
            (result) => {
                if (pendingFetches[id] === undefined)
                    return;
                if (result === null || result === undefined)
                    api.fetchNetwork(id);
                else if (typeof result.read === 'function')
                    api.fetchStreamed(id, result.status, result.headers, result.read);
                else
                    api.fetchDone(id, result.status, result.headers, result.body);
            },
            (error) => { if (pendingFetches[id] !== undefined) api.fetchFailed(id, String(error && error.message || error)); });
        return 1;
    };
    env.ganglion_host_net_done = (id, status, headersPtr, headersLen, bodyPtr, bodyLen, errorPtr, errorLen) => {
        const waiter = pendingNetRequests[id];
        if (waiter === undefined)
            return;
        delete pendingNetRequests[id];
        if (errorLen) {
            waiter.reject(bytesToString(errorPtr, errorLen));
            return;
        }
        const body = new (globalThis.Uint8Array)(bodyLen);
        views();
        for (let i = 0; i < bodyLen; i++)
            body[i] = u8[bodyPtr + i];
        waiter.resolve({ __proto__: null, status, headers: headerLines(headersLen ? bytesToString(headersPtr, headersLen) : ''), body });
    };
    // Tunnels (api.tunnelOpen): the host's handlers run in a task of their own, in order, never inside the engine's call.
    env.ganglion_host_tunnel_open = (id, status, reasonPtr, reasonLen, headersPtr, headersLen) => {
        const reason = bytesToString(reasonPtr, reasonLen);
        const headers = headerLines(headersLen ? bytesToString(headersPtr, headersLen) : '');
        tunnelEvent(id, 'onOpen', status, reason, headers);
    };
    env.ganglion_host_tunnel_data = (id, ptr, len) => {
        tunnelEvent(id, 'onData', copyOutBytes(ptr, len));
    };
    env.ganglion_host_tunnel_close = (id, errPtr, errLen) => {
        tunnelEvent(id, 'onClose', errLen ? bytesToString(errPtr, errLen) : '');
    };
    // TCP streams for the engine's own network: the host (Spiracle through the segment) opens them and
    // reports back through tcpOpened / tcpData / tcpClosed. `callbacks.net` is { connect, write, close }.
    env.ganglion_host_tcp_connect = (id, hostPtr, hostLen, port) => {
        const host = bytesToString(hostPtr, hostLen);
        if (!callbacks.net) {
            hostSetTimeout(() => api.tcpClosed(id, 3), 0);
            return;
        }
        callbacks.net.connect(id, host, port);
    };
    // A synchronous stream (Network.cpp: opened inside a nested wait, a synchronous XMLHttpRequest). Its events come back
    // through callbacks.net.waitSync while the engine's thread is blocked; a host without that opens it as an ordinary one
    // (and the wait ends only by the engine's timeouts, as before).
    env.ganglion_host_tcp_connect_sync = (id, hostPtr, hostLen, port) => {
        const host = bytesToString(hostPtr, hostLen);
        if (!callbacks.net) {
            hostSetTimeout(() => api.tcpClosed(id, 3), 0);
            return;
        }
        if (typeof callbacks.net.connectSync === 'function')
            callbacks.net.connectSync(id, host, port);
        else
            callbacks.net.connect(id, host, port);
    };
    // The nested wait (EventLoop.cpp): blocks for at most `ms` (-1: no timer armed) until a synchronous stream has events,
    // delivers them into the engine here, inside the call, and returns how many.
    env.ganglion_host_wait = (ms) => {
        if (!callbacks.net || typeof callbacks.net.waitSync !== 'function')
            return 0;
        const events = callbacks.net.waitSync(ms);
        if (!events)
            return 0;
        for (let i = 0; i < events.length; i++) {
            const e = events[i];
            if (e.t === 'open')
                X.ganglion_tcp_opened(e.s);
            else if (e.t === 'data') {
                const ptr = copyIn(e.b);
                try {
                    X.ganglion_tcp_data(e.s, ptr, e.b.length);
                } finally {
                    X.ganglion_free(ptr);
                }
            } else if (e.t === 'close')
                X.ganglion_tcp_closed(e.s, e.code | 0);
        }
        return events.length;
    };
    env.ganglion_host_tcp_write = (id, ptr, len) => {
        if (!callbacks.net)
            return;
        callbacks.net.write(id, copyOutBytes(ptr, len));
    };
    env.ganglion_host_tcp_close = (id) => {
        if (callbacks.net)
            callbacks.net.close(id);
    };
    env.ganglion_host_isolation = (isolated) => {
        setPageIsolation(isolated !== 0);
    };
    env.ganglion_host_navigated = (urlPtr, urlLen, status, errPtr, errLen) => {
        if (!errLen)
            cookieJarOf().setTopDocument(bytesToString(urlPtr, urlLen));
        if (callbacks.navigated)
            callbacks.navigated(bytesToString(urlPtr, urlLen), status, errLen ? bytesToString(errPtr, errLen) : null);
    };
    env.ganglion_host_decode_image = (id, ptr, len) => {
        views();
        const copy = new (globalThis.Uint8Array)(len);
        for (let i = 0; i < len; i++)
            copy[i] = u8[ptr + i];
        pendingImages[id] = true;
        let promise;
        try {
            promise = callbacks.decodeImage(copy);
        } catch (e) {
            scheduleImageFailure(id);
            return;
        }
        PromisePrototypeThen(promise,
            (image) => { if (pendingImages[id]) api.imageDone(id, image); },
            () => { if (pendingImages[id]) api.imageFailed(id); });
    };
    // A fallback font subset the engine needs (engine/platform/Fonts.cpp), asked for once: the host's loader answers
    // its bytes (from its cache or the carapace origin); the engine lays the text out again when they arrive.
    env.ganglion_host_load_fallback_font = (id, ptr, len) => {
        const file = bytesToString(ptr, len);
        const loader = fallbackFontLoader;
        if (!loader)
            return;
        hostSetTimeout(() => {
            let promise;
            try {
                promise = loader(file);
            } catch (e) {
                return;
            }
            PromisePrototypeThen(promise, (bytes) => { if (bytes) api.addFallbackFont(id, bytes); }, () => {});
        }, 0);
    };
    env.ganglion_host_navigate = (ptr, len) => {
        const url = bytesToString(ptr, len);
        if (callbacks.navigate)
            callbacks.navigate(url);
    };
    // A classic script just ran (Host.cpp, patch 0023): its microtasks run on the host's queue after the stack unwinds, and
    // document.currentScript stays that script until then. The host says when: a task of its own runs after the microtasks.
    env.ganglion_host_microtask_turn_end_request = () => {
        if (callbacks.afterMicrotasks)
            callbacks.afterMicrotasks(() => api.microtaskTurnEnd());
    };
    // Fullscreen, pointer lock and gamepad effects (Host.cpp; docs/webrtc.md): the carapace owns the host's and answers.
    env.ganglion_host_fullscreen = (enter) => {
        if (callbacks.fullscreen)
            callbacks.fullscreen(enter !== 0);
        else
            HostQueueMicrotask(() => api.fullscreenChanged(false)); // no host: refused, as a window that cannot go fullscreen
    };
    env.ganglion_host_pointer_lock = (kind) => {
        if (callbacks.pointerLock)
            callbacks.pointerLock(kind);
        else if (kind !== 0)
            HostQueueMicrotask(() => api.pointerLockResult(0, 1));
    };
    env.ganglion_host_gamepad_effect = (handle, kind, strong, weak, duration) => {
        if (callbacks.gamepadEffect)
            callbacks.gamepadEffect(handle >>> 0, kind, strong & 0xffff, weak & 0xffff, duration >>> 0);
    };
    env.ganglion_host_title = (ptr, len) => {
        if (callbacks.title)
            callbacks.title(utf16ToString(ptr, len));
    };
    // localStorage (Host.cpp): changed since the host last took it; and the data the host asked for. The host persists
    // it (the Worker: its IndexedDB, before the segment can be replaced by the next document).
    env.ganglion_host_storage_changed = () => {
        if (callbacks.storageChanged)
            callbacks.storageChanged();
    };
    env.ganglion_host_storage_data = (ptr, len) => {
        const text = utf16ToString(ptr, len);
        const entries = [];
        for (let at = 0; at + 4 <= text.length;) {
            const keyLength = text.charCodeAt(at) | (text.charCodeAt(at + 1) << 16);
            const valueLength = text.charCodeAt(at + 2) | (text.charCodeAt(at + 3) << 16);
            at += 4;
            entries[entries.length] = [text.slice(at, at + keyLength), text.slice(at + keyLength, at + keyLength + valueLength)];
            at += keyLength + valueLength;
        }
        if (callbacks.storage)
            callbacks.storage(entries);
    };
    // Whether a frame at `url` in the document at `documentUrl` is on another site: such a frame is a nested segment of
    // the carapace's (glue/engine/50-frames.js lists it), so the engine does not load it. The same rule as the listing.
    env.ganglion_host_frame_is_remote = (urlPtr, urlLen, documentPtr, documentLen) => {
        const site = urlSite(bytesToString(urlPtr, urlLen));
        const own = urlSite(bytesToString(documentPtr, documentLen));
        return site !== null && own !== null && site !== own ? 1 : 0;
    };
    // Cookies (docs/cookies.md): the Cookie header of a request the engine sends, or document.cookie (context "script"); and
    // a response's Set-Cookie lines or one document.cookie write. The jar is glue/cookies.js (cookieJarOf).
    env.ganglion_host_cookie_get = (urlPtr, urlLen, ctxPtr, ctxLen, outPtr) => {
        const url = bytesToString(urlPtr, urlLen);
        const ctx = cookieContext(bytesToString(ctxPtr, ctxLen));
        let text;
        try {
            if (ctx.kind === 'cookiestore') {
                // The Cookie Store API (Host.cpp): name and value of each cookie document.cookie would see, NUL-separated.
                const list = cookieJarOf().listForScript(url);
                text = '';
                for (let i = 0; i < list.length; i++)
                    text += (i ? '\0' : '') + list[i].name + '\0' + list[i].value;
                if (list.length === 0)
                    return 0;
            } else {
                text = ctx.kind === 'script' ? cookieJarOf().forScript(url) : cookieJarOf().header(url, ctx);
            }
        } catch (e) {
            engineLog('cookies: ' + HostString(e && e.message || e));
            text = '';
        }
        if (text === '')
            return 0;
        const bytes = TextEncoderPrototypeEncode(encoderUtf8, text);
        const len = TypedArrayLength(bytes);
        const ptr = X.ganglion_alloc(len + 1);
        views();
        for (let i = 0; i < len; i++)
            u8[ptr + i] = bytes[i];
        u8[ptr + len] = 0;
        u32[outPtr >>> 2] = ptr;
        return len;
    };
    env.ganglion_host_cookie_set = (urlPtr, urlLen, ctxPtr, ctxLen, linesPtr, linesLen) => {
        const url = bytesToString(urlPtr, urlLen);
        const ctx = cookieContext(bytesToString(ctxPtr, ctxLen));
        const text = bytesToString(linesPtr, linesLen);
        try {
            cookieJarOf().store(url, ctx.kind === 'script' ? text : CookieStringSplit(text, '\n'), ctx);
        } catch (e) {
            engineLog('cookies: ' + HostString(e && e.message || e));
        }
    };
    env.ganglion_host_idb_persist = (ptr, len) => {
        if (!callbacks.idbPersist)
            return;
        views();
        const entry = Uint8ArraySlice(u8, ptr, ptr + len);
        try {
            callbacks.idbPersist(entry);
        } catch (e) {
            engineLog('IndexedDB persistence: ' + HostString(e && e.message || e));
        }
    };
    env.ganglion_host_request_frame = () => {
        if (callbacks.requestFrame)
            callbacks.requestFrame();
    };
    addMediaImports(env);
    addWebGLImports(env);
    return env;
}

// --- Cookies (docs/cookies.md) ---------------------------------------------------------------------------------------------
// The segment's jar (glue/cookies.js): made on first use from options.cookies (the carapace's records and the segment's place:
// its site, nested or not, the top-level site of a nested segment, the initiator of its first navigation). Node tests that
// give none get a jar of the first document's site.
let cookieJar = null;
const TypedArrayLength = uncurryThis(ObjectGetOwnPropertyDescriptor(ObjectGetPrototypeOf(globalThis.Uint8Array.prototype), 'length').get);
const CookieStringSplit = uncurryThis(HostString.prototype.split);
function cookieJarOf() {
    if (cookieJar === null)
        cookieJar = ChitinCookies.createJar(callbacks && callbacks.cookies ? callbacks.cookies : null);
    return cookieJar;
}
// "kind\nmethod" (Network.h cookie_header) or "script".
function cookieContext(text) {
    const nl = StringPrototypeIndexOf(text, '\n');
    return { __proto__: null, kind: nl < 0 ? text : StringPrototypeSlice(text, 0, nl), method: nl < 0 ? 'GET' : StringPrototypeSlice(text, nl + 1) };
}

// "name: value" lines into [[name, value], ...] (repeated names stay apart: Set-Cookie).
function headerLines(text) {
    const out = [];
    let at = 0;
    while (at < text.length) {
        let end = StringPrototypeIndexOf(text, '\n', at);
        if (end < 0)
            end = text.length;
        const line = StringPrototypeSlice(text, at, end);
        at = end + 1;
        const colon = StringPrototypeIndexOf(line, ':');
        if (colon > 0)
            out[out.length] = [StringPrototypeTrim(StringPrototypeSlice(line, 0, colon)), StringPrototypeTrim(StringPrototypeSlice(line, colon + 1))];
    }
    return out;
}

// The request behind a ganglion_host_fetch (Host.cpp): method, mode, destination, credentials, navigation, the client's
// document URL, headers, body.
function describeRequest(ptr, len, bodyPtr, bodyLen) {
    const text = len ? bytesToString(ptr, len) : 'GET\nno-cors\n\nomit\n-\n\n';
    const lines = [];
    let at = 0;
    for (let i = 0; i < 6; i++) {
        let end = StringPrototypeIndexOf(text, '\n', at);
        if (end < 0)
            end = text.length;
        lines[i] = StringPrototypeSlice(text, at, end);
        at = end + 1;
    }
    const body = new (globalThis.Uint8Array)(bodyLen);
    if (bodyLen) {
        views();
        for (let i = 0; i < bodyLen; i++)
            body[i] = u8[bodyPtr + i];
    }
    return { __proto__: null, method: lines[0], mode: lines[1], destination: lines[2], credentials: lines[3], navigate: lines[4] === 'navigate', client: lines[5], headers: headerLines(StringPrototypeSlice(text, at)), body };
}

const pendingNetRequests = { __proto__: null };
let nextNetRequest = 1;

const hostSetTimeout = globalThis.setTimeout;
const tunnels = { __proto__: null };
let nextTunnel = 1;
const tunnelQueue = [];
function tunnelEvent(id, name, a, b, c) {
    tunnelQueue[tunnelQueue.length] = [id, name, a, b, c];
    if (tunnelQueue.length === 1)
        hostSetTimeout(drainTunnelEvents, 0);
}
function drainTunnelEvents() {
    // One event at a time, the handlers' own throws contained: a page's handler failing must not strand the rest.
    while (tunnelQueue.length) {
        const [id, name, a, b, c] = ArrayPrototypeShift(tunnelQueue);
        const t = tunnels[id];
        if (t === undefined)
            continue;
        if (name === 'onClose')
            delete tunnels[id];
        try { t[name](a, b, c); } catch (e) { engineLog('tunnel handler ' + name + ': ' + (e && e.stack || e)); }
    }
}
function scheduleFetchFailure(id, message) {
    hostSetTimeout(() => api.fetchFailed(id, message), 0);
}
function scheduleImageFailure(id) {
    hostSetTimeout(() => api.imageFailed(id), 0);
}

// --- The API the segment host gets ------------------------------------------------------------------

const api = { __proto__: null };
// The jar for the host's own requests (WebSocket handshakes, a page worker's fetch) and the carapace's changes (docs/cookies.md).
api.cookies = ObjectFreeze({
    __proto__: null,
    header: (url, ctx) => cookieJarOf().header(url, ctx),
    store: (url, lines, ctx) => cookieJarOf().store(url, lines, ctx),
    forScript: (url) => cookieJarOf().forScript(url),
    listForScript: (url) => cookieJarOf().listForScript(url),
    apply: (list) => cookieJarOf().apply(list),
    all: () => cookieJarOf().all(),
    flush: () => cookieJarOf().flush(),
});

// ICU's common data, before start(); the engine keeps its own copy.
api.setIcuData = (bytes) => {
    const ptr = copyIn(bytes);
    X.ganglion_set_icu_data(ptr, bytes.length);
    X.ganglion_free(ptr);
};

api.addFont = (bytes) => {
    const ptr = copyIn(bytes);
    X.ganglion_add_font(ptr, bytes.length);
    X.ganglion_free(ptr);
};

// The fallback fonts (docs/fonts.md): the manifest's bytes, the host's languages (navigator.languages) and a loader,
// file name -> Promise<Uint8Array>, for the subsets. Before start().
let fallbackFontLoader = null;
api.setFallbackFonts = (manifest, languages, loader) => {
    fallbackFontLoader = loader;
    const ptr = copyIn(manifest);
    let langs = '';
    for (let i = 0; languages && i < languages.length; i++)
        langs += (i ? ',' : '') + languages[i];
    const langPtr = copyInString(langs);
    X.ganglion_set_fallback_fonts(ptr, manifest.length, langPtr, TextEncoderPrototypeEncode(encoderUtf8, langs).length);
    X.ganglion_free(ptr);
    X.ganglion_free(langPtr);
};

api.addFallbackFont = (id, bytes) => {
    const ptr = copyIn(bytes);
    X.ganglion_add_fallback_font(id, ptr, bytes.length);
    X.ganglion_free(ptr);
};

// [subsets asked for, subsets installed].
api.fallbackFontCounts = () => {
    const packed = X.ganglion_fallback_font_counts() >>> 0;
    return [packed >>> 16, packed & 0xffff];
};

// A header of a response's headers given as an object (name -> value) or as [name, value] pairs; null when absent.
function headerValue(headers, name) {
    if (ArrayIsArray(headers)) {
        for (let i = 0; i < headers.length; i++)
            if (ArrayIsArray(headers[i]) && StringPrototypeToLowerCase(HostString(headers[i][0])) === name)
                return HostString(headers[i][1]);
        return null;
    }
    const keys = ObjectKeys(headers);
    for (let i = 0; i < keys.length; i++)
        if (StringPrototypeToLowerCase(keys[i]) === name)
            return HostString(headers[keys[i]]);
    return null;
}
// A nested segment's cross-origin isolation as its parent's iframe earns it (Host.cpp ganglion_set_embedder_isolation).
api.setEmbedderIsolation = (isolated, parentCoep, parentOrigin) => {
    const text = HostString(parentOrigin || '');
    const ptr = copyInString(text);
    try {
        X.ganglion_set_embedder_isolation(isolated ? 1 : 0, parentCoep === 'require-corp' ? 1 : parentCoep === 'credentialless' ? 2 : 0, ptr, TextEncoderPrototypeEncode(encoderUtf8, text).length);
    } finally {
        X.ganglion_free(ptr);
    }
};
// The embedder policy of the document of `global` (the page's window, or a same-site frame realm's global; anything else: the
// page's): 'unsafe-none', 'require-corp' or 'credentialless'.
api.embedderPolicyOf = (global) => {
    let realm = 0;
    const cell = global !== undefined && global !== null ? WeakMapPrototypeGet(cellOf, global) : undefined;
    if (cell !== undefined && cell !== 0) {
        const mark = scratchTop;
        const o = slots(1);
        writeObject(o, cell);
        realm = X.ganglion_js_realm_of(o);
        scratchTop = mark;
    }
    const v = X.ganglion_realm_embedder_policy(realm);
    return v === 1 ? 'require-corp' : v === 2 ? 'credentialless' : 'unsafe-none';
};
api.start = () => {
    X.ganglion_start();
};

api.load = (url, bytes, mime, headers) => {
    // The response's headers that set the document's policies (COOP, COEP: docs/user-tests/coi.md), as "name: value" lines.
    if (headers && typeof headers === 'object') {
        let text = '';
        const names = ['cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-embedder-policy-report-only', 'cross-origin-resource-policy'];
        for (let i = 0; i < names.length; i++) {
            const v = headerValue(headers, names[i]);
            if (v !== null)
                text += names[i] + ': ' + v + '\n';
        }
        const ptr = copyInString(text);
        try {
            X.ganglion_set_next_document_headers(ptr, TextEncoderPrototypeEncode(encoderUtf8, text).length);
        } finally {
            X.ganglion_free(ptr);
        }
    }
    const urlPtr = copyInString(url);
    const bodyPtr = copyIn(bytes);
    const mimePtr = copyInString(mime || 'text/html');
    try {
        X.ganglion_load(urlPtr, TextEncoderPrototypeEncode(encoderUtf8, url).length, bodyPtr, bytes.length, mimePtr, TextEncoderPrototypeEncode(encoderUtf8, mime || 'text/html').length);
    } finally {
        X.ganglion_free(urlPtr);
        X.ganglion_free(bodyPtr);
        X.ganglion_free(mimePtr);
    }
};

// localStorage: the host takes the engine's copy (callbacks.storage(entries) receives [[key, value], ...]), and gives
// back what it persisted before the first document.
api.storageFlush = () => {
    X.ganglion_storage_flush();
};
// IndexedDB across reloads: the journal entries the segment kept (Uint8Arrays, oldest first), each replayed in turn (a damaged
// one is skipped and reported); then the state as one snapshot entry, which replaces them (compaction). After start(), before
// the first navigation.
api.idbRestore = (entries) => {
    let applied = 0, failed = 0;
    if (typeof X.ganglion_idb_import !== 'function')
        return { applied, failed: entries.length };
    for (const entry of entries) {
        const ptr = copyIn(entry);
        const r = X.ganglion_idb_import(ptr, entry.length);
        X.ganglion_free(ptr);
        if (r === 0)
            applied++;
        else
            failed++;
    }
    return { applied, failed };
};
api.idbSnapshot = () => {
    const out = X.ganglion_alloc(4);
    const len = X.ganglion_idb_export(out);
    views();
    const ptr = u32[out >>> 2];
    const bytes = Uint8ArraySlice(u8, ptr, ptr + len);
    X.ganglion_free(ptr);
    X.ganglion_free(out);
    return bytes;
};

api.storageRestore = (entries) => {
    let packed = '';
    for (let i = 0; i < entries.length; i++) {
        const key = entries[i][0], value = entries[i][1];
        packed += StringFromCharCode(key.length & 0xFFFF, key.length >>> 16, value.length & 0xFFFF, value.length >>> 16) + key + value;
    }
    const ptr = stringToEngine(packed);
    try {
        X.ganglion_storage_restore(ptr, packed.length);
    } finally {
        X.ganglion_free(ptr);
    }
};

// The trust store for TLS: a PEM bundle (Mozilla's CA certificates), before the first https request.
api.setCaBundle = (bytes) => {
    const ptr = copyIn(bytes);
    try {
        X.ganglion_set_ca_bundle(ptr, bytes.length);
    } finally {
        X.ganglion_free(ptr);
    }
};

// Loads `url` over the engine's own network (redirects followed; an error page on failure). The outcome
// arrives through callbacks.navigated(finalUrl, status, errorOrNull).
api.navigate = (url) => {
    const ptr = copyInString(url);
    try {
        X.ganglion_navigate(ptr, TextEncoderPrototypeEncode(encoderUtf8, url).length);
    } finally {
        X.ganglion_free(ptr);
    }
    api.pump();
};

// Events of the host's TCP streams.
// `peer`: the address the stream connected to, when the host knows it (HTTP/2 connection pooling needs it).
api.tcpOpened = (id, peer) => {
    if (typeof peer === 'string' && peer.length > 0 && typeof X.ganglion_tcp_peer === 'function') {
        const bytes = TextEncoderPrototypeEncode(encoderUtf8, peer);
        const ptr = copyIn(bytes);
        try {
            X.ganglion_tcp_peer(id, ptr, bytes.length);
        } finally {
            X.ganglion_free(ptr);
        }
    }
    X.ganglion_tcp_opened(id);
    api.pump();
};
api.tcpData = (id, bytes) => {
    const ptr = copyIn(bytes);
    try {
        X.ganglion_tcp_data(id, ptr, bytes.length);
    } finally {
        X.ganglion_free(ptr);
    }
    api.pump();
};
api.tcpClosed = (id, reason) => {
    X.ganglion_tcp_closed(id, reason | 0);
    api.pump();
};

// The engine's execution context stack as text (a debugging aid: Host.cpp ganglion_debug_context_stack).
api.contextStack = () => (typeof X.ganglion_debug_context_stack === 'function' ? cString(X.ganglion_debug_context_stack()) : '');

// Exports wrapped so that the first outermost call leaving the execution context stack non-empty is reported
// (options.debugContexts; never on in a shipped segment).
function contextCheckedExports(exports, report) {
    const wrapped = { __proto__: null };
    let depth = 0;
    let entered = 0; // ganglion_js_enter leaves one context pushed until its ganglion_js_leave
    let reported = false;
    const skip = new Set(['ganglion_debug_context_depth', 'ganglion_debug_context_stack', 'memory', 'ganglion_malloc', 'ganglion_free']);
    for (const name of Object.keys(exports)) {
        const f = exports[name];
        if (typeof f !== 'function' || skip.has(name)) {
            wrapped[name] = f;
            continue;
        }
        wrapped[name] = function () {
            depth++;
            if (name === 'ganglion_js_leave' || name === 'ganglion_js_leave_deferring_microtasks')
                entered--;
            try {
                return ReflectApply(f, undefined, arguments);
            } catch (e) {
                // A host exception that unwound through the engine's frames: no C++ cleanup ran under it.
                if (!reported && report)
                    report('ganglion: an exception unwound through ' + name + ' at depth ' + depth + ': ' + (e && e.stack ? e.stack : String(e)), name, '');
                throw e;
            } finally {
                depth--;
                if (name === 'ganglion_js_enter' || name === 'ganglion_js_enter_realm')
                    entered++;
                if (depth === 0 && !reported && exports.ganglion_debug_context_depth() !== entered) {
                    reported = true;
                    views();
                    const text = cString(exports.ganglion_debug_context_stack());
                    const message = 'ganglion: execution contexts left on the stack after ' + name + ':\n' + text;
                    if (report) report(message, name, text);
                    else console.error(message);
                }
            }
        };
    }
    return wrapped;
}

// A deliberate verification failure in the engine (tests of the host's handling of a stopped engine).
api.debugTrap = () => {
    X.ganglion_debug_trap();
};

// { bytesReceived, bytesSent, connections, tlsHandshakes, tlsHandshakeMs, tlsHandshakeCpuMs, requests, failures, caCertificates }
api.netStats = () => ({ __proto__: null,
    bytesReceived: X.ganglion_net_stats(0), bytesSent: X.ganglion_net_stats(1), connections: X.ganglion_net_stats(2),
    tlsHandshakes: X.ganglion_net_stats(3), tlsHandshakeMs: X.ganglion_net_stats(4), tlsHandshakeCpuMs: X.ganglion_net_stats(5),
    requests: X.ganglion_net_stats(6), failures: X.ganglion_net_stats(7), caCertificates: X.ganglion_net_stats(8), inFlight: X.ganglion_net_stats(9),
    h2Connections: X.ganglion_net_stats(11), h2Streams: X.ganglion_net_stats(12), h2Pooled: X.ganglion_net_stats(13) });

// What a host name resolves to, as the host learned it (an array of address strings; empty forgets it): with the stream's
// peer address, what HTTP/2 connection pooling decides by.
api.netDns = (host, addresses) => {
    const hostBytes = TextEncoderPrototypeEncode(encoderUtf8, String(host));
    let list = '';
    for (let i = 0; i < addresses.length; i++)
        list += String(addresses[i]) + '\n';
    const listBytes = TextEncoderPrototypeEncode(encoderUtf8, list);
    const hostPtr = copyIn(hostBytes);
    const listPtr = copyIn(listBytes);
    try {
        X.ganglion_net_dns(hostPtr, hostBytes.length, listPtr, listBytes.length);
    } finally {
        X.ganglion_free(hostPtr);
        X.ganglion_free(listPtr);
    }
};

// Logs every connection and waiting request through the engine log (a stuck page).
api.netDump = () => { X.ganglion_net_stats(10); };

// Host fetches the engine has not received the answer to yet (a resolved promise still counts until its
// reaction has delivered the bytes): a host that waits for the engine to settle waits for this too.
api.pendingHostFetches = () => pendingHostFetches;

function headerTextOf(headers) {
    let headerText = '';
    if (ArrayIsArray(headers)) {
        for (let i = 0; i < headers.length; i++)
            headerText += headers[i][0] + ': ' + headers[i][1] + '\n';
    } else {
        for (const name of ObjectKeys(headers))
            headerText += name + ': ' + headers[name] + '\n';
    }
    return headerText;
}

// A host response whose body streams in: `read()` resolves { done, value: Uint8Array } as a stream reader's does. The
// engine has the headers at once and each chunk as it comes (a media element demuxes before the end, Media.cpp).
api.fetchStreamed = (id, status, headers, read) => {
    const headerText = headerTextOf(headers);
    const headerPtr = copyInString(headerText);
    try {
        X.ganglion_fetch_headers(id, status, headerPtr, TextEncoderPrototypeEncode(encoderUtf8, headerText).length);
    } finally {
        X.ganglion_free(headerPtr);
    }
    api.pump();
    const next = () => PromisePrototypeThen(read(), (r) => {
        if (pendingFetches[id] === undefined)
            return;
        if (r.done) {
            pendingHostFetches--;
            delete pendingFetches[id];
            X.ganglion_fetch_end(id);
            api.pump();
            return;
        }
        const bytes = r.value instanceof globalThis.Uint8Array ? r.value : new (globalThis.Uint8Array)(r.value);
        const ptr = copyIn(bytes);
        try {
            X.ganglion_fetch_data(id, ptr, bytes.length);
        } finally {
            X.ganglion_free(ptr);
        }
        api.pump();
        next();
    }, (error) => { if (pendingFetches[id] !== undefined) api.fetchFailed(id, String(error && error.message || error)); });
    next();
};

api.fetchDone = (id, status, headers, body) => {
    if (pendingFetches[id] !== undefined)
        pendingHostFetches--;
    delete pendingFetches[id];
    const headerText = headerTextOf(headers);
    const bytes = body instanceof globalThis.Uint8Array ? body : new (globalThis.Uint8Array)(body);
    const headerPtr = copyInString(headerText);
    const bodyPtr = copyIn(bytes);
    try {
        X.ganglion_fetch_done(id, status, headerPtr, TextEncoderPrototypeEncode(encoderUtf8, headerText).length, bodyPtr, bytes.length);
    } finally {
        X.ganglion_free(headerPtr);
        X.ganglion_free(bodyPtr);
    }
    api.pump();
};

// A fetch the host claimed goes to the engine's own network after all (ganglion_fetch_network).
api.fetchNetwork = (id) => {
    if (pendingFetches[id] !== undefined)
        pendingHostFetches--;
    delete pendingFetches[id];
    X.ganglion_fetch_network(id);
    api.pump();
};

// A request on the engine's own network outside any document (a page service worker's fetch): no CORS or redirects here.
// `cookies`: the caller's credentials mode includes cookies for this URL, so the engine adds the jar's and stores the response's
// (Set-Cookie never comes back). Resolves { status, headers: [[name, value]], body: Uint8Array }; rejects with the network
// error's message.
api.netRequest = (method, url, headers, body, cookies) => new HostPromise((resolve, reject) => {
    const id = nextNetRequest++;
    pendingNetRequests[id] = { __proto__: null, resolve, reject };
    let headerText = '';
    for (let i = 0; i < headers.length; i++)
        headerText += headers[i][0] + ': ' + headers[i][1] + '\n';
    const bytes = body ? (body instanceof globalThis.Uint8Array ? body : new (globalThis.Uint8Array)(body)) : new (globalThis.Uint8Array)(0);
    const m = copyInString(method), u = copyInString(url), h = copyInString(headerText), b = copyIn(bytes);
    try {
        X.ganglion_net_request(id, m, TextEncoderPrototypeEncode(encoderUtf8, method).length, u, TextEncoderPrototypeEncode(encoderUtf8, url).length, h, TextEncoderPrototypeEncode(encoderUtf8, headerText).length, b, bytes.length, cookies === true ? 1 : 0);
    } finally {
        X.ganglion_free(m); X.ganglion_free(u); X.ganglion_free(h); X.ganglion_free(b);
    }
    api.pump();
});

// A tunnel on the engine's own network (docs/architecture.md, "WebSockets"): an HTTP/1.1 upgrade request (GET, `headers` as
// [[name, value]]) to an http(s) URL; after a 101 the connection carries the upgraded protocol, TLS inside the engine as for
// any request. handlers: { onOpen(status, reason, headers), onData(Uint8Array), onClose(errorText) } (errorText is '' for a
// normal end; onClose also reports an upgrade that failed). Returns the tunnel's id.
api.tunnelOpen = (url, headers, handlers) => {
    const id = nextTunnel++;
    tunnels[id] = handlers;
    let headerText = '';
    for (let i = 0; i < headers.length; i++)
        headerText += headers[i][0] + ': ' + headers[i][1] + '\n';
    const u = copyInString(url), h = copyInString(headerText);
    try {
        X.ganglion_tunnel_open(id, u, TextEncoderPrototypeEncode(encoderUtf8, url).length, h, TextEncoderPrototypeEncode(encoderUtf8, headerText).length);
    } finally {
        X.ganglion_free(u); X.ganglion_free(h);
    }
    api.pump();
    return id;
};
api.tunnelWrite = (id, bytes) => {
    if (tunnels[id] === undefined)
        return false;
    const data = bytes instanceof globalThis.Uint8Array ? bytes : new (globalThis.Uint8Array)(bytes);
    const ptr = copyIn(data);
    let ok;
    try {
        ok = X.ganglion_tunnel_write(id, ptr, data.length) !== 0;
    } finally {
        X.ganglion_free(ptr);
    }
    api.pump();
    return ok;
};
api.tunnelClose = (id) => {
    if (tunnels[id] === undefined)
        return;
    delete tunnels[id];
    X.ganglion_tunnel_close(id);
    api.pump();
};

api.fetchFailed = (id, message) => {
    if (pendingFetches[id] !== undefined)
        pendingHostFetches--;
    delete pendingFetches[id];
    const ptr = copyInString(message);
    try {
        X.ganglion_fetch_failed(id, ptr, TextEncoderPrototypeEncode(encoderUtf8, message).length);
    } finally {
        X.ganglion_free(ptr);
    }
    api.pump();
};

// image: { width, height, frames: [{ rgba: Uint8Array (RGBA, straight alpha), duration }] }
api.imageDone = (id, image) => {
    delete pendingImages[id];
    const frames = image.frames;
    const count = frames.length;
    const frameBytes = image.width * image.height * 4;
    const pixelsPtr = X.ganglion_alloc(frameBytes * count);
    const durationsPtr = X.ganglion_alloc(4 * count);
    views();
    for (let f = 0; f < count; f++) {
        const rgba = frames[f].rgba;
        const base = pixelsPtr + f * frameBytes;
        // RGBA straight -> BGRA premultiplied
        for (let i = 0; i < frameBytes; i += 4) {
            const a = rgba[i + 3];
            u8[base + i] = (rgba[i + 2] * a + 127) / 255 | 0;
            u8[base + i + 1] = (rgba[i + 1] * a + 127) / 255 | 0;
            u8[base + i + 2] = (rgba[i] * a + 127) / 255 | 0;
            u8[base + i + 3] = a;
        }
        u32[(durationsPtr >>> 2) + f] = frames[f].duration | 0;
    }
    try {
        X.ganglion_image_done(id, image.width, image.height, count, pixelsPtr, durationsPtr);
    } finally {
        X.ganglion_free(pixelsPtr);
        X.ganglion_free(durationsPtr);
    }
    api.pump();
};

api.imageFailed = (id) => {
    delete pendingImages[id];
    X.ganglion_image_failed(id);
    api.pump();
};

// A display frame: LibWeb's rendering update (requestAnimationFrame and friends) runs on it.
api.renderingOpportunity = (ts) => X.ganglion_rendering_opportunity(ts || 0);

// Runs the engine's due timers and queued events; returns ms until the next timer or -1.
api.pump = () => {
    const r = X.ganglion_pump();
    syncNamedProperties(); // 45-surface.js: elements the tasks added or renamed
    return r;
};
api.microtaskTurnEnd = () => X.ganglion_microtask_turn_end();
api.setViewport = (width, height, dpr) => X.ganglion_set_viewport(width, height, dpr);
// prefers-color-scheme as the host browser answers it ('dark' or 'light').
// The host browser's screen (harness/segment/segment.js reads the segment document's `screen`): Screen, ScreenOrientation and
// the device-* media features answer with it; a change of orientation fires `change` at screen.orientation.
const ORIENTATION_TYPES = { __proto__: null, 'portrait-primary': 0, 'portrait-secondary': 1, 'landscape-primary': 2, 'landscape-secondary': 3 };
api.setScreen = (s) => {
    if (s === null || typeof s !== 'object' || typeof X.ganglion_set_screen !== 'function')
        return;
    const n = (v, d) => (typeof v === 'number' && v === v ? MathFloor(v) : d);
    X.ganglion_set_screen(n(s.width, 0), n(s.height, 0), n(s.availLeft, 0), n(s.availTop, 0), n(s.availWidth, 0), n(s.availHeight, 0), n(s.colorDepth, 24), (typeof s.orientationType === 'string' && ORIENTATION_TYPES[s.orientationType] !== undefined ? ORIENTATION_TYPES[s.orientationType] : -1), n(s.orientationAngle, 0), s.isExtended === true ? 1 : 0);
};
// The host browser's navigator.connection (segment.js): effectiveType, rtt, downlink and saveData for the page's NetworkInformation.
const EFFECTIVE_TYPES = { __proto__: null, 'slow-2g': 0, '2g': 1, '3g': 2, '4g': 3 };
api.setNetworkInformation = (c) => {
    if (c === null || typeof c !== 'object' || typeof X.ganglion_set_network_information !== 'function')
        return;
    const t = typeof c.effectiveType === 'string' && EFFECTIVE_TYPES[c.effectiveType] !== undefined ? EFFECTIVE_TYPES[c.effectiveType] : 3;
    X.ganglion_set_network_information(t, typeof c.rtt === 'number' ? c.rtt : 50, typeof c.downlink === 'number' ? c.downlink : 10, c.saveData === true ? 1 : 0);
};
// Web Audio's output goes to the host from now on (glue/engine/55-media.js), at the host's output rate (0: LibMedia's default).
api.setAudioOutput = (sampleRate) => { if (typeof X.ganglion_set_audio_output === 'function') X.ganglion_set_audio_output(typeof sampleRate === 'number' && sampleRate > 0 ? MathFloor(sampleRate) : 0); };
api.setColorScheme = (scheme) => { if (typeof X.ganglion_set_color_scheme === 'function') X.ganglion_set_color_scheme(scheme === 'dark' ? 1 : 0); };
api.needsPaint = () => !!X.ganglion_needs_paint();
api.frameWidth = () => X.ganglion_frame_width();
api.frameHeight = () => X.ganglion_frame_height();

// A copy of `n` bytes at `ptr` as a Uint8Array (never a view: linear memory stays private).
const Uint8ArrayPrototypeSet = uncurryThis(globalThis.Uint8Array.prototype.set);
function copyOutBytes(ptr, n) {
    views();
    const bytes = new (globalThis.Uint8Array)(n);
    Uint8ArrayPrototypeSet(bytes, TypedArrayPrototypeSubarray(u8, ptr, ptr + n));
    return bytes;
}

// Copies `n` bytes out of linear memory at `ptr` into a fresh Uint8ClampedArray (one typed-array copy; the
// subarray view is not retained).
function copyOut(ptr, n) {
    views();
    const pixels = new Uint8ClampedArray_(n);
    TypedArrayPrototypeSet(pixels, TypedArrayPrototypeSubarray(u8, ptr, ptr + n));
    return pixels;
}

function imageOf(ptr, width, height) {
    const pixels = copyOut(ptr, width * height * 4);
    if (HostImageData)
        return new HostImageData(pixels, width, height);
    return { __proto__: null, data: pixels, width, height };
}

// Paints what changed. Returns null when nothing could be painted, else { blit: {dx, dy}, x, y, width,
// height, image }: the host moves its copy of the frame by the blit (a scroll), then puts `image` at
// (x, y). `width`/`height` are 0 when nothing changed (the frame is as it was).
const HostJSONParse = globalThis.JSON.parse;
api.paint = () => {
    const ptr = X.ganglion_paint();
    if (!ptr)
        return null;
    if (typeof X.ganglion_compositor === 'function' && X.ganglion_compositor() !== 0)
        return layeredFrame();
    const x = X.ganglion_dirty_x(), y = X.ganglion_dirty_y();
    const width = X.ganglion_dirty_width(), height = X.ganglion_dirty_height();
    const blit = { __proto__: null, dx: X.ganglion_blit_dx(), dy: X.ganglion_blit_dy() };
    const image = width > 0 && height > 0 ? imageOf(ptr, width, height) : null;
    return { __proto__: null, blit, x, y, width, height, image };
};

// The compositor (docs/compositor.md): 'flat' (one frame, api.paint as above), 'layers' (tiles; backdrop filters
// rastered in the engine) or 'gpu' (tiles; blur/saturate backdrop filters for the carapace's WebGL2).
api.setCompositor = (mode) => { if (typeof X.ganglion_set_compositor === 'function') X.ganglion_set_compositor(mode === 'gpu' ? 2 : mode === 'layers' ? 1 : 0); };
api.compositor = () => (typeof X.ganglion_compositor === 'function' ? ['flat', 'layers', 'gpu'][X.ganglion_compositor()] || 'flat' : 'flat');
// A layered paint: { layers: the tree (JSON from the engine), tiles: [{ layer, i, j, x, y, width, height, image }], bytes }.
function layeredFrame() {
    const tree = HostJSONParse(bytesToString(X.ganglion_layers_json(), X.ganglion_layers_json_length()));
    const tiles = [];
    let bytes = 0;
    const dirty = tree.dirty;
    for (let k = 0; k < dirty.length; k++) {
        const d = dirty[k];
        const width = d[5], height = d[6];
        tiles[k] = { __proto__: null, layer: d[0], i: d[1], j: d[2], x: d[3], y: d[4], width, height, image: imageOf(X.ganglion_layers_dirty_pixels(k), width, height) };
        bytes += width * height * 4;
    }
    return { __proto__: null, layers: tree, tiles, bytes, blit: { __proto__: null, dx: 0, dy: 0 }, x: 0, y: 0, width: 0, height: 0, image: null };
}
api.layerStats = () => ({ __proto__: null, rasterMs: X.ganglion_layers_stats(0), splitMs: X.ganglion_layers_stats(1), layers: X.ganglion_layers_stats(2), tiles: X.ganglion_layers_stats(3), tilesRastered: X.ganglion_layers_stats(4), bytes: X.ganglion_layers_stats(5), flattened: !!X.ganglion_layers_stats(6), tilesRasteredVisible: X.ganglion_layers_stats(7), convertMs: X.ganglion_layers_stats(8) });

// The whole frame as an ImageData (a copy out of linear memory), or null before the first paint.
api.frame = () => {
    const ptr = X.ganglion_frame_rgba();
    if (!ptr)
        return null;
    return imageOf(ptr, X.ganglion_frame_width(), X.ganglion_frame_height());
};

// { painted, rasters, fullRasters, blits } since start.
api.paintCounts = () => ({ __proto__: null, painted: X.ganglion_paint_counts(0), rasters: X.ganglion_paint_counts(1), fullRasters: X.ganglion_paint_counts(2), blits: X.ganglion_paint_counts(3),
    lastLayoutMs: X.ganglion_paint_counts(4), lastRecordMs: X.ganglion_paint_counts(5), lastRasterMs: X.ganglion_paint_counts(6), lastConvertMs: X.ganglion_paint_counts(7) });

// The pointer the next mouse call comes from (Pointer Events): 'mouse', 'pen' or 'touch', its id, contact size, pressure
// (negative: not reported) and whether it is primary.
api.pointer = (type, id, width, height, pressure, isPrimary) => {
    if (typeof X.ganglion_pointer === 'function')
        X.ganglion_pointer(type === 'touch' ? 2 : type === 'pen' ? 1 : 0, id | 0, +width || 1, +height || 1, typeof pressure === 'number' ? pressure : -1, isPrimary !== false);
};
api.mouse = (kind, x, y, button, buttons, modifiers) => X.ganglion_mouse(kind, x, y, button | 0, buttons | 0, modifiers | 0);
api.wheel = (x, y, dx, dy) => X.ganglion_wheel(x, y, dx, dy);
// A mouse event with a screen position of its own (movementX/Y are screen deltas; under the pointer lock the client position stays).
api.mouseScreen = (kind, x, y, sx, sy, button, buttons, modifiers) => X.ganglion_mouse_screen(kind, x, y, sx, sy, button | 0, buttons | 0, modifiers | 0);
api.fullscreenChanged = (on) => X.ganglion_fullscreen_changed(on ? 1 : 0);
// kind 0: the answer to a lock request (error 0 locked, 1 refused, 2 unsupported options); kind 1: the host's lock ended.
api.pointerLockResult = (kind, error) => X.ganglion_pointer_lock_result(kind | 0, error | 0);
// Host gamepads (the carapace polls navigator.getGamepads): handle > 0, axes -1..1 and button values 0..1 as the host gives them.
api.gamepadConnected = (handle, id, standard, axisCount, buttonCount) => {
    const ptr = copyInString(id);
    try {
        return X.ganglion_gamepad_connected(handle >>> 0, ptr, TextEncoderPrototypeEncode(encoderUtf8, id).length, standard ? 1 : 0, axisCount | 0, buttonCount | 0) === 1;
    } finally {
        X.ganglion_free(ptr);
    }
};
api.gamepadState = (handle, axes, buttons) => {
    const na = axes.length, nb = buttons.length;
    const ptr = X.ganglion_alloc((na + nb) * 2 + 2);
    try {
        views();
        const put = (at, v) => { u8[ptr + at * 2] = v & 255; u8[ptr + at * 2 + 1] = (v >> 8) & 255; };
        for (let i = 0; i < na; i++)
            put(i, MathMax(-32768, MathMin(32767, MathFloor(+axes[i] * 32767 + 0.5))) | 0);
        for (let i = 0; i < nb; i++)
            put(na + i, MathMax(0, MathMin(32767, MathFloor(+buttons[i] * 32767 + 0.5))) | 0);
        X.ganglion_gamepad_state(handle >>> 0, ptr, na, ptr + na * 2, nb);
    } finally {
        X.ganglion_free(ptr);
    }
};
api.gamepadDisconnected = (handle) => X.ganglion_gamepad_disconnected(handle >>> 0);
api.scrollBy = (dx, dy) => X.ganglion_scroll_by(dx, dy);
// Threaded scroll: the carapace scrolled node `node` by (dx, dy) CSS px for a wheel at (x, y); see Host.cpp.
api.scrollSync = (seq, node, x, y, dx, dy) => { if (typeof X.ganglion_scroll_sync === 'function') X.ganglion_scroll_sync(seq >>> 0, node >>> 0, +x || 0, +y || 0, +dx || 0, +dy || 0); };
api.key = (kind, keyCode, modifiers, codePoint) => X.ganglion_key(kind, keyCode | 0, modifiers | 0, codePoint >>> 0);
api.collect = (force) => !!X.ganglion_collect(!!force);
api.memoryBytes = () => (views(), viewBuffer.byteLength);
api.fingerprint = () => cString(X.ganglion_fingerprint());
api.debug = (flags) => X.ganglion_debug(flags | 0);
api.renderBlocked = () => (typeof X.ganglion_render_blocked === 'function' ? X.ganglion_render_blocked() : -1);
api.setLog = (fn) => { engineLog = fn; };
