// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// What the carapace and Spiracle accept from a segment (docs/security.md items 4 and 6). A segment runs
// the site's code, so everything it sends is untrusted: every message is checked against a schema, a
// sanitised copy is all that is used, per-segment limits cap what one segment can ask for, and a counter
// of misbehaviour kills a segment that keeps sending what no honest segment sends. Pure functions and
// small classes with no DOM, shared by the carapace page, the Spiracle Worker and the Node tests.

import { cleanLayerTree } from './compositor.mjs';
import ChitinCookies from '../../build/cookies.mjs';

// --- Sites and segment origins ---------------------------------------------------------------------

// The site a URL belongs to: its registrable domain by the Public Suffix List (glue/cookies.js, the list the engine's libpsl
// has, private rules included as in Chrome). IP literals, single labels and public suffixes are their own site.
export function siteOf(url) {
    return ChitinCookies.registrableDomain(new URL(url).hostname);
}

export const sameSite = (a, b) => {
    try {
        return siteOf(a) === siteOf(b);
    } catch {
        return false;
    }
};

// The segment's DNS label: a hash of the site (and, as a hook, an identity salt: Tor is parked, so the salt is
// always empty today and a segment's origin depends on the site alone). 128 bits of SHA-256, hex, so the
// label is 33 characters (under DNS's 63) and tells nothing a navigation would not.
export async function segmentLabel(site, identitySalt = '', subtle = globalThis.crypto.subtle) {
    const bytes = new TextEncoder().encode(`chitin-segment\0${site.toLowerCase()}\0${identitySalt}`);
    const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
    let hex = '';
    for (let i = 0; i < 16; i++)
        hex += digest[i].toString(16).padStart(2, '0');
    return 's' + hex;
}

// --- Schemas ---------------------------------------------------------------------------------------

export const LIMITS = Object.freeze({
    urlLength: 8192,
    statusKey: 64,
    statusValue: 4096,
    errorLength: 2048,
    maxBitmapDimension: 16384,
    maxPaintMs: 600000,
});

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const isHttpUrl = (v) => {
    if (!isStr(v, LIMITS.urlLength))
        return false;
    try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
};

// The status line's value as text: the segment reports numbers, flags and small records as well as strings.
function statusText(v) {
    if (typeof v === 'string')
        return v;
    if (typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined)
        return String(v);
    if (typeof v === 'object') {
        try {
            const t = JSON.stringify(v);
            return typeof t === 'string' ? t : null;
        } catch {
            return null;
        }
    }
    return null;
}

