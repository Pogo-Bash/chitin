// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Encrypted Media Extensions, the segment document's side (docs/eme.md). The page's EME calls (harness/segment/eme.js in the
// segment Worker) are forwarded here, to this document's own navigator.requestMediaKeySystemAccess, MediaKeys and
// MediaKeySession: the host browser's real CDM (Clear Key everywhere, Widevine where the host has it). Media that needs a
// key plays in a real <video> of this document, fed with the page's own MSE bytes (the Worker forwards each appendBuffer);
// the host's CDM decrypts and the host draws it, at the box the Worker reports for the page's <video>. Nothing here
// decrypts, reads or copies a frame: the frames never leave the host's media pipeline. License requests and responses are
// bytes the page itself fetches over the engine's network; this document only hands them to and from the CDM.
//
// It defines `ChitinEMEHost(port, notify)`: `port` is the Worker's line (a MessagePort of its own), `notify(on)` tells the
// carapace whether a host video is on show (it lifts the segment's frame over its canvas while one is).
'use strict';
(() => {
    const EL_EVENTS = ['loadstart', 'progress', 'suspend', 'abort', 'error', 'emptied', 'stalled', 'loadedmetadata', 'loadeddata',
        'canplay', 'canplaythrough', 'playing', 'waiting', 'seeking', 'seeked', 'ended', 'durationchange', 'timeupdate', 'play',
        'pause', 'ratechange', 'resize', 'volumechange', 'encrypted', 'waitingforkey'];
    const SB_EVENTS = ['updatestart', 'update', 'updateend', 'error', 'abort'];
    const MS_EVENTS = ['sourceopen', 'sourceended', 'sourceclose'];
    const MAX_HANDLES = 4096;

    function ChitinEMEHost(port, notify) {
        const accesses = new Map(), keys = new Map(), sessions = new Map(), elements = new Map(), buffers = new Map();
        const errorOf = (e) => ({ name: e && typeof e.name === 'string' ? e.name : 'Error', message: e && e.message !== undefined ? String(e.message) : String(e), dom: e instanceof DOMException });
        const reply = (id, value, transfer) => { if (id) port.postMessage({ re: id, ok: true, value }, transfer || []); };
        const fail = (id, e) => { if (id) port.postMessage({ re: id, ok: false, error: errorOf(e) }); };
        const emit = (m, transfer) => port.postMessage(m, transfer || []);
        const copy = (b) => (b instanceof ArrayBuffer ? b.slice(0) : ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice().buffer : b);
        const ranges = (r) => { const out = []; for (let i = 0; i < r.length; i++) out.push([r.start(i), r.end(i)]); return out; };
        const handle = (map, h) => typeof h === 'number' && h > 0 && map.size < MAX_HANDLES;
        const now = () => performance.timeOrigin + performance.now();

        // --- Key systems, keys and sessions ------------------------------------------------------------------------------
        function statuses(session) {
            const list = [];
            session.keyStatuses.forEach((status, keyId) => list.push([copy(keyId), status]));
            return list;
        }
        function watchSession(s, session) {
            session.addEventListener('message', (e) => {
                const message = copy(e.message);
                emit({ ev: 'session', s, type: 'message', messageType: e.messageType, message }, [message]);
            });
            session.addEventListener('keystatuseschange', () => {
                emit({ ev: 'session', s, type: 'keystatuseschange', statuses: statuses(session), expiration: session.expiration });
            });
            session.closed.then((reason) => emit({ ev: 'session', s, type: 'closed', reason, statuses: statuses(session) }));
        }
        const sessionState = (session) => ({ sessionId: session.sessionId, expiration: session.expiration, statuses: statuses(session) });

        // --- Media elements: one host <video> per page element that has used EME --------------------------------------
        function snapshot(v) {
            return {
                t: v.currentTime, at: now(), paused: v.paused, ended: v.ended, seeking: v.seeking, rs: v.readyState, ns: v.networkState,
                dur: v.duration, rate: v.playbackRate, w: v.videoWidth, h: v.videoHeight, buf: ranges(v.buffered), seekable: ranges(v.seekable),
                played: ranges(v.played), err: v.error ? { code: v.error.code, message: v.error.message } : null,
            };
        }
        let shown = 0;
        function setShown(d, on) {
            if (d.shown === on)
                return;
            d.shown = on;
            shown += on ? 1 : -1;
            const any = shown > 0;
            // The segment's frame lies over the carapace's view while a video shows: only the video may paint, so the
            // document's own background goes.
            document.documentElement.style.background = any ? 'transparent' : '';
            document.body.style.background = any ? 'transparent' : '';
            notify(any);
        }
        function element(e) {
            let d = elements.get(e);
            if (d)
                return d;
            if (!handle(elements, e))
                throw new DOMException('Too many media elements.', 'QuotaExceededError');
            const v = document.createElement('video');
            v.playsInline = true;
            v.disablePictureInPicture = true;
            v.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;display:none;border:0;margin:0;padding:0;pointer-events:none;';
            document.body.appendChild(v);
            d = { e, v, live: false, ms: null, url: '', open: null, sbs: new Map(), msChain: Promise.resolve(), shown: false, gen: 0, firstOpen: true };
            for (const type of EL_EVENTS) {
                v.addEventListener(type, (ev) => {
                    if (!d.live)
                        return;
                    const m = { ev: 'el', e, type, st: snapshot(v) };
                    const transfer = [];
                    if (type === 'encrypted') {
                        m.initDataType = ev.initDataType;
                        m.initData = ev.initData ? copy(ev.initData) : null;
                        if (m.initData)
                            transfer.push(m.initData);
                    }
                    emit(m, transfer);
                });
            }
            elements.set(e, d);
            return d;
        }
        function watchMediaSource(d, ms) {
            for (const type of MS_EVENTS) {
                ms.addEventListener(type, () => {
                    if (d.ms !== ms || !d.live)
                        return;
                    const first = type === 'sourceopen' && d.firstOpen;
                    if (type === 'sourceopen')
                        d.firstOpen = false;
                    emit({ ev: 'ms', e: d.e, type, first, st: { rs: ms.readyState, dur: ms.duration } });
                });
            }
        }
        function sbState(sb) {
            let buf = [];
            try { buf = ranges(sb.buffered); } catch { /* removed */ }
            return { updating: sb.updating, buf, tso: sb.timestampOffset, mode: sb.mode, aws: sb.appendWindowStart, awe: sb.appendWindowEnd };
        }
        function addBuffer(d, b, type) {
            const sb = d.ms.addSourceBuffer(type);
            const entry = { b, sb, d, chain: Promise.resolve(), replay: false };
            for (const t of SB_EVENTS) {
                sb.addEventListener(t, () => {
                    if (!d.live || buffers.get(b) !== entry)
                        return;
                    emit({ ev: 'sb', b, type: t, replay: entry.replay, st: sbState(sb), ms: { rs: d.ms.readyState, dur: d.ms.duration } });
                });
            }
            buffers.set(b, entry);
            d.sbs.set(b, entry);
            return entry;
        }
        // One operation of a source buffer at a time, as the page made them: an append or a removal waits for its updateend.
        function onBuffer(entry, fn) {
            entry.chain = entry.chain.then(() => new Promise((resolve) => {
                let waits = false;
                try {
                    waits = fn(entry.sb) === true;
                } catch (e) {
                    emit({ ev: 'sb-error', b: entry.b, error: errorOf(e), st: sbState(entry.sb) });
                }
                if (!waits)
                    return resolve();
                entry.sb.addEventListener('updateend', () => resolve(), { once: true });
            }));
            return entry.chain;
        }
        // What waits for every buffer's operations so far (duration, endOfStream): the page made it after their updateend.
        const afterBuffers = (d) => Promise.all(Array.from(d.sbs.values(), (x) => x.chain));
        function undelegate(d) {
            d.live = false;
            d.gen++;
            for (const b of d.sbs.keys())
                buffers.delete(b);
            d.sbs.clear();
            d.ms = null;
            if (d.url)
                URL.revokeObjectURL(d.url);
            d.url = '';
            d.v.removeAttribute('src');
            d.v.load();
            d.v.style.display = 'none';
            setShown(d, false);
        }
        function delegate(d, m) {
            if (d.live)
                undelegate(d);
            d.live = true;
            d.firstOpen = true;
            const v = d.v;
            v.muted = m.attrs.muted === true;
            v.volume = Math.min(1, Math.max(0, Number(m.attrs.volume) || 0));
            v.loop = m.attrs.loop === true;
            v.autoplay = m.attrs.autoplay === true;
            try { v.defaultPlaybackRate = Number(m.attrs.defaultRate) || 1; v.playbackRate = Number(m.attrs.rate) || 1; } catch { /* the host refuses a rate: it keeps its own */ }
            const ms = new MediaSource();
            d.ms = ms;
            watchMediaSource(d, ms);
            d.url = URL.createObjectURL(ms);
            const gen = d.gen;
            d.open = new Promise((resolve) => ms.addEventListener('sourceopen', resolve, { once: true }));
            v.addEventListener('error', () => emit({ ev: 'ms-error', e: d.e, error: { name: 'MediaError', message: 'host video: ' + (v.error && v.error.message) } }), { once: true });
            v.src = d.url;
            // The page's buffers, made before the media went to the host, and what it appended to them meanwhile: replayed in
            // order (their events were the engine's; the page has heard them).
            d.msChain = d.open.then(() => {
                if (d.gen !== gen)
                    return;
                for (const x of m.sbs) {
                    const entry = addBuffer(d, x.b, x.type);
                    for (const op of x.log)
                        onBuffer(entry, (sb) => { entry.replay = true; return bufferOp(sb, op); }).then(() => { entry.replay = false; });
                }
            }).catch((e) => emit({ ev: 'ms-error', e: d.e, error: errorOf(e) }));
        }
        function bufferOp(sb, op) {
            if (op.kind === 'append') {
                sb.appendBuffer(op.bytes);
                return true;
            }
            if (op.kind === 'remove') {
                sb.remove(op.start, op.end);
                return true;
            }
            if (op.kind === 'abort')
                sb.abort();
            else if (op.kind === 'tso')
                sb.timestampOffset = op.value;
            else if (op.kind === 'mode')
                sb.mode = op.value;
            else if (op.kind === 'aws')
                sb.appendWindowStart = op.value;
            else if (op.kind === 'awe')
                sb.appendWindowEnd = op.value;
            else if (op.kind === 'changeType')
                sb.changeType(op.value);
            return false;
        }

        // --- The box: where the page's <video> is, in this document's (= the view's) CSS pixels --------------------------
        function place(d, m) {
            const s = d.v.style;
            const show = m.show === true && d.live && [m.x, m.y, m.w, m.h].every(Number.isFinite) && m.w > 0 && m.h > 0;
            if (show) {
                s.left = m.x + 'px';
                s.top = m.y + 'px';
                s.width = m.w + 'px';
                s.height = m.h + 'px';
                s.objectFit = /^(fill|contain|cover|none|scale-down)$/.test(m.fit) ? m.fit : 'contain';
                s.zIndex = String(Math.max(0, Math.min(1e6, m.z | 0)));
                s.display = 'block';
            } else {
                s.display = 'none';
            }
            setShown(d, show);
        }

        // --- Requests from the Worker --------------------------------------------------------------------------------------
        const ops = {
            async access(m) {
                const access = await navigator.requestMediaKeySystemAccess(...m.args);
                const a = m.a;
                if (!handle(accesses, a))
                    throw new DOMException('Too many key system accesses.', 'QuotaExceededError');
                accesses.set(a, access);
                return { keySystem: access.keySystem, configuration: access.getConfiguration() };
            },
            async createMediaKeys(m) {
                const access = accesses.get(m.a);
                if (!access || !handle(keys, m.k))
                    throw new DOMException('The key system access is gone.', 'InvalidStateError');
                keys.set(m.k, await access.createMediaKeys());
                return true;
            },
            async setServerCertificate(m) {
                return keys.get(m.k).setServerCertificate(...m.args);
            },
            async getStatusForPolicy(m) {
                return keys.get(m.k).getStatusForPolicy(...m.args);
            },
            createSession(m) {
                const mk = keys.get(m.k);
                if (!mk || !handle(sessions, m.s))
                    throw new DOMException('The media keys are gone.', 'InvalidStateError');
                const session = mk.createSession(...m.args);
                sessions.set(m.s, session);
                watchSession(m.s, session);
                return true;
            },
            async generateRequest(m) {
                const session = sessions.get(m.s);
                await session.generateRequest(...m.args);
                return sessionState(session);
            },
            async load(m) {
                const session = sessions.get(m.s);
                const found = await session.load(...m.args);
                return { found, ...sessionState(session) };
            },
            async update(m) {
                const session = sessions.get(m.s);
                await session.update(...m.args);
                return sessionState(session);
            },
            async close(m) {
                const session = sessions.get(m.s);
                await session.close();
                return sessionState(session);
            },
            async remove(m) {
                const session = sessions.get(m.s);
                await session.remove();
                return sessionState(session);
            },
            async setMediaKeys(m) {
                const d = element(m.e);
                const mk = m.k ? keys.get(m.k) : null;
                if (m.k && !mk)
                    throw new DOMException('The media keys are gone.', 'InvalidStateError');
                await d.v.setMediaKeys(mk);
                return true;
            },
            delegate(m) {
                delegate(element(m.e), m);
                return true;
            },
            undelegate(m) {
                const d = elements.get(m.e);
                if (d)
                    undelegate(d);
                return true;
            },
            addSourceBuffer(m) {
                const d = elements.get(m.e);
                if (!d || !d.live)
                    return false;
                const gen = d.gen;
                d.msChain = d.msChain.then(() => { if (d.gen === gen && d.live) addBuffer(d, m.b, m.type); });
                return true;
            },
            removeSourceBuffer(m) {
                const entry = buffers.get(m.b);
                if (!entry)
                    return false;
                const d = entry.d;
                d.msChain = d.msChain.then(() => {
                    try { d.ms.removeSourceBuffer(entry.sb); } catch { /* already gone */ }
                    buffers.delete(m.b);
                    d.sbs.delete(m.b);
                });
                return true;
            },
            buffer(m) {
                const d = elements.get(m.e);
                if (!d || !d.live)
                    return false;
                // The buffer exists once the source is open and it was added (both on the source's chain).
                d.msChain.then(() => {
                    const entry = buffers.get(m.b);
                    if (entry)
                        onBuffer(entry, (sb) => bufferOp(sb, m.act));
                });
                return true;
            },
            source(m) {
                const d = elements.get(m.e);
                if (!d || !d.live)
                    return false;
                const gen = d.gen;
                d.msChain = d.msChain.then(() => afterBuffers(d)).then(() => {
                    if (d.gen !== gen || !d.ms)
                        return;
                    try {
                        if (m.what === 'duration')
                            d.ms.duration = m.value;
                        else if (m.what === 'endOfStream')
                            m.value === undefined ? d.ms.endOfStream() : d.ms.endOfStream(m.value);
                        else if (m.what === 'setLiveSeekableRange')
                            d.ms.setLiveSeekableRange(m.start, m.end);
                        else if (m.what === 'clearLiveSeekableRange')
                            d.ms.clearLiveSeekableRange();
                    } catch (e) {
                        emit({ ev: 'ms-error', e: d.e, error: errorOf(e) });
                    }
                });
                return true;
            },
            async play(m) {
                const d = elements.get(m.e);
                if (!d || !d.live)
                    return snapshotOr(d);
                d.v.loop = m.loop === true;
                await d.v.play();
                return snapshot(d.v);
            },
            media(m) {
                const d = elements.get(m.e);
                if (!d)
                    return false;
                const v = d.v;
                if (m.what === 'pause')
                    v.pause();
                else if (m.what === 'seek')
                    v.currentTime = m.value;
                else if (m.what === 'fastSeek')
                    v.fastSeek(m.value);
                else if (m.what === 'volume')
                    v.volume = m.value;
                else if (m.what === 'muted')
                    v.muted = m.value === true;
                else if (m.what === 'rate')
                    v.playbackRate = m.value;
                else if (m.what === 'defaultRate')
                    v.defaultPlaybackRate = m.value;
                else if (m.what === 'loop')
                    v.loop = m.value === true;
                return true;
            },
            box(m) {
                const d = elements.get(m.e);
                if (d)
                    place(d, m);
                return true;
            },
        };
        const snapshotOr = (d) => (d ? snapshot(d.v) : null);

        port.onmessage = async (event) => {
            const m = event.data;
            if (!m || typeof m.op !== 'string' || !Object.hasOwn(ops, m.op))
                return;
            const id = typeof m.id === 'number' ? m.id : 0;
            try {
                const value = await ops[m.op](m);
                reply(id, value);
            } catch (e) {
                fail(id, e);
            }
        };
    }
    self.ChitinEMEHost = ChitinEMEHost;
})();
