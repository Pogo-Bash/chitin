#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only
# Copyright (c) 2026 [OWNER NAME]
# Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
"""Concatenates the glue sources into one classic script: an IIFE that leaves a single boot
function on globalThis.__chitinBoot. The host script takes it and deletes the global before any
page script runs."""
import sys
from pathlib import Path

args = sys.argv[1:]
name = "__chitinBoot"
if args[0] == "--global":
    name = args[1]
    args = args[2:]
out, *parts = args
chunks = ["/*! Chitin: a web browser that runs inside a web page. Copyright (c) 2026 [OWNER NAME].\n"
          " * Licensed under the PolyForm Noncommercial License 1.0.0 (LICENSE.md); built on Ladybird (BSD-2-Clause,\n"
          " * CREDITS.md). Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL]). */\n",
          "// Chitin segment glue (bundled by tools/bundle-glue.py; sources in glue/).\n",
          "(function () {\n'use strict';\n"]
for part in parts:
    chunks.append(f"\n// ===== {part} =====\n")
    chunks.append(Path(part).read_text())
chunks.append(f"\nObject.defineProperty(globalThis, '{name}', {{ value: boot, writable: false, enumerable: false, configurable: true }});\n}})();\n")
Path(out).parent.mkdir(parents=True, exist_ok=True)
Path(out).write_text("".join(chunks))
