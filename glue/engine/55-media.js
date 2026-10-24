// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin engine glue: media decoding for the engine's media server (engine/platform/Media.cpp) on the host's
// WebCodecs (VideoDecoder, AudioDecoder; a dedicated Worker has both). Encoded samples come out of the engine,
// decoded planes go back in. The WebCodecs constructors are captured when the glue loads, before any page script.
// A host without WebCodecs (Node tests) passes callbacks.createMediaDecoder and callbacks.mediaCodecs instead.
//
// Audio: decoded PCM (planar float) goes to callbacks.audio, the segment host's output (in the segment Worker: a port
// to the carapace's AudioWorklet, harness/carapace/audio-worklet.js), never back into the engine; the engine hears
// how far it was decoded and, from the output, the media time being heard, which then drives its clock.
//   callbacks.audio = { open(id, onProgress(playedUs, queuedUs, flags)), write(id, timestampUs, sampleRate, planes),
//                       control(id, { playing, volume, rate, syncUs }), close(id) }

const HostVideoDecoder = globalThis.VideoDecoder;
const HostAudioDecoder = globalThis.AudioDecoder;
const HostEncodedVideoChunk = globalThis.EncodedVideoChunk;
const HostEncodedAudioChunk = globalThis.EncodedAudioChunk;
const VideoDecoderPrototypeConfigure = HostVideoDecoder ? uncurryThis(HostVideoDecoder.prototype.configure) : null;
const VideoDecoderPrototypeDecode = HostVideoDecoder ? uncurryThis(HostVideoDecoder.prototype.decode) : null;
const VideoDecoderPrototypeFlush = HostVideoDecoder ? uncurryThis(HostVideoDecoder.prototype.flush) : null;
const VideoDecoderPrototypeClose = HostVideoDecoder ? uncurryThis(HostVideoDecoder.prototype.close) : null;
const VideoDecoderIsConfigSupported = HostVideoDecoder ? HostVideoDecoder.isConfigSupported : null;
const AudioDecoderIsConfigSupported = HostAudioDecoder ? HostAudioDecoder.isConfigSupported : null;
const HostVideoFrame = globalThis.VideoFrame;
const VideoFramePrototypeCopyTo = HostVideoFrame ? uncurryThis(HostVideoFrame.prototype.copyTo) : null;
const VideoFramePrototypeAllocationSize = HostVideoFrame ? uncurryThis(HostVideoFrame.prototype.allocationSize) : null;
const VideoFramePrototypeClose = HostVideoFrame ? uncurryThis(HostVideoFrame.prototype.close) : null;
const VideoFrameGetFormat = HostVideoFrame ? uncurryThis(Object.getOwnPropertyDescriptor(HostVideoFrame.prototype, 'format').get) : null;
const VideoFrameGetTimestamp = HostVideoFrame ? uncurryThis(Object.getOwnPropertyDescriptor(HostVideoFrame.prototype, 'timestamp').get) : null;
const VideoFrameGetDuration = HostVideoFrame ? uncurryThis(Object.getOwnPropertyDescriptor(HostVideoFrame.prototype, 'duration').get) : null;
const VideoFrameGetVisibleRect = HostVideoFrame ? uncurryThis(Object.getOwnPropertyDescriptor(HostVideoFrame.prototype, 'visibleRect').get) : null;
const FunctionPrototypeCall = uncurryThis(HostFunction.prototype.call);
const HostUint8ArrayMedia = globalThis.Uint8Array;
const HostFloat32ArrayMedia = globalThis.Float32Array;
const AudioDecoderPrototypeConfigure = HostAudioDecoder ? uncurryThis(HostAudioDecoder.prototype.configure) : null;
const AudioDecoderPrototypeDecode = HostAudioDecoder ? uncurryThis(HostAudioDecoder.prototype.decode) : null;
const AudioDecoderPrototypeFlush = HostAudioDecoder ? uncurryThis(HostAudioDecoder.prototype.flush) : null;
const AudioDecoderPrototypeClose = HostAudioDecoder ? uncurryThis(HostAudioDecoder.prototype.close) : null;
const HostAudioData = globalThis.AudioData;
const audioDataGetter = (name) => HostAudioData ? uncurryThis(Object.getOwnPropertyDescriptor(HostAudioData.prototype, name).get) : null;
const AudioDataGetFrames = audioDataGetter('numberOfFrames');
const AudioDataGetChannels = audioDataGetter('numberOfChannels');
const AudioDataGetSampleRate = audioDataGetter('sampleRate');
const AudioDataGetTimestamp = audioDataGetter('timestamp');
const AudioDataPrototypeCopyTo = HostAudioData ? uncurryThis(HostAudioData.prototype.copyTo) : null;
const AudioDataPrototypeClose = HostAudioData ? uncurryThis(HostAudioData.prototype.close) : null;

