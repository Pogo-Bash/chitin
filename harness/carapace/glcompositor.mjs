// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// The compositor's WebGL2 backend (docs/compositor.md): one canvas per segment, each tile a texture drawn as a quad
// under its layer's affine map, clipped by the layer's clip (scissor), and backdrop-filter blur/saturate run on the GPU
// over what is already drawn (copy the region and a margin, two separable Gaussian passes, saturate, draw back inside
// the rounded region). Draws at the host's animation frames, when something changed (a segment frame or a scroll).
// The segment never touches this context: only the carapace's code does (docs/security.md).
import { LayerTree, intersect } from './compositor.mjs';

const VS = `#version 300 es
in vec2 a;
uniform mat3 u_m;        // local -> viewport (device px)
uniform vec4 u_rect;     // the quad in local px
uniform vec2 u_size;     // the frame in device px
uniform vec2 u_uv;       // the part of the texture the quad covers (scratch textures can be larger)
uniform float u_flip;    // 1: a bottom-up texture (drawn into as a framebuffer)
uniform vec2 u_uv0;      // where that part starts in the texture
out vec2 v_uv;
void main() {
    vec2 local = u_rect.xy + a * u_rect.zw;
    vec3 p = u_m * vec3(local, 1.0);
    v_uv = u_uv0 + vec2(a.x, mix(a.y, 1.0 - a.y, u_flip)) * u_uv;
    gl_Position = vec4(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0, 0.0, 1.0);
}`;
// u_rr > 0: only inside the rounded rect u_rclip (device px, y down) of corner radius u_rr (a rounded scrollport,
// docs/scroll.md R1); the tiles are premultiplied, so coverage scales all four channels.
const FS_TILE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec4 u_rclip;
uniform float u_rr;
uniform vec2 u_fb;
out vec4 o;
void main() {
    o = texture(u_tex, v_uv);
    if (u_rr > 0.0) {
        vec2 p = vec2(gl_FragCoord.x, u_fb.y - gl_FragCoord.y);
        vec2 q = clamp(p, u_rclip.xy + u_rr, u_rclip.xy + u_rclip.zw - u_rr);
        o *= clamp(0.5 - (length(p - q) - u_rr), 0.0, 1.0);
    }
}`;
// A separable Gaussian pass over u_tex (texel step u_dir), radius 3 sigma.
const FS_BLUR = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_dir;     // one source texel along the pass, in uv
uniform float u_sigma;  // in source texels
uniform float u_step;   // texels between taps (2 on a downsampling pass: linear filtering averages the pair)
out vec4 o;
void main() {
    if (u_sigma <= 0.0) { o = texture(u_tex, v_uv); return; }
    float r = ceil(u_sigma * 3.0 / u_step);
    vec4 acc = vec4(0.0); float w = 0.0;
    for (float i = -64.0; i <= 64.0; i += 1.0) {
        if (abs(i) > r) continue;
        float d = i * u_step;
        float k = exp(-0.5 * d * d / (u_sigma * u_sigma));
        acc += texture(u_tex, v_uv + u_dir * d) * k;
        w += k;
    }
    o = acc / w;
}`;
// The blurred backdrop drawn back: saturate, then only inside the rounded region (u_region in device px, y down).
const FS_BACK = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec4 u_region;
uniform float u_radius;
uniform float u_saturate;
uniform vec2 u_size;
out vec4 o;
void main() {
    vec4 c = texture(u_tex, v_uv);
    float s = u_saturate;
    mat3 sat = mat3(0.213 + 0.787 * s, 0.213 - 0.213 * s, 0.213 - 0.213 * s,
                    0.715 - 0.715 * s, 0.715 + 0.285 * s, 0.715 - 0.715 * s,
                    0.072 - 0.072 * s, 0.072 - 0.072 * s, 0.072 + 0.928 * s);
    c.rgb = clamp(sat * c.rgb, 0.0, 1.0);
    vec2 p = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);
    vec2 lo = u_region.xy + u_radius, hi = u_region.xy + u_region.zw - u_radius;
    vec2 q = clamp(p, lo, hi);
    float d = length(p - q) - u_radius;
    float cover = u_radius > 0.0 ? clamp(0.5 - d, 0.0, 1.0) : 1.0;
    o = vec4(c.rgb, 1.0) * cover;
}`;

function program(gl, vs, fs) {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
            throw new Error('shader: ' + gl.getShaderInfoLog(s));
        gl.attachShader(p, s);
    }
    gl.bindAttribLocation(p, 0, 'a');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
        throw new Error('program: ' + gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i);
        u[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
}

export class GLCompositor {
    // `canvas`: a canvas element the carapace placed over the view. Throws when WebGL2 is not there (the caller falls
    // back to the DOM backend).
    constructor(canvas) {
        this.canvas = canvas;
        const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
        if (!gl)
            throw new Error('no WebGL2');
        this.gl = gl;
        this.tree = new LayerTree(this);
        this.tileProg = program(gl, VS, FS_TILE);
        this.blurProg = program(gl, VS, FS_BLUR);
        this.backProg = program(gl, VS, FS_BACK);
        this.quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        this.scratch = [null, null, null]; // the copied backdrop and two half-size blur targets
        this.fbo = gl.createFramebuffer();
        this.dirty = true;
        this.lost = false;
        this.stats = { composites: 0, lastMs: 0, ms: [], gpuMs: [] };
        // GPU time per composite where the host exposes it (EXT_disjoint_timer_query_webgl2): the benchmarks' number.
        this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
        this.queries = [];
        // Nested segments (cross-site iframes) as layers over the parent's: key -> { tex, w, h, rect (device px) }.
        this.externals = new Map();
        canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    }
    newTile(w, h) {
        const gl = this.gl;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
        for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
            gl.texParameteri(gl.TEXTURE_2D, k, v);
        return { tex, w, h };
    }
    dropTile(tile) {
        this.gl.deleteTexture(tile.tex);
    }
    writeTile(tile, x, y, w, h, bitmap) {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, tile.tex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        bitmap.close?.();
    }
    apply(tree, bitmaps) {
        if (this.canvas.width !== tree.w || this.canvas.height !== tree.h) {
            this.canvas.width = tree.w;
            this.canvas.height = tree.h;
            this.scratch = [null, null, null];
        }
        this.tree.apply(tree, bitmaps);
        this.dirty = true;
    }
    scratchTexture(k, w, h) {
        const gl = this.gl;
        let s = this.scratch[k];
        if (!s || s.w < w || s.h < h) {
            if (s) gl.deleteTexture(s.tex);
            s = { tex: gl.createTexture(), w: Math.max(w, s ? s.w : 0), h: Math.max(h, s ? s.h : 0) };
            gl.bindTexture(gl.TEXTURE_2D, s.tex);
            gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, s.w, s.h);
            for (const [kk, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
                gl.texParameteri(gl.TEXTURE_2D, kk, v);
            this.scratch[k] = s;
        }
        return s;
    }
    // Draws the layers; returns the CPU ms it took (the GPU work is queued; `sync` waits for it, for benchmarks).
    composite(sync = false) {
        // A 0x0 tree (a segment before its first layout) has nothing to show: a zero-size target is a GL error
        // (texStorage2D refuses it, then the clear meets an incomplete framebuffer).
        if (this.lost || !(this.tree.width > 0) || !(this.tree.height > 0))
            return 0;
        const t0 = performance.now();
        const gl = this.gl;
        const W = this.tree.width, H = this.tree.height;
        this.pollQueries();
        let query = null;
        if (this.timer && this.queries.length < 8) {
            gl.flush(); // the tile uploads of the frame go first: the query times the composite itself
            query = gl.createQuery();
            gl.beginQuery(this.timer.TIME_ELAPSED_EXT, query);
        }
        // Everything is drawn into an offscreen target, which backdrop passes read directly (no framebuffer copies),
        // then shown with one quad.
        const main = this.mainTarget(W, H);
        gl.bindFramebuffer(gl.FRAMEBUFFER, main.fbo);
        gl.viewport(0, 0, W, H);
        const f = this.tree.fill / 255;
        gl.disable(gl.SCISSOR_TEST);
        gl.clearColor(f, f, f, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindVertexArray(this.vao);
        // Child segments in paint order (docs/scroll.md B3): each after the last layer of the scroller it moves with, so
        // the sticky and fixed layers after it draw over it; moved and clipped with the carapace's scroll of that chain.
        const placed = [...this.externals.values()].filter((e) => e.tex && e.rect).map((e) => ({ e, ...this.tree.externalPlacement(e.rect, e.moves) }));
        const drawExternal = (p) => {
            const clip = intersect([0, 0, W, H], p.clip);
            if (!clip[2] || !clip[3]) return;
            gl.enable(gl.SCISSOR_TEST);
            gl.scissor(clip[0], H - clip[1] - clip[3], clip[2], clip[3]);
            const { p: prog, u } = this.tileProg;
            gl.useProgram(prog);
            gl.uniformMatrix3fv(u.u_m, false, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
            gl.uniform1f(u.u_rr, 0);
            gl.uniform2f(u.u_size, W, H);
            gl.uniform2f(u.u_uv, 1, 1);
            gl.uniform2f(u.u_uv0, 0, 0);
            gl.uniform1f(u.u_flip, 0);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, p.e.tex);
            gl.uniform1i(u.u_tex, 0);
            gl.uniform4f(u.u_rect, p.rect[0], p.rect[1], p.rect[2], p.rect[3]);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        };
        let layerIndex = -1;
        for (const layer of this.tree.order) {
            layerIndex++;
            if (layer.backdrop)
                this.backdrop(layer.backdrop, W, H);
            const m = this.tree.matrixOf(layer);
            const lc = this.tree.clipOf(layer);
            const clip = lc ? intersect([0, 0, W, H], lc) : [0, 0, W, H];
            if (!clip[2] || !clip[3])
                continue;
            gl.enable(gl.SCISSOR_TEST);
            gl.scissor(clip[0], H - clip[1] - clip[3], clip[2], clip[3]);
            const { p, u } = this.tileProg;
            gl.useProgram(p);
            gl.uniformMatrix3fv(u.u_m, false, [m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1]);
            gl.uniform1f(u.u_rr, lc && layer.rr ? layer.rr : 0);
            if (lc && layer.rr) { gl.uniform4f(u.u_rclip, lc[0], lc[1], lc[2], lc[3]); gl.uniform2f(u.u_fb, W, H); }
            gl.uniform2f(u.u_size, W, H);
            gl.uniform1i(u.u_tex, 0);
            gl.uniform2f(u.u_uv, 1, 1);
            gl.uniform2f(u.u_uv0, 0, 0);
            gl.uniform1f(u.u_flip, 0);
            gl.activeTexture(gl.TEXTURE0);
            for (const tile of layer.store.values()) {
                gl.bindTexture(gl.TEXTURE_2D, tile.tex);
                gl.uniform4f(u.u_rect, tile.i * layer.tw, tile.j * layer.th, tile.w, tile.h);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            }
            for (const p of placed) if (p.after === layerIndex) drawExternal(p);
        }
        // The rest (fixed boxes, or no layer of their scroller): over the parent's layers, as before.
        for (const p of placed) if (p.after < 0 || p.after > layerIndex) drawExternal(p);
        gl.disable(gl.SCISSOR_TEST);
        // Show it.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, W, H);
        gl.disable(gl.BLEND);
        {
            const { p, u } = this.tileProg;
            gl.useProgram(p);
            gl.uniformMatrix3fv(u.u_m, false, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
            gl.uniform1f(u.u_rr, 0);
            gl.uniform2f(u.u_size, W, H);
            gl.uniform4f(u.u_rect, 0, 0, W, H);
            gl.uniform2f(u.u_uv, 1, 1);
            gl.uniform2f(u.u_uv0, 0, 0);
            gl.uniform1f(u.u_flip, 1);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, main.tex);
            gl.uniform1i(u.u_tex, 0);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
        if (query) {
            gl.endQuery(this.timer.TIME_ELAPSED_EXT);
            this.queries.push(query);
        }
        if (sync) {
            const px = new Uint8Array(4);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        }
        const ms = performance.now() - t0;
        this.stats.composites++;
        this.stats.lastMs = ms;
        this.stats.ms.push(ms);
        if (this.stats.ms.length > 600) this.stats.ms.shift();
        this.dirty = false;
        return ms;
    }
    mainTarget(W, H) {
        const gl = this.gl;
        if (!this.main || this.main.w !== W || this.main.h !== H) {
            if (this.main) { gl.deleteTexture(this.main.tex); gl.deleteFramebuffer(this.main.fbo); }
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H);
            for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
                gl.texParameteri(gl.TEXTURE_2D, k, v);
            const fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
            this.main = { tex, fbo, w: W, h: H };
        }
        return this.main;
    }
    pollQueries() {
        const gl = this.gl;
        while (this.queries.length) {
            const q = this.queries[0];
            if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE))
                break;
            const disjoint = gl.getParameter(this.timer.GPU_DISJOINT_EXT);
            const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
            if (!disjoint) {
                this.stats.gpuMs.push(ns / 1e6);
                if (this.stats.gpuMs.length > 600) this.stats.gpuMs.shift();
            }
            gl.deleteQuery(q);
            this.queries.shift();
        }
    }
    // The backdrop of a region: copy (with a 3 sigma margin), blur across then down, draw back inside the region.
    backdrop(bd, W, H) {
        const gl = this.gl;
        const pad = Math.ceil(bd.blur * 3);
        const box = intersect([0, 0, W, H], [Math.floor(bd.region[0]) - pad, Math.floor(bd.region[1]) - pad, Math.ceil(bd.region[2]) + 2 * pad, Math.ceil(bd.region[3]) + 2 * pad]);
        const [bx, by, bw, bh] = box;
        if (!bw || !bh)
            return;
        gl.disable(gl.SCISSOR_TEST);
        // Blurs of 4 px and more run at half size (a quarter of the pixels, half the taps): a horizontal pass over the main
        // target that also halves (taps two texels apart, linear filtering), a vertical pass at half size; the result is
        // drawn back with linear filtering.
        const q = bd.blur >= 4 ? 2 : 1;
        const hw = Math.ceil(bw / q), hh = Math.ceil(bh / q);
        const main = this.main;
        const b = this.scratchTexture(1, hw, hh), c = this.scratchTexture(2, hw, hh);
        // Scratch textures and the main target are bottom-up (drawn into as framebuffers): sampled with u_flip.
        const pass = (src, x0, y0, sw, sh, dst, dw, dh, dx, dy, sigma, step) => {
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst.tex, 0);
            gl.viewport(0, 0, dw, dh);
            gl.disable(gl.BLEND);
            const { p, u } = this.blurProg;
            gl.useProgram(p);
            gl.uniformMatrix3fv(u.u_m, false, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
            gl.uniform1f(u.u_rr, 0);
            gl.uniform2f(u.u_size, dw, dh);
            gl.uniform4f(u.u_rect, 0, 0, dw, dh);
            gl.uniform2f(u.u_dir, dx / src.w, dy / src.h);
            gl.uniform1f(u.u_sigma, sigma);
            gl.uniform1f(u.u_step, step);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, src.tex);
            gl.uniform1i(u.u_tex, 0);
            gl.uniform2f(u.u_uv0, x0 / src.w, y0 / src.h);
            gl.uniform2f(u.u_uv, sw / src.w, sh / src.h);
            gl.uniform1f(u.u_flip, 1);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        };
        // The box in the main target's (bottom-up) texels.
        pass(main, bx, H - by - bh, bw, bh, b, hw, hh, 1, 0, bd.blur, q);
        pass(b, 0, 0, hw, hh, c, hw, hh, 0, 1, bd.blur / q, 1);
        const result = c;
        gl.bindFramebuffer(gl.FRAMEBUFFER, main.fbo);
        gl.viewport(0, 0, W, H);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        {
            const { p, u } = this.backProg;
            gl.useProgram(p);
            gl.uniformMatrix3fv(u.u_m, false, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
            gl.uniform1f(u.u_rr, 0);
            gl.uniform2f(u.u_size, W, H);
            gl.uniform4f(u.u_rect, bx, by, bw, bh);
            gl.uniform4f(u.u_region, bd.region[0], bd.region[1], bd.region[2], bd.region[3]);
            gl.uniform1f(u.u_radius, bd.radius);
            gl.uniform1f(u.u_saturate, bd.saturate);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, result.tex);
            gl.uniform1i(u.u_tex, 0);
            gl.uniform2f(u.u_uv0, 0, 0);
            gl.uniform2f(u.u_uv, hw / result.w, hh / result.h);
            gl.uniform1f(u.u_flip, 1);
            gl.enable(gl.SCISSOR_TEST);
            const r = intersect(box, bd.region.map(Math.round));
            gl.scissor(r[0], H - r[1] - r[3], r[2], r[3]);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            gl.disable(gl.SCISSOR_TEST);
        }
    }
    // A nested segment's frame (an ImageBitmap of its whole viewport) and where it goes (device px); null removes it.
    setExternal(key, bitmap, rect, moves) {
        const gl = this.gl;
        let ext = this.externals.get(key);
        if (bitmap === null) {
            if (ext && ext.tex) gl.deleteTexture(ext.tex);
            this.externals.delete(key);
            this.dirty = true;
            return;
        }
        if (!ext) {
            ext = { tex: null, w: 0, h: 0, rect, moves: null };
            this.externals.set(key, ext);
        }
        if (rect) ext.rect = rect;
        if (moves !== undefined) ext.moves = moves;
        if (bitmap) {
            if (!ext.tex || ext.w !== bitmap.width || ext.h !== bitmap.height) {
                if (ext.tex) gl.deleteTexture(ext.tex);
                ext.tex = this.newTile(bitmap.width, bitmap.height).tex;
                ext.w = bitmap.width;
                ext.h = bitmap.height;
            }
            gl.bindTexture(gl.TEXTURE_2D, ext.tex);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
            bitmap.close?.();
        }
        this.dirty = true;
    }
    // The composited frame into a 2D context (tests): the canvas as last drawn.
    drawInto(ctx) {
        this.composite();
        ctx.drawImage(this.canvas, 0, 0);
    }
    destroy() {
        for (const ext of this.externals.values()) if (ext.tex) this.gl.deleteTexture(ext.tex);
        for (const layer of this.tree.order) for (const t of layer.store.values()) this.dropTile(t);
        this.canvas.remove();
    }
}
