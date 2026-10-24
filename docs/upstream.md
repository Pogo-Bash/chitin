# Fixes worth sending to Ladybird

Chitin's Ladybird changes are patches/ladybird/. Some are Emscripten- or Chitin-specific; the ones below are plain
LibWeb bugs that upstream has too and could take as they are (or nearly).

| Patch | What | Upstreamable |
|---|---|---|
| 0042 | lighting-color missing from Properties.json | yes |
| 0042 | @page margin descriptors serialized as `margin: X` four times (expanded descriptors keep the shorthand's name); now longhand names, collapsed to one `margin` | yes |
| 0042 | empty @supports block serialized `{\n\n}` | yes |
| 0042 | @keyframes cssText layout (one keyframe per line) | maybe: no spec text, matches Chrome and Firefox |
| 0042 | font-family names: identifier only when one plain identifier, else string | maybe: matches Chrome; CSSOM leaves it open |
| 0042 | numbers keep six significant digits | no: CSSOM says six decimals; done for Chrome parity |
| 0042 | PaintFacts.cpp `.ptr().ptr()` | no: a build fix to our own patch 0030 |
| 0045 | navigator.permissions / PermissionStatus behind [Experimental]; query knows only geolocation | yes: the table of names and states is Chrome's, upstream may want its own |
| 0045 | request_permission grants geolocation without asking (and denies the rest outright, storing it) | yes: no grant without a prompt; a dismissed request stores nothing |
| 0045 | Notification.permission / requestPermission were [FIXME] | yes |
| 0045 | ScreenOrientation type/angle stubs (always landscape-primary 0), unlock dbgln | yes: client-provided, else the screen's shape |
| 0045 | Screen availLeft/availTop missing; colorDepth/available area fixed | yes |
| 0045 | NetworkInformation (navigator.connection) missing | yes |
| 0046 | NullPlaybackStream embedder output | no: Emscripten embedders only |

## Canvas and SVG text (patch 0050, parity B)

- `CanvasRenderingContext2D.isPointInStroke()` (both overloads): implemented with Skia's `FillPathWithPaint` over the
  current line styles (`Gfx::path_stroke_contains` in LibGfx/PathSkia.cpp). Upstream would want WPT
  `html/canvas/element/path-objects/2d.path.isPointInStroke*` run with it.
- `wordSpacing`, `fontKerning`, `fontStretch`, `fontVariantCaps`, `textRendering`, `lang` on CanvasTextDrawingStyles:
  stored with the spec's defaults and setter rules. Upstream would also want the shaper to apply them (word spacing,
  kerning, stretch, small caps), which this patch does not do. The four enums moved to CanvasRenderingContext2D.idl for
  the same export reason the existing FIXME there gives.
- `measureText()` actualBoundingBox* from the glyph outlines' bounds and the textAlign point (was the font's ascent/descent).
- `image/webp` in canvas serialization through the existing (lossless) WebPWriter.
- `SVGDecodedImageData::set_in_process_rasterizer`: only useful to embedders without a compositor process; upstream may
  prefer to keep it local.
- `SVGTextContentElement.getStartPositionOfChar` was a stub returning (0, 0); it, `getEndPositionOfChar`,
  `getRotationOfChar` and `getCharNumAtPosition` now read the glyph cells layout commits, which carry a new `baseline`
  field (Rust `FfiSvgTextCharacterCell`). Right-to-left, vertical and text-on-a-path positions remain FIXMEs.

Found while comparing against Chrome and not fixed (upstream candidates, docs/parity-b.md): `createImageBitmap` with
`resizeWidth/resizeHeight` throws "Image size is invalid"; no `drawFocusIfNeeded`, `ImageBitmapRenderingContext`,
`ImageData.pixelFormat`, SVG `textLength`/`lengthAdjust`; a `display-p3` 2D context keeps an sRGB backing.
| 0043 | body info never set: encodedBodySize/decodedBodySize always 0 (and transferSize always 300); now counted in FetchedDataReceiver, encoded total from RequestTimingInfo | yes |
| 0043 | minimise a supported MIME type step 5 was a FIXME: contentType empty for text/css, text/plain, text/html, images | yes |
| 0043 | `<img>` fetches had no initiator type, so no Resource Timing entry at all | yes (WPT resource-timing/initiator-type/img.html) |
| 0043 | `<link rel=stylesheet>` reported as "css"; every engine and WPT say "link" | yes, as INTEROP |
| 0043 | HTMLScriptElement "if el is currently render-blocking, set options's render-blocking" was a FIXME | yes |
| 0043 | Server-Timing: no PerformanceServerTiming; headers read from the filtered response (empty for no-cors) | yes |
| 0043 | a failed timing allow check still reported transferSize 300; spec/WPT say 0 | yes |
| 0043 | a same-origin iframe document never reported to its container's global (only the TAO-fail fallback was) | yes, AD-HOC in completely_finish_loading |
| 0043 | Paint Timing (first-paint, first-contentful-paint) and VisibilityStateEntry missing; "mark paint timing" was a FIXME | yes (contentful check is a DOM approximation) |
| 0043 | navigationId, activationStart, notRestoredReasons, contentEncoding, worker router fields; Blink's attribute order | partly: the attributes yes, the order is Chrome parity only |
| 0043 | supportedEntryTypes lists types with empty buffers (event, LCP, longtask...) | no: Chrome parity only |
| 0043 | reset_performance_timeline for an embedder reusing a global | no: Chitin's single-realm model |

## WebGL on a WebGL executor (patch 0064)

For embedders whose GL is itself WebGL (Chitin's segment Worker; docs/webgl.md). Mostly embedder-only; the parts
upstream might want are marked.

- `RemoteWebGLTransport::local_factory()` and `on_context_loss_change` (as the Canvas 2D transport has): no for upstream's
  process model, yes as an embedder hook.
- `glHostQueryCHITIN` / `glHostExtensionCallCHITIN` in GLFunctions.json: the getters and extension methods answered by
  the executor's host. Embedder only (ANGLE has no such entry points; only used when the executor reports WebGL names).
- `WEBGL_lose_context` (loseContext/restoreContext over the existing loss machinery): yes.
- `getSamplerParameter`, `getTransformFeedbackVarying`, `getIndexedParameter`, `drawingBufferColorSpace`,
  `unpackColorSpace` were [FIXME]: yes in shape; upstream needs its own (GLES) answers for them.
- 36 extension interfaces (tools/webgl/gen-extensions.py), named as Chrome names them (`WebGLCompressedTextureS3TC`, not
  `...S3tc`): the names, yes; the method bodies forward to the executor and do nothing on ANGLE.
- A negative `bufferData` size is INVALID_VALUE (spec): yes.
- Deleted shaders/programs keep their name in the replayer (`keep_name`): yes, GL keeps them alive while attached.
- `COMPOSITING_WEBGL_HOST_OVERRIDE`: on Emscripten the page's clientWaitSync timeout reaches the (WebGL) host.
