// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Spiracle: the carapace's network Worker (docs/architecture.md). It holds the relay's URL and token,
// keeps one Wisp session to the relay, and turns each segment's stream requests into Wisp streams.
// Segments get a MessagePort to this Worker and nothing else: never the relay URL or the token, and
// only their own streams. A module Worker, so the Wisp client is shared with the Node tests.
//
// Carapace -> Spiracle: { type: 'config', url, token, ports } (ports: the destination ports segments may use; server --net-ports), { type: 'segment', name } with a port.
// Segment  -> Spiracle (on its port): { t: 'connect', s, host, port }, { t: 'data', s, b }, { t: 'close', s }.
// Spiracle -> segment: { t: 'open', s }, { t: 'data', s, b }, { t: 'close', s, code, reason }.
// Spiracle -> carapace: { type: 'status', key, value }.
import { WispClient } from './wisp.mjs';
import { NetGuard } from './guard.mjs';

let config = null;
let allowedPorts = [80, 443];
// Wisp sessions to the relay. A relay limits each WebSocket (relay.py: 64 open streams, 120 connects a minute by default) and
// allows a few per client address (8), so busy pages (a news front page and its ad frames: one connection per origin even over
// HTTP/2, Chrome's socket pool allows 256) spread over up to MAX_SESSIONS sessions: a stream goes to the session with the most
// room, and another session is opened when every open one is near its limits.
const MAX_SESSIONS = 4;
const SESSION_STREAMS = 56;          // under the relay's default 64 per WebSocket: room for streams still closing
const SESSION_CONNECTS_PER_MINUTE = 110; // under the relay's default 120
const SESSION_HOSTS_PER_MINUTE = 55;  // under the relay's scan rule: 60 distinct hosts a minute throttles the session for a minute
let sessions = [];                    // { client, connects: [times], hosts: Map(host -> last connect time) }
let connecting = null;
let wisp = null;                      // the first session (the status line's numbers)
const segments = new Map(); // name -> { port, streams: Map(localId -> WispStream) }

const status = (key, value) => self.postMessage({ type: 'status', key, value });

function sessionRoom(entry, now, host) {
    while (entry.connects.length && now - entry.connects[0] > 60000)
        entry.connects.shift();
    for (const [h, t] of entry.hosts)
        if (now - t > 60000)
            entry.hosts.delete(h);
    const hostRoom = entry.hosts.has(host) ? Infinity : SESSION_HOSTS_PER_MINUTE - entry.hosts.size;
    return Math.min(SESSION_STREAMS - entry.client.streamCount, SESSION_CONNECTS_PER_MINUTE - entry.connects.length, hostRoom);
}

async function openSession() {
    if (connecting)
        return connecting;
    if (!config || !config.url)
        throw new Error('no relay configured');
    connecting = (async () => {
        const entry = { client: null, connects: [], hosts: new Map() };
        const client = new WispClient({
            url: config.url,
            token: config.token || null,
            onMotd: (m) => status('relay message', m),
            onClose: (code) => {
                status('relay', `disconnected (${code})`);
                sessions = sessions.filter((x) => x !== entry);
                if (wisp === client)
                    wisp = sessions.length ? sessions[0].client : null;
            },
        });
        entry.client = client;
        const t0 = performance.now();
        try {
            await client.connect();
        } finally {
            connecting = null;
        }
        sessions.push(entry);
        if (!wisp)
            wisp = client;
        status('relay', `connected to ${config.url} in ${(performance.now() - t0).toFixed(0)} ms` + (sessions.length > 1 ? ` (session ${sessions.length})` : ''));
        return entry;
    })();
    return connecting;
}

// The session a new stream to `host` goes to (its connect and host counted there).
async function session(host) {
    const now = performance.now();
    sessions = sessions.filter((x) => x.client.connected);
    let best = null, room = -Infinity;
    for (const entry of sessions) {
        const r = sessionRoom(entry, now, host);
        if (r > room) {
            best = entry;
            room = r;
        }
    }
    if (!best || (room <= 0 && sessions.length < MAX_SESSIONS)) {
        try {
            best = await openSession();
        } catch (e) {
            if (!best)
                throw e;
        }
    }
    const t = performance.now();
    best.connects.push(t);
    best.hosts.set(host, t);
    return best.client;
}

