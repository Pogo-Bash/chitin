// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Encrypted Media Extensions for the page (docs/eme.md), the segment Worker's side. Chitin has no CDM and never decrypts:
// every EME call of the page goes to the segment document (harness/segment/eme-host.js), which makes it on the host
// browser's own EME, so the key systems, the license exchange's bytes, the errors and the events are the host's. Media the
// host has to decrypt is played by a host <video>: the page's MediaSource is handed over (its SourceBuffers' appends go to a
// host MediaSource), the page's element reflects the host element's state and events, and the host video is shown at the
// page element's box. The engine never sees a decrypted frame.
//
// When an element is handed over: it has MediaKeys (setMediaKeys) and plays a MediaSource, or an init segment appended to its
// MediaSource is encrypted (WebM ContentEncryption, MP4 encv/enca/tenc/pssh). What was appended before goes over too.
// Not handed over: a plain `src` URL (the engine plays it; an encrypted file there fails as before), elements of same-site
// iframes (the page's own document only), MediaSource handles from workers.
//
// It defines `__chitinEME`, which the caller takes and deletes from the global.
'use strict';
(() => {
    const G = self;
    const ObjectDefineProperty = Object.defineProperty;
    const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    const ObjectSetPrototypeOf = Object.setPrototypeOf;
    const ObjectCreate = Object.create;
    const ReflectApply = Reflect.apply;
    const ReflectConstruct = Reflect.construct;
    const HostPromise = G.Promise;
    const HostMap = Map;
    const HostWeakMap = WeakMap;
    const HostSet = Set;
    const HostUint8Array = G.Uint8Array;
    const HostArrayBuffer = G.ArrayBuffer;
    const HostSharedArrayBuffer = G.SharedArrayBuffer;
    const HostWeakRef = G.WeakRef;
    const ArrayBufferIsView = HostArrayBuffer.isView;
    const ArrayBufferSlice = HostArrayBuffer.prototype.slice;
    const Uint8ArraySlice = HostUint8Array.prototype.slice;
    const SymbolIterator = Symbol.iterator;
    const SymbolToStringTag = Symbol.toStringTag;
    const hostPerformance = G.performance;
    const performanceNow = hostPerformance.now.bind(hostPerformance);
    const timeOrigin = hostPerformance.timeOrigin;
    const now = () => timeOrigin + performanceNow();
    const MAX_LOG_BYTES = 64 * 1024 * 1024; // what a MediaSource keeps of its appends in case it is handed over later

    // --- Encrypted init segments ----------------------------------------------------------------------------------------
    // MP4: a protected sample entry (encv, enca) in moov/trak/mdia/minf/stbl/stsd, a pssh box, or a fragment's senc (moof/traf). WebM: a TrackEntry
    // with ContentEncodings holding a ContentEncryption. Both walked as structures (a byte search finds the IDs in media data).
    function sniffMP4(u8, from, to, depth) {
        for (let at = from; at + 8 <= to;) {
            let size = ((u8[at] << 24) >>> 0) + (u8[at + 1] << 16) + (u8[at + 2] << 8) + u8[at + 3];
            const type = String.fromCharCode(u8[at + 4], u8[at + 5], u8[at + 6], u8[at + 7]);
            let head = 8;
            if (size === 1) {
                if (at + 16 > to)
                    return false;
                size = (u8[at + 12] * 16777216) + (u8[at + 13] << 16) + (u8[at + 14] << 8) + u8[at + 15];
                head = 16;
            } else if (size === 0) {
                size = to - at;
            }
            if (size < head)
                return false;
            const end = Math.min(to, at + size);
            if (type === 'pssh' || type === 'encv' || type === 'enca' || type === 'tenc' || type === 'senc')
                return true;
            if (depth < 8 && (type === 'moov' || type === 'trak' || type === 'mdia' || type === 'minf' || type === 'stbl' || type === 'moof' || type === 'traf') && sniffMP4(u8, at + head, end, depth + 1))
                return true;
            if (depth < 8 && type === 'stsd' && sniffMP4(u8, at + head + 8, end, depth + 1))
                return true;
            at += size;
        }
        return false;
    }
    function vint(u8, at, keepMarker) {
        const first = u8[at];
        let len = 1;
        while (len <= 8 && !(first & (0x80 >> (len - 1))))
            len++;
        if (len > 8 || at + len > u8.length)
            return null;
        let v = keepMarker ? first : first & (0xff >> len);
        let all = (first & (0xff >> len)) === (0xff >> len);
        for (let i = 1; i < len; i++) {
            v = v * 256 + u8[at + i];
            all = all && u8[at + i] === 0xff;
        }
        return { v, len, unknown: !keepMarker && all };
    }
    function sniffWebM(u8, from, to, depth) {
        for (let at = from; at < to;) {
            const id = vint(u8, at, true);
            if (!id)
                return false;
            const size = vint(u8, at + id.len, false);
            if (!size)
                return false;
            const dataAt = at + id.len + size.len;
            const end = size.unknown ? to : Math.min(to, dataAt + size.v);
            if (id.v === 0x5035 || id.v === 0x47E2) // ContentEncryption, ContentEncKeyID
                return true;
            // Segment, Tracks, TrackEntry, ContentEncodings, ContentEncoding: inside; a Cluster ends the headers.
            if (id.v === 0x1F43B675)
                return false;
            if (depth < 6 && (id.v === 0x18538067 || id.v === 0x1654AE6B || id.v === 0xAE || id.v === 0x6D80 || id.v === 0x6240) && sniffWebM(u8, dataAt, end, depth + 1))
                return true;
            if (size.unknown)
                return false;
            at = dataAt + size.v;
        }
        return false;
    }
    function sniffEncrypted(u8) {
        if (!u8 || u8.length < 8)
            return false;
        const to = Math.min(u8.length, 4 * 1024 * 1024);
        if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3)
            return sniffWebM(u8, 0, to, 0);
        return sniffMP4(u8, 0, to, 0);
    }

    function create() {
        // `P` is the page's global (the engine's Window); options: { port, dispatch(target, event), native(fn), pump(),
        // secure: whether the document is a secure context (EME is [SecureContext]) }.
        function install(P, options) {
            const port = options.port;
            const native = typeof options.native === 'function' ? options.native : () => {};
            const pump = typeof options.pump === 'function' ? options.pump : () => {};
            const PDOMException = P.DOMException;
            const PTypeError = P.TypeError;
            const PEvent = P.Event;
            const PEventTarget = P.EventTarget;
            const PHTMLMediaElement = P.HTMLMediaElement;
            const PHTMLVideoElement = P.HTMLVideoElement;
            const PMediaSource = P.MediaSource;
            const PSourceBuffer = P.SourceBuffer;
            const PTimeRanges = P.TimeRanges;
            const PMediaError = P.MediaError;
            const PURL = P.URL;
            const PNavigator = P.Navigator;
            if (!PEventTarget || !PEvent || !PHTMLMediaElement || !PNavigator)
                return null;
            const EventTargetAddEventListener = PEventTarget.prototype.addEventListener;
            const EventTargetDispatchEvent = PEventTarget.prototype.dispatchEvent;
            const uncurry = (f) => (self_, ...args) => ReflectApply(f, self_, args);
            const own = (proto, name) => {
                for (let o = proto; o; o = Object.getPrototypeOf(o)) {
                    const d = ObjectGetOwnPropertyDescriptor(o, name);
                    if (d)
                        return d;
                }
                return undefined;
            };
            const getterOf = (proto, name) => { const d = own(proto, name); return d && d.get ? uncurry(d.get) : null; };
            const setterOf = (proto, name) => { const d = own(proto, name); return d && d.set ? uncurry(d.set) : null; };
            const methodOf = (proto, name) => { const d = own(proto, name); return d && typeof d.value === 'function' ? uncurry(d.value) : null; };
            const ElementGetBoundingClientRect = methodOf(P.Element.prototype, 'getBoundingClientRect');
            const NodeIsConnected = getterOf(P.Node.prototype, 'isConnected');
            const NodeOwnerDocument = getterOf(P.Node.prototype, 'ownerDocument');
            const ElementHasAttribute = methodOf(P.Element.prototype, 'hasAttribute');
            const DocumentQuerySelectorAll = methodOf(P.Document.prototype, 'querySelectorAll');
            const getComputedStyle = P.getComputedStyle;
            const CSSGetPropertyValue = methodOf(P.CSSStyleDeclaration.prototype, 'getPropertyValue');
            const DOMRectGet = (r, k) => ReflectApply(own(P.DOMRectReadOnly.prototype, k).get, r, []);
            const pageDocument = () => P.document;

            const illegal = () => new PTypeError('Illegal invocation');
            const dom = (message, name) => new PDOMException(message, name);
            // The host's error as the page's own: the same name and message, the page's class.
            const pageError = (e) => {
                if (!e)
                    return dom('Unknown error.', 'InvalidStateError');
                if (e.dom) {
                    // A DOMException subclass of the page's (QuotaExceededError in Chrome) when the host's was one.
                    const C = P[e.name];
                    if (e.name !== 'DOMException' && typeof C === 'function' && C.prototype instanceof PDOMException)
                        return new C(e.message);
                    return dom(e.message, e.name);
                }
                const C = typeof P[e.name] === 'function' && /Error$/.test(e.name) ? P[e.name] : PTypeError;
                return new C(e.message);
            };

            // --- The line to the segment document ---------------------------------------------------------------------------
            let nextId = 1;
            const pending = new HostMap();
            const call = (op, fields, transfer) => new HostPromise((resolve, reject) => {
                const id = nextId++;
                pending.set(id, { resolve, reject });
                fields.op = op;
                fields.id = id;
                port.postMessage(fields, transfer || []);
            });
            const send = (op, fields, transfer) => {
                fields.op = op;
                fields.id = 0;
                port.postMessage(fields, transfer || []);
            };
            // A BufferSource as bytes of their own (the page may change its buffer later). Anything else goes as it is: the
            // host's own conversion refuses it with Chrome's error.
            const bytesOf = (x) => {
                if (x instanceof HostArrayBuffer)
                    return ReflectApply(ArrayBufferSlice, x, [0]);
                if (ArrayBufferIsView(x) && !(HostSharedArrayBuffer && x.buffer instanceof HostSharedArrayBuffer))
                    return ReflectApply(Uint8ArraySlice, new HostUint8Array(x.buffer, x.byteOffset, x.byteLength), []).buffer;
                return x;
            };
            const transferable = (x) => (x instanceof HostArrayBuffer ? [x] : []);
            const sameBytes = (a, b) => {
                if (a.byteLength !== b.byteLength)
                    return false;
                const x = new HostUint8Array(a), y = new HostUint8Array(b);
                for (let i = 0; i < x.length; i++)
                    if (x[i] !== y[i])
                        return false;
                return true;
            };

            // --- Interface objects -------------------------------------------------------------------------------------------
            const globals = []; // the global's names, defined again on each new document (its own properties are reset)
            function iface(name, Parent, construct, length) {
                const cls = { [name]: function (...args) {
                    if (new.target === undefined)
                        throw new PTypeError(construct ? `Failed to construct '${name}': Please use the 'new' operator, this DOM object constructor cannot be called as a function.` : 'Illegal constructor');
                    if (!construct)
                        throw new PTypeError(`Failed to construct '${name}': Illegal constructor`);
                    return construct(args, new.target);
                } }[name];
                native(cls);
                ObjectDefineProperty(cls, 'length', { value: length, configurable: true });
                if (Parent) {
                    ObjectSetPrototypeOf(cls, Parent);
                    ObjectSetPrototypeOf(cls.prototype, Parent.prototype);
                }
                ObjectDefineProperty(cls, 'prototype', { writable: false, enumerable: false, configurable: false });
                ObjectDefineProperty(cls.prototype, SymbolToStringTag, { value: name, configurable: true });
                globals.push([name, cls]);
                ObjectDefineProperty(P, name, { value: cls, writable: true, enumerable: false, configurable: true });
                return cls;
            }
            const method = (target, name, length, fn) => {
                const f = { [name](...args) { return ReflectApply(fn, this, args); } }[name];
                ObjectDefineProperty(f, 'length', { value: length, configurable: true });
                native(f);
                ObjectDefineProperty(target, name, { value: f, writable: true, enumerable: true, configurable: true });
                return f;
            };
            const attribute = (target, name, get, set) => {
                const g = ObjectGetOwnPropertyDescriptor({ get [name]() { return ReflectApply(get, this, []); } }, name).get;
                native(g);
                let s;
                if (set) {
                    s = ObjectGetOwnPropertyDescriptor({ set [name](v) { ReflectApply(set, this, [v]); } }, name).set;
                    native(s);
                }
                ObjectDefineProperty(target, name, { get: g, set: s, enumerable: true, configurable: true });
            };
            // An event handler IDL attribute: one listener, added when it is first set.
            const handlerAttribute = (target, type, slotOf) => {
                const handlers = new HostWeakMap();
                attribute(target, 'on' + type, function () {
                    slotOf(this);
                    const h = handlers.get(this);
                    return h ? h.fn : null;
                }, function (value) {
                    slotOf(this);
                    let h = handlers.get(this);
                    if (!h) {
                        h = { fn: null };
                        handlers.set(this, h);
                        ReflectApply(EventTargetAddEventListener, this, [type, function (event) {
                            const f = h.fn;
                            return typeof f === 'function' ? ReflectApply(f, this, [event]) : undefined;
                        }]);
                    }
                    h.fn = typeof value === 'function' || (typeof value === 'object' && value !== null) ? value : null;
                });
            };
            const fire = (target, event) => {
                try {
                    if (options.dispatch && options.dispatch(target, event))
                        return;
                    ReflectApply(EventTargetDispatchEvent, target, [event]);
                } catch { /* a throwing listener is reported by the dispatch */ }
            };
            const slot = (map) => (self_) => {
                const s = map.get(self_);
                if (!s)
                    throw illegal();
                return s;
            };
            const rejectIllegal = () => HostPromise.reject(illegal());

            // --- Events: MediaKeyMessageEvent and MediaEncryptedEvent ----------------------------------------------------------
            const messageEvents = new HostWeakMap();
            const MediaKeyMessageEvent = iface('MediaKeyMessageEvent', PEvent, (args, newTarget) => {
                const prefix = "Failed to construct 'MediaKeyMessageEvent': ";
                if (args.length < 2)
                    throw new PTypeError(prefix + `2 arguments required, but only ${args.length} present.`);
                const init = args[1];
                if (init !== undefined && init !== null && typeof init !== 'object' && typeof init !== 'function')
                    throw new PTypeError(prefix + "The provided value is not of type 'MediaKeyMessageEventInit'.");
                const message = init == null ? undefined : init.message;
                const messageType = init == null ? undefined : init.messageType;
                if (message === undefined)
                    throw new PTypeError(prefix + "Failed to read the 'message' property from 'MediaKeyMessageEventInit': Required member is undefined.");
                if (!(message instanceof HostArrayBuffer))
                    throw new PTypeError(prefix + "Failed to read the 'message' property from 'MediaKeyMessageEventInit': The provided value is not of type 'ArrayBuffer'.");
                if (messageType === undefined)
                    throw new PTypeError(prefix + "Failed to read the 'messageType' property from 'MediaKeyMessageEventInit': Required member is undefined.");
                const type = String(messageType);
                if (type !== 'license-request' && type !== 'license-renewal' && type !== 'license-release' && type !== 'individualization-request')
                    throw new PTypeError(prefix + `Failed to read the 'messageType' property from 'MediaKeyMessageEventInit': The provided value '${type}' is not a valid enum value of type MediaKeyMessageType.`);
                const e = ReflectConstruct(PEvent, [args[0], init], newTarget);
                messageEvents.set(e, { messageType: type, message });
                return e;
            }, 2);
            const messageSlot = slot(messageEvents);
            attribute(MediaKeyMessageEvent.prototype, 'messageType', function () { return messageSlot(this).messageType; });
            attribute(MediaKeyMessageEvent.prototype, 'message', function () { return messageSlot(this).message; });

            const encryptedEvents = new HostWeakMap();
            const MediaEncryptedEvent = iface('MediaEncryptedEvent', PEvent, (args, newTarget) => {
                if (args.length < 1)
                    throw new PTypeError("Failed to construct 'MediaEncryptedEvent': 1 argument required, but only 0 present.");
                const init = args[1];
                const initData = init == null || init.initData === undefined ? null : init.initData;
                if (initData !== null && !(initData instanceof HostArrayBuffer))
                    throw new PTypeError("Failed to construct 'MediaEncryptedEvent': Failed to read the 'initData' property from 'MediaEncryptedEventInit': The provided value is not of type 'ArrayBuffer'.");
                const initDataType = init == null || init.initDataType === undefined ? '' : String(init.initDataType);
                const e = ReflectConstruct(PEvent, [args[0], init], newTarget);
                encryptedEvents.set(e, { initDataType, initData });
                return e;
            }, 1);
            const encryptedSlot = slot(encryptedEvents);
            attribute(MediaEncryptedEvent.prototype, 'initDataType', function () { return encryptedSlot(this).initDataType; });
            attribute(MediaEncryptedEvent.prototype, 'initData', function () { return encryptedSlot(this).initData; });

            // --- MediaKeyStatusMap -------------------------------------------------------------------------------------------
            const statusMaps = new HostWeakMap();
            const MediaKeyStatusMap = iface('MediaKeyStatusMap', null, null, 0);
            const statusSlot = slot(statusMaps);
            const makeStatusMap = () => {
                const o = ObjectCreate(MediaKeyStatusMap.prototype);
                statusMaps.set(o, { list: [] });
                return o;
            };
            const findStatus = (list, keyId) => {
                const b = bytesOf(keyId);
                if (!(b instanceof HostArrayBuffer))
                    throw new PTypeError("Failed to execute 'get' on 'MediaKeyStatusMap': The provided value is not of type '(ArrayBuffer or ArrayBufferView)'.");
                for (let i = 0; i < list.length; i++)
                    if (sameBytes(list[i][0], b))
                        return list[i];
                return null;
            };
            attribute(MediaKeyStatusMap.prototype, 'size', function () { return statusSlot(this).list.length; });
            method(MediaKeyStatusMap.prototype, 'has', 1, function (keyId) {
                const s = statusSlot(this);
                if (arguments.length < 1)
                    throw new PTypeError("Failed to execute 'has' on 'MediaKeyStatusMap': 1 argument required, but only 0 present.");
                return findStatus(s.list, keyId) !== null;
            });
            method(MediaKeyStatusMap.prototype, 'get', 1, function (keyId) {
                const s = statusSlot(this);
                if (arguments.length < 1)
                    throw new PTypeError("Failed to execute 'get' on 'MediaKeyStatusMap': 1 argument required, but only 0 present.");
                const hit = findStatus(s.list, keyId);
                return hit === null ? undefined : hit[1];
            });
            method(MediaKeyStatusMap.prototype, 'forEach', 1, function (callback, thisArg) {
                const s = statusSlot(this);
                if (typeof callback !== 'function')
                    throw new PTypeError("Failed to execute 'forEach' on 'MediaKeyStatusMap': The callback provided as parameter 1 is not a function.");
                const list = s.list.slice();
                for (let i = 0; i < list.length; i++)
                    ReflectApply(callback, thisArg, [list[i][1], list[i][0], this]);
            });
            const iterator = (kind) => function () {
                const s = statusSlot(this);
                const list = s.list.slice();
                return (function* () {
                    for (let i = 0; i < list.length; i++)
                        yield kind === 'keys' ? list[i][0] : kind === 'values' ? list[i][1] : [list[i][0], list[i][1]];
                })();
            };
            const entries = method(MediaKeyStatusMap.prototype, 'entries', 0, iterator('entries'));
            method(MediaKeyStatusMap.prototype, 'keys', 0, iterator('keys'));
            method(MediaKeyStatusMap.prototype, 'values', 0, iterator('values'));
            ObjectDefineProperty(MediaKeyStatusMap.prototype, SymbolIterator, { value: entries, writable: true, enumerable: false, configurable: true });
            const setStatuses = (map, statuses) => {
                if (Array.isArray(statuses))
                    statusSlot(map).list = statuses.filter((x) => Array.isArray(x) && x[0] instanceof HostArrayBuffer && typeof x[1] === 'string');
            };

            // --- MediaKeySystemAccess, MediaKeys, MediaKeySession ----------------------------------------------------------
            const accesses = new HostWeakMap(), mediaKeys = new HostWeakMap(), sessions = new HostWeakMap();
            const accessSlot = slot(accesses), keysSlot = slot(mediaKeys), sessionSlot = slot(sessions);
            const sessionsById = new HostMap();
            let handles = 0;
            const MediaKeySystemAccess = iface('MediaKeySystemAccess', null, null, 0);
            const MediaKeys = iface('MediaKeys', null, null, 0);
            const MediaKeySession = iface('MediaKeySession', PEventTarget, null, 0);

            attribute(MediaKeySystemAccess.prototype, 'keySystem', function () { return accessSlot(this).keySystem; });
            method(MediaKeySystemAccess.prototype, 'getConfiguration', 0, function () {
                return structuredClone(accessSlot(this).configuration);
            });
            method(MediaKeySystemAccess.prototype, 'createMediaKeys', 0, function () {
                const a = accesses.get(this);
                if (!a)
                    return rejectIllegal();
                const k = ++handles;
                return call('createMediaKeys', { a: a.a, k }).then(() => {
                    const o = ObjectCreate(MediaKeys.prototype);
                    mediaKeys.set(o, { k, sessionTypes: a.configuration && Array.isArray(a.configuration.sessionTypes) ? a.configuration.sessionTypes : ['temporary'] });
                    return o;
                }, (e) => { throw pageError(e); });
            });

            method(MediaKeys.prototype, 'createSession', 0, function (sessionType) {
                const k = keysSlot(this);
                const type = sessionType === undefined ? 'temporary' : String(sessionType);
                if (type !== 'temporary' && type !== 'persistent-license')
                    throw new PTypeError(`Failed to execute 'createSession' on 'MediaKeys': The provided value '${type}' is not a valid enum value of type MediaKeySessionType.`);
                if (!k.sessionTypes.includes(type))
                    throw dom("Failed to execute 'createSession' on 'MediaKeys': Unsupported session type.", 'NotSupportedError');
                const s = ++handles;
                const session = ReflectConstruct(PEventTarget, [], MediaKeySession);
                let resolveClosed;
                const closed = new HostPromise((r) => { resolveClosed = r; });
                const st = { s, k, type, sessionId: '', expiration: NaN, keyStatuses: makeStatusMap(), closed, resolveClosed, callable: false, isClosed: false, busy: false };
                sessions.set(session, st);
                sessionsById.set(s, new HostWeakRef(session));
                send('createSession', { k: k.k, s, args: [type] });
                return session;
            });
            method(MediaKeys.prototype, 'setServerCertificate', 1, function (...args) {
                const k = mediaKeys.get(this);
                if (!k)
                    return rejectIllegal();
                const cert = args.length ? bytesOf(args[0]) : undefined;
                return call('setServerCertificate', { k: k.k, args: args.length ? [cert] : [] }, transferable(cert)).catch((e) => { throw pageError(e); });
            });
            method(MediaKeys.prototype, 'getStatusForPolicy', 0, function (...args) {
                const k = mediaKeys.get(this);
                if (!k)
                    return rejectIllegal();
                let policy = args[0];
                if (policy !== null && typeof policy === 'object')
                    policy = { minHdcpVersion: policy.minHdcpVersion };
                return call('getStatusForPolicy', { k: k.k, args: args.length ? [policy] : [] }).catch((e) => { throw pageError(e); });
            });

            const sessionApply = (st, v) => {
                if (!v)
                    return;
                if (typeof v.sessionId === 'string')
                    st.sessionId = v.sessionId;
                if (typeof v.expiration === 'number')
                    st.expiration = v.expiration;
                setStatuses(st.keyStatuses, v.statuses);
            };
            attribute(MediaKeySession.prototype, 'sessionId', function () { return sessionSlot(this).sessionId; });
            attribute(MediaKeySession.prototype, 'expiration', function () { return sessionSlot(this).expiration; });
            attribute(MediaKeySession.prototype, 'closed', function () { return sessionSlot(this).closed; });
            attribute(MediaKeySession.prototype, 'keyStatuses', function () { return sessionSlot(this).keyStatuses; });
            handlerAttribute(MediaKeySession.prototype, 'keystatuseschange', sessionSlot);
            handlerAttribute(MediaKeySession.prototype, 'message', sessionSlot);
            const sessionCall = (op, transferArgs) => function (...args) {
                const st = sessions.get(this);
                if (!st)
                    return rejectIllegal();
                const sent = args.map(bytesOf);
                const transfer = [];
                if (transferArgs)
                    for (const x of sent)
                        if (x instanceof HostArrayBuffer)
                            transfer.push(x);
                return call(op, { s: st.s, args: sent }, transfer).then((v) => {
                    sessionApply(st, v);
                    return op === 'load' ? v.found : undefined;
                }, (e) => { throw pageError(e); });
            };
            method(MediaKeySession.prototype, 'generateRequest', 2, sessionCall('generateRequest', true));
            method(MediaKeySession.prototype, 'load', 1, sessionCall('load', false));
            method(MediaKeySession.prototype, 'update', 1, sessionCall('update', true));
            method(MediaKeySession.prototype, 'close', 0, sessionCall('close', false));
            method(MediaKeySession.prototype, 'remove', 0, sessionCall('remove', false));

            // --- navigator.requestMediaKeySystemAccess --------------------------------------------------------------------
            // The page's configurations as plain data, read as WebIDL reads a dictionary (its members in order, getters run
            // once); values of the wrong type are passed as they are, so the host's own conversion refuses them.
            const CAPABILITY = ['contentType', 'encryptionScheme', 'robustness'];
            const CONFIGURATION = ['audioCapabilities', 'distinctiveIdentifier', 'initDataTypes', 'label', 'persistentState', 'sessionTypes', 'videoCapabilities'];
            const sequence = (v, item) => {
                if (v === null || typeof v !== 'object' || typeof v[SymbolIterator] !== 'function')
                    return v;
                const out = [];
                for (const x of v)
                    out.push(item(x));
                return out;
            };
            const dictionary = (v, members, convert) => {
                if (v === null || v === undefined)
                    return {};
                if (typeof v !== 'object' && typeof v !== 'function')
                    return v;
                const out = {};
                for (const name of members) {
                    const x = v[name];
                    if (x !== undefined)
                        out[name] = convert(name, x);
                }
                return out;
            };
            const capability = (v) => dictionary(v, CAPABILITY, (n, x) => (typeof x === 'object' && x !== null ? String(x) : x));
            const configuration = (v) => dictionary(v, CONFIGURATION, (n, x) => {
                if (n === 'audioCapabilities' || n === 'videoCapabilities')
                    return sequence(x, capability);
                if (n === 'initDataTypes' || n === 'sessionTypes')
                    return sequence(x, (y) => (typeof y === 'object' && y !== null ? String(y) : y));
                return typeof x === 'object' && x !== null ? String(x) : x;
            });
            if (options.secure !== false) {
                method(PNavigator.prototype, 'requestMediaKeySystemAccess', 2, function (...args) {
                    if (!(this instanceof PNavigator))
                        return rejectIllegal();
                    const sent = args.slice(0, 2);
                    if (sent.length > 0 && typeof sent[0] === 'object' && sent[0] !== null)
                        sent[0] = String(sent[0]);
                    try {
                        if (sent.length > 1)
                            sent[1] = sequence(sent[1], configuration);
                    } catch (e) {
                        return HostPromise.reject(e);
                    }
                    const a = ++handles;
                    return call('access', { a, args: sent }).then((v) => {
                        const o = ObjectCreate(MediaKeySystemAccess.prototype);
                        accesses.set(o, { a, keySystem: v.keySystem, configuration: v.configuration });
                        return o;
                    }, (e) => { throw pageError(e); });
                });
            }

            // --- Media elements ----------------------------------------------------------------------------------------------
            // An element's state, once it used EME: its host twin's id, its MediaKeys, whether its media went to the host, and
            // the host element's last state (with the time it was taken, so currentTime moves on between reports).
            const elements = new HostWeakMap();
            const elementList = []; // WeakRefs, for the boxes
            const mediaKeysOf = new HostWeakMap();
            const elementState = (el) => {
                let d = elements.get(el);
                if (!d) {
                    d = { e: ++handles, el: new HostWeakRef(el), mk: null, setting: false, delegated: false, ms: null, snap: null, box: '', paused: true, plays: [] };
                    elements.set(el, d);
                    elementList.push(d.el);
                }
                return d;
            };
            const original = {
                setMediaKeys: null,
                play: methodOf(PHTMLMediaElement.prototype, 'play'),
                pause: methodOf(PHTMLMediaElement.prototype, 'pause'),
                fastSeek: methodOf(PHTMLMediaElement.prototype, 'fastSeek'),
                load: methodOf(PHTMLMediaElement.prototype, 'load'),
                src: getterOf(PHTMLMediaElement.prototype, 'src'),
                currentSrc: getterOf(PHTMLMediaElement.prototype, 'currentSrc'),
                muted: getterOf(PHTMLMediaElement.prototype, 'muted'),
                volume: getterOf(PHTMLMediaElement.prototype, 'volume'),
                rate: getterOf(PHTMLMediaElement.prototype, 'playbackRate'),
                defaultRate: getterOf(PHTMLMediaElement.prototype, 'defaultPlaybackRate'),
                loop: getterOf(PHTMLMediaElement.prototype, 'loop'),
                paused: getterOf(PHTMLMediaElement.prototype, 'paused'),
            };
            const attrsOf = (el) => ({
                muted: original.muted ? original.muted(el) : false,
                volume: original.volume ? original.volume(el) : 1,
                rate: original.rate ? original.rate(el) : 1,
                defaultRate: original.defaultRate ? original.defaultRate(el) : 1,
                loop: original.loop ? original.loop(el) : false,
                autoplay: ElementHasAttribute(el, 'autoplay'),
            });

            // MediaSources: the URL they were given (to find their element) and what was appended to them before a hand-over.
            const sources = new HostWeakMap();
            const buffers = new HostWeakMap();
            const sourceByUrl = new HostMap();
            const sourceState = (ms) => {
                let m = sources.get(ms);
                if (!m) {
                    m = { ms: new HostWeakRef(ms), url: '', sbs: [], logBytes: 0, logging: true, delegated: false, d: null, rs: 'open', dur: NaN, liveRange: null };
                    sources.set(ms, m);
                }
                return m;
            };
            if (PURL && typeof PURL.createObjectURL === 'function' && PMediaSource) {
                const createObjectURL = PURL.createObjectURL;
                const revokeObjectURL = PURL.revokeObjectURL;
                method(PURL, 'createObjectURL', 1, function (...args) {
                    const url = ReflectApply(createObjectURL, this, args);
                    if (args[0] instanceof PMediaSource) {
                        const m = sourceState(args[0]);
                        m.url = url;
                        sourceByUrl.set(url, m.ms);
                    }
                    return url;
                });
                ObjectDefineProperty(PURL, 'createObjectURL', { enumerable: true });
                method(PURL, 'revokeObjectURL', 1, function (...args) {
                    // the element keeps its MediaSource; only the lookup by URL ends when the element no longer uses it
                    return ReflectApply(revokeObjectURL, this, args);
                });
                ObjectDefineProperty(PURL, 'revokeObjectURL', { enumerable: true });
            }
            // The page element playing MediaSource `m`: one that used EME, or any media element of the page's document.
            const elementOfSource = (m) => {
                if (m.d) {
                    const el = m.d.el.deref();
                    if (el && original.currentSrc && (original.currentSrc(el) === m.url || original.src(el) === m.url))
                        return el;
                }
                if (!m.url || !original.src)
                    return null;
                for (const ref of elementList) {
                    const el = ref.deref();
                    if (el && (original.currentSrc(el) === m.url || original.src(el) === m.url))
                        return el;
                }
                const doc = pageDocument();
                if (!doc)
                    return null;
                const list = DocumentQuerySelectorAll(doc, 'video, audio');
                for (let i = 0; i < list.length; i++) {
                    const el = list[i];
                    if (original.currentSrc(el) === m.url || original.src(el) === m.url)
                        return el;
                }
                return null;
            };
            const sourceOfElement = (el) => {
                const url = original.currentSrc ? original.currentSrc(el) || original.src(el) : '';
                const ref = url ? sourceByUrl.get(url) : undefined;
                const ms = ref ? ref.deref() : undefined;
                return ms ? sourceState(ms) : null;
            };

            // Hands element `el`'s MediaSource `m` to the host: its buffers, what they were given so far, the element's attributes.
            function delegate(el, m) {
                const d = elementState(el);
                if (d.delegated && d.ms === m)
                    return d;
                if (d.delegated)
                    undelegate(d);
                d.delegated = true;
                d.ms = m;
                d.snap = null;
                d.paused = true;
                m.delegated = true;
                m.d = d;
                // The page changes the element's source (src, removeAttribute, a new MediaSource): the engine empties it,
                // and the host's video lets this media go.
                if (!d.watching) {
                    d.watching = true;
                    ReflectApply(EventTargetAddEventListener, el, ['emptied', () => {
                        if (d.delegated && d.ms && !(original.src(el) === d.ms.url || original.currentSrc(el) === d.ms.url))
                            undelegate(d);
                    }]);
                }
                const transfer = [];
                const sbs = m.sbs.map((b) => {
                    for (const op of b.log)
                        if (op.bytes)
                            transfer.push(op.bytes);
                    const log = b.log;
                    b.log = [];
                    return { b: b.b, type: b.type, log };
                });
                m.logging = false;
                m.logBytes = 0;
                send('delegate', { e: d.e, sbs, attrs: attrsOf(el) }, transfer);
                // play() already called (the engine fired its play event): the host plays, its play event is not the page's
                // second one, and the pending promises settle with the host's.
                if (original.paused && !original.paused(el)) {
                    d.paused = false;
                    d.skipPlay = true;
                    const waiting = d.plays.splice(0);
                    call('play', { e: d.e, loop: original.loop ? original.loop(el) : false }).then((s) => {
                        if (s)
                            d.snap = s;
                        for (const p of waiting)
                            p.resolve(undefined);
                    }, (e) => {
                        d.paused = true;
                        for (const p of waiting)
                            p.reject(pageError(e));
                    });
                }
                return d;
            }
            function undelegate(d) {
                if (!d.delegated)
                    return;
                d.delegated = false;
                if (d.ms) {
                    d.ms.delegated = false;
                    d.ms.d = null;
                }
                d.ms = null;
                d.snap = null;
                d.box = '';
                for (const p of d.plays)
                    p.reject(dom('The play() request was interrupted by a new load request. https://goo.gl/LdLk22', 'AbortError'));
                d.plays = [];
                send('undelegate', { e: d.e });
            }
            // Before bytes go to a MediaSource's buffer: should its element's media go to the host now?
            function maybeDelegate(m, bytes) {
                if (m.delegated)
                    return true;
                const el = elementOfSource(m);
                if (!el)
                    return false;
                const d = elements.get(el);
                if ((d && d.mk) || (bytes && sniffEncrypted(bytes))) {
                    delegate(el, m);
                    return true;
                }
                return false;
            }

            // setMediaKeys / mediaKeys / onencrypted / onwaitingforkey on HTMLMediaElement.
            method(PHTMLMediaElement.prototype, 'setMediaKeys', 1, function (...args) {
                if (!(this instanceof PHTMLMediaElement))
                    return rejectIllegal();
                if (args.length < 1)
                    return HostPromise.reject(new PTypeError("Failed to execute 'setMediaKeys' on 'HTMLMediaElement': 1 argument required, but only 0 present."));
                const keys = args[0];
                if (keys !== null && !mediaKeys.has(keys))
                    return HostPromise.reject(new PTypeError("Failed to execute 'setMediaKeys' on 'HTMLMediaElement': parameter 1 is not of type 'MediaKeys'."));
                const el = this;
                const d = elementState(el);
                // A source the page has just changed (src = '' then setMediaKeys, in one task): the host lets it go first.
                if (d.delegated && d.ms && !(original.src(el) === d.ms.url || original.currentSrc(el) === d.ms.url))
                    undelegate(d);
                if (d.setting)
                    return HostPromise.reject(dom("Failed to execute 'setMediaKeys' on 'HTMLMediaElement': Another request is in progress.", 'InvalidStateError'));
                d.setting = true;
                const done = () => { d.setting = false; };
                return call('setMediaKeys', { e: d.e, k: keys ? keysSlot(keys).k : 0 }).then(() => {
                    d.mk = keys;
                    mediaKeysOf.set(el, keys);
                    // An element already playing a MediaSource goes to the host now; one that gets one later, at its first append.
                    if (keys) {
                        const m = sourceOfElement(el);
                        if (m && !m.delegated)
                            delegate(el, m);
                    }
                    done();
                }, (e) => { done(); throw pageError(e); });
            });
            attribute(PHTMLMediaElement.prototype, 'mediaKeys', function () {
                if (!(this instanceof PHTMLMediaElement))
                    throw illegal();
                const k = mediaKeysOf.get(this);
                return k === undefined ? null : k;
            });
            const mediaSlot = (self_) => { if (!(self_ instanceof PHTMLMediaElement)) throw illegal(); return self_; };
            handlerAttribute(PHTMLMediaElement.prototype, 'encrypted', mediaSlot);
            handlerAttribute(PHTMLMediaElement.prototype, 'waitingforkey', mediaSlot);

            // TimeRanges and MediaError of a handed-over element: objects of the page's classes over the host's numbers.
            const ranges = new HostWeakMap();
            const makeRanges = (list) => {
                const o = ObjectCreate(PTimeRanges.prototype);
                ranges.set(o, Array.isArray(list) ? list : []);
                return o;
            };
            if (PTimeRanges) {
                const length = getterOf(PTimeRanges.prototype, 'length');
                const start = methodOf(PTimeRanges.prototype, 'start');
                const end = methodOf(PTimeRanges.prototype, 'end');
                attribute(PTimeRanges.prototype, 'length', function () {
                    const r = ranges.get(this);
                    return r ? r.length : length(this);
                });
                ObjectDefineProperty(PTimeRanges.prototype, 'length', { set: undefined });
                const at = (which, fallback) => function (...args) {
                    const r = ranges.get(this);
                    if (!r)
                        return fallback(this, ...args);
                    if (args.length < 1)
                        throw new PTypeError(`Failed to execute '${which}' on 'TimeRanges': 1 argument required, but only 0 present.`);
                    const i = Number(args[0]) >>> 0;
                    if (i >= r.length)
                        throw dom(`Failed to execute '${which}' on 'TimeRanges': The index provided (${i}) is greater than or equal to the maximum bound (${r.length}).`, 'IndexSizeError');
                    return r[i][which === 'start' ? 0 : 1];
                };
                method(PTimeRanges.prototype, 'start', 1, at('start', start));
                method(PTimeRanges.prototype, 'end', 1, at('end', end));
            }
            const errors = new HostWeakMap();
            if (PMediaError) {
                for (const name of ['code', 'message']) {
                    const g = getterOf(PMediaError.prototype, name);
                    attribute(PMediaError.prototype, name, function () {
                        const e = errors.get(this);
                        return e ? e[name] : g(this);
                    });
                }
            }

            // The element's members, the host's while its media is there.
            const live = (el) => {
                const d = elements.get(el);
                return d && d.delegated ? d : null;
            };
            const currentTimeOf = (d) => {
                const s = d.snap;
                if (!s)
                    return 0;
                if (s.paused || d.paused || s.seeking || s.ended || s.rs < 3)
                    return s.t;
                const t = s.t + ((now() - s.at) / 1000) * s.rate;
                return Number.isFinite(s.dur) ? Math.min(t, s.dur) : t;
            };
            const override = (proto, name, get, set) => {
                const d = own(proto, name);
                if (!d)
                    return;
                const engineGet = d.get ? uncurry(d.get) : null;
                const engineSet = d.set ? uncurry(d.set) : null;
                const g = ObjectGetOwnPropertyDescriptor({ get [name]() {
                    const s = live(this);
                    return s && get ? get(s, this) : engineGet(this);
                } }, name).get;
                native(g);
                let st;
                if (engineSet) {
                    st = ObjectGetOwnPropertyDescriptor({ set [name](v) {
                        const s = live(this);
                        if (s && set && set(s, this, v, engineSet) === true)
                            return;
                        engineSet(this, v);
                    } }, name).set;
                    native(st);
                }
                ObjectDefineProperty(proto, name, { get: g, set: st, enumerable: d.enumerable, configurable: true });
            };
            const snap = (d, k, dflt) => (d.snap ? d.snap[k] : dflt);
            override(PHTMLMediaElement.prototype, 'currentTime', (d) => currentTimeOf(d), (d, el, v) => {
                const t = Number(v);
                if (!Number.isFinite(t))
                    throw new PTypeError("Failed to set the 'currentTime' property on 'HTMLMediaElement': The provided double value is non-finite.");
                if (d.snap) {
                    d.snap.t = t;
                    d.snap.at = now();
                    d.snap.seeking = true;
                }
                send('media', { e: d.e, what: 'seek', value: t });
                return true;
            });
            override(PHTMLMediaElement.prototype, 'duration', (d) => snap(d, 'dur', d.ms ? d.ms.dur : NaN));
            override(PHTMLMediaElement.prototype, 'paused', (d) => d.paused);
            override(PHTMLMediaElement.prototype, 'ended', (d) => snap(d, 'ended', false));
            override(PHTMLMediaElement.prototype, 'seeking', (d) => snap(d, 'seeking', false));
            override(PHTMLMediaElement.prototype, 'readyState', (d) => snap(d, 'rs', 0));
            override(PHTMLMediaElement.prototype, 'networkState', (d) => snap(d, 'ns', 2));
            override(PHTMLMediaElement.prototype, 'buffered', (d) => makeRanges(snap(d, 'buf', [])));
            override(PHTMLMediaElement.prototype, 'seekable', (d) => makeRanges(snap(d, 'seekable', [])));
            override(PHTMLMediaElement.prototype, 'played', (d) => makeRanges(snap(d, 'played', [])));
            override(PHTMLMediaElement.prototype, 'error', (d) => {
                const e = snap(d, 'err', null);
                if (!e || !PMediaError)
                    return null;
                if (!d.errorObject || d.errorObject.code !== e.code) {
                    const o = ObjectCreate(PMediaError.prototype);
                    errors.set(o, { code: e.code, message: e.message });
                    d.errorObject = { code: e.code, o };
                }
                return d.errorObject.o;
            });
            // Volume, muted, rates and loop stay the engine element's (its events are the page's); the host follows.
            const follow = (name, what) => override(PHTMLMediaElement.prototype, name, null, (d, el, v, engineSet) => {
                engineSet(el, v);
                const g = getterOf(PHTMLMediaElement.prototype, name);
                send('media', { e: d.e, what, value: g ? g(el) : v });
                return true;
            });
            follow('volume', 'volume');
            follow('muted', 'muted');
            follow('playbackRate', 'rate');
            follow('defaultPlaybackRate', 'defaultRate');
            follow('loop', 'loop');
            if (PHTMLVideoElement) {
                override(PHTMLVideoElement.prototype, 'videoWidth', (d) => snap(d, 'w', 0));
                override(PHTMLVideoElement.prototype, 'videoHeight', (d) => snap(d, 'h', 0));
            }
            if (original.play) {
                method(PHTMLMediaElement.prototype, 'play', 0, function () {
                    const d = live(this);
                    if (!d) {
                        // A MediaSource element may go to the host later (its first encrypted append): its play() is then the
                        // host's, so the promise is ours, settled by the engine's unless the hand-over comes first.
                        const m = sourceOfElement(this);
                        const engine = original.play(this);
                        if (!m)
                            return engine;
                        const s = elementState(this);
                        return new HostPromise((resolve, reject) => {
                            const entry = { resolve, reject, early: true };
                            s.plays.push(entry);
                            engine.then((v) => { const i = s.plays.indexOf(entry); if (i >= 0 && !s.delegated) { s.plays.splice(i, 1); resolve(v); } },
                                (e) => { const i = s.plays.indexOf(entry); if (i >= 0 && !s.delegated) { s.plays.splice(i, 1); reject(e); } });
                        });
                    }
                    d.paused = false;
                    return new HostPromise((resolve, reject) => {
                        const entry = { resolve, reject };
                        d.plays.push(entry);
                        call('play', { e: d.e, loop: original.loop ? original.loop(this) : false }).then((s) => {
                            if (s)
                                d.snap = s;
                            const i = d.plays.indexOf(entry);
                            if (i >= 0) {
                                d.plays.splice(i, 1);
                                resolve(undefined);
                            }
                        }, (e) => {
                            const i = d.plays.indexOf(entry);
                            if (i >= 0) {
                                d.plays.splice(i, 1);
                                if (d.snap)
                                    d.paused = d.snap.paused = true;
                                reject(pageError(e));
                            }
                        });
                    });
                });
            }
            if (original.pause) {
                method(PHTMLMediaElement.prototype, 'pause', 0, function () {
                    const d = live(this);
                    if (!d)
                        return original.pause(this);
                    d.paused = true;
                    if (d.snap) {
                        d.snap.t = currentTimeOf(d);
                        d.snap.at = now();
                        d.snap.paused = true;
                    }
                    send('media', { e: d.e, what: 'pause' });
                    return undefined;
                });
            }
            if (original.fastSeek) {
                method(PHTMLMediaElement.prototype, 'fastSeek', 1, function (...args) {
                    const d = live(this);
                    if (!d)
                        return original.fastSeek(this, ...args);
                    send('media', { e: d.e, what: 'fastSeek', value: Number(args[0]) });
                    return undefined;
                });
            }
            if (original.load) {
                method(PHTMLMediaElement.prototype, 'load', 0, function () {
                    const d = elements.get(this);
                    if (d && d.delegated)
                        undelegate(d);
                    return original.load(this);
                });
            }

            // --- MediaSource and SourceBuffer -------------------------------------------------------------------------------
            if (PMediaSource && PSourceBuffer) {
                const MS = PMediaSource.prototype, SB = PSourceBuffer.prototype;
                const addSourceBuffer = methodOf(MS, 'addSourceBuffer');
                const removeSourceBuffer = methodOf(MS, 'removeSourceBuffer');
                const endOfStream = methodOf(MS, 'endOfStream');
                const msReadyState = getterOf(MS, 'readyState');
                const appendBuffer = methodOf(SB, 'appendBuffer');
                const sbUpdating = getterOf(SB, 'updating');
                const sbRemove = methodOf(SB, 'remove');
                const sbAbort = methodOf(SB, 'abort');
                const sbChangeType = methodOf(SB, 'changeType');
                const msOf = (self_) => (self_ instanceof PMediaSource ? sourceState(self_) : null);
                const bufferState = (sb) => buffers.get(sb);
                const prefixMS = (what) => `Failed to execute '${what}' on 'MediaSource': `;
                const prefixSB = (what) => `Failed to execute '${what}' on 'SourceBuffer': `;
                const removed = (b) => b.removed === true;

                method(MS, 'addSourceBuffer', 1, function (...args) {
                    const m = msOf(this);
                    const sb = addSourceBuffer(this, ...args); // the engine's checks and errors (type, state)
                    if (m) {
                        const b = { b: ++handles, sb: new HostWeakRef(sb), m, type: String(args[0]), log: [], updating: false, buf: [], tso: 0, mode: 'segments', aws: 0, awe: Infinity, removed: false };
                        buffers.set(sb, b);
                        m.sbs.push(b);
                        if (m.delegated)
                            send('addSourceBuffer', { e: m.d.e, b: b.b, type: b.type });
                    }
                    return sb;
                });
                method(MS, 'removeSourceBuffer', 1, function (...args) {
                    const m = msOf(this);
                    const b = args[0] instanceof PSourceBuffer ? bufferState(args[0]) : null;
                    const out = removeSourceBuffer(this, ...args);
                    if (m && b) {
                        b.removed = true;
                        const i = m.sbs.indexOf(b);
                        if (i >= 0)
                            m.sbs.splice(i, 1);
                        if (m.delegated)
                            send('removeSourceBuffer', { b: b.b });
                    }
                    return out;
                });
                const anyUpdating = (m) => m.sbs.some((b) => b.updating);
                attribute(MS, 'readyState', function () {
                    const m = sources.get(this);
                    return m && m.delegated ? m.rs : msReadyState(this);
                });
                ObjectDefineProperty(MS, 'readyState', { set: undefined });
                const msDuration = own(MS, 'duration');
                if (msDuration) {
                    const engineGet = uncurry(msDuration.get), engineSet = uncurry(msDuration.set);
                    attribute(MS, 'duration', function () {
                        const m = sources.get(this);
                        return m && m.delegated ? m.dur : engineGet(this);
                    }, function (v) {
                        const m = sources.get(this);
                        if (!m || !m.delegated)
                            return engineSet(this, v);
                        const t = Number(v);
                        const prefix = "Failed to set the 'duration' property on 'MediaSource': ";
                        if (Number.isNaN(t) || t < 0)
                            throw new PTypeError(prefix + `The value provided (${String(t)}) is ${Number.isNaN(t) ? 'NaN' : 'negative'}.`);
                        if (m.rs !== 'open')
                            throw dom(prefix + "The MediaSource's readyState is not 'open'.", 'InvalidStateError');
                        if (anyUpdating(m))
                            throw dom(prefix + "The 'updating' attribute is true on one or more of this MediaSource's SourceBuffers.", 'InvalidStateError');
                        m.dur = t;
                        send('source', { e: m.d.e, what: 'duration', value: t });
                    });
                }
                method(MS, 'endOfStream', 0, function (...args) {
                    const m = sources.get(this);
                    if (!m || !m.delegated)
                        return endOfStream(this, ...args);
                    const error = args[0];
                    if (error !== undefined && error !== 'network' && error !== 'decode')
                        throw new PTypeError(prefixMS('endOfStream') + `The provided value '${String(error)}' is not a valid enum value of type EndOfStreamError.`);
                    if (m.rs !== 'open')
                        throw dom(prefixMS('endOfStream') + "The MediaSource's readyState is not 'open'.", 'InvalidStateError');
                    if (anyUpdating(m))
                        throw dom(prefixMS('endOfStream') + "The 'updating' attribute is true on one or more of this MediaSource's SourceBuffers.", 'InvalidStateError');
                    m.rs = 'ended';
                    send('source', { e: m.d.e, what: 'endOfStream', value: error });
                    return undefined;
                });
                for (const what of ['setLiveSeekableRange', 'clearLiveSeekableRange']) {
                    const engine = methodOf(MS, what);
                    if (!engine)
                        continue;
                    method(MS, what, what === 'setLiveSeekableRange' ? 2 : 0, function (...args) {
                        const m = sources.get(this);
                        if (!m || !m.delegated)
                            return engine(this, ...args);
                        send('source', { e: m.d.e, what, start: Number(args[0]), end: Number(args[1]) });
                        return undefined;
                    });
                }

                // A buffer's operation, checked as Chrome checks it, then sent; its events come back from the host.
                const checkBuffer = (b, what) => {
                    if (removed(b))
                        throw dom(prefixSB(what) + 'This SourceBuffer has been removed from the parent media source.', 'InvalidStateError');
                    if (b.updating || (sbUpdating && b.sbEngineUpdating))
                        throw dom(prefixSB(what) + "This SourceBuffer is still processing an 'appendBuffer' or 'remove' operation.", 'InvalidStateError');
                };
                const reopen = (m) => {
                    if (m.rs === 'ended')
                        m.rs = 'open'; // the host fires sourceopen
                };
                method(SB, 'appendBuffer', 1, function (...args) {
                    const b = bufferState(this);
                    if (!b)
                        return appendBuffer(this, ...args);
                    const m = b.m;
                    const data = args[0];
                    const isBytes = data instanceof HostArrayBuffer || ArrayBufferIsView(data);
                    if (!m.delegated) {
                        const view = isBytes ? (data instanceof HostArrayBuffer ? new HostUint8Array(data) : new HostUint8Array(data.buffer, data.byteOffset, data.byteLength)) : null;
                        if (!maybeDelegate(m, view)) {
                            const out = appendBuffer(this, ...args); // the engine's own checks first
                            if (m.logging && view) {
                                m.logBytes += view.length;
                                if (m.logBytes > MAX_LOG_BYTES) {
                                    m.logging = false;
                                    for (const x of m.sbs)
                                        x.log = [];
                                } else {
                                    b.log.push({ kind: 'append', bytes: bytesOf(data) });
                                }
                            }
                            return out;
                        }
                    }
                    if (args.length < 1)
                        throw new PTypeError(prefixSB('appendBuffer') + '1 argument required, but only 0 present.');
                    if (!isBytes)
                        throw new PTypeError(prefixSB('appendBuffer') + "The provided value is not of type '(ArrayBuffer or ArrayBufferView)'.");
                    b.sbEngineUpdating = sbUpdating ? sbUpdating(this) : false;
                    checkBuffer(b, 'appendBuffer');
                    reopen(m);
                    b.updating = true;
                    const bytes = bytesOf(data);
                    send('buffer', { e: b.m.d.e, b: b.b, act: { kind: 'append', bytes } }, [bytes]);
                    return undefined;
                });
                method(SB, 'remove', 2, function (...args) {
                    const b = bufferState(this);
                    if (!b || !b.m.delegated)
                        return sbRemove(this, ...args);
                    if (args.length < 2)
                        throw new PTypeError(prefixSB('remove') + `2 arguments required, but only ${args.length} present.`);
                    checkBuffer(b, 'remove');
                    const start = Number(args[0]), end = Number(args[1]);
                    const dur = b.m.dur;
                    if (Number.isNaN(dur) || start < 0 || start > dur)
                        throw new PTypeError(prefixSB('remove') + `The start provided (${start}) is outside the range (0, ${dur}).`);
                    if (!(end > start) || Number.isNaN(end))
                        throw new PTypeError(prefixSB('remove') + `The end value provided (${end}) must be greater than the start value provided (${start}).`);
                    reopen(b.m);
                    b.updating = true;
                    send('buffer', { e: b.m.d.e, b: b.b, act: { kind: 'remove', start, end } });
                    return undefined;
                });
                method(SB, 'abort', 0, function () {
                    const b = bufferState(this);
                    if (!b || !b.m.delegated)
                        return sbAbort(this);
                    if (removed(b))
                        throw dom(prefixSB('abort') + 'This SourceBuffer has been removed from the parent media source.', 'InvalidStateError');
                    send('buffer', { e: b.m.d.e, b: b.b, act: { kind: 'abort' } });
                    return undefined;
                });
                if (sbChangeType) {
                    method(SB, 'changeType', 1, function (...args) {
                        const b = bufferState(this);
                        if (!b || !b.m.delegated)
                            return sbChangeType(this, ...args);
                        checkBuffer(b, 'changeType');
                        b.type = String(args[0]);
                        send('buffer', { e: b.m.d.e, b: b.b, act: { kind: 'changeType', value: b.type } });
                        return undefined;
                    });
                }
                const bufferMember = (name, field, kind, convert) => {
                    const d = own(SB, name);
                    if (!d)
                        return;
                    const engineGet = uncurry(d.get), engineSet = d.set ? uncurry(d.set) : null;
                    attribute(SB, name, function () {
                        const b = bufferState(this);
                        if (!b || !b.m.delegated)
                            return engineGet(this);
                        if (field === 'buf')
                            return makeRanges(b.buf);
                        return b[field];
                    }, engineSet ? function (v) {
                        const b = bufferState(this);
                        if (!b || !b.m.delegated) {
                            engineSet(this, v);
                            if (b && b.m.logging)
                                b.log.push({ kind, value: engineGet(this) });
                            return;
                        }
                        const value = convert(v, name);
                        checkBuffer(b, name);
                        b[field] = value;
                        send('buffer', { e: b.m.d.e, b: b.b, act: { kind, value } });
                    } : undefined);
                    if (!engineSet)
                        ObjectDefineProperty(SB, name, { set: undefined });
                };
                const finite = (v, name) => {
                    const t = Number(v);
                    if (!Number.isFinite(t))
                        throw new PTypeError(`Failed to set the '${name}' property on 'SourceBuffer': The provided double value is non-finite.`);
                    return t;
                };
                ObjectDefineProperty(SB, 'updating', { get: ObjectGetOwnPropertyDescriptor({ get updating() {
                    const b = bufferState(this);
                    return b && b.m.delegated ? b.updating || sbUpdating(this) : sbUpdating(this);
                } }, 'updating').get, set: undefined, enumerable: true, configurable: true });
                native(ObjectGetOwnPropertyDescriptor(SB, 'updating').get);
                bufferMember('buffered', 'buf', null, null);
                bufferMember('timestampOffset', 'tso', 'tso', finite);
                bufferMember('mode', 'mode', 'mode', (v) => {
                    const s = String(v);
                    if (s !== 'segments' && s !== 'sequence')
                        throw new PTypeError(`Failed to set the 'mode' property on 'SourceBuffer': The provided value '${s}' is not a valid enum value of type AppendMode.`);
                    return s;
                });
                bufferMember('appendWindowStart', 'aws', 'aws', finite);
                bufferMember('appendWindowEnd', 'awe', 'awe', (v) => Number(v));
            }

            // --- What the segment document reports ---------------------------------------------------------------------------
            const DROP = new HostSet(['loadstart', 'volumechange', 'ratechange']);
            function onElementEvent(m) {
                let d = null, el = null;
                for (const ref of elementList) {
                    const x = ref.deref();
                    const s = x ? elements.get(x) : null;
                    if (s && s.e === m.e) {
                        d = s;
                        el = x;
                        break;
                    }
                }
                if (!d || !d.delegated)
                    return;
                if (m.st) {
                    d.snap = m.st;
                    if (m.type === 'pause' || m.type === 'ended' || m.type === 'play' || m.type === 'playing')
                        d.paused = m.st.paused;
                }
                if (m.type === 'durationchange' && d.ms && m.st)
                    d.ms.dur = m.st.dur;
                if (DROP.has(m.type))
                    return;
                if (m.type === 'play' && d.skipPlay) {
                    d.skipPlay = false;
                    return;
                }
                let event;
                if (m.type === 'encrypted') {
                    event = ReflectConstruct(PEvent, ['encrypted'], MediaEncryptedEvent);
                    encryptedEvents.set(event, { initDataType: typeof m.initDataType === 'string' ? m.initDataType : '', initData: m.initData instanceof HostArrayBuffer ? m.initData : null });
                } else {
                    event = new PEvent(m.type);
                }
                fire(el, event);
            }
            function bufferById(id) {
                for (const ref of elementList) {
                    const x = ref.deref();
                    const d = x ? elements.get(x) : null;
                    if (d && d.ms)
                        for (const b of d.ms.sbs)
                            if (b.b === id)
                                return b;
                }
                return null;
            }
            function onBufferEvent(m) {
                const b = bufferById(m.b);
                if (!b || !b.m.delegated)
                    return;
                const st = m.st;
                if (st) {
                    if (!m.replay)
                        b.updating = st.updating === true;
                    b.buf = Array.isArray(st.buf) ? st.buf : [];
                    b.tso = st.tso;
                    b.mode = st.mode;
                    b.aws = st.aws;
                    b.awe = st.awe;
                }
                if (m.ms) {
                    b.m.dur = m.ms.dur;
                    b.m.rs = m.ms.rs;
                }
                if (m.replay)
                    return;
                const sb = b.sb.deref();
                if (sb)
                    fire(sb, new PEvent(m.type));
            }
            function onSourceEvent(m) {
                for (const ref of elementList) {
                    const x = ref.deref();
                    const d = x ? elements.get(x) : null;
                    if (!d || d.e !== m.e || !d.ms)
                        continue;
                    if (m.st) {
                        d.ms.rs = m.st.rs;
                        d.ms.dur = m.st.dur;
                    }
                    if (m.first)
                        return; // the page heard the engine's sourceopen
                    const ms = d.ms.ms.deref();
                    if (ms)
                        fire(ms, new PEvent(m.type));
                    return;
                }
            }
            function onSessionEvent(m) {
                const ref = sessionsById.get(m.s);
                const session = ref ? ref.deref() : null;
                const st = session ? sessions.get(session) : null;
                if (!st)
                    return;
                if (m.type === 'message') {
                    const event = ReflectConstruct(PEvent, ['message'], MediaKeyMessageEvent);
                    messageEvents.set(event, { messageType: m.messageType, message: m.message });
                    fire(session, event);
                } else if (m.type === 'keystatuseschange') {
                    setStatuses(st.keyStatuses, m.statuses);
                    if (typeof m.expiration === 'number')
                        st.expiration = m.expiration;
                    fire(session, new PEvent('keystatuseschange'));
                } else if (m.type === 'closed') {
                    setStatuses(st.keyStatuses, m.statuses);
                    st.isClosed = true;
                    st.resolveClosed(m.reason);
                }
            }
            port.onmessage = (event) => {
                const m = event.data;
                if (!m || typeof m !== 'object')
                    return;
                try {
                    if (typeof m.re === 'number') {
                        const p = pending.get(m.re);
                        if (p) {
                            pending.delete(m.re);
                            if (m.ok)
                                p.resolve(m.value);
                            else
                                p.reject(m.error);
                        }
                    } else if (m.ev === 'el') {
                        onElementEvent(m);
                    } else if (m.ev === 'sb') {
                        onBufferEvent(m);
                    } else if (m.ev === 'debug') {
                        if (options.status)
                            options.status('eme debug', String(m.text));
                    } else if (m.ev === 'ms-error') {
                        if (options.status)
                            options.status('eme host error', `${m.error && m.error.name}: ${m.error && m.error.message}`);
                    } else if (m.ev === 'sb-error') {
                        if (options.status)
                            options.status('eme host error', `buffer: ${m.error && m.error.name}: ${m.error && m.error.message}`);
                        const b = bufferById(m.b);
                        if (b && m.st)
                            b.updating = m.st.updating === true;
                    } else if (m.ev === 'ms') {
                        onSourceEvent(m);
                    } else if (m.ev === 'session') {
                        onSessionEvent(m);
                    }
                } finally {
                    pump();
                }
            };

            // --- Boxes: after each paint, where each handed-over <video> is, for the host's video layer ---------------------
            function boxOf(d, el) {
                const doc = pageDocument();
                if (!PHTMLVideoElement || !(el instanceof PHTMLVideoElement) || !NodeIsConnected(el) || NodeOwnerDocument(el) !== doc)
                    return { show: false };
                const cs = getComputedStyle(el);
                const px = (name) => parseFloat(CSSGetPropertyValue(cs, name)) || 0;
                if (CSSGetPropertyValue(cs, 'visibility') !== 'visible' || CSSGetPropertyValue(cs, 'display') === 'none')
                    return { show: false };
                const r = ElementGetBoundingClientRect(el);
                const x = DOMRectGet(r, 'x') + px('border-left-width') + px('padding-left');
                const y = DOMRectGet(r, 'y') + px('border-top-width') + px('padding-top');
                const w = DOMRectGet(r, 'width') - px('border-left-width') - px('padding-left') - px('border-right-width') - px('padding-right');
                const h = DOMRectGet(r, 'height') - px('border-top-width') - px('padding-top') - px('border-bottom-width') - px('padding-bottom');
                return { show: w > 0 && h > 0, x, y, w, h, fit: CSSGetPropertyValue(cs, 'object-fit') || 'contain' };
            }
            function frame() {
                for (let i = 0; i < elementList.length; i++) {
                    const el = elementList[i].deref();
                    const d = el ? elements.get(el) : null;
                    if (!d || !d.delegated)
                        continue;
                    let box;
                    try {
                        box = boxOf(d, el);
                    } catch {
                        box = { show: false };
                    }
                    box.z = i;
                    const key = box.show ? `${box.x},${box.y},${box.w},${box.h},${box.fit},${box.z}` : 'hidden';
                    if (key === d.box)
                        continue;
                    d.box = key;
                    box.e = d.e;
                    send('box', box);
                }
            }
            const redefine = () => {
                for (const [name, cls] of globals)
                    ObjectDefineProperty(P, name, { value: cls, writable: true, enumerable: false, configurable: true });
            };
            return { frame, redefine, active: () => elementList.length > 0 };
        }
        return { install, sniffEncrypted };
    }
    G.__chitinEME = Object.freeze({ create });
})();
