// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin's compositor, carapace half (docs/compositor.md). A segment sends, per frame, its layer tree (in paint order:
// id, kind, the local -> viewport affine map `m`, tile size, the tiles it keeps, a clip rect, a scroll node and offset,
// a backdrop filter) and the dirty parts of tiles as ImageBitmaps. This module keeps the tiles and composites them:
//   - SoftwareCompositor: RGBA in memory (Node reftests: composited vs flat paint);
//   - DomCompositor: one canvas element per tile under CSS transforms and clips; a backdrop filter the engine leaves to
//     the carapace is a CSS backdrop-filter box (the host browser's GPU); without CSS backdrop-filter the engine rasters
//     those boxes with what is behind them;
//   - GLCompositor: WebGL2, one textured quad per tile, scissor/rounded clips and a GPU blur pass for
//     backdrop-filter (see glcompositor.mjs).
// All three read the same LayerTree model, so a test of the model covers what the browser backends draw.

export const COMPOSITOR_LIMITS = Object.freeze({
    maxLayers: 64,
    maxTilesPerLayer: 512,
    maxTileSize: 512,
    maxDirty: 1024,
    maxDimension: 16384,
});
const KINDS = new Set(['root', 'scroll', 'sticky', 'transform', 'canvas', 'backdrop', 'video']);

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// A segment's layer tree, cleaned: returns null when anything is malformed (the guard counts a strike). Unknown fields
// are dropped. `dirty` entries are [layer, i, j, x, y, w, h], matched with the transferred bitmaps by index.
export function cleanLayerTree(t) {
    const L = COMPOSITOR_LIMITS;
    if (!t || typeof t !== 'object' || !int(t.w, 1, L.maxDimension) || !int(t.h, 1, L.maxDimension) || !Array.isArray(t.layers) || t.layers.length > L.maxLayers)
        return null;
    const out = { w: t.w, h: t.h, fill: int(t.fill, 0, 255) ? t.fill : 255, flat: t.flat === true, layers: [], dirty: [] };
    if (Array.isArray(t.media) && t.media.length <= 64 && t.media.every((r) => Array.isArray(r) && r.length === 4 && r.every(num)))
        out.media = t.media.map((r) => r.slice()); // the trace only
    if (Array.isArray(t.ds) && t.ds.length === 16 && t.ds.every(num))
        out.ds = t.ds.slice(); // the trace only: why the list's damage was what it was (docs/feel.md)
    const ids = new Set();
    for (const l of t.layers) {
        if (!l || typeof l !== 'object' || !int(l.id, 1, 0x7fffffff) || ids.has(l.id) || !KINDS.has(l.kind) || !int(l.node, 0, 0x7fffffff))
            return null;
        if (!Array.isArray(l.m) || l.m.length !== 6 || !l.m.every(num) || !int(l.tw, 1, L.maxTileSize) || !int(l.th, 1, L.maxTileSize))
            return null;
        if (!Array.isArray(l.tiles) || l.tiles.length > L.maxTilesPerLayer || !l.tiles.every((p) => Array.isArray(p) && p.length === 2 && int(p[0], -65536, 65536) && int(p[1], -65536, 65536)))
            return null;
        ids.add(l.id);
        const layer = { id: l.id, kind: l.kind, ms: num(l.ms) && l.ms >= 0 ? l.ms : 0, node: l.node, m: l.m.slice(), tw: l.tw, th: l.th, tiles: l.tiles.map((p) => [p[0], p[1]]), clip: null, offset: null, backdrop: null, canvas: l.canvas === true };
        if (l.clip !== undefined) {
            if (!Array.isArray(l.clip) || l.clip.length !== 4 || !l.clip.every(num))
                return null;
            layer.clip = l.clip.slice();
        }
        if (l.why !== undefined && int(l.why, 0, 255)) layer.why = l.why;
        // A video layer (docs/youtube.md "Video on the host"): [host frame, x, y, w, h (layer space), scaling, u0, v0, uw, vh, rounded clip x, y, w, h, radius]; its
        // frame arrives beside the tiles and is drawn there.
        if (l.video !== undefined) {
            if (!Array.isArray(l.video) || l.video.length !== 15 || !l.video.every(num))
                return null;
            layer.video = l.video.slice();
        }
        if (l.rr !== undefined) {
            if (!num(l.rr) || l.rr < 0 || l.rr > 4096)
                return null;
            layer.rr = l.rr; // a rounded port's corner radius (docs/scroll.md R1)
        }
        if (Array.isArray(l.dmg) && l.dmg.length === 8 && l.dmg.every(num)) layer.dmg = l.dmg.slice(); // the trace only
        if (l.ext !== undefined) {
            // A scroll layer's content extent in its own space: what tiles must cover (the checkerboard measure).
            if (!Array.isArray(l.ext) || l.ext.length !== 4 || !l.ext.every(num))
                return null;
            layer.ext = l.ext.slice();
        }
        if (l.offset !== undefined) {
            if (!Array.isArray(l.offset) || l.offset.length !== 2 || !l.offset.every(num))
                return null;
            layer.offset = l.offset.slice();
        }
        if (l.chain !== undefined) {
            if (!Array.isArray(l.chain) || l.chain.length > 64 || !l.chain.every((n) => int(n, 1, 0x7fffffff)))
                return null;
            layer.chain = l.chain.slice();
        }
        if (l.sticky !== undefined) {
            const v = l.sticky;
            if (!Array.isArray(v) || v.length !== 18 || !v.every((x, i) => (i >= 12 && i <= 15 ? x === null || num(x) : num(x))))
                return null;
            layer.sticky = v.slice();
        }
        if (l.backdrop !== undefined) {
            const b = l.backdrop;
            if (!b || !Array.isArray(b.region) || b.region.length !== 4 || !b.region.every(num) || !num(b.radius) || !num(b.blur) || !num(b.saturate) || b.blur < 0 || b.blur > 256)
                return null;
            layer.backdrop = { region: b.region.slice(), radius: Math.max(0, b.radius), blur: b.blur, saturate: b.saturate };
        }
        out.layers.push(layer);
    }
    // Threaded scroll (docs/compositor.md): scroll nodes [node, parent, port x, y, w, h, min x, min y, max x, max y,
    // offset x, y, wheel h, wheel v, flags (1 viewport, 2 snap container, 4 a layer), last carapace scroll applied],
    // wheel targets [x, y, w, h, node] in paint order, regions that keep wheels on the main thread [x, y, w, h].
    out.scroll = { nodes: [], targets: [], blocking: [], blockAll: true };
    if (t.scroll !== undefined) {
        const sc = t.scroll;
        if (!sc || typeof sc !== 'object' || !Array.isArray(sc.nodes) || !Array.isArray(sc.targets) || !Array.isArray(sc.blocking) || sc.nodes.length > 256 || sc.targets.length > 4096 || sc.blocking.length > 4096)
            return null;
        if (!sc.nodes.every((n) => Array.isArray(n) && n.length === 16 && n.every(num)) || !sc.targets.every((n) => Array.isArray(n) && n.length === 5 && n.every(num)) || !sc.blocking.every((n) => Array.isArray(n) && n.length === 4 && n.every(num)))
            return null;
        out.scroll = { nodes: sc.nodes.map((n) => n.slice()), targets: sc.targets.map((n) => n.slice()), blocking: sc.blocking.map((n) => n.slice()), blockAll: sc.blockAll === true };
    }
    if (t.dirty !== undefined) {
        if (!Array.isArray(t.dirty) || t.dirty.length > L.maxDirty)
            return null;
        for (const d of t.dirty) {
            if (!Array.isArray(d) || d.length !== 7 || !ids.has(d[0]) || !int(d[1], -65536, 65536) || !int(d[2], -65536, 65536) || !int(d[3], 0, L.maxTileSize) || !int(d[4], 0, L.maxTileSize) || !int(d[5], 1, L.maxTileSize) || !int(d[6], 1, L.maxTileSize))
                return null;
            out.dirty.push(d.slice());
        }
    }
    return out;
}

