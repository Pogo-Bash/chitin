// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Media: a VP9/Opus WebM through <video> (metadata, event order, a muted play and pause), MSE, canPlayType, Web Audio offline.
WB.section('media', async (t) => {
    await t.check('canPlayType', () => { const v = document.createElement('video'); return ['video/webm; codecs="vp9, opus"', 'video/webm; codecs="vp8"', 'video/mp4; codecs="avc1.42E01E"', 'audio/ogg; codecs="vorbis"', 'audio/mpeg', 'audio/wav', 'video/x-nope'].map((m) => m + '=' + v.canPlayType(m)); });
    await t.check('video', async () => {
        const v = document.createElement('video');
        const L = [];
        for (const ev of ['loadstart', 'durationchange', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'play', 'playing', 'pause', 'seeking', 'seeked', 'ended', 'error', 'emptied', 'ratechange', 'volumechange'])
            v.addEventListener(ev, () => { if (L[L.length - 1] !== ev) L.push(ev); });
        v.muted = true; v.preload = 'auto'; v.width = 160;
        v.src = 'vp9-opus.webm';
        t.root.append(v);
        await t.withTimeout(new Promise((r) => v.addEventListener('canplay', r, { once: true })), 15000, 'canplay');
        const meta = [v.videoWidth, v.videoHeight, t.round(v.duration, 1), v.readyState >= 3, v.networkState, v.paused, v.buffered.length];
        await v.play();
        await t.sleep(300);
        v.pause();
        const advanced = v.currentTime > 0;
        v.currentTime = 0.5;
        await t.withTimeout(new Promise((r) => v.addEventListener('seeked', r, { once: true })), 10000, 'seeked');
        v.playbackRate = 2;
        const c = document.createElement('canvas'); c.width = 32; c.height = 18;
        c.getContext('2d').drawImage(v, 0, 0, 32, 18);
        const frame = t.pixHash(c.getContext('2d').getImageData(0, 0, 32, 18), 20);
        const quality = v.getVideoPlaybackQuality ? 'yes' : 'no';
        v.removeAttribute('src'); v.load();
        return { meta, advanced, currentTime: t.round(v.currentTime, 1), order: L, frame, quality };
    });
    await t.check('mse', async () => {
        if (!window.MediaSource) return 'no MediaSource';
        const type = 'video/webm; codecs="vp9, opus"';
        const ms = new MediaSource();
        const v = document.createElement('video'); v.muted = true;
        const L = [];
        ms.addEventListener('sourceopen', () => L.push('sourceopen:' + ms.readyState));
        v.src = URL.createObjectURL(ms);
        await t.withTimeout(new Promise((r) => ms.addEventListener('sourceopen', r, { once: true })), 10000, 'sourceopen');
        const sb = ms.addSourceBuffer(type);
        for (const ev of ['updatestart', 'update', 'updateend', 'error', 'abort']) sb.addEventListener(ev, () => L.push(ev));
        const buf = await (await fetch('vp9-opus.webm')).arrayBuffer();
        sb.appendBuffer(buf);
        await t.withTimeout(new Promise((r) => sb.addEventListener('updateend', r, { once: true })), 15000, 'updateend');
        ms.endOfStream();
        L.push('ended:' + ms.readyState);
        return { supported: MediaSource.isTypeSupported(type), order: L, buffered: sb.buffered.length ? [t.round(sb.buffered.start(0), 1), t.round(sb.buffered.end(0), 1)] : [], duration: t.round(ms.duration, 1), mode: sb.mode };
    });
    await t.check('offlineAudio', async () => {
        const ctx = new OfflineAudioContext(1, 4410, 44100);
        const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 441;
        const g = ctx.createGain(); g.gain.setValueAtTime(0.5, 0); g.gain.linearRampToValueAtTime(0, 0.1);
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2000;
        o.connect(f).connect(g).connect(ctx.destination); o.start();
        const buf = await ctx.startRendering();
        const d = buf.getChannelData(0);
        let sum = 0, abs = 0, zc = 0;
        for (let i = 0; i < d.length; i++) { sum += d[i]; abs += Math.abs(d[i]); if (i && (d[i] >= 0) !== (d[i - 1] >= 0)) zc++; }
        return { length: buf.length, rate: buf.sampleRate, sum: t.approx(t.round(sum, 2), 0.5), abs: t.approx(t.round(abs, 1), abs * 0.02 + 1), zc: t.approx(zc, 3), sample100: t.approx(t.round(d[100], 3), 0.02) };
    });
    await t.check('audioContext', async () => {
        const ac = new AudioContext();
        const s = [ac.state, ac.sampleRate > 0, typeof ac.baseLatency];
        await ac.close();
        return [...s, ac.state];
    });
    await t.check('audioElement', async () => {
        const a = new Audio(); const L = [];
        for (const ev of ['loadstart', 'loadedmetadata', 'canplay', 'error']) a.addEventListener(ev, () => L.push(ev));
        a.preload = 'metadata'; a.src = 'vp9-opus.webm';
        await t.withTimeout(new Promise((r) => { a.addEventListener('loadedmetadata', r, { once: true }); a.addEventListener('error', r, { once: true }); }), 10000, 'audio metadata');
        return [L.slice(0, 2), t.round(a.duration, 1)];
    });
}, { timeout: 45000 });
