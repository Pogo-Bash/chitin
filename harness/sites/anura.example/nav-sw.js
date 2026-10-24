// A controlled navigation answered from the worker's own IndexedDB (anura's worker serves its files from Filer over
// IndexedDB): the worker's database works while the page's document does not exist yet.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
const db = () => new Promise((resolve, reject) => {
    const r = indexedDB.open('swfs', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
});
async function visits() {
    const d = await db();
    const tx = d.transaction('files', 'readwrite');
    const store = tx.objectStore('files');
    const n = await new Promise((resolve) => { const g = store.get('visits'); g.onsuccess = () => resolve((g.result || 0) + 1); });
    store.put(n, 'visits');
    await new Promise((resolve) => { tx.oncomplete = resolve; });
    d.close();
    return n;
}
self.addEventListener('fetch', (event) => {
    const u = new URL(event.request.url);
    if (event.request.mode === 'navigate' && u.pathname.endsWith('/nav.html'))
        event.respondWith(visits().then((n) => new Response(`<!doctype html><title>served:${n}</title>`, { headers: { 'content-type': 'text/html' } }),
            (e) => new Response(`<!doctype html><title>sw-idb-error:${e.name}:${e.message}</title>`, { headers: { 'content-type': 'text/html' } })));
});
