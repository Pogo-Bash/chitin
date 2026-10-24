# Chitin: the compositor (M7)

This page says what is built, how it works and what it measures.

## What it does

Before M7 the segment Worker painted one frame per tick: record the display list, find damage, replay it with Skia
in wasm, convert the pixels and send one ImageBitmap of the whole frame. Now the engine cuts the display list into
**layers**, rasters each layer on the CPU into **512 px tiles** in its own space, rasters again only the tiles its own
damage touches, and the carapace **composites** the tiles at host animation frames.

| Piece | Where |
|---|---|
| Layer split, per-layer damage, tiles | `engine/platform/Layers.{h,cpp}` |
| Ladybird support (patch 0050) | `LibCompositing`: replay a command range, run/command/node introspection, simple filter functions; `DisplayListPlayer`: replay range, skip backdrop filters |
| Frame message, validation | `harness/carapace/compositor.mjs` (`cleanLayerTree`, used by `guard.mjs`) |
| DOM backend | `compositor.mjs` `DomCompositor`: a canvas per tile under CSS `matrix()` and clip boxes |
| WebGL2 backend | `harness/carapace/glcompositor.mjs` |
| Software backend (tests) | `compositor.mjs` `SoftwareCompositor` |

## Modes and the debug flag

- Carapace `?compositor=flat` is the old path (one frame per paint) and the reference the tests diff against;
  `?compositor=dom` (the default) composites layers.
