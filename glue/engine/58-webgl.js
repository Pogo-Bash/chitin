// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin engine glue: WebGL's executor (engine/platform/WebGL.cpp, docs/webgl.md). LibWeb's WebGL contexts record
// their calls as a command stream; the engine replays it with Ladybird's GPU-process executor, whose GL ES calls
// (GLFunctions, ANGLE's names) arrive here and run on a WebGL context of the segment Worker's own: one host
// OffscreenCanvas per page context, created by the glue and never reachable from page script. The answers to
// queries (getParameter, extensions, precision formats, errors, info logs) are therefore the host browser's.
//
// GL names: the engine works in GL integer names; the host in WebGL objects. Each host context keeps a table
// name -> object (and the reverse, for getParameter answers that are objects). Uniform locations get names too.
// Pointers are into the engine's linear memory; "offset" pointers (vertex attribs, indices, pixel buffers bound)
// are passed on as numbers, as WebGL takes them.
//
// Every host method is captured when the glue loads (uncurried from the prototypes), before any page script.

const HostOffscreenCanvas = globalThis.OffscreenCanvas;
const HostWebGL1 = globalThis.WebGLRenderingContext;
const HostWebGL2 = globalThis.WebGL2RenderingContext;
// A host without these (Node tests, a fake global) has no WebGL: every capture tolerates their absence.
const webglMethodOf = (ctor, name) => (ctor && ctor.prototype && typeof ctor.prototype[name] === 'function' ? uncurryThis(ctor.prototype[name]) : null);
const webglSetterOf = (ctor, name) => {
    const d = ctor && ctor.prototype && ObjectGetOwnPropertyDescriptor(ctor.prototype, name);
    return d && d.set ? uncurryThis(d.set) : null;
};
const OffscreenCanvasGetContext = webglMethodOf(HostOffscreenCanvas, 'getContext');
const OffscreenCanvasSetWidth = webglSetterOf(HostOffscreenCanvas, 'width');
const OffscreenCanvasSetHeight = webglSetterOf(HostOffscreenCanvas, 'height');
const EventTargetAddEventListener = webglMethodOf(globalThis.EventTarget, 'addEventListener');
const EventPreventDefault = webglMethodOf(globalThis.Event, 'preventDefault');
const WebGLTypedArrayLength = uncurryThis(ObjectGetOwnPropertyDescriptor(ObjectGetPrototypeOf(Uint16Array.prototype), 'length').get);
const WeakMapGet = uncurryThis(WeakMap.prototype.get);
const WeakMapSet = uncurryThis(WeakMap.prototype.set);
const WebGLInt8Array = globalThis.Int8Array;
const WebGLInt16Array = globalThis.Int16Array;
const WebGLInt32Array = globalThis.Int32Array;
const WebGLUint8Array = globalThis.Uint8Array;
const WebGLBigInt64Array = globalThis.BigInt64Array;
const WebGLBigInt = globalThis.BigInt;
const WebGLArrayIsArray = globalThis.Array.isArray;
const WebGLImageData = globalThis.ImageData;
const WebGLUint8ClampedArray = globalThis.Uint8ClampedArray;
const WebGLTypedArraySet = uncurryThis(ObjectGetPrototypeOf(Uint8Array.prototype).set);

// The prototype methods of each host context kind, uncurried: M[name](gl, ...args).
function captureMethods(proto) {
    const methods = { __proto__: null };
    if (!proto)
        return methods;
    const names = HostReflect.ownKeys(proto);
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (typeof name !== 'string')
            continue;
        const d = ObjectGetOwnPropertyDescriptor(proto, name);
        if (d && typeof d.value === 'function')
            methods[name] = uncurryThis(d.value);
    }
    return methods;
}
const WebGL1Methods = captureMethods(HostWebGL1 && HostWebGL1.prototype);
const WebGL2Methods = captureMethods(HostWebGL2 && HostWebGL2.prototype);
// Extension objects' methods, captured on first use from the host's own prototype (page script cannot reach them:
// the host extension objects never leave the glue).
const extensionMethodCache = new WeakMap();
function extensionMethods(ext) {
    const proto = ObjectGetPrototypeOf(ext);
    let methods = WeakMapGet(extensionMethodCache, proto);
    if (!methods) {
        methods = captureMethods(proto);
        WeakMapSet(extensionMethodCache, proto, methods);
    }
    return methods;
}

const ObjectPrototypeToStringWebGL = uncurryThis(HostObject.prototype.toString);
const getterOf = (ctor, name) => {
    const d = ctor && ctor.prototype && ObjectGetOwnPropertyDescriptor(ctor.prototype, name);
    return d && d.get ? uncurryThis(d.get) : null;
};
const ActiveInfoName = getterOf(globalThis.WebGLActiveInfo, 'name');
const ActiveInfoSize = getterOf(globalThis.WebGLActiveInfo, 'size');
const ActiveInfoType = getterOf(globalThis.WebGLActiveInfo, 'type');
const PrecisionRangeMin = getterOf(globalThis.WebGLShaderPrecisionFormat, 'rangeMin');
const PrecisionRangeMax = getterOf(globalThis.WebGLShaderPrecisionFormat, 'rangeMax');
const PrecisionPrecision = getterOf(globalThis.WebGLShaderPrecisionFormat, 'precision');
const JSONQuote = (s) => {
    let out = '"';
    for (let i = 0; i < s.length; i++) {
        const c = StringPrototypeCharCodeAtWebGL(s, i);
        if (c === 0x22 || c === 0x5C) out += '\\' + StringFromCharCode(c);
        else if (c < 0x20 || c > 0x7E) out += '\\u' + StringPrototypePadStartWebGL(NumberPrototypeToStringWebGL(c, 16), 4, '0');
        else out += StringFromCharCode(c);
    }
    return out + '"';
};
const StringPrototypeCharCodeAtWebGL = uncurryThis(HostString.prototype.charCodeAt);
const StringPrototypePadStartWebGL = uncurryThis(HostString.prototype.padStart);
const NumberPrototypeToStringWebGL = uncurryThis(HostNumber.prototype.toString);

// A host answer as JSON for the engine (patch 0064, glHostQueryCHITIN): null, booleans, numbers ({"nan":1} for NaN),
// strings, ["Float32Array", [...]] for typed arrays, plain arrays, {"info":[name,size,type]} for WebGLActiveInfo,
// {"prec":[min,max,precision]}, and {"o":name} for any other object (the engine answers objects itself).
function hostJSON(C, v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return NumberIsFinite(v) ? NumberPrototypeToStringWebGL(v) : (v !== v ? '{"nan":1}' : (v > 0 ? '{"inf":1}' : '{"inf":-1}'));
    if (typeof v === 'string') return JSONQuote(v);
    if (typeof v === 'bigint') return NumberPrototypeToStringWebGL(HostNumber(v));
    const tag = ObjectPrototypeToStringWebGL(v);
    if (WebGLIsView(v)) {
        const n = WebGLTypedArrayLength(v);
        let out = '[' + JSONQuote(StringPrototypeSliceWebGL(tag, 8, -1)) + ',[';
        for (let i = 0; i < n; i++) out += (i ? ',' : '') + hostJSON(C, v[i]);
        return out + ']]';
    }
    if (WebGLArrayIsArray(v)) {
        let out = '[';
        for (let i = 0; i < v.length; i++) out += (i ? ',' : '') + hostJSON(C, v[i]);
        return out + ']';
    }
    if (tag === '[object WebGLActiveInfo]')
        return '{"info":[' + JSONQuote(ActiveInfoName(v)) + ',' + ActiveInfoSize(v) + ',' + ActiveInfoType(v) + ']}';
    if (tag === '[object WebGLShaderPrecisionFormat]')
        return '{"prec":[' + PrecisionRangeMin(v) + ',' + PrecisionRangeMax(v) + ',' + PrecisionPrecision(v) + ']}';
    return '{"o":' + nameOf(C, v) + '}';
}
const StringPrototypeSliceWebGL = uncurryThis(HostString.prototype.slice);

