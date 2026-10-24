// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Dedicated (classic and module), shared and service workers: messages, transfers, errors, importScripts, interception.
WB.section('workers', async (t) => {
    const ask = (w, msg, transfer) => new Promise((resolve) => { w.onmessage = (e) => resolve(e.data); w.postMessage(msg, transfer || []); });
    await t.check('dedicated', async () => {
        const w = new Worker('worker.js?x=1', { name: 'wbw' });
        const hello = await ask(w, { op: 'hello' });
        const buf = new Uint8Array([1, 2, 3, 4]).buffer;
        const echo = await ask(w, { op: 'transfer', buf }, [buf]);
        const detached = buf.byteLength;
        const imp = await ask(w, { op: 'import' });
        const err = await new Promise((resolve) => { w.onerror = (e) => { e.preventDefault(); resolve(['error', typeof e.message, e.lineno > 0, String(e.filename).replace(/^.*\//, '')]); }; w.postMessage({ op: 'throw' }); });
        const after = await ask(w, { op: 'hello' });
        const nested = await ask(w, { op: 'nested' });
        w.terminate();
        return { hello, echo, detached, imp, err, alive: after.name, nested };
    });
    await t.check('module', async () => {
        const w = new Worker('mworker.js', { type: 'module' });
        const r = await t.withTimeout(ask(w, { op: 'hello' }), 8000, 'module worker');
        w.terminate();
        return r;
    });
    await t.check('blobWorker', async () => {
        const u = URL.createObjectURL(new Blob(['onmessage = (e) => postMessage([e.data * 2, self.location.protocol, typeof importScripts])'], { type: 'text/javascript' }));
        const w = new Worker(u); const r = await ask(w, 21); w.terminate(); return r;
    });
    await t.check('workerLoadError', () => new Promise((resolve) => { const w = new Worker('nonexistent-worker.js'); w.onerror = (e) => { e.preventDefault(); resolve(['error', e.constructor.name]); }; setTimeout(() => resolve('no error event'), 5000); }));
    await t.check('structuredClone', async () => {
        const w = new Worker('worker.js');
        const v = { d: new Date(0), r: /a+/gi, m: new Map([[1, { s: new Set([2]) }]]), big: 10n, ta: new Float64Array([1.5, -0]), nested: { arr: [undefined, null, NaN] }, err: new RangeError('x') };
        v.self = v;
        const back = await ask(w, { op: 'clone', v });
        w.terminate();
        let fnErr = null; try { structuredClone(() => 1); } catch (e) { fnErr = e.name; }
        return { back, fnErr };
    });
    await t.check('shared', async () => {
        if (typeof SharedWorker === 'undefined') return 'no SharedWorker';
        const a = new SharedWorker('shared.js', 'wb-' + t.MODE), b = new SharedWorker('shared.js', 'wb-' + t.MODE);
        const talk = (sw, m) => new Promise((resolve) => { sw.port.onmessage = (e) => resolve(e.data); sw.port.postMessage(m); });
        const r1 = await talk(a, 'count'), r2 = await talk(b, 'count');
        const errs = [];
        a.onerror = () => errs.push('error');
        a.port.close(); b.port.close();
        return [r1, r2, errs];
    });
    await t.check('service', async () => {
        if (!navigator.serviceWorker) return 'no serviceWorker';
        const scope = '/wb-sw/' + t.MODE + '/';
        const reg = await navigator.serviceWorker.register('/wb-sw/sw.js', { scope });
        const L = [];
        const sw = reg.installing || reg.waiting || reg.active;
        L.push('initial:' + sw.state);
        if (sw.state !== 'activated') await t.withTimeout(new Promise((r) => sw.addEventListener('statechange', () => { L.push(sw.state); if (sw.state === 'activated') r(); })), 10000, 'activate');
        const f = document.createElement('iframe');
        f.src = scope + 'page.html';
        t.root.append(f);
        const fromFrame = await t.withTimeout(new Promise((r) => addEventListener('message', function h(e) { if (e.data && e.data.wbsw) { removeEventListener('message', h); r(e.data); } })), 10000, 'controlled frame');
        const regs = (await navigator.serviceWorker.getRegistrations()).filter((x) => x.scope.endsWith(scope)).length;
        const unreg = await reg.unregister();
        f.remove();
        return { order: L, scope: new URL(reg.scope).pathname, fromFrame, regs, unreg, controllerHere: !!navigator.serviceWorker.controller };
    });
});
