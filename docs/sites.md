# Real sites in Chitin: status per site

Status 2026-10-22, branch `chess`. One section per real site the owner ran: what it does in Chitin, the walls it hit,
and what was fixed. Each wall is reduced to a page of `sites.example` (harness/sites/sites.example) with a test in
tests/sites.test.mjs, and checked against plain headless Chrome for Testing with the same page. Runs: Node
(`node tools/net-page.mjs <url> --scripting`, `TRACE_VERIFY=1` prints the wasm stack at each `VERIFICATION FAILED`)
and Chrome for Testing through the carapace (`tools/with-browser.sh ... node tools/live-chrome.mjs <url> --any-host
--stacks`, `--wheel <dy>` scrolls with a real mouse wheel, `--click <selector>` clicks). All anonymous: nothing is
signed into, no form is sent. For many sites at once, `make corpus` loads tools/corpus/sites.txt in both browsers and
writes what differs (docs/corpus.md).

## chess.com (https://www.chess.com/, signed out)

- **Status:** works. The landing page renders (header, hero, bots, puzzles, watch sections), stays up past 70 s at
  60 frames a second, scrolls with the wheel, and the menu (the hamburger, `.mobile-toolbar-expand-menu-button`) opens
  and lists Play / Puzzles / Learn / Train / Watch / Community.
- **Wall (fixed): the engine stopped at load.** The panel's trap was `perform_a_microtask_checkpoint` failing
  `vm().execution_context_stack().is_empty()` (EventLoop.cpp), after `&settings.realm_execution_context() ==
  &vm.running_execution_context()` (Environments.cpp:189). Both were consequences. The first failure was
  `rc == 0` in `Threading::Thread::start` (Thread.cpp:124): the site's client bundle runs `new AudioContext()` at
  load; on Emscripten there is no platform audio backend, so the realtime renderer takes Ladybird's
  `NullPlaybackStream`, which starts a thread to pull audio at wall-clock pace. One thread cannot start another: the
  VERIFY trapped. The trap reached page code from a *construct*, and the glue stopped the engine on traps from page
  calls (hcap) but not from constructs, so the page went on with the context the trap had skipped popping still on
  the stack, and the next microtask checkpoint failed.
  - Layer: Ladybird on Emscripten (no threads), then Chitin glue (a construct's trap did not stop the engine).
  - Fix: patch 0040, `NullPlaybackStream` on Emscripten runs on the event loop. Each step does what one turn of the
    thread's loop did. Where the thread would wait for a played frame, a timer is armed. Where it would wait for a
    state change, the next signal schedules a step. `glue/engine/40-bridge.js`: a trap in a construct or a property
    set from page code now stops the engine, as one in a call does.
  - Chrome, same page (harness/sites/sites.example/audio-context.html): `running 48000`, microtask, rAF microtask,
    `resume()` resolves, `currentTime` advances, `close()`. Chitin now gives the same events (its output is 44100 Hz,
    and it starts `suspended` until the resume, which Chrome allows without a gesture under the test's flags). The
    audio is not heard: the null output discards it. Routing WebAudio to the carapace's AudioWorklet (as
    `<video>` audio is) is open.
- **Open:** two sidebar icons show their icon-font ligature names behind the label ("binoculars" behind Watch,
  "friends" behind Community). The icon font's glyphs or ligatures are not applied. Not investigated yet.

## fiverr.com (https://www.fiverr.com/)

- **Status:** depends on the bot check. In the owner's run the engine stopped `(unreachable, in renderingOpportunity)`,
  the same wall as chess.com (the page creates an AudioContext). The fix above covers it. The headless runs here get
  PerimeterX's "It needs a human touch" page instead of the site, so the site itself was not re-checked past that.
  Policy (docs/captcha.md): the challenge is never solved or worked around. The owner's run is the check.
- **Unstyled page:** the owner saw Fiverr's CSS not applied (plain links, serif text, a duplicated "Try building
  mobile ap" input). The engine had stopped by then, so the frame was the last one painted before or during the stop,
  which also matches "loaded a bit more but reverted". Recheck after the AudioContext fix before treating it as a
  separate CSS wall.
- **Wall (fixed, carapace): a tracking frame's navigation was shown as the top page's.** "navigating", "navigated"
  and "page title: Chitin could not load the page" showed `fls.doubleclick.net/activityi...` (in the runs here:
  `crcldu.com/bd/sync.html`). A nested segment (a cross-site iframe in a Worker of its own) reports status under the
  same row names as the top page, and the carapace showed its rows as they came, so they overwrote the page's. The
  top document was not replaced: only the rows were wrong. Fix (harness/carapace/carapace.js `segStatus`): a nested
  segment's rows are shown under `frame N <row>`, and only rows that say something went wrong (errors, failures, an
  engine stop). Stale `frame N` rows from the previous page are cleared per navigation on branch `cfdash` (1d67dad,
  `clearPageRows`). That fix is not repeated here.
