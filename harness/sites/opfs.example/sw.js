// The test site's service worker (harness/sites/opfs.example): OPFS in the worker, over the same files as the page's.
self.addEventListener('install', (event) => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener('message', (event) => {
    event.waitUntil((async () => {
        const out = {};
        out.same = [navigator.storage instanceof StorageManager, typeof FileSystemDirectoryHandle, typeof FileSystemSyncAccessHandle, 'createSyncAccessHandle' in FileSystemFileHandle.prototype];
        const root = await navigator.storage.getDirectory();
        const docs = await root.getDirectoryHandle('docs', { create: true });
        const seen = await (await (await docs.getFileHandle('a.txt')).getFile()).text();
        const w = await (await docs.getFileHandle('from-sw.txt', { create: true })).createWritable();
        await w.write('from the worker: ' + seen);
        await w.close();
        out.seen = seen;
        out.missing = await docs.getFileHandle('nope').then(() => 'ok', (e) => (e instanceof DOMException ? 'DOMException:' : 'other:') + e.name);
        out.estimate = typeof (await navigator.storage.estimate()).quota;
        event.ports[0].postMessage(out);
    })().catch((e) => event.ports[0].postMessage({ error: String(e) })));
});
