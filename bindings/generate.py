#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (c) 2026 [OWNER NAME]
# Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
"""
Chitin binding generator, phase-0 prototype.

Parses Web IDL with Ladybird's parser (third_party/ladybird/Meta/Utils/webidl_parser.py, BSD-2-Clause,
used unmodified) and emits, for every engine-backed interface:

  - a JS class for the segment glue (build/gen/bindings.gen.js), with WebIDL argument conversion,
    brand checks on private fields, and calls straight into the engine's wasm exports;
  - flat C exports (build/gen/Bindings.gen.cpp) that resolve handles and call the implementation
    by Ladybird's naming convention (snake_case of the IDL name, or [ImplementedAs]);
  - the interface id enum and is-a table (build/gen/InterfaceIds.gen.h).

Members marked [ImplementedInBindings] are written by hand in glue/custom/*.js (and their C
exports in toy/engine/Custom.cpp). Interfaces marked [ImplementedInBindings] (DOMRect) live
entirely in the glue.

The ABI is described in toy/engine/Bindings.h.
"""

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "third_party" / "ladybird" / "Meta"))

from Utils.webidl_parser import InterfaceKind  # noqa: E402
from Utils.webidl_parser import parse_module  # noqa: E402

STRING_TYPES = {"DOMString", "USVString", "CSSOMString", "ByteString"}
INT_TYPES = {
    "byte": "s8",
    "octet": "u8",
    "short": "s16",
    "unsigned short": "u16",
    "long": "s32",
    "unsigned long": "u32",
}
DOUBLE_TYPES = {"double", "unrestricted double", "float", "unrestricted float", "DOMHighResTimeStamp"}


def snake_case(name):
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name)
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", s)
    return s.lower()


class Model:
    def __init__(self, idl_dir):
        self.interfaces = {}
        self.mixins = {}
        self.dictionaries = {}
        includes = []
        for path in sorted(Path(idl_dir).glob("*.idl")):
            module = parse_module(path, path.read_text())
            if module.interface and module.interface.kind == InterfaceKind.Interface:
                self.interfaces[module.interface.name] = module.interface
            for mixin in module.mixins:
                self.mixins[mixin.name] = mixin
            for dictionary in module.dictionaries:
                self.dictionaries[dictionary.name] = dictionary
            includes.extend(module.included_mixins)
        for inc in includes:
            target = self.interfaces[inc.interface_name]
            mixin = self.mixins[inc.mixin_name]
            target.regular_attributes.extend(mixin.regular_attributes)
            target.regular_operations.extend(mixin.regular_operations)
            target.constants.extend(mixin.constants)

        # Interfaces in parent-first order; ids start at 1.
        self.order = []
        seen = set()

        def visit(name):
            if name in seen:
                return
            interface = self.interfaces[name]
            if interface.parent_name:
                visit(interface.parent_name)
            seen.add(name)
            self.order.append(interface)

        for name in sorted(self.interfaces):
            visit(name)
        self.engine_backed = [i for i in self.order if "ImplementedInBindings" not in i.extended_attributes]
        self.ids = {i.name: n + 1 for n, i in enumerate(self.engine_backed)}

    def root_of(self, interface):
        while interface.parent_name:
            interface = self.interfaces[interface.parent_name]
        return interface

    def is_engine_interface(self, type_name):
        return type_name in self.ids

    def dictionary_members(self, name):
        d = self.dictionaries[name]
        members = self.dictionary_members(d.parent_name) if d.parent_name else []
        # WebIDL: inherited members first, then own members in lexicographic order.
        return members + sorted(d.members, key=lambda m: m.name)


# --- Type classification ---------------------------------------------------------------------------


def result_kind(model, idl_type):
    name = idl_type.name
    if name == "undefined":
        return "status"
    if name in STRING_TYPES:
        if "FlyString" in idl_type.extended_attributes:
            return "atom"
        return "string"
    if name == "boolean":
        return "bool"
    if name in INT_TYPES:
        return "uint" if name.startswith("unsigned") else "int"
    if name in DOUBLE_TYPES:
        return "double"
    if name == "DOMRect":
        return "rect"
    if model.is_engine_interface(name):
        return "handle"
    raise SystemExit(f"generate.py: unsupported result type {idl_type}")


