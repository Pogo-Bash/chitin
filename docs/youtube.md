# YouTube (www.youtube.com): what it found

Status: 2026-10-22, branch `yt`. Evidence: `tools/live-chrome.mjs https://www.youtube.com/` with the relay allowing youtube.com, google.com, gstatic.com, ytimg.com, googleapis.com, ggpht.com, googleusercontent.com, doubleclick.net, googlevideo.com and their subdomains (build/live-yt1, build/live-yt2).

## 1. `window.__shady_native_addEventListener is not a function`

ShadyDOM (webcomponents-all-noPatch.js) captures native methods by defining `__shady_native_<name>` on the prototype that owns them (`Object.defineProperty(EventTarget.prototype, '__shady_native_addEventListener', ...)`) and then calls `window.__shady_native_addEventListener(...)`. If `window.__shady_native_addEventListener` is still undefined it falls back to the descriptor on `Window.prototype`, which has no own `addEventListener`. In Chrome the window inherits `EventTarget.prototype`, so the first lookup finds it.

Cause: the segment's global is a Worker scope; the prototype behind `WindowProperties` is the Worker's `EventTarget.prototype`, not the engine's, so a property a page put on the page's `EventTarget.prototype` was invisible from the window (the old residue "window instanceof EventTarget is false").

Fix (glue/engine/45-surface.js `adoptEventTargetPrototype`): the page's `EventTarget` is rebuilt on the object that already stands behind the global (its prototype cannot be changed, so the engine's interface moves onto it, not the other way round). `window instanceof EventTarget` is true. Checked against Chrome in `make surface-test` ("the global inherits the page's EventTarget"), 37 checks agree.

## 2. `segment killed: 12 misbehaving messages, the last: status flood`

Cause: not a navigation loop. The first trap in the engine (below) stops the engine, and from then on every timer pump, every stream chunk (20 streams stay open), the uncaught-error and unhandled-rejection handlers each reported the same refusal ("the engine stopped") through `status`, far over the guard's 40 a second. `options.stopped` was never wired in the segment Worker, so nothing quieted them.

Fix (harness/segment/worker.js): the stop is reported once (`engine stopped`), later refusals are not reported, the net and timer paths stop feeding a stopped engine, and every status line leaves through a token bucket (burst 20, 10 a second) under the guard's limit; lines held back keep the newest value per key and go out as tokens return. The guard is unchanged. Test: `CHITIN_ONLY=flood make chrome-test` (flood.example: 3000 reports in one task plus timer-driven ones; killed before, alive and newest values delivered after).

## 3. `VERIFY(m_playback_manager_failure_callback)` in HTMLMediaElement (branch `yt2`)

Cause: every media element in this build fails to load (below), and the playback manager reports that failure twice (the add-media-source rejection and its `on_error`). The first runs the one-shot failure callback; the dedicated media source failure steps it leads to are queued, so `error` is still null when the second report's task runs, and that task VERIFYed the callback.

Fix (patch 0027): a report after the callback has run is dropped; the queued failure steps already set MEDIA_ERR_SRC_NOT_SUPPORTED (4) and fire `error` once, and a pending `play()` rejects. Test `tests/media.test.mjs` (harness/sites/media.example: `<video>`, `<audio>` and a scripted video on undecodable WebM/MP4): trapped before, now each element gets code 4 and exactly one error event. Chrome on the same page: the same codes, one event each, the muted `play()` rejects with NotSupportedError.

## 4. `DataError: Value is invalid` (IndexedDB keys)

Cause: page JS runs on the host V8, and a page Array or Date reached the engine's key conversion as a foreign object, not a key: `indexedDB.cmp([1], [1])`, `IDBKeyRange.only([1, 'a'])`, `store.get(new Date())` and keyPath stores whose key is an array all threw DataError. Stored values lost their Dates and arrays the same way.

