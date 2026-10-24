#!/bin/sh
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 [OWNER NAME]
# Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
# Installs the pinned Emscripten (clang 21) outside the repo, in $CHITIN_EXT (default ~/dev/chitin-ext).
set -eu
. "$(dirname "$0")/toolchain.env"
export EMSDK_PYTHON
mkdir -p "$CHITIN_EXT"
if [ ! -d "$EMSDK_DIR/.git" ]; then
    git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
fi
git -C "$EMSDK_DIR" fetch --quiet origin "$EMSDK_COMMIT" || true
git -C "$EMSDK_DIR" checkout --quiet "$EMSDK_COMMIT"
"$EMSDK_DIR/emsdk" install "$EMSCRIPTEN_VERSION"
"$EMSDK_DIR/emsdk" activate "$EMSCRIPTEN_VERSION"
. "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
emcc --version | head -1
"$EMSDK_DIR/upstream/bin/clang" --version | head -1
