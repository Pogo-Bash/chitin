// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Errors, their [[ErrorData]], throw completions and exception logging.

#include <AK/Format.h>
#include <Ganglion/Runtime.h>

namespace Ganglion {

static bool s_log_all_exceptions = false;

Object* create_error(VM& vm, Realm& realm, u8 kind, Utf16View message)
{
    VERIFY(kind < 10);
    auto* error = static_cast<ErrorObject*>(create_object(vm, realm, error_prototype_for(vm, realm, kind), class_native_error[kind]));
    error->error_data.error_kind = kind;
    if (!message.is_empty())
        define_direct_property(vm, *error, vm.keys->message, Value::from_string(create_string(vm, message)), JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_CONFIGURABLE);
    return error;
}

JSCompletion throw_error(VM& vm, u8 kind, Utf16View message)
{
    auto* error = create_error(vm, *current_realm(vm), kind, message);
    if (s_log_all_exceptions)
        dbgln("ganglion: throwing {}: {}", StringView { class_native_error[kind].name, class_native_error[kind].name_length }, message);
    return throw_value(Value::from_object(error));
}

JSCompletion throw_error(VM& vm, u8 kind, StringView message)
{
    auto string = Utf16String::from_utf8(message);
    return throw_error(vm, kind, string.utf16_view());
}

JSCompletion throw_type_error(VM& vm, StringView message)
{
    return throw_error(vm, 6, message);
}

JSCompletion throw_range_error(VM& vm, StringView message)
{
    return throw_error(vm, 3, message);
}

ErrorData* error_data_of(Object& object)
{
    // By id, not address: class_native_error[0] is a copy of class_error (Heap.cpp), so every plain Error the
    // runtime creates (create_error, js_error_create, the bridge's twins of the host's errors) has that copy
    // as its class. Comparing addresses missed them all, and LibWeb's exception reporter then went on to make
    // a fresh Error for the console and VERIFYed on its missing [[ErrorData]] (owner run 2026-10-11).
    for (auto const* klass = object.klass; klass; klass = klass->parent) {
        if (klass->id == JS_LAYOUT_CLASS_ID_ERROR)
            return &static_cast<ErrorObject&>(object).error_data;
    }
    if (auto const* host_class = host_class_of(object); host_class && host_class->kind == JS_HOST_CLASS_OBJECT) {
        auto const* hooks = static_cast<JSHostObjectHooks const*>(host_class->hooks);
        if (hooks && hooks->error_data) {
            auto* data = hooks->error_data(object_abi(&object));
            if (!data)
                return nullptr;
            // Either an ErrorDataCell of ours or the error data inside one of our errors.
            auto* cell = static_cast<Cell*>(data);
            if (cell->klass == &class_error_data_cell)
                return &static_cast<ErrorDataCell*>(cell)->error_data;
            return static_cast<ErrorData*>(data);
        }
    }
    return nullptr;
}

extern "C" JSCompletion js_error_throw(JSVM* vm, JSErrorKind kind, JSUtf16View message)
{
    return throw_error(vm_of(vm), kind, view_of(message));
}

extern "C" JSCompletion js_error_throw_with_owned_message(JSVM* vm, JSErrorKind kind, JSOwnedUtf16String message)
{
    auto string = Utf16String::adopt_raw(message);
    return throw_error(vm_of(vm), kind, string.utf16_view());
}

extern "C" JSObject* js_error_create(JSVM* vm, JSRealm* realm, JSErrorKind kind)
{
    return object_abi(create_error(vm_of(vm), *realm_of(realm), kind, {}));
}

extern "C" JSObject* js_error_create_with_prototype(JSVM* abi_vm, JSRealm* realm, JSObject* prototype)
{
    auto& vm = vm_of(abi_vm);
    auto* error = static_cast<ErrorObject*>(create_object(vm, *realm_of(realm), object_of(prototype), class_error));
    return object_abi(error);
}

extern "C" void js_error_set_message(JSVM* abi_vm, JSObject* error, JSUtf16View message)
{
    auto& vm = vm_of(abi_vm);
    define_direct_property(vm, *object_of(error), vm.keys->message, Value::from_string(create_string(vm, view_of(message))), JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_CONFIGURABLE);
}

extern "C" void js_error_set_owned_message(JSVM* abi_vm, JSObject* error, JSOwnedUtf16String message)
{
    auto& vm = vm_of(abi_vm);
    define_direct_property(vm, *object_of(error), vm.keys->message, Value::from_string(create_string(vm, Utf16String::adopt_raw(message))), JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_CONFIGURABLE);
}

// InstallErrorCause ( O, options )
extern "C" JSCompletion js_error_install_error_cause(JSVM* abi_vm, JSObject* error, JSValue abi_options)
{
    auto& vm = vm_of(abi_vm);
    Value options { abi_options };
    if (!options.is_object())
        return normal();
    auto has = internal_has_property(vm, *options.as_object(), vm.keys->cause);
    if (is_throw(has))
        return has;
    if (!has.payload)
        return normal();
    auto cause = internal_get(vm, *options.as_object(), vm.keys->cause, options, JS_PROPERTY_LOOKUP_PHASE_OWN_PROPERTY);
    if (is_throw(cause))
        return cause;
    define_direct_property(vm, *object_of(error), vm.keys->cause, value_of(cause), JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_CONFIGURABLE);
    return normal();
}

extern "C" JSErrorData const* js_error_data_of(JSObject* object)
{
    return reinterpret_cast<JSErrorData const*>(error_data_of(*object_of(object)));
}

extern "C" JSOwnedUtf16String js_error_data_stack_string(JSErrorData const*, bool)
{
    return Utf16String {}.into_raw();
}

extern "C" size_t js_error_data_traceback_length(JSErrorData const*)
{
    return 0;
}

extern "C" void js_error_data_traceback_frame(JSErrorData const*, size_t, JSTracebackFrame* out)
{
    *out = JSTracebackFrame {};
}

extern "C" JSErrorDataCell* js_error_data_cell_capture(JSVM* vm)
{
    return reinterpret_cast<JSErrorDataCell*>(allocate<ErrorDataCell>(vm_of(vm), class_error_data_cell));
}

extern "C" void js_completion_set_log_all_exceptions(bool enabled, JSByteSink const*)
{
    s_log_all_exceptions = enabled;
}

extern "C" void js_completion_log_exception(JSVM* vm, JSValue value)
{
    dbgln("ganglion: exception: {}", to_string_without_side_effects(vm_of(vm), Value { value }));
}

}
