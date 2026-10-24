// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// The carapace's cookie store (docs/cookies.md): every cookie of the browser, in one place on the carapace's origin, which
// never runs site code. Segments keep a copy of what they are entitled to (glue/cookies.js createJar) and send their changes
// here; the store checks each record against the segment's entitlement before it keeps it, and forwards it to the other live
// segments entitled to it. A segment is entitled to two things only:
//   - the unpartitioned jar of its own site (the segment's origin is hash(site): it is that site's process anyway);
//   - the partitions of its own context: '<its top-level schemeful site> 0' for a top-level segment, '<the top-level site>
//     1' for a cross-site iframe's segment (CHIPS, with the cross-site ancestor bit). A partition holds Partitioned cookies of
//     any site and, under '\tu', the cookies a third-party response set in that context without Partitioned.
// So no segment ever receives another site's unpartitioned cookies, and HttpOnly ones only reach a segment of their own site,
// whose engine sends them; page code never reads them (the jar's forScript drops them).
//
// Persistence: IndexedDB on the carapace's origin ('chitin-cookies'), each persistent cookie encrypted with AES-GCM under a
// non-extractable key kept in the same database (at rest the values are ciphertext; the key cannot be read out of the
// browser by script, only used). Session cookies (no Expires/Max-Age) live in memory for the life of the carapace, as a
// browser session.
import ChitinCookies from '../../build/cookies.mjs';

const C = ChitinCookies;
const DB = 'chitin-cookies';
const MAX_WRITES_PER_MESSAGE = 256;

