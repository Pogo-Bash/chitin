// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
import { twice } from './mlib.js';
onmessage = () => postMessage({ twice: twice(4), meta: import.meta.url.replace(/^.*\//, ''), importScripts: (() => { try { importScripts('lib.js'); return 'allowed'; } catch (e) { return e.name; } })() });