// Each validator returns a clean copy of the message, or null. Unknown fields are dropped: a segment
// cannot smuggle data through a field the carapace never reads.
const PORT_SCHEMAS = {
    frame(m) {
        if (!isInt(m.seq, 0, 0x7fffffff) || typeof m.paintMs !== 'number' && m.paintMs !== undefined)
            return null;
        const out = { type: 'frame', seq: m.seq };
        if (m.paintMs !== undefined) {
            if (!Number.isFinite(m.paintMs) || m.paintMs < 0 || m.paintMs > LIMITS.maxPaintMs)
                return null;
            out.paintMs = m.paintMs;
        } else {
            out.paintMs = 0;
        }
        if (m.notReady !== undefined) {
            if (typeof m.notReady !== 'boolean')
                return null;
            out.notReady = m.notReady;
        }
        if (m.error !== undefined) {
            // An error text is shown, never acted on: cut it, do not refuse the frame.
            if (typeof m.error !== 'string')
                return null;
            out.error = m.error.slice(0, LIMITS.errorLength);
        }
        if (m.inputTs !== undefined) {
            if (typeof m.inputTs !== 'number' || !Number.isFinite(m.inputTs))
                return null;
            out.inputTs = m.inputTs;
        }
        if (m.inputSeq !== undefined) {
            if (!isInt(m.inputSeq, 0, 0x7fffffff))
                return null;
            out.inputSeq = m.inputSeq;
        }
        if (m.raster !== undefined) {
            // The engine's raster numbers of a layered frame (docs/scroll.md trace): ms, tiles rastered, of them on screen.
            if (!Array.isArray(m.raster) || m.raster.length !== 3 || !m.raster.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e6))
                return null;
            out.raster = m.raster.slice();
        }
        if (m.layers !== undefined) {
            // The compositor's layer tree (compositor.mjs cleans it) and one ImageBitmap per dirty tile part, of its size.
            const tree = cleanLayerTree(m.layers);
            if (!tree || !Array.isArray(m.tiles) || m.tiles.length !== tree.dirty.length)
                return null;
            for (let k = 0; k < m.tiles.length; k++) {
                const b = m.tiles[k];
                if (!b || typeof b !== 'object' || b.width !== tree.dirty[k][5] || b.height !== tree.dirty[k][6])
                    return null;
            }
            out.layers = tree;
            out.tiles = m.tiles.slice();
            // Video layers' frames (docs/youtube.md "Video on the host"): [layer id, ImageBitmap] for layers of the tree
            // that are video layers, each bitmap within bounds.
            if (m.videos !== undefined) {
                if (!Array.isArray(m.videos) || m.videos.length > 64)
                    return null;
                const videoLayers = new Set(tree.layers.filter((l) => l.video).map((l) => l.id));
                for (const v of m.videos) {
                    if (!Array.isArray(v) || v.length !== 2 || !videoLayers.has(v[0]))
                        return null;
                    const b = v[1];
                    if (!b || typeof b !== 'object' || !isInt(b.width, 1, LIMITS.maxBitmapDimension) || !isInt(b.height, 1, LIMITS.maxBitmapDimension))
                        return null;
                }
                out.videos = m.videos.map((v) => [v[0], v[1]]);
            }
        }
        if (m.bitmap !== undefined) {
            const b = m.bitmap;
            // An ImageBitmap (or the test's stand-in): positive integer dimensions within bounds, and a close().
            if (!b || typeof b !== 'object' || !isInt(b.width, 1, LIMITS.maxBitmapDimension) || !isInt(b.height, 1, LIMITS.maxBitmapDimension))
                return null;
            out.bitmap = b;
        }
        return out;
    },
    // The devtools panel's answers (carapace/devtools.js): one JSON string, shown with textContent only, never as markup.
    devtools(m) {
        if (!isInt(m.id, 0, 2 ** 31) || !isStr(m.json, 4 * 1024 * 1024))
            return null;
        return { type: 'devtools', id: m.id, json: m.json };
    },
    status(m) {
        const value = statusText(m.value);
        if (!isStr(m.key, LIMITS.statusKey) || m.key.length === 0 || value === null || value.length > LIMITS.statusValue)
            return null;
        return { type: 'status', key: m.key, value };
    },
    ready() {
        return { type: 'ready' };
    },
    // A wheel a nested segment's document could not use (docs/scroll.md C1): the carapace scrolls the parent with it.
    'wheel-unused'(m) {
        const n = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e6;
        if (!n(m.x) || !n(m.y) || !n(m.dx) || !n(m.dy) || !(m.ts === undefined || n(m.ts) || (typeof m.ts === 'number' && Number.isFinite(m.ts))))
            return null;
        return { type: 'wheel-unused', x: m.x, y: m.y, dx: m.dx, dy: m.dy, ts: m.ts };
    },
    // A nested segment's document finished loading (its parent fires the iframe's load event).
    loaded() {
        return { type: 'loaded' };
    },
    navigated(m) {
        if (!isHttpUrl(m.url) || !isInt(m.status, 0, 999))
            return null;
        if (m.error !== null && m.error !== undefined && !isStr(m.error, LIMITS.errorLength))
            return null;
        return { type: 'navigated', url: m.url, status: m.status, error: m.error || null };
    },
    // The segment jar's changes (docs/cookies.md): records the carapace's cookie store checks one by one against the segment's
    // entitlement (cookie-store.mjs); here only the shape.
    cookies(m) {
        return Array.isArray(m.list) && m.list.length <= 256 ? { type: 'cookies', list: m.list } : null;
    },
    'navigate-request'(m) {
        return isHttpUrl(m.url) ? { type: 'navigate-request', url: m.url } : null;
    },
    // Nested segments (frames.mjs): the parent's cross-site iframes; the carapace cleans the list itself.
    subframes(m) {
        return Array.isArray(m.list) && m.list.length <= 16 ? { type: 'subframes', list: m.list } : null;
    },
    // The segment's audio line (one per segment, the port rides along): the carapace hands it to the segment's
    // AudioWorklet node (audio-worklet.js checks what comes over it).
    'audio-port'() {
        return { type: 'audio-port' };
    },
    // Real-time features (docs/webrtc.md): the boxes of the page's elements that show a stream (the video layer), and the page's
    // requests for fullscreen, the pointer lock and gamepad effects. The carapace acts on them only with its own user activation.
    'video-sinks'(m) {
        if (!Array.isArray(m.list) || m.list.length > 32)
            return null;
        const list = [];
        for (const b of m.list) {
            if (!b || !isInt(b.sink, 1, 0x7fffffff) || ![b.x, b.y, b.width, b.height].every((v) => Number.isFinite(v) && Math.abs(v) < 1e6) || !(b.width >= 0 && b.height >= 0))
                return null;
            list.push({ sink: b.sink, x: b.x, y: b.y, width: b.width, height: b.height, fit: ['contain', 'cover', 'fill', 'none', 'scale-down'].includes(b.fit) ? b.fit : 'contain' });
        }
        return { type: 'video-sinks', list };
    },
    'fullscreen-request'(m) {
        return typeof m.enter === 'boolean' ? { type: 'fullscreen-request', enter: m.enter } : null;
    },
    'pointer-lock-request'(m) {
        return isInt(m.kind, 0, 2) ? { type: 'pointer-lock-request', kind: m.kind } : null;
    },
    'gamepad-effect'(m) {
        if (!isInt(m.index, 0, 15) || !isInt(m.kind, 0, 2) || !isInt(m.duration, 0, 5000) || ![m.strong, m.weak].every((v) => Number.isFinite(v) && v >= 0 && v <= 1))
            return null;
        return { type: 'gamepad-effect', index: m.index, kind: m.kind, strong: m.strong, weak: m.weak, duration: m.duration };
    },
    // A page's postMessage to one of its frames (an id) or to its parent. The data is the pages' business.
    // Windows a page opens (docs/oauth.md, glue/engine/52-popups.js): '' is about:blank, a window navigated later.
    'popup-open'(m) {
        if (!isInt(m.id, 1, 0x7fffffff) || !(m.url === '' || isHttpUrl(m.url)))
            return null;
        return { type: 'popup-open', id: m.id, url: m.url, noopener: m.noopener === true };
    },
    'popup-navigate'(m) {
        return isInt(m.id, 1, 0x7fffffff) && isHttpUrl(m.url) ? { type: 'popup-navigate', id: m.id, url: m.url } : null;
    },
    'popup-close'(m) {
        return isInt(m.id, 1, 0x7fffffff) ? { type: 'popup-close', id: m.id } : null;
    },
    // A popup segment's window.close().
    'window-close'() {
        return { type: 'window-close' };
    },
    // A page's postMessage to one of its frames (an id), its parent, its opener or a popup it opened ('popup:<id>').
    'frame-post'(m) {
        if (!(m.to === 'parent' || m.to === 'opener' || (typeof m.to === 'string' && /^popup:[1-9]\d{0,9}$/.test(m.to)) || isInt(m.to, 1, 0x7fffffff)) || !isStr(m.targetOrigin, LIMITS.urlLength))
            return null;
        return { type: 'frame-post', to: m.to, targetOrigin: m.targetOrigin, data: m.data };
    },
};

