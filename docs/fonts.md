# Fonts

<!-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
     Copyright (c) 2026 [OWNER NAME]
     Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL]) -->

## Base faces (loaded at start)

Noto Sans (Regular, Bold, Italic), Noto Serif (Regular, Bold), Noto Sans Mono and Cousine (four faces), fetched by tools/fonts.sh, served at
`/chitin/fonts/` and handed to the engine before `start()`. The generic families map as in Chrome on Linux with the Noto
set: `serif` is Noto Serif, `sans-serif` Noto Sans, `monospace` Noto Sans Mono; `cursive`, `fantasy`, `system-ui` and
`ui-*` resolve to sans-serif (engine/platform/Fonts.cpp `resolve_generic_family`).

### Metric-compatible aliases

Cousine (Regular, Bold, Italic, Bold Italic; Apache-2.0, Google's Croscore face with Courier New's advances and vertical
metrics) is loaded with the base faces but reached only by name: `"Courier New"` and `Courier` resolve to it when no face
of that name is installed, as fontconfig's 30-metric-aliases.conf does for Chrome on Linux (engine/platform/Fonts.cpp
`metric_alias`). Names match ASCII case-insensitively, as in Chrome; an identifier like `courier-new` is another name and
matches nothing in either. Cousine is not a system-fallback face. `monospace` stays Noto Sans Mono (Chrome on Linux's
answer; on macOS Chrome uses Menlo).

Measured against Chrome for Testing 154 on macOS (harness/sites/monofont.example, five lines of 48 characters at 16 px):
the terminal stack `courier-new, courier, monospace` draws in Courier there, 460.875 x 90 (18 px a line); Chitin drew it
in Noto Sans Mono, 460.5 x 110, and now in Cousine, the same box as Chrome. `"Courier New"` was proportional Noto Sans
(340.1 wide); now 460.875 x 90 like Chrome's Courier New. Checked by tests/fonts-alias.test.mjs and the chrome-test fonts
group.

## System fallback (loaded on first need)

When no font in an element's cascade has a glyph for a code point, LibWeb asks the system font provider
(FontCascadeList's system fallback, `Gfx::FontDatabase::get_font_for_code_point`). Chitin's provider answers:

1. one of the base faces, if it has the glyph (this is how a page font without U+2026 gets an ellipsis, as Chrome finds one
   in the system's fonts), unless the text asks for emoji presentation;
2. otherwise a fallback subset that covers the code point, in this order: Arabic, Hebrew, Syriac, Thaana, the Indic
   scripts, Tibetan, Thai, Lao, Khmer, Myanmar, Georgian, Armenian, Ethiopic, CJK, Math, Symbols, Symbols 2, emoji
   (emoji first when the text has emoji presentation). The emoji font is Noto Color Emoji's COLRv1 build, which LibGfx
   (Skia) draws in colour.
3. CJK: kana take the Japanese face and Hangul the Korean one whatever the language; Han ideographs and shared
   punctuation take the face for the top-level document's `lang` (`zh-Hans`/`zh-CN` Simplified, `zh-Hant`/`zh-TW`/`zh-HK`
   Traditional, `ja`, `ko`), then the host's `navigator.languages`, then Simplified Chinese.

If the subset is not loaded yet, the engine asks the host for it once (`ganglion_host_load_fallback_font`) and answers no
font, so the text shows boxes until it arrives. On arrival (`ganglion_add_fallback_font`) the fallback cache is cleared and
every document re-resolves its font cascades and builds layout again (Ladybird patch 0036), as after a web font load.

The subsets are cut by tools/fallback-fonts.py from the Noto fonts listed in docs/toolchain.md ("Fallback fonts"): one
WOFF2 per script font (shaping tables kept), the CJK fonts in about 25 pieces each (punctuation, kana, jamo and fullwidth
forms in one; the everyday characters of GB 2312 level 1, Big5 level 1, JIS X 0208 level 1 or KS X 1001 Hangul next, 500
per piece; the rest by code point, 1000 per piece), emoji in two (flags apart). Only code points the base faces lack are
cut.

### What it costs

- Cold start: the manifest, `fallback.bin`, 74 KB (fetched with the base fonts). The base fonts and the engine are
  unchanged.
- On first need: one subset per script; for example Thai 8 KB, Arabic 43 KB, a CJK piece 22-401 KB, emoji 1.0 MB (+0.7 MB
  for flags). All 129 subsets together are 21.2 MiB. A page in one language loads a few.
- The segment keeps fetched subsets in its origin's Cache Storage (`chitin-fallback-fonts-1`), so a later visit does not
  fetch them again; the server sends them `immutable`.

### Limits

- The CJK choice by language reads the top-level document's root `lang`, not each element's (a `lang="ja"` span in a
  `lang="zh"` page gets Simplified Chinese Han forms; its kana are still Japanese).
- Fallback faces are Regular only; bold text in a fallback script is not emboldened.
- Fallback faces are not reachable by name from `font-family`.

## Files

- engine/platform/Fonts.cpp, Fonts.h: the provider (base faces, manifest, subsets, the fallback order).
- engine/platform/Host.cpp: `ganglion_set_fallback_fonts`, `ganglion_add_fallback_font`, `ganglion_fallback_font_counts`.
- glue/engine/30-host.js: `setFallbackFonts(manifest, languages, loader)`, `addFallbackFont`, `fallbackFontCounts`.
- harness/segment/worker.js: the loader (Cache Storage, then `/chitin/fallback/<file>`); harness/server.mjs serves them.
- Tests: tests/fallback-fonts.test.mjs (one subset per missing run, loaded once; layout uses it); chrome-test group
  "fonts" (scripts.example in Chrome and Chitin, run widths within 0.6x..1.6x of Chrome's).

## Manifest layout (`fallback.bin`)

`CHFB`, u32 version (1), u32 family count; per family: u8 flags (1 emoji, 2 CJK), varint-length family name,
varint-length lang tag, varint subset count; per subset: varint-length file name, varint byte size, varint run count,
then runs as (start minus the previous run's end, length) varint pairs. Varints are LEB128.
