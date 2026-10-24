# The surface: what a page can see that says "not Chrome" or "Worker"

Status: 2026-10-22, M5a. Page JavaScript runs in a Worker's global with the
Window mirrored onto it (docs/phase2.md section 2); anti-bot and captcha scripts read that global closely
(docs/research/scramjet-lessons.md, item 1), and an escape or a mismatch shows them a Worker, which is how a proxy gets
caught. This page records how the difference is measured, what it was, what was fixed and what is left.

## The measurement

`make surface-diff` loads one page, `harness/sites/surface.example` (the same bytes), in two places and diffs what its
scripts find:

- **Chrome side**: Chrome for Testing 154 (the one `make chrome-test` uses), a top-level window at `http://localhost:<port>/`,
  served by a plain static server.
- **Chitin side**: the same page in a segment (`/?url=https://surface.example/`), where the page's code runs in the
  `chitin-segment` Worker through the engine and the mirror.

The page's scripts are real page scripts: an inline script, an external classic script (`early.js`), a module and
`walker.js`. The walker (`harness/sites/surface.example/walker.js`) does two things.

1. **Enumerates** the global and everything reachable from it, with `Object.getOwnPropertyDescriptor` and nothing cleverer:
   the global and its prototype chain (compared by position, a Window against a DedicatedWorkerGlobalScope), every interface
   object and its prototype chain (compared by name), and the instances behind the global's accessors (`navigator`,
   `location`, `performance`, `history`, `screen`, `chrome`, ...). For each property: data or accessor, writable/enumerable/
   configurable, the type of the value, and for a function: its name, length, whether `Function.prototype.toString` says
   `[native code]` (and the first 50 characters of the source when it does not), whether it owns a `prototype`, its own
   keys and its `[[Prototype]]`. Constants carry their value.
2. **Probes** behaviour: about 70 small named probes (the global's string and chain, `Atomics.wait`, `Error` statics and
   stacks in six places, `document.write` timing, `currentScript` and `import.meta.url`, requestAnimationFrame and
   requestIdleCallback, performance entries, navigator and screen values, `window.chrome`, canvas and WebGL, error events,
   message events, a data: `import()`), plus a **receiver check on every member**: each method, getter and setter of
   every interface is called with a plain object as `this` and the error is recorded (Chrome says `Illegal invocation`
   for all of them), and every interface object is called without `new`. Dialogs are probed one per page load
   (`dialogs.html`) because a `confirm()` that never returns blocks the page.

`tools/surface-diff/diff.mjs` classifies each difference and clusters those that have the same category and the same pair
of values (one root cause is one cluster). Categories, in the order they are ranked:

| category | meaning | counted as a tell |
|---|---|---|
| `probe` | a behaviour probe answers differently | yes |
| `extra-interface`, `extra-member` | Chitin has a name Chrome 154 has not | yes |
| `not-native` | a function whose `toString` shows source | yes |
| `brand-check` | a member answers a foreign `this` or a call without `new` differently | yes |
| `prototype-chain` | an object's chain differs | yes |
| `accessor-vs-data`, `descriptor`, `function-shape` | flags, kind, length, name, own keys, `prototype` differ | yes |
| `value` | a constant differs | yes |
| `missing-member`, `missing-interface` | Chrome has it, Chitin has not | no: a feature gap, listed, not a sign of a Worker |

`make surface-diff` writes `docs/results/surface-diff-<date>.json` (the counts and every cluster with its first keys and both
values, one cluster per line) and `build/surface/{chrome,chitin}.json` (the raw walks); `node tools/surface-diff/rediff.mjs
--cat brand-check --top 10` reads the last walks without a browser. `tools/surface-diff/eval.mjs 'expr' ...` evaluates
expressions on both sides while working on a tell.

Reading the counts: they are differences, not causes, and one cause can be thousands (every binding's receiver message).
Both are given below. The chosen Chrome is 154; a Chrome update moves the numbers and regenerates two data files (see
Maintenance).

## What it found, ranked

Baseline (the glue as of d9e4336, same walker): **7,487 differences, 6,101 of them tells, 1,056 distinct causes.** The ranking
by weight and then size:

1. **Binding error messages and stacks (5,667 differences, one cause).** Every engine-side type check threw `TypeError: Not
   an object of type Node` where Chrome says `Illegal invocation`, with `errorToJS`, `invoke` and `objectToJS` as the top
   frames of the stack. Argument errors read the same where Chrome says `Failed to execute 'appendChild' on 'Node': parameter
   1 is not of type 'Node'.`; missing arguments said `canParse() needs one argument` or `Overload resolution failed`.
2. **The global is a DedicatedWorkerGlobalScope.** `Object.prototype.toString.call(window)` was `[object
   DedicatedWorkerGlobalScope]`, `window.constructor.name` `WorkerGlobalScope`, the prototype chain `DedicatedWorkerGlobalScope >
   WorkerGlobalScope > EventTarget`, `Window.prototype` was not on the chain and 26 members sat on the scope prototypes where a
   Window has none.
3. **Interface objects were classes.** `Node()` threw V8's `Class constructors cannot be invoked without 'new'` (290
   interfaces); Chrome throws `Illegal constructor` or `Failed to construct 'X': Please use the 'new' operator...`, and
   `new Node()` is `Failed to construct 'Node': Illegal constructor`.
