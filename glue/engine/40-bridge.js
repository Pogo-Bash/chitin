// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin engine glue: the mirror (docs/phase2.md section 2). Page JavaScript runs on this realm's V8;
// the DOM lives in the engine. The mirror builds a V8 class for every interface from the prototype
// objects LibWeb's own generated bindings made inside the runtime, calls their native functions
// through one export (ganglion_js_invoke), converts values at the boundary, and hands the engine
// "foreign" cells for the page's own objects and functions. Runtime values are 64-bit NaN-boxed words
// in linear memory; the tags are Runtime.h's.
//
// Everything here runs with page code in the same realm: captured primordials only, null-prototype
// tables, no views of linear memory escape.

const HostPromise_ = globalThis.Promise;
const HostJSON = globalThis.JSON;
const HostProxy = globalThis.Proxy;
const HostWeakSet = globalThis.WeakSet;
const HostMap = globalThis.Map;
const HostRangeError = globalThis.RangeError;
const HostSyntaxError = globalThis.SyntaxError;
const HostReferenceError = globalThis.ReferenceError;
const HostEvalError = globalThis.EvalError;
const HostURIError = globalThis.URIError;
const HostAggregateError = globalThis.AggregateError;
const ReflectGet = HostReflect.get;
const ReflectHas = HostReflect.has;
const ReflectOwnKeys = HostReflect.ownKeys;
const ReflectDefineProperty = HostReflect.defineProperty;
const ReflectDeleteProperty = HostReflect.deleteProperty;
const ReflectGetPrototypeOf = HostReflect.getPrototypeOf;
const ObjectCreate = HostObject.create;
const ArrayIsArray = Array.isArray;
const ArrayPrototypePush = uncurryThis(Array.prototype.push);
const ArrayPrototypePop = uncurryThis(Array.prototype.pop);
const MapPrototypeGet = uncurryThis(HostMap.prototype.get);
const MapPrototypeSet = uncurryThis(HostMap.prototype.set);
const MapPrototypeDelete = uncurryThis(HostMap.prototype.delete);
const ArrayFromList = Array.from;
const MapPrototypeHas = uncurryThis(HostMap.prototype.has);
const HostSet = globalThis.Set;
const SetPrototypeAdd = uncurryThis(HostSet.prototype.add);
const SetPrototypeHas = uncurryThis(HostSet.prototype.has);
const MapPrototypeEntries = uncurryThis(HostMap.prototype.entries);
const SetPrototypeValues = uncurryThis(HostSet.prototype.values);
const WeakMapPrototypeDelete = uncurryThis(WeakMap.prototype.delete);
const WeakSetPrototypeAdd = uncurryThis(HostWeakSet.prototype.add);
const WeakSetPrototypeHas = uncurryThis(HostWeakSet.prototype.has);
const JSONParse = HostJSON.parse;
const JSONStringify = HostJSON.stringify;
const PromiseResolve_ = HostPromise_.resolve;
const FunctionPrototypeToString = HostFunction.prototype.toString;
const SymbolIterator = HostSymbol.iterator;
const SymbolFor = HostSymbol.for;
const StringPrototypeSlice = uncurryThis(HostString.prototype.slice);
const latin1Decoder = new TextDecoder('latin1');
const utf16Decoder = new TextDecoder('utf-16le');
const G = globalThis;

