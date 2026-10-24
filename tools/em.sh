#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-only
# Copyright (c) 2026 [OWNER NAME]
# Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
# Runs a command with the pinned Emscripten on PATH: tools/em.sh em++ ...
. "$(dirname "$0")/toolchain.env"
export EMSDK_PYTHON EMSDK_QUIET=1
. "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
exec "$@"