Fix (glue/engine/40-bridge.js, `CLONED_ARGUMENTS`): the key and value arguments of IDBFactory.cmp, the IDBKeyRange factories and includes, IDBObjectStore/IDBIndex put/add/get/getKey/getAll/getAllKeys/delete/count/openCursor/openKeyCursor and IDBCursor update/continue/continuePrimaryKey are copied into the engine as structured clone copies (arrays, Dates, binary data); an engine object there (an IDBKeyRange query) goes as it is. A Map or Set inside a stored value was stored as an empty object; it is now built as the engine's own Map or Set (Bridge.cpp `ganglion_v_map_create`/`ganglion_v_set_create`, read back by `ganglion_v_collection_entries`) and comes back with its entries, as in Chrome (section 5). structuredClone and postMessage now copy them too (section 6). Test `tests/idbkeys.test.mjs`; Chrome gives the same nine answers.

## Media plan (what YouTube playback needs)

What our build does now: LibMedia is built without FFmpeg (engine/platform/MediaWithoutFFmpeg.cpp: every demuxer and decoder factory reports "no decoder"), and the media element's remote playback manager has no media server (engine log: `MediaClient: Could not reach the media server for playback: No media server transport factory is installed`), so every `<video>`/`<audio>` fails with code 4. `MediaSource` exists, but `MediaSource.isTypeSupported` is false for `video/webm; codecs="vp9"`, `video/mp4; codecs="avc1.4d401f"`, `audio/webm; codecs="opus"` and `audio/mp4; codecs="mp4a.40.2"` (Chrome: all four true); `canPlayType("video/mp4")` is ""; there is no `VideoDecoder` (WebCodecs) in the segment; `AudioContext` exists.

YouTube's player uses MSE: fMP4 (H.264/AV1 + AAC) or WebM (VP9/AV1 + Opus) segments from googlevideo.com appended to SourceBuffers. What playback needs, in order:

1. An in-process media transport, like the Canvas 2D one in patch 0026: a `MediaClient` transport factory the engine installs itself so the playback manager runs in the engine instead of a media server process.
2. Demuxing in the engine: Ladybird's own Matroska/WebM reader and an fMP4 reader (or FFmpeg's libavformat built for wasm).
3. Decoding outside the engine: the segment's host has WebCodecs (Chrome's `VideoDecoder`/`AudioDecoder`, hardware decoders, no codec licensing in our build). Encoded chunks go out through the bridge, VideoFrames come back as bitmaps for the paint path. Alternative: FFmpeg's decoders in wasm (dav1d, libvpx, an H.264 decoder): large, slow, licensing to check.
4. `isTypeSupported`/`canPlayType` answered from what step 3 can decode (`VideoDecoder.isConfigSupported` on the host).
5. Audio: decoded PCM to the host's AudioContext (an AudioWorklet), clocked against video for A/V sync.
6. EME (Widevine) is not needed for ordinary YouTube videos; it is for some (films, music premium).

## 5. `VERIFY(transaction->state() != Active)` in IDBDatabase::block_on_conflicting_transactions (branch `idb`)

Sequence (reproduced by harness/sites/idbtx.example, case 0): the page opens readwrite transaction X, puts, calls `X.commit()`, and in the same task opens readwrite Y on the same store. Y waits for X. Since patch 0024 the microtask checkpoint's cleanup that makes Y inactive is held until the embedder's microtasks have run (a host task: `setTimeout(0)` in the Worker, `setImmediate` under Node), but X's commit queues its complete as an engine database task, which runs in the same engine pump. X's `complete` then runs the pending waits, Y's wait callback finds Y still active and VERIFYs. Without `commit()` the trap does not happen (X's own auto-commit is held back by 0024 too), which is why the other overlapping patterns (back-to-back writers, awaited get/put chains, a writer opened from a success callback, a reader behind a writer) all passed.

