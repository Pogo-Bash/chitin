// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// The segment document: one per site, on the site's own origin (seg-<name>.localhost here).
// It never runs site code itself. It registers the segment's service worker (the module loader),
// starts the Worker that holds the engine and the page's JS, and hands it the carapace's port.
'use strict';
(() => {
    const CARAPACE = `http://localhost:${location.port}`;
    const status = (text) => console.log('[segment]', text);

    async function controlled() {
        const sw = navigator.serviceWorker;
        await sw.register('/sw.js', { scope: '/' });
        await sw.ready;
        if (!sw.controller)
            await new Promise((resolve) => sw.addEventListener('controllerchange', resolve, { once: true }));
        return sw.controller;
    }

    // Gives the service worker a direct line to the engine in the Worker. Done again whenever the
    // service worker asks (it loses its ports when the browser stops and restarts it).
    // The line to the Worker goes over the control port, never over the Worker's global, where page JS
    // could listen to it (docs/security.md, item 2).
    function connectEngine(control, nonce) {
        const channel = new MessageChannel();
        navigator.serviceWorker.controller.postMessage({ type: 'engine-port', nonce }, [channel.port1]);
        control.postMessage({ type: 'sw-port', nonce }, [channel.port2]);
    }

    // Synchronous streams (docs/network.md "Synchronous requests"): while the Worker is blocked in a synchronous
    // XMLHttpRequest, Spiracle sends that request's stream events here (the aux port), and this document writes them into the
    // ring the Worker reads: records of [kind (1 open, 2 data, 3 close), stream, length or close code] and the bytes, 4-aligned.
    function startSyncNet(sab, aux) {
        const CAP = sab.byteLength - 16;
        const i32 = new Int32Array(sab, 0, 4), bytes = new Uint8Array(sab, 16, CAP);
        const backlog = [];
        let timer = 0;
        const put = (pos, v) => { for (let i = 0; i < 4; i++) bytes[(pos + i) % CAP] = (v >>> (8 * i)) & 255; };
        const flush = () => {
            timer = 0;
            while (backlog.length) {
                const [kind, id, payload, code] = backlog[0];
                const len = payload ? payload.length : code >>> 0;
                const size = 12 + (payload ? (payload.length + 3) & ~3 : 0);
                const w = Atomics.load(i32, 0) >>> 0, r = Atomics.load(i32, 1) >>> 0;
                if (size > CAP - ((w - r) >>> 0)) {
                    timer = setTimeout(flush, 1); // the Worker has not read yet
                    return;
                }
                backlog.shift();
                const pos = w % CAP;
                put(pos, kind);
                put(pos + 4, id);
                put(pos + 8, len);
                if (payload) {
                    const at = (pos + 12) % CAP, first = Math.min(payload.length, CAP - at);
                    bytes.set(payload.subarray(0, first), at);
                    if (first < payload.length)
                        bytes.set(payload.subarray(first), 0);
                }
                Atomics.store(i32, 0, ((w + size) >>> 0) | 0);
                Atomics.notify(i32, 0);
            }
        };
        aux.onmessage = (e) => {
            const m = e.data;
            if (!m || typeof m.s !== 'number')
                return;
            if (m.t === 'open')
                backlog.push([1, m.s, null, 0]);
            else if (m.t === 'data' && m.b instanceof ArrayBuffer)
                backlog.push([2, m.s, new Uint8Array(m.b), 0]);
            else if (m.t === 'close')
                backlog.push([3, m.s, null, m.code | 0]);
            else
                return;
            if (!timer)
                flush();
        };
        return true;
    }

    window.addEventListener('message', async (event) => {
        if (event.origin !== CARAPACE || !event.data || event.data.type !== 'init')
            return;
        const init = event.data;
        const port = event.ports[0];
        const netPort = event.ports[1]; // to Spiracle: the engine's TCP streams
        try {
            await controlled();
        } catch (e) {
            port.postMessage({ type: 'status', key: 'service worker', value: 'FAILED: ' + e.message });
            return;
        }
        const nonce = crypto.randomUUID();
        const colorScheme = () => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        // The host browser's screen, for the page's Screen and ScreenOrientation (sent again when the orientation changes).
        // The output rate the page's AudioContexts run at, as Chrome's run at the device's: this document's own context's.
        const audioRate = () => {
            try {
                const c = new AudioContext();
                const rate = c.sampleRate;
                c.close();
                return rate;
            } catch {
                return 0;
            }
        };
        const connectionInfo = () => {
            const c = navigator.connection;
            return c ? { effectiveType: c.effectiveType, rtt: c.rtt, downlink: c.downlink, saveData: c.saveData === true } : null;
        };
        const screenInfo = () => {
            const s = self.screen, o = s.orientation;
            return { width: s.width, height: s.height, availLeft: s.availLeft, availTop: s.availTop, availWidth: s.availWidth, availHeight: s.availHeight, colorDepth: s.colorDepth, isExtended: s.isExtended === true, orientationType: o ? o.type : '', orientationAngle: o ? o.angle : 0 };
        };
        const worker = new Worker('/chitin/worker.js', { name: 'chitin-segment' });
        // `port` is transferred to the Worker below, so report straight to the carapace window.
        const report = (key, value) => window.parent.postMessage({ type: 'segment-status', key, value }, CARAPACE);
        worker.addEventListener('error', (e) => report('worker error', `${e.message} (${e.filename}:${e.lineno})`));
        worker.addEventListener('messageerror', () => report('worker messageerror', 'a message could not be deserialised'));
        // The control port is the Worker's only way to hear from this document after `init`.
        const control = new MessageChannel();
        const transfer = [port, control.port2];
        // WebRTC and capture for the page (docs/webrtc.md): the host's RTCPeerConnection lives here (a Worker has none); the Worker's
        // side (rtc.js) talks to it over a port of its own. Off when the carapace says so (the Tor network mode).
        const rtcChannel = init.rtc !== false && self.__chitinRTCHost && self.__chitinRTCHost.available ? new MessageChannel() : null;
        if (rtcChannel) {
            transfer.push(rtcChannel.port2);
            const asks = new Map();
            let nextAsk = 1;
            window.addEventListener('message', (e) => {
                if (e.origin !== CARAPACE || e.source !== window.parent || !e.data || e.data.type !== 'rtc-permission-answer' || !asks.has(e.data.ask))
                    return;
                asks.get(e.data.ask)(e.data.allow === true);
                asks.delete(e.data.ask);
            });
            self.__chitinRTCHost.attach(rtcChannel.port1, {
                origin: CARAPACE,
                askPermission: (kinds) => new Promise((resolve) => {
                    const ask = nextAsk++;
                    asks.set(ask, resolve);
                    window.parent.postMessage({ type: 'rtc-permission', ask, kinds }, CARAPACE);
                }),
                // A frame of a stream the page shows: to the carapace's video layer, transferred.
                video: (sink, bitmap, width, height) => window.parent.postMessage({ type: 'rtc-video', sink, bitmap, width, height }, CARAPACE, [bitmap]),
            });
        }
        if (netPort)
            transfer.push(netPort);
        let canvas = init.canvas;
        if (init.mode === 'direct') {
            // Comparison mode: the segment shows its own canvas in its own frame and takes input
            // directly, with the carapace out of the frame path.
            const el = document.getElementById('direct');
            el.hidden = false;
            el.width = Math.round(init.width * init.dpr);
            el.height = Math.round(init.height * init.dpr);
            canvas = el.transferControlToOffscreen();
            const send = (kind) => (e) => {
                control.port1.postMessage({ type: 'direct-input', kind, x: e.offsetX, y: e.offsetY, button: e.button, buttons: e.buttons, ts: performance.timeOrigin + e.timeStamp });
            };
            el.addEventListener('pointerdown', send(0));
            el.addEventListener('pointerup', send(1));
            el.addEventListener('pointermove', send(2));
            el.addEventListener('click', send(3));
        }
        if (canvas)
            transfer.push(canvas);
        worker.postMessage({ type: 'init', mode: init.mode, classic: init.classic, site: init.site, url: init.url, engine: init.engine, scripting: init.scripting, width: init.width, height: init.height, dpr: init.dpr, colorScheme: colorScheme(), screen: screenInfo(), connection: connectionInfo(), audioRate: audioRate(), nested: init.nested === true, opener: init.opener === true, embedder: init.nested === true && init.embedder && typeof init.embedder === 'object' ? init.embedder : null, frameRealms: init.frameRealms !== false, debugContexts: init.debugContexts === true, compatHide: Array.isArray(init.compatHide) ? init.compatHide.map(String) : [], compositor: init.compositor === 'layers' || init.compositor === 'gpu' ? init.compositor : 'flat', canvas, cookies: init.cookies && typeof init.cookies === 'object' ? init.cookies : null, nonce, isolated: self.crossOriginIsolated, rtc: !!rtcChannel, rtcPort: rtcChannel ? rtcChannel.port2 : null }, transfer);
        connectEngine(control.port1, nonce);
        // prefers-color-scheme follows the host browser (this document's media query), and again when it changes.
        const darkQuery = matchMedia('(prefers-color-scheme: dark)');
        darkQuery.addEventListener('change', () => control.port1.postMessage({ type: 'color-scheme', value: colorScheme() }));
        if (navigator.connection)
            navigator.connection.addEventListener('change', () => control.port1.postMessage({ type: 'connection', value: connectionInfo() }));
        if (self.screen.orientation)
            self.screen.orientation.addEventListener('change', () => control.port1.postMessage({ type: 'screen', value: screenInfo() }));
        // Runners of the page's own service workers (docs/architecture.md, "Page service workers"): the segment Worker asks,
        // this document starts /chitin/pagesw.js (the Worker's CSP allows no workers) and hands it the Worker's port.
        const runners = new Map();
        // Chrome has no fixed number of dedicated Workers per page (a machine with a Worker per task, such as plasmaontheweb.com,
        // starts 40 and more); Firefox stops at 512 per domain. The cap is Firefox's: it bounds what a page can start in its
        // own segment, and is far above what real pages use (it was 32, which stalled plasmaontheweb.com's boot silently).
        const MAX_RUNNERS = 512;
        const READY_RUNNERS = 8;
        const readyRunners = [];
        let poolNonce = null;
        const newRunner = () => {
            const runner = new Worker('/chitin/pagesw.js', { name: 'chitin-page-sw' });
            runner.addEventListener('error', (err) => report('page service worker error', `${err.message} (${err.filename}:${err.lineno})`));
            runner.addEventListener('message', (ev) => { if (ev.data && ev.data.t === 'fatal') report('page service worker error', String(ev.data.error)); });
            return runner;
        };
        const fillPool = () => {
            while (poolNonce !== null && readyRunners.length < READY_RUNNERS && runners.size + readyRunners.length < MAX_RUNNERS) {
                const worker = newRunner();
                worker.postMessage({ type: 'init', nonce: poolNonce });
                readyRunners.push({ worker, nonce: poolNonce });
            }
        };
        let syncNet = null;
        let emeStarted = false;
        control.port1.onmessage = (e) => {
            const m = e.data;
            if (!m || typeof m.id !== 'number')
                return;
            if (m.type === 'eme-port' && e.ports[0] && !emeStarted && typeof self.ChitinEMEHost === 'function') {
                // The page's EME calls and handed-over media (eme-host.js, docs/eme.md); `notify` lifts the frame over the view.
                emeStarted = true;
                self.ChitinEMEHost(e.ports[0], (on) => window.parent.postMessage({ type: 'segment-video', on: on === true }, CARAPACE));
            } else if (m.type === 'sync-net' && e.ports[0] && m.sab instanceof SharedArrayBuffer && !syncNet)
                syncNet = startSyncNet(m.sab, e.ports[0]);
            else if (m.type === 'start-page-sw' && e.ports[0] && runners.size >= MAX_RUNNERS) {
                // Over the cap: the page's Worker gets an error event instead of waiting for a runner for good.
                e.ports[0].postMessage({ t: 'error', message: 'Uncaught Error: too many Workers on this page (' + MAX_RUNNERS + ')' });
                e.ports[0].close();
            } else if (m.type === 'start-page-sw' && e.ports[0]) {
                // A runner kept ready (started, the segment's service worker probed, the doors taken: pagesw.js) gets the
                // port at once; the pool is filled from a page's first Worker on, so a page without Workers starts none.
                // plasmaontheweb.com starts a Worker per task: a runner's own start-up was most of a Worker's 12 ms (Chrome 2).
                const ready = readyRunners.shift();
                let runner;
                if (ready && ready.nonce === m.nonce) {
                    runner = ready.worker;
                    runner.postMessage({ type: 'port' }, [e.ports[0]]);
                } else {
                    if (ready)
                        ready.worker.terminate();
                    runner = newRunner();
                    runner.postMessage({ type: 'init', nonce: m.nonce }, [e.ports[0]]);
                }
                runners.set(m.id, runner);
                poolNonce = m.nonce;
                fillPool();
            } else if (m.type === 'stop-page-sw' && runners.has(m.id)) {
                runners.get(m.id).terminate();
                runners.delete(m.id);
            }
        };
        navigator.serviceWorker.addEventListener('message', (e) => {
            if (e.data && e.data.type === 'need-port')
                connectEngine(control.port1, nonce);
        });
        status('started');
    });
    window.parent.postMessage({ type: 'segment-ready', crossOriginIsolated: self.crossOriginIsolated }, CARAPACE);
})();
