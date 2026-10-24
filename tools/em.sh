#!/bin/sh
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 [OWNER NAME]
# Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
# Runs a command with the pinned Emscripten on PATH: tools/em.sh em++ ...
. "$(dirname "$0")/toolchain.env"
export EMSDK_PYTHON EMSDK_QUIET=1
. "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
exec "$@"
