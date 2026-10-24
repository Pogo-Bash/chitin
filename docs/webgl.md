# WebGL in Chitin

Status: built on branch `webgl` (2026-10-23), Ladybird patch 0064; not merged. Goal: WebGL 1 and 2 for pages, OffscreenCanvas and workers, answering exactly
as Chrome 154 on the same machine: the same errors, validation, getParameter answers, extensions, precision formats,
shader logs, context-loss behaviour and pixels.

## How it works

Ladybird's LibWeb records a WebGL context's calls as a command stream (LibCompositing/WebGL) for its GPU process,
where `Services/Compositor/HostWebGLContext` replays them on ANGLE. The engine has no GPU process, so:

- **Transport** (`engine/platform/WebGL.cpp`): an in-process `RemoteWebGLTransport` (installed through
  `RemoteWebGLTransport::local_factory()`, Ladybird patch 0064). Commands, synchronous queries (`sync_call`), readPixels
  and buffer reads run at once on the same `HostWebGLContext` and generated `WebGLCommandReplayer` the GPU process uses,
  compiled into `ganglion.wasm`.
- **Executor**: the replayer's GL ES calls (`GLFunctions`, ANGLE's names, including the `*RobustANGLE` forms) are wasm
  imports answered by `glue/engine/58-webgl.js` on a host WebGL context of the segment Worker: one `OffscreenCanvas` per
  page context, WebGL 1 for `webgl`, WebGL 2 for `webgl2`, created by the glue and never reachable from page script
  (every host method is captured when the glue loads). GL integer names map to host WebGL objects in a per-context
  table; uniform locations and syncs get names too. GL `*_LENGTH` queries with no WebGL form are derived from the
  strings they measure.
- **What the page sees**: `getParameter`, `getSupportedExtensions` (the host's list in the host's order, those LibWeb can
  create), `getShaderPrecisionFormat`, `getError`, shader and program info logs are the host's. `WEBGL_debug_renderer_info`
  answers the host's own unmasked strings: what Chrome exposes there, nothing more (patch 0064 asks the executor for
  `UNMASKED_*` instead of substituting `VENDOR`/`RENDERER`).
- **Presentation**: when LibWeb presents a frame the default framebuffer is read back (`readPixels`) into the canvas's
  surface, which the frame's display list draws. The drawing buffer is preserved on the host; a non-preserving page
  context is cleared by the executor as Ladybird's GPU process does. Not yet: handing the host canvas to the carapace
  compositor as a layer without the CPU copy (the m7 compositor is WebGL 2; the frame would travel as an ImageBitmap).
- **Context loss**: a host `webglcontextlost`/`webglcontextrestored` reaches LibWeb's loss machinery
  (`on_context_loss_change`, patch 0064); `WEBGL_lose_context` (patch 0064) simulates it.

- **Getters**: LibWeb's own getter code is bypassed for every non-object answer: `glHostQueryCHITIN` carries the host's
  value back as JSON (typed arrays keep their type, `WebGLActiveInfo` and precision formats are rebuilt in LibWeb).
  Answers that are objects (bindings) stay LibWeb's, as do the unpack flip/premultiply/colorspace state.
- **Extensions**: 36 extension interfaces are generated (tools/webgl/gen-extensions.py, from Chrome's answers: names,
  constants, method lengths) and their methods run on the host's extension object (`glHostExtensionCallCHITIN`).
- **Uploads**: array uploads take the page's UNPACK_FLIP_Y / PREMULTIPLY on the host. Image sources (img, canvas,
  video, ImageData, ImageBitmap) go up through the host's own TexImageSource upload (patch 0072,
  `ganglion_host_webgl_tex_source`): the engine hands the source's pixels as unpremultiplied RGBA8 in a host ImageData,
  with flip and premultiply as LibWeb resolved them for that source (ignored for an ImageBitmap, as the spec says),
  and the host converts to the format and type (every WebGL 1 and 2 one) and applies the WebGL 2 unpack
  sub-rectangle. Measured against Chrome by the Khronos conformance suite (tools/khronos, docs/results/khronos-*.md).

## Results (2026-10-23, Chrome for Testing 154, this Mac)

chrome-test group `webgl`: 2014 of 2020 keys equal Chrome's exactly (tolerance 0), page and dedicated worker; this
includes every getParameter of WebGL 1 and 2, getContextAttributes, the extension list and every extension object
(class name, constants, method lengths), shader precision formats, the unmasked renderer strings, getError after
every call of the scenes (triangle, textures with flip/premultiply, framebuffers, instancing, transform feedback,
UBOs, queries/samplers/syncs, lit cubes, invalid calls, shader/link failures and logs), the full-buffer pixel hashes,
toDataURL (decoded), drawImage and createImageBitmap of the canvas, and context loss/restore events.

Recorded gaps (tests/chrome/webgl-known.json):
- `EXT_disjoint_timer_query` / `_webgl2` are not exposed (their WebGLTimerQueryEXT objects are not built), so the
  extension lists lack them.
- (fixed by patch 0073) `bufferData(target, -1, usage)` reached the engine as size 0: LibWeb's 64-bit WebIDL integer
  conversion did its modulo in doubles, where -1 mod 2^64 rounds to 2^64 and comes back as 0; it is done in integers now.

- (fixed by patch 0074) The compressed texture extensions other than S3TC did not enable their formats, so
  `compressedTexImage*` refused ETC2/EAC, ETC1, ASTC, BPTC, RGTC and PVRTC with INVALID_ENUM once enabled.