Fix (Ladybird patch 0028): the wait callback no longer requires the transaction to be inactive. A transaction still active when its blockers finish starts at once (execution unblocked, mutation logs set up); the held-back cleanup then makes it inactive and auto-commits it if no request was placed, as the spec's auto-commit says (an inactive transaction with no pending requests commits; a conflicting one waits, never traps). Tests: `tests/idbtx.test.mjs` (engine-js-test) and the chrome-test group `CHITIN_ONLY=idb` (idbtx.example and idbkeys.example: Chrome and Chitin give the same answers).
## Media playback (branch `media`)

What plays now: a VP9/Opus WebM through `<video src>` and through MSE (one SourceBuffer, the whole file appended), in
Chrome headless, to the end, with the same event order (loadedmetadata, loadeddata, canplay, playing, ended) and
currentTime progress as Chrome, and the frames on the view (`CHITIN_ONLY=media make chrome-test`, 11 checks; Node with a
fake decoder: `tests/media-play.test.mjs`). `MediaSource.isTypeSupported`/`canPlayType` answer from the segment Worker's
WebCodecs: vp9, av01, avc1, opus and mp4a are true, as in Chrome.

How (engine/platform/Media.cpp, glue/engine/55-media.js): LibWeb's media client talks to a media server of our own
inside the engine over an in-process IPC transport (patches 0031-0034: an in-process TransportSocket pair,
AnonymousBuffer by reference, the demuxer's buffered scan on the event loop, a valid ThreadID on Emscripten). The
server demuxes with LibMedia (its Matroska reader; its SourceBuffer processor for WebM and fMP4 byte streams) and hands
each sample to the host's `VideoDecoder`; decoded planes come back into LibMedia's frame pool and the display list's
video sinks paint them. Upstream's `PlaybackManager` is not used: it decodes on threads, and a segment has none.

Audio (branch `audio`): the enabled track is decoded by the Worker's `AudioDecoder` and played by the carapace's
AudioWorklet, whose position drives the media clock (docs/architecture.md, Media); muted autoplay plays, sound needs a
user activation from the carapace's input, as in Chrome. `CHITIN_ONLY=audio make chrome-test` (8 checks): the clip's
440 Hz tone reaches the worklet and is rendered, the clicked clip ends 2.0 s after the click (Chrome 2.1 s), and muted
autoplay, pause and seek, unmuting and the NotAllowedError refusal give Chrome's events; `tests/media-audio.test.mjs`
(Node, fake decoder and output): a slow output makes the clip end late, currentTime never goes back. The test Chrome
runs with `--disable-audio-output` (the default `--mute-audio` stops the audio clock) and
`--disable-accelerated-video-decode` (its hardware VP9 decoder fails the clips after a seek).

Seeking and progressive `<video src>` (branch `audio`): a media resource is demuxed as it arrives (Ladybird patch 0035:
on one thread a read of data that has not come answers at once instead of waiting, and the session reads again when
it has; a WebM whose Cues no SeekHead locates is read without them meanwhile). `CHITIN_ONLY=seek make chrome-test`
(4 checks): a pause at 0.5 s and a seek to 4.5 s of the 6 s clip give Chrome's events and land at 4.5 s; the Cue-less
clip served at 16 kB/s plays from 0.33 s buffered (Chrome waits for 3.0 s) and ends as in Chrome. A seek completes only
with a frame queued after the one on show (else play() right after `seeked` waited for the decoder: an extra
waiting/playing pair that Chrome does not fire). Video decoders run with `optimizeForLatency`. Node:
`tests/media-progressive.test.mjs` (4 KiB pieces every 120 ms through the host's streamed responses). Ladybird asks
for a byte range only past 1 MiB ahead of the download, so a small file with its Cues at the end starts once they
arrive, as upstream.

Not yet: `decodeAudioData`, drawing a video into a canvas, video damage repaints the whole frame.

YouTube (build/live-media1, `https://www.youtube.com/watch?v=jNQXAC9IVRw`, 60 s, nothing clicked): the watch page
paints with its player (poster area, play button, 0:00 / 0:19, the title and channel); the Segment panel lists the
host's codecs; no request to googlevideo.com was made: the player does not start without a user gesture (autoplay
with sound), and live-chrome clicks nothing. Next: a muted-autoplay or a scripted click on the play button in a
headless run, then the player's MSE appends of real YouTube segments.

## 6. `DataCloneError: #<Set> could not be cloned` (branch `yt3`)

Cause: structuredClone, postMessage and history.pushState/replaceState copy the page's value into the engine (section 4), and that copy refused Map and Set; RegExp, Error, boxed primitives and BigInt too. The engine's JS runtime (engine/libjs-runtime) has no RegExp, BigInt, boxed primitives or DataView and no typed array over part of a buffer, so those cannot be the engine's own objects. A DataView went in as a Uint8Array, a view lost its offset into its buffer, and every copy read back (structuredClone's result, MessageEvent.data, history.state, IndexedDB results) was a snapshot cut at depth two.

