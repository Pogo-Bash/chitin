#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (c) 2026 [OWNER NAME]
# Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
# Downloads the third-party archives listed in tools/deps/sources.txt into $CHITIN_EXT/wasm-deps/dl,
# checks them against the recorded sha256 (recording it on first download), and unpacks each into
# $CHITIN_EXT/wasm-deps/src/<name>-<version>.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../toolchain.env"
DEPS="${CHITIN_DEPS:-$CHITIN_EXT/wasm-deps}"
mkdir -p "$DEPS/dl" "$DEPS/src"
list="$here/sources.txt"
tmp="$list.tmp"
: > "$tmp"
while IFS= read -r line; do
    case "$line" in ''|'#'*) printf '%s\n' "$line" >> "$tmp"; continue ;; esac
    set -- $line
    name=$1 version=$2 url=$3 want=${4:-}
    file="$DEPS/dl/$(basename "$url")"
    if [ ! -f "$file" ]; then
        echo "fetch $name $version"
        curl -fsSL --retry 3 -o "$file.part" "$url"
        mv "$file.part" "$file"
    fi
    got=$(shasum -a 256 "$file" | cut -d' ' -f1)
    # "-": the host regenerates the archive on every request (gitiles +archive), so its bytes are not
    # stable; the URL pins a commit instead.
    [ "$want" = "-" ] && got="-"
    if [ -n "$want" ] && [ "$want" != "$got" ]; then
        echo "sha256 mismatch for $name: want $want got $got" >&2
        exit 1
    fi
    printf '%-13s %-7s %s %s\n' "$name" "$version" "$url" "$got" >> "$tmp"
    dest="$DEPS/src/$name-$version"
    if [ ! -d "$dest" ]; then
        mkdir -p "$dest.part"
        case "$file" in
            *.tar.gz|*.tgz) tar -xzf "$file" -C "$dest.part" ;;
            *.tar.xz) tar -xJf "$file" -C "$dest.part" ;;
            *.zip) (cd "$dest.part" && unzip -q "$file") ;;
            *) cp "$file" "$dest.part/" ;;
        esac
        # Strip a single top-level directory.
        n=$(ls -A "$dest.part" | wc -l | tr -d ' ')
        if [ "$n" = 1 ] && [ -d "$dest.part/$(ls -A "$dest.part")" ]; then
            mv "$dest.part/$(ls -A "$dest.part")" "$dest"
            rmdir "$dest.part"
        else
            mv "$dest.part" "$dest"
        fi
    fi
done < "$list"
mv "$tmp" "$list"
