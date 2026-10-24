// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Says it is up as soon as its script runs; echoes what it is sent.
postMessage({ up: performance.timeOrigin + performance.now() });
onmessage = (e) => postMessage({ echo: e.data.n });
