# Chitin: scroll sync, checkerboard, paint cost, FOUC (m8)

Owner report (Spotify web player, logged in, M7 compositor, WebGL2): "scroll is definitely quicker but parts of the
page don't keep up with other parts". Measured first; this page says how, what was found, what changed. Builds on
`docs/compositor.md`.

## How it is measured

| Tool | What |
|---|---|
| `harness/sites/scroll.example` | Spotify-shaped page: side bar scroller, rounded main view scroller, sticky top bar recoloured by a scroll listener, parallax header moved by script, horizontal shelf (a nested scroller), sticky track header, cross-site iframe (`scrollframe.example`), IntersectionObserver lazy blocks, fixed now-playing bar. Every box is 8 px rows coloured `rgb(row & 255, row >> 8, id*16+8)`. `?square`: no rounded corners. |
| `tests/scroll-analyze.mjs` | Reads any frame: main offset from its rows, each part's error against that offset (tears), the part's visible extent (clip errors), pixels with no code (checkerboard), the scroll listener's lag, lazy placeholders. |
| `tests/chrome/scroll-sync.mjs` (`make scroll-test`) | Same wheel script (40x100 px, fling 12x400, 30x-150, side bar) in Chrome for Testing and in Chitin, every frame from the DevTools screencast (lossless PNG). Gate: no tear, no part off, checkerboard frames <= Chrome + 2. |
| `tests/chrome/scroll-sites.mjs` | Real sites (own relay): Chrome vs Chitin band motion per frame, plus Chitin's trace. |
| `chitinCarapace.trace(on)` | Per engine frame: layers (kind, node, m, clip, tiles, dirty tiles, raster ms, why rastered, damage rects), scroll nodes, raster [ms, tiles, on screen], video/frame boxes. Per composite: carapace offsets, scroll-layer px with no tile (`uncovered`), child rects. Per wheel: threaded, or why not. |

## Findings, in order of visible impact, and fixes

| | Finding (measured) | Class | Fix |
|---|---|---|---|
| B1 | A scroller that is not a layer (Spotify's rounded main view) moves its content inside other layers' tiles, but damage compared both lists at the new offsets: spans after a promoted box kept stale pixels (shelf drawn up to 1600 px from where it belonged, 117/136 frames). Main-thread and threaded paths alike. | b | Non-promoted scrollers compared at their old offsets (`Layers.cpp` damage). |
| B2 | A layer cut by its outer clip and moved rastered only the (empty) list damage: the sticky track header stayed a 4 px strip. | b | Moved + cut = raster what shows. |
| R1 | Scrollers under a rounded clip were never layers: every Spotify main-view wheel went to the engine ("the scroller is not a layer", 16/16 on open.spotify.com). | perf | Promoted with the radius; tiles inset by it; carapace clips the rounded rect (GL shader, software, DOM). scroll.example threaded 0 -> 79/97 wheels. |
| B3 | Cross-site iframes (GL backend) moved only when the child sent a frame: 26-33 of 41-48 frames off, up to 212 px; drawn over sticky/fixed layers. | b | Boxes applied with the parent's frame (atomic), moved/clipped with the carapace's scroll of their scrollers, drawn in paint order. |
| C1 | Wheels over an iframe that cannot scroll were swallowed (scrolling stopped at the iframe); the engine's latched-wheel fallback scrolled an `overflow: hidden` viewport. | b | `ganglion_wheel` answers whether anything can scroll; unused wheels go to the parent (Chrome's scroll chaining). |
| B4 | Layer clips did not move with the scrollers around their own (nested scroller cut at its old place under threaded scroll). | b | `LayerTree.clipOf`. |
| A1 | Wikipedia fling: 6-9 composites with 58-93% of the view uncovered. Tiles on screen at the carapace's offset counted as "ahead" (one per paint), and ahead tiles went in raster order (behind first). | a | On-screen tiles at either offset always rastered; ahead tiles by distance, the scroll side weighted 1/3 (Chrome's skewport idea), while the paint is under 6 ms. 0-2 composites. |
| D1-D3 | YouTube results: raster p50/p95 37/86 ms, 40 tiles a frame. Video frames / same-site frame changes forced full raster of every layer; a span whose range moved (appends) rastered whole; damaged tiles ahead all rastered in the same paint. | d | Damage = video/frame boxes; resplit damage = boundary runs; damaged ahead tiles invalidated and rastered by priority, old pixels kept. 17/43 ms, 29 tiles p95. |
| c | Scroll-linked script (parallax, top bar recolour) lags threaded scroll: 14/60 frames, p95 150 px. Chrome: 16/43, 150 px. | c | Same as Chrome (main-thread effect under compositor scroll); nothing to fix. IntersectionObserver lazy blocks: same as Chrome. |

Remaining, measured: YouTube still checkerboards on flings (13 composites) because its paints take 20-60 ms (upstream
damage is page-wide when the tree's contexts do not pair after DOM changes): raster cost, see `docs/gpu-raster.md`.
Reddit refuses Chitin ("blocked by network security"): recorded, not pursued (policy). DOM backend: child frames are
still canvases that do not follow threaded scroll (WebGL2 is the default).

## Results (Chrome for Testing 154, GPU, 1280x800)

| | Chrome | Chitin main | Chitin m8 |
|---|---|---|---|
| scroll.example: frames moved / tears / parts off | 74 / 0 / 0 | 23 / 0 / shelf 117, frame 26 | 74 / 0 / 0 |
| scroll.example checkerboard frames | 2 | 0-11 | 0 |
| scroll.example ?square (threaded) | PASS ref | - | PASS |
| Wikipedia fling, composites with uncovered tiles | - | 6-9 (up to 93%) | 0-2 |
| YouTube results raster p50/p95 | - | 37/86 ms | 17/43 ms |
| compositor-chrome-bench reftests | | 0.00% | 0.00% |

## FOUC (owner report: unstyled page for about a second)

Measured with `harness/sites/fouc.example` (stylesheets 1.5 s late; `make fouc-test`): Chrome shows blank -> styled,
and on a same-origin navigation keeps the old page until the new one is styled. Chitin showed unstyled frames on
load and blank + unstyled on navigation. LibWeb tracks HTML render-blocking, but `ganglion_paint` (our paint path)
ignored it; it also painted the initial about:blank. Now neither is presented, and the carapace holds the last frame
across same-origin navigations (paint holding, 4 s cap; Chrome held >1.5 s in the test; its exact timeout was not
measured). The stand-in also dropped request queries, so `?delay` tests never delayed: fixed.