const mediaDecoders = { __proto__: null };

// Video on the host (docs/youtube.md): with the GPU compositor a decoded frame stays here as an ImageBitmap (its
// VideoFrame closed at once, so a hardware decoder gets its buffer back) and the engine gets a handle; the carapace
// draws the bitmap where the engine's video layer is. The engine asks for the pixels (hostFramePlanes) only when it
// draws the frame itself, and releases the handle when nothing holds the frame.
const HostCreateImageBitmap = typeof createImageBitmap === 'function' ? createImageBitmap : null;
const HostOffscreenCanvasMedia = typeof OffscreenCanvas === 'function' ? OffscreenCanvas : null;
const hostFrames = new HostMap();
let nextHostFrame = 1;
let readbackCanvas = null;
function hostFramesWanted() {
    return !!HostCreateImageBitmap && !!HostOffscreenCanvasMedia && !callbacks.createMediaDecoder && api.compositor() === 'gpu';
}
// The bitmap to show for a host frame: its display copy, handed over once (transferred to the carapace); a frame shown
// again (a new layer) gets a copy of the kept one.
api.takeHostVideoFrame = (handle) => {
    const f = MapPrototypeGet(hostFrames, handle);
    if (f === undefined)
        return null;
    const show = f.show;
    f.show = null;
    return show ? [show, true] : [f.keep, false]; // [bitmap, whether it may be transferred]
};
api.hostVideoFrameCount = () => hostFrames.size;

// The probe's codec strings, one per family the engine asks about (Media.cpp family_of).
const MEDIA_PROBES = [
    ['vp8', 'video', { codec: 'vp8' }],
    ['vp9', 'video', { codec: 'vp09.00.10.08' }],
    ['av1', 'video', { codec: 'av01.0.04M.08' }],
    ['h264', 'video', { codec: 'avc1.42E01E' }],
    ['h265', 'video', { codec: 'hev1.1.6.L93.B0' }],
    ['opus', 'audio', { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 }],
    ['vorbis', 'audio', { codec: 'vorbis', sampleRate: 48000, numberOfChannels: 2 }],
    ['aac', 'audio', { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 }],
    ['flac', 'audio', { codec: 'flac', sampleRate: 48000, numberOfChannels: 2 }],
    ['mp3', 'audio', { codec: 'mp3', sampleRate: 48000, numberOfChannels: 2 }],
];

// Asks the host which codec families it decodes and tells the engine (canPlayType, isTypeSupported). Resolves
// once the engine knows; the segment host awaits it before the first page.
api.probeMediaCodecs = async () => {
    let families = [];
    if (callbacks.mediaCodecs) {
        families = callbacks.mediaCodecs;
    } else {
        for (let i = 0; i < MEDIA_PROBES.length; i++) {
            const probe = MEDIA_PROBES[i];
            const check = probe[1] === 'video' ? VideoDecoderIsConfigSupported : AudioDecoderIsConfigSupported;
            if (!check)
                continue;
            try {
                const result = await FunctionPrototypeCall(check, probe[1] === 'video' ? HostVideoDecoder : HostAudioDecoder, probe[2]);
                if (result && result.supported)
                    families[families.length] = probe[0];
            } catch (e) {
            }
        }
    }
    let text = '';
    for (let i = 0; i < families.length; i++)
        text += (i ? '\n' : '') + families[i];
    const ptr = copyInString(text);
    try {
        X.ganglion_media_set_codec_support(ptr, TextEncoderPrototypeEncode(encoderUtf8, text).length);
    } finally {
        X.ganglion_free(ptr);
    }
    return families;
};

