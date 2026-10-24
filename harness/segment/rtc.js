// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// WebRTC and media capture for a segment's page (docs/webrtc.md). Loaded with importScripts before the host's doors are removed
// (harness/segment/doors.js). The page's RTCPeerConnection, RTCDataChannel, MediaStream and MediaStreamTrack are the interfaces
// of this file; each one stands for a real object of the host browser in the segment *document* (harness/segment/rtc-host.js),
// which owns the host's RTCPeerConnection, its ICE (STUN, TURN, mDNS host candidates: Chrome's own rules) and the capture
// devices behind the host's own permission prompts. A Worker has no RTCPeerConnection, and the page's code is not edited: every
// call here is the page's own call, carried over one MessagePort as plain data.
//
// It defines `__chitinRTC`, which the caller takes and deletes from the global.
'use strict';
(() => {
    const G = self;
    const defineProperty = Object.defineProperty;
    const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    const ReflectApply = Reflect.apply;
    const HostPromise = G.Promise;
    const HostMap = Map;
    const HostSet = Set;
    const HostWeakMap = WeakMap;
    const HostArrayBuffer = G.ArrayBuffer;
    const HostUint8Array = G.Uint8Array;
    const HostTextEncoder = G.TextEncoder;
    const arrayBufferIsView = HostArrayBuffer.isView;
    const randomUUID = G.crypto && G.crypto.randomUUID ? G.crypto.randomUUID.bind(G.crypto) : () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => ((Math.random() * 16) | (c === 'x' ? 0 : 8)).toString(16));
    const hostSetTimeout = G.setTimeout.bind(G);
    const encoder = new HostTextEncoder();

    const SIGNALING = ['stable', 'have-local-offer', 'have-remote-offer', 'have-local-pranswer', 'have-remote-pranswer', 'closed'];
    const SDP_TYPES = ['offer', 'pranswer', 'answer', 'rollback'];
    const DIRECTIONS = ['sendrecv', 'sendonly', 'recvonly', 'inactive', 'stopped'];

    // A candidate-attribute (RFC 8839 section 5.1) as RTCIceCandidate's members: what Chrome parses out of `candidate`.
    function parseCandidate(text) {
        const none = { foundation: null, component: null, priority: null, address: null, protocol: null, port: null, type: null, tcpType: null, relatedAddress: null, relatedPort: null, usernameFragment: null };
        let s = String(text);
        if (s.startsWith('a='))
            s = s.slice(2);
        if (!s.startsWith('candidate:') || /^\s/.test(s.slice(10)))
            return none;
        const f = s.slice(10).split(' ').filter((x) => x !== '');
        const digits = (x, max) => /^\d+$/.test(x) && x.length <= max;
        // Chrome's parser: numbers are digits only (priority at most 10), the type one of four, a TCP type one of three.
        if (f.length < 8 || f[6] !== 'typ' || !digits(f[1], 5) || !digits(f[3], 10) || !digits(f[5], 5) || !['host', 'srflx', 'prflx', 'relay'].includes(f[7]))
            return none;
        const out = { ...none };
        out.foundation = f[0];
        out.component = f[1] === '1' ? 'rtp' : f[1] === '2' ? 'rtcp' : null;
        out.protocol = f[2].toLowerCase() === 'udp' ? 'udp' : f[2].toLowerCase() === 'tcp' ? 'tcp' : null;
        out.priority = Number(f[3]) >>> 0;
        out.address = f[4];
        out.port = Number(f[5]) | 0;
        out.type = f[7];
        for (let i = 8; i + 1 < f.length; i += 2) {
            if (f[i] === 'raddr') out.relatedAddress = f[i + 1];
            else if (f[i] === 'rport') {
                if (!digits(f[i + 1], 5))
                    return none;
                out.relatedPort = Number(f[i + 1]) | 0;
            } else if (f[i] === 'tcptype') {
                if (!['active', 'passive', 'so'].includes(f[i + 1]))
                    return none;
                out.tcpType = f[i + 1];
            }
        }
        return out;
    }

    function create() {
        // `P` is the page's realm; `options`: { port (to rtc-host.js), dispatch(target, event) (trusted events), enabled }.
        function install(P, options) {
            const port = options.port;
            const PDOMException = P.DOMException;
            const PTypeError = P.TypeError || TypeError;
            const PEventTarget = P.EventTarget;
            const PEvent = P.Event;
            const PMessageEvent = P.MessageEvent;
            const PBlob = P.Blob;
            const PPromise = P.Promise || HostPromise;
            const dom = (message, name) => new PDOMException(message, name);
            const illegal = () => new PTypeError('Illegal invocation');
            const failed = (iface, member, message) => `Failed to execute '${member}' on '${iface}': ${message}`;

            // --- The line to the segment document -------------------------------------------------------------------------
            let nextId = 1;
            const calls = new HostMap(); // call id -> { resolve, reject, before }
            const objects = new HostMap(); // host id -> page object (connections, channels, tracks)
            const post = (m, transfer) => { try { port.postMessage(m, transfer || []); } catch { /* the document is gone */ } };
            const call = (m, before) => new PPromise((resolve, reject) => {
                const id = nextId++;
                calls.set(id, { resolve, reject, before });
                post({ ...m, call: id });
            });
            const errorFrom = (e) => {
                if (!e || typeof e !== 'object')
                    return dom('Unknown error', 'OperationError');
                if (e.name === 'TypeError')
                    return new PTypeError(String(e.message));
                if (e.name === 'RTCError') {
                    const err = dom(String(e.message), 'OperationError');
                    return err;
                }
                return dom(String(e.message), String(e.name || 'OperationError'));
            };
            let capabilities = { audio: null, video: null, sendAudio: null, sendVideo: null };

            // --- Events -----------------------------------------------------------------------------------------------------
            function fire(target, event) {
                try {
                    if (options.dispatch && options.dispatch(target, event))
                        return;
                    ReflectApply(PEventTarget.prototype.dispatchEvent, target, [event]);
                } catch (e) { void e; }
            }
            const simple = (type) => new PEvent(type);
            // IDL event handler attributes on `proto` for `types`, each a getter/setter (WebIDL: enumerable, configurable).
            function handlers(proto, types, slotOf) {
                for (const type of types) {
                    const get = { ['get on' + type]() {
                        const h = slotOf(this).handlers.get(type);
                        return h ? h.fn : null;
                    } }['get on' + type];
                    const set = { ['set on' + type](value) {
                        const s = slotOf(this);
                        let h = s.handlers.get(type);
                        if (!h) {
                            h = { fn: null };
                            s.handlers.set(type, h);
                            ReflectApply(PEventTarget.prototype.addEventListener, this, [type, function (event) {
                                const f = h.fn;
                                if (typeof f === 'function')
                                    return ReflectApply(f, this, [event]);
                                return undefined;
                            }]);
                        }
                        h.fn = typeof value === 'function' || (typeof value === 'object' && value !== null) ? value : null;
                    } }['set on' + type];
                    defineProperty(proto, 'on' + type, { get, set, enumerable: true, configurable: true });
                }
            }
            // Class members are not enumerable; WebIDL's are. toStringTag and lengths as Chrome's.
            function idl(cls, name, lengths) {
                for (const key of Object.getOwnPropertyNames(cls.prototype)) {
                    if (key === 'constructor')
                        continue;
                    const d = getOwnPropertyDescriptor(cls.prototype, key);
                    defineProperty(cls.prototype, key, { ...d, enumerable: true });
                }
                for (const [member, n] of Object.entries(lengths || {}))
                    if (cls.prototype[member] !== undefined || member === 'constructor')
                        defineProperty(member === 'constructor' ? cls : cls.prototype[member], 'length', { value: n, configurable: true });
                defineProperty(cls.prototype, Symbol.toStringTag, { value: name, configurable: true });
            }
            const slotMap = (name) => {
                const map = new HostWeakMap();
                const get = (o) => {
                    const s = map.get(o);
                    if (!s)
                        throw illegal();
                    return s;
                };
                return { map, get, name };
            };

            // --- Dictionaries -------------------------------------------------------------------------------------------------
            const SessionSlots = slotMap('RTCSessionDescription');
            class RTCSessionDescription {
                constructor(init = {}) {
                    if (init === null || (typeof init !== 'object' && typeof init !== 'function'))
                        init = {};
                    const type = init.type;
                    if (type === undefined || !SDP_TYPES.includes(String(type)))
                        throw new PTypeError(`Failed to construct 'RTCSessionDescription': Failed to read the 'type' property from 'RTCSessionDescriptionInit': The provided value '${String(type)}' is not a valid enum value of type RTCSdpType.`);
                    SessionSlots.map.set(this, { type: String(type), sdp: init.sdp === undefined ? '' : String(init.sdp) });
                }
                get type() { return SessionSlots.get(this).type; }
                get sdp() { return SessionSlots.get(this).sdp; }
                toJSON() { const s = SessionSlots.get(this); return { type: s.type, sdp: s.sdp }; }
            }
            idl(RTCSessionDescription, 'RTCSessionDescription', { constructor: 0, toJSON: 0 });
            const description = (d) => (d ? new RTCSessionDescription(d) : null);

            const CandidateSlots = slotMap('RTCIceCandidate');
            class RTCIceCandidate {
                constructor(init = {}) {
                    if (init === null || typeof init !== 'object')
                        init = {};
                    const sdpMid = init.sdpMid === undefined || init.sdpMid === null ? null : String(init.sdpMid);
                    const sdpMLineIndex = init.sdpMLineIndex === undefined || init.sdpMLineIndex === null ? null : Number(init.sdpMLineIndex) & 0xffff;
                    if (sdpMid === null && sdpMLineIndex === null)
                        throw new PTypeError("Failed to construct 'RTCIceCandidate': sdpMid and sdpMLineIndex are both null.");
                    const candidate = init.candidate === undefined ? '' : String(init.candidate);
                    const parsed = parseCandidate(candidate);
                    // Chrome takes the ufrag from the init, not from the candidate's text.
                    parsed.usernameFragment = init.usernameFragment !== undefined && init.usernameFragment !== null ? String(init.usernameFragment) : null;
                    CandidateSlots.map.set(this, { candidate, sdpMid, sdpMLineIndex, ...parsed, relayProtocol: null, url: null });
                }
                get candidate() { return CandidateSlots.get(this).candidate; }
                get sdpMid() { return CandidateSlots.get(this).sdpMid; }
                get sdpMLineIndex() { return CandidateSlots.get(this).sdpMLineIndex; }
                get foundation() { return CandidateSlots.get(this).foundation; }
                get component() { return CandidateSlots.get(this).component; }
                get priority() { return CandidateSlots.get(this).priority; }
                get address() { return CandidateSlots.get(this).address; }
                get protocol() { return CandidateSlots.get(this).protocol; }
                get port() { return CandidateSlots.get(this).port; }
                get type() { return CandidateSlots.get(this).type; }
                get tcpType() { return CandidateSlots.get(this).tcpType; }
                get relatedAddress() { return CandidateSlots.get(this).relatedAddress; }
                get relatedPort() { return CandidateSlots.get(this).relatedPort; }
                get usernameFragment() { return CandidateSlots.get(this).usernameFragment; }
                get url() { return CandidateSlots.get(this).url; }
                get relayProtocol() { return CandidateSlots.get(this).relayProtocol; }
                toJSON() {
                    const s = CandidateSlots.get(this);
                    return { candidate: s.candidate, sdpMid: s.sdpMid, sdpMLineIndex: s.sdpMLineIndex, usernameFragment: s.usernameFragment === null ? '' : s.usernameFragment };
                }
            }
            idl(RTCIceCandidate, 'RTCIceCandidate', { constructor: 0, toJSON: 0 });
            const candidateFrom = (c, extra) => {
                const out = new RTCIceCandidate(c);
                if (extra) {
                    const s = CandidateSlots.get(out);
                    s.url = extra.url === undefined ? null : extra.url;
                    s.relayProtocol = extra.relayProtocol === undefined ? null : extra.relayProtocol;
                }
                return out;
            };

            // --- Events of their own ------------------------------------------------------------------------------------------
            const EventSlots = new HostWeakMap();
            const eventMember = (name) => function () {
                const s = EventSlots.get(this);
                if (!s)
                    throw illegal();
                return s[name];
            };
            function eventClass(name, members, required) {
                const cls = { [name]: class extends PEvent {
                    constructor(type, init) {
                        if (arguments.length < 1)
                            throw new PTypeError(`Failed to construct '${name}': 1 argument required, but only 0 present.`);
                        super(type, init);
                        const s = {};
                        for (const [m, def] of members)
                            s[m] = init && init[m] !== undefined ? init[m] : def;
                        if (required && (!init || init[required] === undefined))
                            throw new PTypeError(`Failed to construct '${name}': Failed to read the '${required}' property from '${name}Init': Required member is undefined.`);
                        EventSlots.set(this, s);
                    }
                } }[name];
                for (const [m] of members)
                    defineProperty(cls.prototype, m, { get: { ['get ' + m]: eventMember(m) }['get ' + m], enumerable: true, configurable: true });
                defineProperty(cls.prototype, Symbol.toStringTag, { value: name, configurable: true });
                defineProperty(cls, 'length', { value: required ? 2 : 1, configurable: true });
                return cls;
            }
            const RTCPeerConnectionIceEvent = eventClass('RTCPeerConnectionIceEvent', [['candidate', null], ['url', null]]);
            const RTCPeerConnectionIceErrorEvent = eventClass('RTCPeerConnectionIceErrorEvent', [['address', null], ['port', null], ['url', ''], ['errorCode', 0], ['errorText', '']], 'errorCode');
            const RTCDataChannelEvent = eventClass('RTCDataChannelEvent', [['channel', null]], 'channel');
            const RTCTrackEvent = eventClass('RTCTrackEvent', [['receiver', null], ['track', null], ['streams', []], ['transceiver', null]], 'receiver');
            const MediaStreamTrackEvent = eventClass('MediaStreamTrackEvent', [['track', null]], 'track');

            // --- MediaStreamTrack and MediaStream -----------------------------------------------------------------------------
            const TrackSlots = slotMap('MediaStreamTrack');
            const tracksById = new HostMap(); // host track id -> page track
            class MediaStreamTrack extends PEventTarget {
                constructor() {
                    throw new PTypeError('Illegal constructor');
                }
                get kind() { return TrackSlots.get(this).kind; }
                get id() { const s = TrackSlots.get(this); return s.publicId || s.id; } // `id` is the host's key; Chrome's id may repeat (a remote track has its sender's)
                get label() { return TrackSlots.get(this).label; }
                get enabled() { return TrackSlots.get(this).enabled; }
                set enabled(v) {
                    const s = TrackSlots.get(this);
                    s.enabled = !!v;
                    post({ t: 'track-enabled', track: s.id, enabled: s.enabled });
                }
                get muted() { return TrackSlots.get(this).muted; }
                get readyState() { return TrackSlots.get(this).readyState; }
                get contentHint() { return TrackSlots.get(this).contentHint; }
                set contentHint(v) {
                    const s = TrackSlots.get(this);
                    const ok = s.kind === 'audio' ? ['', 'speech', 'speech-recognition', 'music'] : ['', 'motion', 'detail', 'text'];
                    if (ok.includes(String(v))) {
                        s.contentHint = String(v);
                        post({ t: 'track-hint', track: s.id, hint: s.contentHint });
                    }
                }
                clone() {
                    const s = TrackSlots.get(this);
                    const id = randomUUID();
                    post({ t: 'track-clone', track: s.id, id });
                    return trackFor({ id, kind: s.kind, label: s.label, settings: s.settings, capabilities: s.capabilities, constraints: s.constraints, readyState: s.readyState, enabled: s.enabled, muted: s.muted });
                }
                stop() {
                    const s = TrackSlots.get(this);
                    if (s.readyState === 'ended')
                        return;
                    s.readyState = 'ended';
                    post({ t: 'track-stop', track: s.id });
                }
                getCapabilities() { return structuredCopy(TrackSlots.get(this).capabilities); }
                getConstraints() { return structuredCopy(TrackSlots.get(this).constraints); }
                getSettings() { return structuredCopy(TrackSlots.get(this).settings); }
                applyConstraints(constraints = {}) {
                    let s;
                    try { s = TrackSlots.get(this); } catch (e) { return PPromise.reject(e); }
                    return call({ t: 'track-constraints', track: s.id, constraints: plain(constraints) }).then((r) => {
                        s.constraints = r.constraints || {};
                        s.settings = r.settings || s.settings;
                    });
                }
            }
            // Tracks are made by this file only: an EventTarget whose prototype is MediaStreamTrack's.
            const newTrack = (info) => {
                const track = Reflect.construct(PEventTarget, [], MediaStreamTrack);
                TrackSlots.map.set(track, {
                    id: info.id, publicId: info.publicId || null, kind: info.kind === 'audio' ? 'audio' : 'video', label: String(info.label || ''), enabled: info.enabled !== false, muted: info.muted === true,
                    readyState: info.readyState === 'ended' ? 'ended' : 'live', contentHint: '', settings: info.settings || {}, capabilities: info.capabilities || {}, constraints: info.constraints || {},
                    handlers: new HostMap(),
                });
                return track;
            };
            // One page object per host track.
            const trackFor = (info) => {
                let t = tracksById.get(info.id);
                if (!t) {
                    t = newTrack(info);
                    tracksById.set(info.id, t);
                }
                return t;
            };
            handlers(MediaStreamTrack.prototype, ['mute', 'unmute', 'ended'], TrackSlots.get);
            idl(MediaStreamTrack, 'MediaStreamTrack', { clone: 0, stop: 0, getCapabilities: 0, getConstraints: 0, getSettings: 0, applyConstraints: 0 });

            const StreamSlots = slotMap('MediaStream');
            const streamsById = new HostMap();
            class MediaStream extends PEventTarget {
                constructor(arg) {
                    super();
                    const tracks = [];
                    if (arg !== undefined) {
                        if (StreamSlots.map.has(arg))
                            tracks.push(...StreamSlots.map.get(arg).tracks);
                        else if (arg !== null && typeof arg === 'object' && typeof arg[Symbol.iterator] === 'function') {
                            for (const t of arg) {
                                if (!TrackSlots.map.has(t))
                                    throw new PTypeError("Failed to construct 'MediaStream': Failed to convert value to 'MediaStreamTrack'.");
                                tracks.push(t);
                            }
                        } else
                            throw new PTypeError("Failed to construct 'MediaStream': The provided value cannot be converted to a sequence.");
                    }
                    StreamSlots.map.set(this, { id: randomUUID(), tracks: [...new HostSet(tracks)], handlers: new HostMap() });
                }
                get id() { return StreamSlots.get(this).id; }
                get active() { return StreamSlots.get(this).tracks.some((t) => TrackSlots.get(t).readyState === 'live'); }
                getAudioTracks() { return StreamSlots.get(this).tracks.filter((t) => TrackSlots.get(t).kind === 'audio'); }
                getVideoTracks() { return StreamSlots.get(this).tracks.filter((t) => TrackSlots.get(t).kind === 'video'); }
                getTracks() { return [...StreamSlots.get(this).tracks]; }
                getTrackById(id) { return StreamSlots.get(this).tracks.find((t) => t.id === String(id)) || null; }
                addTrack(track) {
                    const s = StreamSlots.get(this);
                    if (!TrackSlots.map.has(track))
                        throw new PTypeError(failed('MediaStream', 'addTrack', "parameter 1 is not of type 'MediaStreamTrack'."));
                    if (!s.tracks.includes(track)) {
                        s.tracks.push(track);
                        sinksChanged(this);
                    }
                }
                removeTrack(track) {
                    const s = StreamSlots.get(this);
                    if (!TrackSlots.map.has(track))
                        throw new PTypeError(failed('MediaStream', 'removeTrack', "parameter 1 is not of type 'MediaStreamTrack'."));
                    const i = s.tracks.indexOf(track);
                    if (i >= 0) {
                        s.tracks.splice(i, 1);
                        sinksChanged(this);
                    }
                }
                clone() {
                    const s = StreamSlots.get(this);
                    return new MediaStream(s.tracks.map((t) => t.clone()));
                }
            }
            handlers(MediaStream.prototype, ['addtrack', 'removetrack', 'active', 'inactive'], StreamSlots.get);
            idl(MediaStream, 'MediaStream', { constructor: 0, getTrackById: 1, addTrack: 1, removeTrack: 1, clone: 0, getAudioTracks: 0, getVideoTracks: 0, getTracks: 0 });
            // A remote stream (an msid of the remote description): one page object per host stream id.
            // Remote streams are the receiving connection's own (the id is the sender's msid, which a local stream may share).
            const remoteStreams = new HostMap();
            const streamFor = (pcId, id) => {
                const key = pcId + ' ' + id;
                let st = remoteStreams.get(key);
                if (!st) {
                    st = new MediaStream();
                    StreamSlots.get(st).id = id;
                    remoteStreams.set(key, st);
                }
                return st;
            };

            const structuredCopy = (o) => (o === undefined || o === null ? {} : JSON.parse(JSON.stringify(o)));
            const plain = (o) => {
                try {
                    return o === undefined ? undefined : JSON.parse(JSON.stringify(o));
                } catch {
                    return {};
                }
            };

            // --- Capture: navigator.mediaDevices --------------------------------------------------------------------------
            function capture(kind, constraints) {
                if (constraints === undefined)
                    constraints = {};
                if (constraints === null || typeof constraints !== 'object')
                    return PPromise.reject(new PTypeError(failed('MediaDevices', kind, "The provided value is not of type '" + (kind === 'getUserMedia' ? 'MediaStreamConstraints' : 'DisplayMediaStreamOptions') + "'.")));
                if (kind === 'getUserMedia' && !constraints.audio && !constraints.video)
                    return PPromise.reject(new PTypeError(failed('MediaDevices', 'getUserMedia', 'At least one of audio and video must be requested')));
                return call({ t: 'capture', kind, constraints: plain(constraints) }).then((r) => {
                    const stream = new MediaStream(r.tracks.map(trackFor));
                    StreamSlots.get(stream).id = r.stream;
                    streamsById.set(r.stream, stream);
                    return stream;
                });
            }
            if (P.MediaDevices && options.enabled !== false) {
                const MD = P.MediaDevices.prototype;
                const methods = {
                    getUserMedia(constraints) { return capture('getUserMedia', constraints); },
                    getDisplayMedia(options_) { return capture('getDisplayMedia', options_); },
                    enumerateDevices() { return call({ t: 'devices' }).then((list) => list.map((d) => deviceInfo(d))); },
                    getSupportedConstraints() { return structuredCopy(supportedConstraints); },
                };
                for (const [name, fn] of Object.entries(methods)) {
                    defineProperty(fn, 'name', { value: name });
                    defineProperty(fn, 'length', { value: 0 });
                    defineProperty(MD, name, { value: fn, writable: true, enumerable: true, configurable: true });
                }
            }
            let supportedConstraints = {};
            const InfoSlots = slotMap('MediaDeviceInfo');
            const deviceInfo = (d) => {
                const proto = P.MediaDeviceInfo ? P.MediaDeviceInfo.prototype : Object.prototype;
                const o = Object.create(proto);
                InfoSlots.map.set(o, d);
                return o;
            };
            if (P.MediaDeviceInfo) {
                for (const m of ['deviceId', 'kind', 'label', 'groupId'])
                    defineProperty(P.MediaDeviceInfo.prototype, m, { get: { ['get ' + m]() { const s = InfoSlots.map.get(this); if (!s) throw illegal(); return String(s[m] || ''); } }['get ' + m], enumerable: true, configurable: true });
                defineProperty(P.MediaDeviceInfo.prototype, 'toJSON', { value: function toJSON() { const s = InfoSlots.map.get(this); if (!s) throw illegal(); return { deviceId: s.deviceId, kind: s.kind, label: s.label, groupId: s.groupId }; }, writable: true, enumerable: true, configurable: true });
            }

            // --- RTCDataChannel ---------------------------------------------------------------------------------------------
            const ChannelSlots = slotMap('RTCDataChannel');
            class RTCDataChannel extends PEventTarget {
                constructor() {
                    throw new PTypeError('Illegal constructor');
                }
                get label() { return ChannelSlots.get(this).label; }
                get ordered() { return ChannelSlots.get(this).ordered; }
                get maxPacketLifeTime() { return ChannelSlots.get(this).maxPacketLifeTime; }
                get maxRetransmits() { return ChannelSlots.get(this).maxRetransmits; }
                get protocol() { return ChannelSlots.get(this).protocol; }
                get negotiated() { return ChannelSlots.get(this).negotiated; }
                get id() { return ChannelSlots.get(this).id; }
                get readyState() { return ChannelSlots.get(this).readyState; }
                get bufferedAmount() { return ChannelSlots.get(this).bufferedAmount; }
                get bufferedAmountLowThreshold() { return ChannelSlots.get(this).lowThreshold; }
                set bufferedAmountLowThreshold(v) {
                    const s = ChannelSlots.get(this);
                    s.lowThreshold = Number(v) >>> 0;
                    post({ t: 'dc-threshold', dc: s.hid, value: s.lowThreshold });
                }
                get binaryType() { return ChannelSlots.get(this).binaryType; }
                set binaryType(v) {
                    const s = ChannelSlots.get(this);
                    if (v === 'blob' || v === 'arraybuffer')
                        s.binaryType = v;
                }
                close() {
                    const s = ChannelSlots.get(this);
                    if (s.readyState === 'closing' || s.readyState === 'closed')
                        return;
                    s.readyState = 'closing';
                    post({ t: 'dc-close', dc: s.hid });
                }
                send(data) {
                    const s = ChannelSlots.get(this);
                    if (arguments.length < 1)
                        throw new PTypeError(failed('RTCDataChannel', 'send', '1 argument required, but only 0 present.'));
                    if (s.readyState !== 'open')
                        throw dom(failed('RTCDataChannel', 'send', "RTCDataChannel.readyState is not 'open'"), 'InvalidStateError');
                    let payload, size;
                    if (typeof data === 'string' || (typeof data !== 'object' && typeof data !== 'function') || data === null) {
                        payload = String(data);
                        size = encoder.encode(payload).length;
                    } else if (data instanceof HostArrayBuffer || (P.ArrayBuffer && data instanceof P.ArrayBuffer)) {
                        payload = data.slice(0);
                        size = data.byteLength;
                    } else if (arrayBufferIsView(data)) {
                        payload = new HostUint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
                        size = data.byteLength;
                    } else if (PBlob && data instanceof PBlob) {
                        size = data.size;
                        s.bufferedAmount += size;
                        const hid = s.hid;
                        s.queue = s.queue.then(() => data.arrayBuffer()).then((buffer) => post({ t: 'dc-send', dc: hid, data: buffer, size }), () => {});
                        return;
                    } else {
                        payload = String(data);
                        size = encoder.encode(payload).length;
                    }
                    s.bufferedAmount += size;
                    const hid = s.hid;
                    // Binary sends wait behind a Blob being read; strings go at once (Chrome's order).
                    if (s.queue !== s.idle && typeof payload !== 'string')
                        s.queue = s.queue.then(() => post({ t: 'dc-send', dc: hid, data: payload, size }));
                    else
                        post({ t: 'dc-send', dc: hid, data: payload, size }, payload instanceof HostArrayBuffer ? [payload] : []);
                }
            }
            handlers(RTCDataChannel.prototype, ['open', 'bufferedamountlow', 'error', 'closing', 'close', 'message'], ChannelSlots.get);
            idl(RTCDataChannel, 'RTCDataChannel', { close: 0, send: 1 });
            function newChannel(info) {
                const dc = Reflect.construct(PEventTarget, [], RTCDataChannel);
                const idle = PPromise.resolve();
                ChannelSlots.map.set(dc, {
                    hid: info.dc, label: String(info.label), ordered: info.ordered !== false, maxPacketLifeTime: info.maxPacketLifeTime ?? null, maxRetransmits: info.maxRetransmits ?? null,
                    protocol: String(info.protocol || ''), negotiated: info.negotiated === true, id: info.id ?? null, readyState: info.readyState || 'connecting', bufferedAmount: 0,
                    lowThreshold: 0, binaryType: 'arraybuffer', handlers: new HostMap(), queue: idle, idle,
                });
                objects.set(info.dc, dc);
                return dc;
            }

            // --- RTCRtpSender / RTCRtpReceiver / RTCRtpTransceiver ----------------------------------------------------------
            const SenderSlots = slotMap('RTCRtpSender'), ReceiverSlots = slotMap('RTCRtpReceiver'), TransceiverSlots = slotMap('RTCRtpTransceiver');
            const noNew = () => { throw new PTypeError('Illegal constructor'); };
            class RTCRtpSender { constructor() { noNew(); }
                get track() { return SenderSlots.get(this).track; }
                get transport() { return null; }
                get dtmf() { return null; }
                replaceTrack(track) {
                    let s;
                    try { s = SenderSlots.get(this); } catch (e) { return PPromise.reject(e); }
                    if (track !== null && !TrackSlots.map.has(track))
                        return PPromise.reject(new PTypeError(failed('RTCRtpSender', 'replaceTrack', "parameter 1 is not of type 'MediaStreamTrack'.")));
                    return call({ t: 'sender-replace', sender: s.hid, track: track ? TrackSlots.get(track).id : null }).then(() => { s.track = track; });
                }
                getParameters() { return structuredCopy(SenderSlots.get(this).parameters); }
                setParameters(parameters) {
                    let s;
                    try { s = SenderSlots.get(this); } catch (e) { return PPromise.reject(e); }
                    return call({ t: 'sender-parameters', sender: s.hid, parameters: plain(parameters) }).then((p) => { s.parameters = p; });
                }
                getStats() {
                    let s;
                    try { s = SenderSlots.get(this); } catch (e) { return PPromise.reject(e); }
                    return call({ t: 'stats', sender: s.hid }).then(statsReport);
                }
                setStreams(...streams) { const s = SenderSlots.get(this); post({ t: 'sender-streams', sender: s.hid, streams: streams.map((st) => StreamSlots.get(st).id) }); }
                static getCapabilities(kind) { return kind === 'audio' || kind === 'video' ? structuredCopy(capabilities[kind === 'audio' ? 'sendAudio' : 'sendVideo']) : null; }
            }
            idl(RTCRtpSender, 'RTCRtpSender', { replaceTrack: 1, getParameters: 0, setParameters: 1, getStats: 0, setStreams: 0 });
            class RTCRtpReceiver { constructor() { noNew(); }
                get track() { return ReceiverSlots.get(this).track; }
                get transport() { return null; }
                get jitterBufferTarget() { return ReceiverSlots.get(this).jitterBufferTarget; }
                set jitterBufferTarget(v) { const s = ReceiverSlots.get(this); s.jitterBufferTarget = v === null ? null : Number(v); post({ t: 'receiver-jitter', receiver: s.hid, value: s.jitterBufferTarget }); }
                getParameters() { return structuredCopy(ReceiverSlots.get(this).parameters); }
                getContributingSources() { return []; }
                getSynchronizationSources() { return []; }
                getStats() {
                    let s;
                    try { s = ReceiverSlots.get(this); } catch (e) { return PPromise.reject(e); }
                    return call({ t: 'stats', receiver: s.hid }).then(statsReport);
                }
                static getCapabilities(kind) { return kind === 'audio' || kind === 'video' ? structuredCopy(capabilities[kind]) : null; }
            }
            idl(RTCRtpReceiver, 'RTCRtpReceiver', { getParameters: 0, getContributingSources: 0, getSynchronizationSources: 0, getStats: 0 });
            class RTCRtpTransceiver { constructor() { noNew(); }
                get mid() { return TransceiverSlots.get(this).mid; }
                get sender() { return TransceiverSlots.get(this).sender; }
                get receiver() { return TransceiverSlots.get(this).receiver; }
                get direction() { return TransceiverSlots.get(this).direction; }
                set direction(v) {
                    const s = TransceiverSlots.get(this);
                    if (!DIRECTIONS.includes(String(v)))
                        return;
                    if (s.stopped || s.direction === 'stopped')
                        throw dom("Failed to set the 'direction' property on 'RTCRtpTransceiver': The transceiver is stopped.", 'InvalidStateError');
                    if (v === 'stopped')
                        throw new PTypeError("Failed to set the 'direction' property on 'RTCRtpTransceiver': The provided value 'stopped' is not an allowed value.");
                    s.direction = String(v);
                    post({ t: 'transceiver-direction', transceiver: s.hid, direction: s.direction });
                }
                get currentDirection() { return TransceiverSlots.get(this).currentDirection; }
                stop() { const s = TransceiverSlots.get(this); s.stopped = true; post({ t: 'transceiver-stop', transceiver: s.hid }); }
                setCodecPreferences(codecs) { const s = TransceiverSlots.get(this); post({ t: 'transceiver-codecs', transceiver: s.hid, codecs: plain(Array.from(codecs || [])) }); }
            }
            idl(RTCRtpTransceiver, 'RTCRtpTransceiver', { stop: 0, setCodecPreferences: 1 });
            const transceivers = new HostMap(); // host id -> transceiver
            function transceiverFor(info) {
                let tr = transceivers.get(info.id);
                if (!tr) {
                    const sender = Object.create(RTCRtpSender.prototype), receiver = Object.create(RTCRtpReceiver.prototype);
                    SenderSlots.map.set(sender, { hid: info.id, track: info.senderTrack ? tracksById.get(info.senderTrack) || null : null, parameters: info.senderParameters || {} });
                    ReceiverSlots.map.set(receiver, { hid: info.id, track: info.receiverTrack ? trackFor(info.receiverTrack) : null, parameters: info.receiverParameters || {}, jitterBufferTarget: null });
                    tr = Object.create(RTCRtpTransceiver.prototype);
                    TransceiverSlots.map.set(tr, { hid: info.id, mid: null, sender, receiver, direction: info.direction || 'sendrecv', currentDirection: null, stopped: false });
                    transceivers.set(info.id, tr);
                }
                const s = TransceiverSlots.get(tr);
                s.mid = info.mid ?? null;
                s.direction = info.direction || s.direction;
                s.currentDirection = info.currentDirection ?? null;
                if (info.senderParameters)
                    SenderSlots.get(s.sender).parameters = info.senderParameters;
                return tr;
            }

            // --- RTCStatsReport, RTCCertificate -------------------------------------------------------------------------------
            const ReportSlots = slotMap('RTCStatsReport');
            class RTCStatsReport { constructor() { noNew(); }
                get size() { return ReportSlots.get(this).size; }
                get(k) { return ReportSlots.get(this).get(String(k)); }
                has(k) { return ReportSlots.get(this).has(String(k)); }
                entries() { return ReportSlots.get(this).entries(); }
                keys() { return ReportSlots.get(this).keys(); }
                values() { return ReportSlots.get(this).values(); }
                forEach(fn, thisArg) { for (const [k, v] of ReportSlots.get(this)) ReflectApply(fn, thisArg, [v, k, this]); }
            }
            defineProperty(RTCStatsReport.prototype, Symbol.iterator, { value: RTCStatsReport.prototype.entries, writable: true, configurable: true });
            idl(RTCStatsReport, 'RTCStatsReport', { get: 1, has: 1, forEach: 1, entries: 0, keys: 0, values: 0 });
            const statsReport = (list) => {
                const r = Object.create(RTCStatsReport.prototype);
                ReportSlots.map.set(r, new HostMap((list || []).map((s) => [s.id, s])));
                return r;
            };
            const CertSlots = slotMap('RTCCertificate');
            class RTCCertificate { constructor() { noNew(); }
                get expires() { return CertSlots.get(this).expires; }
                getFingerprints() { return structuredCopy(CertSlots.get(this).fingerprints); }
            }
            idl(RTCCertificate, 'RTCCertificate', { getFingerprints: 0 });

            // --- RTCPeerConnection --------------------------------------------------------------------------------------------
            const PcSlots = slotMap('RTCPeerConnection');
            const live = new HostSet();
            function checkConfiguration(config, member) {
                if (config === undefined || config === null)
                    return {};
                if (typeof config !== 'object')
                    throw new PTypeError(`Failed to ${member}: The provided value is not of type 'RTCConfiguration'.`);
                const out = {};
                if (config.iceServers !== undefined) {
                    out.iceServers = [];
                    for (const server of config.iceServers) {
                        const urls = server && server.urls;
                        if (urls === undefined)
                            throw new PTypeError(`Failed to ${member}: Failed to read the 'iceServers' property from 'RTCConfiguration': Failed to read the 'urls' property from 'RTCIceServer': Required member is undefined.`);
                        const list = typeof urls === 'string' ? [urls] : Array.from(urls, String);
                        for (const u of list) {
                            // RFC 7064/7065: scheme:host[:port], ?transport=udp|tcp for TURN only; no '//', no path.
                            const stunUrl = /^(stuns?):(\[[0-9a-f:.]+\]|[^\s\/?#:@\[\]]+)(:\d{1,5})?$/i, turnUrl = /^(turns?):(\[[0-9a-f:.]+\]|[^\s\/?#:@\[\]]+)(:\d{1,5})?(\?transport=(udp|tcp))?$/i;
                            if (!stunUrl.test(u) && !turnUrl.test(u))
                                throw dom(`Failed to ${member}: '${u}' is not a valid stun or turn URL.`, 'SyntaxError');
                            if (/^turns?:/i.test(u) && server.username !== undefined && String(server.username).length > 509)
                                throw dom(`Failed to ${member}: ICE server username is too long.`, 'InvalidAccessError');
                            if (!/^(stun|stuns|turn|turns):/i.test(u))
                                throw dom(`Failed to ${member}: '${u}' is not a valid stun or turn URL.`, 'SyntaxError');
                            if (/^turns?:/i.test(u) && (server.username === undefined || server.credential === undefined))
                                throw dom(`Failed to ${member}: Both username and credential are required when the URL scheme is "turn" or "turns".`, 'InvalidAccessError');
                        }
                        const s = { urls: typeof urls === 'string' ? urls : list };
                        if (server.username !== undefined) s.username = String(server.username);
                        if (server.credential !== undefined) s.credential = String(server.credential);
                        out.iceServers.push(s);
                    }
                }
                for (const [k, values] of [['iceTransportPolicy', ['relay', 'all']], ['bundlePolicy', ['balanced', 'max-compat', 'max-bundle']], ['rtcpMuxPolicy', ['require']]]) {
                    if (config[k] === undefined)
                        continue;
                    if (!values.includes(String(config[k])))
                        throw new PTypeError(`Failed to ${member}: Failed to read the '${k}' property from 'RTCConfiguration': The provided value '${String(config[k])}' is not a valid enum value of type ${k === 'iceTransportPolicy' ? 'RTCIceTransportPolicy' : k === 'bundlePolicy' ? 'RTCBundlePolicy' : 'RTCRtcpMuxPolicy'}.`);
                    out[k] = String(config[k]);
                }
                if (config.iceCandidatePoolSize !== undefined) {
                    const n = Number(config.iceCandidatePoolSize);
                    if (!(n >= 0 && n <= 255))
                        throw new PTypeError(`Failed to ${member}: Failed to read the 'iceCandidatePoolSize' property from 'RTCConfiguration': Value is outside the 'octet' value range.`);
                    out.iceCandidatePoolSize = n | 0;
                }
                if (config.certificates !== undefined)
                    out.certificates = Array.from(config.certificates, (c) => CertSlots.get(c).hid);
                return out;
            }
            class RTCPeerConnection extends PEventTarget {
                constructor(configuration = undefined) {
                    if (options.enabled === false)
                        throw dom("Failed to construct 'RTCPeerConnection': WebRTC is off in this network mode.", 'NotSupportedError');
                    const config = checkConfiguration(configuration, "construct 'RTCPeerConnection'");
                    super();
                    const hid = nextId++;
                    const s = {
                        hid, config, closed: false, signalingState: 'stable', iceGatheringState: 'new', iceConnectionState: 'new', connectionState: 'new',
                        localDescription: null, currentLocalDescription: null, pendingLocalDescription: null,
                        remoteDescription: null, currentRemoteDescription: null, pendingRemoteDescription: null, canTrickle: null,
                        handlers: new HostMap(), channels: new HostSet(), transceivers: [], sctp: null,
                    };
                    PcSlots.map.set(this, s);
                    objects.set(hid, this);
                    live.add(this);
                    post({ t: 'pc-new', pc: hid, config });
                }
                get localDescription() { return description(PcSlots.get(this).localDescription); }
                get currentLocalDescription() { return description(PcSlots.get(this).currentLocalDescription); }
                get pendingLocalDescription() { return description(PcSlots.get(this).pendingLocalDescription); }
                get remoteDescription() { return description(PcSlots.get(this).remoteDescription); }
                get currentRemoteDescription() { return description(PcSlots.get(this).currentRemoteDescription); }
                get pendingRemoteDescription() { return description(PcSlots.get(this).pendingRemoteDescription); }
                get signalingState() { return PcSlots.get(this).signalingState; }
                get iceGatheringState() { return PcSlots.get(this).iceGatheringState; }
                get iceConnectionState() { return PcSlots.get(this).iceConnectionState; }
                get connectionState() { return PcSlots.get(this).connectionState; }
                get canTrickleIceCandidates() { return PcSlots.get(this).canTrickle; }
                get sctp() { return PcSlots.get(this).sctp; }
                createOffer(opts) { return pcCall(this, 'createOffer', 'createOffer', [plain(typeof opts === 'object' && opts !== null && typeof opts !== 'function' ? opts : undefined)]); }
                createAnswer(opts) { return pcCall(this, 'createAnswer', 'createAnswer', [plain(typeof opts === 'object' && opts !== null && typeof opts !== 'function' ? opts : undefined)]); }
                setLocalDescription(desc) {
                    let d;
                    if (desc !== undefined && desc !== null) {
                        const type = desc.type;
                        if (type !== undefined && !SDP_TYPES.includes(String(type)))
                            return PPromise.reject(new PTypeError(failed('RTCPeerConnection', 'setLocalDescription', `Failed to read the 'type' property from 'RTCLocalSessionDescriptionInit': The provided value '${String(type)}' is not a valid enum value of type RTCSdpType.`)));
                        d = { type: type === undefined ? undefined : String(type), sdp: desc.sdp === undefined ? undefined : String(desc.sdp) };
                    }
                    return pcCall(this, 'setLocalDescription', 'setLocalDescription', d === undefined ? [] : [d]).then(() => undefined);
                }
                setRemoteDescription(desc) {
                    if (desc === undefined || desc === null || typeof desc !== 'object')
                        return PPromise.reject(new PTypeError(failed('RTCPeerConnection', 'setRemoteDescription', "1 argument required, but only 0 present.")));
                    const type = desc.type;
                    if (!SDP_TYPES.includes(String(type)))
                        return PPromise.reject(new PTypeError(failed('RTCPeerConnection', 'setRemoteDescription', `Failed to read the 'type' property from 'RTCSessionDescriptionInit': The provided value '${String(type)}' is not a valid enum value of type RTCSdpType.`)));
                    return pcCall(this, 'setRemoteDescription', 'setRemoteDescription', [{ type: String(type), sdp: desc.sdp === undefined ? '' : String(desc.sdp) }]).then(() => undefined);
                }
                addIceCandidate(candidate) {
                    let c = null;
                    if (candidate !== undefined && candidate !== null) {
                        if (CandidateSlots.map.has(candidate))
                            c = candidate.toJSON();
                        else if (typeof candidate === 'object') {
                            c = { candidate: candidate.candidate === undefined ? '' : String(candidate.candidate) };
                            if (candidate.sdpMid !== undefined && candidate.sdpMid !== null) c.sdpMid = String(candidate.sdpMid);
                            if (candidate.sdpMLineIndex !== undefined && candidate.sdpMLineIndex !== null) c.sdpMLineIndex = Number(candidate.sdpMLineIndex) & 0xffff;
                            if (candidate.usernameFragment !== undefined && candidate.usernameFragment !== null) c.usernameFragment = String(candidate.usernameFragment);
                            if (c.candidate !== '' && c.sdpMid === undefined && c.sdpMLineIndex === undefined)
                                return PPromise.reject(new PTypeError(failed('RTCPeerConnection', 'addIceCandidate', 'Candidate missing values for both sdpMid and sdpMLineIndex')));
                        } else
                            return PPromise.reject(new PTypeError(failed('RTCPeerConnection', 'addIceCandidate', "The provided value is not of type 'RTCIceCandidateInit'.")));
                    }
                    return pcCall(this, 'addIceCandidate', 'addIceCandidate', c === null ? [] : [c]).then(() => undefined);
                }
                restartIce() { const s = PcSlots.get(this); if (!s.closed) post({ t: 'pc-restart-ice', pc: s.hid }); }
                getConfiguration() {
                    const s = PcSlots.get(this);
                    // Chrome's dictionary, its members in order.
                    return { alwaysNegotiateDataChannels: false, bundlePolicy: s.config.bundlePolicy || 'balanced', certificates: [], encodedInsertableStreams: false, iceCandidatePoolSize: s.config.iceCandidatePoolSize || 0, iceServers: structuredCopy(s.config.iceServers || []), iceTransportPolicy: s.config.iceTransportPolicy || 'all', rtcpMuxPolicy: 'require' };
                }
                setConfiguration(configuration) {
                    const s = PcSlots.get(this);
                    if (s.closed)
                        throw dom(failed('RTCPeerConnection', 'setConfiguration', "The RTCPeerConnection's signalingState is 'closed'."), 'InvalidStateError');
                    const config = checkConfiguration(configuration, "execute 'setConfiguration' on 'RTCPeerConnection'");
                    s.config = config;
                    post({ t: 'pc-config', pc: s.hid, config });
                }
                close() {
                    const s = PcSlots.get(this);
                    if (s.closed)
                        return;
                    s.closed = true;
                    s.signalingState = 'closed';
                    s.iceConnectionState = 'closed';
                    s.connectionState = 'closed';
                    // Channels and remote tracks keep their states until the host reports them (Chrome: a channel that never opened
                    // stays 'connecting', remote tracks stay 'live').
                    for (const tr of s.transceivers) {
                        const t = TransceiverSlots.get(tr);
                        t.stopped = true;
                        t.currentDirection = 'stopped';
                        t.direction = 'stopped';
                    }
                    live.delete(this);
                    post({ t: 'pc-close', pc: s.hid });
                }
                getSenders() { return PcSlots.get(this).transceivers.filter((t) => !TransceiverSlots.get(t).stopped).map((t) => t.sender); }
                getReceivers() { return PcSlots.get(this).transceivers.filter((t) => !TransceiverSlots.get(t).stopped).map((t) => t.receiver); }
                getTransceivers() { return [...PcSlots.get(this).transceivers]; }
                addTrack(track, ...streams) {
                    const s = PcSlots.get(this);
                    if (arguments.length < 1 || !TrackSlots.map.has(track))
                        throw new PTypeError(failed('RTCPeerConnection', 'addTrack', "parameter 1 is not of type 'MediaStreamTrack'."));
                    if (s.closed)
                        throw dom(failed('RTCPeerConnection', 'addTrack', "The RTCPeerConnection's signalingState is 'closed'."), 'InvalidStateError');
                    for (const tr of s.transceivers)
                        if (SenderSlots.get(tr.sender).track === track)
                            throw dom(failed('RTCPeerConnection', 'addTrack', 'A sender already exists for the track.'), 'InvalidAccessError');
                    const id = nextId++;
                    const tSlot = TrackSlots.get(track);
                    const info = { id, mid: null, direction: 'sendrecv', senderTrack: tSlot.id, receiverTrack: { id: randomUUID(), kind: tSlot.kind, label: tSlot.kind === 'audio' ? 'remote audio' : 'remote video', muted: true } };
                    const tr = transceiverFor(info);
                    SenderSlots.get(tr.sender).track = track;
                    s.transceivers.push(tr);
                    post({ t: 'pc-add-track', pc: s.hid, transceiver: id, track: tSlot.id, streams: streams.map((st) => ({ id: StreamSlots.get(st).id })), receiverTrack: info.receiverTrack.id });
                    return tr.sender;
                }
                removeTrack(sender) {
                    const s = PcSlots.get(this);
                    if (!SenderSlots.map.has(sender))
                        throw new PTypeError(failed('RTCPeerConnection', 'removeTrack', "parameter 1 is not of type 'RTCRtpSender'."));
                    if (s.closed)
                        throw dom(failed('RTCPeerConnection', 'removeTrack', "The RTCPeerConnection's signalingState is 'closed'."), 'InvalidStateError');
                    const ss = SenderSlots.get(sender);
                    ss.track = null;
                    post({ t: 'pc-remove-track', pc: s.hid, transceiver: ss.hid });
                }
                addTransceiver(trackOrKind, init = {}) {
                    const s = PcSlots.get(this);
                    if (s.closed)
                        throw dom(failed('RTCPeerConnection', 'addTransceiver', "The RTCPeerConnection's signalingState is 'closed'."), 'InvalidStateError');
                    let kind, track = null;
                    if (TrackSlots.map.has(trackOrKind)) {
                        track = trackOrKind;
                        kind = TrackSlots.get(track).kind;
                    } else {
                        kind = String(trackOrKind);
                        if (kind !== 'audio' && kind !== 'video')
                            throw new PTypeError(failed('RTCPeerConnection', 'addTransceiver', `The argument provided as parameter 1 is not a valid kind (${kind}).`));
                    }
                    const direction = init && init.direction !== undefined ? String(init.direction) : 'sendrecv';
                    if (!DIRECTIONS.includes(direction) || direction === 'stopped')
                        throw new PTypeError(failed('RTCPeerConnection', 'addTransceiver', `Failed to read the 'direction' property from 'RTCRtpTransceiverInit': The provided value '${direction}' is not a valid enum value of type RTCRtpTransceiverDirection.`));
                    const id = nextId++;
                    const tr = transceiverFor({ id, direction, senderTrack: track ? TrackSlots.get(track).id : null, receiverTrack: { id: randomUUID(), kind, label: kind === 'audio' ? 'remote audio' : 'remote video', muted: true } });
                    SenderSlots.get(tr.sender).track = track;
                    s.transceivers.push(tr);
                    post({ t: 'pc-add-transceiver', pc: s.hid, transceiver: id, kind, track: track ? TrackSlots.get(track).id : null, init: { direction, streams: (init && init.streams ? Array.from(init.streams) : []).map((st) => ({ id: StreamSlots.get(st).id })), sendEncodings: plain(init && init.sendEncodings) }, receiverTrack: ReceiverSlots.get(tr.receiver).track ? TrackSlots.get(ReceiverSlots.get(tr.receiver).track).id : null });
                    return tr;
                }
                createDataChannel(label, init = {}) {
                    const s = PcSlots.get(this);
                    if (arguments.length < 1)
                        throw new PTypeError(failed('RTCPeerConnection', 'createDataChannel', '1 argument required, but only 0 present.'));
                    if (s.closed)
                        throw dom(failed('RTCPeerConnection', 'createDataChannel', "The RTCPeerConnection's signalingState is 'closed'."), 'InvalidStateError');
                    label = String(label);
                    init = init === null || init === undefined ? {} : init;
                    const protocol = init.protocol === undefined ? '' : String(init.protocol);
                    if (encoder.encode(label).length > 65535)
                        throw new PTypeError(failed('RTCPeerConnection', 'createDataChannel', 'RTCDataChannel label too long'));
                    if (encoder.encode(protocol).length > 65535)
                        throw new PTypeError(failed('RTCPeerConnection', 'createDataChannel', 'RTCDataChannel protocol too long'));
                    const maxPacketLifeTime = init.maxPacketLifeTime === undefined || init.maxPacketLifeTime === null ? null : Number(init.maxPacketLifeTime) & 0xffff;
                    const maxRetransmits = init.maxRetransmits === undefined || init.maxRetransmits === null ? null : Number(init.maxRetransmits) & 0xffff;
                    if (maxPacketLifeTime !== null && maxRetransmits !== null)
                        throw new PTypeError(failed('RTCPeerConnection', 'createDataChannel', 'RTCDataChannel cannot have both max retransmits and max lifetime'));
                    const negotiated = init.negotiated === true;
                    const id = init.id === undefined || init.id === null ? null : Number(init.id) & 0xffff;
                    if (negotiated && id === null)
                        throw new PTypeError(failed('RTCPeerConnection', 'createDataChannel', 'RTCDataChannel must have id set if negotiated is true'));
                    if (id !== null && id > 65534)
                        throw new PTypeError(failed('RTCPeerConnection', 'createDataChannel', 'RTCDataChannel cannot have id > 65534'));
                    const hid = nextId++;
                    const dc = newChannel({ dc: hid, label, ordered: init.ordered !== false, maxPacketLifeTime, maxRetransmits, protocol, negotiated, id: negotiated ? id : null });
                    s.channels.add(dc);
                    const dInit = { ordered: init.ordered !== false, protocol, negotiated };
                    if (maxPacketLifeTime !== null) dInit.maxPacketLifeTime = maxPacketLifeTime;
                    if (maxRetransmits !== null) dInit.maxRetransmits = maxRetransmits;
                    if (id !== null) dInit.id = id;
                    post({ t: 'dc-new', pc: s.hid, dc: hid, label, init: dInit });
                    return dc;
                }
                getStats(selector) {
                    let s;
                    try { s = PcSlots.get(this); } catch (e) { return PPromise.reject(e); }
                    const m = { t: 'stats', pc: s.hid };
                    if (selector !== undefined && selector !== null) {
                        if (!TrackSlots.map.has(selector))
                            return PPromise.reject(new PTypeError(failed('RTCPeerConnection', 'getStats', "The provided value is not of type 'MediaStreamTrack'.")));
                        m.track = TrackSlots.get(selector).id;
                    }
                    return call(m).then(statsReport);
                }
                static generateCertificate(keygen) {
                    return call({ t: 'certificate', keygen: plain(keygen) }).then((c) => {
                        const cert = Object.create(RTCCertificate.prototype);
                        CertSlots.map.set(cert, { hid: c.id, expires: c.expires, fingerprints: c.fingerprints });
                        return cert;
                    });
                }
            }
            handlers(RTCPeerConnection.prototype, ['negotiationneeded', 'icecandidate', 'signalingstatechange', 'iceconnectionstatechange', 'connectionstatechange', 'icegatheringstatechange', 'icecandidateerror', 'track', 'datachannel'], PcSlots.get);
            idl(RTCPeerConnection, 'RTCPeerConnection', { constructor: 0, createOffer: 0, createAnswer: 0, setLocalDescription: 0, setRemoteDescription: 0, addIceCandidate: 0, restartIce: 0, getConfiguration: 0, setConfiguration: 0, close: 0, getSenders: 0, getReceivers: 0, getTransceivers: 0, addTrack: 1, removeTrack: 1, addTransceiver: 1, createDataChannel: 1, getStats: 0 });
            defineProperty(RTCPeerConnection.generateCertificate, 'length', { value: 1 });

            function pcCall(pc, method, member, args) {
                let s;
                try { s = PcSlots.get(pc); } catch (e) { return PPromise.reject(e); }
                if (s.closed)
                    return PPromise.reject(dom(failed('RTCPeerConnection', member, "The RTCPeerConnection's signalingState is 'closed'."), 'InvalidStateError'));
                return call({ t: 'pc-call', pc: s.hid, method, args }).then((r) => (r && r.description ? new RTCSessionDescription(r.description) : undefined));
            }
            // The host's state after an operation or an event: applied before the promise resolves or the event fires, as the spec's
            // "same task" asks.
            function applyState(pc, st) {
                const s = PcSlots.get(pc);
                if (!st)
                    return;
                for (const k of ['signalingState', 'iceGatheringState', 'iceConnectionState', 'connectionState', 'localDescription', 'currentLocalDescription', 'pendingLocalDescription', 'remoteDescription', 'currentRemoteDescription', 'pendingRemoteDescription'])
                    if (st[k] !== undefined && !s.closed)
                        s[k] = st[k];
                if (st.canTrickle !== undefined)
                    s.canTrickle = st.canTrickle;
                if (Array.isArray(st.transceivers))
                    for (const info of st.transceivers) {
                        const tr = transceiverFor(info);
                        if (!s.transceivers.includes(tr))
                            s.transceivers.push(tr);
                    }
                if (Array.isArray(st.channelIds))
                    for (const [dcId, id] of st.channelIds) {
                        const dc = objects.get(dcId);
                        if (dc && ChannelSlots.map.has(dc))
                            ChannelSlots.get(dc).id = id;
                    }
            }

            // --- Video and audio sinks: <video>/<audio> srcObject ------------------------------------------------------------
            // A media element given a MediaStream of this file shows it through the carapace's video layer (docs/webrtc.md): the
            // segment document plays the host's tracks, the frames go to the carapace, which draws them in the element's box.
            const sinks = new HostMap(); // element -> { id, stream, playing }
            const sinkIds = new HostWeakMap();
            let nextSink = 1;
            const PMedia = P.HTMLMediaElement;
            // What the sinks read of an element, taken now: the page may replace these members later (the glue is hardened).
            const getterOf = (C, name) => { for (let o = C && C.prototype; o; o = Object.getPrototypeOf(o)) { const d = getOwnPropertyDescriptor(o, name); if (d && d.get) return d.get; } return null; };
            const gBCR = P.Element && P.Element.prototype.getBoundingClientRect;
            const gIsConnected = getterOf(P.Node, 'isConnected');
            const gMuted = getterOf(PMedia, 'muted'), gVolume = getterOf(PMedia, 'volume'), gAutoplay = getterOf(PMedia, 'autoplay');
            const gComputedStyle = P.getComputedStyle;
            const read = (fn, el, fallback) => { try { return fn ? ReflectApply(fn, el, []) : fallback; } catch { return fallback; } };
            function sinksChanged(stream) {
                for (const [el, sink] of sinks)
                    if (sink.stream === stream)
                        postSink(el, sink);
            }
            function postSink(el, sink) {
                const tracks = StreamSlots.get(sink.stream).tracks.filter((t) => TrackSlots.get(t).readyState === 'live').map((t) => TrackSlots.get(t).id);
                const muted = !!read(gMuted, el, false), volume = +read(gVolume, el, 1);
                post({ t: 'sink', sink: sink.id, tracks, video: el instanceof (P.HTMLVideoElement || PMedia), muted, volume, playing: sink.playing });
            }
            function mediaEvent(el, type) {
                fire(el, simple(type));
            }
            if (PMedia && options.enabled !== false) {
                const proto = PMedia.prototype;
                const srcObject = getOwnPropertyDescriptor(proto, 'srcObject');
                const wrapGetter = (name, fn) => {
                    const d = getOwnPropertyDescriptor(proto, name);
                    if (!d || !d.get)
                        return;
                    const orig = d.get;
                    defineProperty(proto, name, { ...d, get: { ['get ' + name]() { const sink = sinks.get(this); return sink ? fn(this, sink) : ReflectApply(orig, this, []); } }['get ' + name] });
                };
                if (srcObject && srcObject.set) {
                    const origSet = srcObject.set, origGet = srcObject.get;
                    defineProperty(proto, 'srcObject', {
                        ...srcObject,
                        get: { 'get srcObject'() { const sink = sinks.get(this); return sink ? sink.stream : ReflectApply(origGet, this, []); } }['get srcObject'],
                        set: { 'set srcObject'(value) {
                            const old = sinks.get(this);
                            if (old) {
                                sinks.delete(this);
                                post({ t: 'sink-off', sink: old.id });
                            }
                            if (value !== null && value !== undefined && StreamSlots.map.has(value)) {
                                ReflectApply(origSet, this, [null]);
                                let id = sinkIds.get(this);
                                if (!id) {
                                    id = nextSink++;
                                    sinkIds.set(this, id);
                                }
                                const sink = { id, stream: value, playing: false, width: 0, height: 0 };
                                sinks.set(this, sink);
                                postSink(this, sink);
                                // The load algorithm for a MediaProvider: metadata as soon as the tracks are there, autoplay plays.
                                const el = this;
                                hostSetTimeout(() => {
                                    if (sinks.get(el) !== sink)
                                        return;
                                    mediaEvent(el, 'loadstart');
                                    mediaEvent(el, 'loadedmetadata');
                                    mediaEvent(el, 'loadeddata');
                                    mediaEvent(el, 'canplay');
                                    const autoplay = !!read(gAutoplay, el, false);
                                    if (autoplay && !sink.playing) {
                                        sink.playing = true;
                                        postSink(el, sink);
                                        mediaEvent(el, 'play');
                                        mediaEvent(el, 'playing');
                                    }
                                    mediaEvent(el, 'canplaythrough');
                                }, 0);
                                return;
                            }
                            ReflectApply(origSet, this, [value]);
                        } }['set srcObject'],
                    });
                    const play = proto.play, pause = proto.pause;
                    defineProperty(proto, 'play', { value: { play() {
                        const sink = sinks.get(this);
                        if (!sink)
                            return ReflectApply(play, this, []);
                        if (!sink.playing) {
                            sink.playing = true;
                            postSink(this, sink);
                            hostSetTimeout(() => { mediaEvent(this, 'play'); mediaEvent(this, 'playing'); }, 0);
                        }
                        return PPromise.resolve();
                    } }.play, writable: true, enumerable: true, configurable: true });
                    defineProperty(proto, 'pause', { value: { pause() {
                        const sink = sinks.get(this);
                        if (!sink)
                            return ReflectApply(pause, this, []);
                        if (sink.playing) {
                            sink.playing = false;
                            postSink(this, sink);
                            hostSetTimeout(() => mediaEvent(this, 'pause'), 0);
                        }
                        return undefined;
                    } }.pause, writable: true, enumerable: true, configurable: true });
                    wrapGetter('paused', (el, sink) => !sink.playing);
                    wrapGetter('readyState', () => 4);
                    wrapGetter('currentSrc', () => '');
                    wrapGetter('duration', () => Infinity);
                    wrapGetter('networkState', () => 2);
                    if (P.HTMLVideoElement) {
                        const vproto = P.HTMLVideoElement.prototype;
                        for (const [name, key] of [['videoWidth', 'width'], ['videoHeight', 'height']]) {
                            const d = getOwnPropertyDescriptor(vproto, name);
                            if (d && d.get) {
                                const orig = d.get;
                                defineProperty(vproto, name, { ...d, get: { ['get ' + name]() { const sink = sinks.get(this); return sink ? sink[key] : ReflectApply(orig, this, []); } }['get ' + name] });
                            }
                        }
                    }
                    for (const name of ['muted', 'volume']) {
                        const d = getOwnPropertyDescriptor(proto, name);
                        if (d && d.set) {
                            const orig = d.set;
                            defineProperty(proto, name, { ...d, set: { ['set ' + name](v) { ReflectApply(orig, this, [v]); const sink = sinks.get(this); if (sink) postSink(this, sink); } }['set ' + name] });
                        }
                    }
                }
            }
            // The boxes of the elements that show a stream, in the viewport's CSS pixels, for the carapace's video layer: what the
            // Worker sends with each frame it paints (worker.js). An element that is not rendered has no box.
            let lastBoxes = '';
            function sinkBoxes() {
                const out = [];
                for (const [el, sink] of sinks) {
                    if (!sink.playing)
                        continue;
                    if (!read(gIsConnected, el, false))
                        continue;
                    const r = read(gBCR, el, null);
                    if (!r || !(r.width > 0 && r.height > 0))
                        continue;
                    let fit = 'contain';
                    try { fit = ReflectApply(gComputedStyle, P, [el]).getPropertyValue('object-fit') || 'contain'; } catch { /* */ }
                    out.push({ sink: sink.id, x: r.left, y: r.top, width: r.width, height: r.height, fit });
                }
                const key = JSON.stringify(out);
                if (key === lastBoxes)
                    return null;
                lastBoxes = key;
                return out;
            }

            // --- From the segment document ----------------------------------------------------------------------------------
            port.onmessage = (e) => {
                const m = e.data;
                if (!m || typeof m !== 'object')
                    return;
                if (m.t === 'reply') {
                    const c = calls.get(m.call);
                    if (!c)
                        return;
                    calls.delete(m.call);
                    if (m.pc !== undefined && objects.get(m.pc) && m.state)
                        applyState(objects.get(m.pc), m.state);
                    if (m.ok)
                        c.resolve(m.value);
                    else
                        c.reject(errorFrom(m.error));
                    return;
                }
                if (m.t === 'capabilities') {
                    capabilities = m.capabilities || capabilities;
                    supportedConstraints = m.supportedConstraints || {};
                    return;
                }
                if (m.t === 'sink-size') {
                    for (const [el, sink] of sinks)
                        if (sink.id === m.sink && (sink.width !== m.width || sink.height !== m.height)) {
                            sink.width = m.width;
                            sink.height = m.height;
                            mediaEvent(el, 'resize');
                        }
                    return;
                }
                if (m.t === 'track-ended' || m.t === 'track-mute' || m.t === 'track-unmute') {
                    const track = tracksById.get(m.track);
                    if (!track)
                        return;
                    const s = TrackSlots.get(track);
                    if (m.t === 'track-ended') {
                        if (s.readyState === 'ended')
                            return;
                        s.readyState = 'ended';
                        fire(track, simple('ended'));
                    } else {
                        const muted = m.t === 'track-mute';
                        if (s.muted === muted)
                            return;
                        s.muted = muted;
                        fire(track, simple(muted ? 'mute' : 'unmute'));
                    }
                    return;
                }
                const target = objects.get(m.pc !== undefined ? m.pc : m.dc);
                if (!target)
                    return;
                if (m.pc !== undefined && PcSlots.map.has(target)) {
                    const s = PcSlots.get(target);
                    if (s.closed)
                        return;
                    applyState(target, m.state);
                    switch (m.t) {
                    case 'pc-event':
                        fire(target, simple(m.event));
                        break;
                    case 'pc-icecandidate':
                        fire(target, new RTCPeerConnectionIceEvent('icecandidate', { candidate: m.candidate ? candidateFrom(m.candidate, m) : null, url: m.url ?? null }));
                        break;
                    case 'pc-icecandidateerror':
                        fire(target, new RTCPeerConnectionIceErrorEvent('icecandidateerror', { address: m.address ?? null, port: m.port ?? null, url: m.url || '', errorCode: m.errorCode | 0, errorText: m.errorText || '' }));
                        break;
                    case 'pc-datachannel': {
                        const dc = newChannel(m.channel);
                        s.channels.add(dc);
                        fire(target, new RTCDataChannelEvent('datachannel', { channel: dc }));
                        break;
                    }
                    case 'pc-track': {
                        const tr = transceiverFor(m.transceiver);
                        if (!s.transceivers.includes(tr))
                            s.transceivers.push(tr);
                        const receiver = tr.receiver;
                        const track = trackFor(m.track);
                        ReceiverSlots.get(receiver).track = track;
                        const streams = (m.streams || []).map((id) => {
                            const st = streamFor(m.pc, id);
                            const ss = StreamSlots.get(st);
                            if (!ss.tracks.includes(track)) {
                                ss.tracks.push(track);
                                sinksChanged(st);
                                fire(st, new MediaStreamTrackEvent('addtrack', { track }));
                            }
                            return st;
                        });
                        fire(target, new RTCTrackEvent('track', { receiver, track, streams, transceiver: tr }));
                        break;
                    }
                    case 'pc-removetrack': {
                        const track = tracksById.get(m.track);
                        for (const id of m.streams || []) {
                            const st = remoteStreams.get(m.pc + ' ' + id);
                            if (!st || !track)
                                continue;
                            const ss = StreamSlots.get(st);
                            const i = ss.tracks.indexOf(track);
                            if (i >= 0) {
                                ss.tracks.splice(i, 1);
                                sinksChanged(st);
                                fire(st, new MediaStreamTrackEvent('removetrack', { track }));
                            }
                        }
                        break;
                    }
                    default:
                        break;
                    }
                    return;
                }
                if (ChannelSlots.map.has(target)) {
                    const s = ChannelSlots.get(target);
                    // bufferedamountlow when the amount falls to the threshold or below (the host's own event is only an update).
                    if (m.bufferedAmount !== undefined) {
                        const before = s.bufferedAmount;
                        s.bufferedAmount = Math.max(0, m.bufferedAmount | 0);
                        if (before > s.lowThreshold && s.bufferedAmount <= s.lowThreshold && s.readyState === 'open')
                            fire(target, simple('bufferedamountlow'));
                    }
                    if (m.id !== undefined && m.id !== null)
                        s.id = m.id;
                    switch (m.t) {
                    case 'dc-open':
                        if (s.readyState !== 'connecting')
                            return;
                        s.readyState = 'open';
                        fire(target, simple('open'));
                        break;
                    case 'dc-message': {
                        if (s.readyState !== 'open')
                            return;
                        let data = m.data;
                        if (typeof data !== 'string' && s.binaryType === 'blob' && PBlob)
                            data = new PBlob([data]);
                        fire(target, new PMessageEvent('message', { data }));
                        break;
                    }
                    case 'dc-buffered':
                        break;
                    case 'dc-bufferedamountlow':
                        break;
                    case 'dc-closing':
                        if (s.readyState === 'closed' || s.readyState === 'closing')
                            return;
                        s.readyState = 'closing';
                        fire(target, simple('closing'));
                        break;
                    case 'dc-error': {
                        const ev = new PEvent('error');
                        try {
                            defineProperty(ev, 'error', { value: dom(String(m.message || 'Transport channel closed'), 'OperationError'), enumerable: true });
                        } catch { /* */ }
                        fire(target, ev);
                        break;
                    }
                    case 'dc-close':
                        if (s.readyState === 'closed')
                            return;
                        s.readyState = 'closed';
                        s.bufferedAmount = 0;
                        fire(target, simple('close'));
                        break;
                    default:
                        break;
                    }
                }
            };
            if (typeof port.start === 'function')
                port.start();

            const names = { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, RTCDataChannel, RTCRtpSender, RTCRtpReceiver, RTCRtpTransceiver, RTCStatsReport, RTCCertificate,
                RTCPeerConnectionIceEvent, RTCPeerConnectionIceErrorEvent, RTCDataChannelEvent, RTCTrackEvent, MediaStream, MediaStreamTrack, MediaStreamTrackEvent };
            const define = () => {
                if (options.enabled === false)
                    return;
                for (const [name, value] of Object.entries(names))
                    defineProperty(P, name, { value, writable: true, configurable: true });
                // Chrome's legacy alias.
                defineProperty(P, 'webkitRTCPeerConnection', { value: RTCPeerConnection, writable: true, configurable: true });
            };
            define();
            return {
                redefine: define,
                sinkBoxes,
                // A new document: its connections, channels and captures end with it (the host's objects are closed).
                closeAll: () => {
                    for (const pc of Array.from(live))
                        try { pc.close(); } catch { /* */ }
                    for (const [el, sink] of sinks) {
                        post({ t: 'sink-off', sink: sink.id });
                        sinks.delete(el);
                    }
                    lastBoxes = '';
                    post({ t: 'reset' });
                },
            };
        }
        return { install, parseCandidate };
    }
    G.__chitinRTC = Object.freeze({ create });
})();
