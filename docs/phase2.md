# Phase 2: page JavaScript on the host V8

Status: plan, 2026-10-11, written after phase 1 (docs/phase1.md) and the network (docs/network.md)
and after reading what the pinned Ladybird (`975740c`) and our runtime already have. Milestone
results are appended below as they land.

| Item of the brief | Plan | State |
|---|---|---|
| bindings from Web IDL, on the host V8 | the V8 mirror of LibWeb's own generated bindings (section 2) | M1 |
| indistinguishable from Chrome's (scramjet-lessons.md item 1) | section 2.6 and the surface diff tool | M1 (shape), M5 (diff against Chrome) |
| the anchor GC design | section 4, on LibGC | M3 |
| the event loop | section 3 | M1 (tasks, microtasks, timers), M2 (rAF, nested loops) |
| forms, cookies, storage | section 5 | M4 |
| Wikipedia with its JS; TodoMVC | the targets of M2 and M1 | |
| the framework matrix, js-framework-benchmark | M5 | |

## 1. Where phase 1 left the seam

LibWeb at this pin does not link a JavaScript engine: LibJS is a facade whose `JS::Object`,
`Value`, `Realm` are cells read through `Embedding/Layout.h` and operated through 358 `js_*`
functions (phase1.md section 3). Our runtime (`engine/libjs-runtime`, 4,300 lines) implements the
cells LibWeb's own code needs: objects with property tables and host-class hook dispatch, native
functions, realms, promises, ArrayBuffers and typed arrays, errors. Two consequences decide this
phase:

1. **LibWeb's generated bindings are in the module and run.** `Meta/Generators/libweb_bindings`
   emits, per interface, a `JSHostClass` (name, parent, flags such as
   `JS_HOST_CLASS_IS_GLOBAL_OBJECT`, `JS_HOST_CLASS_MAY_INTERFERE_WITH_INDEXED_PROPERTY_ACCESS`,
   and the `PlatformObject` hooks with `supports_named_properties`, `supports_indexed_properties`,
   `named_item_value`), a prototype object initialised with `define_native_function` /
   `define_direct_accessor` (WebIDL's attributes: accessors and operations enumerable and
   configurable, constants enumerable and frozen, `Symbol.toStringTag`), an interface object with
   `length`, `name`, `prototype` and the constants, `[LegacyUnforgeable]` own accessors on each
   wrapper, and the WebIDL conversion of every argument from `JS::Value` inside each
   `JS_DEFINE_NATIVE_FUNCTION` (`Bindings/Node.cpp`: `append_child` reads `vm.argument(0)`, checks
   the brand, calls `impl.append_child(node)`, converts the result). The interface objects are
   defined on the global lazily (`js_object_define_intrinsic_accessor`, our `IntrinsicPending`
   property kind). Phase 1 runs all of this for the realm, the Window and every wrapper a fetch
   creates. 674 interfaces, every overload, dictionary, union and callback conversion, already
   compiled and Ladybird-maintained.
2. **The runtime's dispatch is narrow.** Every operation LibWeb performs on an object goes through
   `internal_get/set/has/own_keys/call/construct` in Object.cpp and Function.cpp, which consult
   the cell's class. A new class whose internals are imports is all it takes for a V8 value to be
   usable by LibWeb's code.

So the plan is not a new generator backend over 674 IDL files (bindings-and-gc.md section 2 was
written before the runtime existed). It is a **mirror**: the glue builds V8 classes from the
runtime's prototype objects, calls their native functions through one export, and converts values
at the boundary. bindings/generate.py (phase 0) stays for what it was built for: direct exports for
hot members, measured first.

## 2. The bindings: a V8 mirror of the runtime's prototypes

### 2.1 Classes from prototypes

