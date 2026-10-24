# CSSOM serialization: Chitin against Chrome

Status: 2026-10-22, parity pass group C (items from Ladybird's web-compat checklist #226). Pages read CSS back through the
CSSOM (`style.cssText`, `getPropertyValue`, the `style` attribute, `CSSRule.cssText`, `getComputedStyle`, `CSS.supports`)
and compare or parse the text; a different spelling breaks frameworks and tells a fingerprinting script "not Chrome".

## The measurement

`make cssom-diff` loads `harness/sites/cssom.example` in Chrome for Testing 154 (top-level window) and in a Chitin segment,
with the same bytes (the surface-diff environment, `tools/surface-diff/env.mjs`). `gen.js` sets about 1,800 property/value
pairs (lengths, numbers, calc(), colors in every syntax, shorthands, SVG presentation properties, custom properties and
var()) and reads each one back nine ways: `CSS.supports`, `getPropertyValue`, `cssText`, the `style` attribute, computed,
`!important`, a rule's `cssText`, the rule's `getPropertyValue`, and the attribute set as text. It also reads longhands
from shorthands and shorthands from longhands, about 50 at-rules (`@media`, `@supports`, `@keyframes`, `@font-face`,
`@container`, `@layer`, `@page`, `@property`, `@scope`, nesting, selectors) through `insertRule` and a parsed `<style>`,
url() resolution against the sheet, and computed values. The page origin is written as ORIGIN so the two hosts compare.

`tools/cssom-diff/run.mjs` compares the two result maps, clusters differences by shape (numbers become N) and ranks them:
`docs/results/cssom-diff-<date>.json`; `--rediff` recompares the last run without a browser.

## Results

| | compared | differ |
|---|---:|---:|
| before (main, 2026-10-22) | 14,129 | 1,188 |
| after patch 0042 | 14,129 | 551 |

Fixed (Ladybird patch 0042):

- **Numbers: six significant digits**, as in Chrome (`1.23456789px` is `1.23457px`, `calc(100% / 3)` is
  `calc(33.3333%)`); Ladybird kept six decimals. CSSOM says "not more than 6 decimals"; WPT accepts both, sites see
  Chrome's. Not upstreamable as is.
- **`lighting-color`** existed nowhere (316 differences: every door returned empty, `CSS.supports` false).
- `@keyframes` rule text one keyframe per line; empty `@supports` block `{\n}`.
- `@page { margin: 1cm }` serialized `margin: 1cm` four times (the expanded descriptors kept the shorthand's name); now
  `margin: 1cm`.
- `font-family`: `"Arial"` reads back `Arial`, `Times New Roman` reads back `"Times New Roman"` (also in `@font-face`).

Left (largest first, from `docs/results/cssom-diff-2026-10-22.json`):

- System colors (`canvastext`, `Canvas`, `initial` color) compute to dark-scheme values in Chitin (rgb(235,235,235) text):
  the engine's preferred color scheme is dark while headless Chrome is light. Environment, not serialization; check what
  the segment reports for `prefers-color-scheme`.
- `color-mix(in oklch, red, blue 30%)` keeps one percentage (Chrome writes both); oklch results differ in the 5th digit.
- Missing properties/values: `font: menu|caption`, `marker-*`, `r`, `offset`, `overscroll-behavior`, `text-emphasis`,
  `width: stretch|-webkit-fill-available` (Chitin accepts `fit-content(10px)` for width, Chrome does not).
- Computed `fill`/`stroke`/`accent-color: currentcolor` stays `currentcolor` (Chrome resolves to rgb()).
- Computed url() is not made absolute against the sheet (`url("img.png")`, Chrome `url("https://host/img.png")`):
  the Rust image value keeps `should_absolutize_url_for_computed_value` false even after the C++ facade sets it.
- Computed shorthands (`background`, `border`, `outline`, `list-style`, `grid`, `flex-flow`, `text-decoration`) are
  shortest-form in Chitin and Chrome's legacy long forms in Chrome; longhands set by `background:` read `initial` in
  Chrome. Chrome-specific, low value.
- Computed lengths on margins/padding print LibWeb's 1/64 px fixed point (`1.23438px`, Chrome `1.23457px`).
- `@-webkit-keyframes` loses its prefix in cssText; `@starting-style` and `*|a` in `insertRule` throw SyntaxError;
  media query units are not lower-cased (`100PX`); type selectors are not lower-cased in `selectorText`.
- **`insertRule('@import ...')` stops the engine**: a trap (null function) in
  `relevant_window_or_worker_global_scope` under `StyleSheetImport::set_parent_style_sheet` /
  `Document::relevant_settings_object`. The generator leaves `@import` out until that is fixed.

## WPT

`make wpt DIRS=css/cssom CAP=120` (`/css/cssom/` added to the sparse WPT checkout; `WPT_BASE_PORT` moves wptserve off
8460 when another run holds it). 120 files: Chrome 1440/1455; Chitin 1230/1438 before, 1228/1438 after (the two changes are mutation-record tests that timed out under load, NOTRUN, nothing serialization-related; the evenly-picked 120 of 310 files include few serialization tests).
