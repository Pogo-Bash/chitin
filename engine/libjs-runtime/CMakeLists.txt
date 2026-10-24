# SPDX-License-Identifier: GPL-2.0-only
# Copyright (c) 2026 [OWNER NAME]
# Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
#
# Ganglion's runtime behind LibJS's embedding ABI (docs/phase1.md, "The LibJS shim").
file(GLOB GANGLION_JS_RUNTIME_SOURCES CONFIGURE_DEPENDS "${CMAKE_CURRENT_LIST_DIR}/src/*.cpp")
set(stubs "${CMAKE_CURRENT_BINARY_DIR}/AbiStubs.gen.cpp")
add_custom_command(
    OUTPUT "${stubs}"
    COMMAND ${Python3_EXECUTABLE} "${CMAKE_CURRENT_LIST_DIR}/tools/gen-stubs.py"
        "${CHITIN_LIBJS_RUNTIME_INCLUDE}/LibJS/Embedding/ABI.h" "${stubs}" ${GANGLION_JS_RUNTIME_SOURCES}
    DEPENDS "${CMAKE_CURRENT_LIST_DIR}/tools/gen-stubs.py" "${CHITIN_LIBJS_RUNTIME_INCLUDE}/LibJS/Embedding/ABI.h" ${GANGLION_JS_RUNTIME_SOURCES}
    COMMENT "Generating LibJS ABI stubs")
add_library(GanglionJSRuntime STATIC ${GANGLION_JS_RUNTIME_SOURCES} "${stubs}")
target_include_directories(GanglionJSRuntime PUBLIC "${CMAKE_CURRENT_LIST_DIR}/include" "${CHITIN_LIBJS_RUNTIME_INCLUDE}")
target_link_libraries(GanglionJSRuntime PRIVATE AK LibGC LibUnicode)
target_compile_options(GanglionJSRuntime PRIVATE -Wno-missing-field-initializers)