// Window messages from the segment document (before the port exists).
const WINDOW_SCHEMAS = {
    'segment-ready'(m) {
        return typeof m.crossOriginIsolated === 'boolean' ? { type: 'segment-ready', crossOriginIsolated: m.crossOriginIsolated } : null;
    },
    'segment-video'(m) {
        return typeof m.on === 'boolean' ? { type: 'segment-video', on: m.on } : null;
    },
    'segment-status'(m) {
        return isStr(m.key, LIMITS.statusKey) && m.key.length > 0 && isStr(m.value, LIMITS.statusValue)
            ? { type: 'segment-status', key: m.key, value: m.value } : null;
    },
    // WebRTC from the segment document (docs/webrtc.md): a capture the page asked for (the carapace's per-site decision), and a frame
    // of a stream the page shows (an ImageBitmap for the video layer).
    'rtc-permission'(m) {
        if (!isInt(m.ask, 1, 0x7fffffff) || !Array.isArray(m.kinds) || m.kinds.length < 1 || m.kinds.length > 2 || !m.kinds.every((k) => k === 'camera' || k === 'microphone' || k === 'display'))
            return null;
        return { type: 'rtc-permission', ask: m.ask, kinds: [...m.kinds] };
    },
    'rtc-video'(m) {
        const bitmapOk = typeof ImageBitmap === 'undefined' ? m.bitmap && typeof m.bitmap === 'object' : m.bitmap instanceof ImageBitmap;
        if (!isInt(m.sink, 1, 0x7fffffff) || !bitmapOk || !isInt(m.width, 0, 16384) || !isInt(m.height, 0, 16384))
            return null;
        return { type: 'rtc-video', sink: m.sink, bitmap: m.bitmap, width: m.width, height: m.height };
    },
};

