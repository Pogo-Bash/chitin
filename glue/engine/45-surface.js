// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin engine glue: the surface (docs/surface.md). What a page can observe about its global that says "Worker" or "not Chrome":
// the messages and stacks of the errors bindings throw, interface objects that are called, the Window's own names and prototypes
// on a Worker's immutable-prototype global, main-thread-only behaviours (Atomics.wait throws, no SharedArrayBuffer without
// cross-origin isolation, dialogs that return at once), window.chrome. Each item has a check in tests/chrome/run.mjs that compares
// against Chrome's top-level window, and the diff (make surface-diff) counts what is left.

const ObjectDefineProperties = HostObject.defineProperties;
const SymbolAsyncIterator = HostSymbol.asyncIterator;
const PromiseReject = HostPromise_.reject.bind(HostPromise_);
const ErrorCaptureStackTrace = HostError.captureStackTrace;
const HostRegExp = globalThis.RegExp;
// RegExpPrototypeExec: 50-frames.js
const NOT_AN_OBJECT_OF_TYPE = new HostRegExp('^Not an object of type (\\w+)$');
const NEEDS_ARGUMENTS = new HostRegExp('^[\\w.]+\\(\\) needs (one|\\d+) arguments?$');
const NEEDS_AT_LEAST_ARGUMENTS = new HostRegExp('^[\\w.]+\\(\\) needs at least (one|\\d+) arguments?$');

// The stack of `e` as if it were thrown by the native function `fn`: the frames above and including `fn` (ours) are dropped, so it
// starts at the page's call site, as V8's own errors from native functions do.
function withStackFrom(e, fn) {
    if (ErrorCaptureStackTrace !== undefined && typeof e === 'object' && e !== null) {
        try {
            ErrorCaptureStackTrace(e, fn);
        } catch { /* a frozen error: it keeps its stack */ }
    }
    return e;
}
// The receiver of a member of the global that is not the global (nor the undefined/null that means "the global"): Chrome throws.
// (Only in a Worker: under Node's vm the global the page sees and the object the glue was handed are different objects.)
let checkGlobalReceivers = false; // set once the global is a Worker's (shapeWindowChain)
function foreignReceiver(self, global) {
    return checkGlobalReceivers && self !== global && self !== undefined && self !== null;
}
function illegalInvocation(fn) {
    return withStackFrom(new HostTypeError('Illegal invocation'), fn);
}
function illegalConstructor(fn, viaNew) {
    return withStackFrom(new HostTypeError(viaNew ? "Failed to construct '" + fn.name + "': Illegal constructor" : 'Illegal constructor'), fn);
}
function callWithoutNew(fn, constructible) {
    if (!constructible)
        return illegalConstructor(fn, false);
    return withStackFrom(new HostTypeError("Failed to construct '" + fn.name + "': Please use the 'new' operator, this DOM object constructor cannot be called as a function."), fn);
}

// Members of the global that a Window does not check the receiver of (event-handler attributes), and those that return a promise:
// Chrome answers a foreign receiver there with a rejected promise, not a throw.
// (onmouseenter, onmouseleave and onreadystatechange are [LegacyLenientThis] in Chrome: a foreign receiver reads undefined and sets nothing.)
const LENIENT_GLOBAL_MEMBERS = /^on(mouseenter|mouseleave|readystatechange)$/;
const PROMISE_GLOBAL_MEMBERS = { __proto__: null, fetch: true, createImageBitmap: true, scroll: true, scrollBy: true, scrollTo: true };
function foreignGlobalCall(fn, name) {
    const error = illegalInvocation(fn);
    if (PROMISE_GLOBAL_MEMBERS[name] === true)
        return PromiseReject(error);
    throw error;
}
function lenientThis(name) {
    return LENIENT_GLOBAL_MEMBERS.test(name);
}
// A receiver that is not an engine object (or the global): Chrome checks it before it looks at the arguments.
function notWrapper(self) {
    return !((typeof self === 'object' || typeof self === 'function') && self !== null && WeakMapPrototypeGet(cellOf, self) !== undefined);
}

// The interface a member is on, for messages ("Failed to execute 'appendChild' on 'Node'").
const ownerNames = new HostMap();
function ownerName(cell) {
    let name = MapPrototypeGet(ownerNames, cell);
    if (name === undefined) {
        name = vObjectKind(cell) === 4 ? vGet(cell, 'name') : prototypeNameRaw(cell);
        if (typeof name !== 'string')
            name = '';
        if (name === 'WindowProperties' || name === 'WindowPrototype')
            name = 'Window';
        MapPrototypeSet(ownerNames, cell, name);
    }
    return name;
}

const QUERY_METHODS = { __proto__: null, querySelector: true, querySelectorAll: true, matches: true, closest: true, webkitMatchesSelector: true };

// What an engine error looks like when a binding throws it: Chrome's messages and a stack that starts at the caller. Anything that
// is not an error the engine made (a page's own throw coming back through a callback, a DOMException with Chrome's text) is returned
// as it is. kind: 'method' | 'get' | 'set'.
function chromeError(e, fn, kind, owner, name, thisValue, args) {
    if (typeof e !== 'object' || e === null)
        return e;
    if (WeakSetPrototypeHas(engineErrors, e)) {
        const d = ObjectGetOwnPropertyDescriptor(e, 'message');
        const match = d !== undefined && typeof d.value === 'string' ? RegExpPrototypeExec(NOT_AN_OBJECT_OF_TYPE, d.value) : null;
        if (match === null) {
            // The engine's argument-count messages in Chrome's words.
            const text = d !== undefined && typeof d.value === 'string' ? argumentCountMessage(d.value, args.length, "Failed to execute '" + name + "' on '" + owner + "': ") : null;
            return withStackFrom(text === null ? e : new HostTypeError(text), fn);
        }
        // "Not an object of type T": the receiver is wrong (Chrome: Illegal invocation) unless the receiver is fine and an
        // argument is the wrong kind of thing (Chrome names the parameter).
        const type = match[1];
        let text = 'Illegal invocation';
        if (args.length > 0 && owner !== '') {
            const ownClass = MapPrototypeGet(classByName, owner);
            const receiverOk = (typeof thisValue === 'object' || typeof thisValue === 'function') && thisValue !== null && WeakMapPrototypeGet(cellOf, thisValue) !== undefined
                && (thisValue === G || ownClass === undefined || thisValue instanceof ownClass);
            if (receiverOk) {
                const argClass = MapPrototypeGet(classByName, type);
                let index = -1;
                for (let i = 0; i < args.length && index < 0; i++)
                    if (argClass === undefined || !(args[i] instanceof argClass))
                        index = i;
                if (index >= 0) {
                    text = kind === 'set'
                        ? "Failed to set the '" + name + "' property on '" + owner + "': The provided value is not of type '" + type + "'."
                        : "Failed to execute '" + name + "' on '" + owner + "': parameter " + (index + 1) + " is not of type '" + type + "'.";
                }
            }
        }
        return withStackFrom(new HostTypeError(text), fn);
    }
    if (QUERY_METHODS[name] === true && kind === 'method' && args.length > 0) {
        // The engine's selector error becomes Chrome's.
        let message;
        try {
            message = e.message;
        } catch { return e; }
        if (message === 'Failed to parse selector') {
            const DOMExceptionClass = MapPrototypeGet(classByName, 'DOMException');
            if (DOMExceptionClass !== undefined)
                return withStackFrom(new DOMExceptionClass("Failed to execute '" + name + "' on '" + owner + "': '" + HostString(args[0]) + "' is not a valid selector.", 'SyntaxError'), fn);
        }
    }
    return e;
}

