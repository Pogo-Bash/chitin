// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
onmessage = (e) => {
    const i32 = new Int32Array(e.data);
    const rounds = 300;
    const t0 = performance.now();
    for (let i = 1; i <= rounds; i++) {
        postMessage({ i });
        Atomics.wait(i32, 0, i - 1, 10000);
    }
    postMessage({ done: true, rounds, ms: performance.now() - t0 });
};
