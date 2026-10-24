// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Realms and their intrinsics, environment records, job callbacks.

#include <AK/Format.h>
#include <Ganglion/Runtime.h>

namespace Ganglion {

Realm* current_realm(VM& vm)
{
    if (vm.type_error_realm_override)
        return vm.type_error_realm_override;
    if (vm.running_execution_context && vm.running_execution_context->realm)
        return vm.running_execution_context->realm;
    VERIFY(vm.realms && !vm.realms->is_empty());
    return vm.realms->first();
}

static JSCompletion stub_behaviour(JSVM* vm)
{
    return throw_type_error(vm_of(vm), "This builtin is not available in this build"sv);
}

static JSCompletion return_undefined(JSVM*)
{
    return normal(Value::undefined());
}

static FunctionObject* stub_constructor(VM& vm, Realm& realm, StringView name, Object* prototype_object)
{
    auto* function = create_native_function(vm, &realm, FunctionKind::Stub, stub_behaviour, nullptr, nullptr, 0, Utf16FlyString::from_utf8_without_validation(name), {}, true);
    function->is_constructor = true;
    if (prototype_object) {
        define_direct_property(vm, *function, vm.keys->prototype, Value::from_object(prototype_object), 0);
        define_direct_property(vm, *prototype_object, vm.keys->constructor, Value::from_object(function), JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_CONFIGURABLE);
    }
    return function;
}

Object* named_prototype(VM& vm, Realm& realm, Object* parent, StringView name)
{
    auto* object = create_object(vm, realm, parent);
    auto to_string_tag = Key::from_symbol(vm.well_known_symbols[14]);
    define_direct_property(vm, *object, to_string_tag, Value::from_string(create_string(vm, Utf16String::from_utf8(name))), JS_ATTRIBUTE_CONFIGURABLE);
    return object;
}

Object* error_prototype_for(VM& vm, Realm& realm, u8 kind)
{
    VERIFY(kind < 10);
    auto& intrinsics = *realm.intrinsics;
    if (!intrinsics.error_prototypes[kind]) {
        Object* parent = kind == 0 ? intrinsic(vm, realm, JS_INTRINSIC_OBJECT_PROTOTYPE) : error_prototype_for(vm, realm, 0);
        auto* prototype = create_object(vm, realm, parent);
        StringView name { class_native_error[kind].name, class_native_error[kind].name_length };
        define_direct_property(vm, *prototype, vm.keys->name, Value::from_string(create_string(vm, Utf16String::from_utf8(name))), JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_CONFIGURABLE);
        define_direct_property(vm, *prototype, vm.keys->message, Value::from_string(vm.empty_string), JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_CONFIGURABLE);
        intrinsics.error_prototypes[kind] = prototype;
        stub_constructor(vm, realm, name, prototype);
    }
    return intrinsics.error_prototypes[kind];
}

Object* promise_prototype(VM& vm, Realm& realm)
{
    auto& intrinsics = *realm.intrinsics;
    if (!intrinsics.promise_prototype)
        intrinsics.promise_prototype = named_prototype(vm, realm, intrinsic(vm, realm, JS_INTRINSIC_OBJECT_PROTOTYPE), "Promise"sv);
    return intrinsics.promise_prototype;
}

Object* intrinsic(VM& vm, Realm& realm, JSIntrinsic which)
{
    VERIFY(which < JS_INTRINSIC_COUNT);
    auto& intrinsics = *realm.intrinsics;
    if (auto* object = intrinsics.slots[which])
        return object;
    Object* object = nullptr;
    switch (which) {
    case JS_INTRINSIC_OBJECT_PROTOTYPE:
        object = create_object(vm, realm, nullptr);
        break;
    case JS_INTRINSIC_FUNCTION_PROTOTYPE: {
        // %Function.prototype% is itself a function that returns undefined, whose prototype is %Object.prototype%.
        auto* function = static_cast<FunctionObject*>(create_object(vm, realm, intrinsic(vm, realm, JS_INTRINSIC_OBJECT_PROTOTYPE), class_function));
        function->flags |= JS_LAYOUT_OBJECT_FLAG_IS_FUNCTION | JS_LAYOUT_OBJECT_FLAG_IS_RAW_NATIVE_FUNCTION;
        function->realm = &realm;
        function->function_kind = FunctionKind::Native;
        function->behaviour = return_undefined;
        function->name_raw = Utf16FlyString {}.into_raw();
        object = function;
        break;
    }
    case JS_INTRINSIC_ARRAY_PROTOTYPE: {
        auto* array = create_object(vm, realm, intrinsic(vm, realm, JS_INTRINSIC_OBJECT_PROTOTYPE), class_array);
        object = array;
        intrinsics.slots[which] = array; // set first: nothing made below may recurse into this case
        install_array_iteration(vm, realm, *array);
        break;
    }
    case JS_INTRINSIC_STRING_PROTOTYPE:
        object = create_object(vm, realm, intrinsic(vm, realm, JS_INTRINSIC_OBJECT_PROTOTYPE), class_string_object);
        static_cast<PrimitiveWrapper*>(object)->primitive = Value::from_string(vm.empty_string);
        break;
    case JS_INTRINSIC_ERROR_PROTOTYPE:
        object = error_prototype_for(vm, realm, 0);
        break;
    case JS_INTRINSIC_ITERATOR_PROTOTYPE:
        object = named_prototype(vm, realm, intrinsic(vm, realm, JS_INTRINSIC_OBJECT_PROTOTYPE), "Iterator"sv);
        intrinsics.slots[which] = object; // set first: nothing made below may recurse into this case
        install_iterator_iteration(vm, realm, *object);
        break;
    case JS_INTRINSIC_ASYNC_ITERATOR_PROTOTYPE:
        object = create_object(vm, realm, intrinsic(vm, realm, JS_INTRINSIC_OBJECT_PROTOTYPE));
        break;
    case JS_INTRINSIC_ERROR_CONSTRUCTOR: {
        auto* prototype = error_prototype_for(vm, realm, 0);
        auto* constructor = find_own_property(*prototype, vm.keys->constructor);
        object = constructor->value.as_object();
        break;
    }
    case JS_INTRINSIC_PROMISE_CONSTRUCTOR: {
        auto* prototype = promise_prototype(vm, realm);
        auto* function = create_native_function(vm, &realm, FunctionKind::PromiseConstructor, nullptr, nullptr, nullptr, 1, Utf16FlyString::from_utf8_without_validation("Promise"sv), {}, true);
        function->is_constructor = true;
        define_direct_property(vm, *function, vm.keys->prototype, Value::from_object(prototype), 0);
        define_direct_property(vm, *prototype, vm.keys->constructor, Value::from_object(function), JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_CONFIGURABLE);
        object = function;
        break;
    }
    case JS_INTRINSIC_SHARED_ARRAY_BUFFER_CONSTRUCTOR:
        object = stub_constructor(vm, realm, "SharedArrayBuffer"sv, named_prototype(vm, realm, intrinsic(vm, realm, JS_INTRINSIC_OBJECT_PROTOTYPE), "SharedArrayBuffer"sv));
        break;
    case JS_INTRINSIC_DATA_VIEW_CONSTRUCTOR:
        object = stub_constructor(vm, realm, "DataView"sv, named_prototype(vm, realm, intrinsic(vm, realm, JS_INTRINSIC_OBJECT_PROTOTYPE), "DataView"sv));
        break;
    case JS_INTRINSIC_UINT8_ARRAY_CONSTRUCTOR:
    case JS_INTRINSIC_UINT8_CLAMPED_ARRAY_CONSTRUCTOR:
    case JS_INTRINSIC_UINT16_ARRAY_CONSTRUCTOR:
    case JS_INTRINSIC_UINT32_ARRAY_CONSTRUCTOR:
    case JS_INTRINSIC_BIG_UINT64_ARRAY_CONSTRUCTOR:
    case JS_INTRINSIC_INT8_ARRAY_CONSTRUCTOR:
    case JS_INTRINSIC_INT16_ARRAY_CONSTRUCTOR:
    case JS_INTRINSIC_INT32_ARRAY_CONSTRUCTOR:
    case JS_INTRINSIC_BIG_INT64_ARRAY_CONSTRUCTOR:
    case JS_INTRINSIC_FLOAT16_ARRAY_CONSTRUCTOR:
    case JS_INTRINSIC_FLOAT32_ARRAY_CONSTRUCTOR:
    case JS_INTRINSIC_FLOAT64_ARRAY_CONSTRUCTOR: {
        object = typed_array_constructor(vm, realm, static_cast<u8>(which - JS_INTRINSIC_UINT8_ARRAY_CONSTRUCTOR));
        break;
    }
    case JS_INTRINSIC_JSON_STRINGIFY_FUNCTION:
        object = create_native_function(vm, &realm, FunctionKind::Stub, stub_behaviour, nullptr, nullptr, 3, Utf16FlyString::from_utf8_without_validation("stringify"sv), {}, true);
        break;
    case JS_INTRINSIC_CONSOLE_OBJECT: {
        auto* console_object = static_cast<ConsoleObject*>(create_object(vm, realm, intrinsic(vm, realm, JS_INTRINSIC_OBJECT_PROTOTYPE), class_console_object));
        auto* console = allocate<Console>(vm, class_console);
        console->realm = &realm;
        console_object->console = console;
        object = console_object;
        break;
    }
    default:
        return nullptr;
    }
    intrinsics.slots[which] = object;
    return object;
}

Environment* create_environment(VM& vm, u8 kind, Environment* outer)
{
    VERIFY(kind < 5);
    auto* environment = allocate<Environment>(vm, class_environment[kind]);
    environment->env_kind = kind;
    environment->outer = outer;
    if (kind == JS_ENVIRONMENT_KIND_DECLARATIVE || kind == JS_ENVIRONMENT_KIND_FUNCTION || kind == JS_ENVIRONMENT_KIND_MODULE)
        environment->bindings = new HashMap<FlatPtr, Binding>;
    return environment;
}

// InitializeHostDefinedRealm ( ), with the global object and its this value created by the embedder.
extern "C" JSCompletion js_realm_initialize_host_defined_realm(JSVM* abi_vm, void* new_context, JSCreateRealmObjectCallback create_global_object, void* create_global_object_context, JSCreateRealmObjectCallback create_global_this_value, void* create_global_this_value_context)
{
    auto& vm = vm_of(abi_vm);
    auto* realm = allocate<Realm>(vm, class_realm);
    realm->intrinsics = new Intrinsics {};
    vm.realms->append(realm);

    auto* context = static_cast<ExecutionContext*>(new_context);
    __builtin_memset(context, 0, sizeof(ExecutionContext));
    context->yield_continuation = 0xFFFFFFFFu;
    context->this_value = Value::empty();
    context->realm = realm;
    js_execution_context_push(abi_vm, reinterpret_cast<JSExecutionContext*>(context));

    intrinsic(vm, *realm, JS_INTRINSIC_OBJECT_PROTOTYPE);
    intrinsic(vm, *realm, JS_INTRINSIC_FUNCTION_PROTOTYPE);

    Object* global_object = nullptr;
    if (create_global_object)
        global_object = object_of(create_global_object(create_global_object_context, realm_abi(realm)));
    else
        global_object = create_object(vm, *realm, intrinsic(vm, *realm, JS_INTRINSIC_OBJECT_PROTOTYPE), class_global_object);
    VERIFY(global_object);
    global_object->flags |= JS_LAYOUT_OBJECT_FLAG_IS_GLOBAL_OBJECT;
    realm->global_object = global_object;

    Object* this_value = global_object;
    if (create_global_this_value)
        this_value = object_of(create_global_this_value(create_global_this_value_context, realm_abi(realm)));
    VERIFY(this_value);

    auto* object_record = create_environment(vm, JS_ENVIRONMENT_KIND_OBJECT, nullptr);
    object_record->binding_object = global_object;
    auto* declarative_record = create_environment(vm, JS_ENVIRONMENT_KIND_DECLARATIVE, nullptr);
    auto* global_environment = create_environment(vm, JS_ENVIRONMENT_KIND_GLOBAL, nullptr);
    global_environment->binding_object = this_value;
    global_environment->object_record = object_record;
    global_environment->declarative_record = declarative_record;
    realm->global_environment = global_environment;
    context->lexical_environment = global_environment;
    context->variable_environment = global_environment;
    return normal();
}

extern "C" void js_realm_set_host_defined(JSRealm* realm, void* host_defined)
{
    realm_of(realm)->host_defined = host_defined;
}

extern "C" JSObject* js_realm_intrinsic(JSVM* vm, JSRealm* realm, JSIntrinsic which)
{
    return object_abi(intrinsic(vm_of(vm), *realm_of(realm), which));
}

extern "C" JSCompletion js_realm_get_function_realm(JSVM* vm, JSObject* function)
{
    auto& object = *object_of(function);
    if (is_function_object(object))
        return normal_cell(static_cast<FunctionObject&>(object).realm);
    return normal_cell(current_realm(vm_of(vm)));
}

extern "C" JSJobCallback* js_realm_job_callback_create(JSVM* abi_vm, JSObject* callback, void* custom_data)
{
    auto& vm = vm_of(abi_vm);
    auto* job_callback = allocate<JobCallback>(vm, class_job_callback);
    job_callback->callback = object_of(callback);
    job_callback->custom_data = custom_data;
    return reinterpret_cast<JSJobCallback*>(job_callback);
}

extern "C" JSObject* js_realm_job_callback_callback(JSJobCallback* job_callback)
{
    return object_abi(reinterpret_cast<JobCallback*>(job_callback)->callback);
}

extern "C" void* js_realm_job_callback_custom_data(JSJobCallback* job_callback)
{
    return reinterpret_cast<JobCallback*>(job_callback)->custom_data;
}

extern "C" JSCompletion js_vm_default_host_call_job_callback(JSVM* vm, JSJobCallback* job_callback, JSValue this_value, JSValue const* arguments, size_t argument_count)
{
    auto* callback = reinterpret_cast<JobCallback*>(job_callback)->callback;
    return call(vm_of(vm), Value::from_object(callback), Value { this_value }, reinterpret_cast<Value const*>(arguments), argument_count);
}

// --- Environments --------------------------------------------------------------------------------------

static Environment* environment_of(JSEnvironment* environment)
{
    return reinterpret_cast<Environment*>(environment);
}

static JSEnvironment* environment_abi(Environment* environment)
{
    return reinterpret_cast<JSEnvironment*>(environment);
}

static Binding* find_binding(Environment& environment, Utf16View name)
{
    if (!environment.bindings)
        return nullptr;
    auto fly = Utf16FlyString::from_utf16(name);
    return environment.bindings->get(fly.raw_identity()).map([](auto& b) { return &b; }).value_or(nullptr);
}

extern "C" JSEnvironment* js_environment_new_object_environment(JSVM* vm, JSObject* binding_object, bool is_with_environment, JSEnvironment* outer)
{
    auto* environment = create_environment(vm_of(vm), JS_ENVIRONMENT_KIND_OBJECT, environment_of(outer));
    environment->binding_object = object_of(binding_object);
    environment->is_with_environment = is_with_environment;
    return environment_abi(environment);
}

extern "C" JSEnvironment* js_environment_new_module_environment(JSVM* vm, JSEnvironment* outer)
{
    return environment_abi(create_environment(vm_of(vm), JS_ENVIRONMENT_KIND_MODULE, environment_of(outer)));
}

extern "C" JSCompletion js_environment_create_immutable_binding(JSVM* vm, JSEnvironment* abi_environment, JSUtf16View name, bool strict)
{
    auto& environment = *environment_of(abi_environment);
    if (environment.env_kind == JS_ENVIRONMENT_KIND_GLOBAL)
        return js_environment_create_immutable_binding(vm, environment_abi(environment.declarative_record), name, strict);
    VERIFY(environment.bindings);
    auto fly = Utf16FlyString::from_utf16(view_of(name));
    auto raw = Utf16FlyString(fly).into_raw();
    environment.bindings->set(raw, Binding { .value = Value::undefined(), .is_mutable = false, .initialized = false, .strict = strict });
    return normal();
}

extern "C" JSCompletion js_environment_initialize_binding(JSVM* abi_vm, JSEnvironment* abi_environment, JSUtf16View name, JSValue value, uint8_t)
{
    auto& vm = vm_of(abi_vm);
    auto& environment = *environment_of(abi_environment);
    if (environment.env_kind == JS_ENVIRONMENT_KIND_OBJECT || environment.env_kind == JS_ENVIRONMENT_KIND_GLOBAL) {
        auto& object = environment.env_kind == JS_ENVIRONMENT_KIND_GLOBAL ? *environment.object_record->binding_object : *environment.binding_object;
        auto fly = Utf16FlyString::from_utf16(view_of(name));
        if (environment.env_kind == JS_ENVIRONMENT_KIND_GLOBAL) {
            if (auto* binding = find_binding(*environment.declarative_record, view_of(name))) {
                binding->value = Value { value };
                binding->initialized = true;
                return normal();
            }
        }
        auto completion = internal_set(vm, object, Key::from_fly_string(fly), Value { value }, Value::from_object(&object), JS_PROPERTY_LOOKUP_PHASE_OWN_PROPERTY);
        if (is_throw(completion))
            return completion;
        return normal();
    }
    auto* binding = find_binding(environment, view_of(name));
    if (!binding) {
        auto raw = Utf16FlyString(Utf16FlyString::from_utf16(view_of(name))).into_raw();
        environment.bindings->set(raw, Binding {});
        binding = find_binding(environment, view_of(name));
    }
    binding->value = Value { value };
    binding->initialized = true;
    return normal();
}

extern "C" JSCompletion js_environment_set_mutable_binding(JSVM* abi_vm, JSEnvironment* abi_environment, JSUtf16View name, JSValue value, bool strict)
{
    auto& vm = vm_of(abi_vm);
    auto& environment = *environment_of(abi_environment);
    if (environment.env_kind == JS_ENVIRONMENT_KIND_OBJECT || environment.env_kind == JS_ENVIRONMENT_KIND_GLOBAL) {
        if (environment.env_kind == JS_ENVIRONMENT_KIND_GLOBAL) {
            if (auto* binding = find_binding(*environment.declarative_record, view_of(name))) {
                if (!binding->is_mutable && strict)
                    return throw_type_error(vm, "Invalid assignment to const variable"sv);
                binding->value = Value { value };
                return normal();
            }
        }
        auto& object = environment.env_kind == JS_ENVIRONMENT_KIND_GLOBAL ? *environment.object_record->binding_object : *environment.binding_object;
        auto fly = Utf16FlyString::from_utf16(view_of(name));
        auto completion = internal_set(vm, object, Key::from_fly_string(fly), Value { value }, Value::from_object(&object), JS_PROPERTY_LOOKUP_PHASE_OWN_PROPERTY);
        if (is_throw(completion))
            return completion;
        if (!completion.payload && strict)
            return throw_type_error(vm, "Cannot assign to read-only property"sv);
        return normal();
    }
    auto* binding = find_binding(environment, view_of(name));
    if (!binding) {
        if (strict)
            return throw_error(vm, 4 /* ReferenceError */, "Unknown binding"sv);
        return js_environment_initialize_binding(abi_vm, abi_environment, name, value, 0);
    }
    if (!binding->is_mutable && (strict || binding->strict))
        return throw_type_error(vm, "Invalid assignment to const variable"sv);
    binding->value = Value { value };
    return normal();
}

extern "C" JSCompletion js_environment_get_binding_value(JSVM* abi_vm, JSEnvironment* abi_environment, JSUtf16View name, bool strict)
{
    auto& vm = vm_of(abi_vm);
    auto& environment = *environment_of(abi_environment);
    if (environment.env_kind == JS_ENVIRONMENT_KIND_OBJECT || environment.env_kind == JS_ENVIRONMENT_KIND_GLOBAL) {
        if (environment.env_kind == JS_ENVIRONMENT_KIND_GLOBAL) {
            if (auto* binding = find_binding(*environment.declarative_record, view_of(name)))
                return normal(binding->value);
        }
        auto& object = environment.env_kind == JS_ENVIRONMENT_KIND_GLOBAL ? *environment.object_record->binding_object : *environment.binding_object;
        auto fly = Utf16FlyString::from_utf16(view_of(name));
        auto key = Key::from_fly_string(fly);
        auto has = internal_has_property(vm, object, key);
        if (is_throw(has))
            return has;
        if (!has.payload) {
            if (strict)
                return throw_error(vm, 4 /* ReferenceError */, "Unknown binding"sv);
            return normal(Value::undefined());
        }
        return internal_get(vm, object, key, Value::from_object(&object), JS_PROPERTY_LOOKUP_PHASE_OWN_PROPERTY);
    }
    auto* binding = find_binding(environment, view_of(name));
    if (!binding)
        return throw_error(vm, 4 /* ReferenceError */, "Unknown binding"sv);
    if (!binding->initialized)
        return throw_error(vm, 4 /* ReferenceError */, "Binding is not initialized"sv);
    return normal(binding->value);
}

extern "C" JSCompletion js_environment_delete_binding(JSVM* abi_vm, JSEnvironment* abi_environment, JSUtf16View name)
{
    auto& vm = vm_of(abi_vm);
    auto& environment = *environment_of(abi_environment);
    if (environment.env_kind == JS_ENVIRONMENT_KIND_OBJECT || environment.env_kind == JS_ENVIRONMENT_KIND_GLOBAL) {
        auto& object = environment.env_kind == JS_ENVIRONMENT_KIND_GLOBAL ? *environment.object_record->binding_object : *environment.binding_object;
        auto fly = Utf16FlyString::from_utf16(view_of(name));
        return internal_delete(vm, object, Key::from_fly_string(fly));
    }
    auto* binding = find_binding(environment, view_of(name));
    if (!binding)
        return normal(true);
    return normal(false);
}

extern "C" JSCompletion js_environment_resolve_binding(JSVM* abi_vm, JSUtf16View name, bool, JSEnvironment* abi_environment)
{
    auto& vm = vm_of(abi_vm);
    for (auto* environment = environment_of(abi_environment); environment; environment = environment->outer) {
        if (environment->env_kind == JS_ENVIRONMENT_KIND_OBJECT || environment->env_kind == JS_ENVIRONMENT_KIND_GLOBAL) {
            if (environment->env_kind == JS_ENVIRONMENT_KIND_GLOBAL && find_binding(*environment->declarative_record, view_of(name)))
                return normal_cell(environment);
            auto& object = environment->env_kind == JS_ENVIRONMENT_KIND_GLOBAL ? *environment->object_record->binding_object : *environment->binding_object;
            auto fly = Utf16FlyString::from_utf16(view_of(name));
            auto has = internal_has_property(vm, object, Key::from_fly_string(fly));
            if (is_throw(has))
                return has;
            if (has.payload)
                return normal_cell(environment);
            continue;
        }
        if (find_binding(*environment, view_of(name)))
            return normal_cell(environment);
    }
    return normal_cell(nullptr);
}

extern "C" uint8_t js_environment_kind(JSEnvironment* environment)
{
    return environment_of(environment)->env_kind;
}

extern "C" JSEnvironment* js_environment_outer(JSEnvironment* environment)
{
    return environment_abi(environment_of(environment)->outer);
}

extern "C" void js_environment_declarative_binding_names(JSEnvironment* abi_environment, JSStringSink* names)
{
    auto& environment = *environment_of(abi_environment);
    if (!environment.bindings)
        return;
    for (auto& it : *environment.bindings) {
        auto fly = Utf16FlyString::from_raw(it.key);
        Utf16String widened = Utf16String { fly };
        auto view = widened.utf16_view();
        Vector<u16> units;
        units.ensure_capacity(view.length_in_code_units());
        for (size_t i = 0; i < view.length_in_code_units(); ++i)
            units.unchecked_append(view.code_unit_at(i));
        names->append(names->context, units.data(), units.size());
    }
}

extern "C" bool js_environment_declarative_binding_is_mutable(JSEnvironment* abi_environment, JSUtf16View name)
{
    auto* binding = find_binding(*environment_of(abi_environment), view_of(name));
    return binding ? binding->is_mutable : false;
}

extern "C" JSEnvironment* js_environment_global_declarative_record(JSEnvironment* environment)
{
    return environment_abi(environment_of(environment)->declarative_record);
}

extern "C" JSObject* js_environment_global_this_value(JSEnvironment* environment)
{
    return object_abi(environment_of(environment)->binding_object);
}

extern "C" JSObject* js_environment_object_binding_object(JSEnvironment* environment)
{
    return object_abi(environment_of(environment)->binding_object);
}

extern "C" JSObject* js_environment_function_object(JSEnvironment* environment)
{
    return object_abi(environment_of(environment)->function);
}

}
