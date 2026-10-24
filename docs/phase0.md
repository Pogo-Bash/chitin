# Phase 0: results

Status: 2026-10-11. Everything below was built and measured on the Mac (M4 Max, shared with other
work). Node figures are measured. Chrome figures come from the owner's runs of
docs/user-tests/phase0.md: the first run is in section 9; frame and benchmark figures are still to
be filled in.

| Item | Where | State |
|---|---|---|
| Toolchain: clang 21, libc++, Wasm EH, wasm32 | docs/toolchain.md, `tools/` | done; Emscripten 4.0.11 pinned |
| Toy DOM in C++ (LibWeb-shaped), flat C exports | `toy/engine/` (81 KiB wasm) | done |
| Binding generator on Ladybird's IDL parser | `bindings/generate.py`, `third_party/ladybird/`, `toy/idl/` | done; 12 interfaces, 76 generated exports |
| Glue hardened Node-primordials style | `glue/` → `build/ganglion.js` | done, with tests |
| GC anchor scheme on the toy | `toy/engine/Heap.cpp`, `glue/10-runtime.js`, `tests/gc.test.mjs` | done; 12 tests |
| Call costs under Node | `bench/`, `make bench` | measured (below) |
| Call costs in Chrome | `harness/bench/` | page ready; owner to run |
| Segment harness | `harness/` | built; owner to run |
| Module loader + sourceURL | `harness/segment/sw.js`, `worker.js` | verified in Chrome 154 (owner's first run, section 9) |

Run everything native with `make && make test && make bench`. `make test` runs 28 tests: bindings,
GC, and a simulation of the segment Worker and service worker in Node vm contexts
(`tests/harness.test.mjs`).

## 1. The toy engine

C++23, `-fno-exceptions -fno-rtti -Werror` like Ladybird, about 2,400 lines in `toy/engine/`:

- `Wrappable` base with a handle (index << 8 | generation) and a "has live wrapper" bit, as
  `Web::Bindings::Wrappable`.
- `EventTarget`, `Node`, `CharacterData`, `Text`, `Element`, `HTMLElement`, `Document`,
  `CSSStyleDeclaration`, `Range`, `Event`, `MouseEvent`, `KeyboardEvent`. Methods are named as in
  LibWeb (`pre_insert`, `pre_remove`, `append_child`, `dispatch_event_for_bindings`, …) so the
  generator's naming convention is Ladybird's.
- Errors as `ExceptionOr<T>`; DOM exceptions cross as codes.
- Listeners and dispatch: capture, target and bubble phases, `once`, `passive`, stopPropagation,
  stopImmediatePropagation, a snapshot of listeners per invoke.
- Style, layout and paint, trivial on purpose: inline style only, block boxes, absolute
  positioning, 8×16 px monospace text, a display list of rectangles and text runs.
- A mark/sweep collector run only at task boundaries (`ganglion_collect`), standing in for LibGC.

## 2. The binding generator

`bindings/generate.py` imports Ladybird's `Meta/Utils/webidl_parser.py` unmodified (vendored from
`975740c` with its BSD-2 licence; credited in CREDITS.md). The IDL in `toy/idl/` is a subset of
Ladybird's own files. From it the generator emits:

- **JS classes** (`build/gen/bindings.gen.js`), one per interface, extending their IDL parent:
  - WebIDL conversions inline: ToString via template literals (so Symbols throw), ConvertToInt via
    `|0`/`>>>0`, finite-double checks, dictionaries read in WebIDL member order,
    `[LegacyNullToEmptyString]`, nullable types, argument counts.
  - Brand checks on private fields: every class has a `#brand`, so `#brand in o` is exactly "o
    implements this interface". Page JS cannot forge or read a handle.
  - Property shapes per WebIDL: enumerable accessors and operations, constants on interface and
    prototype, `Symbol.toStringTag`, `[Unscopable]`, `[LegacyUnforgeable]` own accessors,
    `[PutForwards]`, interface `length`, illegal constructors.
  - `[FlyString]` results cross as atom ids and are cached as JS strings.
