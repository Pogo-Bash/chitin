// SPDX-License-Identifier: GPL-2.0-only
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
