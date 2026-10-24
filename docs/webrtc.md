# Chitin: real-time features (WebRTC, capture, gamepads, pointer lock, fullscreen)

Status: built 2026-10-22/23 on branch `rtc` (not merged). Target: what cloud gaming sites (GeForce NOW, now.gg) and video calls
need, matching Chrome 154 per spec.

## The shape

A segment's page runs in the segment Worker, which has no `RTCPeerConnection`, no capture and no gamepads, and receives input
as messages from the carapace. So each feature is delegated to the part of the host browser that has it, the way media decoding
is delegated to the Worker's WebCodecs:

| Feature | Page's interface (where) | Host object (where) |
|---|---|---|
| `RTCPeerConnection`, `RTCDataChannel`, senders/receivers/transceivers, stats, certificates | `harness/segment/rtc.js` (Worker, page realm) | the host's `RTCPeerConnection` in the segment document (`harness/segment/rtc-host.js`) |
| `getUserMedia`, `getDisplayMedia`, `enumerateDevices`, `MediaStream`, `MediaStreamTrack` | `rtc.js` | the host's capture in the segment document, after the carapace's per-site decision |
| `<video>`/`<audio>` `srcObject` = a stream | `rtc.js` (wraps the engine's `HTMLMediaElement`) | frames: the segment document reads the host track (`MediaStreamTrackProcessor`) and sends `ImageBitmap`s to the carapace's **video layer**; sound: an `<audio>` of the segment document |
| Fullscreen API | LibWeb's own (`Element.requestFullscreen`, `:fullscreen`, events) | the carapace's `#tab.requestFullscreen()`; the segment's viewport becomes the screen (`ganglion_fullscreen_changed`) |
| Pointer Lock (`requestPointerLock`, `pointerLockElement`, `movementX/Y`, `unadjustedMovement`) | LibWeb with Ladybird patch 0061 | the carapace's `view.requestPointerLock()`; movement passed as the engine's screen position (`ganglion_mouse_screen`) |
| Gamepad API (`getGamepads`, `gamepadconnected`/`disconnected`, `vibrationActuator`) | LibWeb's own (`GamepadRegistry`) | the carapace polls the host's `navigator.getGamepads()` each display frame and sends the pads (`ganglion_gamepad_*`); effects go to the host pad's `vibrationActuator` |

The page's code is never edited; every call it makes is its own call carried as plain data over one `MessagePort` per segment
(Worker ↔ segment document), and every event it sees is dispatched by the engine as trusted, with the host's state applied
before a promise resolves or the event fires (the spec's "same task").

## Privacy model

- **ICE is the host's.** Candidates are gathered by the host browser in the segment document under Chrome's own rules: host
  candidates are mDNS names (`<uuid>.local`) and no local address appears in candidates or SDP, unless the segment document
  holds an active capture (Chrome exposes host addresses to a frame with camera/microphone access; the same applies here, per
  segment, i.e. per site). STUN gives the server-reflexive (public) address and TURN relays as for any page in Chrome.
- **WebRTC does not go through the relay or Tor.** Everything else a segment does leaves through Spiracle (relay, later Tor);
  WebRTC media and data use the host's network directly, so a site that uses WebRTC learns the user's public address the way it
  would in Chrome. This is the price of matching Chrome for calls and cloud gaming, and it is stated here so nobody assumes
  otherwise. **`?rtc=off`** (and the future Tor network mode, which must set it, as Tor Browser disables WebRTC) removes the
  interfaces from the page and creates no host connection; the segment document then gets no RTC port at all.
- **Capture is asked twice.** Chrome's permission for an iframe is keyed to the top-level origin (the carapace), which every site
  shares. So before the host's prompt, the carapace asks for the site itself (a bar in the tab: "<site> wants to use your
  camera"); Allow is remembered per site for the session (a screen is chosen every time). The host's own prompt follows. The
  segment document's Permissions-Policy allows camera, microphone and display-capture for itself (`self`) only; the Worker,
  where page code runs, keeps `camera=()` and the rest (harness/segment-headers.mjs).
- **No data path to other sites.** Host ids are per segment; the segment document accepts only its Worker's port; frames to the
  carapace go through the guard (`rtc-video`, rate-limited; `video-sinks`, `rtc-permission`, `fullscreen-request`,
  `pointer-lock-request`, `gamepad-effect` schemas in guard.mjs). A new document closes its connections and stops its captures.
- **Input features need the page's activation and the carapace's.** The engine checks the page's transient activation
  (LibWeb's Fullscreen; Document::request_pointer_lock in patch 0061), and the host checks the carapace's, which the same real
  click gave. A page cannot lock the pointer or go fullscreen without a user gesture, and cannot keep them: Esc ends both
  (the carapace tells the engine: `pointerlockchange`/`fullscreenchange`). Gamepads appear only after the user presses a
  button while the carapace has focus (Chrome's gamepad user gesture, applied to the carapace) and only for the displayed page
  and its frames.

## The video layer

A `<video>` whose `srcObject` is a stream of `rtc.js` is a *sink*: the engine paints the element's box (with its background), and
after each painted frame the Worker sends the sinks' boxes (`getBoundingClientRect`, `object-fit`) as `video-sinks`. The
carapace keeps a canvas per sink over the view at that box (clipped by the tab, like nested segments) and draws the latest
`ImageBitmap` from the segment document with the element's `object-fit`. `play()`, `pause()`, `paused`, `readyState`,
`videoWidth/Height` (from the host's frames: `resize` fires), autoplay and the load events are answered for sinks as Chrome
answers them for a MediaProvider.

Not yet: a sink under other content (it is drawn on top), CSS transforms and clip paths on the element, `captureStream()` of an
engine canvas or media element as a track, `MediaStreamTrackProcessor`/`Generator` and encoded transforms in the page,
`RTCRtpSender.dtmf`, `transport`/`sctp` objects (null), `getDisplayMedia` from a segment without transient activation in the
segment document (Chrome requires it there; see below).

## Known gaps

- `getDisplayMedia` needs transient activation in the calling document; the segment document gets none from input that lands in
  the carapace, so Chrome refuses it (`InvalidStateError`). Fix planned: the carapace's bar for display capture is drawn by the
  segment document itself (its own click is the activation).
- Fullscreen of a cross-site iframe (nested segment) is refused (the carapace gives no `allowfullscreen` to nested segments yet).
- Under the pointer lock, the engine's hover state does not change (mouse events are retargeted to the lock element per spec;
  `mouseover`/`out` are not synthesised).

## Files

- harness/segment/rtc.js, rtc-host.js; segment.js (the port, permission asks, frames); worker.js (install, `video-sinks`,
  input with screen positions, carapace answers, gamepads)
- harness/carapace/carapace.js (section "Real-time features"), guard.mjs, carapace.css
- engine/platform/Host.cpp: PageClient hooks (fullscreen, pointer lock, gamepad effects) and exports `ganglion_mouse_screen`,
  `ganglion_fullscreen_changed`, `ganglion_pointer_lock_result`, `ganglion_gamepad_connected/state/disconnected`;
  glue/engine/30-host.js
- patches/ladybird/0061 (pointer lock in LibWeb)
- tests/rtc.test.mjs (Node, scripted segment document); tests/chrome/run.mjs group "webrtc" and "realtime input" (Chitin
  against Chrome); harness/sites/rtc.example

## Results (2026-10-23)

- tests/rtc.test.mjs 5/5 (Node, scripted segment document). chrome-test groups `webrtc` and `realtime input` 9/9 against
  Chrome for Testing 154: the API's shape and errors, a DataChannel loopback (strings, ArrayBuffer, views, Blob, 200 KB,
  `binaryType` blob, `bufferedamountlow`, a second in-band channel, stats, close), a media loopback of the fake camera and
  microphone (ontrack, msid, remote `<video>` size, frames decoded, `replaceTrack`, stop) drawn by the video layer, pointer lock
  and fullscreen with and without activation (events, promises, `movementX/Y`), `getGamepads()`.
- WPT (pin 0ed321dcab3b, caps 40/20/30; docs/results/wpt-rtc-2026-10-23.json): Chitin passes 206 of Chrome's 296 passing
  subtests (70%): webrtc 110/196, pointerlock 52/53, fullscreen 44/47. The webrtc gap is mostly tracks the page makes itself
  (WPT's helpers use Web Audio / canvas streams, which are engine objects, not host tracks), rollback and transceiver details.
- Chrome withholding of local addresses: a site with no capture of its own sees no raw host candidate even when the host gives
  them (because the carapace's origin holds another site's grant); a same-machine loopback cannot connect then (seen in the
  test, by design).
- The engine's Gamepad list has Chrome's four entries (`[null, null, null, null]` without pads); the Fullscreen refusal is
  Chrome's `TypeError: Permissions check failed` (both in patch 0061).
