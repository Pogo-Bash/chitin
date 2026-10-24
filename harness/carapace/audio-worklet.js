// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// The carapace's audio output for one segment (docs/architecture.md, Media): an AudioWorkletProcessor that plays the
// PCM the segment Worker's AudioDecoder produced (glue/engine/55-media.js, harness/segment/worker.js). The Worker's port
// arrives in a 'line' message on the node's port; over it come, per stream (one per media element's audio decoder):
//   { type: 'open', id }   { type: 'close', id }
//   { type: 'data', id, t (us), sampleRate, planes: [Float32Array per channel] }   (transferred, no SharedArrayBuffer)
//   { type: 'control', id, playing, volume, rate, sync (us, or null) }
// and back on it, every few render quanta, what each playing stream is heard at:
//   { id, played (us, the media time leaving the speakers now), queued (us), flags (1 running, 2 starved) }
// The data is the segment's: everything is checked and bounded, and a stream holds at most MAX_QUEUED_S of it.

const MAX_STREAMS = 32;
const MAX_CHANNELS = 8;
const MAX_FRAMES = 192000;
const MAX_QUEUED_S = 8;
const REPORT_EVERY = 8; // render quanta (128 frames each): about 21 ms at 48 kHz

class ChitinAudio extends AudioWorkletProcessor {
    constructor() {
        super();
        this.streams = new Map();
        this.line = null;
        this.latencyUs = 0;
        this.quanta = 0;
        this.stats = { framesIn: 0, framesOut: 0, crossings: 0, crossingFrames: 0, last: 0, peak: 0, chunks: 0, dropped: 0 };
        this.statsAt = 0;
        this.port.onmessage = (e) => {
            const m = e.data;
            if (!m || typeof m !== 'object')
                return;
            if (m.type === 'line' && e.ports && e.ports[0] && !this.line) {
                this.line = e.ports[0];
                this.line.onmessage = (ev) => this.onLine(ev.data);
            } else if (m.type === 'latency' && Number.isFinite(m.seconds) && m.seconds >= 0 && m.seconds < 2) {
                this.latencyUs = m.seconds * 1e6;
            } else if (m.type === 'stop') {
                this.stopped = true;
                this.streams.clear();
                if (this.line)
                    this.line.close();
            }
        };
    }

    onLine(m) {
        if (!m || typeof m !== 'object' || !Number.isInteger(m.id) || m.id < 0)
            return;
        let s = this.streams.get(m.id);
        if (m.type === 'open') {
            if (!s && this.streams.size < MAX_STREAMS)
                this.streams.set(m.id, { queue: [], pos: 0, playing: false, volume: 1, rate: 1, started: false, quanta: 0, queuedFrames: 0 });
            return;
        }
        if (!s)
            return;
        if (m.type === 'close') {
            this.streams.delete(m.id);
        } else if (m.type === 'control') {
            s.playing = m.playing === true;
            if (Number.isFinite(m.volume))
                s.volume = Math.min(1, Math.max(0, m.volume));
            if (Number.isFinite(m.rate) && m.rate > 0 && m.rate <= 16)
                s.rate = m.rate;
            if (Number.isFinite(m.sync))
                this.trim(s, m.sync);
        } else if (m.type === 'data') {
            const planes = m.planes;
            if (!Array.isArray(planes) || planes.length < 1 || planes.length > MAX_CHANNELS || !Number.isFinite(m.t) || !Number.isFinite(m.sampleRate) || m.sampleRate < 3000 || m.sampleRate > 384000)
                return;
            const frames = planes[0] instanceof Float32Array ? planes[0].length : -1;
            if (frames < 1 || frames > MAX_FRAMES)
                return;
            for (const p of planes)
                if (!(p instanceof Float32Array) || p.length !== frames)
                    return;
            this.stats.chunks++;
            this.stats.framesIn += frames;
            this.measure(planes[0]);
            this.stats.sr = m.sampleRate;
            s.queue.push({ t: m.t, sr: m.sampleRate, planes, frames });
            s.queuedFrames += frames;
            // Bounded: the oldest goes first.
            while (s.queue.length > 1 && s.queuedFrames > MAX_QUEUED_S * s.queue[0].sr) {
                const old = s.queue.shift();
                s.queuedFrames -= old.frames;
                s.pos = 0;
                this.stats.dropped += old.frames;
            }
        }
    }