- (fixed by patch 0075) Every host context was made with alpha and premultipliedAlpha: alpha: false pages saw
  ALPHA_BITS 8 and their clear's alpha; premultipliedAlpha: false buffers were presented as premultiplied. The page's
  two attributes now reach `webglCreate`, and presentation premultiplies an unpremultiplied buffer. Residue: the
  presented surface is premultiplied BGRA, so an unpremultiplied colour at a small alpha reads back from toDataURL or
  drawImage with the precision lost (Khronos premultiplyalpha-test, alpha 1/255).

- (fixed by patch 0076) `uniformMatrix2fv(loc, false, [])` stopped the engine (the replay's size check against a
  count of 0); empty uniform arrays are INVALID_VALUE as in Chrome.

Not built:
- The canvas as a compositor layer without the CPU copy: presentation reads the frame back (`readPixels`) into the
  canvas surface. The host canvas could instead go to the carapace compositor as an ImageBitmap.
- **Sixteen live contexts.** Every page context is a host context in the segment's Worker, and Chrome allows a
  worker 4 active WebGL contexts where a page's main thread has 16 (measured 2026-10-23 in Chrome for Testing 154,
  SwiftShader: 8 OffscreenCanvas contexts in a dedicated worker lose the oldest 4; 20 canvases on the main thread lose
  the oldest 4). A page with a fifth live context loses its oldest one in Chitin where Chrome keeps it: the Khronos
  `textures/webgl_canvas` pages (7 contexts: the test's own, two source canvases and an OffscreenCanvas for each alpha)
  lose their main context and time out. Fix needs the contexts virtualised over at most 4 host contexts (each engine
  context's default framebuffer an FBO of its attributes, its GL state saved and restored on a switch, as Chrome's
  own virtualised contexts do), or the host contexts on the segment document's main thread. Not started.

## Khronos conformance (2026-10-23, suite 3a65272e, SwiftShader both sides; tools/khronos, docs/results/khronos-2026-10-23.json)

| | Chrome | Chitin baseline | Chitin now (patches 0072-0083) | Chrome-pass, Chitin-fail |
|---|---|---|---|---|
| 2.0.1 (2865 pages) | 2838 | 2037 | 2717 | 813 -> 137 (44 webgl_canvas) |
| 1.0.4 (971 pages) | 965 | 866 | 914 | 99 -> 53 |

Fixed since the baseline: image-source uploads and createImageBitmap options (0072); PBO overloads, OVR_multiview2,
64-bit IDL (0073); compressed texture extensions (0074); alpha/premultipliedAlpha, WebGL 1 DEPTH_STENCIL (0075); empty
uniform arrays (0076, stopped the engine); a video's current frame for drawImage/createImageBitmap/texImage (0077);
getExtension on a lost context (stopped the engine), WebGL 1 null uploads go to the host as null (extension
formats were INVALID_ENUM, max-size textures stopped the engine), an engine buffer copy that cannot be allocated is a
RangeError (0078); isQuery/isSampler/isSync/isTransformFeedback, getFragDataLocation, copyTexSubImage3D (0079); a
lost context's locations, getUniform validation (0080); restoreContext without preventDefault, checkFramebufferStatus
when lost (0081); H.264 VUI colour (full-range BT.601 clips converted as studio BT.709; LibMedia, 0082) and an
unspecified matrix as BT.601 like Chrome's video renderer; unpackColorSpace reaches the host (0083).

Open: textures/webgl_canvas (more contexts than a worker may hold: needs virtualised contexts); s3tc-and-rgtc still
stops the engine in the replay (HostWebGLContext::execute_commands, not yet located); webgl-compressed-texture-size-limit
times out (page typed arrays are copied into the engine's memory for every call: hundreds of MB); a few timeouts
under load (rapid-resizing, framebuffer-state-restoration, offscreencanvas transfer); deqp negative*/statequery pages; and single pages in other areas (the diff in the result file).

## Security

Only the segment's own contexts: each host context belongs to the segment Worker, created by the glue for a page
context of that segment. Pointers from the engine are bounded views of its own memory. No host object reaches page
script.

## Tests

- chrome-test group `webgl` (`CHITIN_ONLY=webgl`): `harness/sites/webgl.example/probe.js` runs identity queries and
  scenes (triangle, textures, framebuffers, instancing, transform feedback, UBOs, queries/samplers/syncs, lit cubes),
  invalid calls with `getError()` after every call, logs, loss and restore, and the canvas exported (toDataURL,
  drawImage, createImageBitmap), in the page and in a dedicated worker. Compared with Chrome key by key, tolerance 0.
  Recorded gaps: `tests/chrome/webgl-known.json`. Outputs: `build/webgl-{chrome,chitin}.json`, `build/webgl-diff.txt`.
- Run it: `CHITIN_ONLY=webgl CHITIN_NET=0 nice -n 15 caffeinate -i tools/with-browser.sh
  chitin node tests/chrome/run.mjs` (one GPU browser, about a minute).
- Khronos WebGL conformance: not in our checkout. `chitin-ext/wpt` is a sparse, blob-less clone; its `webgl/` holds 24
  small WPT tests (not the Khronos suite) and checking them out would fetch from GitHub, which needs the coordinator's
  go. The Khronos suite (KhronosGroup/WebGL `sdk/tests`) is likewise not present.