For an interface `X`, the glue asks the runtime for `X`'s prototype object (the one
`ensure_web_prototype<XPrototype>` made) and its interface object, enumerates their own properties
(exports `ganglion_object_own_keys`, `ganglion_object_own_property` giving kind, attributes, the
value or getter/setter cells, the native function's `length` and `name`), and defines a V8 class:

- `class X extends Parent` where `Parent` is the mirror of the runtime prototype's prototype
  (`Node → EventTarget → Object.prototype`); the chain is Ladybird's, which is the IDL's, which is
  Chrome's.
- every accessor becomes a V8 accessor whose getter and setter call
  `invoke(getterCell, this, [])` / `invoke(setterCell, this, [v])`; every operation a function
  calling `invoke(functionCell, this, args)`; constants, `Symbol.toStringTag`, `[Unscopable]`s and
  the attributes copied as they are. `length` and `name` of each function come from the native
  function's own properties.
- the interface object (`X` itself) gets `length`, `name`, `prototype` (non-writable,
  non-enumerable, non-configurable) and the constants, and calls `construct(ctorCell, args)` for
  interfaces with constructors; the others throw `TypeError: Illegal constructor`.
- `[LegacyUnforgeable]` members are defined on each wrapper instance at `wrap` (the runtime's
  wrapper has them as own properties; the mirror copies them).
- classes are built lazily, on the first wrap of an instance or the first touch of the global's
  lazy interface accessor, and cached per interface name.

`invoke(fnCell, thisValue, args)` is one export, `ganglion_js_invoke`: arguments converted to
`JSValue`s in a scratch block, `this` converted, the runtime's `call` (which pushes the execution
context with the arguments in its slots, as LibWeb's `vm.argument(i)` expects), the result
converted back; a `JS_COMPLETION_THROW` comes back as a flag and the thrown value, which the glue
rethrows after conversion. Overload resolution, argument count checks and WebIDL conversions are
the C++ binding's, so `appendChild(42)` throws the TypeError LibWeb throws.

### 2.2 Values across the boundary

| runtime value | to V8 | back |
|---|---|---|
| undefined, null, boolean, int32, double | the same | the same |
| string cell (`PrimitiveString`, UTF-16) | `ganglion_string_chars` → a JS string; fly strings cached by cell address (tag names, event types, attribute names cost nothing after the first time) | a V8 string → `ganglion_string_create(ptr, len)` (a copy; interned on the runtime side when short) |
| host object with a wrappable (a DOM object) | `wrap(cell)`: the WeakRef table by cell address, else a new instance of the class named by the cell's host class, with its `[LegacyUnforgeable]` own properties | the wrapper's private `#cell` |
| foreign cell (a V8 value the page gave the engine) | the original value, from the handle table | the same cell again (handle table lookup by value, a WeakMap) |
| native function cell (an iterator `next`, a promise resolving function, a callback LibWeb made) | a V8 function that calls `invoke(cell, this, args)`; cached | its cell |
| promise cell | a V8 twin promise; `ganglion_promise_then(cell, handle)` reports settlement through an import and the twin follows | a V8 promise → a foreign cell; LibWeb's `then` on it goes through `get("then")` + `call` imports |
| array cell | a V8 array of converted elements (a copy: sequences are copied by WebIDL anyway) | a V8 array → a foreign cell; sequence conversion iterates it through the imports |
| plain object cell (a dictionary LibWeb returns, structured data) | a copy of its own enumerable properties | a foreign cell |
| error cell (TypeError, RangeError) | a V8 error of the same constructor with the runtime's message | a foreign cell |
| symbol cell | well-known symbols by name; others a V8 symbol per cell | registered symbols by key; others a foreign-symbol cell |

The **foreign cell** is the new runtime class: an `Object` cell whose class hooks are imports
(`ganglion_host_js_get/set/has/delete/own_keys/define/call/construct/get_prototype_of`),
holding an index into the glue's handle table. LibWeb's dictionary conversion (`object.get("once")`),
callback invocation (`JS::call`), sequence iteration (`get(@@iterator)` then `next`), `JSON` (the
runtime's `js_json_parse` and stringify become imports that return foreign cells), structured
clone (serialize walks the object through `get` and `own_keys`) all work through these without
knowing the object is V8's. Property keys cross as the runtime's `Key` bits: the glue interns a JS
string once (`ganglion_key_intern`) and caches; indices and well-known symbols map directly.

Linear memory is never exposed: every string and buffer crossing is a copy (phase 0's glue rules).
`ArrayBuffer`s the page hands to the engine (`fetch` bodies, `TextDecoder`) are copied into
runtime buffers; those the engine hands out (`response.arrayBuffer()`) are copied into V8 buffers.

### 2.3 Scripts

`js_script_parse` keeps the source, filename and the host-defined pointer in a `Script` cell;
`js_script_run` calls the import `ganglion_host_run_script(source, filename, type)`. The glue
evaluates a classic script with an indirect `eval` of the source plus one appended
`//# sourceURL=<url>` line (the decision in docs/plan.md: errors and stacks name the real script;
the engine's copy is untouched, so `script.text`, integrity checks and `textContent` see the bytes
as served). A V8 exception comes back as a foreign cell in a throw completion, so LibWeb's
"report an exception" fires `error` on the window with the page's own error object. Parse errors
surface at run instead of at parse; the `error` event fires either way, which is the observable
part.

Modules (wikispeedruns.com, 2026-10-22): a module script is a record with no requested modules (`js_module_parse_source_text_module`,
`js_compile_create_module_from_*`); the host's V8 loads and links the imports itself, through phase 0's module
loader (the segment's service worker answering V8's fetches from the engine, harness/segment/sw.js). `js_module_evaluate`
calls the import `ganglion_host_js_run_module(source, url)`: the Worker stages the module's bytes (which the engine
already fetched) with the service worker under its real URL, waits for its acknowledgement, and `import(url)`s it, so
`import.meta.url` and relative imports are the site's; an inline module has the document's URL, which V8 cannot
import twice, so it gets a `?__chitin_module=N` query (relative imports still resolve against the document's
path). The returned promise settles the capability Evaluate returns. Modules run one at a time in the order the
engine asks (the glue queues them), and a LibWeb patch (0022) makes the end of parsing wait for a pending module
evaluation, so the next deferred script and DOMContentLoaded follow a module as in a browser (listeners a module
adds for DOMContentLoaded fire). Under Node the same import is `vm.SourceTextModule` (`node --experimental-vm-modules`,
tests/engine-run.mjs). Dynamic `import()` inside classic scripts resolves against the script's URL as V8 does.
Map and Set iterators (`CreateMapIterator`, `CreateSetIterator`, used by set-like interfaces such as `document.fonts`)
are objects with an own `next`; the glue's snapshot of one is iterable. A page's own `Worker` and `SharedWorker`
are not exposed yet (constructing one needs the browser's worker machinery and trapped the engine).

### 2.4 The global

A Worker's global is a `DedicatedWorkerGlobalScope` with an immutable prototype, so `window`
cannot *be* a `Window` instance. The glue mirrors the Window's surface onto `globalThis` as own
properties: every accessor and operation of `WindowPrototype`, `WindowProperties` and
`EventTargetPrototype` bound to the Window cell (`document`, `location`, `setTimeout`,
`addEventListener`, `getComputedStyle`, ...); the lazy interface objects (`Node`, `Event`,
`XMLHttpRequest`, every `IntrinsicPending` own property of the runtime global) as lazy accessors
that build the class on first touch and replace themselves with a data property; `window`,
`self`, `globalThis`, `frames`, `top`, `parent` returning the global. Named access (`window.someId`)
comes with the `WindowProperties` named getter: the mirror defines per-id accessors as elements with
ids enter and leave the document (the engine reports them through a listener on the document's id
map; M2). What cannot be made true: `globalThis instanceof Window`, `Object.getPrototypeOf(window)
=== Window.prototype`. Both are rare in page code; the surface diff tool (2.6) lists them.

The Worker's own API (`postMessage`, `importScripts`, `fetch`, `WebSocket`, `Worker`, `close`,
`onmessage`) is hidden before the first script, as phase 0 did, and the CSP fails closed on
anything missed.

### 2.5 Exotic objects

Interfaces whose host class says `supports_named_properties` or `supports_indexed_properties`
(NodeList, HTMLCollection, HTMLFormElement, HTMLSelectElement, DOMStringMap, Storage,
NamedNodeMap, CSSStyleDeclaration, DOMTokenList, HTMLAllCollection, the Window's named
properties) get a `Proxy` as the wrapper (phase 0 decided this): `get`/`has`/`ownKeys`/
`getOwnPropertyDescriptor`/`set`/`deleteProperty` traps that first consult the runtime's own
`get_own_property` hook (indexed and named getters, in the order WebIDL's legacy platform object
steps prescribe, which the C++ side implements) and fall back to the mirrored prototype. The
proxy's target is the class instance, so `instanceof`, `Object.getPrototypeOf`, `toStringTag` and
the brand checks behave; `Object.getOwnPropertyNames(nodeList)` lists the indices as Chrome does.

### 2.6 Chrome-identical surfaces

What scramjet-lessons.md item 1 asks for, and how each is met or not:

- **`Function.prototype.toString`** must print `function querySelector() { [native code] }` for a
  binding. V8 prints a JS function's source. The glue replaces `Function.prototype.toString` in the
  realm before any script runs with a function that returns Chrome's text (`function <name>() {
  [native code] }`, accessor getters as `function get innerHTML() { [native code] }`) for every
  function in a private WeakSet (every mirrored function, accessor, interface object, and the
  replacement itself), and V8's own `toString` otherwise. `toString.toString()` is native text;
  `toString.name === "toString"`, `length === 0`. A `ShadowRealm`'s intrinsics, if the host ever
  ships them in Workers, would expose the source; that and stack-trace file names are the known
  limits, listed in docs/user-tests/phase2.md.
- **Descriptors** (`enumerable`, `configurable`, `writable`, accessor vs data) are copied from the
  runtime's prototypes, which Ladybird's generator sets per the WebIDL "create an interface
  prototype object" steps; Chrome follows the same steps. The diff tool checks.
- **Prototype chains** are the IDL's. `Symbol.toStringTag` is on each prototype. `instanceof`
  works through the real class chain; brand checks are the C++ binding's (`#brand in o` is not
  needed: the wrapper's private `#cell` is the brand, and a foreign object reaching a binding fails
  the C++ `impl_from<T>` check with LibWeb's TypeError).
- **Error messages.** LibWeb's messages differ from Chrome's in text: the glue maps the generic
  families at the boundary when it rethrows (brand failure → `Failed to execute 'appendChild' on
  'Node': parameter 1 is not of type 'Node'.`; illegal invocation → `Illegal invocation`;
  constructor → `Illegal constructor`; argument count → `Failed to execute 'x' on 'Y': 1 argument
  required, but only 0 present.`). The rethrown error is a V8 `TypeError`/`RangeError`/
  `DOMException` (the latter a wrapper of LibWeb's, with Chrome's `name`/`code`/`message` shape).
  The long tail of specific messages is matched as the diff tool and sites surface them.
- **The surface diff tool** (tests/surface.mjs, docs/user-tests/phase2.md): a script that walks
  `Object.getOwnPropertyDescriptors` of every interface and prototype reachable from the global,
  with `toString`, `name`, `length`, the prototype chain and `toStringTag`, into JSON. The owner runs
  it in Chrome natively (one page) and in Chitin (the same page as a site); `node tests/surface-diff.mjs`
  prints the differences by interface. The target is zero differences on the interfaces the
  milestone pages touch; the rest are a list.
- **Stack frames.** A page's `Error().stack` shows our glue frames with file names;
  `Error.prepareStackTrace` is left to the page (item 2 of the lessons). Glue frames are kept to
  one per binding call (`invoke`), named like the member (V8's `name` inference from the property
  key), so a stack reads `at HTMLElement.innerHTML` followed by one glue frame.

## 3. The event loop

- The engine's task loop stays the host's `pump` (phase 1): timers, posted events, LibWeb's task
  queues. The Worker calls `pump` from its own macrotasks (frame ticks, network events, timer
  chain), so V8's microtask checkpoint runs when each `pump` returns, which is "after each engine
  task" from the page's point of view. Inside one engine task a listener call returns to the
  engine, not to V8's loop, so a page microtask queued in a listener runs after the engine task
  ends rather than after the listener: the spec's checkpoint "when the JS stack empties". The
  engine's own microtasks (the runtime's promise jobs, MutationObserver delivery) run through
  LibWeb's `perform_a_microtask_checkpoint` at the same points. M2 measures whether any target
  page notices; the fix if one does is `queueMicrotask` from the invoke export after the outermost
  listener returns.
