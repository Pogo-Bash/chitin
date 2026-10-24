// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Iframes on three origins (same origin, same site sub.wb.localhost, cross site wbx.localhost): load order, what each may
// reach of its parent, postMessage with transfers, MessageChannel ports, BroadcastChannel, srcdoc and about:blank.
WB.section('frames', async (t) => {
    const here = location.origin, port = location.port;
    const origins = { same: here, sameSite: here.replace('//wb.', '//sub.wb.'), crossSite: here.replace('//wb.', '//wbx.') };
    const L = [];
    const frames = {};
    const ready = {};
    const onMsg = (e) => { if (e.data && e.data.wbframe && !e.data.transferBack) { ready[e.data.wbframe] = e.data; L.push('ready:' + e.data.wbframe); } };
    addEventListener('message', onMsg);
    for (const [role, origin] of Object.entries(origins)) {
        const f = document.createElement('iframe');
        f.name = 'wbf-' + role; f.width = 90; f.height = 40;
        f.addEventListener('load', () => L.push('load:' + role));
        f.src = origin + '/frame.html?role=' + role + '&mode=' + t.MODE;
        t.root.append(f);
        frames[role] = f;
    }
    await t.withTimeout((async () => { while (Object.keys(ready).length < 3) await t.sleep(20); })(), 15000, 'three frames');
    await t.sleep(50);
    t.set('loadOrder.perFrame', Object.keys(origins).map((r) => L.filter((x) => x.endsWith(':' + r)).join(',')));
    for (const role of Object.keys(origins)) {
        const { wbframe, ...info } = ready[role]; void wbframe;
        t.set('frame.' + role, { ...info, origin: info.origin.replace(port, '') });
    }
    await t.check('parentAccess', () => Object.entries(frames).map(([r, f]) => { try { return r + ':' + typeof f.contentWindow.document.title; } catch (e) { return r + ':' + e.name; } }));
    await t.check('windowProxy', () => [window.frames.length >= 3, frames.crossSite.contentWindow === window.frames['wbf-crossSite'], typeof frames.crossSite.contentWindow.postMessage, (() => { try { return frames.crossSite.contentWindow.location.href; } catch (e) { return e.name; } })(), frames.same.contentDocument !== null, frames.crossSite.contentDocument]);
    for (const role of Object.keys(origins)) {
        await t.check('channel.' + role, async () => {
            const mc = new MessageChannel();
            const got = [];
            const done = new Promise((r) => { mc.port1.onmessage = (e) => { got.push(e.data); if (got.length === 3) r(); }; });
            frames[role].contentWindow.postMessage({ op: 'port' }, origins[role], [mc.port2]);
            const buf = new Uint8Array([9, 8, 7]).buffer;
            mc.port1.postMessage({ buf }, [buf]);
            mc.port1.postMessage({ x: [1, { y: 2 }] });
            await t.withTimeout(done, 8000, 'port replies');
            mc.port1.close();
            return [got, buf.byteLength];
        });
        await t.check('transfer.' + role, async () => {
            const buf = new ArrayBuffer(16);
            const back = new Promise((r) => addEventListener('message', function h(e) { if (e.data && e.data.transferBack && e.data.wbframe === role) { removeEventListener('message', h); r([e.data.gotLen, e.data.buf.byteLength, e.origin === origins[role], e.source === frames[role].contentWindow]); } }));
            frames[role].contentWindow.postMessage({ op: 'buf', buf }, '*', [buf]);
            return [buf.byteLength, await t.withTimeout(back, 8000, 'transfer back')];
        });
    }
    await t.check('targetOriginMismatch', async () => { frames.crossSite.contentWindow.postMessage({ op: 'buf', buf: new ArrayBuffer(1) }, 'https://elsewhere.example'); await t.sleep(200); return 'no throw'; });
    await t.check('broadcastChannel', async () => {
        const bc = new BroadcastChannel('wb-bc-' + t.MODE);
        const got = [];
        bc.onmessage = (e) => got.push(e.data);
        for (const role of Object.keys(origins)) frames[role].contentWindow.postMessage({ op: 'bc', mode: t.MODE }, '*');
        await t.sleep(400);
        bc.close();
        return got.sort();
    });
    await t.check('srcdocBlank', async () => {
        const s = document.createElement('iframe'); s.srcdoc = '<p id=p>srcdoc</p><script>parent.postMessage({wbsrcdoc: location.href, o: origin}, "*")<\/script>';
        const got = new Promise((r) => addEventListener('message', function h(e) { if (e.data && e.data.wbsrcdoc) { removeEventListener('message', h); r(e.data); } }));
        t.root.append(s);
        const d = await t.withTimeout(got, 5000, 'srcdoc');
        const b = document.createElement('iframe'); t.root.append(b);
        const blank = [b.contentWindow.location.href, b.contentDocument.readyState, b.contentDocument.body && b.contentDocument.body.childNodes.length];
        b.contentDocument.body.innerHTML = '<i>w</i>';
        return [d.wbsrcdoc, d.o === location.origin, blank, b.contentDocument.body.innerHTML, s.contentDocument.getElementById('p').textContent];
    });
    await t.check('sandbox', async () => {
        const s = document.createElement('iframe'); s.sandbox = 'allow-scripts'; s.src = 'frame.html?role=sandboxed';
        const got = new Promise((r) => addEventListener('message', function h(e) { if (e.data && e.data.wbframe === 'sandboxed') { removeEventListener('message', h); r([e.data.origin, e.origin, e.data.parentDoc]); } }));
        t.root.append(s);
        return t.withTimeout(got, 8000, 'sandboxed frame');
    });
    await t.check('removeDuringLoad', async () => { const f = document.createElement('iframe'); let loads = 0; f.onload = () => loads++; f.src = 'frame.html?role=removed'; t.root.append(f); f.remove(); await t.sleep(300); return [loads, f.contentWindow]; });
    removeEventListener('message', onMsg);
    for (const f of Object.values(frames)) f.remove();
});
