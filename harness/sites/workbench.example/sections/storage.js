// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Storage: Web Storage, IndexedDB (keys, cursors, indexes, transaction event order, versionchange), OPFS, Cache API, cookies.
WB.section('storage', async (t) => {
    const ns = t.ns('st');
    await t.check('localStorage', () => {
        for (const k of Object.keys(localStorage)) if (k.startsWith(ns)) localStorage.removeItem(k);
        localStorage.setItem(ns + 'b', '2'); localStorage.setItem(ns + 'a', 1); localStorage[ns + 'c'] = { x: 1 };
        const v = [localStorage.getItem(ns + 'a'), localStorage.getItem(ns + 'c'), localStorage.getItem(ns + 'none'), Object.keys(localStorage).filter((k) => k.startsWith(ns)).sort()];
        let quota = null; try { localStorage.setItem(ns + 'big', 'x'.repeat(6 * 1024 * 1024)); quota = 'stored'; } catch (e) { quota = e.name; }
        localStorage.removeItem(ns + 'big');
        return [...v, quota];
    });
    await t.check('sessionStorage', () => { sessionStorage.setItem(ns, 'v'); const v = sessionStorage.getItem(ns); sessionStorage.removeItem(ns); return [v, sessionStorage.getItem(ns)]; });
    await t.check('storageEvent', async () => {
        const f = document.createElement('iframe'); f.src = 'frame.html?role=storage'; t.root.append(f);
        await new Promise((r) => (f.onload = r));
        const got = new Promise((r) => f.contentWindow.addEventListener('storage', (e) => r([e.key === ns + 'ev', e.oldValue, e.newValue, e.storageArea === f.contentWindow.localStorage, e.url.replace(/^.*\//, '').replace(/\?.*/, '')])));
        localStorage.setItem(ns + 'ev', 'n');
        const r = await t.withTimeout(got, 5000, 'storage event');
        localStorage.removeItem(ns + 'ev'); f.remove();
        return r;
    });
    const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    await t.check('indexedDB', async () => {
        const L = [];
        await req(indexedDB.deleteDatabase(ns));
        const open = indexedDB.open(ns, 2);
        open.onupgradeneeded = (e) => {
            L.push('upgrade:' + e.oldVersion + '->' + e.newVersion);
            const db = open.result;
            const s = db.createObjectStore('s', { keyPath: 'id' });
            s.createIndex('by', 'tag', { unique: false });
            db.createObjectStore('k', { autoIncrement: true });
            open.transaction.oncomplete = () => L.push('versionchange-complete');
        };
        open.onsuccess = () => L.push('open-success');
        const db = await req(open);
        const tx = db.transaction(['s', 'k'], 'readwrite');
        const s = tx.objectStore('s');
        const keys = [3, 'b', -1, [1, 'a'], new Date(5), 'a', 2.5, [1], new Uint8Array([1, 2]).buffer];
        keys.forEach((id, i) => s.put({ id, tag: i % 2 ? 'odd' : 'even', i }).onsuccess = () => L.push('put' + i));
        tx.objectStore('k').add('x'); tx.objectStore('k').add('y').onsuccess = (e) => L.push('auto:' + e.target.result);
        const dup = s.add({ id: 3 }); dup.onerror = (e) => { L.push('dup:' + dup.error.name); e.preventDefault(); };
        Promise.resolve().then(() => L.push('microtask-during-tx'));
        await new Promise((r) => (tx.oncomplete = () => { L.push('tx-complete'); r(); }));
        const r = db.transaction('s').objectStore('s');
        const all = (await req(r.getAllKeys())).map((k) => (k instanceof ArrayBuffer ? 'buf' + k.byteLength : k instanceof Date ? 'date' : JSON.stringify(k)));
        const idx = (await req(r.index('by').getAll('odd'))).map((x) => x.i);
        const cur = [];
        await new Promise((resolve) => { const c = db.transaction('s').objectStore('s').openCursor(IDBKeyRange.bound(0, 'z'), 'prev'); c.onsuccess = () => { const x = c.result; if (!x) return resolve(); cur.push(x.value.i); x.continue(); }; });
        const count = await req(db.transaction('s').objectStore('s').count(IDBKeyRange.lowerBound(0)));
        const cmp = [indexedDB.cmp(1, '1'), indexedDB.cmp([1], [1, 0]), indexedDB.cmp('a', 'B')];
        let badKey = null; try { indexedDB.cmp({}, 1); } catch (e) { badKey = e.name; }
        let inactive = null; try { tx.objectStore('s').get(1); } catch (e) { inactive = e.name; }
        const ro = db.transaction('s'); let roErr = null; try { ro.objectStore('s').put({ id: 9 }); } catch (e) { roErr = e.name; }
        db.onversionchange = () => { L.push('onversionchange'); db.close(); };
        const re = indexedDB.open(ns, 3); re.onblocked = () => L.push('blocked');
        re.onupgradeneeded = (e) => L.push('upgrade:' + e.oldVersion + '->' + e.newVersion);
        const db3 = await req(re); db3.close();
        const dbs = indexedDB.databases ? (await indexedDB.databases()).filter((d) => d.name === ns).map((d) => d.version) : 'n/a';
        await req(indexedDB.deleteDatabase(ns));
        return { order: L, all, idx, cur, count, cmp, badKey, inactive, roErr, dbs, names: [...db.objectStoreNames] };
    });
    await t.check('opfs', async () => {
        if (!navigator.storage || !navigator.storage.getDirectory) return 'no OPFS';
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle(ns, { create: true });
        const fh = await dir.getFileHandle('a.txt', { create: true });
        const w = await fh.createWritable(); await w.write('hello opfs'); await w.seek(0); await w.write('J'); await w.truncate(8); await w.close();
        const file = await fh.getFile(); const text = await file.text();
        await dir.getDirectoryHandle('sub', { create: true });
        const names = []; for await (const [n, h] of dir.entries()) names.push(n + ':' + h.kind);
        let missing = null; try { await dir.getFileHandle('nope'); } catch (e) { missing = e.name; }
        const resolved = await root.resolve(fh);
        await root.removeEntry(ns, { recursive: true });
        return [text, file.size, file.name, names.sort(), missing, resolved && resolved.map((x) => (x === ns ? 'NS' : x)), await fh.isSameEntry(fh)];
    });
    await t.check('cacheAPI', async () => {
        if (!self.caches) return 'no caches';
        await caches.delete(ns);
        const c = await caches.open(ns);
        await c.put('/api/json?c=1', new Response('cached', { headers: { 'x-a': '1' } }));
        await c.add('/api/json?c=2');
        const m = await c.match('/api/json?c=1');
        const ig = await c.match('/api/json?c=9', { ignoreSearch: true });
        const keys = (await c.keys()).map((r) => new URL(r.url).search);
        const has = await caches.has(ns);
        const del = await c.delete('/api/json?c=1');
        await caches.delete(ns);
        return [await m.text(), m.headers.get('x-a'), !!ig, keys, has, del, await caches.has(ns)];
    });
    await t.check('cookies', async () => {
        const n = ns.replace(/-/g, '_');
        document.cookie = n + 'a=1; path=/';
        document.cookie = n + 'b=2; path=/; max-age=3600; samesite=strict';
        document.cookie = n + 'c=3; path=/nowhere';
        document.cookie = n + 'd=4; path=/; secure';
        document.cookie = n + 'b=; path=/; max-age=0';
        await fetch('/api/set-cookie?name=' + n + 's');
        const mine = document.cookie.split('; ').filter((c) => c.startsWith(n)).sort();
        const store = self.cookieStore ? (await cookieStore.getAll()).map((c) => c.name).filter((x) => x.startsWith(n)).sort() : 'no cookieStore';
        const sent = await (await fetch('/api/cookies')).text();
        for (const c of mine) document.cookie = c.split('=')[0] + '=; path=/; max-age=0';
        return { mine, store, sent: sent.split('; ').filter((c) => c.startsWith(n)).sort() };
    });
    await t.check('storageManager', async () => { if (!navigator.storage) return 'none'; const e = await navigator.storage.estimate(); return [typeof e.quota, typeof e.usage, typeof navigator.storage.persist]; });
});
