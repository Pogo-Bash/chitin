# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 [OWNER NAME]
# Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
#!/bin/sh
# ICU's common data for the engine, trimmed with icupkg (ICU User Guide, "ICU Data": packaging tools) from the
# archive the source tarball ships: the tarball carries no data sources, so the data filter cannot apply, and the
# wasm cross build's libicudata.a is a stub, so the engine loads this file at run time (ganglion_set_icu_data).
# Kept: break iteration (the line and grapheme segmenters LibWeb's text layout uses) with the CJK/Thai/Khmer/Lao/
# Burmese dictionaries, normalization, UTS 46, the emoji and layout property tables, the supplemental and root
# locale data, the root and en locale bundles. Dropped: collation, transliteration, time zones, currencies,
# units, languages/regions names, RBNF, string prep, confusables, character names, the converters (LibTextCodec
# has its own), and every other locale. tools/deps/icu-filter.json is the same selection as an ICU data filter,
# for a build from the data sources.
# Writes $CHITIN_EXT/icu/icudt78l.dat and keeps the untrimmed archive beside it as icudt78l-full.dat.
set -e
: "${CHITIN_EXT:=$HOME/dev/chitin-ext}"
DEPS="${CHITIN_DEPS:-$CHITIN_EXT/wasm-deps}"
SRC="$DEPS/src"; BLD="$DEPS/build"
ICUPKG="$BLD/icu-host/bin/icupkg"
FULL="$SRC/icu-78.3/source/data/in/icudt78l.dat"
mkdir -p "$CHITIN_EXT/icu"
cp "$FULL" "$CHITIN_EXT/icu/icudt78l-full.dat"
cp "$SRC/icu-78.3/LICENSE" "$CHITIN_EXT/icu/LICENSE"
# icupkg reads a list from a file only when its name ends in .txt or .lst (icupkg usage); otherwise the
# argument is taken as item names.
list="$CHITIN_EXT/icu/items.txt"; remove="$CHITIN_EXT/icu/remove.txt"
"$ICUPKG" -l "$FULL" > "$list"
python3 - "$list" "$remove" <<'PY'
import re, sys
items = [l.strip() for l in open(sys.argv[1]) if l.strip()]
def keep(item):
    tree, _, name = item.rpartition('/')
    if tree in ('curr', 'zone', 'region', 'lang', 'unit', 'coll', 'rbnf', 'translit'):
        return False
    if tree == 'brkitr':
        return True
    if name.endswith(('.nrm', '.icu')) and name != 'unames.icu':
        return True
    if name.endswith(('.cnv', '.spp', '.cfu')) or name == 'unames.icu':
        return False
    if name in ('zoneinfo64.res', 'metaZones.res', 'windowsZones.res', 'timezoneTypes.res', 'currencyNumericCodes.res', 'units.res', 'grammaticalFeatures.res', 'langInfo.res'):
        return False
    if name.endswith('.res'):
        locale = name[:-4]
        if re.fullmatch(r'[a-z]{2,3}(_[A-Za-z0-9]+)*', locale):
            return locale == 'root' or locale == 'en' or locale.startswith('en_')
        return True  # supplementalData, likelySubtags, metadata, plurals, pool, icuver, ...
    return True
with open(sys.argv[2], 'w') as out:
    for item in items:
        if not keep(item):
            out.write(item + '\n')
PY
"$ICUPKG" -r "$remove" "$FULL" "$CHITIN_EXT/icu/icudt78l.dat"
rm -f "$list" "$remove"
ls -la "$CHITIN_EXT/icu/"