// The host calls glHostQueryCHITIN stands for, by kind (LibWeb's WebGLRenderingContextBase::HostQuery).
function hostQuery(C, kind, obj, a, b, c) {
    const gl = C.gl, M = C.M, o = object(C, obj);
    switch (kind) {
    case 1: return M.getParameter(gl, a);
    case 2: return M.getTexParameter(gl, a, b);
    case 3: return M.getBufferParameter(gl, a, b);
    case 4: return M.getRenderbufferParameter(gl, a, b);
    case 5: return M.getVertexAttrib(gl, a >>> 0, b);
    case 6: return M.getShaderPrecisionFormat(gl, a, b);
    case 7: return M.getProgramParameter(gl, o, a);
    case 8: return M.getShaderParameter(gl, o, a);
    case 9: return M.getSamplerParameter(gl, o, a);
    case 10: return M.getQueryParameter(gl, o, a);
    case 11: return M.getIndexedParameter(gl, a, b >>> 0);
    case 12: return M.getInternalformatParameter(gl, a, b, c);
    case 13: return M.getActiveUniform(gl, o, a >>> 0);
    case 14: return M.getActiveAttrib(gl, o, a >>> 0);
    case 15: return M.getTransformFeedbackVarying(gl, o, a >>> 0);
    case 16: return M.getActiveUniformBlockName(gl, o, a >>> 0);
    case 17: return M.getFramebufferAttachmentParameter(gl, a, b, c);
    case 18: return M.getUniform(gl, o, a < 0 ? null : (C.locations[a] || null));
    case 19: return M.getActiveUniformBlockParameter(gl, o, a >>> 0, b);
    case 20: return M.getQuery(gl, a, b);
    case 21: {
        const ext = C.ext.WEBGL_debug_shaders || (C.ext.WEBGL_debug_shaders = M.getExtension(gl, 'WEBGL_debug_shaders'));
        return ext ? extensionMethods(ext).getTranslatedShaderSource(ext, o) : null;
    }
    case 22: return C.extensionResult;
    default: return null;
    }
}

// {"e":"NAME","m":"name","a":[1,true,[1,2],0.5,null]} as the engine writes it (WebGLRenderingContextBase::host_extension_call).
function parseExtensionCall(text) {
    let i = 0;
    const ws = () => { while (text[i] === ' ') i++; };
    const value = () => {
        ws();
        const ch = text[i];
        if (ch === '"') {
            let out = '';
            i++;
            while (i < text.length && text[i] !== '"') out += text[i++];
            i++;
            return out;
        }
        if (ch === '[') {
            const list = [];
            i++;
            ws();
            if (text[i] === ']') { i++; return list; }
            for (;;) {
                list[list.length] = value();
                ws();
                if (text[i] === ',') { i++; continue; }
                i++;
                return list;
            }
        }
        if (StringPrototypeStartsWith(text, 'true', i)) { i += 4; return true; }
        if (StringPrototypeStartsWith(text, 'false', i)) { i += 5; return false; }
        if (StringPrototypeStartsWith(text, 'null', i)) { i += 4; return null; }
        let start = i;
        while (i < text.length && text[i] !== ',' && text[i] !== ']' && text[i] !== '}' && text[i] !== ' ') i++;
        return +StringPrototypeSliceWebGL(text, start, i);
    };
    const result = { __proto__: null, e: '', m: '', a: [] };
    i = 1; // past '{'
    for (;;) {
        ws();
        if (text[i] !== '"') break;
        const key = value();
        ws(); i++; // ':'
        result[key] = value();
        ws();
        if (text[i] === ',') { i++; continue; }
        break;
    }
    return result;
}

const webglContexts = { __proto__: null };
let nextWebGLHandle = 1;
let currentWebGL = null;

// GL ES names of extensions the engine may ask for -> WebGL names (the engine asks by WebGL name; these are kept for
// a request made by the GL name).
const GL_TO_WEBGL_EXTENSION = {
    __proto__: null,
    GL_ANGLE_instanced_arrays: 'ANGLE_instanced_arrays',
    GL_OES_vertex_array_object: 'OES_vertex_array_object',
    GL_EXT_draw_buffers: 'WEBGL_draw_buffers',
};

// Typed-array constructor for pixel data of a GL type.
function pixelArrayFor(type) {
    switch (type) {
    case 0x1400: return WebGLInt8Array;                       // BYTE
    case 0x1402: return WebGLInt16Array;                      // SHORT
    case 0x1403: case 0x8363: case 0x8033: case 0x8034:       // UNSIGNED_SHORT, 5_6_5, 4_4_4_4, 5_5_5_1
    case 0x140B: case 0x8D61: return Uint16Array;             // HALF_FLOAT, HALF_FLOAT_OES
    case 0x1404: return WebGLInt32Array;                      // INT
    case 0x1405: case 0x8368: case 0x8C3B: case 0x8C3E:       // UNSIGNED_INT, 2_10_10_10_REV, 10F_11F_11F_REV, 5_9_9_9_REV
    case 0x84FA: return Uint32Array;                          // UNSIGNED_INT_24_8
    case 0x1406: return Float32Array;                         // FLOAT
    default: return WebGLUint8Array;
    }
}

// A view of `bytes` bytes of linear memory at `ptr` as `Ctor` elements; copied when misaligned. The view goes only
// to host WebGL methods.
function memoryView(Ctor, ptr, bytes) {
    views();
    const size = Ctor.BYTES_PER_ELEMENT;
    const count = MathFloor(bytes / size);
    if (ptr % size === 0)
        return new Ctor(viewBuffer, ptr, count);
    const copy = new WebGLUint8Array(count * size);
    for (let i = 0; i < count * size; i++)
        copy[i] = u8[ptr + i];
    return new Ctor(copy.buffer, 0, count);
}

function i32View() { views(); return new WebGLInt32Array(viewBuffer); }
function f32View() { views(); return new Float32Array(viewBuffer); }

function webglCreate(version, depth, stencil, antialias, width, height, alpha, premultipliedAlpha) {
    if (!HostOffscreenCanvas || !OffscreenCanvasGetContext || !OffscreenCanvasSetWidth || (version === 2 ? !HostWebGL2 : !HostWebGL1))
        return 0;
    let canvas;
    let gl;
    try {
        canvas = new HostOffscreenCanvas(width, height);
        // Page attributes the executor carries; the drawing buffer is preserved because the engine clears it
        // itself when a non-preserving page context presents (HostWebGLContext).
        gl = OffscreenCanvasGetContext(canvas, version === 2 ? 'webgl2' : 'webgl', {
            __proto__: null, alpha: alpha !== 0, depth: !!depth, stencil: !!stencil, antialias: !!antialias,
            premultipliedAlpha: true, preserveDrawingBuffer: true,
        });
    } catch (e) {
        return 0;
    }
    if (!gl)
        return 0;
    const handle = nextWebGLHandle++;
    const C = {
        __proto__: null,
        handle, canvas, gl, version,
        premultiplied: premultipliedAlpha !== 0, // the page's premultipliedAlpha: presentation premultiplies when false
        M: version === 2 ? WebGL2Methods : WebGL1Methods,
        objects: { __proto__: null },  // name -> host object
        names: new WeakMap(),          // host object -> name
        nextName: 1,
        locations: { __proto__: null }, // location name -> WebGLUniformLocation
        nextLocation: 0,
        syncs: { __proto__: null },
        nextSync: 8,
        ext: { __proto__: null },       // enabled host extensions by WebGL name
        strings: { __proto__: null },   // GL string pointers, freed with the context
        packBuffer: 0, unpackBuffer: 0,
        mapped: null,
        lost: false,
        fresh: true,
        dirty: true,
        readOnce: false,
    };
    webglContexts[handle] = C;
    if (EventTargetAddEventListener) {
        EventTargetAddEventListener(canvas, 'webglcontextlost', (event) => {
            EventPreventDefault(event); // the host may restore it; the page's context is told either way
            C.lost = true;
            if (webglContexts[handle] && X) {
                X.ganglion_webgl_context_event(handle, 0);
                api.pump();
            }
        });
        EventTargetAddEventListener(canvas, 'webglcontextrestored', () => {
            if (webglContexts[handle] && X) {
                X.ganglion_webgl_context_event(handle, 1);
                api.pump();
            }
        });
    }
    currentWebGL = C;
    return handle;
}

function remember(C, object) {
    if (!object)
        return 0;
    const name = C.nextName++;
    C.objects[name] = object;
    WeakMapSet(C.names, object, name);
    return name;
}

function object(C, name) {
    return name ? (C.objects[name] || null) : null;
}

function nameOf(C, value) {
    if (value === null || value === undefined)
        return 0;
    return WeakMapGet(C.names, value) || 0;
}

function forget(C, name) {
    delete C.objects[name];
}

// Writes a getParameter-style answer as `kind` ('i' int32, 'u' uint32, 'f' float32, 'b' GLboolean, 'l' int64) values
// at `ptr`, at most `max` of them; returns how many it wrote.
function writeValues(C, value, kind, ptr, max) {
    views();
    let values;
    if (value === null || value === undefined)
        values = [0];
    else if (typeof value === 'boolean')
        values = [value ? 1 : 0];
    else if (typeof value === 'number')
        values = [value];
    else if (typeof value === 'object' && WebGLArrayIsArray(value))
        values = value;
    else if (typeof value === 'object' && WebGLIsView(value)) {
        const n = WebGLTypedArrayLength(value);
        values = [];
        for (let i = 0; i < n; i++)
            values[i] = value[i];
    } else if (typeof value === 'object')
        values = [nameOf(C, value)];
    else
        values = [0];
    const n = MathMin(values.length, max);
    if (kind === 'f') {
        const f = f32View();
        for (let i = 0; i < n; i++)
            f[(ptr >>> 2) + i] = +values[i];
    } else if (kind === 'b') {
        for (let i = 0; i < n; i++)
            u8[ptr + i] = values[i] ? 1 : 0;
    } else if (kind === 'l') {
        const l = new WebGLBigInt64Array(viewBuffer);
        for (let i = 0; i < n; i++)
            l[(ptr >>> 3) + i] = WebGLBigInt(typeof values[i] === 'boolean' ? (values[i] ? 1 : 0) : MathFloor(+values[i]));
    } else {
        const v = i32View();
        for (let i = 0; i < n; i++) {
            const x = values[i];
            v[(ptr >>> 2) + i] = typeof x === 'boolean' ? (x ? 1 : 0) : (kind === 'i' && typeof x === 'number' && !NumberIsFinite(x) ? 0 : x);
        }
    }
    return n;
}
const WebGLIsView = HostArrayBuffer.isView;

