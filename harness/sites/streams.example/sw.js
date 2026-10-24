// The test site's service worker (harness/sites/streams.example): transferable streams both ways, over a client's postMessage,
// over a reply port, and as a streamed fetch response (the shape of Scramjet's controller and service worker).
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const bytes = (...n) => new Uint8Array(n);
let gate = null;               // resolves when the page says 'release'
let gateOpen = () => {};
function newGate() { gate = new Promise((resolve) => { gateOpen = resolve; }); }
newGate();
const state = { cancelled: [], aborted: [] };

async function drain(stream) {
    const reader = stream.getReader();
    const chunks = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            return chunks;
        chunks.push(Array.from(value));
    }
}
// A source of three chunks; the third waits for the gate when `gated` (for ever when 'hold'); records a cancel.
function source(name, gated) {
    let i = 0;
    return new ReadableStream({
        async pull(controller) {
            i++;
            if (i === 3 && gated)
                await (gated === 'hold' ? new Promise(() => {}) : gate);
            if (i > 3)
                return controller.close();
            controller.enqueue(bytes(i, i * 10));
        },
        cancel(reason) { state.cancelled.push(name + ':' + reason); },
    });
}

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    (state.seen = state.seen || []).push(url.href);
    if (url.pathname.endsWith('/streamed'))
        event.respondWith(new Response(source('fetch', false), { headers: { 'Content-Type': 'application/octet-stream', 'X-Streamed': '1' } }));
    else if (url.pathname.endsWith('/endless'))
        event.respondWith(new Response(new ReadableStream({ pull(c) { c.enqueue(bytes(9)); }, cancel() { state.cancelled.push('fetch'); } }), { headers: { 'Content-Type': 'application/octet-stream' } })); // Chrome does not pass the page's reason on
    else if (url.pathname.endsWith('/gated'))
        event.respondWith(new Response(source('gated', true), { headers: { 'Content-Type': 'application/octet-stream' } }));
    else if (url.pathname.endsWith('/gated-text')) {
        // Text, not bytes, as a proxy answers: the body is read as text by the page.
        const enc = new TextEncoder();
        let i = 0;
        event.respondWith(new Response(new ReadableStream({
            async pull(c) { i++; if (i === 2) await gate; if (i > 2) return c.close(); c.enqueue(enc.encode('part' + i + ';')); },
        }), { headers: { 'Content-Type': 'text/plain' } }));
    }
});

self.addEventListener('message', (event) => {
    const d = event.data || {};
    const port = event.ports[0];
    const reply = (m, transfer) => (port ? port.postMessage(m, transfer || []) : event.source.postMessage(m, transfer || []));
    event.waitUntil((async () => {
        switch (d.type) {
        case 'sink': // a stream from the page: read all of it, report the chunks
            const chunks = await drain(d.stream);
            reply({ type: 'sunk', chunks });
            break;
        case 'sink-cancel': { // read one chunk, then cancel with a reason
            const reader = d.stream.getReader();
            const first = await reader.read();
            await reader.cancel('stop-from-worker');
            reply({ type: 'cancelled', first: Array.from(first.value) });
            break;
        }
        case 'sink-error': { // the page errors its stream: the worker's read rejects
            const reader = d.stream.getReader();
            try { await reader.read(); await reader.read(); reply({ type: 'errored', error: 'none' }); } catch (e) { reply({ type: 'errored', error: String(e && e.message || e) }); }
            break;
        }
        case 'source-transfer': {
            const stream = source('source', false);
            reply({ type: 'source', stream }, [stream]);
            break;
        }
        case 'source-nested': {
            const stream = source('nested', false);
            reply({ type: 'source', deep: { list: [{ stream }] }, n: 5 }, [stream]);
            break;
        }
        case 'source-cancel': {
            // Held at the third chunk: otherwise the cancel races the bridges' read-ahead to the end of three chunks (a stream
            // that has closed has nothing to cancel), and which wins is timing (docs/crypto.md: one task per host turn).
            const stream = source('cancel', 'hold');
            reply({ type: 'source', stream }, [stream]);
            break;
        }
        case 'echo': // a stream from the page goes back to it, through the worker
            reply({ type: 'echo', stream: d.stream }, [d.stream]);
            break;
        case 'writable': { // write into the page's WritableStream, then close it
            const w = d.writable.getWriter();
            await w.write(bytes(1, 2));
            await w.write(bytes(3));
            await w.close();
            reply({ type: 'written' });
            break;
        }
        case 'writable-abort': {
            const w = d.writable.getWriter();
            await w.abort('abort-from-worker');
            reply({ type: 'written' });
            break;
        }
        case 'transform': { // a TransformStream from the page: write into its writable, read what the page's transform made
            const w = d.transform.writable.getWriter();
            w.write(bytes(1)); w.write(bytes(2)); w.close();
            reply({ type: 'transformed', chunks: await drain(d.transform.readable) });
            break;
        }
        case 'release':
            gateOpen(); newGate();
            reply({ type: 'released' });
            break;
        case 'state': {
            reply({ type: 'state', cancelled: state.cancelled.slice(), seen: state.seen || [] });
            break;
        }
        default:
            reply({ type: 'unknown' });
        }
    })().catch((e) => reply({ type: 'error', error: String(e && e.stack || e) })));
});
