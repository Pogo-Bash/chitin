// The worker: on { open: url } it opens a WebSocket and reports what happens to the page that asked.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
const sockets = new Map();
self.addEventListener('message', (e) => {
    const m = e.data || {};
    const reply = (x) => e.source.postMessage(x);
    if (m.open) {
        let ws;
        try {
            ws = m.protocols ? new WebSocket(m.open, m.protocols) : new WebSocket(m.open);
        } catch (err) {
            reply({ id: m.id, event: 'threw', name: err.name, isDOM: err instanceof DOMException });
            return;
        }
        ws.binaryType = 'arraybuffer';
        sockets.set(m.id, ws);
        ws.onopen = () => reply({ id: m.id, event: 'open', protocol: ws.protocol, state: ws.readyState, url: ws.url, tag: Object.prototype.toString.call(ws), et: ws instanceof EventTarget });
        ws.onmessage = (ev) => reply({ id: m.id, event: 'message', data: typeof ev.data === 'string' ? ev.data : Array.from(new Uint8Array(ev.data)).slice(0, 8), size: typeof ev.data === 'string' ? ev.data.length : ev.data.byteLength });
        ws.onerror = () => reply({ id: m.id, event: 'error' });
        ws.onclose = (ev) => reply({ id: m.id, event: 'close', code: ev.code, reason: ev.reason, wasClean: ev.wasClean, state: ws.readyState });
    } else if (m.send !== undefined) {
        const ws = sockets.get(m.id);
        ws.send(m.send === 'binary' ? new Uint8Array([1, 2, 3]) : m.send);
    } else if (m.close) {
        sockets.get(m.id).close(m.code, m.reason);
    } else if (m.shape) {
        reply({ id: 'shape', names: Object.getOwnPropertyNames(WebSocket.prototype), consts: [WebSocket.CONNECTING, WebSocket.OPEN, WebSocket.CLOSING, WebSocket.CLOSED], typeofWS: typeof WebSocket });
    }
});
