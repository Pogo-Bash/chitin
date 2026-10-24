// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// A spare runner as plasmaontheweb.com's: set up on 'init', given its task later in 'assign' (a Map of compiled modules,
// shared memory), then it runs, says so, and blocks in Atomics.wait for good until the page ends it.
let mem = null;
onmessage = (e) => {
    const m = e.data;
    if (m.method === 'init') {
        mem = new Int32Array(m.memory.buffer);
        postMessage({ method: 'ready' });
        return;
    }
    if (m.method === 'assign') {
        const modules = m.modules instanceof Map ? m.modules.size : -1;
        Atomics.add(mem, 0, 1);
        postMessage({ method: 'done', task: m.task, modules });
        for (;;)
            Atomics.wait(mem, 1, 0);
    }
};
