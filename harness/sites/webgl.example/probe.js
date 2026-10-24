// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// WebGL probe (docs/webgl.md): the same scenes and calls run in Chrome and in Chitin, every call followed by
// getError(), and the answers compared key by key with no tolerance (tests/chrome/run.mjs, group webgl). Keys:
//   <scene>.<n>.<call>  -> [result, error after the call]
//   <scene>.pixels      -> FNV-1a of the whole readPixels RGBA buffer, and a few sampled pixels
// Runs in a page and (worker.html) in a dedicated worker on an OffscreenCanvas.

/* eslint-disable no-var */
var webglProbe = (function () {
    'use strict';
    var R = {};

    function describe(v) {
        if (v === null || v === undefined) return v === null ? null : 'undefined';
        if (typeof v === 'number') return Number.isNaN(v) ? 'NaN' : v;
        if (typeof v === 'boolean' || typeof v === 'string') return v;
        if (ArrayBuffer.isView(v)) return [Object.prototype.toString.call(v).slice(8, -1), Array.prototype.slice.call(v)];
        if (Array.isArray(v)) return v.map(describe);
        var tag = Object.prototype.toString.call(v).slice(8, -1);
        if (tag === 'WebGLActiveInfo') return [tag, v.name, v.size, v.type];
        if (tag === 'WebGLShaderPrecisionFormat') return [tag, v.rangeMin, v.rangeMax, v.precision];
        if (tag === 'Object') return JSON.parse(JSON.stringify(v));
        return tag;
    }

    function fnv(bytes) {
        var h = 0x811c9dc5;
        for (var i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
        return h.toString(16);
    }

    // A recorder over one context: v('name', args...) calls gl.name(...args), stores [result, getError()] under
    // <scene>.<n>.<name> and returns the result itself (objects and locations are used by the scenes).
    function recorder(scene, gl) {
        var n = 0;
        return function v(name) {
            var args = Array.prototype.slice.call(arguments, 1);
            var key = scene + '.' + (n < 10 ? '0' : '') + n + '.' + name;
            n++;
            var result;
            try {
                result = gl[name].apply(gl, args);
                R[key] = [describe(result), gl.getError()];
            } catch (e) {
                R[key] = ['!' + e.name, gl.getError()];
            }
            return result;
        };
    }

    function pixels(scene, gl, w, h) {
        var buf = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        var samples = [];
        var pts = [[0, 0], [w >> 1, h >> 1], [w - 1, h - 1], [w >> 2, (h * 3) >> 2], [(w * 3) >> 2, h >> 2]];
        for (var i = 0; i < pts.length; i++) {
            var o = (pts[i][1] * w + pts[i][0]) * 4;
            samples.push([buf[o], buf[o + 1], buf[o + 2], buf[o + 3]]);
        }
        R[scene + '.pixels'] = [fnv(buf), samples, gl.getError()];
    }

    var VS1 = 'attribute vec2 p; attribute vec3 col; varying vec3 vc; void main(){ vc = col; gl_Position = vec4(p, 0.0, 1.0); }';
    var FS1 = 'precision mediump float; varying vec3 vc; void main(){ gl_FragColor = vec4(vc, 1.0); }';

    function program(v, gl, vs, fs) {
        var s1 = v('createShader', gl.VERTEX_SHADER);
        v('shaderSource', s1, vs);
        v('compileShader', s1);
        v('getShaderParameter', s1, gl.COMPILE_STATUS);
        var s2 = v('createShader', gl.FRAGMENT_SHADER);
        v('shaderSource', s2, fs);
        v('compileShader', s2);
        v('getShaderParameter', s2, gl.COMPILE_STATUS);
        var p = v('createProgram');
        v('attachShader', p, s1);
        v('attachShader', p, s2);
        v('linkProgram', p);
        v('getProgramParameter', p, gl.LINK_STATUS);
        v('getProgramInfoLog', p);
        v('useProgram', p);
        return p;
    }

    var WEBGL1_PNAMES = ['ACTIVE_TEXTURE', 'ALIASED_LINE_WIDTH_RANGE', 'ALIASED_POINT_SIZE_RANGE', 'ALPHA_BITS', 'ARRAY_BUFFER_BINDING', 'BLEND', 'BLEND_COLOR', 'BLEND_DST_ALPHA', 'BLEND_DST_RGB', 'BLEND_EQUATION', 'BLEND_EQUATION_ALPHA', 'BLEND_EQUATION_RGB', 'BLEND_SRC_ALPHA', 'BLEND_SRC_RGB', 'BLUE_BITS', 'COLOR_CLEAR_VALUE', 'COLOR_WRITEMASK', 'COMPRESSED_TEXTURE_FORMATS', 'CULL_FACE', 'CULL_FACE_MODE', 'CURRENT_PROGRAM', 'DEPTH_BITS', 'DEPTH_CLEAR_VALUE', 'DEPTH_FUNC', 'DEPTH_RANGE', 'DEPTH_TEST', 'DEPTH_WRITEMASK', 'DITHER', 'ELEMENT_ARRAY_BUFFER_BINDING', 'FRAMEBUFFER_BINDING', 'FRONT_FACE', 'GENERATE_MIPMAP_HINT', 'GREEN_BITS', 'IMPLEMENTATION_COLOR_READ_FORMAT', 'IMPLEMENTATION_COLOR_READ_TYPE', 'LINE_WIDTH', 'MAX_COMBINED_TEXTURE_IMAGE_UNITS', 'MAX_CUBE_MAP_TEXTURE_SIZE', 'MAX_FRAGMENT_UNIFORM_VECTORS', 'MAX_RENDERBUFFER_SIZE', 'MAX_TEXTURE_IMAGE_UNITS', 'MAX_TEXTURE_SIZE', 'MAX_VARYING_VECTORS', 'MAX_VERTEX_ATTRIBS', 'MAX_VERTEX_TEXTURE_IMAGE_UNITS', 'MAX_VERTEX_UNIFORM_VECTORS', 'MAX_VIEWPORT_DIMS', 'PACK_ALIGNMENT', 'POLYGON_OFFSET_FACTOR', 'POLYGON_OFFSET_FILL', 'POLYGON_OFFSET_UNITS', 'RED_BITS', 'RENDERBUFFER_BINDING', 'RENDERER', 'SAMPLE_ALPHA_TO_COVERAGE', 'SAMPLE_BUFFERS', 'SAMPLE_COVERAGE', 'SAMPLE_COVERAGE_INVERT', 'SAMPLE_COVERAGE_VALUE', 'SAMPLES', 'SCISSOR_BOX', 'SCISSOR_TEST', 'SHADING_LANGUAGE_VERSION', 'STENCIL_BACK_FAIL', 'STENCIL_BACK_FUNC', 'STENCIL_BACK_PASS_DEPTH_FAIL', 'STENCIL_BACK_PASS_DEPTH_PASS', 'STENCIL_BACK_REF', 'STENCIL_BACK_VALUE_MASK', 'STENCIL_BACK_WRITEMASK', 'STENCIL_BITS', 'STENCIL_CLEAR_VALUE', 'STENCIL_FAIL', 'STENCIL_FUNC', 'STENCIL_PASS_DEPTH_FAIL', 'STENCIL_PASS_DEPTH_PASS', 'STENCIL_REF', 'STENCIL_TEST', 'STENCIL_VALUE_MASK', 'STENCIL_WRITEMASK', 'SUBPIXEL_BITS', 'TEXTURE_BINDING_2D', 'TEXTURE_BINDING_CUBE_MAP', 'UNPACK_ALIGNMENT', 'UNPACK_COLORSPACE_CONVERSION_WEBGL', 'UNPACK_FLIP_Y_WEBGL', 'UNPACK_PREMULTIPLY_ALPHA_WEBGL', 'VENDOR', 'VERSION', 'VIEWPORT'];
    var WEBGL2_PNAMES = ['COPY_READ_BUFFER_BINDING', 'COPY_WRITE_BUFFER_BINDING', 'DRAW_BUFFER0', 'DRAW_FRAMEBUFFER_BINDING', 'FRAGMENT_SHADER_DERIVATIVE_HINT', 'MAX_3D_TEXTURE_SIZE', 'MAX_ARRAY_TEXTURE_LAYERS', 'MAX_CLIENT_WAIT_TIMEOUT_WEBGL', 'MAX_COLOR_ATTACHMENTS', 'MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS', 'MAX_COMBINED_UNIFORM_BLOCKS', 'MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS', 'MAX_DRAW_BUFFERS', 'MAX_ELEMENT_INDEX', 'MAX_ELEMENTS_INDICES', 'MAX_ELEMENTS_VERTICES', 'MAX_FRAGMENT_INPUT_COMPONENTS', 'MAX_FRAGMENT_UNIFORM_BLOCKS', 'MAX_FRAGMENT_UNIFORM_COMPONENTS', 'MAX_PROGRAM_TEXEL_OFFSET', 'MAX_SAMPLES', 'MAX_SERVER_WAIT_TIMEOUT', 'MAX_TEXTURE_LOD_BIAS', 'MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS', 'MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS', 'MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS', 'MAX_UNIFORM_BLOCK_SIZE', 'MAX_UNIFORM_BUFFER_BINDINGS', 'MAX_VARYING_COMPONENTS', 'MAX_VERTEX_OUTPUT_COMPONENTS', 'MAX_VERTEX_UNIFORM_BLOCKS', 'MAX_VERTEX_UNIFORM_COMPONENTS', 'MIN_PROGRAM_TEXEL_OFFSET', 'PACK_ROW_LENGTH', 'PACK_SKIP_PIXELS', 'PACK_SKIP_ROWS', 'PIXEL_PACK_BUFFER_BINDING', 'PIXEL_UNPACK_BUFFER_BINDING', 'RASTERIZER_DISCARD', 'READ_BUFFER', 'READ_FRAMEBUFFER_BINDING', 'SAMPLE_ALPHA_TO_COVERAGE', 'SAMPLER_BINDING', 'TEXTURE_BINDING_2D_ARRAY', 'TEXTURE_BINDING_3D', 'TRANSFORM_FEEDBACK_ACTIVE', 'TRANSFORM_FEEDBACK_BINDING', 'TRANSFORM_FEEDBACK_BUFFER_BINDING', 'TRANSFORM_FEEDBACK_PAUSED', 'UNIFORM_BUFFER_BINDING', 'UNIFORM_BUFFER_OFFSET_ALIGNMENT', 'UNPACK_IMAGE_HEIGHT', 'UNPACK_ROW_LENGTH', 'UNPACK_SKIP_IMAGES', 'UNPACK_SKIP_PIXELS', 'UNPACK_SKIP_ROWS', 'VERTEX_ARRAY_BINDING'];

    function make(scope, kind, w, h, attrs) {
        var canvas = scope.document ? scope.document.createElement('canvas') : new OffscreenCanvas(w, h);
        canvas.width = w; canvas.height = h;
        if (scope.document) scope.document.body.appendChild(canvas);
        return [canvas, canvas.getContext(kind, attrs)];
    }

    function identity(scope, prefix) {
        ['webgl', 'experimental-webgl', 'webgl2'].forEach(function (kind) {
            var gl;
            try { gl = make(scope, kind, 4, 4)[1]; } catch (e) { R[prefix + 'context.' + kind] = '!' + e.name; return; }
            R[prefix + 'context.' + kind] = gl ? Object.prototype.toString.call(gl) : null;
        });
        ['webgl', 'webgl2'].forEach(function (kind) {
            var p = prefix + kind;
            var gl = make(scope, kind, 8, 8)[1];
            if (!gl) return;
            R[p + '.attributes'] = describe(gl.getContextAttributes());
            R[p + '.attributes.custom'] = describe(make(scope, kind, 8, 8, { alpha: false, depth: false, stencil: true, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: 'low-power' })[1].getContextAttributes());
            R[p + '.drawingBuffer'] = [gl.drawingBufferWidth, gl.drawingBufferHeight, gl.drawingBufferColorSpace, String(gl.unpackColorSpace)];
            R[p + '.extensions'] = gl.getSupportedExtensions();
            var names = WEBGL1_PNAMES.concat(kind === 'webgl2' ? WEBGL2_PNAMES : []);
            names.forEach(function (name) {
                var v = gl.getParameter(gl[name]);
                R[p + '.param.' + name] = [describe(v), gl.getError()];
            });
            R[p + '.param.bogus'] = [describe(gl.getParameter(0x1234)), gl.getError()];
            R[p + '.param.UNMASKED_before'] = [describe(gl.getParameter(0x9246)), gl.getError()];
            var dbg = gl.getExtension('WEBGL_debug_renderer_info');
            R[p + '.debug_renderer_info'] = dbg ? [gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL), gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL), gl.getError()] : null;
            [gl.VERTEX_SHADER, gl.FRAGMENT_SHADER].forEach(function (s) {
                [gl.LOW_FLOAT, gl.MEDIUM_FLOAT, gl.HIGH_FLOAT, gl.LOW_INT, gl.MEDIUM_INT, gl.HIGH_INT].forEach(function (pr) {
                    R[p + '.precision.' + s + '.' + pr] = describe(gl.getShaderPrecisionFormat(s, pr));
                });
            });
            R[p + '.precision.bogus'] = [describe(gl.getShaderPrecisionFormat(0x1234, gl.LOW_FLOAT)), gl.getError()];
            (gl.getSupportedExtensions() || []).forEach(function (e) {
                var x = gl.getExtension(e);
                var proto = x && Object.getPrototypeOf(x);
                R[p + '.ext.' + e] = x ? Object.prototype.toString.call(x) + ':' + Object.keys(proto).sort().map(function (k) {
                    var d = Object.getOwnPropertyDescriptor(proto, k);
                    return typeof d.value === 'function' ? k + '/' + d.value.length : k + '=' + d.value;
                }).join(',') : null;
            });
            R[p + '.ext.bogus'] = gl.getExtension('NOT_AN_EXTENSION');
        });
    }

    function triangle(scope, prefix, kind) {
        var scene = prefix + kind + '.triangle';
        var made = make(scope, kind, 64, 48);
        var gl = made[1];
        if (!gl) return null;
        var v = recorder(scene, gl);
        program(v, gl, VS1, FS1);
        var b = v('createBuffer');
        v('bindBuffer', gl.ARRAY_BUFFER, b);
        v('bufferData', gl.ARRAY_BUFFER, new Float32Array([-0.8, -0.8, 1, 0, 0, 0.8, -0.8, 0, 1, 0, 0, 0.8, 0, 0, 1]), gl.STATIC_DRAW);
        var prog = gl.getParameter(gl.CURRENT_PROGRAM);
        var pl = v('getAttribLocation', prog, 'p');
        var cl = v('getAttribLocation', prog, 'col');
        v('enableVertexAttribArray', pl);
        v('vertexAttribPointer', pl, 2, gl.FLOAT, false, 20, 0);
        v('enableVertexAttribArray', cl);
        v('vertexAttribPointer', cl, 3, gl.FLOAT, false, 20, 8);
        v('getVertexAttrib', pl, gl.VERTEX_ATTRIB_ARRAY_SIZE);
        v('getVertexAttribOffset', cl, gl.VERTEX_ATTRIB_ARRAY_POINTER);
        v('clearColor', 0.1, 0.2, 0.3, 1);
        v('clear', gl.COLOR_BUFFER_BIT);
        v('drawArrays', gl.TRIANGLES, 0, 3);
        pixels(scene, gl, 64, 48);
        // The canvas read in the same task as the drawing (no frame presented in between).
        if (scope.document) {
            var c2 = scope.document.createElement('canvas'); c2.width = 64; c2.height = 48;
            var x2 = c2.getContext('2d'); x2.drawImage(made[0], 0, 0);
            var d = x2.getImageData(32, 24, 1, 1).data;
            R[scene + '.sameTask.drawImage'] = [d[0], d[1], d[2], d[3]];
            R[scene + '.sameTask.toDataURL'] = made[0].toDataURL().slice(0, 22);
        }
        return made[0];
    }

    function textures(scope, prefix, kind) {
        var scene = prefix + kind + '.textures';
        var gl = make(scope, kind, 32, 32)[1];
        if (!gl) return;
        var v = recorder(scene, gl);
        program(v, gl, 'attribute vec2 p; varying vec2 uv; void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }',
            'precision mediump float; varying vec2 uv; uniform sampler2D t; uniform vec4 tint; void main(){ gl_FragColor = texture2D(t, uv) * tint; }');
        var prog = gl.getParameter(gl.CURRENT_PROGRAM);
        var b = v('createBuffer');
        v('bindBuffer', gl.ARRAY_BUFFER, b);
        v('bufferData', gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        v('enableVertexAttribArray', 0);
        v('vertexAttribPointer', 0, 2, gl.FLOAT, false, 0, 0);
        var t = v('createTexture');
        v('activeTexture', gl.TEXTURE0);
        v('bindTexture', gl.TEXTURE_2D, t);
        v('pixelStorei', gl.UNPACK_ALIGNMENT, 1);
        v('texImage2D', gl.TEXTURE_2D, 0, gl.RGB, 3, 3, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 0, 255, 255, 255, 0, 255, 128, 128, 128, 0, 0, 0, 255, 255, 255]));
        v('texParameteri', gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        v('texParameteri', gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        v('texParameteri', gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        v('texParameteri', gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        v('getTexParameter', gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER);
        v('uniform1i', v('getUniformLocation', prog, 't'), 0);
        v('uniform4f', v('getUniformLocation', prog, 'tint'), 1, 0.5, 1, 1);
        v('drawArrays', gl.TRIANGLE_STRIP, 0, 4);
        pixels(scene + '.nearest', gl, 32, 32);
        v('texParameteri', gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        v('drawArrays', gl.TRIANGLE_STRIP, 0, 4);
        pixels(scene + '.linear', gl, 32, 32);
        // Flip and premultiply on upload, and a sub-image.
        v('pixelStorei', gl.UNPACK_FLIP_Y_WEBGL, true);
        v('pixelStorei', gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        v('texImage2D', gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 0, 0, 128, 0, 255, 0, 255, 0, 0, 255, 64, 255, 255, 255, 255]));
        v('texSubImage2D', gl.TEXTURE_2D, 0, 1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([10, 20, 30, 40]));
        v('texParameteri', gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        v('drawArrays', gl.TRIANGLE_STRIP, 0, 4);
        pixels(scene + '.flipped', gl, 32, 32);
        v('generateMipmap', gl.TEXTURE_2D);
        // Errors: bad target, bad level, size mismatch, a texture bound to two targets.
        v('texImage2D', 0x1234, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        v('texImage2D', gl.TEXTURE_2D, -1, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        v('texImage2D', gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(3));
        v('texImage2D', gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, null);
        v('texImage2D', gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        v('bindTexture', gl.TEXTURE_CUBE_MAP, t);
        v('texParameteri', gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, 0x1234);
    }

    // Image sources (ImageData, a 2D canvas) uploaded in every WebGL 1 format and type, with flip and premultiply, and
    // the WebGL 2 sized formats and unpack sub-rectangle: drawn and read back. A texel of zero alpha keeps its colour
    // unless premultiplied.
    function sources(scope, prefix, kind) {
        var scene = prefix + kind + '.sources';
        var gl = make(scope, kind, 4, 4)[1];
        if (!gl) return;
        var v = recorder(scene, gl);
        program(v, gl, 'attribute vec2 p; varying vec2 uv; void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }',
            'precision mediump float; varying vec2 uv; uniform sampler2D t; void main(){ gl_FragColor = texture2D(t, uv); }');
        var b = v('createBuffer');
        v('bindBuffer', gl.ARRAY_BUFFER, b);
        v('bufferData', gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        v('enableVertexAttribArray', 0);
        v('vertexAttribPointer', 0, 2, gl.FLOAT, false, 0, 0);
        var data = new ImageData(new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 0, 0, 255, 0, 255, 0, 64, 255, 128]), 2, 2);
        var c2 = scope.document ? scope.document.createElement('canvas') : new OffscreenCanvas(2, 2);
        c2.width = 2; c2.height = 2;
        var x = c2.getContext('2d');
        x.fillStyle = '#ff0000'; x.fillRect(0, 0, 2, 1);
        x.fillStyle = 'rgba(0, 255, 0, 0.5)'; x.fillRect(0, 1, 2, 1);
        var t = v('createTexture');
        v('bindTexture', gl.TEXTURE_2D, t);
        v('texParameteri', gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        v('texParameteri', gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        var formats = [['RGBA', 'UNSIGNED_BYTE'], ['RGB', 'UNSIGNED_BYTE'], ['RGBA', 'UNSIGNED_SHORT_4_4_4_4'], ['RGBA', 'UNSIGNED_SHORT_5_5_5_1'],
            ['RGB', 'UNSIGNED_SHORT_5_6_5'], ['LUMINANCE', 'UNSIGNED_BYTE'], ['LUMINANCE_ALPHA', 'UNSIGNED_BYTE'], ['ALPHA', 'UNSIGNED_BYTE']];
        var n = 0;
        [['data', data], ['canvas', c2]].forEach(function (src) {
            formats.forEach(function (f) {
                [[false, false], [true, false], [false, true]].forEach(function (fp) {
                    var name = scene + '.' + src[0] + '.' + f[0] + '.' + f[1] + (fp[0] ? '.flip' : '') + (fp[1] ? '.premul' : '');
                    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, fp[0]);
                    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, fp[1]);
                    // Every other upload goes through texSubImage2D onto a null-initialised level.
                    if (n++ % 2) {
                        gl.texImage2D(gl.TEXTURE_2D, 0, gl[f[0]], 2, 2, 0, gl[f[0]], gl[f[1]], null);
                        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl[f[0]], gl[f[1]], src[1]);
                    } else {
                        gl.texImage2D(gl.TEXTURE_2D, 0, gl[f[0]], gl[f[0]], gl[f[1]], src[1]);
                    }
                    var e = gl.getError();
                    gl.clearColor(0, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
                    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                    var px = new Uint8Array(64);
                    gl.readPixels(0, 0, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, px);
                    R[name] = [e, Array.prototype.slice.call(px, 0, 4), Array.prototype.slice.call(px, 12, 16), Array.prototype.slice.call(px, 48, 52), Array.prototype.slice.call(px, 60, 64), gl.getError()];
                });
            });
        });
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        if (kind !== 'webgl2') return;
        // WebGL 2: sized formats, and a 1x1 sub-rectangle (skip one pixel and one row) of the source.
        [['RGBA8', 'RGBA', 'UNSIGNED_BYTE'], ['RGB8', 'RGB', 'UNSIGNED_BYTE'], ['R8', 'RED', 'UNSIGNED_BYTE'], ['RG8', 'RG', 'UNSIGNED_BYTE'],
            ['RGBA16F', 'RGBA', 'HALF_FLOAT'], ['RGBA32F', 'RGBA', 'FLOAT'], ['SRGB8_ALPHA8', 'RGBA', 'UNSIGNED_BYTE'], ['RGB5_A1', 'RGBA', 'UNSIGNED_BYTE']].forEach(function (f) {
            var name = scene + '.sized.' + f[0];
            gl.texImage2D(gl.TEXTURE_2D, 0, gl[f[0]], gl[f[1]], gl[f[2]], data);
            var e = gl.getError();
            gl.clearColor(0, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            var px = new Uint8Array(64);
            gl.readPixels(0, 0, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, px);
            R[name] = [e, Array.prototype.slice.call(px, 0, 4), Array.prototype.slice.call(px, 60, 64), gl.getError()];
        });
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 1);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        var e2 = gl.getError();
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        var one = new Uint8Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one);
        R[scene + '.subrect'] = [e2, Array.prototype.slice.call(one), gl.getError()];
    }

    function framebuffers(scope, prefix, kind) {
        var scene = prefix + kind + '.framebuffers';
        var gl = make(scope, kind, 16, 16, { antialias: false })[1];
        if (!gl) return;
        var v = recorder(scene, gl);
        program(v, gl, VS1, FS1);
        var fb = v('createFramebuffer');
        var tex = v('createTexture');
        v('bindTexture', gl.TEXTURE_2D, tex);
        v('texImage2D', gl.TEXTURE_2D, 0, gl.RGBA, 8, 8, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        v('bindFramebuffer', gl.FRAMEBUFFER, fb);
        v('checkFramebufferStatus', gl.FRAMEBUFFER);
        v('framebufferTexture2D', gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        v('checkFramebufferStatus', gl.FRAMEBUFFER);
        v('getFramebufferAttachmentParameter', gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE);
        var rb = v('createRenderbuffer');
        v('bindRenderbuffer', gl.RENDERBUFFER, rb);
        v('renderbufferStorage', gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, 8, 8);
        v('getRenderbufferParameter', gl.RENDERBUFFER, gl.RENDERBUFFER_WIDTH);
        v('framebufferRenderbuffer', gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
        v('checkFramebufferStatus', gl.FRAMEBUFFER);
        v('viewport', 0, 0, 8, 8);
        v('clearColor', 0, 1, 0, 1);
        v('clear', gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        v('enable', gl.SCISSOR_TEST);
        v('scissor', 2, 2, 3, 3);
        v('clearColor', 1, 0, 1, 1);
        v('clear', gl.COLOR_BUFFER_BIT);
        v('disable', gl.SCISSOR_TEST);
        pixels(scene + '.fbo', gl, 8, 8);
        v('readPixels', 0, 0, 2, 2, gl.RGBA, gl.FLOAT, new Float32Array(16));
        v('readPixels', 0, 0, 2, 2, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array(12));
        v('readPixels', 0, 0, 2, 2, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
        v('bindFramebuffer', gl.FRAMEBUFFER, null);
        v('copyTexImage2D', gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, 4, 4, 0);
        v('deleteFramebuffer', fb);
        v('isFramebuffer', fb);
        v('bindFramebuffer', gl.FRAMEBUFFER, fb);
        v('bindFramebuffer', 0x1234, null);
        v('clear', 0x1);
        pixels(scene + '.default', gl, 16, 16);
    }

    function instancing(scope, prefix, kind) {
        var scene = prefix + kind + '.instancing';
        var gl = make(scope, kind, 40, 40, { antialias: false })[1];
        if (!gl) return;
        var v = recorder(scene, gl);
        var ext = kind === 'webgl' ? v('getExtension', 'ANGLE_instanced_arrays') : null;
        program(v, gl, 'attribute vec2 p; attribute vec2 off; attribute vec3 col; varying vec3 vc; void main(){ vc = col; gl_Position = vec4(p * 0.2 + off, 0.0, 1.0); }', FS1);
        var prog = gl.getParameter(gl.CURRENT_PROGRAM);
        var lp = gl.getAttribLocation(prog, 'p'), lo = gl.getAttribLocation(prog, 'off'), lc = gl.getAttribLocation(prog, 'col');
        var b = v('createBuffer');
        v('bindBuffer', gl.ARRAY_BUFFER, b);
        v('bufferData', gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 0, 1]), gl.STATIC_DRAW);
        v('enableVertexAttribArray', lp);
        v('vertexAttribPointer', lp, 2, gl.FLOAT, false, 0, 0);
        var ib = v('createBuffer');
        v('bindBuffer', gl.ARRAY_BUFFER, ib);
        v('bufferData', gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 1, 0, 0, 0.5, -0.5, 0, 1, 0, -0.5, 0.5, 0, 0, 1, 0.5, 0.5, 1, 1, 0]), gl.STATIC_DRAW);
        v('enableVertexAttribArray', lo);
        v('vertexAttribPointer', lo, 2, gl.FLOAT, false, 20, 0);
        v('enableVertexAttribArray', lc);
        v('vertexAttribPointer', lc, 3, gl.FLOAT, false, 20, 8);
        var idx = v('createBuffer');
        v('bindBuffer', gl.ELEMENT_ARRAY_BUFFER, idx);
        v('bufferData', gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2]), gl.STATIC_DRAW);
        if (ext) {
            ext.vertexAttribDivisorANGLE(lo, 1); R[scene + '.divisor'] = gl.getError();
            ext.vertexAttribDivisorANGLE(lc, 1);
            ext.drawElementsInstancedANGLE(gl.TRIANGLES, 3, gl.UNSIGNED_SHORT, 0, 4); R[scene + '.draw'] = gl.getError();
            ext.drawArraysInstancedANGLE(gl.TRIANGLES, 0, 3, -1); R[scene + '.drawbad'] = gl.getError();
        } else if (gl.vertexAttribDivisor) {
            v('vertexAttribDivisor', lo, 1);
            v('vertexAttribDivisor', lc, 1);
            v('drawElementsInstanced', gl.TRIANGLES, 3, gl.UNSIGNED_SHORT, 0, 4);
            v('drawArraysInstanced', gl.TRIANGLES, 0, 3, -1);
            v('drawElements', gl.TRIANGLES, 3, gl.UNSIGNED_SHORT, 1);
            v('drawElements', gl.TRIANGLES, 30, gl.UNSIGNED_SHORT, 0);
        }
        pixels(scene, gl, 40, 40);
    }

    function webgl2Only(scope, prefix) {
        var gl = make(scope, 'webgl2', 8, 8, { antialias: false })[1];
        if (!gl) return;
        // The is* queries of WebGL 2's objects, getFragDataLocation and copyTexSubImage3D (missing before).
        var w = recorder(prefix + 'webgl2.objects', gl);
        var q = w('createQuery'), sm = w('createSampler'), tf = w('createTransformFeedback'), sy = w('fenceSync', gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        w('isQuery', null); w('isQuery', q); w('beginQuery', gl.ANY_SAMPLES_PASSED, q); w('endQuery', gl.ANY_SAMPLES_PASSED); w('isQuery', q);
        w('isSampler', null); w('isSampler', sm); w('isTransformFeedback', tf); w('bindTransformFeedback', gl.TRANSFORM_FEEDBACK, tf); w('isTransformFeedback', tf);
        w('bindTransformFeedback', gl.TRANSFORM_FEEDBACK, null); w('isSync', null); w('isSync', sy);
        w('deleteQuery', q); w('isQuery', q); w('deleteSampler', sm); w('isSampler', sm); w('deleteSync', sy); w('isSync', sy);
        var fp = program(w, gl, '#version 300 es\nin vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }',
            '#version 300 es\nprecision mediump float; layout(location = 1) out vec4 b; layout(location = 0) out vec4 a; void main(){ a = vec4(1.0); b = vec4(0.5); }');
        w('getFragDataLocation', fp, 'a'); w('getFragDataLocation', fp, 'b'); w('getFragDataLocation', fp, 'c'); w('getFragDataLocation', fp, 'gl_FragColor');
        var t3 = w('createTexture'); w('bindTexture', gl.TEXTURE_3D, t3); w('texStorage3D', gl.TEXTURE_3D, 1, gl.RGBA8, 4, 4, 2);
        w('copyTexSubImage3D', gl.TEXTURE_3D, 0, 0, 0, 1, 0, 0, 4, 4); w('copyTexSubImage3D', gl.TEXTURE_3D, 0, 0, 0, 5, 0, 0, 4, 4);
        // Transform feedback.
        var scene = prefix + 'webgl2.transformfeedback';
        var v = recorder(scene, gl);
        var vs = '#version 300 es\nin float x; out float y; out vec2 z; void main(){ y = x * 2.0 + 1.0; z = vec2(x, -x); gl_Position = vec4(0.0); }';
        var fs = '#version 300 es\nprecision mediump float; out vec4 o; void main(){ o = vec4(1.0); }';
        var s1 = v('createShader', gl.VERTEX_SHADER); v('shaderSource', s1, vs); v('compileShader', s1);
        var s2 = v('createShader', gl.FRAGMENT_SHADER); v('shaderSource', s2, fs); v('compileShader', s2);
        var p = v('createProgram'); v('attachShader', p, s1); v('attachShader', p, s2);
        v('transformFeedbackVaryings', p, ['y', 'z'], gl.INTERLEAVED_ATTRIBS);
        v('linkProgram', p);
        v('getProgramParameter', p, gl.LINK_STATUS);
        v('getProgramParameter', p, gl.TRANSFORM_FEEDBACK_VARYINGS);
        v('getTransformFeedbackVarying', p, 0);
        v('getTransformFeedbackVarying', p, 1);
        v('getTransformFeedbackVarying', p, 2);
        v('useProgram', p);
        var vao = v('createVertexArray'); v('bindVertexArray', vao);
        var inb = v('createBuffer'); v('bindBuffer', gl.ARRAY_BUFFER, inb);
        v('bufferData', gl.ARRAY_BUFFER, new Float32Array([1, 2, 3, 4]), gl.STATIC_DRAW);
        v('enableVertexAttribArray', 0); v('vertexAttribPointer', 0, 1, gl.FLOAT, false, 0, 0);
        var outb = v('createBuffer'); v('bindBuffer', gl.TRANSFORM_FEEDBACK_BUFFER, outb);
        v('bufferData', gl.TRANSFORM_FEEDBACK_BUFFER, 48, gl.STATIC_READ);
        var tf = v('createTransformFeedback'); v('bindTransformFeedback', gl.TRANSFORM_FEEDBACK, tf);
        v('bindBufferBase', gl.TRANSFORM_FEEDBACK_BUFFER, 0, outb);
        v('enable', gl.RASTERIZER_DISCARD);
        v('beginTransformFeedback', gl.POINTS);
        v('drawArrays', gl.POINTS, 0, 4);
        v('drawArrays', gl.TRIANGLES, 0, 3);
        v('endTransformFeedback');
        v('disable', gl.RASTERIZER_DISCARD);
        v('bindTransformFeedback', gl.TRANSFORM_FEEDBACK, null);
        var out = new Float32Array(12);
        v('getBufferSubData', gl.TRANSFORM_FEEDBACK_BUFFER, 0, out);
        R[scene + '.result'] = Array.prototype.slice.call(out);
        v('getBufferSubData', gl.TRANSFORM_FEEDBACK_BUFFER, 40, out);
        // Uniform buffers.
        scene = prefix + 'webgl2.ubo';
        v = recorder(scene, gl);
        vs = '#version 300 es\nlayout(std140) uniform Block { vec4 color; mat2 m; float k[3]; } blk; in vec2 p; void main(){ gl_Position = vec4(blk.m * p * blk.k[2], 0.0, 1.0); }';
        fs = '#version 300 es\nprecision highp float; layout(std140) uniform Block { vec4 color; mat2 m; float k[3]; } blk; uniform Other { vec2 q; }; out vec4 o; void main(){ o = blk.color + vec4(q, 0.0, 0.0); }';
        s1 = v('createShader', gl.VERTEX_SHADER); v('shaderSource', s1, vs); v('compileShader', s1); v('getShaderInfoLog', s1);
        s2 = v('createShader', gl.FRAGMENT_SHADER); v('shaderSource', s2, fs); v('compileShader', s2); v('getShaderInfoLog', s2);
        p = v('createProgram'); v('attachShader', p, s1); v('attachShader', p, s2); v('linkProgram', p);
        v('getProgramParameter', p, gl.LINK_STATUS);
        v('getProgramParameter', p, gl.ACTIVE_UNIFORM_BLOCKS);
        v('getProgramParameter', p, gl.ACTIVE_UNIFORMS);
        var bi = v('getUniformBlockIndex', p, 'Block');
        v('getUniformBlockIndex', p, 'Nope');
        v('getActiveUniformBlockName', p, bi);
        v('getActiveUniformBlockName', p, 7);
        [gl.UNIFORM_BLOCK_BINDING, gl.UNIFORM_BLOCK_DATA_SIZE, gl.UNIFORM_BLOCK_ACTIVE_UNIFORMS, gl.UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES, gl.UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER, gl.UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER].forEach(function (pn) {
            v('getActiveUniformBlockParameter', p, bi, pn);
        });
        var indices = v('getUniformIndices', p, ['Block.color', 'Block.m', 'Block.k[0]', 'q', 'missing']);
        var valid = (indices || []).filter(function (i) { return i !== gl.INVALID_INDEX; });
        [gl.UNIFORM_TYPE, gl.UNIFORM_SIZE, gl.UNIFORM_BLOCK_INDEX, gl.UNIFORM_OFFSET, gl.UNIFORM_ARRAY_STRIDE, gl.UNIFORM_MATRIX_STRIDE, gl.UNIFORM_IS_ROW_MAJOR].forEach(function (pn) {
            v('getActiveUniforms', p, valid, pn);
        });
        for (var i = 0; i < 6; i++) v('getActiveUniform', p, i);
        v('uniformBlockBinding', p, bi, 3);
        v('getActiveUniformBlockParameter', p, bi, gl.UNIFORM_BLOCK_BINDING);
        var ub = v('createBuffer'); v('bindBuffer', gl.UNIFORM_BUFFER, ub);
        v('bufferData', gl.UNIFORM_BUFFER, new Float32Array([0.25, 0.5, 0.75, 1, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), gl.DYNAMIC_DRAW);
        v('bindBufferRange', gl.UNIFORM_BUFFER, 3, ub, 0, 96);
        v('bindBufferRange', gl.UNIFORM_BUFFER, 3, ub, 3, 16);
        v('getIndexedParameter', gl.UNIFORM_BUFFER_BINDING, 3);
        v('getIndexedParameter', gl.UNIFORM_BUFFER_SIZE, 3);
        // Queries, samplers, syncs, 3D textures.
        scene = prefix + 'webgl2.objects';
        v = recorder(scene, gl);
        var q = v('createQuery');
        v('beginQuery', gl.ANY_SAMPLES_PASSED, q);
        v('getQuery', gl.ANY_SAMPLES_PASSED, gl.CURRENT_QUERY);
        v('endQuery', gl.ANY_SAMPLES_PASSED);
        v('getQueryParameter', q, gl.QUERY_RESULT_AVAILABLE);
        v('beginQuery', 0x1234, q);
        var smp = v('createSampler');
        v('samplerParameteri', smp, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        v('getSamplerParameter', smp, gl.TEXTURE_MIN_FILTER);
        v('samplerParameteri', smp, gl.TEXTURE_MIN_FILTER, 0x1234);
        v('bindSampler', 0, smp);
        var sync = v('fenceSync', gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        v('getSyncParameter', sync, gl.OBJECT_TYPE);
        v('clientWaitSync', sync, 0, 1);
        v('deleteSync', sync);
        var t3 = v('createTexture');
        v('bindTexture', gl.TEXTURE_3D, t3);
        v('texImage3D', gl.TEXTURE_3D, 0, gl.RGBA8, 2, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(32));
        v('texStorage2D', gl.TEXTURE_2D, 1, gl.RGBA8, 4, 4);
        var t2 = v('createTexture');
        v('bindTexture', gl.TEXTURE_2D, t2);
        v('texStorage2D', gl.TEXTURE_2D, 1, gl.RGBA8, 4, 4);
        v('texImage2D', gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        v('getInternalformatParameter', gl.RENDERBUFFER, gl.RGBA8, gl.SAMPLES);
        v('getInternalformatParameter', gl.RENDERBUFFER, gl.RGBA32F, gl.SAMPLES);
        v('vertexAttribI4i', 1, 1, -2, 3, -4);
        v('getVertexAttrib', 1, gl.CURRENT_VERTEX_ATTRIB);
        v('clearBufferfv', gl.COLOR, 0, [0.5, 0.25, 0.125, 1]);
        v('clearBufferiv', gl.COLOR, 0, [1, 2, 3, 4]);
        pixels(scene, gl, 8, 8);
    }

    function errors(scope, prefix, kind) {
        var scene = prefix + kind + '.errors';
        var gl = make(scope, kind, 8, 8)[1];
        if (!gl) return;
        var v = recorder(scene, gl);
        v('bindBuffer', 0x1234, null);
        v('drawArrays', gl.TRIANGLES, 0, 3);
        v('drawArrays', gl.TRIANGLES, -1, 3);
        v('drawArrays', 0x1234, 0, 3);
        v('enable', 0x1234);
        v('isEnabled', 0x1234);
        v('blendFunc', gl.CONSTANT_COLOR, gl.CONSTANT_ALPHA);
        v('depthRange', 2, -1);
        v('getParameter', gl.DEPTH_RANGE);
        v('lineWidth', 0);
        v('lineWidth', NaN);
        v('viewport', 0, 0, -1, 1);
        v('scissor', 0, 0, 1, -1);
        v('stencilFunc', 0x1234, 0, 0);
        v('pixelStorei', gl.UNPACK_ALIGNMENT, 3);
        v('pixelStorei', 0x1234, 1);
        v('activeTexture', gl.TEXTURE0 - 1);
        v('activeTexture', gl.TEXTURE0 + 1000);
        v('vertexAttribPointer', 0, 5, gl.FLOAT, false, 0, 0);
        v('vertexAttribPointer', 0, 2, gl.FLOAT, false, 0, 0);
        v('vertexAttribPointer', 0, 2, gl.FLOAT, false, 0, 3);
        v('vertexAttribPointer', 999, 2, gl.FLOAT, false, 0, 0);
        v('enableVertexAttribArray', 999);
        v('uniform1f', null, 1);
        v('useProgram', null);
        v('bufferData', gl.ARRAY_BUFFER, 4, gl.STATIC_DRAW);
        var b = v('createBuffer');
        v('bindBuffer', gl.ARRAY_BUFFER, b);
        v('bindBuffer', gl.ELEMENT_ARRAY_BUFFER, b);
        v('bufferData', gl.ARRAY_BUFFER, -1, gl.STATIC_DRAW);
        v('bufferData', gl.ARRAY_BUFFER, 8, 0x1234);
        v('bufferSubData', gl.ARRAY_BUFFER, 4, new Uint8Array(8));
        v('bufferData', gl.ARRAY_BUFFER, 8, gl.STATIC_DRAW);
        v('bufferSubData', gl.ARRAY_BUFFER, 4, new Uint8Array(8));
        v('getBufferParameter', gl.ARRAY_BUFFER, gl.BUFFER_SIZE);
        v('getBufferParameter', gl.ARRAY_BUFFER, 0x1234);
        // Shader compile and link failures, info logs.
        var s = v('createShader', gl.VERTEX_SHADER);
        v('shaderSource', s, 'void main(){ gl_Position = undefinedThing; }');
        v('compileShader', s);
        v('getShaderParameter', s, gl.COMPILE_STATUS);
        v('getShaderInfoLog', s);
        v('getShaderSource', s);
        v('getShaderParameter', s, 0x1234);
        var f = v('createShader', gl.FRAGMENT_SHADER);
        v('shaderSource', f, 'precision mediump float; varying vec3 nope; void main(){ gl_FragColor = vec4(nope, 1.0); }');
        v('compileShader', f);
        var vs = v('createShader', gl.VERTEX_SHADER);
        v('shaderSource', vs, 'void main(){ gl_Position = vec4(0.0); }');
        v('compileShader', vs);
        var p = v('createProgram');
        v('linkProgram', p);
        v('getProgramParameter', p, gl.LINK_STATUS);
        v('attachShader', p, vs);
        v('attachShader', p, vs);
        v('attachShader', p, f);
        v('linkProgram', p);
        v('getProgramParameter', p, gl.LINK_STATUS);
        v('getProgramInfoLog', p);
        v('getAttachedShaders', p);
        v('useProgram', p);
        v('validateProgram', p);
        v('getProgramParameter', p, gl.VALIDATE_STATUS);
        v('deleteShader', vs);
        v('isShader', vs);
        v('getShaderParameter', vs, gl.DELETE_STATUS);
        v('createShader', 0x1234);
        v('getUniformLocation', p, 'x');
        v('getActiveAttrib', p, 0);
        v('getActiveUniform', p, 99);
        v('getError');
    }

    function contextLoss(scope, prefix, kind) {
        var scene = prefix + kind + '.loss';
        var made = make(scope, kind, 8, 8);
        var canvas = made[0], gl = made[1];
        if (!gl) return Promise.resolve();
        var events = [];
        canvas.addEventListener('webglcontextlost', function (e) { events.push('lost:' + e.statusMessage + ':' + e.cancelable + ':' + gl.isContextLost()); e.preventDefault(); });
        canvas.addEventListener('webglcontextrestored', function (e) { events.push('restored:' + gl.isContextLost() + ':' + gl.getError()); });
        var ext = gl.getExtension('WEBGL_lose_context');
        R[scene + '.ext'] = ext ? Object.prototype.toString.call(ext) : null;
        if (!ext) return Promise.resolve();
        var b = gl.createBuffer();
        var lp = program(recorder(scene + '.program', gl), gl, 'attribute vec2 p; uniform vec2 u; void main(){ gl_Position = vec4(p + u, 0.0, 1.0); }',
            'precision mediump float; void main(){ gl_FragColor = vec4(1.0); }');
        var lu = gl.getUniformLocation(lp, 'u');
        // A program and a location of another context, and a location of another program: INVALID_OPERATION, null.
        var other = make(scope, kind, 2, 2)[1];
        var op = program(recorder(scene + '.other', other), other, 'attribute vec2 p; uniform vec2 u; void main(){ gl_Position = vec4(p + u, 0.0, 1.0); }',
            'precision mediump float; void main(){ gl_FragColor = vec4(1.0); }');
        var ou = other.getUniformLocation(op, 'u');
        R[scene + '.crossContext'] = [describe(gl.getUniform(op, lu)), gl.getError(), describe(gl.getUniform(lp, ou)), gl.getError(),
            describe(gl.getUniformLocation(op, 'u')), gl.getError(), gl.getAttribLocation(op, 'p'), gl.getError(), describe(gl.getUniform(lp, lu)), gl.getError()];
        other.getExtension('WEBGL_lose_context').loseContext();
        ext.loseContext();
        // A lost context answers -1 and null without an error (the executor's answer was 0 and a location).
        events.push('lost-locations:' + gl.getAttribLocation(lp, 'p') + ':' + describe(gl.getUniformLocation(lp, 'u')) + ':' + describe(gl.getUniform(lp, lu)) + ':' + (gl.getFragDataLocation ? gl.getFragDataLocation(lp, 'x') : 'none'));
        events.push('sync:' + gl.isContextLost() + ':' + gl.getError() + ':' + gl.getError() + ':' + describe(gl.getParameter(gl.MAX_TEXTURE_SIZE)) + ':' + describe(gl.createBuffer()) + ':' + gl.isBuffer(b) + ':' + describe(gl.getContextAttributes()) + ':' + describe(gl.getSupportedExtensions()));
        // A lost context supports no extensions: getExtension is null (it stopped the engine).
        events.push('lost-ext:' + describe(gl.getExtension('OES_texture_float')) + ':' + describe(gl.getExtension('WEBGL_lose_context') === ext));
        ext.loseContext();
        events.push('again:' + gl.getError());
        return new Promise(function (ok) { setTimeout(ok, 50); }).then(function () {
            ext.restoreContext();
            events.push('restore-called:' + gl.isContextLost());
            return new Promise(function (ok) { setTimeout(ok, 100); });
        }).then(function () {
            events.push('after:' + gl.isContextLost() + ':' + gl.getError() + ':' + gl.isBuffer(b) + ':' + describe(gl.getParameter(gl.MAX_TEXTURE_SIZE)));
            ext.restoreContext();
            events.push('restore-again:' + gl.getError());
            R[scene + '.events'] = events;
        });
    }

    // WebGL 1 null uploads with the extensions' formats and types (float, half float, sRGB, depth): the host validates
    // and zero-fills them (an INVALID_ENUM before), and a null upload at a large size is not copied through the engine.
    function nullUploads(scope, prefix) {
        var scene = prefix + 'webgl.nullUploads';
        var gl = make(scope, 'webgl', 2, 2)[1];
        if (!gl) return;
        var v = recorder(scene, gl);
        var half = gl.getExtension('OES_texture_half_float'), srgb = gl.getExtension('EXT_sRGB'), depth = gl.getExtension('WEBGL_depth_texture');
        gl.getExtension('OES_texture_float');
        var t = v('createTexture');
        v('bindTexture', gl.TEXTURE_2D, t);
        v('texImage2D', gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.FLOAT, null);
        if (half) v('texImage2D', gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, half.HALF_FLOAT_OES, null);
        if (srgb) v('texImage2D', gl.TEXTURE_2D, 0, srgb.SRGB_ALPHA_EXT, 2, 2, 0, srgb.SRGB_ALPHA_EXT, gl.UNSIGNED_BYTE, null);
        if (depth) v('texImage2D', gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT, 2, 2, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
        if (depth) v('texImage2D', gl.TEXTURE_CUBE_MAP_POSITIVE_X, 0, gl.DEPTH_COMPONENT, 2, 2, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
        v('texImage2D', gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, 0x1234, null);
        v('texImage2D', gl.TEXTURE_2D, 0, gl.RGBA, 4096, 4096, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        v('texImage2D', gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        var fb = v('createFramebuffer');
        v('bindFramebuffer', gl.FRAMEBUFFER, fb);
        v('framebufferTexture2D', gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        pixels(scene, gl, 2, 2);
    }

    // unpackColorSpace reaches the host: a green sRGB canvas uploaded into display-p3 (117,251,76 in Chrome), then sRGB.
    function unpackColorSpace(scope, prefix) {
        var scene = prefix + 'webgl.unpackColorSpace';
        var gl = make(scope, 'webgl', 2, 2)[1];
        if (!gl || !('unpackColorSpace' in gl) || typeof scope.OffscreenCanvas === 'undefined') return;
        var c = new scope.OffscreenCanvas(2, 2), g = c.getContext('2d');
        g.fillStyle = 'rgb(0, 255, 0)'; g.fillRect(0, 0, 2, 2);
        var v = recorder(scene, gl);
        var t = v('createTexture'); v('bindTexture', gl.TEXTURE_2D, t);
        var fb = v('createFramebuffer'); v('bindFramebuffer', gl.FRAMEBUFFER, fb);
        ['display-p3', 'srgb'].forEach(function (space, i) {
            gl.unpackColorSpace = space;
            R[scene + '.space' + i] = gl.unpackColorSpace;
            v('texImage2D', gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
            v('framebufferTexture2D', gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
            var px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
            R[scene + '.pixel' + i] = Array.prototype.slice.call(px);
        });
    }

    // A small three.js-shaped scene: three lit cubes with depth, indexed, matrices built in JS.
    function cubes(scope, prefix, kind) {
        var scene = prefix + kind + '.cubes';
        var made = make(scope, kind, 96, 64, { antialias: false });
        var gl = made[1];
        if (!gl) return null;
        var v = recorder(scene, gl);
        program(v, gl,
            'attribute vec3 p; attribute vec3 n; uniform mat4 mvp; uniform mat4 model; varying vec3 vn; void main(){ vn = mat3(model) * n; gl_Position = mvp * vec4(p, 1.0); }',
            'precision mediump float; varying vec3 vn; uniform vec3 color; void main(){ float l = max(dot(normalize(vn), normalize(vec3(0.5, 0.8, 0.6))), 0.0); gl_FragColor = vec4(color * (0.2 + 0.8 * l), 1.0); }');
        var prog = gl.getParameter(gl.CURRENT_PROGRAM);
        var P = [], N = [], I = [];
        var faces = [[0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0]];
        faces.forEach(function (f, fi) {
            var u = f[0] ? [0, 1, 0] : [1, 0, 0], w = [f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]];
            [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (c) {
                P.push(f[0] * 0.5 + (u[0] * c[0] + w[0] * c[1]) * 0.5, f[1] * 0.5 + (u[1] * c[0] + w[1] * c[1]) * 0.5, f[2] * 0.5 + (u[2] * c[0] + w[2] * c[1]) * 0.5);
                N.push(f[0], f[1], f[2]);
            });
            I.push(fi * 4, fi * 4 + 1, fi * 4 + 2, fi * 4, fi * 4 + 2, fi * 4 + 3);
        });
        var pb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(P), gl.STATIC_DRAW);
        var lp = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, 0, 0);
        var nb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, nb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(N), gl.STATIC_DRAW);
        var ln = gl.getAttribLocation(prog, 'n'); gl.enableVertexAttribArray(ln); gl.vertexAttribPointer(ln, 3, gl.FLOAT, false, 0, 0);
        var ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(I), gl.STATIC_DRAW);
        function mul(a, b) { var r = []; for (var i = 0; i < 4; i++) for (var j = 0; j < 4; j++) { var s = 0; for (var k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]; r[i * 4 + j] = s; } return r; }
        function rot(ax, ay, tx, ty, tz) { var cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay); return [cy, sx * sy, -cx * sy, 0, 0, cx, sx, 0, sy, -sx * cy, cx * cy, 0, tx, ty, tz, 1]; }
        var f = 1 / Math.tan(0.5), near = 0.1, far = 20, aspect = 96 / 64;
        var proj = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0];
        gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);
        gl.clearColor(0.05, 0.05, 0.1, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        var lm = gl.getUniformLocation(prog, 'mvp'), lmo = gl.getUniformLocation(prog, 'model'), lc = gl.getUniformLocation(prog, 'color');
        [[0.4, 0.6, -1.4, 0, -4, [1, 0.3, 0.2]], [0.9, -0.3, 0, 0.3, -3.5, [0.2, 0.9, 0.4]], [-0.5, 1.2, 1.5, -0.2, -5, [0.3, 0.4, 1]]].forEach(function (c) {
            var model = rot(c[0], c[1], c[2], c[3], c[4]);
            gl.uniformMatrix4fv(lmo, false, new Float32Array(model));
            gl.uniformMatrix4fv(lm, false, new Float32Array(mul(proj, model)));
            gl.uniform3fv(lc, new Float32Array(c[5]));
            gl.drawElements(gl.TRIANGLES, I.length, gl.UNSIGNED_SHORT, 0);
        });
        R[scene + '.error'] = gl.getError();
        pixels(scene, gl, 96, 64);
        return made[0];
    }

    // ImageBitmaps with imageOrientation / premultiplyAlpha uploaded to WebGL (UNPACK_FLIP_Y and PREMULTIPLY are ignored
    // for them): what the bitmap holds is what the texture gets.
    function bitmaps(scope, prefix) {
        var scene = prefix + 'webgl.bitmaps';
        var gl = make(scope, 'webgl', 2, 2)[1];
        if (!gl || !scope.createImageBitmap) return Promise.resolve();
        var data = new ImageData(new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 0, 0, 255, 0, 128, 0, 64, 255, 255]), 2, 2);
        var options = [{}, { imageOrientation: 'flipY' }, { imageOrientation: 'none' }, { premultiplyAlpha: 'none' }, { premultiplyAlpha: 'premultiply' },
            { imageOrientation: 'flipY', premultiplyAlpha: 'none' }];
        return Promise.all(options.map(function (o) { return scope.createImageBitmap(data, o).catch(function (e) { return '!' + e.name; }); })).then(function (list) {
            var t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            var fb = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
            list.forEach(function (b, i) {
                var key = scene + '.' + JSON.stringify(options[i]);
                if (typeof b === 'string') { R[key] = b; return; }
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, b);
                var e = gl.getError();
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
                var px = new Uint8Array(16);
                gl.readPixels(0, 0, 2, 2, gl.RGBA, gl.UNSIGNED_BYTE, px);
                R[key] = [b.width, b.height, e, Array.prototype.slice.call(px), gl.getError()];
            });
        });
    }

    // WebGL 2 uploads from a PIXEL_UNPACK_BUFFER (the GLintptr overloads), and GLintptr arguments that are negative.
    function unpackBuffer(scope, prefix) {
        var scene = prefix + 'webgl2.unpackbuffer';
        var gl = make(scope, 'webgl2', 2, 2)[1];
        if (!gl) return;
        var v = recorder(scene, gl);
        var t = v('createTexture');
        v('bindTexture', gl.TEXTURE_2D, t);
        v('texImage2D', gl.TEXTURE_2D, 0, gl.RGBA8, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        var b = v('createBuffer');
        v('bindBuffer', gl.PIXEL_UNPACK_BUFFER, b);
        v('bufferData', gl.PIXEL_UNPACK_BUFFER, new Uint8Array([1, 2, 3, 4, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 9]), gl.STATIC_DRAW);
        v('texImage2D', gl.TEXTURE_2D, 0, gl.RGBA8, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, 4);
        v('texSubImage2D', gl.TEXTURE_2D, 0, 1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, 16);
        v('texImage2D', gl.TEXTURE_2D, 0, gl.RGBA8, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, -1);
        v('texImage2D', gl.TEXTURE_2D, 0, gl.RGBA8, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(16));
        v('bufferSubData', gl.PIXEL_UNPACK_BUFFER, -1, new Uint8Array(1));
        v('compressedTexImage2D', gl.TEXTURE_2D, 0, 0x9274, 4, 4, 0, 8, 0);
        var t3 = v('createTexture');
        v('bindTexture', gl.TEXTURE_3D, t3);
        v('texImage3D', gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, 8);
        v('texSubImage3D', gl.TEXTURE_3D, 0, 0, 0, 1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        v('bindBuffer', gl.PIXEL_UNPACK_BUFFER, null);
        var fb = v('createFramebuffer');
        v('bindFramebuffer', gl.FRAMEBUFFER, fb);
        v('framebufferTexture2D', gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        pixels(scene, gl, 2, 2);
    }

    // Uniform uploads whose arrays are empty, short or not a whole number of elements (INVALID_VALUE, as Chrome; an empty
    // matrix array stopped the engine on a size check in the executor's replay), typed arrays of another type, and
    // values a uniform of another type refuses.
    function uniformArrays(scope, prefix, kind) {
        var scene = prefix + kind + '.uniforms';
        var gl = make(scope, kind, 2, 2)[1];
        if (!gl) return;
        var v = recorder(scene, gl);
        var p = program(v, gl,
            'attribute vec2 p; uniform mat2 m2; uniform mat3 m3; uniform mat4 m4; uniform vec2 v2; uniform float f[2]; uniform ivec2 i2; ' +
            'void main(){ gl_Position = m4 * vec4(m3 * vec3(m2 * p, 1.0), 1.0) + vec4(v2, f[0] + f[1], float(i2.x)); }',
            'precision mediump float; void main(){ gl_FragColor = vec4(1.0); }');
        var u = function (n) { return v('getUniformLocation', p, n); };
        var m2 = u('m2'), m3 = u('m3'), m4 = u('m4'), v2 = u('v2'), f = u('f'), i2 = u('i2');
        v('uniformMatrix2fv', m2, false, []);
        v('uniformMatrix2fv', m2, false, [1, 2, 3]);
        v('uniformMatrix3fv', m3, false, []);
        v('uniformMatrix4fv', m4, false, []);
        v('uniformMatrix4fv', m4, false, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 9]);
        v('uniformMatrix4fv', m4, false, new Float32Array(16));
        v('uniformMatrix2fv', m2, false, new Float64Array(4));
        v('uniform2fv', v2, []);
        v('uniform2fv', v2, [1]);
        v('uniform2fv', v2, new Int32Array([1, 2]));
        v('uniform1fv', f, []);
        v('uniform1fv', f, [1, 2]);
        v('uniform2iv', i2, []);
        v('uniform2iv', i2, new Float32Array([1, 2]));
        v('uniform2iv', i2, new Uint8Array([1, 2]));
        v('getUniform', p, i2);
        v('uniform2iv', v2, [1, 2]);
    }

    // Drawing buffers without alpha, and unpremultiplied ones: ALPHA_BITS, a clear whose alpha is ignored, blending as
    // if the destination alpha were 1, and the canvas as others see it (the Khronos context-attributes and
    // webgl-to-2d-canvas pages).
    function alphaAttributes(scope, prefix) {
        var out = [];
        [['noalpha', { alpha: false }], ['unpremultiplied', { premultipliedAlpha: false }], ['noalpha.unpremultiplied', { alpha: false, premultipliedAlpha: false }]].forEach(function (c) {
            var made = make(scope, 'webgl', 4, 4, c[1]);
            var gl = made[1];
            if (!gl) return;
            var scene = prefix + 'webgl.alpha.' + c[0];
            var v = recorder(scene, gl);
            v('getParameter', gl.ALPHA_BITS);
            v('clearColor', 0.25, 0.5, 1, 0.5);
            v('clear', gl.COLOR_BUFFER_BIT);
            pixels(scene, gl, 4, 4);
            v('enable', gl.BLEND);
            v('blendFunc', gl.DST_ALPHA, gl.ZERO);
            v('clearColor', 1, 1, 1, 1);
            v('clear', gl.COLOR_BUFFER_BIT);
            out.push(exportCanvas(scope, prefix, 'webgl.alpha.' + c[0] + '.export', made[0]));
        });
        return out;
    }

    // The canvas leaves WebGL: toDataURL, drawImage into 2D, and createImageBitmap (preserveDrawingBuffer false: same frame).
    function exportCanvas(scope, prefix, name, canvas) {
        if (!canvas) return Promise.resolve();
        var key = prefix + name;
        var bitmap = createImageBitmap(canvas); // taken now, in the drawing task
        bitmap.catch(function () {});
        var decoded = Promise.resolve();
        if (canvas.toDataURL) {
            // The PNG bytes are each encoder's own; the pixels they decode to are compared.
            var url = canvas.toDataURL();
            R[key + '.toDataURL'] = url.slice(0, 22);
            decoded = new Promise(function (ok) {
                var im = new Image();
                im.onload = function () {
                    var c = scope.document.createElement('canvas'); c.width = im.width; c.height = im.height;
                    var x = c.getContext('2d'); x.drawImage(im, 0, 0);
                    R[key + '.toDataURL.pixels'] = [im.width, im.height, fnv(x.getImageData(0, 0, im.width, im.height).data)];
                    ok();
                };
                im.onerror = function () { R[key + '.toDataURL.pixels'] = 'error'; ok(); };
                im.src = url;
            });
        }
        var c2 = scope.document ? scope.document.createElement('canvas') : new OffscreenCanvas(canvas.width, canvas.height);
        c2.width = canvas.width; c2.height = canvas.height;
        var ctx = c2.getContext('2d');
        ctx.drawImage(canvas, 0, 0);
        var img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        R[key + '.drawImage'] = fnv(img);
        var w = canvas.width, h = canvas.height, at = function (x, y) { var o = (y * w + x) * 4; return [img[o], img[o + 1], img[o + 2], img[o + 3]]; };
        R[key + '.drawImage.samples'] = [at(0, 0), at(w >> 1, h >> 1), at(w - 1, h - 1), at(w >> 2, h >> 2), at((w * 3) >> 2, (h * 3) >> 2)];
        return decoded.then(function () { return bitmap; }).then(function (b) {
            var c3 = scope.document ? scope.document.createElement('canvas') : new OffscreenCanvas(b.width, b.height);
            c3.width = b.width; c3.height = b.height;
            var x = c3.getContext('2d');
            x.drawImage(b, 0, 0);
            R[key + '.imageBitmap'] = fnv(x.getImageData(0, 0, b.width, b.height).data);
        }, function (e) { R[key + '.imageBitmap'] = '!' + e.name; });
    }

    return function run(scope, prefix) {
        prefix = prefix || '';
        identity(scope, prefix);
        var exported = [];
        ['webgl', 'webgl2'].forEach(function (kind) {
            // Exported in the task that drew them: a frame presented in between clears a non-preserved buffer.
            exported.push(exportCanvas(scope, prefix, kind + '.triangle', triangle(scope, prefix, kind)));
            textures(scope, prefix, kind);
            sources(scope, prefix, kind);
            framebuffers(scope, prefix, kind);
            instancing(scope, prefix, kind);
            errors(scope, prefix, kind);
            exported.push(exportCanvas(scope, prefix, kind + '.cubes', cubes(scope, prefix, kind)));
        });
        webgl2Only(scope, prefix);
        unpackBuffer(scope, prefix);
        uniformArrays(scope, prefix, 'webgl');
        uniformArrays(scope, prefix, 'webgl2');
        nullUploads(scope, prefix);
        unpackColorSpace(scope, prefix);
        exported = exported.concat(alphaAttributes(scope, prefix));
        exported.push(bitmaps(scope, prefix));
        return Promise.all(exported).then(function () { return contextLoss(scope, prefix, 'webgl'); })
            .then(function () { return contextLoss(scope, prefix, 'webgl2'); })
            .then(function () { return R; });
    };
})();
