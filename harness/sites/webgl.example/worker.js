// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// The WebGL probe in a dedicated worker, on OffscreenCanvas (keys prefixed "worker.").
importScripts('probe.js');
webglProbe(self, 'worker.').then(function (r) { postMessage(r); }, function (e) { postMessage({ 'worker.failed': String(e && e.stack || e) }); });
