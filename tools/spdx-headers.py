#!/usr/bin/env python3
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 [OWNER NAME]
# Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
#
# Adds the licence header to Chitin-authored source files that lack one (never to third_party/ or
# patches/). Idempotent: a file with an SPDX line is left alone. Usage: tools/spdx-headers.py [--check].
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP = ("third_party/", "patches/", "build/", "node_modules/", ".git/", "harness/sites/", "docs/", "toy/idl/", "engine/libjs-runtime/tools/Layout-x86_64-reference.h")
STYLES = {".js": "//", ".mjs": "//", ".cpp": "//", ".h": "//", ".py": "#", ".sh": "#", ".cmake": "#", ".mk": "#", ".idl": "//", ".css": "/*", ".html": "<!--"}
LINES = ["SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0", "Copyright (c) 2026 [OWNER NAME]", "Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])"]


def header_for(ext):
    style = STYLES[ext]
    if style == "/*":
        return "/*\n" + "".join(f" * {l}\n" for l in LINES) + " */\n"
    if style == "<!--":
        return "<!--\n" + "".join(f"  {l}\n" for l in LINES) + "-->\n"
    return "".join(f"{style} {l}\n" for l in LINES)


def main():
    check = "--check" in sys.argv
    missing = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        rel = os.path.relpath(dirpath, ROOT) + "/"
        if any(rel.startswith(s) or ("/" + rel).find("/" + s) >= 0 for s in SKIP):
            dirnames[:] = []
            continue
        for filename in filenames:
            ext = os.path.splitext(filename)[1]
            path = os.path.join(dirpath, filename)
            relpath = os.path.relpath(path, ROOT)
            if ext not in STYLES or any(relpath.startswith(s) for s in SKIP) or filename in ("Makefile",):
                continue
            text = open(path, encoding="utf-8", errors="replace").read()
            if "SPDX-License-Identifier" in text[:600]:
                continue
            missing.append(relpath)
            if check:
                continue
            header = header_for(ext)
            if text.startswith("#!"):
                first, rest = text.split("\n", 1)
                text = first + "\n" + header + rest
            elif text.startswith("<!doctype") or text.startswith("<!DOCTYPE"):
                first, rest = text.split("\n", 1)
                text = first + "\n" + header + rest
            else:
                text = header + text
            open(path, "w", encoding="utf-8").write(text)
    if check:
        for m in missing:
            print(m)
        return 1 if missing else 0
    print(f"added headers to {len(missing)} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