// --- Binary data: ArrayBuffers and typed arrays cross by value ---------------------------------------------------
// Captured before any page script runs. The runtime's buffers live in linear memory, which never leaves the glue,
// so a buffer is copied on each crossing (a page that hands the engine a view to write into sees no writes).
const BufferUint8Array = globalThis.Uint8Array;
const bufferViewProto = ObjectGetPrototypeOf(BufferUint8Array.prototype);   // %TypedArray%.prototype
const bufferGetter = (proto, name) => ObjectGetOwnPropertyDescriptor(proto, name).get;
const ArrayBufferIsView = HostArrayBuffer.isView;
const ArrayBufferByteLength = uncurryThis(bufferGetter(HostArrayBuffer.prototype, 'byteLength'));
const ArrayBufferDetachedGet = ObjectGetOwnPropertyDescriptor(HostArrayBuffer.prototype, 'detached') ? bufferGetter(HostArrayBuffer.prototype, 'detached') : null;
const ArrayBufferDetached = ArrayBufferDetachedGet ? uncurryThis(ArrayBufferDetachedGet) : null;
const ArrayBufferTransfer = typeof HostArrayBuffer.prototype.transfer === 'function' ? uncurryThis(HostArrayBuffer.prototype.transfer) : null;
const TypedArrayBuffer = uncurryThis(bufferGetter(bufferViewProto, 'buffer'));
const TypedArrayByteOffset = uncurryThis(bufferGetter(bufferViewProto, 'byteOffset'));
const TypedArrayByteLength = uncurryThis(bufferGetter(bufferViewProto, 'byteLength'));
const TypedArrayTag = uncurryThis(ObjectGetOwnPropertyDescriptor(bufferViewProto, HostSymbol.toStringTag).get);
const DataViewBuffer = uncurryThis(bufferGetter(globalThis.DataView.prototype, 'buffer'));
const DataViewByteOffset = uncurryThis(bufferGetter(globalThis.DataView.prototype, 'byteOffset'));
const DataViewByteLength = uncurryThis(bufferGetter(globalThis.DataView.prototype, 'byteLength'));
// Index = the runtime's typed array kind (Runtime.h); null where this V8 has no such class.
const BUFFER_NAMES = ['Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'BigUint64Array', 'Int8Array', 'Int16Array', 'Int32Array', 'BigInt64Array', 'Float16Array', 'Float32Array', 'Float64Array'];
const BUFFER_CTORS = [];
const BUFFER_KIND_BY_NAME = ObjectCreate(null);
for (let i = 0; i < BUFFER_NAMES.length; i++) {
    BUFFER_CTORS[i] = globalThis[BUFFER_NAMES[i]] || null;
    BUFFER_KIND_BY_NAME[BUFFER_NAMES[i]] = i;
}

// --- Tags (Runtime.h) ------------------------------------------------------------------------------------
// The high 32 bits of a tagged value, as JS sees them after >>> 0 (unsigned), and the 16-bit tags.
const HI_UNDEFINED = 0x7FFE0000, HI_NULL = 0x7FFF0000, HI_BOOLEAN = 0x7FF90000, HI_INT32 = 0x7FFA0000;
const HI_OBJECT = 0xFFF90000, HI_STRING = 0xFFFA0000, HI_SYMBOL = 0xFFFB0000;
const TAG_UNDEFINED = 0x7FFE, TAG_NULL = 0x7FFF, TAG_BOOLEAN = 0x7FF9, TAG_INT32 = 0x7FFA, TAG_OBJECT = 0xFFF9, TAG_STRING = 0xFFFA, TAG_SYMBOL = 0xFFFB;
const WELL_KNOWN = ['asyncDispose', 'asyncIterator', 'dispose', 'hasInstance', 'isConcatSpreadable', 'iterator', 'match', 'matchAll', 'replace', 'replaceAll', 'search', 'species', 'split', 'toPrimitive', 'toStringTag', 'unscopables'];
const PD_HAS_VALUE = 1, PD_HAS_GET = 2, PD_HAS_SET = 4, PD_HAS_WRITABLE = 8, PD_WRITABLE = 16, PD_HAS_ENUMERABLE = 32, PD_ENUMERABLE = 64, PD_HAS_CONFIGURABLE = 128, PD_CONFIGURABLE = 256, PD_PRESENT = 1024;

// --- Scratch memory: a bump allocator of 8-byte slots, saved and restored around every call ---------------
let scratchBase = 0, scratchTop = 0, scratchEnd = 0;
function scratchInit() {
    scratchBase = X.ganglion_alloc(1 << 16);
    scratchTop = scratchBase;
    scratchEnd = scratchBase + (1 << 16);
}
function slots(n) {
    const p = scratchTop;
    scratchTop += n * 8;
    if (scratchTop > scratchEnd)
        throw new HostError('ganglion: the glue ran out of scratch memory');
    return p;
}
function writeLoHi(p, lo, hi) {
    views();
    u32[p >>> 2] = lo;
    u32[(p >>> 2) + 1] = hi;
}
function writeUndefined(p) { writeLoHi(p, 0, HI_UNDEFINED); }
function writeObject(p, cell) { writeLoHi(p, cell, HI_OBJECT); }

// --- Strings -----------------------------------------------------------------------------------------------
function readRuntimeString(p) {
    const dataPtr = X.ganglion_v_string_data(p, scratchTop, scratchTop + 4);
    views();
    const length = u32[scratchTop >>> 2];
    const ascii = u32[(scratchTop >>> 2) + 1];
    if (length === 0)
        return '';
    if (ascii) {
        if (length < 64) {
            let s = '';
            for (let i = 0; i < length; i++)
                s += StringFromCharCode(u8[dataPtr + i]);
            return s;
        }
        const copy = new (globalThis.Uint8Array)(length);
        for (let i = 0; i < length; i++)
            copy[i] = u8[dataPtr + i];
        return TextDecoderPrototypeDecode(latin1Decoder, copy);
    }
    return utf16ToString(dataPtr, length);
}
// Writes a JS string as UTF-16 into fresh engine memory; returns the pointer (the caller frees).
function stringToEngine(s) {
    const n = s.length;
    const ptr = X.ganglion_alloc(n * 2 + 2);
    views();
    const base = ptr >>> 1;
    const u16 = new Uint16Array(viewBuffer);
    for (let i = 0; i < n; i++)
        u16[base + i] = StringPrototypeCharCodeAt(s, i);
    return ptr;
}
function writeString(p, s) {
    const ptr = stringToEngine(s);
    X.ganglion_v_string_from_utf16(ptr, s.length, p);
    X.ganglion_free(ptr);
}
function readText(ptr, length, ascii) {
    views();
    if (ascii) {
        const copy = new (globalThis.Uint8Array)(length);
        for (let i = 0; i < length; i++)
            copy[i] = u8[ptr + i];
        return TextDecoderPrototypeDecode(latin1Decoder, copy);
    }
    return utf16ToString(ptr, length);
}

// --- Keys ----------------------------------------------------------------------------------------------------
const internedKeys = new HostMap();       // string -> key bits (our interned fly strings, alive for good)
const wellKnownKeys = safeArray();         // index -> key bits
const wellKnownSymbols = safeArray();      // index -> V8 symbol
const symbolKeys = new HostMap();          // V8 symbol -> key bits (page symbols given to the engine)
const symbolsByCell = new HostMap();       // runtime symbol cell -> V8 symbol
function isArrayIndex(s) {
    const n = s.length;
    if (n === 0 || n > 10)
        return false;
    let v = 0;
    for (let i = 0; i < n; i++) {
        const c = StringPrototypeCharCodeAt(s, i);
        if (c < 48 || c > 57 || (i === 0 && c === 48 && n > 1))
            return false;
        v = v * 10 + (c - 48);
    }
    return v < 4294967295;
}
// LibJS keeps an index as a number key only up to MAX_NUMBER_KEY_INDEX, 2 ** 30 - 1 on wasm32 (the index shares a pointer-sized
// word with two flag bits); a larger index is a string key there. ganglion_key_index(i) for a larger i wrapped around to
// i mod 2 ** 30: childNodes[2 ** 30] read childNodes[0] (secfuzz B2).
const MAX_NUMBER_KEY_INDEX = 0x3fffffff;
function indexKey(i) {
    return i <= MAX_NUMBER_KEY_INDEX ? X.ganglion_key_index(i) : keyBits(HostString(i));
}
function keyBits(key) {
    if (typeof key === 'string') {
        if (isArrayIndex(key) && +key <= MAX_NUMBER_KEY_INDEX)
            return X.ganglion_key_index(+key);
        let bits = MapPrototypeGet(internedKeys, key);
        if (bits === undefined) {
            const ptr = stringToEngine(key);
            bits = X.ganglion_key_intern(ptr, key.length);
            X.ganglion_free(ptr);
            MapPrototypeSet(internedKeys, key, bits);
        }
        return bits;
    }
    if (typeof key === 'symbol') {
        let bits = MapPrototypeGet(symbolKeys, key);
        if (bits !== undefined)
            return bits;
        for (let i = 0; i < WELL_KNOWN.length; i++) {
            if (wellKnownSymbols[i] === key) {
                bits = wellKnownKeys[i];
                MapPrototypeSet(symbolKeys, key, bits);
                return bits;
            }
        }
        const mark = scratchTop;
        const p = slots(1);
        const desc = key.description === undefined ? '' : key.description;
        const ptr = stringToEngine(desc);
        X.ganglion_v_symbol_create(ptr, desc.length, p);
        X.ganglion_free(ptr);
        bits = X.ganglion_key_from_symbol(p);
        views();
        MapPrototypeSet(symbolsByCell, u32[p >>> 2], key);
        scratchTop = mark;
        MapPrototypeSet(symbolKeys, key, bits);
        return bits;
    }
    return keyBits(HostString(key));
}
function keyToJS(bits) {
    const kind = X.ganglion_key_kind(bits);
    if (kind === 3)
        return HostString(X.ganglion_key_number(bits));
    const mark = scratchTop;
    const p = slots(1);
    X.ganglion_key_value(bits, p);
    const v = toJS(p);
    scratchTop = mark;
    return v;
}

// --- Handles: the page's values the engine holds ---------------------------------------------------------------
const handles = safeArray();
const freeHandles = safeArray();
const handleOf = new WeakMap();           // object/function -> handle
const foreignCellByHandle = safeArray();  // handle -> cell address while the cell lives
function handleFor(value) {
    let h = WeakMapPrototypeGet(handleOf, value);
    if (h !== undefined)
        return h;
    h = freeHandles.length ? ArrayPrototypePop(freeHandles) : handles.length;
    handles[h] = value;
    WeakMapPrototypeSet(handleOf, value, h);
    return h;
}

// --- Wrappers: the engine's objects as page values ----------------------------------------------------------------
const cellOf = new WeakMap();             // wrapper (or its proxy) -> cell address
const wrapperByCell = new HostMap();      // cell address -> wrapper (strong until the GC milestone)
const classByProto = new HostMap();       // prototype cell -> class
const functionByCell = new HostMap();     // native function cell -> page-visible function
const nativeFunctions = new HostWeakSet();// every function the mirror made (for Function.prototype.toString)
const engineErrors = new HostWeakSet();   // errors errorToJS made from the engine's: the ones a binding rewrites into Chrome's (45-surface.js)
const classByName = new HostMap();        // interface name -> class
let globalCell = 0;
let objectPrototypeCell = 0;
let documentsReset = 0;
let scriptsRun = 0;
let scriptingOn = false;

// The runtime object `cell` now has a page value: remember it and keep the cell alive (its address is
// the key; a collected cell's address would be reused).
function cacheWrapper(cell, value) {
    const mark = scratchTop;
    const p = slots(1);
    writeObject(p, cell);
    X.ganglion_v_root(p);
    scratchTop = mark;
    MapPrototypeSet(wrapperByCell, cell, value);
}

// --- Value conversion ----------------------------------------------------------------------------------------------
function toJS(p) {
    views();
    const lo = u32[p >>> 2];
    const hi = u32[(p >>> 2) + 1];
    const tag = hi >>> 16;
    if ((tag & 0x7FF8) === 0x7FF8 && (tag & 7) !== 0) {
        switch (tag) {
        case TAG_UNDEFINED: return undefined;
        case TAG_NULL: return null;
        case TAG_BOOLEAN: return lo !== 0;
        case TAG_INT32: return lo | 0;
        case TAG_STRING: return readRuntimeString(p);
        case TAG_SYMBOL: return symbolToJS(p, lo);
        case TAG_OBJECT: return objectToJS(p, lo);
        default: return undefined; // accessor, empty: nothing a page should see
        }
    }
    return f64[p >>> 3];
}

function symbolToJS(p, cell) {
    const known = MapPrototypeGet(symbolsByCell, cell);
    if (known !== undefined)
        return known;
    const which = X.ganglion_v_symbol_well_known(p);
    if (which >= 0)
        return wellKnownSymbols[which];
    const mark = scratchTop;
    const d = slots(1);
    X.ganglion_v_symbol_description(p, d);
    const description = toJS(d);
    scratchTop = mark;
    const sym = HostSymbol(description);
    MapPrototypeSet(symbolsByCell, cell, sym);
    return sym;
}

// The cell of the principal window's WindowProxy: what `window` is on the global.
let principalWindowProxy = 0;
function principalWindowProxyCell() {
    if (principalWindowProxy !== 0)
        return principalWindowProxy;
    const mark = scratchTop;
    const o = slots(1), r = slots(1);
    writeObject(o, globalCell);
    const threw = X.ganglion_v_get(o, keyBits('window'), r);
    views();
    if (!threw && (u32[(r >>> 2) + 1] >>> 16) === TAG_OBJECT)
        principalWindowProxy = u32[r >>> 2];
    scratchTop = mark;
    return principalWindowProxy;
}

// The WindowProxy of a frame's window (iframe.contentWindow, a child's `parent`...): the engine's WindowProxy applies the
// same-origin and cross-origin rules itself, so the page's object forwards every operation to it. The frame's realm has
// no V8 context of its own (its scripts do not run, Bridge.cpp), so there is no global to hand out.
function frameWindow(cell, holder) {
    const target = ObjectCreate(null);
    // The engine's WindowProxy asks for the current window, so each operation runs with a script context under it, as
    // the page's calls into the engine do (idleEntry): the context of the realm that holds this stand-in (`holder`, its
    // global's cell), the realm whose code uses it. A cross-origin method read here is made in that realm (HTML
    // CrossOriginGetOwnPropertyHelper: "created in the current Realm Record"), so calling it later enters that realm too,
    // and the incumbent settings object of a frame's `parent.postMessage(...)` is the frame's (the event's source).
    const get = (key) => {
        const entered = idleEntry(holder);
        try {
            return vGet(cell, key);
        } finally {
            idleExit(entered);
        }
    };
    // Every operation that reaches the engine's WindowProxy (its [[GetPrototypeOf]] checks the origin against the
    // current settings object, which needs a context: `x instanceof Window` after an `await`).
    const inRealm = (f) => {
        const entered = idleEntry(holder);
        try {
            return f();
        } finally {
            idleExit(entered);
        }
    };
    const handler = {
        __proto__: null,
        get(t, key) { return get(key); },
        set(t, key, value) {
            const entered = idleEntry(holder);
            try {
                vSetEntered(cell, key, value);
            } finally {
                idleExit(entered);
            }
            return true;
        },
        has(t, key) { return get(key) !== undefined || inRealm(() => vOwnProperty(cell, keyBits(key))) !== null; },
        ownKeys() {
            const keys = inRealm(() => vOwnKeys(cell));
            const out = [];
            for (let i = 0; i < keys.length; i++)
                ArrayPrototypePush(out, keyToJS(keys[i]));
            return out;
        },
        getOwnPropertyDescriptor(t, key) {
            const prop = inRealm(() => vOwnProperty(cell, keyBits(key)));
            if (prop === null)
                return undefined;
            return { value: get(key), writable: true, enumerable: (prop.flags & PD_ENUMERABLE) !== 0, configurable: true };
        },
        getPrototypeOf() {
            const protoCell = inRealm(() => vPrototypeCell(cell));
            const cls = protoCell === 0 ? null : classForPrototype(protoCell);
            return cls === null ? null : cls.prototype;
        },
        defineProperty(t, key, descriptor) {
            if ('value' in descriptor)
                handler.set(t, key, descriptor.value);
            return true;
        },
        deleteProperty() { return false; },
        setPrototypeOf() { return false; },
        preventExtensions() { return false; },
    };
    const proxy = new HostProxy(target, handler);
    WeakMapPrototypeSet(cellOf, proxy, cell);
    // Kept apart from the wrapper cache: the same WindowProxy is its realm's own window to a script of its origin (the
    // frame's code reading `window`), and this stand-in only to a script of another origin (windowProxyToJS).
    rootAccessorCell(cell);
    let byHolder = MapPrototypeGet(standInByCell, cell);
    if (byHolder === undefined) {
        byHolder = new HostMap();
        MapPrototypeSet(standInByCell, cell, byHolder);
    }
    MapPrototypeSet(byHolder, holder, proxy);
    return proxy;
}
// The principal window as the realm asking sees it: itself to its own code and to a same-origin frame's, the
// engine-checked stand-in to a cross-origin frame's code (a cross-origin same-site frame's `parent`, `top`, an event's
// source): HTML's WindowProxy checks are relative to the accessing realm, and the stand-in's methods act in that realm.
function principalWindowFor(cell) {
    const asking = currentGlobalCell();
    if (asking === 0 || asking === globalCell)
        return G;
    let own, principal;
    try {
        own = vGet(asking, 'origin');
        principal = vGet(globalCell, 'origin');
    } catch {
        return G;
    }
    if (own === principal)
        return G;
    const wp = principalWindowProxyCell();
    const byHolder = MapPrototypeGet(standInByCell, wp);
    const standIn = byHolder !== undefined ? MapPrototypeGet(byHolder, asking) : undefined;
    return standIn !== undefined ? standIn : frameWindow(wp, asking);
}
const standInByCell = new HostMap(); // a frame's WindowProxy cell -> (the holding realm's global cell -> its cross-origin stand-in)
const rootedAccessorCells = new HostSet();
function rootAccessorCell(cell) {
    if (SetPrototypeHas(rootedAccessorCells, cell))
        return;
    SetPrototypeAdd(rootedAccessorCells, cell);
    rootCell(cell);
}
function rootCell(cell) {
    const mark = scratchTop;
    const p = slots(1);
    writeObject(p, cell);
    X.ganglion_v_root(p);
    scratchTop = mark;
}

function cacheWrapperValue(cell, value) {
    return value; // a Date is a value: not cached, a page that changes its copy does not change the engine's
}

function objectToJS(p, cell) {
    if (cell === globalCell)
        return frameRealmsOn ? principalWindowFor(cell) : G;
    const cached = MapPrototypeGet(wrapperByCell, cell);
    if (cached === G && frameRealmsOn)
        return principalWindowFor(cell);
    if (cached !== undefined)
        return cached;
    if (frameRealmsOn) {
        // A frame's Window itself (its global object): the page sees its WindowProxy (55-realms.js).
        const record = MapPrototypeGet(realmByWindowCell, cell);
        if (record !== undefined)
            return record.proxy;
    }
    const kind = X.ganglion_v_object_kind(p);
    switch (kind) {
    case 1:
    case 8:
        // The window's WindowProxy is the global as the page sees it (one window per segment). The WindowProxy of
        // a frame's window is another object, mirrored like any other: its document, location and the rest are
        // the frame's, not the page's.
        if (vClassName(cell) === 'WindowProxy') {
            if (cell === principalWindowProxyCell()) {
                cacheWrapper(cell, G);
                return G;
            }
            // A same-origin frame's window is its realm's (55-realms.js); any other, the engine-checked stand-in.
            const realmWindow = windowProxyToJS(cell);
            if (realmWindow !== null)
                return realmWindow;
            // One stand-in per realm that holds it (HTML: a cross-origin WindowProxy's properties are per current realm).
            const holder = frameRealmsOn ? currentGlobalCell() || globalCell : globalCell;
            const byHolder = MapPrototypeGet(standInByCell, cell);
            const standIn = byHolder !== undefined ? MapPrototypeGet(byHolder, holder) : undefined;
            return standIn !== undefined ? standIn : frameWindow(cell, holder);
        }
        if (kind === 1)
            return wrap(p, cell);
        // A host object that wraps nothing but has an interface's prototype (the iterator of URLSearchParams.keys()) is
        // that interface's object, not a snapshot of its own properties: its methods are on the prototype.
        if (classForPrototype(vPrototypeCell(cell)) !== null)
            return wrap(p, cell);
        return otherToJS(p, cell, 0);
    case 2: case 3: return handles[X.ganglion_v_foreign_handle(p)];
    case 4: return functionToJS(p, cell);
    case 5: return arrayToJS(p);
    case 10: return bufferToJS(p);
    case 11: return cacheWrapperValue(cell, new HostDate(X.ganglion_v_date_value(p)));
    case 12: case 13: return collectionToJS(p, cell, kind === 12);
    case 6: return promiseToJS(p, cell);
    case 7: return errorToJS(p);
    default: return otherToJS(p, cell, 0);
    }
}

// The constructor CreateDynamicFunction uses for a function kind (JS_FUNCTION_KIND_*).
const HostGeneratorFunction = ReflectGetPrototypeOf(function* () {}).constructor;
const HostAsyncFunction = ReflectGetPrototypeOf(async function () {}).constructor;
const HostAsyncGeneratorFunction = ReflectGetPrototypeOf(async function* () {}).constructor;
function dynamicFunctionConstructor(kind) {
    return kind === 1 ? HostGeneratorFunction : kind === 2 ? HostAsyncFunction : kind === 3 ? HostAsyncGeneratorFunction : HostFunction;
}

// The runtime's ArrayBuffer or typed array as a V8 one holding a copy of the bytes.
function bufferToJS(p) {
    const mark = scratchTop;
    const info = slots(1);
    const kind = X.ganglion_v_buffer_info(p, info);
    views();
    const ptr = u32[info >>> 2];
    const length = u32[(info >>> 2) + 1];
    scratchTop = mark;
    const bytes = new BufferUint8Array(length);
    if (length > 0)
        Uint8ArrayPrototypeSet(bytes, TypedArrayPrototypeSubarray(u8, ptr, ptr + length));
    if (kind === 13)
        return TypedArrayBuffer(bytes);
    const Ctor = BUFFER_CTORS[kind - 1];
    return Ctor === null ? bytes : new Ctor(TypedArrayBuffer(bytes));
}

// The bytes of a page ArrayBuffer, typed array or DataView as [kind, Uint8Array] (kind as ganglion_v_buffer_create
// takes it), or null when the value is none of those.
function pageBytes(value) {
    if (ArrayBufferIsView(value)) {
        const tag = TypedArrayTag(value);
        if (tag === undefined)
            return [1, new BufferUint8Array(DataViewBuffer(value), DataViewByteOffset(value), DataViewByteLength(value))];
        const k = BUFFER_KIND_BY_NAME[tag];
        if (k === undefined)
            return null;
        return [k + 1, new BufferUint8Array(TypedArrayBuffer(value), TypedArrayByteOffset(value), TypedArrayByteLength(value))];
    }
    let length;
    try {
        length = ArrayBufferByteLength(value);
    } catch {
        return null;
    }
    return [13, new BufferUint8Array(value, 0, length)];
}

// Buffers the page passes into an engine call are copies, but the engine's functions may fill them in place
// (crypto.getRandomValues, TextEncoder.encodeInto, stream readers) and return the same object. While a call is
// being made `bufferPins` lists the copies; afterwards their bytes are written back to the page's buffers and a
// result that is one of the copies is the page's own object again.
let bufferPins = null;
function finishPins(pins, resultSlot) {
    let identical;
    for (let i = 0; i < pins.length; i++) {
        const pin = pins[i];
        const mark = scratchTop;
        const info = slots(1);
        X.ganglion_v_buffer_info(pin.slot, info);
        views();
        const ptr = u32[info >>> 2];
        const length = u32[(info >>> 2) + 1];
        scratchTop = mark;
        if (length === pin.bytes.length && length > 0)
            Uint8ArrayPrototypeSet(pin.bytes, TypedArrayPrototypeSubarray(u8, ptr, ptr + length));
        views();
        if (u32[pin.slot >>> 2] === u32[resultSlot >>> 2] && (u32[(pin.slot >>> 2) + 1] >>> 0) === HI_OBJECT && (u32[(resultSlot >>> 2) + 1] >>> 0) === HI_OBJECT)
            identical = pin.page;
    }
    return identical;
}

function writeBuffer(p, kind, bytes) {
    const length = bytes.length;
    // A buffer the engine's memory cannot hold is a RangeError (as V8's for an allocation it cannot make), not a trap.
    const ptr = X.ganglion_alloc(length + 1);
    if (!ptr)
        throw new HostRangeError('Array buffer allocation failed');
    views();
    if (length > 0)
        Uint8ArrayPrototypeSet(TypedArrayPrototypeSubarray(u8, ptr, ptr + length), bytes);
    const made = X.ganglion_v_buffer_create(kind, ptr, length, p);
    X.ganglion_free(ptr);
    if (!made)
        throw new HostRangeError('Array buffer allocation failed');
}

// ImageData's pixels are the page's own array, as in Chrome: `imageData.data` is the same object on every read (the array the
// page constructed it with, or the first copy read out of the engine), and a page that writes into it is seen by the engine:
// the bytes are copied into the engine's buffer whenever the ImageData crosses into an engine call (putImageData,
// createImageBitmap, ...). Before, every read was a fresh copy, so `d.data[i] = v` never reached putImageData.
const imageDataPixels = new WeakMap(); // ImageData wrapper -> the page's typed array
function syncImageData(cell, pixels) {
    const mark = scratchTop;
    const r = slots(1), info = slots(1);
    try {
        if (rawGetInto(cell, keyBits('data'), r))
            return;
        views();
        if ((u32[(r >>> 2) + 1] >>> 0) !== HI_OBJECT)
            return;
        X.ganglion_v_buffer_info(r, info);
        views();
        const ptr = u32[info >>> 2];
        const length = u32[(info >>> 2) + 1];
        const page = new BufferUint8Array(TypedArrayBuffer(pixels), TypedArrayByteOffset(pixels), TypedArrayByteLength(pixels));
        if (length === page.length && length > 0)
            Uint8ArrayPrototypeSet(TypedArrayPrototypeSubarray(u8, ptr, ptr + length), page);
    } finally {
        scratchTop = mark;
    }
}

// A runtime object with no class of its own: an interface prototype (its mirror class's prototype),
// the language's own prototypes, or a plain object copied to a depth of two.
function otherToJS(p, cell, depth) {
    if (cell === objectPrototypeCell)
        return HostObject.prototype;
    const name = prototypeNameRaw(cell);
    if (name !== '') {
        const cls = classForPrototype(cell);
        if (cls !== null)
            return cls.prototype;
        const intrinsic = INTRINSIC_PARENTS[name];
        if (intrinsic !== undefined)
            return intrinsic.prototype;
    }
    return plainToJS(cell, depth);
}

// --- Values copied across whole: structured clone ----------------------------------------------------------------
// history.pushState(state), postMessage(message) and structuredClone(value) serialize the page's value in the engine, which walks the
// value as an engine object: a page's Array, Date or Map (foreign cells to it) came out as a bare `{}`. Those calls get a copy
// built in the engine instead: plain objects, arrays (holes kept), Dates and binary data, with cycles; anything else
// that is not cloneable in a browser either (functions, symbols, DOM nodes) throws DataCloneError, and Map, Set, RegExp, Error
// and boxed primitives, which are cloneable but not copied yet, throw it too rather than turn into `{}`.
const engineClones = new HostWeakSet();
const HostStructuredClone = globalThis.structuredClone;
const CLONED_FIRST_ARGUMENT = { __proto__: null, pushState: true, replaceState: true, postMessage: true, structuredClone: true };
// IndexedDB keys and values are converted in the engine too (convert a value to a key looks for an Array or a Date, and a stored
// value is structured-serialized): a page's [1, 2] or new Date() came out as a bare object, so indexedDB.cmp([1], [1]) and
// store.get(new Date()) threw "DataError: Value is invalid" (YouTube's unhandled rejection). The key and value arguments of
// these members are copied the same way; an engine object passed there (an IDBKeyRange as the query) goes as it is.
const IDB_QUERY = [0];
const CLONED_ARGUMENTS = { __proto__: null,
    'IDBFactory.cmp': [0, 1],
    'IDBKeyRange.only': [0], 'IDBKeyRange.lowerBound': [0], 'IDBKeyRange.upperBound': [0], 'IDBKeyRange.bound': [0, 1], 'IDBKeyRange.includes': [0],
    'IDBObjectStore.put': [0, 1], 'IDBObjectStore.add': [0, 1],
    'IDBObjectStore.get': IDB_QUERY, 'IDBObjectStore.getKey': IDB_QUERY, 'IDBObjectStore.getAll': IDB_QUERY, 'IDBObjectStore.getAllKeys': IDB_QUERY,
    'IDBObjectStore.delete': IDB_QUERY, 'IDBObjectStore.count': IDB_QUERY, 'IDBObjectStore.openCursor': IDB_QUERY, 'IDBObjectStore.openKeyCursor': IDB_QUERY,
    'IDBIndex.get': IDB_QUERY, 'IDBIndex.getKey': IDB_QUERY, 'IDBIndex.getAll': IDB_QUERY, 'IDBIndex.getAllKeys': IDB_QUERY,
    'IDBIndex.count': IDB_QUERY, 'IDBIndex.openCursor': IDB_QUERY, 'IDBIndex.openKeyCursor': IDB_QUERY,
    'IDBCursor.update': [0], 'IDBCursor.continue': [0], 'IDBCursor.continuePrimaryKey': [0, 1],
};
// args: the call's arguments when value is args[0] of a cloning member (its transfer list may move streams), else null.
function cloneForEngine(value, lenientCollections, args) {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null)
        return value; // primitives go as they are
    const marker = { value, lenientCollections: lenientCollections === true, moves: args ? takeStreams(args) : null };
    WeakSetPrototypeAdd(engineClones, marker);
    return marker;
}
// Streams in the call's transfer list (postMessage(message, transfer | { transfer }), structuredClone(value, { transfer }); a
// Window's postMessage has the target origin before it). The engine cannot transfer a stream (its MessagePort transfer steps
// are missing), so each becomes a new stream of the page whose source is the old one (harness/segment/streams.js), and leaves
// the list the engine is given. The map goes to buildClone, which puts the new stream where the old one is in the message.
function takeStreams(args) {
    const bridge = callbacks.streams;
    if (!bridge || !bridge.bound)
        return null;
    let moves = null;
    for (let i = 1; i < args.length && i <= 2; i++) {
        const a = args[i];
        if (a === null || typeof a !== 'object')
            continue;
        const direct = ArrayIsArray(a);
        let list;
        try {
            list = direct ? a : a.transfer;
            if (list === undefined || list === null || typeof list !== 'object')
                continue;
            list = ArrayFromList(list);
        } catch {
            continue; // not a sequence: the engine reports it
        }
        let any = false;
        for (let k = 0; k < list.length; k++)
            if (bridge.isStream(list[k]))
                any = true;
        if (!any)
            continue;
        if (moves === null)
            moves = new HostMap();
        const kept = [];
        for (let k = 0; k < list.length; k++) {
            if (!bridge.isStream(list[k]))
                ArrayPrototypePush(kept, list[k]);
            else if (!MapPrototypeHas(moves, list[k]))
                MapPrototypeSet(moves, list[k], bridge.mirror(list[k], 'page'));
        }
        if (direct) {
            args[i] = kept;
        } else {
            const options = ObjectCreate(null);
            const keys = ObjectKeys(a);
            for (let k = 0; k < keys.length; k++)
                options[keys[k]] = a[keys[k]];
            options.transfer = kept;
            args[i] = options;
        }
    }
    return moves;
}
// ArrayBuffers in the call's transfer list (the same places takeStreams looks). The engine is given a copy of each (page
// buffers are the host's), so the page's own buffer is detached here once the call has succeeded, as a transfer does in
// Chrome; one already detached, or listed twice, is the DataCloneError Chrome throws before anything is sent.
function transferredBuffers(args) {
    let out = null;
    for (let i = 1; i < args.length && i <= 2; i++) {
        const a = args[i];
        if (a === null || typeof a !== 'object')
            continue;
        let list;
        try {
            list = ArrayIsArray(a) ? a : a.transfer;
            if (list === undefined || list === null || typeof list !== 'object')
                continue;
            list = ArrayFromList(list);
        } catch {
            continue;
        }
        for (let k = 0; k < list.length; k++) {
            const b = list[k];
            if (typeof b !== 'object' || b === null || !isArrayBuffer(b))
                continue;
            if (out === null)
                out = [];
            for (let j = 0; j < out.length; j++)
                if (out[j] === b)
                    throw new G.DOMException('ArrayBuffer at index ' + k + ' is a duplicate of an earlier ArrayBuffer. Duplicate transferable objects are not allowed.', 'DataCloneError');
            if (ArrayBufferDetached !== null && ArrayBufferDetached(b))
                throw new G.DOMException('An ArrayBuffer is detached and could not be cloned.', 'DataCloneError');
            ArrayPrototypePush(out, b);
        }
    }
    return out;
}
// An options object's `transfer` is read once, as Chrome's bindings convert the dictionary once: transferredBuffers, takeStreams
// and the engine each read it, so a getter could hand each a different list (secfuzz B3: the buffers checked and detached were
// not the ones the engine was given).
function snapshotTransfer(args) {
    for (let i = 1; i < args.length && i <= 2; i++) {
        const a = args[i];
        if (a === null || typeof a !== 'object' || ArrayIsArray(a))
            continue;
        const transfer = a.transfer;
        const options = ObjectCreate(null);
        const keys = ObjectKeys(a);
        for (let k = 0; k < keys.length; k++)
            if (keys[k] !== 'transfer')
                options[keys[k]] = a[keys[k]];
        if (transfer !== undefined)
            options.transfer = transfer !== null && typeof transfer === 'object' ? ArrayFromList(transfer) : transfer;
        args[i] = options;
    }
}
function detachBuffers(list) {
    if (list === null || ArrayBufferTransfer === null)
        return;
    for (let i = 0; i < list.length; i++) {
        try {
            ArrayBufferTransfer(list[i]);
        } catch {}
    }
}
let activeMoves = null; // the stream moves of the clone being built
const STREAM_KEY = '\u0000chitin-stream:' + HostString(Math.random()).slice(2) + HostString(Math.random()).slice(2);
const inflightStreams = new HostMap(); // marker id -> the page stream a message in flight carries
let nextStreamId = 1;
// A value read back from the engine (a message's data, structuredClone's result) with its stream markers replaced by the streams.
function decodeStreams(value) {
    if (inflightStreams.size === 0 || (typeof value !== 'object' && typeof value !== 'function') || value === null || !callbacks.streams)
        return value;
    const isMarker = (x) => {
        try {
            return typeof x === 'object' && x !== null && ObjectHasOwn(x, STREAM_KEY) && typeof x[STREAM_KEY] === 'number';
        } catch {
            return false;
        }
    };
    if (!callbacks.streams.containsStream(value, isMarker))
        return value;
    const taken = [];
    const out = callbacks.streams.substitute(value, isMarker, (m) => {
        const id = m[STREAM_KEY];
        ArrayPrototypePush(taken, id);
        return MapPrototypeGet(inflightStreams, id);
    });
    for (let i = 0; i < taken.length; i++)
        MapPrototypeDelete(inflightStreams, taken[i]);
    return out;
}
// --- Types the engine's runtime does not have, carried as markers -------------------------------------------------
// The engine's JS runtime (engine/libjs-runtime) has no RegExp, BigInt, boxed primitives or DataView, and no typed array
// on part of a buffer, so a clone of those cannot be the engine's own object. Each goes through the engine's serializer as
// a plain object marked with CLONE_KEY (its fields engine values: strings, numbers, the ArrayBuffer a view is on) and
// readClone, which reads every structured clone result back, turns the marker into the type again. Errors go the same way
// (name, message and stack, as V8 clones them). The key is fixed, so a marker stored in IndexedDB reads back later too.
const CLONE_KEY = '\u0000chitin-clone';
const CloneRegExp = globalThis.RegExp;
const RegExpSource = uncurryThis(ObjectGetOwnPropertyDescriptor(CloneRegExp.prototype, 'source').get);
const RegExpFlags = uncurryThis(ObjectGetOwnPropertyDescriptor(CloneRegExp.prototype, 'flags').get);
const HostBoolean = globalThis.Boolean;
const BooleanValueOf = uncurryThis(HostBoolean.prototype.valueOf);
const NumberValueOf = uncurryThis(HostNumber.prototype.valueOf);
const StringValueOf = uncurryThis(HostString.prototype.valueOf);
const BigIntValueOf = uncurryThis(HostBigInt.prototype.valueOf);
const BigIntToString = uncurryThis(HostBigInt.prototype.toString);
const HostDataView = globalThis.DataView;
// The standard error names a clone keeps (HTML's serialization; anything else is "Error").
const CLONE_ERROR_NAMES = { __proto__: null, Error: HostError, EvalError: HostEvalError, RangeError: HostRangeError, ReferenceError: HostReferenceError, SyntaxError: HostSyntaxError, TypeError: HostTypeError, URIError: HostURIError };
// A marker object in `p`: { [CLONE_KEY]: kind, ...fields }, each field [name, page value] (cloned in turn, so a view's
// buffer is shared through `seen`).
function writeMarker(p, kind, fields, seen, depth) {
    const mark = scratchTop;
    const e = slots(1);
    X.ganglion_v_object_create(p);
    writeString(e, kind);
    X.ganglion_v_define_data(p, keyBits(CLONE_KEY), e);
    for (let i = 0; i < fields.length; i++) {
        buildClone(fields[i][1], e, seen, depth + 1);
        X.ganglion_v_define_data(p, keyBits(fields[i][0]), e);
    }
    scratchTop = mark;
}
// The primitive a boxed Boolean, Number, String or BigInt holds, as [primitive], or null.
function boxedValue(v) {
    try { return [BooleanValueOf(v)]; } catch {}
    try { return [NumberValueOf(v)]; } catch {}
    try { return [StringValueOf(v)]; } catch {}
    try { return [BigIntValueOf(v)]; } catch {}
    return null;
}
function isArrayBuffer(v) {
    try {
        ArrayBufferByteLength(v);
        return true;
    } catch {
        return false;
    }
}

