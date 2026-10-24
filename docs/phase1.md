# Phase 1: LibWeb in a segment, rendering static pages

Status: 2026-10-11. Ladybird's LibWeb (HTML, CSS, layout, Skia CPU raster) is linked into one wasm
module, `ganglion.wasm`, with Ganglion's own runtime behind LibJS's embedding ABI in place of Ladybird's
JavaScript engine. It runs in the segment Worker through the phase 0 harness and under Node, and renders
the six test sites in harness/sites. No page JavaScript runs (phase 2). Numbers are in section 9; the
owner's Chrome steps in docs/user-tests/phase1.md; provenance in docs/provenance.md.

Ladybird is pinned at `975740ccd4de6bcdb92e7566fac8d799f32acdca` (tools/ladybird.env); file paths below are
at that commit. Our changes to it are the patch series patches/ladybird/0001-0013 (section 7).

| Item of the brief | State |
|---|---|
| 1. library builds (LibMedia stubs, Emscripten UA, size flags; LibTLS skipped) | done: every library LibWeb needs builds for wasm32 |
| 2. the js_* runtime | done for what boot and static rendering reach (section 3) |
| 3. the LibGC wasm heap, collect between tasks | done (section 4) |
| 4. compile LibJS and LibWeb, link the engine | done: `ganglion.wasm` (section 5) |
| 5. the segment page host | done: engine/platform, glue/engine, harness/segment/worker.js (section 6) |
| 6. test sites | done: static, article (web font), grid/flex, images, table, forms |
| 7. input | wheel and programmatic scrolling, link navigation (host reloads), mouse and keys delivered; selection untested |
| 8. provenance | done: docs/provenance.md, tools/provenance-*.py, AGENTS.md, SPDX headers, built-JS banner, wasm notice |
| 9. numbers | section 9 |

## 1. The shape of it

```
segment Worker
  glue/engine (hardened JS): WASI + Emscripten library imports, the host API,
                             fetch and image decoding through the Worker's own fetch/createImageBitmap
  ganglion.wasm
    engine/platform/Host.cpp      the page client, event loop, fonts, images, network, paint, input
    Services/Compositor/*          the display list player (Skia, CPU) compiled in
    LibWeb, LibCompositing, LibGfx, LibCore, LibURL, LibHTTP, LibMedia (no FFmpeg), LibWasm, ...
    LibJS facade (unchanged)      ──js_*──►  engine/libjs-runtime  (Ganglion's runtime)
    LibGC                          one heap for the embedder's cells and the runtime's
    Skia m148 (CPU raster, FreeType), HarfBuzz, ICU, libpng/jpeg/webp (unused: images decode on the host)
```

One page, one top-level traversable. The host fetches the page's bytes itself (through the network stand-in
in the harness, `harness/sites` under Node), hands them to `ganglion_load`, which parses them into the
traversable's document the way Ladybird's `about:srcdoc` path does
(`Libraries/LibWeb/DOM/DocumentLoading.cpp`, `HTMLParser::create_with_uncertain_encoding` then
`parser->run(url)`), after `set_url` and `set_origin` so that subresource fetches and CORS checks see the real
site. Subresources go through LibWeb's own Fetch stack to `ResourceLoader`, whose new embedder loader
(patch 0011) asks the host (`ganglion_host_fetch`) and feeds the answer back into Fetch's callbacks
(`ganglion_fetch_done`), with no `Requests::Request`, which Fetch already tolerates for `about:` and `file:`
loads (`Fetch/Fetching/Fetching.cpp` keeps a null request).

Painting: `Document::record_display_list` (the SVG-image path in `SVG/SVGDecodedImageData.cpp` is the
in-process model) into a `Compositing::DisplayListResourceStorage` the host owns, then the Compositor's
`DisplayListPlayerSkia` (`Services/Compositor/DisplayListPlayerSkia.cpp`, compiled into the engine) plays it
into a BGRA8888 bitmap wrapped by `Gfx::PaintingSurface::wrap_bitmap`, as `RasterizeDisplayList.cpp` does.
The host swizzles to RGBA and the glue copies the frame out of linear memory into an `ImageData`, which the
Worker draws into the OffscreenCanvas and transfers to the carapace as an ImageBitmap (phase 0's path).

## 2. Building the libraries (item 1)

`tools/ganglion-build.sh configure|build` drives Ladybird's own CMake for wasm32 with the embedder hooks
of patch 0001 (`engine/cmake/ladybird-embedder.cmake`). What changed since the handoff:

- **Flag order.** Ladybird adds `-Wall -Wextra -Werror` as directory options after ours, and clang lets the
  last flag win, so `-Wno-tautological-constant-out-of-range-compare` had no effect. The `-Wno-` flags are
  now target options (CMake emits those after directory options), on every library target, and only there:
  CMake de-duplicates compile options, so a directory-level copy made the target-level one vanish.
- **LibMedia without FFmpeg.** The FFmpeg sources are dropped; `engine/platform/include/LibMedia/FFmpeg/*.h`
  shadow upstream's headers (a global `include_directories(BEFORE ...)`, because LibWeb's
  `WebAudio/MediaStreamAudioSourceNode.cpp` includes one too) with the same class names and only the static
  entry points the registries call; `MediaWithoutFFmpeg.cpp` answers "no decoder", and implements the
  Vorbis packet parser (which upstream builds on libavcodec) as "no durations".
