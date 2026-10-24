# Chitin: architecture

Chitin is a web browser that runs inside a web page. It does not intercept or rewrite sites. Each site
gets its own hard shell: a separate browser process with its own origin, its own copy of a real
engine and its own storage. Its JavaScript runs on the host browser's V8 JIT, and its network leaves
through our relay or through Tor. Nothing a site sends or runs is edited on the way.

The name: chitin is what an insect's exoskeleton is made of. A shell around every site, rather than
a mask over it.

Status: design, 2026-10-11, with phase 0 (docs/phase0.md), phase 1 (docs/phase1.md: LibWeb
renders static pages in a segment) and the network (docs/network.md: real sites through a relay the
user runs, TLS inside the engine, Wisp over WebSocket; WebTransport and Tor not yet) built. The
research behind each choice is summarised in docs/research/ (sources cited there).

## The pieces

```
 host browser tab
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ Carapace (our origin): tabs, address bar, compositor, input, downloads   │
 │   │  frames (ImageBitmap / VideoFrame)  ▲   input events, sizes ▼        │
 │   │                                      │                               │
 │ ┌─┴──────────────────────────┐  ┌────────┴───────────────────┐           │
 │ │ Segment: site A            │  │ Segment: site B            │  ...      │
 │ │ own registrable domain,    │  │ (same shape)               │           │
 │ │ own process (DIP / site    │  └────────────────────────────┘           │
 │ │ isolation)                 │                                           │
 │ │ ┌────────────────────────┐ │                                           │
 │ │ │ one Worker:            │ │                                           │
 │ │ │  Ganglion (engine wasm)│ │                                           │
 │ │ │  + the site's JS on V8 │ │                                           │
 │ │ │  bindings = direct     │ │                                           │
 │ │ │  calls, same thread    │ │                                           │
 │ │ │  OffscreenCanvas paint │ │                                           │
 │ │ └───────────┬────────────┘ │                                           │
 │ └─────────────┼──────────────┘                                           │
 │               │ byte streams (MessagePort), TLS inside                   │
 │ ┌─────────────┴────────────────────────────────────────────────────────┐ │
 │ │ Spiracle (our origin, a Worker): stream mux                          │ │
 │ │   WebTransport ─┐                                                    │ │
 │ │   Wisp v2 / wss ┼──► Relay (self-hosted)                             │ │
 │ │   Tor (Arti)  ──┘    or Tor guards / Snowflake                       │ │
 │ └──────────────────────────────────────────────────────────────────────┘ │
 └──────────────────────────────────────────────────────────────────────────┘
```

### Carapace: the shell page

The top-level page, on our origin (e.g. `chitin.app`). It never runs site code.
- The browser chrome: tabs, address bar, history, bookmarks, settings, downloads, permission prompts.
- Compositor: each segment sends finished frames (ImageBitmap, or VideoFrame for video) and the
  carapace draws them into the tab area. Input (pointer, keys, IME, scroll, touch) goes the other way
  as messages, with coordinates already mapped.
- Owns the network credentials (relay token, Tor state) and hands each segment stream ports, never
  the credentials.
- Owns the AudioContext: segments send audio buffers to it (Workers cannot open one).

### Segment: one hard shell per site

One per site (eTLD+1), created when a tab navigates there.
- An iframe on its own registrable domain (e.g. `<hash>.chitin-sites.net`), so the host browser puts
  it in its own process and its own agent cluster. Document-Isolation-Policy (Chrome 137+, desktop)
  makes it cross-origin isolated by itself where we need SharedArrayBuffer inside it.
- Inside, one Worker holds both the engine and the site's JavaScript. Page JS is a real V8 realm with
  the JIT; DOM bindings are direct calls into the engine's wasm (nanoseconds, ordinary reentrancy,
  one event loop driven by the engine as in a real browser).
- Storage: localStorage, IndexedDB and cache live in the segment's storage (partitioned by the host browser under our
  top-level site), so sites never see each other's. Cookies are the browser's, per site of the cookie: one store in the
  carapace, and each segment holds only its own site's cookies and its own context's partitions (docs/cookies.md).
- If a site breaks out of its engine, it lands in its own sandbox: no access to the carapace, to other
  sites or to the network credentials. The isolation is the host browser's own origin model, not code
  of ours that could miss a case.
- The binding glue is hardened against the page (captured primordials, as Node does), because page JS
  shares the realm with it.

### Nested segments: cross-site iframes

A cross-site `<iframe>` (another registrable domain than its parent document) is not rendered by the parent's
engine: it becomes a nested segment, a segment like any other with the parent as its embedder. This is what
lets challenge widgets (Turnstile, reCAPTCHA, hCaptcha, all cross-site iframes) appear so that the user can solve
them. Chitin never solves, skips or fakes a challenge; it only shows the frame and passes the user's input to it.
Same-site iframes stay documents of the parent's engine (docs/security.md 4, "iframes").

- **Creation.** The parent's engine leaves the iframe's own browsing context at its initial `about:blank` (it
  never fetches B). After each frame the parent glue lists its cross-site iframes: an id per element, the
  resolved `src`, and the content box in the parent's viewport (from the engine's layout). Iframes inside shadow
  roots count too, open or closed (Cloudflare Turnstile puts its widget in a closed one): the glue keeps a weak list
  of every root `attachShadow` made and searches them as well as the document. The list goes to
  the carapace (`subframes`). The carapace, not the parent, derives the child's site from the URL and starts
  the child segment exactly as a top-level one: origin `s<hash(site)>`, its own iframe in the carapace, its own
  Worker and engine, its own Spiracle port. An id that disappears, or whose URL moves to another document,
  tears the child down (a new URL is a new child, as a cross-document navigation is a new segment).
- **Sizing and compositing.** The child's viewport is the content box's size; a change of size is a `resize`.
  The carapace composites: the child's frames go to a canvas of their own placed over the parent's view at the
  box, clipped to the parent's content box (a child can never draw outside its box, and the parent can place
  it only inside its own pixels, as in any browser). Under Node, tests/frames.test.mjs composes the two RGBA
  frames with the same rectangle arithmetic (harness/carapace/frames.mjs).
- **Input.** The carapace hit-tests a pointer event against the boxes (topmost child first). A hit goes to
  the child only, in the child's coordinates; the parent gets nothing. Keys go to whichever segment the last
  pointer-down landed in (focus).
