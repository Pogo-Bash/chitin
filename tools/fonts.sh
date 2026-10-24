#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (c) 2026 [OWNER NAME]
# Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
#
# Fetches the fonts the harness and the Node tests feed the engine into $CHITIN_EXT/fonts: Noto Sans,
# Noto Serif and Noto Sans Mono (SIL Open Font License 1.1, from the Noto project's releases), and Cousine
# (Regular, Bold, Italic, Bold Italic; Apache License 2.0, Google's Croscore face metric-compatible with
# Courier New, which "Courier New" and "Courier" resolve to: docs/fonts.md). Cousine comes from google/fonts'
# apache/cousine at a pinned commit, the last before upstream replaced it with an OFL release (1.240).
# Each file is pinned by sha256; a mismatch stops the script. Each licence is kept beside the files
# (OFL.txt, Cousine-LICENSE.txt). Chitin ships no fonts of its own in phase 1.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/toolchain.env"
dir="${CHITIN_EXT:-$HOME/dev/chitin-ext}/fonts"
mkdir -p "$dir"
base=https://github.com/notofonts/notofonts.github.io/raw/main/fonts
fetch() { # name path sha256 [base]
    if [ -f "$dir/$1" ] && [ "$(shasum -a 256 "$dir/$1" | cut -c1-64)" = "$3" ]; then return; fi
    echo "fetching $1"
    curl -sSfL -o "$dir/$1" "${4:-$base}/$2"
    sum=$(shasum -a 256 "$dir/$1" | cut -c1-64)
    [ "$sum" = "$3" ] || { echo "$1: sha256 $sum, expected $3" >&2; exit 1; }
}
fetch NotoSans-Regular.ttf     NotoSans/full/ttf/NotoSans-Regular.ttf         f5f552c8c5edb61fe6efb824baf4d4de47b1a8689ab4925ff43f7bd6a4ebece5
fetch NotoSans-Bold.ttf        NotoSans/full/ttf/NotoSans-Bold.ttf            3a08a47daa00cade516425c15c57615aef2fd418ec9811a7b9f465088f92cc05
fetch NotoSans-Italic.ttf      NotoSans/full/ttf/NotoSans-Italic.ttf          126522ae1bb9cd92120287fc47dfc74ef981e73931d93e52c565fb7e09b2d74a
fetch NotoSerif-Regular.ttf    NotoSerif/unhinted/ttf/NotoSerif-Regular.ttf   a15cfbbc1539d707115111d672d590a3d70d4f74b4c0a315956da20ae19a14e1
fetch NotoSerif-Bold.ttf       NotoSerif/unhinted/ttf/NotoSerif-Bold.ttf      24ad531e6b05ddad8c3d89572d2c93eb86a6b74e652ce7ee3c3e171de68e84c3
fetch NotoSansMono-Regular.ttf NotoSansMono/unhinted/ttf/NotoSansMono-Regular.ttf 87f8ce0522a6c99b743ee5fc75b4073cfdd575639119672828b7b9944b65b4f4
cousine=https://github.com/google/fonts/raw/46d8a043641ec6f446cddf39749c0b8d0dc71467/apache/cousine
fetch Cousine-Regular.ttf      Cousine-Regular.ttf    69e1ea59eb770014204e5174f805750f9a793db4a2531e6516b30b7460d470b3 "$cousine"
fetch Cousine-Bold.ttf         Cousine-Bold.ttf       42d14baaf1802f8edf7659346a8574b41c4c78e264eb81cdb0891ca6686354ce "$cousine"
fetch Cousine-Italic.ttf       Cousine-Italic.ttf     9b2b98e5d389fe74968af2abb440ac4b6fcd24e2a1aba5ed895b0337b6b0b5e6 "$cousine"
fetch Cousine-BoldItalic.ttf   Cousine-BoldItalic.ttf ef65b8624e7993977feb9f9ba18f514a1fa9adc4e1c4737c8839574685c188ae "$cousine"
fetch Cousine-LICENSE.txt      LICENSE.txt            cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 "$cousine"
# The licences, kept beside the files.
[ -f "$dir/OFL.txt" ] || curl -sSL -o "$dir/OFL.txt" "$base/NotoSans/OFL.txt"
echo "fonts in $dir"
