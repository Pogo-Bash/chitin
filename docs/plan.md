# Plan and timeline

Decisions (owner, 2026-10-11):
- Engine: Ladybird's LibWeb, built for wasm32 with LibJS removed from the start
  (docs/research/engines.md). Toolchain: clang 21.
- ES modules: a service worker on the segment's own origin may serve the engine's fetched bytes,
  unmodified, to V8's module loader. It belongs to one site and changes nothing; what Chitin rules out
  is a service worker that rewrites or stands in the middle.
- No hosted relay: the relay ships as a Docker image; whoever runs one is responsible for the traffic
  through it (docs/legal/). Chitin's own defaults stay safe.
- Provenance: the engine carries structural watermarks and behaviour fingerprints so copies can be
  identified; licence: GPL-2.0-or-later, plus a trademark policy (docs/legal/).
- Classic scripts are evaluated with one appended `//# sourceURL=` line, so errors and stack traces
  name the real script. The page never sees it: its own view of the script text and integrity checks
  use the engine's untouched copy.

## Timeline

Calibrated on how this project has actually gone, not on estimates made in advance: the native Qt/KDE
port was estimated at a week and reached the owner's browser in about a day; the full KDE build was
100 packages in about 2.5 hours with its fix-ups; the kernel sound card, ALSA and PulseAudio took
about 80 minutes of agent time; the dynamic-linking prototype about 45 minutes. Earlier estimates
here (2-4 weeks, 8-14 weeks, then 4-6 weeks in total) were the same kind of overestimate.

Time below is elapsed time with agents working and the owner testing in between; the owner's test
rounds are usually the pace-setter.

| Phase | What | Time |
|---|---|---|
| 0 | clang 21 wasm32 toolchain; toy DOM in wasm with V8 bindings in one Worker; the GC anchor scheme; call-cost numbers; a segment on its own origin sending frames to the carapace and getting input back; the module loader | about a day |
| 1 | LibWeb (HTML, CSS, layout, Skia paint) on wasm32 with the LibJS shim; static pages render in a segment; network through a local relay; provenance marks (structural watermarks in the engine wasm, behaviour fingerprints readable from a test page, docs/provenance.md) | 1-2 days |
| 2 | generated bindings from Web IDL; real sites with JavaScript; event loop, forms, cookies, storage; bindings indistinguishable from Chrome's (docs/research/scramjet-lessons.md); a framework matrix (TodoMVC and a starter app each for React, Vue, Svelte, Solid, Astro, Lit, Angular; a Tailwind v4 page) and js-framework-benchmark as the speed scoreboard; import maps | 2-4 days |
| 3 | Spiracle (WebTransport, Wisp) and the relay as a Docker image people run themselves, with safe defaults (port allowlist, no private ranges, rate limits) and an operator disclaimer; Tor mode | 1-2 days |
| 4 | media (WebCodecs, audio), downloads, permissions | 1-2 days |

About 1-2 weeks to a browser people can use. For scale: rvwasm itself (the riscv64 JIT, Debian, KDE
Plasma native and translated, the GPU path, audio) was built with agents in about a week. Chitin is a
separate product and depends on none of it. The items most likely to stretch the schedule: the LibJS
shim (LibJS is used throughout LibWeb's own code), the cross-heap GC leak class, and keeping up with
Ladybird's pace upstream.

## Frameworks and CSS

No framework-specific code: frameworks run on the standard APIs, so they are the test bed and the
speed targets, and every speedup is a general one (hot DOM paths, interned strings, cheaper wrappers,
a fast MessageChannel, custom elements and shadow DOM).

Tailwind-sized CSS (thousands of one-class rules, custom properties, cascade layers, color-mix, oklch,
@property, container queries, :has, nesting) may need work in Ladybird's own CSS engine, both feature
support and selector-matching and style-recalc speed. Order: measure first (a real Tailwind v4 page, in
Ladybird's desktop build and in Chitin, profiled), then fix. Fixes to Ladybird itself go upstream as
pull requests where they are general (BSD-2-Clause), and live in patches/ladybird/ until merged, so
the fork does not drift. Before sending anything upstream, read Ladybird's contribution guidelines,
including any policy on AI-assisted contributions.

Measured 2026-10-22 (docs/frameworks.md, "Tailwind CSS v4 (measured)"): a Tailwind v4 landing page matches Chrome's computed styles and geometry; a page with 2723 rules and 6008 elements
takes about 17 times Chrome's time for a full style and layout (1.0 s against 61 ms), a flat profile with the repeated tokenizing of `var()` values at about 12 %.
