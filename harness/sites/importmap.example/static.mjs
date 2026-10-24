// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Static imports through the import map: a bare key, a prefix key, a URL key, a re-export, and a scope.
import entry from '#entry';
import a from 'lib/a.mjs';
import old from "/old.mjs";
export { x } from 'second';
import { x } from 'second';
import scoped from '/scoped/s.mjs';
window.ran.push(`static: ${entry} ${a} ${old} ${x} ${scoped}`);
