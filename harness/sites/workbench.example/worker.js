// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// The workers section's dedicated Worker.
let imported = null;
onmessage = (e) => {
    const m = e.data;
    if (m.op === 'hello') postMessage({ name: self.name, isWorker: typeof WorkerGlobalScope !== 'undefined', hasDocument: typeof document, origin: self.origin.replace(/:\d+$/, ''), loc: location.pathname + location.search, nav: typeof navigator.hardwareConcurrency });
    else if (m.op === 'transfer') { const u = new Uint8Array(m.buf); postMessage({ len: u.length, sum: u.reduce((a, b) => a + b, 0) }); }
    else if (m.op === 'import') { importScripts('lib.js'); imported = self.wbLib(3); postMessage(imported); }
    else if (m.op === 'throw') { throw new TypeError('wb thrown'); }
    else if (m.op === 'clone') { const v = m.v; postMessage([v.d.getTime(), v.r.source + '/' + v.r.flags, [...v.m.get(1).s], typeof v.big, v.big === 10n, [...v.ta].map((x) => Object.is(x, -0) ? '-0' : x), v.nested.arr.map(String), v.self === v, v.err.constructor.name, v.err.message]); }
    else if (m.op === 'nested') {
        if (typeof Worker === 'undefined') { postMessage('no nested Worker'); return; }
        const w = new Worker('lib-worker.js'); w.onmessage = (x) => { postMessage(x.data); w.terminate(); }; w.postMessage(5);
    }
};
