# How Chitin is different

A plain-language tour of Chitin for someone who already knows how web proxies work (Scramjet,
Ultraviolet, Sandstone) and has seen the "browser compiled to wasm" demos (Puter's Ladybird port,
firefox-wasm). It explains what Chitin does instead, why, what that buys, and what it costs. Where a
number appears, it was measured; where something is a plan, it says so.

Deeper references: `docs/architecture.md` (the design), `docs/security.md` (threat model),
`docs/network.md` (the network path), `docs/operators.md` (running a relay), `docs/research/` (why
each choice was made, with sources).

---

## The one-sentence version

Proxies **rewrite** a site so it runs as part of *your* page; browser-in-wasm ports **emulate** a whole
browser inside your page; Chitin **runs the site's own engine in a sealed box of its own**, and lends it the host browser's JavaScript engine.

---

## The problem everyone is solving

You want `https://example.com` to render inside a page you control. The browser refuses, for good reasons: CORS blocks reading other sites, `X-Frame-Options` blocks framing them, and every relative URL would resolve against your domain. So something has to do two jobs:

1. **Get the bytes** from somewhere the browser's origin rules don't apply. *(the transport)*
2. **Make the page work** somewhere it wasn't built for. *(the hard part)*

Everyone solves job 1 roughly the same way now: a byte tunnel (Wisp over a WebSocket) to a relay, with TLS negotiated inside the browser so the relay only sees ciphertext. Chitin does this too.

Job 2 is where the approaches split into three families.

---

## Three ways to do job 2

### Family 1: rewrite the site (Scramjet, Ultraviolet, Sandstone)

The site runs as a document **on your origin**. A service worker intercepts its requests, and a
rewriter edits HTML, CSS and every script so that `location`, `fetch`, `document.cookie`,
`postMessage`, `Worker` and friends hit shims instead of the real thing.

- **Good:** small download (a few hundred KB plus the transport), real host engine speed for
  everything (the site's JS runs on the host's V8 at full JIT speed), mature.
- **Bad:** rewriting JavaScript correctly is an endless arms race; ProxDocs calls it "inherently
  jank". Every proxied site shares **your** origin, so a hostile site can read your settings,
  history and the other sites' cookie jar (it lives in IndexedDB on the same origin). The site's own
  Content-Security-Policy has to be stripped. Bot detection notices the rewritten environment.
- Sandstone's twist: each page in an opaque-origin sandboxed iframe, no service worker, runnable
  from a local file. Better containment, but still a rewriter, and storage and modules suffer.

### Family 2: compile a whole browser to wasm (Puter's Ladybird port, firefox-wasm)

Build the entire engine, **including its JavaScript engine**, with Emscripten, and paint into a
canvas.

- **Good:** no rewriting at all; the site sees a real engine.
- **Bad:** the site's JavaScript runs on a JS engine *compiled to wasm*, which cannot JIT to native
  code. firefox-wasm builds with `--disable-jit` and runs SpiderMonkey's portable baseline
  interpreter; Puter's Ladybird port started from LibJS. Modern sites are mostly JavaScript, so they
  crawl (firefox-wasm on YouTube feels about like Chromium inside rvwasm's emulated riscv64
  machine). A site's own WebAssembly is interpreted too. Everything shares one wasm instance: no site
  isolation, one bug exposes every site. Software painting. Large downloads (firefox-wasm's
  `gecko.wasm` is 247 MB).

### Family 3: Chitin

A real engine for HTML, CSS, layout and paint, **without its JavaScript engine**, one copy per site,
each in its own sealed box; the site's JavaScript runs on **the host browser's own V8**, with the JIT.

---

## The pieces

```
 your browser tab
 ┌────────────────────────────────────────────────────────────────┐
 │ Carapace  (our origin): tabs, address bar, compositor, input   │
 │                                                                │
 │   ┌──────────────────────┐   ┌──────────────────────┐          │
 │   │ Segment: site A      │   │ Segment: site B      │   ...    │
 │   │ own origin, own      │   │ (same shape)         │          │
 │   │ process              │   └──────────────────────┘          │
 │   │  ┌────────────────┐  │                                     │
 │   │  │ one Worker:    │  │                                     │
 │   │  │  Ganglion      │  │  frames ──► carapace                │
 │   │  │  (LibWeb wasm) │  │  ◄── input                          │
 │   │  │ + site's JS on │  │                                     │
 │   │  │   host V8      │  │                                     │
 │   │  └───────┬────────┘  │                                     │
 │   └──────────┼───────────┘                                     │
 │              │ byte streams, TLS already inside                │
 │   Spiracle (our Worker): stream mux ──► relay you run (Wisp)   │
 └────────────────────────────────────────────────────────────────┘
```

