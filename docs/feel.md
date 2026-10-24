# Chitin: how scrolling feels (m9)

Owner report after m8: "scrolling lag is still pretty bad" in their own Chrome on real sites. This page says how feel is
measured against Chrome, what was found, what changed and what is still open. Builds on `docs/scroll.md` and
`docs/compositor.md`.

## How it is measured (`make feel-test`, `tests/chrome/feel.mjs`)

One Chrome for Testing 154 (headless, GPU when no other agent had one up; every run here was GPU), 1280x800, smooth
scrolling off (wheels apply at once, as a trackpad's do). Each site is loaded in plain Chrome and in Chitin (the
carapace in the same browser), and both are measured the same way: wheel events go in over DevTools, every frame
comes back on the screencast with its swap timestamp, and the vertical shift of the page's content per frame is read
from row signatures.

| Number | How |
|---|---|
| wheel p50/p95/p99 | 12 mouse-wheel notches of 100 px, 250 ms apart: dispatch to the first frame that moved |
| fling p50/p95/p99 | a trackpad-like momentum stream (60 events 16 ms apart, deltas ramping up then decaying, ~1000 px): dispatch to the frame showing that event's cumulative offset |
| late / stalled | frames more than 25 ms apart while the input moves the page / frames where the content did not move although input had moved it |
| engine paint, raster, tiles | Chitin's trace: per engine frame |
| checkerboard | composites with scroll-layer pixels that had no tile |
| slow wheels | wheels the carapace had to send to the engine (not threaded), with the reason |
| first content | navigation to the first screencast frame whose page area is not one flat colour (both browsers) |
| peak MB | resident memory of the browser's whole process tree during the run (one tab open) |
| engine first load | the 61 MiB ganglion.wasm download / compile / instantiate and a corpus page to ready, cold (HTTP cache cleared) and warm |

Low-end profile (`FEEL_THROTTLE=4,6`): DevTools CPU throttling (`Emulation.setCPUThrottlingRate`) slows a page's main
thread only; Chrome refuses it for dedicated Worker targets ("only supported for pages"), and Chitin's engine runs in
one, so it would have slowed Chrome alone. Instead every renderer process of the browser is duty-cycled to 1/rate of
the CPU (`tests/chrome/throttle-procs.mjs`, SIGSTOP/SIGCONT every 20 ms). It approximates a school Chromebook's CPU
(Celeron N4500 / MediaTek Kompanio class, 4 GB). It does not model their GPU, eMMC storage or memory pressure, and it
also stalls the compositor thread, which a slow CPU does not. No memory cap was applied: peak memory is reported.

Noise: the Mac ran other agents' builds and browsers meanwhile (load 4-30). Chrome's own numbers moved by 2-5x between
runs on the same page (YouTube fling p50 35 to 231 ms); one run per cell below. Engine paint/raster/tiles are
stable to ~20%; latencies need `FEEL_RUNS=3` before a small difference means anything.

## Findings and fixes, in order of felt impact