- Engine: `ganglion_set_compositor(0|1|2)`, glue `engine.setCompositor('flat'|'layers'|'gpu')`. `layers` rasters a
  backdrop-filtered box in the engine together with what is behind it; `gpu` leaves blur/saturate backdrop filters to
  the carapace (the box's own layer is rastered without its backdrop). The DOM backend asks for `gpu` when the host has
  CSS `backdrop-filter` (it draws the blur as a `backdrop-filter` box, which the host browser runs on its GPU), else
  `layers`.
- `ganglion_debug(32)` logs the per-layer decisions (hash changed, damage, needed region) and, when a list is
  recorded again, which runs' bytes changed.

## The layer split (engine)

1. Promoted spatial nodes: scroll containers (translation-only, with a rectangular scrollport at least 64 px each
   way), sticky boxes, and roots of running transform animations (2D affine). `will-change` is not visible in the
   visual context tree and does not promote yet.
2. Every run of the display list is keyed by its nearest promoted node. An opacity/filter/mask/blend effect whose runs
   fall under several keys moves them all to the keys' common ancestor: a group effect is never split. A run that reads
   what is behind it (backdrop-filter, a blend mode) is its own span.
3. Spans: maximal sequences of commands with one key in paint order. A `DrawCanvas` command is a span of its own.
   Spans are the layers; position:fixed content needs nothing special (it sits outside the viewport's scroll node).
   Over 32 spans, or a 3D sorting context: one layer.
4. Each layer: a content hash over its own command bytes, its runs' contexts and the clip/effect values relative to
   the layer's node. Unchanged hash: nothing is rastered, whatever else moved. Changed: the list's damage (both lists
   compared at the new offsets, so a scroll alone is no damage) mapped into the layer's space. Scroll bars of a
   scroller that moved: their own rects.
5. Tiles: a scroll layer's tiles cover the scrollport and two scrollports ahead each way, whole tiles only, a tile
   rastered with the scroll offset that places it inside the scrollport (so the scrollport's clip never cuts it; the
   carapace clips). Tiles off screen are rastered ahead at most one per paint, and the engine asks for another paint
   until they are done. A canvas drawn 1:1 is copied straight from its pixels.
6. Out: the layer tree as JSON (`ganglion_layers_json`) and each dirty tile part as RGBA (not premultiplied); the
   Worker sends them as transferred ImageBitmaps.

## Frame message

`{ w, h, fill, flat, layers: [{ id, kind, node, m: [a,b,c,d,e,f] (layer -> viewport), tw, th, ms, clip?, offset?,
canvas?, backdrop?: { region, radius, blur, saturate }, tiles: [[i,j]...] }], scroll: {...}, dirty: [[layer, i, j, x,
y, w, h]...] }` with one ImageBitmap per `dirty` entry. The carapace checks every field (`cleanLayerTree`: kinds,
finite numbers, at most 64 layers, 512 tiles a layer, parts within a tile, bitmap sizes equal to the part).

## Invariant

Only painting and compositing follow the host's animation frames. Engine tasks, input events and microtasks run when
they arrive, as before (input is applied and the engine pumped in the same message handler).

## Benchmarks

`make compositor-bench` (Node: engine paint/raster per frame, 1280x800) and `make compositor-chrome-bench` (Chrome for
Testing: wheel timestamp to the frame containing it, from the carapace's input sequence numbers, and the Worker's
segment paint). Corpus: `harness/sites/comp.example` (particles under ten backdrop blurs, a long article, a sticky
header with a fixed button, an inner scroller). YouTube is measured by hand (needs the network). Baselines:
`bench/compositor-*-baseline.json`; a run more than 20% worse fails.

## Tests

`tests/compositor.test.mjs` (in `make engine-js-test`): every corpus page composited by the software backend against
the flat paint of the same state (pixel diff <= 1%; 2% for GPU blurs drawn with three box blurs), at rest, after
scrolling and after animation frames; scrolling within tiles rasters no tile on screen; an inner scroller leaves the
page around it alone but for its scroll bar; the guard refuses malformed trees.

## Results

See the phase sections below (numbers as measured, Mac under load from other agents).

### P0 + P1 (2026-10-22, commit on m7)

Node (`make compositor-bench`, 1280x800, ms p50/p95, flat -> layers with host backdrop):

| page | flat paint | layered paint | layered raster | note |
|---|---|---|---|---|
| blur (canvas + 10 backdrop blurs) | 23.1 / 25.4 | 1.6 / 3.0 | 1.1 / 2.4 | engine-rastered backdrops (`layers` mode): 20.6 / 22.6 |
| article (wheel/scroll steps) | 1.0 / 1.9 | 1.0 / 2.8 | 0.9 / 2.6 | p95 is a tile rastered ahead |
| inner scroller | 3.2 / 4.1 | 0.3 / 2.2 | 0.26 / 2.1 | on screen only the scroll bar (~3.8k px); p95 = one tile ahead |

Chrome for Testing 154 (`make compositor-chrome-bench`): blur segment paint 14.5/18.6 -> 2.3/2.9 ms; scroll
input -> frame p50/p95 stays ~33/35-40 ms on all three scroll pages (main-thread scroll until P3).
Targets: blur paint <= 4 ms met; inner-scroller raster <= 1 ms met at p50 (visible part 0.2 ms), not at p95 (2.1 ms,
the tile rastered ahead in the same paint).

### P2 (WebGL2 backend, transform/sticky/fixed layers, GPU backdrop blur, nested segments as layers)

- `?compositor=webgl` is the default where WebGL2 exists: one canvas per top segment; everything is drawn into an
  offscreen target that backdrop passes read directly; blur at half size for sigma >= 4 (horizontal pass halves with
  linear filtering, vertical pass at half size), saturate, rounded region; nested segments (cross-site iframes) are
  textured quads in the same canvas over the parent's layers (`setExternal`), instead of canvas elements.
- Running transforms: a transform node whose local matrix changed in the last 60 paints is promoted (LibWeb publishes
  compositor animations only to a compositor host). Fixed: before this, CSS transform animations did not move at all
  in Chitin's flat path either: the paint reused the last tree when nothing was recorded again, and LibWeb updates
  transform values in the tree in place; the paint now takes the document's tree whenever it fits the list (and
  samples visual animations when there are any).
- A layer whose span covers other commands than last frame is rastered again whole (the list's damage cannot see a
  moved split).
- Opacity is baked into a layer's tiles (an opacity group is never split); carapace-side opacity is for P4.

Measured (Chrome for Testing 154 on the M4 Max, ANGLE Metal; Mac under load):

| | before (flat) | P2 |
|---|---|---|
| blur page segment paint p50/p95, 800x600 tab | 14.5 / 18.6 ms | 2.5 / 2.9 ms |
| blur page segment paint p50/p95, 1920x1080 tab | - | 6.4 / 7.2 ms (canvas copy of 8 MB a frame) |
| composite, GPU waited for (readPixels), 1920x1080, article | - | 0.6 / 1.1 ms |
| composite, same, blur page (ten 12 px blurs) | - | 2.8 / 4.8 ms |
| reftest vs flat in Chrome (article rest/scrolled, scroller, sticky) | | 0.00 / 0.00 / 0.00 / 0.93 % pixels |

Targets: blur paint <= 2 ms not met at 800x600 (2.5 p50; the canvas copy-out, 4 MB a frame); composite <= 2 ms at
1080p met for plain pages, not for the ten-blur page (2.8 p50). EXT_disjoint_timer_query reported 6-9 ms on every page
including static ones under ANGLE Metal, so the GPU-waited wall time is what is quoted.

### P3 (threaded scroll)

- The carapace scrolls: a wheel over the view is hit-tested against the engine's wheel targets (paint order), chained
  to the enclosing scroller when one cannot move that way, and applied at once to the scroll layer (and every layer
  whose `chain` holds that node; sticky layers move by LibWeb's sticky formula, `stickyOffset`, vectors checked against
  the engine in the tests); composited at the next host animation frame.
- Then `{seq, node, x, y, dx, dy}` goes to the engine (`ganglion_scroll_sync`): the page's wheel listeners get the
  wheel with its default action done, the node scrolls by the same delta (so a script's `scrollTo` meanwhile composes),
  scroll/scrollend follow as for any user scroll. Each layered frame reports per node the last carapace scroll the
  engine applied (`hseq`) and its offset: carapace scrolls up to it are dropped, later ones stay on top. With none
  pending the engine's offset is what shows (the engine is the authority).
- Main thread (as before) when: a non-passive wheel listener on the way (LibWeb's blocking wheel regions, or one
  covering the viewport), a nested document region, a snap container, a scroller that is not a layer, or nothing
  left to scroll. `?scroll=main` turns threaded scroll off.
- Not done: overscroll-behavior, scrollbar dragging and keyboard scrolling on the carapace (they take the engine's
  path), a scroll that outruns the tiles shows the fill colour until the engine's next frame (tiles are rastered two
  scrollports ahead, one per paint).

Measured (Chrome for Testing 154, 1280x800 tab, 60 wheel steps, p50/p95 from the wheel event's timestamp to the
composite that shows it):

| page | main-thread scroll | threaded | our handler -> composite (p95) |
|---|---|---|---|
| article | 33.1 / 42.9 ms | 32.2 / 33.4 ms | 0.4 ms |
| sticky | 32.9 / 35.3 ms | 32.1 / 33.7 ms | 0.5 ms |
| inner scroller | 34.7 / 43.2 ms | 31.6 / 33.3 ms | 0.5 ms |
| busy (120 ms script task every 200 ms) | 99.7 / 153.2 ms | 32.9 / 33.7 ms | 0.2 ms |

Target p95 <= 16 ms: not met as measured. The ~32 ms floor is the same on every page and path: headless Chrome
delivers a DevTools-synthesized wheel about two frames after its timestamp; from our handler to the frame it is
under 1 ms. Scrolling within tiles rasters no tile on screen (Node test).

Found on the way (not compositor): the engine's main-thread wheel path stops after the first 100 px on
comp.example/sticky.html (a latched gesture; ganglion_wheel's fallback does not fire). Threaded scroll does not use it.
