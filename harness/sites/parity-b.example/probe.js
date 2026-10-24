// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// The Chrome-parity probe (group B: canvas, OffscreenCanvas, ImageData, ImageBitmap, WebGL, SVG text geometry, image
// decoding). Run by Chrome and by Chitin on the same page; tests/chrome/run.mjs compares the two answers key by key
// (values exactly, pixels and lengths within the tolerances it names). Every probe catches its own error and records
// it as `!Name: message`, so one missing member never hides the rest.
function parityProbe(doc, win, base) {
    var r = {};
    function rec(key, fn) {
        try { var v = fn(); r[key] = v === undefined ? '<undefined>' : v; }
        catch (e) { r[key] = '!' + (e && e.name) + ': ' + (e && e.message); }
    }
    function type(v) { return v === null ? 'null' : typeof v; }
    function canvas(w, h) { var c = doc.createElement('canvas'); c.width = w || 20; c.height = h || 20; return c; }
    function px(g, x, y) { return Array.from(g.getImageData(x, y, 1, 1).data); }

    // --- CanvasRenderingContext2D: the members and their defaults --------------------------------------------------
    var proto = win.CanvasRenderingContext2D && win.CanvasRenderingContext2D.prototype;
    var members = ['getLineDash', 'setLineDash', 'lineDashOffset', 'letterSpacing', 'wordSpacing', 'fontKerning', 'fontStretch',
        'fontVariantCaps', 'textRendering', 'roundRect', 'createConicGradient', 'filter', 'imageSmoothingEnabled',
        'imageSmoothingQuality', 'isPointInPath', 'isPointInStroke', 'getContextAttributes', 'reset', 'isContextLost',
        'direction', 'lang', 'textAlign', 'textBaseline', 'createPattern', 'drawFocusIfNeeded', 'getTransform', 'setTransform',
        'resetTransform', 'ellipse', 'clip', 'measureText', 'createImageData', 'getImageData', 'putImageData', 'shadowBlur'];
    r.c2dMembers = members.map(function (m) { return m + ':' + (proto ? (m in proto) : 'no-proto'); });
    var g = canvas(40, 40).getContext('2d');
    ['lineDashOffset', 'letterSpacing', 'wordSpacing', 'fontKerning', 'fontStretch', 'fontVariantCaps', 'textRendering', 'filter',
        'imageSmoothingEnabled', 'imageSmoothingQuality', 'direction', 'lang', 'font', 'lineCap', 'lineJoin', 'miterLimit',
        'globalCompositeOperation', 'shadowColor'].forEach(function (k) { rec('c2d.default.' + k, function () { return g[k]; }); });
    rec('c2d.getLineDash.default', function () { return Array.from(g.getLineDash()); });
    rec('c2d.setLineDash', function () { g.setLineDash([5, 3, 2]); return Array.from(g.getLineDash()); }); // odd -> doubled
    rec('c2d.setLineDash.negative', function () { g.setLineDash([1, -1]); return Array.from(g.getLineDash()); }); // ignored
    rec('c2d.setLineDash.nan', function () { g.setLineDash([1, NaN]); return Array.from(g.getLineDash()); });
    rec('c2d.lineDashOffset.set', function () { g.lineDashOffset = 2.5; g.lineDashOffset = NaN; return g.lineDashOffset; });
    rec('c2d.letterSpacing.set', function () { g.letterSpacing = '3px'; var a = g.letterSpacing; g.letterSpacing = 'bogus'; return [a, g.letterSpacing]; });
    rec('c2d.wordSpacing.set', function () { g.wordSpacing = '1em'; return g.wordSpacing; });
    rec('c2d.fontKerning.set', function () { g.fontKerning = 'none'; var a = g.fontKerning; g.fontKerning = 'NONE'; return [a, g.fontKerning]; });
    rec('c2d.fontStretch.set', function () { g.fontStretch = 'condensed'; return g.fontStretch; });
    rec('c2d.textRendering.set', function () { g.textRendering = 'optimizeLegibility'; var a = g.textRendering; g.textRendering = 'optimizelegibility'; return [a, g.textRendering]; });
    rec('c2d.imageSmoothingQuality.set', function () { g.imageSmoothingQuality = 'high'; var a = g.imageSmoothingQuality; g.imageSmoothingQuality = 'x'; return [a, g.imageSmoothingQuality]; });
    rec('c2d.filter.set', function () { g.filter = 'blur(2px)'; var a = g.filter; g.filter = 'bogus('; return [a, g.filter]; });
    rec('c2d.getContextAttributes', function () { var a = g.getContextAttributes(); return a && JSON.stringify(Object.keys(a).sort().map(function (k) { return [k, a[k]]; })); });
    rec('c2d.getContextAttributes.opts', function () {
        var a = canvas().getContext('2d', { alpha: false, desynchronized: true, willReadFrequently: true, colorSpace: 'display-p3' }).getContextAttributes();
        return JSON.stringify(Object.keys(a).sort().map(function (k) { return [k, a[k]]; }));
    });
    rec('c2d.isContextLost', function () { return g.isContextLost(); });
    rec('c2d.font.set', function () { g.font = 'italic bold 12px/30px serif'; return g.font; });

    // --- drawing that reads back ------------------------------------------------------------------------------------
    rec('c2d.roundRect', function () {
        var h = canvas(40, 40).getContext('2d');
        h.fillStyle = '#f00'; h.beginPath(); h.roundRect(0, 0, 40, 40, 15); h.fill();
        return [px(h, 1, 1)[3], px(h, 20, 20), px(h, 20, 1)];
    });
    rec('c2d.roundRect.radii', function () {
        var h = canvas(40, 40).getContext('2d');
        h.beginPath(); h.roundRect(0, 0, 40, 40, [0, 20]); h.fill();
        return [px(h, 1, 1)[3], px(h, 38, 1)[3], px(h, 38, 38)[3], px(h, 1, 38)[3]];
    });
    rec('c2d.roundRect.errors', function () {
        var h = canvas().getContext('2d'), e = [];
        try { h.roundRect(0, 0, 10, 10, [1, 2, 3, 4, 5]); e.push('ok'); } catch (x) { e.push(x.name); }
        try { h.roundRect(0, 0, 10, 10, -1); e.push('ok'); } catch (x) { e.push(x.name); }
        return e;
    });
    rec('c2d.conicGradient', function () {
        var h = canvas(40, 40).getContext('2d');
        var gr = h.createConicGradient(0, 20, 20); gr.addColorStop(0, '#f00'); gr.addColorStop(0.5, '#00f'); gr.addColorStop(1, '#f00');
        h.fillStyle = gr; h.fillRect(0, 0, 40, 40);
        return [Object.prototype.toString.call(gr), px(h, 38, 21), px(h, 2, 20)];
    });
    rec('c2d.dash.pixels', function () {
        var h = canvas(40, 10).getContext('2d');
        h.strokeStyle = '#000'; h.lineWidth = 4; h.setLineDash([10, 10]); h.beginPath(); h.moveTo(0, 5); h.lineTo(40, 5); h.stroke();
        var a = [px(h, 5, 5)[3], px(h, 15, 5)[3], px(h, 25, 5)[3]];
        h.clearRect(0, 0, 40, 10); h.lineDashOffset = 10; h.beginPath(); h.moveTo(0, 5); h.lineTo(40, 5); h.stroke();
        return a.concat([px(h, 5, 5)[3], px(h, 15, 5)[3]]);
    });
    rec('c2d.isPointInPath', function () {
        var h = canvas(40, 40).getContext('2d');
        h.beginPath(); h.rect(10, 10, 10, 10);
        var p = new win.Path2D(); p.rect(0, 0, 5, 5);
        var ring = new win.Path2D(); ring.rect(0, 0, 30, 30); ring.rect(10, 10, 10, 10);
        return [h.isPointInPath(15, 15), h.isPointInPath(5, 5), h.isPointInPath(p, 2, 2), h.isPointInPath(ring, 15, 15),
            h.isPointInPath(ring, 15, 15, 'evenodd'), h.isPointInPath(NaN, 1)];
    });
    rec('c2d.isPointInPath.transform', function () {
        var h = canvas(40, 40).getContext('2d');
        h.translate(10, 0); h.beginPath(); h.rect(0, 0, 5, 5); // the path is in device space once added
        return [h.isPointInPath(12, 2), h.isPointInPath(2, 2)];
    });
    rec('c2d.isPointInStroke', function () {
        var h = canvas(40, 40).getContext('2d');
        h.lineWidth = 4; h.beginPath(); h.moveTo(0, 20); h.lineTo(40, 20);
        return [h.isPointInStroke(20, 21), h.isPointInStroke(20, 25), h.isPointInStroke(new win.Path2D('M0 0 L40 0'), 20, 0.5)];
    });
    rec('c2d.reset', function () {
        var c = canvas(20, 20), h = c.getContext('2d');
        h.fillStyle = '#f00'; h.lineWidth = 7; h.translate(3, 3); h.setLineDash([2]); h.fillRect(0, 0, 20, 20); h.save(); h.beginPath(); h.rect(0, 0, 5, 5);
        h.reset();
        return [px(h, 10, 10)[3], h.fillStyle, h.lineWidth, Array.from(h.getLineDash()), h.getTransform().e, h.isPointInPath(1, 1), c.width];
    });
    rec('c2d.filter.pixels', function () {
        var h = canvas(20, 20).getContext('2d');
        h.filter = 'invert(1)'; h.fillStyle = '#ff0000'; h.fillRect(0, 0, 20, 20);
        return px(h, 10, 10);
    });
    rec('c2d.filter.blur', function () {
        var h = canvas(40, 20).getContext('2d');
        h.filter = 'blur(3px)'; h.fillRect(20, 0, 20, 20);
        return [px(h, 16, 10)[3] > 0, px(h, 30, 10)[3] > 200];
    });
    rec('c2d.letterSpacing.measure', function () {
        var h = canvas().getContext('2d'); h.font = '20px sans-serif';
        var a = h.measureText('abcd').width; h.letterSpacing = '10px'; var b = h.measureText('abcd').width;
        return Math.round(b - a);
    });
    rec('c2d.wordSpacing.measure', function () {
        var h = canvas().getContext('2d'); h.font = '20px sans-serif';
        var a = h.measureText('a b c').width; h.wordSpacing = '10px'; var b = h.measureText('a b c').width;
        return Math.round(b - a);
    });
    rec('c2d.measureText.keys', function () {
        var h = canvas().getContext('2d'), m = h.measureText('Hg');
        return ['width', 'actualBoundingBoxLeft', 'actualBoundingBoxRight', 'actualBoundingBoxAscent', 'actualBoundingBoxDescent',
            'fontBoundingBoxAscent', 'fontBoundingBoxDescent', 'emHeightAscent', 'emHeightDescent', 'hangingBaseline',
            'alphabeticBaseline', 'ideographicBaseline'].map(function (k) { return k + ':' + type(m[k]); });
    });
    rec('c2d.measureText.ink', function () {
        // The ink box of the glyphs (not the font's ascent/descent): 'x' has no ascender or descender, 'Hg' both.
        var h = canvas().getContext('2d'); h.font = '40px sans-serif';
        var x = h.measureText('x'), hg = h.measureText('Hg');
        h.textAlign = 'center'; var c = h.measureText('Hg');
        return [x.actualBoundingBoxAscent, x.actualBoundingBoxDescent, hg.actualBoundingBoxAscent, hg.actualBoundingBoxDescent,
            hg.actualBoundingBoxLeft, Math.round(c.actualBoundingBoxLeft - c.width / 2), x.actualBoundingBoxAscent < hg.actualBoundingBoxAscent];
    });
    rec('c2d.toDataURL.types', function () {
        var c = canvas(4, 4);
        return ['image/png', 'image/jpeg', 'image/webp', 'image/bogus'].map(function (t) { return c.toDataURL(t).slice(0, 15); });
    });
    rec('c2d.imageSmoothing.pixels', function () {
        var s = canvas(2, 1), sg = s.getContext('2d'); sg.fillStyle = '#000'; sg.fillRect(0, 0, 1, 1); sg.fillStyle = '#fff'; sg.fillRect(1, 0, 1, 1);
        var h = canvas(20, 10).getContext('2d');
        h.imageSmoothingEnabled = false; h.drawImage(s, 0, 0, 20, 10); var a = px(h, 9, 5)[0];
        h.imageSmoothingEnabled = true; h.drawImage(s, 0, 0, 20, 10); var b = px(h, 9, 5)[0];
        return [a, b > 20 && b < 235];
    });

    // --- ImageData ----------------------------------------------------------------------------------------------------
    rec('imagedata.members', function () { var d = new win.ImageData(1, 1); return ['colorSpace', 'pixelFormat', 'data', 'width', 'height'].map(function (k) { return k + ':' + (k in d) + ':' + (typeof d[k] === 'object' ? Object.prototype.toString.call(d[k]) : d[k]); }); });
    rec('imagedata.p3', function () { return new win.ImageData(1, 1, { colorSpace: 'display-p3' }).colorSpace; });
    rec('imagedata.float16', function () { var d = new win.ImageData(1, 1, { pixelFormat: 'rgba-float16' }); return [d.pixelFormat, Object.prototype.toString.call(d.data)]; });
    rec('imagedata.badspace', function () { return new win.ImageData(1, 1, { colorSpace: 'nope' }).colorSpace; });
    rec('imagedata.errors', function () {
        var e = [];
        [[0, 1], [1, 0], [new Uint8ClampedArray(3), 1], [new Uint8ClampedArray(8), 3], [new Uint8ClampedArray(8), 1, 3]].forEach(function (a) {
            try { new win.ImageData(a[0], a[1], a[2]); e.push('ok'); } catch (x) { e.push(x.name); }
        });
        return e;
    });
    rec('c2d.createImageData.settings', function () { var d = g.createImageData(2, 2, { colorSpace: 'display-p3' }); return [d.colorSpace, d.width, d.data.length]; });
    rec('c2d.createImageData.neg', function () { var d = g.createImageData(-3, -2); return [d.width, d.height]; });
    rec('c2d.getImageData.settings', function () { var d = g.getImageData(0, 0, 1, 1, { colorSpace: 'display-p3' }); return d.colorSpace; });
    rec('c2d.getImageData.neg', function () { var d = g.getImageData(5, 5, -2, -2); return [d.width, d.height]; });
    rec('c2d.getImageData.zero', function () { g.getImageData(0, 0, 0, 1); return 'ok'; });
    rec('c2d.p3.getImageData', function () { var h = canvas(1, 1).getContext('2d', { colorSpace: 'display-p3' }); h.fillStyle = '#ff0000'; h.fillRect(0, 0, 1, 1); return [h.getImageData(0, 0, 1, 1).colorSpace, px(h, 0, 0)]; });
    rec('c2d.putImageData.dirty', function () {
        var h = canvas(4, 4).getContext('2d'), d = new win.ImageData(4, 4);
        for (var i = 0; i < d.data.length; i += 4) d.data.set([0, 0, 255, 255], i);
        h.putImageData(d, 0, 0, 1, 1, 2, 2);
        return [px(h, 0, 0)[3], px(h, 1, 1)[2], px(h, 3, 3)[3]];
    });

    // --- OffscreenCanvas (page) --------------------------------------------------------------------------------------
    rec('offscreen.exists', function () { return typeof win.OffscreenCanvas; });
    rec('offscreen.2d', function () {
        var o = new win.OffscreenCanvas(10, 10), h = o.getContext('2d');
        h.fillStyle = '#0f0'; h.fillRect(0, 0, 10, 10);
        return [Object.prototype.toString.call(h), px(h, 5, 5), o.width, typeof h.canvas, h.canvas === o];
    });
    rec('offscreen.contexts', function () {
        return ['2d', 'webgl', 'webgl2', 'bitmaprenderer', 'webgpu', 'bogus'].map(function (t) {
            try { var x = new win.OffscreenCanvas(1, 1).getContext(t); return t + ':' + (x ? Object.prototype.toString.call(x) : 'null'); } catch (e) { return t + ':!' + e.name; }
        });
    });
    rec('offscreen.transfer', function () { var o = new win.OffscreenCanvas(3, 4); o.getContext('2d'); var b = o.transferToImageBitmap(); return [Object.prototype.toString.call(b), b.width, b.height, o.width]; });
    rec('canvas.transferControlToOffscreen', function () { var c = canvas(5, 6), o = c.transferControlToOffscreen(); return [Object.prototype.toString.call(o), o.width]; });
    rec('canvas.contexts', function () {
        return ['2d', 'webgl', 'experimental-webgl', 'webgl2', 'bitmaprenderer', 'webgpu', 'bogus'].map(function (t) {
            try { var x = canvas(1, 1).getContext(t); return t + ':' + (x ? Object.prototype.toString.call(x) : 'null'); } catch (e) { return t + ':!' + e.name; }
        });
    });

    // --- WebGL ----------------------------------------------------------------------------------------------------------
    function gl(kind) {
        var c = canvas(4, 4), x = c.getContext(kind);
        if (!x) { r[kind + '.context'] = 'null'; return; }
        r[kind + '.context'] = Object.prototype.toString.call(x);
        rec(kind + '.attributes', function () { var a = x.getContextAttributes(); return JSON.stringify(Object.keys(a).sort().map(function (k) { return [k, a[k]]; })); });
        rec(kind + '.drawingBufferColorSpace', function () { return [x.drawingBufferColorSpace, x.unpackColorSpace]; });
        rec(kind + '.extensions', function () { return x.getSupportedExtensions().slice().sort(); });
        var p = ['VERSION', 'SHADING_LANGUAGE_VERSION', 'VENDOR', 'RENDERER', 'MAX_TEXTURE_SIZE', 'MAX_VIEWPORT_DIMS', 'MAX_RENDERBUFFER_SIZE',
            'MAX_VERTEX_ATTRIBS', 'MAX_VERTEX_UNIFORM_VECTORS', 'MAX_FRAGMENT_UNIFORM_VECTORS', 'MAX_VARYING_VECTORS', 'MAX_TEXTURE_IMAGE_UNITS',
            'MAX_COMBINED_TEXTURE_IMAGE_UNITS', 'MAX_VERTEX_TEXTURE_IMAGE_UNITS', 'MAX_CUBE_MAP_TEXTURE_SIZE', 'ALIASED_LINE_WIDTH_RANGE',
            'ALIASED_POINT_SIZE_RANGE', 'RED_BITS', 'ALPHA_BITS', 'DEPTH_BITS', 'STENCIL_BITS', 'SAMPLES', 'SAMPLE_BUFFERS'];
        if (kind === 'webgl2') p = p.concat(['MAX_3D_TEXTURE_SIZE', 'MAX_ARRAY_TEXTURE_LAYERS', 'MAX_COLOR_ATTACHMENTS', 'MAX_DRAW_BUFFERS', 'MAX_SAMPLES', 'MAX_UNIFORM_BUFFER_BINDINGS', 'MAX_ELEMENT_INDEX']);
        p.forEach(function (k) { rec(kind + '.param.' + k, function () { var v = x.getParameter(x[k]); return v && v.length !== undefined && typeof v !== 'string' ? Array.from(v) : v; }); });
        rec(kind + '.precision', function () {
            var out = [];
            [['VERTEX_SHADER', 'v'], ['FRAGMENT_SHADER', 'f']].forEach(function (s) {
                ['LOW_FLOAT', 'MEDIUM_FLOAT', 'HIGH_FLOAT', 'LOW_INT', 'MEDIUM_INT', 'HIGH_INT'].forEach(function (t) {
                    var f = x.getShaderPrecisionFormat(x[s[0]], x[t]); out.push(s[1] + t + ':' + f.rangeMin + '/' + f.rangeMax + '/' + f.precision);
                });
            });
            return out;
        });
        rec(kind + '.clear', function () { x.clearColor(1, 0, 0, 1); x.clear(x.COLOR_BUFFER_BIT); var b = new Uint8Array(4); x.readPixels(0, 0, 1, 1, x.RGBA, x.UNSIGNED_BYTE, b); return Array.from(b); });
    }
    gl('webgl');
    gl('webgl2');

    // --- SVG text geometry and getBBox --------------------------------------------------------------------------------
    var NS = 'http://www.w3.org/2000/svg';
    var svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('width', '300'); svg.setAttribute('height', '100');
    svg.innerHTML = '<text id="t1" x="10" y="40" font-family="monospace" font-size="20">Hello</text>' +
        '<text id="t2" x="10" y="80" font-size="20" textLength="200" lengthAdjust="spacingAndGlyphs">ab</text>' +
        '<rect id="r1" x="5" y="6" width="30" height="20" transform="translate(10 10)"/><g id="g1"><circle cx="50" cy="50" r="10"/><rect x="0" y="0" width="5" height="5"/></g>';
    (doc.body || doc.documentElement).appendChild(svg);
    rec('svg.text.members', function () { var t = doc.getElementById('t1'); return ['getComputedTextLength', 'getSubStringLength', 'getStartPositionOfChar', 'getEndPositionOfChar', 'getExtentOfChar', 'getRotationOfChar', 'getCharNumAtPosition', 'getNumberOfChars', 'selectSubString', 'getBBox', 'textLength', 'lengthAdjust'].map(function (k) { return k + ':' + (k in t); }); });
    rec('svg.text.numberOfChars', function () { return doc.getElementById('t1').getNumberOfChars(); });
    rec('svg.text.computedTextLength', function () { return doc.getElementById('t1').getComputedTextLength(); });
    rec('svg.text.subStringLength', function () { return doc.getElementById('t1').getSubStringLength(1, 3); });
    rec('svg.text.subStringLength.err', function () { try { doc.getElementById('t1').getSubStringLength(9, 1); return 'ok'; } catch (e) { return e.name; } });
    rec('svg.text.startOfChar', function () { var p = doc.getElementById('t1').getStartPositionOfChar(2); return [Object.prototype.toString.call(p), p.x, p.y]; });
    rec('svg.text.endOfChar', function () { var p = doc.getElementById('t1').getEndPositionOfChar(2); return [p.x, p.y]; });
    rec('svg.text.extentOfChar', function () { var b = doc.getElementById('t1').getExtentOfChar(0); return [b.x, b.y, b.width, b.height]; });
    rec('svg.text.charNumAtPosition', function () { var t = doc.getElementById('t1'); var p = svg.createSVGPoint(); p.x = 15; p.y = 35; return t.getCharNumAtPosition(p); });
    rec('svg.text.textLength', function () { var t = doc.getElementById('t2'); return [t.textLength.baseVal.value, t.lengthAdjust.baseVal, t.getComputedTextLength()]; });
    rec('svg.text.bbox', function () { var b = doc.getElementById('t1').getBBox(); return [b.x, b.y, b.width, b.height]; });
    rec('svg.rect.bbox', function () { var b = doc.getElementById('r1').getBBox(); return [b.x, b.y, b.width, b.height]; });
    rec('svg.g.bbox', function () { var b = doc.getElementById('g1').getBBox(); return [b.x, b.y, b.width, b.height]; });
    rec('svg.detached.bbox', function () { var e = doc.createElementNS(NS, 'rect'); e.setAttribute('width', '4'); var b = e.getBBox(); return [b.x, b.y, b.width, b.height]; });

    // --- the asynchronous part: ImageBitmap options, workers, image decoding -------------------------------------------
    var jobs = [];
    function arec(key, promise) { jobs.push(Promise.resolve().then(function () { return promise(); }).then(function (v) { r[key] = v === undefined ? '<undefined>' : v; }, function (e) { r[key] = '!' + (e && e.name) + ': ' + (e && e.message); })); }
    function bmpPixels(b, w, h) { var c = canvas(w || b.width, h || b.height), h2 = c.getContext('2d'); h2.drawImage(b, 0, 0); return h2; }
    var src = canvas(4, 2), sg = src.getContext('2d');
    sg.fillStyle = 'rgba(255,0,0,0.5)'; sg.fillRect(0, 0, 2, 2); sg.fillStyle = '#00f'; sg.fillRect(2, 0, 2, 2);
    arec('bitmap.plain', function () { return win.createImageBitmap(src).then(function (b) { var h = bmpPixels(b); return [b.width, b.height, px(h, 0, 0), px(h, 3, 1)]; }); });
    arec('bitmap.flipY', function () { return win.createImageBitmap(src, { imageOrientation: 'flipY' }).then(function (b) { var h = bmpPixels(b); return px(h, 3, 0); }); });
    arec('bitmap.resize', function () { return win.createImageBitmap(src, { resizeWidth: 8, resizeHeight: 6, resizeQuality: 'pixelated' }).then(function (b) { var h = bmpPixels(b); return [b.width, b.height, px(h, 7, 5)]; }); });
    arec('bitmap.crop', function () { return win.createImageBitmap(src, 2, 0, 2, 2).then(function (b) { var h = bmpPixels(b); return [b.width, px(h, 0, 0)]; }); });
    arec('bitmap.cropNeg', function () { return win.createImageBitmap(src, 4, 2, -2, -2).then(function (b) { return [b.width, b.height]; }); });
    arec('bitmap.premultiply', function () {
        var d = new win.ImageData(new Uint8ClampedArray([200, 100, 50, 128]), 1, 1);
        return Promise.all(['default', 'none', 'premultiply'].map(function (m) {
            return win.createImageBitmap(d, { premultiplyAlpha: m }).then(function (b) { return m + ':' + px(bmpPixels(b), 0, 0).join(','); });
        }));
    });
    arec('bitmap.badopts', function () { return win.createImageBitmap(src, { resizeWidth: 0 }).then(function () { return 'ok'; }); });
    arec('bitmap.zeroCrop', function () { return win.createImageBitmap(src, 0, 0, 0, 1).then(function () { return 'ok'; }); });
    arec('bitmap.close', function () { return win.createImageBitmap(src).then(function (b) { b.close(); return [b.width, b.height]; }); });
    arec('bitmap.renderer', function () {
        return win.createImageBitmap(src).then(function (b) {
            var c = canvas(4, 2), x = c.getContext('bitmaprenderer'); if (!x) return 'null';
            x.transferFromImageBitmap(b); return [Object.prototype.toString.call(x), b.width, c.width];
        });
    });
    arec('offscreen.convertToBlob', function () {
        if (typeof win.OffscreenCanvas !== 'function') return 'no OffscreenCanvas';
        var o = new win.OffscreenCanvas(4, 4); o.getContext('2d').fillRect(0, 0, 4, 4);
        return o.convertToBlob().then(function (b) { return [b.type, b.size > 0]; });
    });
    arec('offscreen.worker', function () {
        if (typeof win.Worker !== 'function') return 'no Worker';
        var code = 'try{var o=new OffscreenCanvas(8,8),g=o.getContext("2d");g.fillStyle="#0000ff";g.fillRect(0,0,8,8);var d=Array.from(g.getImageData(1,1,1,1).data);' +
            'var b=o.transferToImageBitmap();var gl=null;try{gl=new OffscreenCanvas(1,1).getContext("webgl2")}catch(e){};postMessage({d:d,w:b.width,gl:gl?Object.prototype.toString.call(gl):"null",cib:typeof createImageBitmap,fonts:typeof self.fonts})}' +
            'catch(e){postMessage({err:e.name+": "+e.message})}';
        var w = new win.Worker(win.URL.createObjectURL(new win.Blob([code], { type: 'text/javascript' })));
        return new Promise(function (ok, no) {
            var t = setTimeout(function () { no(new Error('worker timed out')); }, 8000);
            w.onmessage = function (e) { clearTimeout(t); w.terminate(); ok(JSON.stringify(e.data)); };
            w.onerror = function (e) { clearTimeout(t); no(new Error('worker error ' + (e.message || ''))); };
        });
    });
    arec('offscreen.transferredToWorker', function () {
        if (typeof win.Worker !== 'function') return 'no Worker';
        var c = canvas(6, 6), o;
        try { o = c.transferControlToOffscreen(); } catch (e) { return '!' + e.name; }
        var code = 'onmessage=function(e){try{var o=e.data,g=o.getContext("2d");g.fillStyle="#ff0";g.fillRect(0,0,6,6);postMessage([o.width,o.height])}catch(x){postMessage("!"+x.name)}}';
        var w = new win.Worker(win.URL.createObjectURL(new win.Blob([code], { type: 'text/javascript' })));
        return new Promise(function (ok, no) {
            var t = setTimeout(function () { no(new Error('worker timed out')); }, 8000);
            w.onmessage = function (e) { clearTimeout(t); w.terminate(); ok(JSON.stringify(e.data)); };
            w.postMessage(o, [o]);
        });
    });
    // Images: each drawn onto a canvas, the centre of each column sampled (red, green, blue, the fourth).
    var images = ['pattern.png', 'rgb.png', 'palette.png', 'palette-trns.png', 'palette-2bit.png', 'grey-trns.png', 'rgb-trns.png', 'rgba16.png',
        'interlaced.png', 'gama.png', 'srgb.png', 'iccp-p3.png', 'apng.png', 'opaque64.jpg', 'opaque64.gif', 'opaque64.avif', 'opaque64.webp', 'pattern.svg'];
    images.forEach(function (name) {
        arec('img.' + name, function () {
            return new Promise(function (ok, no) {
                var im = new win.Image();
                im.onload = function () {
                    var w = im.naturalWidth, h = im.naturalHeight, x = canvas(w, h).getContext('2d');
                    x.drawImage(im, 0, 0);
                    var cols = [0, 1, 2, 3].map(function (i) { return px(x, Math.floor((i + 0.5) * w / 4), h >> 1); });
                    win.createImageBitmap(im).then(function (b) { var y = bmpPixels(b); ok([w, h, cols, px(y, Math.floor(w / 8), h >> 1)]); }, function (e) { ok([w, h, cols, '!' + e.name]); });
                };
                im.onerror = function () { ok('error'); };
                im.src = base + 'img/' + name;
            });
        });
    });
    arec('c2d.webp.roundTrip', function () {
        var c = canvas(8, 8), h = c.getContext('2d'); h.fillStyle = '#0080ff'; h.fillRect(0, 0, 8, 8);
        return new Promise(function (ok) {
            c.toBlob(function (b) {
                if (!b) return ok('null');
                win.createImageBitmap(b).then(function (bm) { ok([b.type, bm.width, px(bmpPixels(bm), 4, 4)]); }, function (e) { ok('!' + e.name); });
            }, 'image/webp', 1);
        });
    });
    arec('img.decode', function () { var im = new win.Image(); im.src = base + 'img/pattern.png'; return im.decode().then(function () { return [im.complete, im.naturalWidth]; }); });
    arec('img.decode.broken', function () { var im = new win.Image(); im.src = base + 'img/missing.png'; return im.decode().then(function () { return 'ok'; }); });
    arec('bitmap.blob', function () {
        return win.fetch(base + 'img/palette-trns.png').then(function (x) { return x.blob(); }).then(function (b) { return win.createImageBitmap(b); })
            .then(function (b) { return [b.width, px(bmpPixels(b), 14, 4)]; });
    });
    return Promise.all(jobs).then(function () { return r; });
}
