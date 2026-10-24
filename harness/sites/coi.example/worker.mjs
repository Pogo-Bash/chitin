// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// A module Worker with a nested import: its own isolation, SharedArrayBuffer, Atomics.wait woken by the page.
import { dep } from './dep.mjs';
import { probe } from './probe.mjs';
self.onmessage = (e) => {
    if (e.data && e.data.sab) {
        const i32 = new Int32Array(e.data.sab);
        const r = Atomics.wait(i32, 0, 0, 5000);
        // The page wakes this worker through a view it got back from this worker (shared memory from a worker to the page).
        self.postMessage({ back: new Int32Array(e.data.sab, 8, 1) });
        const back = Atomics.wait(i32, 2, 0, 5000);
        self.postMessage({ waited: r, value: Atomics.load(i32, 1), wokenBack: back });
    }
};
self.postMessage({ hello: dep, big: 2n ** 40n + 3n, ...probe() });
