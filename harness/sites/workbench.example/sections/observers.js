// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// IntersectionObserver (an element root, so the viewport does not enter), ResizeObserver, PerformanceObserver, ReportingObserver.
WB.section('observers', async (t) => {
    const r = t.root;
    await t.check('intersection', async () => {
        const sc = document.createElement('div'); sc.style.cssText = 'position:absolute;left:0;top:0;width:200px;height:100px;overflow:hidden';
        const inner = document.createElement('div'); inner.style.cssText = 'position:relative;height:600px';
        sc.append(inner); r.append(sc);
        const targets = [0, 80, 150, 300].map((top, i) => { const d = document.createElement('div'); d.id = 'io' + i; d.style.cssText = 'position:absolute;left:10px;width:50px;height:40px;top:' + top + 'px'; inner.append(d); return d; });
        const batches = [];
        const io = new IntersectionObserver((es) => batches.push(es.map((e) => [e.target.id, e.isIntersecting, t.round(e.intersectionRatio, 2), t.round(e.intersectionRect.height, 1), e.boundingClientRect.height]).sort()), { root: sc, threshold: [0, 0.5, 1], rootMargin: '0px 0px 10px 0px' });
        targets.forEach((x) => io.observe(x));
        await t.withTimeout((async () => { while (!batches.length) await t.sleep(10); })(), 3000, 'first batch');
        sc.scrollTop = 120;
        await t.withTimeout((async () => { while (batches.length < 2) await t.sleep(10); })(), 3000, 'after scroll');
        await t.sleep(50);
        io.disconnect();
        return batches;
    });
    await t.check('resize', async () => {
        const d = document.createElement('div'); d.style.cssText = 'width:100px;height:50px;padding:5px;border:2px solid;box-sizing:content-box';
        r.append(d);
        const batches = [];
        const ro = new ResizeObserver((es) => batches.push(es.map((e) => [t.round(e.contentRect.width), t.round(e.contentRect.height), e.contentRect.x, e.borderBoxSize && e.borderBoxSize[0] && [e.borderBoxSize[0].inlineSize, e.borderBoxSize[0].blockSize], e.contentBoxSize && e.contentBoxSize[0] && e.contentBoxSize[0].inlineSize])));
        ro.observe(d);
        await t.withTimeout((async () => { while (!batches.length) await t.sleep(10); })(), 3000, 'first');
        d.style.width = '130px';
        await t.withTimeout((async () => { while (batches.length < 2) await t.sleep(10); })(), 3000, 'second');
        d.style.padding = '9px';
        await t.sleep(100);
        ro.observe(d, { box: 'border-box' });
        d.style.display = 'none';
        await t.sleep(100);
        ro.disconnect();
        return batches;
    });
    await t.check('performance', async () => {
        const name = t.ns('mark');
        const seen = [];
        const po = new PerformanceObserver((list) => seen.push(...list.getEntries().filter((e) => e.name.startsWith(name)).map((e) => e.entryType + ':' + e.name.slice(name.length))));
        po.observe({ entryTypes: ['mark', 'measure'] });
        performance.mark(name + 'a', { detail: { x: 1 } });
        performance.mark(name + 'b');
        const m = performance.measure(name + 'ab', name + 'a', name + 'b');
        await t.sleep(50);
        po.disconnect();
        await fetch('/api/json?po=' + t.MODE);
        await t.sleep(50);
        const res = performance.getEntriesByType('resource').filter((e) => e.name.includes('po=' + t.MODE)).map((e) => [e.initiatorType, e.nextHopProtocol !== undefined, e.duration >= 0]);
        const nav = performance.getEntriesByType('navigation').map((e) => [e.type, e.entryType, e.name.replace(/^.*\//, '').split('?')[0]]);
        const supported = (PerformanceObserver.supportedEntryTypes || []).filter((x) => ['mark', 'measure', 'resource', 'navigation', 'paint', 'longtask', 'event', 'largest-contentful-paint', 'layout-shift'].includes(x));
        const marks = performance.getEntriesByName(name + 'a').map((e) => [e.detail && e.detail.x, e.startTime >= 0]);
        performance.clearMarks(name + 'a');
        return { seen, measure: [m && m.entryType, m && m.duration >= 0], res, nav, supported, marks, after: performance.getEntriesByName(name + 'a').length };
    });
    await t.check('reporting', () => (self.ReportingObserver ? typeof new ReportingObserver(() => {}).observe : 'none'));
    await t.check('visibility', () => [document.visibilityState, document.hidden, document.hasFocus === undefined ? 'n/a' : typeof document.hasFocus()]);
});