| Piece | What it is | Insect joke |
|---|---|---|
| **Carapace** | The outer page: tabs, address bar, compositing the frames, input | the shell |
| **Segment** | One per site: an iframe on its own registrable domain, so the host browser gives it its own process and origin | a body segment |
| **Ganglion** | The engine: Ladybird's LibWeb (HTML, CSS, layout, Skia paint) built for wasm32, LibJS removed | a nerve cluster |
| **The bridge and mirror** | How the site's JS on V8 talks to the engine: classes generated from LibWeb's own bindings, direct calls into wasm, same thread | |
| **Spiracle** | Multiplexes the segments' byte streams onto the relay connection | breathing holes |
| **Relay** | A small Wisp v2 server *you* run (Docker or Python); sees destinations and ciphertext only | |

---

## Following one page load

You type `en.wikipedia.org/wiki/Web_browser`.

1. **Carapace** decides the site is `wikipedia.org` and creates (or reuses) that site's **segment**:
   an iframe on a domain derived from the site, so the host browser puts it in a separate process.
2. Inside the segment, **one Worker** starts **Ganglion**. A boot check removes every host API the
   page must not reach (host `fetch`, `XMLHttpRequest`, `WebSocket`, storage, messaging, WebRTC,
   device APIs) from where they actually live, not just the global, and refuses to start if Chrome
   exposes anything it hasn't classified.
3. Ganglion requests the document through its own network stack. The **TLS handshake happens in
   the engine**, in wasm. The encrypted bytes go to **Spiracle**, then over Wisp to **your relay**,
   which opens a TCP connection to Wikipedia and pipes bytes. The relay never sees the page.
4. LibWeb parses the HTML and CSS, lays out, and paints with Skia into an OffscreenCanvas; frames go
   to the carapace, input comes back.
5. Scripts: the engine hands each `<script>` to the **host V8**, in the segment's own realm. They run
   at full JIT speed and call DOM APIs that the **mirror** routes straight into LibWeb's C++.
   Classic scripts share top-level `let`/`const` the way Chrome does.
6. Nothing in the page was edited. The site's CSP applies to the site (planned: enforced by the
   engine). `document.cookie` is the engine's own jar, for that site only.

Measured under Node (2026-10-21): Wikipedia with its JavaScript loads 124 modules with none in
error, the main menu opens and search suggestions appear; document in 0.8 s, 188 requests.
Phase 0 in Chrome: 120 fps, about 10 ms from input to frame.

---

## Side by side

| | Rewriting proxy (Scramjet) | Browser-in-wasm (firefox-wasm) | **Chitin** |
|---|---|---|---|
| Edits the site's code | yes, all of it | no | **no** |
| Site's JS runs on | host V8 (JIT) | JS engine compiled to wasm (no JIT) | **host V8 (JIT)** |
| Site's own wasm | host (native) | interpreted | **host (native)** |
| Sites isolated from each other | no, one shared origin | no, one wasm instance | **yes, origin + process per site** |
| Site can read your app's storage | yes | n/a | **no** |
| Site's CSP | stripped | kept | **kept (engine-enforced: planned)** |
| Rendering engine | the host's | Gecko (wasm) | LibWeb (wasm) |
| Painting | host | software, canvas | Skia into OffscreenCanvas (GPU path planned) |
| Download | ~0.3 MB + ~0.8 MB transport | ~247 MB engine | **~61 MB engine (a problem: see below)** |
| Relay sees | destinations + ciphertext (Wisp) | same | same |

---

## Security, honestly

The full threat model is `docs/security.md`. The short version, including where outside critics
were right:

