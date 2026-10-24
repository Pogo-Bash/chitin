// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
'use strict';
const fnv = (b) => { let h = 0x811c9dc5; for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193) >>> 0; return h; };
const seeded = (n, seed) => { const o = new Uint8Array(n); let x = seed >>> 0 || 1; for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; o[i] = x & 255; } return o; };
const wait = (target, type, ms = 10000) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('timed out waiting for ' + type)), ms); target.addEventListener(type, (e) => { clearTimeout(t); resolve(e); }, { once: true }); });
const tag = (o) => Object.prototype.toString.call(o);

// The shape of the API, before anything runs: what a page can see without a peer.
function shape() {
    const out = {};
    const pc = new RTCPeerConnection();
    out.states = [pc.signalingState, pc.iceGatheringState, pc.iceConnectionState, pc.connectionState, pc.localDescription, pc.remoteDescription, pc.canTrickleIceCandidates];
    const dc = pc.createDataChannel('x');
    out.channel = [dc.label, dc.ordered, dc.maxPacketLifeTime, dc.maxRetransmits, dc.protocol, dc.negotiated, dc.id, dc.readyState, dc.bufferedAmount, dc.bufferedAmountLowThreshold, dc.binaryType, tag(dc)];
    const neg = pc.createDataChannel('n', { negotiated: true, id: 7, maxRetransmits: 2, protocol: 'p' });
    out.negotiated = [neg.id, neg.negotiated, neg.maxRetransmits, neg.protocol, neg.ordered];
    const errors = [];
    const tryIt = (f) => { try { f(); errors.push('no error'); } catch (e) { errors.push(e.name + ': ' + e.message); } };
    tryIt(() => pc.createDataChannel('a', { maxRetransmits: 1, maxPacketLifeTime: 1 }));
    tryIt(() => pc.createDataChannel('a', { negotiated: true }));
    tryIt(() => dc.send('early'));
    tryIt(() => new RTCPeerConnection({ iceServers: [{ urls: 'http://example.com' }] }));
    tryIt(() => new RTCPeerConnection({ iceServers: [{ urls: 'turn:example.com' }] }));
    tryIt(() => new RTCPeerConnection({ bundlePolicy: 'nope' }));
    tryIt(() => new RTCSessionDescription({ type: 'bogus' }));
    tryIt(() => new RTCIceCandidate({ candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 54400 typ host' }));
    out.errors = errors;
    const c = new RTCIceCandidate({ candidate: 'candidate:842163049 1 udp 1677729535 198.51.100.7 61665 typ srflx raddr 0.0.0.0 rport 0 generation 0 ufrag abcd network-cost 999', sdpMid: '0', sdpMLineIndex: 0 });
    out.candidate = [c.foundation, c.component, c.priority, c.address, c.protocol, c.port, c.type, c.relatedAddress, c.relatedPort, c.usernameFragment, c.tcpType, JSON.stringify(c.toJSON())];
    const d = new RTCSessionDescription({ type: 'offer', sdp: 'v=0' });
    out.description = [d.type, d.sdp, JSON.stringify(d), tag(d)];
    out.config = JSON.stringify(pc.getConfiguration());
    out.tags = [tag(pc), tag(new MediaStream()), String(RTCPeerConnection.length), String(RTCPeerConnection.prototype.addTrack.length), typeof webkitRTCPeerConnection];
    pc.close();
    out.closed = [pc.signalingState, pc.iceConnectionState, pc.connectionState, dc.readyState];
    const errs2 = [];
    pc.createOffer().then(() => errs2.push('resolved'), (e) => errs2.push(e.name + ': ' + e.message));
    out.closedErrors = errs2;
    return out;
}

async function dataChannels() {
    const log = window.dcLog = { a: [], b: [], candidates: { a: [], b: [] } };
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    for (const [name, pc, other] of [['a', a, b], ['b', b, a]]) {
        pc.addEventListener('icecandidate', (e) => {
            if (e.candidate) {
                // Host candidates as mDNS names (Chrome without a capture): no local address is ever exposed.
                log.candidates[name].push({ type: e.candidate.type, protocol: e.candidate.protocol, mdns: /\.local$/.test(e.candidate.address || ''), ip: /^[0-9.]+$|:/.test(e.candidate.address || '') });
                other.addIceCandidate(e.candidate).catch((err) => log[name].push('addIceCandidate failed: ' + err.name));
            } else
                log[name].push('icecandidate null');
        });
        for (const t of ['signalingstatechange', 'icegatheringstatechange', 'connectionstatechange'])
            pc.addEventListener(t, () => log[name].push(t + ' ' + (t === 'signalingstatechange' ? pc.signalingState : t === 'icegatheringstatechange' ? pc.iceGatheringState : pc.connectionState)));
        pc.addEventListener('negotiationneeded', () => log[name].push('negotiationneeded'));
    }
    const ch = a.createDataChannel('chat', { ordered: true });
    const opened = wait(ch, 'open');
    const remote = wait(b, 'datachannel');
    const offer = await a.createOffer();
    log.a.push('offer ' + offer.type + ' ' + /m=application/.test(offer.sdp) + ' ' + /a=fingerprint:sha-256/.test(offer.sdp));
    await a.setLocalDescription(offer);
    log.a.push('after setLocal ' + a.signalingState + ' ' + (a.localDescription && a.localDescription.type) + ' pending=' + !!a.pendingLocalDescription);
    await b.setRemoteDescription(offer);
    log.b.push('after setRemote ' + b.signalingState);
    await b.setLocalDescription(); // implicit answer
    log.b.push('after implicit setLocal ' + b.signalingState + ' ' + b.localDescription.type);
    await a.setRemoteDescription(b.localDescription);
    log.a.push('after setRemote ' + a.signalingState + ' current=' + !!a.currentRemoteDescription + ' canTrickle=' + a.canTrickleIceCandidates);
    await opened;
    const rc = (await remote).channel;
    if (rc.readyState !== 'open')
        await wait(rc, 'open');
    log.channel = { a: [ch.label, ch.readyState, typeof ch.id, ch.id === rc.id], b: [rc.label, rc.readyState, rc.ordered, rc.negotiated, rc.protocol, rc.binaryType, tag(rc)] };
    // Messages both ways, in order, of each kind.
    const got = [];
    rc.onmessage = (e) => {
        const d = e.data;
        if (typeof d === 'string') {
            got.push('string ' + d.length + ' ' + d.slice(0, 12));
            if (d !== 'bye')
                rc.send('echo:' + d.slice(0, 8));
        } else
            got.push(tag(d) + ' ' + d.byteLength + ' ' + fnv(new Uint8Array(d)));
    };
    const echoes = [];
    ch.onmessage = (e) => echoes.push(e.data);
    ch.send('hello');
    ch.send('héllo wörld ☃');
    ch.send(seeded(1000, 1).buffer);
    ch.send(seeded(64, 2));
    ch.send(new DataView(seeded(10, 3).buffer));
    ch.send(new Blob([seeded(300, 4)]));
    ch.send(seeded(200000, 5));
    log.buffered = ch.bufferedAmount > 0;
    ch.send('bye');
    const t0 = Date.now();
    while (got.length < 8 && Date.now() - t0 < 10000) // all eight, the Blob's read included
        await new Promise((r) => setTimeout(r, 20));
    log.got = got;
    while (echoes.length < 2 && Date.now() - t0 < 10000)
        await new Promise((r) => setTimeout(r, 20));
    log.echoes = echoes;
    // binaryType blob on the receiving side.
    rc.binaryType = 'blob';
    const blobMsg = wait(rc, 'message');
    ch.send(seeded(16, 6));
    const bm = await blobMsg;
    log.blob = [tag(bm.data), bm.data.size, fnv(new Uint8Array(await bm.data.arrayBuffer()))];
    // bufferedamountlow
    ch.bufferedAmountLowThreshold = 1024;
    const low = wait(ch, 'bufferedamountlow');
    ch.send(seeded(65536, 7));
    await low;
    log.low = ch.bufferedAmount <= 1024;
    // A second channel from b, negotiated in-band.
    const back = b.createDataChannel('back');
    const arrived = wait(a, 'datachannel');
    const ad = (await arrived).channel;
    if (ad.readyState !== 'open')
        await wait(ad, 'open');
    log.second = [ad.label, ad.id === back.id, back.readyState];
    // Stats
    const stats = await a.getStats();
    const types = new Set();
    stats.forEach((s) => types.add(s.type));
    log.stats = [tag(stats), types.has('data-channel'), types.has('transport'), types.has('candidate-pair'), types.has('peer-connection')];
    // Close: the remote side sees closing/close.
    const rClosed = wait(rc, 'close');
    const states = [];
    rc.addEventListener('closing', () => states.push('closing'));
    ch.addEventListener('close', () => states.push('local close'));
    ch.close();
    states.push('after close() ' + ch.readyState);
    await rClosed;
    states.push('remote close ' + rc.readyState);
    log.close = states;
    a.close();
    b.close();
    log.final = [a.signalingState, a.connectionState, ch.readyState];
    // Event order differs between runs only in the ICE gathering/connection interleaving; keep what is deterministic.
    for (const k of ['a', 'b'])
        log[k] = log[k].filter((l) => !/^icegatheringstatechange|^connectionstatechange|^icecandidate null|^addIceCandidate/.test(l));
    log.candidates = { a: summary(log.candidates.a), b: summary(log.candidates.b) };
    return log;
}
const summary = (list) => ({ count: list.length > 0, anyRawIp: list.some((c) => c.type === 'host' && c.ip), hostMdns: list.filter((c) => c.type === 'host').every((c) => c.mdns) });

// Media: a capture (Chrome's fake devices in the test browser) sent from one peer to the other, shown in <video>s.
async function media() {
    const out = {};
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: true });
    out.local = [stream.getTracks().map((t) => t.kind).sort().join(','), stream.active, tag(stream), stream.getVideoTracks()[0].readyState, typeof stream.getVideoTracks()[0].getSettings().width];
    const local = document.getElementById('local');
    local.srcObject = stream;
    out.localSame = local.srcObject === stream;
    await local.play();
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    const tracks = [];
    const gotTrack = new Promise((resolve) => {
        b.ontrack = (e) => {
            tracks.push([e.track.kind, e.streams.length, e.streams[0] && e.streams[0].id === stream.id, tag(e), tag(e.receiver), tag(e.transceiver), e.transceiver.mid !== null]);
            if (tracks.length === 2)
                resolve(e.streams[0]);
        };
    });
    for (const t of stream.getTracks())
        a.addTrack(t, stream);
    out.senders = a.getSenders().map((s) => s.track.kind).sort().join(',');
    out.transceivers = a.getTransceivers().map((t) => [t.direction, t.mid]);
    const offer = await a.createOffer();
    out.offer = [/m=audio/.test(offer.sdp), /m=video/.test(offer.sdp), /a=msid:/.test(offer.sdp)];
    await a.setLocalDescription(offer);
    await b.setRemoteDescription(offer);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
    out.mids = a.getTransceivers().map((t) => [t.mid !== null, t.currentDirection]);
    const remoteStream = await gotTrack;
    out.tracks = tracks.sort();
    const remote = document.getElementById('remote');
    remote.srcObject = remoteStream;
    await remote.play().catch((e) => { out.playError = e.name; });
    const t0 = Date.now();
    while ((remote.videoWidth === 0 || b.connectionState !== 'connected') && Date.now() - t0 < 15000)
        await new Promise((r) => setTimeout(r, 50));
    out.remoteSize = [remote.videoWidth, remote.videoHeight];
    out.connected = [a.connectionState, b.connectionState];
    // Inbound video arrives: frames decoded on the receiving side.
    let frames = 0;
    const t1 = Date.now();
    while (frames === 0 && Date.now() - t1 < 10000) {
        const st = await b.getStats();
        st.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') frames = s.framesDecoded || 0; });
        if (!frames)
            await new Promise((r) => setTimeout(r, 200));
    }
    out.framesDecoded = frames > 0;
    // Replace and stop.
    const vt = stream.getVideoTracks()[0];
    const sender = a.getSenders().find((s) => s.track && s.track.kind === 'video');
    await sender.replaceTrack(null);
    out.replaced = sender.track === null;
    const ended = [];
    vt.onended = () => ended.push('ended event');
    vt.stop();
    out.stopped = [vt.readyState, ended.length];
    a.close();
    b.close();
    out.afterClose = remoteStream.getTracks().map((t) => t.readyState).join(',');
    for (const t of stream.getTracks())
        t.stop();
    return out;
}

window.dcResult = null;
window.mediaResult = null;
window.shapeResult = null;
try {
    window.shapeResult = shape();
} catch (e) {
    window.shapeResult = { error: e.name + ': ' + e.message };
}
window.runDataChannels = () => dataChannels().then((r) => { window.dcResult = r; return r; }, (e) => { const c = window.dcLog && window.dcLog.candidates; window.dcResult = { error: String(e && e.message || e), candidates: c && Array.isArray(c.a) ? { a: summary(c.a), b: summary(c.b) } : null }; return window.dcResult; });
window.runMedia = () => media().then((r) => { window.mediaResult = r; return r; }, (e) => { window.mediaResult = { error: e.name + ': ' + e.message }; return window.mediaResult; });
document.getElementById('s').textContent = 'ready';