// The model: layers by id with their tiles; `apply` takes a cleaned tree and the dirty parts (each with a `pixels`
// source the backend understands), `forEach` walks the layers in paint order with their current map.
export class LayerTree {
    constructor(backend) {
        this.backend = backend;
        this.layers = new Map(); // id -> { ...layer, store: Map('i,j' -> tile) }
        this.order = [];
        this.width = 0;
        this.height = 0;
        this.fill = 255;
        this.scroll = new Map(); // scroll node -> device offset the carapace applies (threaded scroll), or absent
        this.threaded = new Map(); // scroll node -> { base: [x, y] (the engine's scroll offset), pending: [[seq, dx, dy]] }
        this.scrollInfo = { nodes: [], targets: [], blocking: [], blockAll: true };
    }
    // The engine's offsets: each frame says the last carapace scroll it applied per node; scrolls up to it are in the
    // engine's offset now, later ones are still the carapace's (the engine is the authority; a script's scrollTo or a
    // clamp shows as soon as no carapace scroll is pending).
    syncScroll(info) {
        this.scrollInfo = info;
        for (const n of info.nodes) {
            const [node] = n;
            const st = this.threaded.get(node);
            if (!st) continue;
            st.base = [n[10], n[11]];
            st.pending = st.pending.filter((p) => p[0] > n[15]);
            if (!st.pending.length) {
                this.threaded.delete(node);
                this.scroll.delete(node);
            } else {
                this.scroll.set(node, this.deviceOffset(node));
            }
        }
    }
    node(index) { return this.scrollInfo.nodes.find((n) => n[0] === index); }
    scrollOffset(index) {
        const n = this.node(index);
        if (!n) return null;
        const st = this.threaded.get(index);
        let x = st ? st.base[0] : n[10], y = st ? st.base[1] : n[11];
        if (st) for (const p of st.pending) { x += p[1]; y += p[2]; }
        return [Math.min(Math.max(x, n[6]), n[8]), Math.min(Math.max(y, n[7]), n[9])];
    }
    deviceOffset(index) { const o = this.scrollOffset(index); return o ? [-o[0], -o[1]] : null; }
    // A wheel at (x, y) by (dx, dy), device pixels: the scroll node the carapace scrolls, by how much, or null when the
    // wheel must go to the engine (Chrome's rules: a non-passive wheel listener on the way, a nested document, a snap
    // container, a scroller that is not a layer, or nothing left to scroll in that direction).
    // `whyNot` (the scroll trace, docs/scroll.md) says why the last wheel went to the engine.
    wheelTarget(x, y, dx, dy) {
        const info = this.scrollInfo;
        const no = (why) => { this.whyNot = why; return null; };
        if (info.blockAll || !info.nodes.length) return no(info.blockAll ? 'blocked: a non-passive wheel listener on the viewport (or no tree yet)' : 'no scroll nodes');
        const inside = (r) => x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3];
        if (info.blocking.some(inside)) return no('blocked: a non-passive wheel listener region');
        let index = 0;
        for (const t of info.targets) if (inside(t) && t[4]) index = t[4];
        if (!index) {
            const viewport = info.nodes.find((n) => n[14] & 1);
            if (!viewport) return no('no viewport node');
            index = viewport[0];
        }
        for (let guard = 0; index && guard < 64; guard++) {
            const n = this.node(index);
            if (!n) return no('unknown node');
            const o = this.scrollOffset(index);
            const nx = n[12] ? Math.min(Math.max(o[0] + dx, n[6]), n[8]) : o[0];
            const ny = n[13] ? Math.min(Math.max(o[1] + dy, n[7]), n[9]) : o[1];
            if (nx !== o[0] || ny !== o[1]) {
                if (n[14] & 2) return no('snap container');
                if (!(n[14] & 4)) return no('the scroller is not a layer');
                this.whyNot = null;
                return { node: index, dx: nx - o[0], dy: ny - o[1] };
            }
            index = n[1]; // chain to the scroller around it
        }
        return no('nothing left to scroll');
    }
    // The carapace scrolled `node` by (dx, dy) device px as scroll `seq`.
    scrollBy(node, dx, dy, seq) {
        let st = this.threaded.get(node);
        if (!st) {
            const n = this.node(node);
            st = { base: [n[10], n[11]], pending: [] };
            this.threaded.set(node, st);
        }
        st.pending.push([seq, dx, dy]);
        this.scroll.set(node, this.deviceOffset(node));
    }
    apply(tree, parts) {
        if (tree.scroll)
            this.syncScroll(tree.scroll);
        this.width = tree.w;
        this.height = tree.h;
        this.fill = tree.fill;
        const next = new Map();
        for (const l of tree.layers) {
            const old = this.layers.get(l.id);
            const store = old && old.tw === l.tw && old.th === l.th ? old.store : new Map();
            if (old && old.store !== store)
                for (const t of old.store.values()) this.backend.dropTile(t);
            const keep = new Set(l.tiles.map((p) => p[0] + ',' + p[1]));
            for (const [k, t] of store)
                if (!keep.has(k)) { this.backend.dropTile(t); store.delete(k); }
            next.set(l.id, { ...l, store });
        }
        for (const [id, old] of this.layers)
            if (!next.has(id))
                for (const t of old.store.values()) this.backend.dropTile(t);
        this.layers = next;
        this.order = tree.layers.map((l) => next.get(l.id));
        for (let k = 0; k < tree.dirty.length; k++) {
            const [id, i, j, x, y, w, h] = tree.dirty[k];
            const layer = next.get(id);
            const key = i + ',' + j;
            let tile = layer.store.get(key);
            if (!tile) {
                tile = this.backend.newTile(layer.tw, layer.th, layer);
                tile.i = i;
                tile.j = j;
                layer.store.set(key, tile);
            }
            this.backend.writeTile(tile, x, y, w, h, parts[k]);
        }
    }
    // Checkerboard (docs/scroll.md): device px of scroll layers on screen now (inside their clip, inside their content
    // extent) that no tile covers. Translation-only layers (scroll layers are).
    uncovered() {
        let px = 0;
        for (const layer of this.order) {
            if (layer.kind !== 'scroll' || !layer.ext || !layer.clip) continue;
            // A video layer with no tile (docs/youtube.md "Video on the host"): the host draws its frame; nothing to wait for.
            if (layer.video && !layer.tiles.length) continue;
            const m = this.matrixOf(layer);
            const port = intersect(this.clipOf(layer), [0, 0, this.width, this.height]);
            const r = intersect([port[0] - m[4], port[1] - m[5], port[2], port[3]], layer.ext);
            if (!r[2] || !r[3]) continue;
            const i0 = Math.floor(r[0] / layer.tw), i1 = Math.floor((r[0] + r[2] - 1) / layer.tw);
            const j0 = Math.floor(r[1] / layer.th), j1 = Math.floor((r[1] + r[3] - 1) / layer.th);
            for (let j = j0; j <= j1; j++)
                for (let i = i0; i <= i1; i++) {
                    if (layer.store.has(i + ',' + j)) continue;
                    const c = intersect(r, [i * layer.tw, j * layer.th, layer.tw, layer.th]);
                    px += c[2] * c[3];
                }
        }
        return px;
    }
    // A child segment's place now (docs/scroll.md B3): its box (device px, as the parent's last frame laid it out) moved
    // by the carapace's scroll of the scroll nodes it moves with (the viewport and the nodes whose ports match its
    // scrolling ancestors' boxes; nothing for a frame under a fixed box), clipped to its innermost scroller, and the
    // index of the layer it is drawn after (the last layer of those nodes), or -1 (over everything).
    externalPlacement(rect, moves) {
        const nodes = this.scrollInfo.nodes;
        if (!moves || moves.fixed || !nodes.length)
            return { rect, clip: rect, after: -1 };
        const near = (a, b) => Math.abs(a - b) <= 2;
        const chain = [];
        for (const n of nodes) {
            if (n[14] & 1) { chain.push(n); continue; }
            if (moves.scrollers.some((r) => {
                const c = intersect([Math.round(r[0]), Math.round(r[1]), Math.round(r[2]), Math.round(r[3])], [0, 0, this.width, this.height]);
                return near(c[0], n[2]) && near(c[1], n[3]) && near(c[2], n[4]) && near(c[3], n[5]);
            })) chain.push(n);
        }
        let dx = 0, dy = 0;
        for (const n of chain) {
            const host = this.scroll.get(n[0]);
            if (host) { dx += host[0] + n[10]; dy += host[1] + n[11]; }
        }
        const moved = [rect[0] + dx, rect[1] + dy, rect[2], rect[3]];
        let clip = moved;
        let inner = null;
        for (const n of chain) if (!(n[14] & 1) && (!inner || n[4] * n[5] < inner[4] * inner[5])) inner = n;
        if (inner) {
            // The inner scroller's port moves with the scrolls around it, not with its own.
            const own = this.scroll.get(inner[0]);
            const ox = own ? own[0] + inner[10] : 0, oy = own ? own[1] + inner[11] : 0;
            clip = intersect(moved, [inner[2] + dx - ox, inner[3] + dy - oy, inner[4], inner[5]]);
        }
        const ids = new Set(chain.map((n) => n[0]));
        let after = -1;
        this.order.forEach((l, k) => { if (ids.has(l.node)) after = k; });
        // Its scroller is not a layer: after the last layer that scrolls at all and is not sticky (fixed and sticky
        // layers, later in paint order, stay over it).
        if (after < 0)
            this.order.forEach((l, k) => { if (l.kind !== 'sticky' && l.chain && l.chain.length) after = k; });
        return { rect: moved, clip, after };
    }
    // The clip a layer is drawn with now: the engine's, moved by the carapace's scroll of the scrollers around the one
    // that clips it (a layer's chain starts with its own scroll node, or the scroller it sits in; its clip is that
    // scroller's port, which moves with the ones around it only). docs/scroll.md B4.
    clipOf(layer) {
        if (!layer.clip || !this.scroll.size || !layer.chain || layer.chain.length < 2)
            return layer.clip;
        let dx = 0, dy = 0;
        for (const node of layer.chain.slice(1)) {
            const host = this.scroll.get(node);
            const n = host && this.node(node);
            if (!n) continue;
            dx += host[0] + n[10];
            dy += host[1] + n[11];
        }
        if (!dx && !dy)
            return layer.clip;
        // The engine's clip is already cut by the outer scroller's port: a side flush with that port was cut there, so it
        // is grown back by the shift, and the result cut by the port, which does not move with this scroll (an
        // approximation: content past the cut by less than the shift shows up to the port; docs/scroll.md B4).
        const c = layer.clip;
        let [x0, y0, x1, y1] = [c[0] + dx, c[1] + dy, c[0] + c[2] + dx, c[1] + c[3] + dy];
        const outer = this.node(layer.chain[1]);
        if (outer) {
            const [ox, oy, ow, oh] = [outer[2], outer[3], outer[4], outer[5]];
            const at = (a, b) => Math.abs(a - b) <= 1;
            if (at(c[0], ox)) x0 -= Math.abs(dx);
            if (at(c[1], oy)) y0 -= Math.abs(dy);
            if (at(c[0] + c[2], ox + ow)) x1 += Math.abs(dx);
            if (at(c[1] + c[3], oy + oh)) y1 += Math.abs(dy);
            return intersect([x0, y0, x1 - x0, y1 - y0], [ox, oy, ow, oh]);
        }
        return [x0, y0, x1 - x0, y1 - y0];
    }
    // The map a layer is drawn with now: the engine's, moved by how far the carapace scrolled its node beyond the
    // engine's offset (threaded scroll), and for sticky layers by the sticky shift the carapace computes.
    matrixOf(layer) {
        const m = layer.m.slice();
        if (this.scroll.size && layer.chain) {
            // Every scroll node the layer moves with that the carapace scrolled past the engine's offset.
            for (const node of layer.chain) {
                const host = this.scroll.get(node);
                const n = host && this.node(node);
                if (!n) continue;
                m[4] += host[0] + n[10];
                m[5] += host[1] + n[11];
            }
            // A sticky box moves by how its sticky shift changes at the carapace's offset of its scroller.
            if (layer.sticky && this.scroll.has(layer.sticky[0]) && !layer.sticky[1]) {
                const n = this.node(layer.sticky[0]);
                if (n) {
                    const shift = stickyOffset(layer.sticky, this.scroll.get(layer.sticky[0]));
                    m[4] += shift[0] - layer.sticky[16];
                    m[5] += shift[1] - layer.sticky[17];
                }
            }
        }
        if (this.adjust)
            this.adjust(layer, m);
        return m;
    }
}

