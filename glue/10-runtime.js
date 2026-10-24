// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
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