// Engine interfaces with [Serializable] (LibWeb's IDL) or a transfer the engine does itself (MessagePort), by their toStringTag.
const ENGINE_SERIALIZABLE = { __proto__: null };
for (const n of ['MessagePort', 'Blob', 'File', 'FileList', 'CryptoKey', 'DOMException', 'QuotaExceededError', 'DOMMatrix', 'DOMMatrixReadOnly',
    'DOMPoint', 'DOMPointReadOnly', 'DOMQuad', 'DOMRect', 'DOMRectReadOnly', 'ImageBitmap', 'ImageData'])
    ENGINE_SERIALIZABLE['[object ' + n + ']'] = true;
function dataCloneError(what) {
    return new G.DOMException(what + ' could not be cloned.', 'DataCloneError');
}
// The engine object made for page object `v` (its cell: the slot it was written to is reused for the next sibling).
function rememberClone(seen, v, p) {
    views();
    MapPrototypeSet(seen, v, u32[p >>> 2]);
}
function buildClone(v, p, seen, depth) {
    if (typeof v !== 'object' && typeof v !== 'function' || v === null) {
        if (typeof v === 'function' || typeof v === 'symbol')
            throw dataCloneError(typeof v === 'function' ? String(v).slice(0, 40) : 'Symbol()');
        if (typeof v === 'bigint') {
            writeMarker(p, 'bigint', [['v', BigIntToString(v)]], seen, depth);
            return;
        }
        fromJS(v, p);
        return;
    }
    if (typeof v === 'function')
        throw dataCloneError(String(v).slice(0, 40));
    if (depth > 1000)
        throw dataCloneError('A value nested too deeply');
    const earlier = MapPrototypeGet(seen, v);
    if (earlier !== undefined) {
        writeObject(p, earlier);
        return;
    }
    if (activeMoves !== null) {
        const moved = MapPrototypeGet(activeMoves, v);
        if (moved !== undefined) {
            // The engine's serializer refuses a stream (a platform object that is not [Serializable]) and cannot move one (its
            // transfer steps trap), so the message carries a marker object; MessageEvent.data (50-frames.js) and the result of
            // structuredClone put the new stream where the marker is (decodeStreams).
            const id = nextStreamId++;
            MapPrototypeSet(inflightStreams, id, moved);
            const m = scratchTop;
            const e = slots(1);
            X.ganglion_v_object_create(p);
            fromJS(id, e);
            X.ganglion_v_define_data(p, keyBits(STREAM_KEY), e);
            scratchTop = m;
            return;
        }
    }
    const ownCell = WeakMapPrototypeGet(cellOf, v);
    if (ownCell !== undefined && ENGINE_SERIALIZABLE[ObjectPrototypeToString(v)] === true) {
        // A port goes to the engine as itself: its serializer moves it when the transfer list has it (patch 0029, in-process
        // entanglement) and throws DataCloneError when it does not, as Chrome does. The engine's [Serializable] platform objects
        // (geometry, Blob/File, ImageData, CryptoKey, DOMException) go as themselves too: its serializer copies them (HTML
        // StructuredSerializeInternal, the platform object steps), where a page object walk would refuse them.
        writeObject(p, ownCell);
        MapPrototypeSet(seen, v, p);
        return;
    }
    if (ownCell !== undefined || WeakMapPrototypeGet(handleOf, v) !== undefined && false || callbacks.streams && callbacks.streams.hostStream(v) !== null)
        throw dataCloneError('#<' + (v.constructor && v.constructor.name || 'Object') + '>');
    // Shared memory (a SharedArrayBuffer, a view on one, a shared WebAssembly.Memory): refused without cross-origin isolation and
    // for storage, as in Chrome. Isolated, the engine cannot hold it (its memory is not V8's), so the message carries a marker as
    // a stream does and the copy read back is the host's clone of it: a new object on the same memory, as Chrome's is.
    {
        let shared = isSharedArrayBuffer(v);
        if (!shared && ArrayBufferIsView(v)) {
            const tag = TypedArrayTag(v);
            shared = isSharedArrayBuffer(tag === undefined ? DataViewBuffer(v) : TypedArrayBuffer(v));
        }
        if (!shared && HostWasmMemory !== null && v instanceof HostWasmMemory) {
            try { shared = isSharedArrayBuffer(v.buffer); } catch { shared = false; }
        }
        if (shared) {
            if (!pageIsolated)
                throw sharedCloneError();
            if (seen.lenientCollections === true || !callbacks.streams)
                throw dataCloneError('#<SharedArrayBuffer>');
            const id = nextStreamId++;
            MapPrototypeSet(inflightStreams, id, HostStructuredClone(v));
            const m = scratchTop;
            const e = slots(1);
            X.ganglion_v_object_create(p);
            fromJS(id, e);
            X.ganglion_v_define_data(p, keyBits(STREAM_KEY), e);
            scratchTop = m;
            rememberClone(seen, v, p);
            return;
        }
    }
    // Binary data. In an IndexedDB key or value (lenientCollections) a view's own bytes are copied as before (a key must be
    // the engine's binary). Elsewhere an ArrayBuffer is copied once per clone, and a typed array or DataView is a marker over
    // that copy with its offset and length, as Chrome keeps them (two views of one buffer share one copy).
    if (seen.lenientCollections === true) {
        const bytes = pageBytes(v);
        if (bytes !== null) {
            writeBuffer(p, bytes[0], bytes[1]);
            return;
        }
    } else if (ArrayBufferIsView(v)) {
        const tag = TypedArrayTag(v);
        const isDataView = tag === undefined;
        writeMarker(p, 'view', [['type', isDataView ? 'DataView' : tag], ['buffer', isDataView ? DataViewBuffer(v) : TypedArrayBuffer(v)],
            ['offset', isDataView ? DataViewByteOffset(v) : TypedArrayByteOffset(v)], ['length', isDataView ? DataViewByteLength(v) : v.length]], seen, depth);
        rememberClone(seen, v, p);
        return;
    } else if (isArrayBuffer(v)) {
        writeBuffer(p, 13, new BufferUint8Array(v, 0, ArrayBufferByteLength(v)));
        rememberClone(seen, v, p);
        return;
    }
    const mark = scratchTop;
    const e = slots(1), r = slots(1);
    if (ArrayIsArray(v)) {
        const length = v.length >>> 0;
        X.ganglion_v_array_create(length, p);
        rememberClone(seen, v, p);
        if (length > 65536) {
            // A sparse array (new Array(2 ** 32 - 1) with one element) is walked by its own keys, as Chrome's serializer does:
            // a loop over the length hung the segment for minutes (secfuzz B1). Own keys list integer indices first, ascending.
            const keys = ReflectOwnKeys(v);
            for (let j = 0; j < keys.length; j++) {
                const key = keys[j];
                if (typeof key !== 'string')
                    continue;
                const i = +key;
                if (!(i >= 0 && i < length && i === (i >>> 0) && HostString(i) === key))
                    continue;
                buildClone(v[key], e, seen, depth + 1);
                X.ganglion_v_define_data(p, indexKey(i), e);
            }
            scratchTop = mark;
            return;
        }
        for (let i = 0; i < length; i++) {
            if (!ObjectHasOwn(v, i))
                continue;
            buildClone(v[i], e, seen, depth + 1);
            X.ganglion_v_define_data(p, indexKey(i), e);
        }
        scratchTop = mark;
        return;
    }
    let time;
    try { time = ReflectApply(DatePrototypeGetTime, v, []); } catch { time = undefined; }
    if (time !== undefined) {
        X.ganglion_v_date_create(time, p);
        scratchTop = mark;
        return;
    }
    const tag = ObjectPrototypeToString(v);
    if (tag === '[object Map]' || tag === '[object Set]') {
        // A Map or Set of the engine's, its entries copied in the page's order (the engine serializes it as Chrome does).
        const isMap = tag === '[object Map]';
        if (isMap)
            X.ganglion_v_map_create(p);
        else
            X.ganglion_v_set_create(p);
        rememberClone(seen, v, p);
        const k = slots(1);
        if (isMap) {
            const entries = ArrayFromList(MapPrototypeEntries(v));
            for (let i = 0; i < entries.length; i++) {
                buildClone(entries[i][0], k, seen, depth + 1);
                buildClone(entries[i][1], e, seen, depth + 1);
                X.ganglion_v_map_put(p, k, e);
            }
        } else {
            const values = ArrayFromList(SetPrototypeValues(v));
            for (let i = 0; i < values.length; i++) {
                buildClone(values[i], e, seen, depth + 1);
                X.ganglion_v_set_put(p, e);
            }
        }
        scratchTop = mark;
        return;
    }
    if (tag === '[object RegExp]') {
        writeMarker(p, 'regexp', [['source', RegExpSource(v)], ['flags', RegExpFlags(v)]], seen, depth);
        rememberClone(seen, v, p);
        scratchTop = mark;
        return;
    }
    const boxed = boxedValue(v);
    if (boxed !== null) {
        writeMarker(p, 'boxed', [['v', boxed[0]]], seen, depth);
        rememberClone(seen, v, p);
        scratchTop = mark;
        return;
    }
    if (tag === '[object Error]') {
        // HTML's serialization of an Error: the name when it is a standard one (else "Error"), the message when it is an own
        // data property; V8 keeps the stack too.
        let name = 'Error', stack;
        try {
            const n = v.name;
            if (typeof n === 'string' && CLONE_ERROR_NAMES[n] !== undefined)
                name = n;
        } catch {}
        const fields = [['name', name]];
        const md = ObjectGetOwnPropertyDescriptor(v, 'message');
        if (md !== undefined && 'value' in md)
            ArrayPrototypePush(fields, ['message', HostString(md.value)]);
        try {
            stack = v.stack;
        } catch {}
        if (typeof stack === 'string')
            ArrayPrototypePush(fields, ['stack', stack]);
        writeMarker(p, 'error', fields, seen, depth);
        rememberClone(seen, v, p);
        scratchTop = mark;
        return;
    }
    if (tag === '[object Promise]' || tag === '[object WeakMap]' || tag === '[object WeakSet]' || tag === '[object WeakRef]')
        throw dataCloneError('#<' + tag.slice(8, -1) + '>');
    X.ganglion_v_object_create(p);
    rememberClone(seen, v, p);
    const keys = ObjectKeys(v);
    for (let i = 0; i < keys.length; i++) {
        buildClone(v[keys[i]], e, seen, depth + 1);
        X.ganglion_v_define_data(p, keyBits(keys[i]), e);
    }
    scratchTop = mark;
}

