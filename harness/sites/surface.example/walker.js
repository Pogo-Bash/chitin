// The surface walker: runs as page JavaScript in Chrome's top-level window and in a Chitin segment, leaves JSON in window.__surface.
// props: path -> "key" -> signature; calls: brand-check results; probes: named behaviour probes.
(function () {
    'use strict';
    const G = globalThis;
    const TRACE = /trace/.test(String(G.location && G.location.search));
    const trace = (m) => { if (TRACE) console.log('TRACE ' + m); };
    const FPTS = Function.prototype.toString;
    const OPN = Object.getOwnPropertyNames, OPD = Object.getOwnPropertyDescriptor, GPO = Object.getPrototypeOf, OPS = Object.prototype.toString;
    const BUILTIN = new Set(('Object Function Array Number parseFloat parseInt Infinity NaN undefined Boolean String Symbol Date Promise RegExp Error AggregateError EvalError RangeError ReferenceError SyntaxError TypeError URIError globalThis JSON Math Intl ArrayBuffer Atomics Uint8Array Int8Array Uint16Array Int16Array Uint32Array Int32Array Float32Array Float64Array Uint8ClampedArray BigUint64Array BigInt64Array DataView Map BigInt Set WeakMap WeakSet Proxy Reflect FinalizationRegistry WeakRef decodeURI decodeURIComponent encodeURI encodeURIComponent escape unescape eval isFinite isNaN console Iterator SharedArrayBuffer WebAssembly').split(' '));
    const tag = (o) => { try { return OPS.call(o).slice(8, -1); } catch (e) { return '?'; } };
    const label = (o) => {
        try {
            const d = OPD(o, 'constructor');
            const c = d && d.value;
            const t = o[Symbol.toStringTag];
            return (typeof c === 'function' ? c.name : '?') + (typeof t === 'string' ? '/' + t : '');
        } catch (e) { return '?'; }
    };
    const native = (f) => { try { return /\{\s*\[native code\]\s*\}\s*$/.test(FPTS.call(f)); } catch (e) { return 'throws:' + e.name; } };
    function fsig(f) {
        let s = 'fn:' + f.name + ':' + f.length + ':' + (native(f) === true ? 'N' : 'SRC<' + FPTS.call(f).slice(0, 50).replace(/\s+/g, ' ') + '>');
        s += ':proto=' + Object.prototype.hasOwnProperty.call(f, 'prototype') + ':keys=' + OPN(f).filter((k) => k !== 'prototype').join(',') + ':fp=' + (GPO(f) === Function.prototype);
        return s;
    }
    function vsig(v, deep) {
        const t = typeof v;
        if (t === 'function') return fsig(v);
        if (t === 'object' && v !== null) return 'obj:' + tag(v);
        if (t === 'string') return deep ? 'str:' + v.slice(0, 40) : 'str';
        if (t === 'number' || t === 'boolean') return deep ? t + ':' + String(v) : t;
        return t;
    }
    function dsig(d, deep) {
        const flags = (d.writable ? 'w' : '-') + (d.enumerable ? 'e' : '-') + (d.configurable ? 'c' : '-');
        if ('value' in d) return 'd' + flags + '|' + vsig(d.value, deep);
        return 'a' + (d.enumerable ? 'e' : '-') + (d.configurable ? 'c' : '-') + '|g=' + (d.get ? fsig(d.get) : 'none') + '|s=' + (d.set ? fsig(d.set) : 'none');
    }
    const props = {}, calls = {}, chains = {}, visited = new Set();
    const symName = (k) => (typeof k === 'symbol' ? k.toString() : k);
    // Members that navigate, block or close when a binding does not check its receiver (Chitin's did, once): never called with a foreign this.
    const NO_CALL = /^(alert|confirm|prompt|print|reload|assign|replace|back|forward|go|open|close|stop|submit|requestSubmit|showModal|requestFullscreen|requestPointerLock|showPicker|location|href|pathname|search|hash|host|hostname|port|protocol|origin|username|password|write|writeln)$/;
    function brand(path, key, d) {
        if (NO_CALL.test(String(key)) || BUILTIN.has(String(key))) return;
        // The same call everywhere: this = a plain object. Chrome throws "Illegal invocation" for any DOM member.
        const run = (f, what) => {
            try { const r = f.call({}); if (r && typeof r.then === 'function') { r.then(null, () => {}); calls[path + '::' + key + what] = 'returned a promise'; } else calls[path + '::' + key + what] = 'returned'; } catch (e) { calls[path + '::' + key + what] = (e && e.name) + ': ' + String(e && e.message).slice(0, 120); }
        };
        if ('value' in d) { if (typeof d.value === 'function' && String(key) !== 'constructor' && !(path[0] === 'G' && /^[A-Z]/.test(String(key)))) run(d.value, '()'); }
        else { if (d.get) run(d.get, ' get'); if (d.set) { try { d.set.call({}, 1); calls[path + '::' + key + ' set'] = 'returned'; } catch (e) { calls[path + '::' + key + ' set'] = (e && e.name) + ': ' + String(e && e.message).slice(0, 120); } } }
    }
    function walk(path, o, deep, doCalls) {
        trace('walk ' + path);
        const keys = Reflect.ownKeys(o);
        const m = props[path] = {};
        m['#keys'] = String(keys.length);
        for (const k of keys) {
            const d = OPD(o, k);
            if (!d || (o === G && k === '__chitinReport')) continue; // the test sites' hook (worker.js installPageGlobals); real pages do not get it
            m[symName(k)] = dsig(d, deep);
            trace('  ' + String(symName(k)));
            if (doCalls && k !== 'console') brand(path, symName(k), d);
        }
    }
    // The global's chain is compared by position (a Window against a DedicatedWorkerGlobalScope); the others by what they are, shared
    // prototypes once (HTMLElement.prototype is S:HTMLElement/HTMLElement however the walk got there).
    function walkChain(base, o, deep, doCalls) {
        const labels = [];
        let i = 0;
        for (let p = o; p && i < 12; p = GPO(p), i++) {
            const l = label(p);
            labels.push(l);
            if (visited.has(p)) continue;
            visited.add(p);
            walk(i === 0 ? base : base === 'G' ? 'G' + i : 'S:' + l, p, deep || i > 0, doCalls && !BUILTIN.has(l.split('/')[0]));
        }
        chains[base] = labels.join(' > ');
    }
    // 1. the global and its prototype chain
    walkChain('G', G, false, true);
    // 2. every interface object: the constructor and its prototype (with the prototype chains)
    // Interface objects by their own name, in name order, aliases (webkitURL, WebKitCSSMatrix) once: the walk must not depend on the
    // order of the global's keys, which differs between a Window and a Worker's global.
    const names = OPN(G).slice().sort();
    for (const n of names) {
        let d = OPD(G, n);
        if (!d || !('value' in d)) continue;
        const v = d.value;
        if (typeof v === 'function' && v.prototype && typeof v.prototype === 'object' && /^[A-Z]/.test(n) && !BUILTIN.has(n)) {
            const cn = v.name || n;
            if (!visited.has(v)) { visited.add(v); walk('C:' + cn, v, true, true); }
            walkChain('P:' + cn, v.prototype, true, true);
            try { chains['C:' + cn] = label(GPO(v)); } catch (e) {}
            try { calls['callnew:' + cn] = (() => { try { v(); return 'returned'; } catch (e) { return e.name + ': ' + String(e.message).slice(0, 140); } })(); } catch (e) {}
        } else if (typeof v === 'object' && v !== null && !BUILTIN.has(n) && n !== 'document' || n === 'document') {
            // instances (navigator, document, location, screen, history, performance, ...): own and inherited members
            walkChain('I:' + n, v, false, false);
        }
    }
    // Instances reached through accessors of the global (not data properties): the same walk.
    for (const n of ['navigator', 'location', 'performance', 'history', 'screen', 'localStorage', 'sessionStorage', 'crypto', 'visualViewport', 'customElements', 'speechSynthesis', 'trustedTypes', 'scheduler', 'indexedDB', 'caches', 'external', 'styleMedia', 'navigation', 'cookieStore', 'chrome', 'locationbar', 'menubar', 'toolbar', 'statusbar', 'scrollbars', 'personalbar']) {
        let v;
        try { v = G[n]; } catch (e) { continue; }
        if (typeof v === 'object' && v !== null && !visited.has(v)) walkChain('I:' + n, v, false, false);
    }
    // 3. constructibility of the usual suspects
    for (const [n, args] of [['Node', []], ['Element', []], ['HTMLElement', []], ['Document', []], ['Window', []], ['EventTarget', []], ['Event', ['x']], ['Event', []], ['URL', []], ['Headers', []], ['Blob', []], ['HTMLDivElement', []], ['NodeList', []], ['CSSStyleDeclaration', []], ['Navigator', []], ['Location', []], ['History', []], ['Storage', []], ['MutationObserver', []], ['Text', []], ['DocumentFragment', []]]) {
        try { new G[n](...args); calls['new:' + n + args.length] = 'ok'; } catch (e) { calls['new:' + n + args.length] = (e && e.name) + ': ' + String(e && e.message).slice(0, 140); }
    }

    // --- behaviour probes -----------------------------------------------------------------------------------------
    const out = {};
    const norm = (s) => String(s).replace(/(?:https?|blob):\/\/[^/\s)]+/g, '<o>').replace(/:\d+:\d+\)?/g, ':L)').replace(/:\d+$/gm, ':L');
    const stackOf = (s) => String(s).split('\n').map(norm);
    const probe = async (name, fn) => { trace('probe ' + name); try { const r = await fn(); out[name] = JSON.stringify(r === undefined ? 'undefined' : r); } catch (e) { out[name] = 'THROWS ' + (e && e.name) + ': ' + String(e && e.message).slice(0, 160); } };
    const E = window.__early || {};
    const P = [];
    trace('probes');
    const add = (n, f) => P.push(probe(n, f));
    add('global string', () => [OPS.call(G), String(G), G.constructor && G.constructor.name, typeof window, G === window, window.window === window, self === window, top === window, parent === window, frames === window, window.length, typeof opener, window.closed, window.name]);
    add('proto chains', () => [chains.G, chains['I:navigator'], chains['I:location'], chains['I:document'], chains['I:history'], chains['I:screen'], chains['I:performance']]);
    add('worker names', () => ['WorkerGlobalScope', 'DedicatedWorkerGlobalScope', 'WorkerNavigator', 'WorkerLocation', 'SharedWorkerGlobalScope', 'ServiceWorkerGlobalScope', 'importScripts', 'close', 'postMessage', 'onmessage', 'onmessageerror', 'onconnect', 'registration', 'skipWaiting', 'clients', 'caches', 'createImageBitmap', 'FileReaderSync'].map((n) => n + ':' + (n in G) + ':' + typeof G[n]));
    add('navigator proto identity', () => [GPO(navigator) === Navigator.prototype, OPS.call(navigator), navigator.constructor === Navigator, navigator instanceof Navigator, Object.keys(navigator).length]);
    add('location', () => [OPS.call(location), GPO(location) === Location.prototype, location.constructor.name, location.constructor === Location, Object.keys(location).join(','), typeof location.ancestorOrigins, typeof location.assign]);
    add('brand: location/history getters on a foreign this', () => ['href', 'origin', 'pathname'].map((k) => { try { const d = OPD(location, k) || OPD(Location.prototype, k); d.get.call({}); return k + ': returned'; } catch (e) { return k + ': ' + e.name + ': ' + e.message; } }).concat(['length', 'state'].map((k) => { try { OPD(History.prototype, k).get.call({}); return k + ': returned'; } catch (e) { return k + ': ' + e.name + ': ' + e.message; } })));
    add('document chain', () => { const o = []; for (let p = document; p; p = GPO(p)) o.push(label(p)); return o; });
    add('element chain', () => { const o = []; for (let p = document.createElement('div'); p; p = GPO(p)) o.push(label(p)); return o; });
    add('Atomics.wait', () => { try { return 'result ' + Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); } catch (e) { return e.name + ': ' + e.message; } });
    add('Atomics.waitAsync/isLockFree', () => [typeof Atomics.waitAsync, typeof SharedArrayBuffer, crossOriginIsolated]);
    add('Error statics', () => ['prepareStackTrace' in Error, typeof Error.captureStackTrace, Error.stackTraceLimit, OPD(Error, 'prepareStackTrace') === undefined]);
    add('stack: inline script', () => stackOf(E.stackInline));
    add('stack: external script', () => stackOf(E.external && E.external.stack));
    add('stack: module', () => stackOf(E.module && E.module.stack));
    add('stack: walker file', () => stackOf(new Error('x').stack));
    add('stack: in an event listener', () => { let s; const t = new EventTarget(); t.addEventListener('x', () => { s = new Error('x').stack; }); t.dispatchEvent(new Event('x')); return stackOf(s); });
    add('stack: in a DOM listener', () => { let s; const el = document.createElement('div'); el.addEventListener('click', () => { s = new Error('x').stack; }); el.click(); return stackOf(s); });
    add('stack: in a timer', () => new Promise((r) => setTimeout(() => r(stackOf(new Error('x').stack)), 0)));
    add('stack: brand error thrown by a binding', () => { try { Node.prototype.appendChild.call({}, 1); } catch (e) { return [e.name, e.message, stackOf(e.stack)]; } });
    add('stack: error thrown by a getter on an element', () => { try { Object.getOwnPropertyDescriptor(Node.prototype, 'nodeType').get.call({}); } catch (e) { return [e.name, e.message, stackOf(e.stack)]; } });
    add('stack: callback via MutationObserver', () => new Promise((r) => { const mo = new MutationObserver(() => { r(stackOf(new Error('x').stack)); mo.disconnect(); }); const d = document.createElement('div'); mo.observe(d, { attributes: true }); d.setAttribute('a', '1'); }));
    add('stack: DOM method error message', () => { try { document.createElement('div').appendChild(5); } catch (e) { return [e.name, e.message]; } });
    add('stack: setAttribute bad', () => { try { document.createElement('div').setAttribute('1a', 'x'); } catch (e) { return [e.name, e.message, e.code, e.constructor.name, OPS.call(e)]; } });
    add('stack: querySelector bad', () => { try { document.querySelector('!!'); } catch (e) { return [e.name, e.message, e.code]; } });
    add('script src / currentScript', () => [norm(E.inline && E.inline.src), E.inline && E.inline.tag, norm(E.external && E.external.src), norm(E.module && E.module.url), E.module && E.module.cs, E.docWriteSync, E.thisIsGlobal, E.readyState]);
    add('document.write timing', () => E.docWriteSync);
    add('Function.prototype.toString', () => [FPTS.call(FPTS), FPTS.call(alert), FPTS.call(OPD(Node.prototype, 'nodeType').get), FPTS.call(Node.prototype.appendChild), FPTS.call(setTimeout), FPTS.call(Event), FPTS.call(document.createElement), FPTS.call(class A {}), String(FPTS.call(function () {})).length, FPTS.call(Object.getOwnPropertyDescriptor(Document.prototype, 'cookie').set), FPTS.call(HTMLElement.prototype.click), FPTS.call(console.log), FPTS.call(fetch), FPTS.call(requestAnimationFrame)]);
    add('toString proxy tampering', () => { try { return FPTS.call(new Proxy(alert, {})); } catch (e) { return e.name + ': ' + e.message; } });
    add('dialogs', () => [typeof alert, typeof confirm, typeof prompt, typeof print, typeof open, typeof close, typeof stop, typeof focus, typeof blur, alert && alert.length, confirm && confirm.length, prompt && prompt.length]);
    add('rAF', () => new Promise((r) => { if (typeof requestAnimationFrame !== 'function') return r('missing'); const t = []; const f = (ts) => { t.push(ts); if (t.length < 4) requestAnimationFrame(f); else r({ argType: typeof t[0], isHighRes: t[0] % 1 !== 0 || t[0] > 100, dt: Math.round(t[3] - t[1]), id: typeof requestAnimationFrame(() => {}), cancel: typeof cancelAnimationFrame }); }; requestAnimationFrame(f); setTimeout(() => r('timeout, got ' + t.length), 4000); }));
    add('rIC', () => new Promise((r) => { if (typeof requestIdleCallback !== 'function') return r('missing'); requestIdleCallback((d) => r({ keys: Object.keys(d), proto: OPS.call(d), tr: typeof d.timeRemaining(), did: d.didTimeout, cancel: typeof cancelIdleCallback })); setTimeout(() => r('timeout'), 4000); }));
    add('performance', () => [OPS.call(performance), typeof performance.timeOrigin, typeof performance.memory, typeof PerformanceObserver === 'function' ? PerformanceObserver.supportedEntryTypes : 'none', typeof performance.getEntries, typeof performance.measureUserAgentSpecificMemory, Object.keys(performance.toJSON ? performance.toJSON() : {}).join(',')]);
    add('performance entries', () => performance.getEntries().map((e) => e.entryType + ':' + norm(e.name).split('/').pop() + ':' + e.initiatorType));
    add('performance resolution', () => { const a = []; for (let i = 0; i < 30; i++) a.push(performance.now()); const d = a.slice(1).map((x, i) => x - a[i]).filter((x) => x > 0); return [d.length ? Math.min(...d) < 0.01 ? '<10us' : Math.min(...d) < 0.1 ? '<100us' : '>=100us' : 'flat']; });
    add('navigator values', () => ['userAgent', 'appVersion', 'platform', 'vendor', 'vendorSub', 'product', 'productSub', 'appName', 'appCodeName', 'language', 'languages', 'hardwareConcurrency', 'deviceMemory', 'webdriver', 'cookieEnabled', 'onLine', 'maxTouchPoints', 'pdfViewerEnabled', 'doNotTrack', 'globalPrivacyControl'].map((k) => k + '=' + JSON.stringify(navigator[k])));
    add('navigator objects', () => ['plugins', 'mimeTypes', 'connection', 'userAgentData', 'permissions', 'storage', 'serviceWorker', 'mediaDevices', 'clipboard', 'credentials', 'geolocation', 'gpu', 'locks', 'bluetooth', 'usb', 'hid', 'serial', 'wakeLock', 'mediaSession', 'keyboard', 'presentation', 'scheduling', 'ink', 'xr', 'virtualKeyboard', 'windowControlsOverlay', 'userActivation', 'login'].map((k) => k + ':' + typeof navigator[k] + ':' + (navigator[k] && tag(navigator[k]))));
    add('navigator.userAgentData', () => navigator.userAgentData ? [navigator.userAgentData.brands.map((b) => b.brand).join('|'), navigator.userAgentData.mobile, navigator.userAgentData.platform] : 'none');
    add('plugins', () => navigator.plugins ? [navigator.plugins.length, Array.from(navigator.plugins).map((p) => p.name).join('|'), navigator.mimeTypes.length] : 'none');
    add('screen/window geometry', () => [screen.colorDepth, screen.pixelDepth, screen.orientation && screen.orientation.type, typeof outerWidth, outerWidth === innerWidth, outerHeight - innerHeight, devicePixelRatio, screenX, screenY, typeof visualViewport, visualViewport && visualViewport.scale, matchMedia('(prefers-color-scheme: dark)').matches, matchMedia('(hover: hover)').matches, matchMedia('(pointer: fine)').matches]);
    add('document state', () => [document.visibilityState, document.hidden, document.hasFocus(), document.readyState, document.characterSet, document.compatMode, document.contentType, document.designMode, typeof document.timeline, document.fonts && document.fonts.status, history.length, history.scrollRestoration, document.referrer, document.cookie === '' || typeof document.cookie, typeof document.fullscreenEnabled]);
    add('chrome object', () => [typeof chrome, typeof chrome === 'object' && chrome ? Object.keys(chrome).join(',') : '', typeof chrome === 'object' && chrome && chrome.runtime ? typeof chrome.runtime : 'no runtime', 'chrome' in window, typeof webkitRequestFileSystem, typeof webkitURL, typeof webkitSpeechRecognition, typeof webkitStorageInfo]);
    add('global enumerable keys', () => { const k = []; for (const x in G) k.push(x); return [k.length, k.slice(0, 15), k.slice(-8)]; });
    add('global own key order', () => { const n = OPN(G); return [n.length, n.slice(0, 25), n.slice(-12)]; });
    add('Object.keys(window) order', () => Object.keys(G).slice(0, 25));
    add('sloppy this / new Function', () => [(function () { return this; })() === G, new Function('return this')() === G, (0, eval)('this') === G, Object.getPrototypeOf(G) === Window.prototype, G instanceof Window, G instanceof EventTarget, Window.prototype.constructor === Window]);
    add('timers', () => [typeof setTimeout(() => {}, 0), typeof setInterval(() => {}, 1e9), typeof queueMicrotask, typeof structuredClone, typeof reportError, typeof scheduler, typeof requestAnimationFrame]);
    add('timer clamp', () => new Promise((r) => { const t0 = performance.now(); let n = 0; const f = () => { if (++n < 8) setTimeout(f, 0); else r(performance.now() - t0 > 18 ? 'clamped(>=4ms nested)' : 'unclamped'); }; setTimeout(f, 0); }));
    add('console', () => [OPS.call(console), Object.keys(console).join(','), console.log.name, console.log.length, FPTS.call(console.log), typeof console.context]);
    add('crypto', () => [typeof crypto, OPS.call(crypto), typeof crypto.subtle, typeof crypto.randomUUID, typeof crypto.getRandomValues, OPS.call(crypto.subtle)]);
    add('permissions', () => navigator.permissions ? navigator.permissions.query({ name: 'notifications' }).then((s) => [s.state, typeof Notification !== 'undefined' && Notification.permission]) : 'none');
    add('canvas/webgl', () => { const c = document.createElement('canvas'); const r = [OPS.call(c), typeof c.getContext, typeof OffscreenCanvas]; try { const g = c.getContext('2d'); r.push(g && OPS.call(g)); } catch (e) { r.push('2d throws ' + e.message); } try { const g = c.getContext('webgl'); r.push(g && OPS.call(g)); if (g) { const x = g.getExtension('WEBGL_debug_renderer_info'); r.push(x && g.getParameter(x.UNMASKED_RENDERER_WEBGL)); } } catch (e) { r.push('webgl throws ' + e.message); } return r; });
    add('fonts / measureText', () => { const g = document.createElement('canvas').getContext('2d'); g.font = '16px sans-serif'; return g ? [Math.round(g.measureText('mmmmmmmmmmlli').width), typeof g.measureText('x').actualBoundingBoxAscent] : 'none'; });
    add('Intl/tz', () => [Intl.DateTimeFormat().resolvedOptions().timeZone, new Date(0).getTimezoneOffset(), navigator.language]);
    add('storage objects', () => ['localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookieStore', 'webkitStorageInfo', 'external', 'speechSynthesis', 'customElements', 'trustedTypes', 'isSecureContext', 'originAgentCluster', 'crossOriginIsolated', 'origin', 'frameElement', 'event', 'styleMedia', 'clientInformation', 'launchQueue', 'navigation', 'documentPictureInPicture'].map((k) => k + ':' + typeof G[k] + ':' + (G[k] !== null && typeof G[k] === 'object' ? tag(G[k]) : '')));
    add('instanceof/brand', () => [document instanceof Document, document instanceof Node, document.body instanceof HTMLBodyElement, document.createElement('div') instanceof HTMLDivElement, OPS.call(document.createElement('div')), OPS.call(document), OPS.call(document.body), OPS.call(document.createElement('canvas')), OPS.call(new Event('x')), OPS.call(document.createTextNode('x')), OPS.call(document.querySelectorAll('div')), OPS.call(document.createElement('div').style), OPS.call(document.createElement('div').classList), OPS.call(new URL('http://a/')), OPS.call(new Headers()), OPS.call(new Blob([])), OPS.call(fetch('data:,').catch(() => {}).constructor === Promise)]);
    add('descriptor of window props', () => ['window', 'self', 'document', 'location', 'top', 'parent', 'frames', 'navigator', 'performance', 'name', 'onload', 'localStorage', 'chrome'].map((k) => { const d = OPD(G, k); return k + ':' + (d ? ('value' in d ? 'd' : 'a') + (d.writable ? 'w' : '-') + (d.enumerable ? 'e' : '-') + (d.configurable ? 'c' : '-') : 'none'); }));
    add('Object.getOwnPropertyDescriptors count', () => [OPN(Object.getPrototypeOf(G)).length, OPN(Object.getPrototypeOf(Object.getPrototypeOf(G))).length]);
    add('event handler props', () => ['onload', 'onerror', 'onmessage', 'onclick', 'onresize', 'onhashchange', 'onpopstate', 'onbeforeunload', 'onunload', 'onpagehide', 'onvisibilitychange', 'onfocus', 'onscroll', 'onunhandledrejection', 'onlanguagechange', 'ononline', 'onstorage', 'ontouchstart', 'onpointerdown', 'onwheel'].map((k) => k + ':' + (k in G) + ':' + typeof G[k] + ':' + (OPD(G, k) ? 'own' : 'inh')));
    add('unhandled rejection / error event shape', () => new Promise((r) => { const h = (e) => { removeEventListener('error', h); r([OPS.call(e), e.constructor.name, typeof e.message, typeof e.filename && norm(e.filename).split('/').pop(), typeof e.lineno, e.error && e.error.name, e.isTrusted]); }; addEventListener('error', h); setTimeout(() => { throw new TypeError('boom'); }, 0); setTimeout(() => r('timeout'), 3000); }));
    add('MessageEvent from postMessage', () => new Promise((r) => { const h = (e) => { removeEventListener('message', h); r([OPS.call(e), e.constructor.name, e.data, norm(e.origin), e.source === window, e.isTrusted, OPS.call(e.ports)]); }; addEventListener('message', h); try { postMessage('hi', '*'); } catch (e) { r('threw ' + e.name + ': ' + e.message); } setTimeout(() => r('timeout'), 3000); }));
    add('postMessage signature', () => [postMessage.length, postMessage.name, FPTS.call(postMessage)]);
    add('close/self.close', () => [close.length, close.name, typeof self.close]);
    add('Function ctor / eval stack', () => { try { new Function('throw new Error("e")')(); } catch (e) { return stackOf(e.stack); } });
    add('getComputedStyle', () => [typeof getComputedStyle, OPS.call(getComputedStyle(document.body)), getComputedStyle(document.body).display]);
    add('fetch/XHR/WebSocket shapes', () => [FPTS.call(fetch), OPS.call(fetch('data:,').catch(() => {})), fetch.length, typeof XMLHttpRequest, typeof WebSocket, XMLHttpRequest && XMLHttpRequest.DONE, new XMLHttpRequest().readyState, typeof EventSource, typeof navigator.sendBeacon, typeof BroadcastChannel, typeof Worker, typeof SharedWorker, typeof MessageChannel, typeof RTCPeerConnection]);
    add('import() of a data module and import.meta', async () => { const m = await import('data:text/javascript,export default 1'); return [m.default, OPS.call(m)]; });
    add('Reflect.ownKeys(window) vs Object.getOwnPropertyNames', () => [Reflect.ownKeys(G).length - OPN(G).length]);
    return Promise.all(P).then(() => { window.__surface = JSON.stringify({ props, calls, chains, probes: out }); window.__surfaceDialog = 'done'; });
})();
