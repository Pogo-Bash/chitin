// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Nested segments (docs/architecture.md "Nested segments"): the carapace's rules for cross-site iframes, shared by
// carapace.js and the Node tests (tests/frames.test.mjs). A parent segment reports its cross-site iframes
// (`subframes`); the carapace cleans the list, starts a child segment per entry, composites the child's frames over
// the box, routes pointer input by hit test, and relays postMessage between parent and child, stamping the sender's
// origin and checking the receiver's against targetOrigin. Nothing here trusts what a segment says about anyone
// but itself.
import { siteOf } from './guard.mjs';

export const FRAME_LIMITS = Object.freeze({
    maxFrames: 16,
    maxDimension: 8192,
    postsPerSecond: 60,
});

export function originOf(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
    } catch {
        return null;
    }
}

// The parent's list, cleaned: integer ids, http(s) URLs of another site than the parent's, finite boxes clamped to
// the parent's viewport (a box entirely outside it is kept with zero size: the child exists but is not shown).
// Returns null when the message is malformed (a strike), else the clean list.
export function cleanSubframes(list, parentUrl, viewport) {
    if (!Array.isArray(list) || list.length > FRAME_LIMITS.maxFrames)
        return null;
    const parentSite = siteOf(parentUrl);
    const out = [];
    const seen = new Set();
    for (const f of list) {
        if (!f || typeof f !== 'object' || !Number.isInteger(f.id) || f.id <= 0 || seen.has(f.id))
            return null;
        if (typeof f.url !== 'string' || f.url.length > 8192 || originOf(f.url) === null)
            return null;
        for (const k of ['x', 'y', 'width', 'height'])
            if (typeof f[k] !== 'number' || !Number.isFinite(f[k]))
                return null;
        seen.add(f.id);
        if (siteOf(f.url) === parentSite)
            continue; // same-site frames are the parent engine's own documents
        const width = Math.min(Math.max(0, Math.round(f.width)), FRAME_LIMITS.maxDimension);
        const height = Math.min(Math.max(0, Math.round(f.height)), FRAME_LIMITS.maxDimension);
        // What the frame's document may earn of cross-origin isolation: its parent isolated and its iframe allowing it, and the
        // parent's COEP the frame's response must meet (docs/user-tests/coi.md).
        const coi = f.coi && typeof f.coi === 'object' ? { isolated: f.coi.isolated === true, coep: ['require-corp', 'credentialless'].includes(f.coi.coep) ? f.coi.coep : 'unsafe-none' } : { isolated: false, coep: 'unsafe-none' };
        const entry = { id: f.id, url: f.url, name: typeof f.name === 'string' ? f.name.slice(0, 1024) : '', coi, box: { x: Math.round(f.x), y: Math.round(f.y), width, height }, clip: clampRect({ x: Math.round(f.x), y: Math.round(f.y), width, height }, viewport) };
        // What the frame moves with under threaded scroll (docs/scroll.md B3): a fixed box, or its scrolling ancestors.
        if (typeof f.fixed === 'boolean' && Array.isArray(f.scrollers) && f.scrollers.length <= 8 && f.scrollers.every((r) => Array.isArray(r) && r.length === 4 && r.every((v) => typeof v === 'number' && Number.isFinite(v))))
            entry.moves = { fixed: f.fixed, scrollers: f.scrollers.map((r) => r.slice()) };
        out.push(entry);
    }
    return out;
}

// The part of `rect` inside the viewport (0, 0, width, height), or an empty rect.
export function clampRect(rect, viewport) {
    const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y);
    const x1 = Math.min(viewport.width, rect.x + rect.width), y1 = Math.min(viewport.height, rect.y + rect.height);
    if (x1 <= x0 || y1 <= y0)
        return { x: 0, y: 0, width: 0, height: 0 };
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// The topmost frame (last in document order) whose visible part holds the point, with the point in its coordinates.
export function hitTest(frames, x, y) {
    for (let i = frames.length - 1; i >= 0; i--) {
        const f = frames[i];
        const c = f.clip;
        if (c.width > 0 && x >= c.x && x < c.x + c.width && y >= c.y && y < c.y + c.height)
            return { id: f.id, x: x - f.box.x, y: y - f.box.y };
    }
    return null;
}

