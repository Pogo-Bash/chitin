<!-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 -->
<!-- Copyright (c) 2026 [OWNER NAME] -->
<!-- Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL]) -->
# InvisiProxy (Holy Unblocker LTS, Scramjet) in Chitin

InvisiProxy (https://invisiproxy.com/) is a Holy Unblocker deployment: the home page stores the address to visit in
`localStorage["ip-frame-url"]` (`sj:<url>` for Scramjet) and goes to `/s?cache=<key>`, whose Scramjet controller registers
its service worker (`/sw-blacklist.js`, a page service worker, docs/architecture.md), opens a Wisp WebSocket
(`wss://invisiproxy.com/wisp/`), loads libcurl.js as its transport and shows the proxied page in a **same-site iframe**
(`/scram/network/<session>/<id>/<encoded url>`). Scramjet's client is injected into that frame and hooks the frame's window.

How it is run here (anonymous; nothing is submitted): `tools/live-chrome.mjs https://invisiproxy.com/ --any-host --wait 90000
--act-after 12000 --act '<set ip-frame-url to sj:https://duckduckgo.com/?q=duckduckgo; location.href = "/s?cache=2609979094">'`
(`--any-host`: the local relay's `--allow-any-host`, Decisions.md 2026-10-22; `--stacks` adds call sites, `--eval <js>`
probes the segment at the end). Results in build/live-m6-ip1 .. ip7 (M6), build/ip-base .. ip-10 (branch invisi).
The native reference is the same flow in Chrome for Testing straight on invisiproxy.com (build/chrome-ip).

## Before M6 (the owner's run on main 1b1bea5)

The proxied DuckDuckGo page was fetched ("detected quirky document structure parsing @ https://duckduckgo.com/?q=duckduckgo")
but the view stayed white; `unrewriteurl: unexpected url https://invisiproxy.com/s?cache=...` about 123 times: a frame's scripts
did not run, so Scramjet's frame client never saw its own document.

## With frame realms (M6, 2026-10-22, branch m6)

- **The frame sees its own location.** In the frame realm `location.href` is the Scramjet URL
  (`https://invisiproxy.com/scram/network/.../https%3A%2F%2Fduckduckgo.com%2F%3Fq%3Dduckduckgo`), `document.title` is
  "duckduckgo at DuckDuckGo", the raw `document.URL` and `baseURI` are the frame's, and Scramjet's hooked `baseURI` answers
  `https://duckduckgo.com/?q=duckduckgo`.
- **Scramjet's client hooks completely** after one fix: it defines its globals non-configurable on the frame's window
  (`Object.defineProperty(self, "$scramjet$rewrite", {configurable: false})`), which the frame WindowProxy (a Proxy) refused
  with an invariant TypeError, so the hook loop stopped after the first global and every rewritten script then failed with
  `$scramjet$pushsourcemap is not defined`. The WindowProxy now keeps such properties on its target as well (one object per
  document of the frame). All eleven `$scramjet$*` globals are there; frame `Function(...)` compiles in the frame's scope.
- **DuckDuckGo's results do not paint yet.** Next walls, in the order they appear:
  1. Scramjet's wasm rewriter fails on one script: `failed rewriting js ... (function proxy) Failed to allocate a memory`
     (an allocation in Scramjet's own wasm module in the segment Worker).
  2. Six of DuckDuckGo's requests through libcurl.js over Wisp fail: `Request failed with error code 35: SSL connect error`.
  3. DuckDuckGo's own scripts then fail: `Cannot set properties of undefined (setting 'duckduckgo')` (reported by the page to
     improving.duckduckgo.com, refused by nothing: it is the page's own telemetry through the proxy) and
     `DDG.deep.anomalyDetectionBlock` on undefined; the frame then navigates to `https://duckduckgo.com/undefined`.
  4. `unrewriteurl: unexpected url https://invisiproxy.com/s?cache=...` still appears about 250 times; it is the parent
     document's URL (the frame's `document.referrer` is it, as in Chrome); which caller asks Scramjet to unrewrite it is not
     found yet.
- Also seen, correct: "Refusing to run classic script because it has the nomodule attribute".

## Branch invisi (2026-10-22): against native Chrome

Native Chrome running the same flow paints DuckDuckGo inside InvisiProxy (DuckDuckGo shows its "bots use DuckDuckGo too"
duck challenge to a headless browser). It also logs `Request failed with error code 35: SSL connect error` (15 times) and
`wisp client warning: received a CLOSE packet for a stream which doesn't exist` (11), and its frame also ends at
`https://duckduckgo.com/undefined`: all of them are DuckDuckGo's telemetry host improving.duckduckgo.com refusing the
proxy's TLS, and DuckDuckGo's own navigation. **Walls 2 and 3's navigation are not Chitin's**; Chitin now logs the same
lines in the same numbers. What was Chitin's, fixed on the branch:

1. **Scramjet's rewriter out of memory**: the frame realm's `WebAssembly` was the engine's (LibWeb's own namespace on
   the frame Window, backed by LibWasm, whose memory allocation failed: "Failed to allocate a memory instance"). The
   frame's `WebAssembly` is now the host's, as the page's has been (40-bridge.js `HOST_ONLY_GLOBALS`).
