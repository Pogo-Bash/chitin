// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Timers, microtasks, rAF, idle callbacks, message tasks and their order. Each experiment is its own log, so one that is
// implementation-defined (a timeout against a message task) does not hide the ones the spec fixes.
WB.section('timing', async (t) => {
    const until = (L, n, ms = 3000) => t.withTimeout((async () => { while (L.length < n) await t.sleep(5); })(), ms, 'order log');
    await t.check('microtasks', async () => {
        const L = [];
        (async () => { L.push('async-start'); await null; L.push('after-await-1'); await new Promise((r) => r()); L.push('after-await-2'); })();
        Promise.resolve().then(() => L.push('then-1')).then(() => L.push('then-2')).then(() => L.push('then-3'));
        queueMicrotask(() => { L.push('qm'); queueMicrotask(() => L.push('qm-nested')); });
        const thenable = { then(r) { L.push('thenable.then'); r('t'); } };
        Promise.resolve(thenable).then(() => L.push('thenable-resolved'));
        const el = document.createElement('div');
        new MutationObserver(() => L.push('mutation')).observe(el, { attributes: true });
        el.setAttribute('a', '1');
        Promise.reject(new Error('x')).catch(() => L.push('catch'));
        Promise.all([1, Promise.resolve(2)]).then(() => L.push('all'));
        Promise.race([new Promise(() => {}), Promise.resolve(1)]).then(() => L.push('race'));
        L.push('sync-end');
        await t.sleep(20);
        return L;
    });
    await t.check('timeouts', async () => {
        const L = [];
        setTimeout(() => L.push('t10'), 10);
        setTimeout(() => L.push('t0-a'), 0);
        setTimeout(() => L.push('t0-b'));
        setTimeout(() => L.push('t5'), 5);
        setTimeout((a, b) => L.push('args:' + a + b), 1, 'x', 'y');
        const c = setTimeout(() => L.push('cleared'), 0); clearTimeout(c);
        let n = 0; const iv = setInterval(() => { L.push('iv' + ++n); if (n === 3) clearInterval(iv); }, 1);
        await until(L, 8);
        await t.sleep(30);
        return L.filter((x) => !x.startsWith('iv')).concat(['intervals:' + L.filter((x) => x.startsWith('iv')).length]);
    });
    await t.check('nestingClamp', async () => {
        const gaps = []; let last = performance.now(), depth = 0;
        await new Promise((r) => { const f = () => { const now = performance.now(); gaps.push(now - last); last = now; if (++depth < 8) setTimeout(f, 0); else r(); }; setTimeout(f, 0); });
        return [gaps.slice(6).every((g) => g >= 3.5), gaps.length];
    });
    await t.check('microtasksBetweenTasks', async () => {
        const L = [];
        setTimeout(() => { L.push('task1'); Promise.resolve().then(() => L.push('task1-micro')); }, 0);
        setTimeout(() => { L.push('task2'); }, 0);
        await until(L, 3);
        return L;
    });
    await t.check('syntheticDispatchMicrotasks', () => {
        const L = []; const b = document.createElement('button');
        b.addEventListener('click', () => { L.push('l1'); Promise.resolve().then(() => L.push('m1')); });
        b.addEventListener('click', () => { L.push('l2'); Promise.resolve().then(() => L.push('m2')); });
        b.click(); L.push('after-click');
        return new Promise((r) => setTimeout(() => r(L), 0));
    });
    await t.check('raf', async () => {
        const L = []; let ts1, ts2, ts3;
        requestAnimationFrame((a) => { ts1 = a; L.push('raf1'); requestAnimationFrame((c) => { ts3 = c; L.push('raf-nested'); }); Promise.resolve().then(() => L.push('raf1-micro')); });
        requestAnimationFrame((b) => { ts2 = b; L.push('raf2'); });
        const id = requestAnimationFrame(() => L.push('cancelled')); cancelAnimationFrame(id);
        await until(L, 4, 5000);
        return [L, ts1 === ts2, ts3 > ts1, typeof ts1];
    });
    await t.check('idle', async () => {
        if (!self.requestIdleCallback) return 'none';
        const d = await new Promise((r) => requestIdleCallback((dl) => r([typeof dl.didTimeout, dl.timeRemaining() <= 50]), { timeout: 2000 }));
        return d;
    });
    await t.check('messageVsTimeout', async () => {
        const L = []; const mc = new MessageChannel();
        mc.port1.onmessage = () => L.push('message');
        setTimeout(() => L.push('timeout'), 0);
        mc.port2.postMessage(0);
        await until(L, 2);
        mc.port1.close();
        return L;
    });
    await t.check('postMessageSelf', async () => {
        const L = []; const tag = 'wbpm-' + Math.floor(t.rng() * 1e6);
        const h = (e) => { if (e.data === tag) L.push('pm:' + (e.source === window) + ':' + (e.origin === location.origin)); };
        addEventListener('message', h);
        postMessage(tag, '*'); L.push('sync');
        await until(L, 2);
        removeEventListener('message', h);
        return L;
    });
    await t.check('scheduler', async () => {
        if (!self.scheduler || !scheduler.postTask) return 'none';
        const L = [];
        await Promise.all([scheduler.postTask(() => L.push('background'), { priority: 'background' }), scheduler.postTask(() => L.push('user-visible')), scheduler.postTask(() => L.push('user-blocking'), { priority: 'user-blocking' })]);
        const y = typeof scheduler.yield;
        return [L, y];
    });
    await t.check('performanceNow', () => { const a = performance.now(), b = performance.now(); return [b >= a, typeof performance.timeOrigin, performance.timeOrigin > 1.6e12, Number.isInteger(Date.now())]; });
    await t.check('errorInTimer', async () => {
        const L = []; const h = (e) => { if (String(e.message).includes('wb-timer-error')) { L.push('window.onerror:' + e.error.name); e.preventDefault(); } };
        addEventListener('error', h);
        setTimeout(() => { throw new SyntaxError('wb-timer-error'); }, 0);
        setTimeout(() => L.push('next-timer-ran'), 1);
        await until(L, 2);
        removeEventListener('error', h);
        return L;
    });
    await t.check('unhandledRejection', async () => {
        const L = []; const h = (e) => { if (e.reason && e.reason.message === 'wb-unhandled') { L.push('unhandledrejection'); e.preventDefault(); } }; const h2 = (e) => { if (e.reason && e.reason.message === 'wb-unhandled') L.push('rejectionhandled'); };
        addEventListener('unhandledrejection', h); addEventListener('rejectionhandled', h2);
        const p = Promise.reject(new Error('wb-unhandled'));
        await t.sleep(50);
        p.catch(() => {});
        await t.sleep(50);
        removeEventListener('unhandledrejection', h); removeEventListener('rejectionhandled', h2);
        return L;
    });
});