- **Relay throttling:** "throttled by the relay", 65 streams open. The shipped relay allows 64 streams and 120 new
  connections a minute per session. Ad and tracker frames open most of them. Chitin keeps HTTP/1.1 keep-alive
  connections and at most 6 per origin (engine/platform/Network.cpp), as Chrome does for HTTP/1.1. But Chrome speaks
  HTTP/2 to most of these hosts, with one connection per origin, so on a tracker-heavy page Chitin opens more TCP
  connections than Chrome. Node run: 307 requests, 110 connections, 68 TLS handshakes. A local relay can raise its
  limits (`relay/relay.py` flags). HTTP/2 in the engine would bring the count close to Chrome's. Both are open.

## hostinger.com (https://www.hostinger.com/)

- **Status (branch `importmap`):** the landing page renders (header, domain search, the Black Friday hero, the cookie
  dialog) and stays up 60 s at 60 frames a second, headless through the carapace. Nuxt's error page is gone. Open: the
  Cloudflare Turnstile frame (a nested segment, 0x0 off-screen) reports `Uncaught TypeError: TypeError` and Turnstile
  error 300010; not studied.
- **Wall (fixed): the engine stopped when the session recorder read `rules`.** `trap in a call from page code:
  ganglion_key_value ← keyToJS ← wrap ← objectToJS ← toJS ← invokeEntered ← invoke ← get rules`, from the site's
  session-replay recorder (`LS.startRecording` → a stylesheet snapshot). `ganglion_v_own_keys`
  (engine/platform/Bridge.cpp) turned each string key into a `Utf16FlyString` and kept only the key's borrowed
  identity. The fly string was dropped at the end of the statement. Short names are stored inline and survived.
  Longer ones, such as the index "1234" of a CSSRuleList with thousands of rules (wrapping one reads its own keys),
  were freed, and reading the key failed a VERIFY.
  - Layer: Chitin engine bridge.
  - Fix: the names an own-key list hands out are kept alive (a set, each name once), as `ganglion_key_intern`
    already did for the glue's keys.
  - Chrome, same page (harness/sites/sites.example/rules.html, 3000 rules plus `@import`, `@media`, `@font-face`,
    `@keyframes`, `@supports`, `@layer` and a cross-origin sheet): `rules === cssRules`, `Object.keys` gives
    `0..2999`, JSON of the list, `rules[2999]`, rules with no own keys except `CSSKeyframesRule` (two indexed keys),
    and `SecurityError` on the cross-origin sheet's `rules`. Chitin now matches it.
- **Wall (fixed): Nuxt's `#entry` import.** The app's error was `Failed to resolve module specifier "#entry"`. Nuxt maps
  `#entry` in the document's `<script type="importmap">`, and V8 in the segment Worker knows no import map.
  - Layer: Chitin's module loader (and LibWeb's import map, patch 0041 for Chrome's error wording and merged integrity).
  - Fix: import maps (docs/architecture.md "Import maps"): the engine's map, and the segment service worker replaces the
    mapped specifier strings with the map's URLs (the owner-approved second exception to no-rewriting).
  - Chrome, same shapes (harness/sites/importmap.example: several maps, scopes, null and backtracking entries,
    integrity, a late map, a frame's own map, a module Worker, the error messages): Chitin gives the same 25 outcomes,
    except `import(expression)` (chrome-test group importmap, tests/importmap.test.mjs).

## hls.gehealthcare.com (https://hls.gehealthcare.com/momentum/index.php)

- **Status:** renders (header, hero, cookie dialog) and stays up 60 s in the headless runs here, with the old engine
  and the new one.
- **Owner's wall:** "engine stopped (unreachable, in a call from page code)" after rendering. It did not reproduce
  headless (no consent given, no interaction), so its stack is not captured yet. It is the same kind of stop as
  hostinger's (a trap in a call from page code), and the dangling own-key fix covers every own-key read. If the owner
  still sees it on this branch, the panel's engine log holds the stack (`--stacks` here).
- **Stale panel rows** (audio rows, frame 1–3 from Fiverr): a carapace reused across sites kept the previous page's
  rows. The frame rows are cleared on `cfdash`. The audio rows are the carapace's own AudioContext rows, which live
  as long as the carapace and are not cleared per navigation yet.
