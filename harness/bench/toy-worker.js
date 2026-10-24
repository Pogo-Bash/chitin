// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Runs the same cases on the toy engine, in a dedicated Worker with page JS on V8 next to the
// engine: the shape of a segment.
importScripts('/build/ganglion.js');
const boot = self.__chitinBoot;
delete self.__chitinBoot;
self.onmessage = async () => {
    const wasm = await (await fetch('/build/ganglion-toy.wasm')).arrayBuffer();
    const env = Object.create(null);
    const host = boot({ wasm, global: env });
    const { domCases, vdomCases } = await import('/bench-src/cases.js');
    const { rawCases } = await import('/bench-src/raw.js');
    const channel = new MessageChannel();
    const taskBoundary = () => new Promise((resolve) => {
        channel.port1.onmessage = () => {
            host.collect();
            resolve();
        };
        channel.port2.postMessage(0);
    });
    const raw = rawCases(host);
    const dom = await domCases(env, { taskBoundary });
    const vdom = await vdomCases(env, { taskBoundary });
    self.postMessage({ raw, dom, vdom });
};