class Arg:
    """One IDL argument: its JS conversion and its C++ parameters."""

    def __init__(self, model, name, idl_type, optional=False, default=None, ext=None):
        self.model = model
        self.name = name
        self.type = idl_type
        self.optional = optional
        self.default = default
        self.ext = dict(ext or {})
        self.ext.update(idl_type.extended_attributes)

    @property
    def kind(self):
        name = self.type.name
        if name in STRING_TYPES:
            return "string"
        if name == "boolean":
            return "bool"
        if name in INT_TYPES:
            return "int"
        if name in DOUBLE_TYPES:
            return "double"
        if self.model.is_engine_interface(name):
            return "handle"
        if name in self.model.dictionaries:
            return "dictionary"
        raise SystemExit(f"generate.py: unsupported argument type {self.type} for {self.name}")

    def js_default(self):
        d = self.default
        if d is None:
            return {"string": '""', "bool": "false", "int": "0", "double": "0", "handle": "null"}.get(self.kind, "undefined")
        if d == "{}":
            return "undefined"
        return d

    def js_convert(self, value, op_label, position):
        """Returns (statements, [js values passed to the export])."""
        kind = self.kind
        v = f"a{position}"
        lines = []
        src = value
        if self.optional:
            src = f"({value} === undefined ? {self.js_default()} : {value})"
        if kind == "string":
            if self.type.nullable:
                lines.append(f"const {v} = {src} == null ? null : toDOMString({src});")
            elif "LegacyNullToEmptyString" in self.ext:
                lines.append(f"const {v} = {src} === null ? '' : toDOMString({src});")
            else:
                lines.append(f"const {v} = toDOMString({src});")
            return lines, [("string", v, self.type.nullable)]
        if kind == "bool":
            lines.append(f"const {v} = !!{src};")
            return lines, [("raw", f"{v} ? 1 : 0", False)]
        if kind == "int":
            conv = {
                "s8": "(ToNumberInt({s}) << 24) >> 24",
                "u8": "ToNumberInt({s}) & 0xff",
                "s16": "(ToNumberInt({s}) << 16) >> 16",
                "u16": "ToNumberInt({s}) & 0xffff",
                "s32": "ToNumberInt({s}) | 0",
                "u32": "ToNumberInt({s}) >>> 0",
            }[INT_TYPES[self.type.name]].format(s=src)
            lines.append(f"const {v} = {conv};")
            return lines, [("raw", v, False)]
        if kind == "double":
            if self.type.name.startswith("unrestricted"):
                lines.append(f"const {v} = +{src};")
            else:
                lines.append(f"const {v} = toFiniteDouble({src}, {op_label!r});")
            return lines, [("raw", v, False)]
        if kind == "handle":
            check = f"{self.type.name}_arg"
            if self.type.nullable:
                lines.append(f"const {v} = {src} == null ? 0 : {check}({src}, {op_label!r}, {position + 1});")
            else:
                lines.append(f"const {v} = {check}({src}, {op_label!r}, {position + 1});")
            return lines, [("raw", v, False)]
        if kind == "dictionary":
            members = self.model.dictionary_members(self.type.name)
            d = f"d{position}"
            lines.append(f"const {d} = {value};")
            lines.append(
                f"if ({d} !== undefined && {d} !== null && typeof {d} !== 'object' && typeof {d} !== 'function') throw typeError({op_label!r} + ': parameter {position + 1} is not of type \\'{self.type.name}\\'.');"
            )
            passed = []
            for m in members:
                mv = f"{d}_{m.name}"
                default = m.default_value if m.default_value is not None else "false"
                if m.type.name != "boolean":
                    raise SystemExit(f"generate.py: dictionary member type {m.type} not supported yet")
                lines.append(f"const {mv}_raw = {d} == null ? undefined : {d}.{m.name};")
                lines.append(f"const {mv} = {mv}_raw === undefined ? {default} : !!{mv}_raw;")
                passed.append(("raw", f"{mv} ? 1 : 0", False))
            return lines, passed
        raise AssertionError(kind)

    def cpp_params(self, position):
        kind = self.kind
        p = f"a{position}"
        if kind == "string":
            return [f"u32 {p}_ptr", f"u32 {p}_len"]
        if kind == "bool":
            return [f"i32 {p}"]
        if kind == "int":
            return [f"i32 {p}"]
        if kind == "double":
            return [f"f64 {p}"]
        if kind == "handle":
            return [f"u32 {p}"]
        if kind == "dictionary":
            return [f"i32 {p}_{m.name}" for m in self.model.dictionary_members(self.type.name)]
        raise AssertionError(kind)

    def cpp_value(self, position):
        kind = self.kind
        p = f"a{position}"
        if kind == "string":
            if self.type.nullable:
                return [f"in_nullable_string({p}_ptr, {p}_len)"]
            return [f"in_string({p}_ptr, {p}_len)"]
        if kind == "bool":
            return [f"{p} != 0"]
        if kind == "int":
            t = INT_TYPES[self.type.name]
            ctype = "u32" if t.startswith("u") else "i32"
            return [f"static_cast<{ctype}>({p})"]
        if kind == "double":
            return [p]
        if kind == "handle":
            if self.type.nullable:
                return [f"resolve_nullable<{self.type.name}>({p})"]
            return [f"resolve<{self.type.name}>({p})"]
        if kind == "dictionary":
            return [f"{p}_{m.name} != 0" for m in self.model.dictionary_members(self.type.name)]
        raise AssertionError(kind)