// LibWeb's sticky offset (LibCompositing visual_context/queries.rs resolve_sticky_offsets), for a sticky box with no
// parent sticky: `v` is the engine's constraint list [scroller, parent, position x, y, border box w, h, scrollport w, h,
// containing block x, y, w, h, insets top, right, bottom, left (null: auto), entry x, y]; `entry` the scroller's device
// offset (its negated scroll offset). Test vectors: tests/compositor.test.mjs.
export function stickyOffset(v, entry) {
    const [, , px, py, bw, bh, sw, sh, cx, cy, cw, ch, top, right, bottom, left] = v;
    const port = { x: -entry[0], y: -entry[1], w: sw, h: sh };
    const maxX = cx + cw - bw, maxY = cy + ch - bh;
    let ox = 0, oy = 0;
    if (top !== null && port.y > py - top) oy = Math.min(port.y + top, maxY) - py;
    if (left !== null && port.x > px - left) ox = Math.min(port.x + left, maxX) - px;
    if (bottom !== null && port.y + port.h < py + bh + bottom) oy = Math.max(port.y + port.h - bh - bottom, cy) - py;
    if (right !== null && port.x + port.w < px + bw + right) ox = Math.max(port.x + port.w - bw - right, cx) - px;
    return [ox, oy];
}

