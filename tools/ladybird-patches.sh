#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (c) 2026 [OWNER NAME]
# Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
#
# Chitin's changes to Ladybird are a patch series in patches/ladybird/, on top of the pinned commit
# (tools/ladybird.env). The working copy is a branch `chitin` in $LADYBIRD_SRC.
#
#   tools/ladybird-patches.sh apply    # fresh branch `chitin` at the pin, patches applied with git am
#   tools/ladybird-patches.sh export   # write the branch's commits back to patches/ladybird/
#
# The patches change Ladybird's files, which stay under Ladybird's BSD-2-Clause licence.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/toolchain.env"
. "$here/ladybird.env"
dir="$here/../patches/ladybird"
case "${1:-}" in
apply)
    [ -d "$LADYBIRD_SRC/.git" ] || git clone "$LADYBIRD_REPO" "$LADYBIRD_SRC"
    git -C "$LADYBIRD_SRC" fetch -q origin "$LADYBIRD_COMMIT" 2>/dev/null || true
    # The series is applied in a scratch worktree, and the source tree is then moved to the result with one
    # checkout: git rewrites only the files that differ, so their mtimes (and ninja's incremental build) survive.
    # Resetting the tree to the pin and re-applying every patch in place touched every patched file and rebuilt
    # most of LibWeb each time a patch was added.
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/ladybird-apply.XXXXXX")
    git -C "$LADYBIRD_SRC" worktree add -q --detach "$tmp/wt" "$LADYBIRD_COMMIT"
    for p in "$dir"/*.patch; do [ -e "$p" ] || continue; git -C "$tmp/wt" am -q --keep-cr "$p"; done
    head=$(git -C "$tmp/wt" rev-parse HEAD)
    git -C "$LADYBIRD_SRC" worktree remove --force "$tmp/wt"; rm -rf "$tmp"
    git -C "$LADYBIRD_SRC" checkout -q -B chitin "$head"
    git -C "$LADYBIRD_SRC" log --oneline "$LADYBIRD_COMMIT"..chitin ;;
export)
    rm -f "$dir"/*.patch
    git -C "$LADYBIRD_SRC" format-patch -q --no-signature --zero-commit -o "$dir" "$LADYBIRD_COMMIT"..chitin
    ls "$dir" ;;
*) echo "usage: $0 apply|export" >&2; exit 2 ;;
esac