- **C exports** (`build/gen/Bindings.gen.cpp`): one `extern "C"` function per member. It resolves
  handles (trapping on a wrong type: the glue already checked the brand, so a mismatch is a glue
  bug), calls the implementation, and encodes the result (Bindings.h describes the ABI).
- **The interface id table** (`InterfaceIds.gen.h`).

`[ImplementedInBindings]` members (`addEventListener`, `removeEventListener`) and interfaces
(`DOMRect`) are hand-written in `glue/custom/`, as Ladybird does.

## 3. The GC anchor scheme: implemented, tested, changed in two places

Implemented as in bindings-and-gc.md section 3: engine → JS edges (listener callbacks) live in V8 on
per-component anchors; wrappers hold their component's anchor in a private field; the engine pins
the anchors of components it can reach from real roots; components merge on insert and split on
remove; a FinalizationRegistry clears the engine's "has live wrapper" bits.

Two changes came out of profiling (`--cpu-prof`), where anchor upkeep dominated `createElement` and
`appendChild`:

1. **Anchors are lazy.** A component gets an anchor only when it holds two or more JS items
   (wrappers or listener edges), or when it is pinned and holds one. A lone wrapper keeps itself
   alive, so an anchor would add nothing. When a second item appears, the engine creates the anchor
   and adopts the component's existing wrappers into it.
2. **Merges link instead of copying.** The inserted component's anchor becomes a child of ours
   (union-find). Its wrappers keep the top anchor alive, and the top keeps them alive; only listener
   edges move, because they always live on the top anchor. Moves between trees go anchor to anchor;
   moves within a tree cost nothing.

`createElement` fell from 1.09 µs to 0.22 µs and the VDOM "create 1000 rows" from 24 ms to 9 ms.