// --- Rate limits ------------------------------------------------------------------------------------

// A token bucket: `rate` tokens a second, up to `burst`.
export class Bucket {
    constructor(rate, burst, now = () => performance.now()) {
        this.rate = rate;
        this.burst = burst;
        this.tokens = burst;
        this.now = now;
        this.last = now();
    }
    take() {
        const t = this.now();
        this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) * this.rate) / 1000);
        this.last = t;
        if (this.tokens < 1)
            return false;
        this.tokens -= 1;
        return true;
    }
}

// --- The carapace's view of one segment -------------------------------------------------------------

export const DEFAULT_SEGMENT_LIMITS = Object.freeze({
    strikesToKill: 12,
    messagesPerSecond: 600,     // all port messages; frames are paced to the display, so this is generous
    statusPerSecond: 40,
    navigateRequestsPerSecond: 3,
    framePostsPerSecond: 60,
    subframeListsPerSecond: 30,
    videoFramesPerSecond: 480,  // the video layer: a few streams at 60-120 fps
    permissionAsksPerSecond: 2,
});

// One displayed segment: the site it may show, the frame handshake, the checks and the strike counter.
// `kill(reason)` is called once, when the counter passes the threshold.
export class SegmentGuard {
    constructor({ url, kill, limits = {}, now }) {
        this.limits = { ...DEFAULT_SEGMENT_LIMITS, ...limits };
        this.displayedUrl = url;
        this.site = siteOf(url);
        this.kill = kill;
        this.strikes = 0;
        this.dead = false;
        this.log = [];
        this.framesInFlight = 0;
        this.expectedSeq = 0;
        this.all = new Bucket(this.limits.messagesPerSecond, this.limits.messagesPerSecond, now);
        this.statuses = new Bucket(this.limits.statusPerSecond, this.limits.statusPerSecond, now);
        this.navRequests = new Bucket(this.limits.navigateRequestsPerSecond, this.limits.navigateRequestsPerSecond, now);
        this.framePosts = new Bucket(this.limits.framePostsPerSecond, this.limits.framePostsPerSecond, now);
        this.subframeLists = new Bucket(this.limits.subframeListsPerSecond, this.limits.subframeListsPerSecond, now);
        this.videoFrames = new Bucket(this.limits.videoFramesPerSecond, this.limits.videoFramesPerSecond, now);
        this.permissionAsks = new Bucket(this.limits.permissionAsksPerSecond, this.limits.permissionAsksPerSecond * 2, now);
    }

