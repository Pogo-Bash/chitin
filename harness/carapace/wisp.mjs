// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// A Wisp v2.1 client (MercuryWorkshop/wisp-protocol, protocol.md): one WebSocket to a relay, many TCP
// streams inside it. Used by Spiracle (the carapace's network Worker) and by the Node tests; it needs
// only a WebSocket constructor. Packets are little-endian: type u8, stream id u32, payload.
//
//   const wisp = new WispClient({ url, token });
//   await wisp.connect();                        // INFO exchange, password auth, CONTINUE for stream 0
//   const s = wisp.open('example.org', 443, { onOpen, onData, onClose });
//   s.write(bytes); s.close();
//
// Flow control follows the spec: the relay says how many DATA packets it buffers per stream; the client
// counts down and queues writes at zero until a CONTINUE arrives. The relay confirms a stream once its
// TCP socket is connected (extension 0x05): that first CONTINUE is `onOpen`.

const CONNECT = 1, DATA = 2, CONTINUE = 3, CLOSE = 4, INFO = 5;
const EXT_PASSWORD = 2, EXT_MOTD = 4, EXT_OPEN_CONFIRM = 5;

export const closeReasons = {
    0x01: 'unspecified', 0x02: 'closed', 0x03: 'network error', 0x04: 'incompatible extensions',
    0x41: 'invalid destination', 0x42: 'host not found', 0x43: 'connection timed out', 0x44: 'connection refused',
    0x47: 'stream idle too long', 0x48: 'destination blocked by the relay', 0x49: 'throttled by the relay',
    0x81: 'client error', 0xc0: 'relay refused the token', 0xc1: 'relay refused the key', 0xc2: 'relay requires a token',
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_DATA = 16384; // largest DATA payload this client sends (relays cap one packet well above this)

function packet(type, id, payload) {
    const out = new Uint8Array(5 + payload.length);
    const view = new DataView(out.buffer);
    view.setUint8(0, type);
    view.setUint32(1, id, true);
    out.set(payload, 5);
    return out;
}

export class WispClient {
    #url; #token; #username; #WebSocket; #ws = null; #streams = new Map(); #bufferSize = 0;
    #ready = null; #onClose; #onMotd; #serverExtensions = new Set(); #openConfirm = false;
    bytesSent = 0; bytesReceived = 0; motd = '';

    constructor({ url, token = null, username = 'chitin', WebSocket: WS = globalThis.WebSocket, onClose = null, onMotd = null }) {
        this.#url = url;
        this.#token = token;
        this.#username = username;
        this.#WebSocket = WS;
        this.#onClose = onClose;
        this.#onMotd = onMotd;
    }

    get connected() { return this.#ws !== null && this.#ws.readyState === 1 && this.#bufferSize > 0; }
    get streamCount() { return this.#streams.size; }

    // Resolves once the relay accepted the session (CONTINUE for stream 0); rejects with the relay's
    // close reason or the socket error.
    connect() {
        if (this.#ready)
            return this.#ready;
        this.#ready = new Promise((resolve, reject) => {
            let ws;
            try {
                // The spec requires Sec-WebSocket-Protocol to be present; its value is unspecified.
                ws = new this.#WebSocket(this.#url, ['wisp-v2']);
            } catch (e) {
                this.#ready = null;
                reject(e);
                return;
            }
            ws.binaryType = 'arraybuffer';
            let settled = false;
            const fail = (message) => {
                if (!settled) {
                    settled = true;
                    this.#ready = null;
                    reject(new Error(message));
                }
            };
            ws.onerror = () => fail('relay unreachable: ' + this.#url);
            ws.onclose = (e) => {
                fail('relay closed the socket (' + e.code + ')');
                this.#ws = null;
                this.#bufferSize = 0;
                const streams = [...this.#streams.values()];
                this.#streams.clear();
                for (const s of streams)
                    s._closed(0x03);
                this.#ready = null;
                if (this.#onClose)
                    this.#onClose(e.code, e.reason);
            };
            ws.onmessage = (e) => {
                const bytes = new Uint8Array(e.data);
                if (bytes.length < 5)
                    return;
                this.bytesReceived += bytes.length;
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                const type = view.getUint8(0);
                const id = view.getUint32(1, true);
                const payload = bytes.subarray(5);
                if (id === 0) {
                    if (type === INFO) {
                        this.#readServerInfo(payload);
                        ws.send(this.#clientInfo());
                    } else if (type === CONTINUE && payload.length >= 4) {
                        this.#bufferSize = new DataView(payload.buffer, payload.byteOffset).getUint32(0, true);
                        if (!settled) {
                            settled = true;
                            resolve(this);
                        }
                    } else if (type === CLOSE) {
                        const reason = payload[0] || 1;
                        fail('relay refused the session: ' + (closeReasons[reason] || reason));
                    }
                    return;
                }
                const stream = this.#streams.get(id);
                if (!stream)
                    return;
                if (type === DATA)
                    stream._data(payload);
                else if (type === CONTINUE && payload.length >= 4)
                    stream._continue(new DataView(payload.buffer, payload.byteOffset).getUint32(0, true));
                else if (type === CLOSE) {
                    this.#streams.delete(id);
                    stream._closed(payload[0] || 1);
                }
            };
            this.#ws = ws;
        });
        return this.#ready;
    }

    #readServerInfo(payload) {
        // version major, minor, then extension entries: id u8, length u32, data.
        let i = 2;
        while (i + 5 <= payload.length) {
            const view = new DataView(payload.buffer, payload.byteOffset + i);
            const ext = view.getUint8(0);
            const n = view.getUint32(1, true);
            const data = payload.subarray(i + 5, i + 5 + n);
            this.#serverExtensions.add(ext);
            if (ext === EXT_MOTD) {
                this.motd = decoder.decode(data);
                if (this.#onMotd)
                    this.#onMotd(this.motd);
            } else if (ext === EXT_OPEN_CONFIRM)
                this.#openConfirm = true;
            i += 5 + n;
        }
    }

    #clientInfo() {
        const parts = [];
        if (this.#token !== null && this.#serverExtensions.has(EXT_PASSWORD)) {
            const user = encoder.encode(this.#username);
            const pass = encoder.encode(this.#token);
            const data = new Uint8Array(1 + user.length + pass.length);
            data[0] = user.length;
            data.set(user, 1);
            data.set(pass, 1 + user.length);
            parts.push([EXT_PASSWORD, data]);
        }
        parts.push([EXT_OPEN_CONFIRM, new Uint8Array(0)]);
        let total = 2;
        for (const [, data] of parts)
            total += 5 + data.length;
        const payload = new Uint8Array(total);
        payload[0] = 2;
        payload[1] = 1;
        let i = 2;
        for (const [ext, data] of parts) {
            payload[i] = ext;
            new DataView(payload.buffer).setUint32(i + 1, data.length, true);
            payload.set(data, i + 5);
            i += 5 + data.length;
        }
        return packet(INFO, 0, payload);
    }

    _send(bytes) {
        this.bytesSent += bytes.length;
        this.#ws.send(bytes);
    }

    // A new TCP stream. Callbacks: onOpen() once the relay confirms the socket, onData(Uint8Array),
    // onClose(reasonCode, reasonText). Returns the stream; write()/close() may be called at once.
    open(host, port, callbacks) {
        if (!this.connected)
            throw new Error('not connected to the relay');
        let id;
        do {
            id = (Math.random() * 0xffffffff >>> 0) || 1;
        } while (this.#streams.has(id));
        const stream = new WispStream(this, id, this.#bufferSize, callbacks, this.#openConfirm);
        this.#streams.set(id, stream);
        const name = encoder.encode(host);
        const payload = new Uint8Array(3 + name.length);
        payload[0] = 1; // TCP
        new DataView(payload.buffer).setUint16(1, port, true);
        payload.set(name, 3);
        this._send(packet(CONNECT, id, payload));
        return stream;
    }

    _closeStream(id) {
        if (this.#streams.delete(id) && this.#ws && this.#ws.readyState === 1)
            this._send(packet(CLOSE, id, new Uint8Array([0x02])));
    }

    close() {
        if (this.#ws)
            this.#ws.close(1000);
    }
}

class WispStream {
    #client; #credit; #queue = []; #callbacks; #open; #closed = false;
    bytesSent = 0; bytesReceived = 0;

    constructor(client, id, credit, callbacks, confirmed) {
        this.#client = client;
        this.id = id;
        this.#credit = credit;
        this.#callbacks = callbacks;
        // Without the confirmation extension the stream counts as open at once.
        this.#open = !confirmed;
        if (this.#open && callbacks.onOpen)
            queueMicrotask(() => { if (!this.#closed) callbacks.onOpen(); });
    }

    get open() { return this.#open && !this.#closed; }
    get closed() { return this.#closed; }

    write(bytes) {
        if (this.#closed)
            return false;
        if (bytes.length > MAX_DATA) {
            // One packet per MAX_DATA bytes, each using one credit: relays cap what one packet may carry.
            let sent = true;
            for (let i = 0; i < bytes.length; i += MAX_DATA)
                sent = this.#writeOne(bytes.subarray(i, i + MAX_DATA)) && sent;
            return sent;
        }
        return this.#writeOne(bytes);
    }

    #writeOne(bytes) {
        if (this.#closed)
            return false;
        if (this.#credit <= 0) {
            this.#queue.push(bytes);
            return false;
        }
        this.#credit--;
        this.bytesSent += bytes.length;
        this.#client._send(packet(DATA, this.id, bytes));
        return true;
    }

    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        this.#queue = [];
        this.#client._closeStream(this.id);
    }

    _data(payload) {
        this.bytesReceived += payload.length;
        if (this.#callbacks.onData)
            this.#callbacks.onData(payload);
    }

    _continue(n) {
        this.#credit = n;
        if (!this.#open) {
            this.#open = true;
            if (this.#callbacks.onOpen)
                this.#callbacks.onOpen();
        }
        while (this.#queue.length && this.#credit > 0)
            this.#writeOne(this.#queue.shift());
    }

    _closed(reason) {
        if (this.#closed)
            return;
        this.#closed = true;
        this.#queue = [];
        if (this.#callbacks.onClose)
            this.#callbacks.onClose(reason, closeReasons[reason] || ('reason ' + reason));
    }
}
