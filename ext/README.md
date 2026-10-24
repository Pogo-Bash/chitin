# Runtime files

Files the harness serves to the engine at run time. They are third-party data under their own licences.

| Path | What | Licence |
|---|---|---|
| `icu/icudt78l.dat` | ICU 78.3 common data | Unicode License v3 (`icu/LICENSE`) |
| `ca/cacert.pem` | Mozilla's CA certificate bundle (via curl's cacert.pem) | MPL-2.0 |
| `fonts/Noto*` | Noto Sans, Serif, Sans Mono | SIL Open Font License 1.1 (`fonts/OFL.txt`) |
| `fonts/Cousine*` | Cousine (Croscore), metric-compatible with Courier New | Apache-2.0 (`fonts/Cousine-LICENSE.txt`) |
| `fallback-fonts/out/` | Noto fallback subsets cut by `tools/fallback-fonts.py` | SIL Open Font License 1.1; sources in `fallback-fonts/sources.tsv` |

`tools/fonts.sh`, `tools/ca-bundle.sh` and `tools/fallback-fonts.py` regenerate them (pinned by sha256).
