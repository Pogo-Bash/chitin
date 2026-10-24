#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (c) 2026 [OWNER NAME]
# Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
#
# Configures and builds Ladybird's libraries for wasm32 (Ganglion's engine half) with Ladybird's own
# CMake and our hooks (engine/cmake/ladybird-embedder.cmake). Output: $CHITIN_EXT/build/ganglion.
#
#   tools/ganglion-build.sh configure
#   tools/ganglion-build.sh build [ninja targets...]     # default: LibWeb
#
# Jobs: JOBS (default 6; never more than 10 on the shared Mac). Rust's std is rebuilt for our
# Emscripten (-Zbuild-std, RUSTC_BOOTSTRAP on the pinned stable toolchain; docs/toolchain.md).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
. "$here/toolchain.env"
. "$here/ladybird.env"
export EMSDK_PYTHON EMSDK_QUIET=1 CHITIN_EXT LADYBIRD_SRC
. "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
B="${GANGLION_BUILD:-$CHITIN_EXT/build/ganglion}"
JOBS="${JOBS:-6}"
[ "$JOBS" -le 10 ] || JOBS=10
DEPS="$CHITIN_EXT/wasm-deps"
export PATH="$CHITIN_EXT/venv/bin:$PATH"
export RUSTC_BOOTSTRAP=1 CARGO_UNSTABLE_BUILD_STD=std,panic_abort
export RUSTUP_TOOLCHAIN="$RUST_TOOLCHAIN"

case "${1:-build}" in
configure)
    mkdir -p "$B/libjs-runtime"
    (cd "$here/libjs-abi" && cargo run -q --release -- "$LADYBIRD_SRC" "$B/libjs-runtime")
    emcmake cmake -S "$LADYBIRD_SRC" -B "$B" -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DLADYBIRD_EMBEDDER_CMAKE="$root/engine/cmake/ladybird-embedder.cmake" \
        -DLADYBIRD_LIBRARIES_ONLY=ON \
        -DCHITIN_DEPS_PREFIX="$DEPS/prefix" \
        -DCHITIN_ANGLE_INCLUDE="$DEPS/src/angle-include-chromium_7258" \
        -DCHITIN_LIBJS_RUNTIME_INCLUDE="$B/libjs-runtime" \
        -DENABLE_GUI_TARGETS=ON \
        -DLADYBIRD_CACHE_DIR="$CHITIN_EXT/ladybird-caches" ;;
build)
    shift || true
    ninja -C "$B" -j"$JOBS" "${@:-LibWeb}" ;;
*) echo "usage: $0 configure|build [targets]" >&2; exit 2 ;;
esac
