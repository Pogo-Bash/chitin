// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// The worker of idbsw.example: what workbox-expiration does with IndexedDB (open with an upgrade, an index, puts in one
// transaction, a cursor over an index, deletes, promise-wrapped requests across awaits), plus the shape of the interfaces.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const done = (tx) => new Promise((resolve, reject) => { tx.oncomplete = () => resolve('complete'); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });
async function run() {
    const out = {};
    out.shape = [typeof indexedDB, typeof IDBFactory, typeof IDBKeyRange, typeof IDBCursorWithValue, indexedDB instanceof IDBFactory,
        Object.prototype.toString.call(indexedDB), typeof self.caches];
    // The rest of a WorkerGlobalScope's storage, by name.
    const nav = self.navigator;
    // (navigator.storageBuckets, Chrome's Storage Buckets API, is not compared: the page has none in Chitin either.)
    out.storage = ['storage', 'locks'].map((n) => n + ':' + typeof nav[n]).concat(
        ['estimate', 'persisted', 'persist', 'getDirectory'].map((n) => 'storage.' + n + ':' + (nav.storage ? typeof nav.storage[n] : '-')),
        ['request', 'query'].map((n) => 'locks.' + n + ':' + (nav.locks ? typeof nav.locks[n] : '-')),
        ['cookieStore', 'CookieStore', 'LockManager', 'StorageManager', 'CacheStorage'].map((n) => n + ':' + typeof self[n]));
    const open = indexedDB.open('sw-db', 2);
    const events = self.events = [];
    open.onupgradeneeded = (e) => {
        events.push('upgrade ' + e.oldVersion + '->' + e.newVersion + ' ' + (e instanceof IDBVersionChangeEvent));
        const db = open.result;
        const store = db.createObjectStore('entries', { keyPath: 'id' });
        store.createIndex('cacheName', 'cacheName', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        events.push('stores ' + [...db.objectStoreNames].join(','));
        open.transaction.oncomplete = () => events.push('upgrade complete');
    };
    const db = await req(open);
    events.push('open ' + db.version);
    const tx = db.transaction('entries', 'readwrite');
    const st = tx.objectStore('entries');
    for (let i = 0; i < 5; i++)
        st.put({ id: 'c|https://x/' + i, cacheName: 'c', url: 'https://x/' + i, timestamp: 1000 + i });
    st.put({ id: 'd|https://y/', cacheName: 'd', url: 'https://y/', timestamp: 5 });
    events.push('tx ' + await done(tx));
    // workbox: the oldest entries of one cache through the timestamp index, deleted with the cursor.
    const tx2 = db.transaction('entries', 'readwrite');
    const index = tx2.objectStore('entries').index('timestamp');
    const seen = self.seen = [];
    await new Promise((resolve, reject) => {
        const c = index.openCursor(IDBKeyRange.bound(1000, 1002), 'prev');
        c.onsuccess = () => {
            const cur = c.result;
            if (!cur) { seen.push('end'); resolve(); return; }
            seen.push(cur.value.url + '@' + cur.key);
            if (cur.key === 1001)
                cur.delete();
            cur.continue();
        };
        c.onerror = () => reject(c.error);
    });
    events.push('cursor ' + seen.join(' '));
    events.push('tx2 ' + await done(tx2));
    // Across awaits inside one transaction: requests made in a promise callback of a success (idb's style).
    const tx3 = db.transaction('entries', 'readwrite');
    const s3 = tx3.objectStore('entries');
    const got = await req(s3.get('c|https://x/0'));
    got.timestamp = 9;
    await req(s3.put(got));
    const count = await req(s3.index('cacheName').count('c'));
    const keys = await req(s3.getAllKeys());
    events.push('tx3 ' + count + ' ' + keys.length + ' ' + await done(tx3));
    // Errors: a duplicate add fails the request and aborts the transaction (ConstraintError), not prevented.
    const tx4 = db.transaction('entries', 'readwrite');
    const a = tx4.objectStore('entries').add({ id: 'd|https://y/' });
    a.onerror = () => events.push('add error ' + a.error.name);
    await done(tx4).catch((e) => events.push('tx4 abort ' + (e && e.name)));
    out.sync = [];
    for (const f of [() => db.transaction('nope'), () => db.transaction([]), () => IDBKeyRange.bound(2, 1), () => indexedDB.cmp([1, 'a'], [1, 'b']), () => new IDBKeyRange()])
        try { out.sync.push(String(f())); } catch (e) { out.sync.push(e.name); }
    db.close();
    out.locks = await navigator.locks.request('sw-lock', async (lock) => {
        const q = await navigator.locks.query();
        return [lock.name, lock.mode, q.held.map((l) => l.name + ':' + l.mode).join(','), lock instanceof Lock];
    });
    out.ifAvailable = await navigator.locks.request('sw-lock', () => navigator.locks.request('sw-lock', { ifAvailable: true }, (l) => l === null));
    await cookieStore.set('swc', 'v1').catch((e) => e.name);
    out.cookie = await cookieStore.get('swc').then((c) => c && [c.name, c.value], (e) => e.name);
    events.length; // (kept)
    out.events = events;
    out.dbs = (await indexedDB.databases()).map((d) => d.name + ':' + d.version);
    return out;
}
self.addEventListener('message', (e) => {
    const stuck = new Promise((resolve) => setTimeout(() => resolve({ stuck: self.events || null, seen: self.seen || null }), 25000));
    e.waitUntil(Promise.race([run(), stuck]).catch((err) => ({ failed: String(err && err.stack || err), events: self.events || null })).then((out) => e.source.postMessage(out)));
});