- **"You still need a sandbox for the JS engine."** Partly right. The real sandbox is the host
  browser's own site isolation: an escape lands in that site's box. But inside the Worker, page JS
  could once reach the host's real `fetch` through the prototype chain, which would leak your IP. Now
  those APIs are deleted where they live, a boot-time allowlist refuses anything unknown, a strict
  Worker CSP backs it up, and script loading fails closed without the service worker. (Proven under
  Node; the automated Chrome run is being built.)
- **"JS can escape and mess with your IPC."** Was true of the harness: a page could forge a message
  to the Worker. Now the Worker takes exactly one trusted `init`, then stops listening; control
  messages ride a private port. Worst case for a fully compromised segment: what its own site could
  do anyway, plus outbound connections from the relay's IP. Never your IP, other sites, the relay
  token or the address bar.
- **"Sites will silently reject you (Turnstile)."** Largely right and not fully fixable. We can match
  Chrome's JS surface, User-Agent, TLS fingerprint and HTTP/2 fingerprint because we control every
  byte; we can't change a relay's IP reputation or the fact that the global isn't a real Window.
  Plan: detect the rejection and offer "open in your own browser".
- **"You'll need interception to fix Error.stack."** Wrong: V8's own stack-trace hooks shape it
  inside the realm, no script rewriting. One tell remains (`'prepareStackTrace' in Error`).

---

## What it costs (the honest list)

- **Download size.** The engine is about 61 MB of wasm. Proxies ship about 1 MB. This is the
  biggest open UX problem: compression, streaming compile and lazy loading are not done yet.
- **Rendering fidelity.** LibWeb renders fewer sites correctly than Chrome. Ladybird moves fast,
  but the gap is real.
- **Memory per site.** Each segment is its own engine instance.
- **Never works:** DRM video (Netflix, Spotify, Disney+): licenses are bound to the real origin and
  device. Same for every proxy and every browser-in-a-browser.
- **Bot-detected sites** may block you regardless.

---

## Hosting and the relay

There is no public Chitin service. The project publishes a demo behind an allowlist, and anyone else
runs their own relay and bears the consequences, informed by `docs/operators.md`. The relay's
defaults are the ones ProxDocs says people get wrong:

- private and loopback ranges refused, including cloud metadata; every resolved address is
  checked and the checked one is the one connected to (no DNS rebinding);
- a destination allowlist it refuses to start without (`--host-allow`), and a literal IP never
  matches a name pattern, so the allowlist can't be bypassed with a bare IP;
- per-session stream limits, connection rate limits, scan detection; ports 80 and 443 only.

Tor mode is parked for now.

---

## Where it stands (2026-10-21)

- Phase 0 and 1 done; network through the relay done; phase 2 M1 (TodoMVC) and M2 (Wikipedia with
  its JS) working under Node.
- In progress: the M2 bug fixes at their root causes, a fresh Worker per page, the carapace owning
  the address bar, message validation, and automated Chrome tests (Puppeteer on Chrome for Testing).
- Next: M3 cross-heap GC, M4 forms/cookies/encrypted storage, M5 Chrome-identical surfaces + the
  rejection detector, M5n TLS/HTTP2 fingerprints, M6 stack and CSP shaping; then the relay as a
  Docker image people run, then media.

The bet in one line: **a real engine per site, sealed by the browser itself, with the site's
JavaScript at full host speed.** The comparison that will prove or disprove it is the same page timed
in Chitin, firefox-wasm and Puter's Ladybird port. That benchmark is on the list.

---

## Glossary

- **Carapace**: the outer page; owns tabs, the address bar and what is shown.
- **Segment**: one site's sealed box: its own origin, process and engine.
- **Ganglion**: the engine (LibWeb in wasm, LibJS removed).
- **Mirror / bridge**: generated bindings letting V8-run page JS call into LibWeb directly.
- **Spiracle**: multiplexes segments' encrypted byte streams to the relay.
- **Relay**: your Wisp v2 server; sees destinations and ciphertext only.
- **Wisp**: one WebSocket carrying many TCP streams.
- **Site isolation / DIP**: the host browser's own per-site process separation
  (Document-Isolation-Policy makes a segment cross-origin isolated by itself).
- **Rewriting proxy**: edits a site's code so it runs on your origin (what Chitin doesn't do).