function setLength(ptr, n) {
    if (ptr)
        i32View()[ptr >>> 2] = n;
}

// A string into a GL out buffer: at most bufSize-1 bytes and a NUL; *length = bytes written (without the NUL).
function webglWriteString(s, bufSize, lengthPtr, out) {
    const bytes = TextEncoderPrototypeEncode(encoderUtf8, s || '');
    let n = 0;
    if (bufSize > 0 && out) {
        views();
        n = MathMin(bytes.length, bufSize - 1);
        for (let i = 0; i < n; i++)
            u8[out + i] = bytes[i];
        u8[out + n] = 0;
    }
    setLength(lengthPtr, n);
}

function cStringArray(count, ptr) {
    const v = i32View();
    const list = [];
    for (let i = 0; i < count; i++)
        list[i] = cString(v[(ptr >>> 2) + i] >>> 0);
    return list;
}

function uintArray(count, ptr) {
    const v = i32View();
    const list = [];
    for (let i = 0; i < count; i++)
        list[i] = v[(ptr >>> 2) + i] >>> 0;
    return list;
}

function utf8Length(s) {
    return s ? TextEncoderPrototypeEncode(encoderUtf8, s).length : 0;
}

// The default framebuffer, with the bindings and state the engine's own use touches saved and put back. Nothing
// here can raise a GL error the page would see.
function withDefaultFramebuffer(C, read, body) {
    const gl = C.gl, M = C.M;
    const target = C.version === 2 ? (read ? 0x8CA8 : 0x8CA9) : 0x8D40; // READ_/DRAW_FRAMEBUFFER : FRAMEBUFFER
    const binding = C.version === 2 ? (read ? 0x8CAA : 0x8CA6) : 0x8CA6;
    const previous = M.getParameter(gl, binding);
    if (previous)
        M.bindFramebuffer(gl, target, null);
    try {
        body();
    } finally {
        if (previous)
            M.bindFramebuffer(gl, target, previous);
    }
}

function addWebGLImports(env) {
    env.ganglion_host_webgl_create = webglCreate;
    env.ganglion_host_webgl_destroy = (handle) => {
        const C = webglContexts[handle];
        if (!C)
            return;
        delete webglContexts[handle];
        if (currentWebGL === C)
            currentWebGL = null;
        const strings = ObjectKeys(C.strings);
        for (let i = 0; i < strings.length; i++)
            X.ganglion_free(C.strings[strings[i]]);
        const lose = C.ext.WEBGL_lose_context || (C.M.getExtension ? C.M.getExtension(C.gl, 'WEBGL_lose_context') : null);
        // Let the host free the GPU resources now rather than at collection.
        if (lose && !C.lost) {
            try { extensionMethods(lose).loseContext(lose); } catch (e) { }
        }
    };
    env.ganglion_host_webgl_make_current = (handle) => {
        currentWebGL = webglContexts[handle] || null;
    };
    env.ganglion_host_webgl_resize = (handle, width, height) => {
        const C = webglContexts[handle];
        if (!C)
            return;
        C.dirty = true;
        OffscreenCanvasSetWidth(C.canvas, width);
        OffscreenCanvasSetHeight(C.canvas, height);
        // The context is made at 1x1 and sized right away: the viewport and scissor box start as the drawing
        // buffer's size, as when a page's context is created.
        if (C.fresh) {
            C.fresh = false;
            C.M.viewport(C.gl, 0, 0, width, height);
            C.M.scissor(C.gl, 0, 0, width, height);
        }
    };
    // Image uploads arrive converted (flipped, premultiplied by the engine): the page's unpack state is set aside.
    env.ganglion_host_webgl_bitmap_upload = (begin) => {
        const C = currentWebGL;
        if (!C)
            return;
        const gl = C.gl, M = C.M;
        if (begin) {
            C.savedUnpack = [M.getParameter(gl, 0x9240), M.getParameter(gl, 0x9241), M.getParameter(gl, 0x9243)];
            M.pixelStorei(gl, 0x9240, 0);
            M.pixelStorei(gl, 0x9241, 0);
            M.pixelStorei(gl, 0x9243, 0);
        } else if (C.savedUnpack) {
            M.pixelStorei(gl, 0x9240, C.savedUnpack[0] ? 1 : 0);
            M.pixelStorei(gl, 0x9241, C.savedUnpack[1] ? 1 : 0);
            M.pixelStorei(gl, 0x9243, C.savedUnpack[2]);
            C.savedUnpack = null;
        }
    };
    // An image source upload (HTMLImageElement, canvas, video, ImageData, ImageBitmap): the engine hands the source's
    // pixels as unpremultiplied RGBA8 and the host's own TexImageSource upload does the rest, as it does for a page:
    // the conversion to format/type, UNPACK_FLIP_Y / PREMULTIPLY_ALPHA (as the engine resolved them for this source),
    // the WebGL 2 unpack sub-rectangle and image height. call: 0 texImage2D, 1 texSubImage2D, 2 texImage3D,
    // 3 texSubImage3D; width < 0 means the source's own size (the WebGL 1 overloads).
    env.ganglion_host_webgl_tex_source = (call, target, level, internalformat, xoffset, yoffset, zoffset, width, height, depth, format, type,
        ptr, sourceWidth, sourceHeight, flipY, premultiply) => {
        const C = currentWebGL;
        if (!C)
            return;
        const gl = C.gl, M = C.M;
        let source = null;
        if (sourceWidth > 0 && sourceHeight > 0 && WebGLImageData) {
            views();
            const data = new WebGLUint8ClampedArray(sourceWidth * sourceHeight * 4);
            WebGLTypedArraySet(data, new WebGLUint8Array(viewBuffer, ptr, data.length));
            source = new WebGLImageData(data, sourceWidth, sourceHeight);
        }
        const saved = [M.getParameter(gl, 0x9240), M.getParameter(gl, 0x9241), M.getParameter(gl, 0x9243)];
        M.pixelStorei(gl, 0x9240, flipY ? 1 : 0);
        M.pixelStorei(gl, 0x9241, premultiply ? 1 : 0);
        M.pixelStorei(gl, 0x9243, 0);
        try {
            if (!source) {
                // An empty source (0x0): the same call with no pixels.
                const w = width < 0 ? 0 : width, h = height < 0 ? 0 : height;
                if (call === 0) M.texImage2D(gl, target, level, internalformat, w, h, 0, format, type, null);
                else if (call === 1) M.texSubImage2D(gl, target, level, xoffset, yoffset, w, h, format, type, null);
                else if (call === 2) M.texImage3D(gl, target, level, internalformat, w, h, depth, 0, format, type, null);
                else M.texSubImage3D(gl, target, level, xoffset, yoffset, zoffset, w, h, depth, format, type, null);
            } else if (call === 0) {
                if (width < 0) M.texImage2D(gl, target, level, internalformat, format, type, source);
                else M.texImage2D(gl, target, level, internalformat, width, height, 0, format, type, source);
            } else if (call === 1) {
                if (width < 0) M.texSubImage2D(gl, target, level, xoffset, yoffset, format, type, source);
                else M.texSubImage2D(gl, target, level, xoffset, yoffset, width, height, format, type, source);
            } else if (call === 2) {
                M.texImage3D(gl, target, level, internalformat, width, height, depth, 0, format, type, source);
            } else {
                M.texSubImage3D(gl, target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, source);
            }
        } catch (e) {
            // The host throws only for what the engine has validated already; the error state is the host's.
        }
        M.pixelStorei(gl, 0x9240, saved[0] ? 1 : 0);
        M.pixelStorei(gl, 0x9241, saved[1] ? 1 : 0);
        M.pixelStorei(gl, 0x9243, saved[2]);
    };
    env.ganglion_host_webgl_extensions = (handle) => {
        const C = webglContexts[handle];
        if (!C)
            return 0;
        const list = C.M.getSupportedExtensions(C.gl) || [];
        let text = '';
        for (let i = 0; i < list.length; i++)
            text += (i ? '\n' : '') + list[i];
        return copyInString(text);
    };
    env.ganglion_host_webgl_clear_default = (handle) => {
        const C = webglContexts[handle];
        if (!C || C.lost)
            return;
        const gl = C.gl, M = C.M;
        const color = M.getParameter(gl, 0x0C22);    // COLOR_CLEAR_VALUE
        const depth = M.getParameter(gl, 0x0B73);    // DEPTH_CLEAR_VALUE
        const stencil = M.getParameter(gl, 0x0B91);  // STENCIL_CLEAR_VALUE
        const scissor = M.isEnabled(gl, 0x0C11);     // SCISSOR_TEST
        const colorMask = M.getParameter(gl, 0x0C23);
        const depthMask = M.getParameter(gl, 0x0B72);
        const stencilMask = M.getParameter(gl, 0x0B98);
        const stencilBackMask = M.getParameter(gl, 0x8CA5);
        withDefaultFramebuffer(C, false, () => {
            if (scissor)
                M.disable(gl, 0x0C11);
            M.colorMask(gl, true, true, true, true);
            M.depthMask(gl, true);
            M.stencilMask(gl, 0xFFFFFFFF);
            M.clearColor(gl, 0, 0, 0, 0);
            M.clearDepth(gl, 1);
            M.clearStencil(gl, 0);
            M.clear(gl, 0x4500); // COLOR | DEPTH | STENCIL
            M.clearColor(gl, color[0], color[1], color[2], color[3]);
            M.clearDepth(gl, depth);
            M.clearStencil(gl, stencil);
            M.colorMask(gl, colorMask[0], colorMask[1], colorMask[2], colorMask[3]);
            M.depthMask(gl, depthMask);
            M.stencilMaskSeparate(gl, 0x0404, stencilMask);     // FRONT
            M.stencilMaskSeparate(gl, 0x0405, stencilBackMask); // BACK
            if (scissor)
                M.enable(gl, 0x0C11);
        });
    };
    env.ganglion_host_webgl_read_frame = (handle, ptr, pitch, width, height) => {
        const C = webglContexts[handle];
        if (!C || C.lost)
            return;
        // Nothing drawn since the last read (a presented frame whose buffer the engine has since cleared, or the
        // same frame read again): the surface keeps what it has, as Chrome keeps the presented frame for read-back.
        if (!C.dirty && C.readOnce)
            return;
        C.dirty = false;
        C.readOnce = true;
        const gl = C.gl, M = C.M;
        const pixels = new WebGLUint8Array(width * height * 4);
        withDefaultFramebuffer(C, true, () => {
            const alignment = M.getParameter(gl, 0x0D05); // PACK_ALIGNMENT
            let packBuffer = null, rowLength = 0, skipPixels = 0, skipRows = 0;
            if (C.version === 2) {
                packBuffer = M.getParameter(gl, 0x88ED); // PIXEL_PACK_BUFFER_BINDING
                rowLength = M.getParameter(gl, 0x0D02);
                skipPixels = M.getParameter(gl, 0x0D04);
                skipRows = M.getParameter(gl, 0x0D03);
                if (packBuffer) M.bindBuffer(gl, 0x88EB, null);
                if (rowLength) M.pixelStorei(gl, 0x0D02, 0);
                if (skipPixels) M.pixelStorei(gl, 0x0D04, 0);
                if (skipRows) M.pixelStorei(gl, 0x0D03, 0);
            }
            if (alignment !== 4) M.pixelStorei(gl, 0x0D05, 4);
            M.readPixels(gl, 0, 0, width, height, 0x1908, 0x1401, pixels);
            if (alignment !== 4) M.pixelStorei(gl, 0x0D05, alignment);
            if (C.version === 2) {
                if (packBuffer) M.bindBuffer(gl, 0x88EB, packBuffer);
                if (rowLength) M.pixelStorei(gl, 0x0D02, rowLength);
                if (skipPixels) M.pixelStorei(gl, 0x0D04, skipPixels);
                if (skipRows) M.pixelStorei(gl, 0x0D03, skipRows);
            }
        });
        // GL rows are bottom-up RGBA; the surface is top-down BGRA, premultiplied (as the buffer is, unless the page
        // asked for premultipliedAlpha: false, whose colours are premultiplied here as Chrome composites them).
        views();
        const premultiply = !C.premultiplied;
        for (let y = 0; y < height; y++) {
            let src = (height - 1 - y) * width * 4;
            let dst = ptr + y * pitch;
            for (let x = 0; x < width; x++, src += 4, dst += 4) {
                const a = pixels[src + 3];
                if (premultiply && a !== 255) {
                    u8[dst] = MathFloor(pixels[src + 2] * a / 255 + 0.5);
                    u8[dst + 1] = MathFloor(pixels[src + 1] * a / 255 + 0.5);
                    u8[dst + 2] = MathFloor(pixels[src] * a / 255 + 0.5);
                } else {
                    u8[dst] = pixels[src + 2];
                    u8[dst + 1] = pixels[src + 1];
                    u8[dst + 2] = pixels[src];
                }
                u8[dst + 3] = a;
            }
        }
    };

    addGLFunctions(env);

    // A host exception must not unwind through the engine's frames (it would skip C++ cleanup): every import
    // catches, says what threw once per name, and returns 0.
    const names = ObjectKeys(env);
    const reported = { __proto__: null };
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (!(name[0] === 'g' && name[1] === 'l' && name[2] >= 'A' && name[2] <= 'Z') && !StringPrototypeStartsWith(name, 'ganglion_host_webgl_'))
            continue;
        const f = env[name];
        // Anything but a query may change the drawing buffer: the next frame read takes it.
        const changes = name[1] === 'l' && !StringPrototypeStartsWith(name, 'glGet') && !StringPrototypeStartsWith(name, 'glIs') && name !== 'glCheckFramebufferStatus' && name !== 'glHostQueryCHITIN' && name !== 'glFinish';
        env[name] = function () {
            if (changes && currentWebGL)
                currentWebGL.dirty = true;
            try {
                return ReflectApply(f, null, arguments);
            } catch (e) {
                if (!reported[name]) {
                    reported[name] = true;
                    hostConsoleError(hostConsole, 'webgl: ' + name + ' threw ' + (e && e.name) + ': ' + (e && e.message));
                }
                return 0;
            }
        };
    }
}

