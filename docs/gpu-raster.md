# GPU raster for Chitin: options, costs, what the numbers say (design note, not built)

Decision for the owner after the m8 measurements (`docs/scroll.md`). Nothing here is built.

## What raster costs today (measured, Chrome for Testing 154, M4 Max, GPU compositor)

| Page | Engine raster per frame p50 / p95 | Tiles rastered per frame (p95) | Per 512x512 tile |
|---|---|---|---|
| Wikipedia article, threaded scroll + fling | 0.15 / 6 ms (the 6 ms is the prefetch budget) | 6-8 | ~0.7-1 ms |
| YouTube results, scrolling while the list grows | 17 / 43 ms | 29 | ~1.5 ms |
| comp.example blur page (canvas + 10 backdrop blurs) | segment paint 4.1 / 4.9 ms (blurs on the carapace GPU) | - | canvas copy dominates |

After m8, scrolling within tiles costs zero raster; what is left is content that changes (YouTube: page-wide damage
when the visual context tree's contexts do not pair after DOM changes, so ~20 tiles a frame are rastered again). That
is the case GPU raster would speed up, and so would better damage: both are listed below.

## Options

| | (A) Skia Ganesh on WebGL2 in the segment Worker (CanvasKit-style) | (B) Skia Graphite on WebGPU | (C) CPU raster, better tiling |
|---|---|---|---|
| Build | Skia is already in the engine (CPU backend). Add Ganesh GL with Emscripten's WebGL2 bindings (`-sMAX_WEBGL_VERSION=2`, `-sOFFSCREEN_FRAMEBUFFER` off: OffscreenCanvas in the Worker), `SK_GL`, a `GrDirectContext` from `GrGLMakeNativeInterface`. LibWeb's `DisplayListPlayerSkia` already takes a Ganesh surface (Ladybird's GPU path), so the player code is shared; Chitin's tile raster loop wraps `SkSurface::MakeRenderTarget` per tile or an atlas. No new dependency. | Skia Graphite + Dawn-less WebGPU (CanvasKit's experimental path); LibWeb's player is Ganesh-shaped, Graphite paths need testing; async device. | No build change. |
| wasm size | +1.5-3 MB (Ganesh GL + shaders as SkSL) (estimate) | +1-2 MB (estimate) | 0 |
| Per segment cost | One WebGL2 context per segment Worker (OffscreenCanvas). Browsers cap live contexts (Chrome ~16 per process, older lost first): many cross-site iframes need a shared context or a CPU fallback per child segment. GPU memory: tile textures (1 MB each at 512^2) + Skia caches (glyph atlas, path cache; budget 32-64 MB). | One device per segment; same memory shape. | None. |
| Handoff to the carapace | Zero-copy: render each tile into the OffscreenCanvas and `transferToImageBitmap()` (a GPU-backed ImageBitmap), transferred to the carapace, which `texImage2D`s it (GPU-to-GPU in Chrome when both are accelerated). Today the tile goes BGRA->RGBA on the CPU and through `createImageBitmap(ImageData)` (an upload). | Same (WebGPU canvas -> ImageBitmap). | Same as today. |
| Raster speed | Text/rects: similar to CPU per tile for simple content (glyph uploads dominate); gradients, blurs, filters, big images, paths: several times faster. Shader compile hitches on first use (SkSL->GLSL; warm common pipelines at startup). | Similar, compile hitches. | Unchanged per tile; fewer tiles with better damage. |
| Fallback | Context loss / no WebGL2: CPU (today's path) per segment. | No WebGPU: CPU. | - |
| Security | The segment (site origin) gets a GL context: fingerprinting via `getParameter`/renderer strings is the page's anyway through page WebGL; Skia's context is not page-visible. | Adapter info hidden. | No GPU in the segment. |

## What the measurements say each would buy

- YouTube-class pages (content changing every frame, ~20-30 tiles): (A) or (B) would cut 17-43 ms raster to an
  estimated 4-12 ms if per-tile cost falls 3-4x for its content (thumbnails = image draws, rounded rects, text).
  That moves engine frames from 45-110 ms apart to under ~30 ms and removes most fling checkerboard.
- Wikipedia-class pages: nothing visible (raster already ~0 while scrolling).
- (C) better damage would buy the YouTube case too, for free on every other page: if the upstream damage paired
  contexts across appends, the ~20 tiles would be ~3-6. Worth measuring first (a day of work in LibCompositing's
  damage.rs, upstreamable), before a GPU raster build.
- (C) a raster worker pool (coordinator's item 3): N engine raster Workers rastering tiles in parallel. The display
  list lives in the engine's wasm memory; sharing it needs the engine built with shared memory (`-pthread`,
  SharedArrayBuffer: the segment is cross-origin isolated already) and the player made thread-safe (resource storage,
  glyph cache), or the list serialized per frame to each Worker (copy cost ~ list size per frame). 4 Workers on the
  M4 Max would cut the YouTube raster wall time ~3x, at 4x CPU, and against the Mac rules (<= 5 heavy threads).

## Recommendation

1. Measure damage precision first (C, damage.rs context pairing): cheapest, helps every page.
2. Then (A) Ganesh on WebGL2 for the main segment only, CPU for child segments, behind a flag, reftested against
   CPU raster; zero-copy ImageBitmap handoff. (B) only if WebGPU becomes the carapace backend.
3. Worker pool last: highest CPU cost on the owner's machine for a gain (A) gets on the GPU.

## Status of the cc/viz-style items (coordinator, 2026-10-23)

- Tile priorities + prepaint in the scroll direction: done in m8 (A1, D3).
- Atomic commits: a frame message (tree + its dirty tiles + child boxes) is applied in one task before the next
  composite (B3 made child boxes part of it); on-screen tiles at the engine's offset are always rastered in the frame
  that shows them, which is what cc's "required for activation" guarantees. A separate pending/active tree in the
  carapace (to hold a frame whose tiles at the carapace's own, newer offset are missing) is not built.
- Property trees in the carapace: the layer tree carries per-layer scroll chains, sticky constraints and clips
  (`matrixOf`/`clipOf`), which is the scroll/transform/clip part; a separate effect tree is not needed until
  carapace-side opacity animations (M7 P4).
- Raster worker pool, Ganesh: not built (above).
