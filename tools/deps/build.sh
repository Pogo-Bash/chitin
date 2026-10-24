#!/bin/sh
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 [OWNER NAME]
# Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
# Builds Ganglion's third-party dependencies for wasm32 with the pinned Emscripten (docs/toolchain.md)
# into $CHITIN_EXT/wasm-deps/prefix. Sources come from tools/deps/fetch.sh (and skia.sh for Skia).
#
#   tools/deps/build.sh            # everything not built yet
#   tools/deps/build.sh zlib icu   # just these (rebuilds them)
#
# No -pthread anywhere: the engine runs single-threaded in the segment Worker, and Emscripten's
# pthreads need its JS runtime, which must not sit in the page realm (docs/toolchain.md).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../toolchain.env"
export EMSDK_PYTHON EMSDK_QUIET=1
. "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
DEPS="${CHITIN_DEPS:-$CHITIN_EXT/wasm-deps}"
SRC="$DEPS/src"
BLD="$DEPS/build"
PREFIX="$DEPS/prefix"
JOBS="${JOBS:-8}"
VENV="$CHITIN_EXT/venv/bin"
CMAKE="$VENV/cmake"
NINJA="$VENV/ninja"
mkdir -p "$BLD" "$PREFIX/lib" "$PREFIX/include" "$DEPS/stamps"

export CFLAGS="-O2 -fPIC"
export CXXFLAGS="-O2 -fPIC"

cm() { # cm <name> <srcdir> [cmake args...]
    name=$1 src=$2; shift 2
    rm -rf "$BLD/$name"
    emcmake "$CMAKE" -S "$src" -B "$BLD/$name" -G Ninja -DCMAKE_MAKE_PROGRAM="$NINJA" \
        -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" -DBUILD_SHARED_LIBS=OFF \
        -DCMAKE_PREFIX_PATH="$PREFIX" -DCMAKE_FIND_ROOT_PATH="$PREFIX" \
        -DCMAKE_POLICY_VERSION_MINIMUM=3.5 "$@"
    "$NINJA" -C "$BLD/$name" -j"$JOBS" install
}