// Whether a page may construct an interface (Chrome's list, 46-constructible.js): the engine has a constructor function for every
// interface and cannot be asked, and constructing to find out would build objects (some leave its execution context unbalanced).
function constructible(cls) {
    return MapPrototypeGet(CONSTRUCTIBLE_INTERFACES, cls.name) === true;
}

// "foo() needs one argument" / "Overload resolution failed" as Chrome says it: "<prefix>1 argument required, but only 0 present."
function argumentCountMessage(message, given, prefix) {
    let m = RegExpPrototypeExec(NEEDS_ARGUMENTS, message) || RegExpPrototypeExec(NEEDS_AT_LEAST_ARGUMENTS, message);
    let required;
    if (m !== null)
        required = m[1] === 'one' ? 1 : +m[1];
    else if (message === 'Overload resolution failed' && given === 0)
        required = 1;
    else
        return null;
    return prefix + required + (required === 1 ? ' argument' : ' arguments') + ' required, but only ' + given + ' present.';
}

// A constructor's engine errors: the HTML element that cannot be built directly says what Chrome's says.
function chromeConstructError(e, cls, args) {
    if (typeof e === 'object' && e !== null && WeakSetPrototypeHas(engineErrors, e)) {
        const d = ObjectGetOwnPropertyDescriptor(e, 'message');
        if (d !== undefined && (d.value === 'Cannot directly construct an HTML element, it must be inherited' || d.value === 'Illegal constructor'))
            return illegalConstructor(cls, true);
        const text = d !== undefined && typeof d.value === 'string' ? argumentCountMessage(d.value, args.length, "Failed to construct '" + cls.name + "': ") : null;
        return withStackFrom(text === null ? e : new HostTypeError(text), cls);
    }
    return e;
}

// --- The global --------------------------------------------------------------------------------------------------
const WORKER_ONLY_INTERFACES = ['FileReaderSync'];
const WINDOW_PROTOTYPE_KEEP = { __proto__: null, constructor: true, TEMPORARY: true, PERSISTENT: true };
// A page's global is a Window; in the segment it is a DedicatedWorkerGlobalScope whose prototype cannot be replaced (the
// global's prototype is immutable). So the objects on its chain become the Window's: the interface object is named Window and is
// the Worker's own function (calling it throws "Illegal constructor" natively), its prototype carries the Window's tag, and the
// WorkerGlobalScope prototype behind it becomes WindowProperties (no constructor, nothing of its own). The members they carried
// are the global's own, as on a Window.
function shapeWindowChain() {
    const proto = ObjectGetPrototypeOf(G);
    if (proto === null || proto === undefined)
        return;
    const tag = ObjectGetOwnPropertyDescriptor(proto, SymbolToStringTag);
    if (tag === undefined || tag.value !== 'DedicatedWorkerGlobalScope')
        return;
    checkGlobalReceivers = true;
    const props = ObjectGetPrototypeOf(proto);
    if (props === null || props === Object.prototype)
        return;
    const EngineWindow = MapPrototypeGet(classByName, 'Window');
    // The interface object is a function of ours (the Worker's own would name itself in V8's messages): it throws Chrome's
    // "Illegal constructor" and its `prototype` is the Worker's prototype object, which becomes Window.prototype.
    const WindowCtor = { Window: function () {
        throw illegalConstructor(WindowCtor, new.target !== undefined);
    } }.Window;
    ObjectDefineProperty(WindowCtor, 'prototype', { value: proto, writable: false, enumerable: false, configurable: false });
    ObjectDefineProperty(proto, 'constructor', { value: WindowCtor, writable: true, enumerable: false, configurable: true });
    WeakSetPrototypeAdd(nativeFunctions, WindowCtor);
    // Constants and statics of the engine's Window go to the interface object that replaces it.
    if (EngineWindow !== undefined) {
        const copy = (from, to, skip) => {
            const keys = ReflectOwnKeys(from);
            for (let i = 0; i < keys.length; i++) {
                if (skip[keys[i]] === true)
                    continue;
                const d = ObjectGetOwnPropertyDescriptor(from, keys[i]);
                if (d !== undefined && !ObjectHasOwn(to, keys[i]))
                    ObjectDefineProperty(to, keys[i], d);
            }
        };
        copy(EngineWindow, WindowCtor, { __proto__: null, length: true, name: true, prototype: true });
        copy(EngineWindow.prototype, proto, { __proto__: null, constructor: true });
    }
    ObjectDefineProperty(proto, SymbolToStringTag, { value: 'Window', configurable: true });
    const EventTargetClass = MapPrototypeGet(classByName, 'EventTarget');
    if (EventTargetClass !== undefined)
        ObjectSetPrototypeOf(WindowCtor, EventTargetClass); // Window inherits EventTarget as an interface
    for (const [n, v] of [['TEMPORARY', 0], ['PERSISTENT', 1]]) {
        ObjectDefineProperty(WindowCtor, n, { value: v, writable: false, enumerable: true, configurable: false });
        if (!ObjectHasOwn(proto, n))
            ObjectDefineProperty(proto, n, { value: v, writable: false, enumerable: true, configurable: false });
    }
    // The Worker's global object owns a `constructor` (the Worker scope's); a Window's does not.
    ReflectDeleteProperty(G, 'constructor');
    // Members the Worker scopes carry move to the global itself (a Window owns them); the Worker-only ones go.
    const move = (from, keep) => {
        const keys = ReflectOwnKeys(from);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (key === SymbolToStringTag || (keep !== null && keep[key] === true))
                continue;
            const d = ObjectGetOwnPropertyDescriptor(from, key);
            if (d !== undefined && key !== 'fonts' && key !== 'constructor' && !ObjectHasOwn(G, key))
                ObjectDefineProperty(G, key, d);
            ReflectDeleteProperty(from, key);
        }
    };
    move(proto, WINDOW_PROTOTYPE_KEEP);
    move(props, null);
    ObjectDefineProperty(props, SymbolToStringTag, { value: 'WindowProperties', configurable: true });
    namedPropertiesObject = props;
    // Behind WindowProperties is the Worker's EventTarget.prototype, and the prototype of that object cannot be changed (the
    // prototype of a [Global] interface's prototype object is immutable in V8), so the page's EventTarget.prototype is made to
    // be that object: `window instanceof EventTarget` is true, and what a page defines on EventTarget.prototype (ShadyDOM's
    // __shady_native_addEventListener) is found from the window, as in Chrome. addEventListener, removeEventListener and
    // dispatchEvent are EventTarget.prototype's on a Window, not the global's own.
    const HostEventTargetPrototype = ObjectGetPrototypeOf(props);
    if (HostEventTargetPrototype !== null && HostEventTargetPrototype !== Object.prototype) {
        const EventTargetInterface = adoptEventTargetPrototype(HostEventTargetPrototype);
        if (EventTargetInterface !== null) {
            ObjectSetPrototypeOf(WindowCtor, EventTargetInterface);
            for (const n of ['addEventListener', 'removeEventListener', 'dispatchEvent'])
                ReflectDeleteProperty(G, n);
        }
    }
    shapeWindowSize();
    // Interfaces only a Worker has.
    for (const n of WORKER_ONLY_INTERFACES)
        ReflectDeleteProperty(G, n);
    ObjectDefineProperty(G, 'Window', { value: WindowCtor, writable: true, enumerable: false, configurable: true });
}