- **LibTLS** is an empty target (`Empty.cpp`): LibHTTP and LibWeb link it, nothing includes it. TLS is
  Spiracle's job (phase 3).
- **LibWebCommon UserAgent.h** gets `WebAssembly` / `wasm32` strings (patch 0007).
- **ICU data at run time.** ICU's cross build (`--with-data-packaging=static`) installs a 618-byte
  `libicudata.a`: pkgdata has no assembler setting for wasm32, so it falls back to the stub library, and
  every `BreakIterator` (the grapheme and line segmenters LibWeb's text layout uses for anything
  non-ASCII) fails `Segmenter::create`'s VERIFY. The host build's `icudt78l.dat` (33.1 MB, little-endian,
  the same bytes the wasm build would embed) goes to `$CHITIN_EXT/icu/` and the engine takes it before
  `ganglion_start` through `ganglion_set_icu_data`, which keeps a copy and calls `udata_setCommonData`
  (ICU User Guide, "ICU Data: Loading"; the memory has to stay valid). The Worker fetches it from
  `/chitin/icudt78l.dat`. Trimming it with an ICU data filter (`ICU_DATA_FILTER_FILE`, "Data Customizer")
  is part of the phase 2 size work: break iteration, normalization and the root locale are what the
  engine reaches.
- **LibCompositing** needs the generated `WebGL/GLFunctions.h`, whose generator upstream only attaches to
  the Compositor service; the hook adds the dependency.
- **Skia** is `libskia.wasm.a` (the name gn gives it for `target_cpu=wasm`), plus `libskia_pathops.a`:
  Skia's `skia` component does not include the pathops source set unless PDF or XPS pulls it in
  (`BUILD.gn`, `skia_source_set("pathops")` is a dep of `clipstack_utils`, `pdf`, `xps` only), and LibWeb's
  clipping needs `Op()`. tools/deps/skia.sh builds the source set with `ninja pathops` and archives it.
- **32-bit targets.** Four patches fix 64-bit assumptions that are static assertions or layout: the Rust
  `PositionSet` size (0009), `Wrappable`'s size checks, a `constexpr` 4-byte UTF-16 literal that cannot be a
  short string on 32-bit, and a lambda whose deduced return type clang 21 got wrong (0010), `PropertyKey`
  as one word with indices above 2^30 - 1 as string keys, and `HostClassBuilder.h`'s ABI struct sizes by
  pointer size (0008).