Fix (glue/engine/40-bridge.js): Map and Set are the engine's Map and Set on every clone path. The types the runtime lacks cross the engine's serializer as plain marker objects (a fixed key, so one stored in IndexedDB reads back later) whose fields are engine values (a view's marker holds the engine copy of its ArrayBuffer, shared by every view of that buffer). Errors keep a standard name (others become "Error"), the message when it is an own data property, and the stack, as V8 clones them. Copies are read back whole (`cloneToJS`): every depth, cycles and shared references kept, the markers turned back into RegExp, BigInt, Boolean/Number/String/BigInt objects, DataView and typed arrays with their offsets; MessageEvent.data and history.state are one object per read, as in Chrome. WeakMap, WeakSet, Promise, functions, symbols and DOM nodes still throw DataCloneError. The cycle table now keeps cells, not scratch slots (a later sibling overwrote the slot an earlier object was found in, so `{a: s, x: [..], b: s}` lost the sharing). In IndexedDB arguments binary data is copied as before (a key must be the engine's binary). Tests: tests/structuredclone.test.mjs (5), chrome-test group `CHITIN_ONLY=clone` (clone.example: Chrome and Chitin give the same 8 answers).

## 7. `Internal error opening database with version 1` (segment Worker storage)

The segment Worker's own IndexedDB (harness persistence: localStorage and the page service worker registrations, harness/segment/worker.js) failed to open once (build/live-yt5). Chrome's UnknownError for a backing store that did not open. Not reproduced: three YouTube runs since (live-yt6..8) saved localStorage, and a stress page (one to four Workers opening, writing and closing the same database 50 to 200 times each, Workers terminated while holding connections) gave no error in Chrome for Testing 154. The open is now retried twice (100 ms, 400 ms) on UnknownError before the error is reported.

## 8. A throwing `requestAnimationFrame` callback stopped the engine

Found while tracing the message-less DOMException: an exception in a rAF callback goes to LibWeb's report_exception, which asks `VM::debugger()`; the runtime's `js_debugger_is_enabled` was a generated stub that traps (`unimplemented LibJS ABI function`). Fix (engine/libjs-runtime/src/VM.cpp): no debugger (`is_enabled`/`is_paused` false, `did_finish_exception_propagation` does nothing). Remaining difference: that report goes to the engine console only, not to `window.onerror` (Chrome fires error); a Ladybird patch, not done. Test: harness/sites/uncaught.example in the chrome-test clone group (queueMicrotask, setTimeout, MessagePort, a listener, reportError and a nested microtask all reach window.onerror as in Chrome; the rAF callback runs and the engine goes on).
## YouTube plays (branch `audio`, 2026-10-22)