const partitionTop = (key) => {
    const sp = key.lastIndexOf(' ');
    return sp < 0 ? key : key.slice(0, sp);
};
const siteOfSchemeful = (s) => s.replace(/^[a-z]+:\/\//, '');

export class CookieStore {
    constructor({ persist = true, now = () => Date.now(), indexedDB = globalThis.indexedDB, crypto = globalThis.crypto } = {}) {
        this.now = now;
        this.persist = persist && !!indexedDB && !!(crypto && crypto.subtle);
        this.idb = indexedDB;
        this.crypto = crypto;
        this.all = C.createStore(now);
        this.dirty = new Map();          // key -> record | null (delete)
        this.timer = 0;
        this.writes = Promise.resolve();
        this.key = null;
    }

    // Whether `seg` ({ site, partitionKeys }) may hold record `c`.
    static entitled(seg, c) {
        if (c.partitionKey === '')
            return c.site === seg.site;
        return seg.partitionKeys.includes(c.partitionKey);
    }

    // The records a segment starts with.
    forSegment(seg) {
        this.all.purgeExpired();
        const out = [];
        this.all.each((c) => { if (CookieStore.entitled(seg, c)) out.push(C.plain(c)); });
        return out;
    }

    // A segment's changes. Returns { accepted, refused, changes } where changes are the clean records to forward.
    write(seg, list) {
        let accepted = 0, refused = 0;
        const changes = [];
        if (!Array.isArray(list) || list.length > MAX_WRITES_PER_MESSAGE)
            return { accepted, refused: 1, changes };
        for (const r of list) {
            const c = C.checkRecord(r);
            if (c === null || !CookieStore.entitled(seg, c)) {
                refused++;
                continue;
            }
            const key = C.cookieKey(c);
            if (r.deleted === true || (c.expires !== null && c.expires <= this.now())) {
                this.all.remove(key);
                this.mark(key, null);
                changes.push({ ...C.plain(c), deleted: true });
            } else {
                this.all.put(c);
                this.mark(key, c);
                changes.push(C.plain(c));
            }
            accepted++;
        }
        for (const k of this.all.evict())
            this.mark(k, null);
        return { accepted, refused, changes };
    }

    // Every cookie of `site` and every partition whose top-level site is `site` (the panel's "clear"). Returns the count.
    clearSite(site) {
        const gone = [];
        this.all.each((c, k) => {
            if (c.site === site || (c.partitionKey !== '' && siteOfSchemeful(partitionTop(c.partitionKey)) === site))
                gone.push([k, c]);
        });
        for (const [k] of gone) {
            this.all.remove(k);
            this.mark(k, null);
        }
        this.cleared = gone.map(([, c]) => ({ ...C.plain(c), deleted: true }));
        return gone.length;
    }

    // Sites with cookies, for the panel: [{ site, count, partitioned }].
    sites() {
        this.all.purgeExpired();
        const by = new Map();
        this.all.each((c) => {
            const e = by.get(c.site) || { site: c.site, count: 0, partitioned: 0 };
            e.count++;
            if (c.partitionKey !== '')
                e.partitioned++;
            by.set(c.site, e);
        });
        return [...by.values()].sort((a, b) => a.site.localeCompare(b.site));
    }

    // --- Persistence ----------------------------------------------------------------------------------------------------------
    mark(key, c) {
        if (!this.persist)
            return;
        if (c && c.expires === null)
            c = null; // session cookies are never written; an old persistent copy under the same key goes
        this.dirty.set(key, c);
        if (!this.timer)
            this.timer = setTimeout(() => { this.timer = 0; this.flush(); }, 100);
    }
    open() {
        return new Promise((resolve, reject) => {
            const req = this.idb.open(DB, 1);
            req.onupgradeneeded = () => { req.result.createObjectStore('cookies'); req.result.createObjectStore('meta'); };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    async cryptoKey(db) {
        if (this.key)
            return this.key;
        const tx = (mode) => db.transaction('meta', mode).objectStore('meta');
        let key = await new Promise((resolve) => { const r = tx('readonly').get('key'); r.onsuccess = () => resolve(r.result || null); r.onerror = () => resolve(null); });
        if (!key) {
            key = await this.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
            await new Promise((resolve, reject) => { const r = tx('readwrite').put(key, 'key'); r.onsuccess = resolve; r.onerror = () => reject(r.error); });
        }
        return (this.key = key);
    }
    async load() {
        if (!this.persist)
            return 0;
        const db = await this.open();
        try {
            const key = await this.cryptoKey(db);
            const rows = await new Promise((resolve, reject) => {
                const r = db.transaction('cookies', 'readonly').objectStore('cookies').getAll();
                r.onsuccess = () => resolve(r.result);
                r.onerror = () => reject(r.error);
            });
            let n = 0;
            for (const row of rows) {
                try {
                    const plain = await this.crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.iv }, key, row.data);
                    const c = C.checkRecord(JSON.parse(new TextDecoder().decode(plain)));
                    if (c && c.expires !== null && c.expires > this.now()) {
                        this.all.put(c);
                        n++;
                    }
                } catch { /* a row this key cannot open: dropped */ }
            }
            return n;
        } finally {
            db.close();
        }
    }
    flush() {
        if (!this.persist || this.dirty.size === 0)
            return this.writes;
        const batch = [...this.dirty];
        this.dirty.clear();
        this.writes = this.writes.then(async () => {
            const db = await this.open();
            try {
                const key = await this.cryptoKey(db);
                const rows = [];
                for (const [k, c] of batch) {
                    if (!c) {
                        rows.push([k, null]);
                        continue;
                    }
                    const iv = this.crypto.getRandomValues(new Uint8Array(12));
                    const data = await this.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(C.plain(c))));
                    rows.push([k, { iv, data }]);
                }
                await new Promise((resolve, reject) => {
                    const tx = db.transaction('cookies', 'readwrite');
                    const os = tx.objectStore('cookies');
                    for (const [k, row] of rows)
                        row ? os.put(row, k) : os.delete(k);
                    tx.oncomplete = resolve;
                    tx.onerror = () => reject(tx.error);
                });
            } finally {
                db.close();
            }
        }).catch((e) => { this.lastError = String(e && e.message || e); });
        return this.writes;
    }
}
