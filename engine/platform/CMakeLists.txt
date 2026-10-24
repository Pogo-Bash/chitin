# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (c) 2026 [OWNER NAME]
# Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
#
# ganglion.wasm: LibWeb and the libraries under it, Ganglion's LibJS runtime, the Compositor's CPU
# rasterizer, and the segment host (Host.cpp), linked as a standalone wasm module with no Emscripten JS
# runtime (docs/phase1.md, "The link"). Every import it has is written by hand in glue/.

# The default theme, embedded as text (Base/res/themes/Default.ini, BSD-2-Clause).
file(READ "${LADYBIRD_SOURCE_DIR}/Base/res/themes/Default.ini" GANGLION_DEFAULT_THEME_INI)
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/DefaultTheme.gen.h" "// Generated from Ladybird's Base/res/themes/Default.ini -- DO NOT EDIT\nstatic constexpr char default_theme_ini[] = R\"ini(${GANGLION_DEFAULT_THEME_INI})ini\";\n")

set(COMPOSITOR_DIR "${LADYBIRD_SOURCE_DIR}/Services/Compositor")

# WebGL's executor (WebGL.cpp): the Compositor's generated command replayer, whose GL calls are glue imports.
file(MAKE_DIRECTORY "${CMAKE_BINARY_DIR}/Services/Compositor")
invoke_py_generator(
    "GanglionWebGLCommandReplayer"
    "generate_compositor_webgl_replayer.py"
    "${LADYBIRD_SOURCE_DIR}/Libraries/LibCompositing/WebGL/GLFunctions.json"
    "${CMAKE_BINARY_DIR}/Services/Compositor/WebGLCommandReplayer.h"
    "${CMAKE_BINARY_DIR}/Services/Compositor/WebGLCommandReplayer.cpp"
    arguments -j "${LADYBIRD_SOURCE_DIR}/Libraries/LibCompositing/WebGL/GLFunctions.json"
    dependencies "${LADYBIRD_SOURCE_DIR}/Meta/Generators/libweb_webgl.py"
)
add_executable(ganglion
    Host.cpp
    Layers.cpp
    EventLoop.cpp
    Network.cpp
    Bridge.cpp
    Canvas2D.cpp
    WebGL.cpp
    Fonts.cpp
    Media.cpp
    SkiaStubs.cpp
    "${COMPOSITOR_DIR}/DisplayListPlayer.cpp"
    "${COMPOSITOR_DIR}/DisplayListPlayerSkia.cpp"
    "${COMPOSITOR_DIR}/DisplayListRasterCache.cpp"
    "${COMPOSITOR_DIR}/VideoFrameSkia.cpp"
    "${COMPOSITOR_DIR}/HostWebGLContext.cpp"
    "${COMPOSITOR_DIR}/WebGLObjectMap.cpp"
    "${CMAKE_BINARY_DIR}/Services/Compositor/WebGLCommandReplayer.cpp"
    "${CMAKE_BINARY_DIR}/Libraries/LibCompositing/WebGL/GLFunctions.cpp"
)
add_dependencies(ganglion generate_GanglionWebGLCommandReplayer)
set_target_properties(ganglion PROPERTIES OUTPUT_NAME ganglion SUFFIX ".wasm")
# Ladybird's directory-wide ELF link options (-z defs, --no-undefined) are not for a wasm module whose
# system imports are undefined on purpose; emcc also mangles the "-z defs" pair.
get_target_property(ganglion_link_options ganglion LINK_OPTIONS)
if (ganglion_link_options)
    list(FILTER ganglion_link_options EXCLUDE REGEX "LINKER:(-z,defs|-z,undefs|--no-undefined|--no-allow-shlib-undefined|--allow-shlib-undefined)")
    set_property(TARGET ganglion PROPERTY LINK_OPTIONS "${ganglion_link_options}")
endif()
target_include_directories(ganglion PRIVATE
    "${CMAKE_CURRENT_BINARY_DIR}"
    "${LADYBIRD_SOURCE_DIR}/Services"
    "${CMAKE_BINARY_DIR}/Services"
    "${CMAKE_BINARY_DIR}/Libraries/LibCompositing")
target_compile_options(ganglion PRIVATE -Wno-missing-field-initializers -Wno-missing-prototypes -Wno-c++11-narrowing -Wno-tautological-constant-out-of-range-compare)
target_link_libraries(ganglion PRIVATE
    LibWeb LibCompositing LibWebCommon LibMedia LibMediaClient LibGfx LibJS LibGC LibCore LibURL LibHTTP LibRequests
    LibUnicode LibTextCodec LibRegex LibCrypto LibCompress LibXML LibIPC LibThreading LibWasm LibSyntax LibDatabase LibFileSystem
    LibImageDecoderClient AK GanglionJSRuntime skia harfbuzz ICU::i18n ICU::uc ICU::data
    OpenSSL::SSL OpenSSL::Crypto ZLIB::ZLIB _chitin_brotli _chitin_nghttp2)