function fromJS(value, p) {
    switch (typeof value) {
    case 'undefined': writeUndefined(p); return;
    case 'boolean': writeLoHi(p, value ? 1 : 0, HI_BOOLEAN); return;
    case 'number':
        if ((value | 0) === value && !(value === 0 && 1 / value < 0)) {
            writeLoHi(p, value >>> 0, HI_INT32);
        } else if (value !== value) {
            // NaN as the engine's one canonical NaN (0x7FF8000000000000): V8 keeps a NaN's payload and sign, and a NaN whose
            // top 16 bits are 0xFFF8 or above is a cell tag in the engine's NaN-boxing (a NaN from a Float64Array or a
            // DataView read was a bogus object pointer, anura.pro's IndexedDB put trapped on it; Chrome's `undefined * 1`
            // is 0xFFF8..., which made ToNumber recurse until the stack overflowed: setTimeout(f, NaN)).
            writeLoHi(p, 0, 0x7FF80000);
        } else {
            views();
            f64[p >>> 3] = value;
        }
        return;
    case 'string': writeString(p, value); return;
    case 'symbol': X.ganglion_key_value(keyBits(value), p); return;
    case 'bigint': throw typeError('BigInt values cannot be given to the engine yet');
    case 'object':
        if (value === null) {
            writeLoHi(p, 0, HI_NULL);
            return;
        }
        // fall through
    case 'function': {
        if (value === G) {
            writeObject(p, globalCell);
            return;
        }
        const errorCell = WeakMapPrototypeGet(moduleErrorCells, value);
        if (errorCell !== undefined) {
            writeObject(p, errorCell);
            return;
        }
        if (typeof value === 'object' && WeakSetPrototypeHas(engineClones, value)) {
            const outer = activeMoves;
            activeMoves = value.moves;
            try {
                const seen = new HostMap();
                seen.lenientCollections = value.lenientCollections;
                buildClone(value.value, p, seen, 0);
            } finally {
                activeMoves = outer;
            }
            return;
        }
        const cell = WeakMapPrototypeGet(cellOf, value);
        if (cell !== undefined) {
            const pixels = WeakMapPrototypeGet(imageDataPixels, value);
            if (pixels !== undefined)
                syncImageData(cell, pixels);
            writeObject(p, cell);
            return;
        }
        if (typeof value === 'object' && WeakMapPrototypeGet(handleOf, value) === undefined) {
            const binary = pageBytes(value);
            if (binary !== null) {
                writeBuffer(p, binary[0], binary[1]);
                if (bufferPins !== null)
                    ArrayPrototypePush(bufferPins, { page: value, bytes: binary[1], slot: p });
                return;
            }
        }
        const h = handleFor(value);
        let fcell = foreignCellByHandle[h];
        if (fcell === undefined) {
            if (typeof value === 'function')
                X.ganglion_foreign_function(h, isConstructorFunction(value) ? 1 : 0, p);
            else
                X.ganglion_foreign_object(h, p);
            views();
            foreignCellByHandle[h] = u32[p >>> 2];
            return;
        }
        writeObject(p, fcell);
        return;
    }
    }
}
function isConstructorFunction(f) {
    // Arrow functions and methods are not constructors; everything else may be.
    try {
        ReflectConstruct(HostString, [], f);
        return true;
    } catch {
        return false;
    }
}

// --- Reading the runtime's objects ------------------------------------------------------------------------------
function cellToJS(cell) {
    const mark = scratchTop;
    const p = slots(1);
    writeObject(p, cell);
    const v = toJS(p);
    scratchTop = mark;
    return v;
}
function vGet(cell, key) {
    const mark = scratchTop;
    const o = slots(1), r = slots(1);
    writeObject(o, cell);
    const threw = X.ganglion_v_get(o, keyBits(key), r);
    const v = toJS(r);
    scratchTop = mark;
    if (threw)
        throw mapThrown(v);
    return v;
}
function vSet(cell, key, value) {
    const entered = idleEntry();
    try {
        return vSetEntered(cell, key, value);
    } catch (e) {
        engineTrapped(e, 'a property set from page code');
        throw e;
    } finally {
        idleExit(entered);
    }
}
function vSetEntered(cell, key, value) {
    const mark = scratchTop;
    const o = slots(1), val = slots(1), r = slots(1);
    writeObject(o, cell);
    fromJS(value, val);
    const threw = X.ganglion_v_set(o, keyBits(key), val, r);
    const v = toJS(r);
    scratchTop = mark;
    if (threw)
        throw mapThrown(v);
    return v;
}
function vPrototypeCell(cell) {
    const mark = scratchTop;
    const o = slots(1), r = slots(1);
    writeObject(o, cell);
    X.ganglion_v_prototype(o, r);
    views();
    const hi = u32[(r >>> 2) + 1], lo = u32[r >>> 2];
    scratchTop = mark;
    return (hi >>> 16) === TAG_OBJECT ? lo : 0;
}
function vOwnKeys(cell) {
    const mark = scratchTop;
    const o = slots(1), r = slots(1);
    writeObject(o, cell);
    X.ganglion_v_own_keys(o, r);
    const n = X.ganglion_keys_count();
    const keys = safeArray();
    for (let i = 0; i < n; i++)
        keys[i] = X.ganglion_keys_at(i);
    scratchTop = mark;
    return keys;
}
// { kind: 1 data | 2 accessor | 3 pending | 4 exotic, flags, value, getterCell, setterCell } or null.
function vOwnProperty(cell, bits) {
    const mark = scratchTop;
    const o = slots(1);
    writeObject(o, cell);
    const kind = X.ganglion_v_own_kind(o, bits);
    if (kind === 0) {
        scratchTop = mark;
        return null;
    }
    if (kind === 3) {
        scratchTop = mark;
        return { __proto__: null, kind: 3 };
    }
    const flagsPtr = slots(1), value = slots(1), getter = slots(1), setter = slots(1);
    const threw = X.ganglion_v_own_property(o, bits, flagsPtr, value, getter, setter);
    views();
    const flags = u32[flagsPtr >>> 2];
    let result = null;
    if (!threw && (flags & PD_PRESENT)) {
        // Object values stay as cells (valueCell): converting them here would walk prototype <-> constructor
        // cycles for ever. Primitives are converted now.
        result = { __proto__: null, kind: (flags & (PD_HAS_GET | PD_HAS_SET)) ? 2 : 1, flags, value: undefined, valueCell: 0, getterCell: 0, setterCell: 0, getterIsObject: false, setterIsObject: false };
        if (flags & PD_HAS_VALUE) {
            if ((u32[(value >>> 2) + 1] >>> 16) === TAG_OBJECT)
                result.valueCell = u32[value >>> 2];
            else
                result.value = toJS(value);
        }
        if (flags & PD_HAS_GET)
            result.getterCell = u32[getter >>> 2], result.getterIsObject = (u32[(getter >>> 2) + 1] >>> 16) === TAG_OBJECT;
        if (flags & PD_HAS_SET)
            result.setterCell = u32[setter >>> 2], result.setterIsObject = (u32[(setter >>> 2) + 1] >>> 16) === TAG_OBJECT;
    }
    scratchTop = mark;
    return result;
}
function vObjectKind(cell) {
    const mark = scratchTop;
    const o = slots(1);
    writeObject(o, cell);
    const k = X.ganglion_v_object_kind(o);
    scratchTop = mark;
    return k;
}
function vClassName(cell) {
    const mark = scratchTop;
    const o = slots(1);
    writeObject(o, cell);
    const ptr = X.ganglion_v_class_name(o, scratchTop);
    views();
    const n = u32[scratchTop >>> 2];
    const name = bytesToString(ptr, n);
    scratchTop = mark;
    return name;
}
function vHostFlags(cell) {
    const mark = scratchTop;
    const o = slots(1);
    writeObject(o, cell);
    const f = X.ganglion_v_host_flags(o);
    scratchTop = mark;
    return f;
}

// --- Calling into the engine ---------------------------------------------------------------------------------------
// Page JS the host starts by itself (a V8 promise job, a microtask) calls bindings with no engine frame under
// it, so no script execution context and no backup incumbent realm: LibWeb's incumbent_realm() then fails its
// VERIFY and the engine stops (Wikipedia's Codex/Vue on the first keystroke). Such a call is bracketed with
// the same enter/leave the harness's evalInPage uses. `hostDepth` counts the engine's own calls out into
// page JS (callbacks, scripts, handlers), under which a context already exists.
let hostDepth = 0;
// The incumbent of a call made from a host job (HTML: the realm of the calling script). A frame's classic scripts are compiled
// under their own URLs (55-realms.js runFrameScript records them here: URL -> the frame's global, or null when two realms ran
// scripts of that URL), so the innermost page frame of the stack names the calling realm; a URL no frame ran is the principal
// window's. Used where the incumbent is observable: Window.postMessage's `source` (a parent posting to its frame after an
// `await` is the parent, not the frame whose postMessage it called).
const scriptRealmByUrl = new HostMap();
const STACK_URL_RE = /\(?((?:https?|blob|data):[^\s)]*?):\d+:\d+\)?\s*$/;
function noteScriptRealm(filename, global) {
    const url = HostString(filename);
    if (!MapPrototypeHas(scriptRealmByUrl, url))
        MapPrototypeSet(scriptRealmByUrl, url, global);
    else if (MapPrototypeGet(scriptRealmByUrl, url) !== global)
        MapPrototypeSet(scriptRealmByUrl, url, null);
}
function callerRealmCell() {
    if (scriptRealmByUrl.size === 0)
        return undefined;
    const E = HostError;
    const saved = [E.prepareStackTrace, E.stackTraceLimit];
    let stack;
    try {
        E.prepareStackTrace = undefined;
        E.stackTraceLimit = 16;
        stack = HostString(new E().stack);
    } catch {
        return undefined;
    } finally {
        E.prepareStackTrace = saved[0];
        E.stackTraceLimit = saved[1];
    }
    const lines = StringPrototypeSplit(stack, '\n');
    for (let i = 1; i < lines.length; i++) {
        const m = RegExpPrototypeExec(STACK_URL_RE, lines[i]);
        if (m === null)
            continue;
        const url = m[1];
        if (StringPrototypeIncludes(url, '/chitin/'))
            continue; // the glue's own frames
        if (!MapPrototypeHas(scriptRealmByUrl, url))
            return globalCell;
        const global = MapPrototypeGet(scriptRealmByUrl, url);
        if (global === null)
            return undefined;
        const cell = WeakMapPrototypeGet(cellOf, global);
        return cell === undefined ? undefined : cell;
    }
    return undefined;
}
function idleEntry(realmCell, incumbentFromStack) {
    if (incumbentFromStack === true && hostDepth === 0 && frameRealmsOn) {
        const caller = callerRealmCell();
        if (caller !== undefined)
            realmCell = caller;
    }
    // Any call with a document to enter is bracketed, scripts run or not: the DevTools console (or a host
    // callback) calling the page's globals on a page with no script of its own is the same case.
    if (hostDepth !== 0 || !scriptingOn || !X.ganglion_js_can_enter())
        return false;
    // With frame realms, the realm the page's code acts in: the realm of the function it calls (a frame's own
    // `postMessage`, its stand-in's methods), or of the global a stand-in belongs to (`realmCell`). The page's code in
    // a host job (after an `await`) has no engine frame to say which realm it is; the callee's realm stands in for it.
    // Everything else, and pages without frames, enter the principal realm.
    if (frameRealmsOn && realmCell !== undefined && realmCell !== 0 && realmCell !== globalCell) {
        const mark = scratchTop;
        const o = slots(1);
        writeObject(o, realmCell);
        const realm = X.ganglion_js_realm_of(o);
        scratchTop = mark;
        X.ganglion_js_enter_realm(realm);
        return true;
    }
    X.ganglion_js_enter();
    return true;
}
function idleExit(entered) {
    if (!entered || stoppedReason !== null) // after a trap the engine is not called again (engineTrapped)
        return;
    // The page's code is still running on the host's stack: microtasks the engine queued during the call (a mutation observer
    // microtask) run from the host's microtask queue, after this code and in order with its promise jobs (Host.cpp).
    if (HostQueueMicrotask === null) {
        X.ganglion_js_leave();
        return;
    }
    if (X.ganglion_js_leave_deferring_microtasks() === 1 && !engineCheckpointQueued) {
        engineCheckpointQueued = true;
        HostQueueMicrotask(engineCheckpoint);
    }
}
let engineCheckpointQueued = false;
function engineCheckpoint() {
    engineCheckpointQueued = false;
    if (stoppedReason === null && hostDepth === 0)
        X.ganglion_microtask_checkpoint();
}
function invoke(fnCell, thisValue, args, incumbentFromStack) {
    if (stoppedReason !== null)
        throw new HostError('ganglion: the engine stopped: ' + stoppedReason);
    const entered = idleEntry(fnCell, incumbentFromStack);
    try {
        return invokeEntered(fnCell, thisValue, args);
    } catch (e) {
        engineTrapped(e, 'a call from page code');
        throw e;
    } finally {
        idleExit(entered);
    }
}
let readAsClone = false; // the next invoke's result is a structured clone's copy: read whole (cloneToJS)
function invokeEntered(fnCell, thisValue, args) {
    const asClone = readAsClone;
    readAsClone = false;
    const mark = scratchTop;
    const n = args.length;
    const f = slots(1), t = slots(1), a = slots(n || 1), r = slots(1);
    writeObject(f, fnCell);
    const outerPins = bufferPins;
    const pins = bufferPins = [];
    let threw, result;
    try {
        fromJS(thisValue, t);
        for (let i = 0; i < n; i++)
            fromJS(args[i], a + i * 8);
        bufferPins = outerPins;
        threw = X.ganglion_js_invoke(f, t, a, n, r);
        const same = pins.length ? finishPins(pins, r) : undefined;
        result = same !== undefined ? same : asClone && !threw ? cloneToJS(r) : toJS(r);
    } finally {
        bufferPins = outerPins;
    }
    scratchTop = mark;
    if (threw) {
        // The engine refused the call because the cell is not a function: a wrapper that stands for a cell the engine no
        // longer has as a function (a diagnostic for the operator's console, once per page; Discord, 2026-10-22).
        if (!reportedNotAFunction && result && result.message === 'not a function' && hostConsoleError !== undefined) {
            reportedNotAFunction = true;
            hostConsoleError(hostConsole, '[chitin] engine call refused (not a function); page stack:', new HostError().stack);
        }
        throw mapThrown(result);
    }
    return result;
}
let reportedNotAFunction = false;
function constructCell(ctorCell, args, newTarget) {
    const entered = idleEntry(ctorCell);
    try {
        return constructCellEntered(ctorCell, args, newTarget);
    } catch (e) {
        engineTrapped(e, 'a construct from page code'); // new AudioContext() trapped in Thread::start (chess.com)
        throw e;
    } finally {
        idleExit(entered);
    }
}
function constructCellEntered(ctorCell, args, newTarget) {
    const mark = scratchTop;
    const n = args.length;
    const f = slots(1), a = slots(n || 1), r = slots(1);
    writeObject(f, ctorCell);
    const outerPins = bufferPins;
    bufferPins = [];
    let threw, result;
    try {
        for (let i = 0; i < n; i++)
            fromJS(args[i], a + i * 8);
        const pins = bufferPins;
        bufferPins = outerPins;
        // NewTarget: a page class that extends an interface (a custom element extending HTMLElement) constructs the interface's
        // object with its own constructor as NewTarget, which the engine looks up (custom element definitions) and takes the
        // prototype from.
        let nt = 0;
        if (newTarget !== undefined) {
            nt = slots(1);
            fromJS(newTarget, nt);
        }
        threw = X.ganglion_js_construct(f, a, n, nt, r);
        if (pins.length)
            finishPins(pins, r);
        result = toJS(r);
        if (!threw && n > 0 && ArrayBufferIsView(args[0]) && typeof result === 'object' && result !== null && vClassName(u32[r >>> 2]) === 'ImageData')
            WeakMapPrototypeSet(imageDataPixels, result, args[0]);
    } finally {
        bufferPins = outerPins;
    }
    scratchTop = mark;
    if (threw) {
        // Interfaces without a constructor: Chrome's message.
        if (result instanceof HostTypeError && /is not a constructor$/.test(result.message)) {
            const illegal = typeError('Illegal constructor');
            WeakSetPrototypeAdd(engineErrors, illegal);
            throw illegal;
        }
        throw mapThrown(result);
    }
    if (newTarget !== undefined && typeof result === 'object' && result !== null) {
        const proto = newTarget.prototype;
        if (typeof proto === 'object' && proto !== null && ObjectGetPrototypeOf(result) !== proto)
            ObjectSetPrototypeOf(result, proto);
    }
    return result;
}

// A thrown runtime value as the page should see it. Engine errors arrive already converted to V8
// errors by errorToJS; DOMExceptions are wrappers; foreign values are the page's own.
function mapThrown(value) {
    return value;
}

const ERROR_CONSTRUCTORS = [HostError, HostEvalError, HostError, HostRangeError, HostReferenceError, HostSyntaxError, HostTypeError, HostURIError, HostAggregateError || HostError, HostError];
const errorTwins = new HostMap(); // runtime error cell -> the page's own error it stands for
// The other way, for a module script's failure only (ganglion_host_js_run_module): the error its promise rejects with is given
// to the engine as the engine Error that stands for it, so the error event's message is the error's (LibWeb reads `message`
// without side effects, which a host object cannot answer).
const moduleErrorCells = new WeakMap(); // the page's error -> its runtime error cell
const ObjectPrototypeToString = uncurryThis(HostObject.prototype.toString);
// A page error given to the engine (a throw out of a callback or a script) becomes a runtime Error cell
// with the same kind and message, so LibWeb's exception reporting reads it as an error; the page gets
// its own object back when the engine rethrows it.
function errorFromJS(e, p) {
    let kind = 0;
    let ctor;
    try {
        ctor = e.constructor;
    } catch { /* a proxy or accessor that throws */ }
    if (ctor === HostTypeError) kind = 6;
    else if (ctor === HostRangeError) kind = 3;
    else if (ctor === HostSyntaxError) kind = 5;
    else if (ctor === HostReferenceError) kind = 4;
    else if (ctor === HostEvalError) kind = 1;
    else if (ctor === HostURIError) kind = 7;
    const info = describeThrown(e);
    // The runtime reports an error by its class and message. A DOMException, a subclass or a bare object has the
    // generic class, so its own name goes first (message alone read "[object ForeignObject]" in the owner's run). A
    // standard class keeps its message as it is: pages read it back (ErrorEvent.message, a rejection's reason).
    let message = info.message;
    if (kind === 0 && info.name !== 'Error')
        message = info.name + ': ' + message;
    // The host's stack goes to the engine log where the report line will be, once per thrown value.
    if (!WeakSetPrototypeHas(describedThrown, e)) {
        WeakSetPrototypeAdd(describedThrown, e);
        if (info.stack !== '')
            engineLog('ganglion: thrown by the host: ' + info.name + ': ' + info.message + '\n' + info.stack);
        else
            engineLog('ganglion: thrown by the host (no stack): ' + info.name + ': ' + info.message + ' ' + ObjectPrototypeToString(e) + ' keys ' + describeKeys(e) + '\n' + new HostError('where').stack);
    }
    const ptr = stringToEngine(message);
    X.ganglion_v_error_create(kind, ptr, message.length, p);
    X.ganglion_free(ptr);
    X.ganglion_v_root(p);
    views();
    MapPrototypeSet(errorTwins, u32[p >>> 2], e);
}
const describedThrown = new HostWeakSet();
function describeKeys(e) {
    try { return HostString(ObjectKeys(e).slice(0, 8)); } catch { return '?'; }
}
// What a thrown host value is, without running anything that can throw: its class name (DOMException, a subclass's
// name, or the Object.prototype.toString tag), message and stack when they are strings.
function describeThrown(e) {
    let name = '', message = '', stack = '';
    try {
        const n = e.name;
        if (typeof n === 'string' && n !== '') name = n;
    } catch { /* an accessor that throws */ }
    if (name === '') {
        try {
            const c = e.constructor;
            if (typeof c === 'function' && typeof c.name === 'string') name = c.name;
        } catch { /* as above */ }
    }
    if (name === '') name = ObjectPrototypeToString(e).slice(8, -1);
    try {
        const m = e.message;
        if (typeof m === 'string') message = m;
    } catch { /* as above */ }
    if (message === '') {
        try {
            const j = typeof e.toString === 'function' ? ReflectApply(e.toString, e, []) : '';
            if (typeof j === 'string' && j !== '[object Object]') message = j;
        } catch { /* as above */ }
    }
    try {
        const st = e.stack;
        if (typeof st === 'string') stack = st;
    } catch { /* as above */ }
    return { name, message, stack };
}
function errorToJS(p) {
    views();
    const cell = u32[p >>> 2];
    const twin = MapPrototypeGet(errorTwins, cell);
    if (twin !== undefined)
        return twin;
    const kind = X.ganglion_v_error_kind(p);
    // Reading the message may run LibWeb accessors that throw; that must not hide the error being converted.
    let message = '';
    try {
        const v = vGet(cell, 'message');
        if (typeof v === 'string')
            message = v;
    } catch (inner) {
        message = '[the error\'s message could not be read: ' + (inner && inner.message) + ']';
    }
    const Ctor = ERROR_CONSTRUCTORS[kind] || HostError;
    const error = new Ctor(message);
    WeakSetPrototypeAdd(engineErrors, error);
    return error;
}

