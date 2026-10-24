// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin engine glue: windows a page opens (window.open), for sign-in popups (docs/oauth.md).
// The engine has no second top-level page, so window.open here does what the carapace can do: with a user gesture it
// returns a cross-origin WindowProxy stand-in (50-frames.js makeRemoteWindow) and asks the host to open the window
// (callbacks.popups.open). The carapace decides: a page of the opener's own site runs in a popup segment of that site
// (hidden; its window.opener is a stand-in for this window, and its postMessage reaches this page through the carapace,
// origin stamped and checked as for frames); an identity provider's page goes to the user's real browser (RFC 8252), and
// the address the provider returns to, pasted back by the user, becomes the popup segment's page. The stand-in's
// `closed` and, while the popup shows a page of this origin, its `location` follow what the carapace reports (popupState).
// Without a gesture the engine's own window.open runs (Chrome's popup blocker: null).

const StringPrototypeStartsWith = uncurryThis(HostString.prototype.startsWith);
const PopupMap = globalThis.Map;
const popups = new PopupMap();           // id -> { id, name, closed, url, proxy }
const popupList = [];                    // the same entries, in order (no Map iteration: page code shares the realm's prototypes)
let nextPopupId = 1;
let openerProxy = null;                  // in a popup segment: the stand-in for the window that opened it
let openerOverride;                      // `window.opener = x` (a replaceable attribute)
let openerOverridden = false;

// The MessageEvent source for a message the carapace delivers from `opener` or `popup:<id>` (50-frames.js deliverMessage).
function popupMessageSource(from) {
    if (from === 'opener')
        return openerProxy;
    const id = +StringPrototypeSlice(from, 6);
    const p = MapPrototypeGet(popups, id);
    return p === undefined || p.closed ? null : p.proxy;
}

// The features string's noopener / noreferrer (HTML "tokenize the features argument" and "check if a window feature is set").
function featureSet(features, name) {
    const parts = StringPrototypeSplit(StringPrototypeToLowerCase(HostString(features)), new HostRegExp('[\\s,]+'));
    for (let i = 0; i < parts.length; i++) {
        const eq = StringPrototypeSplit(parts[i], '=');
        if (StringPrototypeTrim(eq[0]) !== name)
            continue;
        if (eq.length === 1)
            return true;
        const v = StringPrototypeTrim(eq[1]);
        return v === '' || v === 'yes' || v === 'true' || (v !== '' && +v !== 0 && v === v);
    }
    return false;
}