set(GANGLION_EXPORTS
    _ganglion_alloc _ganglion_free _ganglion_init _ganglion_set_icu_data _ganglion_add_font _ganglion_set_fallback_fonts _ganglion_add_fallback_font _ganglion_fallback_font_counts _ganglion_start _ganglion_load
    _ganglion_fetch_done _ganglion_fetch_failed _ganglion_fetch_network _ganglion_net_request _ganglion_tunnel_open _ganglion_tunnel_write _ganglion_tunnel_close _ganglion_image_done _ganglion_image_failed _ganglion_pump
    _ganglion_navigate _ganglion_rendering_opportunity _ganglion_debug_trap _ganglion_set_ca_bundle _ganglion_set_identity _ganglion_tcp_peer _ganglion_net_dns _ganglion_tcp_opened _ganglion_tcp_data _ganglion_tcp_closed _ganglion_net_stats
    _ganglion_js_enable _ganglion_js_attach _ganglion_js_enter _ganglion_js_leave _ganglion_js_global _ganglion_js_object_prototype _ganglion_js_invoke _ganglion_js_construct
    _ganglion_foreign_object _ganglion_foreign_function _ganglion_v_foreign_handle _ganglion_v_object_kind _ganglion_v_is_constructor _ganglion_v_class_name _ganglion_v_host_flags
    _ganglion_v_from_number _ganglion_v_number _ganglion_v_string_data _ganglion_v_string_from_utf16 _ganglion_v_string_from_latin1
    _ganglion_v_symbol_description _ganglion_v_symbol_well_known _ganglion_v_symbol_create
    _ganglion_key_intern _ganglion_key_index _ganglion_key_well_known _ganglion_key_from_symbol _ganglion_key_kind _ganglion_key_number _ganglion_key_value _ganglion_keys_push _ganglion_keys_count _ganglion_keys_at
    _ganglion_v_prototype _ganglion_v_get _ganglion_v_set _ganglion_v_own_keys _ganglion_window_named_keys _ganglion_v_own_kind _ganglion_v_own_property _ganglion_v_is_callable _ganglion_v_root
    _ganglion_v_error_kind _ganglion_v_error_create _ganglion_v_promise_state _ganglion_v_promise_result _ganglion_promise_then
    _ganglion_set_viewport _ganglion_needs_paint _ganglion_paint _ganglion_frame_rgba _ganglion_dirty_x _ganglion_dirty_y _ganglion_dirty_width _ganglion_dirty_height _ganglion_blit_dx _ganglion_blit_dy _ganglion_paint_counts _ganglion_frame_width _ganglion_frame_height
    _ganglion_set_compositor _ganglion_compositor _ganglion_layers_json _ganglion_layers_json_length _ganglion_layers_dirty_count _ganglion_layers_dirty_pixels _ganglion_layers_stats _ganglion_scroll_sync
    _ganglion_media_set_codec_support _ganglion_media_video_frame _ganglion_media_decoder_flushed _ganglion_media_decoder_error _ganglion_webgl_context_event
    _ganglion_mouse _ganglion_mouse_screen _ganglion_fullscreen_changed _ganglion_pointer_lock_result _ganglion_gamepad_connected _ganglion_gamepad_state _ganglion_gamepad_disconnected _ganglion_wheel _ganglion_scroll_by _ganglion_key _ganglion_collect _ganglion_heap_bytes _ganglion_fingerprint _ganglion_debug
    _malloc _free _setThrew _emscripten_stack_get_current __emscripten_stack_restore)
list(JOIN GANGLION_EXPORTS "," GANGLION_EXPORTS_LIST)
target_link_options(ganglion PRIVATE
    # The objects are -O3; at -O2 emcc runs wasm-opt over the linked module (Binaryen accepts it since the
    # stack-protector/return_call shape went, docs/phase1.md), which shrinks it by a third and makes the
    # cross-library inlining the objects could not.
    -O2
    --profiling-funcs
    -mtail-call
    -sSTANDALONE_WASM=1
    --no-entry
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=128MB
    -sMAXIMUM_MEMORY=2GB
    -sSTACK_SIZE=8MB
    -sERROR_ON_UNDEFINED_SYMBOLS=0
    -sWARN_ON_UNDEFINED_SYMBOLS=0
    "-sEXPORTED_FUNCTIONS=${GANGLION_EXPORTS_LIST}"
    -Wl,--allow-multiple-definition)
