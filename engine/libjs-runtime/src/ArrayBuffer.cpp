// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// ArrayBuffer and the typed arrays: bytes in LibGC's primitive storage (LibGC/CAPI.h), which LibWeb's
// streams and fetch use for every byte that crosses the platform (a font, an image, a stylesheet body).
// No page JavaScript runs in phase 1, so the prototypes are plain named objects and DataView stays
// unimplemented (tools/gen-stubs.py).

#include <AK/Format.h>
#include <AK/StringBuilder.h>
#include <math.h>
#include <Ganglion/Runtime.h>
#include <string.h>

namespace Ganglion {

static constexpr u8 element_sizes[12] = { 1, 1, 2, 4, 8, 1, 2, 4, 8, 2, 4, 8 };
static constexpr StringView typed_array_names[12] = {
    "Uint8Array"sv, "Uint8ClampedArray"sv, "Uint16Array"sv, "Uint32Array"sv, "BigUint64Array"sv, "Int8Array"sv,
    "Int16Array"sv, "Int32Array"sv, "BigInt64Array"sv, "Float16Array"sv, "Float32Array"sv, "Float64Array"sv
};

// --- Classes ---------------------------------------------------------------------------------------------

static void visit_array_buffer(Cell* cell, GCVisitor* v)
{
    visit_object_edges(cell, v);
    auto& buffer = *static_cast<ArrayBufferObject*>(cell);
    visit_value(v, buffer.detach_key);
    if (buffer.storage_kind == JS_ARRAY_BUFFER_STORAGE_EXTERNAL)
        visit_cell(v, buffer.external_owner);
}

static void finalize_array_buffer(Cell* cell)
{
    auto& buffer = *static_cast<ArrayBufferObject*>(cell);
    if (buffer.storage_kind == JS_ARRAY_BUFFER_STORAGE_OWNED)
        gc_primitive_storage_free(buffer.handle);
    buffer.handle = GC_PRIMITIVE_STORAGE_NULL_HANDLE;
    buffer.storage_kind = JS_ARRAY_BUFFER_STORAGE_DETACHED;
    finalize_object_fields(cell);
}

static void visit_typed_array(Cell* cell, GCVisitor* v)
{
    visit_object_edges(cell, v);
    visit_cell(v, static_cast<TypedArray*>(cell)->viewed_array_buffer);
}

Class const class_array_buffer { .id = JS_LAYOUT_CLASS_ID_ARRAY_BUFFER, .flags = 0, .parent = &class_object, .name = "ArrayBuffer", .name_length = 11, .cell_size = sizeof(ArrayBufferObject), .cell_kind = GC_CELL_KIND_OBJECT, .visit = visit_array_buffer, .finalize = finalize_array_buffer, .allocator = nullptr };

#define GANGLION_TYPED_ARRAY_CLASS(id_, name_) \
    { .id = (id_), .flags = 0, .parent = &class_object, .name = name_, .name_length = sizeof(name_) - 1, .cell_size = sizeof(TypedArray), .cell_kind = GC_CELL_KIND_OBJECT, .visit = visit_typed_array, .finalize = finalize_object_fields, .allocator = nullptr }
Class const class_typed_array[12] {
    GANGLION_TYPED_ARRAY_CLASS(JS_LAYOUT_CLASS_ID_UINT8_ARRAY, "Uint8Array"),
    GANGLION_TYPED_ARRAY_CLASS(JS_LAYOUT_CLASS_ID_UINT8_CLAMPED_ARRAY, "Uint8ClampedArray"),
    GANGLION_TYPED_ARRAY_CLASS(JS_LAYOUT_CLASS_ID_UINT16_ARRAY, "Uint16Array"),
    GANGLION_TYPED_ARRAY_CLASS(JS_LAYOUT_CLASS_ID_UINT32_ARRAY, "Uint32Array"),
    GANGLION_TYPED_ARRAY_CLASS(JS_LAYOUT_CLASS_ID_BIG_UINT64_ARRAY, "BigUint64Array"),
    GANGLION_TYPED_ARRAY_CLASS(JS_LAYOUT_CLASS_ID_INT8_ARRAY, "Int8Array"),
    GANGLION_TYPED_ARRAY_CLASS(JS_LAYOUT_CLASS_ID_INT16_ARRAY, "Int16Array"),
    GANGLION_TYPED_ARRAY_CLASS(JS_LAYOUT_CLASS_ID_INT32_ARRAY, "Int32Array"),
    GANGLION_TYPED_ARRAY_CLASS(JS_LAYOUT_CLASS_ID_BIG_INT64_ARRAY, "BigInt64Array"),
    GANGLION_TYPED_ARRAY_CLASS(JS_LAYOUT_CLASS_ID_FLOAT16_ARRAY, "Float16Array"),
    GANGLION_TYPED_ARRAY_CLASS(JS_LAYOUT_CLASS_ID_FLOAT32_ARRAY, "Float32Array"),
    GANGLION_TYPED_ARRAY_CLASS(JS_LAYOUT_CLASS_ID_FLOAT64_ARRAY, "Float64Array"),
};
#undef GANGLION_TYPED_ARRAY_CLASS

static void install_typed_array_members(VM&, Realm&, Object&);
static void install_tag_to_string(VM&, Realm&, Object&);

// --- Prototypes ------------------------------------------------------------------------------------------

static Object* array_buffer_prototype(VM& vm, Realm& realm, bool shared)
{
    auto& intrinsics = *realm.intrinsics;
    auto*& slot = shared ? intrinsics.shared_array_buffer_prototype : intrinsics.array_buffer_prototype;
    if (!slot) {
        slot = named_prototype(vm, realm, intrinsic(vm, realm, JS_INTRINSIC_OBJECT_PROTOTYPE), shared ? "SharedArrayBuffer"sv : "ArrayBuffer"sv);
        install_tag_to_string(vm, realm, *slot);
    }
    return slot;
}

static Object* typed_array_prototype(VM& vm, Realm& realm, u8 kind)
{
    auto& intrinsics = *realm.intrinsics;
    if (!intrinsics.typed_array_base_prototype) {
        intrinsics.typed_array_base_prototype = named_prototype(vm, realm, intrinsic(vm, realm, JS_INTRINSIC_OBJECT_PROTOTYPE), "TypedArray"sv);
        install_typed_array_members(vm, realm, *intrinsics.typed_array_base_prototype);
    }
    auto*& slot = intrinsics.typed_array_prototypes[kind];
    if (!slot)
        slot = named_prototype(vm, realm, intrinsics.typed_array_base_prototype, typed_array_names[kind]);
    return slot;
}

// --- ArrayBuffer -----------------------------------------------------------------------------------------

static ArrayBufferObject& buffer_of(JSObject* object)
{
    auto& buffer = *static_cast<ArrayBufferObject*>(object_of(object));
    VERIFY(buffer.klass->id == JS_LAYOUT_CLASS_ID_ARRAY_BUFFER);
    return buffer;
}

static ArrayBufferObject* new_buffer(VM& vm, Realm& realm, bool shared)
{
    auto* buffer = static_cast<ArrayBufferObject*>(create_object(vm, realm, array_buffer_prototype(vm, realm, shared), class_array_buffer));
    buffer->handle = GC_PRIMITIVE_STORAGE_NULL_HANDLE;
    buffer->storage_kind = JS_ARRAY_BUFFER_STORAGE_OWNED;
    buffer->shared = shared;
    buffer->has_max_byte_length = false;
    buffer->max_byte_length = 0;
    buffer->external_owner = nullptr;
    buffer->external_has_fixed_byte_length = false;
    buffer->external_fixed_byte_length = 0;
    buffer->detach_key = Value::undefined();
    return buffer;
}

static size_t storage_byte_length(ArrayBufferObject const& buffer)
{
    switch (buffer.storage_kind) {
    case JS_ARRAY_BUFFER_STORAGE_DETACHED:
        return 0;
    case JS_ARRAY_BUFFER_STORAGE_EXTERNAL:
        if (buffer.external_has_fixed_byte_length)
            return buffer.external_fixed_byte_length;
        [[fallthrough]];
    default:
        return buffer.handle == GC_PRIMITIVE_STORAGE_NULL_HANDLE ? 0 : gc_primitive_storage_size(buffer.handle);
    }
}

// Owned storage of `length` bytes, or the null handle for none; false when memory ran out.
static bool allocate_owned(ArrayBufferObject& buffer, size_t length, bool zero_fill)
{
    buffer.storage_kind = JS_ARRAY_BUFFER_STORAGE_OWNED;
    buffer.handle = GC_PRIMITIVE_STORAGE_NULL_HANDLE;
    if (length == 0)
        return true;
    return gc_primitive_storage_allocate(length, zero_fill, &buffer.handle, nullptr);
}

extern "C" JSCompletion js_array_buffer_create(JSVM* abi_vm, JSRealm* realm, size_t byte_length, bool shared)
{
    auto& vm = vm_of(abi_vm);
    auto* buffer = new_buffer(vm, *realm_of(realm), shared);
    if (!allocate_owned(*buffer, byte_length, true))
        return throw_range_error(vm, "Out of memory allocating an ArrayBuffer"sv);
    return normal_cell(buffer);
}

extern "C" JSObject* js_array_buffer_create_from_bytes(JSVM* abi_vm, JSRealm* realm, uint8_t const* bytes, size_t length, bool shared)
{
    auto& vm = vm_of(abi_vm);
    auto* buffer = new_buffer(vm, *realm_of(realm), shared);
    VERIFY(allocate_owned(*buffer, length, false));
    if (length)
        memcpy(gc_primitive_storage_data(buffer->handle), bytes, length);
    return object_abi(buffer);
}

Object* try_create_array_buffer_from_bytes(VM& vm, Realm& realm, u8 const* bytes, size_t length)
{
    auto* buffer = new_buffer(vm, realm, false);
    if (!allocate_owned(*buffer, length, false))
        return nullptr;
    if (length)
        memcpy(gc_primitive_storage_data(buffer->handle), bytes, length);
    return buffer;
}

extern "C" JSObject* js_array_buffer_create_adopting_storage(JSVM* abi_vm, JSRealm* realm, uint64_t handle, bool shared)
{
    auto& vm = vm_of(abi_vm);
    auto* buffer = new_buffer(vm, *realm_of(realm), shared);
    buffer->storage_kind = JS_ARRAY_BUFFER_STORAGE_OWNED;
    buffer->handle = handle;
    return object_abi(buffer);
}

static void set_external(ArrayBufferObject& buffer, JSExternalPrimitiveStorage const& storage)
{
    buffer.storage_kind = JS_ARRAY_BUFFER_STORAGE_EXTERNAL;
    buffer.handle = storage.handle;
    buffer.external_owner = storage.owner;
    buffer.external_has_fixed_byte_length = storage.has_fixed_byte_length;
    buffer.external_fixed_byte_length = storage.fixed_byte_length;
}

extern "C" JSObject* js_array_buffer_create_with_external_storage(JSVM* abi_vm, JSRealm* realm, JSExternalPrimitiveStorage const* storage, bool shared)
{
    auto& vm = vm_of(abi_vm);
    auto* buffer = new_buffer(vm, *realm_of(realm), shared);
    set_external(*buffer, *storage);
    return object_abi(buffer);
}

extern "C" JSObject* js_array_buffer_create_from_shared_memory(JSVM*, JSRealm*, int, size_t, uint64_t)
{
    // No shared memory objects in a Worker without threads: the caller treats null as "not possible".
    return nullptr;
}

extern "C" void js_array_buffer_set_external_storage(JSVM*, JSObject* object, JSExternalPrimitiveStorage const* storage, bool shared)
{
    auto& buffer = buffer_of(object);
    if (buffer.storage_kind == JS_ARRAY_BUFFER_STORAGE_OWNED)
        gc_primitive_storage_free(buffer.handle);
    set_external(buffer, *storage);
    buffer.shared = shared;
}

static void describe_storage(ArrayBufferObject const& buffer, JSArrayBufferStorage& out)
{
    out = JSArrayBufferStorage {};
    out.kind = buffer.storage_kind;
    out.handle = buffer.storage_kind == JS_ARRAY_BUFFER_STORAGE_DETACHED ? GC_PRIMITIVE_STORAGE_NULL_HANDLE : buffer.handle;
    if (buffer.storage_kind == JS_ARRAY_BUFFER_STORAGE_EXTERNAL) {
        out.external.owner = buffer.external_owner;
        out.external.handle = buffer.handle;
        out.external.fixed_byte_length = buffer.external_fixed_byte_length;
        out.external.has_fixed_byte_length = buffer.external_has_fixed_byte_length;
    }
    out.shared_memory_object_id = 0;
}

extern "C" void js_array_buffer_storage(JSObject* object, JSArrayBufferStorage* out)
{
    describe_storage(buffer_of(object), *out);
}

extern "C" int js_array_buffer_duplicate_shared_memory(JSObject*, size_t* out_byte_length)
{
    if (out_byte_length)
        *out_byte_length = 0;
    return -1;
}

extern "C" size_t js_array_buffer_byte_length(JSObject* object)
{
    return storage_byte_length(buffer_of(object));
}

extern "C" size_t js_array_buffer_max_byte_length(JSObject* object)
{
    auto& buffer = buffer_of(object);
    return buffer.has_max_byte_length ? buffer.max_byte_length : storage_byte_length(buffer);
}

extern "C" void js_array_buffer_set_max_byte_length(JSObject* object, size_t max_byte_length)
{
    auto& buffer = buffer_of(object);
    buffer.has_max_byte_length = true;
    buffer.max_byte_length = max_byte_length;
}

extern "C" bool js_array_buffer_is_fixed_length(JSObject* object)
{
    return !buffer_of(object).has_max_byte_length;
}

extern "C" bool js_array_buffer_is_detached(JSObject* object)
{
    return buffer_of(object).storage_kind == JS_ARRAY_BUFFER_STORAGE_DETACHED;
}

extern "C" bool js_array_buffer_is_shared_array_buffer(JSObject* object)
{
    return buffer_of(object).shared;
}

extern "C" uint8_t* js_array_buffer_data(JSObject* object, size_t* out_byte_length)
{
    auto& buffer = buffer_of(object);
    *out_byte_length = storage_byte_length(buffer);
    if (buffer.storage_kind == JS_ARRAY_BUFFER_STORAGE_DETACHED || buffer.handle == GC_PRIMITIVE_STORAGE_NULL_HANDLE)
        return nullptr;
    return gc_primitive_storage_data(buffer.handle);
}

// --- What page values need of a typed array the engine holds ---------------------------------------------------
// A typed array the page passes into an engine call is copied into one of these (glue/engine/40-bridge.js pageBytes). WebIDL's
// conversions then treat it as any object: a union with a sequence takes it through @@iterator (DOMMatrix(Float32Array),
// WebGL's uniform1iv(loc, Float32Array)), and a DOMString takes it through toString ("1.5" for a Float32Array). Before these,
// both threw ("Cannot convert object to primitive value") where Chrome converts.

extern "C" JSObject* js_iterator_create_result_object(JSVM*, JSRealm*, JSValue, bool);

static u32 typed_array_length_now(TypedArray const& array)
{
    if (!array.viewed_array_buffer)
        return 0;
    auto const& buffer = *static_cast<ArrayBufferObject const*>(array.viewed_array_buffer);
    auto available = storage_byte_length(buffer);
    if (array.byte_offset > available)
        return 0;
    if (array.array_length_kind == JS_BYTE_LENGTH_LENGTH)
        return static_cast<u64>(array.byte_offset) + static_cast<u64>(array.array_length_value) * array.element_size <= available ? array.array_length_value : 0;
    return static_cast<u32>((available - array.byte_offset) / array.element_size);
}

static double half_to_double(u16 h)
{
    int exponent = (h >> 10) & 0x1f;
    int mantissa = h & 0x3ff;
    double value;
    if (exponent == 0)
        value = mantissa * (1.0 / (1 << 24));
    else if (exponent == 31)
        value = mantissa ? NAN : INFINITY;
    else
        value = (1024 + mantissa) * __builtin_ldexp(1.0, exponent - 25);
    return (h & 0x8000) ? -value : value;
}

// The element at `index` as a Number; false for the BigInt kinds, which these conversions leave alone.
static bool typed_array_element(TypedArray const& array, u32 index, double& out)
{
    auto const& buffer = *static_cast<ArrayBufferObject const*>(array.viewed_array_buffer);
    if (buffer.storage_kind == JS_ARRAY_BUFFER_STORAGE_DETACHED || buffer.handle == GC_PRIMITIVE_STORAGE_NULL_HANDLE)
        return false;
    u8 const* p = gc_primitive_storage_data(buffer.handle) + array.byte_offset + static_cast<size_t>(index) * array.element_size;
    switch (array.array_kind) {
    case 0: case 1: out = p[0]; return true;
    case 2: { u16 v; memcpy(&v, p, 2); out = v; return true; }
    case 3: { u32 v; memcpy(&v, p, 4); out = v; return true; }
    case 5: out = static_cast<i8>(p[0]); return true;
    case 6: { i16 v; memcpy(&v, p, 2); out = v; return true; }
    case 7: { i32 v; memcpy(&v, p, 4); out = v; return true; }
    case 9: { u16 v; memcpy(&v, p, 2); out = half_to_double(v); return true; }
    case 10: { float v; memcpy(&v, p, 4); out = v; return true; }
    case 11: { double v; memcpy(&v, p, 8); out = v; return true; }
    default: return false; // BigUint64Array, BigInt64Array
    }
}

static TypedArray* this_typed_array(VM& vm)
{
    auto this_value = vm.running_execution_context->this_value;
    if (!this_value.is_object())
        return nullptr;
    auto id = this_value.as_object()->klass->id;
    for (auto const& klass : class_typed_array) {
        if (klass.id == id)
            return static_cast<TypedArray*>(this_value.as_object());
    }
    return nullptr;
}

static JSCompletion typed_array_iterator_next(JSVM* abi_vm)
{
    auto& vm = vm_of(abi_vm);
    auto& function = *static_cast<FunctionObject*>(vm.running_execution_context->function);
    auto& realm = *function.realm;
    auto result = [&](Value value, bool done) {
        return normal(Value::from_object(object_of(js_iterator_create_result_object(abi_vm, realm_abi(&realm), value.bits, done))));
    };
    i32 index = function.slot1.as_i32();
    if (index < 0 || !function.slot0.is_object())
        return result(Value::undefined(), true);
    auto& array = *static_cast<TypedArray*>(function.slot0.as_object());
    double element;
    if (static_cast<u32>(index) >= typed_array_length_now(array) || !typed_array_element(array, static_cast<u32>(index), element)) {
        function.slot1 = Value::from_i32(-1);
        return result(Value::undefined(), true);
    }
    function.slot1 = Value::from_i32(index + 1);
    return result(Value::from_double(element), false);
}

// %TypedArray%.prototype.values and [@@iterator]: an object of %Iterator.prototype% with an own `next`, as the engine's
// array iterator is (Misc.cpp).
static JSCompletion typed_array_prototype_values(JSVM* abi_vm)
{
    auto& vm = vm_of(abi_vm);
    auto* array = this_typed_array(vm);
    if (!array)
        return throw_type_error(vm, "this is not a typed array"sv);
    auto& realm = *static_cast<FunctionObject*>(vm.running_execution_context->function)->realm;
    auto* iterator = create_object(vm, realm, intrinsic(vm, realm, JS_INTRINSIC_ITERATOR_PROTOTYPE));
    auto* next = create_native_function(vm, &realm, FunctionKind::Native, typed_array_iterator_next, nullptr, nullptr, 0, Utf16FlyString::from_utf8_without_validation("next"sv), {}, true);
    next->slot0 = Value::from_object(array);
    next->slot1 = Value::from_i32(0);
    define_direct_property(vm, *iterator, vm.keys->next, Value::from_object(next), JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_ENUMERABLE | JS_ATTRIBUTE_CONFIGURABLE);
    return normal(Value::from_object(iterator));
}

// %TypedArray%.prototype.toString is Array.prototype.toString: the elements joined with ",".
static JSCompletion typed_array_prototype_to_string(JSVM* abi_vm)
{
    auto& vm = vm_of(abi_vm);
    auto* array = this_typed_array(vm);
    if (!array)
        return throw_type_error(vm, "this is not a typed array"sv);
    StringBuilder builder;
    auto length = typed_array_length_now(*array);
    for (u32 i = 0; i < length; ++i) {
        if (i)
            builder.append(',');
        double element;
        if (typed_array_element(*array, i, element))
            builder.append(number_to_string(element).to_utf8_but_should_be_ported_to_utf16());
    }
    return normal(Value::from_string(create_string(vm, Utf16String::from_utf8(builder.string_view()))));
}

// Object.prototype.toString's answer for the engine's own buffer objects: "[object ArrayBuffer]".
static JSCompletion tag_to_string(JSVM* abi_vm)
{
    auto& vm = vm_of(abi_vm);
    auto this_value = vm.running_execution_context->this_value;
    if (!this_value.is_object())
        return throw_type_error(vm, "toString called on a non-object"sv);
    return normal(Value::from_string(create_string(vm, Utf16String::formatted("[object {}]", class_name_of(*this_value.as_object())))));
}

static void install_typed_array_members(VM& vm, Realm& realm, Object& prototype)
{
    auto* values = create_native_function(vm, &realm, FunctionKind::Native, typed_array_prototype_values, nullptr, nullptr, 0, Utf16FlyString::from_utf8_without_validation("values"sv), {}, true);
    define_direct_property(vm, prototype, Key::from_symbol(vm.well_known_symbols[5]), Value::from_object(values), JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_CONFIGURABLE);
    auto* to_string = create_native_function(vm, &realm, FunctionKind::Native, typed_array_prototype_to_string, nullptr, nullptr, 0, Utf16FlyString::from_utf8_without_validation("toString"sv), {}, true);
    define_direct_property(vm, prototype, vm.keys->to_string, Value::from_object(to_string), JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_CONFIGURABLE);
}

static void install_tag_to_string(VM& vm, Realm& realm, Object& prototype)
{
    auto* to_string = create_native_function(vm, &realm, FunctionKind::Native, tag_to_string, nullptr, nullptr, 0, Utf16FlyString::from_utf8_without_validation("toString"sv), {}, true);
    define_direct_property(vm, prototype, vm.keys->to_string, Value::from_object(to_string), JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_CONFIGURABLE);
}

static void detach(ArrayBufferObject& buffer)
{
    if (buffer.storage_kind == JS_ARRAY_BUFFER_STORAGE_OWNED)
        gc_primitive_storage_free(buffer.handle);
    buffer.storage_kind = JS_ARRAY_BUFFER_STORAGE_DETACHED;
    buffer.handle = GC_PRIMITIVE_STORAGE_NULL_HANDLE;
    buffer.external_owner = nullptr;
}

extern "C" JSCompletion js_array_buffer_detach(JSVM* abi_vm, JSObject* object, JSValue key)
{
    auto& vm = vm_of(abi_vm);
    auto& buffer = buffer_of(object);
    VERIFY(!buffer.shared);
    if (!same_value(buffer.detach_key, Value { key }))
        return throw_type_error(vm, "ArrayBuffer detach key mismatch"sv);
    detach(buffer);
    return normal();
}

extern "C" JSCompletion js_array_buffer_detach_and_take_storage(JSVM* abi_vm, JSObject* object, JSArrayBufferStorage* out)
{
    auto& vm = vm_of(abi_vm);
    auto& buffer = buffer_of(object);
    VERIFY(!buffer.shared);
    if (!buffer.detach_key.is_undefined())
        return throw_type_error(vm, "ArrayBuffer has a detach key"sv);
    describe_storage(buffer, *out);
    // The caller owns the storage now: detach without freeing it.
    buffer.storage_kind = JS_ARRAY_BUFFER_STORAGE_DETACHED;
    buffer.handle = GC_PRIMITIVE_STORAGE_NULL_HANDLE;
    buffer.external_owner = nullptr;
    return normal();
}

extern "C" JSCompletion js_array_buffer_clone(JSVM* abi_vm, JSObject* object, size_t byte_offset, size_t length)
{
    auto& vm = vm_of(abi_vm);
    auto& source = buffer_of(object);
    VERIFY(byte_offset + length <= storage_byte_length(source));
    auto* realm = current_realm(vm);
    VERIFY(realm);
    auto* clone = new_buffer(vm, *realm, false);
    if (!allocate_owned(*clone, length, false))
        return throw_range_error(vm, "Out of memory cloning an ArrayBuffer"sv);
    if (length)
        memcpy(gc_primitive_storage_data(clone->handle), gc_primitive_storage_data(source.handle) + byte_offset, length);
    return normal_cell(clone);
}

extern "C" JSValue js_array_buffer_detach_key(JSObject* object)
{
    return buffer_of(object).detach_key.bits;
}

extern "C" void js_array_buffer_set_detach_key(JSObject* object, JSValue key)
{
    buffer_of(object).detach_key = Value { key };
}

// --- Typed arrays ----------------------------------------------------------------------------------------


static TypedArray& typed_array_of(JSObject* object)
{
    auto& array = *static_cast<TypedArray*>(object_of(object));
    VERIFY(array.flags & JS_LAYOUT_OBJECT_FLAG_IS_TYPED_ARRAY);
    return array;
}

static TypedArray* new_typed_array(VM& vm, Realm& realm, u8 kind, ArrayBufferObject& buffer, JSByteLength array_length, JSByteLength byte_length, u32 byte_offset)
{
    VERIFY(kind < 12);
    auto* array = static_cast<TypedArray*>(create_object(vm, realm, typed_array_prototype(vm, realm, kind), class_typed_array[kind]));
    array->flags |= JS_LAYOUT_OBJECT_FLAG_IS_TYPED_ARRAY | JS_LAYOUT_OBJECT_FLAG_MAY_INTERFERE_WITH_INDEXED_PROPERTY_ACCESS;
    array->viewed_array_buffer = &buffer;
    array->array_kind = kind;
    array->element_size = element_sizes[kind];
    array->array_length_value = array_length.length;
    array->array_length_kind = array_length.kind;
    array->byte_offset = byte_offset;
    array->byte_length_value = byte_length.length;
    array->byte_length_kind = byte_length.kind;
    return array;
}

static double number_of(Value value)
{
    if (value.is_int32())
        return value.as_i32();
    if (value.is_double())
        return value.as_double();
    return __builtin_nan("");
}

// new Uint8Array(buffer, byteOffset, length) and its eleven siblings, the shape LibWeb's streams construct
// (ReadableStreamOperations.cpp: "! Construct(%Uint8Array%, « buffer, byteOffset, byteLength »)"). The kind
// is in the function's slot0. Other argument shapes (a length, an array, an iterable) are not needed without
// page JavaScript and throw.
static JSCompletion typed_array_constructor_behaviour(JSVM* abi_vm)
{
    auto& vm = vm_of(abi_vm);
    auto& context = *vm.running_execution_context;
    auto kind = static_cast<u8>(number_of(context.function->slot0));
    VERIFY(kind < 12);
    auto first = context.argument(0);
    if (!first.is_object() || first.as_object()->klass->id != JS_LAYOUT_CLASS_ID_ARRAY_BUFFER)
        return throw_type_error(vm, "This build constructs typed arrays over an ArrayBuffer only"sv);
    auto& buffer = *static_cast<ArrayBufferObject*>(first.as_object());
    auto element_size = element_sizes[kind];
    auto byte_offset_value = context.argument(1);
    double byte_offset = byte_offset_value.is_undefined() ? 0 : number_of(byte_offset_value);
    if (!(byte_offset >= 0) || byte_offset != static_cast<u64>(byte_offset) || static_cast<u64>(byte_offset) % element_size != 0)
        return throw_range_error(vm, "Invalid typed array byte offset"sv);
    if (buffer.storage_kind == JS_ARRAY_BUFFER_STORAGE_DETACHED)
        return throw_type_error(vm, "ArrayBuffer is detached"sv);
    auto buffer_byte_length = storage_byte_length(buffer);
    auto length_value = context.argument(2);
    u64 new_byte_length;
    if (length_value.is_undefined()) {
        if (buffer_byte_length % element_size != 0 || byte_offset > buffer_byte_length)
            return throw_range_error(vm, "Invalid typed array length"sv);
        new_byte_length = buffer_byte_length - static_cast<u64>(byte_offset);
    } else {
        double length = number_of(length_value);
        if (!(length >= 0) || length != static_cast<u64>(length))
            return throw_range_error(vm, "Invalid typed array length"sv);
        new_byte_length = static_cast<u64>(length) * element_size;
        if (static_cast<u64>(byte_offset) + new_byte_length > buffer_byte_length)
            return throw_range_error(vm, "Typed array does not fit in its buffer"sv);
    }
    auto* realm = current_realm(vm);
    VERIFY(realm);
    auto* array = new_typed_array(vm, *realm, kind, buffer,
        { static_cast<u32>(new_byte_length / element_size), JS_BYTE_LENGTH_LENGTH },
        { static_cast<u32>(new_byte_length), JS_BYTE_LENGTH_LENGTH },
        static_cast<u32>(byte_offset));
    return normal(Value::from_object(array));
}

Object* typed_array_constructor(VM& vm, Realm& realm, u8 kind)
{
    VERIFY(kind < 12);
    auto* prototype = typed_array_prototype(vm, realm, kind);
    auto* function = create_native_function(vm, &realm, FunctionKind::Native, typed_array_constructor_behaviour, nullptr, nullptr, 3, Utf16FlyString::from_utf8_without_validation(typed_array_names[kind]), {}, true);
    function->is_constructor = true;
    function->slot0 = Value::from_double(kind);
    define_direct_property(vm, *function, vm.keys->prototype, Value::from_object(prototype), 0);
    define_direct_property(vm, *prototype, vm.keys->constructor, Value::from_object(function), JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_CONFIGURABLE);
    return function;
}

extern "C" JSCompletion js_typed_array_create(JSVM* abi_vm, JSRealm* abi_realm, uint8_t kind, uint32_t length)
{
    auto& vm = vm_of(abi_vm);
    auto& realm = *realm_of(abi_realm);
    VERIFY(kind < 12);
    u64 byte_length = static_cast<u64>(length) * element_sizes[kind];
    if (byte_length > static_cast<u64>(NumericLimits<u32>::max()))
        return throw_range_error(vm, "Invalid typed array length"sv);
    auto* buffer = new_buffer(vm, realm, false);
    if (!allocate_owned(*buffer, static_cast<size_t>(byte_length), true))
        return throw_range_error(vm, "Out of memory allocating a typed array"sv);
    auto* array = new_typed_array(vm, realm, kind, *buffer, { length, JS_BYTE_LENGTH_LENGTH }, { static_cast<u32>(byte_length), JS_BYTE_LENGTH_LENGTH }, 0);
    return normal_cell(array);
}

extern "C" JSObject* js_typed_array_create_on_buffer(JSVM* abi_vm, JSRealm* abi_realm, uint8_t kind, uint32_t length, JSObject* abi_buffer)
{
    auto& vm = vm_of(abi_vm);
    VERIFY(kind < 12);
    auto& buffer = buffer_of(abi_buffer);
    u64 byte_length = static_cast<u64>(length) * element_sizes[kind];
    VERIFY(byte_length <= storage_byte_length(buffer));
    return object_abi(new_typed_array(vm, *realm_of(abi_realm), kind, buffer, { length, JS_BYTE_LENGTH_LENGTH }, { static_cast<u32>(byte_length), JS_BYTE_LENGTH_LENGTH }, 0));
}

extern "C" JSObject* js_typed_array_create_from_slots(JSVM* abi_vm, JSRealm* abi_realm, uint8_t kind, JSObject* abi_buffer, JSByteLength array_length, JSByteLength byte_length, uint32_t byte_offset)
{
    auto& vm = vm_of(abi_vm);
    return object_abi(new_typed_array(vm, *realm_of(abi_realm), kind, buffer_of(abi_buffer), array_length, byte_length, byte_offset));
}

extern "C" JSObject* js_typed_array_viewed_array_buffer(JSObject* object)
{
    return object_abi(typed_array_of(object).viewed_array_buffer);
}

extern "C" JSByteLength js_typed_array_byte_length(JSObject* object)
{
    auto& array = typed_array_of(object);
    return { array.byte_length_value, array.byte_length_kind };
}

extern "C" JSTypedArrayWithBufferWitness js_typed_array_make_witness_record(JSObject* object, uint8_t)
{
    auto& array = typed_array_of(object);
    auto& buffer = *static_cast<ArrayBufferObject*>(array.viewed_array_buffer);
    JSByteLength cached { 0, JS_BYTE_LENGTH_DETACHED };
    if (buffer.storage_kind != JS_ARRAY_BUFFER_STORAGE_DETACHED)
        cached = { static_cast<u32>(storage_byte_length(buffer)), JS_BYTE_LENGTH_LENGTH };
    return { object, cached };
}

// IsTypedArrayOutOfBounds(taRecord).
extern "C" bool js_typed_array_is_out_of_bounds(JSTypedArrayWithBufferWitness const* record)
{
    auto& array = typed_array_of(record->typed_array);
    if (record->cached_buffer_byte_length.kind == JS_BYTE_LENGTH_DETACHED)
        return true;
    u64 buffer_byte_length = record->cached_buffer_byte_length.length;
    u64 byte_offset_start = array.byte_offset;
    u64 byte_offset_end = array.array_length_kind == JS_BYTE_LENGTH_AUTO
        ? buffer_byte_length
        : byte_offset_start + static_cast<u64>(array.array_length_value) * array.element_size;
    return byte_offset_start > buffer_byte_length || byte_offset_end > buffer_byte_length;
}

// TypedArrayLength(taRecord), of a typed array that is not out of bounds.
extern "C" uint32_t js_typed_array_length_of_witness(JSTypedArrayWithBufferWitness const* record)
{
    auto& array = typed_array_of(record->typed_array);
    if (array.array_length_kind != JS_BYTE_LENGTH_AUTO)
        return array.array_length_value;
    u64 buffer_byte_length = record->cached_buffer_byte_length.length;
    return static_cast<u32>((buffer_byte_length - array.byte_offset) / array.element_size);
}

// TypedArrayByteLength(taRecord).
extern "C" uint32_t js_typed_array_byte_length_of_witness(JSTypedArrayWithBufferWitness const* record)
{
    if (js_typed_array_is_out_of_bounds(record))
        return 0;
    auto& array = typed_array_of(record->typed_array);
    return js_typed_array_length_of_witness(record) * array.element_size;
}

}
