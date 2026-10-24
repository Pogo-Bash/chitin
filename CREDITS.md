# Credits

Chitin stands on other people's work. This file lists it, and the browser shows the same list on an
about:credits page with every licence text, as the licences require.

## The engine

If Ganglion is built on Ladybird (the engine choice is being researched: docs/research/engines.md),
most of what renders a page is theirs: years of work by the Ladybird Browser Initiative and hundreds
of contributors, going back to SerenityOS's LibWeb. Chitin's part is the shell around it: the sandbox
per site, the bindings to the host's JavaScript engine, the network layer and the port to wasm.

How we treat it:
- Credited in the README, in the browser's about page, and wherever Chitin is presented.
- Its licence (BSD-2-Clause) kept: copyright notices in our source and in every build we ship.
- Our changes kept as a clear patch series on top of upstream, offered back where they are useful to
  Ladybird itself.
- A link to support their work (they are a non-profit funded by donations).
- No use of their name or logo that suggests they endorse Chitin.

If Servo is chosen instead, the same applies (Servo is MPL-2.0: changed files stay MPL and public).

## Also built on

In use since phase 0:

- **Ladybird's Web IDL parser** (`Meta/Utils/webidl_parser.py` and `Meta/Utils/lexer.py`, BSD-2-Clause,
  copyright the Ladybird developers), vendored unmodified in `third_party/ladybird/` with its
  licence. Chitin's binding generator (`bindings/generate.py`) is built on it, and the toy IDL in
  `toy/idl/` is a subset of Ladybird's IDL files.
- **Emscripten** (MIT / University of Illinois NCSA) and **LLVM** (Apache-2.0 with LLVM exceptions),
  the toolchain (docs/toolchain.md). Not shipped as code, apart from the parts of libc++ and the C
  library linked into the engine, under their own licences.
- The glue's hardening follows the pattern of **Node.js's primordials**
  (`lib/internal/per_context/primordials.js`, MIT); no code is copied.

In use since phase 1 (the engine's dependencies, built for wasm32 by tools/deps; versions in
tools/deps/sources.txt): Skia (BSD-3-Clause), HarfBuzz (MIT-like "Old MIT"), FreeType (FTL),
ICU (Unicode-3.0), libpng, libjpeg-turbo, libwebp, woff2, brotli, zlib, libxml2, SQLite, fmt,
simdutf, simdjson, fast_float, libpsl, libtommath, wuffs, OpenSSL (Apache-2.0), each under its own
licence, as static libraries linked into `ganglion.wasm`.

In use since the network work (docs/network.md):

- **OpenSSL 3.6** (Apache-2.0) is the engine's TLS: a client over memory BIOs inside the wasm module.
- **zlib** (zlib licence) and **brotli** (MIT) decode compressed responses.
- **Mozilla's CA certificate bundle**, as extracted and published by the curl project
  (https://curl.se/docs/caextract.html, MPL-2.0), is the engine's trust store, fetched by
  tools/ca-bundle.sh and served beside the engine, not modified.
- **Wisp** (MercuryWorkshop/wisp-protocol, the protocol specification) is what the relay and Spiracle
  speak; both are written here from the specification, no code is copied. The operational shape of
  the relay follows rvwasm's tools/net-relay.py (the same author).

Planned:

To be filled in as components are adopted, each with its licence: the Tor client (Arti via
ethereum/tor-js) and the rest.

In use since M4 (cookies): the **Public Suffix List** (`third_party/psl/public_suffix_list.dat`, Mozilla Public License 2.0,
publicsuffix.org; the copy libpsl 0.21.5 ships, so the glue's sites agree with the engine's libpsl), compiled into the glue
and the carapace by tools/psl-gen.py.
