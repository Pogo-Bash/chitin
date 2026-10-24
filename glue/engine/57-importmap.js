// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Import maps (docs/architecture.md "Import maps"). The map is the engine's: LibWeb registers every
// <script type="importmap"> of a document and merges them (HTML "merge existing and new import maps").
// The host's V8 resolves page modules' specifiers without it (a Worker has no import map), so the segment's
// service worker replaces each specifier the map remaps with the map's URL (harness/segment/specifiers.js).
// Here: "resolve a module specifier" against the engine's map (HTML 8.1.5.3), in the spec's key order (code units
// descending: the longest prefix first), the resolved module set kept, and Chrome's wording for the failures.

// The host's URL parser (WHATWG URL, as V8's module resolution uses it), given by the host at boot (callbacks.HostURL): the
// global URL may be the engine's by the time a module loads.
let IMURL = null, IMhref = null, IMprotocol = null;
function imURLClass() {
    if (IMURL === null) {
        const C = callbacks.HostURL || globalThis.URL;
        IMhref = uncurryThis(ObjectGetOwnPropertyDescriptor(C.prototype, 'href').get);
        IMprotocol = uncurryThis(ObjectGetOwnPropertyDescriptor(C.prototype, 'protocol').get);
        IMURL = C;
    }
    return IMURL;
}
const IMJSONParse = globalThis.JSON.parse;
const IMKeys = globalThis.Object.keys;
const IMSort = uncurryThis(globalThis.Array.prototype.sort);
const IMPush = uncurryThis(globalThis.Array.prototype.push);
const IMStartsWith = uncurryThis(globalThis.String.prototype.startsWith);
const IMEndsWith = uncurryThis(globalThis.String.prototype.endsWith);
const IMSlice = uncurryThis(globalThis.String.prototype.slice);
const IMReplace = uncurryThis(globalThis.String.prototype.replace);
const imUtf8 = new TextDecoder();
const IM_SPECIAL = { __proto__: null, 'ftp:': true, 'file:': true, 'http:': true, 'https:': true, 'ws:': true, 'wss:': true };

function imParseURL(input, base) {
    const C = imURLClass();
    try {
        return base === undefined ? new C(input) : new C(input, base);
    } catch {
        return null;
    }
}

// The global object cell of a realm id: 0 is the principal window, a frame realm's is its Window's (55-realms.js).
function imGlobalCell(realmId) {
    if (!realmId)
        return globalCell;
    const record = RealmsMapGet(realmById, realmId);
    return record === undefined ? 0 : record.windowCell;
}

const imDescending = (a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0);
function imEntries(object) {
    const keys = IMKeys(object);
    const out = [];
    for (let i = 0; i < keys.length; i++)
        IMPush(out, [keys[i], object[keys[i]]]);
    return IMSort(out, imDescending);
}

// The engine's import map of a realm: { imports: [[key, url|null]], scopes: [[prefix, entries]], integrity } (sorted as
// the spec iterates them), or null when there is none to read.
function imMap(realmId) {
    const cell = imGlobalCell(realmId);
    if (!cell || typeof X.ganglion_import_map_json !== 'function')
        return null;
    const mark = scratchTop;
    try {
        const o = slots(1), len = slots(1);
        writeObject(o, cell);
        const ptr = X.ganglion_import_map_json(o, len);
        views();
        if (!ptr)
            return null;
        const n = u32[len >>> 2];
        const copy = new (globalThis.Uint8Array)(n);
        for (let i = 0; i < n; i++)
            copy[i] = u8[ptr + i];
        const raw = IMJSONParse(TextDecoderPrototypeDecode(imUtf8, copy));
        const scopes = imEntries(raw.scopes);
        for (let i = 0; i < scopes.length; i++)
            scopes[i][1] = imEntries(scopes[i][1]);
        return { __proto__: null, imports: imEntries(raw.imports), scopes, integrity: raw.integrity };
    } finally {
        scratchTop = mark;
    }
}

function imRecordResolved(realmId, base, normalized, asURL) {
    const cell = imGlobalCell(realmId);
    if (!cell || typeof X.ganglion_import_map_resolved !== 'function')
        return;
    const mark = scratchTop;
    const o = slots(1);
    writeObject(o, cell);
    const b = stringToEngine(base), s = stringToEngine(normalized);
    try {
        X.ganglion_import_map_resolved(o, b, base.length, s, normalized.length, asURL === null || IM_SPECIAL[IMprotocol(asURL)] === true ? 1 : 0);
    } finally {
        X.ganglion_free(b);
        X.ganglion_free(s);
        scratchTop = mark;
    }
}

