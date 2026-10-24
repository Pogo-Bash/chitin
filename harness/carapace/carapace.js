// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// The carapace: the shell page on its own origin. It never runs site code. It creates the segment
// iframe on the site's own origin, sends it frame ticks and input, and composites its frames.
// One segment per document: every cross-document navigation (the address bar, a link in the page, a redirect to
// another site) removes the segment's iframe, and its Worker with it, and starts a new one. The carapace owns the
// displayed site: a segment's origin is a hash of the site, `navigated` is accepted only within the site, and
// anything else the segment asks for is a request the carapace performs (docs/security.md item 4). Everything a
// segment sends goes through guard.mjs first (item 6).
// Cross-site iframes are nested segments (frames.mjs, docs/architecture.md "Nested segments"): the carapace starts a
// child segment per iframe its parent reports, draws the child's frames over the box, sends it the input that lands in
// the box, and relays postMessage between the two with the origins it knows.
import { siteOf, segmentLabel, SegmentGuard } from './guard.mjs';
import { cleanSubframes, hitTest, FrameRouter, originOf } from './frames.mjs';
import { detectSignIn, checkReturnUrl } from './signin.mjs';
import { CookieStore } from './cookie-store.mjs';
import { DomCompositor } from './compositor.mjs';
import { GLCompositor } from './glcompositor.mjs';
import ChitinCookies from '../../build/cookies.mjs';
(() => {
    const params = new URLSearchParams(location.search);
    const mode = params.get('mode') || 'bitmap';
    const frameMode = params.get('frame') || 'under';
    const classic = params.get('classic') || 'eval';
    const engine = params.get('engine') || 'ganglion';
    const scripting = params.get('scripting') !== 'off';
    // Same-site frames get a script realm of their own (glue/engine/55-realms.js); ?frames.realms=0 turns it off.
    const frameRealms = params.get('frames.realms') !== '0';
    // ?debug.contexts=1: the engine reports the first call that leaves an execution context behind (docs/captcha.md).
    const debugContexts = params.get('debug.contexts') === '1';
    // The compositor (docs/compositor.md): ?compositor=flat is the reference path (one frame per paint, as before);
    // 'dom' composites the engine's tiles here as canvas elements (backdrop filters as CSS backdrop-filter when the host
    // has it, else rastered by the engine).
    // 'webgl' (the default when the host has WebGL2) draws them as textured quads, backdrop blurs on the GPU, and
    // nested segments as layers of the same canvas.
    // ?scroll=main keeps every wheel on the engine's main-thread path (the threaded scroll's reference).
    const threadedScroll = params.get('scroll') !== 'main';
    let scrollSeq = 0;
    // The scroll trace (docs/scroll.md, tests/chrome/scroll-sync.mjs): per engine frame and per composite, what moved where.
    let trace = null;
    function traceComposite(tree, externals) {
        if (!trace || trace.length > 20000) return;
        trace.push({ k: 'c', t: performance.now(), scroll: [...tree.scroll].map(([n, o]) => [n, o[0], o[1]]), uncovered: tree.uncovered(), ext: externals ? [...externals.values()].map((e) => e.rect && e.rect.slice()) : [] });
    }
    // ?compositor.sync=1: each composite waits for the GPU (benchmarks: the composite ms include the GPU's work).
    const syncComposite = params.get('compositor.sync') === '1';
    const hasWebGL2 = (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } })();
    const compositorBackend = ['flat', 'dom', 'webgl'].includes(params.get('compositor')) ? params.get('compositor') : hasWebGL2 ? 'webgl' : 'dom';
    // What the engine is asked for: layers, with blur/saturate backdrop filters left to us when we can draw them.
    const engineCompositor = compositorBackend === 'flat' ? 'flat' : compositorBackend === 'webgl' || DomCompositor.supportsBackdrop(document) ? 'gpu' : 'layers';
    // ?compat.hide=host1,host2: test rules for the site-compatibility list (docs/surface.md), hiding the Chitin token from those
    // hosts as a webcompat/ rule would. For tests only; the shipped list is webcompat/*.json.
    const compatHide = (params.get('compat.hide') || '').split(',').filter((h) => /^[a-z0-9.-]+$/i.test(h));
    const site = params.get('site') || (engine === 'toy' ? 'demo.example' : 'static.example');
    // A real URL (?url=) loads over the engine's network through Spiracle and the relay; the test
    // sites (*.example) come from the stand-in as before.
    const url = params.get('url') || `https://${site}/`;
    const IDENTITY_SALT = ''; // Tor mode would set this per identity; parked, so a segment's origin is hash(site) alone
    const CARAPACE_PORT = location.port;
    for (const [id, v] of [['mode', mode], ['frame', frameMode], ['classic', classic], ['engine', engine], ['site', site], ['scripting', scripting ? 'on' : 'off']]) {
        const el = document.getElementById(id);
        el.value = v;
        el.addEventListener('change', () => {
            params.set(id, el.value);
            if (id === 'site')
                params.delete('url');
            location.search = params.toString();
        });
    }
    const address = document.getElementById('address');
    address.value = url;
    document.getElementById('go').addEventListener('submit', (e) => {
        e.preventDefault();
        let target = address.value.trim();
        if (!/^[a-z]+:/i.test(target))
            target = 'https://' + target;
        try {
            target = new URL(target).href;
        } catch {
            status('address', 'not a URL: ' + target);
            return;
        }
        navigateTo(target);
    });

    // --- Spiracle: the network Worker, with the relay's URL and token (never given to segments) -----
    const relayInput = document.getElementById('relay');
    const tokenInput = document.getElementById('token');
    const RELAY_DEFAULT = document.documentElement.dataset.relay || 'ws://127.0.0.1:8101/';
    let relaySettings = { url: RELAY_DEFAULT, token: '' };
    try {
        const saved = JSON.parse(sessionStorage.getItem('chitin-relay') || 'null');
        if (saved && saved.url)
            relaySettings = saved;
    } catch { /* no storage: the defaults */ }
    relayInput.value = relaySettings.url;
    tokenInput.value = relaySettings.token || '';
    // --- Cookies: the browser's one store (cookie-store.mjs, docs/cookies.md) ---------------------------------------------
    // ?cookies.persist=0 keeps them in memory only (tests that must start empty).
    const cookieStore = new CookieStore({ persist: params.get('cookies.persist') !== '0' });
    const cookiesReady = cookieStore.load().then((n) => status('cookies', `${n} restored`)).catch((e) => status('cookies', 'restore FAILED: ' + (e && e.message || e)));
    addEventListener('pagehide', () => cookieStore.flush());
    const cookieSegments = new Set();
    // Changes a segment made (already checked by the store) go to every other live segment entitled to them.
    function forwardCookies(from, changes) {
        if (!changes.length)
            return;
        for (const other of cookieSegments) {
            if (other.dead) {
                cookieSegments.delete(other);
                continue;
            }
            if (other === from || !other.port || !other.cookieScope)
                continue;
            const list = changes.filter((c) => CookieStore.entitled(other.cookieScope, c));
            if (list.length)
                other.port.postMessage({ type: 'cookies', list });
        }
    }
    // The panel's list (Cookies, beside the Segment panel): sites with cookies and a clear button for each.
    const cookiePanel = document.getElementById('cookies');
    function showCookies() {
        if (!cookiePanel)
            return;
        cookiePanel.replaceChildren();
        for (const e of cookieStore.sites()) {
            const dt = document.createElement('dt');
            dt.textContent = e.site;
            const dd = document.createElement('dd');
            dd.textContent = `${e.count} cookie${e.count === 1 ? '' : 's'}${e.partitioned ? ` (${e.partitioned} partitioned)` : ''} `;
            const b = document.createElement('button');
            b.textContent = 'clear';
            b.dataset.site = e.site;
            b.addEventListener('click', () => clearSiteCookies(e.site));
            dd.append(b);
            cookiePanel.append(dt, dd);
        }
    }
    function clearSiteCookies(site) {
        const n = cookieStore.clearSite(site);
        forwardCookies(null, cookieStore.cleared || []);
        cookieStore.flush();
        status('cookies cleared', `${site}: ${n}`);
        showCookies();
    }
    let cookiePanelTimer = 0;
    const cookiesChanged = () => { if (!cookiePanelTimer) cookiePanelTimer = setTimeout(() => { cookiePanelTimer = 0; showCookies(); }, 250); };
    cookiesReady.then(showCookies);

    const spiracle = new Worker('/carapace/spiracle.js', { type: 'module', name: 'spiracle' });
    spiracle.onerror = (e) => status('spiracle error', e.message);
    function configureRelay() {
        relaySettings = { url: relayInput.value.trim() || RELAY_DEFAULT, token: tokenInput.value };
        try {
            sessionStorage.setItem('chitin-relay', JSON.stringify(relaySettings));
        } catch { /* fine */ }
        spiracle.postMessage({ type: 'config', url: relaySettings.url, token: relaySettings.token || null, ports: (document.documentElement.dataset.netPorts || '80,443').split(',').map(Number) });
    }
    configureRelay();
    relayInput.addEventListener('change', configureRelay);
    tokenInput.addEventListener('change', configureRelay);

    const tab = document.getElementById('tab');
    let view = document.getElementById('view');
    const metricsEl = document.getElementById('metrics');
    const statusEl = document.getElementById('status');
    const results = { userAgent: navigator.userAgent, mode, frame: frameMode, classic, engine, site, url, status: {}, metrics: {} };
    let dpr = window.devicePixelRatio || 1; // followed per frame (a zoom, another display): the segment's devicePixelRatio
    // ?tab=WxH sizes the tab (benchmarks: docs/compositor.md); the default is the stylesheet's 800x600.
    const tabSize = /^(\d{2,4})x(\d{2,4})$/.exec(params.get('tab') || '');
    if (tabSize)
        Object.assign(tab.style, { width: tabSize[1] + 'px', height: tabSize[2] + 'px', maxWidth: 'none' });
    let width = tab.clientWidth, height = tab.clientHeight; // the tab's size changes in fullscreen (docs/webrtc.md) and from the size menu (layout.js)
    if (mode === 'direct')
        tab.classList.add('direct');

    function show(dl, store, key, value) {
        store[key] = value;
        let dd = dl.querySelector(`dd[data-key="${CSS.escape(key)}"]`);
        if (!dd) {
            const dt = document.createElement('dt');
            dt.textContent = key;
            dd = document.createElement('dd');
            dd.dataset.key = key;
            dl.append(dt, dd);
        }
        dd.textContent = value;
    }
    const metric = (k, v) => show(metricsEl, results.metrics, k, v);
    // Every row also goes to the devtools panel's console (devtools.js), which keeps the errors and says which layer each came from.
    const status = (k, v) => {
        show(statusEl, results.status, k, v);
        window.dispatchEvent(new CustomEvent('chitin-status', { detail: { key: k, value: String(v) } }));
    };
    // Rows that describe one page's frames: dropped when a top-level navigation starts, so a frame row of the
    // previous page (a captcha frame's URL, say) is never shown as if the new page had it.
    const PAGE_ROW = /^frame(s| error| \d+( navigated)?)$/;
    function clearPageRows() {
        for (const key of Object.keys(results.status)) {
            if (!PAGE_ROW.test(key))
                continue;
            delete results.status[key];
            const dd = statusEl.querySelector(`dd[data-key="${CSS.escape(key)}"]`);
            if (dd) {
                dd.previousElementSibling?.remove();
                dd.remove();
            }
        }
    }
    status('carapace origin', location.origin);
    status('carapace crossOriginIsolated', String(self.crossOriginIsolated));
    spiracle.onmessage = (e) => {
        const m = e.data;
        if (m && m.type === 'status' && typeof m.key === 'string' && typeof m.value === 'string')
            status('spiracle: ' + m.key.slice(0, 64), m.value.slice(0, 4096));
        else if (m && m.type === 'kill')
            for (const seg of liveSegments())
                if (seg.label === m.name)
                    killSegment(seg, 'Spiracle: ' + String(m.reason).slice(0, 500));
    };

    // The URL the address bar shows is the carapace's, set when it starts a segment and moved only by a
    // `navigated` from that segment within its own site.
    let current = null;       // the live segment: { label, origin, iframe, port, guard, ... }
    let handoff = null;       // the sign-in handoff shown (docs/oauth.md), or null
    let generation = 0;
    let bitmapCtx;
    const router = new FrameRouter();
    let focused = null;       // the segment keys go to: the last one a pointer-down landed in
    // The live segment and its children (one level: a child's own cross-site iframes are not started yet).
    // A snapshot: callers kill segments while they go through it (a kill tears the children down and can clear `current`).
    function liveSegments() {
        const top = current;
        if (!top || top.dead)
            return [];
        const out = [top];
        for (const child of top.children.values())
            if (!child.dead)
                out.push(child);
        for (const entry of top.popups.values())
            if (entry.segment && !entry.segment.dead)
                out.push(entry.segment);
        return out;
    }

    const pct = (list, p) => {
        if (!list.length)
            return NaN;
        const s = [...list].sort((a, b) => a - b);
        return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
    };
    const stats = { frameTimes: [], roundTrips: [], inputLatencies: [], paintTimes: [], received: 0, lastReport: performance.now(), receivedAtReport: 0 };
    // Input -> the frame that contains it (docs/compositor.md "Benchmarks"): every input message carries a sequence
    // number; a frame reply names the last one the segment had applied before it painted, and each input up to it is
    // timed from its event timestamp to the reply (the frame goes to the canvas in the same task).
    let inputSeq = 0;
    const scrollLatencies = []; // wheel inputs only
    function sendInput(seg, m) {
        m.seq = ++inputSeq;
        const pending = seg.pendingInputs || (seg.pendingInputs = []); // [seq, timestamp (epoch ms), wheel]
        pending.push([m.seq, m.ts, m.kind === 'wheel']);
        if (pending.length > 1000)
            pending.shift();
        seg.port.postMessage(m);
    }
    // A carapace scroll reached the screen (the composite after it): its latency, input timestamp to that frame.
    const handlerLatencies = []; // carapace scrolls: our wheel handler -> the composite that shows it
    function threadedShown(ts, handled) {
        if (handled !== undefined) {
            handlerLatencies.push(performance.now() - handled);
            if (handlerLatencies.length > 2000) handlerLatencies.shift();
        }
        const now = performance.timeOrigin + performance.now();
        scrollLatencies.push(now - ts);
        if (scrollLatencies.length > 2000)
            scrollLatencies.shift();
        stats.inputLatencies.push(now - ts);
        if (stats.inputLatencies.length > 200)
            stats.inputLatencies.shift();
    }
    function inputsShown(seg, upTo) {
        const now = performance.timeOrigin + performance.now();
        const pending = seg.pendingInputs || [];
        while (pending.length && pending[0][0] <= upTo) {
            const [, ts, wheel] = pending.shift();
            stats.inputLatencies.push(now - ts);
            if (stats.inputLatencies.length > 200)
                stats.inputLatencies.shift();
            if (wheel) {
                scrollLatencies.push(now - ts);
                if (scrollLatencies.length > 2000)
                    scrollLatencies.shift();
            }
        }
    }

    // --- Audio: one AudioContext for the carapace, an AudioWorklet node per segment (audio-worklet.js) ---------
    // Workers have no AudioContext; the segment sends its decoded PCM here over a port of its own. The context starts
    // under Chrome's autoplay policy: it runs once the carapace has had a user activation (its real input, below).
    const audio = { ctx: null, ready: null, stats: null };
    function audioLatency() {
        return audio.ctx ? (audio.ctx.baseLatency || 0) + (audio.ctx.outputLatency || 0) : 0;
    }
    function startAudio(seg, line) {
        if (seg.audioNode || seg.dead) {
            line.close();
            return;
        }
        seg.audioNode = 'pending';
        if (!audio.ctx) {
            audio.ctx = new AudioContext({ latencyHint: 'interactive' });
            audio.ready = audio.ctx.audioWorklet.addModule('/carapace/audio-worklet.js');
            audio.ctx.onstatechange = () => {
                status('audio context', `${audio.ctx.state}, ${audio.ctx.sampleRate} Hz, latency ${(audioLatency() * 1000).toFixed(1)} ms`);
                for (const s of liveSegments())
                    if (s.audioNode && s.audioNode !== 'pending')
                        s.audioNode.port.postMessage({ type: 'latency', seconds: audioLatency() });
            };
            status('audio context', `${audio.ctx.state}, ${audio.ctx.sampleRate} Hz`);
        }
        audio.ready.then(() => {
            if (seg.dead) {
                line.close();
                return;
            }
            const node = new AudioWorkletNode(audio.ctx, 'chitin-audio', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
            node.connect(audio.ctx.destination);
            node.port.onmessage = (e) => {
                const m = e.data;
                if (m && m.type === 'stats') {
                    audio.stats = m;
                    status('audio output', `${m.streams} streams, ${m.chunks} chunks, ${m.framesIn} frames in, ${m.framesOut} out, tone ${m.hz} Hz, peak ${m.peak}, dropped ${m.dropped}`);
                }
            };
            node.port.postMessage({ type: 'line' }, [line]);
            node.port.postMessage({ type: 'latency', seconds: audioLatency() });
            seg.audioNode = node;
        }, (err) => status('audio output', 'FAILED: ' + err.message));
    }
    function stopAudio(seg) {
        const node = seg.audioNode;
        seg.audioNode = null;
        if (node && node !== 'pending') {
            node.port.postMessage({ type: 'stop' });
            node.disconnect();
        }
    }
    // A user activation in the carapace lets its AudioContext run (Chrome's autoplay policy for Web Audio).
    function activateAudio() {
        if (audio.ctx && audio.ctx.state === 'suspended')
            audio.ctx.resume().catch(() => {});
    }

    // --- The compositor (docs/compositor.md) ----------------------------------------------------
    // A layer stack over the view: a stage the size of the frame in device pixels, scaled to the tab. The view canvas
    // stays under it for input (the stage takes no pointer events).
    function startCompositor() {
        const holder = document.createElement('div');
        holder.className = 'layers';
        view.after(holder);
        if (compositorBackend === 'webgl') {
            const canvas = document.createElement('canvas');
            canvas.className = 'gl';
            holder.appendChild(canvas);
            let gl = null;
            try {
                gl = new GLCompositor(canvas);
            } catch (err) {
                status('compositor', 'WebGL2 failed (' + err.message + '), DOM backend');
                canvas.remove();
            }
            if (gl) {
                status('compositor', `WebGL2 backend, engine ${engineCompositor}`);
                let raf = 0;
                let shownAfter = []; // timestamps of carapace scrolls not yet on screen
                // Composites at the host's animation frames, when something changed (independent of engine frames).
                const loop = () => {
                    raf = requestAnimationFrame(loop);
                    if (gl.dirty || shownAfter.length) {
                        gl.composite(syncComposite);
                        traceComposite(gl.tree, gl.externals);
                        for (const [ts, handled] of shownAfter) threadedShown(ts, handled);
                        shownAfter = [];
                    }
                };
                raf = requestAnimationFrame(loop);
                return {
                    gl,
                    tree: gl.tree,
                    scrolled(ts, handled) { gl.dirty = true; shownAfter.push([ts, handled]); },
                    apply(tree, tiles, videos) {
                        gl.apply(tree, tiles, videos);
                        if (videos && videos.length)
                            metric('video frames composited (on the host)', String(gl.stats.videoFrames || 0));
                        metric('compositor layers / tiles', `${tree.layers.length} / ${tree.layers.reduce((n, l) => n + l.tiles.length, 0)}${tree.flat ? ' (flattened: over budget)' : ''}`);
                        if (gl.stats.composites % 60 === 1)
                            metric('composite ms p50 / p95 (WebGL2, CPU side)', `${pct(gl.stats.ms, 50).toFixed(2)} / ${pct(gl.stats.ms, 95).toFixed(2)}`);
                    },
                    child(key, bitmap, rect, moves) { gl.setExternal(key, bitmap, rect, moves); },
                    drawInto: (ctx) => gl.drawInto(ctx),
                    stats: () => ({ compositeMs: gl.stats.ms.slice(), gpuMs: gl.stats.gpuMs.slice(), timer: !!gl.timer }),
                    destroy() {
                        cancelAnimationFrame(raf);
                        gl.destroy();
                        holder.remove();
                    },
                };
            }
        }
        const stage = document.createElement('div');
        stage.className = 'stage';
        holder.appendChild(stage);
        const dom = new DomCompositor(stage);
        status('compositor', `DOM backend, engine ${engineCompositor}`);
        let shownAfter = [];
        let raf = 0;
        const loop = () => {
            raf = requestAnimationFrame(loop);
            if (shownAfter.length) {
                dom.layout();
                traceComposite(dom.tree, null);
                for (const [ts, handled] of shownAfter) threadedShown(ts, handled);
                shownAfter = [];
            }
        };
        raf = requestAnimationFrame(loop);
        return {
            tree: dom.tree,
            scrolled(ts, handled) { shownAfter.push([ts, handled]); },
            apply(tree, tiles, videos) {
                dom.apply(tree, tiles, videos);
                const scale = tab.clientWidth / tree.w;
                stage.style.width = tree.w + 'px';
                stage.style.height = tree.h + 'px';
                stage.style.transform = `scale(${scale})`;
                metric('compositor layers / tiles', `${tree.layers.length} / ${tree.layers.reduce((n, l) => n + l.tiles.length, 0)}${tree.flat ? ' (flattened: over budget)' : ''}`);
            },
            drawInto: (ctx) => dom.drawInto(ctx),
            stats: () => ({ compositeMs: [] }),
            destroy() {
                cancelAnimationFrame(raf);
                dom.destroy();
                holder.remove();
            },
        };
    }

    // --- Starting, replacing and stopping segments ---------------------------------------------
    function teardown(seg) {
        if (!seg)
            return;
        seg.dead = true;
        stopAudio(seg);
        realtimeTeardown(seg);
        clearInterval(seg.watchdogTimer);
        try { seg.port && seg.port.close(); } catch { /* closed */ }
        seg.iframe && seg.iframe.remove();
        window.removeEventListener('message', seg.onWindowMessage);
        for (const child of seg.children.values())
            teardown(child);
        seg.children.clear();
        if (seg.popups) {
            for (const entry of seg.popups.values())
                closePopup(seg, entry, false);
            seg.popups.clear();
        }
        if (seg.popup && seg.popup.entry.segment === seg)
            seg.popup.entry.segment = null;
        if (handoff && (handoff.opener === seg || handoff.tab === seg))
            hideHandoff();
        if (seg.canvasEl)
            seg.canvasEl.remove();
        if (seg.nest) {
            const top = topOf(seg);
            if (top && top.compositor && top.compositor.child)
                top.compositor.child(seg.label + ':' + seg.nest.frameId, null);
        }
        if (seg.compositor)
            seg.compositor.destroy();
        if (seg.nest && seg.nest.parent.children.get(seg.nest.frameId) === seg)
            seg.nest.parent.children.delete(seg.nest.frameId);
        router.delete(seg);
        if (focused === seg)
            focused = null;
        if (current === seg)
            current = null;
    }
    function killSegment(seg, reason) {
        if (seg.dead)
            return;
        teardown(seg);
        status('segment killed', reason);
    }

    // A cross-document navigation: a new iframe, so a new Worker, with no binding of the previous page left.
    async function navigateTo(target, initiator = null) {
        let u;
        try {
            u = new URL(target);
            if (u.protocol !== 'http:' && u.protocol !== 'https:')
                throw new Error('scheme');
        } catch {
            status('address', 'not a navigable URL: ' + String(target).slice(0, 200));
            return;
        }
        clearPageRows();
        status('navigating', u.href);
        await startSegment(u.href, null, initiator);
    }

    // `nest` makes a child segment: { parent, frameId, box } (box in the parent's CSS pixels).
    // `initiator`: the schemeful site of the page that asked for this navigation (null: the user, from the address bar).
    // `popup` makes a popup segment (docs/oauth.md): { opener, entry } — a window the opener's page opened, of the opener's site.
    // Paint holding (docs/scroll.md "FOUC"): on a same-origin navigation of the tab the last frame of the page stays up
    // until the next page presents its first frame (or PAINT_HOLD_MS), as Chrome does; a cross-site one shows blank.
    const PAINT_HOLD_MS = 4000;
    let held = null;
    function holdFrame() {
        dropHold();
        const c = document.createElement('canvas');
        c.className = 'hold';
        c.width = view.width;
        c.height = view.height;
        Object.assign(c.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '2' });
        const ctx = c.getContext('2d');
        ctx.drawImage(view, 0, 0);
        if (current && current.compositor)
            current.compositor.drawInto(ctx);
        tab.appendChild(c);
        held = { el: c, timer: setTimeout(dropHold, PAINT_HOLD_MS) };
    }
    function dropHold() {
        if (!held) return;
        clearTimeout(held.timer);
        held.el.remove();
        held = null;
    }
    async function startSegment(targetUrl, nest = null, initiator = null, popup = null) {
        const mine = nest || popup ? 0 : ++generation;
        if (!nest && !popup) {
            let sameOrigin = false;
            try { sameOrigin = !!current && !current.dead && current.lastFrameAt > 0 && new URL((router.segments.get(current) || current).url).origin === new URL(targetUrl).origin; } catch { sameOrigin = false; }
            if (sameOrigin) holdFrame(); else dropHold();
            teardown(current);
        }
        if (popup && popup.entry.segment)
            teardown(popup.entry.segment);
        const startedFor = popup ? (popup.entry.starts = (popup.entry.starts || 0) + 1) : 0;
        const label = await segmentLabel(siteOf(targetUrl), IDENTITY_SALT);
        await cookiesReady;
        if (popup ? popup.opener.dead || popup.entry.closed || popup.entry.starts !== startedFor
            : nest ? nest.parent.dead || nest.parent.children.get(nest.frameId) !== nest.placeholder : mine !== generation)
            return; // a newer navigation took over while the hash was computed
        const origin = `http://${label}.localhost:${CARAPACE_PORT}`;
        const standIn = new URL(targetUrl).hostname.endsWith('.example');
        const seg = {
            label, origin, url: targetUrl, dead: false, port: null, iframe: null, watchdogTimer: 0,
            inFlight: false, sentAt: 0, seq: 0, lastFrameAt: 0, lastReplyAt: 0, lastReplyKind: 'none', watchdogShown: false, started: 0,
            nest, popup, popups: new Map(), children: new Map(), subframes: [], canvasEl: null, ctx: null,
            width: nest ? Math.max(1, nest.box.width) : popup ? POPUP_SIZE.width : width, height: nest ? Math.max(1, nest.box.height) : popup ? POPUP_SIZE.height : height,
        };
        seg.guard = new SegmentGuard({ url: targetUrl, kill: (reason) => killSegment(seg, reason) });
        // What this segment's jar may hold (cookie-store.mjs): its own site's cookies and its own context's partitions.
        {
            const ownSite = siteOf(targetUrl);
            const parentTop = nest ? ChitinCookies.schemefulSite(router.segments.get(nest.parent) ? router.segments.get(nest.parent).url : nest.parent.url) : null;
            seg.cookieScope = nest
                ? { site: ownSite, partitionKeys: [parentTop + ' 1'] }
                : { site: ownSite, partitionKeys: [`https://${ownSite} 0`, `http://${ownSite} 0`] };
            seg.cookieInit = { site: ownSite, topSite: parentTop, initiator: nest ? null : initiator, records: cookieStore.forSegment(seg.cookieScope) };
        }
        cookieSegments.add(seg);
        router.set(seg, { url: targetUrl, parent: nest ? nest.parent : null, frameId: nest ? nest.frameId : null, opener: popup ? popup.opener : null, popupId: popup ? popup.entry.id : null });
        if (popup) {
            // Not shown (docs/oauth.md): a sign-in return page posts to its opener and closes; its frames are drawn nowhere.
            popup.entry.segment = seg;
            const el = document.createElement('canvas');
            el.width = Math.round(seg.width * dpr);
            el.height = Math.round(seg.height * dpr);
            seg.canvasEl = el;
            seg.ctx = el.getContext('bitmaprenderer');
        } else if (nest) {
            nest.parent.children.set(nest.frameId, seg);
            // The child's frames: a canvas of its own over the parent's view at the box (the tab clips it).
            const el = document.createElement('canvas');
            el.className = 'subframe';
            el.dataset.frame = String(nest.frameId);
            el.width = Math.round(seg.width * dpr);
            el.height = Math.round(seg.height * dpr);
            seg.canvasEl = el;
            seg.ctx = el.getContext('bitmaprenderer');
            placeChild(seg);
            tab.append(el);
        } else {
            current = seg;
            address.value = targetUrl;
        }

        if (mode === 'canvas' && !nest && !popup) {
            // transferControlToOffscreen works once per canvas element.
            const fresh = view.cloneNode(false);
            view.replaceWith(fresh);
            view = fresh;
            bindView(view);
        }
        if (mode === 'bitmap' && !nest && !popup) {
            view.width = Math.round(width * dpr);
            view.height = Math.round(height * dpr);
            bitmapCtx = view.getContext('bitmaprenderer');
            if (compositorBackend !== 'flat')
                seg.compositor = startCompositor();
        }

        const iframe = document.createElement('iframe');
        iframe.src = `${origin}/`;
        iframe.title = 'segment';
        // The site's media may play with sound after the user's input on the view and may use the host's EME (docs/eme.md):
        // the carapace delegates both features to the segment's frame, as a page does to an iframe it trusts with playback.
        // WebRTC capture (docs/webrtc.md): behind the carapace's own per-site decision and the host's prompt; fullscreen, the
        // pointer lock and gamepads stay here.
        iframe.allow = 'autoplay; encrypted-media; camera; microphone; display-capture';
        if (nest || popup)
            iframe.classList.add('hidden');
        else if (frameMode !== 'under' && mode !== 'direct')
            iframe.classList.add(frameMode);
        seg.iframe = iframe;
        tab.prepend(iframe);

        // A nested segment's own rows (its navigating, navigated, page title) are not the page's: a 0x0 ad frame's URL
        // was shown as if the top page had navigated there (fiverr's doubleclick frame). Only what went wrong in it is
        // shown, under the frame's row name.
        const segStatus = popup ? (k, v) => status(`popup ${popup.entry.id} ${k}`, v) : !nest ? status : (k, v) => {
            if (/error|stopped|trap|fail|engine log/i.test(k) || /FAILED|engine stopped/.test(v))
                status(`frame ${nest.frameId} ${k}`, v);
        };
        seg.onWindowMessage = (e) => {
            if (seg.dead || e.origin !== origin || e.source !== iframe.contentWindow)
                return;
            const m = seg.guard.acceptWindow(e.data);
            if (!m)
                return;
            if (m.type === 'segment-status') {
                segStatus(m.key, m.value);
                return;
            }
            if (m.type === 'rtc-permission') {
                askCapture(seg, m.kinds).then((allow) => {
                    if (!seg.dead)
                        iframe.contentWindow.postMessage({ type: 'rtc-permission-answer', ask: m.ask, allow }, origin);
                });
                return;
            }
            if (m.type === 'rtc-video') {
                videoFrame(seg, m);
                return;
            }
            if (m.type === 'segment-video') {
                // A handed-over video shows (eme-host.js): the segment's frame lies over the view, transparent but for the
                // video, and takes no input. A nested segment's frame stays hidden (docs/eme.md, "Not yet").
                if (!nest)
                    iframe.classList.toggle('video-over', m.on);
                return;
            }
            if (seg.port)
                return; // one handshake per segment
            status('segment document crossOriginIsolated', String(m.crossOriginIsolated));
            const channel = new MessageChannel();
            seg.port = channel.port1;
            seg.port.onmessage = (ev) => {
                if (seg.dead)
                    return;
                const c = seg.guard.accept(ev.data);
                if (!c)
                    return;
                if (c.type === 'frame')
                    onFrame(seg, c);
                else if (c.type === 'status')
                    segStatus(c.key, c.value);
                else if (c.type === 'devtools') {
                    if (seg === current)
                        window.dispatchEvent(new CustomEvent('chitin-devtools-reply', { detail: { id: c.id, json: c.json } }));
                }
                else if (c.type === 'cookies') {
                    const r = cookieStore.write(seg.cookieScope, c.list);
                    if (r.refused)
                        seg.guard.strike(`cookies outside its jar (${r.refused})`);
                    forwardCookies(seg, r.changes);
                    cookiesChanged();
                }
                else if (c.type === 'ready')
                    status('ready', new Date().toLocaleTimeString());
                else if (c.type === 'loaded') {
                    // A child's document loaded: its parent fires the iframe's load event (once per document).
                    if (nest && nest.parent && !nest.parent.dead && nest.parent.port && !seg.loadedSent) {
                        seg.loadedSent = true;
                        nest.parent.port.postMessage({ type: 'frame-loaded', id: nest.frameId });
                    }
                }
                else if (c.type === 'video-sinks')
                    videoSinks(seg, c.list);
                else if (c.type === 'fullscreen-request')
                    fullscreenRequest(seg, c.enter);
                else if (c.type === 'pointer-lock-request')
                    pointerLockRequest(seg, c.kind);
                else if (c.type === 'gamepad-effect')
                    gamepadEffect(c);
                else if (c.type === 'audio-port') {
                    if (ev.ports.length === 1)
                        startAudio(seg, ev.ports[0]);
                    else
                        seg.guard.strike('audio-port without one port');
                }
                else if (c.type === 'navigated') {
                    router.navigated(seg, c.url);
                    if (popup) {
                        segStatus('navigated', c.error ? `FAILED ${c.url}: ${c.error}` : `${c.url} (HTTP ${c.status})`);
                        popupStateToOpener(popup.opener, popup.entry, c.url);
                        return;
                    }
                    if (nest) {
                        status(`frame ${nest.frameId} navigated`, c.error ? `FAILED ${c.url}: ${c.error}` : `${c.url} (HTTP ${c.status})`);
                        return;
                    }
                    address.value = c.url;
                    status('navigated', c.error ? `FAILED ${c.url}: ${c.error}` : `${c.url} (HTTP ${c.status})`);
                } else if (c.type === 'navigate-request') {
                    // The segment may only ask. The carapace decides, and does it with a fresh segment; a child's
                    // navigation replaces the child in the same box (the parent's iframe.src stays).
                    const fromUrl = router.segments.get(seg) ? router.segments.get(seg).url : seg.url;
                    if (popup)
                        popupGo(popup.opener, popup.entry, c.url, ChitinCookies.schemefulSite(fromUrl));
                    else if (nest)
                        replaceChild(seg, c.url);
                    else if (detectSignIn(c.url, fromUrl))
                        // A sign-in page of an identity provider (docs/oauth.md): not loaded here; the user continues it in their browser.
                        showHandoff({ kind: 'tab', tab: seg, url: c.url, siteUrl: fromUrl });
                    else
                        navigateTo(c.url, ChitinCookies.schemefulSite(fromUrl));
                } else if (c.type === 'popup-open') {
                    if (nest || popup) {
                        segStatus('window.open', 'not handled in a frame or a popup: ' + c.url.slice(0, 200));
                        return;
                    }
                    openPopup(seg, c.id, c.url, c.noopener);
                } else if (c.type === 'popup-navigate') {
                    const entry = seg.popups.get(c.id);
                    if (entry && !entry.closed)
                        popupGo(seg, entry, c.url, ChitinCookies.schemefulSite(router.segments.get(seg) ? router.segments.get(seg).url : seg.url));
                } else if (c.type === 'popup-close') {
                    const entry = seg.popups.get(c.id);
                    if (entry)
                        closePopup(seg, entry, false);
                } else if (c.type === 'window-close') {
                    // Scripts may close the windows they opened (HTML "script-closable"): a popup segment's own close().
                    if (popup)
                        closePopup(popup.opener, popup.entry, true);
                } else if (c.type === 'wheel-unused') {
                    // Chained to the parent page at the frame's place (its box as the parent last reported it).
                    if (nest && nest.parent && !nest.parent.dead && nest.parent.port)
                        wheelTo(nest.parent, nest.box.x + c.x, nest.box.y + c.y, c.dx, c.dy, typeof c.ts === 'number' ? c.ts : performance.timeOrigin + performance.now());
                } else if (c.type === 'subframes') {
                    if (nest) {
                        status(`frame ${nest.frameId}`, 'has cross-site iframes of its own: not started (nesting is kept at one level, docs/architecture.md "Nested segments")');
                        return;
                    }
                    const list = cleanSubframes(c.list, router.segments.get(seg).url, { width: seg.width, height: seg.height });
                    if (!list) {
                        seg.guard.strike('malformed subframes');
                        return;
                    }
                    syncChildren(seg, list);
                } else if (c.type === 'frame-post') {
                    const r = router.route(seg, c.to, c.targetOrigin);
                    if (!r || !r.toKey.port || r.toKey.dead)
                        return; // dropped, as Chrome drops a post whose targetOrigin does not match
                    try {
                        r.toKey.port.postMessage({ type: 'message', from: r.from, origin: r.origin, data: c.data }, [...ev.ports]);
                    } catch (err) {
                        status('postMessage relay', 'FAILED: ' + err.message);
                    }
                }
            };
            const init = {
                type: 'init', mode: nest || popup ? 'bitmap' : mode, opener: !!popup, classic, site: standIn ? new URL(targetUrl).hostname : site, url: targetUrl, siteHost: siteOf(targetUrl),
                engine, scripting, width: seg.width, height: seg.height, dpr, nested: !!nest, frameRealms, debugContexts, compatHide,
                compositor: seg.compositor ? engineCompositor : 'flat',
                cookies: seg.cookieInit,
                rtc: rtcOn,
            };
            // What the iframe gives the document it shows (Host.cpp ganglion_set_embedder): the referrer by the default policy
            // (strict-origin-when-cross-origin: a child is always cross-site, so the parent's origin, nothing on a downgrade
            // from https), the iframe's name and the parent's origin as the ancestor.
            if (nest && nest.parent) {
                const parentUrl = router.segments.get(nest.parent) ? router.segments.get(nest.parent).url : nest.parent.url;
                let parentOrigin = '';
                try { parentOrigin = new URL(parentUrl).origin; } catch {}
                const downgrade = parentUrl.startsWith('https:') && !targetUrl.startsWith('https:');
                init.embedder = { referrer: parentOrigin && !downgrade ? parentOrigin + '/' : '', name: nest.name || '', ancestors: parentOrigin ? [parentOrigin] : [], coi: nest.coi || null };
            }
            // The segment's line to Spiracle: one port per segment, handed over with the init.
            const netChannel = new MessageChannel();
            spiracle.postMessage({ type: 'segment', name: label }, [netChannel.port1]);
            const transfer = [channel.port2, netChannel.port2];
            if (mode === 'canvas' && !nest) {
                view.width = Math.round(width * dpr);
                view.height = Math.round(height * dpr);
                try {
                    init.canvas = view.transferControlToOffscreen();
                    transfer.push(init.canvas);
                } catch (err) {
                    status('canvas transfer', 'FAILED: ' + err.message);
                }
            }
            try {
                iframe.contentWindow.postMessage(init, origin, transfer);
            } catch (err) {
                status('init postMessage', 'FAILED: ' + err.message);
                return;
            }
            seg.started = seg.lastFrameAt = performance.now();
            if (!nest && !popup)
                requestAnimationFrame(tick);
            seg.watchdogTimer = setInterval(() => watchdog(seg), 500);
        };
        window.addEventListener('message', seg.onWindowMessage);
    }

    // --- Nested segments: children follow their parent's list ---------------------------------------
    function placeChild(seg) {
        const b = seg.nest.box;
        Object.assign(seg.canvasEl.style, { left: `${(b.x / width) * 100}%`, top: `${(b.y / height) * 100}%`, width: `${(b.width / width) * 100}%`, height: `${(b.height / height) * 100}%`, display: b.width > 0 && b.height > 0 ? '' : 'none' });
    }
    function syncChildren(parent, list) {
        parent.subframes = list;
        const ids = new Set(list.map((f) => f.id));
        for (const [id, child] of parent.children)
            if (!ids.has(id))
                teardown(child);
        for (const f of list) {
            const child = parent.children.get(f.id);
            if (child && child.url === f.url && !child.placeholder) {
                const resized = child.nest.box.width !== f.box.width || child.nest.box.height !== f.box.height;
                child.nest.box = f.box;
                child.nest.moves = f.moves || null;
                parent.childRectsDirty = true; // applied with the parent's next frame (B3: atomic with its layers)
                placeChild(child);
                if (resized && f.box.width > 0 && f.box.height > 0 && child.port) {
                    child.width = f.box.width;
                    child.height = f.box.height;
                    child.canvasEl.width = Math.round(child.width * dpr);
                    child.canvasEl.height = Math.round(child.height * dpr);
                    child.port.postMessage({ type: 'resize', width: child.width, height: child.height, dpr });
                }
                continue;
            }
            if (child && child.url === f.url)
                continue; // still starting
            if (child)
                teardown(child);
            startChild(parent, f.id, f.url, f.box, f.name, f.coi);
        }
    }
    function startChild(parent, frameId, url, box, name, coi) {
        // A placeholder holds the id while the label is hashed, so a second list does not start it twice.
        const placeholder = { placeholder: true, url, dead: false, children: new Map(), nest: { parent, frameId, box, name: name || '', coi: coi || null } };
        placeholder.nest.placeholder = placeholder;
        parent.children.set(frameId, placeholder);
        status(`frame ${frameId}`, `${url} (nested segment, ${box.width}x${box.height} at ${box.x},${box.y})`);
        startSegment(url, placeholder.nest);
    }
    function replaceChild(child, url) {
        const { parent, frameId, box, name, coi } = child.nest;
        teardown(child);
        if (!parent.dead)
            startChild(parent, frameId, url, box, name, coi);
    }

    // --- Windows a page opens, and sign-in in the user's real browser (docs/oauth.md) -----------------------------
    // A page's window.open (glue/engine/52-popups.js) is an entry of its segment's `popups`. A page of the opener's own site
    // runs in a hidden popup segment of that site, whose window.opener is the opener; anything else (an identity provider's
    // sign-in page above all) is handed to the user's real browser by a click of theirs here (RFC 8252: embedded user agents
    // do not host the provider's login). The provider then sends the user's real browser to the site's return address; the
    // user pastes that address here and it opens in Chitin (in the popup segment, or in the tab), where the site's own page
    // finishes the flow with this segment's cookies and storage. Chitin never sees what is typed at the provider and keeps
    // nothing: the pasted address is used once.
    const POPUP_SIZE = { width: 500, height: 600 };
    const MAX_POPUPS = 4;
    function openPopup(opener, id, url, noopener) {
        if (opener.popups.has(id))
            return;
        const entry = { id, url: '', closed: false, segment: null, starts: 0, noopener };
        opener.popups.set(id, entry);
        if ([...opener.popups.values()].filter((e) => !e.closed).length > MAX_POPUPS) {
            status('window.open', `more than ${MAX_POPUPS} windows open: not opened`);
            closePopup(opener, entry, true);
            return;
        }
        status('window.open', url || 'about:blank (navigated later)');
        if (url)
            popupGo(opener, entry, url, ChitinCookies.schemefulSite(segUrl(opener)));
    }
    function segUrl(seg) {
        return router.segments.get(seg) ? router.segments.get(seg).url : seg.url;
    }
    function popupGo(opener, entry, url, initiator) {
        if (opener.dead || entry.closed)
            return;
        const openerUrl = segUrl(opener);
        if (siteOf(url) === siteOf(openerUrl) && !detectSignIn(url, openerUrl))
            startSegment(url, null, initiator, { opener, entry });
        else {
            if (entry.segment)
                teardown(entry.segment); // the window left the site: what it shows now is in the user's browser
            showHandoff({ kind: 'popup', opener, entry, url, siteUrl: openerUrl });
        }
    }
    function popupStateToOpener(opener, entry, url) {
        entry.url = url;
        if (!opener.dead && opener.port)
            opener.port.postMessage({ type: 'popup-state', id: entry.id, url });
    }
    // `tell`: the opener's page did not close it itself (the popup's own close(), the user's Cancel), so its stand-in learns.
    function closePopup(opener, entry, tell) {
        if (entry.closed)
            return;
        entry.closed = true;
        if (entry.segment)
            teardown(entry.segment);
        if (handoff && handoff.entry === entry)
            hideHandoff();
        if (tell && !opener.dead && opener.port)
            opener.port.postMessage({ type: 'popup-state', id: entry.id, closed: true });
        status('window.open', `window ${entry.id} closed`);
    }

    const handoffEl = document.createElement('section');
    handoffEl.id = 'handoff';
    handoffEl.hidden = true;
    handoffEl.setAttribute('role', 'dialog');
    handoffEl.setAttribute('aria-labelledby', 'handoff-title');
    handoffEl.innerHTML = `
      <h2 id="handoff-title"></h2>
      <p id="handoff-why"></p>
      <p id="handoff-url"></p>
      <div class="row" id="handoff-step1">
        <button id="handoff-continue" class="primary"></button>
        <button id="handoff-cancel">Cancel</button>
      </div>
      <div id="handoff-step2" hidden>
        <p id="handoff-paste-help"></p>
        <form id="handoff-form" class="row">
          <input id="handoff-return" aria-label="address after signing in" placeholder="https://…" spellcheck="false" autocomplete="off">
          <button id="handoff-back" class="primary" type="submit"></button>
        </form>
        <p id="handoff-error" role="alert"></p>
        <div class="row"><button id="handoff-again" type="button">Open it again</button><button id="handoff-cancel2" type="button">Cancel</button></div>
      </div>`;
    tab.before(handoffEl);
    const $h = (id) => handoffEl.querySelector('#' + id);
    function hostOf(url) {
        try { return new URL(url).host; } catch { return url; }
    }
    function showHandoff(h) {
        if (handoff && handoff.kind === 'popup' && handoff.entry !== h.entry)
            closePopup(handoff.opener, handoff.entry, true); // one handoff at a time: the older window counts as closed
        const signIn = detectSignIn(h.url, h.siteUrl);
        handoff = { ...h, signIn, redirectUri: signIn ? signIn.redirectUri : null, opened: false };
        const siteHost = hostOf(h.siteUrl);
        $h('handoff-title').textContent = signIn ? `Continue sign-in in your browser` : `Open this window in your browser`;
        $h('handoff-why').textContent = signIn
            ? `${siteHost} wants you to sign in with ${signIn.provider}. Chitin does not show identity providers' sign-in pages inside it: you sign in in your own browser, where your passwords, passkeys and sessions are, and Chitin never sees what you type there.`
            : `${siteHost} opened a window on ${hostOf(h.url)}, another site. Chitin shows only the site's own windows; this one opens in your own browser.`;
        $h('handoff-url').textContent = h.url.length > 300 ? h.url.slice(0, 300) + '…' : h.url;
        $h('handoff-continue').textContent = signIn ? `Continue sign-in in your browser` : `Open in your browser`;
        const back = handoff.redirectUri ? new URL(handoff.redirectUri) : null;
        $h('handoff-paste-help').textContent = back
            ? `When you have signed in, your browser shows a page on ${back.host} (${back.origin}${back.pathname}). Copy that page's whole address from your browser's address bar and paste it here to finish signing in to ${siteHost} in Chitin.`
            : `If the window ends on a page of ${siteHost}, copy that page's whole address from your browser's address bar and paste it here to finish in Chitin.`;
        $h('handoff-back').textContent = `Return to ${siteHost}`;
        $h('handoff-step1').hidden = false;
        $h('handoff-step2').hidden = true;
        $h('handoff-error').textContent = '';
        $h('handoff-return').value = '';
        handoffEl.hidden = false;
        status('sign-in handoff', `${signIn ? 'sign-in with ' + signIn.provider : 'window on ' + hostOf(h.url)} (${h.kind}): waiting for the user`);
    }
    function hideHandoff() {
        handoff = null;
        handoffEl.hidden = true;
        $h('handoff-return').value = '';
    }
    function openInRealBrowser(url) {
        // A real top-level window of the host browser, on the user's click. noopener: the page there gets no handle on Chitin.
        window.open(url, '_blank', 'noopener,noreferrer,popup,width=520,height=700');
    }
    $h('handoff-continue').addEventListener('click', () => {
        if (!handoff)
            return;
        openInRealBrowser(handoff.url);
        handoff.opened = true;
        $h('handoff-step1').hidden = true;
        $h('handoff-step2').hidden = false;
        status('sign-in handoff', `opened in the browser: ${hostOf(handoff.url)}`);
        $h('handoff-return').focus();
    });
    $h('handoff-again').addEventListener('click', () => { if (handoff) openInRealBrowser(handoff.url); });
    const cancelHandoff = () => {
        if (!handoff)
            return;
        const h = handoff;
        hideHandoff();
        if (h.kind === 'popup')
            closePopup(h.opener, h.entry, true); // as if the user closed the window: the page's polling of `closed` sees it
        status('sign-in handoff', 'cancelled');
    };
    $h('handoff-cancel').addEventListener('click', cancelHandoff);
    $h('handoff-cancel2').addEventListener('click', cancelHandoff);
    $h('handoff-form').addEventListener('submit', (e) => {
        e.preventDefault();
        if (!handoff)
            return;
        const h = handoff;
        const r = checkReturnUrl($h('handoff-return').value, { siteUrl: h.siteUrl, redirectUri: h.redirectUri });
        if (r.error) {
            $h('handoff-error').textContent = r.error;
            return;
        }
        // The provider's page sent the browser here: that is the navigation's initiator (SameSite=Lax cookies go, Strict do not).
        const initiator = ChitinCookies.schemefulSite(h.url);
        hideHandoff();
        status('sign-in handoff', `returning to ${hostOf(r.url)}`);
        if (h.kind === 'popup') {
            if (!h.opener.dead && !h.entry.closed)
                startSegment(r.url, null, initiator, { opener: h.opener, entry: h.entry });
        } else if (current === h.tab && !h.tab.dead) {
            navigateTo(r.url, initiator);
        }
    });
    // Anything Chitin cannot do: the displayed page in the user's own browser.
    document.getElementById('real-browser').addEventListener('click', () => {
        if (current)
            openInRealBrowser(segUrl(current));
    });

    // --- Frame pacing: one frame in flight per segment, ticked by our requestAnimationFrame. ---------------
    function tick() {
        if (!current || current.dead)
            return;
        requestAnimationFrame(tick);
        // devicePixelRatio changes (browser zoom, a move to another display) do not always come with an event: checked per
        // frame, and the segment's viewport gets the new ratio as a resized window would (same CSS size, no resize event).
        if ((window.devicePixelRatio || 1) !== dpr) {
            dpr = window.devicePixelRatio || 1;
            if (fullscreenSeg)
                resizeTop(width, height);
            else
                resizeTop(normalSize.width, normalSize.height);
        }
        for (const seg of liveSegments()) {
            if (seg.placeholder || !seg.port || seg.inFlight)
                continue;
            seg.inFlight = true;
            seg.sentAt = performance.now();
            seg.guard.ticked(++seg.seq);
            seg.port.postMessage({ type: 'frame', seq: seg.seq, ts: seg.sentAt });
        }
    }
    function onFrame(seg, m) {
        const t = performance.now();
        seg.inFlight = false;
        seg.lastReplyAt = t;
        if (m.notReady) {
            seg.lastReplyKind = 'not ready (engine still loading)';
            return;
        }
        if (m.error) {
            seg.lastReplyKind = 'error';
            status('frame error', m.error);
            return;
        }
        seg.lastReplyKind = 'frame';
        seg.lastFrameAt = t;
        if (seg.popup) {
            if (m.bitmap && seg.ctx)
                seg.ctx.transferFromImageBitmap(m.bitmap);
            return;
        }
        if (seg.nest) {
            // In the WebGL2 compositor a child segment is a layer of its top segment's canvas; else its own canvas.
            const top = topOf(seg);
            if (trace && trace.length <= 20000) trace.push({ k: 'child', t, rect: childRect(seg) });
            if (m.bitmap && top && top.compositor && top.compositor.child) {
                if (seg.canvasEl) seg.canvasEl.style.visibility = 'hidden';
                // The box moves with the parent's frames (above); a child frame between the parent's report and its frame
                // keeps the box the parent's layers were drawn with.
                const parent = seg.nest.parent;
                top.compositor.child(seg.label + ':' + seg.nest.frameId, m.bitmap, parent && parent.childRectsDirty ? undefined : childRect(seg), childMoves(seg));
            } else if (m.bitmap && seg.ctx)
                seg.ctx.transferFromImageBitmap(m.bitmap);
            return;
        }
        if (seg.watchdogShown) {
            seg.watchdogShown = false;
            status('frames', 'ok: frames are arriving');
        }
        stats.received++;
        stats.roundTrips.push(t - seg.sentAt);
        stats.paintTimes.push(m.paintMs);
        if (stats.roundTrips.length > 600) {
            stats.roundTrips.shift();
            stats.paintTimes.shift();
        }
        if (m.bitmap && bitmapCtx)
            bitmapCtx.transferFromImageBitmap(m.bitmap); // zero-copy hand-over to our canvas
        if (m.layers && seg.compositor)
            seg.compositor.apply(m.layers, m.tiles, m.videos);
        // The new page presented its first frame: the held one goes (after the composite that shows it).
        if (held && (m.bitmap || m.layers) && seg === current)
            requestAnimationFrame(() => requestAnimationFrame(dropHold));
        // The children's boxes as this frame laid them out, in the same composite as its layers (docs/scroll.md B3).
        if (seg.childRectsDirty && seg.compositor && seg.compositor.child) {
            seg.childRectsDirty = false;
            for (const child of seg.children.values())
                if (!child.placeholder && child.nest)
                    seg.compositor.child(child.label + ':' + child.nest.frameId, undefined, childRect(child), childMoves(child));
        }
        if (trace && m.layers && trace.length <= 20000)
            trace.push({ k: 'f', t, seq: m.seq, paint: m.paintMs, rt: t - seg.sentAt, raster: m.raster || null, dirty: m.tiles.length, media: m.layers.media || null, ds: m.layers.ds || null,
                nodes: m.layers.scroll.nodes.map((n) => [n[0], n[10], n[11], n[15], n[14]]),
                layers: m.layers.layers.map((l) => [l.id, l.kind, l.node, l.m[4], l.m[5], l.clip, l.tiles.length, l.chain || null, m.layers.dirty.filter((d) => d[0] === l.id).length, l.ms, l.why || 0, l.dmg || null]) });
        if (m.inputSeq)
            inputsShown(seg, m.inputSeq);
        if (t - stats.lastReport >= 1000) {
            const fps = ((stats.received - stats.receivedAtReport) * 1000) / (t - stats.lastReport);
            stats.frameTimes.push(fps);
            stats.lastReport = t;
            stats.receivedAtReport = stats.received;
            metric('frames per second (last second)', fps.toFixed(1));
            metric('frames per second (median of seconds)', pct(stats.frameTimes, 50).toFixed(1));
            metric('tick → frame round trip p50 / p95', `${pct(stats.roundTrips, 50).toFixed(2)} / ${pct(stats.roundTrips, 95).toFixed(2)} ms`);
            metric('segment paint p50 / p95', `${pct(stats.paintTimes, 50).toFixed(2)} / ${pct(stats.paintTimes, 95).toFixed(2)} ms`);
            if (stats.inputLatencies.length)
                metric('input → frame shown p50 / p95', `${pct(stats.inputLatencies, 50).toFixed(1)} / ${pct(stats.inputLatencies, 95).toFixed(1)} ms (${stats.inputLatencies.length} events)`);
            metric('frames received', String(stats.received));
        }
    }

    function topOf(seg) {
        let s = seg;
        while (s && s.nest) s = s.nest.parent;
        return s;
    }
    // What a child moves with under threaded scroll, in device pixels (docs/scroll.md B3).
    function childMoves(seg) {
        const mv = seg.nest && seg.nest.moves;
        return mv ? { fixed: mv.fixed, scrollers: mv.scrollers.map((r) => r.map((v) => v * dpr)) } : null;
    }
    // A nested segment's box in device pixels of the top segment (boxes nest in their parents' coordinates).
    function childRect(seg) {
        let x = 0, y = 0;
        for (let s = seg; s && s.nest; s = s.nest.parent) { x += s.nest.box.x; y += s.nest.box.y; }
        return [x * dpr, y * dpr, seg.nest.box.width * dpr, seg.nest.box.height * dpr];
    }

    // A wheel for `seg` at (x, y) by (dx, dy), its CSS px. Threaded scroll (docs/compositor.md): the carapace moves the
    // scroll layer under the wheel at once and tells the engine, unless Chrome's rules keep the wheel on the main thread
    // (see LayerTree.wheelTarget). A wheel a frame's document cannot use comes back as 'wheel-unused' and is given to
    // the parent page at the same place (scroll chaining across frames, docs/scroll.md C1).
    function wheelTo(seg, x, y, dx, dy, ts) {
        if (threadedScroll && seg.compositor && seg.compositor.tree && !seg.nest) {
            const tree = seg.compositor.tree;
            const hit = tree.wheelTarget(x * dpr, y * dpr, dx * dpr, dy * dpr);
            if (hit) {
                const seq = ++scrollSeq;
                tree.scrollBy(hit.node, hit.dx, hit.dy, seq);
                if (trace && trace.length <= 20000) trace.push({ k: 'w', t: performance.now(), node: hit.node, dy: hit.dy });
                seg.compositor.scrolled(ts, performance.now());
                seg.port.postMessage({ type: 'input', kind: 'scroll-sync', seq, node: hit.node, x, y, dx: hit.dx / dpr, dy: hit.dy / dpr, ts });
                return;
            }
        }
        if (trace && trace.length <= 20000)
            trace.push({ k: 'w', t: performance.now(), main: seg.nest ? 'over a cross-site frame' : seg.compositor && seg.compositor.tree ? seg.compositor.tree.whyNot || 'off' : 'no compositor' });
        sendInput(seg, { type: 'input', kind: 'wheel', x, y, dx, dy, ts });
    }

    // --- Input: carapace coordinates -> page CSS pixels ------------------------------------
    const kinds = { pointerdown: 0, pointerup: 1, pointermove: 2, click: 3 };
    // A point in the tab goes to the child whose box holds it (in the child's coordinates), else to the page.
    function target(x, y) {
        const seg = current;
        if (!seg || !seg.port)
            return null;
        const hit = hitTest(seg.subframes, x, y);
        const child = hit && seg.children.get(hit.id);
        if (child && !child.placeholder && child.port && !child.dead)
            return { seg: child, x: hit.x, y: hit.y };
        return { seg, x, y };
    }
    function sendPointer(e) {
        // Under the pointer lock every event goes to the segment that holds it, at the point where the lock began, with the
        // host's movement summed as the screen position (the engine's movementX/Y; docs/webrtc.md).
        if (lock && lock.held && !lock.seg.dead && lock.seg.port) {
            if (e.type === 'click')
                return;
            lock.sx += e.movementX || 0;
            lock.sy += e.movementY || 0;
            if (e.type === 'pointerdown')
                activateAudio();
            sendInput(lock.seg, { type: 'input', kind: kinds[e.type], x: lock.x, y: lock.y, sx: lock.sx, sy: lock.sy, button: e.button, buttons: e.buttons, ts: performance.timeOrigin + e.timeStamp,
                pointerType: e.pointerType, pointerId: e.pointerId, width: e.width, height: e.height, pressure: e.pressure, isPrimary: e.isPrimary });
            return;
        }
        const r = view.getBoundingClientRect();
        const t = target(((e.clientX - r.left) * width) / r.width, ((e.clientY - r.top) * height) / r.height);
        if (!t)
            return;
        if (e.type === 'pointerdown') {
            focused = t.seg;
            activateAudio();
        }
        t.seg.lastPointer = { x: t.x, y: t.y };
        // The pointer it came from (Pointer Events): a touch or a pen keeps its type, id, contact size and pressure.
        sendInput(t.seg, { type: 'input', kind: kinds[e.type], x: t.x, y: t.y, button: e.button, buttons: e.buttons, ts: performance.timeOrigin + e.timeStamp,
            pointerType: e.pointerType, pointerId: e.pointerId, width: e.width, height: e.height, pressure: e.pressure, isPrimary: e.isPrimary });
    }
    function bindView(el) {
        for (const type of Object.keys(kinds))
            el.addEventListener(type, sendPointer);
        el.addEventListener('pointerdown', () => el.focus());
        el.addEventListener('wheel', (e) => {
            const r = el.getBoundingClientRect();
            const t = target(((e.clientX - r.left) * width) / r.width, ((e.clientY - r.top) * height) / r.height);
            if (!t)
                return;
            e.preventDefault();
            const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? height : 1;
            wheelTo(t.seg, t.x, t.y, e.deltaX * scale, e.deltaY * scale, performance.timeOrigin + e.timeStamp);
        }, { passive: false });
        // Keys go down and up with the key's name and the modifiers: Enter, Backspace, Tab, the arrows, keyup handlers
        // (Vue's @keyup.enter) and Shift/Ctrl/Alt/Meta combinations need more than the character.
        const sendKey = (e, down) => {
            const seg = focused && !focused.dead && focused.port ? focused : current;
            if (!seg || !seg.port)
                return;
            e.preventDefault();
            if (down)
                activateAudio();
            sendInput(seg, { type: 'input', kind: 'key', down, key: e.key, mods: (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.shiftKey ? 4 : 0) | (e.metaKey ? 8 : 0), repeat: e.repeat, ts: performance.timeOrigin + e.timeStamp });
        };
        el.addEventListener('keydown', (e) => sendKey(e, true));
        el.addEventListener('keyup', (e) => sendKey(e, false));
    }
    bindView(view);

    // --- Real-time features (docs/webrtc.md): capture decisions, the video layer, fullscreen, the pointer lock, gamepads ---
    // ?rtc=off: no WebRTC or capture in segments (what the Tor network mode will set). ?rtc.allow=1|0 answers capture asks
    // without the bar (tests).
    const rtcOn = params.get('rtc') !== 'off';
    const rtcAnswer = params.get('rtc.allow');
    const captureGrants = new Map(); // site -> Set of kinds allowed for this session
    const KIND_TEXT = { camera: 'your camera', microphone: 'your microphone', display: 'your screen' };
    function askCapture(seg, kinds) {
        const site = siteOf(router.segments.get(seg) ? router.segments.get(seg).url : seg.url);
        const granted = captureGrants.get(site);
        if (rtcAnswer === '1' || (granted && kinds.every((k) => granted.has(k))))
            return Promise.resolve(true);
        if (rtcAnswer === '0')
            return Promise.resolve(false);
        // The carapace's own bar: the host's prompt names the carapace's origin, which every site shares, so the site is asked
        // for here first. Allow covers this session; Block answers this ask.
        return new Promise((resolve) => {
            const bar = document.createElement('div');
            bar.className = 'rtcprompt';
            bar.setAttribute('role', 'dialog');
            const text = document.createElement('span');
            text.textContent = `${site} wants to use ${kinds.map((k) => KIND_TEXT[k]).join(' and ')}.`;
            const allow = document.createElement('button');
            allow.textContent = 'Allow';
            const block = document.createElement('button');
            block.textContent = 'Block';
            const done = (ok) => {
                bar.remove();
                if (ok) {
                    const set = captureGrants.get(site) || new Set();
                    for (const k of kinds)
                        if (k !== 'display') // a screen is chosen each time, as in Chrome
                            set.add(k);
                    captureGrants.set(site, set);
                }
                resolve(ok);
            };
            allow.onclick = () => done(true);
            block.onclick = () => done(false);
            bar.append(text, allow, block);
            tab.append(bar);
            if (seg.dead)
                done(false);
        });
    }

    // The video layer: a canvas per element that shows a stream, over the segment's view at the element's box (the tab clips
    // it); the frames come from the segment document (the host's tracks), the boxes from the Worker (the engine's layout).
    function segOffset(seg) {
        let x = 0, y = 0;
        for (let s = seg; s && s.nest; s = s.nest.parent) { x += s.nest.box.x; y += s.nest.box.y; }
        return [x, y];
    }
    function videoSinks(seg, list) {
        const sinks = seg.videoSinks || (seg.videoSinks = new Map());
        const seen = new Set();
        const [ox, oy] = segOffset(seg);
        for (const b of list) {
            seen.add(b.sink);
            let v = sinks.get(b.sink);
            if (!v) {
                const el = document.createElement('canvas');
                el.className = 'rtcvideo';
                v = { el, ctx: el.getContext('2d'), bitmap: null, box: b };
                sinks.set(b.sink, v);
                tab.append(el);
            }
            v.box = b;
            v.el.width = Math.max(1, Math.round(b.width * dpr));
            v.el.height = Math.max(1, Math.round(b.height * dpr));
            Object.assign(v.el.style, { left: `${((ox + b.x) / width) * 100}%`, top: `${((oy + b.y) / height) * 100}%`, width: `${(b.width / width) * 100}%`, height: `${(b.height / height) * 100}%` });
            if (v.bitmap)
                drawVideo(v);
        }
        for (const [id, v] of sinks)
            if (!seen.has(id)) {
                v.el.remove();
                if (v.bitmap)
                    v.bitmap.close();
                sinks.delete(id);
            }
    }
    function drawVideo(v) {
        const { el, ctx, bitmap, box } = v;
        const cw = el.width, ch = el.height, w = bitmap.width, h = bitmap.height;
        ctx.clearRect(0, 0, cw, ch);
        if (!w || !h)
            return;
        let dw = cw, dh = ch;
        if (box.fit === 'contain' || box.fit === 'scale-down' || box.fit === 'cover') {
            const k = box.fit === 'cover' ? Math.max(cw / w, ch / h) : Math.min(cw / w, ch / h);
            dw = w * (box.fit === 'scale-down' ? Math.min(k, dpr) : k);
            dh = h * (box.fit === 'scale-down' ? Math.min(k, dpr) : k);
        } else if (box.fit === 'none') {
            dw = w;
            dh = h;
        }
        ctx.drawImage(bitmap, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
    }
    function videoFrame(seg, m) {
        const v = seg.videoSinks && seg.videoSinks.get(m.sink);
        if (!v) {
            m.bitmap.close();
            return;
        }
        if (v.bitmap)
            v.bitmap.close();
        v.bitmap = m.bitmap;
        drawVideo(v);
        v.frames = (v.frames || 0) + 1;
    }

    // Fullscreen: the page's request (the engine checked its own activation) becomes the tab's fullscreen, with the carapace's
    // activation from the same click; the segment's viewport becomes the screen, as the page's window does in Chrome.
    let fullscreenSeg = null;
    const normalSize = { width, height };
    function resizeTop(w, h) {
        width = w;
        height = h;
        const seg = current;
        if (mode === 'bitmap' && seg && !seg.compositor) {
            view.width = Math.round(w * dpr);
            view.height = Math.round(h * dpr);
        }
        if (seg && seg.port) {
            seg.width = w;
            seg.height = h;
            seg.port.postMessage({ type: 'resize', width: w, height: h, dpr });
        }
        for (const s of liveSegments())
            if (s.nest && s.canvasEl)
                placeChild(s);
    }
    function fullscreenRequest(seg, enter) {
        const top = topOf(seg);
        if (!enter) {
            if (document.fullscreenElement === tab)
                document.exitFullscreen().catch(() => {});
            else
                seg.port.postMessage({ type: 'fullscreen', on: false });
            return;
        }
        if (seg !== current || top !== current) {
            seg.port.postMessage({ type: 'fullscreen', on: false }); // a cross-site frame has no allowfullscreen from us
            return;
        }
        if (document.fullscreenElement === tab) {
            seg.port.postMessage({ type: 'fullscreen', on: true });
            return;
        }
        tab.requestFullscreen({ navigationUI: 'hide' }).then(() => {
            fullscreenSeg = seg;
            resizeTop(tab.clientWidth, tab.clientHeight);
            seg.port.postMessage({ type: 'fullscreen', on: true });
        }, (err) => {
            status('fullscreen', 'refused by the host: ' + err.message);
            seg.port.postMessage({ type: 'fullscreen', on: false });
        });
    }
    document.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement === tab || !fullscreenSeg)
            return;
        const seg = fullscreenSeg;
        fullscreenSeg = null;
        resizeTop(normalSize.width, normalSize.height);
        if (!seg.dead && seg.port)
            seg.port.postMessage({ type: 'fullscreen', on: false });
    });
    // Reset site (devtools panel): everything Chitin keeps for the shown site goes, as a first visit: the segment stops, the
    // carapace's cookie jar for the site is cleared, and the segment origin is wiped by Chrome (/chitin/reset answers with
    // Clear-Site-Data: the engine's IndexedDB and OPFS, localStorage, Cache Storage, Chitin's and the page's service
    // workers). Then the page loads again.
    window.addEventListener('chitin-reset-site', async () => {
        const seg = current;
        if (!seg)
            return;
        const url = seg.guard.displayedUrl || seg.url;
        const site = siteOf(url);
        const origin = seg.origin;
        teardown(seg);
        current = null;
        clearSiteCookies(site);
        const wipe = document.createElement('iframe');
        wipe.hidden = true;
        wipe.src = origin + '/chitin/reset';
        const done = new Promise((r) => { wipe.onload = r; setTimeout(r, 5000); });
        document.body.append(wipe);
        await done;
        wipe.remove();
        status('site reset', `${site}: cookies, storage, IndexedDB, OPFS, caches and service workers cleared`);
        navigateTo(url);
    });
    // The devtools panel (devtools.js) asks the shown segment: its network entries, or an expression in the page's realm.
    window.addEventListener('chitin-devtools', (e) => {
        const d = e.detail || {};
        if (current && current.port && !current.dead && (d.op === 'net' || d.op === 'eval' || d.op === 'source'))
            current.port.postMessage({ type: 'devtools', id: d.id | 0, op: d.op, code: typeof d.code === 'string' ? d.code : '' });
    });
    // The size menu or a fitted window resized the tab (layout.js): the segment's viewport follows, as a resized window's.
    window.addEventListener('chitin-tab-resize', () => {
        normalSize.width = tab.clientWidth;
        normalSize.height = tab.clientHeight;
        if (!fullscreenSeg)
            resizeTop(normalSize.width, normalSize.height);
    });

    // The pointer lock: the host's, on the view, for the segment that asked (its engine checked the page's activation; the host
    // checks the carapace's, which the same click gave).
    let lock = null; // { seg, held, x, y, sx, sy, exiting }
    function pointerLockRequest(seg, kind) {
        if (kind === 0) {
            if (lock && lock.seg === seg) {
                lock.exiting = true;
                if (document.pointerLockElement === view)
                    document.exitPointerLock();
                else
                    lock = null;
            }
            return;
        }
        const at = seg.lastPointer || { x: 0, y: 0 };
        const mine = { seg, held: false, x: at.x, y: at.y, sx: at.x, sy: at.y, exiting: false };
        const answer = (error) => { if (!seg.dead && seg.port) seg.port.postMessage({ type: 'pointer-lock', error }); };
        const wasHeld = lock && lock.held && document.pointerLockElement === view;
        lock = mine;
        if (wasHeld && kind !== 2) {
            mine.held = true;
            answer(0);
            return;
        }
        let p;
        try {
            p = view.requestPointerLock(kind === 2 ? { unadjustedMovement: true } : undefined);
        } catch (err) {
            lock = null;
            answer(err && err.name === 'NotSupportedError' ? 2 : 1);
            return;
        }
        const ok = () => { if (lock === mine) { mine.held = true; answer(0); } };
        const fail = (err) => { if (lock === mine) lock = null; answer(err && err.name === 'NotSupportedError' ? 2 : 1); };
        if (p && typeof p.then === 'function')
            p.then(ok, fail);
        else {
            const onChange = () => { cleanup(); document.pointerLockElement === view ? ok() : fail(); };
            const onError = () => { cleanup(); fail(); };
            const cleanup = () => { document.removeEventListener('pointerlockchange', onChange); document.removeEventListener('pointerlockerror', onError); };
            document.addEventListener('pointerlockchange', onChange);
            document.addEventListener('pointerlockerror', onError);
        }
    }
    document.addEventListener('pointerlockchange', () => {
        if (document.pointerLockElement === view || !lock || !lock.held)
            return;
        const ended = lock;
        lock = null;
        // Esc or focus lost: the host ended it; a page's own exitPointerLock is already done in its engine.
        if (!ended.exiting && !ended.seg.dead && ended.seg.port)
            ended.seg.port.postMessage({ type: 'pointer-lock', ended: true });
    });

    // Gamepads: the host's, polled each display frame while the carapace has focus (Chrome's own gamepad user gesture applies
    // to us: none appear before a button is pressed), sent to the displayed page and its frames when they change.
    let lastPads = '';
    function pollGamepads() {
        requestAnimationFrame(pollGamepads);
        if (!current || !current.port || !navigator.getGamepads || !document.hasFocus())
            return;
        const pads = [];
        for (const p of navigator.getGamepads())
            if (p && p.connected)
                pads.push({ index: p.index, id: p.id, mapping: p.mapping, axes: Array.from(p.axes), buttons: Array.from(p.buttons, (b) => b.value) });
        const key = JSON.stringify(pads);
        if (key === lastPads)
            return;
        lastPads = key;
        for (const s of liveSegments())
            if (topOf(s) === current && s.port)
                s.port.postMessage({ type: 'gamepads', pads });
    }
    requestAnimationFrame(pollGamepads);
    function gamepadEffect(c) {
        const pad = navigator.getGamepads ? navigator.getGamepads()[c.index] : null;
        const act = pad && pad.vibrationActuator;
        if (!act)
            return;
        if (c.kind === 2)
            act.reset().catch(() => {});
        else
            act.playEffect(c.kind === 0 ? 'dual-rumble' : 'trigger-rumble', c.kind === 0 ? { duration: c.duration, strongMagnitude: c.strong, weakMagnitude: c.weak } : { duration: c.duration, leftTrigger: c.strong, rightTrigger: c.weak }).catch(() => {});
    }
    function realtimeTeardown(seg) {
        if (seg.videoSinks) {
            for (const v of seg.videoSinks.values()) {
                v.el.remove();
                if (v.bitmap)
                    v.bitmap.close();
            }
            seg.videoSinks.clear();
        }
        if (lock && lock.seg === seg) {
            lock.exiting = true;
            if (document.pointerLockElement === view)
                document.exitPointerLock();
            lock = null;
        }
        if (fullscreenSeg === seg && document.fullscreenElement === tab)
            document.exitFullscreen().catch(() => {});
    }
    window.__chitinRealtime = { videoSinks: (seg) => (seg || current) && (seg || current).videoSinks ? [...(seg || current).videoSinks.entries()].map(([id, v]) => ({ id, frames: v.frames || 0, box: v.box, width: v.bitmap ? v.bitmap.width : 0, height: v.bitmap ? v.bitmap.height : 0 })) : [] };

    // An explicit error line when no frame arrives within 2 s, instead of a silent white page.
    function watchdog(seg) {
        if (seg.dead || seg.nest)
            return;
        const t = performance.now();
        const since = (t - seg.lastFrameAt) / 1000;
        if (t - seg.lastFrameAt < 2000)
            return;
        const replying = seg.lastReplyAt > 0 && t - seg.lastReplyAt < 2000;
        const why = !seg.lastReplyAt
            ? `the segment has not answered any frame tick (tick ${seg.seq} in flight since ${((t - seg.sentAt) / 1000).toFixed(1)} s)`
            : replying
              ? `the segment answers ticks, last reply: ${seg.lastReplyKind}`
              : `no reply to tick ${seg.seq} for ${((t - seg.sentAt) / 1000).toFixed(1)} s; last reply: ${seg.lastReplyKind}`;
        status('frames', `ERROR: no frame for ${since.toFixed(1)} s${seg.lastFrameAt === seg.started ? ' (none yet)' : ''}: ${why}`);
        seg.watchdogShown = true;
        // A lost reply must not stall the loop for good: retry with a new tick.
        if (seg.inFlight && t - seg.sentAt > 2000)
            seg.inFlight = false;
    }

    document.getElementById('copy').addEventListener('click', async () => {
        const text = JSON.stringify(results, null, 2);
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            prompt('copy these results', text);
        }
    });

    // Test hook (harness only): lets the page of tests/chrome drive and read the carapace.
    window.chitinCarapace = {
        get current() { return current && { label: current.label, origin: current.origin, url: current.url, dead: current.dead, strikes: current.guard.strikes, log: current.guard.log.slice(), displayed: current.guard.displayedUrl }; },
        get children() { return current ? [...current.children.values()].filter((c) => !c.placeholder).map((c) => ({ frameId: c.nest.frameId, label: c.label, origin: c.origin, url: c.url, dead: c.dead, ready: !!c.port, box: c.nest.box, strikes: c.guard.strikes, log: c.guard.log.slice() })) : []; },
        generation: () => generation,
        results,
        // Benchmarks (tests/chrome/compositor-bench.mjs): the raw samples behind the metrics.
        stats: () => ({ compositeMs: current && current.compositor && current.compositor.stats ? current.compositor.stats().compositeMs : [], gpuMs: current && current.compositor && current.compositor.stats ? current.compositor.stats().gpuMs || [] : [], paintTimes: stats.paintTimes.slice(), roundTrips: stats.roundTrips.slice(), scrollLatencies: scrollLatencies.slice(), handlerLatencies: handlerLatencies.slice(), received: stats.received }),
        // What the tab shows, as pixels: the view canvas, and over it the composited layers (tests; docs/compositor.md).
        // Benchmarks: n composites back to back, each waiting for the GPU (readPixels), wall ms each.
        compositeBench: (n) => {
            const c = current && current.compositor;
            if (!c || !c.gl) return null;
            const out = [];
            for (let i = 0; i < n; i++) { const t = performance.now(); c.gl.composite(true); out.push(performance.now() - t); }
            return out;
        },
        compositorTree: () => current && current.compositor && current.compositor.tree,
        compositorInfo: () => {
            const c = current && current.compositor;
            if (!c) return null;
            const tree = c.gl ? c.gl.tree : null;
            return tree ? { layers: tree.order.map((l) => ({ id: l.id, kind: l.kind, backdrop: l.backdrop, tiles: l.store.size })), glError: c.gl.gl.getError() } : { dom: true };
        },
        drawView: (ctx) => {
            ctx.drawImage(view, 0, 0);
            if (current && current.compositor)
                current.compositor.drawInto(ctx);
            // Child segments drawn as canvases of their own (flat and DOM backends).
            const v = view.getBoundingClientRect(), k = view.width / v.width;
            for (const el of document.querySelectorAll('#tab canvas.subframe')) {
                if (el.style.visibility === 'hidden' || el.style.display === 'none') continue;
                const b = el.getBoundingClientRect();
                ctx.drawImage(el, (b.left - v.left) * k, (b.top - v.top) * k, b.width * k, b.height * k);
            }
        },
        // The scroll trace: trace(true) starts recording, trace(false) stops and returns the records.
        trace: (on) => { if (on) { trace = []; return true; } const out = trace; trace = null; return out; },
        resetStats: () => { handlerLatencies.length = 0; stats.paintTimes.length = 0; stats.roundTrips.length = 0; scrollLatencies.length = 0; stats.inputLatencies.length = 0; },
    };

    startSegment(url);
})();