// Chrome's delivery check (HTML "window post message steps" 7 and the posted task's first step): `*` goes anywhere,
// otherwise only to a receiver whose origin is exactly the target origin at delivery time.
export function deliverable(targetOrigin, receiverOrigin) {
    if (typeof targetOrigin !== 'string' || receiverOrigin === null)
        return false;
    return targetOrigin === '*' || targetOrigin === receiverOrigin;
}

// The relay: segments by key, each child knows its parent and the id the parent gave its iframe.
// route() answers who gets a post and what they are told, or null to drop it.
export class FrameRouter {
    constructor() {
        this.segments = new Map(); // key -> { url, parent: key | null, frameId: number | null }
    }
    set(key, info) {
        // A popup segment (docs/oauth.md) has an `opener` (key) and the `popupId` its opener's page knows it by.
        this.segments.set(key, { url: info.url, parent: info.parent ?? null, frameId: info.frameId ?? null, opener: info.opener ?? null, popupId: info.popupId ?? null });
    }
    navigated(key, url) {
        const s = this.segments.get(key);
        if (s)
            s.url = url;
    }
    delete(key) {
        this.segments.delete(key);
    }
    childOf(parentKey, frameId) {
        for (const [key, s] of this.segments)
            if (s.parent === parentKey && s.frameId === frameId)
                return key;
        return null;
    }
    popupOf(openerKey, popupId) {
        for (const [key, s] of this.segments)
            if (s.opener === openerKey && s.popupId === popupId)
                return key;
        return null;
    }
    // `to` is the frame id the sender used, 'parent', 'opener' (from a popup) or 'popup:<id>' (to a popup the sender opened).
    route(fromKey, to, targetOrigin) {
        const from = this.segments.get(fromKey);
        if (!from)
            return null;
        let toKey, fromId;
        if (to === 'opener') {
            if (from.opener === null)
                return null;
            toKey = this.segments.has(from.opener) ? from.opener : null;
            fromId = 'popup:' + from.popupId;
        } else if (typeof to === 'string' && /^popup:[1-9]\d*$/.test(to)) {
            toKey = this.popupOf(fromKey, Number(to.slice(6)));
            fromId = 'opener';
        } else if (to === 'parent') {
            if (from.parent === null)
                return null;
            toKey = from.parent;
            fromId = from.frameId;
        } else {
            if (!Number.isInteger(to))
                return null;
            toKey = this.childOf(fromKey, to);
            fromId = 'parent';
        }
        const receiver = toKey === null ? null : this.segments.get(toKey);
        if (!receiver || !deliverable(targetOrigin, originOf(receiver.url)))
            return null;
        return { toKey, from: fromId, origin: originOf(from.url) };
    }
}

// Copies `child` (RGBA, its own size) into `parent` at box, clipped to clip (both in parent pixels at dpr 1).
export function composeRGBA(parent, child, box, clip) {
    for (let y = clip.y; y < clip.y + clip.height; y++) {
        const cy = y - box.y;
        if (cy < 0 || cy >= child.height)
            continue;
        for (let x = clip.x; x < clip.x + clip.width; x++) {
            const cx = x - box.x;
            if (cx < 0 || cx >= child.width)
                continue;
            const s = (cy * child.width + cx) * 4, d = (y * parent.width + x) * 4;
            parent.data[d] = child.data[s];
            parent.data[d + 1] = child.data[s + 1];
            parent.data[d + 2] = child.data[s + 2];
            parent.data[d + 3] = child.data[s + 3];
        }
    }
    return parent;
}
