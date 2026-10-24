// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin's cookies (docs/cookies.md): RFC 6265bis (draft-ietf-httpbis-rfc6265bis-20) as Chrome keeps it. One file for the
// segment's jar (bundled into the engine glue, in the realm page code shares, so every builtin is captured below before any
// page script runs) and for the carapace's store (build/cookies.mjs wraps this file as a module). Needs PSL_RULES
// (tools/psl-gen.py) in scope.
//
//   parseSetCookie(string, nowMs)          a set-cookie-string -> a parsed record, or null (6265bis 5.6)
//   registrableDomain(host)                eTLD+1 by the Public Suffix List (private rules included, as Chrome), or the host
//   createJar(config)                      the segment's jar: header(url, ctx), store(url, string, ctx), forScript(url), apply()
//   bucketOf(cookie), cookieKey(cookie)    how the carapace files a record
//   checkRecord(record)                    a clean copy of a record a segment sent, or null
//
// A cookie record (plain data; the carapace persists it, segments receive it):
//   { name, value, domain, hostOnly, path, expires (ms since the epoch, or null for a session cookie), secure, httpOnly,
//     sameSite ('strict' | 'lax' | 'none' | 'unspecified'), partitionKey ('' or '<scheme>://<site> <0|1>'), partitioned,
//     site (the registrable domain of `domain`), created, lastAccess }
// Buckets: '' is the unpartitioned jar of `site`; a partition key alone holds Partitioned (CHIPS) cookies; a partition key
// followed by '\tu' holds the cookies a third-party response set without Partitioned in that partition (docs/cookies.md,
// "Third-party cookies": they never reach the site's own jar, because the segment that received them is another site's).

