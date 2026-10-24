// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// SharedArrayBuffer + Atomics round trip between two Workers (Atomics.wait is not allowed on a
// page's main thread, so the "page JS" side is a Worker too).
self.onmessage = (e) => {
    const { role, buffer, spin } = e.data;
    const flag = new Int32Array(buffer, 0, 4);
    if (role === 'callee') {
        for (;;) {
            if (spin) {
                while (Atomics.load(flag, 0) !== 1) { /* spin */ }
            } else {
                Atomics.wait(flag, 0, 0);
                if (Atomics.load(flag, 0) !== 1)
                    continue;
            }
            Atomics.store(flag, 2, Atomics.load(flag, 1) + 1);
            Atomics.store(flag, 0, 2);
            Atomics.notify(flag, 0);
        }
    }
    const call = (v) => {
        Atomics.store(flag, 1, v);
        Atomics.store(flag, 0, 1);
        Atomics.notify(flag, 0);
        if (spin) {
            while (Atomics.load(flag, 0) !== 2) { /* spin */ }
        } else {
            while (Atomics.load(flag, 0) !== 2)
                Atomics.wait(flag, 0, 1);
        }
        Atomics.store(flag, 0, 0);
        return Atomics.load(flag, 2);
    };
    for (let i = 0; i < 2000; i++)
        call(i);
    const samples = [];
    for (let r = 0; r < 5; r++) {
        const t0 = performance.now();
        for (let i = 0; i < 20000; i++)
            call(i);
        samples.push(((performance.now() - t0) * 1e6) / 20000);
    }
    samples.sort((a, b) => a - b);
    self.postMessage({ name: `SAB + Atomics round trip, two Workers (${spin ? 'spin-wait' : 'Atomics.wait'})`, ns: samples[2] });
};
