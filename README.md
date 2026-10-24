# Chitin

A web browser that runs inside a web page, without intercepting or rewriting sites: every site gets
its own hard shell (its own origin and process, a real engine, its own storage), its JavaScript runs
on the host browser's V8, and its network goes through our relay or Tor.

Start with [docs/architecture.md](docs/architecture.md).

Chitin is built on other projects, above all its rendering engine; see CREDITS.md.

## Try it locally

You need Node.js 20 or newer, Python 3.9 or newer (the relay uses only the standard library) and a current desktop Chrome or
Chromium. Nothing to install: the repository ships a built engine (`build/ganglion.wasm`) and its runtime files (`ext/`: ICU
data, the CA bundle, fonts).

1. **Start the relay** (terminal 1). Chitin's engine opens its TCP connections through it; TLS runs inside the engine, so the
   relay only carries encrypted bytes.
   ```bash
   python3 relay/relay.py --log 1 --allow-any-host
   ```
   `--allow-any-host` lets the relay connect to any public site and is for **local testing only**. Private and local addresses
   are always refused. To limit it, use `--host-allow en.wikipedia.org --host-allow '*.wikimedia.org'` instead. Read
   [relay/README.md](relay/README.md) before running a relay anyone else can reach: whoever runs a relay is responsible
   for its traffic.
2. **Start the harness** (terminal 2):
   ```bash
   node harness/server.mjs
   ```
   It listens on loopback only, port 8100 (`--port` to change; `--relay ws://127.0.0.1:8101/` if the relay runs elsewhere).
3. **Open <http://localhost:8100/>** in Chrome, type an address (for example `https://en.wikipedia.org/`) and press Enter.

### What you see

- **The page** in a tab-sized box. The **size** menu picks a standard window size (1280×720 default) or "fit the window".
- **Right-click** the page for Chitin's menu: back/forward/reload, copy/paste with your clipboard (⌘C/⌘V also work), view
  page source or the live DOM, inspect an element, open the page in your own browser, reset the site.
- **The panel under the page**, like a browser's developer tools:
  - **Console**: every error, labelled with the layer it came from (Chitin's engine, Chitin's glue, the page's own script,
    its service worker, the host browser), and a prompt that runs JavaScript in the page.
  - **Network**: the page's requests (from its Resource Timing), with filters, a waterfall and the engine's connection totals.
  - **Segment / Frames / Cookies**: the engine's status, frame timing, and each site's cookies (with a clear button).
  - **reset site**: clears everything Chitin keeps for the site (cookies, storage, IndexedDB, OPFS, caches, service workers).
- Sites that refuse Chitin (some bot checks do) can be opened in your own browser from the menu. Chitin does not try to get
  past bot checks or captchas; a captcha shown to you can be solved by you.

### Good sites to try

Wikipedia, YouTube (video and audio), Spotify (log in with email; playback uses your Chrome's own Widevine), Google search,
DuckDuckGo, chess.com, GitHub, `https://webrtc.github.io/samples/` (camera and data channels), three.js examples (WebGL),
anura.pro (a web OS), and sites that are themselves web proxies.

### Known gaps

Layout and paint run in WebAssembly on one thread, so heavy pages scroll and animate slower than in Chrome; screen sharing
(`getDisplayMedia`) is not wired yet; fullscreen is refused inside cross-site iframes; video is drawn above other page content;
the first visit downloads the ~61 MB engine (cached after that). See [docs/sites.md](docs/sites.md).

## Building the engine from source

The engine is Ladybird's LibWeb compiled to WebAssembly with the patches in [patches/ladybird/](patches/ladybird/). The
toolchain (Emscripten, dependencies, the Ladybird checkout) and the build are described in [docs/toolchain.md](docs/toolchain.md):
`tools/setup-toolchain.sh`, then `tools/ganglion-build.sh configure` and `tools/ganglion-build.sh build ganglion`, then
`make engine-glue engine`. It is a large build (hours on a laptop the first time).

## What is in this repository

| Path | What |
|---|---|
| `harness/` | The carapace (the page you open) and the segment code each site runs in |
| `relay/` | The relay (Wisp 2 server, Python, standard library only) and its Dockerfile |
| `relay-cpp/` | A fast C++ relay with the same rules (MIT OR Apache-2.0; see its README) |
| `glue/` | The bridge between the engine and the host V8 |
| `engine/` | Chitin's platform layer for the engine (network, fonts, host integration) |
| `patches/ladybird/` | The Ladybird patches the engine is built with |
| `build/` | The built engine and glue bundle |
| `ext/` | Runtime files: ICU data, CA bundle, fonts (their licences are beside them) |
| `docs/` | Architecture and design notes |
| `tools/` | Build scripts |

Chitin's test suites and its comparison and diff tooling are not part of this release.

## Licence and legal

> Draft — not legal advice; to be reviewed by a lawyer before publication.

Chitin's own code is under the GNU General Public License, version 2 or (at your option) any later
version ([LICENSE.md](LICENSE.md), SPDX `GPL-2.0-or-later`). Third-party components keep their own licences; the engine is built on Ladybird
(BSD-2-Clause), whose notices are kept in every build ([CREDITS.md](CREDITS.md)). Copies and forks must
rename and rebrand ([TRADEMARKS.md](TRADEMARKS.md)).

Chitin is not a school or firewall unblocker and must not be presented as one. You are responsible for
following the law and the rules of the networks you use. The project collects no data and does not
run a relay; whoever runs a relay is responsible for the traffic through it.

The legal documents are in [docs/legal/](docs/legal/README.md): [Terms of Use](docs/legal/TERMS.md),
[Acceptable Use](docs/legal/ACCEPTABLE_USE.md), [Privacy](docs/legal/PRIVACY.md),
[running a relay](docs/legal/relay-operators.md), [licence violations and takedowns](docs/legal/takedown.md).