const ChitinCookies = (function () {
    'use strict';
    const G = globalThis;
    const uncurry = G.Function.prototype.bind.bind(G.Function.prototype.call);
    const S = G.String;
    const StrSlice = uncurry(S.prototype.slice);
    const StrIndexOf = uncurry(S.prototype.indexOf);
    const StrLastIndexOf = uncurry(S.prototype.lastIndexOf);
    const StrCharCodeAt = uncurry(S.prototype.charCodeAt);
    const StrToLower = uncurry(S.prototype.toLowerCase);
    const StrSplit = uncurry(S.prototype.split);
    const StrStartsWith = uncurry(S.prototype.startsWith);
    const StrEndsWith = uncurry(S.prototype.endsWith);
    const RegExpExec = uncurry(G.RegExp.prototype.exec);
    const ArraySort = uncurry(G.Array.prototype.sort);
    const ObjectSetPrototypeOf = G.Object.setPrototypeOf;
    const ObjectFreeze = G.Object.freeze;
    const ObjectKeys = G.Object.keys;
    const NumberIsFinite = G.Number.isFinite;
    const NumberParseInt = G.Number.parseInt;
    const MathFloor = G.Math.floor;
    const DateNow = G.Date.now;
    const HostDate = G.Date;
    const DateUTC = G.Date.UTC;
    const DateGetUTCDate = uncurry(G.Date.prototype.getUTCDate);
    const hostQueueMicrotask = typeof G.queueMicrotask === 'function' ? G.queueMicrotask : null;
    const HostMap = G.Map;
    const MapGet = uncurry(HostMap.prototype.get);
    const MapSet = uncurry(HostMap.prototype.set);
    const MapHas = uncurry(HostMap.prototype.has);
    const MapDelete = uncurry(HostMap.prototype.delete);
    const MapForEach = uncurry(HostMap.prototype.forEach);
    const MapClear = uncurry(HostMap.prototype.clear);
    const MapSize = uncurry(G.Object.getOwnPropertyDescriptor(HostMap.prototype, 'size').get);
    const arr = () => ObjectSetPrototypeOf([], null);
    // A list handed to the host's own code: filled while it had no prototype (no page setter saw a write), then an Array.
    const ArrayProto = G.Array.prototype;
    const toArray = (a) => ObjectSetPrototypeOf(a, ArrayProto);
    const obj = () => ObjectSetPrototypeOf({}, null);
    const push = (a, v) => { a[a.length] = v; };

    // Chrome's limits (net/cookies/cookie_monster.h, cookie_constants.h, canonical_cookie.cc).
    const MAX_NAME_VALUE = 4096;
    const MAX_ATTRIBUTE_VALUE = 1024;
    const MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;
    const DOMAIN_MAX = 180, DOMAIN_PURGE = 30;
    const TOTAL_MAX = 3300, TOTAL_PURGE = 300;
    const PARTITION_MAX_BYTES = 10240;
    const LAX_ALLOW_UNSAFE_MS = 2 * 60 * 1000;
    const EARLIEST = 0;

    // --- The Public Suffix List ------------------------------------------------------------------------------------------
    const rules = new HostMap();      // rule -> 1 (normal), 2 (wildcard: '*.' + rule), 3 (exception)
    {
        const list = StrSplit(PSL_RULES, '\n');
        for (let i = 0; i < list.length; i++) {
            const r = list[i];
            if (StrStartsWith(r, '!'))
                MapSet(rules, StrSlice(r, 1), 3);
            else if (StrStartsWith(r, '*.'))
                MapSet(rules, '*.' + StrSlice(r, 2), 2);
            else
                MapSet(rules, r, 1);
        }
    }
    const isIp = (host) => RegExpExec(/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/, host) !== null || StrStartsWith(host, '[');
    // The number of labels of the public suffix of `host` (PSL algorithm; the default rule '*' makes it at least 1).
    function suffixLabels(labels) {
        let best = 1;
        for (let i = 0; i < labels.length; i++) {
            let name = labels[i];
            for (let j = i + 1; j < labels.length; j++)
                name += '.' + labels[j];
            const n = labels.length - i;
            if (MapGet(rules, name) === 3)
                return n - 1;
            if (MapGet(rules, name) === 1 && n > best)
                best = n;
            if (i > 0 && n + 1 > best) {
                let parent = labels[i];
                for (let j = i + 1; j < labels.length; j++)
                    parent += '.' + labels[j];
                if (MapGet(rules, '*.' + parent) === 2 && n + 1 > best)
                    best = n + 1;
            }
        }
        return best;
    }
    function labelsOf(host) {
        let h = StrToLower(S(host));
        if (StrEndsWith(h, '.'))
            h = StrSlice(h, 0, -1);
        return StrSplit(h, '.');
    }
    // eTLD+1, or the host itself when it is an IP literal, a public suffix or has a single label.
    function registrableDomain(host) {
        host = StrToLower(S(host));
        if (StrEndsWith(host, '.'))
            host = StrSlice(host, 0, -1);
        if (host === '' || isIp(host))
            return host;
        const labels = labelsOf(host);
        const n = suffixLabels(labels);
        if (labels.length <= n)
            return host;
        let out = labels[labels.length - n - 1];
        for (let j = labels.length - n; j < labels.length; j++)
            out += '.' + labels[j];
        return out;
    }
    function isPublicSuffix(domain) {
        domain = StrToLower(S(domain));
        if (domain === '' || isIp(domain))
            return false;
        const labels = labelsOf(domain);
        return suffixLabels(labels) >= labels.length;
    }

    // --- URLs ------------------------------------------------------------------------------------------------------------
    // The URLs here are serialized by a URL parser (the engine's, the host's): scheme, host in its canonical ASCII form.
    const URL_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)(?::(\d*))?([^?#]*)/;
    function parseUrl(url) {
        const m = RegExpExec(URL_RE, S(url));
        if (m === null)
            return null;
        let scheme = StrToLower(m[1]);
        if (scheme === 'ws')
            scheme = 'http';
        else if (scheme === 'wss')
            scheme = 'https';
        if (scheme !== 'http' && scheme !== 'https')
            return null;
        let host = StrToLower(m[2]);
        if (StrEndsWith(host, '.'))
            host = StrSlice(host, 0, -1);
        if (host === '')
            return null;
        let path = m[4] || '/';
        if (path === '')
            path = '/';
        return { __proto__: null, scheme, host, path, secure: scheme === 'https' || isLoopbackHost(host) };
    }
    // Chrome treats http://localhost and loopback addresses as potentially trustworthy: Secure cookies may be set and sent there.
    function isLoopbackHost(host) {
        return host === 'localhost' || StrEndsWith(host, '.localhost') || RegExpExec(/^127\.[0-9]+\.[0-9]+\.[0-9]+$/, host) !== null || host === '[::1]';
    }
    // The schemeful site of a URL (Chrome's SchemefulSite): scheme and registrable domain.
    function schemefulSite(url) {
        const u = typeof url === 'string' ? parseUrl(url) : url;
        return u ? u.scheme + '://' + registrableDomain(u.host) : null;
    }

    // --- Parsing a set-cookie-string (6265bis 5.6) ----------------------------------------------------------------------
    const isWsp = (c) => c === 0x20 || c === 0x09;
    function trimWsp(s) {
        let a = 0, b = s.length;
        while (a < b && isWsp(StrCharCodeAt(s, a)))
            a++;
        while (b > a && isWsp(StrCharCodeAt(s, b - 1)))
            b--;
        return StrSlice(s, a, b);
    }
    // A control character other than HTAB anywhere makes Chrome refuse the whole cookie (CookieControlCharacters).
    function hasControl(s) {
        for (let i = 0; i < s.length; i++) {
            const c = StrCharCodeAt(s, i);
            if ((c < 0x20 && c !== 0x09) || c === 0x7f)
                return true;
        }
        return false;
    }

    // The cookie-date algorithm (6265bis 5.4.1); returns ms since the epoch or null.
    const MONTHS = ObjectFreeze(ObjectSetPrototypeOf(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'], null));
    function isDelimiter(c) {
        return c === 0x09 || (c >= 0x20 && c <= 0x2f) || (c >= 0x3b && c <= 0x40) || (c >= 0x5b && c <= 0x60) || (c >= 0x7b && c <= 0x7e);
    }
    function parseCookieDate(s) {
        const tokens = arr();
        let cur = '';
        for (let i = 0; i <= s.length; i++) {
            const c = i < s.length ? StrCharCodeAt(s, i) : 0x20;
            if (isDelimiter(c)) {
                if (cur !== '')
                    push(tokens, cur);
                cur = '';
            } else {
                cur += s[i];
            }
        }
        let time = null, day = null, month = null, year = null;
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            let m;
            if (time === null && (m = RegExpExec(/^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:[^\d].*)?$/, t)) !== null) {
                time = [+m[1], +m[2], +m[3]];
                continue;
            }
            if (day === null && (m = RegExpExec(/^(\d{1,2})(?:[^\d].*)?$/, t)) !== null) {
                day = +m[1];
                continue;
            }
            if (month === null && t.length >= 3) {
                const p3 = StrToLower(StrSlice(t, 0, 3));
                let idx = -1;
                for (let k = 0; k < 12; k++)
                    if (MONTHS[k] === p3)
                        idx = k;
                if (idx >= 0) {
                    month = idx;
                    continue;
                }
            }
            if (year === null && (m = RegExpExec(/^(\d{2,4})(?:[^\d].*)?$/, t)) !== null) {
                year = +m[1];
                continue;
            }
        }
        if (year !== null) {
            if (year >= 70 && year <= 99)
                year += 1900;
            else if (year >= 0 && year <= 69)
                year += 2000;
        }
        if (time === null || day === null || month === null || year === null)
            return null;
        if (day < 1 || day > 31 || year < 1601 || time[0] > 23 || time[1] > 59 || time[2] > 59)
            return null;
        const ms = DateUTC(year, month, day, time[0], time[1], time[2]);
        // A day past the month's end (Feb 30) is refused, as the algorithm says ("the date does not exist").
        if (!NumberIsFinite(ms) || DateGetUTCDate(new HostDate(ms)) !== day)
            return null;
        return ms;
    }

    function parseSetCookie(string, now = DateNow()) {
        string = S(string);
        if (hasControl(string))
            return null;
        let semi = StrIndexOf(string, ';');
        const pair = semi < 0 ? string : StrSlice(string, 0, semi);
        let name, value;
        const eq = StrIndexOf(pair, '=');
        if (eq < 0) {
            name = '';
            value = trimWsp(pair);
        } else {
            name = trimWsp(StrSlice(pair, 0, eq));
            value = trimWsp(StrSlice(pair, eq + 1));
        }
        if (name === '' && value === '')
            return null;
        if (name.length + value.length > MAX_NAME_VALUE)
            return null;
        const out = { __proto__: null, name, value, expires: null, maxAge: null, domain: null, path: null, secure: false, httpOnly: false, sameSite: 'unspecified', partitioned: false };
        let rest = semi < 0 ? '' : StrSlice(string, semi + 1);
        while (rest !== '') {
            semi = StrIndexOf(rest, ';');
            const av = semi < 0 ? rest : StrSlice(rest, 0, semi);
            rest = semi < 0 ? '' : StrSlice(rest, semi + 1);
            const e = StrIndexOf(av, '=');
            const attr = StrToLower(trimWsp(e < 0 ? av : StrSlice(av, 0, e)));
            const val = e < 0 ? '' : trimWsp(StrSlice(av, e + 1));
            if (val.length > MAX_ATTRIBUTE_VALUE)
                continue;
            if (attr === 'expires') {
                const t = parseCookieDate(val);
                if (t !== null)
                    out.expires = t;
            } else if (attr === 'max-age') {
                if (RegExpExec(/^-?\d+$/, val) === null)
                    continue;
                const n = NumberParseInt(val, 10);
                out.maxAge = n <= 0 ? EARLIEST : now + (n * 1000 > MAX_AGE_MS ? MAX_AGE_MS : n * 1000);
            } else if (attr === 'domain') {
                if (val === '')
                    continue;
                let d = StrToLower(val);
                if (StrStartsWith(d, '.'))
                    d = StrSlice(d, 1);
                out.domain = d;
            } else if (attr === 'path') {
                out.path = val !== '' && StrStartsWith(val, '/') ? val : null;
            } else if (attr === 'secure') {
                out.secure = true;
            } else if (attr === 'httponly') {
                out.httpOnly = true;
            } else if (attr === 'samesite') {
                const v = StrToLower(val);
                out.sameSite = v === 'strict' ? 'strict' : v === 'lax' ? 'lax' : v === 'none' ? 'none' : 'unspecified';
            } else if (attr === 'partitioned') {
                out.partitioned = true;
            }
        }
        // Max-Age wins over Expires; both are capped at 400 days from now (6265bis 5.5, 5.6.1).
        let expires = out.maxAge !== null ? out.maxAge : out.expires;
        if (expires !== null && expires !== EARLIEST && expires > now + MAX_AGE_MS)
            expires = now + MAX_AGE_MS;
        out.expires = expires;
        return out;
    }

    // --- Matching ----------------------------------------------------------------------------------------------------------
    function domainMatch(host, domain) {
        if (host === domain)
            return true;
        return !isIp(host) && StrEndsWith(host, '.' + domain);
    }
    // The default-path of a URL path (6265bis 5.1.4).
    function defaultPath(path) {
        if (!StrStartsWith(path, '/'))
            return '/';
        const i = StrLastIndexOf(path, '/');
        return i <= 0 ? '/' : StrSlice(path, 0, i);
    }
    function pathMatch(reqPath, cookiePath) {
        if (reqPath === cookiePath)
            return true;
        if (!StrStartsWith(reqPath, cookiePath))
            return false;
        return StrEndsWith(cookiePath, '/') || StrCharCodeAt(reqPath, cookiePath.length) === 0x2f;
    }
    const lowerStarts = (s, p) => StrStartsWith(StrToLower(s), p);

    function bucketOf(c) {
        return c.partitionKey === '' ? '' : c.partitionKey + (c.partitioned ? '' : '\tu');
    }
    function cookieKey(c) {
        return bucketOf(c) + '\n' + c.name + '\n' + c.domain + '\n' + c.path;
    }

    // A record from another context (a segment's message, the persisted store): every field typed, nothing else kept.
    function checkRecord(r) {
        if (r === null || typeof r !== 'object')
            return null;
        const str = (v, max) => typeof v === 'string' && v.length <= max;
        if (!str(r.name, MAX_NAME_VALUE) || !str(r.value, MAX_NAME_VALUE) || r.name.length + r.value.length > MAX_NAME_VALUE)
            return null;
        if (!str(r.domain, 255) || r.domain === '' || !str(r.path, MAX_ATTRIBUTE_VALUE) || !StrStartsWith(r.path, '/') || !str(r.partitionKey, 600))
            return null;
        if (hasControl(r.name) || hasControl(r.value) || hasControl(r.domain) || hasControl(r.path) || hasControl(r.partitionKey))
            return null;
        if (r.expires !== null && !(typeof r.expires === 'number' && NumberIsFinite(r.expires)))
            return null;
        if (r.sameSite !== 'strict' && r.sameSite !== 'lax' && r.sameSite !== 'none' && r.sameSite !== 'unspecified')
            return null;
        if (typeof r.hostOnly !== 'boolean' || typeof r.secure !== 'boolean' || typeof r.httpOnly !== 'boolean' || typeof r.partitioned !== 'boolean')
            return null;
        if (r.partitionKey === '' && r.partitioned)
            return null;
        const num = (v) => typeof v === 'number' && NumberIsFinite(v) ? v : 0;
        return {
            __proto__: null, name: r.name, value: r.value, domain: r.domain, hostOnly: r.hostOnly, path: r.path, expires: r.expires,
            secure: r.secure, httpOnly: r.httpOnly, sameSite: r.sameSite, partitionKey: r.partitionKey, partitioned: r.partitioned,
            site: registrableDomain(r.domain), created: num(r.created), lastAccess: num(r.lastAccess),
        };
    }
    function plain(c) {
        // A copy with an ordinary prototype, for structured clone (postMessage, IndexedDB).
        return {
            name: c.name, value: c.value, domain: c.domain, hostOnly: c.hostOnly, path: c.path, expires: c.expires, secure: c.secure,
            httpOnly: c.httpOnly, sameSite: c.sameSite, partitionKey: c.partitionKey, partitioned: c.partitioned, site: c.site,
            created: c.created, lastAccess: c.lastAccess,
        };
    }

    // --- The store ---------------------------------------------------------------------------------------------------------
    // Records by key; the same class serves the segment's jar and the carapace's store.
    function createStore(now) {
        const all = new HostMap();
        const expired = (c, t) => c.expires !== null && c.expires <= t;
        const store = {
            __proto__: null,
            all,
            get: (key) => MapGet(all, key),
            put(c) { MapSet(all, cookieKey(c), c); },
            remove(key) { return MapDelete(all, key); },
            size: () => MapSize(all),
            each(fn) { MapForEach(all, (c, k) => fn(c, k)); },
            purgeExpired() {
                const t = now();
                const gone = arr();
                MapForEach(all, (c, k) => { if (expired(c, t)) push(gone, k); });
                for (let i = 0; i < gone.length; i++)
                    MapDelete(all, gone[i]);
                return toArray(gone);
            },
            // Chrome's garbage collection (CookieMonster::GarbageCollect, simplified): over 180 cookies of one site in one
            // bucket, the least recently used go, non-secure ones first, until 150 are left; over 10 KiB in one partition of
            // one site, the oldest partitioned ones go; over 3300 in all, the least recently used go until 3000 are left.
            evict(changed) {
                const removed = arr();
                const groups = new HostMap();
                MapForEach(all, (c, k) => {
                    const g = bucketOf(c) + '\n' + c.site;
                    let list = MapGet(groups, g);
                    if (list === undefined)
                        MapSet(groups, g, list = arr());
                    push(list, k);
                });
                const lru = (a, b) => {
                    const ca = MapGet(all, a), cb = MapGet(all, b);
                    if (ca.secure !== cb.secure)
                        return ca.secure ? 1 : -1;
                    return ca.lastAccess - cb.lastAccess;
                };
                MapForEach(groups, (list, g) => {
                    if (changed !== undefined && !MapHas(changed, g))
                        return;
                    if (list.length > DOMAIN_MAX) {
                        ArraySort(list, lru);
                        for (let i = 0; i < DOMAIN_PURGE + list.length - DOMAIN_MAX; i++) {
                            MapDelete(all, list[i]);
                            push(removed, list[i]);
                        }
                    }
                    const first = MapGet(all, list[list.length - 1]);
                    if (first && first.partitioned) {
                        let bytes = 0;
                        const live = arr();
                        for (let i = 0; i < list.length; i++) {
                            const c = MapGet(all, list[i]);
                            if (c) {
                                bytes += c.name.length + c.value.length;
                                push(live, list[i]);
                            }
                        }
                        ArraySort(live, (a, b) => MapGet(all, a).lastAccess - MapGet(all, b).lastAccess);
                        for (let i = 0; bytes > PARTITION_MAX_BYTES && i < live.length; i++) {
                            const c = MapGet(all, live[i]);
                            bytes -= c.name.length + c.value.length;
                            MapDelete(all, live[i]);
                            push(removed, live[i]);
                        }
                    }
                });
                if (MapSize(all) > TOTAL_MAX) {
                    const keys = arr();
                    MapForEach(all, (c, k) => push(keys, k));
                    ArraySort(keys, (a, b) => MapGet(all, a).lastAccess - MapGet(all, b).lastAccess);
                    for (let i = 0; i < TOTAL_PURGE + keys.length - TOTAL_MAX; i++) {
                        MapDelete(all, keys[i]);
                        push(removed, keys[i]);
                    }
                }
                return toArray(removed);
            },
            clear() { MapClear(all); },
        };
        return store;
    }

    // --- The segment's jar -------------------------------------------------------------------------------------------------
    // config: {
    //   site:          the segment's registrable domain (its own jar; every other site's cookies are another segment's)
    //   nested:        a cross-site iframe's segment: its documents' site for cookies is null (6265bis 5.2.1)
    //   topSite:       a nested segment's top-level schemeful site (its partition key), given by the carapace
    //   initiator:     the schemeful site that asked for the first navigation (null: the user, from the address bar)
    //   cookies:       the records the carapace gave this segment
    //   onChange(list) the records this jar changed (deleted ones have `deleted: true`), for the carapace
    //   now()          ms since the epoch
    // }
    // The jar also needs, per segment, the schemeful site of its current top-level document (topDocument), which it learns
    // from the navigations it sends (ctx.kind 'navigate-top') and the host's navigated callback (setTopDocument).
    function createJar(config) {
        config = config || obj();
        const now = typeof config.now === 'function' ? config.now : DateNow;
        let site = typeof config.site === 'string' && config.site !== '' ? StrToLower(config.site) : null;
        const nested = config.nested === true;
        const nestedTop = nested && typeof config.topSite === 'string' ? config.topSite : null;
        let initiator = typeof config.initiator === 'string' ? config.initiator : null;
        let firstNavigation = true;
        let topDocument = null;              // schemeful site of the top-level document of this (top-level) segment
        const onChange = typeof config.onChange === 'function' ? config.onChange : null;
        const store = createStore(now);
        if (config.cookies) {
            const list = config.cookies;
            for (let i = 0; i < list.length; i++) {
                const c = checkRecord(list[i]);
                if (c !== null)
                    store.put(c);
            }
        }
        let pending = null;
        function changed(c, deleted) {
            if (!onChange)
                return;
            const p = plain(c);
            if (deleted)
                p.deleted = true;
            if (pending === null) {
                pending = arr();
                hostQueueMicrotask ? hostQueueMicrotask(flush) : flush();
            }
            push(pending, p);
        }
        function flush() {
            if (pending === null)
                return;
            const list = pending;
            pending = null;
            onChange(toArray(list));
        }

        // The context of a request or a script, as the parts of 6265bis 5.2 need it:
        //   siteForCookies   schemeful site, or null (a cross-site iframe's documents)
        //   partitionKey     '<top schemeful site> <cross-site ancestor bit>'
        //   strict           the request is same-site for Strict (its initiator is same-site too)
        //   topLevel         a top-level navigation (Lax applies to safe methods)
        //   safe             the method is safe (GET, HEAD, OPTIONS, TRACE)
        function contextOf(url, ctx) {
            const kind = ctx && ctx.kind || 'subresource';
            const method = ctx && typeof ctx.method === 'string' ? ctx.method : 'GET';
            const safe = method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || method === 'TRACE';
            const target = schemefulSite(url);
            let siteForCookies, top, strict = true;
            if (kind === 'navigate-top' && !nested) {
                siteForCookies = target;
                top = target;
                // The first document of a segment was asked for by another site's page or by the user (initiator null): a
                // later one by this segment's own document, which is same-site with it unless the scheme changed.
                const from = firstNavigation ? initiator : topDocument;
                strict = from === null || from === target;
            } else if (nested) {
                siteForCookies = null;
                top = nestedTop;
            } else {
                siteForCookies = topDocument !== null ? topDocument : target;
                top = siteForCookies;
            }
            const sameSite = siteForCookies !== null && siteForCookies === target;
            return {
                __proto__: null, kind, safe, sameSite, strict: sameSite && strict, topLevel: kind === 'navigate-top' && !nested,
                siteForCookies, partitionKey: top === null ? '' : top + (nested ? ' 1' : ' 0'),
            };
        }
        // Which bucket an unpartitioned cookie of `host` lives in for this context.
        function unpartitionedBucket(host, c) {
            if (site === null)
                site = registrableDomain(host);
            return registrableDomain(host) === site ? '' : c.partitionKey + '\tu';
        }

        function sendable(c, u, x, script) {
            if (c.hostOnly ? u.host !== c.domain : !domainMatch(u.host, c.domain))
                return false;
            if (!pathMatch(u.path, c.path))
                return false;
            if (c.secure && !u.secure)
                return false;
            if (c.httpOnly && script)
                return false;
            if (c.sameSite === 'none')
                return true;
            if (!x.sameSite)
                return false;
            if (c.sameSite === 'strict' && !x.strict)
                return false;
            // A cross-site top-level navigation carries Lax cookies with a safe method only; Chrome's "Lax-allowing-unsafe"
            // lets a cookie without SameSite that is under two minutes old ride on an unsafe one too.
            if (!x.strict && x.topLevel && !x.safe)
                return c.sameSite === 'unspecified' && now() - c.created < LAX_ALLOW_UNSAFE_MS;
            return true;
        }
        // The cookies for a request (or document.cookie when `script`), in 6265bis order: longer paths first, then the
        // earlier created.
        function select(url, ctx, script) {
            const u = parseUrl(url);
            if (u === null)
                return arr();
            store.purgeExpired();
            const x = contextOf(url, ctx);
            const own = unpartitionedBucket(u.host, x);
            const list = arr();
            store.each((c) => {
                const b = bucketOf(c);
                if (b !== own && !(c.partitioned && b === x.partitionKey))
                    return;
                if (sendable(c, u, x, script))
                    push(list, c);
            });
            ArraySort(list, (a, b) => (b.path.length - a.path.length) || (a.created - b.created));
            const t = now();
            for (let i = 0; i < list.length; i++)
                list[i].lastAccess = t;
            return list;
        }
        function serialize(list) {
            let out = '';
            for (let i = 0; i < list.length; i++) {
                const c = list[i];
                if (i)
                    out += '; ';
                out += c.name === '' ? c.value : c.name + '=' + c.value;
            }
            return out;
        }

        // The storage model (6265bis 5.7) with Chrome's checks. Returns the stored record, or null when it was refused.
        function storeString(url, string, ctx) {
            const u = parseUrl(url);
            if (u === null)
                return null;
            const script = ctx && ctx.kind === 'script';
            const t = now();
            const p = parseSetCookie(string, t);
            if (p === null)
                return null;
            const x = contextOf(url, ctx);
            if (p.httpOnly && script)
                return null;
            if (p.secure && !u.secure)
                return null;
            // Domain: a public suffix only as the host itself (then host-only), and it must domain-match the host.
            let domain, hostOnly;
            if (p.domain !== null) {
                let d = p.domain;
                if (isPublicSuffix(d)) {
                    if (d !== u.host)
                        return null;
                    d = null;
                }
                if (d !== null && !domainMatch(u.host, d))
                    return null;
                if (d === null || (isIp(u.host) && d === u.host)) {
                    domain = u.host;
                    hostOnly = true;
                } else {
                    domain = d;
                    hostOnly = false;
                }
            } else {
                domain = u.host;
                hostOnly = true;
            }
            const path = p.path !== null ? p.path : defaultPath(u.path);
            // SameSite=None needs Secure (Chrome); Lax, Strict and the default are refused from a cross-site context,
            // except on the response to a top-level navigation (6265bis 5.7, step 15).
            if (p.sameSite === 'none' && !p.secure)
                return null;
            if (p.sameSite !== 'none' && !x.sameSite && !x.topLevel)
                return null;
            // Prefixes, case-insensitively (6265bis 4.1.3); a nameless cookie may not look like one.
            const prefixed = p.name !== '' ? p.name : p.value;
            if (lowerStarts(prefixed, '__secure-') && (!p.secure || !u.secure))
                return null;
            if (lowerStarts(prefixed, '__host-') && (!p.secure || !u.secure || !hostOnly || path !== '/'))
                return null;
            // CHIPS: Partitioned needs Secure; without a partition key (no top-level site) the cookie is unpartitioned.
            if (p.partitioned && !p.secure)
                return null;
            const partitioned = p.partitioned && x.partitionKey !== '';
            const c = {
                __proto__: null, name: p.name, value: p.value, domain, hostOnly, path, expires: p.expires, secure: p.secure,
                httpOnly: p.httpOnly, sameSite: p.sameSite, partitionKey: '', partitioned, site: registrableDomain(domain),
                created: t, lastAccess: t,
            };
            if (partitioned)
                c.partitionKey = x.partitionKey;
            else if (unpartitionedBucket(u.host, x) !== '')
                c.partitionKey = x.partitionKey;
            if (c.partitionKey === '' && unpartitionedBucket(u.host, x) !== '')
                return null; // a foreign site with no partition to keep it in
            const bucket = bucketOf(c);
            // A page's script may not replace an HttpOnly cookie; an insecure URL may not shadow a Secure one ("leave secure
            // cookies alone", 6265bis 5.7 step 16).
            const key = cookieKey(c);
            const old = store.get(key);
            if (old && old.httpOnly && script)
                return null;
            if (!u.secure) {
                let shadow = false;
                store.each((o) => {
                    if (!shadow && o.secure && o.name === c.name && bucketOf(o) === bucket && (domainMatch(o.domain, c.domain) || domainMatch(c.domain, o.domain)) && pathMatch(c.path, o.path))
                        shadow = true;
                });
                if (shadow)
                    return null;
            }
            if (old)
                c.created = old.created;
            if (c.expires !== null && c.expires <= t) {
                if (old) {
                    store.remove(key);
                    changed(old, true);
                }
                return c;
            }
            store.put(c);
            changed(c, false);
            const groups = new HostMap();
            MapSet(groups, bucket + '\n' + c.site, true);
            const removed = store.evict(groups);
            for (let i = 0; i < removed.length; i++)
                changed({ __proto__: null, ...keyParts(removed[i]) }, true);
            return c;
        }
        function keyParts(key) {
            const parts = StrSplit(key, '\n');
            const b = parts[0];
            const tab = StrIndexOf(b, '\t');
            return {
                __proto__: null, name: parts[1], value: '', domain: parts[2], path: parts[3], hostOnly: false, expires: null, secure: false,
                httpOnly: false, sameSite: 'unspecified', partitionKey: tab < 0 ? b : StrSlice(b, 0, tab), partitioned: b !== '' && tab < 0,
                site: registrableDomain(parts[2]), created: 0, lastAccess: 0,
            };
        }

        const jar = {
            __proto__: null,
            // The Cookie header for a request (ctx: { kind: 'navigate-top' | 'navigate-frame' | 'subresource' | 'websocket',
            // method }); '' when no cookie goes.
            header(url, ctx) {
                const out = serialize(select(url, ctx, false));
                // The document a top-level navigation fetches is the site for cookies of what it loads next (its subresources
                // start before the navigation is reported done); each redirect hop moves it.
                if (ctx && ctx.kind === 'navigate-top' && !nested) {
                    const s = schemefulSite(url);
                    if (s !== null)
                        topDocument = s;
                }
                return out;
            },
            // A response's Set-Cookie lines (an array of strings), or one document.cookie write (ctx.kind 'script').
            store(url, lines, ctx) {
                let n = 0;
                if (typeof lines === 'string') {
                    if (storeString(url, lines, ctx) !== null)
                        n++;
                    return n;
                }
                for (let i = 0; i < lines.length; i++)
                    if (storeString(url, lines[i], ctx) !== null)
                        n++;
                return n;
            },
            // document.cookie for a document at `url` (no HttpOnly; the document's own context).
            forScript(url) {
                return serialize(select(url, { __proto__: null, kind: 'script' }, true));
            },
            // The records a script may see (CookieStore): name and value, plus what the Cookie Store API reports.
            listForScript(url) {
                const list = select(url, { __proto__: null, kind: 'script' }, true);
                const out = arr();
                for (let i = 0; i < list.length; i++)
                    out[i] = plain(list[i]);
                return toArray(out);
            },
            setTopDocument(url) {
                const s = schemefulSite(url);
                if (s !== null && !nested) {
                    topDocument = s;
                    firstNavigation = false;
                }
                if (site === null) {
                    const u = parseUrl(url);
                    if (u)
                        site = registrableDomain(u.host);
                }
            },
            // Changes from the carapace (another segment's writes, a clear): records, deleted ones marked.
            apply(list) {
                for (let i = 0; i < list.length; i++) {
                    const r = list[i];
                    const c = checkRecord(r);
                    if (c === null)
                        continue;
                    if (r.deleted === true)
                        store.remove(cookieKey(c));
                    else
                        store.put(c);
                }
            },
            all() {
                const out = arr();
                store.each((c) => { out[out.length] = plain(c); });
                return toArray(out);
            },
            flush,
            contextOf,
            get site() { return site; },
        };
        return jar;
    }

    return ObjectFreeze({
        __proto__: null,
        parseSetCookie, parseCookieDate, registrableDomain, isPublicSuffix, schemefulSite, parseUrl, domainMatch, pathMatch, defaultPath,
        createJar, createStore, bucketOf, cookieKey, checkRecord, plain,
        LIMITS: ObjectFreeze({ __proto__: null, MAX_NAME_VALUE, MAX_ATTRIBUTE_VALUE, MAX_AGE_MS, DOMAIN_MAX, TOTAL_MAX, PARTITION_MAX_BYTES }),
    });
})();