Headless Chrome for Testing through the carapace and our relay (`--any-host`), the play button clicked on the view
(a real click, so a user activation, as a person gives):

    tools/with-browser.sh chitin-audio caffeinate -dims node tools/live-chrome.mjs 'https://www.youtube.com/watch?v=jNQXAC9IVRw' \
        --any-host --relay-log 2 --wait 70000 --click .ytp-large-play-button --click-after 25000 --shot 30000 \
        --sample "(() => { const v = document.querySelector('video'); return v && [v.currentTime, v.paused, v.readyState]; })()"

- "Me at the zoo" (build/live-audio3, live-audio4): the player buffers 0-19 s through MSE before the click
  (googlevideo.com streams in the relay log: rr1/rr2---sn-....googlevideo.com:443, 490 kB on one); after the click
  currentTime runs 0.6 to 19.0 s at one second a second and the clip ends (paused at 19, as Chrome's player does);
  the frames paint on the view (view-30000.png: the zoo at 0:09); audio: 951 chunks decoded by the Worker's
  AudioDecoder, rendered by the carapace's worklet (peak 0.375 at volume 1), 876 position reports clocking the video.
- "Big Buck Bunny 60fps" (build/live-audio8): plays at 854x480 60 fps, 0-60 s buffered ahead, 35 s played in 35 s,
  1943 audio chunks, 1776 position reports.

Divergences found and fixed on the way:

- `frame planes do not match their size: 854x480`: LibMedia's frame pool starts each plane on a 64-byte boundary;
  the host's tightly packed planes are now copied plane by plane (Media.cpp). Before, every 480p frame was refused and
  the video stayed at readyState 2 with currentTime 0 (also the "next video" YouTube autoplayed). Test: media-play
  "854x480".
- live-chrome took the last segment Worker, which on YouTube is the passive sign-in iframe's (accounts.google.com, a
  nested segment); it now finds the page's own. `--click`, `--sample`, `--shot` added; it runs Chrome with a silent
  audio output that keeps time (`--disable-audio-output` instead of the default `--mute-audio`).
- After MediaSource.endOfStream an aborted read is the end, not "demuxing failed: Read aborted".

Still seen: `unhandled rejection: DataCloneError: #<Set> could not be cloned` (section "Next wall"), `HTMLScriptElement:
Refusing to run script because the element's result is null`. Neither stops playback.

## Next wall

