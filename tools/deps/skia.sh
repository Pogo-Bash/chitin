#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-only
# Copyright (c) 2026 [OWNER NAME]
# Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
# Skia for wasm32: CPU raster only (no Ganesh/Graphite yet), FreeType with the "custom empty" font
# manager (LibGfx hands it font bytes), no codecs (LibGfx and the host decode images), no shaper
# (LibGfx shapes with HarfBuzz). Branch chrome/m148, the version Ladybird's vcpkg.json pins.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../toolchain.env"
export EMSDK_PYTHON EMSDK_QUIET=1
. "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
DEPS="${CHITIN_DEPS:-$CHITIN_EXT/wasm-deps}"
SKIA="$DEPS/src/skia-m148"
OUT="$DEPS/build/skia"
PREFIX="$DEPS/prefix"
JOBS="${JOBS:-8}"
SKIA_COMMIT=13ffba253fc7854fd3b34f67c82dfb2418dc2944

if [ ! -d "$SKIA" ]; then
    git clone -q --depth 1 --branch chrome/m148 https://skia.googlesource.com/skia "$SKIA"
fi
test "$(git -C "$SKIA" rev-parse HEAD)" = "$SKIA_COMMIT" || { echo "skia: unexpected commit" >&2; exit 1; }
[ -x "$SKIA/bin/gn" ] || (cd "$SKIA" && "$EMSDK_PYTHON" bin/fetch-gn)

# Skia's gn activates an emsdk of its own (4.0.7) before every build; ours is already active.
printf '#!/usr/bin/env python3\n# Chitin: the pinned emsdk is used instead (tools/deps/skia.sh)\nimport sys\nsys.exit(0)\n' > "$SKIA/bin/activate-emsdk"

# Skia's non-CanvasKit wasm config adds -pthread; Ganglion is single-threaded (tools/deps/build.sh).
sed -i '' 's/^        "-pthread",$/        # "-pthread", (removed for Chitin)/' "$SKIA/gn/skia/BUILD.gn"

# -msimd128 -msse2: Skia's raster pipeline (src/opts/SkRasterPipeline_opts.h) has lane types for SSE2/AVX,
# NEON and LoongArch only; on any other target it compiles scalar stages with no lowp pipeline, which is
# 16 ms for an 800x600 frame of fill rects and text (docs/phase1.md). With -msse2, __SSE2__ selects the
# SSE2 lanes (SK_CPU_X64_LEVEL) and Emscripten's SSE compatibility headers (system/include/compat/
# emmintrin.h, "Porting SIMD code") map the intrinsics onto wasm SIMD; SkVx takes the same route.
# The levels up to SSE4.1 are on (Emscripten's immintrin.h includes each level's header only when its
# -m flag is), so the pipeline is SKRP_CPU_SSE41: 4-wide lanes, one v128 each. Not AVX: Emscripten has
# no avx2intrin.h/avx512 and its AVX ones are pairs of v128.
# skcms.cc includes smmintrin.h, avxintrin.h, avx2intrin.h and the AVX-512 headers directly under
# __clang__ (for its run-time dispatch, which is cpuid-gated and dead on wasm); only the ones whose level
# is on exist under Emscripten, so that block is skipped there.
if ! grep -q 'Chitin' "$SKIA/modules/skcms/skcms.cc"; then
    sed -i '' 's/^    #if defined(__clang__)$/    #if defined(__clang__) \&\& !defined(__EMSCRIPTEN__) \/\/ Chitin: compat headers only (tools\/deps\/skia.sh)/' "$SKIA/modules/skcms/skcms.cc"
fi
grep -q 'Chitin' "$SKIA/modules/skcms/skcms.cc" || { echo "skia: skcms.cc patch did not apply" >&2; exit 1; }
"$SKIA/bin/gn" gen "$OUT" --root="$SKIA" --args="
  is_official_build=true is_debug=false is_component_build=false
  target_cpu=\"wasm\" skia_emsdk_dir=\"$EMSDK_DIR\"
  skia_enable_ganesh=false skia_enable_graphite=false skia_use_gl=false skia_use_webgl=false
  skia_use_vulkan=false skia_use_dawn=false skia_use_webgpu=false skia_use_angle=false
  skia_use_freetype=true skia_use_system_freetype2=true
  skia_system_freetype2_include_path=\"$PREFIX/include/freetype2\"
  skia_use_freetype_woff2=false skia_use_freetype_svg=false
  skia_enable_fontmgr_custom_empty=true skia_enable_fontmgr_custom_directory=false
  skia_enable_fontmgr_custom_embedded=false skia_enable_fontmgr_empty=false
  skia_use_fontconfig=false skia_use_expat=false
  skia_use_harfbuzz=false skia_use_icu=false skia_enable_skshaper=false
  skia_enable_skparagraph=false skia_enable_skunicode=false
  skia_use_libjpeg_turbo_decode=false skia_use_libjpeg_turbo_encode=false skia_use_no_jpeg_encode=true
  skia_use_libpng_decode=false skia_use_libpng_encode=false skia_use_no_png_encode=true
  skia_use_libwebp_decode=false skia_use_libwebp_encode=false skia_use_no_webp_encode=true
  skia_use_wuffs=false skia_use_zlib=false skia_enable_pdf=false skia_use_dng_sdk=false
  skia_use_piex=false skia_use_lua=false skia_use_libavif=false skia_use_libjxl_decode=false
  skia_use_xps=false skia_enable_svg=false skia_enable_skottie=false skia_enable_tools=false
  extra_cflags=[\"-O3\", \"-msimd128\", \"-msse\", \"-msse2\", \"-msse3\", \"-mssse3\", \"-msse4.1\", \"-fno-exceptions\"]
"
"$CHITIN_EXT/venv/bin/ninja" -C "$OUT" -j"$JOBS" skia
mkdir -p "$PREFIX/lib" "$PREFIX/include/skia"
cp "$OUT"/libskia.* "$PREFIX/lib/" 2>/dev/null || true
# Skia's component leaves pathops (Op(), SkOpBuilder) out unless PDF/XPS pulls it in; LibWeb's clipping
# needs it, so the source set is built on its own and archived beside libskia.
"$CHITIN_EXT/venv/bin/ninja" -C "$OUT" pathops
(cd "$OUT/obj/src/pathops" && emar rcs "$PREFIX/lib/libskia_pathops.a" *.o)
ls "$OUT" | grep -i 'libskia' || true
rm -rf "$PREFIX/include/skia"
mkdir -p "$PREFIX/include/skia"
cp -R "$SKIA/include/." "$PREFIX/include/skia/"
# Ladybird includes a few headers from outside include/ (modules/skcms, src/...): keep the tree
# reachable for them.
ln -sfn "$SKIA" "$PREFIX/include/skia-src"
echo "skia: done"
