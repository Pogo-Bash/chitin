# The framework matrix

Frameworks are the test bed for the engine's general paths (docs/plan.md, "Frameworks and CSS"): nothing in the engine is
framework-specific. Each framework has a small local app made from its official template, so a run is deterministic and
offline, and the owner tries one real site per framework by hand (docs/user-tests/frameworks.md).

## The apps

`tools/frameworks/<name>/` is the app (its own `package.json`, every dependency a devDependency pinned to an exact version,
a lockfile, no `node_modules` in git). `npm run build` there writes the built output to `harness/sites/<name>.example/`
(served as `https://<name>.example/`), with a `LICENSE.md` naming the template and the packages in the bundle.
`make frameworks-build` (or `tools/frameworks/build-all.sh [name...]`) rebuilds all of them; `node tools/frameworks/pin.mjs
<dir>` rewrites ranges to the installed versions.

Every app has the same contract (`tests/fw.mjs`): routes `/`, `/items`, `/items/<id>`, `/about` with client-side navigation;
a counter (`#count`, `#inc`); a list fetched from `/data/items.json` (`#status` reads `loaded 5`), filtered by a text input
(`#filter`, on title or tag), a form that adds an item and shows `Title is required` when empty (`#add-form`, `#new-item`,
`#error`); a detail route that reads its id (`#detail-id`, `#back`). So one scenario drives routing, state, lists, forms,
input events, async fetch and History API in each. Where natural an app adds what its framework is known for (custom
elements and shadow DOM for Lit, islands for Astro, and so on); those checks follow the shared scenario in its test.

## Tests

- `tests/frameworks.test.mjs`: Node, one test per app (`make engine-js-test`).
- `make chrome-test`: one group per app, driven through the carapace's canvas (clicks by position, keys from the page).
- `tests/history.test.mjs`: the engine's session history, which every client-side router stands on.

## Session history (found by React Router)

Ladybird keeps session history in the UI process; the renderer only asks for operations
(`Page::page_did_request_history_operation`). Chitin had no UI process, so `history.pushState` changed the URL but there was
no entry list: `history.length` was 0 and `history.back()` did nothing. `engine/platform/Host.cpp` now plays the UI process's
part for one document: it keeps the entries (`describe_active_entry`), answers the same-document finalize and traverse-by-delta
operations by running the renderer's own jobs (`run_ui_changing_navigable_history_job`, `apply_ui_changing_navigable_continuation`:
URL, `history.state`, `popstate`, `hashchange`), and publishes `history.length`. Also needed: the parsed document is no
longer the "initial about:blank" (every pushState counted as a replace), its document state is populated with its origin, it has
a latest entry, and the Navigation API entry list is initialised.