// Planes in the layout the engine takes: Y, U, V one after another, tightly packed; chroma 0 4:2:0, 1 4:2:2, 2 4:4:4.
const VIDEO_FORMATS = { __proto__: null, I420: [0, 8, 3], I420A: [0, 8, 3], I422: [1, 8, 3], I444: [2, 8, 3], I420P10: [0, 10, 3], I422P10: [1, 10, 3], I444P10: [2, 10, 3], NV12: [0, 8, 2] };

async function planesOfVideoFrame(frame) {
    const format = VideoFrameGetFormat(frame);
    const rect = VideoFrameGetVisibleRect(frame);
    const width = rect.width, height = rect.height;
    const info = VIDEO_FORMATS[format];
    if (!info)
        throw new HostError('unsupported frame format ' + format);
    const chroma = info[0], bitDepth = info[1];
    const bytesPerSample = bitDepth > 8 ? 2 : 1;
    const cw = chroma === 2 ? width : (width + 1) >> 1;
    const ch = chroma === 0 ? (height + 1) >> 1 : height;
    const ySize = width * height * bytesPerSample;
    const cSize = cw * ch * bytesPerSample;
    const out = new HostUint8ArrayMedia(ySize + 2 * cSize);
    if (info[2] === 3) {
        // Ask for exactly our layout (the alpha plane of I420A, if any, after it in a scratch buffer).
        const layout = [{ offset: 0, stride: width * bytesPerSample }, { offset: ySize, stride: cw * bytesPerSample }, { offset: ySize + cSize, stride: cw * bytesPerSample }];
        if (format === 'I420A') {
            const scratch = new HostUint8ArrayMedia(ySize * 2 + 2 * cSize);
            layout[3] = { offset: ySize + 2 * cSize, stride: width };
            await VideoFramePrototypeCopyTo(frame, scratch, { layout });
            for (let i = 0; i < out.length; i++)
                out[i] = scratch[i];
        } else {
            await VideoFramePrototypeCopyTo(frame, out, { layout });
        }
    } else {
        // NV12: interleaved UV, split here.
        const scratch = new HostUint8ArrayMedia(ySize + 2 * cSize);
        await VideoFramePrototypeCopyTo(frame, scratch, { layout: [{ offset: 0, stride: width }, { offset: ySize, stride: cw * 2 }] });
        for (let i = 0; i < ySize; i++)
            out[i] = scratch[i];
        for (let i = 0; i < cSize; i++) {
            out[ySize + i] = scratch[ySize + 2 * i];
            out[ySize + cSize + i] = scratch[ySize + 2 * i + 1];
        }
    }
    return { width, height, chroma, bitDepth, planes: out };
}

