// The test site's service worker (harness/sites/pwa.example): the shape of a hand-written PWA worker.
importScripts('lib.js');
const VERSION = 'v1';
const CACHE = 'static-' + VERSION;

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['./', './app.css', './data.json'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        for (const name of await caches.keys())
            if (name !== CACHE)
                await caches.delete(name);
        await self.clients.claim();
        for (const client of await self.clients.matchAll({ type: 'window' }))
            client.postMessage({ type: 'activated', version: VERSION });
    })());
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.pathname.endsWith('/hello')) {
        event.respondWith(new Response('hello from the service worker ' + VERSION + ' with ' + LIB_VERSION, { headers: { 'Content-Type': 'text/plain' } }));
        return;
    }
    if (event.request.method !== 'GET' || url.origin !== self.location.origin)
        return;
    event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
    })));
});

self.addEventListener('message', (event) => {
    const reply = { type: 'pong', version: VERSION, got: event.data, from: event.source && event.source.type };
    if (event.ports[0])
        event.ports[0].postMessage(reply);
    if (event.source)
        event.source.postMessage(reply);
});