// --- Software backend (Node reftests) -----------------------------------------------------------------------------
// Tiles are RGBA (not premultiplied) arrays; parts are { data, width, height } (ImageData-shaped).
export class SoftwareCompositor {
    constructor() {
        this.tree = new LayerTree(this);
    }
    newTile(w, h) { return { w, h, data: new Uint8ClampedArray(w * h * 4) }; }
    dropTile() {}
    writeTile(tile, x, y, w, h, part) {
        for (let row = 0; row < h; row++) {
            const src = row * w * 4;
            tile.data.set(part.data.subarray(src, src + w * 4), ((y + row) * tile.w + x) * 4);
        }
    }
    apply(tree, parts) { this.tree.apply(tree, parts); }
    // The composited frame as { width, height, data } (RGBA).
    composite() {
        const W = this.tree.width, H = this.tree.height;
        const out = new Uint8ClampedArray(W * H * 4);
        const f = this.tree.fill;
        for (let p = 0; p < out.length; p += 4) out[p] = out[p + 1] = out[p + 2] = f, out[p + 3] = 255;
        for (const layer of this.tree.order) {
            const m = this.tree.matrixOf(layer);
            let clip = [0, 0, W, H];
            const lc = this.tree.clipOf(layer);
            if (lc)
                clip = intersect(clip, lc);
            const rr = lc && layer.rr ? layer.rr : 0;
            if (layer.backdrop)
                backdropSoftware(out, W, H, layer.backdrop);
            const inv = invert(m);
            if (!inv) continue;
            for (const tile of layer.store.values()) {
                const ox = tile.i * layer.tw, oy = tile.j * layer.th;
                // The tile's bounds on screen.
                const b = mapRect(m, [ox, oy, layer.tw, layer.th]);
                const r = intersect(clip, [Math.floor(b[0]), Math.floor(b[1]), Math.ceil(b[0] + b[2]) - Math.floor(b[0]), Math.ceil(b[1] + b[3]) - Math.floor(b[1])]);
                for (let y = r[1]; y < r[1] + r[3]; y++) {
                    for (let x = r[0]; x < r[0] + r[2]; x++) {
                        // Pixel centres, nearest sample (the maps are whole-pixel translations in practice).
                        const lx = inv[0] * (x + 0.5) + inv[2] * (y + 0.5) + inv[4] - ox;
                        const ly = inv[1] * (x + 0.5) + inv[3] * (y + 0.5) + inv[5] - oy;
                        const tx = Math.floor(lx), ty = Math.floor(ly);
                        if (tx < 0 || ty < 0 || tx >= tile.w || ty >= tile.h) continue;
                        const s = (ty * tile.w + tx) * 4;
                        let a = tile.data[s + 3];
                        if (rr) a = Math.round(a * roundedCover(x + 0.5, y + 0.5, lc, rr));
                        if (a === 0) continue;
                        const d = (y * W + x) * 4;
                        if (a === 255) {
                            out[d] = tile.data[s]; out[d + 1] = tile.data[s + 1]; out[d + 2] = tile.data[s + 2];
                        } else if (rr) {
                            const k = a / 255; // the tile's alpha (straight) times the corner's coverage
                            out[d] = tile.data[s] * k + out[d] * (1 - k);
                            out[d + 1] = tile.data[s + 1] * k + out[d + 1] * (1 - k);
                            out[d + 2] = tile.data[s + 2] * k + out[d + 2] * (1 - k);
                        } else {
                            const k = a / 255;
                            out[d] = tile.data[s] * k + out[d] * (1 - k);
                            out[d + 1] = tile.data[s + 1] * k + out[d + 1] * (1 - k);
                            out[d + 2] = tile.data[s + 2] * k + out[d + 2] * (1 - k);
                        }
                    }
                }
            }
        }
        return { width: W, height: H, data: out };
    }
}