// A WebCodecs AudioDecoder: each AudioData leaves as planar float, one Float32Array per channel.
function webCodecsAudioDecoder(config, sink) {
    if (!HostAudioDecoder)
        return null;
    const decoder = new HostAudioDecoder({
        output: (data) => {
            try {
                const frames = AudioDataGetFrames(data), channels = AudioDataGetChannels(data);
                const planes = [];
                for (let c = 0; c < channels; c++) {
                    const plane = new HostFloat32ArrayMedia(frames);
                    AudioDataPrototypeCopyTo(data, plane, { planeIndex: c, format: 'f32-planar' });
                    planes[c] = plane;
                }
                sink.audio({ __proto__: null, timestamp: AudioDataGetTimestamp(data), sampleRate: AudioDataGetSampleRate(data), planes });
            } catch (e) {
                sink.error('' + e);
            } finally {
                AudioDataPrototypeClose(data);
            }
        },
        error: (e) => sink.error('' + (e && e.message || e) + ' (' + options.codec + ', ' + options.sampleRate + ' Hz, ' + options.numberOfChannels + ' channels, description ' + (options.description ? options.description.length + ' bytes' : 'none') + ')'),
    });
    const options = { codec: config.codec, sampleRate: config.sampleRate || 48000, numberOfChannels: config.channels || 2 };
    if (config.description && config.description.length)
        options.description = config.description;
    // An Opus stream's own header (OpusHead) has its channel count, and Opus decodes at 48 kHz: Chrome refuses a
    // configuration whose channel count differs from the header's (a container may say otherwise; LibMedia's track
    // gives 2 for the mono test clip).
    const d = options.description;
    if (config.codec === 'opus' && d && d.length >= 19 && d[0] === 0x4f && d[1] === 0x70 && d[2] === 0x75 && d[3] === 0x73 && d[9] > 0) {
        options.numberOfChannels = d[9];
        options.sampleRate = 48000;
    }
    AudioDecoderPrototypeConfigure(decoder, options);
    return {
        decode: (chunk) => AudioDecoderPrototypeDecode(decoder, new HostEncodedAudioChunk({ type: 'key', timestamp: chunk.timestamp, duration: chunk.duration || undefined, data: chunk.data })),
        flush: () => AudioDecoderPrototypeFlush(decoder),
        close: () => { try { AudioDecoderPrototypeClose(decoder); } catch (e) { } },
    };
}

// A WebCodecs decoder behind the interface the engine's imports use (and a fake one in tests implements).
function webCodecsDecoder(config, sink) {
    if (config.kind === 1)
        return webCodecsAudioDecoder(config, sink);
    if (config.kind !== 0 || !HostVideoDecoder)
        return null;
    // Outputs are copied out in order: each waits for the one before it.
    let chain = HostPromise.resolve();
    const decoder = new HostVideoDecoder({
        output: (frame) => {
            const timestamp = VideoFrameGetTimestamp(frame);
            const duration = VideoFrameGetDuration(frame) || 0;
            if (hostFramesWanted() && sink.hostFrame) {
                const rect = VideoFrameGetVisibleRect(frame);
                const width = rect.width, height = rect.height;
                // Two bitmaps: one the engine may read back (drawImage of the video, WebGL uploads), one transferred to
                // the carapace (a structured clone of an ImageBitmap copies its pixels on this thread: ~5 ms a 1080p frame).
                chain = PromisePrototypeThen(chain, () => PromisePrototypeThen(HostCreateImageBitmap(frame, { resizeWidth: width, resizeHeight: height }), (keep) => {
                    VideoFramePrototypeClose(frame);
                    return PromisePrototypeThen(HostCreateImageBitmap(keep), (show) => sink.hostFrame(keep, show, timestamp, duration, width, height), (e) => { keep.close(); sink.error('' + e); });
                }, (e) => {
                    VideoFramePrototypeClose(frame);
                    sink.error('' + e);
                }));
                return;
            }
            chain = PromisePrototypeThen(chain, () => PromisePrototypeThen(planesOfVideoFrame(frame), (p) => {
                VideoFramePrototypeClose(frame);
                p.timestamp = timestamp;
                p.duration = duration;
                sink.frame(p);
            }, (e) => {
                VideoFramePrototypeClose(frame);
                sink.error('' + e);
            }));
        },
        error: (e) => sink.error('' + (e && e.message || e)),
    });
    // optimizeForLatency: each frame comes out as soon as it is decoded; otherwise the decoder holds several back, and the
    // few frames the engine keeps ahead (Media.cpp) run out after a seek.
    const options = { codec: config.codec, optimizeForLatency: true };
    if (config.description && config.description.length)
        options.description = config.description;
    if (config.width)
        options.codedWidth = config.width;
    if (config.height)
        options.codedHeight = config.height;
    VideoDecoderPrototypeConfigure(decoder, options);
    return {
        decode: (chunk) => VideoDecoderPrototypeDecode(decoder, new HostEncodedVideoChunk({ type: chunk.key ? 'key' : 'delta', timestamp: chunk.timestamp, duration: chunk.duration || undefined, data: chunk.data })),
        flush: () => PromisePrototypeThen(VideoDecoderPrototypeFlush(decoder), () => chain),
        close: () => { try { VideoDecoderPrototypeClose(decoder); } catch (e) { } },
    };
}