YouTube (build/live-yt8, engine build `ganglion-yt3`): no engine trap, no DataCloneError, no storage error; the sign-in frame paints. One error remains in the segment Worker: an uncaught `$F` (in yt5 it was `DOMException`, the class name of the thrown value; YouTube's minified class), reported by Chrome at worker.js:0:0 with no stack, and so on the carapace as `[top] pageerror: $F`. Not thrown by page code under the debugger (pause on uncaught exceptions never fired), so it is a report, not a throw: a host-side dispatch that hands a page exception to the Worker's own global. Ruled out (uncaught.example): queueMicrotask, setTimeout, MessageChannel, event listeners, reportError. Chrome loading youtube.com itself reports no uncaught error. `tools/live-chrome.mjs` now records each worker exception with its location and, with CHITIN_PAUSE_UNCAUGHT=1, the stack of a thrown one. Also still: `HTMLScriptElement: Refusing to run script because the element's result is null` (a script host not on the allowlist).

## Earlier wall (fixed above, section 3)

The engine trap that started it (build/live-yt2, the page of accounts.google.com/v3/signin/identifier, reached from YouTube's passive sign-in; the sign-in form itself paints):

`VERIFICATION FAILED` in `HTMLMediaElement::handle_playback_manager_error`'s queued task (Libraries/LibWeb/HTML/HTMLMediaElement.cpp, `VERIFY(self.m_playback_manager_failure_callback)`, about line 2252). A decoder error arrives while the ready state is HaveNothing and the one-shot failure callback is already gone (a second error, or the remote-playback path that never installs it). Suggested patch 0026: return when the callback is empty instead of VERIFY. Needs a wasm rebuild (not done here: the ninja dir is shared with main). Everything after the trap is the stopped engine; the page freezes on its last frame and the Segment panel says `engine stopped`.

Also seen: `HTMLScriptElement: Refusing to run script because the element's result is null` (a script host not on the allowlist), `unhandled rejection: DataError: Value is invalid` (an IndexedDB or crypto call with a bad key, not yet traced).

## 9. Staged classic scripts lost, the home page stalls, thumbnails stay grey (branch `yt4`, 2026-10-22)

The owner's run (real Chrome, 1563f31): `importScripts` of `__chitin_script_38.js` "failed to load", then "frames: ERROR:
no frame for 34 s"; the home page showed only its skeleton.

- **Staged scripts lost.** runScript staged an inline/classic script's bytes with the segment's service worker by a
  message on its port, then `importScripts`. Chrome stops an idle service worker (port messages do not keep it alive), and
  a message to a stopped one is dropped. The restarted worker waited 3 s for the stage, then asked the engine, which is
  blocked in that same importScripts, and gave up after the 15 s engine timeout: about 18 s per script (the 34 s stall),
  then the load failed. Now the Worker stages with a synchronous POST to `/__chitin/stage` (a fetch event, which starts a
  stopped service worker), keyed by client id and name (two Workers of an origin never take each other's script; stages
  expire after a minute); a synthetic name that was not staged fails at once instead of asking the blocked engine. Tests:
  harness.test (restart, 1200 stages, 4 MB scripts, the same names in two Workers); chrome-test `CHITIN_ONLY=stage`
  (300 inline scripts with 2 MB ones, `ServiceWorker.stopAllWorkers` between bursts, a frame, a reload): it hung before.
- **Search results hidden.** polymer-resin (YouTube's sanitizer) lets a falsy value through only when
  `value !== document.all`; our `document.all` was `undefined`, so every unset binding became its "zClosurez"
  placeholder (a truthy TrustedHTML) and `ytd-two-column-search-results-renderer` got `hidden`. `document.all` is now
  `null` (falsy, `== null` like Chrome's; `typeof` stays 'object', not 'undefined').
- **Thumbnails grey.** Two decode bugs on the host: a JPEG/BMP/ICO went through createImageBitmap and its size was read
  after `close()` (0x0, so every JPEG failed); and i.ytimg.com answers thumbnails as AVIF, which was sniffed as PNG.
  Both fixed (harness/segment/worker.js decodeImage); chrome-test `CHITIN_ONLY=jpeg`, and `CHITIN_ONLY=io` (lazy-image
  IntersectionObserver patterns, as Chrome answers them).

After: `/results?search_query=me+at+the+zoo` paints titles, channels, durations and thumbnails (build/live-res34).
The home page in a fresh profile says "Try searching to get started" in Chitin and in Chrome for Testing alike (no
history, signed out). Audio in a headless run of the watch page: peak 0.375 at volume 1. The peak is measured in the
worklet on the mixed samples, after the element's volume and before the output; the system volume cannot make it 0, and
the panel's line is the last half second only (0 once paused or ended).

## 10. Long and high-resolution playback: audio cuts out, then playback stops (branch `ytlong`, 2026-10-23)

Owner report (their Chrome, main): YouTube stops after ~2 minutes, audio cutting out first; later, audio cut out at once
on load. Their bisect: everything played at 360p with h2's 64 KiB windows; with b2ae750's larger windows YouTube's ABR
picks 720p/1080p and the bug comes back. The window was the trigger, not the bug.

Headless YouTube cannot show it past ~35-45 s: plain Chrome for Testing gets "Something went wrong" there too (with
a desktop UA as well); YouTube refuses headless clients. The local stand-in is `harness/sites/video.example/long.html`:
YouTube's shape (two SourceBuffers, 6 s appends at a moving timestampOffset, 30 s ahead, removed 10 s behind),
`?file=vp9-1080p60-6s.webm` (1920x1080 at 60 fps, ~6 Mbit/s, `tools/make-test-media.mjs` NOISE=1 VIDEO_ONLY=1),
`?speed=` playbackRate, `?draw=1` drawImage samples, `?stall=ms` a busy page script.

Two causes, both the segment's one thread:

- **Audio fed 1 s ahead.** Decoding, the decoded audio's hand-over and the media clock run on the segment's thread with
  the page's script; YouTube's watch page holds it 1.5-2.6 s at load ('event loop stalls' status). With 1 s sent ahead
  the AudioWorklet ran dry for the rest of a stall: a 3 s stall gave 2011 ms of silence and a waiting/playing pair. Now
  4 s (Media.cpp `AUDIO_LEAD_MS`; the worklet holds up to 8 s): 9-18 ms (a864940).
- **Video converted on the CPU.** At 1080p60 half the thread was video (profile, 40 s): every frame copied into wasm
  (3.5 s), converted YUV->RGB by LibGfx in wasm (7.8 s) and scaled by Skia (3.3 s); playback fell behind at ~71 s
  (video queue empty, 10 frames in flight). Under YouTube's own script there was no headroom left.

### Video on the host

With the GPU compositor, decoded frames never enter the engine:

- `55-media.js`: a VideoFrame becomes an ImageBitmap (`createImageBitmap`: Chrome's own colour conversion, off the
  thread) and is closed at once (a hardware decoder's buffer goes back). A second bitmap is the carapace's copy,
  transferred (a structured clone of an ImageBitmap copies its pixels on the sending thread: ~5 ms a 1080p frame).
- `Media.cpp`: the engine holds a placeholder frame and a handle. `FrameSink::current_frame()` (LibWeb's rasterizer,
  drawImage, createImageBitmap, WebGL uploads of the video) reads the pixels back from the kept bitmap when asked; a
  host frame is released when nothing holds it. A hosted sink's new frame damages no engine tile.
- `Layers.cpp`: a DrawVideoFrame of a host frame is a span of its own (like a canvas) with no tiles when it has only
  rectangle inline clips, no inline transform, clips inside its layer that are rectangles (at most one rounded) and a
  translate/scale to its layer; the layer JSON carries `video: [frame, rect, scaling, uv crop, rounded clip, radius]`.
  Otherwise it is rastered here as before (the engine log says why, and that frames are read back).
- `glcompositor.mjs` draws the bitmap as a textured quad in paint order (YouTube's controls stay above it; the rounded
  player corners through the tile shader's rounded clip); `compositor.mjs` (DOM backend) puts it in a canvas on the
  layer's plane; `guard.mjs` checks the bitmaps.

Measured, 1080p60 MSE in Chrome for Testing headless: segment paint p50/p95 0.25/0.59 ms (main 5.98/6.13), segment
thread idle 37.4 of 40 s (main 19.9), 120 s with no waiting, engine memory flat at 245 MiB. YouTube (Big Buck Bunny,
854x480 in a headless 800x600 view): no read-backs, the controls over the video.

Tests: `tests/media-long.test.mjs` (engine-js-test: 5 minutes of MSE at 8x in one and two SourceBuffers, memory
levels off; a 3 s page stall does not starve the audio); chrome-test long video group (in `CHITIN_ONLY=media`: 60 s of
1080p60 at 2x against Chrome; paint p95 < 4 ms and a page timer's lateness p95 < 6 ms fail on main; frames composited on
the host; drawImage of the video shows the right second, as in Chrome). Status rows for owner reports: `engine memory`
(MiB, worst timer lateness over 5 s) and `event loop stalls`. The `first frames` row goes out once.

Not done / seen on the way: Chitin accepts an init segment with a track its SourceBuffer's type does not name (Chrome
refuses it: "error" at once); video in a flat or `layers` compositor still converts in the engine; the stall at load
itself is YouTube's script on our thread (Chrome runs it on the main thread with media elsewhere).
