// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Values: strings, the abstract operations on primitives (ToString, ToNumber, ToPrimitive, ToObject,
// SameValue), and primitive wrapper objects.

#include <AK/StringConversions.h>
#include <AK/Format.h>
#include <AK/StringBuilder.h>
#include <Ganglion/Runtime.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

namespace Ganglion {

Value Value::from_double(double d)
{
    if (d == static_cast<i32>(d) && !(d == 0 && signbit(d)))
        return from_i32(static_cast<i32>(d));
    if (isnan(d))
        return Value { CANON_NAN_BITS };
    return Value { bit_cast<u64>(d) };
}

double Value::as_double() const
{
    if (is_int32())
        return as_i32();
    return bit_cast<double>(bits);
}

// --- Strings -------------------------------------------------------------------------------------------

Utf16View view_of(JSUtf16View view)
{
    if (view.length_in_code_units == 0)
        return {};
    if (view.has_ascii_storage)
        return Utf16View { StringView { static_cast<char const*>(view.data), view.length_in_code_units } };
    return Utf16View { static_cast<char16_t const*>(view.data), view.length_in_code_units };
}

JSUtf16View abi_view(Utf16View view)
{
    if (view.has_ascii_storage())
        return { view.ascii_span().data(), view.length_in_code_units(), true };
    return { view.utf16_span().data(), view.length_in_code_units(), false };
}

PrimitiveString* create_string(VM& vm, Utf16String string)
{
    auto* cell = allocate<PrimitiveString>(vm, class_string);
    cell->string_raw = move(string).into_raw();
    return cell;
}

PrimitiveString* create_string(VM& vm, Utf16View view)
{
    return create_string(vm, Utf16String::from_utf16(view));
}

Utf16String string_of(PrimitiveString const* string)
{
    return Utf16String::from_raw(string->string_raw);
}

Utf16View string_view(PrimitiveString const* string)
{
    // The view borrows the string's storage, which the cell keeps alive. A short string (up to 3 ASCII characters on wasm32)
    // has no storage of its own: its characters are inside the raw word, so the view must point into the cell's word, not into
    // a local Utf16String made from it (that view dangled: "0.5", "3" or "1e3" read back as garbage, ToNumber gave NaN and
    // IntersectionObserver's threshold "0.5" threw on cnn.com). Utf16String is that word and nothing else.
    static_assert(sizeof(Utf16String) == sizeof(string->string_raw));
    return reinterpret_cast<Utf16String const*>(&string->string_raw)->utf16_view();
}

Utf16String number_to_string(double d)
{
    if (isnan(d))
        return "NaN"_utf16;
    if (isinf(d))
        return d < 0 ? "-Infinity"_utf16 : "Infinity"_utf16;
    if (d == 0)
        return "0"_utf16;
    if (d == trunc(d) && fabs(d) < 1e21) {
        if (fabs(d) < 9007199254740992.0)
            return Utf16String::number(static_cast<i64>(d));
    }
    char buffer[40];
    // The shortest decimal that reads back as the same double, in the forms JavaScript uses.
    for (int precision = 1; precision <= 17; ++precision) {
        snprintf(buffer, sizeof(buffer), "%.*g", precision, d);
        if (strtod(buffer, nullptr) == d)
            break;
    }
    StringView text { buffer, strlen(buffer) };
    // C's %g writes exponents as e+07; JavaScript writes e+7, and uses exponents only beyond 1e21 / below 1e-7.
    auto e = text.find('e');
    if (!e.has_value())
        return Utf16String::from_utf8(text);
    StringBuilder builder;
    builder.append(text.substring_view(0, *e));
    auto exponent_text = text.substring_view(*e + 1);
    int exponent = atoi(exponent_text.characters_without_null_termination());
    if (exponent >= -7 && exponent < 21) {
        // Expand: digits (without the point) shifted by the exponent.
        auto mantissa = builder.string_view();
        bool negative = mantissa.starts_with('-');
        if (negative)
            mantissa = mantissa.substring_view(1);
        StringBuilder digits;
        int point = -1;
        for (size_t i = 0; i < mantissa.length(); ++i) {
            if (mantissa[i] == '.')
                point = static_cast<int>(i);
            else
                digits.append(mantissa[i]);
        }
        int integer_digits = (point == -1 ? static_cast<int>(mantissa.length()) : point) + exponent;
        auto all = digits.string_view();
        StringBuilder out;
        if (negative)
            out.append('-');
        if (integer_digits <= 0) {
            out.append("0."sv);
            for (int i = integer_digits; i < 0; ++i)
                out.append('0');
            out.append(all);
        } else if (static_cast<size_t>(integer_digits) >= all.length()) {
            out.append(all);
            for (size_t i = all.length(); i < static_cast<size_t>(integer_digits); ++i)
                out.append('0');
        } else {
            out.append(all.substring_view(0, integer_digits));
            out.append('.');
            out.append(all.substring_view(integer_digits));
        }
        return Utf16String::from_utf8(out.string_view());
    }
    builder.append('e');
    builder.append(exponent < 0 ? '-' : '+');
    builder.appendff("{}", abs(exponent));
    return Utf16String::from_utf8(builder.string_view());
}

PrimitiveString* key_to_string(VM& vm, Key key)
{
    if (key.is_string())
        return create_string(vm, Utf16String { key.as_fly_string() });
    if (key.is_number())
        return create_string(vm, Utf16String::number(key.as_number()));
    VERIFY_NOT_REACHED();
}

Value key_to_value(VM& vm, Key key)
{
    if (key.is_symbol())
        return Value::from_symbol(key.as_symbol());
    return Value::from_string(key_to_string(vm, key));
}

extern "C" JSPrimitiveString* js_string_create_from_utf16_view(JSVM* vm, JSUtf16View view)
{
    return reinterpret_cast<JSPrimitiveString*>(create_string(vm_of(vm), view_of(view)));
}

extern "C" JSPrimitiveString* js_string_create_from_owned_utf16_string(JSVM* vm, JSOwnedUtf16String string)
{
    return reinterpret_cast<JSPrimitiveString*>(create_string(vm_of(vm), Utf16String::adopt_raw(string)));
}

extern "C" JSPrimitiveString* js_string_create_from_utf16_fly_string(JSVM* vm, size_t fly_string)
{
    return reinterpret_cast<JSPrimitiveString*>(create_string(vm_of(vm), Utf16String { Utf16FlyString::from_raw(fly_string) }));
}

extern "C" JSPrimitiveString* js_string_create_from_unsigned_integer(JSVM* vm, uint64_t number)
{
    return reinterpret_cast<JSPrimitiveString*>(create_string(vm_of(vm), Utf16String::number(number)));
}

extern "C" JSOwnedUtf16String js_string_utf16_string(JSPrimitiveString* string)
{
    return string_of(reinterpret_cast<PrimitiveString*>(string)).into_raw();
}

extern "C" JSUtf16View js_string_utf16_view(JSPrimitiveString* string)
{
    return abi_view(string_view(reinterpret_cast<PrimitiveString*>(string)));
}

extern "C" size_t js_string_length_in_code_units(JSPrimitiveString* string)
{
    return string_view(reinterpret_cast<PrimitiveString*>(string)).length_in_code_units();
}

extern "C" bool js_string_equals(JSPrimitiveString* lhs, JSPrimitiveString* rhs)
{
    return string_view(reinterpret_cast<PrimitiveString*>(lhs)) == string_view(reinterpret_cast<PrimitiveString*>(rhs));
}

// --- Conversions ---------------------------------------------------------------------------------------

bool to_boolean(Value value)
{
    if (value.is_boolean())
        return value.as_bool();
    if (value.is_nullish() || value.is_empty())
        return false;
    if (value.is_number()) {
        auto d = value.as_double();
        return !(d == 0 || isnan(d));
    }
    if (value.is_string())
        return string_view(value.as_string()).length_in_code_units() != 0;
    return true; // objects, symbols, bigints
}

Utf16String to_string_without_side_effects(VM& vm, Value value)
{
    if (value.is_undefined())
        return "undefined"_utf16;
    if (value.is_null())
        return "null"_utf16;
    if (value.is_empty())
        return "<empty>"_utf16;
    if (value.is_boolean())
        return value.as_bool() ? "true"_utf16 : "false"_utf16;
    if (value.is_number())
        return number_to_string(value.as_double());
    if (value.is_string())
        return string_of(value.as_string());
    if (value.is_symbol())
        return Utf16String::adopt_raw(js_symbol_descriptive_string(reinterpret_cast<JSSymbol*>(value.as_symbol())));
    if (value.is_object()) {
        auto& object = *value.as_object();
        if (object.klass->id == JS_LAYOUT_CLASS_ID_ERROR || (object.klass->parent && object.klass->parent->id == JS_LAYOUT_CLASS_ID_ERROR)) {
            auto* message = find_own_property(object, vm.keys->message);
            if (message && message->kind == PropertyKind::Data && message->value.is_string())
                return Utf16String::formatted("[{}: {}]", StringView { object.klass->name, object.klass->name_length }, string_view(message->value.as_string()));
        }
        if (is_function_object(object))
            return "[function]"_utf16;
        return Utf16String::formatted("[object {}]", class_name_of(object));
    }
    return "<value>"_utf16;
}

JSCompletion to_primitive(VM& vm, Value value, int hint)
{
    if (!value.is_object())
        return normal(value);
    auto& object = *value.as_object();
    // OrdinaryToPrimitive: toString first for a string hint, valueOf first otherwise.
    Key order[2] = { hint == 1 ? vm.keys->to_string : vm.keys->value_of, hint == 1 ? vm.keys->value_of : vm.keys->to_string };
    for (auto key : order) {
        auto method = internal_get(vm, object, key, value, JS_PROPERTY_LOOKUP_PHASE_OWN_PROPERTY);
        if (is_throw(method))
            return method;
        if (!is_callable(value_of(method)))
            continue;
        auto result = call(vm, value_of(method), value, nullptr, 0);
        if (is_throw(result))
            return result;
        if (!value_of(result).is_object())
            return result;
    }
    return throw_type_error(vm, "Cannot convert object to primitive value"sv);
}

JSCompletion to_string(VM& vm, Value value, Utf16String& out)
{
    if (value.is_symbol())
        return throw_type_error(vm, "Cannot convert symbol to string"sv);
    if (value.is_object()) {
        auto primitive = to_primitive(vm, value, 1);
        if (is_throw(primitive))
            return primitive;
        value = value_of(primitive);
        if (value.is_symbol())
            return throw_type_error(vm, "Cannot convert symbol to string"sv);
    }
    out = to_string_without_side_effects(vm, value);
    return normal();
}

static double string_to_number(Utf16View view)
{
    // WhiteSpace and LineTerminator (ECMA-262 12.2, 12.3). A UTF-16 literal: a UTF-8 "..."sv with non-ASCII
    // characters becomes a Utf16View through its ASCII constructor, whose VERIFY traps.
    auto trimmed = view.trim(u" \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"sv);
    if (trimmed.is_empty())
        return 0;
    auto utf8 = trimmed.to_utf8_but_should_be_ported_to_utf16();
    StringView text = utf8;
    if (text == "Infinity"sv || text == "+Infinity"sv)
        return INFINITY;
    if (text == "-Infinity"sv)
        return -INFINITY;
    if (text.starts_with("0x"sv) || text.starts_with("0X"sv)) {
        auto number = text.substring_view(2).to_number<u64>(TrimWhitespace::No, 16);
        return number.has_value() ? static_cast<double>(*number) : NAN;
    }
    if (text.starts_with("0o"sv) || text.starts_with("0O"sv)) {
        auto number = text.substring_view(2).to_number<u64>(TrimWhitespace::No, 8);
        return number.has_value() ? static_cast<double>(*number) : NAN;
    }
    if (text.starts_with("0b"sv) || text.starts_with("0B"sv)) {
        auto number = text.substring_view(2).to_number<u64>(TrimWhitespace::No, 2);
        return number.has_value() ? static_cast<double>(*number) : NAN;
    }
    auto parsed = AK::parse_number<double>(text, TrimWhitespace::No);
    return parsed.has_value() ? *parsed : NAN;
}

JSCompletion to_number(VM& vm, Value value, double& out)
{
    if (value.is_number()) {
        out = value.as_double();
        return normal();
    }
    if (value.is_undefined()) {
        out = NAN;
        return normal();
    }
    if (value.is_null()) {
        out = 0;
        return normal();
    }
    if (value.is_boolean()) {
        out = value.as_bool() ? 1 : 0;
        return normal();
    }
    if (value.is_string()) {
        out = string_to_number(string_view(value.as_string()));
        return normal();
    }
    if (value.is_symbol())
        return throw_type_error(vm, "Cannot convert symbol to number"sv);
    if (value.is_bigint())
        return throw_type_error(vm, "Cannot convert BigInt to number"sv);
    auto primitive = to_primitive(vm, value, 2);
    if (is_throw(primitive))
        return primitive;
    return to_number(vm, value_of(primitive), out);
}

JSCompletion to_object(VM& vm, Value value)
{
    if (value.is_object())
        return normal_cell(value.as_object());
    if (value.is_nullish())
        return throw_type_error(vm, "ToObject on null or undefined"sv);
    auto& realm = *current_realm(vm);
    Object* wrapper = nullptr;
    if (value.is_boolean())
        wrapper = create_object(vm, realm, intrinsic(vm, realm, JS_INTRINSIC_OBJECT_PROTOTYPE), class_boolean_object);
    else if (value.is_number())
        wrapper = create_object(vm, realm, intrinsic(vm, realm, JS_INTRINSIC_OBJECT_PROTOTYPE), class_number_object);
    else if (value.is_string())
        wrapper = create_object(vm, realm, intrinsic(vm, realm, JS_INTRINSIC_STRING_PROTOTYPE), class_string_object);
    else
        return throw_type_error(vm, "ToObject of an unsupported primitive"sv);
    static_cast<PrimitiveWrapper*>(wrapper)->primitive = value;
    return normal_cell(wrapper);
}

bool same_value(Value a, Value b)
{
    if (a.is_number() && b.is_number()) {
        double x = a.as_double(), y = b.as_double();
        if (isnan(x) && isnan(y))
            return true;
        if (x == 0 && y == 0)
            return signbit(x) == signbit(y);
        return x == y;
    }
    return strict_equals(a, b);
}

bool same_value_zero(Value a, Value b)
{
    if (a.is_number() && b.is_number()) {
        double x = a.as_double(), y = b.as_double();
        if (isnan(x) && isnan(y))
            return true;
        return x == y;
    }
    return strict_equals(a, b);
}

bool strict_equals(Value a, Value b)
{
    if (a.is_number() && b.is_number())
        return a.as_double() == b.as_double();
    if (a.is_string() && b.is_string())
        return string_view(a.as_string()) == string_view(b.as_string());
    return a.bits == b.bits;
}

extern "C" bool js_value_to_boolean(JSValue value)
{
    return to_boolean(Value { value });
}

extern "C" bool js_value_same_value(JSValue lhs, JSValue rhs)
{
    return same_value(Value { lhs }, Value { rhs });
}

extern "C" bool js_value_same_value_zero(JSValue lhs, JSValue rhs)
{
    return same_value_zero(Value { lhs }, Value { rhs });
}

extern "C" bool js_value_can_be_held_weakly(JSValue value)
{
    Value v { value };
    return v.is_object() || (v.is_symbol() && !v.as_symbol()->is_global);
}

extern "C" bool js_value_is_constructor(JSValue value)
{
    return is_constructor(Value { value });
}

extern "C" JSCompletion js_value_is_array(JSVM*, JSValue value)
{
    Value v { value };
    return normal(v.is_object() && v.as_object()->klass->id == JS_LAYOUT_CLASS_ID_ARRAY);
}

extern "C" JSOwnedUtf16String js_value_to_utf16_string_without_side_effects(JSValue value)
{
    // The VM is process-wide: there is one, and its address is the facade's.
    return to_string_without_side_effects(*g_vm, Value { value }).into_raw();
}

extern "C" JSCompletion js_value_to_utf16_string(JSVM* vm, JSValue value, JSOwnedUtf16String* out)
{
    Utf16String string;
    auto completion = to_string(vm_of(vm), Value { value }, string);
    if (is_throw(completion))
        return completion;
    *out = move(string).into_raw();
    return normal();
}

extern "C" JSCompletion js_value_to_number(JSVM* vm, JSValue value)
{
    double d;
    auto completion = to_number(vm_of(vm), Value { value }, d);
    if (is_throw(completion))
        return completion;
    return normal(Value::from_double(d));
}

extern "C" JSCompletion js_value_to_double(JSVM* vm, JSValue value, double* out)
{
    return to_number(vm_of(vm), Value { value }, *out);
}

static double to_integer_or_infinity(double d)
{
    if (isnan(d))
        return 0;
    if (isinf(d))
        return d;
    return trunc(d);
}

extern "C" JSCompletion js_value_to_i32(JSVM* vm, JSValue value, int32_t* out)
{
    double d;
    auto completion = to_number(vm_of(vm), Value { value }, d);
    if (is_throw(completion))
        return completion;
    if (isnan(d) || isinf(d)) {
        *out = 0;
        return normal();
    }
    double m = fmod(trunc(d), 4294967296.0);
    if (m < 0)
        m += 4294967296.0;
    *out = static_cast<i32>(static_cast<u32>(m));
    return normal();
}

extern "C" JSCompletion js_value_to_u32(JSVM* vm, JSValue value, uint32_t* out)
{
    int32_t i;
    auto completion = js_value_to_i32(vm, value, &i);
    *out = static_cast<u32>(i);
    return completion;
}

extern "C" JSCompletion js_value_to_u16(JSVM* vm, JSValue value, uint16_t* out)
{
    int32_t i;
    auto completion = js_value_to_i32(vm, value, &i);
    *out = static_cast<u16>(static_cast<u32>(i) & 0xFFFF);
    return completion;
}

extern "C" JSCompletion js_value_to_u8(JSVM* vm, JSValue value, uint8_t* out)
{
    int32_t i;
    auto completion = js_value_to_i32(vm, value, &i);
    *out = static_cast<u8>(static_cast<u32>(i) & 0xFF);
    return completion;
}

extern "C" JSCompletion js_value_to_length(JSVM* vm, JSValue value, uint64_t* out)
{
    double d;
    auto completion = to_number(vm_of(vm), Value { value }, d);
    if (is_throw(completion))
        return completion;
    d = to_integer_or_infinity(d);
    if (d <= 0)
        *out = 0;
    else
        *out = static_cast<u64>(min(d, 9007199254740991.0));
    return normal();
}

extern "C" JSCompletion js_value_to_object(JSVM* vm, JSValue value)
{
    return to_object(vm_of(vm), Value { value });
}

extern "C" JSCompletion js_value_to_bigint(JSVM* vm, JSValue)
{
    return throw_type_error(vm_of(vm), "BigInt is not available in this build"sv);
}

extern "C" JSCompletion js_value_to_bigint_uint64(JSVM* vm, JSValue, uint64_t*)
{
    return throw_type_error(vm_of(vm), "BigInt is not available in this build"sv);
}

// --- Primitive wrappers --------------------------------------------------------------------------------

extern "C" JSObject* js_primitive_wrapper_create_boolean(JSVM* abi_vm, JSRealm* abi_realm, bool value)
{
    auto& vm = vm_of(abi_vm);
    auto& realm = *realm_of(abi_realm);
    auto* object = create_object(vm, realm, intrinsic(vm, realm, JS_INTRINSIC_OBJECT_PROTOTYPE), class_boolean_object);
    static_cast<PrimitiveWrapper*>(object)->primitive = Value::boolean(value);
    return object_abi(object);
}

extern "C" JSObject* js_primitive_wrapper_create_number(JSVM* abi_vm, JSRealm* abi_realm, double value)
{
    auto& vm = vm_of(abi_vm);
    auto& realm = *realm_of(abi_realm);
    auto* object = create_object(vm, realm, intrinsic(vm, realm, JS_INTRINSIC_OBJECT_PROTOTYPE), class_number_object);
    static_cast<PrimitiveWrapper*>(object)->primitive = Value::from_double(value);
    return object_abi(object);
}

extern "C" JSObject* js_primitive_wrapper_create_string(JSVM* abi_vm, JSRealm* abi_realm, JSPrimitiveString* string, JSObject* prototype)
{
    auto& vm = vm_of(abi_vm);
    auto& realm = *realm_of(abi_realm);
    auto* object = create_object(vm, realm, prototype ? object_of(prototype) : intrinsic(vm, realm, JS_INTRINSIC_STRING_PROTOTYPE), class_string_object);
    static_cast<PrimitiveWrapper*>(object)->primitive = Value::from_string(reinterpret_cast<PrimitiveString*>(string));
    return object_abi(object);
}

extern "C" bool js_primitive_wrapper_boolean(JSObject* object)
{
    return static_cast<PrimitiveWrapper*>(object_of(object))->primitive.as_bool();
}

extern "C" double js_primitive_wrapper_number(JSObject* object)
{
    return static_cast<PrimitiveWrapper*>(object_of(object))->primitive.as_double();
}

extern "C" JSPrimitiveString* js_primitive_wrapper_string(JSObject* object)
{
    return reinterpret_cast<JSPrimitiveString*>(static_cast<PrimitiveWrapper*>(object_of(object))->primitive.as_string());
}

}