// An engine Map or Set (an IndexedDB value read back): a page Map or Set with the entries converted.
function collectionToJS(p, cell, isMap) {
    const out = isMap ? new HostMap() : new HostSet();
    cacheWrapperValue(cell, out);
    const mark = scratchTop;
    const a = slots(1);
    X.ganglion_v_collection_entries(p, a);
    const flat = arrayToJS(a);
    scratchTop = mark;
    if (isMap) {
        for (let i = 0; i + 1 < flat.length; i += 2)
            MapPrototypeSet(out, flat[i], flat[i + 1]);
    } else {
        for (let i = 0; i < flat.length; i++)
            SetPrototypeAdd(out, flat[i]);
    }
    return out;
}

// --- Values read back whole: the result of a structured clone ----------------------------------------------------
// structuredClone's result, MessageEvent.data, history.state and IndexedDB's values are the engine's deserialized copy, a
// tree of its own objects. toJS would mirror a plain object as a snapshot cut at depth two; this reads the whole copy into
// page objects of the same types, cycles and shared references kept (Chrome's deserialization). Platform objects (a Blob,
// a MessagePort, an IDBDatabase) are the engine's wrappers as usual.
let lastCloneCell = 0; // the cell the last cloneToJS read (getters cache their result per receiver and cell)
function cloneToJS(p) {
    views();
    const hi = u32[(p >>> 2) + 1];
    lastCloneCell = (hi >>> 16) === TAG_OBJECT ? u32[p >>> 2] : 0;
    const out = readClone(p, new HostMap(), 0);
    return out;
}
function rawGetInto(cell, key, r) {
    const mark = scratchTop;
    const o = slots(1);
    writeObject(o, cell);
    const threw = X.ganglion_v_get(o, key, r);
    scratchTop = mark;
    return threw;
}
// A marker (writeMarker) as the page value it stands for, or undefined when it is not one.
function readMarker(cell, seen, depth, r) {
    const kind = vGet(cell, CLONE_KEY);
    const field = (name) => {
        rawGetInto(cell, keyBits(name), r);
        return readClone(r, seen, depth + 1);
    };
    switch (kind) {
    case 'bigint': return HostBigInt(field('v'));
    case 'regexp': return new CloneRegExp(field('source'), field('flags'));
    case 'boxed': return HostObject(field('v'));
    case 'view': {
        const type = field('type');
        const Ctor = type === 'DataView' ? HostDataView : BUFFER_CTORS[BUFFER_KIND_BY_NAME[type]];
        if (typeof Ctor !== 'function')
            return undefined;
        return new Ctor(field('buffer'), field('offset'), field('length'));
    }
    case 'error': {
        const Ctor = CLONE_ERROR_NAMES[field('name')] || HostError;
        const out = vOwnProperty(cell, keyBits('message')) !== null ? new Ctor(field('message')) : new Ctor();
        if (vOwnProperty(cell, keyBits('stack')) !== null)
            ObjectDefineProperty(out, 'stack', { value: field('stack'), writable: true, enumerable: false, configurable: true });
        return out;
    }
    }
    return undefined;
}
function readClone(p, seen, depth) {
    views();
    const lo = u32[p >>> 2];
    const tag = u32[(p >>> 2) + 1] >>> 16;
    if (tag !== TAG_OBJECT || depth > 2000)
        return toJS(p);
    const cell = lo;
    const earlier = MapPrototypeGet(seen, cell);
    if (earlier !== undefined)
        return earlier;
    if (MapPrototypeGet(wrapperByCell, cell) !== undefined || cell === globalCell)
        return toJS(p);
    const kind = X.ganglion_v_object_kind(p);
    const mark = scratchTop;
    const r = slots(1);
    try {
        if (kind === 5) {
            const out = [];
            MapPrototypeSet(seen, cell, out);
            const n = vGet(cell, 'length') >>> 0;
            out.length = n;
            if (n > 65536) {
                // Sparse: by own keys, not by length (secfuzz B1, as buildClone).
                const keys = vOwnKeys(cell);
                for (let k = 0; k < keys.length; k++) {
                    if (X.ganglion_key_kind(keys[k]) === 2)
                        continue;
                    const key = keyToJS(keys[k]);
                    if (typeof key === 'symbol')
                        continue;
                    const i = +key;
                    if (!(i >= 0 && i < n && i === (i >>> 0) && HostString(i) === HostString(key)))
                        continue;
                    rawGetInto(cell, indexKey(i), r); // the index key, not the own-keys string form
                    out[i] = readClone(r, seen, depth + 1);
                }
                return out;
            }
            for (let i = 0; i < n; i++) {
                const bits = indexKey(i);
                if (vOwnProperty(cell, bits) === null)
                    continue;
                rawGetInto(cell, bits, r);
                out[i] = readClone(r, seen, depth + 1);
            }
            return out;
        }
        if (kind === 12 || kind === 13) {
            const isMap = kind === 12;
            const out = isMap ? new HostMap() : new HostSet();
            MapPrototypeSet(seen, cell, out);
            const a = slots(1);
            X.ganglion_v_collection_entries(p, a);
            views();
            const arr = u32[a >>> 2];
            const n = vGet(arr, 'length') >>> 0;
            const k = slots(1);
            for (let i = 0; i < n; i += isMap ? 2 : 1) {
                rawGetInto(arr, indexKey(i), r);
                const first = readClone(r, seen, depth + 1);
                if (isMap) {
                    rawGetInto(arr, indexKey(i + 1), k);
                    MapPrototypeSet(out, first, readClone(k, seen, depth + 1));
                } else {
                    SetPrototypeAdd(out, first);
                }
            }
            return out;
        }
        if (kind === 7) {
            let name = '', message, stack;
            try { name = vGet(cell, 'name'); } catch {}
            const Ctor = CLONE_ERROR_NAMES[name] || HostError;
            const mp = vOwnProperty(cell, keyBits('message'));
            if (mp !== null)
                message = HostString(vGet(cell, 'message'));
            const out = message === undefined ? new Ctor() : new Ctor(message);
            if (vOwnProperty(cell, keyBits('stack')) !== null) {
                try { stack = vGet(cell, 'stack'); } catch {}
                if (typeof stack === 'string')
                    ObjectDefineProperty(out, 'stack', { value: stack, writable: true, enumerable: false, configurable: true });
            }
            MapPrototypeSet(seen, cell, out);
            return out;
        }
        if (kind === 10) {
            const info = slots(1);
            const bk = X.ganglion_v_buffer_info(p, info);
            let out;
            const Ctor = bk >= 1 && bk <= 12 ? BUFFER_CTORS[bk - 1] : null;
            if (Ctor !== null) {
                // A view: over the clone's copy of its buffer (shared with the other views of it), offset and length kept.
                // When the buffer reads back short (a view the engine made over a received message's bytes read its buffer as
                // empty: DayDream's Wisp frames arrived as empty Uint8Arrays), the view's own bytes are copied instead.
                rawGetInto(cell, keyBits('buffer'), r);
                const buffer = readClone(r, seen, depth + 1);
                const offset = vGet(cell, 'byteOffset') >>> 0, length = vGet(cell, 'length') >>> 0;
                const size = Ctor.BYTES_PER_ELEMENT || 1;
                const fits = ObjectPrototypeToString(buffer) === '[object ArrayBuffer]' && offset + length * size <= buffer.byteLength;
                out = fits ? new Ctor(buffer, offset, length) : bufferToJS(p);
            } else {
                out = bufferToJS(p);
            }
            MapPrototypeSet(seen, cell, out);
            return out;
        }
        if (kind !== 9)
            return toJS(p);
        const proto = vPrototypeCell(cell);
        if (proto === objectPrototypeCell && vOwnProperty(cell, keyBits(CLONE_KEY)) !== null) {
            const out = readMarker(cell, seen, depth, r);
            if (out !== undefined) {
                MapPrototypeSet(seen, cell, out);
                return out;
            }
        }
        if (proto === objectPrototypeCell) {
            const out = {};
            MapPrototypeSet(seen, cell, out);
            const keys = vOwnKeys(cell);
            for (let i = 0; i < keys.length; i++) {
                if (X.ganglion_key_kind(keys[i]) === 2)
                    continue;
                const prop = vOwnProperty(cell, keys[i]);
                if (!prop || prop.kind !== 1 || !(prop.flags & PD_ENUMERABLE))
                    continue;
                rawGetInto(cell, keys[i], r);
                out[keyToJS(keys[i])] = readClone(r, seen, depth + 1);
            }
            return out;
        }
        return toJS(p);
    } finally {
        scratchTop = mark;
    }
}

function arrayToJS(p) {
    views();
    const cell = u32[p >>> 2];
    const n = vGet(cell, 'length') >>> 0;
    const out = [];
    for (let i = 0; i < n; i++)
        out[i] = vGet(cell, HostString(i));
    return out;
}

function plainToJS(cell, depth) {
    const out = {};
    if (depth > 2)
        return out;
    const keys = vOwnKeys(cell);
    for (let i = 0; i < keys.length; i++) {
        if (X.ganglion_key_kind(keys[i]) === 2)
            continue;
        const prop = vOwnProperty(cell, keys[i]);
        if (!prop || prop.kind !== 1 || !(prop.flags & PD_ENUMERABLE))
            continue;
        const key = keyToJS(keys[i]);
        if (prop.valueCell) {
            const cached = MapPrototypeGet(wrapperByCell, prop.valueCell);
            if (cached !== undefined) {
                out[key] = cached;
                continue;
            }
            const mark = scratchTop;
            const vp = slots(1);
            writeObject(vp, prop.valueCell);
            const kind = X.ganglion_v_object_kind(vp);
            out[key] = kind === 8 || kind === 9 ? otherToJS(vp, prop.valueCell, depth + 1) : toJS(vp);
            scratchTop = mark;
        } else {
            out[key] = prop.value;
        }
    }
    // The runtime's Map and Set iterators are plain objects with an own `next` (Misc.cpp); a snapshot of one is
    // iterable itself, as every built-in iterator is.
    if (typeof out.next === 'function' && out[SymbolIterator] === undefined)
        ObjectDefineProperty(out, SymbolIterator, { value: function () { return this; }, writable: true, enumerable: false, configurable: true });
    return out;
}

// A runtime promise as a V8 promise that follows it (the engine's `then`, with the page's resolvers as
// foreign functions).
function promiseToJS(p, cell) {
    const twin = new HostPromise_((resolve, reject) => {
        // The runtime's promises have no `then` property (bare prototype): attach to the cell directly.
        const mark = scratchTop;
        const pr = slots(1), f = slots(1), r = slots(1);
        writeObject(pr, cell);
        fromJS(resolve, f);
        fromJS(reject, r);
        X.ganglion_promise_then(pr, f, r);
        scratchTop = mark;
    });
    cacheWrapper(cell, twin);
    return twin;
}
// A placeholder wrapper for a runtime object that has no class (promises, plain objects) so it can be
// a `this`.
function cellWrapperFor(cell) {
    const existing = MapPrototypeGet(wrapperByCell, cell);
    if (existing !== undefined)
        return existing;
    const o = ObjectCreate(null);
    WeakMapPrototypeSet(cellOf, o, cell);
    return o;
}

// --- Functions of the runtime as page functions ------------------------------------------------------------------
// A legacy factory function (`Image`, `Audio`, `Option`): its `prototype` is another interface's, but it is not
// that interface's constructor (`new HTMLImageElement()` is illegal, `new Image()` is not).
function legacyFactory(cell, cls) {
    const cached = MapPrototypeGet(functionByCell, cell);
    if (cached !== undefined)
        return cached;
    const raw = vGet(cell, 'name');
    const fname = typeof raw === 'string' ? raw : '';
    const factory = {
        [fname]: function (...args) {
            if (new.target === undefined)
                throw typeError(`Failed to construct '${fname}': Please use the 'new' operator, this DOM object constructor cannot be called as a function.`);
            return constructCell(cell, args, undefined);
        },
    }[fname];
    ObjectDefineProperty(factory, 'prototype', { value: cls.prototype, writable: false, enumerable: false, configurable: false });
    WeakSetPrototypeAdd(nativeFunctions, factory);
    MapPrototypeSet(functionByCell, cell, factory);
    cacheWrapper(cell, factory);
    WeakMapPrototypeSet(cellOf, factory, cell);
    return factory;
}
// A legacy callback interface object (NodeFilter) has no prototype, only its constants: WebIDL defines them on the
// function as read-only, enumerable, non-configurable data properties (TreeWalker filters read NodeFilter.SHOW_*).
function defineCallbackInterfaceConstants(f, cell) {
    const keys = vOwnKeys(cell);
    for (let i = 0; i < keys.length; i++) {
        const key = keyToJS(keys[i]);
        if (key === 'length' || key === 'name' || typeof key !== 'string')
            continue;
        const prop = vOwnProperty(cell, keys[i]);
        if (prop && prop.kind === 1 && !prop.valueCell && typeof prop.value === 'number' && !(prop.flags & (PD_WRITABLE | PD_CONFIGURABLE)))
            ObjectDefineProperty(f, key, { value: prop.value, writable: false, enumerable: (prop.flags & PD_ENUMERABLE) !== 0, configurable: false });
    }
}
function functionToJS(p, cell) {
    const cached = MapPrototypeGet(functionByCell, cell);
    if (cached !== undefined)
        return cached;
    // An interface object: a function whose `prototype` is an interface prototype (it carries a toStringTag).
    const protoProp = vOwnProperty(cell, keyBits('prototype'));
    if (protoProp && protoProp.kind === 1 && protoProp.valueCell) {
        const cls = classForPrototype(protoProp.valueCell);
        if (cls !== null) {
            if (ownValueCell(protoProp.valueCell, 'constructor') === cell)
                return cls;
            return legacyFactory(cell, cls);
        }
    }
    const name = vGet(cell, 'name');
    const length = vGet(cell, 'length');
    const f = makeNativeFunction(typeof name === 'string' ? name : '', cell, typeof length === 'number' ? length : 0, undefined);
    defineCallbackInterfaceConstants(f, cell);
    MapPrototypeSet(functionByCell, cell, f);
    cacheWrapper(cell, f);
    WeakMapPrototypeSet(cellOf, f, cell);
    return f;
}