- **No stack protector.** Ladybird compiles with `-fstack-protector-strong`. With `-mtail-call` LLVM 21 turns
  every sibling call into `return_call`, and its stack-protector epilogue ends up as a `block` between the
  pushed arguments and the `return_call`, which is invalid wasm (V8: "not enough arguments on the stack for
  return_call"; Binaryen: "popping from empty stack"). `-fno-stack-protector` on every target; it guards
  nothing on wasm, where return addresses are not in linear memory.
- **No sibling-call optimisation.** The second `-mtail-call` bug cost the most time of the phase: the
  display list was right, the shaped text had no width, and every font-size reached
  `FontResolution.cpp` as 0 while the Rust style engine had sent 1024 (16px in CSSPixels' 26.6
  fixed point). `web_css_resolve_font` takes `FfiFontResolutionRequest` by value and ends in
  `return resolve_font_for_style_engine(memo, snapshot, request, ...)`. At `-O3` LLVM 21 made that a
  sibling call: it copies the by-value struct into its own frame, **pops the frame** (`global.set
  __stack_pointer`), then `return_call`s with a pointer into the popped region, which the callee's
  prologue overwrites (the first field survived by luck, so the family was right and the size was
  zero). The by-value copy has to outlive the caller's frame for a tail call to be legal, and the wasm
  backend does not check that: `WebAssemblyISelLowering::LowerCall` (LLVM release/21.x) refuses a
  tail call for varargs, for a caller/callee return-type mismatch, and when an argument *is* an
  `AllocaInst` ("does not support tail calling with stack arguments"), but a `byval` argument whose
  value is the incoming pointer passes that test, and the copy (`MFI.CreateStackObject` +
  `DAG.getMemcpy` in the byval branch) is created afterwards, in the frame the tail call pops.
  `-fno-optimize-sibling-calls` on every target, so a `return_call` is emitted only
  where the source says `musttail` (LibWasm's interpreter, not linked in phase 1). The symptom is
  invisible to `-O0` builds and to any TU without a by-value struct forwarded in tail position, which is
  why it looked like a heisenbug: adding a `dbgln` that read `request` before the call removed the
  sibling-call shape and "fixed" it.
- **setjmp.** FreeType, libpng and libjpeg use setjmp. Emscripten's default (`-sSUPPORT_LONGJMP=emscripten`)
  makes their callers go through `invoke_<sig>` imports and `_emscripten_throw_longjmp`; the glue provides
  them (section 6), in the shape of Emscripten's `src/library.js` but written here. LibGC's own setjmp (a
  register capture for the conservative scan) is compiled out on Emscripten (patch 0012): wasm has no
  registers to capture.
- **Optimised link.** Objects are `-O3` (Ladybird's Release) and the link is `-O2`, at which emcc runs
  wasm-opt over the whole module: Binaryen accepted it once the stack-protector/`return_call` shape was
  gone (the first link was `-O0` because it did not), and the module went from 80.8 MB to 60.7 MB (code
  46.7 MB, data 7.4 MB, the name section 6.4 MB, kept for readable traces by `--profiling-funcs`;
  dropping it is the next 10%). wasm-opt takes 47 s and 3.1 GB on the M4 Max.
- **Skia's raster pipeline on wasm SIMD.** The first SIMD attempt (`-O3 -msimd128`) changed nothing
  measurable, and a CPU profile of 40 full repaints under Node (`node --cpu-prof`, the name section
  makes the wasm frames readable) put 85% of the time in `portable::load_8888`, `swap_rb`, `clamp_01`,
  `srcover`, `store_8888` and a libm `fmaxf` call per pixel: Skia's raster pipeline
  (`src/opts/SkRasterPipeline_opts.h`) has lane types for SSE2/AVX, NEON and LoongArch only; on any other
  target it compiles scalar stages, one pixel at a time, and *no lowp pipeline at all* ("We don't bother
  generating the lowp stages ... in scalar mode"). `skvx` has a `__wasm_simd128__` path, but the
  pipeline does not. A micro-benchmark inside the engine (debug bit 2) confirmed where the cost was:
  a frame-sized `drawRect` 0.07 ms, 200 glyphs 0.6 ms, the static page's whole list replayed 16 ms.
  The fix is the SSE levels up to 4.1 beside `-msimd128` (`-msse -msse2 -msse3 -mssse3 -msse4.1`).
  Then `__SSE4_1__` is defined, Skia takes its SSE4.1 lanes (`SK_CPU_X64_LEVEL`, which `SkFeatures.h`
  derives from the compiler macros and not from the CPU; the pipeline is `SKRP_CPU_SSE41`, 4-wide, one
  `v128` per lane), and Emscripten's SSE compatibility headers (`system/include/compat/*mmintrin.h`,
  "Porting SIMD code targeting WebAssembly") map every intrinsic onto wasm SIMD; its `immintrin.h`
  includes each level's header only when that level's `-m` flag is on. Not AVX: Emscripten's `avxintrin.h`
  emulates 256-bit vectors as pairs of `v128` and there is no AVX2 header. The lowp pipeline comes with
  it. One source patch, applied by `skia.sh`: `skcms.cc` includes `smmintrin.h`, `avxintrin.h`,
  `avx2intrin.h` and the AVX-512 headers directly under `__clang__` for its run-time dispatch (cpuid-gated,
  dead on wasm), and only the levels that are on exist under Emscripten, so that block is skipped there.
  The archive then has 667 `sse41::` symbols, 118 `lowp` ones and no `portable::`; the static page's
  list replays in 2.1 ms instead of 15.3 (section 9), and the frame is the same to within 11/255 on 2% of
  its pixels (anti-aliased edges, lowp rounding). The rest of the engine is scalar; `-msimd128` for all of
  it is a later experiment (auto-vectorisation, AK/SIMD has no wasm path).
- **ICU data trimmed.** `tools/deps/icu-data.sh` cuts the 33.1 MB archive to 4.8 MB with `icupkg -r`
  (the source tarball ships only the prebuilt archive, so the data filter in `icu-filter.json` is the same
  selection kept for a build from sources): break iteration with its dictionaries, normalization, UTS 46,
  the emoji and layout tables, supplemental data, root and en. Collation, transliteration, time zones,
  currencies, units, names, string prep, confusables and the converters (LibTextCodec has its own) go. The
  six sites render on it; a page in another language still breaks lines (the rules are per script, not per
  locale) and only loses locale-specific tailorings.

## 3. The js_* runtime (item 2)

`engine/libjs-runtime/`: `include/Ganglion/Runtime.h` (cells, layout checks, helpers), `src/Heap.cpp`
(classes, allocation through LibGC/CAPI.h, visiting, finalizing, roots), `VM.cpp`, `Value.cpp`,
`Object.cpp`, `Function.cpp`, `Realm.cpp`, `Error.cpp`, `Promise.cpp`, `ArrayBuffer.cpp`, `Misc.cpp`; `tools/gen-stubs.py`
writes a trapping definition for every ABI function the sources do not define, so the link is complete and
an unimplemented function names itself (`ganglion: unimplemented LibJS ABI function js_...`) when reached.
About 3,300 lines.

What it is: LibJS's C++ at the pin is a facade whose `JS::Object`, `Realm`, `PrimitiveString` and so on are
`GC::ForeignCell`s with no fields (`Libraries/LibJS/Heap/EngineCell.h`), read through offsets in
`LibJS/Embedding/Layout.h`, with every operation a `js_*` call (`Embedding/ABI.h`, 358 functions). The
runtime defines those cells and functions:

- **Layout.h** is generated by `tools/gen-layout.py` from Ladybird's 64-bit one (the enumerators stay
  theirs; the offsets are ours). The facade's own structs were measured with clang's record layout dump:
  `ExecutionContext` is 96 bytes aligned 8 on wasm32, `ScriptOrModule` 8, the stack entry 8; the C++ checks
  them with `static_assert` against the header, and `Runtime.h` checks our cells the same way.
- **Cells** on LibGC's heap: `gc_heap_allocate_cell` per class (`Class` is the first word of every cell,
  with the `JS_LAYOUT_CLASS_ID_*` the facade dispatches `is<T>()` on), LibGC marks through our visit callback
  and sweeps through our finalizer. `js_vm_construct_at` creates the heap as the process default, so LibWeb's
  own `GC::Cell`s share it.
- **Objects**: a `Shape` cell per object (realm and prototype, which the facade reads inline), properties in
  a vector plus a hash on the key's bits (a fly string's identity, an index, or a symbol pointer: the same
  bits as `JS::PropertyKey`), the ordinary internal methods, and dispatch to a host class's hook table
  (`LibJS/HostObjectABI.h`) exactly where the Rust runtime dispatches (`Rust/src/embedding/host/host_object.rs`:
  the object's own class table, not its parents'). Host objects and functions put `host_class`, `wrappable`
  and `host_data` at the offsets `HostObjectABI.h` fixes (72, 80, 88; size 96), padding on wasm32.