- `setTimeout`/`setInterval`/`queueMicrotask`/`requestAnimationFrame`/`requestIdleCallback` are
  LibWeb's own (Window's timers through `Platform::EventLoopPlugin`, which phase 1 implements in
  EventLoop.cpp; rAF through `Page::...` on the frame tick): their callbacks are foreign cells
  called through `invoke`.
- Nested event loops (`alert`, sync XHR, `spin_until`): phase 1's `spin_until` does not exist
  in-process; `alert`/`confirm`/`prompt` go to the carapace asynchronously with a blocking
  `Atomics.wait` in the segment Worker against a SAB the segment document pumps (bindings-and-gc.md
  section 2, "Nested event loops"). M2 builds `alert` only; sync XHR returns an error.

## 4. GC: the anchors on LibGC

The design is bindings-and-gc.md section 3 as phase 0 refined it (lazy anchors, union-find merges,
all wrappers of a live component preserved). What LibGC needs:

1. **Wrapper → cell: strong.** A wrapper's `#cell` is the HostObject's address; the cell carries the
   "has live wrapper" bit (`HostObject.host_data`'s spare bits), set at `wrap`, cleared by a
   `FinalizationRegistry` callback (`ganglion_wrapper_dropped(cell)`), and LibGC treats cells with
   the bit as roots (a root-gathering hook in `Heap::collect_garbage`, patch). LibGC does not move
   cells, and a cell with the bit set is never freed, so the address stays valid until the glue
   drops it.
2. **Engine → JS edges: in V8, on anchors.** A foreign cell holds `(anchor id, slot)`, not the
   value; the glue stores the value on the component's anchor object. The component of a Node is
   its tree root; of an EventTarget that is not a Node, itself; of anything else, the object. A
   foreign cell created while LibWeb converts a callback is attached to the component of the
   receiver of the binding call (the `this` of `addEventListener`), which the invoke export knows.
3. **Pinning.** `Heap::collect_garbage` marks in two passes (patch): first from the real roots
   only (documents of the traversable, activity roots, task queues), noting every HostObject
   reached whose wrappable is a tree root or an anchor owner; then from the wrapper roots. The set
   from the first pass is the pinned set; the glue gets its add/remove diff after each collection
   (`ganglion_host_pin(cells, count)`) and holds those anchors strongly.
4. **Merge and split.** `Node::insert_before` / `remove` (patch, one call each) tell the glue
   `ganglion_host_component_merge(root a, root b)` and `split(root, detached)`, which union or
   split the anchors as phase 0's glue does (glue/10-runtime.js, reused).
5. **Measurement.** Ladybird's wrapper tests (`Tests/LibWeb/Text/input/include.js`,
   `withCollectedWrapper`) ported to the glue; the leak counter from phase 0 ("components pinned
   only by the rule") reported in the Segment panel; the TodoMVC and Wikipedia pages left for
   minutes with periodic collections, memory flat.

## 5. Forms, cookies, storage

- **Forms.** Text entry is LibWeb's editing (phase 1 delivers keys; `HTMLInputElement`'s value and
  `input`/`change` events are the engine's). Submission: `HTMLFormElement::submit` builds the
  request (GET query or POST body, `application/x-www-form-urlencoded` and `multipart/form-data`)
  and navigates; the navigation goes through `ganglion_navigate` extended with a method and body
  (Network.cpp's `fetch_document` already takes them). Focus and the caret are in the engine.
- **Cookies.** LibWeb asks the page client (`page_did_request_cookie`, `page_did_set_cookie`).
  Ladybird's jar lives in LibWebView (`CookieJar.cpp`: RFC 6265 storage and retrieval, 1,000
  lines, with LibDatabase behind it); it depends on LibWebView's BrowsingSession and the
  database, so the engine gets a jar of its own: `engine/platform/CookieJar.cpp`, the RFC 6265
  "storage model" and "the Cookie header" algorithms over LibHTTP's `Cookie` and `ParsedCookie`
  (which do the parsing and attribute handling), per registrable domain (libpsl is linked),
  persisted through a host import to the segment's IndexedDB. HttpOnly cookies never cross into V8
  (`document.cookie` goes through the jar's filter in C++).
- **Storage.** `localStorage` and `sessionStorage` are LibWeb's `StorageAPI` bottles
  (in-memory maps keyed by storage key, per page). localStorage is persisted (2026-10-22, wikispeedruns.com
  keeps its run there across the page change to its finish page): the engine notifies the host once when it changes
  (`ganglion_host_storage_changed`), the host asks for the copy (`ganglion_storage_flush`, delivered through
  `ganglion_host_storage_data`) and restores it before the first document (`ganglion_storage_restore`). The segment
  Worker keeps the copy in the segment origin's IndexedDB (the site's alone), writes it 50 ms after a change and
  always before a navigation request leaves the Worker. Cookies are not persisted yet; sessionStorage is not
  (it should survive same-tab navigations; M4). IndexedDB in LibWeb is early at this
  pin; it stays the engine's (its backend is SQLite, linked) with the file written through the host
  later.

## 6. Milestones

Each is a commit series, a test under Node, and a line in this file's results section.

**M1: scripts run; the mirror; TodoMVC.** The foreign cell class and its imports; `invoke`;
value conversion; classes from prototypes; the global; `js_script_run` through V8; timers and
event listeners calling back; `Page::set_is_scripting_enabled(true)` when the host has V8.
Test: a page with inline scripts that builds DOM, listens, uses `setTimeout`, `JSON`, `fetch` of a
same-origin JSON (through the network stand-in), `localStorage`; then TodoMVC (vanilla JS, from the
TodoMVC repository, served as a stand-in site) driven under Node with key and mouse events: add,
toggle, edit, delete, filter by `hashchange`, persist through `localStorage`. Under Node, page JS
runs in the test's own V8 realm (the `vm` context phase 0's harness simulation uses), the same
glue as the Worker.