// A page-visible function that calls the runtime function `cell`. `boundThis` fixes the receiver (the
// global's members); otherwise the caller's `this` is passed through. `owner` is the interface the member is on
// (for the messages Chrome's bindings give, 45-surface.js).
function makeNativeFunction(name, cell, length, boundThis, owner) {
    const bound = boundThis !== undefined;
    const globalMember = bound && boundThis === G;
    const clones = CLONED_FIRST_ARGUMENT[name] === true;
    const windowPost = name === 'postMessage' && (owner === 'Window' || bound);
    const clonedArguments = owner !== undefined ? CLONED_ARGUMENTS[owner + '.' + name] : undefined;
    const f = {
        [name](...args) {
            if (globalMember && foreignReceiver(this, boundThis))
                return foreignGlobalCall(f, name);
            // A native called with no receiver (`const add = window.addEventListener; add(...)`, a bare call) gets the global
            // object, as V8's API functions do; EventTarget's methods then work on it.
            const self = bound ? boundThis : (this === undefined || this === null) && owner !== undefined ? G : this;
            if (!bound && owner !== undefined && notWrapper(self))
                throw illegalInvocation(f);
            try {
                // Only postMessage and structuredClone take an options dictionary there: pushState/replaceState's third argument
                // is the URL (a URL object from SvelteKit's router), which a snapshot turned into a plain object ("Cannot convert
                // object to primitive value").
                if (clones && args.length > 1 && (name === 'postMessage' || name === 'structuredClone'))
                    snapshotTransfer(args);
                const buffers = clones && args.length > 1 ? transferredBuffers(args) : null;
                if (clones && args.length > 0)
                    args[0] = cloneForEngine(args[0], false, args);
                if (clonedArguments !== undefined) {
                    for (let i = 0; i < clonedArguments.length; i++) {
                        const k = clonedArguments[i];
                        if (k < args.length && WeakMapPrototypeGet(cellOf, args[k]) === undefined)
                            args[k] = cloneForEngine(args[k], true, null);
                    }
                }
                if (clones && name === 'structuredClone') {
                    readAsClone = true;
                    const result = decodeStreams(invoke(cell, self, args));
                    detachBuffers(buffers);
                    return result;
                }
                const result = invoke(cell, self, args, windowPost);
                detachBuffers(buffers);
                return result;
            } catch (e) {
                throw chromeError(e, f, 'method', owner, name, self, args);
            }
        },
    }[name];
    ObjectDefineProperty(f, 'length', { value: length, writable: false, enumerable: false, configurable: true });
    WeakSetPrototypeAdd(nativeFunctions, f);
    return f;
}
// Getters whose value is a structured clone's copy (read whole by cloneToJS; the same object on every read while the
// engine's value is the same, as in Chrome).
const CLONE_GETTERS = { __proto__: null, 'MessageEvent.data': true, 'History.state': true, 'PopStateEvent.state': true, 'IDBRequest.result': true, 'IDBCursorWithValue.value': true, 'IDBCursor.key': true, 'IDBCursor.primaryKey': true, 'Notification.data': true };
function makeGetter(name, cell, boundThis, owner) {
    // The accessor's runtime function is held by the page's accessor from now on: rooted, so a property the engine
    // replaces or deletes (a [Replaceable] global such as performance) does not leave the page calling a collected cell
    // ("TypeError: not a function" from get performance, Discord's react-spring loop, 2026-10-22).
    rootAccessorCell(cell);
    const bound = boundThis !== undefined;
    const globalMember = bound && boundThis === G;
    if (owner !== undefined && CLONE_GETTERS[owner + '.' + name] === true)
        return makeCloneGetter(name, cell, boundThis, owner);
    const imageDataGetter = owner === 'ImageData' && name === 'data';
    const f = {
        get [name]() {
            const self = bound ? boundThis : (this === undefined || this === null) && owner !== undefined ? G : this;
            if ((globalMember && foreignReceiver(this, boundThis)) || (!bound && owner !== undefined && notWrapper(self))) {
                if (lenientThis(name))
                    return undefined;
                throw illegalInvocation(getter);
            }
            try {
                if (imageDataGetter) {
                    const known = WeakMapPrototypeGet(imageDataPixels, self);
                    if (known !== undefined)
                        return known;
                    const pixels = invoke(cell, self, []);
                    if (typeof pixels === 'object' && pixels !== null)
                        WeakMapPrototypeSet(imageDataPixels, self, pixels);
                    return pixels;
                }
                return invoke(cell, self, []);
            } catch (e) {
                throw chromeError(e, getter, 'get', owner, name, self, []);
            }
        },
    };
    const getter = ObjectGetOwnPropertyDescriptor(f, name).get;
    WeakSetPrototypeAdd(nativeFunctions, getter);
    return getter;
}
// A MessageEvent the page constructs carries its init's `data` itself, as in Chrome (`new MessageEvent('message', { data: u8 })
// .data === u8`): it is not a structured clone, and the engine's copy of a typed array or ArrayBuffer is not the page's (a
// Uint8Array came back empty: libcurl.js's Wisp client wraps every DATA packet so, and TLS over it failed with error 35).
const constructedMessageData = new WeakMap(); // event -> { value }
function rememberMessageData(event, init) {
    if (typeof event !== 'object' || event === null || init === undefined || init === null || typeof init !== 'object' && typeof init !== 'function')
        return;
    const data = init.data;
    WeakMapPrototypeSet(constructedMessageData, event, { value: data === undefined ? null : data });
}
function makeCloneGetter(name, cell, boundThis, owner) {
    const bound = boundThis !== undefined;
    const pageData = owner === 'MessageEvent' && name === 'data';
    const reads = new WeakMap(); // receiver -> { cell, value }
    const f = {
        get [name]() {
            const self = bound ? boundThis : (this === undefined || this === null) && owner !== undefined ? G : this;
            if (!bound && owner !== undefined && notWrapper(self))
                throw illegalInvocation(getter);
            if (pageData) {
                const constructed = WeakMapPrototypeGet(constructedMessageData, self);
                if (constructed !== undefined)
                    return constructed.value;
            }
            try {
                readAsClone = true;
                lastCloneCell = 0;
                const value = invoke(cell, self, []);
                const read = lastCloneCell;
                if (read === 0 || typeof self !== 'object' && typeof self !== 'function' || self === null)
                    return value;
                const earlier = WeakMapPrototypeGet(reads, self);
                if (earlier !== undefined && earlier.cell === read)
                    return earlier.value;
                WeakMapPrototypeSet(reads, self, { cell: read, value });
                return value;
            } catch (e) {
                throw chromeError(e, getter, 'get', owner, name, self, []);
            } finally {
                readAsClone = false;
            }
        },
    };
    const getter = ObjectGetOwnPropertyDescriptor(f, name).get;
    WeakSetPrototypeAdd(nativeFunctions, getter);
    return getter;
}
function makeSetter(name, cell, boundThis, owner) {
    // The accessor's runtime function is held by the page's accessor from now on: rooted, so a property the engine
    // replaces or deletes (a [Replaceable] global such as performance) does not leave the page calling a collected cell
    // ("TypeError: not a function" from get performance, Discord's react-spring loop, 2026-10-22).
    rootAccessorCell(cell);
    const bound = boundThis !== undefined;
    const globalMember = bound && boundThis === G;
    const dateArgument = name === 'valueAsDate';
    const f = {
        set [name](value) {
            const self = bound ? boundThis : (this === undefined || this === null) && owner !== undefined ? G : this;
            if ((globalMember && foreignReceiver(this, boundThis)) || (!bound && owner !== undefined && notWrapper(self))) {
                if (lenientThis(name))
                    return;
                throw illegalInvocation(setter);
            }
            try {
                // valueAsDate takes a Date (WebIDL `object?`, checked for [[DateValue]] in the engine): the page's Date is a V8 object,
                // so it goes over as an engine Date with the same time value.
                invoke(cell, self, [dateArgument && value !== null && typeof value === 'object' && WeakMapPrototypeGet(cellOf, value) === undefined ? cloneForEngine(value, false, null) : value]);
            } catch (e) {
                throw chromeError(e, setter, 'set', owner, name, self, [value]);
            }
        },
    };
    const setter = ObjectGetOwnPropertyDescriptor(f, name).set;
    WeakSetPrototypeAdd(nativeFunctions, setter);
    return setter;
}

// --- Classes from the runtime's prototypes -------------------------------------------------------------------------
// The runtime's %IteratorPrototype% is the host's: an iterator the engine makes (URLSearchParams, Headers, FormData and the
// other iterable interfaces' keys(), values(), entries()) is iterable itself and has the host's iterator helpers.
const HostIterator = function Iterator() {};
HostIterator.prototype = ReflectGetPrototypeOf(ReflectGetPrototypeOf([][SymbolIterator]()));
const INTRINSIC_PARENTS = { __proto__: null, Error: HostError, Function: HostFunction, Array, Object: HostObject, Promise: HostPromise_, Iterator: HostIterator };

// The mirror class for a runtime prototype object, or null when the prototype is one of the
// language's own (Object.prototype and the like), whose V8 counterpart is used instead.
function classForPrototype(protoCell) {
    if (protoCell === 0 || protoCell === objectPrototypeCell)
        return null;
    const cached = MapPrototypeGet(classByProto, protoCell);
    if (cached !== undefined)
        return cached;
    if (foreignObjectOf(protoCell) !== undefined)
        return null; // the page's own prototype: not an interface
    const name = prototypeNameRaw(protoCell);
    if (name === '' || INTRINSIC_PARENTS[name] !== undefined)
        return null;
    const parentCell = vPrototypeCell(protoCell);
    const parentClass = classForPrototype(parentCell);
    let parentIntrinsic = null;
    if (parentClass === null && parentCell !== 0 && parentCell !== objectPrototypeCell) {
        const parentName = prototypeNameRaw(parentCell);
        parentIntrinsic = INTRINSIC_PARENTS[parentName] || null;
    }
    const ctorProp = vOwnProperty(protoCell, keyBits('constructor'));
    let ctorCell = 0;
    if (ctorProp && ctorProp.kind === 1) {
        // Read the constructor cell without materialising a wrapper for it.
        ctorCell = ownValueCell(protoCell, 'constructor');
    }
    const cls = makeClass(name, parentClass || parentIntrinsic, ctorCell);
    MapPrototypeSet(classByProto, protoCell, cls);
    if (!MapPrototypeHas(classByName, name))
        MapPrototypeSet(classByName, name, cls); // the principal realm's (a frame realm's classes come later)
    WeakMapPrototypeSet(cellOf, cls.prototype, protoCell);
    cacheWrapper(protoCell, cls.prototype);
    if (ctorCell) {
        WeakMapPrototypeSet(cellOf, cls, ctorCell);
        cacheWrapper(ctorCell, cls);
        MapPrototypeSet(functionByCell, ctorCell, cls);
    }
    defineMembers(cls.prototype, protoCell, undefined, true);
    if (ctorCell)
        defineMembers(cls, ctorCell, cls, false);
    shapeClass(name, cls);
    return cls;
}
// The toStringTag of a prototype read without converting other values.
function prototypeNameRaw(protoCell) {
    const tag = vOwnProperty(protoCell, keyBits(SymbolToStringTag));
    if (tag && tag.kind === 1 && typeof tag.value === 'string')
        return tag.value;
    const ctorCell = ownValueCell(protoCell, 'constructor');
    if (ctorCell) {
        const name = vGet(ctorCell, 'name');
        if (typeof name === 'string')
            return name;
    }
    return '';
}
// The cell of an own data property whose value is an object, or 0.
function ownValueCell(cell, key) {
    const mark = scratchTop;
    const o = slots(1), flagsPtr = slots(1), value = slots(1), getter = slots(1), setter = slots(1);
    writeObject(o, cell);
    const bits = keyBits(key);
    const kind = X.ganglion_v_own_kind(o, bits);
    if (kind === 0 || kind === 3) {
        scratchTop = mark;
        return 0;
    }
    X.ganglion_v_own_property(o, bits, flagsPtr, value, getter, setter);
    views();
    const flags = u32[flagsPtr >>> 2];
    const result = (flags & PD_HAS_VALUE) && (u32[(value >>> 2) + 1] >>> 16) === TAG_OBJECT ? u32[value >>> 2] : 0;
    scratchTop = mark;
    return result;
}

function makeClass(name, Parent, ctorCell, prototypeObject) {
    // A plain function, not a class: Chrome's interface objects can be called (and then throw their own TypeError, not V8's
    // "Class constructors cannot be invoked without 'new'"), and `new.target` says which it was.
    const construct = (args, newTarget) => {
        if (!ctorCell)
            throw illegalConstructor(cls, true);
        try {
            const out = constructCell(ctorCell, args, newTarget === cls ? undefined : newTarget);
            if (name === 'MessageEvent')
                rememberMessageData(out, args[1]);
            return out;
        } catch (e) {
            throw chromeConstructError(e, cls, args);
        }
    };
    const cls = { [name]: function (...args) {
        if (new.target === undefined)
            throw callWithoutNew(cls, ctorCell !== 0 && constructible(cls));
        return construct(args, new.target);
    } }[name];
    if (prototypeObject !== undefined) {
        // An interface whose prototype object is one that already exists (45-surface.js adoptEventTargetPrototype).
        ObjectDefineProperty(cls, 'prototype', { value: prototypeObject });
        ObjectDefineProperty(prototypeObject, 'constructor', { value: cls, writable: true, enumerable: false, configurable: true });
    }
    if (Parent) {
        ObjectSetPrototypeOf(cls, Parent);
        ObjectSetPrototypeOf(cls.prototype, Parent.prototype);
    }
    ObjectDefineProperty(cls, 'prototype', { writable: false });
    WeakSetPrototypeAdd(nativeFunctions, cls);
    return cls;
}

// Defines the members of the runtime object `cell` on `target`: accessors, operations, constants.
// With `boundThis` the functions are bound to that receiver (the global's members on globalThis).
function defineMembers(target, cell, boundThis, isPrototype) {
    const keys = vOwnKeys(cell);
    for (let i = 0; i < keys.length; i++) {
        const bits = keys[i];
        const key = keyToJS(bits);
        if (key === 'constructor' || (key === 'prototype' && !isPrototype) || (key === 'name' && !isPrototype))
            continue;
        if (key === 'length' && !isPrototype) {
            const lp = vOwnProperty(cell, bits);
            if (lp && lp.kind === 1)
                ObjectDefineProperty(target, 'length', { value: lp.value, writable: false, enumerable: false, configurable: true });
            continue;
        }
        defineMember(target, cell, bits, key, boundThis);
    }
}
// Value-iterable declarations (iterable<T>): WebIDL defines @@iterator, values, keys, entries and forEach on
// the prototype from %Array.prototype%'s functions, which the runtime does not carry; Chrome's are the same
// functions (NodeList.prototype.values === Array.prototype.values) except forEach, which is the interface's own.
const ArrayPrototypeForEach = uncurryThis(Array.prototype.forEach);
const ITERABLE_MEMBERS = { __proto__: null, values: Array.prototype.values, keys: Array.prototype.keys, entries: Array.prototype.entries };
function iterableMember(key) {
    if (key === SymbolIterator)
        return Array.prototype.values;
    if (key === 'forEach') {
        const f = { forEach(callback, thisArg) { ArrayPrototypeForEach(this, callback, thisArg); } }.forEach;
        ObjectDefineProperty(f, 'length', { value: 1, configurable: true });
        WeakSetPrototypeAdd(nativeFunctions, f);
        return f;
    }
    return ITERABLE_MEMBERS[key];
}

function defineMember(target, cell, bits, key, boundThis) {
    const prop = vOwnProperty(cell, bits);
    if (!prop)
        return;
    if (prop.kind === 1 && !prop.valueCell && prop.value === undefined && boundThis === undefined) {
        const fn = iterableMember(key);
        if (fn !== undefined) {
            ObjectDefineProperty(target, key, { value: fn, writable: true, enumerable: key !== SymbolIterator, configurable: true });
            return;
        }
    }
    if (prop.kind === 1 && !prop.valueCell && prop.value === undefined && typeof key === 'string' && !(boundThis === undefined && iterableMember(key) !== undefined)) {
        // A member the engine lists but does not implement (its value is undefined): absent, as in a browser without the feature,
        // so `'preserveAspectRatio' in element` is false instead of true-with-undefined (Chrome's is an accessor).
        return;
    }
    if (prop.kind === 3) {
        // A pending intrinsic (an interface object on the global): resolved on first touch.
        defineLazy(target, cell, key);
        return;
    }
    const enumerable = (prop.flags & PD_ENUMERABLE) !== 0;
    const configurable = (prop.flags & PD_CONFIGURABLE) !== 0;
    const owner = ownerName(cell);
    if (prop.kind === 2 && key === 'all' && owner === 'Document' && boundThis === undefined) {
        // document.all is an HTMLAllCollection with [[IsHTMLDDA]] in a browser: `!!document.all` is false and `typeof` is
        // 'undefined', which is how pages tell old IE from everything else (DuckDuckGo: `isIE = !!document.all`). Script
        // cannot make such an object. The getter answers null: falsy like Chrome's, `== null` and `== undefined` like
        // Chrome's, and unlike undefined it is not `===` to a missing value. polymer-resin (YouTube's sanitizer) passes a
        // falsy value through only when `value !== document.all`: with undefined every unset binding (`hidden` of the
        // search results among them) became its "zClosurez" placeholder, which is truthy, so the results stayed hidden.
        // Left different from Chrome: `typeof document.all` is 'object' (Chrome 'undefined') and `=== null` is true.
        const f = { get all() { return null; } };
        const getter = ObjectGetOwnPropertyDescriptor(f, 'all').get;
        WeakSetPrototypeAdd(nativeFunctions, getter);
        ObjectDefineProperty(target, key, { get: getter, set: undefined, enumerable, configurable });
        return;
    }
    if (prop.kind === 2) {
        const getter = prop.getterCell && prop.getterIsObject ? makeGetter(key, prop.getterCell, boundThis, owner) : undefined;
        const setter = prop.setterCell && prop.setterIsObject ? makeSetter(key, prop.setterCell, boundThis, owner) : undefined;
        ObjectDefineProperty(target, key, { get: getter, set: setter, enumerable, configurable });
        return;
    }
    const writable = (prop.flags & PD_WRITABLE) !== 0;
    const valueCell = prop.valueCell;
    if (valueCell && vObjectKind(valueCell) !== 4) {
        ObjectDefineProperty(target, key, { value: cellToJS(valueCell), writable, enumerable, configurable });
        return;
    }
    if (valueCell) {
        // An interface object (a constructor with an interface prototype) is its mirror class.
        const protoCell = ownValueCell(valueCell, 'prototype');
        if (protoCell && prototypeNameRaw(protoCell) !== '') {
            const cls = classForPrototype(protoCell);
            const value = cls === null ? cellToJS(valueCell) : ownValueCell(protoCell, 'constructor') === valueCell ? cls : legacyFactory(valueCell, cls);
            ObjectDefineProperty(target, key, { value, writable, enumerable, configurable });
            return;
        }
    }
    if (valueCell && vObjectKind(valueCell) === 4) {
        const length = vGet(valueCell, 'length');
        const fn = makeNativeFunction(typeof key === 'symbol' ? '[' + (key.description || '') + ']' : key, valueCell, typeof length === 'number' ? length : 0, boundThis, owner);
        if (boundThis === G && typeof key === 'string' && key.charCodeAt(0) >= 65 && key.charCodeAt(0) <= 90)
            defineCallbackInterfaceConstants(fn, valueCell);
        MapPrototypeSet(functionByCell, valueCell, fn);
        cacheWrapper(valueCell, fn);
        WeakMapPrototypeSet(cellOf, fn, valueCell);
        ObjectDefineProperty(target, key, { value: fn, writable, enumerable, configurable });
        return;
    }
    ObjectDefineProperty(target, key, { value: prop.value, writable, enumerable, configurable });
}
function defineLazy(target, cell, key) {
    ObjectDefineProperty(target, key, {
        get() {
            const value = vGet(cell, key);
            ObjectDefineProperty(target, key, { value, writable: true, enumerable: false, configurable: true });
            return value;
        },
        set(value) {
            ObjectDefineProperty(target, key, { value, writable: true, enumerable: false, configurable: true });
        },
        enumerable: false,
        configurable: true,
    });
}

