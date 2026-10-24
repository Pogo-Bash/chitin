# Encrypted Media Extensions: the host browser's CDM (branch `eme`, 2026-10-23)

Chitin has no CDM and never decrypts. Pages that play protected media (Spotify, films on YouTube, Netflix-style players)
get EME by **delegation**: every EME call of the page is made, unchanged, on the host browser's own EME, and protected
media plays in a real host `<video>` whose frames the host decrypts and draws. Nothing here implements, weakens or works
around a DRM system; what plays and what is refused is the host's decision (its key systems, its robustness levels, its
screen-capture protection, its output protection).

## How

| Piece | Where |
|---|---|
| The page's interfaces: `navigator.requestMediaKeySystemAccess`, `MediaKeySystemAccess`, `MediaKeys`, `MediaKeySession`, `MediaKeyStatusMap`, `MediaKeyMessageEvent`, `MediaEncryptedEvent`, `HTMLMediaElement.setMediaKeys/mediaKeys/onencrypted/onwaitingforkey` | `harness/segment/eme.js` (segment Worker) |
| The host's side: the real EME objects, one host `<video>` per page element that used EME, a host `MediaSource` fed with the page's appends | `harness/segment/eme-host.js` (segment document) |
| The video layer: the segment's frame lifted over the view while a handed-over video shows | `harness/carapace/carapace.js` (`segment-video`), `carapace.css` (`iframe.video-over`), `guard.mjs` |

1. **Calls.** The Worker sends each call over a MessagePort of its own to the segment document, which calls the host's
   EME with the same arguments (BufferSources copied; anything else passed as it is, so the host's own WebIDL conversion
   refuses it). Results, events (`message`, `keystatuseschange`, `closed`) and errors come back; an error is rebuilt in the
   page's realm with the host's name and message. Session messages and licenses are bytes the **page** handles: it fetches
   its license over the engine's network as its own request (cookies, CORS and all), and passes the response to `update()`.
2. **Media hand-over.** An element's MediaSource goes to the host when the element has MediaKeys, or when an init segment
   appended to it is encrypted (WebM `ContentEncryption`; MP4 `encv`/`enca`/`tenc`/`pssh`, or a fragment's `senc`; found by
   walking the boxes/elements, not by a byte search). What was appended before (kept up to 64 MiB) is replayed to the host
   MediaSource. From then on the page's `SourceBuffer`/`MediaSource` methods and attributes act on the host's (checked
   first as Chrome checks them), and the page's element reflects the host element: `currentTime`, `duration`, `paused`,
   `readyState`, `buffered`, `error`, `videoWidth`... and its events, dispatched as trusted events (`encrypted` as a
   `MediaEncryptedEvent`). Volume, muted, rates and loop stay the engine element's (its events are the page's) and the
   host follows. A `play()` made before the hand-over resolves with the host's.
3. **Pixels.** After every frame tick the Worker measures each handed-over `<video>`'s content box (layout, padding,
   border, `object-fit`, visibility) and the host video is placed there. The carapace lifts the segment's frame over its
   view (transparent, `pointer-events: none`) while one shows. Decrypted frames never enter the engine: a canvas
   `drawImage` of such a video draws nothing, and nothing in Chitin can read them.
4. **Permissions.** The carapace gives the segment's frame `allow="autoplay; encrypted-media"`; the segment document's CSP
   allows `media-src blob:` (the host MediaSource's URL) and nothing else.

## Tests

- `CHITIN_ONLY=eme make chrome-test` (12 checks, in the default run too): `harness/sites/video.example/eme.html` plays
  `vp9-opus-6s-cenc.webm` (`tools/make-eme-media.mjs`: the WebCodecs-made test clip encrypted with AES-128-CTR as the WebM
  Encryption spec says; key and key ID are public test values) through MSE with Clear Key, MediaKeys set in the `encrypted`
  handler and before the media. Against Chrome on the same page: the API's shape, 17 error probes (names and messages
  equal), the element/session/buffer events in order, key statuses, timeupdates to the end, and the frames on screen at
  the box (red then yellow, read from a screenshot: the host drew them).
- `tests/eme.test.mjs` (make test): the encrypted-init detection against our clips and the WPT clips, the clip decrypts
  back to the clear one, the guard and the CSP.
- WPT `encrypted-media/clearkey-*` (45 files, `make wpt DIRS=encrypted-media`; area added to tools/wpt/subset.json with a
  `match` filter, the sparse clone needs `git sparse-checkout add /encrypted-media/`): Chrome 121/127, Chitin 120/128,
  **117 of Chrome's 121 passes (97 %)**. Missed:
  - `setmediakeys-to-multiple-video-elements`: the error is a `QuotaExceededError` in Chrome, a `DOMException` named so in
    Chitin (the engine has no `QuotaExceededError` interface).
  - `setmediakeys-at-same-time`: five concurrent `setMediaKeys` give two successes in the WPT run (our own probe of four
    gives Chrome's answer); not found yet.
  - `setmediakeys-again-after-resetting-src`: the host still holds the old MediaKeys when the second `setMediaKeys` comes.
  - `waiting-for-a-key`: the engine's own autoplay policy refuses the `play()` made before the hand-over (Chrome there runs
    with `--autoplay-policy=no-user-gesture-required`).
  - Timeouts: `encrypted-clear-sources` and two more (clear-then-encrypted source switches).
- Widevine: Chrome for Testing has no Widevine CDM, so the owner runs docs/user-tests/eme.md in their Chrome.

## Not yet

- **Overlays on a video.** The host video is drawn above the whole page view, so page content over the video (custom
  controls, subtitles drawn by the page) is hidden under it. The fix is a hole in the engine's paint (the video box
  cleared instead of painted) with the frame under the view: a Ladybird paint change.
- **Layout size.** A `<video>` without CSS size keeps the engine's 300x150 (the engine never learns the natural size).
- Handed-over videos in same-site iframes and in nested (cross-site) segments are not shown; their audio plays.
- A plain `src` URL with encrypted media is not handed over (the engine plays it and fails as before); MSE only.
- MediaSource handles from workers; `requestVideoFrameCallback`, `getVideoPlaybackQuality`, Picture-in-Picture of a
  handed-over video.
- `SourceBuffer.appendBuffer` errors the host raises at once (QuotaExceededError when full) arrive as an `error` and
  `updateend`, not as a synchronous throw.
