// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// The segment document's side of a page's WebRTC and media capture (docs/webrtc.md; the page's side is harness/segment/rtc.js in
// the segment Worker). This document never runs site code: it holds the host browser's own RTCPeerConnections, data channels and
// capture tracks for the page, does what the page's calls ask (plain data over one MessagePort), and reports the host's events
// and state back. ICE is the host's: STUN and TURN servers the page names, host candidates as mDNS names unless this document
// holds a capture (Chrome's rule), the host's network stack. Capture asks the carapace first (its per-site decision), then the
// host's own prompt. Tracks a page shows in a <video> are played here and their frames go to the carapace's video layer.
//
// It defines `__chitinRTCHost`, which segment.js takes.
'use strict';
(() => {
    const W = window;
    const HostRTCPeerConnection = W.RTCPeerConnection;
    const HostMediaStream = W.MediaStream;
    const HostTrackProcessor = W.MediaStreamTrackProcessor;

    function attach(port, carapace) {
        // carapace: { origin, askPermission(kinds) -> Promise<boolean>, video(sink, bitmap, width, height) }
        const pcs = new Map();      // page id -> { pc, transceivers: Map(tid -> host transceiver), ids: Map(host transceiver -> tid) }
        const channels = new Map(); // page id -> host RTCDataChannel
        const tracks = new Map();   // page track id -> host MediaStreamTrack
        const streams = new Map();  // page stream id -> host MediaStream (the msid a sender carries)
        const certificates = new Map();
        const sinks = new Map();    // sink id -> { tracks, video, audio, reader, ... }
        const captured = new Set(); // the host's capture tracks (and their clones): stopped with the document
        let nextHostId = 1;
        const hostId = () => 'h' + nextHostId++;
        const post = (m, transfer) => { try { port.postMessage(m, transfer || []); } catch { /* the Worker is gone */ } };
        const errorOf = (e) => ({ name: e && e.name ? String(e.name) : 'OperationError', message: e && e.message !== undefined ? String(e.message) : String(e) });
        // Local addresses (docs/webrtc.md, "Privacy model"): Chrome shows host candidates as raw addresses to a frame whose origin
        // holds a capture permission. The host's permission is the carapace origin's, which every site shares, so a segment
        // whose own site was not granted a capture by the carapace never sees them: raw host candidates are withheld from its
        // events and descriptions (mDNS ones pass), as Chrome withholds them from a site without a capture.
        let siteMayCapture = false;
        const RAW_HOST = /^(?:a=)?candidate:\S+ \d+ \S+ \d+ (?!\S+\.local )\S+ \d+ typ host\b/i;
        const rawHost = (line) => !siteMayCapture && RAW_HOST.test(line);
        // A reflexive or relay candidate's related address is the local one when Chrome exposes it: 0.0.0.0, as Chrome sends it otherwise.
        const scrub = (line) => (siteMayCapture ? line : line.replace(/ raddr (?!0\.0\.0\.0 )\S+ rport \d+/, ' raddr 0.0.0.0 rport 0'));
        const cleanSdp = (sdp) => (siteMayCapture || typeof sdp !== 'string' ? sdp : sdp.split('\r\n').filter((l) => !rawHost(l)).map(scrub).join('\r\n'));
        const desc = (d) => (d ? { type: d.type, sdp: cleanSdp(d.sdp) } : null);

        // What the page side shows synchronously: Chrome's capabilities and constraints, sent once.
        try {
            const caps = (k, recv) => {
                const C = recv ? W.RTCRtpReceiver : W.RTCRtpSender;
                return C && C.getCapabilities ? C.getCapabilities(k) : null;
            };
            post({ t: 'capabilities', capabilities: { audio: caps('audio', true), video: caps('video', true), sendAudio: caps('audio', false), sendVideo: caps('video', false) },
                supportedConstraints: navigator.mediaDevices && navigator.mediaDevices.getSupportedConstraints ? navigator.mediaDevices.getSupportedConstraints() : {} });
        } catch { /* no WebRTC in this host */ }

        function trackInfo(track, id) {
            let settings = {}, capabilities = {}, constraints = {};
            try { settings = track.getSettings(); } catch { /* */ }
            try { capabilities = track.getCapabilities ? track.getCapabilities() : {}; } catch { /* */ }
            try { constraints = track.getConstraints(); } catch { /* */ }
            return { id: id || track.id, publicId: track.id, kind: track.kind, label: track.label, settings, capabilities, constraints, muted: track.muted, readyState: track.readyState, enabled: track.enabled };
        }
        function watchTrack(track, id) {
            if (tracks.get(id) === track)
                return;
            tracks.set(id, track);
            track.addEventListener('ended', () => post({ t: 'track-ended', track: id }));
            track.addEventListener('mute', () => post({ t: 'track-mute', track: id }));
            track.addEventListener('unmute', () => post({ t: 'track-unmute', track: id }));
        }
        // The key the page knows a host track by: its id, unless another track has it (a remote track's id is its sender's, so
        // a loopback has both): then a key of our own.
        const pageTrackId = (track) => {
            for (const [id, t] of tracks)
                if (t === track)
                    return id;
            return tracks.has(track.id) ? hostId() + ':' + track.id : track.id;
        };

        function transceiverInfo(entry, tr) {
            let tid = entry.ids.get(tr);
            if (!tid) {
                tid = hostId();
                entry.ids.set(tr, tid);
                entry.transceivers.set(tid, tr);
            }
            const rt = tr.receiver.track;
            if (rt && ![...tracks.values()].includes(rt))
                watchTrack(rt, pageTrackId(rt));
            let senderParameters;
            try { senderParameters = tr.sender.getParameters(); } catch { /* */ }
            return { id: tid, mid: tr.mid, direction: tr.direction, currentDirection: tr.currentDirection, senderTrack: tr.sender.track ? pageTrackId(tr.sender.track) : null,
                receiverTrack: rt ? trackInfo(rt, pageTrackId(rt)) : null, senderParameters };
        }
        function state(entry) {
            const pc = entry.pc;
            const out = {
                signalingState: pc.signalingState, iceGatheringState: pc.iceGatheringState, iceConnectionState: pc.iceConnectionState, connectionState: pc.connectionState,
                localDescription: desc(pc.localDescription), currentLocalDescription: desc(pc.currentLocalDescription), pendingLocalDescription: desc(pc.pendingLocalDescription),
                remoteDescription: desc(pc.remoteDescription), currentRemoteDescription: desc(pc.currentRemoteDescription), pendingRemoteDescription: desc(pc.pendingRemoteDescription),
                canTrickle: pc.canTrickleIceCandidates,
                transceivers: pc.getTransceivers().map((tr) => transceiverInfo(entry, tr)),
                channelIds: [],
            };
            for (const [id, dc] of channels)
                if (entry.channels.has(id) && dc.id !== null)
                    out.channelIds.push([id, dc.id]);
            return out;
        }

        function wireChannel(entry, id, dc) {
            dc.binaryType = 'arraybuffer';
            channels.set(id, dc);
            entry.channels.add(id);
            let polling = 0;
            const poll = () => {
                polling = 0;
                post({ t: 'dc-buffered', dc: id, bufferedAmount: dc.bufferedAmount });
                if (dc.bufferedAmount > 0 && dc.readyState === 'open')
                    polling = setTimeout(poll, 20);
            };
            dc.__chitinPoll = () => { if (!polling) polling = setTimeout(poll, 0); };
            dc.addEventListener('open', () => post({ t: 'dc-open', dc: id, id: dc.id, bufferedAmount: dc.bufferedAmount }));
            dc.addEventListener('message', (e) => {
                const data = e.data;
                post({ t: 'dc-message', dc: id, data }, data instanceof ArrayBuffer ? [data] : []);
            });
            dc.addEventListener('bufferedamountlow', () => post({ t: 'dc-bufferedamountlow', dc: id, bufferedAmount: dc.bufferedAmount }));
            dc.addEventListener('closing', () => post({ t: 'dc-closing', dc: id }));
            dc.addEventListener('error', (e) => post({ t: 'dc-error', dc: id, message: e.error ? e.error.message : '' }));
            dc.addEventListener('close', () => {
                post({ t: 'dc-close', dc: id });
                channels.delete(id);
                entry.channels.delete(id);
            });
        }
        const channelInfo = (id, dc) => ({ dc: id, label: dc.label, ordered: dc.ordered, maxPacketLifeTime: dc.maxPacketLifeTime, maxRetransmits: dc.maxRetransmits, protocol: dc.protocol, negotiated: dc.negotiated, id: dc.id, readyState: dc.readyState });

        function newConnection(id, config) {
            const c = { ...config };
            if (Array.isArray(c.certificates))
                c.certificates = c.certificates.map((h) => certificates.get(h)).filter(Boolean);
            const pc = new HostRTCPeerConnection(c);
            const entry = { pc, transceivers: new Map(), ids: new Map(), channels: new Set() };
            pcs.set(id, entry);
            const ev = (name) => () => post({ t: 'pc-event', pc: id, event: name, state: state(entry) });
            for (const name of ['negotiationneeded', 'signalingstatechange', 'iceconnectionstatechange', 'connectionstatechange', 'icegatheringstatechange'])
                pc.addEventListener(name, ev(name));
            pc.addEventListener('icecandidate', (e) => {
                const cand = e.candidate;
                if (cand && rawHost(cand.candidate))
                    return;
                const json = cand ? cand.toJSON() : null;
                if (json)
                    json.candidate = scrub(json.candidate);
                post({ t: 'pc-icecandidate', pc: id, candidate: json, url: cand ? cand.url : null, relayProtocol: cand ? cand.relayProtocol : null, state: state(entry) });
            });
            pc.addEventListener('icecandidateerror', (e) => post({ t: 'pc-icecandidateerror', pc: id, address: e.address, port: e.port, url: e.url, errorCode: e.errorCode, errorText: e.errorText }));
            pc.addEventListener('datachannel', (e) => {
                const did = hostId();
                wireChannel(entry, did, e.channel);
                post({ t: 'pc-datachannel', pc: id, channel: channelInfo(did, e.channel), state: state(entry) });
            });
            pc.addEventListener('track', (e) => {
                const tid = transceiverInfo(entry, e.transceiver);
                const track = e.track;
                const trackId = pageTrackId(track);
                watchTrack(track, trackId);
                const ids = e.streams.map((s) => s.id);
                for (const s of e.streams) {
                    if (s.__chitinWatched)
                        continue;
                    s.__chitinWatched = true;
                    s.addEventListener('removetrack', (r) => post({ t: 'pc-removetrack', pc: id, track: pageTrackId(r.track), streams: [s.id] }));
                }
                post({ t: 'pc-track', pc: id, transceiver: tid, track: trackInfo(track, trackId), streams: ids, state: state(entry) });
            });
            return entry;
        }

        async function capture(kind, constraints) {
            const kinds = kind === 'getDisplayMedia' ? ['display'] : [constraints.audio ? 'microphone' : null, constraints.video ? 'camera' : null].filter(Boolean);
            // The carapace's decision for this site first: the host's grant is the carapace origin's, shared by every site.
            if (!(await carapace.askPermission(kinds)))
                throw { name: 'NotAllowedError', message: 'Permission denied' };
            siteMayCapture = true;
            const stream = await navigator.mediaDevices[kind](constraints);
            streams.set(stream.id, stream); // a sender with this stream carries its id (msid), as in Chrome
            const out = [];
            for (const t of stream.getTracks()) {
                captured.add(t);
                watchTrack(t, t.id);
                out.push(trackInfo(t));
            }
            return { stream: stream.id, tracks: out };
        }

        const streamFor = (id) => {
            let s = streams.get(id);
            if (!s) {
                s = new HostMediaStream();
                streams.set(id, s);
            }
            return s;
        };

        // --- Sinks: a page's <video>/<audio> showing a stream --------------------------------------------------------------
        function stopSink(sink) {
            if (sink.reader) {
                try { sink.reader.cancel(); } catch { /* */ }
                sink.reader = null;
            }
            if (sink.audio) {
                sink.audio.pause();
                sink.audio.srcObject = null;
                sink.audio.remove();
                sink.audio = null;
            }
            if (sink.video) {
                sink.video.pause();
                sink.video.srcObject = null;
                sink.video.remove();
                sink.video = null;
            }
            sink.videoTrack = null;
        }
        function updateSink(m) {
            let sink = sinks.get(m.sink);
            if (!sink) {
                sink = { id: m.sink, reader: null, audio: null, video: null, videoTrack: null, width: 0, height: 0 };
                sinks.set(m.sink, sink);
            }
            const list = (m.tracks || []).map((id) => tracks.get(id)).filter(Boolean);
            const video = m.video ? list.find((t) => t.kind === 'video' && t.readyState === 'live') : null;
            const audio = list.filter((t) => t.kind === 'audio' && t.readyState === 'live');
            // Audio: an element of this document plays it (the page's muted and volume; local capture is never played back
            // unless the page asked, as a <video> of a getUserMedia stream does in Chrome).
            if (audio.length && m.playing) {
                if (!sink.audio) {
                    sink.audio = document.createElement('audio');
                    sink.audio.autoplay = true;
                    document.body.append(sink.audio);
                }
                const current = sink.audio.srcObject ? sink.audio.srcObject.getTracks() : [];
                if (current.length !== audio.length || current.some((t, i) => t !== audio[i]))
                    sink.audio.srcObject = new HostMediaStream(audio);
                sink.audio.muted = !!m.muted;
                sink.audio.volume = Math.max(0, Math.min(1, +m.volume || 0));
                sink.audio.play().catch(() => { /* autoplay: waits for the carapace's activation */ });
            } else if (sink.audio) {
                sink.audio.pause();
                sink.audio.srcObject = null;
            }
            if (video !== sink.videoTrack || !m.playing) {
                if (sink.reader) {
                    try { sink.reader.cancel(); } catch { /* */ }
                    sink.reader = null;
                }
                if (sink.video) {
                    sink.video.srcObject = null;
                    sink.video.remove();
                    sink.video = null;
                }
                sink.videoTrack = m.playing ? video : null;
                if (sink.videoTrack)
                    startFrames(sink);
            }
        }
        function sendFrame(sink, source, width, height) {
            if (width !== sink.width || height !== sink.height) {
                sink.width = width;
                sink.height = height;
                post({ t: 'sink-size', sink: sink.id, width, height });
            }
            return createImageBitmap(source).then((bitmap) => carapace.video(sink.id, bitmap, width, height));
        }
        function startFrames(sink) {
            const track = sink.videoTrack;
            if (HostTrackProcessor) {
                // Chrome's MediaStreamTrackProcessor: the track's VideoFrames, independent of anything being rendered here.
                const processor = new HostTrackProcessor({ track, maxBufferSize: 2 });
                const reader = processor.readable.getReader();
                sink.reader = reader;
                (async () => {
                    while (sink.reader === reader) {
                        let r;
                        try { r = await reader.read(); } catch { break; }
                        if (r.done)
                            break;
                        const frame = r.value;
                        try {
                            await sendFrame(sink, frame, frame.displayWidth, frame.displayHeight);
                        } catch { /* a frame lost */ }
                        frame.close();
                    }
                })();
                return;
            }
            // Otherwise a <video> of this document and its frame callbacks.
            const v = document.createElement('video');
            v.muted = true;
            v.playsInline = true;
            v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none';
            document.body.append(v);
            v.srcObject = new HostMediaStream([track]);
            sink.video = v;
            const tick = () => {
                if (sink.video !== v)
                    return;
                if (v.videoWidth)
                    sendFrame(sink, v, v.videoWidth, v.videoHeight).catch(() => {});
                v.requestVideoFrameCallback(tick);
            };
            v.play().then(() => v.requestVideoFrameCallback(tick), () => {});
        }

        async function run(m) {
            switch (m.t) {
            case 'capture':
                return capture(m.kind === 'getDisplayMedia' ? 'getDisplayMedia' : 'getUserMedia', m.constraints || {});
            case 'devices': {
                const list = await navigator.mediaDevices.enumerateDevices();
                return list.map((d) => ({ deviceId: d.deviceId, kind: d.kind, label: d.label, groupId: d.groupId }));
            }
            case 'track-constraints': {
                const t = tracks.get(m.track);
                if (!t)
                    throw { name: 'InvalidStateError', message: 'The track has ended.' };
                await t.applyConstraints(m.constraints || {});
                return { constraints: t.getConstraints(), settings: t.getSettings() };
            }
            case 'certificate': {
                const cert = await HostRTCPeerConnection.generateCertificate(m.keygen);
                const id = hostId();
                certificates.set(id, cert);
                return { id, expires: cert.expires, fingerprints: cert.getFingerprints() };
            }
            case 'stats': {
                let report;
                if (m.pc !== undefined) {
                    const entry = pcs.get(m.pc);
                    if (!entry)
                        throw { name: 'InvalidStateError', message: 'The RTCPeerConnection is closed.' };
                    report = await entry.pc.getStats(m.track ? tracks.get(m.track) || null : null);
                } else {
                    for (const entry of pcs.values()) {
                        const tr = entry.transceivers.get(m.sender || m.receiver);
                        if (tr)
                            report = await (m.sender ? tr.sender : tr.receiver).getStats();
                    }
                }
                const out = [];
                if (report)
                    report.forEach((v) => out.push(JSON.parse(JSON.stringify(v))));
                return out;
            }
            case 'sender-replace': {
                for (const entry of pcs.values()) {
                    const tr = entry.transceivers.get(m.sender);
                    if (tr)
                        return tr.sender.replaceTrack(m.track ? tracks.get(m.track) || null : null).then(() => undefined);
                }
                throw { name: 'InvalidStateError', message: 'The sender was removed.' };
            }
            case 'sender-parameters': {
                for (const entry of pcs.values()) {
                    const tr = entry.transceivers.get(m.sender);
                    if (tr) {
                        await tr.sender.setParameters(m.parameters);
                        return tr.sender.getParameters();
                    }
                }
                throw { name: 'InvalidStateError', message: 'The sender was removed.' };
            }
            case 'pc-call': {
                const entry = pcs.get(m.pc);
                if (!entry)
                    throw { name: 'InvalidStateError', message: "The RTCPeerConnection's signalingState is 'closed'." };
                const result = await entry.pc[m.method](...(m.args || []));
                return result && result.sdp !== undefined ? { description: { type: result.type, sdp: cleanSdp(result.sdp) } } : undefined;
            }
            default:
                return undefined;
            }
        }

        function handle(m) {
            switch (m.t) {
            case 'pc-new':
                try {
                    newConnection(m.pc, m.config || {});
                } catch (e) {
                    post({ t: 'pc-event', pc: m.pc, event: 'connectionstatechange', state: { connectionState: 'failed' } });
                }
                return true;
            case 'pc-config': { const entry = pcs.get(m.pc); if (entry) try { entry.pc.setConfiguration(m.config); } catch { /* */ } return true; }
            case 'pc-restart-ice': { const entry = pcs.get(m.pc); if (entry) entry.pc.restartIce(); return true; }
            case 'pc-close': {
                const entry = pcs.get(m.pc);
                if (entry) {
                    entry.pc.close();
                    for (const id of entry.channels)
                        channels.delete(id);
                    pcs.delete(m.pc);
                }
                return true;
            }
            case 'pc-add-track': {
                const entry = pcs.get(m.pc), track = tracks.get(m.track);
                if (!entry || !track)
                    return true;
                const sender = entry.pc.addTrack(track, ...(m.streams || []).map((s) => streamFor(s.id)));
                const tr = entry.pc.getTransceivers().find((t) => t.sender === sender);
                if (tr) {
                    entry.transceivers.set(m.transceiver, tr);
                    entry.ids.set(tr, m.transceiver);
                    if (m.receiverTrack && tr.receiver.track)
                        watchTrack(tr.receiver.track, m.receiverTrack);
                }
                return true;
            }
            case 'pc-remove-track': {
                const entry = pcs.get(m.pc);
                const tr = entry && entry.transceivers.get(m.transceiver);
                if (tr)
                    try { entry.pc.removeTrack(tr.sender); } catch { /* */ }
                return true;
            }
            case 'pc-add-transceiver': {
                const entry = pcs.get(m.pc);
                if (!entry)
                    return true;
                const init = { direction: m.init.direction, streams: (m.init.streams || []).map((s) => streamFor(s.id)) };
                if (m.init.sendEncodings)
                    init.sendEncodings = m.init.sendEncodings;
                let tr;
                try {
                    tr = entry.pc.addTransceiver(m.track ? tracks.get(m.track) : m.kind, init);
                } catch {
                    return true;
                }
                entry.transceivers.set(m.transceiver, tr);
                entry.ids.set(tr, m.transceiver);
                if (m.receiverTrack && tr.receiver.track)
                    watchTrack(tr.receiver.track, m.receiverTrack);
                return true;
            }
            case 'transceiver-direction': case 'transceiver-stop': case 'transceiver-codecs': {
                for (const entry of pcs.values()) {
                    const tr = entry.transceivers.get(m.transceiver);
                    if (!tr)
                        continue;
                    try {
                        if (m.t === 'transceiver-direction') tr.direction = m.direction;
                        else if (m.t === 'transceiver-stop') tr.stop();
                        else tr.setCodecPreferences(m.codecs);
                    } catch { /* */ }
                }
                return true;
            }
            case 'sender-streams': {
                for (const entry of pcs.values()) {
                    const tr = entry.transceivers.get(m.sender);
                    if (tr && tr.sender.setStreams)
                        tr.sender.setStreams(...m.streams.map(streamFor));
                }
                return true;
            }
            case 'receiver-jitter': {
                for (const entry of pcs.values()) {
                    const tr = entry.transceivers.get(m.receiver);
                    if (tr)
                        try { tr.receiver.jitterBufferTarget = m.value; } catch { /* */ }
                }
                return true;
            }
            case 'dc-new': {
                const entry = pcs.get(m.pc);
                if (!entry)
                    return true;
                let dc;
                try {
                    dc = entry.pc.createDataChannel(m.label, m.init);
                } catch (e) {
                    post({ t: 'dc-error', dc: m.dc, message: e.message });
                    post({ t: 'dc-close', dc: m.dc });
                    return true;
                }
                wireChannel(entry, m.dc, dc);
                if (dc.readyState === 'open')
                    post({ t: 'dc-open', dc: m.dc, id: dc.id });
                return true;
            }
            case 'dc-send': {
                const dc = channels.get(m.dc);
                if (!dc || dc.readyState !== 'open')
                    return true;
                try {
                    dc.send(m.data);
                } catch (e) {
                    post({ t: 'dc-error', dc: m.dc, message: e.message });
                }
                dc.__chitinPoll();
                return true;
            }
            case 'dc-close': { const dc = channels.get(m.dc); if (dc) dc.close(); return true; }
            case 'dc-threshold': { const dc = channels.get(m.dc); if (dc) dc.bufferedAmountLowThreshold = m.value; return true; }
            case 'track-stop': {
                const t = tracks.get(m.track);
                if (t)
                    t.stop();
                return true;
            }
            case 'track-enabled': { const t = tracks.get(m.track); if (t) t.enabled = !!m.enabled; return true; }
            case 'track-hint': { const t = tracks.get(m.track); if (t) t.contentHint = m.hint; return true; }
            case 'track-clone': {
                const t = tracks.get(m.track);
                if (t) {
                    const c = t.clone();
                    if (captured.has(t))
                        captured.add(c);
                    watchTrack(c, m.id);
                }
                return true;
            }
            case 'sink':
                updateSink(m);
                return true;
            case 'sink-off': {
                const sink = sinks.get(m.sink);
                if (sink) {
                    stopSink(sink);
                    sinks.delete(m.sink);
                }
                return true;
            }
            case 'reset':
                for (const entry of pcs.values())
                    entry.pc.close();
                pcs.clear();
                channels.clear();
                for (const sink of sinks.values())
                    stopSink(sink);
                sinks.clear();
                // A new document's page gets no capture of the old one.
                for (const t of captured)
                    t.stop();
                captured.clear();
                tracks.clear();
                streams.clear();
                return true;
            default:
                return false;
            }
        }

        port.onmessage = (e) => {
            const m = e.data;
            if (!m || typeof m !== 'object' || typeof m.t !== 'string')
                return;
            if (handle(m))
                return;
            if (typeof m.call !== 'number')
                return;
            run(m).then(
                (value) => post({ t: 'reply', call: m.call, ok: true, value, pc: m.pc, state: m.pc !== undefined && pcs.get(m.pc) ? state(pcs.get(m.pc)) : undefined }),
                (e) => post({ t: 'reply', call: m.call, ok: false, error: errorOf(e), pc: m.pc, state: m.pc !== undefined && pcs.get(m.pc) ? state(pcs.get(m.pc)) : undefined }));
        };
        port.start();
        return { sinks: () => sinks.size, connections: () => pcs.size };
    }
    W.__chitinRTCHost = Object.freeze({ attach, available: typeof HostRTCPeerConnection === 'function' });
})();
