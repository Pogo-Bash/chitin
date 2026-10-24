// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Images: every format through <img>, decode(), createImageBitmap and a canvas; load/error event order; SVG as image and inline.
WB.section('images', async (t) => {
    const formats = ['png', 'jpg', 'gif', 'webp', 'avif', 'svg'];
    const L = [];
    const load = (src, label) => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => { L.push(label + ':load'); resolve(img); };
        img.onerror = () => { L.push(label + ':error'); resolve(img); };
        img.src = src;
        L.push(label + ':complete=' + img.complete);
    });
    for (const f of formats) {
        const img = await load('img/p.' + f + '?wb=' + t.MODE, f);
        await t.check('img.' + f, async () => {
            let decoded = 'n/a';
            try { await img.decode(); decoded = 'ok'; } catch (e) { decoded = e.name; }
            const c = document.createElement('canvas'); c.width = 32; c.height = 24;
            const x = c.getContext('2d'); x.drawImage(img, 0, 0, 32, 24);
            return { natural: [img.naturalWidth, img.naturalHeight], size: [img.width, img.height], complete: img.complete, decoded, pixels: t.pixHash(x.getImageData(0, 0, 32, 24), f === 'jpg' || f === 'avif' ? 12 : 4) };
        });
        await t.check('bitmap.' + f, async () => {
            const blob = await (await fetch('img/p.' + f)).blob();
            const b = await createImageBitmap(blob);
            const c = new OffscreenCanvas(b.width, b.height); c.getContext('2d').drawImage(b, 0, 0);
            return [blob.type, b.width, b.height, t.pixHash(c.getContext('2d').getImageData(0, 0, b.width, b.height), f === 'jpg' || f === 'avif' ? 12 : 4).grid];
        });
    }
    await load('img/missing.png', 'missing');
    await load('data:image/png;base64,AAAA', 'corrupt');
    await load('data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="5" height="7"/>'), 'datasvg');
    t.set('events', L);
    await t.check('img.attributes', async () => {
        const img = document.createElement('img');
        img.srcset = 'img/p.png 1x, img/p.gif 2x'; img.sizes = '10px'; img.alt = 'a'; img.loading = 'lazy'; img.decoding = 'async';
        t.root.append(img);
        await new Promise((r) => { img.onload = img.onerror = r; setTimeout(r, 3000); });
        return [img.currentSrc.replace(/^.*\//, ''), img.loading, img.decoding, img.naturalWidth];
    });
    await t.check('picture', async () => {
        t.root.insertAdjacentHTML('beforeend', '<picture><source srcset="img/p.avif" type="image/avif"><source srcset="img/p.webp" type="image/webp"><img src="img/p.png" width="16"></picture>');
        const img = t.root.querySelector('picture img');
        await new Promise((r) => { if (img.complete) r(); img.onload = img.onerror = r; setTimeout(r, 3000); });
        return [img.currentSrc.replace(/^.*\//, ''), t.rel(img).slice(2)];
    });
    await t.check('inlineSvg', () => {
        t.root.insertAdjacentHTML('beforeend', '<svg id="wbsvg" width="60" height="40" viewBox="0 0 30 20"><rect x="2" y="3" width="10" height="5" transform="rotate(10)"/><text x="1" y="18" font-size="6">t</text><circle cx="20" cy="10" r="4"/></svg>');
        const s = t.root.querySelector('#wbsvg');
        const rect = s.querySelector('rect');
        const bb = rect.getBBox();
        return [s.viewBox.baseVal.width, [bb.x, bb.y, bb.width, bb.height], s.querySelector('circle').r.baseVal.value, t.approx(t.rel(s.querySelector('circle')), 0.5), s.createSVGPoint ? 'pt' : 'nopt', rect.getCTM() ? t.round(rect.getCTM().b, 3) : null];
    });
});
