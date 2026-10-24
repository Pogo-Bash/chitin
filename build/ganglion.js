/*! Chitin: a web browser that runs inside a web page. Copyright (c) 2026 [OWNER NAME].
 * Licensed under the GNU GPL, version 2 or later (LICENSE.md); built on Ladybird (BSD-2-Clause,
 * CREDITS.md). Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL]). */
// Chitin segment glue (bundled by tools/bundle-glue.py; sources in glue/).
(function () {
'use strict';

// ===== glue/00-primordials.js =====
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Chitin segment glue: captured primordials.
//
// Page JS shares this realm with the glue, so every builtin the glue relies on is captured here,
// before any page script runs, in the style of Node.js's lib/internal/per_context/primordials.js.
// After this point the glue never looks up a property the page could have replaced:
//   - methods are called through uncurried captured functions, never as obj.method();
//   - internal records, tables and lists are null-prototype objects or arrays, so reads and
//     writes never reach a prototype the page can define accessors on (Array.prototype[0] setters
//     would otherwise see every value the glue stores);
//   - typed-array views over linear memory are only indexed, never passed to anything that reads
//     .length, .buffer or .constructor (a patched %TypedArray%.prototype getter would receive the
//     view and could reach memory.buffer, i.e. the whole engine);
//   - glue code is strict mode, so V8's Error.prepareStackTrace CallSites cannot hand page JS a
//     glue function or receiver (getThis/getFunction return undefined in strict frames).

const {
    Array,
    ArrayBuffer: HostArrayBuffer,
    DOMException: HostDOMException,
    Error: HostError,
    FinalizationRegistry,
    Float32Array,
    Float64Array,
    Function: HostFunction,
    Math: HostMath,
    Number: HostNumber,
    Object: HostObject,
    Reflect: HostReflect,
    String: HostString,
    Symbol: HostSymbol,
    TextDecoder,
    TypeError: HostTypeError,
    Uint16Array,
    Uint32Array,
    WeakMap,
    WeakRef,
    WebAssembly: HostWebAssembly,
} = globalThis;

const uncurryThis = HostFunction.prototype.bind.bind(HostFunction.prototype.call);

const ReflectApply = HostReflect.apply;
const ReflectSet = HostReflect.set;
const ReflectConstruct = HostReflect.construct;
const ObjectDefineProperty = HostObject.defineProperty;
const ObjectGetOwnPropertyDescriptor = HostObject.getOwnPropertyDescriptor;
const ObjectSetPrototypeOf = HostObject.setPrototypeOf;
const ObjectGetPrototypeOf = HostObject.getPrototypeOf;
const ObjectFreeze = HostObject.freeze;
const ObjectKeys = HostObject.keys;
const HostDate = globalThis.Date;
const DatePrototypeGetTime = HostDate.prototype.getTime;
const ObjectHasOwn = HostObject.hasOwn;
const NumberIsFinite = HostNumber.isFinite;
const MathFloor = HostMath.floor;
const MathMin = HostMath.min;
const MathMax = HostMath.max;
const StringFromCharCode = HostString.fromCharCode;
const StringPrototypeCharCodeAt = uncurryThis(HostString.prototype.charCodeAt);
const StringPrototypeIncludes = uncurryThis(HostString.prototype.includes);
const StringPrototypeIndexOf = uncurryThis(HostString.prototype.indexOf);
const StringPrototypeTrim = uncurryThis(HostString.prototype.trim);
const MapPrototypeClear = uncurryThis(globalThis.Map.prototype.clear);
// The host's microtask queue: promise jobs run on it, and the page's queueMicrotask joins it (see 40-bridge.js).
const HostQueueMicrotask = typeof queueMicrotask === 'function' ? queueMicrotask : null;
// A host task that runs after the host's microtasks, unclamped (setTimeout nests to 4 ms): one MessageChannel of the host's.
const HostMessageChannel = typeof MessageChannel === 'function' && typeof MessagePort === 'function' ? MessageChannel : null;
// (Node's ports are own properties of the channel, Chrome's are accessors on the prototype.)
const channelPortGetter = (name) => {
    const d = HostMessageChannel ? ObjectGetOwnPropertyDescriptor(HostMessageChannel.prototype, name) : undefined;
    return d && d.get ? uncurryThis(d.get) : (channel) => channel[name];
};
const MessageChannelPort1 = channelPortGetter('port1');
const MessageChannelPort2 = channelPortGetter('port2');
const MessagePortPostMessage = HostMessageChannel ? uncurryThis(globalThis.MessagePort.prototype.postMessage) : null;
const portOnmessage = HostMessageChannel ? ObjectGetOwnPropertyDescriptor(MessagePort.prototype, 'onmessage') : undefined;
const MessagePortSetOnmessage = portOnmessage && portOnmessage.set ? uncurryThis(portOnmessage.set) : (port, f) => { port.onmessage = f; };
const SymbolUnscopables = HostSymbol.unscopables;
const SymbolToStringTag = HostSymbol.toStringTag;
const WeakRefPrototypeDeref = uncurryThis(WeakRef.prototype.deref);
const FinalizationRegistryPrototypeRegister = uncurryThis(FinalizationRegistry.prototype.register);
const WeakMapPrototypeGet = uncurryThis(WeakMap.prototype.get);
const WeakMapPrototypeSet = uncurryThis(WeakMap.prototype.set);
const TextDecoderPrototypeDecode = uncurryThis(TextDecoder.prototype.decode);
const WebAssemblyModule = HostWebAssembly.Module;
const WebAssemblyInstance = HostWebAssembly.Instance;
const WebAssemblyMemoryPrototypeGetBuffer = uncurryThis(ObjectGetOwnPropertyDescriptor(HostWebAssembly.Memory.prototype, 'buffer').get);
const WebAssemblyInstancePrototypeGetExports = uncurryThis(ObjectGetOwnPropertyDescriptor(HostWebAssembly.Instance.prototype, 'exports').get);
const indirectEval = globalThis.eval;
const hostReportError = typeof globalThis.reportError === 'function' ? globalThis.reportError : undefined;
const hostConsoleError = globalThis.console && globalThis.console.error ? uncurryThis(globalThis.console.error) : undefined;
const hostConsole = globalThis.console;
const hostPerformanceNow = globalThis.performance ? uncurryThis(globalThis.performance.now) : undefined;
const hostPerformance = globalThis.performance;

// A null-prototype array: indexed writes never consult Array.prototype.
function safeArray() {
    return ObjectSetPrototypeOf([], null);
}

function typeError(message) {
    return new HostTypeError(message);
}

// ===== glue/10-runtime.js =====
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Chitin segment glue: the runtime under the generated bindings.
//
// Holds the engine instance privately (page JS can never reach X, memory or the views), the
// wrapper table, the anchors of the GC scheme (docs/research/bindings-and-gc.md, section 3) and the
// string and error conventions of toy/engine/Bindings.h.

const kCreate = HostSymbol('chitin.create'); // never leaves this closure

let X;           // the engine's exports (a frozen, null-prototype object)
let memory;
let u16, u32, f64; // views over linear memory, refreshed when it grows
let viewBuffer;    // the ArrayBuffer the views are on (never read back from a view: see primordials)
let ioBase = 0;  // byte address of the engine's IO block (Bindings.h, struct IO)
let inBase = 0;  // u16 index of the input buffer
let inCapacity = 0;
let inTop = 0;   // stack pointer into the input buffer, in code units (re-entrant calls nest)
let bigCount = 0;
const bigPointers = safeArray();
const bigOwners = safeArray();
const rootAccess = { __proto__: null };
const stats = { __proto__: null, wrappersCreated: 0, wrappersFinalized: 0, anchorsCreated: 0, anchorsMerged: 0, anchorsSplit: 0, anchorsRevived: 0, lostEdges: 0, listenerErrors: 0 };

function refreshViews() {
    const buffer = WebAssemblyMemoryPrototypeGetBuffer(memory);
    viewBuffer = buffer;
    u16 = new Uint16Array(buffer);
    u32 = new Uint32Array(buffer);
    f64 = new Float64Array(buffer);
}

// --- Strings -------------------------------------------------------------------------------------

function toDOMString(value) {
    // WebIDL DOMString conversion is ToString, which throws for Symbols; a template literal does
    // exactly that (String(symbol) would not).
    return typeof value === 'string' ? value : `${value}`;
}

function ToNumberInt(value) {
    return +value; // ToNumber; |0 and >>>0 then give WebIDL's ConvertToInt (non-[EnforceRange])
}

function toFiniteDouble(value, label) {
    const x = +value;
    if (!NumberIsFinite(x))
        throw typeError(label + ': The provided double value is non-finite.');
    return x;
}

function putString(s) {
    const n = s.length;
    if (inTop + n > inCapacity)
        return putBigString(s);
    const o = inBase + inTop;
    for (let i = 0; i < n; i++)
        u16[o + i] = StringPrototypeCharCodeAt(s, i);
    inTop += n;
    return o * 2;
}

function putBigString(s) {
    const n = s.length;
    const p = X.malloc(n * 2 + 2);
    if (WebAssemblyMemoryPrototypeGetBuffer(memory) !== viewBuffer)
        refreshViews();
    const o = p >>> 1;
    for (let i = 0; i < n; i++)
        u16[o + i] = StringPrototypeCharCodeAt(s, i);
    bigPointers[bigCount] = p;
    bigOwners[bigCount] = inTop;
    bigCount++;
    inTop += 1; // so a nested call's base is above this owner
    return p;
}

function endCall(base) {
    inTop = base;
    while (bigCount !== 0 && bigOwners[bigCount - 1] >= base) {
        bigCount--;
        X.free(bigPointers[bigCount]);
    }
}

const utf16Decoder = new TextDecoder('utf-16le');

function readOut(n) {
    const p = u32[(ioBase + 8) >>> 2] >>> 1;
    if (n <= 32) {
        let s = '';
        for (let i = 0; i < n; i++)
            s += StringFromCharCode(u16[p + i]);
        return s;
    }
    // TextDecoder reads the view's internal slots only; a fresh view built by the captured
    // constructor is never exposed.
    return TextDecoderPrototypeDecode(utf16Decoder, new Uint16Array(viewBuffer, p * 2, n));
}

const atomCache = safeArray();
function atomString(id) {
    const s = atomCache[id];
    if (s !== undefined)
        return s;
    const t = readOut(X.ganglion_atom_text(id));
    atomCache[id] = t;
    return t;
}

function readRect() {
    const o = (ioBase + 16) >>> 3;
    return makeDOMRect(f64[o], f64[o + 1], f64[o + 2], f64[o + 3]);
}

// --- Errors --------------------------------------------------------------------------------------

const errorNames = ObjectFreeze({
    __proto__: null,
    2: 'HierarchyRequestError',
    3: 'NotFoundError',
    4: 'InvalidCharacterError',
    5: 'IndexSizeError',
    6: 'NotSupportedError',
    7: 'InvalidStateError',
    8: 'WrongDocumentError',
    9: 'SyntaxError',
});
const errorMessages = ObjectFreeze({
    __proto__: null,
    2: 'The operation would yield an incorrect node tree.',
    3: 'The object can not be found here.',
    4: 'The string contains invalid characters.',
    5: 'The index is not in the allowed range.',
    6: 'The operation is not supported.',
    7: 'The object is in an invalid state.',
    8: 'The object is in the wrong document.',
    9: 'The string did not match the expected pattern.',
});

function throwEngineError(code) {
    if (code === 1)
        throw typeError('Invalid argument.');
    throw new HostDOMException(errorMessages[code] || 'Unknown error.', errorNames[code] || 'UnknownError');
}

function illegalInvocation() {
    return typeError('Illegal invocation');
}

function argCountError(label, required, present) {
    return typeError(`${label}: ${required} argument${required === 1 ? '' : 's'} required, but only ${present} present.`);
}

function reportException(error) {
    stats.listenerErrors++;
    if (reportErrorHook !== undefined)
        reportErrorHook(error);
    else if (hostReportError !== undefined)
        ReflectApply(hostReportError, globalThis, [error]);
    else if (hostConsoleError !== undefined)
        hostConsoleError(hostConsole, error);
}
let reportErrorHook;

// --- Wrappers ------------------------------------------------------------------------------------
//
// table[index] holds a WeakRef to the wrapper of the object with that handle index; tableHandle
// guards against index reuse (handles carry a generation). A FinalizationRegistry tells the engine
// when a wrapper dies, so it can clear its "has live wrapper" bit. The serial in the held value
// stops a late callback for a dead wrapper from clearing the bit of its replacement.

const table = safeArray();
const tableHandle = safeArray();
const tableType = safeArray();
const tableSerial = safeArray();
let serialCounter = 0;
const TWO_32 = 4294967296;

const wrapperRegistry = new FinalizationRegistry((held) => {
    const h = held % TWO_32;
    const serial = MathFloor(held / TWO_32);
    const index = h >>> 8;
    if (tableHandle[index] !== h || tableSerial[index] !== serial)
        return;
    if (WeakRefPrototypeDeref(table[index]) !== undefined)
        return;
    table[index] = undefined;
    tableHandle[index] = 0;
    stats.wrappersFinalized++;
    X.ganglion_wrapper_dropped(h);
});

function wrap(h) {
    const index = h >>> 8;
    if (tableHandle[index] === h) {
        const w = WeakRefPrototypeDeref(table[index]);
        if (w !== undefined)
            return w;
    }
    return createWrapper(h);
}

function createWrapper(h) {
    const r = X.ganglion_wrapper_created(h);
    const type = r >>> 24;
    const anchorId = r & 0xffffff;
    const anchor = anchorId === 0 ? undefined : anchorFor(anchorId);
    const C = interfaceClasses[type];
    const w = new C(kCreate, h, anchor);
    register(w, h, type, anchor);
    return w;
}

// For objects made by an IDL constructor (new EventTarget(), new Event(...)): `w` is `this`,
// possibly an instance of a page subclass.
function adoptConstructed(w, h) {
    const r = X.ganglion_wrapper_created(h);
    const anchorId = r & 0xffffff;
    const anchor = anchorId === 0 ? undefined : anchorFor(anchorId);
    register(w, h, r >>> 24, anchor);
    return anchor;
}

function register(w, h, type, anchor) {
    const index = h >>> 8;
    const serial = (++serialCounter) & 0x1fffff;
    table[index] = new WeakRef(w);
    tableHandle[index] = h;
    tableType[index] = type;
    tableSerial[index] = serial;
    FinalizationRegistryPrototypeRegister(wrapperRegistry, w, h + serial * TWO_32);
    if (anchor !== undefined) {
        anchor.wrappers[h] = w;
        anchor.count++;
    }
    stats.wrappersCreated++;
}

function setAnchorOf(w, h, anchor) {
    rootAccess[interfaceRoots[tableType[h >>> 8]]].setA(w, anchor);
}

// --- Anchors -------------------------------------------------------------------------------------
//
// One anchor per component (a node tree, or a standalone EventTarget) that holds two or more JS
// items, or is pinned (toy/engine/Heap.cpp, needs_anchor). It holds every engine -> JS edge of the
// component (edges: listener callbacks by edge id) and every wrapper of the component (wrappers: by
// handle), and every wrapper holds its anchor in a private field. So a component's JS state lives
// exactly as long as JS can reach any of its wrappers, or the engine pins the anchor.
//
// Merges link instead of copying (union-find): the inserted component's anchor becomes a child of
// ours (child.parent = top, top.kids[key] = child), so its wrappers keep the top alive and the top
// keeps them alive. Edges always live on the top anchor, found by following parents.

const anchorRefs = safeArray();
const pinnedAnchors = { __proto__: null };
let anchorKeys = 0;

function makeAnchor(id, pinned) {
    const a = { __proto__: null, id, key: ++anchorKeys, parent: undefined, kids: undefined, kidCount: 0, count: 0, edges: { __proto__: null }, wrappers: { __proto__: null } };
    anchorRefs[id] = new WeakRef(a);
    if (pinned)
        pinnedAnchors[id] = a;
    stats.anchorsCreated++;
    return a;
}

function liveAnchor(id) {
    const ref = anchorRefs[id];
    return ref === undefined ? undefined : WeakRefPrototypeDeref(ref);
}

function anchorFor(id) {
    const a = liveAnchor(id);
    if (a !== undefined)
        return a;
    stats.anchorsRevived++;
    return makeAnchor(id, false);
}

function topAnchor(a) {
    let top = a;
    while (top.parent !== undefined)
        top = top.parent;
    // Path compression would re-parent; it is unnecessary at these depths, so keep links stable.
    return top;
}

// Drops an anchor that holds nothing from its parent, and walks up.
function pruneAnchor(a) {
    while (a.parent !== undefined && a.count === 0 && a.kidCount === 0) {
        const parent = a.parent;
        delete parent.kids[a.key];
        parent.kidCount--;
        a.parent = undefined;
        a = parent;
    }
}

function lookupWrapper(h) {
    const index = h >>> 8;
    if (tableHandle[index] !== h)
        return undefined;
    return WeakRefPrototypeDeref(table[index]);
}

function moveWrapper(w, h, target) {
    const root = rootAccess[interfaceRoots[tableType[h >>> 8]]];
    const current = root.a(w);
    if (current === target)
        return;
    if (current !== undefined) {
        delete current.wrappers[h];
        current.count--;
        pruneAnchor(current);
    }
    if (target !== undefined) {
        target.wrappers[h] = w;
        target.count++;
    }
    root.setA(w, target);
}

const imports = {
    __proto__: null,
    anchor_create(id, pinned) {
        makeAnchor(id, pinned !== 0);
    },
    anchor_adopt(id, handlesPtr, handleCount) {
        const target = anchorFor(id);
        const h0 = handlesPtr >>> 2;
        for (let i = 0; i < handleCount; i++) {
            const h = u32[h0 + i];
            const w = lookupWrapper(h);
            if (w !== undefined)
                moveWrapper(w, h, target);
        }
    },
    anchor_merge(from, into) {
        stats.anchorsMerged++;
        const source = liveAnchor(from);
        anchorRefs[from] = undefined;
        delete pinnedAnchors[from];
        if (source === undefined)
            return;
        const target = anchorFor(into);
        const edges = source.edges;
        for (const e in edges)
            target.edges[e] = edges[e];
        source.edges = { __proto__: null };
        source.parent = target;
        if (target.kids === undefined)
            target.kids = { __proto__: null };
        target.kids[source.key] = source;
        target.kidCount++;
    },
    anchor_split(from, to, edgesPtr, edgeCount, handlesPtr, handleCount) {
        stats.anchorsSplit++;
        const source = from === 0 ? undefined : liveAnchor(from);
        const target = to === 0 ? undefined : anchorFor(to);
        if (source !== undefined && target !== undefined) {
            const e0 = edgesPtr >>> 2;
            for (let i = 0; i < edgeCount; i++) {
                const e = u32[e0 + i];
                const v = source.edges[e];
                if (v !== undefined) {
                    target.edges[e] = v;
                    delete source.edges[e];
                }
            }
        }
        const h0 = handlesPtr >>> 2;
        for (let i = 0; i < handleCount; i++) {
            const h = u32[h0 + i];
            const w = lookupWrapper(h);
            if (w !== undefined)
                moveWrapper(w, h, target);
        }
    },
    anchor_released(id) {
        anchorRefs[id] = undefined;
        delete pinnedAnchors[id];
    },
    anchor_pin(id, pinned) {
        if (pinned !== 0)
            pinnedAnchors[id] = anchorFor(id);
        else
            delete pinnedAnchors[id];
    },
    invoke_listener(anchorId, edge, thisHandle, eventHandle, deleteAfter) {
        const anchor = liveAnchor(anchorId);
        if (anchor === undefined) {
            stats.lostEdges++;
            return;
        }
        const callback = anchor.edges[edge];
        if (deleteAfter !== 0)
            delete anchor.edges[edge];
        if (callback === undefined) {
            stats.lostEdges++;
            return;
        }
        const thisValue = wrap(thisHandle);
        const event = wrap(eventHandle);
        try {
            if (typeof callback === 'function') {
                ReflectApply(callback, thisValue, [event]);
            } else {
                const handleEvent = callback.handleEvent;
                if (typeof handleEvent !== 'function')
                    throw typeError("The provided callback is not a function and has no 'handleEvent' method.");
                ReflectApply(handleEvent, callback, [event]);
            }
        } catch (error) {
            reportException(error);
        }
    },
    now() {
        return hostPerformanceNow !== undefined ? hostPerformanceNow(hostPerformance) : 0;
    },
};

// Callback identity for add/removeEventListener: an id per JS callback object, held weakly.
const callbackIds = new WeakMap();
let nextCallbackId = 1;
function callbackIdOf(callback, create) {
    let id = WeakMapPrototypeGet(callbackIds, callback);
    if (id === undefined && create) {
        id = nextCallbackId++;
        WeakMapPrototypeSet(callbackIds, callback, id);
    }
    return id;
}

// --- Interface objects -----------------------------------------------------------------------

function finishInterface(C, info) {
    const proto = C.prototype;
    for (let i = 0; i < info.members.length; i++) {
        const name = info.members[i];
        const desc = ObjectGetOwnPropertyDescriptor(proto, name);
        if (desc === undefined)
            continue; // [ImplementedInBindings]: installed by glue/custom
        desc.enumerable = true;
        ObjectDefineProperty(proto, name, desc);
    }
    for (const k of ObjectKeys(info.constants)) {
        const desc = { __proto__: null, value: info.constants[k], writable: false, enumerable: true, configurable: false };
        ObjectDefineProperty(C, k, desc);
        ObjectDefineProperty(proto, k, desc);
    }
    if (info.unscopables.length) {
        const u = { __proto__: null };
        for (let i = 0; i < info.unscopables.length; i++)
            u[info.unscopables[i]] = true;
        ObjectDefineProperty(proto, SymbolUnscopables, { __proto__: null, value: u, writable: false, enumerable: false, configurable: true });
    }
    ObjectDefineProperty(proto, SymbolToStringTag, { __proto__: null, value: info.name, writable: false, enumerable: false, configurable: true });
    ObjectDefineProperty(C, 'length', { __proto__: null, value: info.length, writable: false, enumerable: false, configurable: true });
}

function installCustom(C, members, lengths) {
    const proto = C.prototype;
    for (const name of ObjectKeys(members)) {
        const fn = members[name];
        ObjectDefineProperty(fn, 'length', { __proto__: null, value: lengths[name], writable: false, enumerable: false, configurable: true });
        ObjectDefineProperty(proto, name, { __proto__: null, value: fn, writable: true, enumerable: true, configurable: true });
    }
}

// ===== build/gen/bindings.gen.js =====
// Generated by bindings/generate.py from toy/idl/*.idl. Do not edit.
// Parser: Ladybird's Meta/Utils/webidl_parser.py (BSD-2-Clause).

let CSSStyleDeclaration_is, CSSStyleDeclaration_h, CSSStyleDeclaration_arg;
let CSSStyleDeclaration_anchor;
let EventTarget_is, EventTarget_h, EventTarget_arg;
let EventTarget_anchor;
let Node_is, Node_h, Node_arg;
let CharacterData_is, CharacterData_h, CharacterData_arg;
let Document_is, Document_h, Document_arg;
let Element_is, Element_h, Element_arg;
let Event_is, Event_h, Event_arg;
let Event_anchor;
let HTMLElement_is, HTMLElement_h, HTMLElement_arg;
let KeyboardEvent_is, KeyboardEvent_h, KeyboardEvent_arg;
let MouseEvent_is, MouseEvent_h, MouseEvent_arg;
let Range_is, Range_h, Range_arg;
let Range_anchor;
let Text_is, Text_h, Text_arg;
let CSSStyleDeclaration_raw;
let Event_raw;
let EventTarget_raw;
let Range_raw;

// --- CSSStyleDeclaration -----------------------------------------------------------------------
class CSSStyleDeclaration {
    #brand;
    #h;
    #a;
    constructor(t, h, a) {
        if (t !== kCreate) throw typeError('Illegal constructor');
        this.#h = h;
        this.#a = a;
    }
    static {
        CSSStyleDeclaration_is = (o) => o !== null && (typeof o === 'object' || typeof o === 'function') && #brand in o;
        CSSStyleDeclaration_raw = (o) => o.#h;
        rootAccess.CSSStyleDeclaration = { __proto__: null, h: (o) => o.#h, a: (o) => o.#a, setA: (o, a) => { o.#a = a; } };
        CSSStyleDeclaration_h = (o) => { if (!CSSStyleDeclaration_is(o)) throw illegalInvocation(); return o.#h; };
        CSSStyleDeclaration_anchor = (o) => o.#a;
        CSSStyleDeclaration_arg = (o, label, position) => { if (!CSSStyleDeclaration_is(o)) throw typeError(label + ': parameter ' + position + " is not of type 'CSSStyleDeclaration'."); return CSSStyleDeclaration_raw(o); };
    }
    get cssText() {
        const h = CSSStyleDeclaration_h(this);
        const r = X.ganglion_CSSStyleDeclaration_cssText_get(h);
        if (r < -1) throwEngineError(-1 - r);
        return r === -1 ? null : readOut(r);
    }
    set cssText(value) {
        const h = CSSStyleDeclaration_h(this);
        const a0 = toDOMString(value);
        const base = inTop;
        const a0_n = a0.length;
        const a0_p = putString(a0);
        const raw = X.ganglion_CSSStyleDeclaration_cssText_set(h, a0_p, a0_n);
        endCall(base);
        const r = raw;
        if (r !== 0) throwEngineError(r);
        return undefined;
    }
    get length() {
        const h = CSSStyleDeclaration_h(this);
        return X.ganglion_CSSStyleDeclaration_length_get(h) >>> 0;
    }
    getPropertyValue(p0) {
        const h = CSSStyleDeclaration_h(this);
        if (arguments.length < 1) throw argCountError("Failed to execute 'getPropertyValue' on 'CSSStyleDeclaration'", 1, arguments.length);
        const a0 = toDOMString(p0);
        const base = inTop;
        const a0_n = a0.length;
        const a0_p = putString(a0);
        const raw = X.ganglion_CSSStyleDeclaration_getPropertyValue(h, a0_p, a0_n);
        endCall(base);
        const r = raw;
        if (r < -1) throwEngineError(-1 - r);
        return r === -1 ? null : readOut(r);
    }
    setProperty(p0, p1, p2) {
        const h = CSSStyleDeclaration_h(this);
        if (arguments.length < 2) throw argCountError("Failed to execute 'setProperty' on 'CSSStyleDeclaration'", 2, arguments.length);
        const a0 = toDOMString(p0);
        const a1 = p1 === null ? '' : toDOMString(p1);
        const a2 = (p2 === undefined ? "" : p2) === null ? '' : toDOMString((p2 === undefined ? "" : p2));
        const base = inTop;
        const a0_n = a0.length;
        const a0_p = putString(a0);
        const a1_n = a1.length;
        const a1_p = putString(a1);
        const a2_n = a2.length;
        const a2_p = putString(a2);
        const raw = X.ganglion_CSSStyleDeclaration_setProperty(h, a0_p, a0_n, a1_p, a1_n, a2_p, a2_n);
        endCall(base);
        const r = raw;
        if (r !== 0) throwEngineError(r);
        return undefined;
    }
    removeProperty(p0) {
        const h = CSSStyleDeclaration_h(this);
        if (arguments.length < 1) throw argCountError("Failed to execute 'removeProperty' on 'CSSStyleDeclaration'", 1, arguments.length);
        const a0 = toDOMString(p0);
        const base = inTop;
        const a0_n = a0.length;
        const a0_p = putString(a0);
        const raw = X.ganglion_CSSStyleDeclaration_removeProperty(h, a0_p, a0_n);
        endCall(base);
        const r = raw;
        if (r < -1) throwEngineError(-1 - r);
        return r === -1 ? null : readOut(r);
    }
}
finishInterface(CSSStyleDeclaration, { __proto__: null, name: 'CSSStyleDeclaration', members: ['cssText', 'length', 'getPropertyValue', 'setProperty', 'removeProperty'], constants: { __proto__: null,  }, unscopables: [], length: 0 });

// --- EventTarget -------------------------------------------------------------------------------
class EventTarget {
    #brand;
    #h;
    #a;
    constructor(t, h, a) {
        if (t !== kCreate) {
            if (new.target === undefined) throw typeError("Failed to construct 'EventTarget': Please use the 'new' operator.");
            const r = X.ganglion_EventTarget_construct();
            if (r < 0) throwEngineError(-r);
            h = r;
            a = adoptConstructed(this, h);
        }
        this.#h = h;
        this.#a = a;
    }
    static {
        EventTarget_is = (o) => o !== null && (typeof o === 'object' || typeof o === 'function') && #brand in o;
        EventTarget_raw = (o) => o.#h;
        rootAccess.EventTarget = { __proto__: null, h: (o) => o.#h, a: (o) => o.#a, setA: (o, a) => { o.#a = a; } };
        EventTarget_h = (o) => { if (!EventTarget_is(o)) throw illegalInvocation(); return o.#h; };
        EventTarget_anchor = (o) => o.#a;
        EventTarget_arg = (o, label, position) => { if (!EventTarget_is(o)) throw typeError(label + ': parameter ' + position + " is not of type 'EventTarget'."); return EventTarget_raw(o); };
    }
    dispatchEvent(p0) {
        const h = EventTarget_h(this);
        if (arguments.length < 1) throw argCountError("Failed to execute 'dispatchEvent' on 'EventTarget'", 1, arguments.length);
        const a0 = Event_arg(p0, "Failed to execute 'dispatchEvent' on 'EventTarget'", 1);
        const r = X.ganglion_EventTarget_dispatchEvent(h, a0);
        if (r < 0) throwEngineError(-r);
        return r === 1;
    }
}
finishInterface(EventTarget, { __proto__: null, name: 'EventTarget', members: ['addEventListener', 'removeEventListener', 'dispatchEvent'], constants: { __proto__: null,  }, unscopables: [], length: 0 });

// --- Node --------------------------------------------------------------------------------------
class Node extends EventTarget {
    #brand;
    constructor(t, h, a) {
        if (t !== kCreate) throw typeError('Illegal constructor');
        super(t, h, a);
    }
    static {
        Node_is = (o) => o !== null && (typeof o === 'object' || typeof o === 'function') && #brand in o;
        Node_h = (o) => { if (!Node_is(o)) throw illegalInvocation(); return EventTarget_raw(o); };
        Node_arg = (o, label, position) => { if (!Node_is(o)) throw typeError(label + ': parameter ' + position + " is not of type 'Node'."); return EventTarget_raw(o); };
    }
    get nodeType() {
        const h = Node_h(this);
        return X.ganglion_Node_nodeType_get(h) >>> 0;
    }
    get nodeName() {
        const h = Node_h(this);
        return atomString(X.ganglion_Node_nodeName_get(h));
    }
    get isConnected() {
        const h = Node_h(this);
        const r = X.ganglion_Node_isConnected_get(h);
        if (r < 0) throwEngineError(-r);
        return r === 1;
    }
    get ownerDocument() {
        const h = Node_h(this);
        const r = X.ganglion_Node_ownerDocument_get(h);
        if (r < 0) throwEngineError(-r);
        return r === 0 ? null : wrap(r);
    }
    get parentNode() {
        const h = Node_h(this);
        const r = X.ganglion_Node_parentNode_get(h);
        if (r < 0) throwEngineError(-r);
        return r === 0 ? null : wrap(r);
    }
    get parentElement() {
        const h = Node_h(this);
        const r = X.ganglion_Node_parentElement_get(h);
        if (r < 0) throwEngineError(-r);
        return r === 0 ? null : wrap(r);
    }
    get firstChild() {
        const h = Node_h(this);
        const r = X.ganglion_Node_firstChild_get(h);
        if (r < 0) throwEngineError(-r);
        return r === 0 ? null : wrap(r);
    }
    get lastChild() {
        const h = Node_h(this);
        const r = X.ganglion_Node_lastChild_get(h);
        if (r < 0) throwEngineError(-r);
        return r === 0 ? null : wrap(r);
    }
    get previousSibling() {
        const h = Node_h(this);
        const r = X.ganglion_Node_previousSibling_get(h);
        if (r < 0) throwEngineError(-r);
        return r === 0 ? null : wrap(r);
    }
    get nextSibling() {
        const h = Node_h(this);
        const r = X.ganglion_Node_nextSibling_get(h);
        if (r < 0) throwEngineError(-r);
        return r === 0 ? null : wrap(r);
    }
    get nodeValue() {
        const h = Node_h(this);
        const r = X.ganglion_Node_nodeValue_get(h);
        if (r < -1) throwEngineError(-1 - r);
        return r === -1 ? null : readOut(r);
    }
    set nodeValue(value) {
        const h = Node_h(this);
        const a0 = value == null ? null : toDOMString(value);
        const base = inTop;
        const a0_n = a0 === null ? -1 : a0.length;
        const a0_p = a0 === null ? 0 : putString(a0);
        const raw = X.ganglion_Node_nodeValue_set(h, a0_p, a0_n);
        endCall(base);
        const r = raw;
        if (r !== 0) throwEngineError(r);
        return undefined;
    }
    get textContent() {
        const h = Node_h(this);
        const r = X.ganglion_Node_textContent_get(h);
        if (r < -1) throwEngineError(-1 - r);
        return r === -1 ? null : readOut(r);
    }
    set textContent(value) {
        const h = Node_h(this);
        const a0 = value == null ? null : toDOMString(value);
        const base = inTop;
        const a0_n = a0 === null ? -1 : a0.length;
        const a0_p = a0 === null ? 0 : putString(a0);
        const raw = X.ganglion_Node_textContent_set(h, a0_p, a0_n);
        endCall(base);
        const r = raw;
        if (r !== 0) throwEngineError(r);
        return undefined;
    }
    hasChildNodes() {
        const h = Node_h(this);
        const r = X.ganglion_Node_hasChildNodes(h);
        if (r < 0) throwEngineError(-r);
        return r === 1;
    }
    contains(p0) {
        const h = Node_h(this);
        if (arguments.length < 1) throw argCountError("Failed to execute 'contains' on 'Node'", 1, arguments.length);
        const a0 = p0 == null ? 0 : Node_arg(p0, "Failed to execute 'contains' on 'Node'", 1);
        const r = X.ganglion_Node_contains(h, a0);
        if (r < 0) throwEngineError(-r);
        return r === 1;
    }
    insertBefore(p0, p1) {
        const h = Node_h(this);
        if (arguments.length < 2) throw argCountError("Failed to execute 'insertBefore' on 'Node'", 2, arguments.length);
        const a0 = Node_arg(p0, "Failed to execute 'insertBefore' on 'Node'", 1);
        const a1 = p1 == null ? 0 : Node_arg(p1, "Failed to execute 'insertBefore' on 'Node'", 2);
        const r = X.ganglion_Node_insertBefore(h, a0, a1);
        if (r < 0) throwEngineError(-r);
        return wrap(r);
    }
    appendChild(p0) {
        const h = Node_h(this);
        if (arguments.length < 1) throw argCountError("Failed to execute 'appendChild' on 'Node'", 1, arguments.length);
        const a0 = Node_arg(p0, "Failed to execute 'appendChild' on 'Node'", 1);
        const r = X.ganglion_Node_appendChild(h, a0);
        if (r < 0) throwEngineError(-r);
        return wrap(r);
    }
    removeChild(p0) {
        const h = Node_h(this);
        if (arguments.length < 1) throw argCountError("Failed to execute 'removeChild' on 'Node'", 1, arguments.length);
        const a0 = Node_arg(p0, "Failed to execute 'removeChild' on 'Node'", 1);
        const r = X.ganglion_Node_removeChild(h, a0);
        if (r < 0) throwEngineError(-r);
        return wrap(r);
    }
}
finishInterface(Node, { __proto__: null, name: 'Node', members: ['nodeType', 'nodeName', 'isConnected', 'ownerDocument', 'parentNode', 'parentElement', 'firstChild', 'lastChild', 'previousSibling', 'nextSibling', 'nodeValue', 'textContent', 'hasChildNodes', 'contains', 'insertBefore', 'appendChild', 'removeChild'], constants: { __proto__: null, ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9 }, unscopables: [], length: 0 });

// --- CharacterData -----------------------------------------------------------------------------
class CharacterData extends Node {
    #brand;
    constructor(t, h, a) {
        if (t !== kCreate) throw typeError('Illegal constructor');
        super(t, h, a);
    }
    static {
        CharacterData_is = (o) => o !== null && (typeof o === 'object' || typeof o === 'function') && #brand in o;
        CharacterData_h = (o) => { if (!CharacterData_is(o)) throw illegalInvocation(); return EventTarget_raw(o); };
        CharacterData_arg = (o, label, position) => { if (!CharacterData_is(o)) throw typeError(label + ': parameter ' + position + " is not of type 'CharacterData'."); return EventTarget_raw(o); };
    }
    get data() {
        const h = CharacterData_h(this);
        const r = X.ganglion_CharacterData_data_get(h);
        if (r < -1) throwEngineError(-1 - r);
        return r === -1 ? null : readOut(r);
    }
    set data(value) {
        const h = CharacterData_h(this);
        const a0 = value === null ? '' : toDOMString(value);
        const base = inTop;
        const a0_n = a0.length;
        const a0_p = putString(a0);
        const raw = X.ganglion_CharacterData_data_set(h, a0_p, a0_n);
        endCall(base);
        const r = raw;
        if (r !== 0) throwEngineError(r);
        return undefined;
    }
    get length() {
        const h = CharacterData_h(this);
        return X.ganglion_CharacterData_length_get(h) >>> 0;
    }
    appendData(p0) {
        const h = CharacterData_h(this);
        if (arguments.length < 1) throw argCountError("Failed to execute 'appendData' on 'CharacterData'", 1, arguments.length);
        const a0 = toDOMString(p0);
        const base = inTop;
        const a0_n = a0.length;
        const a0_p = putString(a0);
        const raw = X.ganglion_CharacterData_appendData(h, a0_p, a0_n);
        endCall(base);
        const r = raw;
        if (r !== 0) throwEngineError(r);
        return undefined;
    }
    remove() {
        const h = CharacterData_h(this);
        const r = X.ganglion_CharacterData_remove(h);
        if (r !== 0) throwEngineError(r);
        return undefined;
    }
}
finishInterface(CharacterData, { __proto__: null, name: 'CharacterData', members: ['data', 'length', 'appendData', 'remove'], constants: { __proto__: null,  }, unscopables: ['remove'], length: 0 });

// --- Document ----------------------------------------------------------------------------------
class Document extends Node {
    #brand;
    constructor(t, h, a) {
        if (t !== kCreate) throw typeError('Illegal constructor');
        super(t, h, a);
    }
    static {
        Document_is = (o) => o !== null && (typeof o === 'object' || typeof o === 'function') && #brand in o;
        Document_h = (o) => { if (!Document_is(o)) throw illegalInvocation(); return EventTarget_raw(o); };
        Document_arg = (o, label, position) => { if (!Document_is(o)) throw typeError(label + ': parameter ' + position + " is not of type 'Document'."); return EventTarget_raw(o); };
    }
    get documentElement() {
        const h = Document_h(this);
        const r = X.ganglion_Document_documentElement_get(h);
        if (r < 0) throwEngineError(-r);
        return r === 0 ? null : wrap(r);
    }
    get body() {
        const h = Document_h(this);
        const r = X.ganglion_Document_body_get(h);
        if (r < 0) throwEngineError(-r);
        return r === 0 ? null : wrap(r);
    }
    createElement(p0) {
        const h = Document_h(this);
        if (arguments.length < 1) throw argCountError("Failed to execute 'createElement' on 'Document'", 1, arguments.length);
        const a0 = toDOMString(p0);
        const base = inTop;
        const a0_n = a0.length;
        const a0_p = putString(a0);
        const raw = X.ganglion_Document_createElement(h, a0_p, a0_n);
        endCall(base);
        const r = raw;
        if (r < 0) throwEngineError(-r);
        return wrap(r);
    }
    createTextNode(p0) {
        const h = Document_h(this);
        if (arguments.length < 1) throw argCountError("Failed to execute 'createTextNode' on 'Document'", 1, arguments.length);
        const a0 = toDOMString(p0);
        const base = inTop;
        const a0_n = a0.length;
        const a0_p = putString(a0);
        const raw = X.ganglion_Document_createTextNode(h, a0_p, a0_n);
        endCall(base);
        const r = raw;
        if (r < 0) throwEngineError(-r);
        return wrap(r);
    }
    createRange() {
        const h = Document_h(this);
        const r = X.ganglion_Document_createRange(h);
        if (r < 0) throwEngineError(-r);
        return wrap(r);
    }
    getElementById(p0) {
        const h = Document_h(this);
        if (arguments.length < 1) throw argCountError("Failed to execute 'getElementById' on 'Document'", 1, arguments.length);
        const a0 = toDOMString(p0);
        const base = inTop;
        const a0_n = a0.length;
        const a0_p = putString(a0);
        const raw = X.ganglion_Document_getElementById(h, a0_p, a0_n);
        endCall(base);
        const r = raw;
        if (r < 0) throwEngineError(-r);
        return r === 0 ? null : wrap(r);
    }
}
finishInterface(Document, { __proto__: null, name: 'Document', members: ['documentElement', 'body', 'createElement', 'createTextNode', 'createRange', 'getElementById'], constants: { __proto__: null,  }, unscopables: [], length: 0 });

// --- Element -----------------------------------------------------------------------------------
class Element extends Node {
    #brand;
    constructor(t, h, a) {
        if (t !== kCreate) throw typeError('Illegal constructor');
        super(t, h, a);
    }
    static {
        Element_is = (o) => o !== null && (typeof o === 'object' || typeof o === 'function') && #brand in o;
        Element_h = (o) => { if (!Element_is(o)) throw illegalInvocation(); return EventTarget_raw(o); };
        Element_arg = (o, label, position) => { if (!Element_is(o)) throw typeError(label + ': parameter ' + position + " is not of type 'Element'."); return EventTarget_raw(o); };
    }
    get localName() {
        const h = Element_h(this);
        return atomString(X.ganglion_Element_localName_get(h));
    }
    get tagName() {
        const h = Element_h(this);
        return atomString(X.ganglion_Element_tagName_get(h));
    }
    get id() {
        const h = Element_h(this);
        const r = X.ganglion_Element_id_get(h);
        if (r < -1) throwEngineError(-1 - r);
        return r === -1 ? null : readOut(r);
    }
    set id(value) {
        const h = Element_h(this);
        const a0 = toDOMString(value);
        const base = inTop;
        const a0_n = a0.length;
        const a0_p = putString(a0);
        const raw = X.ganglion_Element_id_set(h, a0_p, a0_n);
        endCall(base);
        const r = raw;
        if (r !== 0) throwEngineError(r);
        return undefined;
    }
    get className() {
        const h = Element_h(this);
        const r = X.ganglion_Element_className_get(h);
        if (r < -1) throwEngineError(-1 - r);
        return r === -1 ? null : readOut(r);
    }
    set className(value) {
        const h = Element_h(this);
        const a0 = toDOMString(value);
        const base = inTop;
        const a0_n = a0.length;
        const a0_p = putString(a0);
        const raw = X.ganglion_Element_className_set(h, a0_p, a0_n);
        endCall(base);
        const r = raw;
        if (r !== 0) throwEngineError(r);
        return undefined;
    }
    getAttribute(p0) {
        const h = Element_h(this);
        if (arguments.length < 1) throw argCountError("Failed to execute 'getAttribute' on 'Element'", 1, arguments.length);
        const a0 = toDOMString(p0);
        const base = inTop;
        const a0_n = a0.length;
        const a0_p = putString(a0);
        const raw = X.ganglion_Element_getAttribute(h, a0_p, a0_n);
        endCall(base);
        const r = raw;
        if (r < -1) throwEngineError(-1 - r);
        return r === -1 ? null : readOut(r);
    }
    setAttribute(p0, p1) {
        const h = Element_h(this);
        if (arguments.length < 2) throw argCountError("Failed to execute 'setAttribute' on 'Element'", 2, arguments.length);
        const a0 = toDOMString(p0);
        const a1 = toDOMString(p1);
        const base = inTop;
        const a0_n = a0.length;
        const a0_p = putString(a0);
        const a1_n = a1.length;
        const a1_p = putString(a1);
        const raw = X.ganglion_Element_setAttribute(h, a0_p, a0_n, a1_p, a1_n);
        endCall(base);
        const r = raw;
        if (r !== 0) throwEngineError(r);
        return undefined;
    }
    removeAttribute(p0) {
        const h = Element_h(this);
        if (arguments.length < 1) throw argCountError("Failed to execute 'removeAttribute' on 'Element'", 1, arguments.length);
        const a0 = toDOMString(p0);
        const base = inTop;
        const a0_n = a0.length;
        const a0_p = putString(a0);
        const raw = X.ganglion_Element_removeAttribute(h, a0_p, a0_n);
        endCall(base);
        const r = raw;
        if (r !== 0) throwEngineError(r);
        return undefined;
    }
    hasAttribute(p0) {
        const h = Element_h(this);
        if (arguments.length < 1) throw argCountError("Failed to execute 'hasAttribute' on 'Element'", 1, arguments.length);
        const a0 = toDOMString(p0);
        const base = inTop;
        const a0_n = a0.length;
        const a0_p = putString(a0);
        const raw = X.ganglion_Element_hasAttribute(h, a0_p, a0_n);
        endCall(base);
        const r = raw;
        if (r < 0) throwEngineError(-r);
        return r === 1;
    }
    getBoundingClientRect() {
        const h = Element_h(this);
        const r = X.ganglion_Element_getBoundingClientRect(h);
        if (r !== 0) throwEngineError(r);
        return readRect();
    }
    remove() {
        const h = Element_h(this);
        const r = X.ganglion_Element_remove(h);
        if (r !== 0) throwEngineError(r);
        return undefined;
    }
}
finishInterface(Element, { __proto__: null, name: 'Element', members: ['localName', 'tagName', 'id', 'className', 'getAttribute', 'setAttribute', 'removeAttribute', 'hasAttribute', 'getBoundingClientRect', 'remove'], constants: { __proto__: null,  }, unscopables: ['remove'], length: 0 });

// --- Event -------------------------------------------------------------------------------------
class Event {
    #brand;
    #h;
    #a;
    constructor(t, h, a) {
        if (t !== kCreate) {
            if (new.target === undefined) throw typeError("Failed to construct 'Event': Please use the 'new' operator.");
            if (arguments.length < 1) throw argCountError("Failed to construct 'Event'", 1, arguments.length);
            const a0 = toDOMString(arguments[0]);
            const d1 = arguments[1];
            if (d1 !== undefined && d1 !== null && typeof d1 !== 'object' && typeof d1 !== 'function') throw typeError("Failed to construct 'Event'" + ': parameter 2 is not of type \'EventInit\'.');
            const d1_bubbles_raw = d1 == null ? undefined : d1.bubbles;
            const d1_bubbles = d1_bubbles_raw === undefined ? false : !!d1_bubbles_raw;
            const d1_cancelable_raw = d1 == null ? undefined : d1.cancelable;
            const d1_cancelable = d1_cancelable_raw === undefined ? false : !!d1_cancelable_raw;
            const d1_composed_raw = d1 == null ? undefined : d1.composed;
            const d1_composed = d1_composed_raw === undefined ? false : !!d1_composed_raw;
            const base = inTop;
            const a0_n = a0.length;
            const a0_p = putString(a0);
            const raw = X.ganglion_Event_construct(a0_p, a0_n, d1_bubbles ? 1 : 0, d1_cancelable ? 1 : 0, d1_composed ? 1 : 0);
            endCall(base);
            const r = raw;
            if (r < 0) throwEngineError(-r);
            h = r;
            a = adoptConstructed(this, h);
        }
        this.#h = h;
        this.#a = a;
        ObjectDefineProperty(this, 'isTrusted', unforgeable_Event_isTrusted);
    }
    static {
        Event_is = (o) => o !== null && (typeof o === 'object' || typeof o === 'function') && #brand in o;
        Event_raw = (o) => o.#h;
        rootAccess.Event = { __proto__: null, h: (o) => o.#h, a: (o) => o.#a, setA: (o, a) => { o.#a = a; } };
        Event_h = (o) => { if (!Event_is(o)) throw illegalInvocation(); return o.#h; };
        Event_anchor = (o) => o.#a;
        Event_arg = (o, label, position) => { if (!Event_is(o)) throw typeError(label + ': parameter ' + position + " is not of type 'Event'."); return Event_raw(o); };
    }
    get type() {
        const h = Event_h(this);
        return atomString(X.ganglion_Event_type_get(h));
    }
    get target() {
        const h = Event_h(this);
        const r = X.ganglion_Event_target_get(h);
        if (r < 0) throwEngineError(-r);
        return r === 0 ? null : wrap(r);
    }
    get currentTarget() {
        const h = Event_h(this);
        const r = X.ganglion_Event_currentTarget_get(h);
        if (r < 0) throwEngineError(-r);
        return r === 0 ? null : wrap(r);
    }
    get eventPhase() {
        const h = Event_h(this);
        return X.ganglion_Event_eventPhase_get(h) >>> 0;
    }
    get bubbles() {
        const h = Event_h(this);
        const r = X.ganglion_Event_bubbles_get(h);
        if (r < 0) throwEngineError(-r);
        return r === 1;
    }
    get cancelable() {
        const h = Event_h(this);
        const r = X.ganglion_Event_cancelable_get(h);
        if (r < 0) throwEngineError(-r);
        return r === 1;
    }
    get defaultPrevented() {
        const h = Event_h(this);
        const r = X.ganglion_Event_defaultPrevented_get(h);
        if (r < 0) throwEngineError(-r);
        return r === 1;
    }
    get timeStamp() {
        const h = Event_h(this);
        return X.ganglion_Event_timeStamp_get(h);
    }
    stopPropagation() {
        const h = Event_h(this);
        const r = X.ganglion_Event_stopPropagation(h);
        if (r !== 0) throwEngineError(r);
        return undefined;
    }
    stopImmediatePropagation() {
        const h = Event_h(this);
        const r = X.ganglion_Event_stopImmediatePropagation(h);
        if (r !== 0) throwEngineError(r);
        return undefined;
    }
    preventDefault() {
        const h = Event_h(this);
        const r = X.ganglion_Event_preventDefault(h);
        if (r !== 0) throwEngineError(r);
        return undefined;
    }
}
const unforgeable_Event_isTrusted = { __proto__: null, get: ObjectDefineProperty(function () {
    const h = Event_h(this);
    const r = X.ganglion_Event_isTrusted_get(h);
    if (r < 0) throwEngineError(-r);
    return r === 1;
}, 'name', { __proto__: null, value: 'get isTrusted' }), enumerable: true, configurable: false };
finishInterface(Event, { __proto__: null, name: 'Event', members: ['type', 'target', 'currentTarget', 'eventPhase', 'bubbles', 'cancelable', 'defaultPrevented', 'timeStamp', 'stopPropagation', 'stopImmediatePropagation', 'preventDefault'], constants: { __proto__: null, NONE: 0, CAPTURING_PHASE: 1, AT_TARGET: 2, BUBBLING_PHASE: 3 }, unscopables: [], length: 1 });

// --- HTMLElement -------------------------------------------------------------------------------
class HTMLElement extends Element {
    #brand;
    constructor(t, h, a) {
        if (t !== kCreate) throw typeError('Illegal constructor');
        super(t, h, a);
    }
    static {
        HTMLElement_is = (o) => o !== null && (typeof o === 'object' || typeof o === 'function') && #brand in o;
        HTMLElement_h = (o) => { if (!HTMLElement_is(o)) throw illegalInvocation(); return EventTarget_raw(o); };
        HTMLElement_arg = (o, label, position) => { if (!HTMLElement_is(o)) throw typeError(label + ': parameter ' + position + " is not of type 'HTMLElement'."); return EventTarget_raw(o); };
    }
    get style() {
        const h = HTMLElement_h(this);
        const r = X.ganglion_HTMLElement_style_get(h);
        if (r < 0) throwEngineError(-r);
        return wrap(r);
    }
    set style(value) {
        const target = ReflectApply(getter_HTMLElement_style, this, []);
        if (target === null || typeof target !== 'object') throw typeError('[PutForwards] target is not an object');
        ReflectSet(target, 'cssText', value);
    }
    get offsetTop() {
        const h = HTMLElement_h(this);
        return X.ganglion_HTMLElement_offsetTop_get(h);
    }
    get offsetLeft() {
        const h = HTMLElement_h(this);
        return X.ganglion_HTMLElement_offsetLeft_get(h);
    }
    get offsetWidth() {
        const h = HTMLElement_h(this);
        return X.ganglion_HTMLElement_offsetWidth_get(h);
    }
    get offsetHeight() {
        const h = HTMLElement_h(this);
        return X.ganglion_HTMLElement_offsetHeight_get(h);
    }
}
const getter_HTMLElement_style = ObjectGetOwnPropertyDescriptor(HTMLElement.prototype, 'style').get;
finishInterface(HTMLElement, { __proto__: null, name: 'HTMLElement', members: ['style', 'offsetTop', 'offsetLeft', 'offsetWidth', 'offsetHeight'], constants: { __proto__: null,  }, unscopables: [], length: 0 });

// --- KeyboardEvent -----------------------------------------------------------------------------
class KeyboardEvent extends Event {
    #brand;
    constructor(t, h, a) {
        if (t !== kCreate) throw typeError('Illegal constructor');
        super(t, h, a);
    }
    static {
        KeyboardEvent_is = (o) => o !== null && (typeof o === 'object' || typeof o === 'function') && #brand in o;
        KeyboardEvent_h = (o) => { if (!KeyboardEvent_is(o)) throw illegalInvocation(); return Event_raw(o); };
        KeyboardEvent_arg = (o, label, position) => { if (!KeyboardEvent_is(o)) throw typeError(label + ': parameter ' + position + " is not of type 'KeyboardEvent'."); return Event_raw(o); };
    }
    get key() {
        const h = KeyboardEvent_h(this);
        const r = X.ganglion_KeyboardEvent_key_get(h);
        if (r < -1) throwEngineError(-1 - r);
        return r === -1 ? null : readOut(r);
    }
}
finishInterface(KeyboardEvent, { __proto__: null, name: 'KeyboardEvent', members: ['key'], constants: { __proto__: null,  }, unscopables: [], length: 0 });

// --- MouseEvent --------------------------------------------------------------------------------
class MouseEvent extends Event {
    #brand;
    constructor(t, h, a) {
        if (t !== kCreate) throw typeError('Illegal constructor');
        super(t, h, a);
    }
    static {
        MouseEvent_is = (o) => o !== null && (typeof o === 'object' || typeof o === 'function') && #brand in o;
        MouseEvent_h = (o) => { if (!MouseEvent_is(o)) throw illegalInvocation(); return Event_raw(o); };
        MouseEvent_arg = (o, label, position) => { if (!MouseEvent_is(o)) throw typeError(label + ': parameter ' + position + " is not of type 'MouseEvent'."); return Event_raw(o); };
    }
    get clientX() {
        const h = MouseEvent_h(this);
        return X.ganglion_MouseEvent_clientX_get(h);
    }
    get clientY() {
        const h = MouseEvent_h(this);
        return X.ganglion_MouseEvent_clientY_get(h);
    }
    get button() {
        const h = MouseEvent_h(this);
        return X.ganglion_MouseEvent_button_get(h);
    }
    get buttons() {
        const h = MouseEvent_h(this);
        return X.ganglion_MouseEvent_buttons_get(h) >>> 0;
    }
}
finishInterface(MouseEvent, { __proto__: null, name: 'MouseEvent', members: ['clientX', 'clientY', 'button', 'buttons'], constants: { __proto__: null,  }, unscopables: [], length: 0 });

// --- Range -------------------------------------------------------------------------------------
class Range {
    #brand;
    #h;
    #a;
    constructor(t, h, a) {
        if (t !== kCreate) throw typeError('Illegal constructor');
        this.#h = h;
        this.#a = a;
    }
    static {
        Range_is = (o) => o !== null && (typeof o === 'object' || typeof o === 'function') && #brand in o;
        Range_raw = (o) => o.#h;
        rootAccess.Range = { __proto__: null, h: (o) => o.#h, a: (o) => o.#a, setA: (o, a) => { o.#a = a; } };
        Range_h = (o) => { if (!Range_is(o)) throw illegalInvocation(); return o.#h; };
        Range_anchor = (o) => o.#a;
        Range_arg = (o, label, position) => { if (!Range_is(o)) throw typeError(label + ': parameter ' + position + " is not of type 'Range'."); return Range_raw(o); };
    }
    get startContainer() {
        const h = Range_h(this);
        const r = X.ganglion_Range_startContainer_get(h);
        if (r < 0) throwEngineError(-r);
        return wrap(r);
    }
    get startOffset() {
        const h = Range_h(this);
        return X.ganglion_Range_startOffset_get(h) >>> 0;
    }
    setStart(p0, p1) {
        const h = Range_h(this);
        if (arguments.length < 2) throw argCountError("Failed to execute 'setStart' on 'Range'", 2, arguments.length);
        const a0 = Node_arg(p0, "Failed to execute 'setStart' on 'Range'", 1);
        const a1 = ToNumberInt(p1) >>> 0;
        const r = X.ganglion_Range_setStart(h, a0, a1);
        if (r !== 0) throwEngineError(r);
        return undefined;
    }
}
finishInterface(Range, { __proto__: null, name: 'Range', members: ['startContainer', 'startOffset', 'setStart'], constants: { __proto__: null,  }, unscopables: [], length: 0 });

// --- Text --------------------------------------------------------------------------------------
class Text extends CharacterData {
    #brand;
    constructor(t, h, a) {
        if (t !== kCreate) throw typeError('Illegal constructor');
        super(t, h, a);
    }
    static {
        Text_is = (o) => o !== null && (typeof o === 'object' || typeof o === 'function') && #brand in o;
        Text_h = (o) => { if (!Text_is(o)) throw illegalInvocation(); return EventTarget_raw(o); };
        Text_arg = (o, label, position) => { if (!Text_is(o)) throw typeError(label + ': parameter ' + position + " is not of type 'Text'."); return EventTarget_raw(o); };
    }
}
finishInterface(Text, { __proto__: null, name: 'Text', members: [], constants: { __proto__: null,  }, unscopables: [], length: 0 });

const interfaceClasses = [undefined, CSSStyleDeclaration, EventTarget, Node, CharacterData, Document, Element, Event, HTMLElement, KeyboardEvent, MouseEvent, Range, Text];
const interfaceRoots = [undefined, 'CSSStyleDeclaration', 'EventTarget', 'EventTarget', 'EventTarget', 'EventTarget', 'EventTarget', 'Event', 'EventTarget', 'Event', 'Event', 'Range', 'EventTarget'];
const exposedInterfaces = { __proto__: null, CSSStyleDeclaration, EventTarget, Node, CharacterData, Document, Element, Event, HTMLElement, KeyboardEvent, MouseEvent, Range, Text };

// ===== glue/custom/DOMRect.js =====
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// DOMRect: a plain value object, implemented entirely in the glue (no engine object, no handle).
// https://drafts.fxtf.org/geometry/#domrect (the toy keeps it read-only and skips DOMRectReadOnly)

let makeDOMRect;
class DOMRect {
    #x; #y; #w; #h;
    constructor(x = 0, y = 0, width = 0, height = 0) {
        this.#x = +x;
        this.#y = +y;
        this.#w = +width;
        this.#h = +height;
    }
    static {
        makeDOMRect = (x, y, w, h) => new DOMRect(x, y, w, h);
    }
    get x() { if (!(#x in this)) throw illegalInvocation(); return this.#x; }
    get y() { if (!(#x in this)) throw illegalInvocation(); return this.#y; }
    get width() { if (!(#x in this)) throw illegalInvocation(); return this.#w; }
    get height() { if (!(#x in this)) throw illegalInvocation(); return this.#h; }
    get top() { if (!(#x in this)) throw illegalInvocation(); return MathMin(this.#y, this.#y + this.#h); }
    get right() { if (!(#x in this)) throw illegalInvocation(); return MathMax(this.#x, this.#x + this.#w); }
    get bottom() { if (!(#x in this)) throw illegalInvocation(); return MathMax(this.#y, this.#y + this.#h); }
    get left() { if (!(#x in this)) throw illegalInvocation(); return MathMin(this.#x, this.#x + this.#w); }
    toJSON() {
        if (!(#x in this)) throw illegalInvocation();
        return { x: this.#x, y: this.#y, width: this.#w, height: this.#h, top: this.top, right: this.right, bottom: this.bottom, left: this.left };
    }
}
finishInterface(DOMRect, { __proto__: null, name: 'DOMRect', members: ['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left', 'toJSON'], constants: { __proto__: null }, unscopables: [], length: 0 });

// ===== glue/custom/EventTarget.js =====
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// EventTarget's [ImplementedInBindings] members: listener callbacks are engine -> JS edges, so
// they are stored on the component's anchor, never in the engine.
// https://dom.spec.whatwg.org/#dom-eventtarget-addeventlistener

function flattenListenerOptions(options, withOnceAndPassive) {
    // (AddEventListenerOptions or boolean): an object (or null/undefined) is the dictionary,
    // anything else is ToBoolean. Members are read in WebIDL order: inherited first, then sorted.
    let capture = false, once = false, passive = false;
    if (options === undefined || options === null || typeof options === 'object' || typeof options === 'function') {
        if (options !== undefined && options !== null) {
            capture = !!options.capture;
            if (withOnceAndPassive) {
                once = !!options.once;
                passive = !!options.passive;
            }
        }
    } else {
        capture = !!options;
    }
    return (capture ? 1 : 0) | (once ? 2 : 0) | (passive ? 4 : 0);
}

function checkCallback(callback, label) {
    if (callback === undefined || callback === null)
        return false;
    if (typeof callback !== 'object' && typeof callback !== 'function')
        throw typeError(label + ": parameter 2 is not of type 'EventListener'.");
    return true;
}

installCustom(EventTarget, {
    addEventListener(type, callback, options) {
        const h = EventTarget_h(this);
        const label = "Failed to execute 'addEventListener' on 'EventTarget'";
        if (arguments.length < 2)
            throw argCountError(label, 2, arguments.length);
        const t = toDOMString(type);
        const hasCallback = checkCallback(callback, label);
        const flags = flattenListenerOptions(options, true);
        if (!hasCallback)
            return undefined;
        const id = callbackIdOf(callback, true);
        const base = inTop;
        const p = putString(t);
        const edge = X.ganglion_EventTarget_addEventListener(h, p, t.length, id, flags & 1, (flags >> 1) & 1, (flags >> 2) & 1) >>> 0;
        endCall(base);
        if (edge !== 0)
            topAnchor(EventTarget_anchor(this)).edges[edge] = callback;
        return undefined;
    },
    removeEventListener(type, callback, options) {
        const h = EventTarget_h(this);
        const label = "Failed to execute 'removeEventListener' on 'EventTarget'";
        if (arguments.length < 2)
            throw argCountError(label, 2, arguments.length);
        const t = toDOMString(type);
        const hasCallback = checkCallback(callback, label);
        const flags = flattenListenerOptions(options, false);
        if (!hasCallback)
            return undefined;
        const id = callbackIdOf(callback, false);
        if (id === undefined)
            return undefined;
        const base = inTop;
        const p = putString(t);
        const edge = X.ganglion_EventTarget_removeEventListener(h, p, t.length, id, flags & 1) >>> 0;
        endCall(base);
        if (edge !== 0)
            delete topAnchor(EventTarget_anchor(this)).edges[edge];
        return undefined;
    },
}, { __proto__: null, addEventListener: 2, removeEventListener: 2 });

// ===== glue/90-boot.js =====
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Chitin segment glue: boot.
//
// boot(options) instantiates the engine, installs the interface objects and `document` on the
// page's global, and returns the *host* API: a private object for the segment's own host script
// (frames, input, collection). The host keeps it in a closure; page JS never receives it.

function readDisplayList() {
    const words = X.ganglion_paint(1);
    return { __proto__: null, words, ptr: u32[(ioBase + 8) >>> 2] };
}

// Replays the engine's display list (toy/engine/Style.cpp) onto a 2D context.
function makePainter(ctx) {
    const proto = ObjectGetPrototypeOf(ctx);
    const fillRect = uncurryThis(proto.fillRect);
    const strokeRect = uncurryThis(proto.strokeRect);
    const fillText = uncurryThis(proto.fillText);
    const setTransform = uncurryThis(proto.setTransform);
    const setFillStyle = uncurryThis(ObjectGetOwnPropertyDescriptor(proto, 'fillStyle').set);
    const setStrokeStyle = uncurryThis(ObjectGetOwnPropertyDescriptor(proto, 'strokeStyle').set);
    const setLineWidth = uncurryThis(ObjectGetOwnPropertyDescriptor(proto, 'lineWidth').set);
    const setFont = uncurryThis(ObjectGetOwnPropertyDescriptor(proto, 'font').set);
    const setTextBaseline = uncurryThis(ObjectGetOwnPropertyDescriptor(proto, 'textBaseline').set);
    const scratchBuffer = new HostArrayBuffer(4);
    const scratch = new Float32Array(scratchBuffer);
    const scratchBits = new Uint32Array(scratchBuffer);
    const bitsToFloat = (bits) => {
        scratchBits[0] = bits;
        return scratch[0];
    };
    const colorOf = (rgba) => `rgba(${rgba >>> 24},${(rgba >>> 16) & 255},${(rgba >>> 8) & 255},${(rgba & 255) / 255})`;
    return function paint(width, height, dpr, background) {
        X.ganglion_paint(1);
        const n = u32[(ioBase + 12) >>> 2];
        let p = u32[(ioBase + 8) >>> 2] >>> 2;
        const end = p + n;
        setTransform(ctx, dpr, 0, 0, dpr, 0, 0);
        setFillStyle(ctx, background);
        fillRect(ctx, 0, 0, width, height);
        setFont(ctx, '13px monospace');
        setTextBaseline(ctx, 'top');
        while (p < end) {
            const op = u32[p];
            if (op === 1) {
                setFillStyle(ctx, colorOf(u32[p + 5]));
                fillRect(ctx, bitsToFloat(u32[p + 1]), bitsToFloat(u32[p + 2]), bitsToFloat(u32[p + 3]), bitsToFloat(u32[p + 4]));
                p += 6;
            } else if (op === 3) {
                setStrokeStyle(ctx, colorOf(u32[p + 5]));
                const w = bitsToFloat(u32[p + 6]);
                setLineWidth(ctx, w);
                strokeRect(ctx, bitsToFloat(u32[p + 1]) + w / 2, bitsToFloat(u32[p + 2]) + w / 2, bitsToFloat(u32[p + 3]) - w, bitsToFloat(u32[p + 4]) - w);
                p += 7;
            } else if (op === 2) {
                const x = bitsToFloat(u32[p + 1]);
                const y = bitsToFloat(u32[p + 2]);
                setFillStyle(ctx, colorOf(u32[p + 3]));
                const count = u32[p + 4];
                let s = '';
                for (let i = 0; i < count; i++) {
                    const word = u32[p + 5 + (i >> 1)];
                    s += StringFromCharCode((i & 1) ? word >>> 16 : word & 0xffff);
                }
                // The toy lays text out at 8 px per character; draw each glyph in its cell.
                for (let i = 0; i < count; i++)
                    fillText(ctx, s[i], x + i * 8, y + 2);
                p += 5 + ((count + 1) >> 1);
            } else {
                break;
            }
        }
        return n;
    };
}

function installGlobals(target, documentWrapper) {
    const define = (name, value) => ObjectDefineProperty(target, name, { __proto__: null, value, writable: true, enumerable: false, configurable: true });
    for (const name of ObjectKeys(exposedInterfaces))
        define(name, exposedInterfaces[name]);
    define('DOMRect', DOMRect);
    ObjectDefineProperty(target, 'document', { __proto__: null, value: documentWrapper, writable: false, enumerable: true, configurable: false });
    if (target.window === undefined)
        define('window', target);
}

function boot(options) {
    if (X !== undefined)
        throw typeError('chitin: already booted');
    const module = options.module !== undefined ? options.module : new WebAssemblyModule(options.wasm);
    const env = {
        __proto__: null,
        emscripten_notify_memory_growth() {
            refreshViews();
        },
    };
    const wasi = {
        __proto__: null,
        proc_exit(code) {
            throw new HostError('chitin: engine exited with ' + code);
        },
        fd_write() {
            return 52; // ENOSYS: the toy never writes
        },
        fd_close() {
            return 52;
        },
        fd_seek() {
            return 52;
        },
    };
    const instance = new WebAssemblyInstance(module, { __proto__: null, chitin: imports, env, wasi_snapshot_preview1: wasi });
    X = WebAssemblyInstancePrototypeGetExports(instance);
    memory = X.memory;
    if (typeof X._initialize === 'function')
        X._initialize();
    refreshViews();
    const width = options.width !== undefined ? options.width : 800;
    const height = options.height !== undefined ? options.height : 600;
    const documentHandle = X.ganglion_init(width, height);
    ioBase = X.ganglion_io();
    refreshViews();
    inBase = u32[ioBase >>> 2] >>> 1;
    inCapacity = u32[(ioBase + 4) >>> 2];
    if (options.reportError !== undefined)
        reportErrorHook = options.reportError;
    const documentWrapper = wrap(documentHandle);
    const target = options.global !== undefined ? options.global : globalThis;
    installGlobals(target, documentWrapper);

    const keyBase = () => inTop;
    const host = {
        __proto__: null,
        document: documentWrapper,
        collect: () => X.ganglion_collect(),
        stat: (which) => X.ganglion_stat(which),
        stats: () => ({ __proto__: null, ...stats, liveObjects: X.ganglion_stat(0), liveNodes: X.ganglion_stat(1), pinnedComponents: X.ganglion_stat(2), layouts: X.ganglion_stat(3), liveRanges: X.ganglion_stat(5), liveEvents: X.ganglion_stat(6), pinnedAnchors: ObjectKeys(pinnedAnchors).length }),
        setCrossPinRule: (on) => X.ganglion_set_cross_pin_rule(on ? 1 : 0),
        setViewport: (w, h) => X.ganglion_set_viewport(w, h),
        needsPaint: () => X.ganglion_paint(0) !== 0,
        displayList: readDisplayList,
        makePainter,
        pointer: (kind, x, y, button, buttons) => X.ganglion_pointer(kind, x, y, button, buttons),
        key: (kind, key) => {
            const k = toDOMString(key);
            const base = keyBase();
            const p = putString(k);
            X.ganglion_key(kind, p, k.length);
            endCall(base);
        },
        // Classic scripts: one appended line so stacks name the real URL (docs/plan.md decision).
        evalClassic: (text, url) => indirectEval(text + '\n//# sourceURL=' + url),
        // Call-cost baselines for the benchmarks (no DOM work).
        raw: X,
        wrap,
        putString,
        endCall,
        readOut,
        top: () => inTop,
    };
    return ObjectFreeze(host);
}

Object.defineProperty(globalThis, '__chitinBoot', { value: boot, writable: false, enumerable: false, configurable: true });
})();