// --- Wrapping a DOM object ------------------------------------------------------------------------------------------
// The page's own object a foreign cell stands for, or undefined for any other cell.
function foreignObjectOf(cell) {
    if (cell === 0)
        return undefined;
    const mark = scratchTop;
    const vp = slots(1);
    writeObject(vp, cell);
    const kind = X.ganglion_v_object_kind(vp);
    const out = kind === 2 || kind === 3 ? toJS(vp) : undefined;
    scratchTop = mark;
    return out;
}

function wrap(p, cell) {
    const protoCell = vPrototypeCell(cell);
    // The prototype is the page's when the engine took it from NewTarget (a custom element upgraded by a page class): the
    // wrapper inherits from the page's prototype, which inherits from the interface's mirror class.
    const pageProto = foreignObjectOf(protoCell);
    const cls = pageProto === undefined ? classForPrototype(protoCell) : null;
    let wrapper = pageProto !== undefined ? ObjectCreate(pageProto) : cls ? ObjectCreate(cls.prototype) : ObjectCreate(HostObject.prototype);
    WeakMapPrototypeSet(cellOf, wrapper, cell);
    // [LegacyUnforgeable] members are own properties of the runtime wrapper: mirror them.
    const own = vOwnKeys(cell);
    for (let i = 0; i < own.length; i++) {
        const key = keyToJS(own[i]);
        defineMember(wrapper, cell, own[i], key, undefined);
    }
    const flags = vHostFlags(cell);
    if (flags & 3)
        wrapper = exoticProxy(wrapper, cell, flags);
    cacheWrapper(cell, wrapper);
    return wrapper;
}

// Legacy platform objects with indexed or named properties: a Proxy whose traps ask the engine first.
function exoticProxy(target, cell, flags) {
    const indexed = (flags & 1) !== 0, named = (flags & 2) !== 0, unenumerable = (flags & 8) !== 0;
    const ownsKey = (key) => typeof key === 'string' && ((indexed && isArrayIndex(key)) || (named && !ReflectHas(target, key)));
    const proxy = new HostProxy(target, {
        get(t, key, receiver) {
            if (ownsKey(key)) {
                const v = vGet(cell, key);
                if (v !== undefined)
                    return v;
            }
            return ReflectGet(t, key, receiver);
        },
        has(t, key) {
            if (ownsKey(key) && vGet(cell, key) !== undefined)
                return true;
            return ReflectHas(t, key);
        },
        getOwnPropertyDescriptor(t, key) {
            if (ownsKey(key)) {
                const v = vGet(cell, key);
                if (v !== undefined)
                    return { value: v, writable: true, enumerable: typeof key === 'string' && isArrayIndex(key) ? true : !unenumerable, configurable: true };
            }
            return ObjectGetOwnPropertyDescriptor(t, key);
        },
        ownKeys(t) {
            const keys = vOwnKeys(cell);
            const out = [];
            for (let i = 0; i < keys.length; i++) {
                const k = keyToJS(keys[i]);
                if (typeof k === 'string' && ownsKey(k))
                    ArrayPrototypePush(out, k);
            }
            const rest = ReflectOwnKeys(t);
            for (let i = 0; i < rest.length; i++)
                ArrayPrototypePush(out, rest[i]);
            return out;
        },
        set(t, key, value, receiver) {
            if (ownsKey(key)) {
                try {
                    vSet(cell, key, value);
                    return true;
                } catch (e) {
                    throw e;
                }
            }
            return ReflectSet(t, key, value, receiver);
        },
        deleteProperty(t, key) {
            return ReflectDeleteProperty(t, key);
        },
    });
    WeakMapPrototypeSet(cellOf, proxy, cell);
    return proxy;
}

// --- The global ------------------------------------------------------------------------------------------------------
// A replacement of a member of the global (50-frames.js, 52-popups.js): a descriptor, or a function that is given a way to
// define the engine's own member on another object (to wrap it) and returns the descriptor.
function replacementFor(r, defineEngineMember) {
    return typeof r === 'function' ? r(defineEngineMember) : r;
}
function installGlobal() {
    const mark = scratchTop;
    const g = slots(1), op = slots(1);
    X.ganglion_js_global(g);
    X.ganglion_js_object_prototype(op);
    views();
    globalCell = u32[g >>> 2];
    objectPrototypeCell = u32[op >>> 2];
    scratchTop = mark;
    WeakMapPrototypeSet(cellOf, G, globalCell);
    MapPrototypeSet(wrapperByCell, globalCell, G);
    // The Window's members, from its prototype chain, as own properties of the realm's global.
    const chain = [];
    for (let proto = vPrototypeCell(globalCell); proto !== 0 && proto !== objectPrototypeCell; proto = vPrototypeCell(proto))
        ArrayPrototypePush(chain, proto);
    for (let i = chain.length - 1; i >= 0; i--) {
        const protoCell = chain[i];
        const keys = vOwnKeys(protoCell);
        for (let k = 0; k < keys.length; k++) {
            const key = keyToJS(keys[k]);
            if (key === 'constructor' || typeof key === 'symbol')
                continue;
            if (globalReplacements !== null && globalReplacements[key] !== undefined) {
                ObjectDefineProperty(G, key, replacementFor(globalReplacements[key], (target) => defineMember(target, protoCell, keys[k], key, G)));
                continue;
            }
            if (ObjectHasOwn(G, key) && !isWindowMemberWeWant(key))
                continue;
            defineMember(G, protoCell, keys[k], key, G);
        }
        // The prototype itself is an interface prototype (WindowPrototype, EventTargetPrototype): give it a class
        // so `EventTarget.prototype.addEventListener === window.addEventListener` is not required but `Window` exists.
        classForPrototype(protoCell);
    }
    // The global's own properties: [LegacyUnforgeable] accessors (window, document, location) and the
    // lazy interface objects.
    const own = vOwnKeys(globalCell);
    for (let k = 0; k < own.length; k++) {
        const key = keyToJS(own[k]);
        if (typeof key === 'symbol')
            continue;
        // A page's own Workers are not offered yet: the engine's Worker constructor needs the browser's worker
        // machinery, which it does not have (constructing one traps in MessagePort::transfer_steps). The names stay
        // undefined, as in a browser without workers, so a library that feature-detects (canvas-confetti, wasm
        // loaders) takes its main-thread path.
        if (key === 'Worker' || key === 'SharedWorker')
            continue;
        if (globalReplacements !== null && globalReplacements[key] !== undefined) {
            ObjectDefineProperty(G, key, replacementFor(globalReplacements[key], (target) => defineMember(target, globalCell, own[k], key, G)));
            continue;
        }
        if (ObjectHasOwn(G, key) && !isWindowMemberWeWant(key))
            continue;
        defineMember(G, globalCell, own[k], key, G);
    }
    installQueueMicrotask();
    installToString();
    installWasmStreaming();
    shapeSurface();
    snapshotGlobal();
}

// queueMicrotask joins the host's microtask queue, the one promise jobs run on. The engine's own queue ("queue a
// microtask" in LibWeb) is a second queue drained at other moments, so a library that mixes `await` and queueMicrotask
// (Svelte 5 flushes its batches from queueMicrotask and awaits tick()) saw the two out of order and a flush that never
// came. The spec has one queue; this is the nearest the host allows. An exception is reported, not thrown into the queue.
function installQueueMicrotask() {
    if (HostQueueMicrotask === null)
        return;
    const queue = {
        queueMicrotask(callback) {
            if (foreignReceiver(this, G))
                throw illegalInvocation(queue);
            if (typeof callback !== 'function')
                throw typeError("Failed to execute 'queueMicrotask' on 'Window': parameter 1 is not of type 'Function'.");
            HostQueueMicrotask(() => {
                try {
                    callback();
                } catch (e) {
                    try { G.reportError(e); } catch { /* nothing more to do with it */ }
                }
            });
        },
    }.queueMicrotask;
    WeakSetPrototypeAdd(nativeFunctions, queue);
    ObjectDefineProperty(G, 'queueMicrotask', { value: queue, writable: true, enumerable: true, configurable: true });
}

// The global as the mirror left it: every own property's descriptor, so a later document starts from it.
// Real browsers give each document a fresh realm; until M3's anchors bring one per navigation, the page's
// additions to the global (and its overwrites of the mirror's members) are undone by resetGlobal().
// Changes a page made deeper, on prototypes it shares with the next page, stay: a known gap.
const globalBaseline = new HostMap();
function snapshotGlobal() {
    MapPrototypeClear(globalBaseline);
    const keys = ReflectOwnKeys(G);
    for (let i = 0; i < keys.length; i++)
        MapPrototypeSet(globalBaseline, keys[i], ObjectGetOwnPropertyDescriptor(G, keys[i]));
}
function sameDescriptor(a, b) {
    return a.configurable === b.configurable && a.enumerable === b.enumerable && a.writable === b.writable
        && a.value === b.value && a.get === b.get && a.set === b.set;
}
function resetGlobal() {
    if (globalCell === 0)
        return;
    const keys = ReflectOwnKeys(G);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const now = ObjectGetOwnPropertyDescriptor(G, key);
        if (now === undefined)
            continue;
        const was = MapPrototypeGet(globalBaseline, key);
        if (was === undefined) {
            // The page's own global: a `var` from an indirect eval is configurable, as is an assignment.
            // A `var` or function of a real script is not configurable and cannot be deleted: the best a shared
            // realm can do is blank it (typeof says undefined; the name stays until the Worker is recycled).
            if (!ReflectDeleteProperty(G, key) && ObjectHasOwn(now, 'value') && now.writable)
                G[key] = undefined;
            continue;
        }
        if (sameDescriptor(now, was))
            continue;
        if (now.configurable)
            ReflectDefineProperty(G, key, was);
        else if (now.writable && ObjectHasOwn(was, 'value'))
            G[key] = was.value;
    }
}
// Worker globals that the Window's members replace (the Worker's own are hidden by the host script).
const WINDOW_OVERRIDES = { __proto__: null, self: true, location: true, navigator: true, performance: true, addEventListener: true, removeEventListener: true, dispatchEvent: true, setTimeout: true, clearTimeout: true, setInterval: true, clearInterval: true, queueMicrotask: true, requestAnimationFrame: true, cancelAnimationFrame: true, fetch: true, atob: true, btoa: true, structuredClone: true, reportError: true, crypto: true, caches: true, indexedDB: true, localStorage: true, sessionStorage: true, onerror: true, onunhandledrejection: true, name: true, origin: true, isSecureContext: true, crossOriginIsolated: true, scheduler: true, Image: true, Audio: true, Option: true };
const HOST_ONLY_GLOBALS = { __proto__: null, WebAssembly: true };
function isWindowMemberWeWant(key) {
    if (WINDOW_OVERRIDES[key] === true)
        return true;
    if (typeof key !== 'string' || key.length === 0)
        return false;
    const c = StringPrototypeCharCodeAt(key, 0);
    if (c < 65 || c > 90)
        return false;
    // An interface the engine defines is the page's interface even when the host global (a Worker in Chrome) has one
    // of that name: the engine's functions check their arguments against its own classes, so the host's Event is
    // not accepted by the engine's dispatchEvent ("Not an object of type Event"), and the engine's events are not
    // instanceof the host's. Only what is not an engine interface at all (WebAssembly) stays the host's.
    return !HOST_ONLY_GLOBALS[key] || !ObjectHasOwn(G, key);
}

// WebAssembly stays the host's (HOST_ONLY_GLOBALS), but the page's fetch() answers with the engine's Response, which the
// host's compileStreaming and instantiateStreaming refuse ("An argument must be provided, which must be a Response or
// Promise<Response> object": Discord's libdiscore). They take the page's Response here, with the checks of the WebAssembly
// Web API ("compile a potential WebAssembly response": the MIME type, an ok status, a body not used), and compile its bytes.
function installWasmStreaming() {
    const W = G.WebAssembly;
    const PageResponse = G.Response;
    if (W === undefined || typeof PageResponse !== 'function' || typeof W.compileStreaming !== 'function')
        return;
    const hostCompile = W.compile, hostInstantiate = W.instantiate, hostCompileStreaming = W.compileStreaming, hostInstantiateStreaming = W.instantiateStreaming;
    const lower = uncurryThis(HostString.prototype.toLowerCase), split = uncurryThis(HostString.prototype.split);
    const fail = (op, message) => new HostTypeError(`Failed to execute '${op}' on 'WebAssembly': ${message}`);
    async function bytesOf(op, source) {
        const response = await source;
        if (!(response instanceof PageResponse))
            return { host: response };
        const type = response.headers.get('content-type');
        if (type === null || lower(StringPrototypeTrim(split(type, ';')[0])) !== 'application/wasm')
            throw fail(op, "Incorrect response MIME type. Expected 'application/wasm'.");
        if (!response.ok)
            throw fail(op, 'HTTP status code is not ok');
        if (response.bodyUsed)
            throw fail(op, 'Cannot compile WebAssembly.Module from an already read Response');
        return { bytes: await response.arrayBuffer() };
    }
    const methods = {
        compileStreaming(source) {
            return (async () => {
                const got = await bytesOf('compile', source);
                return got.bytes === undefined ? ReflectApply(hostCompileStreaming, W, [got.host]) : ReflectApply(hostCompile, W, [got.bytes]);
            })();
        },
        instantiateStreaming(source, importObject) {
            return (async () => {
                const got = await bytesOf('instantiate', source);
                return got.bytes === undefined ? ReflectApply(hostInstantiateStreaming, W, [got.host, importObject]) : ReflectApply(hostInstantiate, W, [got.bytes, importObject]);
            })();
        },
    };
    for (const name of ['compileStreaming', 'instantiateStreaming']) {
        const was = ObjectGetOwnPropertyDescriptor(W, name);
        WeakSetPrototypeAdd(nativeFunctions, methods[name]);
        ObjectDefineProperty(W, name, { value: methods[name], writable: was.writable, enumerable: was.enumerable, configurable: was.configurable });
    }
}

// Function.prototype.toString prints `[native code]` for everything the mirror made (phase2.md 2.6).
function installToString() {
    const toString = {
        toString() {
            if (typeof this === 'function' && WeakSetPrototypeHas(nativeFunctions, this))
                return 'function ' + this.name + '() { [native code] }';
            try {
                return ReflectApply(FunctionPrototypeToString, this, []);
            } catch (e) {
                // Chrome's stack starts at the caller (the native toString frame is the only one above it)
                throw withStackFrom(e, toString);
            }
        },
    }.toString;
    WeakSetPrototypeAdd(nativeFunctions, toString);
    ObjectDefineProperty(HostFunction.prototype, 'toString', { value: toString, writable: true, enumerable: false, configurable: true });
}

