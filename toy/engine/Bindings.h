// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
/*
 * Helpers for the generated C exports (build/gen/Bindings.gen.cpp).
 *
 * Calling convention between glue and engine:
 *   - Interface arguments and `this` are u32 handles. The glue has already done the WebIDL brand
 *     check (private-field brands, which page JS cannot forge); a handle of the wrong type here
 *     means a glue bug, so the engine traps (fails closed) instead of returning an error.
 *   - Strings in: UTF-16 in the glue-owned input buffer, passed as (pointer, length); a nullable
 *     string passes length 0xffffffff for null.
 *   - Results by kind:
 *       status    i32: 0, or an Error code
 *       handle    i32: handle, 0 for null, or -code
 *       string    i32: length (text at io().out_ptr), -1 for null, or -1-code
 *       bool      i32: 0/1, or -code
 *       int       i32 raw (cannot throw)    double  f64 raw (cannot throw)
 *       atom      i32 atom id (glue caches the text per id)
 *       rect      i32 status; x, y, width, height in io().f[0..3]
 */
#pragma once

#include "Ganglion.h"

#include <type_traits>

#define GANGLION_EXPORT(name) extern "C" __attribute__((export_name(name)))

namespace ganglion::bindings {

struct IO {
    u32 in_ptr;
    u32 in_capacity; // in UTF-16 code units
    u32 out_ptr;
    u32 out_length;
    f64 f[4];
};
IO& io();

inline StringView in_string(u32 ptr, u32 length)
{
    return StringView(reinterpret_cast<char16_t const*>(static_cast<uintptr_t>(ptr)), length);
}

inline std::optional<StringView> in_nullable_string(u32 ptr, u32 length)
{
    if (length == 0xffffffffu)
        return {};
    return in_string(ptr, length);
}

i32 out_string(StringView);

template<typename T>
struct IsExceptionOr : std::false_type { };
template<typename T>
struct IsExceptionOr<ExceptionOr<T>> : std::true_type { };

template<typename T>
T& resolve(u32 handle)
{
    auto* object = Heap::the().resolve_as<T>(handle);
    if (!object)
        __builtin_trap();
    return *object;
}

template<typename T>
T* resolve_nullable(u32 handle)
{
    if (handle == 0)
        return nullptr;
    return &resolve<T>(handle);
}

template<typename F>
i32 status_of(F&& f)
{
    using R = decltype(f());
    if constexpr (std::is_void_v<R>) {
        f();
        return 0;
    } else if constexpr (IsExceptionOr<R>::value) {
        auto r = f();
        return r.is_error() ? static_cast<i32>(r.error()) : 0;
    } else {
        (void)f();
        return 0;
    }
}

inline i32 handle_from(Wrappable* object) { return object ? static_cast<i32>(object->handle()) : 0; }
inline i32 handle_from(Wrappable& object) { return static_cast<i32>(object.handle()); }

template<typename F>
i32 handle_of(F&& f)
{
    using R = decltype(f());
    if constexpr (IsExceptionOr<R>::value) {
        auto r = f();
        if (r.is_error())
            return -static_cast<i32>(r.error());
        return handle_from(r.value());
    } else {
        return handle_from(f());
    }
}

inline i32 out_any(String const& s) { return out_string(s); }
inline i32 out_any(StringView s) { return out_string(s); }
inline i32 out_any(std::optional<String> const& s) { return s ? out_string(*s) : -1; }

template<typename F>
i32 string_of(F&& f)
{
    using R = decltype(f());
    if constexpr (IsExceptionOr<R>::value) {
        auto r = f();
        if (r.is_error())
            return -1 - static_cast<i32>(r.error());
        return out_any(r.value());
    } else {
        return out_any(f());
    }
}

template<typename F>
i32 bool_of(F&& f)
{
    using R = decltype(f());
    if constexpr (IsExceptionOr<R>::value) {
        auto r = f();
        if (r.is_error())
            return -static_cast<i32>(r.error());
        return r.value() ? 1 : 0;
    } else {
        return f() ? 1 : 0;
    }
}

template<typename F>
i32 int_of(F&& f)
{
    static_assert(!IsExceptionOr<decltype(f())>::value, "integer results cannot carry exceptions in this ABI");
    return static_cast<i32>(f());
}

template<typename F>
f64 double_of(F&& f)
{
    static_assert(!IsExceptionOr<decltype(f())>::value, "double results cannot carry exceptions in this ABI");
    return static_cast<f64>(f());
}

template<typename F>
i32 atom_of(F&& f)
{
    return static_cast<i32>(f());
}

template<typename F>
i32 rect_of(F&& f)
{
    Box box = f();
    io().f[0] = box.x;
    io().f[1] = box.y;
    io().f[2] = box.width;
    io().f[3] = box.height;
    return 0;
}

}
