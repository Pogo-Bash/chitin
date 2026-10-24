// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// fetch (headers, redirects, CORS, abort, errors), streams (bodies, transforms, compression, tee), XHR event order,
// WebSocket and EventSource, against the workbench's own server on its three origins.
WB.section('net', async (t) => {
    const X = location.origin.replace('//wb.', '//wbx.'), SUB = location.origin.replace('//wb.', '//sub.wb.');
    await t.check('fetch.json', async () => { const r = await fetch('/api/json?q=1'); return [r.status, r.ok, r.statusText, r.type, r.redirected, r.headers.get('content-type'), r.headers.get('x-wb'), [...r.headers.keys()].filter((k) => k.startsWith('x-')), await r.json()]; });
    await t.check('fetch.redirect', async () => { const r = await fetch('/api/redirect'); const m = await fetch('/api/redirect', { redirect: 'manual' }); let err = null; try { await fetch('/api/redirect', { redirect: 'error' }); } catch (e) { err = e.name; } return [r.status, r.redirected, new URL(r.url).pathname + new URL(r.url).search, m.type, m.status, err]; });
    await t.check('fetch.status', async () => { const r = await fetch('/api/status?code=404'); const r2 = await fetch('/api/status?code=204'); return [r.status, r.ok, await r.text(), r2.status, await r2.text()]; });
    await t.check('fetch.post', async () => { const fd = new FormData(); fd.append('a', '1'); fd.append('f', new Blob(['xyz'], { type: 'text/plain' }), 'f.txt'); const a = await (await fetch('/api/echo', { method: 'POST', body: JSON.stringify({ k: 1 }), headers: { 'content-type': 'application/json', 'x-custom': 'v' } })).json(); const b = await (await fetch('/api/echo', { method: 'PUT', body: new URLSearchParams({ x: 'y z' }) })).json(); const c = await (await fetch('/api/echo', { method: 'POST', body: fd })).json(); return [a, b, [c.method, c.type.split(';')[0], /name="f"; filename="f.txt"/.test(c.body), c.body.includes('xyz')]]; });
    await t.check('fetch.cors', async () => {
        const ok = await fetch(X + '/api/cors'); const okBody = await ok.json();
        let blocked = null; try { await fetch(X + '/api/nocors'); blocked = 'allowed'; } catch (e) { blocked = e.name; }
        const opaque = await fetch(X + '/api/nocors', { mode: 'no-cors' });
        const pre = await fetch(X + '/api/cors', { method: 'PUT', headers: { 'x-pre': '1' } }).then((r) => r.status, (e) => e.name);
        const cred = await fetch(SUB + '/api/cors?cred=1', { credentials: 'include' }).then((r) => r.status, (e) => e.name);
        return [ok.type, okBody.origin === location.origin, blocked, opaque.type, opaque.status, pre, cred];
    });
    await t.check('fetch.abort', async () => { const c = new AbortController(); const p = fetch('/api/slow', { signal: c.signal }); setTimeout(() => c.abort(), 50); let r; try { await p; r = 'done'; } catch (e) { r = e.name; } let r2; try { await fetch('/api/slow', { signal: AbortSignal.timeout(50) }); } catch (e) { r2 = e.name; } return [r, r2, c.signal.reason && c.signal.reason.name]; });
    await t.check('fetch.networkError', async () => { try { await fetch('https://wb.localhost:1/'); return 'ok'; } catch (e) { return e.name; } });
    await t.check('fetch.dataBlob', async () => { const d = await (await fetch('data:text/plain;base64,aGk=')).text(); const u = URL.createObjectURL(new Blob(['blob!'], { type: 'x/y' })); const b = await fetch(u); return [d, await b.text(), b.headers.get('content-type'), b.headers.get('content-length')]; });
    await t.check('streams.body', async () => { const r = await fetch('/api/stream'); const rd = r.body.getReader(); let text = '', chunks = 0; for (;;) { const { done, value } = await rd.read(); if (done) break; chunks++; text += new TextDecoder().decode(value); } return [text, chunks >= 1, r.bodyUsed]; });
    await t.check('streams.pipe', async () => {
        const up = new TransformStream({ transform(c, ctl) { ctl.enqueue(c.toUpperCase()); } });
        const out = await new Response((await fetch('/api/stream')).body.pipeThrough(new TextDecoderStream()).pipeThrough(up).pipeThrough(new TextEncoderStream())).text();
        const gz = await new Response(new Blob(['a'.repeat(1000)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
        const back = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
        const [a, b] = new ReadableStream({ start(c) { c.enqueue(1); c.enqueue(2); c.close(); } }).tee();
        const ra = []; for await (const x of a) ra.push(x);
        const rb = await b.getReader().read();
        const Lq = []; const ws = new WritableStream({ write(c) { Lq.push('w' + c); }, close() { Lq.push('close'); } }, new CountQueuingStrategy({ highWaterMark: 2 }));
        const w = ws.getWriter(); Lq.push('desired' + w.desiredSize); w.write(1); w.write(2); Lq.push('desired' + w.desiredSize); await w.close();
        const byob = new ReadableStream({ type: 'bytes', pull(c) { const v = c.byobRequest.view; v[0] = 7; c.byobRequest.respond(1); c.close(); } });
        const br = byob.getReader({ mode: 'byob' }); const got = await br.read(new Uint8Array(4));
        return [out, back.length, gz.byteLength < 100, ra, rb.value, Lq, [...got.value]];
    });
    await t.check('streams.upload', async () => { const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('up')); c.close(); } }); try { const r = await fetch('/api/echo', { method: 'POST', body, duplex: 'half' }); return (await r.json()).body; } catch (e) { return { threw: e.name }; } });
    await t.check('xhr', async () => {
        const L = []; const x = new XMLHttpRequest();
        x.onreadystatechange = () => L.push('rs' + x.readyState);
        for (const ev of ['loadstart', 'progress', 'load', 'loadend', 'error', 'abort']) x.addEventListener(ev, () => { if (L[L.length - 1] !== ev) L.push(ev); });
        x.open('GET', '/api/json?xhr=1'); x.responseType = 'json';
        await new Promise((r) => { x.onloadend = r; x.send(); });
        return { order: L, status: x.status, resp: x.response, headers: x.getResponseHeader('x-wb'), url: new URL(x.responseURL).search };
    });
    await t.check('websocket', async () => {
        const L = [];
        const ws = new WebSocket(location.origin.replace('https', 'wss') + '/ws/echo', ['wbproto', 'other']);
        ws.binaryType = 'arraybuffer';
        L.push('state' + ws.readyState);
        await t.withTimeout(new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws error')); }), 8000, 'ws open');
        L.push('open:' + ws.protocol + ':' + ws.extensions.length);
        const msgs = [];
        const done = new Promise((r) => { ws.onmessage = (e) => { msgs.push(typeof e.data === 'string' ? e.data : 'bin' + e.data.byteLength); if (msgs.length === 3) r(); }; });
        ws.send('hello'); ws.send(new Uint8Array([1, 2, 3])); ws.send(new Blob(['abcd']));
        L.push('buffered>=0:' + (ws.bufferedAmount >= 0));
        await t.withTimeout(done, 8000, 'ws messages');
        const closed = new Promise((r) => (ws.onclose = (e) => r([e.code, e.reason, e.wasClean])));
        ws.close(4000, 'bye');
        L.push('closing' + ws.readyState);
        const c = await t.withTimeout(closed, 8000, 'ws close');
        const s2 = new WebSocket(location.origin.replace('https', 'wss') + '/ws/server-close');
        const c2 = await t.withTimeout(new Promise((r) => { s2.onopen = () => s2.send('x'); s2.onclose = (e) => r([e.code, e.reason, e.wasClean]); }), 8000, 'server close');
        let bad = null; try { new WebSocket('http://x'); } catch (e) { bad = e.name; }
        return { order: L, msgs, close: c, serverClose: c2, bad };
    });
    await t.check('eventsource', async () => {
        const L = [];
        const es = new EventSource('/sse');
        L.push('state' + es.readyState);
        await t.withTimeout(new Promise((resolve) => {
            es.onopen = () => L.push('open');
            es.onmessage = (e) => { L.push('message:' + e.data.replace(/\n/g, '|') + ':' + e.lastEventId); if (e.data === 'last') resolve(); };
            es.addEventListener('ping', (e) => L.push('ping:' + e.data + ':' + e.lastEventId));
        }), 8000, 'sse');
        es.close();
        L.push('closed' + es.readyState);
        return L;
    });
    await t.check('beacon', () => (navigator.sendBeacon ? navigator.sendBeacon('/api/echo', 'b') : 'none'));
    await t.check('url', () => { const u = new URL('../a/./b?x=1&x=2#h', 'https://u:p@ex.com:443/p/q/r'); const s = new URLSearchParams('a=1&b=%20&a=3'); s.sort(); return [u.href, u.port, u.username, u.searchParams.getAll('x'), s.toString(), URL.canParse ? URL.canParse('nope') : 'n/a', new URL('http://EXAMPLE.com/%7e').href, new URL('http://xn--nxasmq6b.com').hostname, new URL('http://über.de').hostname]; });
    // Last: a synchronous XHR that never answers would take the section's time from everything after it.
    await t.check('xhr.sync', () => { const s = new XMLHttpRequest(); s.open('GET', '/api/json?sync=1', false); s.send(); return [s.status, s.responseText.length > 0]; });
});