// --- GL ES entry points (Ladybird's GLFunctions.json) ------------------------------------------------------------

function addGLFunctions(env) {
    const cur = () => currentWebGL;
    // Calls with only scalar and object arguments: [GL name, WebGL method, argument kinds] ('n' number, 'o' object).
    const simple = [
        ['glActiveTexture', 'activeTexture', 'n'],
        ['glAttachShader', 'attachShader', 'oo'],
        ['glBeginQuery', 'beginQuery', 'no'],
        ['glBeginTransformFeedback', 'beginTransformFeedback', 'n'],
        ['glBindBufferBase', 'bindBufferBase', 'nno'],
        ['glBindBufferRange', 'bindBufferRange', 'nnonn'],
        ['glBindFramebuffer', 'bindFramebuffer', 'no'],
        ['glBindRenderbuffer', 'bindRenderbuffer', 'no'],
        ['glBindSampler', 'bindSampler', 'no'],
        ['glBindTexture', 'bindTexture', 'no'],
        ['glBindTransformFeedback', 'bindTransformFeedback', 'no'],
        ['glBindVertexArray', 'bindVertexArray', 'o'],
        ['glBlendColor', 'blendColor', 'nnnn'],
        ['glBlendEquation', 'blendEquation', 'n'],
        ['glBlendEquationSeparate', 'blendEquationSeparate', 'nn'],
        ['glBlendFunc', 'blendFunc', 'nn'],
        ['glBlendFuncSeparate', 'blendFuncSeparate', 'nnnn'],
        ['glBlitFramebuffer', 'blitFramebuffer', 'nnnnnnnnnn'],
        ['glClear', 'clear', 'n'],
        ['glClearBufferfi', 'clearBufferfi', 'nnnn'],
        ['glClearColor', 'clearColor', 'nnnn'],
        ['glClearDepthf', 'clearDepth', 'n'],
        ['glClearStencil', 'clearStencil', 'n'],
        ['glColorMask', 'colorMask', 'nnnn'],
        ['glCompileShader', 'compileShader', 'o'],
        ['glCopyBufferSubData', 'copyBufferSubData', 'nnnnn'],
        ['glCopyTexImage2D', 'copyTexImage2D', 'nnnnnnnn'],
        ['glCopyTexSubImage2D', 'copyTexSubImage2D', 'nnnnnnnn'],
        ['glCopyTexSubImage3D', 'copyTexSubImage3D', 'nnnnnnnnn'],
        ['glCullFace', 'cullFace', 'n'],
        ['glDepthFunc', 'depthFunc', 'n'],
        ['glDepthMask', 'depthMask', 'n'],
        ['glDepthRangef', 'depthRange', 'nn'],
        ['glDetachShader', 'detachShader', 'oo'],
        ['glDisable', 'disable', 'n'],
        ['glDisableVertexAttribArray', 'disableVertexAttribArray', 'n'],
        ['glDrawArrays', 'drawArrays', 'nnn'],
        ['glDrawArraysInstanced', 'drawArraysInstanced', 'nnnn'],
        ['glDrawElements', 'drawElements', 'nnnn'],
        ['glDrawElementsInstanced', 'drawElementsInstanced', 'nnnnn'],
        ['glDrawRangeElements', 'drawRangeElements', 'nnnnnn'],
        ['glEnable', 'enable', 'n'],
        ['glEnableVertexAttribArray', 'enableVertexAttribArray', 'n'],
        ['glEndQuery', 'endQuery', 'n'],
        ['glEndTransformFeedback', 'endTransformFeedback', ''],
        ['glFlush', 'flush', ''],
        ['glFramebufferRenderbuffer', 'framebufferRenderbuffer', 'nnno'],
        ['glFramebufferTexture2D', 'framebufferTexture2D', 'nnnon'],
        ['glFramebufferTextureLayer', 'framebufferTextureLayer', 'nnonn'],
        ['glFrontFace', 'frontFace', 'n'],
        ['glGenerateMipmap', 'generateMipmap', 'n'],
        ['glHint', 'hint', 'nn'],
        ['glLineWidth', 'lineWidth', 'n'],
        ['glLinkProgram', 'linkProgram', 'o'],
        ['glPauseTransformFeedback', 'pauseTransformFeedback', ''],
        ['glPixelStorei', 'pixelStorei', 'nn'],
        ['glPolygonOffset', 'polygonOffset', 'nn'],
        ['glReadBuffer', 'readBuffer', 'n'],
        ['glRenderbufferStorage', 'renderbufferStorage', 'nnnn'],
        ['glRenderbufferStorageMultisample', 'renderbufferStorageMultisample', 'nnnnn'],
        ['glResumeTransformFeedback', 'resumeTransformFeedback', ''],
        ['glSampleCoverage', 'sampleCoverage', 'nn'],
        ['glSamplerParameterf', 'samplerParameterf', 'onn'],
        ['glSamplerParameteri', 'samplerParameteri', 'onn'],
        ['glScissor', 'scissor', 'nnnn'],
        ['glStencilFunc', 'stencilFunc', 'nnn'],
        ['glStencilFuncSeparate', 'stencilFuncSeparate', 'nnnn'],
        ['glStencilMask', 'stencilMask', 'n'],
        ['glStencilMaskSeparate', 'stencilMaskSeparate', 'nn'],
        ['glStencilOp', 'stencilOp', 'nnn'],
        ['glStencilOpSeparate', 'stencilOpSeparate', 'nnnn'],
        ['glTexParameterf', 'texParameterf', 'nnn'],
        ['glTexParameteri', 'texParameteri', 'nnn'],
        ['glTexStorage2D', 'texStorage2D', 'nnnnn'],
        ['glTexStorage3D', 'texStorage3D', 'nnnnnn'],
        ['glUniformBlockBinding', 'uniformBlockBinding', 'onn'],
        ['glUseProgram', 'useProgram', 'o'],
        ['glValidateProgram', 'validateProgram', 'o'],
        ['glVertexAttrib1f', 'vertexAttrib1f', 'nn'],
        ['glVertexAttrib2f', 'vertexAttrib2f', 'nnn'],
        ['glVertexAttrib3f', 'vertexAttrib3f', 'nnnn'],
        ['glVertexAttrib4f', 'vertexAttrib4f', 'nnnnn'],
        ['glVertexAttribDivisor', 'vertexAttribDivisor', 'nn'],
        ['glVertexAttribI4i', 'vertexAttribI4i', 'nnnnn'],
        ['glVertexAttribI4ui', 'vertexAttribI4ui', 'nnnnn'],
        ['glVertexAttribIPointer', 'vertexAttribIPointer', 'nnnnn'],
        ['glVertexAttribPointer', 'vertexAttribPointer', 'nnnnnn'],
        ['glViewport', 'viewport', 'nnnn'],
    ];
    for (let i = 0; i < simple.length; i++) {
        const [glName, method, kinds] = simple[i];
        const arity = kinds.length;
        env[glName] = (a, b, c, d, e, f, g, h, k, l) => {
            const C = cur();
            if (!C)
                return;
            const args = [a, b, c, d, e, f, g, h, k, l];
            const call = [C.gl];
            for (let j = 0; j < arity; j++) {
                let v = args[j];
                if (kinds[j] === 'o')
                    v = object(C, v);
                else if (typeof v === 'bigint')
                    v = HostNumber(v);
                call[j + 1] = v;
            }
            ReflectApply(C.M[method], null, call);
        };
    }
    // GLuint parameters arrive as signed i32: masks and unsigned values are reinterpreted.
    env.glStencilMask = (mask) => { const C = cur(); if (C) C.M.stencilMask(C.gl, mask >>> 0); };
    env.glStencilMaskSeparate = (face, mask) => { const C = cur(); if (C) C.M.stencilMaskSeparate(C.gl, face, mask >>> 0); };
    env.glStencilFunc = (func, ref, mask) => { const C = cur(); if (C) C.M.stencilFunc(C.gl, func, ref, mask >>> 0); };
    env.glStencilFuncSeparate = (face, func, ref, mask) => { const C = cur(); if (C) C.M.stencilFuncSeparate(C.gl, face, func, ref, mask >>> 0); };
    env.glVertexAttribI4ui = (index, x, y, z, w) => { const C = cur(); if (C) C.M.vertexAttribI4ui(C.gl, index, x >>> 0, y >>> 0, z >>> 0, w >>> 0); };
    env.glDrawRangeElements = (mode, start, end, count, type, offset) => { const C = cur(); if (C) C.M.drawRangeElements(C.gl, mode, start >>> 0, end >>> 0, count, type, offset); };

    env.glBindBuffer = (target, name) => {
        const C = cur();
        if (!C)
            return;
        C.M.bindBuffer(C.gl, target, object(C, name));
        if (target === 0x88EB) C.packBuffer = name;      // PIXEL_PACK_BUFFER
        if (target === 0x88EC) C.unpackBuffer = name;    // PIXEL_UNPACK_BUFFER
    };
    env.glBindAttribLocation = (program, index, namePtr) => { const C = cur(); if (C) C.M.bindAttribLocation(C.gl, object(C, program), index, cString(namePtr)); };

    // Object creation and deletion.
    const gen = (glName, create) => {
        env[glName] = (n, ptr) => {
            const C = cur();
            const v = i32View();
            for (let i = 0; i < n; i++)
                v[(ptr >>> 2) + i] = C ? remember(C, C.M[create](C.gl)) : 0;
        };
    };
    gen('glGenBuffers', 'createBuffer');
    gen('glGenFramebuffers', 'createFramebuffer');
    gen('glGenQueries', 'createQuery');
    gen('glGenRenderbuffers', 'createRenderbuffer');
    gen('glGenSamplers', 'createSampler');
    gen('glGenTextures', 'createTexture');
    gen('glGenTransformFeedbacks', 'createTransformFeedback');
    gen('glGenVertexArrays', 'createVertexArray');
    const del = (glName, method) => {
        env[glName] = (n, ptr) => {
            const C = cur();
            if (!C)
                return;
            const names = uintArray(n, ptr);
            for (let i = 0; i < n; i++) {
                const o = object(C, names[i]);
                C.M[method](C.gl, o);
                if (o)
                    forget(C, names[i]);
            }
        };
    };
    del('glDeleteBuffers', 'deleteBuffer');
    del('glDeleteFramebuffers', 'deleteFramebuffer');
    del('glDeleteQueries', 'deleteQuery');
    del('glDeleteRenderbuffers', 'deleteRenderbuffer');
    del('glDeleteSamplers', 'deleteSampler');
    del('glDeleteTextures', 'deleteTexture');
    del('glDeleteTransformFeedbacks', 'deleteTransformFeedback');
    del('glDeleteVertexArrays', 'deleteVertexArray');
    env.glCreateProgram = () => { const C = cur(); return C ? remember(C, C.M.createProgram(C.gl)) : 0; };
    env.glCreateShader = (type) => { const C = cur(); return C ? remember(C, C.M.createShader(C.gl, type)) : 0; };
    // A deleted program or shader stays alive (and named) while attached or in use; the host decides.
    env.glDeleteProgram = (name) => { const C = cur(); if (C) C.M.deleteProgram(C.gl, object(C, name)); };
    env.glDeleteShader = (name) => { const C = cur(); if (C) C.M.deleteShader(C.gl, object(C, name)); };

    // WebGL 1 extension entry points.
    const extCall = (extName, method) => (...args) => {
        const C = cur();
        if (!C)
            return 0;
        const ext = C.ext[extName];
        if (!ext)
            return 0;
        const call = [ext];
        for (let i = 0; i < args.length; i++)
            call[i + 1] = args[i];
        return ReflectApply(extensionMethods(ext)[method], null, call);
    };
    env.glGenVertexArraysOES = (n, ptr) => {
        const C = cur();
        const v = i32View();
        const ext = C && C.ext.OES_vertex_array_object;
        for (let i = 0; i < n; i++)
            v[(ptr >>> 2) + i] = ext ? remember(C, extensionMethods(ext).createVertexArrayOES(ext)) : 0;
    };
    env.glDeleteVertexArraysOES = (n, ptr) => {
        const C = cur();
        const ext = C && C.ext.OES_vertex_array_object;
        if (!ext)
            return;
        const names = uintArray(n, ptr);
        for (let i = 0; i < n; i++)
            extensionMethods(ext).deleteVertexArrayOES(ext, object(C, names[i]));
    };
    env.glBindVertexArrayOES = (name) => {
        const C = cur();
        const ext = C && C.ext.OES_vertex_array_object;
        if (ext)
            extensionMethods(ext).bindVertexArrayOES(ext, object(C, name));
    };
    env.glIsVertexArrayOES = (name) => {
        const C = cur();
        const ext = C && C.ext.OES_vertex_array_object;
        return ext && extensionMethods(ext).isVertexArrayOES(ext, object(C, name)) ? 1 : 0;
    };
    env.glDrawArraysInstancedANGLE = extCall('ANGLE_instanced_arrays', 'drawArraysInstancedANGLE');
    env.glDrawElementsInstancedANGLE = extCall('ANGLE_instanced_arrays', 'drawElementsInstancedANGLE');
    env.glVertexAttribDivisorANGLE = extCall('ANGLE_instanced_arrays', 'vertexAttribDivisorANGLE');
    env.glDrawBuffersEXT = (n, ptr) => {
        const C = cur();
        const ext = C && C.ext.WEBGL_draw_buffers;
        if (ext)
            extensionMethods(ext).drawBuffersWEBGL(ext, uintArray(n, ptr));
    };
    env.glRequestExtensionANGLE = (namePtr) => {
        const C = cur();
        if (!C)
            return;
        let name = cString(namePtr);
        name = GL_TO_WEBGL_EXTENSION[name] || name;
        if (C.ext[name])
            return;
        const ext = C.M.getExtension(C.gl, name);
        if (ext)
            C.ext[name] = ext;
    };

    // Data uploads.
    env.glBufferData = (target, size, ptr, usage) => {
        const C = cur();
        if (!C)
            return;
        if (ptr)
            C.M.bufferData(C.gl, target, memoryView(WebGLUint8Array, ptr, size), usage);
        else
            C.M.bufferData(C.gl, target, size, usage);
    };
    env.glBufferSubData = (target, offset, size, ptr) => {
        const C = cur();
        if (C)
            C.M.bufferSubData(C.gl, target, offset, memoryView(WebGLUint8Array, ptr, size));
    };
    const pixels = (C, type, bufSize, ptr) => {
        if (C.unpackBuffer)
            return ptr; // an offset into the bound PIXEL_UNPACK_BUFFER
        if (!ptr)
            return null;
        return memoryView(pixelArrayFor(type), ptr, bufSize);
    };
    env.glTexImage2DRobustANGLE = (target, level, internalformat, width, height, border, format, type, bufSize, ptr) => {
        const C = cur();
        if (C)
            C.M.texImage2D(C.gl, target, level, internalformat, width, height, border, format, type, pixels(C, type, bufSize, ptr));
    };
    env.glTexSubImage2DRobustANGLE = (target, level, xoffset, yoffset, width, height, format, type, bufSize, ptr) => {
        const C = cur();
        if (C)
            C.M.texSubImage2D(C.gl, target, level, xoffset, yoffset, width, height, format, type, pixels(C, type, bufSize, ptr));
    };
    env.glTexImage3DRobustANGLE = (target, level, internalformat, width, height, depth, border, format, type, bufSize, ptr) => {
        const C = cur();
        if (C)
            C.M.texImage3D(C.gl, target, level, internalformat, width, height, depth, border, format, type, pixels(C, type, bufSize, ptr));
    };
    env.glTexSubImage3DRobustANGLE = (target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, bufSize, ptr) => {
        const C = cur();
        if (C)
            C.M.texSubImage3D(C.gl, target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, pixels(C, type, bufSize, ptr));
    };
    const compressed = (C, imageSize, ptr) => C.unpackBuffer ? null : memoryView(WebGLUint8Array, ptr, imageSize);
    env.glCompressedTexImage2DRobustANGLE = (target, level, internalformat, width, height, border, imageSize, bufSize, ptr) => {
        const C = cur();
        if (!C)
            return;
        if (C.unpackBuffer)
            C.M.compressedTexImage2D(C.gl, target, level, internalformat, width, height, border, imageSize, ptr);
        else
            C.M.compressedTexImage2D(C.gl, target, level, internalformat, width, height, border, compressed(C, imageSize, ptr));
    };
    env.glCompressedTexSubImage2DRobustANGLE = (target, level, xoffset, yoffset, width, height, format, imageSize, bufSize, ptr) => {
        const C = cur();
        if (!C)
            return;
        if (C.unpackBuffer)
            C.M.compressedTexSubImage2D(C.gl, target, level, xoffset, yoffset, width, height, format, imageSize, ptr);
        else
            C.M.compressedTexSubImage2D(C.gl, target, level, xoffset, yoffset, width, height, format, compressed(C, imageSize, ptr));
    };
    env.glCompressedTexImage3DRobustANGLE = (target, level, internalformat, width, height, depth, border, imageSize, bufSize, ptr) => {
        const C = cur();
        if (!C)
            return;
        if (C.unpackBuffer)
            C.M.compressedTexImage3D(C.gl, target, level, internalformat, width, height, depth, border, imageSize, ptr);
        else
            C.M.compressedTexImage3D(C.gl, target, level, internalformat, width, height, depth, border, compressed(C, imageSize, ptr));
    };
    env.glCompressedTexSubImage3DRobustANGLE = (target, level, xoffset, yoffset, zoffset, width, height, depth, format, imageSize, bufSize, ptr) => {
        const C = cur();
        if (!C)
            return;
        if (C.unpackBuffer)
            C.M.compressedTexSubImage3D(C.gl, target, level, xoffset, yoffset, zoffset, width, height, depth, format, imageSize, ptr);
        else
            C.M.compressedTexSubImage3D(C.gl, target, level, xoffset, yoffset, zoffset, width, height, depth, format, compressed(C, imageSize, ptr));
    };
    env.glReadPixelsRobustANGLE = (x, y, width, height, format, type, bufSize, lengthPtr, columnsPtr, rowsPtr, ptr) => {
        const C = cur();
        if (!C)
            return;
        if (C.packBuffer)
            C.M.readPixels(C.gl, x, y, width, height, format, type, ptr);
        else
            C.M.readPixels(C.gl, x, y, width, height, format, type, memoryView(pixelArrayFor(type), ptr, bufSize));
        setLength(lengthPtr, bufSize);
        setLength(columnsPtr, width);
        setLength(rowsPtr, height);
    };

    // Uniforms and vertex attributes.
    const location = (C, l) => l < 0 ? null : (C.locations[l] || null);
    for (const n of [1, 2, 3, 4]) {
        for (const [suffix, Ctor] of [['f', Float32Array], ['i', WebGLInt32Array], ['ui', Uint32Array]]) {
            const method = 'uniform' + n + suffix;
            env['glUniform' + n + suffix] = (l, a, b, c, d) => {
                const C = cur();
                if (!C)
                    return;
                const args = [C.gl, location(C, l), a, b, c, d];
                if (suffix === 'ui')
                    for (let i = 2; i < 6; i++) args[i] = args[i] >>> 0;
                args.length = 2 + n;
                ReflectApply(C.M[method], null, args);
            };
            env['glUniform' + n + suffix + 'v'] = (l, count, ptr) => {
                const C = cur();
                if (C)
                    C.M[method + 'v'](C.gl, location(C, l), memoryView(Ctor, ptr, count * n * 4));
            };
        }
    }
    for (const [suffix, size] of [['2', 4], ['3', 9], ['4', 16], ['2x3', 6], ['2x4', 8], ['3x2', 6], ['3x4', 12], ['4x2', 8], ['4x3', 12]]) {
        const method = 'uniformMatrix' + suffix + 'fv';
        env['glUniformMatrix' + suffix + 'fv'] = (l, count, transpose, ptr) => {
            const C = cur();
            if (C)
                C.M[method](C.gl, location(C, l), !!transpose, memoryView(Float32Array, ptr, count * size * 4));
        };
    }
    for (const n of [1, 2, 3, 4]) {
        const method = 'vertexAttrib' + n + 'fv';
        env['glVertexAttrib' + n + 'fv'] = (index, ptr) => {
            const C = cur();
            if (C)
                C.M[method](C.gl, index, memoryView(Float32Array, ptr, n * 4));
        };
    }
    env.glVertexAttribI4iv = (index, ptr) => { const C = cur(); if (C) C.M.vertexAttribI4iv(C.gl, index, memoryView(WebGLInt32Array, ptr, 16)); };
    env.glVertexAttribI4uiv = (index, ptr) => { const C = cur(); if (C) C.M.vertexAttribI4uiv(C.gl, index, memoryView(Uint32Array, ptr, 16)); };
    env.glClearBufferfv = (buffer, drawbuffer, ptr) => { const C = cur(); if (C) C.M.clearBufferfv(C.gl, buffer, drawbuffer, memoryView(Float32Array, ptr, buffer === 0x1801 ? 4 : 16)); };
    env.glClearBufferiv = (buffer, drawbuffer, ptr) => { const C = cur(); if (C) C.M.clearBufferiv(C.gl, buffer, drawbuffer, memoryView(WebGLInt32Array, ptr, buffer === 0x1802 ? 4 : 16)); };
    env.glClearBufferuiv = (buffer, drawbuffer, ptr) => { const C = cur(); if (C) C.M.clearBufferuiv(C.gl, buffer, drawbuffer, memoryView(Uint32Array, ptr, 16)); };
    env.glDrawBuffers = (n, ptr) => { const C = cur(); if (C) C.M.drawBuffers(C.gl, uintArray(n, ptr)); };
    env.glInvalidateFramebuffer = (target, n, ptr) => { const C = cur(); if (C) C.M.invalidateFramebuffer(C.gl, target, uintArray(n, ptr)); };
    env.glInvalidateSubFramebuffer = (target, n, ptr, x, y, width, height) => { const C = cur(); if (C) C.M.invalidateSubFramebuffer(C.gl, target, uintArray(n, ptr), x, y, width, height); };

    // Shaders and programs.
    env.glShaderSource = (shader, count, stringsPtr, lengthsPtr) => {
        const C = cur();
        if (!C)
            return;
        const v = i32View();
        let source = '';
        for (let i = 0; i < count; i++) {
            const p = v[(stringsPtr >>> 2) + i] >>> 0;
            const len = lengthsPtr ? v[(lengthsPtr >>> 2) + i] : -1;
            source += len >= 0 ? bytesToString(p, len) : cString(p);
        }
        C.M.shaderSource(C.gl, object(C, shader), source);
    };
    env.glTransformFeedbackVaryings = (program, count, ptr, mode) => {
        const C = cur();
        if (C)
            C.M.transformFeedbackVaryings(C.gl, object(C, program), cStringArray(count, ptr), mode);
    };
    env.glGetAttribLocation = (program, namePtr) => { const C = cur(); return C ? C.M.getAttribLocation(C.gl, object(C, program), cString(namePtr)) : -1; };
    env.glGetFragDataLocation = (program, namePtr) => { const C = cur(); return C ? C.M.getFragDataLocation(C.gl, object(C, program), cString(namePtr)) : -1; };
    env.glGetUniformBlockIndex = (program, namePtr) => { const C = cur(); return C ? C.M.getUniformBlockIndex(C.gl, object(C, program), cString(namePtr)) : -1; };
    env.glGetUniformLocation = (program, namePtr) => {
        const C = cur();
        if (!C)
            return -1;
        const l = C.M.getUniformLocation(C.gl, object(C, program), cString(namePtr));
        if (!l)
            return -1;
        const name = C.nextLocation++;
        C.locations[name] = l;
        return name;
    };
    env.glGetUniformIndices = (program, count, namesPtr, outPtr) => {
        const C = cur();
        if (!C)
            return;
        const indices = C.M.getUniformIndices(C.gl, object(C, program), cStringArray(count, namesPtr));
        const v = i32View();
        for (let i = 0; i < count; i++)
            v[(outPtr >>> 2) + i] = indices ? indices[i] : -1;
    };
    // GL's *_LENGTH queries have no WebGL form; they are what the strings give.
    const programLengths = (C, program, pname) => {
        const p = object(C, program);
        let max = 0;
        if (pname === 0x8B84) // INFO_LOG_LENGTH
            return (s => s ? utf8Length(s) + 1 : 0)(C.M.getProgramInfoLog(C.gl, p));
        if (pname === 0x8B87 || pname === 0x8B8A || pname === 0x8C76 || pname === 0x8A35) {
            const countPname = { __proto__: null, 0x8B87: 0x8B86, 0x8B8A: 0x8B89, 0x8C76: 0x8C83, 0x8A35: 0x8A36 }[pname];
            const count = C.M.getProgramParameter(C.gl, p, countPname) || 0;
            for (let i = 0; i < count; i++) {
                let name = '';
                if (pname === 0x8B87) { const info = C.M.getActiveUniform(C.gl, p, i); name = info && info.name; }
                else if (pname === 0x8B8A) { const info = C.M.getActiveAttrib(C.gl, p, i); name = info && info.name; }
                else if (pname === 0x8C76) { const info = C.M.getTransformFeedbackVarying(C.gl, p, i); name = info && info.name; }
                else name = C.M.getActiveUniformBlockName(C.gl, p, i);
                max = MathMax(max, utf8Length(name) + 1);
            }
            return max;
        }
        return C.M.getProgramParameter(C.gl, p, pname);
    };
    env.glGetProgramiv = (program, pname, ptr) => { const C = cur(); if (C) writeValues(C, programLengths(C, program, pname), 'i', ptr, 1); };
    env.glGetProgramivRobustANGLE = (program, pname, bufSize, lengthPtr, ptr) => {
        const C = cur();
        if (C)
            setLength(lengthPtr, writeValues(C, programLengths(C, program, pname), 'i', ptr, bufSize));
    };
    const shaderParameter = (C, shader, pname) => {
        const s = object(C, shader);
        if (pname === 0x8B84) { const log = C.M.getShaderInfoLog(C.gl, s); return log ? utf8Length(log) + 1 : 0; }
        if (pname === 0x8B88) { const src = C.M.getShaderSource(C.gl, s); return src ? utf8Length(src) + 1 : 0; }
        return C.M.getShaderParameter(C.gl, s, pname);
    };
    env.glGetShaderiv = (shader, pname, ptr) => { const C = cur(); if (C) writeValues(C, shaderParameter(C, shader, pname), 'i', ptr, 1); };
    env.glGetShaderivRobustANGLE = (shader, pname, bufSize, lengthPtr, ptr) => {
        const C = cur();
        if (C)
            setLength(lengthPtr, writeValues(C, shaderParameter(C, shader, pname), 'i', ptr, bufSize));
    };
    env.glGetProgramInfoLog = (program, bufSize, lengthPtr, out) => { const C = cur(); if (C) webglWriteString(C.M.getProgramInfoLog(C.gl, object(C, program)), bufSize, lengthPtr, out); };
    env.glGetShaderInfoLog = (shader, bufSize, lengthPtr, out) => { const C = cur(); if (C) webglWriteString(C.M.getShaderInfoLog(C.gl, object(C, shader)), bufSize, lengthPtr, out); };
    env.glGetShaderSource = (shader, bufSize, lengthPtr, out) => { const C = cur(); if (C) webglWriteString(C.M.getShaderSource(C.gl, object(C, shader)), bufSize, lengthPtr, out); };
    const activeInfo = (method) => (program, index, bufSize, lengthPtr, sizePtr, typePtr, out) => {
        const C = cur();
        if (!C)
            return;
        const info = C.M[method](C.gl, object(C, program), index >>> 0);
        const v = i32View();
        if (sizePtr) v[sizePtr >>> 2] = info ? info.size : 0;
        if (typePtr) v[typePtr >>> 2] = info ? info.type : 0;
        webglWriteString(info ? info.name : '', bufSize, lengthPtr, out);
    };
    env.glGetActiveAttrib = activeInfo('getActiveAttrib');
    env.glGetActiveUniform = activeInfo('getActiveUniform');
    env.glGetActiveUniformBlockName = (program, index, bufSize, lengthPtr, out) => {
        const C = cur();
        if (C)
            webglWriteString(C.M.getActiveUniformBlockName(C.gl, object(C, program), index >>> 0), bufSize, lengthPtr, out);
    };
    env.glGetActiveUniformBlockivRobustANGLE = (program, index, pname, bufSize, lengthPtr, ptr) => {
        const C = cur();
        if (!C)
            return;
        const p = object(C, program);
        let value;
        if (pname === 0x8A41) // UNIFORM_BLOCK_NAME_LENGTH
            value = (n => n === null ? 0 : utf8Length(n) + 1)(C.M.getActiveUniformBlockName(C.gl, p, index >>> 0));
        else
            value = C.M.getActiveUniformBlockParameter(C.gl, p, index >>> 0, pname);
        setLength(lengthPtr, writeValues(C, value, 'i', ptr, bufSize));
    };
    env.glGetActiveUniformsiv = (program, count, indicesPtr, pname, ptr) => {
        const C = cur();
        if (!C)
            return;
        let value;
        if (pname === 0x8A39) { // UNIFORM_NAME_LENGTH
            const indices = uintArray(count, indicesPtr);
            value = [];
            for (let i = 0; i < count; i++) {
                const info = C.M.getActiveUniform(C.gl, object(C, program), indices[i]);
                value[i] = info ? utf8Length(info.name) + 1 : 0;
            }
        } else {
            value = C.M.getActiveUniforms(C.gl, object(C, program), uintArray(count, indicesPtr), pname);
        }
        writeValues(C, value, 'i', ptr, count);
    };
    env.glGetShaderPrecisionFormat = (shadertype, precisiontype, rangePtr, precisionPtr) => {
        const C = cur();
        const v = i32View();
        const f = C ? C.M.getShaderPrecisionFormat(C.gl, shadertype, precisiontype) : null;
        v[rangePtr >>> 2] = f ? f.rangeMin : 0;
        v[(rangePtr >>> 2) + 1] = f ? f.rangeMax : 0;
        v[precisionPtr >>> 2] = f ? f.precision : 0;
    };

    // State queries.
    env.glGetError = () => { const C = cur(); return C ? C.M.getError(C.gl) : 0; };
    env.glFinish = () => { const C = cur(); if (C) C.M.finish(C.gl); };
    env.glCheckFramebufferStatus = (target) => { const C = cur(); return C ? C.M.checkFramebufferStatus(C.gl, target) : 0; };
    env.glIsEnabled = (cap) => { const C = cur(); return C && C.M.isEnabled(C.gl, cap) ? 1 : 0; };
    const is = (glName, method) => { env[glName] = (name) => { const C = cur(); return C && C.M[method](C.gl, object(C, name)) ? 1 : 0; }; };
    is('glIsBuffer', 'isBuffer');
    is('glIsFramebuffer', 'isFramebuffer');
    is('glIsProgram', 'isProgram');
    is('glIsRenderbuffer', 'isRenderbuffer');
    is('glIsShader', 'isShader');
    is('glIsTexture', 'isTexture');
    is('glIsVertexArray', 'isVertexArray');
    is('glIsQuery', 'isQuery');
    is('glIsSampler', 'isSampler');
    is('glIsTransformFeedback', 'isTransformFeedback');
    env.glIsSync = (handle) => { const C = cur(); return C && C.M.isSync(C.gl, C.syncs[handle] || null) ? 1 : 0; };
    const getv = (glName, kind, query) => {
        env[glName] = (a, b, c, d, e) => {
            const C = cur();
            if (!C)
                return;
            // (pname, bufSize, length*, data*) or (target, pname, bufSize, length*, data*)
            const two = query.length === 3; // (C, target, pname) queries take one argument more
            const value = two ? query(C, a, b) : query(C, a);
            const bufSize = two ? c : b, lengthPtr = two ? d : c, ptr = two ? e : d;
            setLength(lengthPtr, writeValues(C, value, kind, ptr, bufSize));
        };
    };
    const parameter = (C, pname) => C.M.getParameter(C.gl, pname);
    getv('glGetIntegervRobustANGLE', 'i', parameter);
    getv('glGetFloatvRobustANGLE', 'f', parameter);
    getv('glGetBooleanvRobustANGLE', 'b', parameter);
    getv('glGetInteger64vRobustANGLE', 'l', parameter);
    getv('glGetBufferParameterivRobustANGLE', 'i', (C, target, pname) => C.M.getBufferParameter(C.gl, target, pname));
    getv('glGetRenderbufferParameterivRobustANGLE', 'i', (C, target, pname) => C.M.getRenderbufferParameter(C.gl, target, pname));
    getv('glGetTexParameterivRobustANGLE', 'i', (C, target, pname) => C.M.getTexParameter(C.gl, target, pname));
    getv('glGetTexParameterfvRobustANGLE', 'f', (C, target, pname) => C.M.getTexParameter(C.gl, target, pname));
    getv('glGetVertexAttribivRobustANGLE', 'i', (C, index, pname) => C.M.getVertexAttrib(C.gl, index, pname));
    getv('glGetVertexAttribfvRobustANGLE', 'f', (C, index, pname) => C.M.getVertexAttrib(C.gl, index, pname));
    getv('glGetQueryObjectuivRobustANGLE', 'u', (C, name, pname) => C.M.getQueryParameter(C.gl, object(C, name), pname));
    env.glGetVertexAttribPointervRobustANGLE = (index, pname, bufSize, lengthPtr, ptr) => {
        const C = cur();
        if (!C)
            return;
        i32View()[ptr >>> 2] = C.M.getVertexAttribOffset(C.gl, index, pname);
        setLength(lengthPtr, 1);
    };
    env.glGetInternalformativRobustANGLE = (target, internalformat, pname, bufSize, lengthPtr, ptr) => {
        const C = cur();
        if (!C)
            return;
        let value;
        if (pname === 0x9380) { // NUM_SAMPLE_COUNTS: the length of SAMPLES
            const samples = C.M.getInternalformatParameter(C.gl, target, internalformat, 0x80A9);
            value = samples ? WebGLTypedArrayLength(samples) : 0;
        } else {
            value = C.M.getInternalformatParameter(C.gl, target, internalformat, pname);
        }
        setLength(lengthPtr, writeValues(C, value, 'i', ptr, bufSize));
    };
    env.glGetString = (name) => {
        const C = cur();
        if (!C)
            return 0;
        if (C.strings[name])
            return C.strings[name];
        let value;
        if (name === 0x1F03) { // EXTENSIONS
            const list = C.M.getSupportedExtensions(C.gl) || [];
            value = '';
            for (let i = 0; i < list.length; i++)
                value += (i ? ' ' : '') + list[i];
        } else {
            value = C.M.getParameter(C.gl, name);
        }
        if (typeof value !== 'string')
            return 0;
        // The unmasked strings follow the extension's state; the others never change.
        const ptr = copyInString(value);
        if (name !== 0x9245 && name !== 0x9246)
            C.strings[name] = ptr;
        else
            C.strings['u' + name + '_' + C.nextName++] = ptr;
        return ptr;
    };

    // A host extension method (patch 0064's generated extension interfaces): {"e", "m", "a"}. Arguments are numbers,
    // booleans and arrays of numbers, parsed by hand (the page can reach JSON).
    env.glHostExtensionCallCHITIN = (jsonPtr) => {
        const C = cur();
        if (!C)
            return;
        const call = parseExtensionCall(cString(jsonPtr));
        // The context's own unpackColorSpace (LibWeb's setter), in order with the uploads it applies to.
        if (call.e === '@context') {
            if (call.m === 'unpackColorSpace')
                C.gl.unpackColorSpace = call.a[0];
            return;
        }
        const ext = C.ext[call.e];
        C.extensionResult = null;
        if (!ext)
            return;
        const method = extensionMethods(ext)[call.m];
        if (!method)
            return;
        const args = [ext];
        // "@<name>" is a WebGL object by its GL name (OVR_multiview2's texture).
        for (let i = 0; i < call.a.length; i++) {
            const a = call.a[i];
            args[i + 1] = typeof a === 'string' && a[0] === '@' ? object(C, +StringPrototypeSliceWebGL(a, 1)) : a;
        }
        C.extensionResult = ReflectApply(method, null, args);
    };
    env.glHostQueryCHITIN = (kind, obj, a, b, c, bufSize, lengthPtr, out) => {
        const C = cur();
        webglWriteString(C ? hostJSON(C, hostQuery(C, kind, obj, a, b, c)) : 'null', bufSize, lengthPtr, out);
    };

    // Buffers mapped for reading (getBufferSubData).
    env.glMapBufferRange = (target, offset, length, access) => {
        const C = cur();
        if (!C || C.mapped)
            return 0;
        const ptr = X.ganglion_alloc(length > 0 ? length : 1);
        C.M.getBufferSubData(C.gl, target, offset, memoryView(WebGLUint8Array, ptr, length));
        C.mapped = ptr;
        return ptr;
    };
    env.glUnmapBuffer = (target) => {
        const C = cur();
        if (!C || !C.mapped)
            return 0;
        X.ganglion_free(C.mapped);
        C.mapped = null;
        return 1;
    };

    // Sync objects: GLsync is a handle the glue gives out.
    env.glFenceSync = (condition, flags) => {
        const C = cur();
        if (!C)
            return 0;
        const sync = C.M.fenceSync(C.gl, condition, flags);
        if (!sync)
            return 0;
        const handle = C.nextSync;
        C.nextSync += 8;
        C.syncs[handle] = sync;
        return handle;
    };
    env.glDeleteSync = (handle) => {
        const C = cur();
        if (!C)
            return;
        C.M.deleteSync(C.gl, C.syncs[handle] || null);
        delete C.syncs[handle];
    };
    env.glClientWaitSync = (handle, flags, timeout) => {
        const C = cur();
        return C ? C.M.clientWaitSync(C.gl, C.syncs[handle] || null, flags, HostNumber(timeout)) : 0x911D; // WAIT_FAILED
    };
    env.glWaitSync = (handle, flags, timeout) => {
        const C = cur();
        if (C)
            C.M.waitSync(C.gl, C.syncs[handle] || null, flags, HostNumber(WebGLBigInt.asIntN(64, timeout)));
    };
    env.glGetSynciv = (handle, pname, count, lengthPtr, ptr) => {
        const C = cur();
        if (C)
            setLength(lengthPtr, writeValues(C, C.M.getSyncParameter(C.gl, C.syncs[handle] || null, pname), 'i', ptr, count));
    };
}