# --- Emitters ----------------------------------------------------------------------------------------


CPP_RESULT = {
    "status": ("i32", "status_of"),
    "handle": ("i32", "handle_of"),
    "string": ("i32", "string_of"),
    "atom": ("i32", "atom_of"),
    "bool": ("i32", "bool_of"),
    "int": ("i32", "int_of"),
    "uint": ("i32", "int_of"),
    "double": ("f64", "double_of"),
    "rect": ("i32", "rect_of"),
}


def js_result(kind, call, nullable):
    if kind == "status":
        return [f"const r = {call};", "if (r !== 0) throwEngineError(r);", "return undefined;"]
    if kind == "handle":
        lines = [f"const r = {call};", "if (r < 0) throwEngineError(-r);"]
        lines.append("return r === 0 ? null : wrap(r);" if nullable else "return wrap(r);")
        return lines
    if kind == "string":
        return [f"const r = {call};", "if (r < -1) throwEngineError(-1 - r);", "return r === -1 ? null : readOut(r);"]
    if kind == "atom":
        return [f"return atomString({call});"]
    if kind == "bool":
        return [f"const r = {call};", "if (r < 0) throwEngineError(-r);", "return r === 1;"]
    if kind == "int":
        return [f"return {call};"]
    if kind == "uint":
        return [f"return {call} >>> 0;"]
    if kind == "double":
        return [f"return {call};"]
    if kind == "rect":
        return [f"const r = {call};", "if (r !== 0) throwEngineError(r);", "return readRect();"]
    raise AssertionError(kind)


