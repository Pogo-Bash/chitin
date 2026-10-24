// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
let st = null;
onmessage = (e) => {
    const d = e.data;
    if (!d.go) {
        st = { i32: new Int32Array(d.sab), idx: d.idx, n: d.n };
        const v = new WebAssembly.Instance(d.mods.get('seven')).exports.f();
        const own = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
        postMessage({ ready: true, v, module: own, modules: new Map([['k', own]]) });
        return;
    }
    // The ring: worker i waits for slot i, then wakes worker i + 1; the last one tells the page.
    const { i32, idx, n } = st;
    if (idx > 0)
        while (Atomics.load(i32, idx) === 0)
            Atomics.wait(i32, idx, 0, 10000);
    Atomics.store(i32, idx + 1, idx + 1);
    Atomics.notify(i32, idx + 1);
    if (idx === n - 1)
        postMessage({ ring: Atomics.load(i32, n) });
};