// Everything a segment sends here is checked by NetGuard (guard.mjs): schema, destination policy, per-segment
// stream and rate limits, and a misbehaviour counter that kills the segment (its streams close, its port
// closes, the carapace removes the segment).
function onSegmentMessage(segment, e) {
    // The aux port (docs/network.md "Synchronous requests"): one per segment, given once; a stream connected with `aux: true`
    // has its events sent there (the segment document), because the segment Worker is blocked while it waits for them.
    if (e.data && e.data.t === 'aux') {
        if (!segment.aux && e.ports.length === 1)
            segment.aux = e.ports[0];
        else
            segment.guard.strike('a second aux port');
        return;
    }
    const aux = e.data && e.data.t === 'connect' && e.data.aux === true && segment.aux ? segment.aux : null;
    const { clean, refuse, reason } = segment.guard.accept(e.data);
    if (refuse !== undefined)
        (aux || segment.port).postMessage(reason ? { t: 'close', s: refuse, code: 0x49, reason } : { t: 'close', s: refuse, code: 0x41, reason: 'invalid destination' });
    const m = clean;
    if (!m)
        return;
    if (m.t === 'connect') {
        const host = m.host;
        const port = m.port;
        const out = aux || segment.port;
        session(host).then((client) => {
            if (segment.dead || segment.streams.has(m.s))
                return;
            const stream = client.open(host, port, {
                onOpen: () => out.postMessage({ t: 'open', s: m.s }),
                onData: (d) => {
                    const copy = new Uint8Array(d); // the WebSocket's buffer is not transferable in pieces
                    out.postMessage({ t: 'data', s: m.s, b: copy.buffer }, [copy.buffer]);
                },
                onClose: (code, reason) => {
                    segment.streams.delete(m.s);
                    segment.guard.closed(m.s);
                    out.postMessage({ t: 'close', s: m.s, code, reason });
                },
            });
            segment.streams.set(m.s, stream);
            status('streams', `${sessions.reduce((n, x) => n + x.client.streamCount, 0)} open over ${sessions.length} relay session${sessions.length === 1 ? '' : 's'}, ${(client.bytesReceived / 1024).toFixed(0)} KiB in, ${(client.bytesSent / 1024).toFixed(0)} KiB out`);
        }, (err) => {
            segment.guard.closed(m.s);
            status('relay', 'FAILED: ' + (err && err.message || err));
            out.postMessage({ t: 'close', s: m.s, code: 0x03, reason: 'relay unavailable: ' + (err && err.message || err) });
        });
        return;
    }
    const stream = segment.streams.get(m.s);
    if (!stream)
        return;
    if (m.t === 'data')
        stream.write(new Uint8Array(m.b));
    else if (m.t === 'close') {
        segment.streams.delete(m.s);
        stream.close();
    }
}

self.onmessage = (e) => {
    const m = e.data;
    if (!m)
        return;
    if (m.type === 'config') {
        config = { url: m.url, token: m.token };
        if (Array.isArray(m.ports) && m.ports.every((n) => Number.isInteger(n) && n > 0 && n < 65536))
            allowedPorts = m.ports;
        for (const entry of sessions)
            entry.client.close();
        sessions = [];
        wisp = null;
        status('relay', `configured: ${m.url}${m.token ? ' (with a token)' : ''}`);
    } else if (m.type === 'segment') {
        const port = e.ports[0];
        if (!port || typeof m.name !== 'string')
            return;
        const segment = { port, streams: new Map(), dead: false, guard: null, name: m.name };
        segment.guard = new NetGuard({
            limits: { allowedPorts },
            kill: (reason) => {
                segment.dead = true;
                for (const st of segment.streams.values())
                    st.close();
                segment.streams.clear();
                port.close();
                if (segment.aux)
                    segment.aux.close();
                status('segment killed', `${m.name}: ${reason}`);
                self.postMessage({ type: 'kill', name: m.name, reason });
            },
        });
        if (segments.has(m.name)) {
            const old = segments.get(m.name);
            old.dead = true;
            for (const st of old.streams.values())
                st.close();
            old.port.close();
        }
        segments.set(m.name, segment);
        port.onmessage = (ev) => onSegmentMessage(segment, ev);
    }
};
