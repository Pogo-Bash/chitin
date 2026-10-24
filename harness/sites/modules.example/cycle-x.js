// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Two chunks that import each other, as Vite's do (dash.cloudflare.com): the graph links and both evaluate.
import { y } from './cycle-y.js';
export const x = 'x';
export const readx = () => y;