b_zlib() { # compiled directly: its CMake makes a shared and a static libz.a under Emscripten
    o="$BLD/zlib"; rm -rf "$o"; mkdir -p "$o"
    [ -f "$SRC/zlib-1.3.1/zconf.h" ] || cp "$SRC/zlib-1.3.1/zconf.h.in" "$SRC/zlib-1.3.1/zconf.h"
    for f in adler32 compress crc32 deflate gzclose gzlib gzread gzwrite infback inffast inflate \
        inftrees trees uncompr zutil; do
        emcc $CFLAGS -DHAVE_UNISTD_H -c "$SRC/zlib-1.3.1/$f.c" -o "$o/$f.o"
    done
    emar rcs "$PREFIX/lib/libz.a" "$o"/*.o
    cp "$SRC/zlib-1.3.1/zlib.h" "$SRC/zlib-1.3.1/zconf.h" "$PREFIX/include/"
}

b_brotli() { cm brotli "$SRC/brotli-1.2.0" -DBROTLI_DISABLE_TESTS=ON -DBROTLI_BUILD_TOOLS=OFF; }

b_woff2() { # decoder only, compiled directly (its CMake wants pkg-config for brotli)
    o="$BLD/woff2"; rm -rf "$o"; mkdir -p "$o"
    for f in table_tags variable_length woff2_common woff2_dec woff2_out; do
        em++ $CXXFLAGS -std=c++11 -I"$SRC/woff2-1.0.2/include" -I"$PREFIX/include" \
            -c "$SRC/woff2-1.0.2/src/$f.cc" -o "$o/$f.o"
    done
    emar rcs "$PREFIX/lib/libwoff2dec.a" "$o"/*.o
    emar rcs "$PREFIX/lib/libwoff2common.a" "$o/table_tags.o" "$o/variable_length.o" "$o/woff2_common.o"
    mkdir -p "$PREFIX/include/woff2"
    cp "$SRC/woff2-1.0.2/include/woff2/"*.h "$PREFIX/include/woff2/"
}

b_libpng() { cm libpng "$SRC/libpng-1.6.58" -DPNG_SHARED=OFF -DPNG_TESTS=OFF -DPNG_TOOLS=OFF \
    -DPNG_HARDWARE_OPTIMIZATIONS=OFF -DZLIB_ROOT="$PREFIX"; }

b_libjpeg() { cm libjpeg "$SRC/libjpeg-turbo-3.2.0" -DENABLE_SHARED=OFF -DWITH_SIMD=OFF \
    -DWITH_TURBOJPEG=ON -DWITH_TOOLS=OFF -DWITH_TESTS=OFF; }

b_libwebp() { cm libwebp "$SRC/libwebp-1.6.0" -DWEBP_BUILD_ANIM_UTILS=OFF -DWEBP_BUILD_CWEBP=OFF \
    -DWEBP_BUILD_DWEBP=OFF -DWEBP_BUILD_GIF2WEBP=OFF -DWEBP_BUILD_IMG2WEBP=OFF -DWEBP_BUILD_VWEBP=OFF \
    -DWEBP_BUILD_WEBPINFO=OFF -DWEBP_BUILD_WEBPMUX=OFF -DWEBP_BUILD_EXTRAS=OFF -DWEBP_BUILD_LIBWEBPMUX=ON \
    -DWEBP_ENABLE_SIMD=OFF -DWEBP_USE_THREAD=OFF; }

b_freetype() { cm freetype "$SRC/freetype-2.13.3" -DFT_DISABLE_HARFBUZZ=ON -DFT_DISABLE_BZIP2=ON \
    -DFT_DISABLE_BROTLI=ON -DFT_REQUIRE_PNG=ON -DFT_REQUIRE_ZLIB=ON -DZLIB_ROOT="$PREFIX"; }

b_harfbuzz() { cm harfbuzz "$SRC/harfbuzz-10.2.0" -DHB_HAVE_FREETYPE=ON -DHB_HAVE_ICU=OFF \
    -DHB_HAVE_GLIB=OFF -DHB_HAVE_GOBJECT=OFF -DHB_BUILD_SUBSET=OFF -DHB_BUILD_UTILS=OFF \
    -DFREETYPE_INCLUDE_DIRS="$PREFIX/include/freetype2" -DFREETYPE_LIBRARY="$PREFIX/lib/libfreetype.a"; }

b_fmt() { cm fmt "$SRC/fmt-12.2.0" -DFMT_TEST=OFF -DFMT_DOC=OFF; }
b_fast_float() { cm fast_float "$SRC/fast_float-8.2.10" -DFASTFLOAT_TEST=OFF; }
b_simdutf() { cm simdutf "$SRC/simdutf-9.1.0" -DSIMDUTF_TESTS=OFF -DSIMDUTF_TOOLS=OFF \
    -DSIMDUTF_BENCHMARKS=OFF -DSIMDUTF_ICONV=OFF; }
b_simdjson() { cm simdjson "$SRC/simdjson-4.6.4" -DSIMDJSON_DEVELOPER_MODE=OFF \
    -DSIMDJSON_ENABLE_THREADS=OFF; }

b_libxml2() { cm libxml2 "$SRC/libxml2-2.15.3" -DLIBXML2_WITH_PYTHON=OFF -DLIBXML2_WITH_LZMA=OFF \
    -DLIBXML2_WITH_ZLIB=OFF -DLIBXML2_WITH_ICONV=OFF -DLIBXML2_WITH_THREADS=OFF \
    -DLIBXML2_WITH_HTTP=OFF -DLIBXML2_WITH_PROGRAMS=OFF -DLIBXML2_WITH_TESTS=OFF -DLIBXML2_WITH_ICU=OFF \
    -DLIBXML2_WITH_MODULES=OFF; }

b_sqlite() {
    o="$BLD/sqlite"; rm -rf "$o"; mkdir -p "$o"
    emcc $CFLAGS -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_ENABLE_FTS5 \
        -c "$SRC/sqlite-3.53.3/sqlite3.c" -o "$o/sqlite3.o"
    emar rcs "$PREFIX/lib/libsqlite3.a" "$o/sqlite3.o"
    cp "$SRC/sqlite-3.53.3/sqlite3.h" "$SRC/sqlite-3.53.3/sqlite3ext.h" "$PREFIX/include/"
}

b_libtommath() { cm libtommath "$SRC/libtommath-1.3.0" -DBUILD_TESTING=OFF; }

b_libpsl() {
    o="$BLD/libpsl"; rm -rf "$o"; cp -R "$SRC/libpsl-0.21.5" "$o"
    (cd "$o" && PYTHON=python3 emconfigure ./configure --host=wasm32-unknown-emscripten \
        --prefix="$PREFIX" --disable-shared --enable-static --disable-runtime --enable-builtin \
        --disable-man --disable-gtk-doc --disable-nls && emmake make -j"$JOBS" -C src install \
        && emmake make -C include install)
}

b_wuffs() {
    mkdir -p "$PREFIX/include/wuffs"
    cp "$SRC/wuffs-0.3.4/wuffs-v0.3.c" "$PREFIX/include/wuffs/"
}

# ICU: a host build first (its tools generate data at build time), then the cross build.
# Data is linked statically for now; docs/phase1.md has the size and the trimming plan.
b_icu() {
    h="$BLD/icu-host"; w="$BLD/icu-wasm"
    rm -rf "$h" "$w"; mkdir -p "$h" "$w"
    # ICU's configure has no platform file for Emscripten; the Linux one fits (ICU readme, "porting").
    cp "$SRC/icu-78.3/source/config/mh-linux" "$SRC/icu-78.3/source/config/mh-unknown"
    (cd "$h" && env -u CFLAGS -u CXXFLAGS CC=clang CXX=clang++ "$SRC/icu-78.3/source/configure" \
        --disable-tests --disable-samples --disable-extras --disable-icuio --disable-layoutex \
        --enable-static --disable-shared && make -j"$JOBS")
    (cd "$w" && emconfigure "$SRC/icu-78.3/source/configure" --host=wasm32-unknown-emscripten \
        --with-cross-build="$h" --prefix="$PREFIX" --enable-static --disable-shared \
        --disable-tests --disable-samples --disable-extras --disable-icuio --disable-layoutex \
        --disable-tools --with-data-packaging=static \
        && emmake make -j"$JOBS" && emmake make install)
    # The cross build's libicudata.a is the 618-byte stub (pkgdata cannot assemble for wasm32), so the
    # engine loads the host build's common data at run time (ganglion_set_icu_data, served beside the fonts).
    mkdir -p "$CHITIN_EXT/icu"
    cp "$h/data/out/tmp/icudt78l.dat" "$CHITIN_EXT/icu/icudt78l.dat"
    cp "$SRC/icu-78.3/LICENSE" "$CHITIN_EXT/icu/LICENSE"
}

# nghttp2 (MIT): the HTTP/2 framing and HPACK library, no socket calls of its own (frames in and out of memory); the
# library only, as Ladybird's vcpkg port builds it (1.69.0 in Ladybird's vcpkg.json).
b_nghttp2() { cm nghttp2 "$SRC/nghttp2-1.69.0" -DENABLE_LIB_ONLY=ON -DBUILD_STATIC_LIBS=ON -DBUILD_SHARED_LIBS=OFF \
    -DENABLE_DOC=OFF -DBUILD_TESTING=OFF -DENABLE_FAILMALLOC=OFF -DWITH_LIBXML2=OFF -DWITH_JEMALLOC=OFF; }

b_openssl() {
    o="$BLD/openssl"; rm -rf "$o"; cp -R "$SRC/openssl-3.6.3" "$o"
    # -D__wasi__: OpenSSL's seed source (providers/.../seeding/rand_unix.c, syscall_random) takes the
    # getentropy() branch only under __wasi__; Emscripten's getentropy() is WASI random_get, which the
    # glue answers with crypto.getRandomValues. Every other branch fails in a module with no files and no
    # dlsym, and then no TLS handshake can start ("error retrieving entropy").
    (cd "$o" && env CC=emcc AR=emar RANLIB=emranlib CFLAGS="$CFLAGS -D__wasi__" ./Configure linux-generic32 \
        no-asm no-threads no-shared no-dso no-engine no-tests no-apps no-ui-console no-afalgeng \
        no-sock no-secure-memory no-async no-docs --prefix="$PREFIX" --libdir=lib \
        && emmake make -j"$JOBS" build_libs && emmake make install_dev)
}

b_skia() { "$here/skia.sh"; }

ALL="zlib brotli nghttp2 woff2 libpng libjpeg libwebp freetype harfbuzz fmt fast_float simdutf simdjson
libxml2 sqlite libtommath libpsl wuffs icu openssl skia"

if [ $# -gt 0 ]; then
    for d in "$@"; do echo "=== $d"; "b_$d"; touch "$DEPS/stamps/$d"; done
else
    for d in $ALL; do
        [ -f "$DEPS/stamps/$d" ] && continue
        echo "=== $d"; "b_$d"; touch "$DEPS/stamps/$d"
    done
fi
echo "deps: done"
