// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// WebSocket for a segment's page and for its page's virtual service worker (docs/architecture.md, "WebSockets"). Loaded with
// importScripts before the host's doors are removed (harness/segment/doors.js), in the segment Worker and in the runner of a
// page's service worker. The host's WebSocket is a door and is gone (doors.js); this file is RFC 6455 written in JavaScript over a
// *transport* it is given: `open(url, headers, handlers) -> { write(bytes), close() }` with handlers { onOpen(status, reason,
// headers), onData(bytes), onClose(errorText) }. In the segment Worker the transport is the engine's tunnel (an HTTP upgrade on
// the engine's own network: TCP through Spiracle and the relay's allowlist, TLS in the engine, certificates checked there); in the
// runner it is a MessagePort to the segment Worker, which uses the same. Nothing here can reach the host's network, and the page's
// code is not edited: `new WebSocket(url, protocols)` is the page's own call.
//
// It defines `__chitinWebSocket`, which the caller takes and deletes from the global.
'use strict';
(() => {
    const G = self;
    const defineProperty = Object.defineProperty;
    const ReflectApply = Reflect.apply;
    const HostURL = G.URL;
    const HostDOMException = G.DOMException;
    const HostTypeError = G.TypeError;
    const HostPromise = G.Promise;
    const HostUint8Array = G.Uint8Array;
    const HostArrayBuffer = G.ArrayBuffer;
    const HostDataView = G.DataView;
    const HostTextEncoder = G.TextEncoder;
    const HostTextDecoder = G.TextDecoder;
    const HostMap = Map;
    const HostWeakMap = WeakMap;
    const hostSetTimeout = G.setTimeout.bind(G);
    const hostClearTimeout = G.clearTimeout.bind(G);
    const hostBtoa = G.btoa.bind(G);
    const hostCrypto = G.crypto;
    const getRandomValues = hostCrypto.getRandomValues.bind(hostCrypto);
    const digest = hostCrypto.subtle.digest.bind(hostCrypto.subtle);
    const arrayBufferIsView = HostArrayBuffer.isView;
    const objectToString = Object.prototype.toString;
    const encoder = new HostTextEncoder();

    const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;
    const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
    const MAX_MESSAGE = 128 * 1024 * 1024;
    const CLOSE_WAIT_MS = 5000;

    const base64 = (bytes) => {
        let s = '';
        for (let i = 0; i < bytes.length; i++)
            s += String.fromCharCode(bytes[i]);
        return hostBtoa(s);
    };
    const concat = (a, b) => {
        if (!a.length)
            return b;
        const out = new HostUint8Array(a.length + b.length);
        out.set(a, 0);
        out.set(b, a.length);
        return out;
    };

    // The names the page sees, fixed in one place. Members in Chrome's order.
    const CONSTANTS = [['CONNECTING', CONNECTING], ['OPEN', OPEN], ['CLOSING', CLOSING], ['CLOSED', CLOSED]];

    function create() {
        // `P` is the page's realm (the engine's Window for the segment Worker, the runner's own global for the worker).
        function install(P, options) {
            const transport = options.transport;
            const PDOMException = P.DOMException || HostDOMException;
            const PTypeError = P.TypeError || HostTypeError;
            const PEventTarget = P.EventTarget;
            const PEvent = P.Event;
            const PMessageEvent = P.MessageEvent;
            const PCloseEvent = P.CloseEvent;
            const PBlob = P.Blob;
            const PUint8Array = P.Uint8Array || HostUint8Array;
            const dom = (message, name) => new PDOMException(message, name);
            const illegal = () => new PTypeError('Illegal invocation');

            const slots = new HostWeakMap();
            const live = new HostMap(); // open sockets, closed with the document
            const slot = (self_) => {
                const s = slots.get(self_);
                if (!s)
                    throw illegal();
                return s;
            };

            // --- Parsing the arguments ------------------------------------------------------------------------------------
            function parseURL(input) {
                let u;
                try {
                    u = new HostURL(String(input), options.base());
                } catch {
                    throw dom(`Failed to construct 'WebSocket': The URL '${String(input)}' is invalid.`, 'SyntaxError');
                }
                // The URL's scheme: http and https stand for ws and wss (the Fetch/WebSocket standards' current text).
                let scheme = u.protocol.slice(0, -1);
                if (scheme === 'http')
                    scheme = 'ws';
                else if (scheme === 'https')
                    scheme = 'wss';
                if (scheme !== 'ws' && scheme !== 'wss')
                    throw dom(`Failed to construct 'WebSocket': The URL's scheme must be either 'http', 'https', 'ws', or 'wss'. '${u.protocol.slice(0, -1)}' is not allowed.`, 'SyntaxError');
                if (u.hash)
                    throw dom(`Failed to construct 'WebSocket': The URL contains a fragment identifier ('${u.hash}'). Fragment identifiers are not allowed in WebSocket URLs.`, 'SyntaxError');
                return { scheme, u };
            }
            function parseProtocols(protocols) {
                let list;
                if (protocols === undefined)
                    list = [];
                else if (typeof protocols === 'object' && protocols !== null && typeof protocols[Symbol.iterator] === 'function' && typeof protocols !== 'string')
                    list = Array.from(protocols, String);
                else
                    list = [String(protocols)];
                const seen = new Set();
                for (const p of list) {
                    if (!TOKEN.test(p))
                        throw dom(`Failed to construct 'WebSocket': The subprotocol '${p}' is invalid.`, 'SyntaxError');
                    if (seen.has(p))
                        throw dom(`Failed to construct 'WebSocket': The subprotocol '${p}' is duplicated.`, 'SyntaxError');
                    seen.add(p);
                }
                return list;
            }

            // --- Events ---------------------------------------------------------------------------------------------------
            // IDL event handler attributes: one listener per attribute, registered when it is first set to a function.
            const handlerNames = ['open', 'error', 'close', 'message'];
            function fire(ws, s, event) {
                try {
                    // The page's events are trusted (the engine dispatches them: options.dispatch); a worker's are not (its Event
                    // constructor cannot make a trusted one).
                    if (options.dispatch && options.dispatch(ws, event))
                        return;
                    ReflectApply(PEventTarget.prototype.dispatchEvent, ws, [event]);
                } catch (e) {
                    // a throwing listener is reported by the dispatch itself; nothing to do here
                    void e;
                }
            }
            const fireSimple = (ws, s, type) => fire(ws, s, new PEvent(type));

            // --- The connection ---------------------------------------------------------------------------------------------
            async function connect(ws, s) {
                const keyBytes = new HostUint8Array(16);
                getRandomValues(keyBytes);
                s.key = base64(keyBytes);
                const headers = [
                    ['Pragma', 'no-cache'], ['Cache-Control', 'no-cache'],
                    ['Upgrade', 'websocket'], ['Connection', 'Upgrade'],
                    ['Origin', options.origin()],
                    ['Sec-WebSocket-Key', s.key], ['Sec-WebSocket-Version', '13'],
                ];
                if (s.protocols.length)
                    headers.push(['Sec-WebSocket-Protocol', s.protocols.join(', ')]);
                const tunnelURL = (s.scheme === 'wss' ? 'https:' : 'http:') + s.url.replace(/^wss?:/, '');
                s.expectedAccept = null;
                try {
                    const hash = new HostUint8Array(await digest('SHA-1', encoder.encode(s.key + GUID)));
                    s.expectedAccept = base64(hash);
                } catch {
                    failConnection(ws, s, 1006, 'could not compute the handshake');
                    return;
                }
                if (s.state !== CONNECTING || s.failed)
                    return;
                s.tunnel = transport.open(tunnelURL, headers, {
                    onOpen: (status, reason, responseHeaders) => onHandshake(ws, s, status, responseHeaders),
                    onData: (bytes) => onBytes(ws, s, bytes),
                    onClose: (error) => onTransportClosed(ws, s, error),
                });
            }

            function headerValue(list, name) {
                const values = [];
                for (const [n, v] of list)
                    if (n.toLowerCase() === name)
                        values.push(v);
                return values;
            }
            function onHandshake(ws, s, status, responseHeaders) {
                if (s.state !== CONNECTING)
                    return;
                const fail = (why) => failConnection(ws, s, 1006, why);
                if (status !== 101)
                    return fail(`Unexpected response code: ${status}`);
                const upgrade = headerValue(responseHeaders, 'upgrade');
                if (upgrade.length !== 1 || upgrade[0].trim().toLowerCase() !== 'websocket')
                    return fail("'Upgrade' header is missing or not 'websocket'");
                const connection = headerValue(responseHeaders, 'connection');
                if (!connection.some((v) => v.split(',').some((t) => t.trim().toLowerCase() === 'upgrade')))
                    return fail("'Connection' header is missing or not 'Upgrade'");
                const accept = headerValue(responseHeaders, 'sec-websocket-accept');
                if (accept.length !== 1 || accept[0].trim() !== s.expectedAccept)
                    return fail("Incorrect 'Sec-WebSocket-Accept' header value");
                if (headerValue(responseHeaders, 'sec-websocket-extensions').length)
                    return fail('Sent non-empty \'Sec-WebSocket-Extensions\' header');
                const chosen = headerValue(responseHeaders, 'sec-websocket-protocol');
                if (chosen.length > 1)
                    return fail("'Sec-WebSocket-Protocol' header must not appear more than once in a response");
                if (chosen.length === 1) {
                    if (!s.protocols.includes(chosen[0].trim()))
                        return fail('Sent non-empty \'Sec-WebSocket-Protocol\' header but no subprotocol was requested or it was not offered');
                    s.protocol = chosen[0].trim();
                } else if (s.protocols.length) {
                    s.protocol = '';
                }
                s.state = OPEN;
                s.opened = true;
                fireSimple(ws, s, 'open');
            }

            // --- Frames -----------------------------------------------------------------------------------------------------
            function frame(opcode, payload) {
                const length = payload.length;
                const head = length < 126 ? 2 : length < 65536 ? 4 : 10;
                const out = new HostUint8Array(head + 4 + length);
                out[0] = 0x80 | opcode;
                if (length < 126) {
                    out[1] = 0x80 | length;
                } else if (length < 65536) {
                    out[1] = 0x80 | 126;
                    out[2] = length >>> 8;
                    out[3] = length & 255;
                } else {
                    out[1] = 0x80 | 127;
                    const view = new HostDataView(out.buffer);
                    view.setUint32(2, Math.floor(length / 4294967296));
                    view.setUint32(6, length >>> 0);
                }
                const mask = out.subarray(head, head + 4);
                getRandomValues(mask);
                for (let i = 0; i < length; i++)
                    out[head + 4 + i] = payload[i] ^ mask[i & 3];
                return out;
            }
            const closePayload = (code, reason) => {
                const text = encoder.encode(reason || '');
                const out = new HostUint8Array(2 + text.length);
                out[0] = code >>> 8;
                out[1] = code & 255;
                out.set(text, 2);
                return out;
            };
            function writeFrame(s, opcode, payload) {
                if (!s.tunnel)
                    return false;
                try {
                    return s.tunnel.write(frame(opcode, payload)) !== false;
                } catch {
                    return false;
                }
            }

            function onBytes(ws, s, bytes) {
                if (s.state === CLOSED || s.state === CONNECTING && !s.opened)
                    return;
                s.rx = concat(s.rx, bytes);
                for (;;) {
                    const b = s.rx;
                    if (b.length < 2)
                        return;
                    const fin = (b[0] & 0x80) !== 0;
                    const rsv = b[0] & 0x70;
                    const opcode = b[0] & 15;
                    const masked = (b[1] & 0x80) !== 0;
                    let length = b[1] & 127;
                    let at = 2;
                    if (length === 126) {
                        if (b.length < 4)
                            return;
                        length = (b[2] << 8) | b[3];
                        at = 4;
                    } else if (length === 127) {
                        if (b.length < 10)
                            return;
                        const view = new HostDataView(b.buffer, b.byteOffset, b.byteLength);
                        const hi = view.getUint32(2);
                        if (hi > 0x1fffff)
                            return failConnection(ws, s, 1009, 'Message too big');
                        length = hi * 4294967296 + view.getUint32(6);
                        at = 10;
                    }
                    if (rsv)
                        return failConnection(ws, s, 1002, 'One or more reserved bits are on');
                    if (masked)
                        return failConnection(ws, s, 1002, 'A server must not mask any frames that it sends to the client.');
                    if (opcode >= 8 && (!fin || length > 125))
                        return failConnection(ws, s, 1002, 'Invalid control frame');
                    if (length > MAX_MESSAGE)
                        return failConnection(ws, s, 1009, 'Message too big');
                    if (b.length < at + length)
                        return;
                    const payload = b.slice(at, at + length);
                    s.rx = b.subarray(at + length);
                    if (!onFrame(ws, s, fin, opcode, payload))
                        return;
                }
            }
            // false: stop reading (the connection is closing or closed).
            function onFrame(ws, s, fin, opcode, payload) {
                switch (opcode) {
                case 0: // continuation
                    if (!s.fragments)
                        return failConnection(ws, s, 1002, 'Received unexpected continuation frame.'), false;
                    s.size += payload.length;
                    if (s.size > MAX_MESSAGE)
                        return failConnection(ws, s, 1009, 'Message too big'), false;
                    s.fragments.push(payload);
                    if (fin) {
                        const all = concatAll(s.fragments, s.size);
                        const binary = s.fragmentBinary;
                        s.fragments = null;
                        return deliver(ws, s, binary, all);
                    }
                    return true;
                case 1:
                case 2:
                    if (s.fragments)
                        return failConnection(ws, s, 1002, 'Received start of new message but previous message is unfinished.'), false;
                    if (fin)
                        return deliver(ws, s, opcode === 2, payload);
                    s.fragments = [payload];
                    s.size = payload.length;
                    s.fragmentBinary = opcode === 2;
                    return true;
                case 8: {
                    let code = 1005;
                    let reason = '';
                    if (payload.length === 1)
                        return failConnection(ws, s, 1002, 'Invalid close frame'), false;
                    if (payload.length >= 2) {
                        code = (payload[0] << 8) | payload[1];
                        const valid = (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
                        if (!valid)
                            return failConnection(ws, s, 1002, `Invalid close code ${code}`), false;
                        try {
                            reason = new HostTextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload.subarray(2));
                        } catch {
                            return failConnection(ws, s, 1007, 'Invalid UTF-8 in the close reason'), false;
                        }
                    }
                    s.closeCode = code;
                    s.closeReason = reason;
                    s.clean = true;
                    if (s.state === OPEN) {
                        s.state = CLOSING;
                        writeFrame(s, 8, payload.length >= 2 ? payload.subarray(0, 2) : new HostUint8Array(0)); // echo the code
                        // The server closes the TCP stream next; a server that does not is cut off.
                        armCloseTimer(ws, s, 2000);
                    } else if (s.state === CLOSING && s.sentClose) {
                        finish(ws, s); // our close frame was answered: the closing handshake is complete
                    }
                    return false;
                }
                case 9: // ping
                    if (s.state === OPEN)
                        writeFrame(s, 10, payload);
                    return true;
                case 10: // pong
                    return true;
                default:
                    return failConnection(ws, s, 1002, `Unknown opcode ${opcode}`), false;
                }
            }
            function concatAll(parts, size) {
                const out = new HostUint8Array(size);
                let at = 0;
                for (const p of parts) {
                    out.set(p, at);
                    at += p.length;
                }
                return out;
            }
            function deliver(ws, s, binary, payload) {
                if (s.state !== OPEN)
                    return true; // messages after our close frame are dropped
                let data;
                if (!binary) {
                    try {
                        data = new HostTextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload);
                    } catch {
                        failConnection(ws, s, 1007, 'Could not decode a text frame as UTF-8.');
                        return false;
                    }
                } else if (s.binaryType === 'arraybuffer') {
                    // The page's own ArrayBuffer (its realm's): the event keeps the object it is given, as in Chrome.
                    const copy = new PUint8Array(payload.length);
                    copy.set(payload);
                    data = copy.buffer;
                } else {
                    data = new PBlob([payload]);
                }
                fire(ws, s, new PMessageEvent('message', { data, origin: s.origin, lastEventId: '', source: null, ports: [] }));
                return s.state !== CLOSED;
            }

            // --- Ending -------------------------------------------------------------------------------------------------------
            function armCloseTimer(ws, s, ms = CLOSE_WAIT_MS) {
                if (s.closeTimer)
                    return;
                s.closeTimer = hostSetTimeout(() => {
                    s.closeTimer = 0;
                    finish(ws, s);
                }, ms);
            }
            // The connection is over: the close event, once.
            function finish(ws, s) {
                if (s.state === CLOSED && s.finished)
                    return;
                s.finished = true;
                s.state = CLOSED;
                if (s.closeTimer) {
                    hostClearTimeout(s.closeTimer);
                    s.closeTimer = 0;
                }
                live.delete(s);
                const tunnel = s.tunnel;
                s.tunnel = null;
                if (tunnel) {
                    try { tunnel.close(); } catch { /* gone */ }
                }
                const clean = s.clean === true;
                if (s.failed)
                    fireSimple(ws, s, 'error');
                fire(ws, s, new PCloseEvent('close', { wasClean: clean, code: clean ? s.closeCode : 1006, reason: clean ? s.closeReason : '' }));
            }
            // "Fail the WebSocket connection": close frame with the code when the connection is open, then error and close(1006).
            function failConnection(ws, s, code, why) {
                if (s.state === CLOSED && s.finished)
                    return false;
                s.failed = true;
                s.failure = why;
                if (s.opened && s.state !== CLOSED && s.tunnel)
                    writeFrame(s, 8, closePayload(code, ''));
                s.state = CLOSING;
                hostSetTimeout(() => finish(ws, s), 0);
                return false;
            }
            function onTransportClosed(ws, s, error) {
                if (s.finished)
                    return;
                s.tunnel = null; // the stream is gone; nothing to close
                if (s.state === CONNECTING && !s.opened) {
                    s.failed = true;
                    s.failure = error || 'the connection closed before the handshake finished';
                } else if (!s.clean) {
                    s.failure = error || 'the connection closed without a closing handshake';
                }
                finish(ws, s);
            }

            // --- The class ------------------------------------------------------------------------------------------------------
            class WebSocket extends PEventTarget {
                constructor(url, protocols) {
                    if (arguments.length === 0)
                        throw new PTypeError("Failed to construct 'WebSocket': 1 argument required, but only 0 present.");
                    super();
                    const { scheme, u } = parseURL(url);
                    const list = parseProtocols(protocols);
                    if (scheme === 'ws' && options.mixedContent())
                        throw dom(`Failed to construct 'WebSocket': An insecure WebSocket connection may not be initiated from a page loaded over HTTPS.`, 'SecurityError');
                    const href = (scheme + ':' + u.href.slice(u.protocol.length));
                    const s = {
                        url: href, scheme, protocols: list, protocol: '', state: CONNECTING, binaryType: 'blob', bufferedAmount: 0,
                        origin: u.origin.replace(/^http/, 'ws'), rx: new HostUint8Array(0), fragments: null, size: 0, handlers: new HostMap(),
                        opened: false, failed: false, finished: false, clean: false, closeCode: 1005, closeReason: '', tunnel: null, closeTimer: 0, queue: HostPromise.resolve(),
                    };
                    slots.set(this, s);
                    live.set(s, this);
                    connect(this, s).catch(() => { failConnection(this, s, 1006, 'internal error'); });
                }
                get url() { return slot(this).url; }
                get readyState() { return slot(this).state; }
                get bufferedAmount() { return slot(this).bufferedAmount; }
                get extensions() { return slot(this).state === OPEN ? '' : ''; }
                get protocol() { return slot(this).protocol; }
                get binaryType() { return slot(this).binaryType; }
                set binaryType(value) {
                    const s = slot(this);
                    value = String(value);
                    if (value === 'blob' || value === 'arraybuffer')
                        s.binaryType = value;
                }
                close(code, reason) {
                    const s = slot(this);
                    if (code !== undefined) {
                        code = Number(code) & 0xffff;
                        if (code !== 1000 && !(code >= 3000 && code <= 4999))
                            throw dom(`Failed to execute 'close' on 'WebSocket': The code must be either 1000, or between 3000 and 4999. ${code} is neither.`, 'InvalidAccessError');
                    }
                    let text = '';
                    if (reason !== undefined) {
                        text = String(reason);
                        if (encoder.encode(text).length > 123)
                            throw dom(`Failed to execute 'close' on 'WebSocket': The message must not be greater than 123 bytes.`, 'SyntaxError');
                    }
                    if (s.state === CLOSING || s.state === CLOSED)
                        return;
                    if (s.state === CONNECTING) {
                        failConnection(this, s, 1006, 'WebSocket is closed before the connection is established.');
                        return;
                    }
                    s.state = CLOSING;
                    s.sentClose = true;
                    writeFrame(s, 8, code === undefined ? new HostUint8Array(0) : closePayload(code, text));
                    armCloseTimer(this, s);
                }
                send(data) {
                    const s = slot(this);
                    if (arguments.length === 0)
                        throw new PTypeError("Failed to execute 'send' on 'WebSocket': 1 argument required, but only 0 present.");
                    if (s.state === CONNECTING)
                        throw dom("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
                    let opcode = 2;
                    let bytes;
                    let blob = null;
                    if (PBlob && data instanceof PBlob) {
                        blob = data;
                    } else if (data instanceof HostArrayBuffer || objectToString.call(data) === '[object ArrayBuffer]') {
                        bytes = new HostUint8Array(data.slice(0));
                    } else if (arrayBufferIsView(data)) {
                        bytes = new HostUint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
                    } else {
                        opcode = 1;
                        bytes = encoder.encode(String(data));
                    }
                    const n = blob ? blob.size : bytes.length;
                    if (s.state !== OPEN) {
                        s.bufferedAmount += n; // after close() the data is counted, never sent
                        return;
                    }
                    s.bufferedAmount += n;
                    const ws = this;
                    const flush = (payload) => {
                        if (s.state === OPEN)
                            writeFrame(s, opcode, payload);
                        hostSetTimeout(() => { s.bufferedAmount -= n; }, 0);
                    };
                    // Sends keep their order, a Blob's read included.
                    s.queue = s.queue.then(blob ? () => blob.arrayBuffer().then((buffer) => flush(new HostUint8Array(buffer))) : () => flush(bytes));
                    void ws;
                }
            }

            // --- Chrome's shape ----------------------------------------------------------------------------------------------
            // Event handler attributes, each a getter/setter on the prototype (WebIDL: enumerable, configurable).
            for (const type of handlerNames) {
                const get = { ['get on' + type]() {
                    const s = slot(this);
                    const h = s.handlers.get(type);
                    return h ? h.fn : null;
                } }['get on' + type];
                const set = { ['set on' + type](value) {
                    const s = slot(this);
                    let h = s.handlers.get(type);
                    if (!h) {
                        h = { fn: null };
                        s.handlers.set(type, h);
                        ReflectApply(PEventTarget.prototype.addEventListener, this, [type, function (event) {
                            const f = h.fn;
                            if (typeof f === 'function')
                                return ReflectApply(f, this, [event]);
                            return undefined;
                        }]);
                    }
                    h.fn = typeof value === 'function' || (typeof value === 'object' && value !== null) ? value : null;
                } }['set on' + type];
                defineProperty(WebSocket.prototype, 'on' + type, { get, set, enumerable: true, configurable: true });
            }
            // Class members are not enumerable; WebIDL's are.
            for (const name of ['url', 'readyState', 'bufferedAmount', 'extensions', 'protocol', 'binaryType', 'close', 'send']) {
                const d = Object.getOwnPropertyDescriptor(WebSocket.prototype, name);
                defineProperty(WebSocket.prototype, name, { ...d, enumerable: true });
            }
            defineProperty(WebSocket.prototype.close, 'length', { value: 0, configurable: true });
            defineProperty(WebSocket.prototype.send, 'length', { value: 1, configurable: true });
            defineProperty(WebSocket, 'length', { value: 1, configurable: true });
            defineProperty(WebSocket.prototype, Symbol.toStringTag, { value: 'WebSocket', configurable: true });
            // Member order as Chrome lists it (compared against Chrome 154 by the chrome-test group): the attributes, the four
            // constants, close and send, and `constructor` last. Everything configurable is taken off and put back in that order.
            const order = ['url', 'readyState', 'bufferedAmount', 'onopen', 'onerror', 'onclose', 'extensions', 'protocol', 'onmessage', 'binaryType', 'close', 'send', 'constructor'];
            const saved = new HostMap();
            for (const name of order) {
                saved.set(name, Object.getOwnPropertyDescriptor(WebSocket.prototype, name));
                delete WebSocket.prototype[name];
            }
            const constant = (name, value) => ({ value, enumerable: true });
            for (const name of order.slice(0, 10))
                defineProperty(WebSocket.prototype, name, saved.get(name));
            for (const [name, value] of CONSTANTS)
                defineProperty(WebSocket.prototype, name, constant(name, value));
            for (const name of order.slice(10))
                defineProperty(WebSocket.prototype, name, saved.get(name));
            for (const [name, value] of CONSTANTS)
                defineProperty(WebSocket, name, constant(name, value));
            defineProperty(WebSocket.prototype, Symbol.toStringTag, { value: 'WebSocket', configurable: true });

            const define = () => {
                defineProperty(P, 'WebSocket', { value: WebSocket, writable: true, configurable: true });
            };
            define();
            return {
                redefine: define,
                // A new document: sockets of the old one go (going away).
                closeAll: () => {
                    for (const [s, ws] of Array.from(live)) {
                        s.clean = false;
                        if (s.tunnel) {
                            try { s.tunnel.close(); } catch { /* gone */ }
                            s.tunnel = null;
                        }
                        s.state = CLOSED;
                        s.finished = true;
                        live.delete(s);
                        void ws;
                    }
                },
                count: () => live.size,
            };
        }
        return { install };
    }
    G.__chitinWebSocket = Object.freeze({ create });
})();