    // Positive-going zero crossings of the first channel, for the harness's frequency check (a 440 Hz tone).
    measure(plane) {
        let last = this.stats.last;
        for (let i = 0; i < plane.length; i++) {
            const v = plane[i];
            if (last <= 0 && v > 0)
                this.stats.crossings++;
            last = v;
        }
        this.stats.last = last;
        this.stats.crossingFrames += plane.length;
    }

    // Drops what lies before media time `us` (the engine's clock, while this output does not lead it).
    trim(s, us) {
        while (s.queue.length) {
            const head = s.queue[0];
            const end = head.t + (head.frames * 1e6) / head.sr;
            if (end > us)
                break;
            s.queue.shift();
            s.queuedFrames -= head.frames;
            s.pos = 0;
        }
        if (s.queue.length) {
            const head = s.queue[0];
            const at = ((us - head.t) * head.sr) / 1e6;
            if (at > s.pos)
                s.pos = Math.min(at, head.frames - 1);
        }
    }

    position(s) {
        if (!s.queue.length)
            return null;
        const head = s.queue[0];
        return head.t + (s.pos * 1e6) / head.sr;
    }

    process(inputs, outputs) {
        if (this.stopped)
            return false;
        const out = outputs[0];
        const left = out[0], right = out[1] || out[0];
        const n = left.length;
        this.quanta++;
        for (const [id, s] of this.streams) {
            const startPos = this.position(s);
            let underrun = false;
            if (s.playing) {
                for (let i = 0; i < n; i++) {
                    let head = s.queue[0];
                    while (head && s.pos >= head.frames) {
                        s.pos -= head.frames;
                        s.queue.shift();
                        s.queuedFrames -= head.frames;
                        head = s.queue[0];
                    }
                    if (!head) {
                        underrun = s.started;
                        break;
                    }
                    s.started = true;
                    const k = Math.floor(s.pos), f = s.pos - k;
                    const a = head.planes[0], b = head.planes.length > 1 ? head.planes[1] : head.planes[0];
                    const k1 = k + 1 < head.frames ? k + 1 : k;
                    const l = a[k] + (a[k1] - a[k]) * f;
                    const r = b[k] + (b[k1] - b[k]) * f;
                    left[i] += l * s.volume;
                    if (right !== left)
                        right[i] += r * s.volume;
                    s.pos += (head.sr / sampleRate) * s.rate;
                    this.stats.framesOut++;
                }
            }
            if (this.line && s.playing && ++s.quanta % REPORT_EVERY === 0) {
                const played = startPos === null ? (this.position(s) ?? 0) : startPos;
                let queued = 0;
                for (const c of s.queue)
                    queued += (c.frames * 1e6) / c.sr;
                this.line.postMessage({ id, played: Math.max(0, played - this.latencyUs), queued, flags: 1 | (underrun || !s.queue.length ? 2 : 0) });
            }
        }
        for (let i = 0; i < n; i++)
            this.stats.peak = Math.max(this.stats.peak, Math.abs(left[i]));
        if (currentTime - this.statsAt >= 0.5) {
            this.statsAt = currentTime;
            const st = this.stats;
            const hz = st.crossingFrames ? Math.round((st.crossings * (st.sr || sampleRate)) / st.crossingFrames) : 0;
            this.port.postMessage({ type: 'stats', streams: this.streams.size, chunks: st.chunks, framesIn: st.framesIn, framesOut: st.framesOut, hz, peak: Math.round(st.peak * 1000) / 1000, dropped: st.dropped, sampleRate });
            st.peak = 0;
        }
        return true;
    }
}

registerProcessor('chitin-audio', ChitinAudio);