// "resolve a URL-like module specifier"
function imURLLike(specifier, base) {
    if (IMStartsWith(specifier, '/') || IMStartsWith(specifier, './') || IMStartsWith(specifier, '../'))
        return imParseURL(specifier, base);
    return imParseURL(specifier);
}

// "resolve an imports match": { url } | { blocked, key } | null
function imMatch(normalized, asURL, entries) {
    for (let i = 0; i < entries.length; i++) {
        const key = entries[i][0], result = entries[i][1];
        if (key === normalized) {
            if (result === null)
                return { __proto__: null, blocked: 'null', key };
            return { __proto__: null, url: result };
        }
        if (IMEndsWith(key, '/') && IMStartsWith(normalized, key) && (asURL === null || IM_SPECIAL[IMprotocol(asURL)] === true)) {
            if (result === null)
                return { __proto__: null, blocked: 'null', key };
            const url = imParseURL(IMSlice(normalized, key.length), result);
            if (url === null)
                return { __proto__: null, blocked: 'parse', key };
            const href = IMhref(url);
            if (!IMStartsWith(href, result))
                return { __proto__: null, blocked: 'backtrack', key };
            return { __proto__: null, url: href };
        }
    }
    return null;
}

const IM_BLOCKED = { __proto__: null, null: 'is blocked by a null value', parse: 'is blocked due to relative URL parse failure', backtrack: 'is blocked due to backtracking' };

// One specifier against a map: { url, mapped } (mapped: the map changed what the host would resolve), or { error,
// staticMessage, dynamicMessage } in Chrome's words (a static import's error names the reason; import() and
// import.meta.resolve say only the specifier).
function imResolveOne(realmId, map, base, specifier) {
    const asURL = imURLLike(specifier, base);
    const normalized = asURL !== null ? IMhref(asURL) : specifier;
    let result = null;
    for (let i = 0; i < map.scopes.length && result === null; i++) {
        const prefix = map.scopes[i][0];
        if (prefix === base || (IMEndsWith(prefix, '/') && IMStartsWith(base, prefix)))
            result = imMatch(normalized, asURL, map.scopes[i][1]);
    }
    if (result === null)
        result = imMatch(normalized, asURL, map.imports);
    if (result !== null && result.blocked !== undefined) {
        return {
            __proto__: null,
            error: result.blocked,
            staticMessage: `Failed to resolve module specifier "${specifier}". Import Map: "${normalized}" matches with "${result.key}" but ${IM_BLOCKED[result.blocked]}`,
            dynamicMessage: `Failed to resolve module specifier '${specifier}'`,
        };
    }
    if (result === null && asURL === null) {
        return {
            __proto__: null,
            error: 'bare',
            staticMessage: `Failed to resolve module specifier "${specifier}". Relative references must start with either "/", "./", or "../".`,
            dynamicMessage: `Failed to resolve module specifier '${specifier}'`,
        };
    }
    imRecordResolved(realmId, base, normalized, asURL);
    if (result === null)
        return { __proto__: null, url: normalized, mapped: false };
    return { __proto__: null, url: result.url, mapped: result.url !== normalized || asURL === null };
}

// An inline module is imported under the document's URL with a query that names it (40-bridge.js); its base URL is the
// document's.
const imBase = (base) => IMReplace(HostString(base), /[?&]__chitin_module=\d+$/, '');

// Whether a realm's document has an import map with anything in imports or scopes (no map: the service worker leaves
// modules alone, and V8's own errors are already Chrome's).
api.importMapActive = (realmId) => {
    const map = imMap(realmId);
    return map !== null && (map.imports.length > 0 || map.scopes.length > 0);
};

// Resolves specifiers for the module at `base` in a realm: an array of imResolveOne's results, one per specifier.
api.importMapResolve = (realmId, base, specifiers) => {
    const map = imMap(realmId);
    const b = imBase(base);
    const out = [];
    for (let i = 0; i < specifiers.length; i++)
        IMPush(out, map === null ? { __proto__: null, url: null, mapped: false } : imResolveOne(realmId, map, b, HostString(specifiers[i])));
    return out;
};

// The integrity metadata the import map gives a module URL ("resolve a module integrity metadata"), or '' for none.
api.importMapIntegrity = (realmId, url) => {
    const map = imMap(realmId);
    if (map === null)
        return '';
    const v = map.integrity[HostString(url)];
    return typeof v === 'string' ? v : '';
};
