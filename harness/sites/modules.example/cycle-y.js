// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Two chunks that import each other, as Vite's do (dash.cloudflare.com): the graph links and both evaluate.
import { x } from './cycle-x.js';
export const y = 'y';
export const ready = () => x;