// Named access on the window (window.someId, a bare `canvas` for <canvas id=canvas>): the Window's supported property names
// (ids, the names of embed/form/img/object, child navigable target names), as Chrome answers them from the named properties
// object behind Window.prototype. The global's prototype chain cannot take an exotic object, so WindowProperties carries an
// accessor per name that asks the engine's Window for the value now (an element, an HTMLCollection or a WindowProxy); the set
// of names is refreshed when the document's tree version moves (before and after each script, at each pump). Names the frame
// code keeps as data properties (55-realms.js syncFrameNames) are left to it. The global's own names and Window.prototype's
// win, as they do in Chrome.
let namedPropertiesObject = null;
let namedPropertiesVersion = -1;
let namedPropertyNames = [];
function namedPropertyGetter(name) {
    const get = function () {
        if (globalCell === 0)
            return undefined;
        const entered = idleEntry();
        try {
            return vGet(globalCell, name);
        } catch {
            return undefined;
        } finally {
            idleExit(entered);
        }
    };
    return get;
}
function syncNamedProperties() {
    const props = namedPropertiesObject;
    if (props === null || globalCell === 0 || typeof X.ganglion_window_named_keys !== 'function')
        return;
    const mark = scratchTop;
    const names = safeArray();
    try {
        const o = slots(1), v = slots(1);
        writeObject(o, globalCell);
        if (X.ganglion_window_named_keys(o, namedPropertiesVersion, v) === 0) {
            views();
            namedPropertiesVersion = f64[v >>> 3];
            return;
        }
        views();
        namedPropertiesVersion = f64[v >>> 3];
        const n = X.ganglion_keys_count();
        for (let i = 0; i < n; i++) {
            const key = keyToJS(X.ganglion_keys_at(i));
            if (typeof key === 'string')
                names[names.length] = key;
        }
    } finally {
        scratchTop = mark;
    }
    const keep = { __proto__: null };
    for (let i = 0; i < names.length; i++)
        keep[names[i]] = true;
    for (let i = 0; i < namedPropertyNames.length; i++) {
        const name = namedPropertyNames[i];
        if (keep[name] === true)
            continue;
        const d = ObjectGetOwnPropertyDescriptor(props, name);
        if (d !== undefined && d.get !== undefined && WeakSetPrototypeHas(namedPropertyGetters, d.get))
            ReflectDeleteProperty(props, name);
    }
    const kept = safeArray();
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const d = ObjectGetOwnPropertyDescriptor(props, name);
        if (d !== undefined) {
            // A frame's name (a data property of 55-realms.js) or an accessor of ours already there.
            if (d.get !== undefined && WeakSetPrototypeHas(namedPropertyGetters, d.get))
                kept[kept.length] = name;
            continue;
        }
        const get = namedPropertyGetter(name);
        WeakSetPrototypeAdd(namedPropertyGetters, get);
        // Chrome: a named property is writable and configurable, not enumerable ([LegacyUnenumerableNamedProperties]); an
        // assignment through the global defines an own property of the global, which then shadows it.
        ObjectDefineProperty(props, name, { get, set: namedPropertySetter(name), enumerable: false, configurable: true });
        kept[kept.length] = name;
    }
    namedPropertyNames = kept;
}
const namedPropertyGetters = new HostWeakSet();
function namedPropertySetter(name) {
    return function (value) {
        ObjectDefineProperty(this, name, { value, writable: true, enumerable: true, configurable: true });
    };
}

// The engine's EventTarget interface, rebuilt on `host`, the object that already stands behind the global's prototypes: the interface
// object is a new function whose prototype is `host` and that carries the engine's constructor cell; the engine's members are
// copied onto `host`; every interface that inherited the engine's prototype object (and every class made later) inherits `host`.
// The engine's old prototype object stays only for the few objects made from it before this runs.
function adoptEventTargetPrototype(host) {
    const old = MapPrototypeGet(classByName, 'EventTarget');
    if (old === undefined)
        return null;
    const protoCell = WeakMapPrototypeGet(cellOf, old.prototype);
    const ctorCell = WeakMapPrototypeGet(cellOf, old);
    if (protoCell === undefined || ctorCell === undefined)
        return null;
    const cls = makeClass('EventTarget', null, ctorCell, host);
    const keys = ReflectOwnKeys(old.prototype);
    for (let i = 0; i < keys.length; i++) {
        if (keys[i] === 'constructor')
            continue;
        const d = ObjectGetOwnPropertyDescriptor(old.prototype, keys[i]);
        if (d !== undefined)
            ObjectDefineProperty(host, keys[i], d);
    }
    const statics = ReflectOwnKeys(old);
    for (let i = 0; i < statics.length; i++) {
        const k = statics[i];
        if (k === 'length' || k === 'name' || k === 'prototype')
            continue;
        const d = ObjectGetOwnPropertyDescriptor(old, k);
        if (d !== undefined && !ObjectHasOwn(cls, k))
            ObjectDefineProperty(cls, k, d);
    }
    WeakMapPrototypeSet(cellOf, cls, ctorCell);
    WeakMapPrototypeSet(cellOf, host, protoCell);
    MapPrototypeSet(classByProto, protoCell, cls);
    MapPrototypeSet(classByName, 'EventTarget', cls);
    MapPrototypeSet(wrapperByCell, protoCell, host);
    MapPrototypeSet(wrapperByCell, ctorCell, cls);
    MapPrototypeSet(functionByCell, ctorCell, cls);
    for (const c of classByName.values()) {
        if (c === cls)
            continue;
        if (ObjectGetPrototypeOf(c.prototype) === old.prototype)
            ObjectSetPrototypeOf(c.prototype, host);
        if (ObjectGetPrototypeOf(c) === old)
            ObjectSetPrototypeOf(c, cls);
    }
    const g = ObjectGetOwnPropertyDescriptor(G, 'EventTarget');
    if (g !== undefined && g.value !== undefined)
        ObjectDefineProperty(G, 'EventTarget', { value: cls, writable: g.writable, enumerable: g.enumerable, configurable: g.configurable });
    return cls;
}

