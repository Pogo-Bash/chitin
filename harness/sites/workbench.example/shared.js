// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// The workers section's SharedWorker: one instance for every port with the same name.
let n = 0;
onconnect = (e) => { const p = e.ports[0]; n++; p.onmessage = () => p.postMessage({ connections: n, name: self.name }); };
