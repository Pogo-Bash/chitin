# Chitin: security design

Status: design, 2026-10-21. Answers four outside criticisms of the segment design with concrete
measures, says where the critics are right, and gives a ranked work list and the tests that would
prove each guarantee. Code references are to the tree at 67d3cde (harness/segment/worker.js,
harness/server.mjs, glue/00-primordials.js, glue/engine/40-bridge.js, harness/carapace/*.js).

Owner decisions this design keeps: no interception proxies (nothing rewrites a site on the network),
no hosted relay, LibJS removed, page JS on the host's V8 in the same realm as the binding glue.

## 0. Threat model

Assets, in the order we protect them:
1. **The user's IP and identity.** In Tor mode the site must not learn the user's IP, and a Tor-mode
   visit must not be linkable to a normal-mode visit of the same site. In normal mode the site sees
   the relay's IP, never the user's.
2. **Other sites' data.** Site A must not read site B's cookies, storage, DOM, frames or streams.
3. **The carapace.** Relay credentials, Tor state, history, bookmarks, settings, the address bar's
   truth (what site the user is looking at), the permission prompts.
4. **The site's own secrets against its own JS** where the web platform promises that: HttpOnly
   cookies, the engine's TLS keys, cross-origin response bodies the site's JS may not read (CORS).
5. **The relay operator** against being made an open proxy or a scanner.

Attackers:
- **A. The site's own JS.** Runs in the segment Worker in the same realm as our glue, with V8's JIT.
  It wants to do what a page in Chrome cannot: reach the host network directly (assets 1), read
  HttpOnly cookies or cross-origin bodies (4), talk to the carapace (3), detect it is in Chitin.
- **B. A hostile site that has fully compromised its segment**: arbitrary code in the segment's
  renderer process (a V8 or wasm bug, or a glue bug that hands it the engine's linear memory). The
  question is what it can do beyond attacker A.
- **C. A network observer** between the user and the relay, or between the relay and the site, or a
  hostile relay operator. Sees ciphertext and metadata (timing, sizes, destinations at the relay).
- **D. A bot/fingerprint vendor** embedded by the site (Turnstile, reCAPTCHA, hCaptcha, Akamai): not
  hostile to the user but able to reject them silently.

Out of scope: a compromised host browser or OS; the user's own extensions; a Tor exit reading
plaintext HTTP (we say "hides your IP from sites", not anonymity).

What the host browser gives us for free (and which no bug of ours can undo):
- Segments sit on their own registrable domain (`<hash>.chitin-sites.net`), so Chromium's Site
  Isolation puts each in its own renderer process and agent cluster
  (https://www.chromium.org/Home/chromium-security/site-isolation/). A segment compromise (attacker B)
  is a compromise of one site's process, held by the host's renderer sandbox. It reaches neither the
  carapace's memory, nor other segments, nor the host's cookie store for other origins.
- Document-Isolation-Policy (`isolate-and-require-corp`, Chrome 137+, desktop) makes the segment
  cross-origin isolated by itself, in its own process, without the carapace being so
  (https://developer.chrome.com/blog/document-isolation-policy). Spectre-class reads with the SAB
  timers it grants reach only that process.
- Storage partitioning: the segment origin's storage is keyed by the carapace's top-level site, so
  nothing leaks to or from first-party storage of the real site (which Chitin never touches).
- CSP on the Worker's own response: a dedicated Worker's policy comes from the Worker script's
  response headers, not from its creator (CSP3, "Initialize a global object's CSP list",
  https://w3c.github.io/webappsec-csp/#initialize-global-object-csp). That is our backstop: even a
  host API we forgot to hide cannot connect where the policy says no.

## 1. "You still need a sandbox for the JS engine"

**Verdict: right that the hiding we do today is not a sandbox; wrong that the answer is a second JS
engine.** The sandbox is the host's process and origin (above); the realm-level work is to make sure
the only door out of the Worker is ours, and to back that with the Worker's CSP so a missed door
fails closed. Today's hiding has two real holes (1.2).

### 1.1 What page JS can reach inside the segment Worker today

| Surface | Reachable today? | Breaks a guarantee? |
|---|---|---|
| `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `WebTransport` | shadowed on the instance by `installPageGlobals` (own property set to `undefined`), **but** `WorkerGlobalScope.prototype.fetch` and the interface objects' prototypes are still reachable: `Object.getPrototypeOf(Object.getPrototypeOf(self)).fetch.call(self, url)`. `XMLHttpRequest`/`WebSocket` constructors come back through any of their instances' `constructor`... once one exists, and the host's `WebSocket.prototype` survives on `Object.getPrototypeOf` of the mirror's if the mirror ever falls back | **Yes, the worst one.** The CSP (`connect-src 'self' http://origin.localhost`) is the only thing stopping a host fetch to anywhere. A host fetch leaves from the user's machine with the user's IP, bypassing Spiracle, the relay and Tor. In production, `'self'` (the segment origin's server, i.e. us) must be the only allowed destination, and ideally `'none'` |
| `importScripts`, `import()` | `importScripts` shadowed, prototype copy reachable; `import()` is syntax and cannot be removed. Worker CSP has `script-src https:` so V8 asks for the site's real URLs | **Yes when the service worker is not controlling the Worker** (first load race, a shift-reload that bypasses the SW, the SW being evicted mid-session): V8 then fetches `https://anything` from the host network, with the user's IP. The `hello.mjs` check covers boot only |
| `postMessage`, `onmessage`, `addEventListener('message')`, `dispatchEvent` on the global | instance members shadowed; `DedicatedWorkerGlobalScope.prototype.postMessage` and `EventTarget.prototype.{add,dispatch}EventListener` reachable | **Yes.** Page JS can post to the segment document; it can listen to the segment document's messages; and it can **dispatch a synthetic `MessageEvent` on `self`** that `onFirstMessage` accepts: `{type:'direct-input'}` becomes engine input the engine treats as trusted (user activation: popups, clipboard, fullscreen), `{type:'sw-port'}` and `{type:'init'}` replace our ports with the page's own (`start()` runs again with page-chosen `e.ports`). `onFirstMessage` does not check `e.isTrusted` |
| `Worker`, `SharedWorker` | shadowed; prototype reachable | No: Worker CSP `default-src 'none'` with no `worker-src` blocks nested workers. Keep it that way explicitly (`worker-src 'none'`) |
| `indexedDB`, `caches`, `navigator.storage`, `navigator.locks` | yes (the mirror replaces `indexedDB`/`caches` with the Window's, but the host's are on `WorkerGlobalScope.prototype`) | **Not for cookies** (M4, docs/cookies.md): the jar is persisted by the carapace, on its own origin, encrypted; nothing of it is in the segment origin's IndexedDB. Also an **identity link**: host storage outlives a Molt unless the segment origin changes |
| `BroadcastChannel`, `navigator.locks`, `SharedWorker` names | yes (BroadcastChannel) | **Yes in Tor mode**: a Tor-mode tab and a normal-mode tab of the same site share the segment origin today, so BroadcastChannel, locks, IndexedDB and the HTTP cache link the two identities |
| `navigator.*` (WorkerNavigator: `userAgent`, `hardwareConcurrency`, `deviceMemory`, `gpu`, `storage`, `locks`, `connection`, `language(s)`) | yes, mirrored over by the Window's `navigator` on the instance, host's reachable on the prototype | Fingerprint surface only (criticism 3). `navigator.serviceWorker` is behind a flag in Chromium's dedicated workers (https://chromium.googlesource.com/chromium/src/+/d0a55527d2400a0a2a778af6af07c60b9d50e3ec, MDN https://developer.mozilla.org/en-US/docs/Web/API/WorkerNavigator/serviceWorker; shipped in Firefox 133): if it ships, page JS could unregister or message our module-loader SW. Test for it |
| `SharedArrayBuffer`, `Atomics`, `performance.now` (5 µs under COI) | yes (crossOriginIsolated via DIP) | Same as a cross-origin-isolated page in Chrome. The process contains only this site, our glue and its engine: Spectre reads reach the engine's memory (its own cookies, TLS keys of its own connections), which is attacker B's position anyway. **Except** cross-site iframes rendered by the same engine (see 2.4) |
| timers, `queueMicrotask`, `scheduler` | mirrored (Window's, driven by the engine) | No |
| `OffscreenCanvas`, `createImageBitmap`, `ImageDecoder`, WebGL/WebGPU via `navigator.gpu` | yes | Not a network leak (no `connect-src` reach). GPU process is shared with every tab in the host browser: same exposure as any Chrome tab. Fingerprint surface (criticism 3) |
| WebRTC | not exposed in dedicated workers in Chromium | Would be the classic IP leak; test it stays absent |
| `WebAssembly.*` | yes (the page may compile its own wasm; CSP has `wasm-unsafe-eval`) | No, but the glue must not trust `WebAssembly.Memory.prototype.buffer` etc. after boot (primordials do this) |
| the glue's objects | wrappers carry private `#cell`; records are null-prototype; captured primordials; strict mode hides CallSite receivers | The design is right; the residual risk is one missed `obj.method()` in 1,300 lines of bridge. A typed-array view leaking means the page holds `memory.buffer`, i.e. attacker B without a V8 bug |
| the engine's linear memory | only through the glue | If reached: the engine's cookie jar (incl. HttpOnly), the TLS session keys, the net port's protocol. Treat as "segment compromised" (section 2) |
| the segment's service worker | indirectly: every Worker request goes through it; the SW answers from the engine | `portFor()` falls back to "the only port" when it lost its map: fine while one engine per origin |

### 1.2 Containment, in layers

**Layer 0, the host (free).** Site Isolation, DIP, the renderer sandbox, storage partitioning, the
Worker's own CSP. Never weaken these for convenience (e.g. never `connect-src https:` on the Worker).

**Layer 1, the Worker's response headers (fail closed).** Production headers for `worker.js`:

```
Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' https:;
  connect-src 'self'; worker-src 'none'; img-src 'none'; font-src 'none'; media-src 'none';
  object-src 'none'; base-uri 'none'
Permissions-Policy: (on the segment document, inherited by its Worker:) camera=(), microphone=(),
  geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), publickey-credentials-get=(),
  identity-credentials-get=(), browsing-topics=(), local-fonts=()
Cross-Origin-Resource-Policy: same-origin
```
- `connect-src 'self'` only works if every request to `'self'` is answered by the SW or our static
  host, and the static host for segment origins serves nothing but our files (no open redirects, no
  proxying). Better: `connect-src 'none'` and give the glue its engine files through the SW port
  (the glue already captures `hostFetch`; fetch the wasm before CSP matters is not possible because
  CSP applies from the start, so the wasm comes over the SW message port or as `'self'` from a
  host that serves only static bytes). Decision: `'self'` with a static-only host is acceptable; the
  user's IP reaching our static host is no worse than loading Chitin itself.
- `script-src https:` is the remaining hole: needed for V8's module loader to request the site's real
  URLs from the SW. Fix: refuse to run **any** page script until the SW controls the Worker (today
  only modules are gated), and re-check control on every `import()` / `importScripts` resolution
  failure; if control is ever lost, stop the segment (a crash page, not a silent host fetch).
  `navigator.serviceWorker.controller` is not visible in the Worker, so the check stays the nonce'd
  `hello.mjs` probe, repeated by the glue before each module graph load.
- Permissions-Policy is belt-and-braces: segments get no powerful features directly; anything the
  user grants is the carapace's prompt plus an engine-side capability.

**Layer 2, remove host API before page code, by deletion from the prototypes, not shadowing.** The
host script (`worker.js`) runs first and is the only code that ever holds host network/messaging
APIs. Today it captures, then shadows instance properties. It must instead:
1. Capture what the glue needs (as now) into the closure.
2. `delete` the members from where they actually live: `WorkerGlobalScope.prototype`
   (`fetch`, `importScripts`, `indexedDB`, `caches`, `onerror`...), `DedicatedWorkerGlobalScope.prototype`
   (`postMessage`, `close`, `onmessage`, `onmessageerror`, `requestAnimationFrame`...),
   `EventTarget.prototype` methods are kept but the global's `EventTarget` must be the mirror's.
   WebIDL members on prototypes are configurable (WebIDL "define the regular operations": `[[Configurable]]: true`),
   so `delete` works; `[LegacyUnforgeable]` members (none on worker globals except
   `self.location`-style ones; check) cannot be deleted and must be listed by a test.
3. Delete the host's interface objects from the global (`XMLHttpRequest`, `WebSocket`, `EventSource`,
   `WebTransport`, `Worker`, `SharedWorker`, `BroadcastChannel`, `WorkerGlobalScope`,
   `DedicatedWorkerGlobalScope`, `WorkerNavigator`, `WorkerLocation`, `IDBFactory` ...) and replace the
   ones the page should have with the mirror's (LibWeb's), which route through the engine. Host
   constructors still reachable through a surviving host object's `.constructor` are neutralised by
   deleting their prototype's dangerous methods too (e.g. `WebSocket.prototype.send` cannot be
   reached without a host `WebSocket` instance, and none can be created once the constructor is gone
   and CSP forbids the connect; but delete anyway).
4. Then walk: a boot-time self-check (`tests/escape-surface.mjs` run inside the Worker before page
   code) enumerates every own property of every object on the global's prototype chain and every
   interface object, against an allowlist, and refuses to start the page on any unknown host member.
   This turns "we forgot one" into a failed boot after a Chrome update rather than a leak.
5. Message intake (`onFirstMessage`) checks `e.isTrusted` and, after `init`, accepts nothing more on
   the global: the segment document hands everything over in the one `init` and the Worker removes
   its global listener. Input only ever arrives on the carapace's captured port.

Deleting vs unforgeable: the global itself (`self`) is not deletable and its prototype is immutable
(`DedicatedWorkerGlobalScope` has an immutable prototype exotic object), which is why phase2.md 2.4
mirrors the Window onto the instance; nothing here needs `[LegacyUnforgeable]` tricks. Members we
*add* for the page (the Window surface) stay configurable like Chrome's Window members.

**Layer 3, storage the page must not read.** Cookies (HttpOnly ones included) are never stored in the segment origin: the
carapace keeps them, AES-GCM at rest (docs/cookies.md, built in M4). The engine's other persisted state
(HSTS, TLS session tickets) is to be encrypted before it reaches the segment's IndexedDB,
with an AES-GCM key the **carapace** holds per segment identity and sends in `init` (captured, imported
as a non-extractable `CryptoKey` in the closure, never stored in the segment origin). The carapace
also keeps a version counter so a page cannot roll the blob back to an older session. Page JS can
still delete or corrupt the blob: the effect is "cookies cleared" for its own site, which a site's JS
can nearly do in Chrome anyway (overwriting non-HttpOnly cookies; it cannot clear HttpOnly ones,
listed as a known difference).

**Layer 4, identity separation by origin.** A segment origin is `<hash(site, identity)>.chitin-sites.net`
where `identity` is a per-mode, per-Molt random salt the carapace keeps. Tor mode and normal mode of
the same site get different origins; Molt changes the salt, so the old origin's IndexedDB, caches,
HTTP cache, BroadcastChannel and locks are simply unreachable (and the carapace clears the old
origin's storage via `Clear-Site-Data` on a navigation to it, best effort). This needs a wildcard
host, which the static segment host already is.

**Is a realm or Worker split needed?** No, and it would not help:
- A second Worker for page JS breaks synchronous bindings (the whole point; split-engine research).
- A second realm in the same Worker does not exist for us: Workers cannot create iframes, and
  ShadowRealm is at TC39 stage 2.7 with no shipping browser
  (https://github.com/tc39/proposal-shadowrealm, Mozilla's open bug
  https://bugzilla.mozilla.org/show_bug.cgi?id=1566145). Even shipped, its callable boundary only
  passes primitives and callables, which cannot carry DOM wrappers by identity.
- The protection a split realm would give (page cannot touch glue intrinsics) is what captured
  primordials give, the same technique Node.js core relies on against user code
  (lib/internal/per_context/primordials.js). The line that actually matters is the process/origin,
  and we have it.

## 2. "JS can escape the worker and mess with your browser IPC"

**Verdict: right about today's harness (two concrete bugs, below); the design answer is that the
carapace and Spiracle treat every segment as already compromised, so "escaping" the Worker into the
segment process buys attacker B only what the segment's ports allow.**

### 2.1 Every channel

| # | Channel | Direction | Carries | Created / captured |
|---|---|---|---|---|
| 1 | carapace window → segment document `postMessage(init, SEGMENT, [port2, netPort2, canvas])` | C→S | init, the two ports, OffscreenCanvas | carapace checks `e.origin === SEGMENT && e.source === iframe.contentWindow` on `segment-ready` |
| 2 | segment document → carapace `window.parent.postMessage({segment-status|segment-ready}, CARAPACE)` | S→C | status text | targetOrigin pinned |
| 3 | carapace ↔ Worker MessagePort (`port`) | both | frame ticks and input C→S; frames (ImageBitmap), `status`, `ready`, `navigated{url,status,error}` S→C | port2 transferred through the document into the Worker; captured in the closure |
| 4 | Spiracle ↔ Worker MessagePort (`netPort`) | both | `connect{s,host,port}`, `data{s,b}`, `close{s}`; `open`, `data`, `close{code,reason}` back | Spiracle registers it under the segment name |
| 5 | carapace → Spiracle Worker `postMessage` | C→N | `config{url,token}`, `segment{name}` + port | carapace only |
| 6 | segment document ↔ Worker (Worker global message events) | both | `init`, `sw-port`, `direct-input`; Worker errors | **the global's own message event: reachable by page JS** |
| 7 | segment document ↔ segment SW (`engine-port` + nonce; `need-port`) | both | a MessagePort to the engine | SW keeps `nonce → port` |
| 8 | SW ↔ Worker port (`swPort`) | both | `fetch{id,url}` → engine bytes; `stage{url,...}` | |
| 9 | Spiracle ↔ relay (Wisp over wss / WebTransport) | network | Wisp frames with the token; TLS records from the engine inside | carapace origin; relay checks Origin and token |
| 10 | Tor (Arti in Spiracle) ↔ guards via relay | network | Tor cells | |

### 2.2 Bugs in the harness today
- **Channel 6 is forgeable and listenable by page JS** (section 1.1): synthetic `direct-input` is
  trusted input; synthetic `init`/`sw-port` re-run boot with page-chosen ports. Fix: `isTrusted`, one
  `init`, remove the global listener, no `direct-input` on the global (comparison mode only, behind a
  harness flag).
- **`navigated{url}` sets the address bar** (carapace.js `address.value = m.url`). A compromised
  segment can show any URL, e.g. `https://bank.example`, while rendering its own pixels: address-bar
  spoofing, the one thing a browser's chrome exists to prevent. Fix: the carapace owns the displayed
  origin. The segment origin is derived from `hash(site, identity)`, so the carapace knows which site a
  segment is; it accepts `navigated` only if `registrableDomain(url) === segment.site`, and a
  cross-site navigation is a request (`navigate-request{url}`) the carapace performs by creating or
  switching to the other site's segment. Path and query within the site may come from the segment
  (Chrome shows whatever the site's own JS sets with `pushState` too).
- **Spiracle connects any host on 80/443** for any segment: a compromised segment is a TCP client to
  the whole web from the relay's IP (it cannot reach private ranges, the relay checks resolved
  addresses). That is attacker A's power minus CORS: page JS in Chrome can *send* to any host but not
  *read* cross-origin responses; with raw TCP and its own TLS, attacker B reads them, without
  cookies (the engine's jar for other sites is not in this process if 2.4 holds). Equivalent to
  running `curl` from the relay: an operator concern (rate and stream limits per segment, already in
  the relay's policy model), not a user-data one.

### 2.3 Capability design
- **Ports are capabilities, captured before page code.** The only things a segment holds are: its
  carapace port (render + input + navigation requests), its net port (streams), its SW port. No
  global listeners after `init`. The relay token, Tor state and history never enter a segment.
- **Every segment message is hostile at the receiver.** Carapace and Spiracle parse each message
  through a schema: an allowlist of `type`s, exact field types (`s` a uint32 below a per-segment cap,
  `host` a hostname or IP literal ≤ 253 chars, `port` in the allowlist, `b` an ArrayBuffer ≤ 1 MiB,
  `url` a string ≤ 8 KiB that parses), no extra fields used, transferables of the expected kind only
  (an ImageBitmap for frames, nothing else). Unknown → drop and count; a count above a threshold
  kills the segment ("this site misbehaved", reload offered).
- **Per-site scoping.** Spiracle keys state by the port object, not by a name in a message; the name
  comes only from the carapace. Stream ids are per port, so a segment cannot name another's streams.
  Tor isolation tokens are per segment identity, assigned by the carapace.
- **Rate and resource limits** per segment: streams open (e.g. 256), connect rate, bytes/s, frame
  size and rate (frames larger than the viewport are dropped), status message rate (the panel is a
  harness thing; production has no `status`).
- **Replay/forgery.** MessagePorts are unforgeable object capabilities: a message on port P can only
  come from whoever holds P's twin, and ports cannot be guessed. So there is nothing to sign; the
  "forgery" risk is only on window `postMessage` (channels 1, 2), which check `origin` and `source`.
  Replay of an old `navigated` is harmless once the carapace derives the displayed site itself.
- **No ambient authority in the segment document.** It has no DOM worth stealing and no listener
  that acts on Worker messages except error reporting.
- **Permissions** (camera, notifications, downloads, clipboard) are requests on the carapace port;
  the prompt names the site the carapace knows, not one the segment claims.
- **Frames**: the carapace draws segment pixels only inside the tab content box, never over its own
  chrome or prompts (pixels cannot fake the address bar if the bar is never covered).

### 2.4 Cross-site iframes
A page that embeds `<iframe src=https://other.example>` today would be rendered by the same engine in
the same process. Then site A's JS (with a glue bug) or its Spectre timers read B's DOM and B's
partitioned cookies. Chrome puts B in another process. Design: cross-site subframes become their own
nested segment (B's segment origin, as an `<iframe>` inside A's segment document, or a sibling
composited by the carapace), with layout/paint of B's box delegated over a port (phase 4 item,
listed below). Built in M5 as a nested segment created by the carapace, composited over the parent's box;
the design, the postMessage origin checks and what the carapace validates are in docs/architecture.md
"Nested segments". The parent's engine never loads B (its iframe stays `about:blank`).

### 2.5 Worst case for a fully compromised segment (attacker B)
It can: do anything with **its own site** that the user could (its cookies, including HttpOnly, its
storage, its open connections, what it renders), lie in its own pixels inside the content box, open
TCP to any public host on 80/443 from the relay's IP within the per-segment limits, burn CPU/GPU/memory
in its process, ask for permissions (the carapace prompts with the true site). It cannot: learn the
user's IP (no host network; CSP; no WebRTC), reach other sites' data or segments, read the relay
token or Tor state, spoof the address bar or prompts, link a Tor identity to a normal one, or persist
past a Molt. A further host-browser sandbox escape is the host's problem and out of scope.

## 3. "Or just reject you silently (Turnstile)"

**Verdict: largely right, and it cannot be fully fixed.** Some signals we can match (the JS surface,
the TLS ClientHello); some we cannot change (relay/Tor IP reputation, the Worker execution model
showing through timing). The honest product answer is detection plus a one-click "open in your own
browser".

### 3.1 How the challengers decide (public material only)
- Cloudflare documents Turnstile's managed mode as using "information from the visitor" and running
  non-interactive challenges in the browser, with an "outdated or unsupported browser" failure state
  (https://developers.cloudflare.com/turnstile/concepts/widget/). Cloudflare's Bot Management exposes
  JA3/JA4 TLS fingerprints as scoring inputs (https://developers.cloudflare.com/bots/additional-configurations/ja3-ja4-fingerprint/).
- Third-party write-ups (secondary, treat as indicative): Turnstile and Cloudflare bot scoring
  combine TLS fingerprint consistency with the claimed User-Agent, HTTP/2 settings and frame order,
  canvas/WebGL/audio hashes, automation markers, IP type/ASN reputation, behaviour (pointer, keys),
  and a proof-of-work (https://scrapfly.io/blog/posts/how-cloudflare-detects-bots,
  https://blog.send.win/how-to-check-how-turnstile-captcha-detects-bots/).
- JA4 is `protocol, TLS version, SNI, cipher count, extension count, ALPN` + a hash of sorted ciphers
  + a hash of sorted extensions and the signature algorithms in order
  (https://github.com/FoxIO-LLC/ja4/blob/main/technical_details/JA4.md). Chrome randomises extension
  order, which JA4's sorting neutralises; JA3 is useless against Chrome for that reason.
- reCAPTCHA v3/Enterprise and hCaptcha run obfuscated VMs in the page that probe the same classes of
  signal plus Google/hCaptcha account and cookie history; Akamai Bot Manager additionally scores the
  HTTP/2 fingerprint (SETTINGS values, WINDOW_UPDATE, pseudo-header order; Akamai's own paper on
  passive HTTP/2 fingerprinting, Black Hat EU 2017).

### 3.2 Where Chitin differs from Chrome, and whether it can be matched

| Signal | Differs today | Matchable? | How / milestone |
|---|---|---|---|
| Global object shape: `self instanceof Window`, `Object.getPrototypeOf(window)`, `WorkerGlobalScope` present, `importScripts` | yes (phase2.md 2.4 lists the two untruths) | mostly; the two prototype untruths no | M5 diff + layer-2 deletion of worker-only names; the prototype chain is a permanent tell |
| Missing/extra APIs (WebRTC, `document.*` long tail, `navigator.userAgentData`, `chrome.*`, `Notification`, `speechSynthesis`, plugins/mimeTypes) | yes | yes, by implementing or stubbing with Chrome's shapes | M5 surface diff; challengers probe exactly these |
| `Function.prototype.toString` of bindings | done (native text) | yes | M1/M5 |
| `Error.stack`, `prepareStackTrace` CallSites | glue + wasm frames show | nearly (section 4) | new M6 |
| Error messages | LibWeb's text | yes, family by family | M5 |
| Timing: main thread is a Worker, rAF driven by carapace ticks, layout costs in wasm, event dispatch latency, `performance.now` resolution | yes | partially: resolution and rAF cadence yes; absolute costs no | M5 measure against Chrome; accept |
| Canvas 2D / WebGL / WebGPU fingerprints | uses the host's own OffscreenCanvas (same GPU, same driver): close to the user's real Chrome | mostly yes for page canvases; text rendering through our fonts differs (engine fonts vs system fonts in `measureText`, font list probes) | ship font metrics that match common Chrome-on-OS; accept residue |
| `navigator.userAgent` / `userAgentData` / Client Hints | must claim the host Chrome's UA | yes (copy the host's from the carapace) | M5 |
| TLS ClientHello (JA4) of the engine's wasm TLS | differs (whatever our TLS library sends) | **yes**: we control every byte. Replicate Chrome's current ClientHello: cipher list, extension set incl. GREASE, X25519MLKEM768 key share, ALPS, compressed certs (brotli), extension order shuffle, ECH GREASE, record-size limit. Same discipline as uTLS (https://github.com/refraction-networking/utls). Must track Chrome releases | new item in M5 (network) |
| HTTP/2 fingerprint (SETTINGS, window, priority frames, pseudo-header order `:method :authority :scheme :path`), header order and casing, `sec-ch-ua*`, `sec-fetch-*` | differs (LibWeb/our stack) | yes, same way | M5 network |
| HTTP/3/QUIC | we do not offer it | can omit (Chrome falls back on TCP too) | later |
| IP reputation: relay egress (datacenter ASN) | yes, inherently | **no** | the operator can run the relay on a residential line; document it |
| Tor exit IP | yes, publicly listed | **no**; many sites block or challenge Tor by policy | expected; fallback |
| Behaviour (pointer paths, key timing) | input is the user's own, forwarded with timestamps | yes, if we pass coalesced events and real timestamps and do not quantise | M2/M5 input |
| Cookie/account history (reCAPTCHA) | segments start empty; Molt wipes | no, by design | fallback |

Mismatch is the sharpest signal: a Chrome UA with a non-Chrome JA4 is flagged immediately. So the
order is: UA honesty first (claim exactly the host's Chrome), then TLS + HTTP/2 to match that version,
then the JS surface. A segment that cannot match a version should claim nothing it cannot back.

### 3.3 Detecting a silent rejection
Silent rejection usually looks like: a challenge page that never resolves (Cloudflare "Just a moment"
interstitial looping, `cf-mitigated: challenge` response header, HTTP 403/429/503 with `server:
cloudflare` and a `cf-ray`), a Turnstile widget reaching its "unsupported browser" or timeout state,
a reCAPTCHA token the site's backend rejects (visible only as the form failing), Akamai `_abck`
cookie never validating (403 with a reference id). The engine sees all of these in its own network
stack and DOM, so detection is engine-side, not interception:
- response-level: `cf-mitigated: challenge`, repeated challenge-page bodies for the same URL, 403/429
  from known bot-management servers;
- DOM-level: the known challenge iframes/widgets present for more than N seconds without progress, or
  reloading in a loop;
- the user's own signal: a "this site isn't working" button.

User-facing fallback: a bar "This site may be blocking Chitin. Open in your browser" which opens the
URL with `window.open` from the carapace into the user's own browser (a normal top-level tab: their
IP, their cookies, explicitly said so, and in Tor mode a warning that this leaves Tor). Never a proxy,
never solving the challenge for them. A per-site "always open in my browser" preference.

## 4. "At some point you'll need interception to rewrite JS APIs like Error.stack"

**Verdict: wrong about interception, right that it is work.** Network interception (rewriting script
bytes, a SW that edits responses) stays ruled out. What these APIs need is in-realm API shaping: the
glue defines members in the page's own realm before page code runs, exactly as the mirror already
does for every DOM binding and `Function.prototype.toString`. A browser's bindings are "API shaping"
by definition. The only bytes we add to a script are the owner-approved `//# sourceURL=` line (plus,
proposed below, leading newlines), which the page never sees (its `script.text` and SRI use the
engine's untouched copy).

### 4.1 Where glue frames come from
1. A binding call: page frame → mirror function (glue) → `invoke` (glue) → wasm frames → back.
2. A callback: wasm (event dispatch, timers, observers, promise jobs from the engine) → glue
   trampoline → the page's listener. Chrome shows only the listener frame (dispatch is native).
3. Script evaluation: `ganglion_host_js_run_script` → `indirectEval(source + sourceURL)`: the frame
   is an eval frame (`isEval() === true`, `getEvalOrigin()` names the glue), and its top-level frame
   prints as `at eval (https://site/a.js:1:1)` where Chrome prints `at https://site/a.js:1:1`.

**Done 2026-10-21 (item 5):** the glue's `ganglion_host_js_run_script` calls the host's `options.runScript(source, filename, lineOffset)` (Worker: `runScript` in harness/segment/worker.js, importScripts of a staged synthetic URL with `lineOffset-1` newlines and the sourceURL line; Node tests: `vm.Script`). Limits: a realm cannot forget the previous document's global lexical bindings, so after an in-engine navigation a colliding script runs as an eval and non-configurable vars are blanked, not deleted (a fresh Worker per document is the real fix); column offsets of the first line of an inline script are not padded.

Item 3 also has a semantic bug beyond stacks: indirect `eval` is not script evaluation. Top-level
`let`/`const`/`class` of an eval live in a fresh declarative environment (ECMA-262
EvalDeclarationInstantiation), so `let x` in one `<script>` is invisible to the next; and `var`s are
configurable (the reset code in 40-bridge.js already notes the latter). Fix this first: evaluate
classic scripts as real scripts with `importScripts` of a URL the segment's SW answers with the
engine's bytes plus the sourceURL line (worker.js already has an `importScripts` mode that stages
bytes in the SW). `importScripts` runs global code in the Worker's global scope: shared lexical
environment, non-configurable `var`s, no eval frame. Inline scripts get a synthetic SW URL and a
sourceURL of the document URL; to match Chrome's line numbers (Chrome reports inline-script frames at
the HTML document's line), prepend `lineOffset - 1` newlines (the host import already receives
`lineOffset`, unused) and pad the first line by the column. V8 then reports `https://site/page.html:42:7`
as Chrome does.

### 4.2 The stack shaper
- **Prevention first.** Errors the glue throws for a binding (brand checks, argument errors, mapped
  LibWeb exceptions) are created with `Error.captureStackTrace(err, mirrorFunction)` (captured
  primordial), which omits the mirror function's frame and every frame above it (V8 stack trace API,
  https://v8.dev/docs/stack-trace-api). That covers case 1 entirely, with no hook.
- **Case 2 and errors the page creates while glue frames are below it** need formatting control. V8
  calls `Error.prepareStackTrace(error, callSites)` when `stack` is first read, looked up on the
  realm's intrinsic `%Error%`. The glue installs an **accessor** `prepareStackTrace` on `Error` that
  stores the page's value (`undefined` by default) and is otherwise invisible to it, and a formatter
  that:
  1. drops CallSites whose `getFileName()` is a glue/engine URL or that are wasm frames of the
     engine module (`getScriptNameOrSourceURL`, `isWasm`), and the trampoline frames;
  2. wraps the rest so `isEval()` is false, `getEvalOrigin()` undefined and `getTypeName/
     getFunctionName` of mirror frames read as Chrome's (`HTMLElement.get innerHTML` style) for the
     few binding frames that remain visible (Chrome shows none for native bindings, so in practice
     all mirror frames are dropped);
  3. if the page set its own `prepareStackTrace`, calls it with the filtered CallSites; otherwise
     produces V8's default text (`${error}\n    at ...`) from them, matching V8's formatting rules
     (constructor/method/`async`/`new` prefixes, `<anonymous>`), tested against V8's own output.
  4. honours `Error.stackTraceLimit` as the page set it: the glue raises the internal limit by the
     number of frames it expects to drop (bounded) and truncates to the page's limit after
     filtering, so the page sees exactly N site frames.
- `Error.captureStackTrace` called by the page goes through the same formatter (V8 uses the same
  path). `new Error().stack` getter identity, `Object.getOwnPropertyDescriptor(err, 'stack')` shape
  (V8: an own accessor pair since 2023; check against the host version) stay V8's own.
- **The residue that cannot be hidden:** `Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')`
  and `'prepareStackTrace' in Error` report a property that Chrome does not have until the page
  sets one. Reflection on the descriptor can be shaped (patching `Object.getOwnPropertyDescriptor`,
  `Reflect.getOwnPropertyDescriptor`, `Object.getOwnPropertyNames`, `Reflect.ownKeys`,
  `Object.prototype.hasOwnProperty`, `Object.hasOwn` to lie about one key is possible, though each
  patched function is itself one more thing to keep native-looking), but the `in` operator cannot be
  shaped at all. Least-bad: install the accessor, shape
  `getOwnPropertyNames/ownKeys/hasOwn/getOwnPropertyDescriptor(s)` for that one key on `Error` only,
  accept `in` as a documented tell. The alternative (no hook) leaves glue frames in every listener's
  stack, which is the far more common probe (stack-depth and file-name checks are standard in bot
  scripts). Measure with the M5 diff which challengers check which.
- Nothing here needs script-byte rewriting.

### 4.3 Other APIs that need the same shaping
- **`performance` timing**: `performance.now`/`timeOrigin` must be the document's (navigation start),
  not the Worker's; `performance.getEntries*` and `PerformanceObserver` must list the engine's resource
  timings for the site's URLs (never the SW/glue fetches of our own files, never `/chitin/*.wasm`);
  `performance.memory` (Chrome-only) must not reveal the wasm heap. The host's `performance` is
  replaced by the mirror's (already in WINDOW_OVERRIDES) and the host's entries are never exposed.
- **`document.currentScript`**: the engine's, set by LibWeb's run-a-classic-script steps (the
  importScripts path above keeps it correct since the engine still drives execution).
- **`import.meta.url`**: real URLs, because the SW answers the Worker's request for the real URL and
  Fetch keeps the request's URL list (sw.js header). `import.meta.resolve` likewise. Import maps are
  the engine's, resolved before V8 sees a specifier.
- **CSP of the site**: the site's own CSP must be enforced by the engine (script-src checks before it
  hands a script to V8, `eval`/`new Function`/string timers checked against the site's
  `unsafe-eval` — the glue wraps `eval`, `Function`, `AsyncFunction`, `GeneratorFunction` constructors
  and string `setTimeout` as Chrome's bindings would enforce them), and `securitypolicyviolation`
  events and reports must come from the engine with the site's URLs, never the segment Worker's own
  CSP violations (those are ours: we capture `securitypolicyviolation` on the host before page code
  and drop them so the page never sees a violation of a policy it did not set).
- **Workers the page spawns** (`new Worker(url)`, `SharedWorker`, `Worklet`s): there are no host
  Workers for the page (CSP `worker-src 'none'`). A page Worker becomes a second engine-less V8 Worker
  on the segment origin, created by the host script with the same layered containment, its script
  bytes delivered by the SW, its network through the segment's net port (a port the glue hands it),
  and its `self` shaped as a DedicatedWorkerGlobalScope (here the global really is one). Same for
  module workers. Service workers registered by the site: emulated inside the engine (they intercept
  the engine's own fetches), never registered with the host.
- **iframes**: same-site iframes are more documents in the same engine; each needs its own realm,
  which a Worker cannot create. Options: shared global with per-document shaping (wrong for globals),
  or one Worker per same-site browsing context with `SharedArrayBuffer` + `Atomics.wait` for the
  synchronous `contentWindow` access (bindings-and-gc.md "nested event loops" machinery). Cross-site:
  nested segments (2.4).
- **`location`, `document.URL`, `document.referrer`, `origin`, `isSecureContext`,
  `crossOriginIsolated`**: the engine's values, never the segment origin's (`self.origin` would say
  `https://<hash>.chitin-sites.net`). `crossOriginIsolated` should report what the site's own headers
  would earn in Chrome, not our DIP state (SAB is then gated per the site's COOP/COEP; we delete
  `SharedArrayBuffer` from the global when the site is not isolated, after capturing it). Done on branch `coi`
  (docs/user-tests/coi.md): the engine computes isolation from the document's COOP/COEP (patch 0070), page Workers
  follow their owner and their own COEP, and shared memory is refused in clones and posts when not isolated. A cross-site
  frame's isolation is what its parent segment claims for it (`subframes` coi field): a compromised parent can only
  give its child SharedArrayBuffer and 5 µs timers in the child's own segment, which is already isolated (DIP), so
  nothing crosses a process boundary.
- **`Error.stack` inside `console`**: no DevTools in the segment; the carapace's DevTools later shows
  the shaped stacks.

### 4.4 Does anything need script-byte rewriting?
No item above does. The two places where bytes differ from what was served are the appended
`sourceURL` line and the proposed leading newlines, both invisible to the page's own view of the
script. If a case appears that only rewriting could fix (e.g. a V8 behaviour keyed to the eval-ness
of code we cannot avoid), the least-bad option is still not rewriting: accept the difference, list it
in the surface diff, and send that site to the user's own browser.

## 5. Ranked work list

| Rank | Item | Guarantee | Milestone |
|---|---|---|---|
| 1 | Delete host network/messaging/storage members from the global's **prototypes** and interface objects; boot-time allowlist self-check refuses to start on unknown host members | user IP (1), carapace (3) | M2 (before any real site runs JS with the network on) |
| 2 | Worker message intake: `isTrusted`, single `init`, remove global listener; `direct-input` only behind a harness flag | trusted input, port integrity | M2 |
| 3 | Fail-closed script loading: no page script before SW control; re-probe before each module graph; stop the segment on lost control. Production Worker CSP (`connect-src 'self'` static-only host, `worker-src 'none'`, the rest `'none'`); Permissions-Policy on the segment document | user IP | M2 |
| 4 | Carapace owns the displayed site: segment origin = hash(site, identity); `navigated` accepted only within the site; cross-site navigation as a request | address bar | M2 |
| 5 | Classic scripts as real scripts (importScripts via SW, shared lexical scope), inline line offsets | correctness, stacks | M2 (Wikipedia's ResourceLoader relies on cross-script globals) |
| 6 | Schema validation + per-segment limits on every carapace/Spiracle receiver; misbehaviour counter kills the segment | IPC | M2 (carapace) / phase 3 (Spiracle) |
| 7 | Encrypted engine persistence with a carapace-held key and version counter; HttpOnly never readable by page JS | site secrets (4) | M4 (with the jar) |
| 8 | Identity-salted segment origins: Tor vs normal, Molt rotates; Tor isolation token per identity | Tor unlinkability | phase 3 (Tor mode); origin scheme lands with item 4 |
| 9 | UA honesty + Chrome-matching TLS ClientHello (JA4) and HTTP/2 fingerprint, tracked per Chrome release | challenge pass rate | new **M5n** (network side of M5) |
| 10 | Silent-rejection detector + "open in your browser" bar + per-site preference | user can always proceed | M5 |
| 11 | Stack shaper: captureStackTrace on glue throws, prepareStackTrace accessor + formatter, stackTraceLimit; performance entries, `origin`/`crossOriginIsolated`/SAB per the site's headers | Chrome-identical surface | new **M6: shaped surfaces** (after M5's diff says which matter) |
| 12 | Site CSP enforced by the engine; string-code constructors checked; our own CSP violations swallowed | site's security model | M6 |
| 13 | Page-spawned Workers as contained engine-less Workers on the segment origin | correctness + containment | M6 |
| 14 | Cross-site iframes as nested segments (until then: no script, no B cookies). Moved up 2026-10-21 (owner): challenge widgets (Turnstile, reCAPTCHA, hCaptcha) are cross-site iframes, so without this no captcha can even appear. Goal: the user sees and solves the challenge; Chitin never solves or bypasses one. Test: a solvable-captcha matrix (widget appears, user can complete it, the site accepts the token) | other sites' data (2), sites usable | **M5** (was phase 4) |

## 6. Tests that prove each guarantee

All as stand-in sites under `harness/sites/` (Node runner) plus the owner's Chrome run
(docs/user-tests/), each asserting the attack fails and reporting the value it saw.

- **escape.example / host-network**: tries `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
  `WebTransport`, `importScripts`, `import('https://canary.<ours>/x.mjs')`, `new Worker`,
  `navigator.sendBeacon`, `RTCPeerConnection`, each through the global, through
  `Object.getPrototypeOf` chains, through `constructor` of any reachable host object, and through
  `Function('return this')()`. Pass: every attempt throws or is absent; the canary server (a separate
  origin on the test host) logs **zero** requests from the host network; requests that should succeed
  arrive only via the relay (relay log shows them). Run with the SW deliberately unregistered and
  with a hard reload: the page must not run at all.
- **escape.example / surface-allowlist**: dumps every own key of the global's prototype chain and the
  host interface objects; diff against the allowlist; any unknown host member fails.
- **forge.example / ports**: `self.dispatchEvent(new MessageEvent('message', {data: {type: 'direct-input', ...}}))`,
  then `{type: 'init', ports: [own]}`, `{type: 'sw-port'}`; `DedicatedWorkerGlobalScope.prototype.postMessage.call(self, ...)`.
  Pass: no engine input, no user activation (`navigator.userActivation.isActive` false,
  `window.open` blocked), ports unchanged (frames still reach the carapace), nothing reaches the
  segment document.
- **spoof.example / address-bar**: a test-only compromised segment build (a flag that lets page JS
  post raw carapace messages) sends `navigated{url:'https://bank.example/'}`, oversized frames,
  malformed stream ids, 10k connects/s. Pass: address bar shows the true site, frames dropped,
  streams capped, segment killed past the threshold, carapace responsive.
- **cookies.example / httponly**: sets an HttpOnly cookie; page JS opens every IndexedDB database of
  its origin (`indexedDB.databases()` via the host prototype), reads `caches`, scans storage. Pass:
  the cookie value never appears in plaintext; a rolled-back blob is rejected.
- **link.example / identities**: same site in a normal and a Tor tab; BroadcastChannel, IndexedDB,
  locks, HTTP cache timing probe between them; then Molt and repeat. Pass: no shared state.
- **stack.example / stacks**: `new Error().stack` in top-level script, in a listener, in a timer, in a
  MutationObserver callback, in a promise job, inside a binding error (`document.createElement(' ')`),
  with and without a page `prepareStackTrace`, with `stackTraceLimit` 0/1/3/Infinity; CallSite
  `getFileName`/`isEval`/`getEvalOrigin`/`getFunction`. Pass: byte-identical to the same page in the
  owner's Chrome (diffed by tests/surface-diff.mjs), except the documented `in Error` tell.
- **scripts.example / lexical**: script 1 `let a = 1; class B {}`, script 2 reads `a` and `B`; `var v`
  then `delete self.v` is false; inline script error line numbers equal Chrome's.
- **timing.example**: `performance.now` resolution, `timeOrigin`, `getEntriesByType('resource')`
  lists only site URLs, rAF cadence vs the display.
- **ja4 test**: the relay (test mode) records the ClientHello and HTTP/2 SETTINGS of the engine's
  connection to a local TLS server; compare JA4 and the Akamai-style HTTP/2 fingerprint to Chrome's
  of the same version, captured by the same server.
- **challenge matrix (owner run)**: a list of public pages with Turnstile (Cloudflare's demo page),
  reCAPTCHA v2/v3 demos, hCaptcha demo, an Akamai-fronted site; through relay and through Tor; record
  pass / interactive / silent-fail, and that the detector fires on every silent fail.

## 7. Fuzzing, 2026-10 (branch `secfuzz`)

Our own code that takes untrusted input, attacked with generated input (all runs time-boxed and niced). Severity is for
Chitin's threat model (section 0): a page or a site attacking its own segment is low unless it reaches another site, the
carapace or the host.

| ID | Where | Finding | Severity | Status |
|---|---|---|---|---|
| R1 | relay/relay.py `serve` | A request head past the stream limit raised `LimitOverrunError`, which was not caught: one traceback in the relay's log per such connection (log flooding by any client) | Low | Fixed, test `secfuzz R1` |
| R2 | relay/relay.py `serve` | `Sec-WebSocket-Protocol` was echoed into the 101 unchecked; the request is split on CRLF only, so a bare LF in it became a header line of the relay's response (response header injection, reachable by a non-browser client against itself) | Low | Fixed: token list only, else 400; test `secfuzz R2` |
| R3 | relay/relay.py `read_message` | A ping between the fragments of a message threw away the fragments before it (the session then closed on "continuation without a start"); control frames over 125 bytes or without FIN, and frames with RSV bits, were accepted (RFC 6455 5.2, 5.5) | Low | Fixed, test `secfuzz R3` |
| B1 | glue/engine/40-bridge.js `buildClone`, `readClone` | `structuredClone(new Array(2 ** 32 - 1))` (or history state, postMessage) walked the length index by index both ways: the segment hung for minutes (40 s cap hit) | Low (own segment) | Fixed: arrays longer than 65536 go by own keys; test `secfuzz B1` |
| B2 | glue/engine/40-bridge.js `keyBits`, all `ganglion_key_index` callers | LibJS on wasm32 keeps an index as a number key only up to 2 ** 30 - 1 (`MAX_NUMBER_KEY_INDEX`); the bridge made number keys up to 2 ** 32 - 2, whose bits wrapped to `i mod 2 ** 30`: `childNodes[2 ** 30]` read `childNodes[0]`, a cloned `a[2 ** 30 + 5]` landed on `a[5]` | Medium (property aliasing across the page/engine boundary; wrong element read or written) | Fixed in the glue (`indexKey`); test `secfuzz B2`. Open: C++ `Key::from_index` (engine/libjs-runtime Runtime.h) has the same wrap and is reached only with internal, small indices; give it the same guard when Bridge.cpp is next rebuilt |
| B3 | glue/engine/40-bridge.js `makeNativeFunction` | An options object's `transfer` getter was read three times (buffer check, stream moves, engine): it could hand each a different list, so the buffers checked and detached were not the ones transferred | Low | Fixed: read once (`snapshotTransfer`); test `secfuzz B3` |
| B4 | 40-bridge.js clone, conformance only | A Proxy is cloned (Chrome: DataCloneError); a detached ArrayBuffer throws TypeError (Chrome: DataCloneError); a view whose buffer grew during the clone throws RangeError on read-back. None reads memory out of bounds: views are rebuilt by the host's constructors, which check bounds | Info | Open |
| N1 | engine/platform/Network.cpp `on_plaintext` (chunked) | Each chunk does `c.rx.remove(0, n)` (a memmove of the rest): a response of many tiny chunks in one read is quadratic in CPU; the CRLF after chunk data is skipped without being checked (Chrome refuses the response) | Low (a site can burn its own segment's CPU anyway) | Open (found by review; needs an engine rebuild to fix) |
| C0 | glue/cookies.js, harness/carapace/cookie-store.mjs | Property test: 3000 generated jars x 6 Set-Cookie lines (prefixes, Domain on public suffixes and IPs, Partitioned, SameSite, Max-Age overflow, controls). Every change a jar reports is accepted by `checkRecord` and is within `CookieStore.entitled` for that segment; no HttpOnly reaches script | none found | `tests/cookies-fuzz.test.mjs` |
| S0 | harness/segment/specifiers.js | Differential: generated modules (real `import()` / `import.meta.resolve` mixed with look-alikes in strings, templates, regexps, comments, methods, line continuations, U+2028) run in V8 before and after the transform: same values, same modules except remapped ones, same line for every token | none found | `tests/specifiers-fuzz.test.mjs` |

Tools: `tools/secfuzz/bridge-probes.mjs` + `probe.sh` (one adversarial clone value per capped Node process). The Wisp fuzzer
client used for R1-R3 drove random/mutated handshakes, frames (fragments, interleaved pings, unmasked, RSV, bogus 64-bit
lengths) and Wisp packets (CONNECT to private/odd hosts, DATA floods, unknown types) against a local relay for 100 s with no
traceback and flat RSS after the fixes.

Not done this round: native libFuzzer/ASan harnesses for engine/platform (no host build of AK/LibWeb exists here; a host
Lagom build is hours) and Ladybird's own fuzzers (now `Meta/Fuzzers` in ladybird-src, same host-build need). `@rvwasm/wisp`
(rvwasm-packages) was reviewed for R1-R3: its FrameParser already refuses bad control frames and RSV bits, and Node's HTTP
parser refuses a bare LF in a header, so nothing was changed there.

## Sources
- V8 stack trace API: https://v8.dev/docs/stack-trace-api
- Chromium Site Isolation: https://www.chromium.org/Home/chromium-security/site-isolation/
- Document-Isolation-Policy: https://developer.chrome.com/blog/document-isolation-policy, https://http.dev/document-isolation-policy
- CSP3 for workers: https://w3c.github.io/webappsec-csp/#initialize-global-object-csp
- Permissions Policy: https://www.w3.org/TR/permissions-policy/
- ShadowRealm: https://github.com/tc39/proposal-shadowrealm, https://bugzilla.mozilla.org/show_bug.cgi?id=1566145
- ServiceWorker in dedicated workers: https://developer.mozilla.org/en-US/docs/Web/API/WorkerNavigator/serviceWorker, https://chromium.googlesource.com/chromium/src/+/d0a55527d2400a0a2a778af6af07c60b9d50e3ec
- Turnstile widget modes and errors: https://developers.cloudflare.com/turnstile/concepts/widget/
- Cloudflare JA3/JA4: https://developers.cloudflare.com/bots/additional-configurations/ja3-ja4-fingerprint/
- JA4 technical details: https://github.com/FoxIO-LLC/ja4/blob/main/technical_details/JA4.md
- uTLS (ClientHello mimicry): https://github.com/refraction-networking/utls
- Secondary write-ups on Cloudflare signals: https://scrapfly.io/blog/posts/how-cloudflare-detects-bots, https://blog.send.win/how-to-check-how-turnstile-captcha-detects-bots/
- Node.js primordials: https://github.com/nodejs/node/blob/main/lib/internal/per_context/primordials.js