    strike(reason) {
        if (this.dead)
            return;
        this.strikes++;
        if (this.log.length < 50)
            this.log.push(reason);
        if (this.strikes >= this.limits.strikesToKill) {
            this.dead = true;
            this.kill(`${this.strikes} misbehaving messages, the last: ${reason}`);
        }
    }

    // The carapace sent a frame tick: one reply is owed.
    ticked(seq) {
        this.framesInFlight++;
        this.expectedSeq = seq;
    }

    // A message on the segment's port. Returns a clean message the carapace may act on, or null (dropped).
    accept(data) {
        if (this.dead)
            return null;
        if (!this.all.take()) {
            this.strike('message flood');
            return null;
        }
        if (!data || typeof data !== 'object' || typeof data.type !== 'string' || !Object.hasOwn(PORT_SCHEMAS, data.type)) {
            this.strike('unknown message');
            return null;
        }
        const clean = PORT_SCHEMAS[data.type](data);
        if (!clean) {
            this.strike(`malformed ${data.type} {${describe(data)}}`);
            return null;
        }
        switch (clean.type) {
        case 'frame':
            if (this.framesInFlight <= 0) {
                this.strike('frame nobody asked for');
                if (clean.bitmap && typeof clean.bitmap.close === 'function')
                    clean.bitmap.close();
                return null;
            }
            this.framesInFlight--;
            if (clean.seq !== this.expectedSeq) {
                // A late reply to an older tick (the carapace re-ticks after a lost reply): not a crime, not shown.
                if (clean.bitmap && typeof clean.bitmap.close === 'function')
                    clean.bitmap.close();
                return null;
            }
            return clean;
        case 'status':
            if (!this.statuses.take()) {
                this.strike('status flood');
                return null;
            }
            return clean;
        case 'navigated':
            // The displayed address is the carapace's: a segment may report only documents of its own site.
            if (!sameSite(clean.url, this.displayedUrl)) {
                this.strike(`navigated to another site (${safeHost(clean.url)})`);
                return null;
            }
            this.displayedUrl = clean.url;
            return clean;
        case 'popup-open':
        case 'popup-navigate':
        case 'navigate-request':
            if (!this.navRequests.take()) {
                this.strike('navigation request flood');
                return null;
            }
            return clean;
        case 'frame-post':
            if (!this.framePosts.take()) {
                this.strike('postMessage flood');
                return null;
            }
            return clean;
        case 'subframes':
            if (!this.subframeLists.take()) {
                this.strike('subframe list flood');
                return null;
            }
            return clean;
        default:
            return clean;
        }
    }

    acceptWindow(data) {
        if (this.dead)
            return null;
        if (!data || typeof data !== 'object' || typeof data.type !== 'string' || !Object.hasOwn(WINDOW_SCHEMAS, data.type)) {
            this.strike('unknown window message');
            return null;
        }
        const clean = WINDOW_SCHEMAS[data.type](data);
        if (!clean) {
            this.strike(`malformed ${data.type}`);
            return null;
        }
        // Video frames past the layer's rate are dropped (a busy page, not a crime); capture asks are few or a flood.
        if (clean.type === 'rtc-video' && !this.videoFrames.take()) {
            if (typeof clean.bitmap.close === 'function')
                clean.bitmap.close();
            return null;
        }
        if (clean.type === 'rtc-permission' && !this.permissionAsks.take()) {
            this.strike('capture permission flood');
            return null;
        }
        return clean;
    }
}

// What a rejected message looked like, for the log: field names with their types (and short scalar values).
function describe(data) {
    const parts = [];
    for (const k of Object.keys(data).slice(0, 12)) {
        const v = data[k];
        parts.push(`${k.slice(0, 20)}:${v !== null && typeof v === 'object' ? `object(${v.width ?? ''}x${v.height ?? ''})` : typeof v === 'string' ? JSON.stringify(v.slice(0, 40)) : String(v)}`);
    }
    return parts.join(' ');
}