**Wrappers of a live component are preserved** (Blink semantics), not only those with expandos
(Ladybird's "preserved wrapper"). V8 gives no hook to notice an expando being added, so
preservation on demand is not possible. In practice, every wrapper of a node that is reachable keeps
its identity and expandos, which is what jQuery-style `el[expando]` data needs.

### Test results (`make test`, Node 22.14, V8 12.4, `--expose-gc`)

```
ok   gc.test.mjs > wrapper identity is stable while a wrapper lives
ok   gc.test.mjs > expando on an attached element survives GC (wrapper preserved by the pinned document)
ok   gc.test.mjs > expando inside a detached tree survives while JS holds another node of the tree
ok   gc.test.mjs > listener cycles on detached trees are collected  [2000 cycles, 6000 nodes freed, pinned anchors 1]
ok   gc.test.mjs > live trees survive: listeners on attached nodes fire after GC with no JS references
ok   gc.test.mjs > removed subtree keeps its listeners while JS holds it, and they work after reinsertion
ok   gc.test.mjs > split: a removed subtree nobody holds is freed, the rest of the document keeps its listeners
ok   gc.test.mjs > merge: a detached tree with listeners inserted into the document survives without JS references
ok   gc.test.mjs > standalone EventTarget: listeners live with the target
ok   gc.test.mjs > page subclasses of EventTarget and Event are their own wrappers
ok   gc.test.mjs > known leak class: an engine edge out of a JS-held component pins what it reaches  [leaked per cycle: 1 node + 1 Range in the engine, ~4886 B of V8 heap; rule off frees them but loses listeners]
ok   gc.test.mjs > stress: random mutations, listeners and drops keep every reachable listener and free the rest  [6000 steps, 884 listeners, 6 checkpoints, 624 reachable at the end, merges 317, splits 678]
```

- **Listener cycles on detached trees are collected.** 2,000 trees, each with the classic cycle
  (closure → wrapper → node → listener → closure) on two nodes: all 6,000 engine nodes are freed,
  and WeakRef probes confirm that V8 collected the closures.
- **Live trees survive.** 50 attached elements with listeners and no JS references survive GC. A
  trusted click from "the carapace" (engine hit test) and `dispatchEvent` both reach them.
- **Split and merge.** A removed subtree held by JS keeps its listeners and works after
  reinsertion. One nobody holds is freed while the rest of the document keeps its listeners. A
  detached tree inserted into the document keeps its listeners without JS references.
- **Stress.** 6,000 seeded random steps (create, append anywhere, remove, add listeners, drop
  references, collect). At 6 checkpoints, every listener on a reachable node fires exactly once,
  with no lost edges and no anchor recreated. After dropping everything, the engine is back to its
  3 document nodes.

### The known leak class, measured

The case: a detached tree A, a Range R whose start is in A (an engine edge V8 cannot see), and a
listener on A whose closure holds R.

- With the conservative rule ("components reachable from a live wrapper through engine edges are
  pinned"), every such cycle leaks: 1 node and 1 Range in the engine, and about 5 KB of V8 heap
  (heapUsed delta, rough), per cycle, for as long as the page lives.
- Without the rule, the cycles are collected, but a node that is still reachable loses its
  listener. The test keeps only the Range, collects, then dispatches on `range.startContainer`: the
  listener has died and the engine dispatched to a dead edge. So the rule must stay. The leak is
  the price.
- What makes a leak: a JS-visible object holding a non-tree engine reference (Range, and in LibWeb
  also NodeIterator/TreeWalker roots, observers' targets, `AbortSignal` sources, selection) into a
  component whose own listeners close over that object.
- How often it happens on real sites can only be measured on a corpus with LibWeb (phase 2).
  Ladybird's wrapper tests (`Tests/LibWeb/Text/input/include.js` `withCollectedWrapper`) are the
  starting point.
- **Mitigation for phase 2:** the engine knows these edges. It can report, per collection, how many
  pinned components are pinned only by the rule, and a component pinned that way whose listeners'
  closures are themselves unreachable from anything else is the leak. We cannot see closures, so
  the counter is the most we get.

## 4. Glue hardening

Page JS shares the Worker realm with the glue, so `glue/00-primordials.js` captures every builtin
before page code runs. The glue never:

- calls a method through a patchable prototype (uncurried captured functions only);
- keeps state in objects or arrays with a prototype (null-prototype tables and lists, because a
  page can define `Array.prototype[0]` setters that see every value written);
- hands a view of linear memory to anything that reads `.length`, `.buffer`, `.constructor` or
  `Symbol.species`. Typed arrays are only indexed. A patched `%TypedArray%.prototype` getter that
  received a view could reach `memory.buffer`, and with it HttpOnly cookies and every other
  frame's state. Strings out of the engine are built by indexing or by a captured `TextDecoder` on
  a fresh view;
- runs in sloppy mode: in strict frames V8's `Error.prepareStackTrace` CallSites return undefined
  for `getFunction()`/`getThis()`, so page JS cannot get hold of glue functions or receivers.

Tests (`tests/bindings.test.mjs`):

- One test patches 16 builtins and accessors after boot (`Array.prototype[0]`,
  `Object.prototype.edges` and `.wrappers`, `%TypedArray%.prototype.buffer/length`, `Uint16Array.prototype.constructor`,
  `String.prototype.charCodeAt`, `WeakRef.prototype.deref`, `FinalizationRegistry.prototype.register`,
  `WeakMap.prototype.get`, `Map.prototype.set`, `Reflect.apply`, `Function.prototype.call`,
  `TextDecoder.prototype.decode`, `Math.floor`, `String.fromCharCode`), then runs a DOM workload
  with events and GC. The glue calls none of them, and no view of linear memory reaches page code.
  Its sensitivity was checked: one `s.charCodeAt(i)` put back into the glue makes it fail.
- Another uses `Error.prepareStackTrace` from inside a listener: every glue frame hides its function
  and receiver.

The segment Worker's host script also hides `postMessage`, `onmessage`, `importScripts`, `fetch`,
`XMLHttpRequest`, `WebSocket`, `EventSource`, `WebTransport`, `Worker` and `close` from page JS.
The Worker's CSP allows `connect-src` only to the network stand-in, so a host network API we miss
fails instead of leaking.

Gaps that remain (phase 2):

- `await` on a native promise reads `promise.constructor` (PromiseResolve), which a page can
  observe. The glue avoids awaiting after page code starts.
- A page can `self.addEventListener('message')` and see what the segment document sends the Worker
  later (in the harness: input in direct mode, re-sent service-worker ports). The fix is to move
  everything after start onto private MessagePorts, which the carapace port already is.
- Emscripten's own JS runtime is not hardened; the toy does not use it (docs/toolchain.md).

## 5. Call costs

### Under Node (measured)

Node 22.14.0, V8 12.4.254.21, Apple M4 Max, load average 2.0. Each figure is the best of 3 runs of
a median over 9 rounds. Each round is its own task, with the engine's collection between rounds.

| Boundary (toy engine) | ns |
|---|---|
| empty wasm export call | 2.3 |
| export call with handle check | 4.8 |
| `wrap(handle)`, cached wrapper | 15.3 |
| string in, 8 / 64 / 4096 chars (copied into an engine String) | 34.6 / 140 / 8,110 |
| string out, 8 / 64 / 4096 chars | 47.1 / 103 / 2,720 |
| `document.body` getter (export + wrap) | 21.7 |

| DOM operation (toy, through generated bindings) | ns |
|---|---|
| `createElement('div')` | 223 |
| `setAttribute('data-x', 'value')` | 48.1 |
| `getAttribute('data-x')` | 70.7 |
| `el.id = 'a'` | 18.4 |
| `appendChild` (moving 1000 wrapped nodes into a fresh container) | 293 |
| `firstChild`/`nextSibling` walk, per step | 33.1 |
| `style.setProperty('width', …)` | 107 |
| `offsetWidth`, layout clean | 11.0 |
| `getBoundingClientRect()`, layout clean | 21.4 |
| style write + `offsetWidth` read, ~10 nodes in the document | 186 |
| style write + `offsetWidth` read, ~1000 nodes (the toy relays out everything) | 8,090 |
| `dispatchEvent(new Event)` to one listener | 430 |

| Cross-thread alternative (two Node threads, SharedArrayBuffer + Atomics) | ns |
|---|---|
| round trip with `Atomics.wait` / `notify` | 693 (3,200 to 5,300 when the Mac was loaded) |
| round trip with both sides spinning (burns a core each) | 112 |

| Preact-style keyed VDOM, 1000 rows (toy) | ms |
|---|---|
| create 1000 rows | 9.14 |
| replace all 1000 rows | 14.4 |
| partial update (every 10th label) | 1.48 |
| select row | 1.39 |
| swap rows 2 and 999 (this naive diff moves ~1000 rows) | 4.13 |
| remove one row | 1.36 |
| clear 1000 rows | 3.29 |
| partial update + `offsetHeight` read | 1.54 |

What it shows:

- **The boundary itself is nearly free.** An export call is 2–5 ns; a getter that returns a node
  is ~20–30 ns including the wrapper lookup. The cost of a binding is the work on either side.
- **Strings are the main per-call cost.** In: ~2 ns per UTF-16 unit for the copy loop. Out: a
  `TextDecoder` above 32 units. Atoms (`tagName`, `nodeName`, `localName`, event types) are cached
  per id and cost nothing after the first time. If strings dominate real profiles, the fix is an
  engine-side string cache keyed by JS string identity, or `wasm:js-string` builtins
  (bindings-and-gc.md).
- **Wrapper creation is the main per-object cost**, about half of the 223 ns `createElement`: a
  JS object, a WeakRef and a FinalizationRegistry registration. WeakRef creation is ~40 ns in a
  short task, but ~75 ns in a task that creates 100k of them, because V8 keeps WeakRef targets alive
  to the end of the job.
- **Same-thread versus SAB:** a getter that costs 11–30 ns directly costs at least 700 ns as a
  cross-thread round trip on an idle machine, and 3–5 µs when other work competes for cores. That is
  30× to 400×, before serialising any arguments. Spinning cuts it to ~110 ns but burns a core per
  segment. Layout reads after writes, which frameworks do constantly, would pay that on every read.
  This confirms the same-thread choice.

### In Chrome (owner, to fill in)

`http://localhost:8100/bench/` runs the same cases on the native DOM (main thread), on the toy in
a dedicated Worker, and as an SAB round trip between two Workers, and prints a comparison table.
Paste the JSON from "Copy results" into this section.

## 6. The segment harness

`node harness/server.mjs` serves on loopback only (127.0.0.1 and ::1), port 8100:

| Origin | What | Headers |
|---|---|---|
| `http://localhost:8100/` | the carapace | CSP, no COOP/COEP |
| `http://seg-demo.localhost:8100/` | the segment for demo.example | `Document-Isolation-Policy: isolate-and-require-corp`, CSP with `frame-ancestors` the carapace |
| `…/chitin/worker.js` | the segment Worker | CSP `connect-src` only the network stand-in; `script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' https:` |
| `…/sw.js` | the segment's service worker | |
| `http://origin.localhost:8100/<site>/` | stand-in for the network (the sites' real bytes) | CORS for segment origins only |
| `http://localhost:8100/bench/` | the benchmark page | COOP + COEP (for SharedArrayBuffer) |

Any other `Host` gets 421, which also blocks DNS rebinding.

### What Chrome treats as a separate site locally

- **Chrome's site** is scheme plus registrable domain. Chromium computes the registrable domain
  with `GetDomainAndRegistry(…, INCLUDE_PRIVATE_REGISTRIES)` (`net/base/schemeful_site.cc`). When
  no Public Suffix List rule matches, the last label is taken as the registry: the header's own
  example is `http://foo.bar/file.html -> "foo.bar"`
  (`net/base/registry_controlled_domains/registry_controlled_domain.h`).
- `localhost` is not in the Public Suffix List (checked 2026-10-11). So `seg-demo.localhost` and
  `seg-other.localhost` are two sites, and the bare `localhost` (a single label, so no registrable
  domain) is a third, keyed by its host. Two segments under one parent, like `a.chitin.localhost`
  and `b.chitin.localhost`, would be one site, `chitin.localhost`. Hence one label per segment.
- `127.0.0.1` versus `localhost` are also different sites (an IP literal has no registrable
  domain), but the `.localhost` names scale to any number of segments.
- **Resolution:** Chrome resolves every `*.localhost` name to `::1` and `127.0.0.1` itself, without
  the OS (`net/dns/host_resolver_manager.cc`, `ResolveLocalHostname`, via `IsLocalHostname` in
  `net/base/url_util.cc`). That is why the server listens on both addresses.
- **Secure context:** `http://*.localhost` is potentially trustworthy (W3C Secure Contexts, "Is
  origin potentially trustworthy?" step 5). Service workers and cross-origin isolation work over
  plain http.
- **`.test` via /etc/hosts:** it would work for the site split, but `http://x.test` is not a secure
  context, so service workers and isolation would need HTTPS with a local CA. It is not needed. If
  the owner ever wants it, it is one line per name in `/etc/hosts` (`127.0.0.1 seg-demo.test`) plus
  a certificate. Not done here.

### Cross-origin isolation in the segment

- Document-Isolation-Policy ships in Chrome 137 on desktop and "applies per frame and makes no
  requirements of subframes" (developer.chrome.com/blog/document-isolation-policy). So the segment
  can be isolated while the carapace is not.
- Dedicated workers inherit the creator's isolation state (explainer, "Interactions with workers":
  "Document-Isolation-State and the crossOriginIsolation status should be inherited from the
  creator of a DedicatedWorker").
- The harness reports `crossOriginIsolated` for the carapace, the segment document and the segment
  Worker. Expected: false, true, true.

### Frames and input

- **Pacing:** the carapace's `requestAnimationFrame` sends a frame tick (one in flight). The
  Worker runs the page's rAF callbacks, lays out and paints the display list onto an
  OffscreenCanvas, and answers.
- **Mode `bitmap` (default):** `transferToImageBitmap()` is sent over the carapace's MessagePort,
  and the carapace shows it with a `bitmaprenderer` context (`transferFromImageBitmap`, no copy on
  our side).
  - ImageBitmap is serializable and transferable across agent clusters, as long as it is
    origin-clean (HTML, the ImageBitmap interface; whatwg/html#4764 added the block for non-clean
    bitmaps entering COEP contexts).
  - Ours are always origin-clean: the engine rasterises page content itself, so the host canvas
    never sees a cross-origin image.
- **Mode `canvas`:** the carapace transfers its own canvas (`transferControlToOffscreen`) to the
  segment, which passes it on to the Worker. Whether Chrome accepts an OffscreenCanvas
  transferred to a cross-process frame is one of the owner's checks; WebKit only fixed this for
  site isolation recently (WebKit bug 325214).
- **Mode `direct` (comparison only):** the segment shows its own canvas and takes input itself. It
  bypasses the carapace, unlike the architecture.
- **Input:** pointer events on the carapace canvas are mapped to page CSS pixels (canvas rect,
  scaled to the tab size) and sent with their timestamps. The engine hit-tests and dispatches
  trusted `MouseEvent`s; keys go to the body. The Worker echoes the timestamp of the last input
  with the next frame, so the carapace measures input → frame shown.
- **The iframe is kept full size under the carapace's canvas by default.** Chromium throttles
  cross-origin iframes that are `display:none` (rendering, rAF; Microsoft's Edge docs, "iframe
  throttling"). Hidden renderers may also get lower process priority. The `frame` switch (under,
  1×1, `display:none`) lets the owner measure the difference.

## 7. The module loader and classic scripts

**Modules.** The segment Worker imports the site's modules at their **real URLs**
(`import('https://demo.example/app/main.mjs')`). The segment's service worker sees those requests,
because a dedicated worker is a service-worker client controlled by the registration matching its
own script URL. It asks the engine in the Worker for the bytes over a private MessagePort and
answers with them unmodified.

Why that keeps URLs exact:

- A constructed `Response` has an empty URL list, and Fetch's main fetch fills it with the
  request's. So `import.meta.url`, the module map key, relative resolution and stack frames all use
  `https://demo.example/...`.
- "The CORS check is not to be applied to … responses from a service worker" (Fetch, HTTP fetch).
  So we invent no `Access-Control-Allow-Origin`.
- The one header the service worker adds is `Cross-Origin-Resource-Policy: cross-origin`, for the
  isolated segment's no-cors classic scripts. Bytes and URLs are untouched.

Checks built into the demo site (harness/sites/), each shown in the carapace's Segment panel:

| Check | Expected |
|---|---|
| `main.mjs` `import.meta.url` | `https://demo.example/app/main.mjs` |
| relative import `./lib/util.mjs` | `https://demo.example/app/lib/util.mjs` |
| cross-origin import `https://cdn.example/lib.mjs` | `https://cdn.example/lib.mjs` |
| `import.meta.resolve('./x.mjs')` | `https://demo.example/app/x.mjs` |
| module stack frame | names `https://demo.example/app/main.mjs` |
| dynamic `import('./lib/util.mjs?dynamic')` | `https://demo.example/app/lib/util.mjs?dynamic` |

Safety: the Worker first imports `/__chitin/hello.mjs?nonce=…`, which only the service worker
answers. It loads no modules unless that succeeds, because otherwise V8 would fetch the site's URLs
from the host network, around Spiracle and Tor.

**Classic scripts**, two modes:

- **`eval` (the plan's decision):** `(0, eval)(text + "\n//# sourceURL=" + url)`.
  - Tested in Node: stack frames name `https://demo.example/app/main.js:1:…`, and
    `Function.prototype.toString` returns the original source without the comment.
  - The page never sees the added line; the engine keeps the untouched text for the page's own view
    and for integrity checks.
- **`importScripts`, through the service worker (experiment):** V8 loads the script from its real
  URL. The Worker is blocked inside `importScripts`, so it stages the bytes with the service worker
  first.

### What cannot be made exact

| What | Why | Effect |
|---|---|---|
| `import()` inside a classic script in `eval` mode | dynamic import resolves against the referrer's base URL. For eval code that is the script that called eval (the glue), not the sourceURL | `import('./x.mjs')` from a site's classic script resolves against the segment Worker's URL and fails. The demo reports it ("import() from the classic script …"). The `importScripts` mode should resolve it correctly; the owner's run decides between the modes |
| muted errors in `importScripts` mode | importScripts is a no-cors request to a cross-origin URL, so Fetch sets its response tainting to opaque and wraps even the service worker's constructed response in an opaque filtered response (main fetch). HTML mutes errors of CORS-cross-origin scripts | uncaught errors reach `onerror` handlers as "Script error."; errors caught by the page's own code are unaffected. `eval` mode has no muting. To be confirmed in the owner's run |
| import maps | Chrome does not support import maps in workers (WICG/import-maps#235, web-platform-tests/interop#715) | bare specifiers fail before any fetch, so no service worker can help. Needs an upstream feature or a rewrite we do not do. A real gap for sites that use import maps. **Since 2026-10-22:** the owner approved that rewrite for specifier strings only (docs/architecture.md "Import maps") |
| inline module scripts (not in the demo) | they have no URL of their own; their `import.meta.url` is the document's URL | planned: import them from `https://site/page#chitin-inline-N` (served by the service worker), so relative imports resolve right; `import.meta.url` then carries a fragment |
| first visit, or a reload that bypasses the service worker | the Worker would not be controlled | detected by the hello probe; modules are refused, never fetched from the host |
| several Workers on one segment origin (e.g. two tabs of one site) | the service worker must route each fetch to the right engine | designed in (FetchEvent.clientId → engine, learnt from the hello nonce), untested: the harness has one tab. After the browser restarts the service worker it asks the segment document for a new port, and with one engine it falls back to that one |

## 8. Risks that change phase 1

1. **Rust and clang 21 do not match.**
   - Rust 1.98 is LLVM 22.1, and its prebuilt `wasm32-unknown-emscripten` std is built with
     whatever Emscripten was latest at release time.
   - So LibWeb's Rust half needs `-Zbuild-std` with our Emscripten, and there is no cross-language
     LTO.
   - Alternatively, move the C++ to an Emscripten on LLVM 22 and drop the clang 21 pin. The owner's
     call (docs/toolchain.md).
2. **Emscripten's JS runtime cannot run in the shared realm.** LibWeb needs files, clocks,
   threads and more. We must write those imports ourselves in the hardened style
   (`-sSTANDALONE_WASM`), not use Emscripten's `library_*.js`. That is more phase-1 work than
   "build with Emscripten" suggests.
3. **Wrapper preservation is Blink-like, and that has a cost.** Every wrapper of a reachable
   component stays alive. Large documents that JS has touched keep one wrapper per touched node.
   That is fine, but it is more retention than Ladybird's preserve-on-expando.
4. **The leak class is real and permanent** for its pattern (section 3). Phase 2 needs the
   rule-only pin counter, and a corpus run with LibWeb.
5. **Strings and wrapper creation are where the time goes**, not the boundary. LibWeb's own
   strings are UTF-16 (`Utf16String`), which matches the toy. A JS-string → engine-string cache is
   the first optimisation if profiles call for it.
6. **Classic scripts' dynamic `import()` is wrong in `eval` mode** (section 7). If the owner's run
   confirms that `importScripts` resolves it, the decision on classic scripts may need revisiting:
   exact URLs and imports, at the price of muted errors in `onerror`.
7. **Import maps don't work in workers.** Sites that depend on them fail in a segment until Chrome
   ships import maps for workers.
8. **Unverified until the owner runs Chrome:**
   - whether an OffscreenCanvas crosses into the segment's process;
   - fps and latency with each iframe placement;
   - whether DIP makes the Worker isolated as the explainer says;
   - whether a third-party (partitioned) service worker controls the segment Worker with this
     Chrome's settings. Chrome allows service worker registration in third-party frames, partitioned
     by top-level site (developer.chrome.com, Storage Partitioning), but cookie settings can differ.

## 9. The owner's first Chrome run (Chrome 154) and what it fixed

Mode: ImageBitmap transfer, iframe under the canvas, classic scripts by eval + sourceURL.

**Confirmed in Chrome:**
- Segment document and Worker are `crossOriginIsolated` (Document-Isolation-Policy), the carapace
  is not.
- The service worker controls the segment Worker. Engine boot 1.1 ms; page loaded 11.4 ms after
  boot.
- Classic script stack frame: `at eval (https://demo.example/app/classic.js:7:16)`.
- Module URLs are all exact: `import.meta.url`, relative and cross-origin imports,
  `import.meta.resolve`, module stack frames, and a dynamic import with a query all show
  `https://demo.example/...` and `https://cdn.example/...`.
- `import()` from the classic script in eval mode failed as predicted, resolving to
  `http://seg-demo.localhost:8100/chitin/lib/util.mjs`.

**Bug 1, the first load failed** with "Unexpected end of JSON input" in `loadSite`.
- Cause: the segment's service worker answered every cross-origin fetch from the Worker, including
  the engine's own fetch to the network stand-in (`http://origin.localhost/...`). It asked the
  engine for the engine's own request, and the engine refused the non-https URL with an empty 400.
- The coordinator's fix (8b491ed) let every non-https request through to the network. That fixed
  the load, but it was too wide: any `http:` or `ws:` URL would then reach the host network,
  around Spiracle. Only the page's CSP stood in the way.
- Now: exactly the stand-in origin passes through; other non-https requests get `Response.error()`
  (fail closed); https site URLs come from the engine.
- Tests: `service worker: the engine's own requests to the network stand-in pass through` and
  `… any other request fails closed`. Both fail on the sw.js from before the fix.

**Bug 2, the page stayed white with no frame metrics** in every frame mode.
- Cause: the carapace starts ticking as soon as it has sent `init`, so its first tick reaches the
  Worker while the engine wasm is still loading. `frame()` called `host.needsPaint()` with `host`
  undefined and threw (owner's console: "Cannot read properties of undefined (reading
  'needsPaint') at frame (worker.js:106)").
- No reply was posted. The carapace keeps one tick in flight and waits for its reply, so it never
  ticked again and nothing was ever painted.
- The error reached no panel: the segment document reported Worker errors on the carapace port,
  which it had already transferred to the Worker.
- Fixes:
  - Every tick gets exactly one reply: `notReady` before boot, `error` with the stack if anything
    throws (try/finally), the frame otherwise. Input before boot is ignored.
  - The Worker forwards its own uncaught errors and unhandled rejections to the Segment panel; the
    segment document reports Worker `error`/`messageerror` straight to the carapace window.
  - The carapace's watchdog shows `frames: ERROR: no frame for N s …` when no frame has arrived for
    2 s. It says whether the segment answers ticks at all and what it last replied, and it re-ticks
    if a reply was lost.
- Test: `segment Worker: frame ticks during boot are answered, so the carapace never stalls` fails
  on the old worker.js with exactly the owner's TypeError.

**Bug 3, found by the new tests: blank frames.**
- In bitmap mode, the Worker transferred a bitmap every frame, even when nothing was repainted.
  `transferToImageBitmap()` leaves the canvas transparent, so an idle frame would have replaced the
  picture with an empty one.
- The demo hid this because its animation repaints every frame; a static page would have gone
  blank after the first frames.
- Now a bitmap is sent only for a painted frame. Test: `a frame with nothing new sends no blank
  bitmap`.

**importScripts mode (for the owner's next run).** The Worker side is tested in Node
(`segment Worker, importScripts mode: …`): the bytes are staged with the service worker before the
blocking `importScripts`, and the script runs under its real URL. The service worker now waits up
to 3 s for staged bytes, not 100 ms, because asking the blocked Worker could only time out.

What to expect in Chrome:
- `import('./lib/util.mjs')` from the classic script should resolve against
  `https://demo.example/app/classic.js` and load through the service worker. Under eval it resolves
  against the Worker's own URL, because V8 takes the referrer of eval code from the calling script,
  and no `sourceURL` changes that.
- Uncaught errors from that script should be muted ("Script error."), section 7.
- Two things can still break it, and only Chrome can tell: whether Chrome accepts the service
  worker's response to a no-cors `importScripts` under `isolate-and-require-corp` (it carries CORP:
  cross-origin), and its JavaScript MIME check on an opaque response.

Also: an empty favicon (`<link rel="icon" href="data:,">`, and a 204 from the server) removes the
favicon.ico 404.
