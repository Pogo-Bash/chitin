// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Functions: native functions and closures of the embedder, host functions, calling and constructing.
// A call pushes an execution context with the arguments in its slots, as the Rust runtime does, so the
// facade's NativeFunction reads vm.argument(i) from the running context.

#include <AK/Format.h>
#include <Ganglion/Runtime.h>

namespace Ganglion {

FunctionObject* create_native_function(VM& vm, Realm* realm, FunctionKind kind, JSNativeFunction behaviour, JSClosureCall closure_call, void* context, i32 length, Utf16FlyString const& name, StringView prefix, bool with_own_properties)
{
    if (!realm)
        realm = current_realm(vm);
    auto* function = static_cast<FunctionObject*>(create_object(vm, *realm, intrinsic(vm, *realm, JS_INTRINSIC_FUNCTION_PROTOTYPE), class_function));
    function->flags |= JS_LAYOUT_OBJECT_FLAG_IS_FUNCTION;
    if (kind == FunctionKind::Native)
        function->flags |= JS_LAYOUT_OBJECT_FLAG_IS_RAW_NATIVE_FUNCTION;
    if (kind == FunctionKind::DirectGetter)
        function->flags |= JS_LAYOUT_OBJECT_FLAG_IS_DIRECT_GETTER_FUNCTION;
    function->realm = realm;
    function->function_kind = kind;
    function->behaviour = behaviour;
    function->closure_call = closure_call;
    function->closure_context = context;
    function->length = length;
    Utf16FlyString full_name = name;
    if (!prefix.is_empty()) {
        auto prefixed = Utf16String::formatted("{} {}", prefix, name.view());
        full_name = Utf16FlyString::from_utf16(prefixed.utf16_view());
    }
    function->name_raw = Utf16FlyString(full_name).into_raw();
    if (with_own_properties) {
        define_direct_property(vm, *function, vm.keys->length, Value::from_i32(length), JS_ATTRIBUTE_CONFIGURABLE);
        define_direct_property(vm, *function, vm.keys->name, Value::from_string(create_string(vm, Utf16String { full_name })), JS_ATTRIBUTE_CONFIGURABLE);
    }
    return function;
}

static JSCompletion dispatch(VM& vm, FunctionObject& function, Object* new_target)
{
    switch (function.function_kind) {
    case FunctionKind::Native:
    case FunctionKind::DirectGetter:
        return function.behaviour(vm_abi(vm));
    case FunctionKind::Closure:
        return function.closure_call(function.closure_context, vm_abi(vm));
    case FunctionKind::Host: {
        auto& host_function = static_cast<HostFunction&>(function);
        auto const* hooks = static_cast<JSHostFunctionHooks const*>(host_function.host_class->hooks);
        if (new_target) {
            if (!hooks || !hooks->construct)
                return throw_type_error(vm, "Not a constructor"sv);
            return hooks->construct(object_abi(&function), vm_abi(vm), object_abi(new_target));
        }
        if (!hooks || !hooks->call)
            return throw_type_error(vm, "Not callable"sv);
        return hooks->call(object_abi(&function), vm_abi(vm));
    }
    case FunctionKind::PromiseResolve:
    case FunctionKind::PromiseReject:
        return promise_resolving_function_behaviour(vm, function);
    case FunctionKind::PromiseConstructor:
        return promise_constructor_behaviour(vm_abi(vm));
    case FunctionKind::Stub:
        return throw_type_error(vm, "This builtin is not available in this build"sv);
    }
    VERIFY_NOT_REACHED();
}

static JSCompletion call_or_construct(VM& vm, FunctionObject& function, Value this_value, Value const* arguments, size_t count, Object* new_target)
{
    auto* context = reinterpret_cast<ExecutionContext*>(js_execution_context_create(0, 0, count));
    for (size_t i = 0; i < count; ++i)
        context->arguments()[i] = arguments[i];
    context->function = &function;
    context->realm = function.realm ? function.realm : current_realm(vm);
    context->this_value = this_value;
    context->passed_argument_count = count;
    js_execution_context_push(vm_abi(vm), reinterpret_cast<JSExecutionContext*>(context));
    auto completion = dispatch(vm, function, new_target);
    pop_execution_context(vm);
    js_execution_context_destroy(reinterpret_cast<JSExecutionContext*>(context));
    return completion;
}

JSCompletion call(VM& vm, Value function, Value this_value, Value const* arguments, size_t count)
{
    if (!is_callable(function))
        return throw_type_error(vm, "Value is not a function"sv);
    return call_or_construct(vm, *static_cast<FunctionObject*>(function.as_object()), this_value, arguments, count, nullptr);
}

JSCompletion construct(VM& vm, Object& function, Value const* arguments, size_t count, Object* new_target)
{
    if (!is_constructor(Value::from_object(&function)))
        return throw_type_error(vm, "Value is not a constructor"sv);
    return call_or_construct(vm, static_cast<FunctionObject&>(function), Value::undefined(), arguments, count, new_target ? new_target : &function);
}

JSCompletion call_method(VM& vm, Value receiver, Key key, Value const* arguments, size_t count)
{
    auto object = to_object(vm, receiver);
    if (is_throw(object))
        return object;
    auto method = internal_get(vm, *reinterpret_cast<Object*>(static_cast<uintptr_t>(object.payload)), key, receiver, JS_PROPERTY_LOOKUP_PHASE_OWN_PROPERTY);
    if (is_throw(method))
        return method;
    return call(vm, value_of(method), receiver, arguments, count);
}

static StringView prefix_view(char const* prefix, size_t length)
{
    if (!prefix || length == 0)
        return {};
    return StringView { prefix, length };
}

static Utf16FlyString name_of(JSPropertyKey const* abi_name)
{
    if (!abi_name)
        return {};
    auto key = Key::from_abi(abi_name);
    if (key.is_string())
        return key.as_fly_string();
    if (key.is_number()) {
        auto number = Utf16String::number(key.as_number());
        return Utf16FlyString::from_utf16(number.utf16_view());
    }
    auto* symbol = key.as_symbol();
    if (!symbol->description_raw)
        return {};
    auto description = Utf16String::from_raw(symbol->description_raw);
    auto bracketed = Utf16String::formatted("[{}]", description.utf16_view());
    return Utf16FlyString::from_utf16(bracketed.utf16_view());
}

extern "C" JSObject* js_function_create_native(JSVM* vm, JSNativeFunction behaviour, int32_t length, JSPropertyKey const* name, JSRealm* realm, char const* prefix, size_t prefix_length)
{
    return object_abi(create_native_function(vm_of(vm), realm_of(realm), FunctionKind::Native, behaviour, nullptr, nullptr, length, name_of(name), prefix_view(prefix, prefix_length), true));
}

extern "C" JSObject* js_function_create_closure(JSVM* vm, JSClosureCall call, void* context, int32_t length, JSPropertyKey const* name, JSRealm* realm, char const* prefix, size_t prefix_length)
{
    return object_abi(create_native_function(vm_of(vm), realm_of(realm), FunctionKind::Closure, nullptr, call, context, length, name_of(name), prefix_view(prefix, prefix_length), true));
}

extern "C" JSObject* js_function_create_closure_with_name(JSVM* vm, JSRealm* realm, JSUtf16View name, JSClosureCall call, void* context)
{
    return object_abi(create_native_function(vm_of(vm), realm_of(realm), FunctionKind::Closure, nullptr, call, context, 0, Utf16FlyString::from_utf16(view_of(name)), {}, true));
}

extern "C" JSObject* js_function_create_direct_getter(JSVM* vm, JSRealm* realm, JSNativeFunction behaviour, int32_t length, JSPropertyKey const* name, JSDirectGetterConfiguration const*, char const* prefix, size_t prefix_length)
{
    return object_abi(create_native_function(vm_of(vm), realm_of(realm), FunctionKind::DirectGetter, behaviour, nullptr, nullptr, length, name_of(name), prefix_view(prefix, prefix_length), true));
}

extern "C" JSRealm* js_function_realm(JSObject* function)
{
    return realm_abi(static_cast<FunctionObject*>(object_of(function))->realm);
}

extern "C" JSOwnedUtf16String js_function_name_for_call_stack(JSObject* abi_function)
{
    auto& function = *static_cast<FunctionObject*>(object_of(abi_function));
    if (function.name_raw)
        return Utf16String { Utf16FlyString::from_raw(function.name_raw) }.into_raw();
    return Utf16String {}.into_raw();
}

extern "C" JSCompletion js_function_call(JSVM* vm, JSValue function, JSValue this_value, JSValue const* arguments, size_t count)
{
    return call(vm_of(vm), Value { function }, Value { this_value }, reinterpret_cast<Value const*>(arguments), count);
}

extern "C" JSCompletion js_function_construct(JSVM* vm, JSObject* function, JSValue const* arguments, size_t count, JSObject* new_target)
{
    return construct(vm_of(vm), *object_of(function), reinterpret_cast<Value const*>(arguments), count, object_of(new_target));
}

// GetMethod ( V, P )
extern "C" JSCompletion js_function_get_method(JSVM* abi_vm, JSValue abi_value, JSPropertyKey const* key)
{
    auto& vm = vm_of(abi_vm);
    Value value { abi_value };
    auto object = to_object(vm, value);
    if (is_throw(object))
        return object;
    auto method = internal_get(vm, *reinterpret_cast<Object*>(static_cast<uintptr_t>(object.payload)), Key::from_abi(key), value, JS_PROPERTY_LOOKUP_PHASE_OWN_PROPERTY);
    if (is_throw(method))
        return method;
    if (value_of(method).is_nullish())
        return normal(Value::undefined());
    if (!is_callable(value_of(method)))
        return throw_type_error(vm, "Property is not a function"sv);
    return method;
}


// --- Functions from source text ------------------------------------------------------------------------------------
// CreateDynamicFunction as LibWeb uses it (an event handler's content attribute): the text is checked when the
// function is compiled, and the host's engine compiles it when it is instantiated, with the scope the caller gives.

extern "C" JSSharedFunctionData* js_function_compile_dynamic(JSVM* abi_vm, JSUtf16View source_text, JSUtf16View parameters, JSUtf16View body, uint8_t kind, JSOwnedUtf16String* error_message)
{
    auto& vm = vm_of(abi_vm);
    if (!g_dynamic_function_check) {
        *error_message = "Ganglion runs no JavaScript here (scripting is off)"_utf16.into_raw();
        return nullptr;
    }
    if (!g_dynamic_function_check(vm, view_of(parameters), view_of(body), kind, error_message))
        return nullptr;
    auto* data = allocate<DynamicFunction>(vm, class_dynamic_function);
    data->source_raw = Utf16String::from_utf16(view_of(source_text)).into_raw();
    data->parameters_raw = Utf16String::from_utf16(view_of(parameters)).into_raw();
    data->body_raw = Utf16String::from_utf16(view_of(body)).into_raw();
    data->kind = kind;
    return reinterpret_cast<JSSharedFunctionData*>(data);
}

extern "C" JSObject* js_function_instantiate_dynamic(JSVM* abi_vm, JSRealm* realm, JSSharedFunctionData* function_data, JSEnvironment* scope, JSPrivateEnvironment*, JSScriptOrModule)
{
    auto& vm = vm_of(abi_vm);
    VERIFY(g_dynamic_function_instantiate);
    auto* function = g_dynamic_function_instantiate(vm, *realm_of(realm), *reinterpret_cast<DynamicFunction*>(function_data), reinterpret_cast<Environment*>(scope));
    return object_abi(function);
}

}