class Emitter:
    def __init__(self, model):
        self.model = model
        self.js = []
        self.cpp = []
        self.exports = []

    def export_name(self, interface, member, suffix=""):
        return f"ganglion_{interface.name}_{member}{suffix}"

    def emit_call(self, interface, member_label, export, args_js, cpp_params, cpp_call, kind, nullable, self_handle=True):
        """Emit the JS body tail (strings, call, result) and the C++ thunk."""
        passed = []
        body = []
        strings = []
        for js_value in args_js:
            for item in js_value:
                passed.append(item)
        call_args = ["h"] if self_handle else []
        for tag, value, string_nullable in passed:
            if tag == "string":
                strings.append((value, string_nullable))
                call_args.append(f"{value}_p")
                call_args.append(f"{value}_n")
            else:
                call_args.append(value)
        if strings:
            body.append("const base = inTop;")
            for value, string_nullable in strings:
                if string_nullable:
                    body.append(f"const {value}_n = {value} === null ? -1 : {value}.length;")
                    body.append(f"const {value}_p = {value} === null ? 0 : putString({value});")
                else:
                    body.append(f"const {value}_n = {value}.length;")
                    body.append(f"const {value}_p = putString({value});")
        call = f"X.{export}({', '.join(call_args)})"
        if strings:
            body.append(f"const raw = {call};")
            body.append("endCall(base);")
            call = "raw"
        body.extend(js_result(kind, call, nullable))

        ctype, wrapper = CPP_RESULT[kind]
        params = (["u32 self_handle"] if self_handle else []) + cpp_params
        self.cpp.append(f'GANGLION_EXPORT("{export}") {ctype} {export}({", ".join(params)})')
        self.cpp.append("{")
        if self_handle:
            self.cpp.append(f"    auto& self = resolve<{interface.name}>(self_handle);")
            self.cpp.append("    (void)self;")
        self.cpp.append(f"    return {wrapper}([&] {{ return {cpp_call}; }});")
        self.cpp.append("}")
        self.cpp.append("")
        self.exports.append(export)
        return body

    def emit_interface(self, interface):
        model = self.model
        name = interface.name
        root = model.root_of(interface)
        is_root = root is interface
        parent = interface.parent_name
        lines = self.js
        lines.append(f"// --- {name} " + "-" * max(1, 90 - len(name)))
        lines.append(f"class {name}{' extends ' + parent if parent else ''} {{")
        lines.append("    #brand;")
        if is_root:
            lines.append("    #h;")
            lines.append("    #a;")

        # Constructor.
        ctor = interface.constructors[0] if interface.constructors else None
        lines.append("    constructor(t, h, a) {")
        if ctor:
            lines.append("        if (t !== kCreate) {")
            lines.append(f"            if (new.target === undefined) throw typeError(\"Failed to construct '{name}': Please use the 'new' operator.\");")
            args = [Arg(model, p.name, p.type, p.optional, p.default_value, p.extended_attributes) for p in ctor.parameters]
            required = sum(1 for a in args if not a.optional)
            if required:
                lines.append(f"            if (arguments.length < {required}) throw argCountError({('Failed to construct ' + repr(name))!r}, {required}, arguments.length);")
            js_vals = []
            for i, a in enumerate(args):
                stmts, vals = a.js_convert(f"arguments[{i}]", f"Failed to construct '{name}'", i)
                for s in stmts:
                    lines.append("            " + s)
                js_vals.append(vals)
            cpp_params = [p for i, a in enumerate(args) for p in a.cpp_params(i)]
            cpp_values = [v for i, a in enumerate(args) for v in a.cpp_value(i)]
            export = self.export_name(interface, "construct")
            body = self.emit_call(interface, "constructor", export, js_vals, cpp_params, f"{name}::construct({', '.join(cpp_values)})", "handle", False, self_handle=False)
            # The result is a fresh handle: register `this` (which may be a page subclass) as its wrapper.
            body = [b.replace("return wrap(r);", "h = r;") for b in body]
            for b in body:
                lines.append("            " + b)
            if is_root:
                lines.append("            a = adoptConstructed(this, h);")
            lines.append("        }")
        else:
            lines.append(f"        if (t !== kCreate) throw typeError('Illegal constructor');")
        if parent:
            lines.append("        super(t, h, a);")
        if is_root:
            lines.append("        this.#h = h;")
            lines.append("        this.#a = a;")
        for attr in interface.regular_attributes:
            if "LegacyUnforgeable" in attr.extended_attributes:
                lines.append(f"        ObjectDefineProperty(this, '{attr.name}', unforgeable_{name}_{attr.name});")
        lines.append("    }")

        # Brand checks and handle access, captured in a static block so page JS never sees them.
        lines.append("    static {")
        lines.append(f"        {name}_is = (o) => o !== null && (typeof o === 'object' || typeof o === 'function') && #brand in o;")
        if is_root:
            lines.append(f"        {name}_raw = (o) => o.#h;")
            lines.append(f"        rootAccess.{name} = {{ __proto__: null, h: (o) => o.#h, a: (o) => o.#a, setA: (o, a) => {{ o.#a = a; }} }};")
            lines.append(f"        {name}_h = (o) => {{ if (!{name}_is(o)) throw illegalInvocation(); return o.#h; }};")
            lines.append(f"        {name}_anchor = (o) => o.#a;")
        else:
            lines.append(f"        {name}_h = (o) => {{ if (!{name}_is(o)) throw illegalInvocation(); return {root.name}_raw(o); }};")
        lines.append(f"        {name}_arg = (o, label, position) => {{ if (!{name}_is(o)) throw typeError(label + ': parameter ' + position + \" is not of type '{name}'.\"); return {root.name}_raw(o); }};")
        lines.append("    }")

        enumerable = []
        unforgeable = []
        for attr in interface.regular_attributes:
            ext = attr.extended_attributes
            if "ImplementedInBindings" in ext:
                enumerable.append(attr.name)
                continue
            cpp_name = ext.get("ImplementedAs", snake_case(attr.name))
            kind = result_kind(model, attr.type)
            export = self.export_name(interface, attr.name, "_get")
            body = self.emit_call(interface, attr.name, export, [], [], f"self.{cpp_name}()", kind, attr.type.nullable)
            getter = [f"get {attr.name}() {{", f"    const h = {name}_h(this);"] + ["    " + b for b in body] + ["}"]
            if "LegacyUnforgeable" in ext:
                unforgeable.append((attr, getter))
            else:
                lines.extend("    " + g for g in getter)
                enumerable.append(attr.name)
            if not attr.readonly:
                arg = Arg(model, "value", attr.type, ext=ext)
                stmts, vals = arg.js_convert("value", f"Failed to set the '{attr.name}' property on '{name}'", 0)
                export = self.export_name(interface, attr.name, "_set")
                setter_cpp = ext.get("ImplementedAs", snake_case(attr.name))
                body = self.emit_call(interface, attr.name, export, [vals], arg.cpp_params(0), f"self.set_{setter_cpp}({', '.join(arg.cpp_value(0))})", "status", False)
                lines.append(f"    set {attr.name}(value) {{")
                lines.append(f"        const h = {name}_h(this);")
                for s in stmts + body:
                    lines.append("        " + s)
                lines.append("    }")
            elif "PutForwards" in ext:
                forward = ext["PutForwards"]
                lines.append(f"    set {attr.name}(value) {{")
                lines.append(f"        const target = ReflectApply(getter_{name}_{attr.name}, this, []);")
                lines.append(f"        if (target === null || typeof target !== 'object') throw typeError('[PutForwards] target is not an object');")
                lines.append(f"        ReflectSet(target, '{forward}', value);")
                lines.append("    }")

        for op in interface.regular_operations:
            ext = op.extended_attributes
            if "ImplementedInBindings" in ext:
                enumerable.append(op.name)
                continue
            cpp_name = ext.get("ImplementedAs", snake_case(op.name))
            args = [Arg(model, p.name, p.type, p.optional, p.default_value, p.extended_attributes) for p in op.parameters]
            required = sum(1 for a in args if not a.optional)
            label = f"Failed to execute '{op.name}' on '{name}'"
            kind = result_kind(model, op.return_type)
            params = ", ".join(f"p{i}" for i in range(len(args)))
            lines.append(f"    {op.name}({params}) {{")
            lines.append(f"        const h = {name}_h(this);")
            if required:
                lines.append(f"        if (arguments.length < {required}) throw argCountError({label!r}, {required}, arguments.length);")
            js_vals = []
            for i, a in enumerate(args):
                stmts, vals = a.js_convert(f"p{i}", label, i)
                for s in stmts:
                    lines.append("        " + s)
                js_vals.append(vals)
            cpp_params = [p for i, a in enumerate(args) for p in a.cpp_params(i)]
            cpp_values = [v for i, a in enumerate(args) for v in a.cpp_value(i)]
            export = self.export_name(interface, op.name)
            body = self.emit_call(interface, op.name, export, js_vals, cpp_params, f"self.{cpp_name}({', '.join(cpp_values)})", kind, op.return_type.nullable)
            for b in body:
                lines.append("        " + b)
            lines.append("    }")
            enumerable.append(op.name)
        lines.append("}")

        # Unforgeable getters are defined per instance (in the constructor), once per realm.
        for attr, getter in unforgeable:
            fn = "\n".join(getter).replace(f"get {attr.name}() {{", "function () {", 1)
            lines.append(f"const unforgeable_{name}_{attr.name} = {{ __proto__: null, get: ObjectDefineProperty({fn}, 'name', {{ __proto__: null, value: 'get {attr.name}' }}), enumerable: true, configurable: false }};")
        for attr in interface.regular_attributes:
            if "PutForwards" in attr.extended_attributes:
                lines.append(f"const getter_{name}_{attr.name} = ObjectGetOwnPropertyDescriptor({name}.prototype, '{attr.name}').get;")

        unscopable = [op.name for op in interface.regular_operations if "Unscopable" in op.extended_attributes]
        consts = ", ".join(f"{c.name}: {c.value}" for c in interface.constants)
        ctor_length = 0
        if ctor:
            ctor_length = sum(1 for p in ctor.parameters if not p.optional)
        lines.append(
            f"finishInterface({name}, {{ __proto__: null, name: '{name}', members: {enumerable!r}, constants: {{ __proto__: null, {consts} }}, unscopables: {unscopable!r}, length: {ctor_length} }});"
        )
        lines.append("")

    def run(self):
        model = self.model
        js_head = [
            "// Generated by bindings/generate.py from toy/idl/*.idl. Do not edit.",
            "// Parser: Ladybird's Meta/Utils/webidl_parser.py (BSD-2-Clause).",
            "",
        ]
        decl = []
        for i in model.engine_backed:
            decl.append(f"let {i.name}_is, {i.name}_h, {i.name}_arg;")
            if model.root_of(i) is i:
                decl.append(f"let {i.name}_anchor;")
        # Raw handle readers per root (no brand check; used after a subclass brand check passed).
        roots = sorted({model.root_of(i).name for i in model.engine_backed})
        for r in roots:
            decl.append(f"let {r}_raw;")
        for interface in model.engine_backed:
            self.emit_interface(interface)
        tables = []
        tables.append("const interfaceClasses = [undefined, " + ", ".join(i.name for i in model.engine_backed) + "];")
        tables.append("const interfaceRoots = [undefined, " + ", ".join(f"'{model.root_of(i).name}'" for i in model.engine_backed) + "];")
        tables.append("const exposedInterfaces = { __proto__: null, " + ", ".join(f"{i.name}" for i in model.engine_backed) + " };")
        js = js_head + decl + [""] + self.js + tables

        cpp_head = [
            "// Generated by bindings/generate.py from toy/idl/*.idl. Do not edit.",
            '#include "Bindings.h"',
            "",
            "using namespace ganglion;",
            "using namespace ganglion::bindings;",
            "",
        ]
        ids = [
            "// Generated by bindings/generate.py. Do not edit.",
            "#pragma once",
            "#include <cstdint>",
            "namespace ganglion {",
            "enum class InterfaceId : uint8_t {",
            "    None = 0,",
        ]
        for i in model.engine_backed:
            ids.append(f"    {i.name} = {model.ids[i.name]},")
        ids.append("};")
        parents = ["0"] + [str(model.ids.get(i.parent_name, 0)) for i in model.engine_backed]
        ids.append(f"inline constexpr uint8_t interface_parent[] = {{ {', '.join(parents)} }};")
        ids.append("inline bool is_a(InterfaceId type, InterfaceId base)")
        ids.append("{")
        ids.append("    for (auto t = static_cast<uint8_t>(type); t; t = interface_parent[t])")
        ids.append("        if (t == static_cast<uint8_t>(base))")
        ids.append("            return true;")
        ids.append("    return false;")
        ids.append("}")
        ids.append("}")
        return "\n".join(js) + "\n", "\n".join(cpp_head + self.cpp) + "\n", "\n".join(ids) + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--idl", default=str(ROOT / "toy" / "idl"))
    parser.add_argument("--out", default=str(ROOT / "build" / "gen"))
    args = parser.parse_args()
    model = Model(args.idl)
    js, cpp, ids = Emitter(model).run()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for name, text in (("bindings.gen.js", js), ("Bindings.gen.cpp", cpp), ("InterfaceIds.gen.h", ids)):
        path = out / name
        if not path.exists() or path.read_text() != text:
            path.write_text(text)
    print(f"generate.py: {len(model.engine_backed)} interfaces -> {out}")


if __name__ == "__main__":
    main()