function safeHost(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return '?';
    }
}

// --- Spiracle's view of one segment ------------------------------------------------------------------

export const DEFAULT_NET_LIMITS = Object.freeze({
    strikesToKill: 20,
    // Streams open at once and connects a second. The engine keeps a segment under 60 connections (it closes an idle one, or the
    // request waits, as Chrome's socket pool does at its 256), so the cap is a backstop; Chrome opens a burst of connects for a
    // busy page's origins when it starts.
    maxStreams: 128,
    connectsPerSecond: 60,
    connectBurst: 120,
    // Connects refused for the caps above are answered with a close and are free up to this many (and this many a second):
    // a busy page is not a misbehaving one. Past it, each refusal is a strike (a flood).
    refusalsFree: 100,
    refusalsPerSecond: 10,
    messagesPerSecond: 3000,
    maxChunk: 1 << 20,          // bytes in one data message
    maxBufferedWritesPerStream: 64 << 20,
    allowedPorts: [80, 443],
});

const HOST_RE = /^[A-Za-z0-9.\-\[\]:]{1,253}$/;

// Validates the engine's stream requests: { t: 'connect', s, host, port } | { t: 'data', s, b } | { t: 'close', s }.
export class NetGuard {
    constructor({ kill, limits = {}, now }) {
        this.limits = { ...DEFAULT_NET_LIMITS, ...limits };
        this.kill = kill;
        this.strikes = 0;
        this.dead = false;
        this.open = new Set();
        this.all = new Bucket(this.limits.messagesPerSecond, this.limits.messagesPerSecond, now);
        this.connects = new Bucket(this.limits.connectsPerSecond, this.limits.connectBurst, now);
        this.refusals = new Bucket(this.limits.refusalsPerSecond, this.limits.refusalsFree, now);
    }

    strike(reason) {
        if (this.dead)
            return;
        this.strikes++;
        if (this.strikes >= this.limits.strikesToKill) {
            this.dead = true;
            this.kill(`${this.strikes} misbehaving stream requests, the last: ${reason}`);
        }
    }

    // Returns the clean request or null. `refuse` tells the caller to answer a connect with a close
    // (the stream was never opened) rather than stay silent.
    accept(m) {
        if (this.dead)
            return { clean: null };
        if (!this.all.take()) {
            this.strike('stream message flood');
            return { clean: null };
        }
        if (!m || typeof m !== 'object' || !isInt(m.s, 1, 0x7fffffff)) {
            this.strike('malformed stream id');
            return { clean: null };
        }
        if (m.t === 'connect') {
            if (typeof m.host !== 'string' || !HOST_RE.test(m.host) || !isInt(m.port, 1, 65535) || !this.limits.allowedPorts.includes(m.port)) {
                this.strike('invalid destination');
                return { clean: null, refuse: m.s };
            }
            if (this.open.has(m.s)) {
                this.strike('stream id reused');
                return { clean: null };
            }
            if (this.open.size >= this.limits.maxStreams || !this.connects.take()) {
                if (!this.refusals.take())
                    this.strike('too many streams');
                return { clean: null, refuse: m.s, reason: 'too many streams' };
            }
            this.open.add(m.s);
            return { clean: { t: 'connect', s: m.s, host: m.host, port: m.port } };
        }
        if (!this.open.has(m.s)) {
            // Data or close for a stream that is not open: late traffic after a close is normal, so no strike.
            return { clean: null };
        }
        if (m.t === 'data') {
            if (!(m.b instanceof ArrayBuffer) || m.b.byteLength > this.limits.maxChunk) {
                this.strike('malformed data');
                return { clean: null };
            }
            return { clean: { t: 'data', s: m.s, b: m.b } };
        }
        if (m.t === 'close') {
            this.open.delete(m.s);
            return { clean: { t: 'close', s: m.s } };
        }
        this.strike('unknown stream message');
        return { clean: null };
    }

    closed(s) {
        this.open.delete(s);
    }
}
