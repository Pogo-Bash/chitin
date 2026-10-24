// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
import { domCases, vdomCases } from '/bench-src/cases.js';

const log = (s) => (document.getElementById('log').textContent += s + '\n');
const fmt = (ns) => (ns === undefined ? '' : ns >= 1e6 ? `${(ns / 1e6).toFixed(2)} ms` : ns >= 1000 ? `${(ns / 1000).toFixed(2)} µs` : `${ns.toFixed(1)} ns`);
const channel = new MessageChannel();
const yieldTask = () => new Promise((resolve) => {
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(0);
});

function inWorker(url, message) {
    return new Promise((resolve, reject) => {
        const w = new Worker(url);
        w.onmessage = (e) => {
            if (e.data && e.data.log) {
                log(e.data.log);
                return;
            }
            w.terminate();
            resolve(e.data);
        };
        w.onerror = (e) => reject(new Error(e.message));
        w.postMessage(message);
    });
}

async function sab(spin) {
    const buffer = new SharedArrayBuffer(16);
    const callee = new Worker('/bench/sab-worker.js');
    callee.postMessage({ role: 'callee', buffer, spin });
    const result = await inWorker('/bench/sab-worker.js', { role: 'caller', buffer, spin });
    callee.terminate();
    return result;
}

function table(results) {
    const t = document.getElementById('out');
    t.innerHTML = '<tr><th>operation</th><th>native DOM (main thread)</th><th>toy via bindings (Worker)</th><th>toy ÷ native</th></tr>';
    const row = (cells, cls) => {
        const tr = t.insertRow();
        if (cls)
            tr.className = cls;
        for (const c of cells)
            tr.insertCell().textContent = c;
    };
    row(['Boundary (toy only)'], 'section');
    for (const r of results.toy.raw)
        row([r.name, '', fmt(r.ns), '']);
    row(['DOM operations'], 'section');
    results.native.dom.forEach((n, i) => {
        const toy = results.toy.dom[i];
        row([n.name, fmt(n.ns), fmt(toy.ns), (toy.ns / n.ns).toFixed(1) + '×']);
    });
    row(['Cross-thread alternative'], 'section');
    for (const r of results.sab)
        row([r.name, '', fmt(r.ns), '']);
    row(['Preact-style VDOM, 1000 rows'], 'section');
    results.native.vdom.forEach((n, i) => {
        const toy = results.toy.vdom[i];
        row([n.name, n.ms.toFixed(2) + ' ms', toy.ms.toFixed(2) + ' ms', (toy.ms / Math.max(n.ms, 0.01)).toFixed(1) + '×']);
    });
}

document.getElementById('run').addEventListener('click', async () => {
    document.getElementById('run').disabled = true;
    const results = { userAgent: navigator.userAgent, crossOriginIsolated: self.crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency, date: new Date().toISOString() };
    if (!self.crossOriginIsolated)
        log('WARNING: not cross-origin isolated; SharedArrayBuffer is unavailable and timers are coarse.');
    log('native DOM, main thread …');
    results.native = { dom: await domCases({ document, Event }, { taskBoundary: yieldTask }) };
    results.native.vdom = await vdomCases({ document, Event }, { taskBoundary: yieldTask });
    log('toy engine in a Worker …');
    results.toy = await inWorker('/bench/toy-worker.js', {});
    log('SharedArrayBuffer round trips …');
    results.sab = [await sab(false), await sab(true)];
    table(results);
    log('done.');
    const copy = document.getElementById('copy');
    copy.disabled = false;
    copy.onclick = async () => {
        const text = JSON.stringify(results);
        try {
            await navigator.clipboard.writeText(text);
            log('copied to the clipboard.');
        } catch {
            prompt('copy these results', text);
        }
    };
});
