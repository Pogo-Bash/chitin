// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin engine glue: cross-site iframes as nested segments (docs/architecture.md "Nested segments").
// The parent's engine never loads a cross-site iframe (its browsing context stays about:blank); this file lists
// those iframes for the host (api.subframes), gives the page a cross-origin WindowProxy stand-in for each
// (iframe.contentWindow; contentDocument is null), and in a child gives window.parent / window.top the same kind
// of stand-in. postMessage on a stand-in goes to the host (options.frames.post), which hands it to the carapace;
// the carapace checks targetOrigin and stamps the sender's origin. A message from the other segment arrives
// through api.deliverMessage and is fired as a trusted MessageEvent whose `source` is the stand-in. MessagePorts
// in a transfer are bridged over host MessagePorts (host structured clone, both ways).

const ORIGIN_RE = /^(https?):\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)(?::(\d*))?(?:[/?#]|$)/i;
const RegExpPrototypeExec = uncurryThis(RegExp.prototype.exec);
const StringPrototypeToLowerCase = uncurryThis(HostString.prototype.toLowerCase);
const StringPrototypeSplit = uncurryThis(HostString.prototype.split);
const ArrayPrototypeJoin = uncurryThis(Array.prototype.join);
const ArrayPrototypeSlice = uncurryThis(Array.prototype.slice);
const ArrayFrom = Array.from;
const FramesMap = globalThis.Map;

// The origin of an http(s) URL, or null (the glue has no URL parser of its own).
function urlOrigin(url) {
    const m = RegExpPrototypeExec(ORIGIN_RE, HostString(url));
    if (m === null)
        return null;
    const scheme = StringPrototypeToLowerCase(m[1]);
    const host = StringPrototypeToLowerCase(m[2]);
    if (host === '')
        return null;
    let port = m[3] || '';
    if ((scheme === 'https' && port === '443') || (scheme === 'http' && port === '80'))
        port = '';
    return scheme + '://' + host + (port ? ':' + port : '');
}
// The registrable domain by the Public Suffix List (glue/cookies.js), as harness/carapace/guard.mjs siteOf (the carapace checks
// again).
function urlSite(url) {
    const m = RegExpPrototypeExec(ORIGIN_RE, HostString(url));
    if (m === null)
        return null;
    return ChitinCookies.registrableDomain(StringPrototypeToLowerCase(m[2]));
}

let framesInstalled = false;
// Filled before installGlobal in a child: `parent` and `top` are the parent's stand-in (`top` is
// [LegacyUnforgeable], so it cannot be replaced after the mirror defined it).
let globalReplacements = null;
const FramesWeakRef = globalThis.WeakRef;
const WeakRefDeref = uncurryThis(globalThis.WeakRef.prototype.deref);
let shadowRoots = [];                     // WeakRefs to every shadow root attached in this document
const F = { __proto__: null };            // captured engine functions (before any page script)
const frameIds = new WeakMap();          // iframe element -> id
const frameProxies = new WeakMap();      // iframe element -> stand-in
const framesById = new FramesMap();      // id -> iframe element
let nextFrameId = 1;
let parentProxy = null;
const eventSources = new WeakMap();      // MessageEvent made here -> stand-in source
const eventPorts = new WeakMap();        // MessageEvent made here -> frozen array of engine ports
const bridgedPorts = new WeakMap();      // engine MessagePort -> host MessagePort it talks over
const detachedPorts = new HostWeakSet(); // engine ports transferred away
const portPartners = new WeakMap();      // engine MessagePort -> its entangled twin (from MessageChannel)

const getter = (proto, name) => {
    const d = ObjectGetOwnPropertyDescriptor(proto, name);
    return d && d.get;
};
// Functions that look like the browser's own: method and accessor shorthands have no `prototype` (a plain function has one, which
// `Object.getOwnPropertyNames(fn)` shows and a native's does not), a native name, and the length the interface declares.
function nativeGetter(name, fn) {
    const holder = {
        get [name]() { return ReflectApply(fn, this, []); },
    };
    const g = ObjectGetOwnPropertyDescriptor(holder, name).get;
    WeakSetPrototypeAdd(nativeFunctions, g);
    return g;
}
function nativeMethod(name, fn, length) {
    const m = { [name](...args) { return ReflectApply(fn, this, args); } }[name];
    ObjectDefineProperty(m, 'length', { value: length === undefined ? fn.length : length, configurable: true });
    WeakSetPrototypeAdd(nativeFunctions, m);
    return m;
}
function securityError(what) {
    return new F.DOMException('Blocked a frame with origin "' + ownOrigin() + '" from accessing a cross-origin frame' + (what ? ' (' + what + ')' : '') + '.', 'SecurityError');
}
function ownOrigin() {
    try {
        return ReflectApply(F.originGet, G, []);
    } catch {
        return 'null';
    }
}

// --- The cross-origin WindowProxy stand-in -------------------------------------------------------------------
// What Chrome lets a page reach on a cross-origin window (HTML "CrossOriginProperties"): postMessage, window, self,
// frames, parent, top, closed, length, focus, blur, close, location. Anything else throws a SecurityError; then,
// @@toStringTag, @@hasInstance and @@isConcatSpreadable read as undefined.
const FALLBACK_KEYS = { __proto__: null, then: true };
// `extra` (a popup's stand-in, 52-popups.js): { closed(), close(), navigate(url), location() } where location() is null while the
// window is cross-origin, else the same-origin Location stand-in.
function makeRemoteWindow(target, relatives, extra) {
    const members = { __proto__: null };
    const post = makePostMessage(target);
    const noop = (name) => nativeMethod(name, function () {});
    members.postMessage = post;
    members.focus = noop('focus');
    members.blur = noop('blur');
    members.close = extra ? nativeMethod('close', function close() { extra.close(); }, 0) : noop('close');
    const remoteLocation = makeRemoteLocation(extra ? extra.navigate : undefined);
    members.location = remoteLocation;
    let proxy;
    const lookup = (key) => {
        if (key === 'window' || key === 'self' || key === 'frames')
            return proxy;
        if (key === 'parent')
            return relatives.parent();
        if (key === 'top')
            return relatives.top();
        if (key === 'closed')
            return extra ? extra.closed() : false;
        if (key === 'location' && extra) {
            const readable = extra.location();
            return readable !== null ? readable : remoteLocation;
        }
        if (key === 'length')
            return 0;
        return members[key];
    };
    const allowed = (key) => typeof key === 'string' && (members[key] !== undefined || key === 'window' || key === 'self' || key === 'frames' || key === 'parent' || key === 'top' || key === 'closed' || key === 'length');
    const handler = {
        __proto__: null,
        get(t, key) {
            if (allowed(key))
                return lookup(key);
            if (typeof key === 'symbol' ? key === SymbolToStringTag || key === HostSymbol.hasInstance || key === HostSymbol.isConcatSpreadable : FALLBACK_KEYS[key] === true)
                return undefined;
            throw securityError(typeof key === 'string' ? key : '');
        },
        set(t, key) { throw securityError(typeof key === 'string' ? key : ''); },
        has(t, key) { return allowed(key); },
        getOwnPropertyDescriptor(t, key) {
            if (!allowed(key))
                throw securityError(typeof key === 'string' ? key : '');
            return { value: lookup(key), writable: false, enumerable: false, configurable: true };
        },
        defineProperty(t, key) { throw securityError(typeof key === 'string' ? key : ''); },
        deleteProperty(t, key) { throw securityError(typeof key === 'string' ? key : ''); },
        ownKeys() { return ['postMessage', 'focus', 'blur', 'close', 'location', 'window', 'self', 'frames', 'parent', 'top', 'closed', 'length']; },
        getPrototypeOf() { return null; },
        setPrototypeOf() { throw securityError('prototype'); },
        isExtensible() { return true; },
        preventExtensions() { throw securityError('preventExtensions'); },
    };
    proxy = new HostProxy(ObjectCreate(null), handler);
    return proxy;
}

// The cross-origin Location (HTML "CrossOriginProperties" of Location): `replace` and the `href` setter, nothing else
// (reading href, or any other member, is a SecurityError). Navigating the other segment from here is not carried out: a
// child navigating its parent is what Chrome blocks without a user gesture (the case of every frame here: the segment does
// not see the parent's activation), and a parent navigating a cross-site child is not wired to the carapace yet. The URL is
// still checked, so a malformed one throws as in Chrome.
// A popup's stand-in (52-popups.js) passes `navigate`: there the opener does navigate the window it opened.
function makeRemoteLocation(navigate) {
    const check = (url) => {
        const s = HostString(url);
        let resolved = s;
        if (callbacks.HostURL) {
            try {
                resolved = HostString(new callbacks.HostURL(s, ownLocationHref()).href);
            } catch {
                throw new F.DOMException("Failed to execute 'replace' on 'Location': '" + s + "' is not a valid URL.", 'SyntaxError');
            }
        }
        if (navigate !== undefined)
            navigate(resolved);
    };
    const replace = nativeMethod('replace', function replace(url) {
        if (arguments.length === 0)
            throw new HostTypeError("Failed to execute 'replace' on 'Location': 1 argument required, but only 0 present.");
        check(url);
    }, 1);
    const hrefSet = { set href(v) { check(v); } };
    const setter = ObjectGetOwnPropertyDescriptor(hrefSet, 'href').set;
    WeakSetPrototypeAdd(nativeFunctions, setter);
    const allowed = (key) => key === 'replace' || key === 'href';
    const handler = {
        __proto__: null,
        get(t, key) {
            if (key === 'replace')
                return replace;
            if (typeof key === 'symbol' ? key === SymbolToStringTag || key === HostSymbol.hasInstance || key === HostSymbol.isConcatSpreadable : FALLBACK_KEYS[key] === true)
                return undefined;
            throw securityError(typeof key === 'string' ? key : '');
        },
        set(t, key, value) {
            if (key !== 'href')
                throw securityError(typeof key === 'string' ? key : '');
            ReflectApply(setter, undefined, [value]);
            return true;
        },
        has(t, key) { return allowed(key); },
        getOwnPropertyDescriptor(t, key) {
            if (key === 'replace')
                return { value: replace, writable: false, enumerable: false, configurable: true };
            if (key === 'href')
                return { get: undefined, set: setter, enumerable: false, configurable: true };
            throw securityError(typeof key === 'string' ? key : '');
        },
        defineProperty(t, key) { throw securityError(typeof key === 'string' ? key : ''); },
        deleteProperty(t, key) { throw securityError(typeof key === 'string' ? key : ''); },
        ownKeys() { return ['href', 'replace']; },
        getPrototypeOf() { return null; },
        setPrototypeOf() { throw securityError('prototype'); },
        isExtensible() { return true; },
        preventExtensions() { throw securityError('preventExtensions'); },
    };
    return new HostProxy(ObjectCreate(null), handler);
}
function ownLocationHref() {
    try {
        return HostString(G.location.href);
    } catch {
        return undefined;
    }
}

// postMessage(message, targetOrigin, transfer) or postMessage(message, { targetOrigin, transfer }).
function makePostMessage(target) {
    return nativeMethod('postMessage', function postMessage(message, targetOrigin, transfer) {
        if (arguments.length === 0)
            throw new HostTypeError("Failed to execute 'postMessage' on 'Window': 1 argument required, but only 0 present.");
        let origin;
        let list;
        if (targetOrigin !== null && typeof targetOrigin === 'object') {
            origin = targetOrigin.targetOrigin === undefined ? '/' : HostString(targetOrigin.targetOrigin);
            list = targetOrigin.transfer;
        } else {
            origin = targetOrigin === undefined ? '/' : HostString(targetOrigin);
            list = transfer;
        }
        if (origin === '/')
            origin = ownOrigin();
        else if (origin !== '*') {
            const o = urlOrigin(origin);
            if (o === null)
                throw new F.DOMException("Failed to execute 'postMessage' on 'Window': Invalid target origin '" + origin + "' in a call to 'postMessage'.", 'SyntaxError');
            origin = o;
        }
        const ports = [];
        const others = [];
        if (list !== undefined && list !== null) {
            const items = ArrayFrom(list);
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (item instanceof F.MessagePort)
                    ArrayPrototypePush(ports, exportPort(item));
                else
                    ArrayPrototypePush(others, item);
            }
        }
        const to = target();
        if (to === null || !callbacks.frames || typeof callbacks.frames.post !== 'function')
            return;
        try {
            callbacks.frames.post(to, message, origin, ports, others);
        } catch (e) {
            if (e && e.name === 'DataCloneError')
                throw new F.DOMException(HostString(e.message), 'DataCloneError');
            throw e;
        }
    });
}

// --- MessagePorts across segments ---------------------------------------------------------------------------
// An engine port the page transfers: its twin stays with the page and talks over a new host channel from now on;
// a port that already talks over a host port hands that host port on.
function exportPort(port) {
    if (WeakSetPrototypeHas(detachedPorts, port))
        throw new F.DOMException('Port at index 0 is already neutered.', 'DataCloneError');
    WeakSetPrototypeAdd(detachedPorts, port);
    const existing = WeakMapPrototypeGet(bridgedPorts, port);
    if (existing !== undefined) {
        WeakMapPrototypeDelete(bridgedPorts, port);
        return existing;
    }
    const channel = new callbacks.HostMessageChannel();
    const twin = WeakMapPrototypeGet(portPartners, port);
    if (twin !== undefined)
        bindPort(twin, channel.port1);
    return channel.port2;
}
// A host port that arrived with a message: the page gets an engine port that talks over it.
function importPort(hostPort) {
    const channel = new F.MessageChannel();
    const port = ReflectApply(F.port2Get, channel, []);
    bindPort(port, hostPort);
    return port;
}
function bindPort(port, hostPort) {
    WeakMapPrototypeSet(bridgedPorts, port, hostPort);
    hostPort.onmessage = (e) => {
        if (WeakMapPrototypeGet(bridgedPorts, port) !== hostPort)
            return;
        fireMessage(port, callbacks.streams ? callbacks.streams.inbound(e.data) : e.data, '', null, e.ports);
    };
    if (typeof hostPort.unref === 'function')
        hostPort.unref(); // Node: an open port does not keep a test alive
}

// A trusted MessageEvent on `target` (the window or a port), dispatched by the engine.
function fireMessage(target, data, origin, source, hostPorts) {
    const ports = [];
    if (hostPorts)
        for (let i = 0; i < hostPorts.length; i++)
            ArrayPrototypePush(ports, importPort(hostPorts[i]));
    const event = new F.MessageEvent('message', { data, origin, lastEventId: '' });
    WeakMapPrototypeSet(eventSources, event, source);
    WeakMapPrototypeSet(eventPorts, event, ObjectFreeze(ports));
    const targetCell = target === G ? globalCell : WeakMapPrototypeGet(cellOf, target);
    const eventCell = WeakMapPrototypeGet(cellOf, event);
    if (!targetCell || !eventCell)
        return false;
    const entered = idleEntry();
    const mark = scratchTop;
    try {
        const t = slots(1), ev = slots(1);
        writeObject(t, targetCell);
        writeObject(ev, eventCell);
        return X.ganglion_dispatch_trusted(t, ev) === 1;
    } finally {
        scratchTop = mark;
        idleExit(entered);
    }
}

// A trusted dispatch of an event the page's own constructors made, to an EventTarget of the page (WebSocket's open, message, error
// and close are the browser's events, isTrusted true; the page's own dispatchEvent would mark them untrusted).
api.dispatchTrusted = (target, event) => {
    const targetCell = WeakMapPrototypeGet(cellOf, target);
    const eventCell = WeakMapPrototypeGet(cellOf, event);
    if (!targetCell || !eventCell)
        return false;
    const entered = idleEntry();
    const mark = scratchTop;
    try {
        const t = slots(1), ev = slots(1);
        writeObject(t, targetCell);
        writeObject(ev, eventCell);
        return X.ganglion_dispatch_trusted(t, ev) === 1;
    } finally {
        scratchTop = mark;
        idleExit(entered);
    }
};

// A MessageEvent for a page Worker's message (harness/segment/pagesw-host.js), cheap: made with no init dictionary (converting
// `{ data, ports }` into the engine took most of a Worker-to-page message, 70 of 110 us), its data and frozen ports kept here,
// read back by the getters above exactly as for an event the page constructed with them. `C` is the realm's MessageEvent.
api.messageEvent = (C, data, ports) => {
    const event = new C('message');
    WeakMapPrototypeSet(constructedMessageData, event, { value: data === undefined ? null : data });
    WeakMapPrototypeSet(eventPorts, event, ObjectFreeze(ports || []));
    return event;
};

// HTML "notify about rejected promises": the page's promises are the host V8's, which tracks their rejections and fires
// unhandledrejection / rejectionhandled at the host global after a microtask checkpoint. The host (the segment Worker) hands
// each one here: a trusted PromiseRejectionEvent at the page's window (unhandledrejection cancelable, rejectionhandled not).
// Returns true when the page cancelled it, and the host then cancels its own (no console report, as in Chrome).
api.promiseRejection = (type, promise, reason) => {
    if (type !== 'unhandledrejection' && type !== 'rejectionhandled')
        return false;
    if (stoppedReason !== null || !scriptingOn || globalCell === 0)
        return false;
    const PRE = MapPrototypeGet(classByName, 'PromiseRejectionEvent');
    if (PRE === undefined)
        return false;
    let event;
    try {
        event = new PRE(type, { promise, reason, cancelable: type === 'unhandledrejection' });
    } catch {
        return false;
    }
    const eventCell = WeakMapPrototypeGet(cellOf, event);
    if (!eventCell)
        return false;
    const entered = idleEntry();
    const mark = scratchTop;
    try {
        const t = slots(1), ev = slots(1);
        writeObject(t, globalCell);
        writeObject(ev, eventCell);
        if (X.ganglion_dispatch_trusted(t, ev) !== 1)
            return false;
    } finally {
        scratchTop = mark;
        idleExit(entered);
    }
    return event.defaultPrevented === true;
};

// --- Which iframes are remote -------------------------------------------------------------------------------
function remoteUrl(el) {
    let url;
    try {
        url = ReflectApply(F.srcGet, el, []);
    } catch {
        return null;
    }
    if (typeof url !== 'string' || urlOrigin(url) === null)
        return null;
    const own = urlSite(ownOrigin());
    const site = urlSite(url);
    return site !== null && own !== null && site !== own ? url : null;
}
function frameId(el) {
    let id = WeakMapPrototypeGet(frameIds, el);
    if (id === undefined) {
        id = nextFrameId++;
        WeakMapPrototypeSet(frameIds, el, id);
        MapPrototypeSet(framesById, id, el);
    }
    return id;
}
function frameProxy(el) {
    let p = WeakMapPrototypeGet(frameProxies, el);
    if (p === undefined) {
        const id = frameId(el);
        p = makeRemoteWindow(() => (remoteUrl(el) !== null ? id : null), { parent: () => G, top: () => ReflectApply(F.topGet, G, []) });
        WeakMapPrototypeSet(frameProxies, el, p);
    }
    return p;
}

function installFrames() {
    const IFrame = G.HTMLIFrameElement && G.HTMLIFrameElement.prototype;
    if (!IFrame || !G.MessageEvent || !G.MessagePort || !G.MessageChannel)
        return;
    F.DOMException = G.DOMException;
    F.MessageEvent = G.MessageEvent;
    F.MessagePort = G.MessagePort;
    F.MessageChannel = G.MessageChannel;
    F.originGet = getter(G, 'origin');
    F.topGet = getter(G, 'top');
    F.documentGet = getter(G, 'document');
    F.srcGet = getter(IFrame, 'src');
    F.contentWindowGet = getter(IFrame, 'contentWindow');
    F.contentDocumentGet = getter(IFrame, 'contentDocument');
    F.nameGet = getter(IFrame, 'name');
    F.getAttribute = G.Element.prototype.getAttribute;
    F.getElementsByTagName = G.Document.prototype.getElementsByTagName;
    F.collectionLength = getter(G.HTMLCollection.prototype, 'length');
    F.collectionItem = G.HTMLCollection.prototype.item;
    F.getBoundingClientRect = G.Element.prototype.getBoundingClientRect;
    F.fragmentQueryAll = G.DocumentFragment.prototype.querySelectorAll;
    F.nodeListLength = getter(G.NodeList.prototype, 'length');
    F.nodeListItem = G.NodeList.prototype.item;
    F.isConnected = getter(G.Node.prototype, 'isConnected');
    F.parentElement = getter(G.Node.prototype, 'parentElement');
    F.getComputedStyle = G.getComputedStyle;
    F.styleValue = G.CSSStyleDeclaration && G.CSSStyleDeclaration.prototype.getPropertyValue;
    F.scrollHeight = getter(G.Element.prototype, 'scrollHeight');
    F.scrollWidth = getter(G.Element.prototype, 'scrollWidth');
    for (const k of ['clientLeft', 'clientTop', 'clientWidth', 'clientHeight'])
        F[k] = getter(G.Element.prototype, k);
    const RectProto = G.DOMRectReadOnly.prototype;
    F.rectLeft = getter(RectProto, 'left');
    F.rectTop = getter(RectProto, 'top');
    F.sourceGet = getter(G.MessageEvent.prototype, 'source');
    F.Event = G.Event;
    F.readyStateGet = getter(G.Document.prototype, 'readyState');
    F.portsGet = getter(G.MessageEvent.prototype, 'ports');
    F.dataGet = getter(G.MessageEvent.prototype, 'data');
    F.port1Get = getter(G.MessageChannel.prototype, 'port1');
    F.port2Get = getter(G.MessageChannel.prototype, 'port2');
    F.portPost = G.MessagePort.prototype.postMessage;
    const ObjectGetOwnPropertyDescriptorFn = ObjectGetOwnPropertyDescriptor;
    const redefine = (proto, name, get) => {
        const d = ObjectGetOwnPropertyDescriptorFn(proto, name);
        ObjectDefineProperty(proto, name, { get: nativeGetter(name, get), set: d && d.set, enumerable: d ? d.enumerable : true, configurable: true });
    };
    redefine(IFrame, 'contentWindow', function () {
        if (remoteUrl(this) !== null)
            return frameProxy(this);
        return ReflectApply(F.contentWindowGet, this, []);
    });
    redefine(IFrame, 'contentDocument', function () {
        if (remoteUrl(this) !== null)
            return null;
        return ReflectApply(F.contentDocumentGet, this, []);
    });
    redefine(G.MessageEvent.prototype, 'source', function () {
        const s = WeakMapPrototypeGet(eventSources, this);
        return s !== undefined ? s : ReflectApply(F.sourceGet, this, []);
    });
    redefine(G.MessageEvent.prototype, 'ports', function () {
        let p = WeakMapPrototypeGet(eventPorts, this);
        if (p === undefined) {
            // The engine's ports are a plain array (LibWeb: "FIXME: Use a FrozenArray"); the page gets one frozen array per
            // event, the same object on every read, as in Chrome.
            p = ReflectApply(F.portsGet, this, []);
            if (p !== null && typeof p === 'object') {
                ObjectFreeze(p);
                WeakMapPrototypeSet(eventPorts, this, p);
            }
        }
        return p;
    });
    // The data of a message that carried streams (40-bridge.js decodeStreams); the same object every time it is read.
    const decodedData = new WeakMap();
    redefine(G.MessageEvent.prototype, 'data', function () {
        const d = ReflectApply(F.dataGet, this, []);
        if (typeof d !== 'object' || d === null)
            return d;
        const earlier = WeakMapPrototypeGet(decodedData, this);
        if (earlier !== undefined)
            return earlier.value;
        const out = decodeStreams(d);
        if (out !== d)
            WeakMapPrototypeSet(decodedData, this, { value: out });
        return out;
    });
    // Twins of a channel, so a transferred port's twin can be bridged.
    const remember = (channel) => {
        const a = ReflectApply(F.port1Get, channel, []), b = ReflectApply(F.port2Get, channel, []);
        if (WeakMapPrototypeGet(portPartners, a) === undefined) {
            WeakMapPrototypeSet(portPartners, a, b);
            WeakMapPrototypeSet(portPartners, b, a);
        }
    };
    redefine(G.MessageChannel.prototype, 'port1', function () { remember(this); return ReflectApply(F.port1Get, this, []); });
    redefine(G.MessageChannel.prototype, 'port2', function () { remember(this); return ReflectApply(F.port2Get, this, []); });
    const portPost = F.portPost;
    ObjectDefineProperty(G.MessagePort.prototype, 'postMessage', {
        value: nativeMethod('postMessage', function postMessage(message, transfer) {
            if (WeakSetPrototypeHas(detachedPorts, this))
                return;
            const hostPort = WeakMapPrototypeGet(bridgedPorts, this);
            if (hostPort === undefined)
                return ReflectApply(portPost, this, arguments);
            const list = transfer !== null && typeof transfer === 'object' && !ArrayIsArray(transfer) ? transfer.transfer : transfer;
            const moved = [];
            const streamsListed = [];
            if (list !== undefined && list !== null) {
                const items = ArrayFrom(list);
                for (let i = 0; i < items.length; i++) {
                    if (items[i] instanceof F.MessagePort)
                        ArrayPrototypePush(moved, exportPort(items[i]));
                    else if (callbacks.streams && callbacks.streams.isStream(items[i]))
                        ArrayPrototypePush(streamsListed, items[i]);
                    else
                        ArrayPrototypePush(moved, items[i]);
                }
            }
            try {
                let out = message;
                if (callbacks.streams) {
                    const o = callbacks.streams.outbound(message, streamsListed);
                    out = o.message;
                    for (let i = 0; i < o.transfer.length; i++)
                        ArrayPrototypePush(moved, o.transfer[i]);
                }
                hostPort.postMessage(out, moved);
            } catch (e) {
                if (e && e.name === 'DataCloneError')
                    throw new F.DOMException(HostString(e.message), 'DataCloneError');
                throw e;
            }
        }, 1),
        writable: true, enumerable: true, configurable: true,
    });
    // Shadow roots, open and closed: an iframe inside one (Turnstile puts its widget in a closed shadow root) is a
    // cross-site iframe of this document like any other, but document.getElementsByTagName does not reach it.
    const attachShadow = G.Element.prototype.attachShadow;
    if (typeof attachShadow === 'function') {
        ObjectDefineProperty(G.Element.prototype, 'attachShadow', {
            value: nativeMethod('attachShadow', function attachShadow_(init) {
                const root = ReflectApply(attachShadow, this, arguments);
                ArrayPrototypePush(shadowRoots, new FramesWeakRef(root));
                return root;
            }, 1),
            writable: true, enumerable: true, configurable: true,
        });
    }
    if (callbacks.nested)
        parentProxy = makeRemoteWindow(() => 'parent', { parent: () => parentProxy, top: () => parentProxy });
    framesInstalled = true;
}

// Called by enableScripting before the global is installed.
function prepareFrames() {
    if (!callbacks.nested)
        return;
    globalReplacements = { __proto__: null };
    const parentGet = nativeGetter('parent', () => parentProxy);
    const topGet = nativeGetter('top', () => parentProxy);
    globalReplacements.parent = { get: parentGet, set: undefined, enumerable: true, configurable: true };
    globalReplacements.top = { get: topGet, set: undefined, enumerable: true, configurable: false };
}

// Whether a cross-site iframe lets its document use "cross-origin-isolated" (permissions policy, default allowlist 'self': a
// cross-site frame needs allow="cross-origin-isolated"; the same rule as LibWeb's for same-site frames, patch 0070).
function frameAllowedIsolation(el, url) {
    let allow = null;
    try { allow = ReflectApply(F.getAttribute, el, ['allow']); } catch { allow = null; }
    const frameOrigin = urlOrigin(url);
    if (typeof allow === 'string') {
        const directives = StringPrototypeSplit(allow, ';');
        for (let i = 0; i < directives.length; i++) {
            const all = StringPrototypeSplit(StringPrototypeTrim(directives[i]), /\s+/);
            const parts = [];
            for (let j = 0; j < all.length; j++)
                if (all[j] !== '')
                    ArrayPrototypePush(parts, all[j]);
            if (parts.length === 0 || parts[0] !== 'cross-origin-isolated')
                continue;
            if (parts.length === 1)
                return true;
            for (let j = 1; j < parts.length; j++) {
                const t = parts[j];
                if (t === '*' || t === "'src'")
                    return true;
                if (t === "'self'" && frameOrigin === ownOrigin())
                    return true;
                if (urlOrigin(t) !== null && urlOrigin(t) === frameOrigin)
                    return true;
            }
            return false;
        }
    }
    return frameOrigin === ownOrigin();
}

// --- The API for the segment host -------------------------------------------------------------------------
// The cross-site iframes of the document, with their content boxes in viewport CSS pixels.
api.subframes = () => {
    const out = [];
    if (!framesInstalled)
        return out;
    const add = (el) => {
        const url = remoteUrl(el);
        if (url === null || !ReflectApply(F.isConnected, el, []))
            return;
        const rect = ReflectApply(F.getBoundingClientRect, el, []);
        const entry = {
            id: frameId(el), url, name: HostString(ReflectApply(F.nameGet, el, [])),
            coi: { isolated: pageIsolated && frameAllowedIsolation(el, url), coep: api.embedderPolicyOf() },
            x: ReflectApply(F.rectLeft, rect, []) + ReflectApply(F.clientLeft, el, []),
            y: ReflectApply(F.rectTop, rect, []) + ReflectApply(F.clientTop, el, []),
            width: ReflectApply(F.clientWidth, el, []),
            height: ReflectApply(F.clientHeight, el, []),
        };
        // What the frame moves with when the carapace scrolls (threaded scroll, docs/scroll.md B3): nothing under a
        // fixed box; else its scrolling ancestors (their client boxes, which the carapace matches to its scroll nodes'
        // ports) and the viewport. The first 16 frames only (a style read per ancestor per frame).
        if (out.length < 16 && F.getComputedStyle && F.styleValue) {
            const scrollers = [];
            let fixed = false;
            for (let p = el, guard = 0; p && guard < 64; p = ReflectApply(F.parentElement, p, []), guard++) {
                const cs = ReflectApply(F.getComputedStyle, G, [p]);
                const position = ReflectApply(F.styleValue, cs, ['position']);
                if (position === 'fixed' || position === 'sticky') { fixed = position === 'fixed'; if (fixed) break; }
                if (p === el || scrollers.length >= 8) continue;
                const oy = ReflectApply(F.styleValue, cs, ['overflow-y']), ox = ReflectApply(F.styleValue, cs, ['overflow-x']);
                const scrolls = (o) => o === 'auto' || o === 'scroll' || o === 'hidden';
                if ((scrolls(oy) && ReflectApply(F.scrollHeight, p, []) > ReflectApply(F.clientHeight, p, [])) || (scrolls(ox) && ReflectApply(F.scrollWidth, p, []) > ReflectApply(F.clientWidth, p, []))) {
                    const r = ReflectApply(F.getBoundingClientRect, p, []);
                    ArrayPrototypePush(scrollers, [ReflectApply(F.rectLeft, r, []) + ReflectApply(F.clientLeft, p, []), ReflectApply(F.rectTop, r, []) + ReflectApply(F.clientTop, p, []), ReflectApply(F.clientWidth, p, []), ReflectApply(F.clientHeight, p, [])]);
                }
            }
            entry.fixed = fixed;
            entry.scrollers = scrollers;
        }
        ArrayPrototypePush(out, entry);
    };
    const doc = ReflectApply(F.documentGet, G, []);
    const list = ReflectApply(F.getElementsByTagName, doc, ['iframe']);
    const n = ReflectApply(F.collectionLength, list, []);
    for (let i = 0; i < n; i++)
        add(ReflectApply(F.collectionItem, list, [i]));
    const live = [];
    for (let r = 0; r < shadowRoots.length; r++) {
        const root = WeakRefDeref(shadowRoots[r]);
        if (root === undefined)
            continue;
        ArrayPrototypePush(live, shadowRoots[r]);
        const inner = ReflectApply(F.fragmentQueryAll, root, ['iframe']);
        const m = ReflectApply(F.nodeListLength, inner, []);
        for (let i = 0; i < m; i++)
            add(ReflectApply(F.nodeListItem, inner, [i]));
    }
    shadowRoots = live;
    return out;
};

// A message from the other segment, already checked by the carapace: { from: frame id | 'parent', origin, data, ports }.
// The nested segment shown for iframe `id` finished loading its document: the iframe's load event, as a trusted event
// (HTML "iframe load event steps"; the frame is another segment, so the engine never ran them).
api.frameLoaded = (id) => {
    if (!framesInstalled)
        return false;
    const el = MapPrototypeGet(framesById, id);
    if (el === undefined || remoteUrl(el) === null || !ReflectApply(F.isConnected, el, []))
        return false;
    const event = new F.Event('load');
    const targetCell = WeakMapPrototypeGet(cellOf, el);
    const eventCell = WeakMapPrototypeGet(cellOf, event);
    if (!targetCell || !eventCell)
        return false;
    const entered = idleEntry();
    const mark = scratchTop;
    let ok = false;
    try {
        const t = slots(1), ev = slots(1);
        writeObject(t, targetCell);
        writeObject(ev, eventCell);
        ok = X.ganglion_dispatch_trusted(t, ev) === 1;
    } finally {
        scratchTop = mark;
        idleExit(entered);
    }
    api.pump();
    return ok;
};
// Whether the document has finished loading (readyState "complete"): a nested segment tells its parent (the iframe's load).
api.documentComplete = () => {
    try {
        return HostString(ReflectApply(F.readyStateGet, ReflectApply(F.documentGet, G, []), [])) === 'complete';
    } catch {
        return false;
    }
};
// A nested segment's embedder (Host.cpp ganglion_set_embedder): the referrer, the iframe's name, the ancestor origins.
api.setEmbedder = (referrer, name, ancestors) => {
    let text = HostString(referrer) + '\u0000' + HostString(name);
    for (let i = 0; i < ancestors.length; i++)
        text += '\u0000' + HostString(ancestors[i]);
    const ptr = copyInString(text);
    try {
        X.ganglion_set_embedder(ptr, TextEncoderPrototypeEncode(encoderUtf8, text).length);
    } finally {
        X.ganglion_free(ptr);
    }
};
api.deliverMessage = (m) => {
    if (!framesInstalled || !m)
        return false;
    let source;
    if (m.from === 'opener' || (typeof m.from === 'string' && StringPrototypeStartsWith(m.from, 'popup:'))) {
        source = popupMessageSource(m.from);
        if (source === null)
            return false;
    } else if (m.from === 'parent') {
        if (parentProxy === null)
            return false;
        source = parentProxy;
    } else {
        const el = MapPrototypeGet(framesById, m.from);
        if (el === undefined || remoteUrl(el) === null)
            return false;
        source = frameProxy(el);
    }
    const ok = fireMessage(G, m.data, HostString(m.origin), source, m.ports || null);
    api.pump();
    return ok;
};
