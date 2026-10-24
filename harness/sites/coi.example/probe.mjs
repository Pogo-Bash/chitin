// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
export function resolution() {
    let min = Infinity, last = performance.now();
    for (let i = 0; i < 200000 && min > 1e-3; i++) {
        const t = performance.now();
        if (t > last) { min = Math.min(min, t - last); last = t; }
    }
    return min * 1000 <= 20 ? '5us' : min * 1000 <= 200 ? '100us' : 'coarser: ' + min;
}
export function probe() {
    let clone;
    try { const m = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }); structuredClone(m.buffer); clone = 'ok'; } catch (e) { clone = e.name; }
    return { coi: self.crossOriginIsolated, sab: typeof SharedArrayBuffer, inGlobal: 'SharedArrayBuffer' in globalThis, clone, resolution: resolution() };
}
