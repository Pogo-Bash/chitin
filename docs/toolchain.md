# Toolchain

Status: chosen and pinned in phase 0, 2026-10-11. Pins live in `tools/toolchain.env`;
`tools/setup-toolchain.sh` installs them; `make toolchain-check` proves them.

## The choice

**Emscripten 4.0.11, which ships clang 21.0.0git, libc++ 20.1 and Wasm exception handling, target
`wasm32-unknown-emscripten`.** Installed through emsdk into `~/dev/chitin-ext/emsdk` (outside the
repo; 1.5 GB). No LLVM build was needed.

| Pin | Value |
|---|---|
| Emscripten | 4.0.11 (emscripten commit `d3432e7a2a6585331c94b041973fb16c9f332ce4`) |
| emscripten-releases build | `7033fec38817ec01909b044ea0193ddd5057255c` (macOS arm64 binaries) |
| clang | `21.0.0git`, llvm-project `0f0079c29da4b4d5bbd43dced1db9ad6c6d11008` |
| libc++ / libc++abi | 20.1 (`_LIBCPP_VERSION 200100`) |
| emsdk | `35ff8a6d150541276abbc6bae512ca90bcfbe220` |
| Python for emsdk | 3.10 or newer (macOS's 3.9 is refused; `~/.local/bin/python3.12` is used) |
| Node for tests | 22.14 (V8 12.4) on PATH; emsdk also brings Node 24.19 (V8 13.6) |

What `make toolchain-check` shows (2026-10-11, this Mac):

```
wasm exceptions: caught 'thrown across frames'
std::expected: 42  ranges: 4 items  __cplusplus: 202302  clang 21.0  libc++ 200100
if consteval: ok
```

It passes with both encodings of Wasm EH: the legacy proposal (Emscripten's default,
`-fwasm-exceptions`) and the standardised exnref form (`-sWASM_LEGACY_EXCEPTIONS=0`, which Node 22
needs `--experimental-wasm-exnref` for and Chrome 137+ runs natively).

## How each candidate was checked

**wasi-sdk** (WebAssembly/wasi-sdk releases, read 2026-10-11 through the GitHub API):

- LLVM per release: wasi-sdk 28, 29 and 30 are LLVM 21 ("Update to LLVM 21", wasi-sdk-28 notes);
  31 moved to LLVM 22; 34 (2026-08-25) is LLVM tip, heading for 23.
- C++ exceptions: the sysroot gained libc++ built with exceptions only in wasi-sdk 33
  ("Build a sysroot that supports C++ exceptions by default", wasi-sdk-33 notes), and its own docs
  say "enabling C++ exceptions requires LLVM 22 or later" (`CppExceptions.md` at wasi-sdk-33).
- So no wasi-sdk release gives clang 21 *and* Wasm EH. wasi-sdk-30 is the cleanest real clang 21
  release (21.1.x, not a git snapshot), but without exceptions.
- It also brings only wasi-libc. LibWeb's platform layer (AK, LibCore) assumes POSIX: threads,
  mmap, clocks, a filesystem for fonts and ICU data. We would write that layer ourselves.

**Emscripten** (emsdk `emscripten-releases-tags.json`, each release's `DEPS` in
chromium.googlesource.com/emscripten-releases, then `cmake/Modules/LLVMVersion.cmake` at that
llvm-project revision):

| Emscripten | Date | LLVM major of its clang |
|---|---|---|
| 4.0.9 | 2025-05-19 | 21 |
| 4.0.10 | 2025-06-07 | 21 |
| **4.0.11** | 2025-07-14 | **21** (the last one, a day before LLVM's release/21.x branch) |
| 4.0.12 | 2025-08-01 | 22 |
| 6.0.12 (latest) | 2026-10-08 | 24 |

- Emscripten builds its compiler from LLVM main, so its clang is always a `git` snapshot, never a
  21.1.x release. 4.0.11 is the closest Emscripten gets to clang 21.
- Its libc++abi and libunwind have had Wasm EH support for years; `-fwasm-exceptions` just works.
- It brings a musl-based libc with pthreads-as-Workers, mmap emulation, a virtual filesystem, GL to
  WebGL2, and JSPI. firefox-wasm uses it for all of Gecko (Emscripten 6.0.1, `mozconfig.full.emscripten`).
- Ladybird's LibCore already has comments about Emscripten's futex protocol
  (`Libraries/LibCore/Futex.cpp`, docs/research/engines.md).

**Homebrew `llvm@21` plus a wasm sysroot**: Ladybird's own macOS CI installs `llvm@21`
(`.github/actions/setup/action.yml`, Ladybird `975740c`), so it is the most faithful compiler match.
But this Mac has no Homebrew, and the formula has no wasm sysroot: we would need wasi-libc plus a
libc++/libc++abi/libunwind built with exceptions, which is the LLVM-22 problem above. Rejected for
phase 0.

**Building LLVM**: not needed.

## Why Emscripten 4.0.11

1. It is the only prebuilt path to clang 21 with libc++ and Wasm EH.
2. It suits LibWeb later. LibWeb needs a POSIX layer, and Emscripten has one; firefox-wasm shows a
   larger engine on it.
3. It does not force Emscripten's JS runtime on us. The toy engine links with `-sSTANDALONE_WASM
   --no-entry`, so the only imports are our own (`chitin.*`), one memory-growth notice and three
   WASI stubs (`fd_write`, `fd_close`, `fd_seek`), and our glue instantiates it. See the security
   note below.

## Facts that matter more than the version number

- **LibWeb does not need exceptions.** Ladybird compiles with `-fno-exceptions`
  (`Meta/CMake/compile_options.cmake`, line 111) and Rust with `panic = "abort"`. The toy engine is
  built the same way. Wasm EH is in the toolchain and tested, but it is a capability, not something
  LibWeb uses. Third-party dependencies that want exceptions can have them.
- **C++23 works:** `std::expected`, `<print>`, ranges, `if consteval`, `-std=c++23`. Ladybird needs
  clang 19 or newer (`Meta/Utils/find_compiler.py`: `CLANG_MINIMUM_VERSION = 19`), so 21 is
  comfortably above it.
- **Rust 1.98 is LLVM 22.1** (`.gitmodules` at rust-lang/rust 1.98.0: branch
  `rustc/22.1-2026-05-19`). clang 21 cannot read LLVM 22 bitcode, so **cross-language LTO between
  LibWeb's C++ and Rust halves is impossible with clang 21**. Plain object linking still works.
- **Rust's prebuilt std for `wasm32-unknown-emscripten` is built with "latest" Emscripten** at the
  time of the Rust release (`src/ci/docker/host-x86_64/dist-various-1/install-emscripten.sh`
  clones emsdk and runs `./emsdk install latest`). The target docs say to match Emscripten versions
  or rebuild std (`-Zbuild-std`) because Emscripten's ABI is not semver-stable
  (doc.rust-lang.org, platform-support/wasm32-unknown-emscripten). With 4.0.11 we will need
  `-Zbuild-std` for LibWeb's Rust half, as firefox-wasm does.

These two points are why phase 1 should revisit the pin; see "Phase 1" below.

## Security note: Emscripten's JS runtime and the shared realm

Page JS shares the Worker realm with our glue. Emscripten's generated JS (its syscall layer,
`HEAPU8`, `UTF8ToString`, the FS) is ordinary JS that calls builtins page JS can replace, and it
holds views of linear memory. Running it in the page's realm would hand the page ways to reach
`memory.buffer`, which exposes the whole engine (docs/research/bindings-and-gc.md, "Security of the
glue"). So the toy uses `-sSTANDALONE_WASM`, and the glue supplies the imports itself
(glue/90-boot.js). Phase 1 will need many more of them (files, clocks, threads) and should keep
writing them in the hardened style of glue/00-primordials.js rather than pulling in Emscripten's
`library_*.js`.

## Phase 1

- **Recommendation:** keep the C++ on clang 21 for now (Ladybird CI parity, `-Werror` stays clean),
  build the Rust half with Rust 1.98 and `-Zbuild-std` against the same Emscripten, and link
  objects without cross-language LTO.
- If LTO or Rust's prebuilt std turns out to matter, move to an Emscripten on LLVM 22 (5.0.x) and
  drop the clang 21 pin. The owner decides.
- **Threads:** the toy does not use them. LibWeb's StageThread can run inline (engines.md), so
  phase 1 can start without `-pthread`.

## Reproducing

```sh
tools/setup-toolchain.sh        # clones emsdk at the pinned commit and installs 4.0.11
make toolchain-check            # C++23 + libc++ + Wasm EH, both encodings
make                            # toy engine + glue bundle into build/
```

`tools/em.sh` runs any command with the pinned Emscripten on PATH. Builds never need more than
`make -j10`.

## Fallback fonts (docs/fonts.md)

`tools/fallback-fonts.py` (run with `$CHITIN_EXT/venv/bin/python -I`; needs fontTools 4.60.1 and brotli 1.1.0 from PyPI in that venv)
downloads these into `$CHITIN_EXT/fallback-fonts/src`, checks each against `tools/fallback-fonts.sha256`, and cuts them into WOFF2
subsets in `$CHITIN_EXT/fallback-fonts/out` (129 files, 21.2 MiB, plus the 74 KB manifest `fallback.bin`). All are SIL Open Font
License 1.1; the licence texts are kept next to the fonts in both directories (`OFL-notofonts.txt` from
notofonts.github.io `fonts/LICENSE`, `OFL-noto-cjk.txt` from noto-cjk `Sans/LICENSE`, `OFL-noto-emoji.txt` from noto-emoji
`fonts/LICENSE`). Sources, pinned by commit:

- notofonts/notofonts.github.io `957448b6168f09dca2c8005449e9b6f3fd2dd207`: `https://raw.githubusercontent.com/notofonts/notofonts.github.io/<commit>/fonts/<Family>/unhinted/ttf/<Family>-Regular.ttf`
- notofonts/noto-cjk `f8d157532fbfaeda587e826d4cd5b21a49186f7c`: `https://raw.githubusercontent.com/notofonts/noto-cjk/<commit>/Sans/SubsetOTF/<SC|TC|JP|KR>/NotoSans<..>-Regular.otf`
- googlefonts/noto-emoji tag v2.051 = `8998f5dd683424a73e2314a8c1f1e359c19e8742`: `https://raw.githubusercontent.com/googlefonts/noto-emoji/<commit>/fonts/Noto-COLRv1.ttf`

| File | Version | SHA-256 | Subsets |
|---|---|---|---|
| NotoSansArabic-Regular.ttf | Version 2.013 | `bd86ca02f087d7f3c3788ba458fb6b73744c7639ed276b8d870dba6def6c40d0` | 1 |
| NotoSansHebrew-Regular.ttf | Version 3.001 | `04272f5600d0ec816d31d0df73b23aa8d3501ea359ebe820da31c11ffcf00853` | 1 |
| NotoSansSyriac-Regular.ttf | Version 3.000 | `1ec0391c549b5e63e4f8d810b4485a64c5551445bfb2bdbf309ce8368bef9d4c` | 1 |
| NotoSansThaana-Regular.ttf | Version 3.001 | `7543935bdcef770c9d3dd54222651b29040e5ec82f3bc58542392b2c7a9cbd3c` | 1 |
| NotoSansDevanagari-Regular.ttf | Version 2.007 | `9c7d935139ea6a1e6ad9dbac4f6d27ece1e04bca8123c8888d00a0f9df4724cd` | 1 |
| NotoSansBengali-Regular.ttf | Version 3.011 | `5dceda02816fece18ea6796f474f5d3170f1d862f21b1e809cdc94b1caa4b6ec` | 1 |
| NotoSansGurmukhi-Regular.ttf | Version 2.004 | `2454c944fda799d2861f11c03e492c453e33083dd1e8d99bd6baac8de71ad0f0` | 1 |
| NotoSansGujarati-Regular.ttf | Version 2.106 | `18727143b8eadade0a59dca80959ef784bf8d55e07285d1b4096594dbf829f0a` | 1 |
| NotoSansOriya-Regular.ttf | Version 2.007 | `a16645d056017927406546aa78e4ce15e782fd8783467267b75450453d007415` | 1 |
| NotoSansTamil-Regular.ttf | Version 2.004 | `6634d9cc97a726e670df41281dd32b167a6b9b71f2036e19671ff08fdde0c292` | 1 |
| NotoSansTelugu-Regular.ttf | Version 2.005 | `dcb86a5da09365a2d73d725e429403dca988e6d50c1b1d564579a25dbc18bd29` | 1 |
| NotoSansKannada-Regular.ttf | Version 2.006 | `2870274619c2a4abe5d6b11fcb7c4a372eba765b6b7881d459b0eb0a609a68eb` | 1 |
| NotoSansMalayalam-Regular.ttf | Version 2.104 | `cc39bb1f7d63b582a2aec1abf2469a43b805a3523a27e0a0eee8cd32702541d5` | 1 |
| NotoSansSinhala-Regular.ttf | Version 3.000 | `46d5b54952a624e6e3981e0968aecc5464f3b1081131dd7a1fcd42fbf7966471` | 1 |
| NotoSerifTibetan-Regular.ttf | Version 2.103 | `7292b2c76cf5c9b81e5362d88e0cb0a16b9d92827f86f945203014b049fd2fc5` | 1 |
| NotoSansThai-Regular.ttf | Version 2.002 | `d4303fe9c63ebb72759ca8b6d2040c8ae81689f7d08d7b91c656154382b49313` | 1 |
| NotoSansLao-Regular.ttf | Version 2.003 | `d3976b0ac08702c54999ff42eae295d1597fd73b44e0c57d7f4917524e18afbe` | 1 |
| NotoSansKhmer-Regular.ttf | Version 2.004 | `60c10dbfae33a44f1897cd939789bd173aedb7c7dc0a9af389a737e33cb7e548` | 1 |
| NotoSansMyanmar-Regular.ttf | Version 2.107 | `f4be6ef43871516d8347c5217a2033991b8ecda2dd1200007c2fb431a66d64db` | 1 |
| NotoSansGeorgian-Regular.ttf | Version 2.005 | `f4b229b126859725b75031dd8c051335d20c85e4eb6d525af28f3e83e471baa4` | 1 |
| NotoSansArmenian-Regular.ttf | Version 2.008 | `73bde9f3c63aa5ed39236e8a2837224605210a98b54d65724676c0119fcaa24c` | 1 |
| NotoSansEthiopic-Regular.ttf | Version 2.102 | `86b9c07c049e68438388d00a34033fa28cabeef91b26e1bbed67512d360166d4` | 1 |
| NotoSansSC-Regular.otf | Version 2.004 | `faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9` | 34 |
| NotoSansTC-Regular.otf | Version 2.004 | `5bab0cb3c1cf89dde07c4a95a4054b195afbcfe784d69d75c340780712237537` | 25 |
| NotoSansJP-Regular.otf | Version 2.004 | `dff723ba59d57d136764a04b9b2d03205544f7cd785a711442d6d2d085ac5073` | 19 |
| NotoSansKR-Regular.otf | Version 2.004 | `69975a0ac8472717870aefeab0a4d52739308d90856b9955313b2ad5e0148d68` | 24 |
| NotoSansMath-Regular.ttf | Version 3.000 | `b127e84699212b6b2ef50aff58e0ebebeec04ffe6db1b9eb9e209c8c3d97b4aa` | 1 |
| NotoSansSymbols-Regular.ttf | Version 2.003 | `6eea9cb4cd39269ea9f95ba5c2735f80ae74049dfc9e1a7c932a5cfc8f0c3030` | 1 |
| NotoSansSymbols2-Regular.ttf | Version 2.008 | `c4a0a80f0041ce4be81e2478faad22776d23edb98ae3f0d19bd37044820ecf9d` | 1 |
| Noto-COLRv1.ttf | Version 2.051 | `0ae57fe58645638523ba35f388d93739d292539a9acb84df5700c81b1e1a28d2` | 2 |

## nghttp2 (docs/network.md, "HTTP/2")

The engine's HTTP/2 framing and HPACK: nghttp2 **1.69.0**, the version Ladybird's vcpkg.json pins (`"nghttp2": "1.69.0#0"`
at the pinned Ladybird commit). Library only (`-DENABLE_LIB_ONLY=ON`, static), built by `tools/deps/build.sh nghttp2` into
`$CHITIN_EXT/wasm-deps/prefix/lib/libnghttp2.a` (229 KB) and linked into ganglion.wasm (about +90 KB with the code using it).

| | |
|---|---|
| Source | `https://github.com/nghttp2/nghttp2/releases/download/v1.69.0/nghttp2-1.69.0.tar.xz` (tools/deps/sources.txt) |
| SHA-256 | `1fb324b6ec2c56f6bde0658f4139ffd8209fa9e77ce98fd7a5f63af8d0e508ad` |
| Licence | MIT (`COPYING`: Copyright (c) 2012, 2014, 2015, 2016 Tatsuhiro Tsujikawa and nghttp2 contributors) |

## Dependencies

Owner decision 2026-10-22 (supply-chain hardening). The repository has no package-manager dependencies: no
`package.json` at the root, no `node_modules`, nothing installed by npm or pip to build, test or run Chitin.

- **The test browser is driven by our own DevTools client.** `tools/cdp/cdp.mjs` (plain Node 22: `child_process`
  and Chrome's `--remote-debugging-pipe`) launches the existing Chrome for Testing and implements the part of the
  puppeteer-core API the tools used (pages, frames, Workers, targets and sessions with flattened auto-attach,
  evaluate, console and exceptions, input, screenshots, emulation), with puppeteer-core 25.12.0's Chrome flags and
  per-session setup so runs behave as before. `tools/cdp/ws-server.mjs` is the WebSocket server the tests'
  local servers use (it replaced the `ws` package). Neither has a dependency. Worktrees no longer need a
  `node_modules` link to the main checkout; one left over can be deleted.
- **Every third-party code or data item is pinned by SHA-256**, with where it came from and its license, in the
  repository (as `tools/fallback-fonts.sha256` above, `third_party/` with its notices, and CREDITS.md). Nothing is
  fetched unpinned: no floating versions, no `latest`, no install from a registry without a hash.
- **If a package is ever needed**, it is installed only from a committed lockfile with integrity hashes and with
  install scripts off: `npm ci --ignore-scripts`, `pip install --require-hashes -r requirements.txt`. One exception
  stands, outside the build and the tests: rebuilding the vendored framework sites (`make frameworks-build`,
  docs/frameworks.md) runs `npm ci --ignore-scripts` from each app's lockfile (owner decision 2026-10-22); the repository keeps their
  output, never their `node_modules`.
- **Adding any dependency needs the owner's approval first**: code, data, a tool, a font, a model, at build, test
  or run time. Ask with the item, version, source, license and SHA-256.