// A same-origin popup's Location, read-only but for href (what MSAL-style popup flows read: href, hash, search).
function makeReadableLocation(href, navigate) {
    let u;
    try {
        u = new callbacks.HostURL(href);
    } catch {
        return null;
    }
    const fields = ['href', 'origin', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'];
    const loc = ObjectCreate(null);
    for (let i = 0; i < fields.length; i++) {
        const k = fields[i];
        const value = HostString(u[k]);
        const holder = k === 'href'
            ? { get href() { return value; }, set href(v) { navigate(HostString(new callbacks.HostURL(HostString(v), href).href)); } }
            : { get [k]() { return value; } };
        const d = ObjectGetOwnPropertyDescriptor(holder, k);
        WeakSetPrototypeAdd(nativeFunctions, d.get);
        if (d.set)
            WeakSetPrototypeAdd(nativeFunctions, d.set);
        ObjectDefineProperty(loc, k, { get: d.get, set: d.set, enumerable: true, configurable: false });
    }
    const assign = (name) => nativeMethod(name, function (url) { navigate(HostString(new callbacks.HostURL(HostString(url), href).href)); }, 1);
    ObjectDefineProperty(loc, 'assign', { value: assign('assign'), enumerable: true });
    ObjectDefineProperty(loc, 'replace', { value: assign('replace'), enumerable: true });
    ObjectDefineProperty(loc, 'toString', { value: nativeMethod('toString', function () { return HostString(u.href); }, 0), enumerable: true });
    return ObjectFreeze(loc);
}

function makePopup(id, name) {
    const p = { id, name, closed: false, url: '', proxy: null, readable: null, readableFor: '' };
    const navigate = (url) => {
        if (!p.closed)
            callbacks.popups.navigate(id, url);
    };
    p.proxy = makeRemoteWindow(() => (p.closed ? null : 'popup:' + id), { parent: () => p.proxy, top: () => p.proxy }, {
        closed: () => p.closed,
        close: () => {
            if (p.closed)
                return;
            p.closed = true;
            callbacks.popups.close(id);
        },
        navigate,
        location: () => {
            if (p.closed || p.url === '' || urlOrigin(p.url) !== ownOrigin())
                return null;
            if (p.readableFor !== p.url) {
                p.readable = makeReadableLocation(p.url, navigate);
                p.readableFor = p.url;
            }
            return p.readable;
        },
    });
    MapPrototypeSet(popups, id, p);
    ArrayPrototypePush(popupList, p);
    return p;
}

function hasTransientActivation() {
    if (!F.navigatorGet || !F.userActivationGet || !F.isActiveGet)
        return false;
    try {
        const ua = ReflectApply(F.userActivationGet, ReflectApply(F.navigatorGet, G, []), []);
        return ua !== null && ua !== undefined && ReflectApply(F.isActiveGet, ua, []) === true;
    } catch {
        return false;
    }
}

// Before the global is installed (40-bridge.js enableScripting): `open` (and in a popup segment `opener` and `close`) are
// replacements of the engine's members, so the page's global has them from its first script (under Node's vm too, where the
// page's global is not the glue's object).
function preparePopups() {
    if (!callbacks.popups || !callbacks.HostURL)
        return;
    if (globalReplacements === null)
        globalReplacements = { __proto__: null };
    globalReplacements.open = (defineEngineMember) => {
        const holder = ObjectCreate(null);
        defineEngineMember(holder);
        const openDesc = ObjectGetOwnPropertyDescriptor(holder, 'open');
        if (openDesc === undefined || typeof openDesc.value !== 'function')
            return openDesc;
        const engineOpen = openDesc.value;
        const open = nativeMethod('open', function open(url, target, features) {
            const name = target === undefined ? '_blank' : HostString(target);
            const lower = StringPrototypeToLowerCase(name);
            // A window of this page's own (the page itself, its parent or top): the engine navigates it, as before.
            if (lower === '_self' || lower === '_parent' || lower === '_top')
                return ReflectApply(engineOpen, this, arguments);
            let resolved = 'about:blank';
            const given = url === undefined ? '' : HostString(url);
            if (given !== '') {
                try {
                    resolved = HostString(new callbacks.HostURL(given, ownLocationHref()).href);
                } catch {
                    throw new F.DOMException("Failed to execute 'open' on 'Window': Unable to open a window with invalid URL '" + given + "'.", 'SyntaxError');
                }
            }
            // A named window this page already opened: navigated, and the same WindowProxy returned.
            if (lower !== '_blank' && name !== '') {
                for (let i = 0; i < popupList.length; i++) {
                    const p = popupList[i];
                    if (!p.closed && p.name === name) {
                        if (resolved !== 'about:blank')
                            callbacks.popups.navigate(p.id, resolved);
                        return p.proxy;
                    }
                }
            }
            if (!hasTransientActivation())
                return ReflectApply(engineOpen, this, arguments); // the popup blocker: null, as in Chrome
            if (resolved !== 'about:blank' && !StringPrototypeStartsWith(resolved, 'https:') && !StringPrototypeStartsWith(resolved, 'http:'))
                return null; // javascript:, data:, blob: windows are not opened (docs/oauth.md)
            const noopener = features !== undefined && (featureSet(features, 'noopener') || featureSet(features, 'noreferrer'));
            const id = nextPopupId++;
            const p = makePopup(id, lower === '_blank' ? '' : name);
            callbacks.popups.open(id, resolved === 'about:blank' ? '' : resolved, noopener);
            return noopener ? null : p.proxy;
        }, 0);
        return { value: open, writable: openDesc.writable, enumerable: openDesc.enumerable, configurable: openDesc.configurable };
    };
    if (callbacks.opener !== true)
        return;
    // This segment is a popup: `opener` is the opener's stand-in (replaceable, as in Chrome), and close() closes it.
    openerProxy = makeRemoteWindow(() => 'opener', { parent: () => openerProxy, top: () => openerProxy });
    const holder = {
        get opener() { return openerOverridden ? openerOverride : openerProxy; },
        set opener(v) { openerOverridden = true; openerOverride = v; },
    };
    const d = ObjectGetOwnPropertyDescriptor(holder, 'opener');
    WeakSetPrototypeAdd(nativeFunctions, d.get);
    WeakSetPrototypeAdd(nativeFunctions, d.set);
    globalReplacements.opener = { get: d.get, set: d.set, enumerable: true, configurable: true };
    const close = nativeMethod('close', function close() { callbacks.popups.selfClose(); }, 0);
    globalReplacements.close = { value: close, writable: true, enumerable: true, configurable: true };
}

// After the global is installed: what the replacements read at call time.
function installPopups() {
    F.navigatorGet = getter(G, 'navigator');
    F.userActivationGet = G.Navigator && getter(G.Navigator.prototype, 'userActivation');
    F.isActiveGet = G.UserActivation && getter(G.UserActivation.prototype, 'isActive');
}

// The carapace's word on a popup this page opened: { id, closed, url } (url: the page it shows, '' while none).
api.popupState = (m) => {
    const p = m && MapPrototypeGet(popups, m.id);
    if (p === undefined || p.closed)
        return false;
    if (typeof m.url === 'string')
        p.url = m.url;
    if (m.closed === true)
        p.closed = true;
    return true;
};
