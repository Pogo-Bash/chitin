// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Compiles a wasm file eagerly under Node's V8 so that a module Chrome would refuse fails here, in the
// build, with V8's own message and byte offset. Run as
//   node --no-wasm-lazy-validation tools/wasm-validate.mjs build/ganglion.wasm [more.wasm...]
// (--no-wasm-lazy-validation is V8's default, named so a future default cannot quietly skip bodies.)
// make engine-stamp runs it over the stamped module and make engine-test over the module under test:
// the stamp once wrote keyed bytes over data segment headers and only Chrome noticed (docs/provenance.md).

import fs from 'node:fs';

let failed = 0;
for (const file of process.argv.slice(2)) {
    const t0 = performance.now();
    try {
        const module = new WebAssembly.Module(fs.readFileSync(file));
        const imports = WebAssembly.Module.imports(module).length;
        const exports = WebAssembly.Module.exports(module).length;
        console.log(`${file}: compiles (${(performance.now() - t0).toFixed(0)} ms, ${imports} imports, ${exports} exports)`);
    } catch (e) {
        console.error(`${file}: ${e}`);
        failed++;
    }
}
process.exit(failed ? 1 : 0);