// Coverage of pixel centre (px, py) by the rounded rect r with corner radius rad (0..1, a half-pixel edge), as the
// WebGL2 backend's tile shader computes it.
export function roundedCover(px, py, r, rad) {
    const qx = Math.min(Math.max(px, r[0] + rad), r[0] + r[2] - rad), qy = Math.min(Math.max(py, r[1] + rad), r[1] + r[3] - rad);
    const d = Math.hypot(px - qx, py - qy) - rad;
    return Math.min(Math.max(0.5 - d, 0), 1);
}
export function intersect(a, b) {
    const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]);
    const x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]);
    return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : [0, 0, 0, 0];
}
export function invert(m) {
    const [a, b, c, d, e, f] = m;
    const det = a * d - b * c;
    if (!det) return null;
    const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
    return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)];
}
export function mapRect(m, r) {
    const xs = [r[0], r[0] + r[2]], ys = [r[1], r[1] + r[3]];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const x of xs) for (const y of ys) {
        const X = m[0] * x + m[2] * y + m[4], Y = m[1] * x + m[3] * y + m[5];
        x0 = Math.min(x0, X); y0 = Math.min(y0, Y); x1 = Math.max(x1, X); y1 = Math.max(y1, Y);
    }
    return [x0, y0, x1 - x0, y1 - y0];
}

