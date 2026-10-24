// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Canvas 2D (paths, gradients, compositing, text, transforms, ImageData round trips), OffscreenCanvas here and in a Worker, WebGL.
WB.draw2d = function draw2d(ctx, w, h) {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    const g = ctx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, '#f00'); g.addColorStop(0.5, '#0f0'); g.addColorStop(1, '#00f');
    ctx.fillStyle = g; ctx.fillRect(4, 4, w - 8, 20);
    const rg = ctx.createRadialGradient(40, 60, 2, 40, 60, 30); rg.addColorStop(0, 'yellow'); rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(40, 60, 30, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.translate(100, 60); ctx.rotate(Math.PI / 6); ctx.scale(1.5, 0.75);
    ctx.strokeStyle = '#123'; ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.setLineDash([6, 3]);
    ctx.strokeRect(-20, -15, 40, 30); ctx.restore();
    ctx.globalAlpha = 0.5; ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = '#0aa'; ctx.fillRect(60, 30, 50, 50);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath(); ctx.moveTo(130, 90); ctx.bezierCurveTo(140, 40, 170, 120, 180, 60); ctx.quadraticCurveTo(190, 20, 150, 30); ctx.closePath();
    ctx.fillStyle = 'rgba(200, 0, 120, 0.7)'; ctx.fill('evenodd');
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(10, 95, 60, 20, [6, 2]); ctx.fillStyle = '#383'; ctx.fill(); }
    ctx.save(); ctx.beginPath(); ctx.rect(80, 95, 40, 20); ctx.clip(); ctx.fillStyle = '#a50'; ctx.beginPath(); ctx.arc(100, 105, 18, 0, 7); ctx.fill(); ctx.restore();
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 4; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#44f'; ctx.fillRect(130, 95, 30, 20); ctx.shadowColor = 'transparent';
    ctx.font = '14px WBAscii, sans-serif'; ctx.fillStyle = '#000'; ctx.textBaseline = 'alphabetic'; ctx.fillText('Wb 2D', 170, 112);
};
WB.section('canvas', async (t) => {
    const W = 200, H = 120;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; t.root.append(cv);
    await document.fonts.load('14px WBAscii').catch(() => {});
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    await t.check('2d.attrs', () => { const a = ctx.getContextAttributes ? ctx.getContextAttributes() : {}; return [a.alpha, a.desynchronized, a.colorSpace, a.willReadFrequently]; });
    await t.check('2d.defaults', () => [ctx.fillStyle, ctx.strokeStyle, ctx.lineWidth, ctx.font, ctx.textAlign, ctx.textBaseline, ctx.globalCompositeOperation, ctx.imageSmoothingEnabled, ctx.lineCap, ctx.miterLimit, ctx.direction, ctx.filter]);
    await t.check('2d.colorParse', () => ['red', '#abc', '#aabbcc80', 'rgb(1 2 3 / 0.5)', 'hsl(0 100% 50%)', 'transparent', 'nonsense'].map((c) => { ctx.fillStyle = '#123456'; ctx.fillStyle = c; return ctx.fillStyle; }));
    WB.draw2d(ctx, W, H);
    await t.check('2d.pixels', () => t.canvasHash(cv, 8));
    await t.check('2d.exactPixels', () => [[10, 10], [40, 60], [85, 55], [199, 0], [100, 105]].map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]));
    await t.check('2d.transform', () => { ctx.save(); ctx.translate(3, 4); ctx.rotate(0.5); const m = ctx.getTransform(); ctx.restore(); return [m.a, m.b, m.c, m.d, m.e, m.f].map((x) => t.round(x, 4)); });
    await t.check('2d.isPointInPath', () => { const p = new Path2D('M10 10 h50 v50 h-50 z M20 20 h30 v30 h-30 z'); return [ctx.isPointInPath(p, 15, 15), ctx.isPointInPath(p, 30, 30), ctx.isPointInPath(p, 30, 30, 'evenodd'), ctx.isPointInStroke(p, 10, 30)]; });
    await t.check('2d.imageDataRoundTrip', () => { const id = ctx.createImageData(3, 1); id.data.set([255, 0, 0, 128, 0, 255, 0, 255, 0, 0, 255, 1]); ctx.putImageData(id, 0, 0); return [...ctx.getImageData(0, 0, 3, 1).data]; });
    await t.check('2d.toDataURL', () => { const c = document.createElement('canvas'); c.width = 2; c.height = 2; const x = c.getContext('2d'); x.fillStyle = '#f00'; x.fillRect(0, 0, 1, 1); const u = c.toDataURL(); return [u.slice(0, 22), u.length > 50, c.toDataURL('image/jpeg').slice(0, 23), c.toDataURL('image/webp').slice(0, 22)]; });
    await t.check('2d.toBlob', () => new Promise((res) => cv.toBlob((b) => res([b.type, b.size > 100]), 'image/png')));
    await t.check('offscreen.main', async () => {
        const oc = new OffscreenCanvas(W, H); const o = oc.getContext('2d'); WB.draw2d(o, W, H);
        const bmp = oc.transferToImageBitmap();
        const c2 = document.createElement('canvas'); c2.width = W; c2.height = H; c2.getContext('bitmaprenderer').transferFromImageBitmap(bmp);
        const small = new OffscreenCanvas(4, 4); small.getContext('2d').fillRect(0, 0, 2, 2); const blob = await small.convertToBlob();
        return [t.pixHash(o.getImageData(0, 0, W, H), 8), bmp.width, blob.type];
    });
    await t.check('offscreen.worker', () => new Promise((resolve, reject) => {
        const wk = new Worker('canvas-worker.js');
        const c = document.createElement('canvas'); c.width = W; c.height = H; t.root.append(c);
        const off = c.transferControlToOffscreen();
        wk.onmessage = (e) => { wk.terminate(); resolve(e.data); };
        wk.onerror = (e) => { e.preventDefault(); reject(Object.assign(new Error(e.message), { name: 'WorkerError' })); };
        wk.postMessage({ canvas: off, W, H }, [off]);
    }));
    await t.check('webgl', () => {
        const c = document.createElement('canvas'); c.width = 64; c.height = 64;
        const gl = c.getContext('webgl', { preserveDrawingBuffer: true, antialias: false });
        if (!gl) return 'no webgl';
        const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
        const p = gl.createProgram();
        gl.attachShader(p, sh(gl.VERTEX_SHADER, 'attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }'));
        gl.attachShader(p, sh(gl.FRAGMENT_SHADER, 'precision mediump float; void main(){ gl_FragColor = vec4(1.0, 0.5, 0.0, 1.0); }'));
        gl.linkProgram(p);
        const linked = gl.getProgramParameter(p, gl.LINK_STATUS);
        gl.useProgram(p);
        const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.clearColor(0, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 3);
        const px = (x, y) => { const d = new Uint8Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, d); return [...d]; };
        return { linked, below: px(5, 5), above: px(60, 60), error: gl.getError(), webgl2: !!document.createElement('canvas').getContext('webgl2'), maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE) >= 4096, ext: ['OES_texture_float', 'WEBGL_debug_renderer_info', 'ANGLE_instanced_arrays'].map((n) => !!gl.getExtension(n)) };
    });
});
