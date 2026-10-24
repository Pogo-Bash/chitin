// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// A Worker that is quiet for a while, then posts once: what the page schedules from that message must run without
// anything else happening in the page.
let n = 0;
const next = () => setTimeout(() => { postMessage({ i: ++n }); if (n < 3) next(); }, 1500);
next();
// The same quiet spell, then a store and Atomics.notify on memory the page waits on with Atomics.waitAsync.
onmessage = (e) => {
    const i32 = new Int32Array(e.data);
    let k = 0;
    const poke = () => setTimeout(() => { Atomics.store(i32, 0, ++k); Atomics.notify(i32, 0); if (k < 3) poke(); }, 1500);
    poke();
};
