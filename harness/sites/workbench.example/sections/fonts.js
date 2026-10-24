// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Fonts and text metrics: a web font (WBAscii, a woff2 of the site) and the generic families. System families differ between
// machines; the web font's numbers are the ones that should match exactly.
WB.section('fonts', async (t) => {
    const r = t.root;
    const strings = ['Hamburgefonstiv', 'The quick brown fox 0123456789', 'WAVE fi ffl', 'iiiiii MMMMMM'];
    await t.check('fontFace.load', async () => {
        const f = new FontFace('WBAscii2', 'url(ascii-only.woff2)', { weight: '400' });
        const states = [f.status];
        const p = f.load();
        states.push(f.status);
        await p;
        states.push(f.status);
        document.fonts.add(f);
        return [states, f.family, document.fonts.check('16px WBAscii2'), document.fonts.has(f)];
    });
    await t.check('fonts.ready', async () => { await document.fonts.load('16px WBAscii'); await document.fonts.ready; return [document.fonts.status, document.fonts.check('16px WBAscii')]; });
    await t.check('fontFace.bad', async () => { const f = new FontFace('WBBad', 'url(nonexistent.woff2)'); try { await f.load(); return 'loaded'; } catch (e) { return [e.name, f.status]; } });
    const c = document.createElement('canvas').getContext('2d');
    const measure = (font) => strings.map((s) => { c.font = font; const m = c.measureText(s); return [t.round(m.width, 1), t.round(m.actualBoundingBoxAscent, 1), t.round(m.actualBoundingBoxDescent, 1), t.round(m.fontBoundingBoxAscent, 1), t.round(m.fontBoundingBoxDescent, 1)]; });
    await t.check('measureText.webfont', () => t.approx(measure('16px WBAscii').flat(), 0.6));
    await t.check('measureText.sans', () => t.approx(measure('16px sans-serif').flat(), 1));
    await t.check('measureText.mono', () => t.approx(measure('13px monospace').flat(), 1));
    await t.check('canvas.font', () => { c.font = 'italic bold 12px/2 WBAscii, serif'; return c.font; });
    const spans = (font) => strings.map((s) => { const e = document.createElement('span'); e.style.font = font; e.style.whiteSpace = 'pre'; e.textContent = s; r.append(e); const b = e.getBoundingClientRect(); e.remove(); return [t.round(b.width, 1), t.round(b.height, 1)]; });
    await t.check('spans.webfont', () => t.approx(spans('16px/20px WBAscii').flat(), 0.6));
    await t.check('spans.sans', () => t.approx(spans('16px/20px sans-serif').flat(), 1));
    await t.check('wrap', () => {
        const p = document.createElement('p');
        p.style.cssText = 'width:150px;font:14px/18px WBAscii;margin:0;hyphens:none';
        p.textContent = 'The quick brown fox jumps over the lazy dog and keeps running far away';
        r.append(p);
        const lines = Math.round(p.getBoundingClientRect().height / 18);
        const rg = document.createRange(); rg.selectNodeContents(p);
        const out = [lines, rg.getClientRects().length, t.rel(p)];
        p.remove();
        return out;
    });
    await t.check('caretPosition', () => {
        const p = document.createElement('p');
        p.style.cssText = 'position:absolute;left:0;top:0;font:16px/20px WBAscii;margin:0;white-space:pre';
        p.textContent = 'abcdefghij';
        r.append(p);
        const b = p.getBoundingClientRect();
        const pos = document.caretPositionFromPoint ? document.caretPositionFromPoint(b.left + b.width * 0.55, b.top + 10) : null;
        const rng = document.caretRangeFromPoint ? document.caretRangeFromPoint(b.left + b.width * 0.55, b.top + 10) : null;
        p.remove();
        return [pos && pos.offset, rng && rng.startOffset];
    });
    await t.check('textAlignVerticalAlign', () => {
        const d = document.createElement('div');
        d.style.cssText = 'width:200px;font:16px/24px WBAscii;text-align:center';
        d.innerHTML = '<span>ab</span><span style="vertical-align:super;font-size:10px">c</span><span style="vertical-align:-4px">d</span>';
        r.append(d);
        const out = [...d.children].map((e) => t.rel(e));
        d.remove();
        return t.approx(out.flat(), 0.6);
    });
});
