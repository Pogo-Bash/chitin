// The test site's own service worker: proxied pages and their API under /service/ (synthesized here, as a proxy's are).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
const page = (title, script) => new Response(`<!doctype html><html><head><title>${title}</title></head><body><p id="p">${title}</p><script>${script}<\/script></body></html>`, { headers: { 'Content-Type': 'text/html' } });
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.pathname === '/service/page')
        event.respondWith(page('proxied page', `fetch('/service/api?q=1').then((r) => r.json()).then((j) => { window.api = j.answer + ' ' + j.seen + ' ' + j.client; parent.frameEvents.push('api ' + window.api); setTimeout(() => { location.href = '/service/next'; }, 10); });`));
    else if (url.pathname === '/service/next') {
        // A frame's navigation has no client yet; its new document is the resulting client (as in Chrome).
        const ids = (event.clientId === '' ? 'no client' : 'a client') + (event.resultingClientId ? ', a resulting client' : '');
        event.respondWith(page('next page', `parent.frameEvents.push('next ran ' + document.title + ' ' + (window.api === undefined) + ' ${ids}');`));
    } else if (url.pathname === '/service/api') {
        // A frame's request is its own document's: clients.get(event.clientId) is the frame (Scramjet unrewrites its URL).
        event.respondWith(self.clients.get(event.clientId).then((c) => new Response(JSON.stringify({ answer: 42, seen: url.search, client: c ? new URL(c.url).pathname + ' ' + c.frameType : 'none' }), { headers: { 'Content-Type': 'application/json' } })));
    }
});