const webAudioStreams = { __proto__: null };
let nextWebAudioStream = 0x40000000;
function addMediaImports(env) {
    env.ganglion_host_media_decoder_create = (id, kind, codecPtr, codecLen, descPtr, descLen, width, height, sampleRate, channels) => {
        const config = { __proto__: null, kind, codec: bytesToString(codecPtr, codecLen), description: copyOutBytes(descPtr, descLen), width, height, sampleRate, channels };
        const sink = {
            __proto__: null,
            frame: (p) => {
                if (!mediaDecoders[id])
                    return;
                const ptr = copyIn(p.planes);
                try {
                    X.ganglion_media_video_frame(id, p.timestamp, p.duration, p.width, p.height, p.chroma, p.bitDepth, ptr, p.planes.length);
                } finally {
                    X.ganglion_free(ptr);
                }
                api.pump();
            },
            hostFrame: (keep, show, timestamp, duration, width, height) => {
                if (!mediaDecoders[id]) {
                    keep.close();
                    show.close();
                    return;
                }
                const handle = nextHostFrame++;
                MapPrototypeSet(hostFrames, handle, { __proto__: null, keep, show });
                X.ganglion_media_video_frame_host(id, timestamp, duration, width, height, handle);
                api.pump();
            },
            audio: (a) => {
                if (!mediaDecoders[id])
                    return;
                const frames = a.planes.length ? a.planes[0].length : 0;
                const end = a.timestamp + (frames * 1e6) / a.sampleRate;
                if (callbacks.audio)
                    callbacks.audio.write(id, a.timestamp, a.sampleRate, a.planes);
                X.ganglion_media_audio_decoded(id, end);
                api.pump();
            },
            error: (message) => {
                if (!mediaDecoders[id])
                    return;
                const ptr = copyInString(message);
                try {
                    X.ganglion_media_decoder_error(id, ptr, TextEncoderPrototypeEncode(encoderUtf8, message).length);
                } finally {
                    X.ganglion_free(ptr);
                }
                api.pump();
            },
        };
        let decoder = null;
        try {
            decoder = callbacks.createMediaDecoder ? callbacks.createMediaDecoder(config, sink) : webCodecsDecoder(config, sink);
        } catch (e) {
            engineLog('ganglion: media: the host refused the decoder for ' + config.codec + ': ' + e);
        }
        if (!decoder)
            return 0;
        mediaDecoders[id] = decoder;
        if (kind === 1 && callbacks.audio) {
            callbacks.audio.open(id, (playedUs, queuedUs, flags) => {
                if (!mediaDecoders[id])
                    return;
                X.ganglion_media_audio_progress(id, playedUs, queuedUs, flags);
                api.pump();
            });
        }
        return 1;
    };
    // Web Audio's output (an AudioContext's destination): LibMedia's null stream pulls the graph at the output's pace and
    // hands each period here; it goes to the same host output as media audio (callbacks.audio), a stream of its own whose
    // timeline is the frames written so far. Ids from 0x40000000 never meet a media decoder's.
    env.ganglion_host_webaudio_open = (sampleRate, channels) => {
        if (!callbacks.audio || channels < 1 || channels > 8)
            return 0;
        const id = nextWebAudioStream++;
        webAudioStreams[id] = { __proto__: null, sampleRate, channels, frames: 0 };
        callbacks.audio.open(id, () => {});
        return id;
    };
    env.ganglion_host_webaudio_write = (id, ptr, frames) => {
        const s = webAudioStreams[id];
        if (!s || !callbacks.audio || frames <= 0)
            return;
        views();
        const src = new HostFloat32ArrayMedia(u8.buffer, ptr, frames * s.channels);
        const planes = [];
        for (let c = 0; c < s.channels; c++) {
            const plane = new HostFloat32ArrayMedia(frames);
            for (let i = 0, j = c; i < frames; i++, j += s.channels)
                plane[i] = src[j];
            planes[c] = plane;
        }
        const t = (s.frames * 1e6) / s.sampleRate;
        s.frames += frames;
        callbacks.audio.write(id, t, s.sampleRate, planes);
    };
    env.ganglion_host_webaudio_control = (id, playing, volume) => {
        if (webAudioStreams[id] && callbacks.audio)
            callbacks.audio.control(id, { __proto__: null, playing: !!playing, volume, rate: 1, syncUs: null });
    };
    env.ganglion_host_webaudio_close = (id) => {
        if (!webAudioStreams[id])
            return;
        delete webAudioStreams[id];
        if (callbacks.audio)
            callbacks.audio.close(id);
    };
    env.ganglion_host_media_audio_control = (id, playing, volume, rate, syncUs) => {
        if (mediaDecoders[id] && callbacks.audio)
            callbacks.audio.control(id, { __proto__: null, playing: !!playing, volume, rate, syncUs: syncUs >= 0 ? syncUs : null });
    };
    env.ganglion_host_media_frame_release = (handle) => {
        const f = MapPrototypeGet(hostFrames, handle);
        if (f === undefined)
            return;
        MapPrototypeDelete(hostFrames, handle);
        f.keep.close();
        if (f.show)
            f.show.close();
    };
    // The frame's pixels into three planes (G, B, R: a 4:4:4 frame with the Identity matrix, Media.cpp FrameSink).
    env.ganglion_host_media_frame_planes = (handle, width, height, gPtr, bPtr, rPtr) => {
        const f = MapPrototypeGet(hostFrames, handle);
        const bitmap = f && f.keep;
        if (!bitmap || !(bitmap.width > 0) || !HostOffscreenCanvasMedia)
            return 0;
        if (!readbackCanvas || readbackCanvas.width !== width || readbackCanvas.height !== height)
            readbackCanvas = new HostOffscreenCanvasMedia(width, height);
        const g = readbackCanvas.getContext('2d', { willReadFrequently: true });
        g.drawImage(bitmap, 0, 0, width, height);
        const rgba = g.getImageData(0, 0, width, height).data;
        views();
        const n = width * height;
        for (let i = 0, j = 0; i < n; i++, j += 4) {
            u8[gPtr + i] = rgba[j + 1];
            u8[bPtr + i] = rgba[j + 2];
            u8[rPtr + i] = rgba[j];
        }
        return 1;
    };
    env.ganglion_host_media_decode = (id, ptr, len, timestamp, duration, key) => {
        const decoder = mediaDecoders[id];
        if (!decoder)
            return;
        const data = copyOutBytes(ptr, len);
        try {
            decoder.decode({ __proto__: null, data, timestamp, duration, key: !!key });
        } catch (e) {
            hostSetTimeout(() => { if (mediaDecoders[id]) { const p = copyInString('' + e); try { X.ganglion_media_decoder_error(id, p, ('' + e).length); } finally { X.ganglion_free(p); } api.pump(); } }, 0);
        }
    };
    env.ganglion_host_media_decoder_flush = (id) => {
        const decoder = mediaDecoders[id];
        if (!decoder)
            return;
        PromisePrototypeThen(HostPromise.resolve(decoder.flush()), () => {
            if (!mediaDecoders[id])
                return;
            X.ganglion_media_decoder_flushed(id);
            api.pump();
        }, () => {});
    };
    env.ganglion_host_media_decoder_close = (id) => {
        const decoder = mediaDecoders[id];
        delete mediaDecoders[id];
        if (decoder) {
            decoder.close();
            if (callbacks.audio)
                callbacks.audio.close(id);
        }
    };
}
