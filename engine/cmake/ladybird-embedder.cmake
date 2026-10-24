# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 [OWNER NAME]
# Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
#
# Ganglion's hooks into Ladybird's CMake (patches/ladybird/0001): Ladybird's libraries are configured
# for wasm32-unknown-emscripten with the dependencies from tools/deps (prefix CHITIN_DEPS_PREFIX), no
# vcpkg and no pkg-config. Ladybird's own CMake still builds every library, runs its Python code
# generators and its Rust crates; this file only says where the dependencies are and trims what a
# segment Worker cannot have.

get_filename_component(CHITIN_ENGINE_DIR "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)
set(CHITIN_DEPS_PREFIX "$ENV{CHITIN_EXT}/wasm-deps/prefix" CACHE PATH "Prefix of Ganglion's wasm32 dependency builds")
set(CHITIN_ANGLE_INCLUDE "" CACHE PATH "ANGLE's include directory (GLES headers for WebGL constants)")
set(CHITIN_LIBJS_RUNTIME_INCLUDE "" CACHE PATH "Directory holding LibJS/Embedding/ABI.h and Layout.h for Ganglion's LibJS runtime")

# LINKER: options reach emcc as -Wl,a,b (one argument), not -Xlinker a -Xlinker b: emcc takes a lone
# "-Xlinker -u" and then the next word as an input file.
set(CMAKE_C_LINKER_WRAPPER_FLAG "-Wl,")
set(CMAKE_C_LINKER_WRAPPER_FLAG_SEP ",")
set(CMAKE_CXX_LINKER_WRAPPER_FLAG "-Wl,")
set(CMAKE_CXX_LINKER_WRAPPER_FLAG_SEP ",")

# Static libraries everywhere; nothing in the engine is a shared object.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(ENABLE_CRANELIFT_JIT OFF CACHE BOOL "" FORCE)
set(ENABLE_JS_JIT OFF CACHE BOOL "" FORCE)
set(ENABLE_LTO_FOR_RELEASE OFF CACHE BOOL "" FORCE)
set(ENABLE_LAGOM_CCACHE OFF CACHE BOOL "" FORCE)
set(ENABLE_INSTALL_HEADERS OFF CACHE BOOL "" FORCE)
set(LADYBIRD_ENABLE_CPPTRACE OFF CACHE BOOL "" FORCE)
set(RUST_TARGET_TRIPLE "wasm32-unknown-emscripten" CACHE INTERNAL "Rust target triple")

# wasm32 has a 32-bit size_t. Ladybird is written for 64-bit targets, so narrowing u64 -> size_t in
# braced initializers and "size_t > i64 max" range checks appear throughout. They are harmless where
# no object can exceed linear memory, so they are not errors in this build (docs/phase1.md lists the
# few real 64-bit assumptions that were patched instead).
# The -Wno- flags are per target (ladybird_embedder_adjust_targets): CMake de-duplicates compile options,
# so a directory-level copy would make the target-level one vanish, and only the target-level one comes
# after Ladybird's -Wall.
add_compile_options(
    # Wasm tail calls (Chrome 112+, Node 20+): LibWasm's interpreter dispatches with musttail.
    $<$<COMPILE_LANGUAGE:C,CXX>:-mtail-call>
    # But only musttail: LLVM 21's wasm backend miscompiles an ordinary sibling call that forwards a
    # by-value struct. It copies the struct into the caller's frame, pops the frame, then return_calls
    # with a pointer into the popped region, which the callee's prologue overwrites (seen as every
    # font-size reaching FontResolution.cpp as 0; docs/phase1.md). No sibling-call optimisation, so a
    # return_call only appears where the source demands one.
    $<$<COMPILE_LANGUAGE:C,CXX>:-fno-optimize-sibling-calls>)

# There is no pkg-config for the wasm32 sysroot. The few modules Ladybird still looks up with it
# outside check_for_dependencies (PulseAudio in audio.cmake) are reported as not found.
macro(pkg_check_modules prefix)
    set(${prefix}_FOUND FALSE)
endmacro()

function(_chitin_imported name)
    cmake_parse_arguments(PARSE_ARGV 1 ARG "" "" "LIBS;INCLUDES;DEPS")
    if (TARGET ${name})
        return()
    endif()
    add_library(${name} INTERFACE IMPORTED GLOBAL)
    set(libs "")
    foreach(lib IN LISTS ARG_LIBS)
        list(APPEND libs "${CHITIN_DEPS_PREFIX}/lib/${lib}")
    endforeach()
    set(includes "${CHITIN_DEPS_PREFIX}/include")
    foreach(dir IN LISTS ARG_INCLUDES)
        list(APPEND includes "${dir}")
    endforeach()
    set_target_properties(${name} PROPERTIES
        INTERFACE_LINK_LIBRARIES "${libs};${ARG_DEPS}"
        INTERFACE_INCLUDE_DIRECTORIES "${includes}")
endfunction()

function(ladybird_embedder_find_dependencies)
    set(P "${CHITIN_DEPS_PREFIX}")

    # AK
    _chitin_imported(FastFloat::fast_float)
    _chitin_imported(fmt::fmt LIBS libfmt.a)
    _chitin_imported(simdutf::simdutf LIBS libsimdutf.a)
    _chitin_imported(mimalloc) # AK uses the system allocator on Emscripten (patches/ladybird)

    # Compression, text, data
    _chitin_imported(ZLIB::ZLIB LIBS libz.a)
    _chitin_imported(_chitin_brotli LIBS libbrotlidec.a libbrotlienc.a libbrotlicommon.a)
    set(BROTLI_TARGETS _chitin_brotli PARENT_SCOPE)
    _chitin_imported(ICU::uc LIBS libicuuc.a)
    _chitin_imported(ICU::i18n LIBS libicui18n.a)
    _chitin_imported(ICU::data LIBS libicudata.a)
    _chitin_imported(LibXml2::LibXml2 LIBS libxml2.a INCLUDES "${P}/include/libxml2")
    _chitin_imported(simdjson::simdjson LIBS libsimdjson.a)
    _chitin_imported(SQLite3::SQLite3 LIBS libsqlite3.a)
    _chitin_imported(PkgConfig::LIBPSL LIBS libpsl.a)
    _chitin_imported(PkgConfig::libtommath LIBS libtommath.a)
    _chitin_imported(OpenSSL::Crypto LIBS libcrypto.a)
    _chitin_imported(OpenSSL::SSL LIBS libssl.a DEPS OpenSSL::Crypto)
    _chitin_imported(_chitin_nghttp2 LIBS libnghttp2.a) # HTTP/2 framing and HPACK (Network.cpp)

    # Graphics
    _chitin_imported(PNG::PNG LIBS libpng16.a DEPS ZLIB::ZLIB)
    _chitin_imported(JPEG::JPEG LIBS libjpeg.a)
    _chitin_imported(WebP::webp LIBS libwebp.a libsharpyuv.a)
    _chitin_imported(WebP::webpdecoder LIBS libwebpdecoder.a)
    _chitin_imported(WebP::webpdemux LIBS libwebpdemux.a DEPS WebP::webp)
    _chitin_imported(WebP::libwebpmux LIBS libwebpmux.a DEPS WebP::webp)
    _chitin_imported(PkgConfig::WOFF2 LIBS libwoff2dec.a libwoff2common.a DEPS _chitin_brotli)
    _chitin_imported(harfbuzz LIBS libharfbuzz.a libfreetype.a DEPS PNG::PNG ZLIB::ZLIB INCLUDES "${P}/include/harfbuzz" "${P}/include/freetype2")
    set(WUFFS_INCLUDE_DIR "${P}/include" CACHE PATH "" FORCE)
    # Skia's public headers include each other as "include/core/...", so its source root is the include path.
    _chitin_imported(_chitin_skia LIBS libskia.wasm.a libskia_pathops.a DEPS harfbuzz INCLUDES "${P}/include/skia" "${P}/include/skia-src")
    set_property(TARGET _chitin_skia APPEND PROPERTY INTERFACE_COMPILE_DEFINITIONS SK_CPU_LENDIAN)
    add_library(skia ALIAS _chitin_skia)

    # ANGLE: headers only (WebGL constants and types); WebGL goes to the host's WebGL2 later.
    add_library(_chitin_angle INTERFACE IMPORTED GLOBAL)
    set_target_properties(_chitin_angle PROPERTIES INTERFACE_INCLUDE_DIRECTORIES "${CHITIN_ANGLE_INCLUDE}")
    set(ANGLE_TARGETS _chitin_angle PARENT_SCOPE)

    # Not used in a segment: media through WebCodecs, the network through Spiracle, no windowing.
    foreach(t PkgConfig::AVCODEC PkgConfig::AVFORMAT PkgConfig::AVUTIL PkgConfig::LIBSWRESAMPLE SDL3::SDL3
              Threads::Threads CURL::libcurl)
        _chitin_imported(${t})
    endforeach()

    # LibImageDecoders (the ImageDecoder process's decoders) refuses to configure without an APNG
    # libpng. Ganglion never builds it (ninja builds only what LibWeb needs; images decode through
    # the host or LibGfx), so the check is answered here instead of patching libpng.
    set(LIBPNG_HAS_APNG ON CACHE BOOL "" FORCE)

    set(HAS_FONTCONFIG OFF CACHE BOOL "" FORCE)
    set(HAS_VULKAN OFF CACHE BOOL "" FORCE)
    set(USE_VULKAN_DMABUF_IMAGES OFF CACHE BOOL "" FORCE)
    set(HAS_DIRECTX OFF CACHE BOOL "" FORCE)

    # LibJS: Ganglion's own runtime behind LibJS's embedding ABI (engine/libjs-runtime), in place of
    # the Rust runtime, which only builds for 64-bit targets (patches/ladybird: LibJS external runtime).
    # LibJS's facade headers include LibJS/Embedding/Layout.h, and LibWeb includes those headers, so the
    # runtime's headers are on every target's path, not only LibJS's (libjs_rust is linked privately).
    include_directories("${CHITIN_ENGINE_DIR}/libjs-runtime/include" "${CHITIN_LIBJS_RUNTIME_INCLUDE}")
    # The LibMedia/FFmpeg replacement headers shadow upstream's for every target that includes them
    # (LibMedia itself and LibWeb's WebAudio).
    include_directories(BEFORE "${CHITIN_ENGINE_DIR}/platform/include")
    add_library(libjs_rust INTERFACE IMPORTED GLOBAL)
    set_target_properties(libjs_rust PROPERTIES
        INTERFACE_INCLUDE_DIRECTORIES "${CHITIN_ENGINE_DIR}/libjs-runtime/include;${CHITIN_LIBJS_RUNTIME_INCLUDE}"
        INTERFACE_LINK_LIBRARIES GanglionJSRuntime)

endfunction()

# At file scope, so that Python3_EXECUTABLE (the code generators' interpreter) is visible everywhere.
find_package(Git REQUIRED)
find_package(Python3 REQUIRED COMPONENTS Interpreter)

function(_chitin_drop_sources target regex)
    get_target_property(sources ${target} SOURCES)
    list(FILTER sources EXCLUDE REGEX "${regex}")
    set_property(TARGET ${target} PROPERTY SOURCES ${sources})
endfunction()

# Every library target under a directory, recursively.
function(_chitin_all_targets out dir)
    get_property(targets DIRECTORY "${dir}" PROPERTY BUILDSYSTEM_TARGETS)
    get_property(subdirs DIRECTORY "${dir}" PROPERTY SUBDIRECTORIES)
    foreach(sub IN LISTS subdirs)
        _chitin_all_targets(sub_targets "${sub}")
        list(APPEND targets ${sub_targets})
    endforeach()
    set(${out} "${targets}" PARENT_SCOPE)
endfunction()

function(ladybird_embedder_adjust_targets)
    # Ladybird's -Wall -Wextra -Werror are directory options added after this file's add_compile_options,
    # and clang lets the last flag win, so -Wall re-enables -Wtautological-constant-out-of-range-compare.
    # Target options come after directory options on the command line, so the -Wno- flags go on every
    # target here.
    _chitin_all_targets(targets "${CMAKE_SOURCE_DIR}")
    foreach(t IN LISTS targets)
        get_target_property(type ${t} TYPE)
        if (type STREQUAL "STATIC_LIBRARY" OR type STREQUAL "OBJECT_LIBRARY" OR type STREQUAL "EXECUTABLE")
            # No stack protector: it guards nothing on wasm (return addresses are not in linear memory), and
            # LLVM 21 emits its epilogue check inside a block that a return_call (-mtail-call turns every
            # sibling call into one) cannot see its arguments past, which is invalid wasm (docs/phase1.md).
            target_compile_options(${t} PRIVATE
                $<$<COMPILE_LANGUAGE:C,CXX>:-fno-stack-protector>
                $<$<COMPILE_LANGUAGE:CXX>:-Wno-c++11-narrowing>
                $<$<COMPILE_LANGUAGE:C,CXX>:-Wno-tautological-constant-out-of-range-compare>
                $<$<COMPILE_LANGUAGE:C,CXX>:-Wno-shorten-64-to-32>)
        endif()
    endforeach()

    # LibCompositing's WebGL command headers include the generated GLFunctions.h, whose generator upstream
    # only attaches to the Compositor service.
    if (TARGET generate_GLFunctions.cpp)
        add_dependencies(LibCompositing generate_GLFunctions.cpp)
    endif()

    # LibMedia without FFmpeg: decoding goes to the host's WebCodecs in phase 4. The FFmpeg classes are
    # replaced by engine/platform/include/LibMedia/FFmpeg (headers that shadow upstream's) and
    # engine/platform/MediaWithoutFFmpeg.cpp, whose factories report no decoder.
    _chitin_drop_sources(LibMedia "(^|/)FFmpeg/|Codecs/Vorbis\\.cpp$")
    target_sources(LibMedia PRIVATE "${CHITIN_ENGINE_DIR}/platform/MediaWithoutFFmpeg.cpp")

    # LibTLS needs OpenSSL sockets; TLS is Spiracle's job (phase 3) and nothing in LibWeb includes
    # LibTLS headers. The target stays, so LibHTTP and LibWeb can link it, but builds nothing.
    _chitin_drop_sources(LibTLS ".*")
    target_sources(LibTLS PRIVATE "${CHITIN_ENGINE_DIR}/platform/Empty.cpp")

    add_subdirectory("${CHITIN_ENGINE_DIR}/libjs-runtime" "${CMAKE_BINARY_DIR}/ganglion/libjs-runtime")
    add_subdirectory("${CHITIN_ENGINE_DIR}/platform" "${CMAKE_BINARY_DIR}/ganglion/platform")
endfunction()