// A backdrop filter in software, as the GL backend draws it: the region's pixels blurred (Gaussian, sigma = blur;
// pixels from up to 3 sigma outside the region, clamped to the frame) and saturated, inside the rounded region.
export function backdropSoftware(out, W, H, bd) {
    const [rx, ry, rw, rh] = bd.region.map(Math.round);
    const pad = Math.ceil(bd.blur * 3);
    const box = intersect([0, 0, W, H], [rx - pad, ry - pad, rw + 2 * pad, rh + 2 * pad]);
    const [bx, by, bw, bh] = box;
    if (!bw || !bh) return;
    let buf = new Float32Array(bw * bh * 3);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const s = ((by + y) * W + bx + x) * 4, d = (y * bw + x) * 3;
        buf[d] = out[s]; buf[d + 1] = out[s + 1]; buf[d + 2] = out[s + 2];
    }
    if (bd.blur > 0) {
        for (const size of boxesForGauss(bd.blur, 3)) {
            buf = boxBlur(buf, bw, bh, (size - 1) / 2, true);
            buf = boxBlur(buf, bw, bh, (size - 1) / 2, false);
        }
    }
    const s = bd.saturate;
    const r = bd.radius;
    const region = intersect(box, [rx, ry, rw, rh]);
    for (let y = region[1]; y < region[1] + region[3]; y++) for (let x = region[0]; x < region[0] + region[2]; x++) {
        if (r > 0 && !insideRounded(x + 0.5, y + 0.5, rx, ry, rw, rh, r)) continue;
        const d = ((y - by) * bw + (x - bx)) * 3;
        let R = buf[d], G = buf[d + 1], B = buf[d + 2];
        if (s !== 1) {
            // The CSS saturate() matrix (Filter Effects 1).
            const R2 = (0.213 + 0.787 * s) * R + (0.715 - 0.715 * s) * G + (0.072 - 0.072 * s) * B;
            const G2 = (0.213 - 0.213 * s) * R + (0.715 + 0.285 * s) * G + (0.072 - 0.072 * s) * B;
            const B2 = (0.213 - 0.213 * s) * R + (0.715 - 0.715 * s) * G + (0.072 + 0.928 * s) * B;
            R = R2; G = G2; B = B2;
        }
        const o = (y * W + x) * 4;
        out[o] = R; out[o + 1] = G; out[o + 2] = B;
    }
}
function insideRounded(px, py, x, y, w, h, r) {
    const cx = px < x + r ? x + r : px > x + w - r ? x + w - r : px;
    const cy = py < y + r ? y + r : py > y + h - r ? y + h - r : py;
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}
// Box sizes whose three passes approximate a Gaussian of `sigma` (W3C's backdrop/feGaussianBlur note).
export function boxesForGauss(sigma, n) {
    const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
    let wl = Math.floor(wIdeal);
    if (wl % 2 === 0) wl--;
    const wu = wl + 2;
    const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
    const m = Math.round(mIdeal);
    const sizes = [];
    for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
    return sizes;
}
function boxBlur(src, w, h, r, horizontal) {
    const dst = new Float32Array(src.length);
    const n = horizontal ? w : h, lines = horizontal ? h : w;
    const span = 2 * r + 1;
    for (let line = 0; line < lines; line++) {
        const at = (k) => { const kk = Math.min(n - 1, Math.max(0, k)); return (horizontal ? line * w + kk : kk * w + line) * 3; };
        for (let c = 0; c < 3; c++) {
            let acc = 0;
            for (let k = -r; k <= r; k++) acc += src[at(k) + c];
            for (let k = 0; k < n; k++) {
                dst[at(k) + c] = acc / span;
                acc += src[at(k + r + 1) + c] - src[at(k - r) + c];
            }
        }
    }
    return dst;
}