// innerWidth and innerHeight are the segment host's accessors (arrow functions over its state): a Window's are replaceable
// accessors with native getters and setters ("get innerWidth"), enumerable.
function shapeWindowSize() {
    // A window with no browser chrome around the page (the segment has none): its outer size is its inner size.
    const sources = { __proto__: null, innerWidth: 'innerWidth', innerHeight: 'innerHeight', outerWidth: 'innerWidth', outerHeight: 'innerHeight' };
    for (const name of ['innerWidth', 'innerHeight', 'outerWidth', 'outerHeight']) {
        const inner = ObjectGetOwnPropertyDescriptor(G, sources[name]);
        if (inner === undefined || inner.get === undefined)
            continue;
        const read = inner.get;
        const holder = {
            get [name]() {
                if (foreignReceiver(this, G))
                    throw illegalInvocation(nd.get);
                return read();
            },
            set [name](value) {
                if (foreignReceiver(this, G))
                    throw illegalInvocation(nd.set);
                ObjectDefineProperty(G, name, { value, writable: true, enumerable: true, configurable: true });
            },
        };
        const nd = ObjectGetOwnPropertyDescriptor(holder, name);
        WeakSetPrototypeAdd(nativeFunctions, nd.get);
        WeakSetPrototypeAdd(nativeFunctions, nd.set);
        ObjectDefineProperty(G, name, { get: nd.get, set: nd.set, enumerable: true, configurable: true });
    }
}

// --- Main-thread behaviours ---------------------------------------------------------------------------------------
// Atomics.wait throws on a page's main thread, and SharedArrayBuffer does not exist there without cross-origin isolation. The
// segment Worker is always isolated (Document-Isolation-Policy); the page is as its own COOP/COEP earn it in Chrome: the engine
// says so before each document's scripts run (Host.cpp ganglion_host_isolation, setPageIsolation), and the global follows.
const HostSharedArrayBuffer = globalThis.SharedArrayBuffer;
const SharedArrayBufferByteLength = HostSharedArrayBuffer ? uncurryThis(ObjectGetOwnPropertyDescriptor(HostSharedArrayBuffer.prototype, 'byteLength').get) : null;
const HostWasmMemory = globalThis.WebAssembly ? globalThis.WebAssembly.Memory : null;
let pageIsolated = false;
function isSharedArrayBuffer(v) {
    if (SharedArrayBufferByteLength === null || typeof v !== 'object' || v === null)
        return false;
    try {
        SharedArrayBufferByteLength(v);
        return true;
    } catch {
        return false;
    }
}
// Chrome's DataCloneError for a SharedArrayBuffer (or a shared WebAssembly.Memory) cloned without cross-origin isolation.
function sharedCloneError() {
    return new G.DOMException('SharedArrayBuffer transfer requires self.crossOriginIsolated.', 'DataCloneError');
}
function setPageIsolation(isolated) {
    pageIsolated = isolated;
    if (isolated && HostSharedArrayBuffer)
        ObjectDefineProperty(G, 'SharedArrayBuffer', { value: HostSharedArrayBuffer, writable: true, enumerable: false, configurable: true });
    else
        ReflectDeleteProperty(G, 'SharedArrayBuffer');
}
function shapeAtomics() {
    const atomics = globalThis.Atomics;
    if (atomics !== undefined) {
        const d = ObjectGetOwnPropertyDescriptor(atomics, 'wait');
        if (d !== undefined) {
            // V8 checks the arguments first (a typed array that is not shared throws its own message), then whether this thread may block:
            // the original runs with a timeout of 0, which never blocks, and what it accepts is refused for the thread.
            const original = d.value;
            const wait = { wait(typedArray, index, value, timeout) {
                try {
                    ReflectApply(original, atomics, [typedArray, index, value, 0]);
                } catch (e) {
                    throw withStackFrom(e, wait);
                }
                throw withStackFrom(new HostTypeError('Atomics.wait cannot be called in this context'), wait);
            } }.wait;
            WeakSetPrototypeAdd(nativeFunctions, wait);
            ObjectDefineProperty(atomics, 'wait', { value: wait, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable });
        }
    }
    ReflectDeleteProperty(G, 'SharedArrayBuffer');
}

// alert, confirm, prompt and print on a page block until the user has answered; the segment cannot block for a dialog, so they
// answer as a dismissed dialog does (no value), at once. print does nothing.
function shapeDialogs() {
    const define = (name, result) => {
        const f = { [name]() {
            if (foreignReceiver(this, G))
                throw illegalInvocation(f);
            return result;
        } }[name];
        WeakSetPrototypeAdd(nativeFunctions, f);
        ObjectDefineProperty(G, name, { value: f, writable: true, enumerable: true, configurable: true });
    };
    define('alert', undefined);
    define('confirm', false);
    define('prompt', null);
    define('print', undefined);
}

