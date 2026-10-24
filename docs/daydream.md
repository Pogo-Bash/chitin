# DayDream (daydreamx.pro/app/): what it found, and what its service worker needs

Status: 2026-10-22. DayDream is a Scramjet-based proxy site. It was the owner's first run of a site that wants its own service worker. Evidence: `tools/live-chrome.mjs` (Chrome for Testing, own ports, anonymous load, nothing clicked), `build/live/`.

## What failed, in the order it failed

1. **Module chunks 404** (engine 598a33c). The segment's module loader (`engineFetch` in harness/segment/worker.js) fetched every module file that is not a `*.example` test site from the harness's offline stand-in (`origin.localhost`), which only serves `harness/sites`. The entry module came from the engine, but each import of a hashed chunk (`/app/chunks/main-*.js`, `core-*`, `shared-*` ...) was a 404. Fixed: a real site's module bytes now come from the engine's own network (`api.fetchBytes`, the engine's `fetch` read from the engine global, not `window.fetch`, which a page may replace). Test: `tests/modules-net.test.mjs` (local TLS server, five hashed chunks, diamond imports, `import()`, modulepreload, each file fetched at most twice).
2. **`uncaught exception Error: [object ForeignObject]`**. The host threw something that is not an Error with the `[object Error]` tag (a DOMException, a subclass, a bare object); the engine knew only the runtime's class name of a foreign value. Fixed in `errorFromJS`: any thrown object becomes an engine Error cell that stands for it (the page gets its own object back from a catch), reported as `Name: message`, with the host's stack in the engine log. Test: `tests/engine-robustness.test.mjs` (hosterrors.example).
3. **Every IndexedDB read failed** (`TransactionInactiveError`; the app printed dozens of "Could not load X setting: DOMException"). The engine's IndexedDB made a transaction inactive right after the success event, but the page's promise jobs run on the host's V8 after the engine's task returns, so `await store.get(); store.put()` found it inactive. Fixed in Ladybird patch 0024 (step 8 of fire a success/error event and the microtask checkpoint's cleanup wait for the embedder's microtasks, `ganglion_microtask_turn_end`). Test: tests/storage.test.mjs.
4. **"engine fingerprint: Chitin unstamped"** after `make engine-stamp`: `make engine` (a dependency of every test target) copied the unstamped link over the stamped module. `build/ganglion.wasm` is a file target now; it is copied only when the link is newer.

## The black page and the title "Projects"

Not engine faults. "Projects" is DayDream's decoy identity (`cover.identity.title` in its config): the page shows it until the real app is entered. The body is `<div id="app-host">`, empty, and the background colour is `rgb(12,12,12)`: the app's startup (`navigator.serviceWorker.register(...)`, awaited together with the settings database and the profiles store in one `Promise.all`) rejects, so nothing is ever mounted.

## Acceptance case for page service workers (implemented 2026-10-22, see below)

What the page's startup does, from its bundle (chunks/main-*.js, assets/s.js):
- `navigator.serviceWorker.getRegistrations()` on DOMContentLoaded, unregisters registrations whose scope is not its own (once per session, `sessionStorage`).
- `navigator.serviceWorker.register('sw.js' resolved under /app/, { scope })`, then `await navigator.serviceWorker.ready`. Today this rejects: `SecurityError: Service Worker registration has incompatible script and referrer origins` (the Worker's real origin is the segment's `s<hash>.localhost`, the page's is `https://daydreamx.pro`).
- `navigator.serviceWorker.controller.postMessage(...)` (rule updates to the worker), so the page must be controlled.
- Scramjet's own client keeps `this.global.navigator.serviceWorker`.
What the worker therefore needs from Chitin: a registration on the segment's origin for the page's script URL and scope, served from the site (unmodified bytes, over the engine's network); install/activate lifecycle with `skipWaiting` and `clients.claim()` so the page is controlled at once; `ready`, `controller`, `getRegistrations`, `unregister`; `fetch` interception of the page's own requests (documents, scripts, subresources, `fetch`/XHR) in scope, with `respondWith`, `Request`/`Response`/`Headers`, `fetch()` from the worker to the network (through the engine's network, never the host's), `postMessage` both ways, `clients.matchAll`. And one decision for the owner: such a worker is site code that rewrites traffic inside the segment; Chitin's own segment worker (the module loader, and the fail-closed host-network guarantee) must stay separate from it (two workers, or the page's worker nested below ours).

## Also seen, not fixed

- `navigator.storage.getDirectory` (OPFS) is missing: a `pageerror` at startup.
- `SharedWorker` is undefined (by design, no page Workers): the app falls back to main-thread storage.
- Third-party scripts (googletagmanager, bauval.org) are refused by the relay allowlist: "Refusing to run script because the element's result is null."
- The segment's control probe (`hello.mjs?nonce=...`) is an import every 5 s and before each module graph: dozens of requests in DevTools. Harmless; a cheaper probe is possible.

## With page service workers (2026-10-22)

Page service workers run virtually in the segment (docs/architecture.md, "Page service workers"). Two anonymous loads
with `tools/live-chrome.mjs https://daydreamx.pro/app/index.html --host daydreamx.pro --host '*.daydreamx.pro'
--relay-log 2` (build/live-dd1, build/live-dd2):

- `register('sw.js')`, `ready` and `controller` resolve; the app's startup `Promise.all` no longer rejects and the app
  mounts: the sidebar, the tab strip, the proxy's own address bar ("Search or enter website name") paint, instead of
  the black page. Its worker (`[DDXWorker]` in the console) runs in the runner, intercepts the page's requests (it
  answers some and lets others through, "handleRequest failed, passing through"), and its `fetch()` goes over the
  engine's network.
- The relay log shows only daydreamx.pro:443 for the site itself. The worker also forwards Google Analytics beacons
  (www.google.com/g/collect, www.google-analytics.com/g/collect), which the allowlist refuses, as it should.
- Next blocker: OPFS. Both the page (`navigator.storage.getDirectory is not a function`, an unhandled rejection in its
  runtime chunk) and the worker (`ensureWisp failed: Cannot read properties of undefined (reading 'getDirectory')`, and
  its pre-cache of /json/{g,c,p,t}.json, which waits for the same storage) need `navigator.storage.getDirectory`. The
  worker keeps its Wisp/transport settings there, so no proxied site can load until Chitin has OPFS (per site, in the
  segment origin's storage, for the page and the runner). After that: Scramjet's transport (a WebSocket to its Wisp
  server through the engine and the relay allowlist) and `SharedWorker` (by design absent; the app falls back).

## With OPFS (2026-10-22, branch opfs)

OPFS exists for the page and for the page's worker (docs/architecture.md, "OPFS"). Two anonymous loads with
`tools/live-chrome.mjs ... --relay-log 2` (build/live-dd-opfs1, -opfs2; the second also allowed fonts.cdnfonts.com, which
the worker fetches for a font stylesheet):
- Both walls above are gone: no `getDirectory is not a function`, no `ensureWisp failed ... reading 'getDirectory'`. The app
  mounts (sidebar, tab strip, "ddx://newtab" address bar, "New Tab").
- **Next wall, as predicted:** `[DDXWorker] ensureWisp failed: ReferenceError: WebSocket is not defined` (Scramjet's Wisp
  transport; the runner has no `WebSocket` by design, a Wisp client needs one through the engine and the relay's allowlist),
  repeated for every request the worker takes. `SharedWorker is not defined` (falls back to main-thread storage) and
  one `Unexpected end of JSON input` from a page `JSON.parse` remain.
- **An engine stop, earlier in the load and the real freeze:** `VERIFICATION FAILED: document->current_script() == nullptr`
  at HTMLScriptElement.cpp:225 (the `Module` branch of "execute the script element"), at about 400 ms; after it the wasm traps
  (`unreachable, in pump`) and every later pump, frame and network callback throws "the engine stopped", so the painted app
  never updates. A module script reaches that line while a classic script is still `currentScript` and `old_current_script`
  was null-held; the assertion is Ladybird's, the held-for-microtasks logic above it is ours (`s_current_script_held_for_microtasks`).
  Suggested fix: in the Module branch, if `current_script()` is non-null, set it to null for the run and restore it after
  (the spec's `currentScript` is null inside a module). Not done here (the engine build is shared).
- Relay log: only daydreamx.pro:443 for the site; the worker also tries `www.google.com/g/collect` (analytics), refused.

## With WebSocket and the currentScript fix (2026-10-22, branch ws)

Two engine/segment changes: patch 0025 (the hold of `document.currentScript` for the embedder's microtasks belongs to one
document, and a module script runs with `currentScript` null whatever was left; the old global flag was cleared by a script of
another document, which left the first document's `currentScript` set and tripped `VERIFY(current_script() == nullptr)`), and
WebSocket for the page and for its worker (docs/architecture.md, "WebSockets"). Four anonymous loads with
`tools/live-chrome.mjs https://daydreamx.pro/app/index.html --host daydreamx.pro --host '*.daydreamx.pro' --host fonts.cdnfonts.com
--relay-log 2` (build/live-dd-ws1 .. ws4; the relay allowlist is the site, its subdomains and the font host, nothing else):

- The `currentScript` stop at about 400 ms is gone in all four. `ensureWisp failed: WebSocket is not defined` is gone: the
  Segment panel's new `websockets` line shows the page asking for two WebSockets, both upgraded (the site's Wisp server,
  through the engine's tunnel, Spiracle and the relay), one still open at the end. The document title becomes "DayDream X" (the
  real app, not the decoy "Projects").
- **One run of four (ws1) stopped with another engine assertion:** `VERIFICATION FAILED: vm().execution_context_stack().is_empty()`
  at EventLoop.cpp:1460 (`perform_a_microtask_checkpoint` entered with a JavaScript execution context still on the stack), a
  second after the document, right after the first "Refusing to run script because the element's result is null" (the
  refused googletagmanager script); then the wasm traps in `pump` as before. It did not repeat in ws2 to ws4 and a Node page with
  refused scripts, error handlers and promise jobs does not reproduce it, so it is timing-dependent; the engine now logs the wasm
  frames of the first trap (`trap in <entry>: ...` in the engine log, glue/engine/90-boot.js), so the next occurrence names the
  caller. Not fixed here.
- **Next wall, reproducible offline:** the app's favicon fetch (and every request through its proxy transport) fails with
  `TypeError: [object Array] is not iterable`. Minimal case in the page, under Node: `new Headers(new Headers([["a","b"]]))`,
  `new Response("x", { headers: new Headers([["a","b"]]) })`, `new Request(url, { headers: new Headers({a:"b"}) })` and
  `new URLSearchParams(new URLSearchParams("a=b"))` all throw it, while the same objects built from a plain array or a `Map`
  work, and a non-empty engine `Headers`/`URLSearchParams` handed to an IDL `sequence<sequence<...>>` conversion is the
  common shape. The pair arrays the engine's own pair iterator makes are not iterable to the engine's own conversion
  (LibJS `get_method(@@iterator)` on an array the runtime facade created); Scramjet and libcurl.js build `Headers` from `Headers`.
- Seen, unchanged: `SharedWorker` is undefined (the app falls back), one `Unexpected end of JSON input` from a page
  `JSON.parse` (several per load), the worker's analytics beacons refused by the allowlist (`www.google.com/g/collect`,
  `www.google-analytics.com/g/collect`), the third-party GTM script refused ("result is null").

## With the iterable fix (2026-10-22, branch fix2)

Cause of "`[object Array] is not iterable`": the runtime's `%Array.prototype%` and `%Iterator.prototype%` (engine/libjs-runtime)
had no `@@iterator`. The `[key, value]` pairs an engine iterable yields are the engine's own arrays, and WebIDL's
`sequence<sequence<>>` conversion (`GetMethod(@@iterator)`) could not iterate them; `Headers(entries())` fell through to the record
branch of the union and gave an empty Headers. Both now have `@@iterator` (Array's is `values`, which also exists). Tests:
tests/iterables.test.mjs, and a chrome-test group that compares 14 conversions with Chrome's. Two anonymous loads
(build/live-dd-fix2-1, -2; relay allowlist daydreamx.pro, *.daydreamx.pro, fonts.cdnfonts.com):
- No `not iterable` any more; the app mounts, title "DayDream X", 34 requests, 0 failed, the Wisp WebSocket upgrades.
- **Next wall: the new-tab page stays empty (`ddx://newtab/`, no tiles), and the app's file layer (a "TFS" over OPFS) fails:**
  an unhandled rejection `SyntaxError: Unexpected end of JSON input` from `JSON.parse(await file.text())` of `.TFS_STORE`
  (chunks/vendor-*.js, the helper that reads `.TFS_STORE` right after `getFileHandle(".TFS_STORE", {create:true})`), and a
  page error `NotFoundError`. The app's own init removes the root (`(await navigator.storage.getDirectory()).remove({recursive:true})`),
  then creates and writes `.TFS_STORE`; a second TFS instance (page and worker) reads it in between. So either OPFS lets a
  reader see the created-but-not-yet-closed file as empty where Chrome's swap-file semantics do too but faster, or the root `remove()`
  or the order of create/createWritable/close differs from Chrome's. Next step: run the same sequence in Chrome and Chitin
  (a test site doing it twice concurrently) and compare.
- The rare `VERIFICATION FAILED: vm().execution_context_stack().is_empty()` (EventLoop.cpp:1460) came back in one of the two runs
  (fix2-1, after the refused GTM script); the page then stops (engine trap in `pump`). Still unfixed; the trap's wasm frames
  did not reach the result's status lines.
- Unchanged: `SharedWorker` undefined (falls back), the worker's analytics beacons refused by the allowlist.

## The TFS store, the page service worker, and the wall after them (2026-10-22, branch tfs)

- **OPFS is not the divergence.** DayDream's file layer (`.TFS_STORE`: `root.remove({recursive:true})`, create, write, read, from two instances) is reduced to
  harness/sites/tfs.example and run in Chrome for Testing 154 and in Chitin: every step answers the same (`remove` on the root ok, a listing of the
  removed root `NotFoundError`, a fresh `getFileHandle(create)` reads `""` until the writer closes, the stale handle still works). The one
  `Unexpected end of JSON input` (`Tt`, a read of the file the constructor is still writing) is thrown in Chrome too: DayDream's page shows the same
  unhandled rejection there. chrome-test group "OPFS: the TFS sequence" keeps the answers. The new-tab page is empty for another reason: its
  `/app/internal/newtab` iframe is a same-site iframe and **scripts of a frame's document do not run** (docs/architecture.md, "One realm"): the
  iframe's `vendor-*.js` builds the shortcuts (`window.shortcutsManager` is undefined in the frame), so its shortcuts section stays empty. That is
  the next wall: per-frame script contexts.
- **The engine stop was the real freeze** (`VERIFICATION FAILED: execution_context_stack().is_empty()`, EventLoop.cpp:1460, about one load in three,
  the page and every later call dead). Frames of the first trap now reach the host console (`trap in pump: ...`): `ws.close()` inside the `open` event
  of the Wisp socket writes a frame to the tunnel, whose host call `api.pump()` ran timers and a microtask checkpoint while the `dispatchTrusted`
  call that fired `open` was still on the stack. glue/engine/90-boot.js counts engine calls on the stack and runs a nested `pump` when the outermost
  call returns. Test: tests/websocket.test.mjs (close/send in the open handler, six sockets, a 1 ms promise timer).
- **import() in classic scripts** (the owner's InvisiProxy and DayDream runs): a classic script runs from a name under the segment's mirror, so
  `import('/libcurl/index.mjs')` went to the segment origin's root and 404ed. harness/segment/sw.js maps a same-origin request whose referrer is a
  mirror name to the same path on that site. chrome-test group "dynamic import() in classic scripts".
- **Charset:** `Content-Type: text/html` and a `<meta charset>` past 1024 bytes decoded as windows-1252; engine/platform/Host.cpp now finds a late
  declaration in the head before parsing (the spec's restart, done from memory). tests/charset.test.mjs.

## With frame realms (M6, 2026-10-22, branch m6)

One anonymous load (`tools/live-chrome.mjs https://daydreamx.pro/app/index.html --any-host --wait 60000`, build/live-m6-dd2, on
m6 with main 1b1bea5..ec3c9e3 merged): the same-site `/app/internal/newtab` iframe now runs its scripts in its own realm
(docs/architecture.md "Frame realms"): its classic global-slot script, its module chunks (a graph of the frame's: the chunks it
shares with the app shell are evaluated again for it, under `/__chitin/r/1/o/https/daydreamx.pro/...`), `window.shortcutsManager`
is an object and **the shortcuts section has its 12 tiles**. 34 requests, 0 failed, no engine stop. (A first load on m6 before
main was merged stopped in a microtask checkpoint, `realm_execution_context() == running_execution_context()`, with frame realms
on and off alike; gone with main's fixes.)

- **Next wall:** the page's own worker (DDXWorker) was asked for a frame module's `import.meta.url`-relative file at its mirror
  name (`http://<segment>/__chitin/r/1/o/https/daydreamx.pro/app/chunks/main-*.js`) and the relay refused it; the segment now maps
  such a URL back to the site's file before the page's worker and the engine's network see it (worker.js `fetch`), not yet
  re-run live. Still there: an unhandled `Error: i/o error` from vendor-MbGcQkEc.js (the file layer), `SharedWorker` undefined
  (falls back), `Unexpected end of JSON input` (also in Chrome, docs above).

## Through Scramjet to Wikipedia (2026-10-22, branch dd)

Runs: `tools/live-chrome.mjs https://daydreamx.pro/app/index.html --any-host` with an `--act` that clicks the new tab's
Wikipedia tile and then the portal's "English" link; the same act in Chrome for Testing 154 on the live site is the
reference. The mirror-URL fix in harness/segment/worker.js holds (no relay refusal of a `/__chitin/r/...` name).

- **Same-site frames painted nothing** (the new tab's 12 tiles were laid out, the view was black). LibWeb draws an iframe as its
  content navigable's compositor context, and the engine has no compositor host. Patch 0030 + Host.cpp `paint_child_context`
  (docs/architecture.md "Frame realms", Painting). The new tab now looks like Chrome's (icons, the obfuscated font's text).
- **Wisp frames arrived empty**: main's structured clone read-back (yt3) turned a Uint8Array given to `new MessageEvent` into an
  empty one, so DayDream's proxied fetches never completed and the tab never navigated (the favicons fell back to the grey
  circle). Fixed in 40-bridge.js `readClone`; tests/structuredclone.test.mjs.
- **prefers-color-scheme** was always light; it follows the host browser now (the portal is dark in both on a dark Mac).
- **MessagePorts in transfers** work in the engine (patch 0029), which DayDream's codec bootstrap and Scramjet's frame bridge use.

After these: the Wikipedia tile opens `https://www.wikipedia.org/` inside DayDream's Scramjet frame with its client installed
(`_ddx$*` globals, the frame's URL unrewritten to the site's as in Chrome), logo and globe painted; "English" goes on to
`https://en.wikipedia.org/wiki/Main_Page`, which renders as Chrome's does (header, featured article and its image).

- **Still different:** CJK text is tofu (no CJK font in the engine); the ellipsis of a truncated tab title is tofu in the shell's
  obfuscated font (Chrome falls back to another font for U+2026); Wikipedia's reading-preferences (glasses) button is absent in the
  header; 4 of 23 images loaded at 25 s against Chrome's 6; the vendor chunk's unhandled `i/o error` / `no such file or directory`
  (the file layer) is still there.
- **Next wall:** font fallback for characters the page's font lacks (CJK, U+2026), then the lazy images and Wikipedia's client-side
  header features.

## Font fallback and the file layer's i/o error (2026-10-22, branch fonts)

- **Font fallback** (docs/fonts.md): text the page's fonts lack takes a glyph from a base face (U+2026 in the shell's obfuscated
  font) or from a Noto subset loaded on first need (CJK, Arabic, Hebrew, Indic, Thai, symbols, math, colour emoji).
- **`Error: i/o error`** is the vendor chunk's name for a `NotReadableError` (its `l()` maps error names to errno). The segment's
  OPFS copied a File's bytes inside `getFile()`, so a writer closing at the same moment made `getFile()` itself reject, which
  Chrome's never does (its File is read later, and only that read can fail). harness/segment/opfs.js now answers the snapshot
  and makes the page File's reads reject as Chrome's do (stale or removed file). harness/sites/opfsio.example, chrome-test group
  "OPFS edge cases", has the answers from Chrome for Testing 154 (main thread and Worker agree). Not yet re-run live.
