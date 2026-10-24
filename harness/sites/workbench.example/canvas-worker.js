// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// The canvas section's OffscreenCanvas in a dedicated Worker: draws with the page's own routine (importScripts of the section).
self.WB = { section() {} };
importScripts('sections/canvas.js');
onmessage = async (e) => {
    const { canvas, W, H } = e.data;
    const ctx = canvas.getContext('2d');
    try { const f = new FontFace('WBAscii', 'url(ascii-only.woff2)'); self.fonts.add(f); await f.load(); } catch {}
    self.WB.draw2d(ctx, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    const G = 4, sums = new Array(G * G * 4).fill(0), n = new Array(G * G).fill(0);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = Math.floor(y * G / H) * G + Math.floor(x * G / W), i = (y * W + x) * 4; for (let k = 0; k < 4; k++) sums[c * 4 + k] += d[i + k]; n[c]++; }
    postMessage({ grid: { '~': sums.map((s, i) => Math.round(s / n[i >> 2])), tol: 8 }, commit: typeof ctx.commit, isWorker: typeof WorkerGlobalScope });
};