2. **`unrewriteurl: unexpected url https://invisiproxy.com/s?cache=...` (128 a load)**: the page's service worker had one
   client for the whole segment, so every request of the frame carried the parent page's `clientId`, and Scramjet's
   worker unrewrites `clients.get(clientId).url`. A same-site frame's document is now a window client of its own
   (`frameType: 'nested'`), named by the engine's loader (Host.cpp: the request's client document URL); a frame's
   navigation has `clientId` `''` and a `resultingClientId`, as in Chrome. 0 such lines now.
3. **DuckDuckGo's scripts failing** (`Cannot set properties of undefined (setting 'duckduckgo')`, then `DDG.ready is not a
   function`, `DDG.deep` undefined...): DuckDuckGo's util.js runs `(function () { this.locale_data.duckduckgo = ... })()`,
   whose `this` is the Worker's global (the principal window) in a frame realm. While a frame's classic script runs, the
   frame's own globals are now lent to the principal window and what the script makes there is moved to the frame.
4. **`Cannot redefine property: $scramjet__location`** when the frame's next document starts its Scramjet client: the
   ECMAScript built-ins are shared by all realms, so the last document's non-configurable `Object.prototype` accessors
   were still there. A frame's definitions on shared built-ins now stay configurable.
5. **DuckDuckGo took Chitin for Internet Explorer** (`isIE = !!document.all`, then `setTimeout("d.x.reset()")`:
   `Cannot read properties of undefined (reading 'reset')`): `document.all` is now `undefined` (Chrome's object is
   falsy with `typeof` 'undefined').

After these the frame's DuckDuckGo document is complete and laid out as in Chrome (title "duckduckgo at DuckDuckGo",
the SERP header, the duck challenge modal at its place, no page script errors; telemetry as in Chrome), **but the view
is white**.

**Next wall: a same-site iframe's document is not painted.** The segment's bitmap has the iframe's box (InvisiProxy's
`#frame`, white) and nothing of the frame's document; the same holds for the simplest case (iframes.example/same.html:
the border, no "child page" text), so it is the engine's painting of a same-site child navigable (LibWeb's
NavigableContainerViewportPaintable / the child's rendering update in Host.cpp's paint), not InvisiProxy's.

## Branch tls35 (2026-10-22): error 35 on the main request was Chitin's

libcurl.js's Wisp client wraps each DATA packet in `new MessageEvent('message', { data: packet.slice(5) })` and reads
`event.data.buffer`. A page-made MessageEvent's `data` went through the engine and back as a clone, and a Uint8Array came back
**empty**: every TLS record arrived as zero bytes, mbedTLS saw EOF (`ssl_handshake returned -0x7280`), error 35. The WebSocket
itself was byte-exact (tests/websocket.test.mjs "byte-exact": bursts 1 B..1 MiB, views with offsets). Now a constructed
MessageEvent keeps its init's `data` object (40-bridge.js `rememberMessageData`), as in Chrome; websocket.js hands the page an
ArrayBuffer of the page's realm. Reproduced with libcurl.js 0.7.4 from invisiproxy.com against https://duckduckgo.com through a
local Wisp server (`tools/live-chrome.mjs https://localhost:8233/ --relay-args '--allow-private --port-allow 80,443,8233'
--server-args '--net-ports 80,443,8233 --extra-ca tests/fixtures/tls/ca.pem'`): before, error 35; after, HTTP 202 as in Chrome.
Left open: the clone read-back of an engine-made typed array is empty (readClone kind 10), not reached by pages now.
