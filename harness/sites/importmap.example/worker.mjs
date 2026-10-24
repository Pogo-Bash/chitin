// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// A module worker has no import map (Chrome 154): '#entry' fails, a relative import works.
const out = [];
try { await import('#entry'); out.push('ok'); } catch (e) { out.push(e.name + ': ' + e.message); }
try { out.push((await import('./entry.mjs')).default); } catch (e) { out.push(e.message); }
postMessage(out.join(' | '));