Not done: a traversal across documents. A cross-document navigation is a new segment (the carapace's), so `history.back()` past
the document's first entry does nothing; a tab-level history in the carapace is its own piece of work. Operations other than
same-document finalize and traversal (reload, navigable creation and destruction, Navigation API traversals) are not answered,
as before; answering navigable creation with an error broke nested iframes (M5), so they are left alone on purpose.

## Keys

The carapace used to send only `keydown` with the key's text; Enter, Backspace, the arrows and `keyup` never reached pages.
It now sends keydown and keyup with `key` and the modifiers, and the Worker maps named keys to Ladybird's key codes.

## What else the apps found

Each is a general fix with a class-level test, not a framework special case.

- **One microtask queue** (`glue/engine/40-bridge.js`, `installQueueMicrotask`). The page's `queueMicrotask` was LibWeb's own queue, drained at
  other moments than V8's promise jobs; Svelte 5 flushes from `queueMicrotask` and awaits `tick()` (a promise), saw the two out of order and
  a flush that never came: a SvelteKit navigation hung. It is the host's `queueMicrotask` now (tests/microtasks.test.mjs).
- **Iterators of the iterable interfaces** (`classForPrototype` in the same file). `new URLSearchParams(...).keys()` (and Headers, FormData)
  came across as a snapshot without `next`; SvelteKit's start script iterates `url.searchParams.keys()`. A host object with an interface
  prototype is wrapped, and the runtime's `%IteratorPrototype%` is the host's (tests/iterables.test.mjs).
- **Event handler content attributes** (`js_function_compile_dynamic` and `js_function_instantiate_dynamic` in `Misc.cpp`, the
  `ganglion_host_js_new_function` import): `onclick="..."`, `<link media=print onload="this.media='all'">` (Angular's production index.html) trapped
  as unimplemented. The text becomes the host's `new Function(params, body)`; the `with` scopes of the spec (element, form, document) are not
  available to a host function (tests/handlers.test.mjs).
- **A classic script's relative `import()`** (`harness/segment/worker.js` `runScript`, `sw.js` `mirrorTarget`, `Host.cpp` `unmirror`). A classic
  script is run by `importScripts` of a staged URL; the staged URL was `https://<site>/...`, cross-origin to the Worker, so the script was
  fetched without CORS and its base URL for `import()` was about:blank: `import("./_app/start.js")` failed to resolve. The script now
  runs from a name in the segment's mirror of the site, `http://<segment>.localhost/__chitin/o/https/<host>/<dir>/`, which the service
  worker maps back to the site's URL for the engine; the engine unmirrors the mirror URLs modules derive (`import.meta.url`) and lets
  CORS-mode requests for the document's own site's files through (tests/mirror.test.mjs). Not covered: a root-relative `import("/x.js")` from such a
  script resolves to the segment's own root; and a module imported both through the mirror and from a module script is two instances.
- **Test harness**: `settle()` in tests/engine-run.mjs returned before V8's promise jobs had run (a router's guard chain advanced a step
  per call); it now lets the event loop turn once.
- **Keys in Chrome**: see above. Clicks in the Chrome groups scroll the target into view and wait for the layout to settle first.

- **Custom elements** (the largest): `customElements.define(name, PageClass)` read `PageClass.prototype`, `observedAttributes`, `formAssociated`
  and the lifecycle callbacks off the foreign function, which could carry no properties (host functions have call and construct only in the
  engine's ABI). The runtime lets a host function class carry property hooks in `user_data` (`object_hooks_of` in Object.cpp), and the bridge's
  foreign functions use them. Then `super()` from a page class into the engine's `HTMLElement` passed no NewTarget (`constructCell` passed 0), so
  the engine saw `new HTMLElement()` and refused: it passes it now. An element whose prototype the engine took from NewTarget is wrapped with the
  page's own prototype (`wrap`; before, the mirror made a fake class named after the page's), so `instanceof`, upgrades and fragment-parsed
  elements work. An observable array (`adoptedStyleSheets`) had no `length` (the runtime's host arrays did not carry it): it reads back, as a
  snapshot (a `push` on it does not reach the engine). Tests: tests/customelements.test.mjs.
- **Structured clone of page values** (`cloneForEngine`/`buildClone` in the bridge, `ganglion_v_object_create`, `_array_create`, `_date_create`,
  `_define_data`): `history.pushState(state)`, `postMessage` and `structuredClone` serialized the page's value in the engine, which saw a
  foreign object and produced `{}` for arrays, Dates and anything with an array in it: Next.js keeps its router tree (nested arrays) in
  `history.state` and its Back button failed. These calls now get a copy built in the engine (objects, arrays with holes, Dates, binary data,
  cycles), and what a browser refuses (functions, symbols, DOM nodes) or this engine does not copy yet (Map, Set, RegExp, Error) throws
  DataCloneError rather than becoming `{}`. Behind it, a runtime bug: `Object.keys`-style enumeration of the engine's own arrays looked the
  index keys up as strings (`key_of_value` in Object.cpp), so engine-side serialization of any array lost its elements. A Date coming back
  is a Date. Tests: tests/structuredclone.test.mjs. Not done: Map/Set/RegExp/Error, the copy that comes back is a snapshot (cycles are cut at depth two).
- **`document.currentScript` in the script's microtasks** (patch 0023, `HTMLScriptElement`; `afterMicrotasks` in the Worker): HTML runs the microtask
  checkpoint at the end of running a classic script, before currentScript is reset; the page's promise jobs run on the host's queue after the
  engine's call returns, so Turbopack's runtime (it reads currentScript in a continuation) found null. An outermost classic script now stays
  currentScript until a host task after those microtasks. Approximation: microtasks of a script that ran earlier in the same turn see the
  last script of the turn (tests/currentscript.test.mjs).
Environment notes: Node on this Mac was 22.14 when the apps were made (it became 22.23 during the work), so the apps use the newest tools that support it: SvelteKit 2.70 (Kit 3 needs 22.17), Astro 6.4
(Astro 7 needs 22.23), Angular 21.2 (Angular 22 needs 22.22). Angular's npm resolver crashes on its peer set (npm 10.9); the app has an `.npmrc`
with `legacy-peer-deps`. Bundlers: React, Vue and Svelte by Vite 8 (Rolldown), Astro by Vite 7 inside Astro, Angular by esbuild
(`@angular/build`), React again by webpack 5 (classic scripts and JSONP chunks), Next.js will be webpack or Turbopack.

## Tailwind CSS v4 (measured)

`tools/frameworks/tailwind` builds two pages with the Tailwind v4 CLI into `harness/sites/tailwind.example`: `index.html`, a 19 KB stylesheet (a landing
page: `@layer` and `@theme`, custom properties, `@property`, `oklch()`, `color-mix()` and opacity modifiers, container queries, `:has()`, nesting,
grid and flex utilities, gradients, rings and shadows, `dark:` and responsive variants, `transition`), and `big.html`, 1500 cards with a seeded mix
of utilities (a 2723-rule stylesheet, 6008 elements, 46,040 px tall).

**Correctness.** `tools/frameworks/tailwind/measure-chrome.mjs` measures the small page in Chrome for Testing 154 (light scheme, 1100 x 1400):
`tests/fixtures/tailwind-chrome.json`. Chitin matches it: colours (sRGB within 1/255, whatever the syntax), grid track sizes, paddings, radii, shadows,
borders, transforms, container-query and `:has()` results, and box geometry within 0.1 px (a line is 20.02 px in Chitin, 20 in Chrome with another font:
the page is 0.06 px taller). Two serialisation differences, not visual: `border-top-color: currentcolor` resolves to `rgb()` where Chrome keeps the
author's `oklch()`; `color-mix()` results agree to the sixth digit. `tests/tailwind.test.mjs` (Node) and a Tailwind group in `make chrome-test`.
No engine fix was needed for the small page. One thing seen and not explained: right after load `document.getAnimations()` lists 7 transitions (the `transition`
utilities, from the unstyled colours, 150 ms), so a frame painted within 150 ms shows the buttons grey; they finish on their own. Whether Chrome starts them too was not measured.

**Speed** (Node on the Mac, `node tools/frameworks/tailwind/measure-big.mjs chitin`; Chrome: `... chrome` under the browser lock; three runs each, medians):

| big.html | Chrome 154 | Chitin |
|---|---|---|
| load | 65 to 70 ms | 1.7 to 2.2 s (load, settle and first paint) |
| style + layout of the whole page after the root font size changes | 61 ms | 1.0 to 1.1 s |
| style + layout after one element's class changes | under 0.1 ms | under 0.1 ms |
| `getComputedStyle(card).backgroundColor` for 1500 cards | 0.9 ms | 160 to 185 ms (the bridge: about 0.1 ms a call) |

About 17 times Chrome's time for a full recalculation. A CPU profile of the recalculations (`node --cpu-prof`) is flat: wasm memory growth (`sbrk`)
about 10 %, malloc and free about 9 %, the host's garbage collector about 6 %, the Rust style engine's property computation about 4 %, and about 12 %
tokenizing and parsing the same `var()` values again for every element (`consume_a_token`, `consume_a_component_value`, `substitute_tokens`,
`parse_css_value_after_substitution_scan`): Tailwind's shadows, rings, gradients and transforms are `var(--tw-...)` chains. Wasm memory grows by about 25 MB
for each full recalculation (209 MB after load, 389 MB after eight) and a collection frees none of it that shows: not understood yet.

Not done: caching the substituted values per element or per custom-property state (upstream, in Ladybird's Rust style code: a pull request after reading
its contribution policy), building the Rust crates with LTO and one codegen unit (the `distribution` cargo profile, not what the build uses), and a profile of layout
apart from style. These are the next steps if the owner wants Tailwind-sized pages faster.

## Matrix

| Framework | Result | Notes |
|---|---|---|
| React 19 + React Router 7 (Vite 8, Rolldown) | works | Node and Chrome |
| Vue 3 + Vue Router 5 (Vite 8) | works | Node and Chrome |
| SvelteKit 2 + Svelte 5 (Vite 8, adapter-static, prerendered, hydrated) | works | needed one microtask queue, URLSearchParams iterators, relative import() from classic scripts |
| Astro 6 (static pages, ClientRouter view transitions, module scripts) | works | module scripts that wait for `astro:page-load` can miss it: modules start later here than in a browser |
| Angular 21 (esbuild application builder, zoneless, lazy routes, HttpClient) | works | needed event handler content attributes (`<link onload=...>`) |
| React 19 + React Router 7 (webpack 5, JSONP chunks, React.lazy) | works | classic scripts and injected chunk scripts; Vite builds cover the ES-module path |
| Solid 1 + @solidjs/router (Vite) | works | Node and Chrome |
| Lit 3 (web components, shadow DOM, adoptedStyleSheets, lazy views, hand-written router) | works | needed foreign-function properties, NewTarget across the bridge, custom-element prototypes, observable array length |
| Next.js 16 (App Router, static export, Turbopack) | works | needed structured clone of arrays (router tree in history.state) and currentScript held for the script's microtasks |
| jQuery 3.7 multi-page site (document-ready, delegated events, $.getJSON, slideToggle) | works | Node and Chrome; every link is a navigation |
| Tailwind CSS v4 page (small and a 1500-card one) | works; slow on the large page | style and layout match Chrome's measurements; a full recalculation takes about 17 times Chrome's time (docs/frameworks.md, Tailwind) |