// --- The foreign hooks: the engine using the page's values ---------------------------------------------------------
function makeBridgeImports() {
    const env = { __proto__: null };
    // Anything thrown that is an object becomes an engine Error cell that stands for it (errorTwins gives the page its own
    // value back): an Error, a DOMException (its tag is not Error), an error with a changed toStringTag, a plain object.
    const isThrownObject = (v) => typeof v === 'object' && v !== null;
    const result = (threw, p, value) => {
        try {
            if (threw && isThrownObject(value))
                errorFromJS(value, p);
            else
                fromJS(value, p);
        } catch (e) {
            fromJS(e, p);
            return 1;
        }
        return threw;
    };
    env.ganglion_host_js_get = (h, key, receiver, out) => {
        hostJsTouched = 1;
        try {
            const r = toJS(receiver);
            return result(0, out, ReflectGet(handles[h], keyToJS(key), r));
        } catch (e) {
            return result(1, out, e);
        }
    };
    env.ganglion_host_js_set = (h, key, value, receiver, ok, out) => {
        hostJsTouched = 1;
        try {
            const v = toJS(value), r = toJS(receiver);
            views();
            u32[ok >>> 2] = ReflectSet(handles[h], keyToJS(key), v, r) ? 1 : 0;
            return 0;
        } catch (e) {
            return result(1, out, e);
        }
    };
    env.ganglion_host_js_has = (h, key, outFlag, out) => {
        hostJsTouched = 1;
        try {
            const v = ReflectHas(handles[h], keyToJS(key));
            views();
            u32[outFlag >>> 2] = v ? 1 : 0;
            return 0;
        } catch (e) {
            return result(1, out, e);
        }
    };
    env.ganglion_host_js_delete = (h, key, outFlag, out) => {
        hostJsTouched = 1;
        try {
            const v = ReflectDeleteProperty(handles[h], keyToJS(key));
            views();
            u32[outFlag >>> 2] = v ? 1 : 0;
            return 0;
        } catch (e) {
            return result(1, out, e);
        }
    };
    env.ganglion_host_js_own_keys = (h, out) => {
        try {
            const keys = ReflectOwnKeys(handles[h]);
            for (let i = 0; i < keys.length; i++)
                X.ganglion_keys_push(keyBits(keys[i]));
            return 0;
        } catch (e) {
            return result(1, out, e);
        }
    };
    env.ganglion_host_js_get_own_property = (h, key, flagsPtr, value, getter, setter) => {
        hostJsTouched = 1;
        try {
            const d = ObjectGetOwnPropertyDescriptor(handles[h], keyToJS(key));
            views();
            if (!d) {
                u32[flagsPtr >>> 2] = 0;
                return 0;
            }
            let flags = PD_PRESENT | PD_HAS_ENUMERABLE | PD_HAS_CONFIGURABLE | (d.enumerable ? PD_ENUMERABLE : 0) | (d.configurable ? PD_CONFIGURABLE : 0);
            if ('value' in d) {
                flags |= PD_HAS_VALUE | PD_HAS_WRITABLE | (d.writable ? PD_WRITABLE : 0);
                fromJS(d.value, value);
            } else {
                flags |= PD_HAS_GET | PD_HAS_SET;
                fromJS(d.get, getter);
                fromJS(d.set, setter);
            }
            views();
            u32[flagsPtr >>> 2] = flags;
            return 0;
        } catch (e) {
            fromJS(e, value);
            return 1;
        }
    };
    env.ganglion_host_js_define_own_property = (h, key, flags, value, getter, setter, ok, out) => {
        hostJsTouched = 1;
        try {
            const d = {};
            if (flags & PD_HAS_VALUE) d.value = toJS(value);
            if (flags & PD_HAS_GET) d.get = toJS(getter);
            if (flags & PD_HAS_SET) d.set = toJS(setter);
            if (flags & PD_HAS_WRITABLE) d.writable = (flags & PD_WRITABLE) !== 0;
            if (flags & PD_HAS_ENUMERABLE) d.enumerable = (flags & PD_ENUMERABLE) !== 0;
            if (flags & PD_HAS_CONFIGURABLE) d.configurable = (flags & PD_CONFIGURABLE) !== 0;
            const r = ReflectDefineProperty(handles[h], keyToJS(key), d);
            views();
            u32[ok >>> 2] = r ? 1 : 0;
            return 0;
        } catch (e) {
            return result(1, out, e);
        }
    };
    env.ganglion_host_js_get_prototype_of = (h, out) => {
        try {
            return result(0, out, ReflectGetPrototypeOf(handles[h]));
        } catch (e) {
            return result(1, out, e);
        }
    };
    env.ganglion_host_js_call = (h, thisPtr, argv, argc, out) => {
        hostJsTouched = 1;
        try {
            const args = [];
            for (let i = 0; i < argc; i++)
                args[i] = toJS(argv + i * 8);
            const thisValue = toJS(thisPtr);
            return result(0, out, ReflectApply(handles[h], thisValue, args));
        } catch (e) {
            return result(1, out, e);
        }
    };
    env.ganglion_host_js_construct = (h, argv, argc, newTarget, out) => {
        hostJsTouched = 1;
        try {
            const args = [];
            for (let i = 0; i < argc; i++)
                args[i] = toJS(argv + i * 8);
            const target = toJS(newTarget);
            return result(0, out, ReflectConstruct(handles[h], args, typeof target === 'function' ? target : handles[h]));
        } catch (e) {
            return result(1, out, e);
        }
    };
    // The engine is about to parse a new document into the realm (Host.cpp load_document).
    env.ganglion_host_js_document_reset = () => {
        documentsReset++;
        resetGlobal();
        resetFrameRealms();
        if (typeof callbacks.documentReset === 'function')
            callbacks.documentReset();
    };
    env.ganglion_host_js_drop = (h) => {
        const value = handles[h];
        if (value !== undefined) {
            WeakMapPrototypeDelete(handleOf, value);
            handles[h] = undefined;
            foreignCellByHandle[h] = undefined;
            ArrayPrototypePush(freeHandles, h);
        }
    };
    env.ganglion_host_js_run_script = (src, len, ascii, fname, flen, fascii, lineOffset, out) => {
        hostJsTouched = 1;
        const source = readText(src, len, ascii);
        const filename = readText(fname, flen, fascii);
        scriptsRun++;
        syncNamedProperties();
        try {
            // A classic script is a Script, not an eval: top-level let/const/class are shared by all of
            // the page's scripts, vars are not configurable, and there is no eval frame in a stack
            // (docs/security.md 4.1). The host that can run scripts for real provides options.runScript
            // (the Worker: importScripts through the service worker; Node: vm.Script); without one the
            // glue falls back to indirect eval.
            let value;
            const frameRealm = frameRealmOfCurrentScript();
            if (frameRealm !== null) {
                // A same-site frame's script: against the frame's global (55-realms.js).
                value = runFrameScript(frameRealm, '\n'.repeat(lineOffset > 1 ? lineOffset - 1 : 0) + source, filename);
                return result(0, out, value);
            }
            if (typeof callbacks.runScript !== 'function') {
                value = indirectEval(source + '\n//# sourceURL=' + filename);
            } else {
                try {
                    value = callbacks.runScript(source, filename, lineOffset);
                } catch (e) {
                    // A realm cannot forget its global lexical declarations: after a navigation the previous
                    // document's top-level let/const/class are still there. Until the host recycles the
                    // realm per document, a script that collides with one of them runs as an eval (its
                    // lexicals private to it) instead of failing the new page. Only after a reset: within one
                    // document a redeclaration is the page's own error, as in Chrome.
                    if (documentsReset > 1 && e && e.name === 'SyntaxError' && /has already been declared/.test(e.message))
                        value = indirectEval(source + '\n//# sourceURL=' + filename);
                    else
                        throw e;
                }
            }
            if (callbacks.scriptRun)
                callbacks.scriptRun(filename, source.length, indirectEval('this') === G, typeof G.qs, typeof G.app);
            syncFrameIndices();
            syncNamedProperties();
            return result(0, out, value);
        } catch (e) {
            if (callbacks.scriptError)
                callbacks.scriptError(filename, e);
            return result(1, out, e);
        }
    };
    // A module script (<script type=module>): the host's engine loads it and its imports itself (the module loader of
    // the segment's service worker, docs/phase2.md 2.3), so the engine's record has no requested modules and
    // Evaluate settles with the promise the host returns. An external module keeps its URL; an inline one has the
    // document's, which the host cannot import twice, so it gets a query naming it (relative imports still resolve
    // against the document's path).
    let inlineModules = 0;
    let moduleQueue = HostPromise_.resolve();
    const moduleFailed = (e) => {
        if (typeof e === 'object' && e !== null && WeakMapPrototypeGet(moduleErrorCells, e) === undefined) {
            const mark = scratchTop;
            const p = slots(1);
            try {
                errorFromJS(e, p);
                views();
                WeakMapPrototypeSet(moduleErrorCells, e, u32[p >>> 2]);
            } catch { /* left as it was */ }
            scratchTop = mark;
        }
        throw e;
    };
    const noop = () => {};
    env.ganglion_host_js_run_module = (src, len, ascii, fname, flen, fascii, lineOffset, out) => {
        hostJsTouched = 1;
        const source = readText(src, len, ascii);
        let filename = readText(fname, flen, fascii);
        scriptsRun++;
        try {
            if (typeof callbacks.runModule !== 'function')
                throw new HostTypeError('Module scripts are not available in this host');
            const frameRealm = frameRealmOfCurrentScript();
            if (frameRealm !== null) {
                // A same-site frame's module: its own module graph, under the realm's name (55-realms.js). In order, as below.
                const startFrame = () => runFrameModule(frameRealm, source, filename, lineOffset);
                const frameValue = PromisePrototypeThen(PromisePrototypeThen(moduleQueue, startFrame, startFrame), undefined, moduleFailed);
                moduleQueue = PromisePrototypeThen(frameValue, noop, noop);
                return result(0, out, frameValue);
            }
            let documentUrl = '';
            try { documentUrl = String(indirectEval('location.href')).replace(/#.*$/, ''); } catch (e) { documentUrl = ''; }
            if (filename.replace(/#.*$/, '') === documentUrl)
                filename = documentUrl + (documentUrl.includes('?') ? '&' : '?') + '__chitin_module=' + (++inlineModules);
            // Module scripts run one after the other, in the order the engine asks (document order: LibWeb runs them
            // in order, but the host's import settles on its own time). The next starts when the last has settled.
            const start = () => {
                if (callbacks.scriptRun)
                    callbacks.scriptRun(filename, source.length, true, typeof G.qs, typeof G.app);
                return callbacks.runModule(source, filename, lineOffset);
            };
            const value = PromisePrototypeThen(PromisePrototypeThen(moduleQueue, start, start), undefined, moduleFailed);
            moduleQueue = PromisePrototypeThen(value, noop, noop);
            return result(0, out, value);
        } catch (e) {
            if (callbacks.scriptError)
                callbacks.scriptError(filename, e);
            return result(1, out, e);
        }
    };
    // Functions from source text: an event handler's content attribute (EventTarget.cpp, "get the current value of the
    // event handler"). The engine checks the parameters and the body when it first needs the handler (the parser's early
    // errors; the function is built and dropped), and asks for the function when it has the scope: the element, its form
    // owner and the document as with-statements around the function's source, the way the specification's
    // NewObjectEnvironment(…, true, …) scopes work. The function keeps its source text (toString), its name and its
    // sloppy-mode body; the global scope is the page's global, the realm's.
    env.ganglion_host_js_check_function = (paramsPtr, paramsLen, paramsAscii, bodyPtr, bodyLen, bodyAscii, kind, out) => {
        const parameters = readText(paramsPtr, paramsLen, paramsAscii);
        const body = readText(bodyPtr, bodyLen, bodyAscii);
        try {
            dynamicFunctionConstructor(kind)(parameters, body);
            return 0;
        } catch (e) {
            return result(1, out, HostString(e && e.message !== undefined ? e.message : e));
        }
    };
    env.ganglion_host_js_instantiate_function = (srcPtr, srcLen, srcAscii, paramsPtr, paramsLen, paramsAscii, bodyPtr, bodyLen, bodyAscii, kind, scopesPtr, scopeCount, noop, out) => {
        try {
            if (noop)
                return result(0, out, function () {});
            const source = readText(srcPtr, srcLen, srcAscii);
            // A frame realm's handler: the realm's global object comes last (Bridge.cpp); the scopes are inside the frame's.
            let frameRealm = null;
            if (frameRealmsOn && scopeCount > 0) {
                views();
                frameRealm = frameRealmOfGlobalCell(u32[(scopesPtr + (scopeCount - 1) * 8) >>> 2]);
                if (frameRealm !== null)
                    scopeCount--;
            }
            const scopes = [];
            for (let i = 0; i < scopeCount; i++)
                scopes[i] = toJS(scopesPtr + i * 8);
            if (frameRealm !== null)
                return result(0, out, frameHandlerFactory(frameRealm, scopeCount, source)(frameRealm.runtime, scopes));
            // Innermost first in `scopes`: the innermost with-statement is the first.
            let code = '';
            for (let i = scopeCount - 1; i >= 0; i--)
                code += 'with (__chitin_scopes[' + i + ']) ';
            const factory = HostFunction('__chitin_scopes', code + 'return (' + source + '\n);');
            return result(0, out, factory(scopes));
        } catch (e) {
            return result(1, out, e);
        }
    };
    env.ganglion_host_js_json_parse = (text, len, ascii, out) => {
        try {
            return result(0, out, JSONParse(readText(text, len, ascii)));
        } catch (e) {
            return result(1, out, e);
        }
    };
    env.ganglion_host_js_json_stringify = (value, replacer, space, out) => {
        try {
            const s = JSONStringify(toJS(value), toJS(replacer), toJS(space));
            return result(0, out, s);
        } catch (e) {
            return result(1, out, e);
        }
    };
    // The engine calling out into page JS: a context exists under everything these run.
    for (const name of ['ganglion_host_js_get', 'ganglion_host_js_set', 'ganglion_host_js_has', 'ganglion_host_js_delete', 'ganglion_host_js_own_keys',
        'ganglion_host_js_get_own_property', 'ganglion_host_js_define_own_property', 'ganglion_host_js_get_prototype_of', 'ganglion_host_js_call',
        'ganglion_host_js_construct', 'ganglion_host_js_run_script', 'ganglion_host_js_run_module']) {
        const inner = env[name];
        env[name] = function () {
            hostDepth++;
            let r;
            try {
                r = ReflectApply(inner, undefined, arguments);
            } finally {
                hostDepth--;
            }
            // The engine stopped under this call (a trap or a stack overflow in a nested engine call, which the page's code
            // between saw as an exception it may catch): the engine's frames below are not resumed, so no microtask or
            // clean-up step runs on the broken state; the stop unwinds to the outermost call, which refuses from then on.
            if (unwoundError !== null)
                settleUnwound();
            if (stoppedReason !== null)
                throw new HostError('ganglion: the engine stopped: ' + stoppedReason);
            return r;
        };
    }
    return env;
}

// --- The API for the segment host ----------------------------------------------------------------------------------
// Page JavaScript from now on: the engine runs scripts through V8 in this realm, and the Window's
// surface appears on the global. After start().
api.enableScripting = () => {
    scratchInit();
    for (let i = 0; i < WELL_KNOWN.length; i++) {
        wellKnownSymbols[i] = HostSymbol[WELL_KNOWN[i]];
        wellKnownKeys[i] = X.ganglion_key_well_known(i);
    }
    X.ganglion_js_enable();
    prepareFrames();
    preparePopups();
    installGlobal();
    enableFrameRealms(callbacks.frameRealms === true);
    scriptingOn = true;
    installFrames();
    installPopups();
    if (callbacks.streams) {
        callbacks.streams.bind(G); // the page's stream classes, before page code can replace them
        callbacks.streams.setPump(() => api.pump()); // what the host settles for a stream is not an engine turn
    }
};

// Runs source in the page's realm (tests and the harness only; never reachable from page code), on a
// script-having execution context so bindings that need the incumbent realm work.
// The Window of the page's workers' environment for an origin (Host.cpp worker_environment_global): its indexedDB and
// IDBKeyRange serve the page's service worker and workers (harness/segment/pagesw-host.js). null when there is none.
api.workerEnvironment = (url) => {
    if (typeof X.ganglion_worker_environment !== 'function')
        return null;
    const text = HostString(url);
    const ptr = copyInString(text);
    const mark = scratchTop;
    const out = slots(1);
    let result = null;
    try {
        if (X.ganglion_worker_environment(ptr, TypedArrayLength(TextEncoderPrototypeEncode(encoderUtf8, text)), out))
            result = toJS(out);
    } finally {
        scratchTop = mark;
        X.ganglion_free(ptr);
    }
    return result;
};

api.evalInPage = (source) => {
    X.ganglion_js_enter();
    hostDepth++;
    try {
        return indirectEval(source);
    } finally {
        syncFrameIndices();
        syncNamedProperties();
        hostDepth--;
        X.ganglion_js_leave();
        api.pump();
    }
};

// The bytes of a URL fetched by the engine itself (its network stack over Spiracle: TLS, the cookie jar, CORS against the
// document's origin), for the segment's module loader: the service worker answers a module's imports with these. It is the
// engine's own `fetch` read from the engine's global, not the page's `window.fetch`: a page (a proxy, a polyfill) may have
// replaced that one, and the loader must not run page code. Resolves { status, contentType, body: ArrayBuffer }.
api.fetchBytes = async (url) => {
    const f = vGet(globalCell, 'fetch');
    const response = await ReflectApply(f, G, [HostString(url), { __proto__: null, credentials: 'same-origin', redirect: 'follow' }]);
    const body = await response.arrayBuffer();
    const type = response.headers.get('content-type');
    return { __proto__: null, status: response.status, contentType: typeof type === 'string' ? type : null, body };
};

// The names a frame realm's module binds in its prologue (harness/segment/sw.js asks, through the host, for each module of
// a frame's module graph): see 55-realms.js.
api.frameModuleBindings = (realmId, text) => frameModuleBindings(realmId, HostString(text));

// A function the segment host made for the page's surface (harness/segment/eme.js) prints as a native one, as the mirror's do.
api.markNative = (f) => {
    if (typeof f === 'function')
        WeakSetPrototypeAdd(nativeFunctions, f);
};

// Counters for the numbers.
api.mirrorStats = () => ({ __proto__: null, classes: classByProto.size, wrappers: wrapperByCell.size, handles: handles.length - freeHandles.length, scriptsRun });

// What the engine returns for a property of the global, before conversion (debugging).
api.mirrorProbe = (key) => {
    const mark = scratchTop;
    const o = slots(1), r = slots(1);
    writeObject(o, globalCell);
    const threw = X.ganglion_v_get(o, keyBits(key), r);
    views();
    const lo = u32[r >>> 2], hi = u32[(r >>> 2) + 1];
    const out = { __proto__: null, threw, lo, tag: (hi >>> 16).toString(16) };
    if ((hi >>> 16) === TAG_OBJECT) {
        out.kind = X.ganglion_v_object_kind(r);
        out.className = vClassName(lo);
        out.flags = vHostFlags(lo);
        out.cached = MapPrototypeGet(wrapperByCell, lo) === G ? 'G' : MapPrototypeGet(wrapperByCell, lo) !== undefined ? 'cached' : 'none';
    }
    scratchTop = mark;
    return out;
};

// What the mirror sees of the global (debugging the install).
api.mirrorDebug = () => {
    const out = { __proto__: null, globalCell, objectPrototypeCell, chain: [] };
    let proto = vPrototypeCell(globalCell);
    out.ownKeys = vOwnKeys(globalCell).length;
    out.ownKind = vObjectKind(globalCell);
    out.className = vClassName(globalCell);
    for (let i = 0; proto !== 0 && i < 8; i++) {
        const keys = vOwnKeys(proto);
        const names = [];
        for (let k = 0; k < MathMin(keys.length, 6); k++)
            ArrayPrototypePush(names, HostString(keyToJS(keys[k])));
        ArrayPrototypePush(out.chain, { __proto__: null, cell: proto, name: prototypeNameRaw(proto), keys: keys.length, sample: names });
        proto = vPrototypeCell(proto);
    }
    return out;
};
