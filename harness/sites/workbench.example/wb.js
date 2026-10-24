// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// The workbench's page side (docs/workbench.md): sections register with WB.section(name, fn); the page runs them one after
// another (?mode=seq) or all at once (?mode=together) and posts each section's JSON to its server (/report). Values must be
// deterministic: seeded randomness (t.rng), rects relative to the section's own box, no clock readings in the values.
// A value {'~': v, tol} compares numbers (or arrays of numbers) within tol (tools/workbench/diff.mjs).
'use strict';
(() => {
    const params = new URLSearchParams(location.search);
    const RUN = params.get('run') || 'manual';
    const MODE = params.get('mode') || 'seq';
    const ONLY = params.get('only') ? params.get('only').split(',') : null;
    const SEED = Number(params.get('seed') || 20261022);
    const sections = [];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const strHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
    const round = (x, d = 2) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);
    const approx = (v, tol) => ({ '~': v, tol });
    const errName = (e) => (e && e.name) || typeof e;
    const post = (p, body) => fetch(p, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }).catch(() => {});
    const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout: ' + what), { name: 'WBTimeout' })), ms))]);

    // A 4x4 grid of mean RGBA over an ImageData, plus the count of pixels with any alpha: a tolerant pixel hash.
    function pixHash(img, tol = 6) {
        const { width: w, height: h, data } = img;
        const G = 4, sums = new Array(G * G * 4).fill(0), counts = new Array(G * G).fill(0);
        let ink = 0;
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4, c = Math.min(G - 1, Math.floor((y * G) / h)) * G + Math.min(G - 1, Math.floor((x * G) / w));
                for (let k = 0; k < 4; k++) sums[c * 4 + k] += data[i + k];
                counts[c]++;
                if (data[i + 3]) ink++;
            }
        return { size: [w, h], grid: approx(sums.map((s, i) => Math.round(s / Math.max(1, counts[i >> 2]))), tol), ink: approx(ink, Math.max(2, Math.round(w * h * 0.02))) };
    }
    const canvasHash = (canvas, tol) => pixHash(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height), tol);

    // Sections' boxes: fixed-size, absolutely placed, one per section, so geometry is the same in both modes.
    const stage = document.getElementById('stage');
    function box(name, i) {
        const d = document.createElement('div');
        d.className = 'wb-box';
        d.dataset.section = name;
        d.style.cssText = `position:absolute;left:${(i % 4) * 330}px;top:${Math.floor(i / 4) * 330}px;width:320px;height:320px;overflow:hidden;contain:layout`;
        const h = document.createElement('div');
        h.className = 'wb-label';
        h.textContent = name;
        d.append(h);
        const root = document.createElement('div');
        root.style.cssText = 'position:absolute;left:0;top:16px;width:320px;height:304px';
        d.append(root);
        stage.append(d);
        return root;
    }

    function context(name, root) {
        const values = {}, log = [], notes = [];
        const t = {
            name, root, MODE, RUN, sleep, round, approx, pixHash, canvasHash, errName, withTimeout,
            ns: (s) => `wb-${MODE}-${s}`,
            rng: mulberry32(SEED ^ strHash(name)),
            set(k, v) { values[k] = v === undefined ? 'undefined' : v; },
            log(s) { log.push(String(s)); },
            note(s) { notes.push(String(s)); },
            // One value from a step; an exception is recorded as its name (messages differ between engines and go to notes).
            async check(k, fn) {
                try { t.set(k, await fn()); } catch (e) { t.set(k, { threw: errName(e) }); notes.push(k + ': ' + (e && e.message)); }
            },
            rel(el) { const a = el.getBoundingClientRect(), b = root.getBoundingClientRect(); return [round(a.left - b.left), round(a.top - b.top), round(a.width), round(a.height)]; },
            // Real input from the runner: steps with viewport coordinates; resolves when the runner says it is done.
            async input(steps) {
                const id = name + '-' + MODE + '-' + Math.floor(t.rng() * 1e9);
                await post('/input?run=' + RUN, { id, steps });
                for (let i = 0; i < 300; i++) {
                    await sleep(100);
                    const r = await fetch('/input-status?run=' + RUN + '&id=' + id).then((x) => x.text()).catch(() => '');
                    if (r === 'done') return true;
                }
                return false;
            },
        };
        return { t, values, log, notes };
    }

    async function runSection(s, i) {
        const root = box(s.name, i);
        const { t, values, log, notes } = context(s.name, root);
        const t0 = performance.now();
        let error = null;
        try {
            await withTimeout(Promise.resolve().then(() => s.fn(t)), s.timeout || 25000, s.name);
        } catch (e) {
            error = errName(e);
            notes.push('section threw: ' + (e && e.message) + (e && e.stack ? ' @ ' + String(e.stack).split('\n').slice(0, 3).join(' | ') : ''));
        }
        const result = { section: s.name, mode: MODE, error, values, log, notes, ms: Math.round(performance.now() - t0) };
        await post(`/report?run=${RUN}&mode=${MODE}&section=${encodeURIComponent(s.name)}`, result);
        return result;
    }

    const WB = {
        section(name, fn, opts = {}) { sections.push({ name, fn, ...opts }); },
        async start() {
            const list = sections.filter((s) => !ONLY || ONLY.includes(s.name));
            await post(`/begin?run=${RUN}&mode=${MODE}`, { sections: list.map((s) => s.name), ua: navigator.userAgent, viewport: [innerWidth, innerHeight], dpr: devicePixelRatio });
            const order = sections.map((s) => s.name);
            if (MODE === 'together')
                await Promise.all(list.map((s) => runSection(s, order.indexOf(s.name))));
            else
                for (const s of list) await runSection(s, order.indexOf(s.name));
            document.title = 'workbench done';
            document.documentElement.dataset.wbDone = '1';
            await post(`/done?run=${RUN}&mode=${MODE}`, { viewport: [innerWidth, innerHeight] });
        },
    };
    window.WB = WB;
    window.addEventListener('error', (e) => String(e.message).includes('wb-') || post(`/error?run=${RUN}&mode=${MODE}`, { message: String(e.message), file: String(e.filename).replace(/^.*\//, ''), line: e.lineno }));
    window.addEventListener('unhandledrejection', (e) => String(e.reason && e.reason.message).includes('wb-') || post(`/error?run=${RUN}&mode=${MODE}`, { message: 'unhandledrejection: ' + String(e.reason && (e.reason.name + ': ' + e.reason.message)) }));
})();
