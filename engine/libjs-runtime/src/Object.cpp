// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Objects: property storage, the ordinary internal methods, dispatch to a host class's hooks, and the
// js_object_* and js_host_* functions of the ABI.

#include <AK/Format.h>
#include <AK/QuickSort.h>
#include <Ganglion/Runtime.h>

namespace Ganglion {

// --- Creation ------------------------------------------------------------------------------------------

Shape* create_shape(VM& vm, Realm& realm, Object* prototype)
{
    auto* shape = allocate<Shape>(vm, class_shape);
    shape->realm = &realm;
    shape->prototype = prototype;
    return shape;
}

Object* create_object(VM& vm, Realm& realm, Object* prototype, Class const& klass)
{
    auto* object = allocate<Object>(vm, klass);
    object->flags = JS_LAYOUT_OBJECT_FLAG_IS_EXTENSIBLE;
    object->shape = create_shape(vm, realm, prototype);
    return object;
}

Realm& realm_of_object(Object const& object)
{
    return *object.shape->realm;
}

Object* prototype_of(Object const& object)
{
    return object.shape->prototype;
}

void set_prototype(Object& object, Object* prototype)
{
    object.shape->prototype = prototype;
}

bool is_function_object(Object const& object)
{
    return (object.flags & JS_LAYOUT_OBJECT_FLAG_IS_FUNCTION) != 0;
}

bool is_callable(Value value)
{
    return value.is_object() && is_function_object(*value.as_object());
}

bool is_constructor(Value value)
{
    if (!is_callable(value))
        return false;
    return static_cast<FunctionObject*>(value.as_object())->is_constructor;
}

JSHostClass const* host_class_of(Object const& object)
{
    switch (object.klass->id) {
    case JS_LAYOUT_CLASS_ID_HOST_OBJECT:
    case JS_LAYOUT_CLASS_ID_HOST_ARRAY:
        return static_cast<HostObject const&>(object).host_class;
    case JS_LAYOUT_CLASS_ID_HOST_FUNCTION:
        return static_cast<HostFunction const&>(object).host_class;
    default:
        return nullptr;
    }
}

JSHostObjectHooks const* g_function_property_hooks = nullptr;

static JSHostObjectHooks const* object_hooks_of(Object const& object)
{
    auto const* host_class = host_class_of(object);
    if (!host_class)
        return nullptr;
    if (host_class->kind == JS_HOST_CLASS_OBJECT)
        return static_cast<JSHostObjectHooks const*>(host_class->hooks);
    // The ABI gives a host function only call and construct. This runtime lets one also carry property hooks, in `user_data` (the
    // bridge's foreign functions: a page's class or function has its `prototype` and statics in the host's engine, and LibWeb reads
    // them: customElements.define reads constructor.prototype and constructor.observedAttributes).
    if (host_class->kind == JS_HOST_CLASS_FUNCTION && host_class->user_data && host_class->user_data == g_function_property_hooks)
        return g_function_property_hooks;
    return nullptr;
}

static JSHostArrayHooks const* array_hooks_of(Object const& object)
{
    auto const* host_class = host_class_of(object);
    if (!host_class || host_class->kind != JS_HOST_CLASS_ARRAY)
        return nullptr;
    return static_cast<JSHostArrayHooks const*>(host_class->hooks);
}

void const* host_hooks_of(Object const& object)
{
    auto const* host_class = host_class_of(object);
    return host_class ? host_class->hooks : nullptr;
}

StringView class_name_of(Object const& object)
{
    if (auto const* host_class = host_class_of(object))
        return StringView { host_class->name, host_class->name_length };
    return StringView { object.klass->name, object.klass->name_length };
}

// --- Property storage ----------------------------------------------------------------------------------

static PropertyTable& table_of(Object& object)
{
    if (!object.properties)
        object.properties = new PropertyTable;
    return *object.properties;
}

Property* find_own_property(Object& object, Key key)
{
    if (!object.properties)
        return nullptr;
    auto it = object.properties->index.find(key.bits);
    if (it == object.properties->index.end())
        return nullptr;
    return &object.properties->entries[it->value];
}

static Property& add_property(Object& object, Key key)
{
    auto& table = table_of(object);
    if (key.is_string())
        Utf16FlyString::ref_raw(key.bits);
    table.entries.append(Property { .key = key });
    table.index.set(key.bits, table.entries.size() - 1);
    return table.entries.last();
}

static void remove_property(Object& object, Property& property)
{
    auto& table = *object.properties;
    table.index.remove(property.key.bits);
    if (property.key.is_string())
        Utf16FlyString::unref_raw(property.key.bits);
    property.kind = PropertyKind::Deleted;
    property.value = Value::undefined();
    property.setter = nullptr;
    ++table.deleted;
    if (table.deleted > 32 && table.deleted > table.entries.size() / 2) {
        Vector<Property> kept;
        table.index.clear();
        for (auto& entry : table.entries) {
            if (entry.kind == PropertyKind::Deleted)
                continue;
            table.index.set(entry.key.bits, kept.size());
            kept.append(entry);
        }
        table.entries = move(kept);
        table.deleted = 0;
    }
}

void define_direct_property(VM&, Object& object, Key key, Value value, u8 attributes)
{
    auto* property = find_own_property(object, key);
    if (!property)
        property = &add_property(object, key);
    property->kind = PropertyKind::Data;
    property->value = value;
    property->setter = nullptr;
    property->intrinsic = nullptr;
    property->attributes = attributes;
}

void define_direct_accessor(VM&, Object& object, Key key, Object* getter, Object* setter, u8 attributes)
{
    auto* property = find_own_property(object, key);
    if (!property)
        property = &add_property(object, key);
    property->kind = PropertyKind::Accessor;
    property->value = getter ? Value::from_object(getter) : Value::undefined();
    property->setter = setter;
    property->intrinsic = nullptr;
    property->attributes = attributes & ~JS_ATTRIBUTE_WRITABLE;
}

// Resolves a pending intrinsic accessor into the data property it stands for.
static void materialize(VM&, Object& object, Property& property)
{
    if (property.kind != PropertyKind::IntrinsicPending)
        return;
    // The facade bit_casts `JS::Value (*)(Realm&)` to `JSValue (*)(JSRealm*)`. JS::Value wraps a union with
    // several members, which clang's wasm32 ABI does not treat as a single-element struct, so the C++ function
    // returns it through a hidden pointer and returns void: calling it as a u64-returning function traps with a
    // signature mismatch. Call it the way it was compiled.
#if defined(__wasm32__) || defined(__EMSCRIPTEN__)
    using SretAccessor = void (*)(JSValue*, JSRealm*);
    JSValue raw = 0;
    auto accessor = __builtin_bit_cast(SretAccessor, property.intrinsic);
    accessor(&raw, realm_abi(&realm_of_object(object)));
    auto value = Value { raw };
#else
    auto value = Value { property.intrinsic(realm_abi(&realm_of_object(object))) };
#endif
    property.kind = PropertyKind::Data;
    property.value = value;
    property.intrinsic = nullptr;
}

static JSPropertyDescriptor descriptor_of(VM& vm, Object& object, Property& property)
{
    materialize(vm, object, property);
    JSPropertyDescriptor descriptor {};
    u16 flags = JS_PD_PRESENT | JS_PD_HAS_ENUMERABLE | JS_PD_HAS_CONFIGURABLE;
    if (property.attributes & JS_ATTRIBUTE_ENUMERABLE)
        flags |= JS_PD_ENUMERABLE;
    if (property.attributes & JS_ATTRIBUTE_CONFIGURABLE)
        flags |= JS_PD_CONFIGURABLE;
    if (property.kind == PropertyKind::Accessor) {
        flags |= JS_PD_HAS_GET | JS_PD_HAS_SET;
        descriptor.get = property.value.is_object() ? object_abi(property.value.as_object()) : nullptr;
        descriptor.set = property.setter ? object_abi(property.setter) : nullptr;
    } else {
        flags |= JS_PD_HAS_VALUE | JS_PD_HAS_WRITABLE;
        descriptor.value = property.value.bits;
        if (property.attributes & JS_ATTRIBUTE_WRITABLE)
            flags |= JS_PD_WRITABLE;
    }
    descriptor.flags = flags;
    return descriptor;
}

static bool is_accessor_descriptor(JSPropertyDescriptor const& d) { return d.flags & (JS_PD_HAS_GET | JS_PD_HAS_SET); }
static bool is_data_descriptor(JSPropertyDescriptor const& d) { return d.flags & (JS_PD_HAS_VALUE | JS_PD_HAS_WRITABLE); }

// An Array, or a host class of kind ARRAY (an observable array: document.adoptedStyleSheets): both keep their length in array_length.
static bool has_array_length(Object const& object)
{
    return object.klass->id == JS_LAYOUT_CLASS_ID_ARRAY || object.klass->id == JS_LAYOUT_CLASS_ID_HOST_ARRAY;
}

// --- Ordinary internal methods -------------------------------------------------------------------------

JSCompletion ordinary_get_own_property(VM& vm, Object& object, Key key, JSPropertyDescriptor& out)
{
    if (has_array_length(object) && key == vm.keys->length) {
        out = JSPropertyDescriptor { .value = Value::from_double(object.array_length).bits, .get = nullptr, .set = nullptr, .property_offset = 0, .flags = JS_PD_PRESENT | JS_PD_HAS_VALUE | JS_PD_HAS_WRITABLE | JS_PD_WRITABLE | JS_PD_HAS_ENUMERABLE | JS_PD_HAS_CONFIGURABLE };
        return normal();
    }
    auto* property = find_own_property(object, key);
    if (!property) {
        out = JSPropertyDescriptor {};
        return normal();
    }
    out = descriptor_of(vm, object, *property);
    return normal();
}

// ValidateAndApplyPropertyDescriptor, without the checks that only matter to code that can observe them.
JSCompletion ordinary_define_own_property(VM& vm, Object& object, Key key, JSPropertyDescriptor& descriptor, JSPropertyDescriptor const*)
{
    auto* property = find_own_property(object, key);
    if (!property) {
        if (!(object.flags & JS_LAYOUT_OBJECT_FLAG_IS_EXTENSIBLE))
            return normal(false);
        if (has_array_length(object) && key.is_number() && key.as_number() >= object.array_length)
            object.array_length = key.as_number() + 1;
        property = &add_property(object, key);
        property->attributes = 0;
        if (is_accessor_descriptor(descriptor)) {
            property->kind = PropertyKind::Accessor;
            property->value = (descriptor.flags & JS_PD_HAS_GET) && descriptor.get ? Value::from_object(object_of(descriptor.get)) : Value::undefined();
            property->setter = (descriptor.flags & JS_PD_HAS_SET) ? object_of(descriptor.set) : nullptr;
        } else {
            property->kind = PropertyKind::Data;
            property->value = (descriptor.flags & JS_PD_HAS_VALUE) ? Value { descriptor.value } : Value::undefined();
            if ((descriptor.flags & JS_PD_HAS_WRITABLE) && (descriptor.flags & JS_PD_WRITABLE))
                property->attributes |= JS_ATTRIBUTE_WRITABLE;
        }
        if ((descriptor.flags & JS_PD_HAS_ENUMERABLE) && (descriptor.flags & JS_PD_ENUMERABLE))
            property->attributes |= JS_ATTRIBUTE_ENUMERABLE;
        if ((descriptor.flags & JS_PD_HAS_CONFIGURABLE) && (descriptor.flags & JS_PD_CONFIGURABLE))
            property->attributes |= JS_ATTRIBUTE_CONFIGURABLE;
        return normal(true);
    }
    materialize(vm, object, *property);
    bool configurable = property->attributes & JS_ATTRIBUTE_CONFIGURABLE;
    if (!configurable) {
        if ((descriptor.flags & JS_PD_HAS_CONFIGURABLE) && (descriptor.flags & JS_PD_CONFIGURABLE))
            return normal(false);
        if ((descriptor.flags & JS_PD_HAS_ENUMERABLE) && (((descriptor.flags & JS_PD_ENUMERABLE) != 0) != ((property->attributes & JS_ATTRIBUTE_ENUMERABLE) != 0)))
            return normal(false);
        if (property->kind == PropertyKind::Data && is_accessor_descriptor(descriptor))
            return normal(false);
        if (property->kind == PropertyKind::Accessor && is_data_descriptor(descriptor))
            return normal(false);
        if (property->kind == PropertyKind::Data && !(property->attributes & JS_ATTRIBUTE_WRITABLE)) {
            if ((descriptor.flags & JS_PD_HAS_WRITABLE) && (descriptor.flags & JS_PD_WRITABLE))
                return normal(false);
            if ((descriptor.flags & JS_PD_HAS_VALUE) && !same_value(Value { descriptor.value }, property->value))
                return normal(false);
            return normal(true);
        }
    }
    if (is_accessor_descriptor(descriptor)) {
        if (property->kind != PropertyKind::Accessor) {
            property->kind = PropertyKind::Accessor;
            property->value = Value::undefined();
            property->setter = nullptr;
            property->attributes &= ~JS_ATTRIBUTE_WRITABLE;
        }
        if (descriptor.flags & JS_PD_HAS_GET)
            property->value = descriptor.get ? Value::from_object(object_of(descriptor.get)) : Value::undefined();
        if (descriptor.flags & JS_PD_HAS_SET)
            property->setter = object_of(descriptor.set);
    } else if (is_data_descriptor(descriptor)) {
        if (property->kind != PropertyKind::Data) {
            property->kind = PropertyKind::Data;
            property->value = Value::undefined();
            property->setter = nullptr;
        }
        if (descriptor.flags & JS_PD_HAS_VALUE)
            property->value = Value { descriptor.value };
        if (descriptor.flags & JS_PD_HAS_WRITABLE)
            property->attributes = (property->attributes & ~JS_ATTRIBUTE_WRITABLE) | ((descriptor.flags & JS_PD_WRITABLE) ? JS_ATTRIBUTE_WRITABLE : 0);
    }
    if (descriptor.flags & JS_PD_HAS_ENUMERABLE)
        property->attributes = (property->attributes & ~JS_ATTRIBUTE_ENUMERABLE) | ((descriptor.flags & JS_PD_ENUMERABLE) ? JS_ATTRIBUTE_ENUMERABLE : 0);
    if (descriptor.flags & JS_PD_HAS_CONFIGURABLE)
        property->attributes = (property->attributes & ~JS_ATTRIBUTE_CONFIGURABLE) | ((descriptor.flags & JS_PD_CONFIGURABLE) ? JS_ATTRIBUTE_CONFIGURABLE : 0);
    return normal(true);
}

JSCompletion ordinary_get(VM& vm, Object& object, Key key, Value receiver, u8)
{
    JSPropertyDescriptor descriptor;
    auto completion = internal_get_own_property(vm, object, key, descriptor);
    if (is_throw(completion))
        return completion;
    if (!(descriptor.flags & JS_PD_PRESENT)) {
        auto prototype = internal_get_prototype_of(vm, object);
        if (is_throw(prototype))
            return prototype;
        auto* parent = reinterpret_cast<Object*>(static_cast<uintptr_t>(prototype.payload));
        if (!parent)
            return normal(Value::undefined());
        return internal_get(vm, *parent, key, receiver, JS_PROPERTY_LOOKUP_PHASE_PROTOTYPE_CHAIN);
    }
    if (is_data_descriptor(descriptor))
        return normal(Value { descriptor.value });
    if (!descriptor.get)
        return normal(Value::undefined());
    return call(vm, Value::from_object(object_of(descriptor.get)), receiver, nullptr, 0);
}

JSCompletion ordinary_set(VM& vm, Object& object, Key key, Value value, Value receiver, u8 phase)
{
    JSPropertyDescriptor own;
    auto completion = internal_get_own_property(vm, object, key, own);
    if (is_throw(completion))
        return completion;
    return js_object_ordinary_set_with_own_descriptor(vm_abi(vm), object_abi(&object), reinterpret_cast<JSPropertyKey const*>(&key), value.bits, receiver.bits, (own.flags & JS_PD_PRESENT) ? &own : nullptr, nullptr, phase);
}

JSCompletion ordinary_delete(VM& vm, Object& object, Key key)
{
    auto* property = find_own_property(object, key);
    if (!property)
        return normal(true);
    materialize(vm, object, *property);
    if (!(property->attributes & JS_ATTRIBUTE_CONFIGURABLE))
        return normal(false);
    remove_property(object, *property);
    return normal(true);
}

JSCompletion ordinary_own_property_keys(VM& vm, Object& object, JSValueSink* keys)
{
    if (!object.properties) {
        if (has_array_length(object))
            keys->append(keys->context, key_to_value(vm, vm.keys->length).bits);
        return normal();
    }
    Vector<u32> indices;
    for (auto& property : object.properties->entries) {
        if (property.kind != PropertyKind::Deleted && property.key.is_number())
            indices.append(property.key.as_number());
    }
    quick_sort(indices);
    for (auto index : indices)
        keys->append(keys->context, key_to_value(vm, Key::from_index(index)).bits);
    if (has_array_length(object))
        keys->append(keys->context, key_to_value(vm, vm.keys->length).bits);
    for (auto& property : object.properties->entries) {
        if (property.kind != PropertyKind::Deleted && property.key.is_string())
            keys->append(keys->context, key_to_value(vm, property.key).bits);
    }
    for (auto& property : object.properties->entries) {
        if (property.kind != PropertyKind::Deleted && property.key.is_symbol())
            keys->append(keys->context, key_to_value(vm, property.key).bits);
    }
    return normal();
}

// --- Internal methods: a host class's hooks first, the ordinary behaviour otherwise ----------------------

JSCompletion internal_get_prototype_of(VM&, Object& object)
{
    if (auto const* hooks = object_hooks_of(object); hooks && hooks->get_prototype_of)
        return hooks->get_prototype_of(object_abi(&object));
    return normal_cell(prototype_of(object));
}

JSCompletion internal_set_prototype_of(VM& vm, Object& object, Object* prototype)
{
    if (auto const* hooks = object_hooks_of(object); hooks && hooks->set_prototype_of)
        return hooks->set_prototype_of(object_abi(&object), object_abi(prototype));
    if (auto const* host_class = host_class_of(object); host_class && (host_class->flags & JS_HOST_CLASS_IMMUTABLE_PROTOTYPE))
        return js_object_set_immutable_prototype(vm_abi(vm), object_abi(&object), object_abi(prototype));
    return js_object_ordinary_set_prototype_of(vm_abi(vm), object_abi(&object), object_abi(prototype));
}

JSCompletion internal_get_own_property(VM& vm, Object& object, Key key, JSPropertyDescriptor& out)
{
    if (auto const* hooks = object_hooks_of(object); hooks && hooks->get_own_property) {
        out = JSPropertyDescriptor {};
        return hooks->get_own_property(object_abi(&object), JSPropertyKey { key.bits }, &out);
    }
    return ordinary_get_own_property(vm, object, key, out);
}

JSCompletion internal_define_own_property(VM& vm, Object& object, Key key, JSPropertyDescriptor& descriptor, JSPropertyDescriptor const* precomputed)
{
    if (auto const* hooks = object_hooks_of(object); hooks && hooks->define_own_property)
        return hooks->define_own_property(object_abi(&object), JSPropertyKey { key.bits }, &descriptor, precomputed);
    return ordinary_define_own_property(vm, object, key, descriptor, precomputed);
}

JSCompletion internal_has_property(VM& vm, Object& object, Key key)
{
    if (auto const* hooks = object_hooks_of(object); hooks && hooks->has_property)
        return hooks->has_property(object_abi(&object), JSPropertyKey { key.bits });
    JSPropertyDescriptor descriptor;
    auto completion = internal_get_own_property(vm, object, key, descriptor);
    if (is_throw(completion))
        return completion;
    if (descriptor.flags & JS_PD_PRESENT)
        return normal(true);
    auto prototype = internal_get_prototype_of(vm, object);
    if (is_throw(prototype))
        return prototype;
    auto* parent = reinterpret_cast<Object*>(static_cast<uintptr_t>(prototype.payload));
    if (!parent)
        return normal(false);
    return internal_has_property(vm, *parent, key);
}

JSCompletion internal_get(VM& vm, Object& object, Key key, Value receiver, u8 phase)
{
    if (auto const* hooks = object_hooks_of(object); hooks && hooks->get)
        return hooks->get(object_abi(&object), JSPropertyKey { key.bits }, receiver.bits, nullptr, phase);
    return ordinary_get(vm, object, key, receiver, phase);
}

JSCompletion internal_set(VM& vm, Object& object, Key key, Value value, Value receiver, u8 phase)
{
    if (auto const* hooks = object_hooks_of(object); hooks && hooks->set)
        return hooks->set(object_abi(&object), JSPropertyKey { key.bits }, value.bits, receiver.bits, nullptr, phase);
    if (auto const* hooks = array_hooks_of(object); hooks && hooks->set)
        return hooks->set(object_abi(&object), JSPropertyKey { key.bits }, value.bits, receiver.bits, nullptr, phase);
    return ordinary_set(vm, object, key, value, receiver, phase);
}

JSCompletion internal_delete(VM& vm, Object& object, Key key)
{
    if (auto const* hooks = object_hooks_of(object); hooks && hooks->delete_property)
        return hooks->delete_property(object_abi(&object), JSPropertyKey { key.bits });
    if (auto const* hooks = array_hooks_of(object); hooks && hooks->delete_property)
        return hooks->delete_property(object_abi(&object), JSPropertyKey { key.bits });
    return ordinary_delete(vm, object, key);
}

JSCompletion internal_own_property_keys(VM& vm, Object& object, JSValueSink* keys)
{
    if (auto const* hooks = object_hooks_of(object); hooks && hooks->own_property_keys)
        return hooks->own_property_keys(object_abi(&object), keys);
    return ordinary_own_property_keys(vm, object, keys);
}

// --- ABI: creation and host objects --------------------------------------------------------------------

extern "C" JSObject* js_object_create(JSVM* vm, JSRealm* realm, JSObject* prototype)
{
    return object_abi(create_object(vm_of(vm), *realm_of(realm), object_of(prototype)));
}

static void apply_host_class_flags(Object& object, JSHostClass const& host_class)
{
    if (host_class.flags & JS_HOST_CLASS_IS_PLATFORM_OBJECT)
        object.flags |= JS_LAYOUT_OBJECT_FLAG_IS_PLATFORM_OBJECT;
    if (host_class.flags & JS_HOST_CLASS_REQUIRES_SLOW_ADD_OWN_PROPERTY)
        object.flags |= JS_LAYOUT_OBJECT_FLAG_REQUIRES_SLOW_ADD_OWN_PROPERTY;
    if (host_class.flags & JS_HOST_CLASS_MAY_INTERFERE_WITH_INDEXED_PROPERTY_ACCESS)
        object.flags |= JS_LAYOUT_OBJECT_FLAG_MAY_INTERFERE_WITH_INDEXED_PROPERTY_ACCESS;
    if (host_class.flags & JS_HOST_CLASS_IS_HTMLDDA)
        object.flags |= JS_LAYOUT_OBJECT_FLAG_IS_HTMLDDA;
    if (host_class.flags & JS_HOST_CLASS_IS_GLOBAL_OBJECT)
        object.flags |= JS_LAYOUT_OBJECT_FLAG_IS_GLOBAL_OBJECT;
}

extern "C" JSObject* js_host_object_create(JSVM* abi_vm, JSRealm* abi_realm, JSHostClass const* host_class, JSObject* prototype_or_null, void* wrappable_or_null, void* host_data_or_null)
{
    auto& vm = vm_of(abi_vm);
    auto& realm = *realm_of(abi_realm);
    VERIFY(host_class && host_class->kind == JS_HOST_CLASS_OBJECT);
    auto* object = static_cast<HostObject*>(create_object(vm, realm, object_of(prototype_or_null), class_host_object));
    object->host_class = host_class;
    object->wrappable = wrappable_or_null;
    object->host_data = host_data_or_null;
    apply_host_class_flags(*object, *host_class);
    return object_abi(object);
}

extern "C" JSObject* js_host_array_create(JSVM* abi_vm, JSRealm* abi_realm, JSHostClass const* host_class, JSObject* prototype_or_null, void* host_data_or_null)
{
    auto& vm = vm_of(abi_vm);
    auto& realm = *realm_of(abi_realm);
    auto* object = static_cast<HostObject*>(create_object(vm, realm, prototype_or_null ? object_of(prototype_or_null) : intrinsic(vm, realm, JS_INTRINSIC_ARRAY_PROTOTYPE), class_host_array));
    object->host_class = host_class;
    object->host_data = host_data_or_null;
    object->flags |= JS_LAYOUT_OBJECT_FLAG_HAS_MAGICAL_LENGTH_PROPERTY;
    apply_host_class_flags(*object, *host_class);
    return object_abi(object);
}

extern "C" JSCompletion js_host_array_array_set(JSVM* vm, JSObject* host_array, JSPropertyKey const* key, JSValue value, JSValue receiver, JSSetCacheMetadata*, uint8_t phase)
{
    return ordinary_set(vm_of(vm), *object_of(host_array), Key::from_abi(key), Value { value }, Value { receiver }, phase);
}

extern "C" JSCompletion js_host_array_array_delete(JSVM* vm, JSObject* host_array, JSPropertyKey const* key)
{
    return ordinary_delete(vm_of(vm), *object_of(host_array), Key::from_abi(key));
}

extern "C" JSObject* js_host_function_create_without_own_properties(JSVM* abi_vm, JSRealm* abi_realm, JSHostClass const* host_class, JSUtf16View name, JSObject* prototype_or_null, void* host_data_or_null)
{
    auto& vm = vm_of(abi_vm);
    auto& realm = *realm_of(abi_realm);
    VERIFY(host_class && host_class->kind == JS_HOST_CLASS_FUNCTION);
    auto* function = static_cast<HostFunction*>(create_object(vm, realm, prototype_or_null ? object_of(prototype_or_null) : intrinsic(vm, realm, JS_INTRINSIC_FUNCTION_PROTOTYPE), class_host_function));
    function->realm = &realm;
    function->function_kind = FunctionKind::Host;
    auto const* hooks = static_cast<JSHostFunctionHooks const*>(host_class->hooks);
    function->is_constructor = (host_class->flags & JS_HOST_CLASS_HAS_CONSTRUCTOR) || (hooks && hooks->construct);
    function->name_raw = Utf16FlyString::from_utf16(view_of(name)).into_raw();
    function->host_class = host_class;
    function->host_data = host_data_or_null;
    function->flags |= JS_LAYOUT_OBJECT_FLAG_IS_FUNCTION;
    apply_host_class_flags(*function, *host_class);
    return object_abi(function);
}

extern "C" JSObject* js_host_function_create(JSVM* abi_vm, JSRealm* abi_realm, JSHostClass const* host_class, JSUtf16View name, int32_t length, JSObject* prototype_or_null, void* host_data_or_null)
{
    auto& vm = vm_of(abi_vm);
    auto* abi_function = js_host_function_create_without_own_properties(abi_vm, abi_realm, host_class, name, prototype_or_null, host_data_or_null);
    auto& function = *static_cast<HostFunction*>(object_of(abi_function));
    function.length = length;
    define_direct_property(vm, function, vm.keys->length, Value::from_i32(length), JS_ATTRIBUTE_CONFIGURABLE);
    define_direct_property(vm, function, vm.keys->name, Value::from_string(create_string(vm, view_of(name))), JS_ATTRIBUTE_CONFIGURABLE);
    return abi_function;
}

extern "C" JSHostClass const* js_host_object_host_class_of(JSObject* object)
{
    return host_class_of(*object_of(object));
}

extern "C" bool js_host_object_is_host_instance_of(JSObject* object, JSHostClass const* host_class)
{
    for (auto const* c = host_class_of(*object_of(object)); c; c = c->parent) {
        if (c == host_class)
            return true;
    }
    return false;
}

extern "C" void* js_host_object_host_data_of(JSObject* abi_object)
{
    auto& object = *object_of(abi_object);
    switch (object.klass->id) {
    case JS_LAYOUT_CLASS_ID_HOST_OBJECT:
    case JS_LAYOUT_CLASS_ID_HOST_ARRAY:
        return static_cast<HostObject&>(object).host_data;
    case JS_LAYOUT_CLASS_ID_HOST_FUNCTION:
        return static_cast<HostFunction&>(object).host_data;
    default:
        return nullptr;
    }
}

extern "C" void js_host_object_set_host_data(JSObject* abi_object, void* host_data)
{
    auto& object = *object_of(abi_object);
    switch (object.klass->id) {
    case JS_LAYOUT_CLASS_ID_HOST_OBJECT:
    case JS_LAYOUT_CLASS_ID_HOST_ARRAY:
        static_cast<HostObject&>(object).host_data = host_data;
        return;
    case JS_LAYOUT_CLASS_ID_HOST_FUNCTION:
        static_cast<HostFunction&>(object).host_data = host_data;
        return;
    default:
        VERIFY_NOT_REACHED();
    }
}

// --- ABI: the internal methods -------------------------------------------------------------------------

extern "C" JSCompletion js_object_internal_get_prototype_of(JSVM* vm, JSObject* object)
{
    return internal_get_prototype_of(vm_of(vm), *object_of(object));
}

extern "C" JSCompletion js_object_internal_set_prototype_of(JSVM* vm, JSObject* object, JSObject* prototype)
{
    return internal_set_prototype_of(vm_of(vm), *object_of(object), object_of(prototype));
}

extern "C" JSCompletion js_object_internal_get_own_property(JSVM* vm, JSObject* object, JSPropertyKey const* key, JSPropertyDescriptor* out)
{
    return internal_get_own_property(vm_of(vm), *object_of(object), Key::from_abi(key), *out);
}

extern "C" JSCompletion js_object_internal_define_own_property(JSVM* vm, JSObject* object, JSPropertyKey const* key, JSPropertyDescriptor* descriptor, JSPropertyDescriptor const* precomputed)
{
    return internal_define_own_property(vm_of(vm), *object_of(object), Key::from_abi(key), *descriptor, precomputed);
}

extern "C" JSCompletion js_object_internal_get(JSVM* vm, JSObject* object, JSPropertyKey const* key, JSValue receiver, JSGetCacheMetadata*, uint8_t phase)
{
    return internal_get(vm_of(vm), *object_of(object), Key::from_abi(key), Value { receiver }, phase);
}

extern "C" JSCompletion js_object_internal_get_as_prototype_of(JSVM* vm, JSObject* object, JSPropertyKey const* key, JSValue receiver, JSGetCacheMetadata*)
{
    return internal_get(vm_of(vm), *object_of(object), Key::from_abi(key), Value { receiver }, JS_PROPERTY_LOOKUP_PHASE_PROTOTYPE_CHAIN);
}

extern "C" JSCompletion js_object_internal_set(JSVM* vm, JSObject* object, JSPropertyKey const* key, JSValue value, JSValue receiver, JSSetCacheMetadata*, uint8_t phase)
{
    return internal_set(vm_of(vm), *object_of(object), Key::from_abi(key), Value { value }, Value { receiver }, phase);
}

extern "C" JSCompletion js_object_internal_delete(JSVM* vm, JSObject* object, JSPropertyKey const* key)
{
    return internal_delete(vm_of(vm), *object_of(object), Key::from_abi(key));
}

extern "C" JSCompletion js_object_internal_own_property_keys(JSVM* vm, JSObject* object, JSValueSink* keys)
{
    return internal_own_property_keys(vm_of(vm), *object_of(object), keys);
}

// --- ABI: the ordinary methods -------------------------------------------------------------------------

extern "C" JSCompletion js_object_ordinary_get_prototype_of(JSVM*, JSObject* object)
{
    return normal_cell(prototype_of(*object_of(object)));
}

extern "C" JSCompletion js_object_ordinary_set_prototype_of(JSVM*, JSObject* abi_object, JSObject* abi_prototype)
{
    auto& object = *object_of(abi_object);
    auto* prototype = object_of(abi_prototype);
    if (prototype_of(object) == prototype)
        return normal(true);
    if (!(object.flags & JS_LAYOUT_OBJECT_FLAG_IS_EXTENSIBLE))
        return normal(false);
    for (auto* p = prototype; p; p = prototype_of(*p)) {
        if (p == &object)
            return normal(false);
        if (object_hooks_of(*p) && object_hooks_of(*p)->get_prototype_of)
            break;
    }
    set_prototype(object, prototype);
    return normal(true);
}

extern "C" JSCompletion js_object_ordinary_prevent_extensions(JSVM*, JSObject* object)
{
    object_of(object)->flags &= ~JS_LAYOUT_OBJECT_FLAG_IS_EXTENSIBLE;
    return normal(true);
}

extern "C" JSCompletion js_object_ordinary_get_own_property(JSVM* vm, JSObject* object, JSPropertyKey const* key, JSPropertyDescriptor* out)
{
    return ordinary_get_own_property(vm_of(vm), *object_of(object), Key::from_abi(key), *out);
}

extern "C" JSCompletion js_object_ordinary_define_own_property(JSVM* vm, JSObject* object, JSPropertyKey const* key, JSPropertyDescriptor* descriptor, JSPropertyDescriptor const* precomputed)
{
    return ordinary_define_own_property(vm_of(vm), *object_of(object), Key::from_abi(key), *descriptor, precomputed);
}

extern "C" JSCompletion js_object_ordinary_get(JSVM* vm, JSObject* object, JSPropertyKey const* key, JSValue receiver, JSGetCacheMetadata*, uint8_t phase)
{
    return ordinary_get(vm_of(vm), *object_of(object), Key::from_abi(key), Value { receiver }, phase);
}

extern "C" JSCompletion js_object_ordinary_set(JSVM* vm, JSObject* object, JSPropertyKey const* key, JSValue value, JSValue receiver, JSSetCacheMetadata*, uint8_t phase)
{
    return ordinary_set(vm_of(vm), *object_of(object), Key::from_abi(key), Value { value }, Value { receiver }, phase);
}

// OrdinarySetWithOwnDescriptor ( O, P, V, Receiver, ownDesc )
extern "C" JSCompletion js_object_ordinary_set_with_own_descriptor(JSVM* abi_vm, JSObject* abi_object, JSPropertyKey const* abi_key, JSValue abi_value, JSValue abi_receiver, JSPropertyDescriptor const* own_descriptor, JSSetCacheMetadata*, uint8_t)
{
    auto& vm = vm_of(abi_vm);
    auto& object = *object_of(abi_object);
    auto key = Key::from_abi(abi_key);
    Value value { abi_value };
    Value receiver { abi_receiver };
    JSPropertyDescriptor own;
    if (own_descriptor && (own_descriptor->flags & JS_PD_PRESENT)) {
        own = *own_descriptor;
    } else {
        auto prototype = internal_get_prototype_of(vm, object);
        if (is_throw(prototype))
            return prototype;
        auto* parent = reinterpret_cast<Object*>(static_cast<uintptr_t>(prototype.payload));
        if (parent)
            return internal_set(vm, *parent, key, value, receiver, JS_PROPERTY_LOOKUP_PHASE_PROTOTYPE_CHAIN);
        own = JSPropertyDescriptor { .value = Value::undefined().bits, .get = nullptr, .set = nullptr, .property_offset = 0, .flags = JS_PD_PRESENT | JS_PD_HAS_VALUE | JS_PD_HAS_WRITABLE | JS_PD_WRITABLE | JS_PD_HAS_ENUMERABLE | JS_PD_ENUMERABLE | JS_PD_HAS_CONFIGURABLE | JS_PD_CONFIGURABLE };
    }
    if (is_data_descriptor(own)) {
        if (!(own.flags & JS_PD_WRITABLE))
            return normal(false);
        if (!receiver.is_object())
            return normal(false);
        auto& receiver_object = *receiver.as_object();
        JSPropertyDescriptor existing;
        auto completion = internal_get_own_property(vm, receiver_object, key, existing);
        if (is_throw(completion))
            return completion;
        if (existing.flags & JS_PD_PRESENT) {
            if (is_accessor_descriptor(existing))
                return normal(false);
            if (!(existing.flags & JS_PD_WRITABLE))
                return normal(false);
            JSPropertyDescriptor value_descriptor { .value = value.bits, .get = nullptr, .set = nullptr, .property_offset = 0, .flags = JS_PD_PRESENT | JS_PD_HAS_VALUE };
            return internal_define_own_property(vm, receiver_object, key, value_descriptor, &existing);
        }
        JSPropertyDescriptor new_descriptor { .value = value.bits, .get = nullptr, .set = nullptr, .property_offset = 0, .flags = JS_PD_PRESENT | JS_PD_HAS_VALUE | JS_PD_HAS_WRITABLE | JS_PD_WRITABLE | JS_PD_HAS_ENUMERABLE | JS_PD_ENUMERABLE | JS_PD_HAS_CONFIGURABLE | JS_PD_CONFIGURABLE };
        return internal_define_own_property(vm, receiver_object, key, new_descriptor, nullptr);
    }
    if (!own.set)
        return normal(false);
    auto completion = call(vm, Value::from_object(object_of(own.set)), receiver, &value, 1);
    if (is_throw(completion))
        return completion;
    return normal(true);
}

extern "C" JSCompletion js_object_ordinary_delete(JSVM* vm, JSObject* object, JSPropertyKey const* key)
{
    return ordinary_delete(vm_of(vm), *object_of(object), Key::from_abi(key));
}

extern "C" JSCompletion js_object_ordinary_own_property_keys(JSVM* vm, JSObject* object, JSValueSink* keys)
{
    return ordinary_own_property_keys(vm_of(vm), *object_of(object), keys);
}

// --- ABI: operations on objects ------------------------------------------------------------------------

extern "C" JSCompletion js_object_get(JSVM* vm, JSObject* object, JSPropertyKey const* key)
{
    return internal_get(vm_of(vm), *object_of(object), Key::from_abi(key), Value::from_object(object_of(object)), JS_PROPERTY_LOOKUP_PHASE_OWN_PROPERTY);
}

extern "C" JSCompletion js_object_set(JSVM* abi_vm, JSObject* object, JSPropertyKey const* key, JSValue value, bool throw_exceptions)
{
    auto& vm = vm_of(abi_vm);
    auto completion = internal_set(vm, *object_of(object), Key::from_abi(key), Value { value }, Value::from_object(object_of(object)), JS_PROPERTY_LOOKUP_PHASE_OWN_PROPERTY);
    if (is_throw(completion))
        return completion;
    if (!completion.payload && throw_exceptions)
        return throw_type_error(vm, "Cannot set property"sv);
    return normal();
}

extern "C" JSCompletion js_object_define_property_or_throw(JSVM* abi_vm, JSObject* object, JSPropertyKey const* key, JSPropertyDescriptor* descriptor)
{
    auto& vm = vm_of(abi_vm);
    auto completion = internal_define_own_property(vm, *object_of(object), Key::from_abi(key), *descriptor, nullptr);
    if (is_throw(completion))
        return completion;
    if (!completion.payload)
        return throw_type_error(vm, "Cannot define property"sv);
    return normal();
}

extern "C" JSCompletion js_object_create_data_property(JSVM* vm, JSObject* object, JSPropertyKey const* key, JSValue value)
{
    JSPropertyDescriptor descriptor { .value = value, .get = nullptr, .set = nullptr, .property_offset = 0, .flags = JS_PD_PRESENT | JS_PD_HAS_VALUE | JS_PD_HAS_WRITABLE | JS_PD_WRITABLE | JS_PD_HAS_ENUMERABLE | JS_PD_ENUMERABLE | JS_PD_HAS_CONFIGURABLE | JS_PD_CONFIGURABLE };
    return internal_define_own_property(vm_of(vm), *object_of(object), Key::from_abi(key), descriptor, nullptr);
}

extern "C" JSCompletion js_object_create_data_property_or_throw(JSVM* abi_vm, JSObject* object, JSPropertyKey const* key, JSValue value)
{
    auto completion = js_object_create_data_property(abi_vm, object, key, value);
    if (is_throw(completion))
        return completion;
    if (!completion.payload)
        return throw_type_error(vm_of(abi_vm), "Cannot define property"sv);
    return normal(true);
}

extern "C" JSCompletion js_object_has_property(JSVM* vm, JSObject* object, JSPropertyKey const* key)
{
    return internal_has_property(vm_of(vm), *object_of(object), Key::from_abi(key));
}

extern "C" JSCompletion js_object_has_own_property(JSVM* vm, JSObject* object, JSPropertyKey const* key)
{
    JSPropertyDescriptor descriptor;
    auto completion = internal_get_own_property(vm_of(vm), *object_of(object), Key::from_abi(key), descriptor);
    if (is_throw(completion))
        return completion;
    return normal((descriptor.flags & JS_PD_PRESENT) != 0);
}

extern "C" JSCompletion js_object_set_integrity_level(JSVM* abi_vm, JSObject* abi_object, uint8_t level)
{
    auto& object = *object_of(abi_object);
    object.flags &= ~JS_LAYOUT_OBJECT_FLAG_IS_EXTENSIBLE;
    if (object.properties) {
        for (auto& property : object.properties->entries) {
            if (property.kind == PropertyKind::Deleted)
                continue;
            materialize(vm_of(abi_vm), object, property);
            property.attributes &= ~JS_ATTRIBUTE_CONFIGURABLE;
            if (level == JS_INTEGRITY_LEVEL_FROZEN && property.kind == PropertyKind::Data)
                property.attributes &= ~JS_ATTRIBUTE_WRITABLE;
        }
    }
    return normal(true);
}

extern "C" JSCompletion js_object_set_immutable_prototype(JSVM*, JSObject* object, JSObject* prototype)
{
    return normal(prototype_of(*object_of(object)) == object_of(prototype));
}

extern "C" JSValue js_object_get_without_side_effects(JSVM* abi_vm, JSObject* abi_object, JSPropertyKey const* abi_key)
{
    auto key = Key::from_abi(abi_key);
    for (auto* object = object_of(abi_object); object; object = prototype_of(*object)) {
        if (auto* property = find_own_property(*object, key)) {
            materialize(vm_of(abi_vm), *object, *property);
            if (property->kind == PropertyKind::Data)
                return property->value.bits;
            return Value::undefined().bits;
        }
    }
    return Value::undefined().bits;
}

extern "C" void js_object_define_direct_property(JSVM* vm, JSObject* object, JSPropertyKey const* key, JSValue value, uint8_t attributes)
{
    define_direct_property(vm_of(vm), *object_of(object), Key::from_abi(key), Value { value }, attributes);
}

extern "C" void js_object_define_direct_accessor(JSVM* vm, JSObject* object, JSPropertyKey const* key, JSObject* getter, JSObject* setter, uint8_t attributes)
{
    define_direct_accessor(vm_of(vm), *object_of(object), Key::from_abi(key), object_of(getter), object_of(setter), attributes);
}

extern "C" void js_object_define_direct_cached_accessor(JSVM* vm, JSObject* object, JSPropertyKey const* key, JSObject* getter, JSObject* setter, uint8_t attributes, uint8_t)
{
    // The runtime's cache of the getter's result is an optimization; here the getter runs every time.
    define_direct_accessor(vm_of(vm), *object_of(object), Key::from_abi(key), object_of(getter), object_of(setter), attributes);
}

extern "C" void js_object_clear_cached_accessor_value(JSVM*, JSObject*, JSPropertyKey const*)
{
}

extern "C" void js_object_define_native_function(JSVM* abi_vm, JSObject* abi_object, JSRealm* realm, JSPropertyKey const* abi_key, JSNativeFunction behaviour, int32_t length, uint8_t attributes)
{
    auto& vm = vm_of(abi_vm);
    auto key = Key::from_abi(abi_key);
    auto name = key.is_string() ? key.as_fly_string() : Utf16FlyString {};
    auto* function = create_native_function(vm, realm_of(realm), FunctionKind::Native, behaviour, nullptr, nullptr, length, name, {}, true);
    define_direct_property(vm, *object_of(abi_object), key, Value::from_object(function), attributes);
}

extern "C" void js_object_define_native_accessor(JSVM* abi_vm, JSObject* abi_object, JSRealm* realm, JSPropertyKey const* abi_key, JSNativeFunction getter, JSNativeFunction setter, uint8_t attributes)
{
    auto& vm = vm_of(abi_vm);
    auto key = Key::from_abi(abi_key);
    auto name = key.is_string() ? key.as_fly_string() : Utf16FlyString {};
    Object* getter_function = getter ? create_native_function(vm, realm_of(realm), FunctionKind::Native, getter, nullptr, nullptr, 0, name, "get"sv, true) : nullptr;
    Object* setter_function = setter ? create_native_function(vm, realm_of(realm), FunctionKind::Native, setter, nullptr, nullptr, 1, name, "set"sv, true) : nullptr;
    define_direct_accessor(vm, *object_of(abi_object), key, getter_function, setter_function, attributes);
}

extern "C" void js_object_define_intrinsic_accessor(JSVM*, JSObject* abi_object, JSPropertyKey const* abi_key, uint8_t attributes, JSIntrinsicAccessor accessor)
{
    auto& object = *object_of(abi_object);
    auto key = Key::from_abi(abi_key);
    auto* property = find_own_property(object, key);
    if (!property)
        property = &add_property(object, key);
    property->kind = PropertyKind::IntrinsicPending;
    property->value = Value::undefined();
    property->setter = nullptr;
    property->intrinsic = accessor;
    property->attributes = attributes;
    object.flags |= JS_LAYOUT_OBJECT_FLAG_HAS_INTRINSIC_ACCESSORS;
}

extern "C" void js_object_define_unimplemented_property(JSVM* abi_vm, JSObject* abi_object, JSUtf16View name)
{
    // An interface LibWeb has not implemented: reading the property is reported through the VM's
    // on_unimplemented_property_access hook upstream; here it is simply undefined.
    auto& vm = vm_of(abi_vm);
    auto fly = Utf16FlyString::from_utf16(view_of(name));
    define_direct_property(vm, *object_of(abi_object), Key::from_fly_string(fly), Value::undefined(), JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_CONFIGURABLE);
    object_of(abi_object)->flags |= JS_LAYOUT_OBJECT_FLAG_HAS_UNIMPLEMENTED_PROPERTIES;
    ++vm.unimplemented_property_accesses;
}

extern "C" void js_object_set_prototype(JSVM*, JSObject* object, JSObject* prototype)
{
    set_prototype(*object_of(object), object_of(prototype));
}

extern "C" bool js_object_storage_has(JSObject* object, JSPropertyKey const* key)
{
    return find_own_property(*object_of(object), Key::from_abi(key)) != nullptr;
}

extern "C" void js_object_storage_delete(JSVM*, JSObject* abi_object, JSPropertyKey const* key)
{
    auto& object = *object_of(abi_object);
    if (auto* property = find_own_property(object, Key::from_abi(key)))
        remove_property(object, *property);
}

extern "C" void js_object_convert_to_prototype_if_needed(JSVM*, JSObject*)
{
}

extern "C" void js_object_invalidate_property_lookup_caches(JSVM*, JSObject*)
{
}

extern "C" void js_object_clear_requires_slow_add_own_property(JSObject* object)
{
    object_of(object)->flags &= ~JS_LAYOUT_OBJECT_FLAG_REQUIRES_SLOW_ADD_OWN_PROPERTY;
}

extern "C" bool js_object_has_parameter_map(JSObject*)
{
    return false;
}

extern "C" uint8_t const* js_object_class_name(JSObject* object, size_t* out_length)
{
    auto name = class_name_of(*object_of(object));
    *out_length = name.length();
    return reinterpret_cast<u8 const*>(name.characters_without_null_termination());
}

extern "C" bool js_object_eligible_for_own_property_enumeration_fast_path(JSObject* abi_object)
{
    auto& object = *object_of(abi_object);
    auto const* hooks = object_hooks_of(object);
    if (hooks && (hooks->get_prototype_of || hooks->get_own_property || hooks->has_property || hooks->get || hooks->own_property_keys))
        return false;
    if (auto const* host_class = host_class_of(object); host_class && (host_class->flags & JS_HOST_CLASS_NOT_ELIGIBLE_FOR_OWN_PROPERTY_ENUMERATION_FAST_PATH))
        return false;
    return true;
}

struct KeyCollector {
    Vector<Value> keys;
    static void append(void* context, JSValue value) { static_cast<KeyCollector*>(context)->keys.append(Value { value }); }
};

static Key key_of_value(Value value)
{
    if (value.is_symbol())
        return Key::from_symbol(value.as_symbol());
    VERIFY(value.is_string());
    // The key of an index ("0", "17") is the index key the property is stored under (own_property_keys gave it as a string).
    auto text = string_view(value.as_string());
    if (!text.is_empty() && text.length_in_code_units() <= 10 && !(text.code_unit_at(0) == '0' && text.length_in_code_units() > 1)) {
        u64 index = 0;
        bool digits = true;
        for (size_t i = 0; i < text.length_in_code_units(); ++i) {
            auto c = text.code_unit_at(i);
            if (c < '0' || c > '9') {
                digits = false;
                break;
            }
            index = index * 10 + (c - '0');
        }
        if (digits && index < 0xFFFFFFFFull)
            return Key::from_index(static_cast<u32>(index));
    }
    auto fly = Utf16FlyString::from_utf16(text);
    // The property was stored by this key, so the fly string lives on in the object.
    auto raw = fly.raw_identity();
    (void)move(fly).into_raw();
    Utf16FlyString::unref_raw(raw);
    return Key { raw };
}

extern "C" JSCompletion js_object_enumerable_own_property_names(JSVM* abi_vm, JSObject* abi_object, JSPropertyKind kind, JSValueSink* sink)
{
    auto& vm = vm_of(abi_vm);
    auto& object = *object_of(abi_object);
    KeyCollector collector;
    JSValueSink key_sink { &collector, KeyCollector::append };
    auto completion = internal_own_property_keys(vm, object, &key_sink);
    if (is_throw(completion))
        return completion;
    for (auto key_value : collector.keys) {
        if (key_value.is_symbol())
            continue;
        auto key = key_of_value(key_value);
        JSPropertyDescriptor descriptor;
        completion = internal_get_own_property(vm, object, key, descriptor);
        if (is_throw(completion))
            return completion;
        if (!(descriptor.flags & JS_PD_PRESENT) || !(descriptor.flags & JS_PD_ENUMERABLE))
            continue;
        if (kind == 0) { // Key
            sink->append(sink->context, key_value.bits);
            continue;
        }
        auto value = internal_get(vm, object, key, Value::from_object(&object), JS_PROPERTY_LOOKUP_PHASE_OWN_PROPERTY);
        if (is_throw(value))
            return value;
        if (kind == 1) { // Value
            sink->append(sink->context, value.payload);
            continue;
        }
        // KeyAndValue: a [key, value] array
        Value pair[2] = { key_value, value_of(value) };
        auto* array = object_of(js_array_create_from(abi_vm, realm_abi(&realm_of_object(object)), reinterpret_cast<JSValue const*>(pair), 2));
        sink->append(sink->context, Value::from_object(array).bits);
    }
    return normal();
}

extern "C" JSCompletion js_object_enumerate_object_properties(JSVM* abi_vm, JSObject* abi_object, JSPropertyEnumerationCallback callback, void* context)
{
    auto& vm = vm_of(abi_vm);
    Vector<Value> visited;
    for (auto* object = object_of(abi_object); object;) {
        KeyCollector collector;
        JSValueSink key_sink { &collector, KeyCollector::append };
        auto completion = internal_own_property_keys(vm, *object, &key_sink);
        if (is_throw(completion))
            return completion;
        for (auto key_value : collector.keys) {
            if (key_value.is_symbol())
                continue;
            bool seen = false;
            for (auto& v : visited) {
                if (strict_equals(v, key_value)) {
                    seen = true;
                    break;
                }
            }
            if (seen)
                continue;
            visited.append(key_value);
            JSPropertyDescriptor descriptor;
            completion = internal_get_own_property(vm, *object, key_of_value(key_value), descriptor);
            if (is_throw(completion))
                return completion;
            if (!(descriptor.flags & JS_PD_PRESENT) || !(descriptor.flags & JS_PD_ENUMERABLE))
                continue;
            if (!callback(context, key_value.bits))
                return normal();
        }
        auto prototype = internal_get_prototype_of(vm, *object);
        if (is_throw(prototype))
            return prototype;
        object = reinterpret_cast<Object*>(static_cast<uintptr_t>(prototype.payload));
    }
    return normal();
}

}