- **Functions**: native functions and closures of the embedder (`js_function_create_native/closure`), host
  functions (`JSHostFunctionHooks`), direct getters as plain natives, and the builtins this runtime owns:
  `%Promise%`, promise resolving functions, and stub constructors that throw. A call pushes an execution
  context with the arguments in its slots, as the Rust runtime does, so the facade's `vm.argument(i)` works.
- **Realms**: `js_realm_initialize_host_defined_realm` creates the realm, pushes the facade's context,
  calls LibWeb's global-object and this-value callbacks, and builds the global environment (object record
  over the global, declarative record, this value). Intrinsics are created on first request
  (`js_realm_intrinsic`): object/function/array/string/iterator prototypes, the error prototypes and
  constructors, `%Promise%`, the console object, the twelve typed-array constructors, stub
  DataView/SharedArrayBuffer constructors.
- **ArrayBuffer and typed arrays** (`ArrayBuffer.cpp`): a buffer's bytes live in LibGC's primitive
  storage (`gc_primitive_storage_*`, section 4), owned or external (a cell of the embedder's that the
  buffer keeps alive), with detach, detach-and-take, clone, detach keys and max byte length; typed arrays
  carry kind, element size, array length, byte length and byte offset in the slots `Layout.h` fixes, and
  answer the witness-record operations (`IsTypedArrayOutOfBounds`, `TypedArrayLength`) the facade asks
  for. `new Uint8Array(buffer, byteOffset, length)` is a real constructor: LibWeb's byte streams construct
  it for every chunk of a fetched body (`ReadableStreamOperations.cpp`, "Construct(%Uint8Array%, « buffer,
  byteOffset, byteLength »)"), which is how a web font, a stylesheet or an image reaches its consumer.
  The other constructor shapes (a length, an array, an iterable) throw; DataView is not implemented.