**M2: Wikipedia with its JavaScript.** Wikipedia's ResourceLoader (`mw.loader`) loads modules by
inserting `<script>` elements and `fetch`ing `load.php`; the Vector 2022 skin's menus, the
collapsible table of contents, the search field's Codex (Vue) suggestions. Needs dynamic script
insertion, `XMLHttpRequest` and `fetch` to the engine's network, `performance.now`, `navigator`,
`localStorage`, `MutationObserver`, `requestAnimationFrame`, `matchMedia`, `IntersectionObserver`
(stub), `history.replaceState`, named window properties. Test: search suggestions appear after
typing; the menu opens; measured: JS time per page load, mirror class count, invoke count.

**M2 status (2026-10-21):** Wikipedia loads with its scripts under Node (`CHITIN_NET=1 make wikipedia-test`,
numbers in docs/results/phase2-m2-wikipedia-node-2026-10-21.json: document 0.8 s, 188 requests, 124 modules
ready, search suggestions work). Bugs this found and fixed: the engine's string-to-number conversion
trapped on its whitespace table (a UTF-8 literal through Utf16View's ASCII constructor); page JS started by
a V8 promise job had no incumbent realm (now bracketed with enter/leave when no engine frame is under it,
`hostDepth` in 40-bridge.js); the runtime's promises have no `then` (fetch rejected with "not a function";
the twin now attaches through `ganglion_promise_then`); `new Image()`/`Audio`/`Option` were the interface's
class (legacy factories now). Still missing: `Response.arrayBuffer()` resolves an unconverted object,
the "145 languages" dropdown does not open (unexplained), `rAF`/`IntersectionObserver` behaviour is not
measured, no JS-time-per-load number yet, and a paint-thread Rust panic
(`update_visual_context_tree`, bounds check) appears now and then in tests/engine-robustness.test.mjs.