- **Storage and cookies.** The child's storage is its segment's: B's localStorage and IndexedDB live in B's segment,
  never in A's process; A's are never in B's. The origin is hash(site) alone, so B embedded in A and B at top level share
  them. Cookies: the child gets B's own cookies (`SameSite=None` ones go, as in Chrome with third-party cookies allowed) and
  the CHIPS partition `<A> 1`; A's segment never holds B's (docs/cookies.md).
- **postMessage.** `iframe.contentWindow` in A is a cross-origin WindowProxy stand-in (the glue's): only
  `postMessage`, `window`/`self`/`frames`, `parent`, `top`, `closed`, `length`, `focus`, `blur`, `close` and
  `location` (a cross-origin Location: `replace` and the `href` setter check the URL and navigate nothing, the rest throws);
  everything else throws a `SecurityError`, and `iframe.contentDocument` is `null`. A transferred ArrayBuffer is
  detached in the sender's page (the engine is given a copy), in any postMessage and in structuredClone. In B, `window.parent` and
  `window.top` are the same kind of stand-in for A. `postMessage(message, targetOrigin, transfer)` (or the
  options form) is cloned by the host's structured clone over the segment's carapace port; the carapace stamps
  the sender's origin from the URL it tracks for that segment (a segment cannot claim another), and delivers
  only when `targetOrigin` is `*` or equals the receiver's current origin, which it also tracks; otherwise the
  message is dropped silently, as Chrome does. The receiver's glue fires a trusted `MessageEvent` on its window
  (`isTrusted` true, `origin` the stamped one, `source` the same stand-in object the page already holds, so
  `e.source === iframe.contentWindow` works).
- **MessageChannel.** A `MessagePort` in `transfer` is bridged: the glue pairs the page's port with a host
  `MessagePort`, the host port travels with the message, and the receiving glue gives the page an engine
  `MessagePort` in `e.ports` whose messages go over the host port (host structured clone both ways).
- **What the iframe gives the child** (branch wb-frames). The carapace passes the child the iframe's `name`
  (`window.name`), the referrer by the default policy (the parent's origin and `/`, nothing on a downgrade from https:
  the document fetch's `Referer` and `document.referrer`) and the parent's origin (`location.ancestorOrigins`), through
  Host.cpp `ganglion_set_embedder`. When the child's document is complete it says `loaded`, and the parent's glue
  fires a trusted `load` at the iframe (api.frameLoaded), so `iframe.onload` comes after the child's scripts as in Chrome.
- **Navigation inside the child.** The child is a segment: a link it follows is a `navigate-request` to the
  carapace, which replaces the child segment in the same box (the parent's `iframe.src` does not change, as in
  Chrome). `target=_top` and the child navigating its parent are not supported yet (`parent.location.replace(url)` does
  nothing, which is what Chrome does without a user gesture; the parent's `frame.contentWindow.location.href = url` on a
  cross-site frame does nothing either, where Chrome navigates the frame).
- **What the carapace validates.** `subframes`: at most 16 entries, integer ids, http(s) URLs, finite boxes,
  each box clamped to the parent's viewport; an entry whose URL is same-site with the parent is ignored. Posts:
  rate limited per segment (60/s), a numeric frame id the parent actually has, `targetOrigin` a string; the
  data is never inspected (it is the pages' business) but only ever goes to the one segment addressed. A child
  can only post to its own parent. Every rule a top-level segment has (guard.mjs) applies to a child too.
- **Kept at one level (decided 2026-10-22, branch yt4).** A child's own cross-site iframes are listed but not started.
  Every segment is a whole engine in a Worker (about 60 MiB of wasm plus its heap and a page's V8 objects), so a
  second level multiplies the cost of the pages that nest most (ad and sign-in frames, which embed further frames of
  their own) on a machine where two browsers already fill memory. It would also need the router, the boxes (a
  grandchild's box is relative to its parent's, clipped by both), input routing and posts (a grandchild posting to
  its parent, a parent to its child's child) to compose across levels, each of them a new path for a page to reach a
  segment it does not embed. Nothing seen so far needs it: YouTube's only nested frame (the passive sign-in) has no
  visible content of its own. Lifting it: a depth cap (2) and a per-tab segment budget in the carapace first.
- **Not yet.**
  `window.frames[i]` / `window.length` in the parent, `sandbox` and `allow` attributes, the parent's overflow
  clips (the box is clipped to the viewport only), and frames of a parent with page scripting off.

### Same-site iframes: child navigables in one engine

A same-site `<iframe>` (and `about:blank`, `srcdoc`, an iframe a script creates) is a child navigable of the parent's
engine, a document of the same page, as security.md 4 says. Ladybird's renderer does not run a navigable alone: creating
one, navigating it and removing it are requests to a UI process (session history operations, "start this navigation",
"unload these documents"), which answers them. `engine/platform/Host.cpp` plays that part for the one page, as it does
for the history of the top-level document (docs/frameworks.md, "Session history"):

- **Creation.** The history operation that appends the child's initial entry is answered with the parent's step. Until
  then the child is not "ready for navigation" and its container *delays the parent's load event* (HTML "currently
  delays the load event"): a page with any iframe never finished loading (the parser's end state timed out waiting
  for the load event delay, WPT run of 2026-10-21, docs/wpt.md). A cross-site frame was just as stuck.
- **Navigation.** The renderer parks the navigate algorithm and asks to start; the engine checks that unloading is not
  canceled, builds the population request, and lets the renderer fetch and make the navigation params (the body is read
  in full into them); the renderer populates the document and asks to finalize. Finalizing is a history operation: the
  first load of a frame replaces its initial `about:blank` entry (a push after it takes a step of the joint session
  history, `history.length`), and the document is activated by the renderer's own jobs.
- **Cross-site frames are not loaded.** `ganglion_host_frame_is_remote` asks the glue's site rule (the one that lists
  nested segments) and the navigation is dropped: the frame stays at `about:blank`, the container stops delaying the
  parent's load event, and the carapace shows the frame as a nested segment above.
- **Removal.** The engine unloads the descendants of the child deepest first and lets the renderer destroy it.
- **Frame realms (M6, 2026-10-22).** A same-site frame's window has a script realm of its own, made by the glue in the
  one Worker realm (glue/engine/55-realms.js; option (b) of the M6 card, decided by the coordinator for the owner,
  revertible): a global object filled by the mirror from the frame's engine Window (its prototypes are the frame
  realm's, so `frame.contentWindow.HTMLElement !== HTMLElement` and DOM `instanceof` across frames behaves as in
  Chrome), behind a WindowProxy object that forwards to the Window the navigable has now (one per document of the frame:
  a Proxy's invariants are per target, and a page may fix non-configurable properties on its window). The
  engine runs a frame's scripts when the glue has frame realms (Bridge.cpp `ganglion_js_frame_realms`) and the glue
  finds the realm from the script's execution context (`ganglion_js_current_global`).
  - *Classic scripts* run through a fixed wrapper: the script's text is the body of a function (strict when its
    directive says so) inside `with` statements over the realm's lexical record, its global and a guard that hides the
    principal window's own names (a read gives `undefined`); a prologue on the first line registers the script's
    top-level `var`/function declarations as live accessors on the frame's global and its top-level `let`/`const`/
    `class` in the realm's lexical record; the ECMAScript globals and `window`/`self`/`document` are bound as parameters
    once per script (references to them are static, so the cost against a real script is small; measured parity on a
    global-heavy loop). A sloppy assignment to an undeclared name lands on the frame's global. The declarations come
    from a scanner (strings, comments, templates, regular expressions, brackets; it descends only into statement
    blocks), not a parser. tests/globalscope.test.mjs is the conformance file.
  - *Event handler attributes* of a frame's document get the frame's scopes outside the element/form/document ones.
  - *Module scripts* of a frame are a module graph of their own: the Worker imports them under the realm's name in the
    segment's mirror (`/__chitin/r/<id>/o/https/<host>/<path>`), and harness/segment/sw.js puts **one fixed line** in
    front of each: an import of the realm's accessor module and a `const` destructuring of the frame's WindowProxy for
    the names the module uses that are the frame's (or the principal window's) and that it does not declare. **This is
    approved as the M6 exception to "the loader changes nothing" (M5a's no-rewriting rule): fixed text, no general
    rewriting of the module.** A root-absolute import from a frame module is redirected into the realm's mirror.
  - *Import maps* (2026-10-22, owner-approved as the **second exception** to "the loader changes nothing",
    Decisions.md). V8 in a Worker knows no import map (Chrome for Testing 154: a module Worker resolves `'#x'` to
    `TypeError: Failed to resolve module specifier '#x'` even when its document has a map) and resolves specifiers
    before any request, so neither the service worker nor the mirror ever sees `#entry`. What is done instead:
    - The map is the engine's: LibWeb registers each `<script type="importmap">` (inline; Chrome refuses `src`) and
      merges several maps per the spec ("merge existing and new import maps": a later map's rule for a specifier
      already in the map or already resolved is dropped). Bridge.cpp `ganglion_import_map_json` hands it to the glue;
      `ganglion_import_map_resolved` adds to the window's resolved module set. glue/engine/57-importmap.js resolves
      ("resolve a module specifier": scopes most specific first, keys in code-unit descending order, prefix keys,
      null entries, backtracking) with the host's WHATWG URL parser.
    - **The rule** (harness/segment/specifiers.js, used by sw.js and by worker.js for classic scripts): the module's
      text is parsed by a real JavaScript parser (Acorn 8.15.0, MIT, third_party/acorn, served at /chitin/acorn.js),
      never matched by regular expressions. Only string-literal specifiers are touched: static `import`, `export …
      from`, `import('…')` (a template with no substitutions counts) and `import.meta.resolve('…')`. A specifier the
      map remaps is replaced by the URL the map gives (inside a frame realm, the realm's mirror name of it; in a
      classic script, the segment mirror's name, so one URL is one module); everything else stays byte-identical, and
      a replacement never removes a line break, so line numbers (stack traces, source maps' lines) are unchanged
      (columns after a replaced literal on its line move). The parse is skipped when the document has no map.
    - **Chrome's errors.** A specifier the map does not know is left alone: V8's own errors are Chrome's (static:
      `Failed to resolve module specifier "x". Relative references must start with either "/", "./", or "../".`;
      `import()`: `Failed to resolve module specifier 'x'`). A specifier the map blocks (a `null` entry,
      backtracking, an unparsable remainder) becomes `/__chitin/unresolvable.mjs?m=…&n=…`, a module that exports the
      names its importer takes and throws Chrome's TypeError (`… Import Map: "nul" matches with "nul" but is blocked
      by a null value`). An `import('x')` no map knows when its module loads becomes `/__chitin/late.mjs?s=…`, which
      the service worker resolves when the import runs (redirecting to the URL, or throwing Chrome's error): a map
      added later still applies, as Chrome resolves `import()` at the call. Parse errors of a map fire the window's
      error event in Chrome's words (patch 0041, which also words every window error event as Chrome does:
      `Uncaught TypeError: message`).
    - **Integrity**: a module request whose URL the map's `integrity` names is checked in the segment Worker (SRI,
      strongest algorithm, sha256/384/512) before the service worker answers it; a mismatch is a network error, as in
      Chrome.
    - **Workers**: a page's module Worker gets no map (as Chrome 154).
    - **Not covered** (the residue): `import(expression)` and `import.meta.resolve(expression)` (no string to
      replace; WPT's data-driven import-maps tests are of this kind), a map added after a module already resolved a
      specifier without any map (the resolution was V8's and is not in the resolved module set), modules of
      `about:blank` frames written with `document.write`, and a module whose import fails to load reports a window
      error instead of the script element's `error` event. Tests: tests/importmap.test.mjs, chrome-test group
      importmap (harness/sites/importmap.example against Chrome), WPT `import-maps/` (docs/wpt.md).
  - *Identity*: one wrapper per engine object; its class is the realm of its prototype, so `parent.document.body`
    from the frame is the parent's wrapper. `parent`, `top`, `frameElement`, `frames[i]`, `window.length` come from the
    engine's navigable tree; a same-site frame of another origin keeps the engine-checked stand-in.
  - *Messaging*: postMessage between same-segment frames is the engine's (one agent, one event loop, shared
    microtasks); `event.source` is the sender's WindowProxy.
  - *Incumbent realm in host jobs*: page code running in a V8 job (after an `await`, a promise reaction) has no engine
    frame under it, so a call it makes into the engine enters the realm of the function called (Bridge.cpp
    `ganglion_js_realm_of`, Host.cpp `ganglion_js_enter_realm`) instead of the principal one; a cross-origin stand-in is
    made per holding realm and enters that realm, so its methods are made there (HTML CrossOriginGetOwnPropertyHelper) and
    a frame's `parent.postMessage` after an `await` has the frame as its source. A cross-origin frame's code gets the
    principal window as a stand-in too. Not exact: a same-origin frame calling the parent's own functions after an `await`
    enters the parent's realm (Chrome: the caller's). `Window.postMessage` is the exception, because its `source` shows the
    incumbent: there the calling script's realm is read from the stack (the innermost page frame's URL; a frame's classic
    scripts are compiled under their own URLs, 40-bridge.js `callerRealmCell`), so the parent posting to its frame after an
    `await` is the source, as in Chrome; a URL two realms ran falls back to the callee's realm.
  - *History*: a step only a frame took is that frame's to traverse (Host.cpp `traverse_child`): `history.back()` and
    `forward()` take the frame to the entry's document again (a navigation with replacement: popstate and the
    entry's persisted state are not restored).
  - *MessagePorts*: a port in a transfer list (port, window, frame postMessage; structuredClone) stays in the process
    (patch 0029): the end that stays waits under an id the transfer data carries, the port the transfer creates
    entangles with it, and what the waiting end posts meanwhile is kept. `event.ports` is a frozen array (50-frames.js).
    tests/ports.test.mjs, chrome-test group ports (the same answers as Chrome).
  - *Painting*: LibWeb draws an iframe as its content navigable's compositor context; with no compositor host, patch
    0030 gives a same-process child navigable an in-process context id and Host.cpp `paint_child_context` records and
    rasters the child's document (nested frames too) when the parent's list draws it; a change in a frame repaints the
    whole view. tests/frame-paint.test.mjs, chrome-test group framepaint. Scrolling inside a frame alone is not
    repainted yet.
  - Off with `?frames.realms=0` (the carapace), `frameRealms: false` (tests). Without it a frame's scripts do not run.
- **Not yet.** A page's own `Worker` (the constructor's worker machinery), named access to frames (`window.frameName`), form submission to a named frame, reloads, `sandbox`, a sloppy
- **Not yet.** A MessagePort in a postMessage transfer (MessagePort::transfer_steps needs socketpair; for the page as
  well), named access to frames from a frame realm (the principal window has `window.frameName` / `frames.frameName` on its named
  properties object since the captcha branch, from the iframes' `name` attributes; a child's own `window.name` is not followed), form submission to a named frame, reloads, `sandbox`, a sloppy
  function's default `this` in a frame for names the principal window has (docs/surface.md), `import.meta.url` of a frame's module (the mirror name),
  and the rest of the residue in docs/surface.md.

### Windows a page opens, and third-party sign-in

`window.open` with a user gesture returns a cross-origin WindowProxy stand-in; a page of the opener's own site runs in a hidden
popup segment whose `window.opener` is a stand-in for the opener (postMessage relayed by the carapace like a frame's), and an
identity provider's sign-in page (popup or redirect) is handed to the user's real browser, the return address pasted back
(RFC 8252). docs/oauth.md has the flows that work and those that cannot.

### Page service workers: run virtually inside the segment

Decided 2026-10-22 (option a, docs/daydream.md). A site's own service worker runs, but never as a real service
worker of the host browser. The segment's service worker (harness/segment/sw.js, the module loader) stays the only
real one: it is what makes loading fail closed, and a second real worker on the segment origin would either replace
it or sit beside it with the host's network. Instead Chitin runs the page's worker code itself and dispatches the
page's events to it.

**Where it runs.** In a *runner*: a dedicated Worker on the segment origin (`/chitin/pagesw.js`, named
`chitin-page-sw`), started by the segment document on the segment Worker's request, one per registration version. It
has no engine. It is contained like the segment Worker: before any site code it proves it is controlled by the
segment's service worker (the nonce'd `hello.mjs` probe, with `role=pagesw`) and removes the host's doors with the
same lists and the same allowlist check (harness/segment/doors.js, shared with worker.js). It talks only to the
segment Worker, over one MessagePort. The page's script bytes are fetched by the engine, staged with the segment's
service worker and run with the host's `importScripts` from the segment's mirror of the site's address space
(`/__chitin/o/https/<host>/<path>`, as classic page scripts are); a module worker (`type: 'module'`) is imported the
same way. Its own `importScripts(url)` takes the same road, which blocks the runner only: the segment's service
worker asks the engine in the segment Worker, a different thread.

**The page's side** (segment Worker, harness/segment/pagesw-host.js): `navigator.serviceWorker` is Chitin's
(`register`, `ready`, `controller`, `getRegistration(s)`, `startMessages`, `oncontrollerchange`, `onmessage`), with
`ServiceWorkerRegistration` (`installing`/`waiting`/`active`, `scope`, `update`, `unregister`, `onupdatefound`) and
`ServiceWorker` (`scriptURL`, `state`, `onstatechange`, `postMessage`). Rules kept from the spec: https only, script
and scope on the document's origin, the scope at most the script's directory unless the script's response says
`Service-Worker-Allowed`, a JavaScript MIME type, longest-scope match. `register` and `update` fetch the script over
the engine's network and install a new version only when the bytes differ. Lifecycle: installing, installed
(`waiting`), activating, activated, redundant, with `install`/`activate` `waitUntil`, `skipWaiting()` and
`clients.claim()`. A waiting version is promoted when its predecessor has no client, which for a segment is the next
document of the site (one document per segment). The principal document is one window client; each same-site frame document is a nested window
client of its own (`frameType: 'nested'`), so a frame's requests carry its `clientId` and `clients.get(id).url` is the
frame's document (the engine's loader names a request's client by its document's URL, Host.cpp); a frame's navigation
has `clientId` `''` and the new document as `resultingClientId`, as in Chrome.

**What goes through it.** A document is controlled when its navigation URL is in an active registration's scope at
start (the navigation itself is then a `FetchEvent` with mode `navigate`, before the engine is given the document), or
when the active worker calls `clients.claim()`. Every request of a controlled document reaches the engine's loader,
which hands it to the host first (`ganglion_host_fetch`, with method, headers, body, mode, destination and credentials
since this change): if the controller has a `fetch` listener the request becomes a `FetchEvent`; `respondWith(r)`
answers it (the response's bytes go to the engine with `ganglion_fetch_done`), anything else falls through to the
engine's own network unchanged (`ganglion_fetch_network`), as the request would have gone without a worker. Module
scripts and chunks fetched by the segment's loader take the same road, so they are intercepted too.

**The worker's own network.** `fetch()` in the runner is Chitin's: the segment Worker sends the request over the
engine's network (`ganglion_net_request`: the engine's TCP through Spiracle and TLS in wasm; cookies by the request's credentials mode, docs/cookies.md), follows
redirects itself, and applies CORS for the site's origin: a cross-origin `cors` response without a matching
`Access-Control-Allow-Origin` is a network error, a `no-cors` one is opaque (status 0, no readable body; its bytes are
kept beside it so `respondWith` and `Cache.put` can still use them, as a browser's opaque responses work). Requests
from the runner never go through the page's own worker (no recursion), and never reach the host's network: the runner
has no `fetch`, `XMLHttpRequest`, `WebSocket` or `importScripts` of the host's (its `fetch` and `WebSocket` are Chitin's, over the same port: "WebSockets" below).

**CacheStorage.** `caches` in the runner (`open`, `has`, `delete`, `keys`, `match`; `Cache.match`, `matchAll`, `add`,
`addAll`, `put`, `delete`, `keys`, with `ignoreSearch`, `ignoreMethod`, `ignoreVary`), persisted per site in the
segment origin's IndexedDB through the segment Worker (like localStorage), so the next segment of the site sees it.
Registrations (scope, script URL, type, the installed script's bytes, the waiting version) persist the same way. A cache's
list of entries is one record without bodies; each body is a record of its own, written once (saving the list with its
bodies on every put was quadratic, and anura.pro's 251 chunks made records Chrome refused to store).

**IndexedDB across reloads.** The engine's databases (LibWeb's IndexedDB) live in its memory. Patch 0066
(`IndexedDB/Internal/Persistence.h`) gives the embedder a journal: after each committed readwrite transaction the records
it left stored (with their index records) and deleted and the key generators; after an upgrade transaction the whole
database; after `deleteDatabase`, the deletion. Values are LibWeb's storage serialization records as they are (LBSC). The
segment Worker appends each entry to its origin's database `chitin-segment-idb` (one connection kept open, writes in
commit order) and waits for pending writes before a navigation leaves. The next segment of the site replays the entries
after `engine.start()` and before the first navigation (a damaged entry is skipped and reported), then replaces them with
one snapshot. The Segment panel shows "IndexedDB restored". Reset site (Clear-Site-Data) clears it with the rest of the
origin. Durability is relaxed, as Chrome's default: a write still in flight when the tab closes is lost.

**IndexedDB, Web Locks, Cookie Store.** `indexedDB` in a runner (the page's service worker and its dedicated/shared
workers) is the page's: the runner's `IDBFactory`, `IDBDatabase`, `IDBTransaction`, `IDBObjectStore`, `IDBIndex`,
`IDBCursor(WithValue)`, `IDBKeyRange`, `IDBRequest`/`IDBOpenDBRequest`, `IDBVersionChangeEvent` and `DOMStringList` are
clients (pagesw.js) of a server in the segment Worker (pagesw-host.js, `idbServer`) that makes every call on the engine's
IDBFactory, so page and worker share one origin's databases as in Chrome. Scopes, names, key paths and schema checks are
answered in the runner from metadata; results arrive as events in request order. The engine runs a transaction's
requests only while it is active (inside its own requests' callbacks), so the runner's operations queue in the segment
and run at the next success on that transaction; a cheap `count()` keeps one request in flight while the runner may add
more (one `idle` per event it dispatched), and an upgrade of a new database holds a temporary store
(`__chitin_upgrade`, deleted before the commit, never shown). `navigator.locks` and `cookieStore` are the page's
LockManager and CookieStore the same way (a lock is held in the page's manager until the worker's callback settles).
Not yet: `signal` in `locks.request`, cookie change events, `navigator.storageBuckets` (the page has none either),
synchronous DataError for invalid keys in put/get (it arrives as the request's error event).

**Messages.** `controller.postMessage(data, transfer)` becomes an `ExtendableMessageEvent` in the runner with
`source` the page's client; `client.postMessage`, `clients.get/matchAll` (window clients, the one document) and
`event.source.postMessage` reach `navigator.serviceWorker`'s `message` event. A page's `MessagePort` in the transfer
list is bridged: the engine's port and a host port are joined in the segment Worker, so `workbox-window`'s
`messageSW` reply channel works.

**Streams.** A `ReadableStream`, `WritableStream` or `TransformStream` in a transfer list crosses every one of those
paths, as in Chrome (Scramjet's controller passes a Response body that way). The page's streams are the engine's; the
runner's and the segment Worker's are the host's. The engine cannot transfer one (its MessagePort transfer steps are
missing: the Worker constructor traps there) and the host cannot clone an engine object, so a transferred stream is
*bridged* (harness/segment/streams.js): a new stream of the other side whose source (sink, or both ends for a
`TransformStream`) is the old one's reader (writer), pulled one chunk at a time so backpressure holds. The old stream is
locked for good (`locked`, and `getReader()` throws), close, error, cancel and abort pass through, and a stream that is
locked, or in the message without being in the transfer list, is a `DataCloneError`, as in Chrome. Where each bridge sits:
`controller.postMessage(data, transfer)` (page to worker: engine streams become host streams, found anywhere in plain
objects, arrays, Maps and Sets); a reply port or `event.ports[0]` in both directions (an engine port's `postMessage` moves
streams inside the engine first, then the bridge hands them to the host port); `client.postMessage` and `worker.postMessage`
(host streams become engine streams before the page's `message` event); the engine's own `structuredClone(value, {transfer})`,
`MessagePort.postMessage` and `window.postMessage` (glue/engine/40-bridge.js: the new stream rides in the message as a
marker object, since the engine's serializer refuses a stream, and `MessageEvent.data` and the result of `structuredClone`
put the stream back). Not carried: streams in a `window.postMessage` to a cross-site iframe (the carapace forwards ports only),
nested ports in a message that also carries streams, and request bodies that are streams. The page has no dedicated Workers.

**Streamed responses.** The worker's `respondWith(response)` hands the body over as a stream. The page's `fetch()` of a
same-origin http(s) URL, when the page is controlled and the worker has a `fetch` listener, takes it as one: the Response's
body is a page stream fed chunk by chunk (pagesw-host.js `pageFetch`), so a body that is still being produced is readable,
`cancel()` and `AbortSignal` reach the worker's source, and a body that waits for a later message from the page does not
deadlock. A worker that does not answer lets the request go to the network once (no second `FetchEvent`). Everything else the
engine's loader fetches (navigations, scripts, stylesheets, images, XHR, cross-origin requests) still receives the whole
body: the engine takes bytes (`ganglion_fetch_done`), not chunks.

**Out of scope.** Push, notifications, background sync, periodic sync, background fetch, `cookieStore` in the worker, navigation
preload (the manager exists; `enable()` resolves and no preload is sent), `window.caches` in the page (the runner's
only), shared and nested workers controlled by the page's worker, idle termination of the runner (it lives as long as
its segment), streamed bodies for requests other than fetch() (see "Streamed responses"), HTTP cache semantics of `updateViaCache` (every update
check goes to the network), and preflights for non-simple cross-origin requests from the worker.

**Fail closed and the API allowlist still hold.** The real service worker is unchanged and still answers every
request of the segment Worker and the runner from the engine or not at all. The runner proves control before site code
and is stopped with the segment when control is lost. Its global goes through the same door removal and the same
allowlist of host members (a new Chrome door refuses the runner as it refuses a page). What the page's worker gains is
what the page already has: the engine's network for its own site, and its own site's storage in the segment origin.

### Page dedicated Workers: `new Worker(url)` in a runner

A page's dedicated Worker (`new Worker(url, { type, name })`, the principal window's and each same-site frame realm's)
runs in a runner like the page's service worker: a real Worker on the segment origin started by the segment document,
`harness/segment/pagesw.js` with kind `dedicated`, the same door removal and allowlist, its scripts through the segment's
service worker from the mirror (`importScripts` and module imports), its `fetch()` and WebSockets over its port to the
segment Worker and the engine's network. The page's side is `harness/segment/pagesw-host.js` (`makeWorker`):
- **The script** is fetched with the page's fetch (the engine: cookies, the site's CSP of the engine) and staged under its
  URL; a `blob:` or `data:` script is staged under a name of the site (`/__chitin_worker/<n>.js`), so the runner never
  needs `blob:` in its CSP. As in Chrome: an http(s) URL of another origin throws `SecurityError` in the constructor, a
  `type` other than classic/module a `TypeError`, a failed load or a non-JavaScript MIME type fires a plain `error` Event.
- **Messages** are the host's structured clone over the runner's port; transferred buffers are detached at
  `postMessage` (even while the runner is still starting), page `MessagePort`s are bridged as for service workers, streams
  ride along. Messages sent before the script ran wait for it (Chrome's port message queue).
- **Errors.** An uncaught exception in the worker (its top level, a listener, a timer) is an `ErrorEvent` on the `Worker`
  with Chrome's `Uncaught ...` message and the site's URL, line and column. `terminate()` and the worker's `close()` stop the
  runner. The runner's global has `postMessage`, `close`, `name`, `onmessage` and no service-worker names.
- **The worker's global** has `WorkerGlobalScope` and `DedicatedWorkerGlobalScope` (or `SharedWorkerGlobalScope`) as in Chrome:
  interface objects over the global's own prototype chain (the host's were removed with the doors), illegal constructors. A
  module worker's `importScripts` throws Chrome's `TypeError`.
- **Workers made by a worker** (`new Worker()` inside one) run in runners of their own started by the segment; the script
  resolves against the parent's URL (same origin, `data:`, or a `blob:` the parent made, which the parent reads from its own
  store), and messages, errors and `terminate()` go through the segment. Terminating a worker stops the ones it made.
- **SharedWorker.** One runner (kind `shared`) per script URL and name for the segment's site, shared by the principal window
  and its same-site frames; each `new SharedWorker()` makes a channel whose page end is `port` and whose other end arrives in
  the worker's `connect` event (`data` null as in Chrome, `source` the port). A script that fails to load fires `error` on every
  `SharedWorker` waiting for it; runtime errors stay in the worker, as in Chrome. Not shared across sites (each is its own
  segment, and Chrome keys shared workers by origin too).
- **Not yet.** `self.location` methods beyond the URL's parts, module `blob:`
  workers importing relative URLs (Chrome resolves them against the blob URL and fails too), and `Atomics.wait` on memory
  shared with the page (no `SharedArrayBuffer` across the port: docs/captcha.md, Decisions).

### OPFS: the origin private file system, per site

Decided and built 2026-10-22 (harness/segment/opfs.js). `navigator.storage.getDirectory()` and the FileSystem interfaces
exist for the page and for its page's virtual service worker, over the real OPFS of the segment origin. Each segment
is already its own origin (`s<hash(site)>.localhost`), so one site's files are invisible to another's, and they persist
with the origin like the IndexedDB the localStorage copy and the registrations live in. The page and its worker are two
Workers on that origin, so they see the same files; the browser's own locking between them applies unchanged.

**Contained, not exposed.** The file loads before the doors are removed (in the segment Worker and in the runner, right
before `doors.js`), captures the host's `StorageManager`, `FileSystemHandle` family and `WritableStream.getWriter` (the
doors delete them from the global and their prototypes afterwards), and hands the page its own classes: `StorageManager`,
`FileSystemHandle`, `FileSystemFileHandle`, `FileSystemDirectoryHandle`, `FileSystemWritableFileStream` (a subclass of the
page's `WritableStream`, so `pipeTo` and `instanceof` work), with Chrome's members, enumerability, lengths (taken from the
host's own functions), class tags and `Illegal constructor` / `Illegal invocation`. A page's handle is an object with no own
keys; the host's handle sits in a WeakMap slot only this file reads. Native errors (NotFoundError, TypeMismatchError,
InvalidModificationError, NoModificationAllowedError, QuotaExceededError, TypeError) are rethrown as the page's own
`DOMException`/`TypeError` with the host's message. Members this Chrome has and the file does not write out (`move`) are
forwarded generically, handles unwrapped and wrapped. Nothing here reaches the network, and no host object, function or
handle is reachable from the page (the door list and allowlist are unchanged: the names are defined after the check).
`createSyncAccessHandle` and `FileSystemSyncAccessHandle` exist only where `sync: true` is passed (a dedicated-Worker
context; a window and a service worker do not have them in Chrome either). `navigator.storage.estimate/persist/persisted`
are the host's for the segment origin.

**Known gaps** (WPT fs/, docs/results/wpt-fs-2026-10-22.json): a handle cannot be structured-cloned (postMessage,
IndexedDB, `structuredClone` copy it as `{}`: the engine's clone does not know it); `getFile()` copies the bytes into the
engine's `File` (a snapshot that is not lazy: the host's snapshot errors if the file is removed before it is read); no
`FileSystemObserver`, no page Workers, so no `createSyncAccessHandle` for pages yet; sandboxed-iframe rejection
(`opaque-origin`) and cross-window handle tests wait for iframes and windows.

### WebSockets: for the page and for its page's worker

Built 2026-10-22 (harness/segment/websocket.js). A site's `new WebSocket(url, protocols)` works, in the page and in the page's
virtual service worker, and nothing in the site is rewritten. The host's own `WebSocket` stays a door (doors.js removes it, and
`WebSocketStream`, from the segment Worker and the runner); what the page gets instead is RFC 6455 in JavaScript over a
*tunnel* on the engine's own network, so a socket follows the same road as a page's `fetch`: Spiracle's stream, the relay's host
and port allowlist, TLS in the engine against the trust store.

**The tunnel (engine/platform/Network.cpp: `open_tunnel`, `tunnel_write`, `tunnel_close`; Host.cpp `ganglion_tunnel_*`;
`api.tunnelOpen` in the glue).** An HTTP/1.1 request the host builds (the handshake: `Upgrade`, `Connection`,
`Sec-WebSocket-Key/Version/Protocol`, `Origin`), sent on a connection of its own (never pooled, no idle timeout), and when the
answer is `101` the connection becomes a byte pipe: bytes the server sends go to the host as they come, bytes the host writes
go through the TLS session. An answer that is not 101 ends the tunnel with an error; so does a failed connect, a refused
destination or a certificate the engine does not trust. The engine never interprets WebSocket frames; the host's events arrive
in a task of their own, in order.

**The class (websocket.js).** Chrome's interface: `url`, `readyState`, `bufferedAmount`, `extensions`, `protocol`, `binaryType`,
`close(code, reason)`, `send(string | Blob | ArrayBuffer | view)`, `onopen`/`onerror`/`onclose`/`onmessage`, the four constants
on both the constructor and the prototype, `Symbol.toStringTag`, an `EventTarget`; instances have no own keys. Errors are the
page's own `DOMException`s: `SyntaxError` (bad URL, a scheme that is not ws/wss/http/https, a fragment, an invalid or
repeated subprotocol, a close reason over 123 bytes), `SecurityError` (`ws:` from an https page), `InvalidAccessError` (a close
code that is not 1000 or 3000-4999), `InvalidStateError` (`send` while connecting). `http:` and `https:` URLs stand for `ws:`
and `wss:`; relative URLs resolve against the document. The handshake is checked the way the standard says (`101`,
`Upgrade: websocket`, `Connection: Upgrade`, `Sec-WebSocket-Accept` computed from the key with SHA-1, no extension nobody
offered, a subprotocol only from the offered list); a failure is `error` then `close` with code 1006. Frames: masked client
frames with 7-, 16- and 64-bit lengths, fragmented and interleaved-control messages reassembled up to 128 MiB, ping answered
with pong, text validated as UTF-8 (1007), unmasked server frames only (1002), the close handshake with Chrome's codes and
`wasClean`. Messages arrive as the page's `MessageEvent` with `binaryType` `blob` (the page's `Blob`) or `arraybuffer`. No
extensions are offered (no permessage-deflate). Events of the **page** are dispatched by the engine as trusted
(`api.dispatchTrusted`, `isTrusted` true); those of the **worker** use its own `dispatchEvent`, so `isTrusted` is false there (a
Worker's `Event` constructor cannot make a trusted one). A new document of the segment closes the old one's sockets.

**The worker's road.** The runner writes the frames and sends the bytes over its one MessagePort (`ws-open`, `ws-write`,
`ws-close`); the segment Worker (pagesw-host.js `wsOpen`) opens the tunnel and relays. It does not trust the handshake it is
given: the URL must be http(s) (and not `http:` for an https site), only the handshake's headers pass, and `Origin` is the
site's. The runner's sockets close with the runner. The runner still has no `XMLHttpRequest`, `EventSource`, `WebTransport` or
host `WebSocket`.

**Not built.** permessage-deflate, `WebSocketStream`, `WebTransport`, proxies (the handshake carries cookies since M4: the engine
adds them and takes the 101's Set-Cookie, docs/cookies.md), and the relay's port rule applies (80 and 443 only unless the operator widens it).

### Media: demuxed in the engine, decoded by the host

`<video>`, `<audio>` and Media Source Extensions keep LibWeb's own element and MSE code. Where Ladybird sends them to a
MediaServer process, the engine answers itself (engine/platform/Media.cpp) over an in-process IPC transport: LibMedia
demuxes (Matroska/WebM files, as they arrive; WebM and fMP4 source buffers), and each encoded sample goes to the segment Worker's
WebCodecs `VideoDecoder` (glue/engine/55-media.js), so decoding uses the host's own, often hardware, decoders and no
codec is bundled. Decoded planes come back into the engine and are painted from the display list's video sinks.
`canPlayType`/`isTypeSupported` answer from what the Worker's WebCodecs said it decodes (probed before the first page).

Audio: the enabled audio track's samples go to the Worker's WebCodecs `AudioDecoder`; its planar float PCM never comes
back into the engine. A Worker has no AudioContext, so the PCM goes over a port of its own (asked for with an
`audio-port` message, checked by the carapace's guard) to an AudioWorklet node in the carapace
(harness/carapace/audio-worklet.js): transferred Float32Arrays, no SharedArrayBuffer, everything bounded and checked
there. The worklet mixes each stream at its volume (muted is volume 0), resamples to the context's rate, and reports
straight back to the Worker, every 8 render quanta, the media time leaving the speakers (its position less the context's
output latency). While that output runs and is not starved, it leads the engine's media clock: a small difference is
slewed (the clock runs up to 25 % faster or slower until they meet, so currentTime never goes back), a lead of more
than 0.3 s jumps. Otherwise (no audio, or a context that does not run yet) the clock is monotonic and the engine tells
the output where it is every 100 ms, so it drops what has gone by. The engine keeps about a second of audio sent
ahead; playback waits (Buffering) when decoded audio does not reach the clock. A seek or a track change closes the
decoder, and its stream with it.

The autoplay policy is Chrome's (LibWeb's own BlockAudio policy with sticky activation): muted autoplay plays; play()
with sound needs a user activation of the page, which comes from the carapace's real input (a click or key on the
view), and is refused with NotAllowedError otherwise; unmuting a playing video without one pauses it. The carapace's AudioContext is created with the first audio port
and runs once the carapace has had a user activation (the same input, which resumes it); until then the media clock is
monotonic and muted video plays as before.

Encrypted media (docs/eme.md): EME calls are made on the segment document's own EME (the host's CDM; Chitin decrypts
nothing), and a MediaSource carrying encrypted media is handed to a host `<video>` there, shown at the page element's box
over the view.

### Ganglion: the engine

A real engine compiled to wasm, minus its JavaScript engine.
- Engine: Ladybird's LibWeb (HTML, CSS, layout, paint; BSD-2), built for wasm32 with LLVM 21 and Rust
  1.98, LibJS removed. Servo was the alternative; the comparison and reasons are in
  docs/research/engines.md.
- JS bindings are regenerated from Web IDL to target the host V8 realm instead of the engine's own JS
  engine. The long tail: live collections, named properties on window, `document.all`,
  `[LegacyUnforgeable]`, Proxies where needed.
- Every network API exposed to page JS (fetch, XHR, WebSocket, EventSource, WebTransport) goes through
  the engine's own network stack to Spiracle, never through the host browser's fetch.
- TLS is the engine's, in wasm, so the carapace and the relay only ever carry ciphertext.
- HTTP/2 (RFC 9113, nghttp2) when the server picks `h2` by ALPN, HTTP/1.1 otherwise: one connection per origin,
  RFC 9218 priorities from the fetch's destination and hint, server push off (docs/network.md, "HTTP/2").
- Painting: Skia (or the engine's painter) onto an OffscreenCanvas with WebGL2/WebGPU in the Worker.
  Canvas 2D and WebGL for page content can use the host's own implementations through OffscreenCanvas.
- Media: video decoded with WebCodecs in the segment (the host's hardware decoder); audio to the
  carapace's AudioContext.
- Garbage collection across the V8 heap and the engine's memory is the hardest problem: listener
  closures in V8 hold DOM nodes in wasm and back. Decided (docs/research/bindings-and-gc.md): neither
  WasmGC nodes nor a cycle collector; every engine-to-JS edge lives in V8 on a per-tree anchor that
  the wrappers reference, and the engine pins the anchors of what it can reach itself.

### Spiracle: the network

Insects breathe through spiracles. A Worker in the carapace that turns stream requests from segments
into connections.
- Normal mode: WebTransport to our relay, one stream per connection with a Wisp-style CONNECT header
  (type, host, port); datagrams for UDP (DNS, QUIC). Fallback: Wisp v2 over `wss://` when UDP is
  blocked.
- Tor mode, per tab: Arti in wasm (ethereum/tor-js, not webtor-rs), one isolation token per site.
  Guards reached through the relay as a plain TCP pipe by default; Snowflake only when the user's
  network blocks Tor. Named honestly: "hides your IP from sites", not anonymity.
- DNS: the relay's resolver or DNS over HTTPS; Tor RESOLVE in Tor mode.

### Relay: self-hosted

A separate service in this repo (relay/: built, docs/network.md section 2). The design and its
sources are in docs/research/relay.md.
- WebTransport plus Wisp v2, e.g. on webtransport-go and epoxy-server's policy model.
- No project accounts: an operator may require a shared secret or their own tokens for their relay;
  the Origin check stays on top (not as authentication).
- Destination policy: port allowlist, no private or provider ranges (checked on the resolved address),
  no inbound ports, scan detection, bandwidth limits.
- Abuse contact, security.txt, dedicated egress IPs, metadata-only logs kept 7-14 days.
- Shipped as a Docker image that people run themselves; there is no relay hosted by the project.
  The operator is responsible for what passes through it (docs/legal/relay-operators.md), and the
  image's defaults are the safe ones above.

### Molt: new identity

Clears a segment's storage and, in Tor mode, its circuits. Insects shed their shell to grow.

## What Chitin is not

- Not an interception proxy: no service worker of ours rewriting URLs or scripts, no stripped security
  headers, no shared origin for all sites. (A site's own service worker runs as the site wrote it, inside its own
  segment: "Page service workers" above.)
- A separate product. It does not depend on rvwasm and is not built for it.

## When a site does not work

Sites Ganglion cannot render yet open in the user's own browser, never through a proxy.

## Order of work

0. Prove the risky parts before building anything large:
   - a segment on its own domain with a Worker, a toy DOM in wasm and page JS on V8 calling it
     directly; measure call cost and layout reads on a framework-heavy page;
   - the GC design (WasmGC nodes or a cycle collector) on that toy;
   - frames to the carapace and input back, at 60 fps;
   - the engine choice: Ladybird (docs/research/engines.md).
1. Ganglion renders static HTML and CSS in a segment, network through a local relay.
2. Generated bindings: real sites with JavaScript; the event loop; forms, cookies, storage.
3. Spiracle and the self-hosted relay image with its safe defaults; Tor mode.
4. Media (WebCodecs video, audio), downloads, permissions.

## Risks

- Engine compatibility: Ladybird and Servo do not yet handle every heavy site; their gaps are ours,
  narrowed by inheriting V8's language and builtins.
- Cross-heap garbage collection.
- Toolchain: Ladybird needs C++23 with clang 19 or newer and Rust 1.98, so Ganglion cannot use the
  rvwasm toolchain (clang 18, wasm64); it targets wasm32 (docs/research/engines.md).
- The relay: cost and abuse handling are an operational job, not just code.
- Host browser dependence: Document-Isolation-Policy and process-per-site are desktop Chromium
  features today; other browsers get weaker isolation or none of the SharedArrayBuffer paths.