4. **`confirm()`, `prompt()`, `alert()` blocked the page forever** (and `print` was `undefined`). The engine waits for a
   dialog answer that never comes; the whole segment stops answering frame ticks. Not a fingerprint so much as a hang, found
   because the walker calls everything.
5. **No `window.chrome`.** Every Chrome page has `chrome.loadTimes`, `chrome.csi` and `chrome.app`; sannysoft-style checks read it.
6. **Worker-only behaviour on the main thread.** `Atomics.wait` worked (it throws on a Window's thread), `SharedArrayBuffer`
   existed (the segment is cross-origin isolated for the benchmarks), `FileReaderSync` existed.
7. **Names only Chitin has.** `addEventListener`/`removeEventListener`/`dispatchEvent` as own properties of the global (they
   are `EventTarget.prototype`'s), `__chitinReport` (a test hook), `innerWidth`/`innerHeight` as arrow-function accessors that
   print their source and are not enumerable, glue functions with an own `prototype`, `[Symbol.iterator]` named
   `[Symbol.iterator]` where Chrome's is `entries`, `forEach.length` 2 where Chrome's is 1, over a hundred members the engine lists but
   does not implement as `undefined` data properties.
8. **`navigator.hardwareConcurrency` and `deviceMemory` were 1 and 1** (the engine's constants; a container-sized machine).
9. **Glue frames in every `Error.stack`**, and the mirror path in `eval at` origins (not fully fixable, see Residue).
10. **The rest**: the feature gaps (about 840 members and 660 interfaces Chrome has), listed in the JSON, not ranked.

## What was fixed

Each fix has a check in `tools/surface-diff/checks.mjs` (36 of them), which `make surface-test` runs in Chrome's top-level
window and in a segment and requires equal answers, and records Chrome's answers in `tools/surface-diff/chrome-answers.json`
for `tests/surface.test.mjs` (under Node, part of `make engine-js-test`), which holds the engine to Chrome's recorded text
without a browser. The code is `glue/engine/45-surface.js` (new), a few lines in `40-bridge.js`, `50-frames.js` and
`harness/segment/worker.js`.

| item | what is done | check |
|---|---|---|
| receiver and argument errors | a binding's engine error is rewritten into Chrome's text: `Illegal invocation` when the receiver is not an engine object, `Failed to execute 'm' on 'I': parameter N is not of type 'T'.` when an argument is, `N argument(s) required, but only M present.` for the engine's count messages, `Failed to execute 'querySelector' on 'Document': '!!' is not a valid selector.` for selectors. The receiver is checked before the arguments, as Chrome does; a native called with no receiver acts on the global (so `const add = window.addEventListener; add(...)` works, as in Chrome) | a binding on a foreign receiver; a getter on a foreign receiver; a wrong argument names the parameter (x2); a method with overloads on a foreign receiver; a static called with too few arguments; a bad selector (x2); a native called with no receiver |
| stack of those errors | `Error.captureStackTrace(e, binding)` drops the glue frames above the page's call site | a binding error starts at the page; an argument error starts at the page; `Function.prototype.toString` on a non-function |
| interface objects | plain functions, not classes: called they throw Chrome's two messages (the list of constructible interfaces comes from Chrome, `glue/engine/46-constructible.js`, because asking the engine means constructing); `new` on an abstract interface is `Failed to construct 'X': Illegal constructor` | an interface object called without new; new on an abstract interface |
| the global is a Window | `Window` is a function of ours named `Window`, throwing `Illegal constructor`, and its `prototype` is the Worker's prototype object, which gets `Symbol.toStringTag` `Window`, `constructor`, `TEMPORARY`, `PERSISTENT` and nothing else; the WorkerGlobalScope prototype behind it becomes `WindowProperties` (no constructor, no members); the members both carried are the global's own; the global's own Worker `constructor` and `FileReaderSync` are removed; `Window` inherits `EventTarget` as an interface | the global is a Window; the global's prototypes are Window.prototype and WindowProperties; Window is not constructible and not callable; the Worker scope names do not exist; for-in on the global lists no Worker member; navigator and location chains |
| named access on the window (2026-10-23, Khronos deqp `canvas.width`) | the Window's supported property names (element ids, names of embed/form/img/object, child navigable target names; `ganglion_window_named_keys`, refreshed when the document's tree version moves: before and after each script and at each pump) become accessors on WindowProperties that ask the engine's Window for the value now (the element, an `HTMLCollection` for a repeated name); not enumerable, assignment shadows on the global; names the frame code keeps (syncFrameNames) are left to it. Not yet: a frame realm's own named access, and a name read inside the same task right after the element was added from a callback that is not a script (it appears at the next pump) | tests/chrome/run.mjs "named elements" (iframes.example/named-elements.html) |
| EventTarget on the global | the page's `EventTarget` interface is rebuilt on the object that already stands behind WindowProperties (the Worker's `EventTarget.prototype`, whose own prototype cannot be changed): a new interface object whose `prototype` is that object, the engine's members copied onto it, every engine interface that inherited the old prototype object re-parented to it. `window instanceof EventTarget` is true, the three methods are not the global's own, and what a page defines on `EventTarget.prototype` (ShadyDOM's `__shady_native_addEventListener`) is found from the window | the global inherits the page's EventTarget; EventTarget members are not the global's own |
| main-thread behaviour | `Atomics.wait` validates its arguments as V8 does (`[object Int32Array] is not a shared typed array.`) and then throws `Atomics.wait cannot be called in this context`; `SharedArrayBuffer` is deleted | Atomics.wait throws as on the main thread; no SharedArrayBuffer without cross-origin isolation |
| dialogs | `alert` returns undefined, `confirm` false, `prompt` null at once, as a dismissed dialog does; `print` does nothing; all four are enumerable natives that throw on a foreign receiver | dialogs answer as dismissed ones do; a dialog on a foreign receiver |
| `window.chrome` | `loadTimes`, `csi` and `app` with Chrome's key order, anonymous natives that print `function () { [native code] }`; no `runtime` | window.chrome |
| native look of what the glue makes | `innerWidth`/`innerHeight`/`outerWidth`/`outerHeight`: replaceable accessors with native `get`/`set`, enumerable, outer = inner; the frame glue's getters and `postMessage` have no own `prototype` and the right length; `[Symbol.iterator]` is `entries` (`values` for set-likes), `[Symbol.asyncIterator]` is `values`; `forEach.length` 1 | innerWidth and innerHeight; outerWidth and outerHeight; functions the glue makes look native; iterable interfaces |
| members that were not there | members the engine lists with an `undefined` value are not defined (`'preserveAspectRatio' in svgElement` is false, not true-with-undefined); `__chitinReport` exists only on the `*.example` test sites; `webkitRequestFileSystem` and `webkitResolveLocalFileSystemURL` exist and refuse with a SecurityError | members the engine lists but does not implement are absent; webkitRequestFileSystem... exist |
| `performance.memory` | an accessor on `Performance.prototype` returning a `MemoryInfo` with the three numbers (a Worker has none, so they are a plain page's size, not the heap) | performance.memory |
| navigator | `hardwareConcurrency` and `deviceMemory` are what the host browser reports to its own pages | navigator.hardwareConcurrency and deviceMemory (browser only) |
| receivers of the global's own members | `setTimeout.call({})`, `Object.getOwnPropertyDescriptor(window, 'window').get.call({})`, `queueMicrotask`, `innerWidth` throw `Illegal invocation`; `fetch` and `createImageBitmap` reject; `onmouseenter`, `onmouseleave`, `onreadystatechange` are lenient as in Chrome | the globals members on a foreign receiver |

Count of tells (the diff, same walker both times): **6,101 differences / 1,056 causes at baseline, 335 / 143 now** (a 94% and an 86% drop).
Intermediate runs: after the receiver messages, the global's names and the interface objects 1,133; after the EventTarget,
absent-member and argument-count batch 336. The residue of that count is listed next; the other 1,505 differences are gaps.

Suites after the last change: `make engine-js-test` 127/127, `make engine-test` 13/13, `make chrome-test` 108/108, `make
surface-test` 36 of 36 equal to Chrome. WPT was not re-run (see Notes).

## Residue, honestly

**Fixable only by something we have not done.**
- **Glue and wasm frames below the page's outermost frame.** Every `new Error().stack` created from a script or from a
  callback (event listener, timer, observer) ends in `Object.runScript (.../chitin/worker.js)`, `env.ganglion_host_js_run_script
  (.../ganglion-engine.js)` and `ganglion.wasm.Ganglion::Bridge::...` frames: the page runs inside a call from the engine, so
  the host stack has them, and V8 offers a page nothing to hide frames *under* a caller. The only lever is
  `Error.prepareStackTrace`, which would show up as `'prepareStackTrace' in Error` (Chrome: false) and fights pages that set
  it (docs/research/scramjet-lessons.md item 2 decided against owning it). Left to the owner: take the one tell for the other,
  or keep stacks short and honest. The stack of an error a *binding* throws is already clean.
- **`eval at` origins show the mirror path.** `new Function(...)` frames print `eval at <anonymous>
  (.../__chitin/o/https/<host>/__chitin_script_3.js:...)`; ordinary frames use the real URL (the `sourceURL`). V8 prints the
  script's *resource name* for the eval origin, and the resource name has to be the staged mirror path so that a classic
  script's relative `import()` resolves (harness/segment/worker.js runScript). Not changed: it is the other worker's file and
  the trade is theirs.
- **Own-property order of the global.** `Object.keys(window)` starts with `name, cancelAnimationFrame, ...` instead of
  `window, self, document, name, location, ...`: the unforgeable accessors (`window`, `document`, `location`, `top`) are
  non-configurable, so they cannot be moved to the front after they exist, and defining them first means changing the
  install order in the mirror. Only a script that hashes the order sees it.
- **Promise-returning operations on a foreign receiver** throw synchronously where Chrome returns a rejected promise
  (`HTMLMediaElement.prototype.play.call({})`; about 110 members). The engine does not say which operations return promises;
  only `fetch`, `createImageBitmap` and the scroll methods are special-cased.
- **Interface generation.** Ladybird implements some newer and some older IDL than Chrome 154: `CSSStyleProperties` (Chrome:
  `CSSStyleDeclaration`, visible in `Object.prototype.toString.call(el.style)` and `getComputedStyle`), `SVGRect` as an alias of
  `DOMRect`, `Screen` without `EventTarget` behind it, `Range` without `NodeRange`, the order of statics (`URL.parse` before
  `URL.canParse`), `onfocusin` and `onpagereveal`, `AudioTrack`/`VideoTrack`, `ReadableStream.from` and about 70 more names
  Chrome 154 does not have (the `extra-member` cluster list), and about 840 members and 660 interfaces it has that the
  engine does not (`navigator.permissions`, `connection`, `gpu`, `Notification.permission`,
  `SharedWorker`, `RTCPeerConnection` on purpose (`Worker` exists since the captcha branch: docs/architecture.md, "Page
  dedicated Workers"), `ErrorEvent.filename` for errors thrown in timers, a `navigation` entry in
  `performance.getEntries()`, `PerformanceObserver.supportedEntryTypes` beyond four types, data: URLs in `import()`).
  Those are features; the names Chrome 154 lacks could be hidden but the engine uses the interfaces behind some of them.

**A same-site frame's realm (M6, glue/engine/55-realms.js): what one Worker realm cannot give a frame.**
- **Shared ECMAScript built-ins.** Every frame realm of a segment has the Worker's `Object`, `Array`, `Function`, `Promise`,
  `Error`... so `[] instanceof frame.contentWindow.Array` is true (Chrome: false), `Function('return this')()` from a frame
  is the principal window, and a prototype a frame changes is changed for its parent too (same site, so no new cross-site
  leak; a fidelity gap). `Array.isArray` and DOM `instanceof` (per realm) are right.
- **A sloppy function's default `this`** in a frame's code is the principal window (the functions are the Worker realm's).
  While a frame's script runs, a name the principal window lacks is routed to the frame's global through a Proxy in the
  principal global's prototype chain (`this.locale_data.duckduckgo = ...` in DuckDuckGo's util.js works); a name the
  principal window has (`this.document`, a parent global of the same name) is still the principal window's, and code the
  engine does not enter as the frame's (a promise reaction) is not routed.
- **Stacks of frame code** have two wrapper frames (`at eval (...)`, `at Window.eval (...)`) where Chrome's top-level frame is
  a bare `at url:line:col`, and columns on a script's first line are off by the wrapper's prefix. `Error.prepareStackTrace`
  stays unowned (owner decision 2026-10-22).
- **Names of the principal window a frame does not have** read as `undefined` in the frame (Chrome: a ReferenceError).
- **The frame's WindowProxy** reports own properties as configurable unless the page fixed them through it (a Proxy cannot
  report a non-configurable property its target lacks); a frame's top-level `var` reads as a data property through it, as an
  accessor on the frame global itself. Each document of the frame gets its own WindowProxy object: a reference kept across
  the frame's navigation still reaches the frame's current document, but `old === iframe.contentWindow` is false (Chrome: true).
- **`import.meta.url` of a frame's module** is its mirror name on the segment origin (`/__chitin/r/<id>/o/https/<host>/...`).
- **Free names in a frame's module** are bound once, when it is evaluated (the fixed prologue): a later replacement of a frame
  global (`window.setTimeout = patched`) is not seen by a module that already read it. TDZ is emulated for global lexicals;
  redeclaring one in a later script is a SyntaxError, as in Chrome.

**Cannot be fixed from inside a page (timing and main-thread-only).**
- **Dialogs return at once.** A dialog in Chrome blocks until a person answers; here it is gone before the next line. A script
  that times `confirm()` sees it. Real dialogs would mean blocking the Worker on the carapace (`Atomics.wait`, which the page
  itself must not have) and a UI; not built.
- **Timing.** requestAnimationFrame is driven by the carapace's frame messages, not by the display; timer clamping,
  `performance.now()` granularity, task ordering between the engine's queue and V8's microtasks, and the cost of every
  mirrored call differ from a native DOM and can be measured by a script that wants to. nested `setTimeout(..., 0)` clamps in both
  (the probe agrees); the *cost* of a DOM call is a mirrored crossing.
- **Cross-origin isolation and `SharedArrayBuffer`.** The page is presented as not isolated (no SAB, `crossOriginIsolated`
  false, `Atomics.wait` throws), which is right for the sites that do not send COOP/COEP and wrong for the few that do
  (ffmpeg.wasm and friends): the engine does not carry the document's headers yet. To give those sites SAB back, the segment
  would need the document's COOP/COEP from the engine's network layer.
- **`performance.memory` numbers are not the heap.** A Worker has no `performance.memory`; the values are a small plain page's
  (4 GiB limit, about 20 MB total, growing slowly) so the shape is right and the number is plausible.
- **Where the code sits.** `confirm()` answering false and `webkitRequestFileSystem` refusing are choices; Chrome in a normal
  window answers by what the user does.

## Timing and fetch metadata (parity group A, 2026-10-22)

Measured on one local site (tests/parity-site.mjs) that Chrome for Testing 154 and the engine both load over the network,
the engine under Node on its own network stack (the segment's stand-in sites skip that stack, so request headers can only
be compared this way). `node tests/parity-probe.mjs chrome FILE` (under tools/with-browser.sh) records Chrome; tests/timing.test.mjs
(in `make engine-net-test`) compares the engine with tests/fixtures/parity-chrome154.json.

Before: no navigation entry (the host's navigation bypasses LibWeb's), no `<img>` or iframe entries, a stylesheet as "css",
every size 0 and transferSize 300, contentType and nextHopProtocol empty, all phase times equal, no Server-Timing, no
paint or visibility-state entries, supportedEntryTypes of four, no Sec-Fetch-* on the top-level navigation, Firefox's
image and document Accept, Accept-Language "en-US".

Now (Ladybird patch 0043, engine/platform Host.cpp and Network.cpp): PerformanceNavigationTiming from the host's own
fetch (time origin = when it started, phases from the engine's network, coarsened to 100 us, buffers reset per page);
resource entries for link/script/img/iframe/fetch/xhr with Chrome's initiator types, sizes, content type and encoding,
"http/1.1" or "h2", render-blocking, PerformanceServerTiming, Timing-Allow-Origin zeroing (transferSize 0); paint and
visibility-state entries; Chrome's supportedEntryTypes, PerformanceEntry.navigationId and attribute order; Sec-Fetch-Site/
Mode/User/Dest on navigations (none + ?1 typed, the page's relation and activation otherwise, redirects counted), Chrome's
Accept values and weighted Accept-Language; Sec-CH-UA also on http://localhost. Subresource Fetch Metadata was already
right. Priority: Chrome 154 sends no `priority` header over HTTP/1.1 and neither does the engine; fetchpriority and
script async/defer reflection and the dynamic-insertion async default already matched.

Left (listed in tests/timing.test.mjs KNOWN): `confidence` (PerformanceTimingConfidence), performance.eventCounts and
interactionCount (Event Timing), LCP/event/longtask/layout-shift entries (types accepted, buffers empty; a page waiting for
an LCP entry waits for ever, as in no browser), the EventCounts/LargestContentfulPaint/LayoutShift/... interfaces, Chrome's
favicon entry, `zstd` in Accept-Encoding (no decoder), Sec-Fetch-Storage-Access. fetchStart can be 0 where Chrome's is
about 1 ms (Chrome's navigation starts before its fetch). Page dedicated Workers' requests run outside the Node runner and
were not compared.

## Owner decisions (not shaped, because they are policy)

- **`navigator.userAgent`, `appVersion`, `platform`, `userAgentData`: decided 2026-10-22, option B (Decisions.md), done.** Chitin
  says what the host Chrome says, plus one coarse token appended Edge-style: `... Chrome/154.0.0.0 Safari/537.36 Chitin/0`. The
  token is `Chitin/0` for every user on a platform: no build id, no version beyond 0, so the string does not tell users apart.
  - `navigator.userAgent` is the host's string plus ` Chitin/0`; `appVersion` is that string without `Mozilla/`; `platform` is the
    host's (`MacIntel`, `Win32`, `Linux x86_64`).
  - `navigator.userAgentData` exists (`NavigatorUAData`, an interface Chrome has): `brands` are the host's brands with
    `{brand: "Chitin", version: "0"}` appended, `mobile` and `platform` are the host's, `getHighEntropyValues()` returns the host's
    hints with `fullVersionList` extended by `{brand: "Chitin", version: "0.0.0.0"}`, `toJSON()` is the low-entropy trio.
  - The wire says the same: the engine's `User-Agent` is that string for the document and every subresource, and its https
    requests carry `Sec-CH-UA` (the same brand list, `"Brand";v="N", ...`), `Sec-CH-UA-Mobile` and `Sec-CH-UA-Platform`, the low-entropy
    set Chrome sends by default. The strings are computed once in the glue (`IDENTITY`, glue/engine/45-surface.js) and handed to the
    engine at boot (`ganglion_set_identity`, engine/platform/Host.cpp; Network.cpp adds the hints in `serialize_request`), so
    navigator and headers cannot drift apart. Page scripting off (the host's own navigator, harness/segment/doors.js) gets the same
    token and brand. Where the host is not Chrome (Node tests) the glue falls back to a Chrome 154 string.
  - Not claimed: a Chrome build number of Chitin's own, and the TLS fingerprint (the engine's TLS is OpenSSL's, so JA3/JA4 still say
    "not Chrome": a network-layer tell outside this page).
  - Checks: `make engine-js-test` (tests/ua.test.mjs: shape and brands under Node), `make surface-test` (a shape check against
    Chrome's `NavigatorUAData`), `make chrome-test` (group "platform identity": UA == host UA + token, brands == host brands +
    Chitin, and the User-Agent / Sec-CH-UA headers a server receives equal navigator's).
- **The site-compatibility list (owner decision 2026-10-22): `webcompat/*.json`, Ladybird's WebCompat model.** Some sites sniff
  the user agent and degrade (a broken layout, a missing feature, an "unsupported browser" page) when they see a token they do not
  know. For those, and only those, a rule hides the Chitin token, exactly as Ladybird's `WebCompat/*.json` hides `Ladybird/`:
  - One rule per file: `matches` (URL patterns, e.g. `https://*.cnn.com/*`), and `user_agent: ["hide_Chitin"]` and/or
    `expose_experimental_interfaces` (names LibWeb gates behind `[Experimental]`, e.g. `Navigator.permissions`). The shape is
    Ladybird's `SiteCompatibilityRule` (Libraries/LibWebCommon/Loader/SiteCompatibility.cpp); `hide_Chitin` is patch 0038's
    addition beside `hide_Ladybird`. tools/webcompat-gen.py checks each file and writes them into the glue
    (`SITE_COMPATIBILITY`); boot() hands the list to the engine (`ganglion_set_site_compatibility`), and LibWeb's ResourceLoader
    is the one place that answers "which user agent for this URL".
  - Consistent everywhere for a matched URL: `navigator.userAgent` and `appVersion` (the document's URL, LibWeb's NavigatorID),
    `navigator.userAgentData` (`brands`, `toJSON()` and `fullVersionList` without the Chitin brand), the `User-Agent` header of
    the document and of every request to a matched URL (the request's URL, as Ladybird decides it; an own-site mirror request is
    asked for the site's URL), `Sec-CH-UA` without the Chitin brand, and the WebSocket handshake's `User-Agent`. What is left is
    exactly the host Chrome's own string and brands. A request from a matched page to an unmatched host keeps the token, and
    vice versa, as in Ladybird.
  - Seeded with Ladybird's own entries: `www.nytimes.com` and `cnn.com` (user agent), `aljazeera.com` (Permissions interfaces).
  - `expose_experimental_interfaces` reaches LibWeb, which applies it when a global is created at a matched URL; a segment's
    window realm is created once, for about:blank, before the page's URL is known (the single-realm model), so a rule cannot
    reach the window yet (it needs a realm per document, the M3 anchors). The one seeded rule's names (`Navigator.permissions`,
    `PermissionStatus`) no longer need it: patch 0045 exposes them to every page, as Chrome does (group D below).
  - **Policy: the list is for sites that break on user-agent sniffing, never for getting past bot protection, captchas or any
    challenge.** A site behind a challenge (Cloudflare, hCaptcha, reCAPTCHA, Turnstile, DataDome, rateyourmusic and the like) is
    never added, and a rule is never used to make Chitin look like something else to a detector: it only removes Chitin's own
    token so the host Chrome's own string is what a sniffing site sees. Each entry says which site broke and how in its commit.
  - Tests: tests/ua.test.mjs (a matched host: navigator, userAgentData, fullVersionList and the User-Agent headers agree with no
    token; an unmatched host and a request to one keep it; host-added rules; the aljazeera interface rule) and `make chrome-test`
    group "site compatibility" (through the real network: the fetch's User-Agent and Sec-CH-UA and the WebSocket handshake equal
    navigator on the matched host, and keep the token under a rule for another host). The harness's `?compat.hide=host,...`
    adds a test rule for those hosts (tests only; boot option `siteCompatibility`).
- **Pointer and mouse events (Pointer Events 3, UI Events; patch 0039, 2026-10-22).** For a mouse from the carapace the page gets
  Chrome's log: `pointerdown, mousedown, pointerup, mouseup, click` (and `contextmenu` after `mousedown`, `auxclick` for other
  buttons, `dblclick` after the second click); `click`, `auxclick` and `contextmenu` are PointerEvents (pointerId 1,
  pointerType "mouse", width/height 1, isPrimary false as in Chrome); `pointermove` and the pointer boundary events have
  `button` -1; all pointer boundary events come before the mouse ones; pressure is the host's (a real mouse: 0.5 while a button
  is down); the click count is the engine's (same button within 500 ms and 4 px). A touch or pen keeps the host's pointerType,
  pointerId, contact size and pressure. Not yet for touch: TouchEvents (touchstart/touchend) and Chrome's touch order (mouse
  compatibility events after pointerup). Check: chrome-test group "pointer events" (full logs for click, right, middle, double,
  drag against Chrome's, plus a tap's touch fields).
- **`navigator.language(s)`, `webdriver`, `doNotTrack`, `globalPrivacyControl`.** `webdriver` is false (a person's Chrome);
  `globalPrivacyControl` is exposed as `false` where Chrome 154 has no such property.
- **Screen and window geometry.** `screen.orientation`, `screenX/screenY` (0), and `matchMedia('(prefers-color-scheme)')` are
  the engine's, not the host's.
- **The Chrome the numbers are against.** 154. Chitin claims the host Chrome's version (the UA above), so the
  comparison is a stand-in for "whichever Chrome the user has"; a newer or older Chrome moves the extra/missing lists.

## Checklist from the card (docs/security.md sections 3 and 4)

| item | state |
|---|---|
| DedicatedWorkerGlobalScope / WorkerNavigator / WorkerLocation names via getPrototypeOf/constructor | fixed for the global; Navigator and Location were already the page's (their chains equal Chrome's) |
| Atomics.wait works in workers | fixed |
| self.close / postMessage worker signature | equal to Chrome's (`close.length`, `postMessage.length`, native strings); no change needed |
| deleted members whose absence is observable | `importScripts`, `onmessage` and the Worker scope names behave as on a Window; `FileReaderSync` removed; the doors removed on purpose (Worker, SharedWorker, WebRTC, ...) stay missing and are gaps |
| requestAnimationFrame / requestIdleCallback presence and timing | presence and callback shapes equal; cadence is the carapace's (residue: timing) |
| alert/confirm/prompt sync semantics | fixed (no hang, dismissed answers); residue: they return at once |
| document.write timing | equal |
| performance entry types | `performance.memory` added; `supportedEntryTypes` and a `navigation` entry are gaps |
| glue frames in Error.stack, `'prepareStackTrace' in Error` | `prepareStackTrace` stays absent (equal to Chrome); glue frames: binding errors fixed, the rest residue |
| mirror path in import.meta.url / currentScript.src / stack URLs | equal for scripts and modules; residue: the `eval at` origin |
| the hello.mjs probes in the page's resource timing | not present in `performance.getEntries()`; equal |

## Notes

- **A hazard found on the way.** Constructing every interface without arguments inside one script (calling each interface
  object and constructing when it answers `Failed to construct`) stopped the engine with `VERIFICATION FAILED:
  &settings.realm_execution_context() == &vm.running_execution_context()` at the end of the script. Each constructor alone is
  fine; some combination leaves the execution context unbalanced. That is why `constructible()` reads a generated list instead
  of asking the engine. The trigger is not isolated; it is worth a look by whoever owns the engine glue.
- **WPT** (`make wpt`) was not re-run against these changes: an orphaned `wptserve` from another run held ports 8460-8470
  while this was finished. The interface-object and error-message changes move toward Chrome, which is what the suite measures,
  but only a run proves it; `node tools/wpt/run.mjs --compare docs/results/wpt-2026-10-22.json <new>` lists any subtest that
  stopped passing.
- **Merging.** The branch touches `harness/segment/worker.js` in two places (`installPageGlobals(withReport)` and its two
  callers); it does not touch `sw.js`.

## Chrome parity, group D (2026-10-22)

From Ladybird's web-compat checklist (#226), as spec parity; checked by `make chrome-test` group "parity D"
(`CHITIN_ONLY=parity-d`: every probe in Chrome 154 and in Chitin, answers compared) and tests/workers.test.mjs.

- **Screen and ScreenOrientation come from the host.** The segment document reads its own `screen` (width, height,
  availLeft/Top/Width/Height, colorDepth, isExtended, orientation type and angle) and hands it to the engine
  (`ganglion_set_screen`); Screen, the `device-*` media features and `screen.orientation` answer with the host's values.
  A change of the host's orientation fires `change` at the page's `screen.orientation`. `lock()` rejects with Chrome's
  `NotSupportedError` ("screen.orientation.lock() is not available on this device."); `unlock()` does nothing (patch 0045).
- **Permissions.** `navigator.permissions` and `PermissionStatus` are exposed everywhere (they were behind LibWeb's
  `[Experimental]` switch, which the single-realm model could not turn on per document). A query answers Chrome's state for an
  origin that never decided anything: `granted` only where Chrome grants without asking (sensors, clipboard-write,
  background sync/fetch, payment-handler, screen-wake-lock, storage-access, keyboard/pointer lock), `denied` for
  periodic-background-sync, `prompt` for the rest; Chrome's status names (`video_capture`, `durable_storage`, ...), its
  descriptor checks (push without `userVisibleOnly`, fullscreen without `allowWithoutGesture`) and its error messages.
  **Nothing is granted without a prompt and Chitin has no prompt**: a request (geolocation, `Notification.requestPermission()`,
  the microphone) is a dismissed prompt: the caller hears `denied` / `default`, nothing is stored, the state stays `prompt`.
  Headless Chrome is not the reference for notifications and push (it answers `denied` because it has no prompt UI, while its
  `Notification.permission` says `default`); Chitin answers as a new profile of a person's Chrome does.
- **Notification.** `permission` (`default`), `requestPermission()` (resolves `default`, calls the deprecated callback),
  `maxActions` 2.
- **Navigator.** `connection` is a `NetworkInformation` (effectiveType, rtt, downlink, saveData, onchange) with the host
  Chrome's own rounded values (`ganglion_set_network_information`; a host `change` fires `change`). `webdriver` is `false`
  (Chrome under the DevTools protocol says `true`; a person's Chrome does not). hardwareConcurrency and deviceMemory were already
  the host's; plugins/mimeTypes (Chrome's five PDF entries), pdfViewerEnabled, javaEnabled, doNotTrack, onLine and
  cookieEnabled already matched.
- **Workers.** A worker's global has `WorkerGlobalScope` and `DedicatedWorkerGlobalScope`/`SharedWorkerGlobalScope`; a module
  worker's `importScripts` throws Chrome's `TypeError`; workers make workers; `SharedWorker` (docs/architecture.md, "Page
  dedicated Workers"). blob: and data: workers already worked.
- **Initial about:blank and srcdoc iframes** already behaved as in Chrome (a complete about:blank document right after
  `appendChild`, its `load` fired inside the append, `contentWindow.eval` and `document.write` at once; srcdoc is about:blank
  until a later task): the group keeps them that way.
- **Web Audio is heard.** An `AudioContext` runs at the host's output rate (the segment document's own AudioContext's), and
  what its graph renders goes to the carapace's AudioWorklet as media audio does (patch 0046: LibMedia's null stream hands
  each period it pulls to the embedder; glue/engine/55-media.js `ganglion_host_webaudio_*`). OfflineAudioContext renders as
  before (patch 0037) and answers as Chrome does.
- **Open, found here.** A parent's `frame.contentWindow.eval('var q = 7')` runs in the principal realm, not the frame's
  (`frame.contentWindow.q` stays undefined; Chrome: 7): the frame realm has its own `Function` (55-realms.js
  `frameFunctionConstructor`) but not its own `eval`. After `document.open()` on a frame's initial about:blank document its
  URL stays about:blank (Chrome: the opener's URL, HTML "document open steps" with the entry document), and right after
  `document.close()` its readyState is `interactive` (Chrome: `complete` at once). Both are excluded
  from the group's comparisons until fixed. And a C++ `JS::Object::get` of a property a page object does not have, from
  inside a binding (`navigator.permissions.query({ name: 'push' })` reading `userVisibleOnly` that way), stopped the engine
  at the next microtask checkpoint; patch 0045 converts the IDL dictionary instead. Worth a look by whoever owns the bridge.
- **Not yet.** NetworkInformation and Permissions in the page's workers (runners are host Workers with those doors removed);
  `PermissionStatus` change events (no decision ever changes without a prompt); `Screen.onchange` (window-management).

## Maintenance

- A new check: add `{ name, body, node? }` to `tools/surface-diff/checks.mjs` (`body` returns a JSON value; `node: false` if
  the Node vm cannot answer it), run `RECORD=1 make surface-test`, commit `chrome-answers.json`.
- A Chrome update: `make surface-diff` (the numbers), `tools/with-browser.sh WHO node tools/surface-diff/callnew.mjs` then
  `CHROME_VERSION=<x> node tools/surface-diff/gen-constructible.mjs` (the list of constructible interfaces),
  `RECORD=1 make surface-test`.
- Public detection pages: docs/user-tests/fingerprint.md (owner-run only).
