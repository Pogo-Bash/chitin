// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
const out = { has: typeof XMLHttpRequest, states: [XMLHttpRequest.UNSENT, XMLHttpRequest.DONE], tag: Object.prototype.toString.call(new XMLHttpRequest()) };
const sum = (u8) => { let h = 0; for (let i = 0; i < u8.length; i++) h = (h * 31 + u8[i]) | 0; return h; };
try {
    const r = new XMLHttpRequest();
    r.open('GET', 'piece.bin', false);
    r.responseType = 'arraybuffer';
    r.send();
    out.sync = { status: r.status, ready: r.readyState, length: r.response.byteLength, sum: sum(new Uint8Array(r.response)), type: r.getResponseHeader('Content-Type'), url: r.responseURL.replace(/^.*\//, '') };
} catch (e) { out.sync = e.name + ': ' + e.message; }
try {
    const r = new XMLHttpRequest();
    r.open('GET', 'missing.bin', false);
    r.send();
    out.sync404 = r.status;
} catch (e) { out.sync404 = e.name; }
try {
    const r = new XMLHttpRequest();
    r.open('GET', (location.hostname.endsWith('.example') ? 'https://coi-xo.example' : `http://xo.localhost:${location.port}/coi-xo.example`) + '/data-nocorp.txt', false);
    r.send();
    out.syncCrossOrigin = r.status;
} catch (e) { out.syncCrossOrigin = e.name; }
{
    const r = new XMLHttpRequest();
    const seen = [];
    r.onreadystatechange = () => seen.push('rs' + r.readyState);
    for (const t of ['loadstart', 'progress', 'load', 'loadend', 'error'])
        r.addEventListener(t, (e) => seen.push(t + (t === 'load' ? ':' + e.loaded : '')));
    r.open('GET', 'dep.mjs');
    r.onload = () => {
        out.async = { seen, status: r.status, text: r.responseText.length > 0, json: null };
        const j = new XMLHttpRequest();
        j.open('GET', 'piece.bin');
        j.responseType = 'blob';
        j.onload = () => {
            out.blob = [Object.prototype.toString.call(j.response), j.response.size];
            postMessage(out);
        };
        j.send();
    };
    r.send();
}