**M3: GC.** The LibGC patches (wrapper roots, two-pass mark, merge/split notifications), anchors in
the glue, pinning diffs, the ported wrapper tests, memory flat on TodoMVC and Wikipedia over time.

**M4: forms, cookies, storage.** The jar, persisted storage, form submission (a login-shaped test
site under the stand-in: POST, Set-Cookie, a cookie-gated page), Wikipedia's login form reaching
the server (not logging in).

**M5: Chrome-identical surfaces and the framework matrix.** The surface diff against the owner's
Chrome dump, error-message mapping, `Function.prototype.toString`; the matrix of docs/plan.md
(TodoMVC and a starter app for React, Vue, Svelte, Solid, Astro, Lit, Angular; a Tailwind v4 page)
as stand-in sites under Node, each with a pass/fail and the first blocker; js-framework-benchmark's
vanillajs and one framework implementation run under the harness with its numbers against Chrome's
native DOM (the owner's run).

Order: M1 → M2 → M3 → M4 → M5. M3 before M2 would be cleaner but Wikipedia is the owner's priority;
until M3, foreign cells hold their values strongly (a leak per listener on a removed node, bounded
by the page's life).

## 7. Risks

1. **Double conversion.** Each call converts V8 → JSValue → C++ and back. Phase 0 measured the
   boundary at 5 ns and strings at 2 ns per code unit; the C++ conversions add a `PrimitiveString`
   cell per string argument. If a profile shows it, the hot members (`firstChild`, `nodeType`,
   `getAttribute`, `classList`, `style`) get direct exports from bindings/generate.py on top of the
   mirror.
2. **The runtime's gaps.** Phase 1 implemented what loading reached. Page code reaches the rest:
   iterator protocol over foreign objects, `JSON`, Date, RegExp (LibWeb uses them in a few places),
   symbols, getters on foreign cells, `instanceof` checks in C++ (`is<T>` on a foreign cell is
   false, correct). Each `unimplemented` trap names itself; the milestone pages find them.
3. **Navigation and realms.** Phase 1 reuses one document and one realm across loads. With page
   state in V8 that is wrong: a navigation must get a fresh realm and global. The Worker tears
   itself down and restarts the engine on each document navigation until LibWeb's navigation
   machinery runs in-process (phase1.md risk 3); same-document navigations (`hashchange`,
   `pushState`) stay in the Worker.
4. **The global is not a Window.** Section 2.4's two untruths; a library that walks
   `Object.getPrototypeOf(window)` chains for feature detection would see the Worker's.
5. **Proxies for exotic objects** cost V8's proxy overhead on `NodeList[i]` and `style.width`; the
   hot ones can get fast paths (`item(i)` behind the trap is one export).
6. **Microtask timing** (section 3) and **nested loops** (sync XHR unsupported).
7. **Size.** The mirror adds ~2,000 lines of glue; the runtime additions compile into the module;
   nothing is stripped yet (phase1.md risk 1).

## Results

### M1: scripts run; the mirror; TodoMVC (2026-10-11)

Built and tested under Node (`node --test tests/engine-js.test.mjs tests/todomvc.test.mjs`, 6 tests);
the owner's Chrome steps are docs/user-tests/phase2.md.

**What runs.** harness/sites/script.example (inline and external classic scripts that build DOM, use
NodeList/HTMLCollection proxies and iteration, classList, `CustomEvent`, `setTimeout`, JSON,
`localStorage`, `getComputedStyle`, `offsetWidth`, `load`/`DOMContentLoaded`, a click from the host
reaching a listener and repainting) and the TodoMVC project's vanilla ES5 example (eight
parser-blocking external scripts in order; typing into the input through the host's key events,
Enter, the checkbox toggle, the `#/active` and `#/completed` filters as same-document navigations
firing `hashchange`, `.destroy` clicks).

**The shape as built** (sections 1 and 2 hold; what the plan did not know):
- `JS::Value` is returned through a hidden pointer on wasm32 (its NaN-box is a union with several
  members, so clang's single-element-struct rule does not apply), while the facade bit_casts the
  intrinsic accessor type to `JSValue (*)(JSRealm*)`. Every interface object materialised through
  that pointer trapped with a signature mismatch. The runtime now calls intrinsic accessors with the
  sret convention (Object.cpp, `materialize`). The construct hook returns the constructed object as a
  pointer, not a tagged value; `ganglion_js_construct` reads it so.
- The document's realm, not the principal realm, is the one scripts run in (the traversable creates
  its own Window); the bridge mirrors that global. The `WindowProxy` has no wrappable and maps to the
  global; `window === self === globalThis` holds.
- Scripts need a script-having execution context on the runtime's stack for LibWeb's incumbent
  settings object, and host-initiated evaluation (`evalInPage`) needs LibWeb's own "prepare to run
  script" (the realm execution context) for the entry settings object: `ganglion_js_enter/leave`.
- Documents start hidden, which throttles every timer to a one-second grid: the page is now told it
  is visible at start.
- Value-iterable declarations (`NodeList`, `HTMLCollection`, `DOMTokenList`: `@@iterator`, `values`,
  `keys`, `entries`, `forEach`) reuse `%Array.prototype%`'s functions, which the runtime has no
  usable form of; the mirror defines them from V8's `Array.prototype`, as Chrome's are.
- The speculative HTML parser's preloads doubled every script fetch, and the real parser-blocking
  fetch of the second script never completed its delivery; patch 0019 lets the embedder turn the
  speculative parser off, and the host does. Separately, the Node runner stopped pumping while a host
  fetch had resolved but not yet been delivered to the engine (`pendingHostFetches`), and `ganglion_pump`
  now asks for another pump while LibCore's queue holds events posted during the rounds.
- A fragment navigation (`location.hash`, a `#link`) was going out to the host as a navigation
  request because the navigable's session history entry still said `about:blank`; the entry's URL
  is set when a document loads, so `Navigable::navigate` takes its in-process fragment path.
- Runtime wrapper cells are collected by LibGC and their addresses reused; the mirror keyed its
  wrapper cache by address and once saw the document become an `Event`. Every cell the mirror holds
  a page value for is rooted for now (`ganglion_v_root`); M3 replaces that with the "has live
  wrapper" roots and their release.
- Ladybird's button numbering is a bitmask (`Primary = 1`), not the DOM's `button` index: the
  Worker maps it.

**Numbers** (Node v22.14.0, M4 Max; tools: the bench in this file's history, `scratchpad/bench1.mjs`):

| | |
|---|---|
| installing the global (Window surface + 540 interface classes, built eagerly for now) | 131 ms |
| wrappers alive after script.example | 2,635 (prototype objects, functions, DOM wrappers) |
| `el.nodeType` / `el.firstChild` | 117 / 102 ns per call |
| `getAttribute` / `setAttribute` | 310 / 638 ns |
| `classList.contains` | 411 ns |
| `offsetWidth` (layout clean) | 695 ns |
| `querySelector('#box')` | 630 ns |
| `createElement('div')` | 1.98 µs |
| `textContent = ...` | 830 ns |

Against phase 0's direct exports on the toy (`createElement` 223 ns, `setAttribute` 48 ns) the
generic path is 5-10x: two conversions per argument, runtime string cells for every string, the
scratch-slot protocol. That is the expected cost of the mirror; hot members get direct exports in
M5 once profiles of real pages say which.

**Not in M1** (as planned): anchors and pinning (M3; wrappers and foreign cells are strong), a
lazy global (the 131 ms is eager class building), modules, named window properties, error-message
mapping beyond `Illegal constructor`, microtask timing beyond "after each engine task".