| | Finding (measured) | Fix |
|---|---|---|
| F1 | **Page-wide repaint after DOM changes.** The display list's damage was one union rect, applied to every layer whose content hash changed. YouTube: the root background fill is the viewport at the scroll offset (the root has no overflow rect), so it moved with every scroll and damaged the whole view each frame; a hovered thumbnail's preview plus anything else changing gave a rect spanning both. | Ladybird patch **0084** (LibCompositing `damage.rs`): damage as a region (a few rects) and each damaged command's rect tagged with its run, so a layer rasters only its own commands' damage; a solid fill that only moved/resized damages the strips it uncovers/covers. Chitin `Layers.cpp` uses the tags. Test `comp.example/mutate.html` (21 mutations checked against the flat paint; one card's colour = one 255x160 part). Committed alone (d558be4, merged to main). |
| F2 | **A standing animation-frame loop in the carapace delays wheel delivery.** Headless Chrome hands a main-thread wheel listener the event about one frame later while the page asks for a frame every frame: micro test, non-passive listener 28 ms vs 50 ms with an empty rAF loop (and 14 vs 28 in a quieter run; a timer-driven canvas draw costs the same as rAF). The carapace's compositor loop, its tick loop and its gamepad poll all ran every frame; the engine re-sent identical layer trees every tick. | Composite only when something changed; ticks follow animation frames only while the engine is painting, else a 16 ms timer; gamepads polled only while one is connected; a layer tree equal to the last (raster ms aside) is not applied. Input wakes a tick that waits on the timer at once. Wikipedia wheel delivery to our handler p50 30 -> 9 ms, notch input->shown 47 -> 35 ms in back-to-back runs (Chrome 15). |
| F3 | Pages that are painting every frame anyway (a playing preview, Spotify/BBC asking for a frame each tick) keep the host in that state: wheels reach the carapace ~a frame later than on idle pages. Inherent to a compositor whose input is a main-thread DOM listener; Chrome's own compositor thread does not have it. | Not fixed. Options: keep the engine's no-op ticks off animation frames (done for identical trees), and longer term native host scrolling of the tile layers (a host scroll container per scroll layer, scrolled by Chrome's compositor thread). |
| F4 | Wikipedia records its display list on every tick while idle (page-client frame requests + a re-record, `paint reasons` status line); Spotify and BBC ask for a frame every tick without a change. ~1.2 ms a tick on the M4 Max, ~8 ms at 6x. | Diagnosed only (`ganglion_needs_paint_reasons`, status "paint reasons"). The source of the re-record is in LibWeb (style/visual-context invalidation); next step. |
| F5 | Under 4-6x throttling YouTube's own scripts keep the engine busy for hundreds of ms: the page had no scroll layers yet 15 s after load (all wheels "no scroll nodes"), engine frames 150-900 ms apart. Chrome's main thread is equally busy but its compositor scrolls. | Not fixed; the engine's JS/layout speed under a slow CPU is the limit here, not the compositor. |
| F6 | BBC News: the fixed bottom subscription banner shows as a white strip in Chitin (Chrome draws it); ~9 of 12 wheel notches show no motion within 240 ms on BBC in Chitin (Chrome 0). | Recorded, not investigated yet. |
| F7 | Reddit refuses Chitin ("blocked by network security"), as in m8: no scrolling to measure. | Policy, not pursued. |
| - | rAF pipelining (engine paint of N+1 overlapping composite of N): already so (engine in the segment Worker, composite on the carapace thread). Compositing a frame the moment it arrives instead of at the next rAF would not show it sooner: a canvas update is committed at the next main frame either way. | Nothing to change. |

## Results (Chrome for Testing 154, GPU, 1280x800; main = 3f18327 + cousine engine, m9 = 1b56d8b)

ms are input -> frame shown (screencast) p50/p95/p99; "missed": notches with no motion within 240 ms. `-`: nothing
moved (the page was not scrollable yet, or refused).

| site | profile | Chrome wheel | Chitin main wheel | Chitin m9 wheel | Chrome fling | main fling | m9 fling | Chrome late/stalled | main late/stalled | m9 late/stalled | main paint p50/p95 | m9 paint p50/p95 | main checker | m9 checker | m9 slow wheels | first content Chrome / main / m9 | peak MB Chrome / m9 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| youtube-results | 1x | 6/30/30 | 66/101/101 | 50/100/100 | 70/104/108 | 67/148/154 | 91/346/362 | 25/6 | 29/1 | 31/1 | 8/33 | 3/20 | 1/123 | 1/124 | 0+0 | 2012 / 521 / 609 | 2709 / 3895 |
| youtube-results | 4x | 24/124/124 | -/-/- (missed 12) | -/-/- (missed 12) | 86/125/129 | -/-/- | 62/87/87 | 20/6 | 1/0 | 19/0 | 0/287 | 44/147 | 0/12 | 13/40 | 12+0 | 3472 / 1878 / 1430 | 2035 / 3067 |
| youtube-results | 6x | 71/176/176 | -/-/- (missed 12) | -/-/- (missed 12) | 80/159/178 | -/-/- | -/-/- | 19/9 | 1/0 | 1/0 | -/- | 0/364 | 0/0 | 3/3 | 12+57 | 2912 / 985 / 2846 | 1819 / 2993 |
| youtube-watch | 1x | 26/109/109 | 63/65/65 | 61/63/63 | 85/112/112 | 158/465/548 | 72/321/355 | 22/3 | 28/4 | 32/1 | 16/50 | 3/20 | 8/68 | 0/52 | 0+0 | 1161 / 663 / 487 | 1925 / 4805 |
| youtube-watch | 4x | 80/181/181 | -/-/- (missed 12) | -/-/- (missed 12) | 79/126/141 | -/-/- | -/-/- | 20/9 | 2/0 | 0/0 | 0/0 | 109/109 | 0/2 | 0/1 | 12+56 | 966 / 2182 / 1687 | 2187 / 4093 |
| youtube-watch | 6x | 172/223/223 (missed 2) | -/-/- (missed 12) | -/-/- (missed 12) | 72/142/173 | -/-/- | -/-/- | 20/8 | 1/0 | 1/0 | -/- | -/- | 0/0 | 0/0 | 12+54 | 1455 / 1159 / 2532 | 2087 / 4034 |
| spotify | 1x | 64/66/66 | 66/67/67 | 61/62/62 | 288/371/382 | 52/69/72 | 51/68/70 | 29/5 | 30/1 | 30/0 | 2/8 | 1/8 | 0/190 | 0/34 | 0+0 | 2075 / 864 / 499 | 2372 / 4406 |
| spotify | 4x | 69/107/107 | 54/64/64 (missed 8) | 63/81/81 | 341/425/431 | -/-/- | 63/85/86 | 18/4 | 16/1 | 19/0 | 21/113 | 1/63 | 0/79 | 0/33 | 0+0 | 1847 / 2567 / 1339 | 3212 / 4924 |
| spotify | 6x | 67/179/179 | 64/83/83 | 66/76/76 (missed 8) | 342/430/439 | 88/135/138 | 411/584/584 | 19/5 | 16/1 | 13/1 | 2/41 | 21/203 | 0/95 | 4/33 | 8+16 | 2753 / 1163 / 2821 | 3139 / 4706 |
| wikipedia | 1x | 12/45/45 | 64/66/66 | 61/63/63 | 218/688/688 | 53/68/70 | 53/69/70 | 23/6 | 31/2 | 30/0 | 2/5 | 1/2 | 0/198 | 0/33 | 0+0 | 639 / 1503 / 538 | 2396 / 2849 |
| wikipedia | 4x | 11/33/33 | 69/77/77 | 56/81/81 | 60/97/113 | 86/198/221 | 65/87/89 | 18/5 | 14/2 | 16/1 | 2/19 | 1/2 | 0/314 | 0/33 | 0+0 | 313 / 1864 / 1636 | 1449 / 2463 |
| wikipedia | 6x | 17/64/64 | 68/78/78 | 53/84/84 | 69/107/123 | 66/90/100 | 64/84/85 | 19/5 | 19/0 | 17/0 | 1/21 | 1/20 | 0/112 | 0/33 | 0+0 | 376 / 1345 / 2692 | 1439 / 2434 |
| reddit | 1x | 4/5/5 | 49/49/49 (missed 11) | 48/48/48 (missed 11) | -/-/- | -/-/- | -/-/- | 27/0 | 28/0 | 0/0 | 0/0 | 0/0 | 0/29 | 0/0 | 11+58 | 635 / 512 / 539 | 1315 / 2224 |
| reddit | 4x | 14/28/28 | 75/75/75 (missed 11) | 53/53/53 (missed 11) | -/-/- | -/-/- | -/-/- | 19/0 | 21/0 | 0/0 | 0/0 | 0/1 | 0/29 | 0/0 | 11+58 | 165 / 1859 / 1933 | 1250 / 2195 |
| reddit | 6x | 46/60/60 | 76/76/76 (missed 11) | 86/86/86 (missed 11) | -/-/- | -/-/- | -/-/- | 17/0 | 18/0 | 0/0 | 0/0 | 0/0 | 0/30 | 0/0 | 11+55 | 199 / 2689 / 2754 | 1249 / 2173 |
| news | 1x | 4/103/103 | 32/50/50 (missed 9) | 51/51/51 (missed 9) | 178/433/519 | 128/389/440 | 119/391/441 | 24/5 | 30/0 | 30/0 | 1/9 | 1/11 | 0/39 | 0/34 | 0+0 | 712 / 520 / 527 | 1677 / 4112 |
| news | 4x | 16/108/108 | 65/76/76 (missed 8) | 35/121/121 (missed 9) | 63/109/121 | 65/84/87 | 141/398/425 | 18/4 | 18/0 | 20/1 | 1/24 | 1/23 | 0/38 | 2/31 | 0+0 | 463 / 1681 / 1473 | 1697 / 3554 |
| news | 6x | 14/100/100 | 175/222/222 (missed 8) | 124/138/138 (missed 8) | 66/104/122 | 199/637/637 | 136/433/499 | 17/5 | 19/5 | 19/2 | 1/41 | 1/40 | 3/35 | 0/32 | 0+0 | 453 / 2194 / 941 | 1797 / 3282 |
| github | 1x | 4/6/6 | 65/67/67 | 38/71/71 | 110/265/300 | 53/71/72 | 51/69/72 | 23/4 | 29/0 | 29/1 | 1/4 | 1/4 | 0/33 | 0/31 | 0+0 | 1916 / 530 / 660 | 1623 / 2595 |
| github | 4x | 9/18/18 | 59/81/81 | 57/83/83 | 139/455/461 | 64/82/86 | 65/83/86 | 19/3 | 23/1 | 20/2 | 1/23 | 1/23 | 0/34 | 0/32 | 0+0 | 606 / 1340 / 1601 | 1663 / 2589 |
| github | 6x | 15/61/61 | 54/63/63 (missed 5) | 83/231/231 (missed 7) | 120/253/298 | 66/89/98 | 65/86/96 | 18/5 | 19/0 | 20/0 | 1/60 | 1/23 | 0/35 | 0/32 | 0+0 | 1260 / 2692 / 2264 | 1620 / 2663 |

main engine load @1x: cold {'readyMs': 705, 'engine': '35 / 25 / 12.2 ms (61.0 MiB)', 'stopped': None}, warm {'readyMs': 500, 'engine': '30 / 25 / 12.5 ms (61.0 MiB)', 'stopped': None}
main engine load @4x: cold {'readyMs': 768, 'engine': '32 / 25 / 12.3 ms (61.0 MiB)', 'stopped': None}, warm {'readyMs': 648, 'engine': '29 / 25 / 12.5 ms (61.0 MiB)', 'stopped': None}
main engine load @6x: cold {'readyMs': 899, 'engine': '29 / 26 / 12.5 ms (61.0 MiB)', 'stopped': None}, warm {'readyMs': 742, 'engine': '46 / 26 / 12.3 ms (61.0 MiB)', 'stopped': None}
m9 engine load @1x: cold {'readyMs': 713, 'engine': '30 / 24 / 13.0 ms (61.0 MiB)', 'stopped': None}, warm {'readyMs': 501, 'engine': '26 / 25 / 12.8 ms (61.0 MiB)', 'stopped': None}
m9 engine load @4x: cold {'readyMs': 728, 'engine': '44 / 26 / 12.6 ms (61.0 MiB)', 'stopped': None}, warm {'readyMs': 608, 'engine': '26 / 26 / 12.3 ms (61.0 MiB)', 'stopped': None}
m9 engine load @6x: cold {'readyMs': 882, 'engine': '46 / 26 / 12.4 ms (61.0 MiB)', 'stopped': None}, warm {'readyMs': 2287, 'engine': '122 / 94 / 80.5 ms (61.0 MiB)', 'stopped': None}

Engine first load (ganglion.wasm 61.0 MiB from the local harness, then comp.example/article.html to ready): cold
705-899 ms, warm 500-740 ms at 1-6x on both trees; the module itself is 26-46 ms download (loopback) / 24-26 ms
compile (V8 compiles lazily) / 12-13 ms instantiate. Over a real network the 61 MiB download dominates (not measured
here: the harness serves it from loopback).

Damage alone, back to back on the same engine build pair (same carapace; YouTube results, 1x): engine paint p50/p95
8/29 -> 2/15 ms, tiles p95 30 -> 18, wheel 55/81 -> 26/29 ms, fling 69/150 -> 31/42 ms (Chrome 35/51 in that run);
4x: fling 68/320 -> 59/77 ms. Spotify and BBC News: unchanged (not damage-bound).

## Paint profile (coordinator, after the damage fix: "painting must actually be fast")

Measured with the trace's per-frame split (layout, display-list record, raster, raster per command type through Ladybird
patch 0085's replay profiling hook, the RGBA conversion, the Worker's tile hand-over, the carapace's upload; feel-test
prints it). Totals over a scroll run, 1x and 4x (renderer duty-cycle):

| Site | Painted frames | Layout | Record | Raster (commands: top) | Convert + hand-over + upload |
|---|---|---|---|---|---|
| Spotify playlist, 1x | 207 | 1 | 30 | 176 (text 25, scaled images 18, rounded rects 5) | 12 + 21 + 13 |
| Spotify, 4x | 92 | 28 | 101 | 388 (text 66, images 31, fill rects 20, gradients 18) | 59 + 34 + 9 |
| InvisiProxy (Scramjet frame, Wikipedia), 1x, before | 37 | 0 | 0 | 2509 (**composited context 2094**, text 410, fill rects 314) | 63 + 102 + 51 |
| InvisiProxy, 1x, after P1 | 123 | 0 | 0 | 2032 (composited context 667, repeated tile 170, fill rect 131) | raw tiles |
| YouTube results, 1x | 120 | 4 | 11 | 606 (scaled images 140, video 114) | 51 + 185 + 46 |

Where the time goes: on Spotify (logged out) painting is not the bottleneck at 1x (under 1 ms a painted frame); at 4x
record + raster reach 5 ms a frame. InvisiProxy was 65 ms a frame: the same-site frame (Scramjet's) was painted whole
for every tile that showed it (12 times a frame). YouTube: thumbnails drawn scaled, the hover preview's video frames,
and the Worker's ImageBitmap creation.

| | Fix | Result |
|---|---|---|
| P1 | A same-site frame's document is painted once per paint and not at all while its list, scroll offsets, canvases, media and animations are unchanged (Host.cpp `paint_child_context`). | InvisiProxy engine paint p50/p95 65/102 -> 17/22 ms; fling 142/190 -> 70/96 ms (Chrome 26/46) |
| P2 | Raw tiles: the WebGL2 carapace takes the engine's BGRA premultiplied rows as transferred bytes and swizzles in its shader (no RGBA conversion loop, no ImageData, no createImageBitmap in the Worker). `?tiles=rgba` keeps the old path. | YouTube hand-over 1.2 -> 0.6 ms a painted frame; reftests 0.00% |

Still open in the CPU path, measured: (a) InvisiProxy's wheels all take the engine path ("a non-passive wheel listener
region"; Chrome scrolls the same page in 6 ms), so each wheel re-rasters the frame's area (18 tiles): threading a
same-site frame's scrollers (its own layers) is the structural fix; (b) DrawRepeatedTile on InvisiProxy at 4x
(157 ms over a few frames: a cache miss path, not located); (c) YouTube's scaled thumbnails (no scaled-image cache,
Chrome's cc keeps decoded images at draw size); (d) per-tile raster overhead outside the commands is about half of
raster time (Spotify 120 of 176 ms: tile clears, save/restore, flush).

GPU raster (Ganesh on WebGL2, docs/gpu-raster.md): not started in this phase. What it takes, from reading the build:
Skia is built CPU-only (`tools/deps/skia.sh`: `skia_enable_ganesh=false skia_use_gl=false skia_use_webgl=false`), so a
second Skia variant with Ganesh + WebGL is needed (same pinned source, no new dependency; ~1 h build at JOBS=4, in a
separate out dir so the shared prefix is untouched). Ganesh's WebGL interface calls Emscripten's GL entry points
(`emscripten_gl*`), which Chitin's own glue does not provide: they would be implemented in the engine glue over a WebGL2
context on an OffscreenCanvas in the segment Worker (the WebGL transport of patch 0064 is page-facing and does not
cover them). Tiles would be rendered one at a time into that canvas and handed over with `transferToImageBitmap()`
(no readback). Estimate: several days, with the risk in the GL entry points and context-loss handling.

## Open, in order

1. F3: wheels arrive a frame late while anything animates. Native host scrolling of the tile layers is the structural
   fix; measure a prototype with `make feel-test`.
2. F4: find the LibWeb invalidation behind Wikipedia's per-tick re-record.
3. F6: BBC's fixed banner, and its missed notches.
4. F5: engine speed under a slow CPU (profile YouTube at 4x).
5. Memory: Chitin's browser tree peaks at 2.2-4.9 GB against Chrome's 1.3-3.2 GB on the same pages.
