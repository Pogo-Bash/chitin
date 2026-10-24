// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Transferable streams across the engine's boundary (docs/architecture.md, "Streams").
//
// A page's ReadableStream, WritableStream and TransformStream are the engine's; the Worker's own (the host's) are what the
// page's service worker, the carapace and the other segments have. The engine cannot transfer a stream (its MessagePort
// transfer steps are not there), and the host cannot clone an engine object, so a stream in a transfer list is bridged:
// a new stream of the other side whose source (or sink) is the old one's reader (or writer), pulled one chunk at a time.
// The old stream is locked for good, as a transferred stream is in a browser (`locked` is true, getReader() throws).
// close, error and cancel/abort pass through; a chunk is passed as it is (the receiving side's structured clone copies it).
//
//   outbound(message, transfer, options)  a page message leaving for the host: the page streams in the transfer list become
//                                         host streams (inside the message and in the returned transfer list)
//   inbound(message)                      a host message arriving at the page: host streams become page streams
//   mirror(stream, to)                    a stream of either side as a new stream of the side `to` ('page' | 'host'; default the other)
//   pageStream(x) / hostStream(x)         which side a stream belongs to ('ReadableStream' | ... | null)
//
// Only the containers a structured clone keeps (plain objects, arrays, Maps, Sets) are walked; a message with no stream in it
// is returned as it is.
'use strict';
(() => {
    const G = self;
    const KINDS = ['ReadableStream', 'WritableStream', 'TransformStream'];

    function create(host) {
        const Host = { ReadableStream: host.ReadableStream, WritableStream: host.WritableStream, TransformStream: host.TransformStream };
        const HostPromise = Promise;
        const defineProperty = Object.defineProperty;
        const getPrototypeOf = Object.getPrototypeOf;
        let Page = null;             // the page's own constructors, taken once before page code runs
        let pump = host.pump || (() => {});
        let PageDOMException = host.DOMException;

        // The page's global: its (the engine's) stream classes and DOMException, captured now so that page code replacing
        // window.ReadableStream later changes nothing here.
        function bind(P) {
            Page = { ReadableStream: P.ReadableStream, WritableStream: P.WritableStream, TransformStream: P.TransformStream };
            PageDOMException = P.DOMException || host.DOMException;
        }
        function kindOf(x, classes) {
            if (typeof x !== 'object' || x === null || !classes)
                return null;
            for (const k of KINDS) {
                const C = classes[k];
                if (typeof C === 'function' && x instanceof C)
                    return k;
            }
            return null;
        }
        const pageStream = (x) => kindOf(x, Page);
        const hostStream = (x) => kindOf(x, Host);
        const cloneError = (what) => new PageDOMException(what + ' could not be cloned.', 'DataCloneError');
        const isStream = (x) => pageStream(x) !== null || hostStream(x) !== null;

        // --- The three bridges. `Dest` is the constructor of the side the stream is going to. A page stream settles on an
        // engine turn, so the engine is pumped after anything is asked of one from here (`toPage` false: the host's callbacks
        // read a page stream) and after anything the host settles for one (`toPage`: the page's callbacks wait on a host
        // stream); a callback the engine itself is running (the first statement of a pull for a page stream) never pumps.
        const settled = (done, ahead) => {
            if (ahead)
                pump();
            return HostPromise.resolve(done).finally(pump);
        };
        function readable(src, Dest, toPage, signal) {
            const reader = src.getReader();
            return new Dest({
                start(controller) {
                    // An aborted request's body fails with the abort's reason, as fetch()'s does.
                    if (signal)
                        signal.addEventListener('abort', () => { reader.cancel(signal.reason).catch(() => undefined); controller.error(signal.reason); pump(); }, { once: true });
                },
                async pull(controller) {
                    const read = reader.read();
                    if (!toPage)
                        pump();
                    const { done, value } = await read;
                    if (done)
                        controller.close();
                    else
                        controller.enqueue(value);
                    pump();
                },
                cancel(reason) {
                    return settled(reader.cancel(reason), !toPage);
                },
            });
        }
        function writable(src, Dest, toPage) {
            const writer = src.getWriter();
            return new Dest({
                write(chunk) { return settled(writer.write(chunk), !toPage); },
                close() { return settled(writer.close(), !toPage); },
                abort(reason) { return settled(writer.abort(reason), !toPage); },
            });
        }
        // A TransformStream whose writable end is written through to `src.writable` and whose readable end is read from
        // `src.readable`: the two halves of the original, each with its own backpressure.
        function transform(src, Dest, toPage) {
            const writer = src.writable.getWriter();
            const reader = src.readable.getReader();
            return new Dest({
                start(controller) {
                    (async () => {
                        for (;;) {
                            const read = reader.read();
                            if (!toPage)
                                pump();
                            const { done, value } = await read;
                            if (done) {
                                controller.terminate();
                                break;
                            }
                            controller.enqueue(value);
                            pump();
                        }
                        pump();
                    })().catch((e) => { controller.error(e); pump(); });
                },
                transform(chunk) { return settled(writer.write(chunk), !toPage); },
                flush() { return settled(writer.close(), !toPage); },
            });
        }
        const BRIDGES = { ReadableStream: readable, WritableStream: writable, TransformStream: transform };

        // A page or host stream as a stream of the other side. Throws DataCloneError for a stream in use.
        function mirror(stream, to, options) {
            const fromPage = pageStream(stream);
            const kind = fromPage || hostStream(stream);
            if (kind === null)
                throw new TypeError('not a stream');
            if (kind === 'ReadableStream' && stream.locked || kind === 'WritableStream' && stream.locked)
                throw cloneError('#<' + kind + '>');
            if (kind === 'TransformStream' && (stream.readable.locked || stream.writable.locked))
                throw cloneError('#<TransformStream>');
            const toPage = to === undefined ? !fromPage : to === 'page';
            return BRIDGES[kind](stream, toPage ? Page[kind] : Host[kind], toPage, options && options.signal);
        }

        // --- Walking a message ----------------------------------------------------------------------------------
        const isPlain = (v) => { const p = getPrototypeOf(v); return p === null || getPrototypeOf(p) === null; };
        function containsStream(root, test) {
            const seen = new Set();
            const stack = [root];
            while (stack.length) {
                const v = stack.pop();
                if (typeof v !== 'object' || v === null || seen.has(v))
                    continue;
                seen.add(v);
                if (test(v))
                    return true;
                try {
                    if (Array.isArray(v)) {
                        for (let i = 0; i < v.length; i++)
                            stack.push(v[i]);
                    } else if (v instanceof Map) {
                        for (const [k, x] of v) { stack.push(k); stack.push(x); }
                    } else if (v instanceof Set) {
                        for (const x of v) stack.push(x);
                    } else if (isPlain(v)) {
                        for (const k of Object.keys(v)) stack.push(v[k]);
                    }
                } catch { /* a getter that throws or a revoked proxy: the clone itself will report it */ }
            }
            return false;
        }
        // A copy of the message with `replace(stream)` in place of each stream. Containers are copied, everything else is
        // shared (a structured clone copies it anyway).
        function substitute(root, test, replace) {
            const done = new Map();
            const visit = (v) => {
                if (typeof v !== 'object' || v === null)
                    return v;
                if (done.has(v))
                    return done.get(v);
                if (test(v)) {
                    const r = replace(v);
                    done.set(v, r);
                    return r;
                }
                if (Array.isArray(v)) {
                    const out = new Array(v.length);
                    done.set(v, out);
                    for (let i = 0; i < v.length; i++)
                        if (i in v)
                            out[i] = visit(v[i]);
                    return out;
                }
                if (v instanceof Map) {
                    const out = new Map();
                    done.set(v, out);
                    for (const [k, x] of v)
                        out.set(visit(k), visit(x));
                    return out;
                }
                if (v instanceof Set) {
                    const out = new Set();
                    done.set(v, out);
                    for (const x of v)
                        out.add(visit(x));
                    return out;
                }
                if (isPlain(v)) {
                    const out = {};
                    done.set(v, out);
                    for (const k of Object.keys(v))
                        defineProperty(out, k, { value: visit(v[k]), writable: true, enumerable: true, configurable: true });
                    return out;
                }
                return v;
            };
            return visit(root);
        }

        // A page message going to the host. `transfer` is the page's transfer list. Streams listed in it become host streams,
        // in the message and in `transfer`; `received: true` says every stream in the message was moved already (it came out
        // of an engine port, which made its own copy), so none needs to be listed. A page stream that is not moved is a
        // DataCloneError, as it is in a browser. Returns { message, transfer } with `transfer` the list for the host's
        // postMessage: the host streams then the other listed objects.
        function outbound(message, transfer, options) {
            const list = transfer ? Array.from(transfer) : [];
            const moved = new Map();
            const others = [];
            const out = [];
            for (const item of list) {
                if (pageStream(item) !== null) {
                    if (!moved.has(item)) {
                        const m = mirror(item);
                        moved.set(item, m);
                        out.push(m);
                    }
                } else if (hostStream(item) !== null) {
                    if (!out.includes(item))
                        out.push(item);
                } else {
                    others.push(item);
                }
            }
            const received = !!(options && options.received);
            const isPage = (x) => pageStream(x) !== null;
            let result = message;
            if (containsStream(message, isPage)) {
                result = substitute(message, isPage, (s) => {
                    let m = moved.get(s);
                    if (m === undefined) {
                        if (!received)
                            throw cloneError('#<' + pageStream(s) + '>');
                        m = mirror(s);
                        moved.set(s, m);
                        out.push(m);
                    }
                    return m;
                });
            }
            return { message: result, transfer: out.concat(others), moved };
        }

        // The host streams inside a message (the transfer list for handing it to an engine port, which moves them).
        function hostStreamsIn(message) {
            const found = [];
            if (containsStream(message, (x) => hostStream(x) !== null))
                substitute(message, (x) => hostStream(x) !== null, (s) => { if (!found.includes(s)) found.push(s); return s; });
            return found;
        }

        // A host message arriving at the page: every host stream in it becomes a page stream. `transfer`, when the host
        // gave one, lists the host streams that moved (any other host stream in the data is converted the same).
        function inbound(message) {
            if (!containsStream(message, (x) => hostStream(x) !== null))
                return message;
            const moved = new Map();
            return substitute(message, (x) => hostStream(x) !== null, (s) => {
                let m = moved.get(s);
                if (m === undefined)
                    moved.set(s, m = mirror(s));
                return m;
            });
        }

        return Object.freeze({
            bind, pageStream, hostStream, isStream, mirror, outbound, inbound, hostStreamsIn, containsStream, substitute,
            setPump: (fn) => { pump = fn; },
            get bound() { return Page !== null; },
        });
    }

    defineStreams(create);
    function defineStreams(fn) {
        Object.defineProperty(G, '__chitinStreams', { value: Object.freeze({ create: fn }), writable: true, configurable: true });
    }
})();
