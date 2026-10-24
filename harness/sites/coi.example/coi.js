// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Cross-origin isolation probes (docs/user-tests/coi.md): the page's crossOriginIsolated and SharedArrayBuffer, a shared
// WebAssembly.Memory posted to the page's own Workers, Atomics.wait in a module Worker woken from the page, the timer
// resolution, COEP on cross-origin subresources and frames. Same file for every header variant (*.html, _headers.json).
(async () => {
    const XO = location.hostname.endsWith('.example') ? 'https://coi-xo.example' : `http://xo.localhost:${location.port}/coi-xo.example`;
    const r = {};
    const settle = (p, ms = 4000) => Promise.race([p, new Promise((res) => setTimeout(() => res('timeout'), ms))]);
    r.coi = self.crossOriginIsolated;
    r.sab = typeof SharedArrayBuffer;
    r.inGlobal = 'SharedArrayBuffer' in globalThis;
    let min = Infinity, last = performance.now();
    for (let i = 0; i < 200000 && min > 1e-3; i++) {
        const t = performance.now();
        if (t > last) { min = Math.min(min, t - last); last = t; }
    }
    r.resolution = min * 1000 <= 20 ? '5us' : min * 1000 <= 200 ? '100us' : 'coarser';
    const mem = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    r.memory = Object.prototype.toString.call(mem.buffer);
    try { structuredClone(mem.buffer); r.clone = 'ok'; } catch (e) { r.clone = e.name; }
    // The module Worker: its own probe, then a SharedArrayBuffer it waits on until the page wakes it.
    const w = new Worker('worker.mjs', { type: 'module' });
    const messages = [];
    let wake = null;
    const hello = new Promise((res) => {
        w.onmessage = (e) => {
            messages.push(e.data);
            if (e.data.hello) { r.big = typeof e.data.big + ' ' + String(e.data.big); delete e.data.big; res(e.data); }
            if (e.data.back) { r.backShared = Object.prototype.toString.call(e.data.back.buffer); Atomics.store(e.data.back, 0, 1); Atomics.notify(e.data.back, 0); }
            if ('waited' in e.data && wake) wake(e.data);
        };
        w.onerror = () => res('error');
    });
    r.worker = await settle(hello);
    try { w.postMessage({ sab: mem.buffer }); r.post = 'ok'; } catch (e) { r.post = e.name; }
    try { w.postMessage({ memory: mem }); r.postMemory = 'ok'; } catch (e) { r.postMemory = e.name; }
    if (r.post === 'ok') {
        const woke = new Promise((res) => { wake = res; });
        await new Promise((res) => setTimeout(res, 200));
        const i32 = new Int32Array(mem.buffer);
        Atomics.store(i32, 1, 42);
        Atomics.store(i32, 0, 1);
        r.notified = Atomics.notify(i32, 0);
        r.woke = await settle(woke);
    }
    w.terminate();
    // A blob: worker whose URL is revoked right after the constructor (it inherits the page's COEP).
    const blobURL = URL.createObjectURL(new Blob(["postMessage({ blob: self.crossOriginIsolated })"], { type: 'text/javascript' }));
    const bw = new Worker(blobURL);
    URL.revokeObjectURL(blobURL);
    r.blobRevoked = await settle(new Promise((res) => { bw.onmessage = (e) => res(e.data); bw.onerror = () => res('error'); }));
    bw.terminate();
    const cw = new Worker('worker-nocoep.js');
    r.classicNoCoep = await settle(new Promise((res) => { cw.onmessage = (e) => res(e.data); cw.onerror = () => res('error'); }));
    cw.terminate();
    // Cross-origin subresources (no-cors) with and without Cross-Origin-Resource-Policy.
    const img = (src) => settle(new Promise((res) => { const i = new Image(); i.onload = () => res('load'); i.onerror = () => res('error'); i.src = src; }));
    r.imgNoCorp = await img(XO + '/img-nocorp.png');
    r.imgCorp = await img(XO + '/img-corp.png');
    r.scriptNoCorp = await settle(new Promise((res) => { const s = document.createElement('script'); s.onload = () => res('load'); s.onerror = () => res('error'); s.src = XO + '/script-nocorp.js'; document.head.append(s); }));
    const f = (url, init) => settle(fetch(url, init).then((x) => x.type + ' ' + x.status, (e) => e.name));
    r.fetchNoCorsNoCorp = await f(XO + '/data-nocorp.txt', { mode: 'no-cors' });
    r.fetchCors = await f(XO + '/data-cors.txt');
    // Frames: same-origin with and without COEP; cross-origin with and without allow="cross-origin-isolated".
    const frame = (src, allow) => settle(new Promise((res) => {
        const i = document.createElement('iframe');
        const tag = src.split('?')[1];
        const on = (e) => { if (e.data && e.data.frame === tag) { removeEventListener('message', on); res(e.data); } };
        addEventListener('message', on);
        if (allow)
            i.allow = allow;
        i.src = src;
        document.body.append(i);
    }), 3000);
    r.frameSame = await frame('frame.html?same');
    r.frameSameNoCoep = await frame('frame-nocoep.html?samenocoep');
    r.frameXo = await frame(XO + '/frame-xo.html?xo');
    r.frameXoAllowed = await frame(XO + '/frame-xo.html?xoallowed', 'cross-origin-isolated');
    r.frameXoNoCoep = await frame(XO + '/frame-xo-nocoep.html?xonocoep');
    window.result = r;
    document.getElementById('s').textContent = 'done';
})();