- **Errors**: `ErrorObject` with an `ErrorData` (no traceback: nothing runs bytecode), per-kind classes under
  `class_error`, `js_error_throw` in the current realm (the facade's TypeError realm override first).
- **Promises**: state, reactions, resolving functions, `perform_then`, `NewPromiseCapability` for our own
  `%Promise%`, jobs handed to LibWeb's `HostEnqueuePromiseJob` hook and run by `js_promise_job_run`.
- **Values**: ToString, ToNumber (with AK's parser), ToPrimitive via `toString`/`valueOf`, ToObject into
  primitive wrappers, SameValue, number formatting in JavaScript's forms (`number_to_string`).
- **Environments**, Map/Set, iterator records, Date arithmetic, source code handles, and the console
  object are implemented at the level LibWeb's loading path touches. Scripts, modules, JSON, RegExp,
  DataView, BigInt and the debugger are not: `js_script_parse` reports a parse error, the rest throw or
  trap with their name.

Every stub that LibWeb reached while rendering the six sites is now implemented (the stubs trap with
their name, and `make engine-test` passes with none reached); which of the 358 functions ran was not
recorded, and a coverage count is a phase 2 nicety.

Phase 2: each cell gets a V8 handle slot and `internal_get/set/call` on a V8-backed object become imports;
the entry points are narrow on purpose (`internal_*` in Object.cpp, `call` in Function.cpp).

## 4. LibGC on wasm32 (item 3)

Patch 0005 (the handoff: 2 GiB region at address 0, chunks from `aligned_alloc`, no decommit thread, the
shadow stack as `StackInfo`) plus patch 0012:

- **Collect only between tasks.** On Emscripten `Heap::will_allocate` never collects; it sets
  `m_collection_pending` when the threshold is crossed. `Heap::collect_garbage_if_pending()` runs the
  collection, and only the segment host calls it (`ganglion_collect`), from the Worker's frame tick every 60
  frames and after a page settles, when no engine frame is on the stack. Why: the conservative scan reads the
  shadow stack, but values held only in wasm locals are invisible, so a collection with engine frames live
  could free live cells (docs/research/bindings-and-gc.md). The idle GC timer is not started.
- **No setjmp register capture** (`Heap::collect_garbage`, `dump_graph`, `HeapGroup::collect_garbage`): there
  are no registers; the captured span is empty.
- `DeferGC` stays as upstream. Incremental sweeping is off (`gc_heap_set_incremental_sweep_enabled(false)`):
  it needs an event loop of its own.
- `ganglion_collect(force)` with `force` collects unconditionally; the Node test collects twice after a page
  is painted and paints again.
- **PrimitiveStorage on wasm32** (patch 0016). Upstream reserves a 4 TiB cage of address space and
  carves it with `mmap`; the handoff left `ensure_cage()` returning ENOMEM, so every ArrayBuffer failed,
  and the first fetched body (the article's web font) aborted in `js_array_buffer_create_from_bytes`. Now
  linear memory is the cage: the base is 0, an offset is an address, a range is a page-aligned
  `aligned_alloc` (64 KiB pages on Emscripten), committing a range zeroes it (a new slab's first slot
  relies on fresh pages being zero), decommitting is a no-op, release frees, and shared memory objects
  are ENOTSUP. The interpreter's masked access (`cage_offset_mask`, 1 GiB on wasm32) is unused by an
  embedder without an interpreter; a buffer above 1 GiB in memory would break it, which is a phase 2
  note for when LibJS's own interpreter is in the module. Every large buffer costs up to 64 KiB of
  rounding; small ones (up to 64 KiB) come from slabs.

## 5. The link (item 4)

`engine/platform/CMakeLists.txt`: `add_executable(ganglion ...)` of `Host.cpp`, `EventLoop.cpp`,
`SkiaStubs.cpp` and the Compositor's `DisplayListPlayer.cpp`, `DisplayListPlayerSkia.cpp`,
`DisplayListRasterCache.cpp`, `VideoFrameSkia.cpp`, linked against every library with
`-sSTANDALONE_WASM --no-entry -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=128MB -sMAXIMUM_MEMORY=2GB -sSTACK_SIZE=8MB
-sERROR_ON_UNDEFINED_SYMBOLS=0 -Wl,--allow-multiple-definition` and an explicit export list. Two CMake
details: `LINKER:` options must reach emcc as `-Wl,a,b` (CMake's default `-Xlinker a -Xlinker b` makes emcc
read `-u` and the symbol as two arguments), and Ladybird's ELF-only `-z defs`/`--no-undefined` are filtered
off the target. `--allow-multiple-definition` is for the Rust crates, each with its own `std`.

`SkiaStubs.cpp` defines the Ganesh entry points LibGfx references and never reaches without a backend
context. Undefined symbols that remain become `env.*` imports, which the glue lists at boot
(`onMissingImports`) and whose stubs throw by name if ever called.

## 6. The segment host (item 5)

**Engine side** (`engine/platform/Host.cpp`, `EventLoop.cpp`): a `Web::PageClient` (the test client in
`Tests/LibWeb/TestInlineStyle.cpp` is the model; `request_navigation_start` asks the host to load the URL;
`page_did_change_title` reports the title), a `Core::EventLoopManager` for Emscripten (timers in a list,
`pump()` fires the due ones through `ThreadEventQueue::post_event(owner, Event::Type::Timer)` exactly as
`EventLoopImplementationUnix.cpp`'s timers do, then processes the queue; `ganglion_pump` returns the ms until
the next timer so the host can schedule itself), a `Gfx::SystemFontProvider` that wraps a `PathFontProvider`
with fonts the host feeds as bytes (patch 0013 adds `add_typeface`; `Typeface::try_load_from_temporary_memory`
loads them through an anonymous buffer, which on Emscripten is plain memory, patch 0011), an
`ImageCodecPlugin` that sends bytes to the host and gets BGRA frames back (animations: all frames at once,
replayed from a session), the embedder network loader, the theme (Ladybird's `Base/res/themes/Default.ini`
embedded and parsed into `Gfx::SystemTheme`), paint and input.

Exports: `ganglion_init, set_icu_data, add_font, start, load, fetch_done, fetch_failed, image_done,
image_failed, pump, set_viewport, needs_paint, paint, frame_width/height, mouse, wheel, scroll_by, key,
collect, heap_bytes, fingerprint, debug, alloc, free`. Imports: `ganglion_host_log, fetch, decode_image,
navigate, title, request_frame`.

**Paint only what changed.** The owner's first Chrome run repainted the whole viewport every tick (24
fps, 36 ms a frame, on a static page): `ganglion_needs_paint` answered the navigable's
`needs_to_record_display_list()`, which only `LocalNavigable::commit_frame` (the compositor path) ever
clears. Now:

- *Dirty flag.* `needs_paint` is true for the first frame, when the navigable wants a new recording
  (style, layout, DOM, selection and hover changes set that, as they do for Ladybird's compositor), or
  when something requested a frame (`PageClient::request_frame`, input, scrolling). `ganglion_paint`
  records only when the navigable asks, then clears the flag (patch 0018 adds
  `clear_needs_to_record_display_list()`, the one line `commit_frame` has). A static page paints once and
  idle ticks reply "nothing".
- *Damage.* The engine keeps the last frame's list, visual context tree and scroll state and asks
  `Compositing::compute_display_list_damage` (LibCompositing/DisplayList/DisplayListDamage.h, what the
  Compositor service uses in `ContextState::frame_damage_for`) for the rect the two differ in; the player
  runs under a Skia clip to it over the kept frame bitmap. A hover that changes a link's colour repaints
  that line box, not the viewport.
- *Scrolling.* When the list is unchanged and exactly one scroll node's offset moved, and every spatial
  node but the root sits under it (`spatial_nodes_in_subtrees_of`: nothing fixed-position, no other
  scroller changed), the engine moves the frame's own pixels by the delta (`memmove` rows and columns) and
  replays the list clipped to the exposed strip. The host does the same to its canvas: `drawImage` of the
  canvas onto itself by the blit (the 2D context copies first), then `putImageData` of the strip. The
  snapshot holds the node's translation, so scrolling down by 120 is a delta of -120.
- *Output.* `paint()` returns `{ blit, x, y, width, height, image }`, the dirty rect only, converted
  BGRA→RGBA in C++ and copied out with one typed-array `set` (the byte-at-a-time loop was 2–4 ms for a
  frame); `frame()` gives the whole frame for tests and a fresh canvas. In bitmap mode the Worker now
  copies the canvas (`createImageBitmap(canvas)`) instead of transferring it, so the canvas keeps the frame
  between partial paints.
- *Wheel steps.* `Page::handle_mousewheel` scrolls the viewport in process for the first step of a
  gesture; a step that continues a latched gesture (within 500 ms at the same spot,
  `Compositing::user_scroll_settle_delay`) comes back "accepted" without moving the viewport in a build
  with no compositor, so the engine scrolls the viewport itself for such a step (`ganglion_wheel`). Why
  `LocalNavigable::scroll_viewport_by_delta` declines there is a phase 2 question (section 10).

A second `ganglion_load` reuses the page and document: the children go, `page_showing` is reset (the
parser's end steps assert it is false, HTMLParser.cpp "the end" step 9) and readiness returns to
loading, then the new bytes are parsed. Session history, bfcache and `location` are not involved (phase
2, section 10). Clicking a link runs LibWeb's activation behaviour up to `PageClient::request_navigation_start`,
which the engine turns into the `navigate` import; the host decides and calls `load` again. Dragging
across text selects it and the selection paints (the theme's highlight), free of charge.

**Glue** (`glue/engine/`, bundled into `build/ganglion-engine.js` with the `/*! */` banner): `20-wasi.js` is
every WASI preview1 function the module imports (`fd_write` to the log, `clock_time_get`, `random_get`
through `crypto.getRandomValues`, the rest answering EBADF/ENOENT/ENOSYS) and the Emscripten library calls
(`_tzset_js`, `_localtime_js`, `emscripten_resize_heap`, the syscalls as ENOSYS, `invoke_*` for setjmp);
`30-host.js` holds the instance privately and answers the engine's imports with the callbacks the segment
host gave `boot()` (i64 arguments and results cross as BigInt: `clock_time_get`'s precision and the
`_mktime_js`/`_timegm_js` results, which the first glue got wrong and so fired every timer at once); `90-boot.js` builds the import object from `WebAssembly.Module.imports(module)` so a name
nothing provides is reported at boot and throws by name if called. The style is phase 0's: captured
primordials, null-prototype tables, views indexed only, strict mode.

**Worker** (`harness/segment/worker.js`): engine mode downloads `/chitin/ganglion.wasm`, ICU's data
(`/chitin/icudt78l.dat`) and the six Noto fonts (`/chitin/fonts/`, OFL, from `~/dev/chitin-ext/fonts`),
boots, loads `https://<site>/` from the
stand-in, pumps timers on one chain of `setTimeout`s, decodes images with `ImageDecoder` (WebCodecs, every
frame of an animation) or `createImageBitmap`, paints on frame ticks when the engine says the display list
changed, and collects between tasks. A navigation request reloads the engine state with the new URL.

Node runs the same glue (`tests/engine-run.mjs`) with fetches from `harness/sites`, BMP decoding in JS, and
PNG output to `build/frames/`.

## 7. Patches to Ladybird (patches/ladybird)

| # | What | Why |
|---|---|---|
| 0001-0006 | handoff: CMake hooks, Emscripten platform, external LibJS runtime, f16/CSPRNG, LibGC wasm32, Skia empty font manager + LibWasm casts | |
| 0007 | UserAgent.h: WebAssembly / wasm32 | `#error Unknown OS` |
| 0008 | PropertyKey one word on 32-bit; HostClassBuilder.h sizes by pointer size | the facade's layout checks |
| 0009 | LibWeb/Rust `PositionSet` size in words | a 32-byte 64-bit assumption |
| 0010 | Wrappable sizes, clipboard prefix not constexpr, explicit bool in a style-group comparison | 32-bit, clang 21 |
| 0011 | `ResourceLoader::set_embedder_network_loader` + `initialize(GC::Heap&)`; `AnonymousBuffer` without descriptors on Emscripten | no RequestServer, no shm |
| 0012 | LibGC: collect only when asked between tasks; no setjmp capture on wasm | section 4 |
| 0013 | `PathFontProvider::add_typeface` | fonts from bytes |
| 0014 | LibWeb/Rust stage threads (style, layout) run their jobs inline on Emscripten; `is_current()` false | `std::thread::spawn` is EAGAIN without pthreads |
| 0015 | LibGC: an empty captured-register span skips its bounds check | wasm has no registers to capture |
| 0016 | LibGC `PrimitiveStorage` on wasm32: linear memory is the cage, ranges from `aligned_alloc` | ArrayBuffers (section 4) |
| 0017 | LibThreading `ThreadPool::submit` runs the work inline on Emscripten | stylesheet parsing and WOFF2 conversion are pool jobs |
| 0018 | `LocalNavigable::clear_needs_to_record_display_list()` | an embedder that records the list itself (section 6) |
| 0019 | `HTML::set_speculative_parsing_enabled()` | phase 2: the speculative parser's preloads against an embedder-answered network (docs/phase2.md, M1) |

All keep Ladybird's BSD-2 headers and are offered back where useful (0007, 0008, 0009, 0010, 0013, 0015
are plain portability; 0014, 0016 and 0017 are the no-threads/no-mmap shape of a wasm32 build).

## 8. Provenance (item 8)

docs/provenance.md. In short: `tools/provenance-stamp.py` writes keyed values into a 128-byte slot array
the engine reads (frame alpha, pump rounds, frame fill: zeroing them leaves transparent, never-finished,
black pages), a 32-byte HMAC tag and the build id; inserts three to six keyed custom sections at keyed
positions; and appends the visible `chitin.build` and `chitin.notice` sections. `tools/provenance-check.py`
reads a file or URL back, and verifies with the key. The slots are written through the data section's
segments (the `-O2` link packs memory, so the mostly-zero array is one short segment and implicit zeros;
a flat overwrite of the section bytes ran into the next segments' headers and Chrome 154 refused the
module with `illegal flag value`), and `make engine-stamp` compiles the stamped module eagerly under V8
before the check. `ganglion_fingerprint()` and the User-Agent string say `Chitin <build id>`. Notices: SPDX + copyright + Required Notice on every Chitin-authored file
(`tools/spdx-headers.py --check`), a plain-language notice beside the slots in Host.cpp, the banner in built
JS, the wasm notice section, AGENTS.md.

## 9. Numbers

Measured under Node v22.14.0 on the Mac (M4 Max), `make engine-test`, the `-O2` link with Skia's raster
pipeline on wasm SIMD (section 2). docs/results/phase1-node-2026-10-11.json is the file the test writes;
docs/results/phase1-node-2026-10-11-scalar-raster.json is the same run on the build before the SIMD
pipeline (same link, dirty rects and ICU trim already in), which is the "was" in the tables. Chrome's
figures come from the owner's run (docs/user-tests/phase1.md) and go below when they arrive.

**The owner's first Chrome run** (Chrome 154, before dirty rects, SIMD and the `-O2` link): the static
and grid sites rendered correctly; compile 31–32 ms, instantiate 6.5 ms; 24 fps with a 36 ms paint every
tick and about 50 ms input→frame. The retest (docs/user-tests/phase1.md, 3a) is against the numbers here.

**Sizes.** `ganglion.wasm` 60.80 MB linked, 60.81 MB stamped (the marks add under 1 KB; the build id is
`<short commit>-<yyyymmdd>`); `icudt78l.dat` 4.8 MB; the six Noto fonts 4.0 MB.

**Boot.** `new WebAssembly.Module` of the 60.8 MB file: 33.3 ms on the first test (V8 compiles lazily
under Node; Chrome's streaming compile is the number that matters), instantiate + glue 9.7 ms, ICU data +
six fonts + `ganglion_start` (VM, realm, page, empty document) 37.6 ms.

**Per site** (ms; "load" is parse + first pump of the HTML bytes, "settle" is until no fetch is pending
and no timer is due within 50 ms, "paint" is one `ganglion_paint` of the settled page (≈0 where the page
was already painted while settling and nothing is dirty), "first paint" is from before compile to the
first paintable frame; linear memory stays at its 128 MiB initial size on every page):

| site | frame | load | settle | paint | first paint |
|---|---|---|---|---|---|
| static.example | 640x400 | 25.2 | 172.5 | 0.4 | 226.8 |
| article.example | 700x900 | 1.8 | 79.5 | 15.9 | 56.6 |
| grid.example | 700x500 | 1.5 | 69.6 | 0.08 | 43.1 |
| images.example | 700x500 | 3.2 | 80.8 | 7.8 | 45.7 |
| table.example | 700x500 | 1.4 | 69.5 | 0.08 | 46.7 |
| forms.example | 700x600 | 4.7 | 78.9 | 0.11 | 54.0 |

**Repaint cost, scalar raster → SIMD** (ms, medians of 5; "full" is a forced full-viewport repaint, split
into raster (the display list through Skia into the frame) and layout, record being 0.1–0.2 ms on every
page; "wheel step" is the engine time for a 100 px wheel step, which repaints an 800x100 strip and blits
the rest; "wheel→frame" is from the wheel event to the frame):

| site | full | raster | layout | wheel step | wheel→frame |
|---|---|---|---|---|---|
| static.example | 17.0 → 3.5 | 15.3 → 2.1 | 0.7 | 2.65 → 0.49 | 5.2 → 2.9 |
| article.example | 21.1 → 4.5 | 18.7 → 2.4 | 1.4 | 4.14 → 1.43 | 5.1 → 2.4 |
| grid.example | 17.0 → 3.8 | 15.2 → 2.3 | 0.9 | (fits the viewport) | 0.4 |
| images.example | 23.0 → 5.6 | 21.4 → 3.8 | 1.0 | 2.83 → 0.57 | 3.2 → 1.1 |
| table.example | 17.8 → 4.7 | 15.4 → 2.6 | 1.5 | 2.55 → 0.48 | 3.0 → 1.0 |
| forms.example | 20.0 → 5.7 | 16.7 → 2.8 | 2.2 | 2.78 → 0.51 | 3.2 → 0.9 |

An idle tick on every page replies "not dirty" and paints nothing. The raster micro-benchmark (debug bit
2, `GANGLION_DEBUG=4`, an 800x600 frame, each the mean of 10) on the static page: a frame-sized
`drawRect` 0.07 ms before and after (the fill was never the problem), `memset` of the frame 0.02 ms, the
page's whole display list replayed 15.3 → 2.1 ms (article 17.5 → 2.6 ms), 200 glyphs at 12 px
0.57 → 0.15 ms. What is left of a full repaint is the player and the glue around the pipeline, not
per-pixel work.

A second load into the same engine (article → static) took 59.8 ms (was 68.4); the wheel test's event to
the next frame 3.0 ms (was 9.1). Collecting twice after a painted page and painting again keeps the
pixels (the GC test). The SIMD pipeline's static frame differs from the scalar one on 2% of its pixels, by
at most 11 of 255 (anti-aliased edges, lowp rounding); the tests' sampled-pixel counts for the scroll and
selection frames are unchanged (5185 and 9766). The test ran on the unstamped module (`make engine-test`
copies the linked module over `build/ganglion.wasm` first); the stamped one compiles eagerly under V8
(`make engine-stamp`, 0.43 s) and names itself `Chitin <short commit>-<yyyymmdd>`.

## 10. Risks for phase 2

1. **Module size.** 60.8 MB after wasm-opt at `-O2` (Binaryen accepts the module since the
   `return_call` shapes went, section 2) and 4.8 MB of ICU data; `-Os` at link, dropping the name section
   and dead-code stripping of the unused IDL bindings are the next steps before the engine is shippable.
2. **The js_* runtime is the seam, and it is thin.** Page JavaScript in phase 2 means every object the
   facade touches may be V8-backed; property storage, prototype chains and function calls become imports.
   The runtime's `internal_*` dispatch is where that goes; `PropertyKey`'s bits (fly strings) must then
   cross into JS strings, which is where phase 0 measured the cost.
3. **Navigation is the host's.** Link clicks reload the engine state; history, bfcache, `location`, and
   iframes need Ladybird's navigation machinery, which at this commit runs through a UI process
   (`PageClient::request_navigation_*`). Implementing those four callbacks in-process is the phase 2 entry.
4. **Scrolling and the compositor model.** Ladybird now composites in a separate process from display
   lists plus a visual context tree; the engine plays the list itself with an empty scroll state, so async
   scrolling, fixed/sticky positioning under scroll and scroll snapping may differ from Ladybird proper.
5. **Fonts and images come from the host.** No fontconfig, no LibImageDecoders (AVIF/JXL need deps we do
   not build): the segment Worker's `createImageBitmap`/`ImageDecoder` decode images. Images with a
   cross-origin taint never enter a host canvas (the engine paints them), which keeps bitmaps origin-clean.
6. **Threads.** Everything is one thread; `LibThreading` is linked but unused. Ladybird's layout and CSS
   style engines in Rust are single-threaded here by construction.
7. **GC pressure between task boundaries.** A long task (a big parse) cannot collect; the threshold just
   accumulates. Binaryen's `--spill-pointers` remains the fallback (handoff).
8. **The toolchain has bitten twice** (section 2: stack protector + `return_call`, by-value sibling calls).
   Both were `-mtail-call` interactions in LLVM 21's wasm backend; both are off now, but phase 2 links
   LibWasm, whose interpreter needs `musttail`, so the by-value tail-call shape must be kept out of that
   code (and reported upstream with the reproducer in section 2).
9. **Sizes.** 60.7 MB of module (6.4 MB of it names) plus 4.8 MB of ICU data and 4 MB of fonts. The
   next levers: drop the name section from the stamped build, `-Os`, strip unused IDL bindings, and
   `-msimd128` for the engine's own code.
12. **The latched wheel gesture.** EventHandler's latched path declines to scroll the viewport without a
    compositor (section 6); the engine works around it per step. The cause belongs in
    `LocalNavigable::scroll_viewport_by_delta` / `perform_a_scroll_of_the_viewport` and should be found
    before phase 2 adds smooth and snapped scrolling.
10. **Inline thread-pool work blocks the task.** Stylesheet parsing and WOFF2 conversion run on the
    caller's thread (patch 0017); a large stylesheet now costs its parse time inside the fetch task.
    Fine for the test sites; a Worker-side pool (another wasm instance) is the phase 2 shape if it shows.
11. **Theme details.** The disabled form button paints like an enabled one and the progress bar's
    remainder is black: `Default.ini`'s colours through the chrome widget painter, not Ladybird's UI
    styles; cosmetic, untouched.
