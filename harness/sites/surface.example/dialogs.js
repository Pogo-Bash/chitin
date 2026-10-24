(function () {
    'use strict';
    const n = new URLSearchParams(location.search).get('fn');
    const out = {};
    const t0 = performance.now();
    const rec = (k, f) => { try { const r = f(); out[k] = JSON.stringify(r === undefined ? 'undefined' : r); } catch (e) { out[k] = 'THROWS ' + e.name + ': ' + e.message; } };
    window.__dialogStarted = n;
    rec('dialog: ' + n + ' with this={}', () => globalThis[n].call({}));
    rec('dialog: ' + n + ' returns', () => (typeof globalThis[n] === 'function' ? [typeof globalThis[n]('x'), globalThis[n].name, performance.now() - t0 < 1000 ? 'fast' : 'slow'] : 'missing'));
    window.__surface = JSON.stringify({ probes: out });
    window.__surfaceDialog = 'done';
})();