// window.chrome: what Chrome gives every page (loadTimes, csi, app; runtime only to extension pages).
function shapeChromeObject() {
    if (ObjectHasOwn(G, 'chrome'))
        return;
    // Chrome's functions here are anonymous native ones: name "", printing as `function () { [native code] }`.
    const fn = (length, body) => {
        const f = { f: function (...args) { return body(args); } }.f; // (a plain function: Chrome's have a prototype)
        ObjectDefineProperty(f, 'name', { value: '', configurable: true });
        ObjectDefineProperty(f, 'length', { value: length, configurable: true });
        WeakSetPrototypeAdd(nativeFunctions, f);
        return f;
    };
    const now = () => (hostPerformance !== undefined ? hostPerformance.timeOrigin + hostPerformance.now() : 0) / 1000;
    const origin = () => (hostPerformance !== undefined ? hostPerformance.timeOrigin : 0) / 1000;
    const data = (value, writable) => ({ value, writable, enumerable: true, configurable: true });
    const InstallState = { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' };
    const RunningState = { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' };
    const app = {};
    ObjectDefineProperties(app, {
        isInstalled: data(false, false),
        getDetails: data(fn(0, () => null), true),
        getIsInstalled: data(fn(0, () => false), true),
        installState: data(fn(0, (args) => { if (typeof args[0] === 'function') args[0]('not_installed'); }), true),
        runningState: data(fn(0, () => 'cannot_run'), true),
        InstallState: data(InstallState, false),
        RunningState: data(RunningState, false),
    });
    const chrome = {};
    ObjectDefineProperties(chrome, {
        loadTimes: data(fn(0, () => {
            const t = origin();
            return {
                requestTime: t, startLoadTime: t, commitLoadTime: t + 0.05, finishDocumentLoadTime: now(), finishLoadTime: now(),
                firstPaintTime: t + 0.1, firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: true, wasNpnNegotiated: true,
                npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'h2',
            };
        }), true),
        csi: data(fn(0, () => {
            const t = origin() * 1000;
            return { startE: HostMath.round(t), onloadT: HostMath.round(t + 100), pageT: hostPerformance !== undefined ? hostPerformance.now() : 0, tran: 15 };
        }), true),
        app: data(app, true),
    });
    ObjectDefineProperty(G, 'chrome', { value: chrome, writable: true, enumerable: true, configurable: true });
}

// performance.memory, which Chrome has (and Workers too): the Worker's own numbers.
const hostMemoryDescriptor = hostPerformance !== undefined ? (() => { for (let o = hostPerformance; o !== null; o = ObjectGetPrototypeOf(o)) { const d = ObjectGetOwnPropertyDescriptor(o, 'memory'); if (d !== undefined) return d; } return undefined; })() : undefined;
// Workers have no performance.memory; the numbers of a plain page (limit 4 GiB; a small heap growing a little with time, in the
// 100 KB steps Chrome rounds to) stand in. Honest about what they are: not this Worker's heap.
function syntheticMemory(key) {
    const t = hostPerformance !== undefined ? hostPerformance.now() : 0;
    const total = 19000000 + MathFloor(MathMin(t, 600000) / 1000) * 100000;
    if (key === 'jsHeapSizeLimit') return 4294967296;
    if (key === 'totalJSHeapSize') return total;
    return total - 5300000 + MathFloor((t % 7000) / 100) * 100000;
}
// navigator.hardwareConcurrency and deviceMemory: the engine's constants (1 and 1: a container that looks like a bot) give way to what
// the host browser reports to its own pages, which the glue reads as it loads, before the host script removes its doors.
const hostNavigator = globalThis.navigator;
const HOST_NAVIGATOR_VALUES = { __proto__: null };
for (const k of ['hardwareConcurrency', 'deviceMemory']) {
    try {
        if (hostNavigator !== undefined && typeof hostNavigator[k] === 'number')
            HOST_NAVIGATOR_VALUES[k] = hostNavigator[k];
    } catch { /* not available */ }
}
// The platform identity (docs/surface.md, Decisions 2026-10-22, option B): the host Chrome's own user agent with a coarse
// `Chitin/0` token appended, as Edge appends `Edg/...`. The same for every user on a platform: no build id, no version beyond 0.
// navigator.userAgent, appVersion, platform and userAgentData are built from it here, and boot() hands the same strings to the
// engine for the User-Agent and Sec-CH-UA request headers (ganglion_set_identity), so a page and the wire say one thing.
const CHITIN_TOKEN = 'Chitin/0';
const uaJoin = uncurryThis(Array.prototype.join), uaMap = uncurryThis(Array.prototype.map), uaFilter = uncurryThis(Array.prototype.filter), uaConcat = uncurryThis(Array.prototype.concat);
const uaFrom = Array.from;
const FALLBACK_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const hostUAData = (() => { try { return hostNavigator !== undefined ? hostNavigator.userAgentData : undefined; } catch { return undefined; } })();
const HOST_UA = (() => {
    try {
        const ua = hostNavigator !== undefined ? hostNavigator.userAgent : undefined;
        if (typeof ua === 'string' && ua.startsWith('Mozilla/5.0 ') && /Chrome\/\d/.test(ua))
            return ua;
    } catch { /* not available */ }
    return FALLBACK_UA;
})();
const CHROME_MAJOR = (() => { const m = /Chrome\/(\d+)/.exec(HOST_UA); return m !== null ? m[1] : '154'; })();
const IDENTITY = (() => {
    const ua = HOST_UA.endsWith(' ' + CHITIN_TOKEN) ? HOST_UA : HOST_UA + ' ' + CHITIN_TOKEN;
    let platformUA = 'Linux';
    if (HOST_UA.includes('Macintosh')) platformUA = 'macOS';
    else if (HOST_UA.includes('Windows')) platformUA = 'Windows';
    else if (HOST_UA.includes('CrOS')) platformUA = 'Chrome OS';
    else if (HOST_UA.includes('Android')) platformUA = 'Android';
    let brands = [];
    try {
        if (hostUAData !== undefined && hostUAData.brands !== undefined)
            for (const b of hostUAData.brands)
                brands.push({ brand: String(b.brand), version: String(b.version) });
    } catch { brands = []; }
    if (brands.length === 0)
        brands = [{ brand: 'Chromium', version: CHROME_MAJOR }, { brand: 'Not.A/Brand', version: '24' }, { brand: 'Google Chrome', version: CHROME_MAJOR }];
    brands = brands.filter((b) => b.brand !== 'Chitin');
    brands.push({ brand: 'Chitin', version: '0' });
    let mobile = HOST_UA.includes(' Mobile');
    let platform = platformUA;
    try {
        if (hostUAData !== undefined) {
            if (typeof hostUAData.mobile === 'boolean') mobile = hostUAData.mobile;
            if (typeof hostUAData.platform === 'string' && hostUAData.platform !== '') platform = hostUAData.platform;
        }
    } catch { /* keep the UA's */ }
    let navPlatform = 'Linux x86_64';
    try {
        if (hostNavigator !== undefined && typeof hostNavigator.platform === 'string' && hostNavigator.platform !== '' && hostNavigator.platform !== 'WebAssembly wasm32')
            navPlatform = hostNavigator.platform;
        else if (platform === 'macOS') navPlatform = 'MacIntel';
        else if (platform === 'Windows') navPlatform = 'Win32';
    } catch { /* keep the default */ }
    const secChUa = uaJoin(uaMap(brands, (b) => '"' + b.brand + '";v="' + b.version + '"'), ', ');
    // What a URL the site-compatibility list hides Chitin from (webcompat/, "user_agent": ["hide_Chitin"]) is shown and sent:
    // the host Chrome's own user agent and brands, without the Chitin token or brand.
    const hiddenUA = ua.slice(0, ua.length - CHITIN_TOKEN.length - 1);
    const hiddenBrands = brands.filter((b) => b.brand !== 'Chitin');
    const secChUaHidden = uaJoin(uaMap(hiddenBrands, (b) => '"' + b.brand + '";v="' + b.version + '"'), ', ');
    return { userAgent: ua, appVersion: ua.slice('Mozilla/'.length), platform: navPlatform, brands, mobile, uaPlatform: platform,
        secChUa, secChMobile: mobile ? '?1' : '?0', secChPlatform: '"' + platform + '"',
        hidden: { userAgent: hiddenUA, appVersion: hiddenUA.slice('Mozilla/'.length), brands: hiddenBrands, secChUa: secChUaHidden } };
})();
// The hints Chrome adds on request (getHighEntropyValues), read from the host as it loads; the Chitin brand has full version 0.0.0.0.
let hostHighEntropy = null;
if (hostUAData !== undefined && typeof hostUAData.getHighEntropyValues === 'function') {
    try {
        hostHighEntropy = hostUAData.getHighEntropyValues(['architecture', 'bitness', 'formFactors', 'fullVersionList', 'model', 'platformVersion', 'uaFullVersion', 'wow64']).then((v) => v, () => null);
    } catch { hostHighEntropy = null; }
}
function identityHeaderBlock() {
    return IDENTITY.userAgent + '\n' + IDENTITY.secChUa + '\n' + IDENTITY.secChMobile + '\n' + IDENTITY.secChPlatform + '\n' + IDENTITY.hidden.secChUa;
}
// Whether the site-compatibility list hides Chitin from this navigator's document: the engine's own navigator.userAgent
// (LibWeb's NavigatorID, which asks the list for the document's URL) says so by leaving the token out.
function chitinHiddenFor(engineUserAgentGetter, navigator) {
    if (engineUserAgentGetter === undefined)
        return false;
    let ua;
    try {
        ua = ReflectApply(engineUserAgentGetter, navigator, []);
    } catch {
        return false;
    }
    return typeof ua === 'string' && !ua.endsWith(' ' + CHITIN_TOKEN);
}
function shapeUserAgentData(cls, engineUserAgentGetter) {
    // (The host's own NavigatorUAData is on the global already, with the host's brands only; this one replaces it.)
    const UAData = makeClass('NavigatorUAData', null, 0);
    ObjectDefineProperty(UAData.prototype, SymbolToStringTag, { value: 'NavigatorUAData', configurable: true });
    // Two instances: the one most documents see, and the one a document the site-compatibility list hides Chitin from sees.
    const instance = ReflectConstruct(function () {}, [], UAData);
    const hiddenInstance = ReflectConstruct(function () {}, [], UAData);
    const brandsShown = ObjectFreeze(uaMap(IDENTITY.brands, (b) => ({ brand: b.brand, version: b.version })));
    const brandsHidden = ObjectFreeze(uaMap(IDENTITY.hidden.brands, (b) => ({ brand: b.brand, version: b.version })));
    const getter = (name, value, hiddenValue) => {
        const holder = { get [name]() {
            if (this !== instance && this !== hiddenInstance)
                throw illegalInvocation(g);
            return this === hiddenInstance ? hiddenValue : value;
        } };
        const g = ObjectGetOwnPropertyDescriptor(holder, name).get;
        WeakSetPrototypeAdd(nativeFunctions, g);
        ObjectDefineProperty(UAData.prototype, name, { get: g, set: undefined, enumerable: true, configurable: true });
    };
    getter('brands', brandsShown, brandsHidden);
    getter('mobile', IDENTITY.mobile, IDENTITY.mobile);
    getter('platform', IDENTITY.uaPlatform, IDENTITY.uaPlatform);
    const methods = {
        getHighEntropyValues(hints) {
            if (this !== instance && this !== hiddenInstance)
                return PromiseReject(illegalInvocation(methods.getHighEntropyValues));
            const hidden = this === hiddenInstance;
            const brands = hidden ? brandsHidden : brandsShown;
            if (arguments.length < 1)
                return PromiseReject(withStackFrom(new HostTypeError("Failed to execute 'getHighEntropyValues' on 'NavigatorUAData': 1 argument required, but only 0 present."), methods.getHighEntropyValues));
            const wanted = uaFrom(hints, String);
            return (async () => {
                const host = hostHighEntropy !== null ? await hostHighEntropy : null;
                const out = { brands, mobile: IDENTITY.mobile, platform: IDENTITY.uaPlatform };
                const h = host !== null && host !== undefined ? host : {};
                for (const k of wanted) {
                    if (k === 'fullVersionList') {
                        const base = h.fullVersionList !== undefined ? uaMap(h.fullVersionList, (b) => ({ brand: String(b.brand), version: String(b.version) })) : uaMap(IDENTITY.brands, (b) => ({ brand: b.brand, version: b.brand === 'Not.A/Brand' ? b.version + '.0.0.0' : CHROME_MAJOR + '.0.0.0' }));
                        out.fullVersionList = hidden ? uaFilter(base, (b) => b.brand !== 'Chitin') : uaConcat(uaFilter(base, (b) => b.brand !== 'Chitin'), [{ brand: 'Chitin', version: '0.0.0.0' }]);
                    } else if (k === 'uaFullVersion')
                        out.uaFullVersion = h.uaFullVersion !== undefined ? h.uaFullVersion : CHROME_MAJOR + '.0.0.0';
                    else if (k === 'architecture') out.architecture = h.architecture !== undefined ? h.architecture : 'x86';
                    else if (k === 'bitness') out.bitness = h.bitness !== undefined ? h.bitness : '64';
                    else if (k === 'model') out.model = h.model !== undefined ? h.model : '';
                    else if (k === 'platformVersion') out.platformVersion = h.platformVersion !== undefined ? h.platformVersion : '0.0.0';
                    else if (k === 'wow64') out.wow64 = h.wow64 !== undefined ? h.wow64 : false;
                    else if (k === 'formFactors') out.formFactors = h.formFactors !== undefined ? h.formFactors : ['Desktop'];
                }
                return out;
            })();
        },
        toJSON() {
            if (this !== instance && this !== hiddenInstance)
                throw illegalInvocation(methods.toJSON);
            const brands = this === hiddenInstance ? brandsHidden : brandsShown;
            return { brands: uaMap(brands, (b) => ({ brand: b.brand, version: b.version })), mobile: IDENTITY.mobile, platform: IDENTITY.uaPlatform };
        },
    };
    for (const name of ['getHighEntropyValues', 'toJSON']) {
        WeakSetPrototypeAdd(nativeFunctions, methods[name]);
        ObjectDefineProperty(UAData.prototype, name, { value: methods[name], writable: true, enumerable: true, configurable: true });
    }
    ObjectDefineProperty(G, 'NavigatorUAData', { value: UAData, writable: true, enumerable: false, configurable: true });
    const holder = { get userAgentData() {
        if (notWrapper(this))
            throw illegalInvocation(g);
        return chitinHiddenFor(engineUserAgentGetter, this) ? hiddenInstance : instance;
    } };
    const g = ObjectGetOwnPropertyDescriptor(holder, 'userAgentData').get;
    WeakSetPrototypeAdd(nativeFunctions, g);
    ObjectDefineProperty(cls.prototype, 'userAgentData', { get: g, set: undefined, enumerable: true, configurable: true });
}
function shapeNavigator(cls) {
    const engineUA = ObjectGetOwnPropertyDescriptor(cls.prototype, 'userAgent');
    const engineUserAgentGetter = engineUA !== undefined ? engineUA.get : undefined;
    for (const key of ['userAgent', 'appVersion', 'platform']) {
        const d = ObjectGetOwnPropertyDescriptor(cls.prototype, key);
        const value = IDENTITY[key];
        const hiddenValue = key === 'platform' ? value : IDENTITY.hidden[key];
        const holder = { get [key]() {
            if (notWrapper(this))
                throw illegalInvocation(g);
            return chitinHiddenFor(engineUserAgentGetter, this) ? hiddenValue : value;
        } };
        const g = ObjectGetOwnPropertyDescriptor(holder, key).get;
        WeakSetPrototypeAdd(nativeFunctions, g);
        ObjectDefineProperty(cls.prototype, key, { get: g, set: undefined, enumerable: d !== undefined ? d.enumerable : true, configurable: d !== undefined ? d.configurable : true });
    }
    shapeUserAgentData(cls, engineUserAgentGetter);
    for (const key of ['hardwareConcurrency', 'deviceMemory']) {
        const d = ObjectGetOwnPropertyDescriptor(cls.prototype, key);
        if (d === undefined || d.get === undefined || HOST_NAVIGATOR_VALUES[key] === undefined)
            continue;
        const value = HOST_NAVIGATOR_VALUES[key];
        const holder = { get [key]() {
            if (notWrapper(this))
                throw illegalInvocation(g);
            return value;
        } };
        const g = ObjectGetOwnPropertyDescriptor(holder, key).get;
        WeakSetPrototypeAdd(nativeFunctions, g);
        ObjectDefineProperty(cls.prototype, key, { get: g, set: undefined, enumerable: d.enumerable, configurable: d.configurable });
    }
}
// navigator.webkitTemporaryStorage and webkitPersistentStorage: Chrome's DeprecatedStorageQuota (one object for both, its interface not
// on the global), which sites still probe (cnn.com reads queryUsageAndQuota). Usage and quota are navigator.storage.estimate()'s, as
// Chrome answers both from the quota manager; requestQuota grants what is asked up to the quota. Callbacks come later, never in the call.
function shapeDeprecatedStorageQuota(cls) {
    if (ObjectGetOwnPropertyDescriptor(cls.prototype, 'webkitTemporaryStorage') !== undefined)
        return;
    const proto = {};
    ObjectDefineProperty(proto, SymbolToStringTag, { value: 'DeprecatedStorageQuota', configurable: true });
    const quota = ObjectCreate(proto);
    const failed = (op, what) => new HostTypeError("Failed to execute '" + op + "' on 'DeprecatedStorageQuota': " + what);
    const later = (estimate, onError, then) => {
        let p;
        try {
            p = G.navigator.storage.estimate();
        } catch (e) {
            p = PromiseReject(e);
        }
        p.then((e) => then(e && typeof e.usage === 'number' ? e.usage : 0, e && typeof e.quota === 'number' ? e.quota : 0), (e) => {
            if (typeof onError === 'function')
                onError(e);
        }).catch((e) => { try { G.reportError(e); } catch { /* nothing more to do */ } });
    };
    const method = (name, body) => {
        const f = { [name](...args) {
            if (this !== quota)
                throw illegalInvocation(f);
            return body(args);
        } }[name];
        ObjectDefineProperty(f, 'length', { value: 1, configurable: true });
        WeakSetPrototypeAdd(nativeFunctions, f);
        ObjectDefineProperty(proto, name, { value: f, writable: true, enumerable: true, configurable: true });
    };
    method('queryUsageAndQuota', (args) => {
        if (args.length < 1)
            throw failed('queryUsageAndQuota', '1 argument required, but only 0 present.');
        const [onUsage, onError] = args;
        if (typeof onUsage !== 'function')
            throw failed('queryUsageAndQuota', "parameter 1 is not of type 'Function'.");
        if (onError !== undefined && onError !== null && typeof onError !== 'function')
            throw failed('queryUsageAndQuota', "parameter 2 is not of type 'Function'.");
        later(true, onError, (usage, q) => onUsage(usage, q));
    });
    method('requestQuota', (args) => {
        if (args.length < 1)
            throw failed('requestQuota', '1 argument required, but only 0 present.');
        const [size, onGranted, onError] = args;
        const wanted = +size;
        if (onGranted !== undefined && onGranted !== null && typeof onGranted !== 'function')
            throw failed('requestQuota', "parameter 2 is not of type 'Function'.");
        if (onError !== undefined && onError !== null && typeof onError !== 'function')
            throw failed('requestQuota', "parameter 3 is not of type 'Function'.");
        later(false, onError, (usage, q) => { if (typeof onGranted === 'function') onGranted(MathMin(wanted > 0 ? wanted : 0, q)); });
    });
    for (const key of ['webkitTemporaryStorage', 'webkitPersistentStorage']) {
        const holder = { get [key]() {
            if (notWrapper(this))
                throw illegalInvocation(g);
            return quota;
        } };
        const g = ObjectGetOwnPropertyDescriptor(holder, key).get;
        WeakSetPrototypeAdd(nativeFunctions, g);
        ObjectDefineProperty(cls.prototype, key, { get: g, set: undefined, enumerable: true, configurable: true });
    }
}
function shapeClass(name, cls) {
    if (name === 'Navigator') {
        shapeNavigator(cls);
        shapeDeprecatedStorageQuota(cls);
    }
    if (name === 'Crypto')
        shapeCrypto(cls);
    if (name === 'SubtleCrypto')
        shapeSubtleCrypto(cls);
    shapeIterator(name, cls);
    if (name === 'Performance' && !ObjectHasOwn(cls.prototype, 'memory')) {
        const MemoryInfo = makeClass('MemoryInfo', null, 0);
        ObjectDefineProperty(MemoryInfo.prototype, SymbolToStringTag, { value: 'MemoryInfo', configurable: true });
        const numbers = ['jsHeapSizeLimit', 'totalJSHeapSize', 'usedJSHeapSize'];
        for (let i = 0; i < numbers.length; i++) {
            const key = numbers[i];
            const getter = { get [key]() {
                if (!(this instanceof MemoryInfo))
                    throw illegalInvocation(getter);
                return hostMemoryValue(key);
            } };
            const g = ObjectGetOwnPropertyDescriptor(getter, key).get;
            WeakSetPrototypeAdd(nativeFunctions, g);
            ObjectDefineProperty(MemoryInfo.prototype, key, { get: g, set: undefined, enumerable: true, configurable: true });
        }
        const info = ReflectConstruct(function () {}, [], MemoryInfo); // an instance without running the interface's constructor
        const memory = { get memory() {
            if (!(this instanceof cls))
                throw illegalInvocation(memoryGetter);
            return info;
        } };
        const memoryGetter = ObjectGetOwnPropertyDescriptor(memory, 'memory').get;
        WeakSetPrototypeAdd(nativeFunctions, memoryGetter);
        ObjectDefineProperty(cls.prototype, 'memory', { get: memoryGetter, set: undefined, enumerable: true, configurable: true });
    }
}
// crypto.getRandomValues (docs/crypto.md): the engine's JS runtime has no DataView, so the bridge hands it a DataView as the
// Uint8Array over the same bytes and the engine filled it; WebCrypto says TypeMismatchError. Both errors in Chrome's words.
const GRV_INTEGER_TAGS = { __proto__: null, Int8Array: true, Uint8Array: true, Uint8ClampedArray: true, Int16Array: true, Uint16Array: true, Int32Array: true, Uint32Array: true, BigInt64Array: true, BigUint64Array: true };
function shapeCrypto(cls) {
    const d = ObjectGetOwnPropertyDescriptor(cls.prototype, 'getRandomValues');
    if (d === undefined || typeof d.value !== 'function')
        return;
    const engineGetRandomValues = d.value;
    const method = { getRandomValues(array) {
        if (arguments.length > 0 && ArrayBufferIsView(array)) {
            const tag = TypedArrayTag(array);
            const DOMExceptionClass = MapPrototypeGet(classByName, 'DOMException');
            if (DOMExceptionClass !== undefined && GRV_INTEGER_TAGS[tag] !== true)
                throw withStackFrom(new DOMExceptionClass("Failed to execute 'getRandomValues' on 'Crypto': The provided ArrayBufferView is of type '" + (tag === undefined ? 'DataView' : StringPrototypeSlice(tag, 0, tag.length - 5)) + "', which is not an integer array type.", 'TypeMismatchError'), method);
            const length = TypedArrayByteLength(array);
            if (DOMExceptionClass !== undefined && length > 65536)
                throw withStackFrom(new DOMExceptionClass("Failed to execute 'getRandomValues' on 'Crypto': The ArrayBufferView's byte length (" + length + ') exceeds the number of bytes of entropy available via this API (65536).', 'QuotaExceededError'), method);
        }
        try {
            return ReflectApply(engineGetRandomValues, this, arguments);
        } catch (e) {
            throw withStackFrom(e, method);
        }
    } }.getRandomValues;
    WeakSetPrototypeAdd(nativeFunctions, method);
    ObjectDefineProperty(cls.prototype, 'getRandomValues', { value: method, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable });
}
// Chrome 154 has no ML-KEM members on SubtleCrypto (encapsulateKey/Bits, decapsulateKey/Bits): a page that tests for them
// would take a path Chrome never takes.
function shapeSubtleCrypto(cls) {
    const names = ['encapsulateKey', 'encapsulateBits', 'decapsulateKey', 'decapsulateBits'];
    for (let i = 0; i < names.length; i++)
        ReflectDeleteProperty(cls.prototype, names[i]);
}
// A pair iterable's @@iterator is its entries (a set-like's is its values), the same function: Chrome's `[Symbol.iterator].name` is
// "entries"; the engine makes a function of its own named "[Symbol.iterator]".
const SET_LIKE_INTERFACES = { __proto__: null, FontFaceSet: true, CustomStateSet: true, ViewTransitionTypeSet: true };
function shapeIterator(name, cls) {
    const proto = cls.prototype;
    const a = ObjectGetOwnPropertyDescriptor(proto, SymbolAsyncIterator);
    if (a !== undefined && typeof a.value === 'function' && WeakSetPrototypeHas(nativeFunctions, a.value) && a.value.name === '[Symbol.asyncIterator]') {
        const v = ObjectGetOwnPropertyDescriptor(proto, 'values');
        if (v !== undefined && typeof v.value === 'function')
            ObjectDefineProperty(proto, SymbolAsyncIterator, { value: v.value, writable: true, enumerable: false, configurable: true });
    }
    const d = ObjectGetOwnPropertyDescriptor(proto, SymbolIterator);
    if (d === undefined || typeof d.value !== 'function' || !WeakSetPrototypeHas(nativeFunctions, d.value) || d.value.name !== '[Symbol.iterator]')
        return;
    const keys = SET_LIKE_INTERFACES[name] === true ? ['values', 'entries'] : ['entries', 'values'];
    for (let i = 0; i < keys.length; i++) {
        const e = ObjectGetOwnPropertyDescriptor(proto, keys[i]);
        if (e !== undefined && typeof e.value === 'function') {
            ObjectDefineProperty(proto, SymbolIterator, { value: e.value, writable: true, enumerable: false, configurable: true });
            return;
        }
    }
}

function hostMemoryValue(key) {
    if (hostMemoryDescriptor !== undefined && hostMemoryDescriptor.get !== undefined) {
        try {
            return ReflectApply(hostMemoryDescriptor.get, hostPerformance, [])[key];
        } catch { /* fall through */ }
    }
    return syntheticMemory(key);
}

// webkitRequestFileSystem and webkitResolveLocalFileSystemURL exist on a Chrome page (the Worker's were removed as doors); the
// segment has no file system to give, so they answer as a page does when the browser refuses: the error callback, later, with a
// SecurityError.
function shapeFileSystem() {
    const define = (name, length, errorIndex) => {
        const f = { [name](...args) {
            if (foreignReceiver(this, G))
                throw illegalInvocation(f);
            const onError = args[errorIndex];
            const DOMExceptionClass = MapPrototypeGet(classByName, 'DOMException');
            if (typeof onError === 'function' && DOMExceptionClass !== undefined)
                HostQueueMicrotask(() => { try { onError(new DOMExceptionClass('It was determined that certain files are unsafe for access within a Web application, or that too many calls are being made on file resources.', 'SecurityError')); } catch (e) { try { G.reportError(e); } catch { /* nothing more to do */ } } });
        } }[name];
        ObjectDefineProperty(f, 'length', { value: length, configurable: true });
        WeakSetPrototypeAdd(nativeFunctions, f);
        ObjectDefineProperty(G, name, { value: f, writable: true, enumerable: true, configurable: true });
    };
    define('webkitRequestFileSystem', 3, 3);
    define('webkitResolveLocalFileSystemURL', 2, 2);
}

function shapeSurface() {
    shapeWindowChain();
    shapeAtomics();
    shapeDialogs();
    shapeChromeObject();
    shapeFileSystem();
}