// --- DOM backend -----------------------------------------------------------------------------------------------
// `stage` is an element the size of the frame in device pixels (the carapace scales it to the view). Each layer is a
// clip box (overflow hidden) holding a plane under the layer's CSS matrix; each tile is a 2D canvas on the plane.
export class DomCompositor {
    constructor(stage) {
        this.stage = stage;
        this.tree = new LayerTree(this);
        this.boxes = new Map(); // layer id -> { box, plane, backdrop }
    }
    static supportsBackdrop(doc) {
        const css = doc.defaultView && doc.defaultView.CSS;
        return !!(css && css.supports && css.supports('backdrop-filter', 'blur(1px)'));
    }
    newTile(w, h, layer) {
        const c = stage(this).ownerDocument.createElement('canvas');
        c.width = w;
        c.height = h;
        c.style.cssText = 'position:absolute;width:' + w + 'px;height:' + h + 'px';
        return { canvas: c, ctx: c.getContext('2d'), w, h, layer: layer.id };
    }
    dropTile(tile) {
        tile.canvas.remove();
        tile.canvas.width = 0; // gives the memory back now
    }
    writeTile(tile, x, y, w, h, bitmap) {
        tile.ctx.clearRect(x, y, w, h);
        tile.ctx.drawImage(bitmap, x, y);
        bitmap.close?.();
    }
    // `videos`: [[layer id, ImageBitmap]], the new frames of video layers (docs/youtube.md "Video on the host").
    apply(tree, bitmaps, videos) {
        this.tree.apply(tree, bitmaps);
        this.layout();
        for (const [id, bitmap] of videos || []) {
            const el = this.boxes.get(id);
            if (el && el.video) {
                if (el.video.width !== bitmap.width || el.video.height !== bitmap.height) {
                    el.video.width = bitmap.width;
                    el.video.height = bitmap.height;
                }
                const layer = this.tree.layers.get(id);
                const uv = layer && layer.video ? layer.video.slice(6) : [0, 0, 1, 1];
                el.video.getContext('2d').drawImage(bitmap, uv[0] * bitmap.width, uv[1] * bitmap.height, uv[2] * bitmap.width, uv[3] * bitmap.height, 0, 0, bitmap.width, bitmap.height);
            }
            bitmap.close?.();
        }
    }
    // Places the boxes and planes; also called per animation frame when the carapace scrolls (threaded scroll).
    layout() {
        const doc = this.stage.ownerDocument;
        const seen = new Set();
        let before = this.stage.firstChild;
        this.stage.style.background = `rgb(${this.tree.fill},${this.tree.fill},${this.tree.fill})`;
        for (const layer of this.tree.order) {
            seen.add(layer.id);
            let el = this.boxes.get(layer.id);
            if (!el) {
                const box = doc.createElement('div');
                const plane = doc.createElement('div');
                box.style.cssText = 'position:absolute;overflow:hidden;pointer-events:none';
                plane.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0';
                box.appendChild(plane);
                el = { box, plane };
                this.boxes.set(layer.id, el);
            }
            // A backdrop filter: a box under the layer whose CSS backdrop-filter blurs what the layers below drew.
            if (layer.backdrop) {
                if (!el.backdrop) {
                    el.backdrop = doc.createElement('div');
                    el.backdrop.style.cssText = 'position:absolute;pointer-events:none';
                }
                const b = layer.backdrop;
                Object.assign(el.backdrop.style, { left: b.region[0] + 'px', top: b.region[1] + 'px', width: b.region[2] + 'px', height: b.region[3] + 'px', borderRadius: b.radius + 'px',
                    backdropFilter: `blur(${b.blur}px)` + (b.saturate !== 1 ? ` saturate(${b.saturate})` : '') });
                if (el.backdrop !== before)
                    this.stage.insertBefore(el.backdrop, before);
                before = el.backdrop.nextSibling;
            } else if (el.backdrop) {
                el.backdrop.remove();
                el.backdrop = null;
            }
            if (el.box !== before)
                this.stage.insertBefore(el.box, before);
            before = el.box.nextSibling;
            const clip = this.tree.clipOf(layer) || [0, 0, this.tree.width, this.tree.height];
            Object.assign(el.box.style, { left: clip[0] + 'px', top: clip[1] + 'px', width: clip[2] + 'px', height: clip[3] + 'px', borderRadius: layer.rr && layer.clip ? layer.rr + 'px' : '' });
            const m = this.tree.matrixOf(layer);
            el.plane.style.transform = `matrix(${m[0]},${m[1]},${m[2]},${m[3]},${m[4] - clip[0]},${m[5] - clip[1]})`;
            if (layer.video) {
                if (!el.video) {
                    el.video = doc.createElement('canvas');
                    el.video.style.position = 'absolute';
                    el.plane.appendChild(el.video);
                }
                Object.assign(el.video.style, { left: layer.video[1] + 'px', top: layer.video[2] + 'px', width: layer.video[3] + 'px', height: layer.video[4] + 'px', borderRadius: layer.video[14] > 0 ? layer.video[14] + 'px' : '' });
            } else if (el.video) {
                el.video.remove();
                el.video = null;
            }
            for (const tile of layer.store.values()) {
                if (tile.canvas.parentNode !== el.plane) {
                    tile.canvas.style.left = tile.i * layer.tw + 'px';
                    tile.canvas.style.top = tile.j * layer.th + 'px';
                    el.plane.appendChild(tile.canvas);
                }
            }
        }
        for (const [id, el] of this.boxes)
            if (!seen.has(id)) { el.box.remove(); el.backdrop?.remove(); this.boxes.delete(id); }
    }
    // The composited frame drawn into a 2D context the size of the frame (tests read pixels this way, as they read the
    // view canvas in flat mode).
    drawInto(ctx) {
        const f = this.tree.fill;
        ctx.save();
        ctx.fillStyle = `rgb(${f},${f},${f})`;
        ctx.fillRect(0, 0, this.tree.width, this.tree.height);
        for (const layer of this.tree.order) {
            if (layer.backdrop) {
                const [x, y, w, h] = layer.backdrop.region;
                if (w > 0 && h > 0) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.roundRect ? ctx.roundRect(x, y, w, h, layer.backdrop.radius) : ctx.rect(x, y, w, h);
                    ctx.clip();
                    ctx.filter = `blur(${layer.backdrop.blur}px)` + (layer.backdrop.saturate !== 1 ? ` saturate(${layer.backdrop.saturate})` : '');
                    ctx.drawImage(ctx.canvas, 0, 0);
                    ctx.restore();
                }
            }
            const m = this.tree.matrixOf(layer);
            ctx.save();
            const lc = this.tree.clipOf(layer);
            if (lc) {
                ctx.beginPath();
                if (layer.rr && ctx.roundRect) ctx.roundRect(...lc, layer.rr);
                else ctx.rect(...lc);
                ctx.clip();
            }
            ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
            for (const tile of layer.store.values())
                ctx.drawImage(tile.canvas, tile.i * layer.tw, tile.j * layer.th);
            const v = layer.video && this.boxes.get(layer.id) && this.boxes.get(layer.id).video;
            if (v && v.width > 0)
                ctx.drawImage(v, layer.video[1], layer.video[2], layer.video[3], layer.video[4]);
            ctx.restore();
        }
        ctx.restore();
    }
    destroy() {
        for (const layer of this.tree.order) for (const t of layer.store.values()) this.dropTile(t);
        for (const el of this.boxes.values()) { el.box.remove(); el.backdrop?.remove(); }
        this.boxes.clear();
    }
}
const stage = (c) => c.stage;
