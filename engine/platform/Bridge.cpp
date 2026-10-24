// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// The bridge between the runtime and the host's JavaScript engine (V8 in the segment Worker):
// docs/phase2.md section 2. Two host classes whose hooks are imports ("foreign" objects and functions:
// V8 values LibWeb's code can get, set, call and iterate without knowing where they live), the exports
// the glue's mirror uses to read the runtime's prototypes and values and to call native functions, and
// the script, JSON and value-crossing entry points.
//
// Values cross as 64-bit NaN-boxed runtime values written to and read from linear memory: the glue
// decodes the tag itself (Runtime.h's constants) and asks here only about cells.

#include <AK/HashTable.h>
#include <AK/JsonObject.h>
#include <AK/Vector.h>
#include <Ganglion/Runtime.h>
#include <LibJS/HostObjectABI.h>
#include <LibWeb/Bindings/MainThreadVM.h>
#include <LibWeb/Bindings/PlatformObject.h>
#include <LibWeb/Bindings/Wrappable.h>
#include <LibWeb/DOM/Event.h>
#include <LibWeb/DOM/EventTarget.h>
#include <LibWeb/HTML/Scripting/ImportMap.h>
#include <LibWeb/HTML/Window.h>
#include <LibWeb/HTML/WindowProxy.h>
#include <stdint.h>

#define GANGLION_EXPORT extern "C" __attribute__((used, visibility("default")))

// --- What the host provides (wasm imports) ------------------------------------------------------------

extern "C" {
// Foreign objects: `handle` is the glue's table index. Every call writes a runtime value into `result`
// (the value, or the thrown value) and returns 0 for a normal completion, 1 for a throw.
int ganglion_host_js_get(uint32_t handle, uintptr_t key, uint64_t const* receiver, uint64_t* result);
int ganglion_host_js_set(uint32_t handle, uintptr_t key, uint64_t const* value, uint64_t const* receiver, uint32_t* ok, uint64_t* result);
int ganglion_host_js_has(uint32_t handle, uintptr_t key, uint32_t* out, uint64_t* result);
int ganglion_host_js_delete(uint32_t handle, uintptr_t key, uint32_t* out, uint64_t* result);
int ganglion_host_js_own_keys(uint32_t handle, uint64_t* result);
int ganglion_host_js_get_own_property(uint32_t handle, uintptr_t key, uint32_t* flags, uint64_t* value, uint64_t* getter, uint64_t* setter);
int ganglion_host_js_define_own_property(uint32_t handle, uintptr_t key, uint32_t flags, uint64_t const* value, uint64_t const* getter, uint64_t const* setter, uint32_t* ok, uint64_t* result);
int ganglion_host_js_get_prototype_of(uint32_t handle, uint64_t* result);
int ganglion_host_js_call(uint32_t handle, uint64_t const* this_value, uint64_t const* argv, uint32_t argc, uint64_t* result);
int ganglion_host_js_construct(uint32_t handle, uint64_t const* argv, uint32_t argc, uint64_t const* new_target, uint64_t* result);
void ganglion_host_js_drop(uint32_t handle);
// Scripts and JSON. Source text is UTF-16 code units, or Latin-1 bytes when `ascii` is set.
int ganglion_host_js_run_script(void const* source, size_t length, int ascii, void const* filename, size_t filename_length, int filename_ascii, uint32_t line_offset, uint64_t* result);
int ganglion_host_js_run_module(void const* source, size_t length, int ascii, void const* filename, size_t filename_length, int filename_ascii, uint32_t line_offset, uint64_t* result);
int ganglion_host_js_json_parse(void const* text, size_t length, int ascii, uint64_t* result);
// Functions from source text (an event handler's content attribute). Check: 0, or 1 with the first syntax error's message
// as a string in `result`. Instantiate: the function of `source` (the whole text), compiled as `parameters` and `body`
// of the given kind in the scope of `scopes` (object values, innermost first; they act as with-statements), or a function
// that does nothing when `noop` is set; 0 with the function in `result`, or 1 with the thrown value.
int ganglion_host_js_check_function(void const* parameters, size_t parameters_length, int parameters_ascii, void const* body, size_t body_length, int body_ascii, uint32_t kind, uint64_t* result);
int ganglion_host_js_instantiate_function(void const* source, size_t source_length, int source_ascii, void const* parameters, size_t parameters_length, int parameters_ascii, void const* body, size_t body_length, int body_ascii, uint32_t kind, uint64_t const* scopes, uint32_t scope_count, int noop, uint64_t* result);
int ganglion_host_js_json_stringify(uint64_t const* value, uint64_t const* replacer, uint64_t const* space, uint64_t* result);
void ganglion_host_js_document_reset(void);
}

namespace Ganglion::Bridge {

static VM& vm()
{
    return *reinterpret_cast<VM*>(&Web::Bindings::main_thread_vm());
}

// The principal realm (the Window's), set by the host at start: between tasks the execution context
// stack is empty and current_realm() has nothing to answer.
static Realm* s_realm;
static Realm* realm()
{
    return s_realm ? s_realm : current_realm(vm());
}

void set_realm(void* js_realm)
{
    s_realm = reinterpret_cast<Realm*>(js_realm);
}

static bool s_attached;

void document_reset()
{
    if (s_attached)
        ganglion_host_js_document_reset();
}

static Value read(uint64_t const* slot) { return Value { *slot }; }
static void write(uint64_t* slot, Value v) { *slot = v.bits; }

static JSCompletion completion(int threw, uint64_t const* result)
{
    return threw ? throw_value(read(result)) : normal(read(result));
}

static uint32_t handle_of(JSObject* object)
{
    auto& o = *reinterpret_cast<Object*>(object);
    if (o.klass->id == JS_LAYOUT_CLASS_ID_HOST_FUNCTION)
        return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(static_cast<HostFunction&>(o).host_data));
    return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(static_cast<HostObject&>(o).host_data));
}

// The keys a foreign own_keys answers with, pushed by the glue during the import.
static Vector<Key> s_keys;

// --- The foreign object class ------------------------------------------------------------------------------

static JSCompletion foreign_get_prototype_of(JSObject* object)
{
    uint64_t result;
    int threw = ganglion_host_js_get_prototype_of(handle_of(object), &result);
    if (threw)
        return throw_value(read(&result));
    auto value = read(&result);
    return normal_cell(value.is_object() ? value.as_object() : nullptr);
}

static JSCompletion foreign_set_prototype_of(JSObject*, JSObject*)
{
    return normal(true);
}

static JSCompletion foreign_is_extensible(JSObject*) { return normal(true); }
static JSCompletion foreign_prevent_extensions(JSObject*) { return normal(false); }

static JSCompletion foreign_get_own_property(JSObject* object, JSPropertyKey key, JSPropertyDescriptor* out)
{
    uint32_t flags = 0;
    uint64_t value = 0, getter = 0, setter = 0;
    int threw = ganglion_host_js_get_own_property(handle_of(object), key.bits, &flags, &value, &getter, &setter);
    if (threw)
        return throw_value(read(&value));
    *out = {};
    out->flags = static_cast<uint16_t>(flags);
    if (flags & JS_PD_HAS_VALUE)
        out->value = value;
    if (flags & JS_PD_HAS_GET) {
        auto g = read(&getter);
        out->get = g.is_object() ? reinterpret_cast<JSObject*>(g.as_object()) : nullptr;
    }
    if (flags & JS_PD_HAS_SET) {
        auto s = read(&setter);
        out->set = s.is_object() ? reinterpret_cast<JSObject*>(s.as_object()) : nullptr;
    }
    return normal((flags & JS_PD_PRESENT) != 0);
}

static JSCompletion foreign_define_own_property(JSObject* object, JSPropertyKey key, JSPropertyDescriptor* descriptor, JSPropertyDescriptor const*)
{
    uint64_t value = descriptor->value;
    uint64_t getter = Value::from_object(reinterpret_cast<Object*>(descriptor->get)).bits;
    uint64_t setter = Value::from_object(reinterpret_cast<Object*>(descriptor->set)).bits;
    if (!descriptor->get)
        getter = Value::undefined().bits;
    if (!descriptor->set)
        setter = Value::undefined().bits;
    uint32_t ok = 0;
    uint64_t result;
    int threw = ganglion_host_js_define_own_property(handle_of(object), key.bits, descriptor->flags, &value, &getter, &setter, &ok, &result);
    if (threw)
        return throw_value(read(&result));
    return normal(ok != 0);
}

static JSCompletion foreign_has_property(JSObject* object, JSPropertyKey key)
{
    uint32_t out = 0;
    uint64_t result;
    int threw = ganglion_host_js_has(handle_of(object), key.bits, &out, &result);
    if (threw)
        return throw_value(read(&result));
    return normal(out != 0);
}

static JSCompletion foreign_get(JSObject* object, JSPropertyKey key, JSValue receiver, JSGetCacheMetadata*, uint8_t)
{
    uint64_t result;
    uint64_t r = receiver;
    int threw = ganglion_host_js_get(handle_of(object), key.bits, &r, &result);
    return completion(threw, &result);
}

static JSCompletion foreign_set(JSObject* object, JSPropertyKey key, JSValue value, JSValue receiver, JSSetCacheMetadata*, uint8_t)
{
    uint32_t ok = 0;
    uint64_t result;
    uint64_t v = value, r = receiver;
    int threw = ganglion_host_js_set(handle_of(object), key.bits, &v, &r, &ok, &result);
    if (threw)
        return throw_value(read(&result));
    return normal(ok != 0);
}

static JSCompletion foreign_delete_property(JSObject* object, JSPropertyKey key)
{
    uint32_t out = 0;
    uint64_t result;
    int threw = ganglion_host_js_delete(handle_of(object), key.bits, &out, &result);
    if (threw)
        return throw_value(read(&result));
    return normal(out != 0);
}

static JSCompletion foreign_own_property_keys(JSObject* object, JSValueSink* keys)
{
    auto& v = vm();
    s_keys.clear_with_capacity();
    uint64_t result;
    int threw = ganglion_host_js_own_keys(handle_of(object), &result);
    if (threw)
        return throw_value(read(&result));
    for (auto key : s_keys) {
        Value value;
        if (key.is_symbol())
            value = Value::from_symbol(key.as_symbol());
        else if (key.is_number())
            value = Value::from_string(create_string(v, Utf16String::number(key.as_number())));
        else
            value = Value::from_string(create_string(v, Utf16String::from_utf16(key.as_fly_string().view())));
        keys->append(keys->context, value.bits);
    }
    return normal();
}

static bool foreign_is_cacheable(JSObject*) { return false; }

static void foreign_finalize(JSObject* object)
{
    ganglion_host_js_drop(handle_of(object));
}

static JSHostObjectHooks const foreign_object_hooks = {
    .get_prototype_of = foreign_get_prototype_of,
    .set_prototype_of = foreign_set_prototype_of,
    .is_extensible = foreign_is_extensible,
    .prevent_extensions = foreign_prevent_extensions,
    .get_own_property = foreign_get_own_property,
    .define_own_property = foreign_define_own_property,
    .has_property = foreign_has_property,
    .get = foreign_get,
    .set = foreign_set,
    .delete_property = foreign_delete_property,
    .own_property_keys = foreign_own_property_keys,
    .is_cacheable_for_inherited_property = foreign_is_cacheable,
    .error_data = nullptr,
    .finalize = foreign_finalize,
};

static JSHostClass const foreign_object_class = {
    .abi_version = JS_HOST_ABI_VERSION,
    .kind = JS_HOST_CLASS_OBJECT,
    .reserved = 0,
    .flags = JS_HOST_CLASS_NOT_CACHEABLE_FOR_PROPERTY_ABSENCE | JS_HOST_CLASS_NOT_ELIGIBLE_FOR_OWN_PROPERTY_ENUMERATION_FAST_PATH,
    .name = "ForeignObject",
    .name_length = 13,
    .parent = nullptr,
    .hooks = &foreign_object_hooks,
    .user_data = nullptr,
};

// --- The foreign function class ------------------------------------------------------------------------------

static JSCompletion foreign_call(JSObject* function, JSVM* abi_vm)
{
    auto& v = vm_of(abi_vm);
    auto* context = v.running_execution_context;
    uint64_t this_value = context->this_value.bits;
    if (context->this_value.bits == Value::empty().bits)
        this_value = Value::undefined().bits;
    uint64_t result;
    int threw = ganglion_host_js_call(handle_of(function), &this_value, reinterpret_cast<uint64_t const*>(context->arguments()), context->passed_argument_count, &result);
    return completion(threw, &result);
}

static JSCompletion foreign_construct(JSObject* function, JSVM* abi_vm, JSObject* new_target)
{
    auto& v = vm_of(abi_vm);
    auto* context = v.running_execution_context;
    uint64_t target = Value::from_object(reinterpret_cast<Object*>(new_target)).bits;
    uint64_t result;
    int threw = ganglion_host_js_construct(handle_of(function), reinterpret_cast<uint64_t const*>(context->arguments()), context->passed_argument_count, &target, &result);
    return completion(threw, &result);
}

static void foreign_function_finalize(JSObject* function)
{
    ganglion_host_js_drop(handle_of(function));
}

static JSHostFunctionHooks const foreign_function_hooks = {
    .call = foreign_call,
    .construct = foreign_construct,
    .finalize = foreign_function_finalize,
};

// The property hooks of a foreign function (engine/libjs-runtime/src/Object.cpp, object_hooks_of): the host's function answers.
static JSHostObjectHooks const foreign_function_property_hooks = {
    .get_own_property = foreign_get_own_property,
    .has_property = foreign_has_property,
    .get = foreign_get,
    .own_property_keys = foreign_own_property_keys,
};

static JSHostClass const foreign_function_class = {
    .abi_version = JS_HOST_ABI_VERSION,
    .kind = JS_HOST_CLASS_FUNCTION,
    .reserved = 0,
    .flags = JS_HOST_CLASS_HAS_CONSTRUCTOR,
    .name = "ForeignFunction",
    .name_length = 15,
    .parent = nullptr,
    .hooks = &foreign_function_hooks,
    .user_data = &foreign_function_property_hooks,
};

static JSHostClass const foreign_callable_class = {
    .abi_version = JS_HOST_ABI_VERSION,
    .kind = JS_HOST_CLASS_FUNCTION,
    .reserved = 0,
    .flags = 0,
    .name = "ForeignFunction",
    .name_length = 15,
    .parent = nullptr,
    .hooks = &foreign_function_hooks,
    .user_data = &foreign_function_property_hooks,
};

// --- Scripts and JSON through the host -----------------------------------------------------------------------

// The host's V8 has one global, the principal realm's. A script of another realm's document (a same-site frame's page)
// runs there only when the glue has frame realms (glue/engine/55-realms.js, docs/architecture.md "Frame realms"): the
// glue gives that realm a global of its own and finds it from the script's execution context
// (ganglion_js_current_global). Without them the frame's page is parsed, styled and painted but its scripts do not run.
static bool s_frame_realms;
static bool runs_in_the_host(ScriptObject const& script)
{
    return !script.realm || script.realm == Bridge::realm() || s_frame_realms;
}

static JSCompletion run_script(VM& v, ScriptObject& script)
{
    if (!runs_in_the_host(script))
        return normal(Value::undefined());
    auto source = Utf16String::from_raw(script.source_raw);
    auto filename = Utf16String::from_raw(script.filename_raw);
    auto sv = source.utf16_view();
    auto fv = filename.utf16_view();
    // ScriptEvaluation runs on a script execution context of the script's realm: LibWeb finds the
    // incumbent realm through the topmost context with a [[ScriptOrModule]].
    auto* abi_vm = reinterpret_cast<JSVM*>(&v);
    auto* context = reinterpret_cast<ExecutionContext*>(js_execution_context_create(0, 0, 0));
    context->realm = script.realm ? script.realm : Bridge::realm();
    context->script_or_module.tag = JS_LAYOUT_SCRIPT_OR_MODULE_TAG_SCRIPT;
    context->script_or_module.cell = &script;
    js_execution_context_push(abi_vm, reinterpret_cast<JSExecutionContext*>(context));
    uint64_t result;
    int threw = ganglion_host_js_run_script(
        sv.has_ascii_storage() ? static_cast<void const*>(sv.ascii_span().data()) : static_cast<void const*>(sv.utf16_span().data()), sv.length_in_code_units(), sv.has_ascii_storage(),
        fv.has_ascii_storage() ? static_cast<void const*>(fv.ascii_span().data()) : static_cast<void const*>(fv.utf16_span().data()), fv.length_in_code_units(), fv.has_ascii_storage(),
        script.line_number_offset, &result);
    pop_execution_context(v);
    js_execution_context_destroy(reinterpret_cast<JSExecutionContext*>(context));
    return completion(threw, &result);
}

static JSCompletion run_module(VM& v, ScriptObject& script)
{
    if (!runs_in_the_host(script))
        return normal(Value::undefined());
    auto source = Utf16String::from_raw(script.source_raw);
    auto filename = Utf16String::from_raw(script.filename_raw);
    auto sv = source.utf16_view();
    auto fv = filename.utf16_view();
    // Module evaluation runs on a module execution context of the script's realm: LibWeb finds the
    // incumbent realm through the topmost context with a [[ScriptOrModule]].
    auto* abi_vm = reinterpret_cast<JSVM*>(&v);
    auto* context = reinterpret_cast<ExecutionContext*>(js_execution_context_create(0, 0, 0));
    context->realm = script.realm ? script.realm : Bridge::realm();
    context->script_or_module.tag = JS_LAYOUT_SCRIPT_OR_MODULE_TAG_MODULE;
    context->script_or_module.cell = &script;
    js_execution_context_push(abi_vm, reinterpret_cast<JSExecutionContext*>(context));
    uint64_t result;
    int threw = ganglion_host_js_run_module(
        sv.has_ascii_storage() ? static_cast<void const*>(sv.ascii_span().data()) : static_cast<void const*>(sv.utf16_span().data()), sv.length_in_code_units(), sv.has_ascii_storage(),
        fv.has_ascii_storage() ? static_cast<void const*>(fv.ascii_span().data()) : static_cast<void const*>(fv.utf16_span().data()), fv.length_in_code_units(), fv.has_ascii_storage(),
        script.line_number_offset, &result);
    pop_execution_context(v);
    js_execution_context_destroy(reinterpret_cast<JSExecutionContext*>(context));
    return completion(threw, &result);
}

// The text of a view as the host reads it: UTF-16 code units, or Latin-1 bytes when the view is ASCII.
static void const* text_pointer(Utf16View const& view)
{
    return view.has_ascii_storage() ? static_cast<void const*>(view.ascii_span().data()) : static_cast<void const*>(view.utf16_span().data());
}

static bool dynamic_function_check(VM&, Utf16View parameters, Utf16View body, u8 kind, JSOwnedUtf16String* error)
{
    uint64_t result;
    int threw = ganglion_host_js_check_function(
        text_pointer(parameters), parameters.length_in_code_units(), parameters.has_ascii_storage(),
        text_pointer(body), body.length_in_code_units(), body.has_ascii_storage(), kind, &result);
    if (!threw)
        return true;
    auto message = read(&result);
    if (message.is_string()) {
        auto text = string_of(message.as_cell<PrimitiveString>());
        *error = Utf16String::from_utf16(text.utf16_view()).into_raw();
    } else {
        *error = "SyntaxError"_utf16.into_raw();
    }
    return false;
}

static Object* dynamic_function_instantiate(VM& v, Realm& function_realm, DynamicFunction& data, Environment* scope)
{
    // The scope chain: the object environments (event handlers' element, form owner and document) up to the global's.
    Vector<uint64_t> scopes;
    for (auto* environment = scope; environment && environment->env_kind != JS_ENVIRONMENT_KIND_GLOBAL; environment = environment->outer) {
        if (environment->env_kind == JS_ENVIRONMENT_KIND_OBJECT && environment->binding_object)
            scopes.append(Value::from_object(environment->binding_object).bits);
    }
    auto source = Utf16String::from_raw(data.source_raw);
    auto parameters = Utf16String::from_raw(data.parameters_raw);
    auto body = Utf16String::from_raw(data.body_raw);
    auto source_view = source.utf16_view();
    auto parameters_view = parameters.utf16_view();
    auto body_view = body.utf16_view();
    // A handler of another realm's document (a frame's) runs in that realm's global when the glue has frame realms: the
    // realm's global object goes last, after the object environments (the glue takes it off and scopes to the frame's
    // global). Without frame realms it does nothing.
    bool other_realm = &function_realm != Bridge::realm();
    bool noop = other_realm && !s_frame_realms;
    if (other_realm && s_frame_realms && function_realm.global_object)
        scopes.append(Value::from_object(function_realm.global_object).bits);
    uint64_t result;
    int threw = ganglion_host_js_instantiate_function(
        text_pointer(source_view), source_view.length_in_code_units(), source_view.has_ascii_storage(),
        text_pointer(parameters_view), parameters_view.length_in_code_units(), parameters_view.has_ascii_storage(),
        text_pointer(body_view), body_view.length_in_code_units(), body_view.has_ascii_storage(),
        data.kind, scopes.data(), scopes.size(), noop, &result);
    (void)v;
    auto function = read(&result);
    if (threw || !function.is_object())
        return nullptr;
    return function.as_object();
}

static JSCompletion json_parse(VM&, Utf16View text)
{
    uint64_t result;
    int threw = ganglion_host_js_json_parse(
        text.has_ascii_storage() ? static_cast<void const*>(text.ascii_span().data()) : static_cast<void const*>(text.utf16_span().data()), text.length_in_code_units(), text.has_ascii_storage(), &result);
    return completion(threw, &result);
}

static JSCompletion json_stringify(VM&, Value value, Value replacer, Value space, JSOwnedUtf16String* out)
{
    uint64_t v = value.bits, r = replacer.bits, s = space.bits, result;
    int threw = ganglion_host_js_json_stringify(&v, &r, &s, &result);
    if (threw)
        return throw_value(read(&result));
    auto string = read(&result);
    if (!string.is_string())
        return normal(false);
    auto text = string_of(string.as_cell<PrimitiveString>()); // a shared reference
    *out = Utf16String::from_utf16(text.utf16_view()).into_raw();
    return normal(true);
}

}

using namespace Ganglion;
using namespace Ganglion::Bridge;

// --- Exports for the glue's mirror -----------------------------------------------------------------------------

// The host has a JavaScript engine: scripts run through it from now on.
GANGLION_EXPORT void ganglion_js_attach(void)
{
    s_attached = true;
    g_run_script = run_script;
    g_run_module = run_module;
    g_json_parse = json_parse;
    g_function_property_hooks = &foreign_function_property_hooks;
    g_json_stringify = json_stringify;
    g_dynamic_function_check = dynamic_function_check;
    g_dynamic_function_instantiate = dynamic_function_instantiate;
}

// A foreign object or function for the glue's handle; `constructible` says whether `new` works on it.
GANGLION_EXPORT void ganglion_foreign_object(uint32_t handle, uint64_t* out)
{
    auto& v = vm();
    auto* realm = Bridge::realm();
    auto* object = js_host_object_create(reinterpret_cast<JSVM*>(&v), reinterpret_cast<JSRealm*>(realm), &foreign_object_class, nullptr, nullptr, reinterpret_cast<void*>(static_cast<uintptr_t>(handle)));
    write(out, Value::from_object(reinterpret_cast<Object*>(object)));
}

GANGLION_EXPORT void ganglion_foreign_function(uint32_t handle, int constructible, uint64_t* out)
{
    auto& v = vm();
    auto* realm = Bridge::realm();
    static auto const name = ""_utf16;
    auto* function = js_host_function_create_without_own_properties(reinterpret_cast<JSVM*>(&v), reinterpret_cast<JSRealm*>(realm), constructible ? &foreign_function_class : &foreign_callable_class, abi_view(name.utf16_view()), nullptr, reinterpret_cast<void*>(static_cast<uintptr_t>(handle)));
    write(out, Value::from_object(reinterpret_cast<Object*>(function)));
}

// The glue's handle behind a foreign cell, or -1.
GANGLION_EXPORT int32_t ganglion_v_foreign_handle(uint64_t const* slot)
{
    auto value = read(slot);
    if (!value.is_object())
        return -1;
    auto& o = *value.as_object();
    auto const* host_class = host_class_of(o);
    if (host_class == &foreign_object_class || host_class == &foreign_function_class || host_class == &foreign_callable_class)
        return static_cast<int32_t>(handle_of(reinterpret_cast<JSObject*>(&o)));
    return -1;
}

// What kind of object a value is: 12 a Map, 13 a Set, 11 a Date, 10 an ArrayBuffer or a typed array (copied across by value), 1 host object with a wrappable (a DOM object), 2 foreign object,
// 3 foreign function, 4 a function of the runtime's, 5 array, 6 promise, 7 error, 8 host object without
// a wrappable, 9 anything else. 0 when the value is not an object.
GANGLION_EXPORT uint32_t ganglion_v_object_kind(uint64_t const* slot)
{
    auto value = read(slot);
    if (!value.is_object())
        return 0;
    auto& o = *value.as_object();
    auto const* host_class = host_class_of(o);
    if (host_class == &foreign_object_class)
        return 2;
    if (host_class == &foreign_function_class || host_class == &foreign_callable_class)
        return 3;
    switch (o.klass->id) {
    case JS_LAYOUT_CLASS_ID_HOST_OBJECT:
        return static_cast<HostObject&>(o).wrappable ? 1 : 8;
    case JS_LAYOUT_CLASS_ID_HOST_ARRAY:
        return 5;
    case JS_LAYOUT_CLASS_ID_NATIVE_FUNCTION:
    case JS_LAYOUT_CLASS_ID_HOST_FUNCTION:
        return 4;
    case JS_LAYOUT_CLASS_ID_ARRAY:
        return 5;
    case JS_LAYOUT_CLASS_ID_PROMISE:
        return 6;
    case JS_LAYOUT_CLASS_ID_ARRAY_BUFFER:
        return 10;
    case JS_LAYOUT_CLASS_ID_DATE:
        return 11;
    case JS_LAYOUT_CLASS_ID_MAP:
        return 12;
    case JS_LAYOUT_CLASS_ID_SET:
        return 13;
    default:
        break;
    }
    if (o.flags & JS_LAYOUT_OBJECT_FLAG_IS_TYPED_ARRAY)
        return 10;
    if (o.klass->id == JS_LAYOUT_CLASS_ID_ERROR || (o.klass->parent && o.klass->parent->id == JS_LAYOUT_CLASS_ID_ERROR))
        return 7;
    return is_callable(value) ? 4 : 9;
}

// An ArrayBuffer or typed array: its bytes in linear memory as (pointer, length) through `out`. Returns 13 for an
// ArrayBuffer, 1 + the typed array kind (Uint8Array = 1 ... Float64Array = 12) for a view, 0 when the value is
// neither (or is detached: out is then 0, 0 and the kind still tells what it was).
GANGLION_EXPORT int32_t ganglion_v_buffer_info(uint64_t const* slot, uint32_t* out)
{
    out[0] = 0;
    out[1] = 0;
    auto value = read(slot);
    if (!value.is_object())
        return 0;
    auto* o = value.as_object();
    auto* object = reinterpret_cast<JSObject*>(o);
    if (o->klass->id == JS_LAYOUT_CLASS_ID_ARRAY_BUFFER) {
        size_t length = 0;
        auto* data = js_array_buffer_data(object, &length);
        out[0] = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(data));
        out[1] = data ? static_cast<uint32_t>(length) : 0;
        return 13;
    }
    if (!(o->flags & JS_LAYOUT_OBJECT_FLAG_IS_TYPED_ARRAY))
        return 0;
    auto& array = *static_cast<TypedArray*>(o);
    auto witness = js_typed_array_make_witness_record(object, 0);
    if (!js_typed_array_is_out_of_bounds(&witness)) {
        size_t buffer_length = 0;
        auto* data = js_array_buffer_data(reinterpret_cast<JSObject*>(array.viewed_array_buffer), &buffer_length);
        if (data) {
            out[0] = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(data)) + array.byte_offset;
            out[1] = js_typed_array_byte_length_of_witness(&witness);
        }
    }
    return 1 + array.array_kind;
}

// A new ArrayBuffer (kind 13) or typed array (1 + kind, over a fresh buffer) holding the `length` bytes at `bytes`
// (a typed array's length is rounded down to whole elements), written to `out`. Returns 0, writing nothing, when the
// engine cannot allocate the copy (the glue throws a RangeError, as V8 does for an allocation it cannot make).
GANGLION_EXPORT int ganglion_v_buffer_create(int32_t kind, uint8_t const* bytes, uint32_t length, uint64_t* out)
{
    auto* abi_vm = reinterpret_cast<JSVM*>(&vm());
    auto* abi_realm = reinterpret_cast<JSRealm*>(Bridge::realm());
    auto* buffer_object = try_create_array_buffer_from_bytes(vm(), *Bridge::realm(), bytes, length);
    if (!buffer_object)
        return 0;
    auto* buffer = reinterpret_cast<JSObject*>(buffer_object);
    if (kind == 13) {
        write(out, Value::from_object(buffer_object));
        return 1;
    }
    static constexpr uint8_t sizes[12] = { 1, 1, 2, 4, 8, 1, 2, 4, 8, 2, 4, 8 };
    auto k = static_cast<uint8_t>(kind - 1);
    auto* array = js_typed_array_create_on_buffer(abi_vm, abi_realm, k, length / sizes[k], buffer);
    write(out, Value::from_object(reinterpret_cast<Object*>(array)));
    return 1;
}

GANGLION_EXPORT int ganglion_v_is_constructor(uint64_t const* slot)
{
    auto value = read(slot);
    if (!value.is_object() || !is_callable(value))
        return 0;
    return static_cast<FunctionObject*>(value.as_object())->is_constructor ? 1 : 0;
}

// The host class name of an object (the interface name for a wrapper), as (ptr, len) through `out`.
GANGLION_EXPORT char const* ganglion_v_class_name(uint64_t const* slot, uint32_t* length)
{
    auto value = read(slot);
    if (!value.is_object()) {
        *length = 0;
        return "";
    }
    auto name = class_name_of(*value.as_object());
    *length = name.length();
    return name.characters_without_null_termination();
}

// Platform-object traits: bit 0 indexed properties, bit 1 named properties, bit 2 global object,
// bit 3 [LegacyUnenumerableNamedProperties], bit 4 is an HTMLDDA ([LegacyFalsy]).
GANGLION_EXPORT uint32_t ganglion_v_host_flags(uint64_t const* slot)
{
    auto value = read(slot);
    if (!value.is_object())
        return 0;
    auto const* host_class = host_class_of(*value.as_object());
    if (!host_class)
        return 0;
    uint32_t flags = 0;
    if (host_class->flags & JS_HOST_CLASS_IS_GLOBAL_OBJECT)
        flags |= 4;
    if (host_class->flags & JS_HOST_CLASS_IS_HTMLDDA)
        flags |= 16;
    if ((host_class->flags & JS_HOST_CLASS_IS_PLATFORM_OBJECT) && host_class->user_data) {
        auto const& traits = *static_cast<Web::Bindings::LegacyPlatformObjectInfo const*>(host_class->user_data);
        if (traits.supports_indexed_properties)
            flags |= 1;
        if (traits.supports_named_properties)
            flags |= 2;
        if (traits.has_legacy_unenumerable_named_properties_interface_extended_attribute)
            flags |= 8;
    }
    return flags;
}

// --- Values --------------------------------------------------------------------------------------------------------

GANGLION_EXPORT void ganglion_v_from_number(double d, uint64_t* out) { write(out, Value::from_double(d)); }
GANGLION_EXPORT double ganglion_v_number(uint64_t const* slot) { return read(slot).as_double(); }

// A string's code units: writes the data pointer, the length and whether the storage is Latin-1 bytes.
GANGLION_EXPORT void const* ganglion_v_string_data(uint64_t const* slot, uint32_t* length, uint32_t* ascii)
{
    auto value = read(slot);
    if (!value.is_string()) {
        *length = 0;
        *ascii = 1;
        return "";
    }
    auto string = string_of(value.as_cell<PrimitiveString>());
    auto view = string.utf16_view();
    *length = view.length_in_code_units();
    *ascii = view.has_ascii_storage();
    // `string` shares the cell's reference; the storage outlives this copy because the cell keeps it.
    return view.has_ascii_storage() ? static_cast<void const*>(view.ascii_span().data()) : static_cast<void const*>(view.utf16_span().data());
}

GANGLION_EXPORT void ganglion_v_string_from_utf16(uint16_t const* data, size_t length, uint64_t* out)
{
    write(out, Value::from_string(create_string(vm(), Utf16View { reinterpret_cast<char16_t const*>(data), length })));
}

GANGLION_EXPORT void ganglion_v_string_from_latin1(uint8_t const* data, size_t length, uint64_t* out)
{
    write(out, Value::from_string(create_string(vm(), Utf16View { StringView { reinterpret_cast<char const*>(data), length } })));
}

// A symbol's description (a string value, or undefined), and which well-known symbol it is (-1 if none).
GANGLION_EXPORT void ganglion_v_symbol_description(uint64_t const* slot, uint64_t* out)
{
    auto value = read(slot);
    if (!value.is_symbol() || !value.as_cell<Symbol>()->description_raw) {
        write(out, Value::undefined());
        return;
    }
    auto description = Utf16String::from_raw(value.as_cell<Symbol>()->description_raw);
    write(out, Value::from_string(create_string(vm(), description.utf16_view())));
}

GANGLION_EXPORT int32_t ganglion_v_symbol_well_known(uint64_t const* slot)
{
    auto value = read(slot);
    if (!value.is_symbol())
        return -1;
    auto* abi_vm = reinterpret_cast<JSVM*>(&vm());
    for (int i = 0; i <= JS_WELL_KNOWN_SYMBOL_UNSCOPABLES; i++) {
        if (reinterpret_cast<Symbol*>(js_symbol_well_known(abi_vm, i)) == value.as_cell<Symbol>())
            return i;
    }
    return -1;
}

GANGLION_EXPORT void ganglion_v_symbol_create(uint16_t const* description, size_t length, uint64_t* out)
{
    auto* symbol = allocate<Symbol>(vm(), class_symbol);
    symbol->description_raw = Utf16String::from_utf16(Utf16View { reinterpret_cast<char16_t const*>(description), length }).into_raw();
    write(out, Value::from_symbol(symbol));
}

// --- Keys ---------------------------------------------------------------------------------------------------------

static Vector<Utf16FlyString>& interned()
{
    static Vector<Utf16FlyString> s_interned;
    return s_interned;
}

GANGLION_EXPORT uintptr_t ganglion_key_intern(uint16_t const* data, size_t length)
{
    auto fly = Utf16FlyString::from_utf16(Utf16View { reinterpret_cast<char16_t const*>(data), length });
    auto key = Key::from_fly_string(fly);
    interned().append(move(fly)); // keeps the identity alive for the glue's cache
    return key.bits;
}

GANGLION_EXPORT uintptr_t ganglion_key_index(uint32_t index) { return Key::from_index(index).bits; }

GANGLION_EXPORT uintptr_t ganglion_key_well_known(int32_t which)
{
    return Key::from_symbol(reinterpret_cast<Symbol*>(js_symbol_well_known(reinterpret_cast<JSVM*>(&vm()), which))).bits;
}

GANGLION_EXPORT uintptr_t ganglion_key_from_symbol(uint64_t const* slot)
{
    auto value = read(slot);
    return value.is_symbol() ? Key::from_symbol(value.as_cell<Symbol>()).bits : 0;
}

// 1 string, 2 symbol, 3 index.
GANGLION_EXPORT uint32_t ganglion_key_kind(uintptr_t bits)
{
    Key key { bits };
    return key.is_symbol() ? 2 : key.is_number() ? 3 : 1;
}

GANGLION_EXPORT uint32_t ganglion_key_number(uintptr_t bits) { return Key { bits }.as_number(); }

// The key as a value: a string, a symbol, or an index as a number.
GANGLION_EXPORT void ganglion_key_value(uintptr_t bits, uint64_t* out)
{
    Key key { bits };
    if (key.is_symbol())
        write(out, Value::from_symbol(key.as_symbol()));
    else if (key.is_number())
        write(out, Value::from_i32(static_cast<i32>(key.as_number())));
    else
        write(out, Value::from_string(create_string(vm(), Utf16String::from_utf16(key.as_fly_string().view()))));
}

GANGLION_EXPORT void ganglion_keys_push(uintptr_t bits) { s_keys.append(Key { bits }); }
GANGLION_EXPORT uint32_t ganglion_keys_count(void) { return s_keys.size(); }
GANGLION_EXPORT uintptr_t ganglion_keys_at(uint32_t i) { return i < s_keys.size() ? s_keys[i].bits : 0; }

// --- Objects ---------------------------------------------------------------------------------------------------------

static Object* object_at(uint64_t const* slot)
{
    auto value = read(slot);
    return value.is_object() ? value.as_object() : nullptr;
}

// [[GetPrototypeOf]]: the prototype (an object or null) into `out`; returns 1 on a throw (the thrown value in `out`).
GANGLION_EXPORT int ganglion_v_prototype(uint64_t const* slot, uint64_t* out)
{
    auto* object = object_at(slot);
    if (!object) {
        write(out, Value::null());
        return 0;
    }
    auto c = internal_get_prototype_of(vm(), *object);
    if (is_throw(c)) {
        write(out, value_of(c));
        return 1;
    }
    auto* prototype = reinterpret_cast<Object*>(static_cast<uintptr_t>(c.payload));
    write(out, prototype ? Value::from_object(prototype) : Value::null());
    return 0;
}

// [[Get]] with the object as the receiver.
GANGLION_EXPORT int ganglion_v_get(uint64_t const* slot, uintptr_t key, uint64_t* out)
{
    auto* object = object_at(slot);
    if (!object) {
        write(out, Value::undefined());
        return 0;
    }
    auto c = internal_get(vm(), *object, Key { key }, read(slot), JS_PROPERTY_LOOKUP_PHASE_OWN_PROPERTY);
    write(out, value_of(c));
    return is_throw(c) ? 1 : 0;
}

GANGLION_EXPORT int ganglion_v_set(uint64_t const* slot, uintptr_t key, uint64_t const* value, uint64_t* out)
{
    auto* object = object_at(slot);
    if (!object)
        return 0;
    auto c = internal_set(vm(), *object, Key { key }, read(value), read(slot), JS_PROPERTY_LOOKUP_PHASE_OWN_PROPERTY);
    write(out, value_of(c));
    return is_throw(c) ? 1 : 0;
}

// New engine values for the page's values that are copied across whole (structured clone: history.state, postMessage): a plain
// object, an array of `length` (elements set afterwards with ganglion_v_set), a Date.
GANGLION_EXPORT void ganglion_v_object_create(uint64_t* out)
{
    auto* abi_vm = reinterpret_cast<JSVM*>(&vm());
    auto* abi_realm = reinterpret_cast<JSRealm*>(Bridge::realm());
    auto* prototype = reinterpret_cast<JSObject*>(intrinsic(vm(), *Bridge::realm(), JS_INTRINSIC_OBJECT_PROTOTYPE));
    write(out, Value::from_object(reinterpret_cast<Object*>(js_object_create(abi_vm, abi_realm, prototype))));
}

GANGLION_EXPORT void ganglion_v_array_create(uint32_t length, uint64_t* out)
{
    auto c = js_array_create(reinterpret_cast<JSVM*>(&vm()), reinterpret_cast<JSRealm*>(Bridge::realm()), length, nullptr);
    write(out, Value::from_object(reinterpret_cast<Object*>(static_cast<uintptr_t>(c.payload))));
}

GANGLION_EXPORT void ganglion_v_date_create(double ms, uint64_t* out)
{
    write(out, Value::from_object(reinterpret_cast<Object*>(js_date_create(reinterpret_cast<JSVM*>(&vm()), reinterpret_cast<JSRealm*>(Bridge::realm()), ms))));
}

GANGLION_EXPORT void ganglion_v_define_data(uint64_t const* slot, uintptr_t key, uint64_t const* value);

// A Map or Set (an IndexedDB value with one inside): an empty one, then its entries one by one in the page's order.
GANGLION_EXPORT void ganglion_v_map_create(uint64_t* out)
{
    write(out, Value::from_object(reinterpret_cast<Object*>(js_collections_map_create(reinterpret_cast<JSVM*>(&vm()), reinterpret_cast<JSRealm*>(Bridge::realm())))));
}

GANGLION_EXPORT void ganglion_v_set_create(uint64_t* out)
{
    write(out, Value::from_object(reinterpret_cast<Object*>(js_collections_set_create(reinterpret_cast<JSVM*>(&vm()), reinterpret_cast<JSRealm*>(Bridge::realm())))));
}

GANGLION_EXPORT void ganglion_v_map_put(uint64_t const* slot, uint64_t const* key, uint64_t const* value)
{
    auto* object = object_at(slot);
    if (object && object->klass->id == JS_LAYOUT_CLASS_ID_MAP)
        js_collections_map_set(reinterpret_cast<JSVM*>(&vm()), reinterpret_cast<JSObject*>(object), read(key).bits, read(value).bits);
}

GANGLION_EXPORT void ganglion_v_set_put(uint64_t const* slot, uint64_t const* value)
{
    auto* object = object_at(slot);
    if (object && object->klass->id == JS_LAYOUT_CLASS_ID_SET)
        js_collections_set_add(reinterpret_cast<JSVM*>(&vm()), reinterpret_cast<JSObject*>(object), read(value).bits);
}

// A Map's or Set's entries as a new array: key, value, key, value ... for a Map, the values for a Set.
GANGLION_EXPORT void ganglion_v_collection_entries(uint64_t const* slot, uint64_t* out)
{
    auto* abi_vm = reinterpret_cast<JSVM*>(&vm());
    auto c = js_array_create(abi_vm, reinterpret_cast<JSRealm*>(Bridge::realm()), 0, nullptr);
    auto* array = reinterpret_cast<Object*>(static_cast<uintptr_t>(c.payload));
    write(out, Value::from_object(array));
    auto* object = object_at(slot);
    if (!object)
        return;
    struct Sink {
        Object* array;
        uint32_t next { 0 };
        void append(JSValue v)
        {
            uint64_t s = Value::from_object(array).bits, e = v;
            ganglion_v_define_data(&s, Key::from_index(next++).bits, &e);
        }
    } sink { array };
    if (object->klass->id == JS_LAYOUT_CLASS_ID_MAP) {
        js_collections_map_for_each_entry(reinterpret_cast<JSObject*>(object), [](void* context, JSValue key, JSValue value) -> JSCompletion {
            static_cast<Sink*>(context)->append(key);
            static_cast<Sink*>(context)->append(value);
            return normal();
        }, &sink);
    } else if (object->klass->id == JS_LAYOUT_CLASS_ID_SET) {
        js_collections_set_for_each_value(reinterpret_cast<JSObject*>(object), [](void* context, JSValue value) -> JSCompletion {
            static_cast<Sink*>(context)->append(value);
            return normal();
        }, &sink);
    }
}

// CreateDataProperty with a writable, enumerable, configurable data property (not [[Set]]: a key named __proto__ is a plain key).
GANGLION_EXPORT void ganglion_v_define_data(uint64_t const* slot, uintptr_t key, uint64_t const* value)
{
    auto* object = object_at(slot);
    if (!object)
        return;
    Key k { key };
    define_direct_property(vm(), *object, k, read(value), JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_ENUMERABLE | JS_ATTRIBUTE_CONFIGURABLE);
    if ((object->klass->id == JS_LAYOUT_CLASS_ID_ARRAY || object->klass->id == JS_LAYOUT_CLASS_ID_HOST_ARRAY) && k.is_number() && k.as_number() >= object->array_length)
        object->array_length = k.as_number() + 1;
}

GANGLION_EXPORT double ganglion_v_date_value(uint64_t const* slot)
{
    auto* object = object_at(slot);
    return object && object->klass->id == JS_LAYOUT_CLASS_ID_DATE ? static_cast<DateObject*>(object)->date_value : NAN;
}

// The names own-key lists hand to the glue, kept alive while their keys may be read (each name once).
static HashTable<Utf16FlyString>& own_key_names()
{
    static HashTable<Utf16FlyString> s_names;
    return s_names;
}

// [[OwnPropertyKeys]] into the keys list (ganglion_keys_count / at), in the object's order.
GANGLION_EXPORT int ganglion_v_own_keys(uint64_t const* slot, uint64_t* out)
{
    s_keys.clear_with_capacity();
    auto* object = object_at(slot);
    if (!object)
        return 0;
    struct Sink {
        static void append(void*, JSValue value)
        {
            Value v { value };
            if (v.is_symbol())
                s_keys.append(Key::from_symbol(v.as_cell<Symbol>()));
            else if (v.is_string()) {
                auto string = string_of(v.as_cell<PrimitiveString>());
                auto view = string.utf16_view();
                // A key borrows its fly string, and the glue reads the keys after this call returns: a fly string
                // made here and dropped at the end of the statement left the key dangling once it was too long to be
                // stored inline (a CSSRuleList's index "1234": hostinger's session recorder walking `rules` trapped in
                // ganglion_key_value). The names are kept alive with the list's (each name once). An array index stays a
                // string key here; the glue reads it as text.
                auto fly = Utf16FlyString::from_utf16(view);
                s_keys.append(Key::from_fly_string(fly));
                own_key_names().set(move(fly));
            }
        }
    };
    JSValueSink sink { nullptr, Sink::append };
    auto c = js_object_internal_own_property_keys(reinterpret_cast<JSVM*>(&vm()), reinterpret_cast<JSObject*>(object), &sink);
    if (is_throw(c)) {
        write(out, value_of(c));
        return 1;
    }
    return 0;
}

// An own property without materialising a pending intrinsic: 0 absent, 1 data, 2 accessor, 3 pending
// (an interface object not yet created), 4 unknown (an exotic object: ask [[GetOwnProperty]]).
GANGLION_EXPORT uint32_t ganglion_v_own_kind(uint64_t const* slot, uintptr_t key)
{
    auto* object = object_at(slot);
    if (!object)
        return 0;
    if (host_hooks_of(*object))
        return 4;
    auto* property = find_own_property(*object, Key { key });
    if (!property)
        return 0;
    switch (property->kind) {
    case PropertyKind::Data: return 1;
    case PropertyKind::Accessor: return 2;
    case PropertyKind::IntrinsicPending: return 3;
    default: return 0;
    }
}

// [[GetOwnProperty]]: flags (JS_PD_*), the value or getter and setter. Returns 1 on a throw (thrown in `value`).
GANGLION_EXPORT int ganglion_v_own_property(uint64_t const* slot, uintptr_t key, uint32_t* flags, uint64_t* value, uint64_t* getter, uint64_t* setter)
{
    *flags = 0;
    write(value, Value::undefined());
    write(getter, Value::undefined());
    write(setter, Value::undefined());
    auto* object = object_at(slot);
    if (!object)
        return 0;
    JSPropertyDescriptor descriptor {};
    auto c = internal_get_own_property(vm(), *object, Key { key }, descriptor);
    if (is_throw(c)) {
        write(value, value_of(c));
        return 1;
    }
    if (!(descriptor.flags & JS_PD_PRESENT))
        return 0;
    *flags = descriptor.flags;
    if (descriptor.flags & JS_PD_HAS_VALUE)
        *value = descriptor.value;
    if (descriptor.get)
        write(getter, Value::from_object(reinterpret_cast<Object*>(descriptor.get)));
    if (descriptor.set)
        write(setter, Value::from_object(reinterpret_cast<Object*>(descriptor.set)));
    return 0;
}

GANGLION_EXPORT int ganglion_v_is_callable(uint64_t const* slot) { return is_callable(read(slot)) ? 1 : 0; }

// Keeps a cell alive for the page's lifetime: a runtime object the mirror holds a page value for (a
// wrapper, a function, a promise twin) must not be collected and its address reused while the page
// value exists. Phase 2's M3 replaces this with the "has live wrapper" roots and their release.
GANGLION_EXPORT void ganglion_v_root(uint64_t const* slot)
{
    auto value = read(slot);
    if (value.is_object())
        (void)gc_root_create(reinterpret_cast<GCCell*>(value.as_object()));
}

// Calls a runtime function (a binding's native function, a callback LibWeb made) with converted arguments.
GANGLION_EXPORT int ganglion_js_invoke(uint64_t const* function, uint64_t const* this_value, uint64_t const* argv, uint32_t argc, uint64_t* out)
{
    auto& v = vm();
    auto f = read(function);
    if (!is_callable(f)) {
        auto c = throw_type_error(v, "not a function"sv);
        write(out, value_of(c));
        return 1;
    }
    auto c = call(v, f, read(this_value), reinterpret_cast<Value const*>(argv), argc);
    write(out, value_of(c));
    return is_throw(c) ? 1 : 0;
}

GANGLION_EXPORT int ganglion_js_construct(uint64_t const* function, uint64_t const* argv, uint32_t argc, uint64_t const* new_target, uint64_t* out)
{
    auto& v = vm();
    auto f = read(function);
    if (!is_callable(f) || !static_cast<FunctionObject*>(f.as_object())->is_constructor) {
        auto c = throw_type_error(v, "Illegal constructor"sv);
        write(out, value_of(c));
        return 1;
    }
    auto* target = new_target ? object_at(new_target) : nullptr;
    auto c = construct(v, *f.as_object(), reinterpret_cast<Value const*>(argv), argc, target);
    if (is_throw(c)) {
        write(out, value_of(c));
        return 1;
    }
    // A construct completion carries the constructed object as a pointer (the ABI's construct hook returns
    // the object), not a tagged value.
    auto* constructed = reinterpret_cast<Object*>(static_cast<uintptr_t>(c.payload));
    write(out, constructed ? Value::from_object(constructed) : Value::undefined());
    return 0;
}

// The error kind of an error object (JS_ERROR_KIND_*), or -1.
GANGLION_EXPORT int32_t ganglion_v_error_kind(uint64_t const* slot)
{
    auto* object = object_at(slot);
    if (!object)
        return -1;
    if (object->klass->id != JS_LAYOUT_CLASS_ID_ERROR && !(object->klass->parent && object->klass->parent->id == JS_LAYOUT_CLASS_ID_ERROR))
        return -1;
    return static_cast<ErrorObject*>(object)->error_data.error_kind;
}

// A runtime error object of a kind with a message (for exceptions the glue raises on the engine's behalf).
GANGLION_EXPORT void ganglion_v_error_create(int32_t kind, uint16_t const* message, size_t length, uint64_t* out)
{
    auto& v = vm();
    write(out, Value::from_object(create_error(v, *Bridge::realm(), static_cast<u8>(kind), Utf16View { reinterpret_cast<char16_t const*>(message), length })));
}

GANGLION_EXPORT uint32_t ganglion_v_promise_state(uint64_t const* slot)
{
    auto* object = object_at(slot);
    if (!object || object->klass->id != JS_LAYOUT_CLASS_ID_PROMISE)
        return 0;
    return js_promise_state(reinterpret_cast<JSObject*>(object)) + 1; // 1 pending, 2 fulfilled, 3 rejected
}

// PerformPromiseThen on a runtime promise (a fetch's, a stream's) for the glue's twin: the runtime's promises
// have no `then` of their own (their prototype is bare), so the glue attaches its resolve/reject functions
// (foreign functions of the page's promise) directly. Marks the promise handled.
GANGLION_EXPORT void ganglion_promise_then(uint64_t const* promise, uint64_t const* on_fulfilled, uint64_t const* on_rejected)
{
    auto* object = object_at(promise);
    if (!object || object->klass->id != JS_LAYOUT_CLASS_ID_PROMISE)
        return;
    js_promise_perform_then(reinterpret_cast<JSVM*>(&vm()), reinterpret_cast<JSObject*>(object), read(on_fulfilled).bits, read(on_rejected).bits, nullptr);
}

GANGLION_EXPORT void ganglion_v_promise_result(uint64_t const* slot, uint64_t* out)
{
    *out = js_promise_result(reinterpret_cast<JSObject*>(object_at(slot)));
}

// The realm's global object (the Window wrapper) and the realm's %Object.prototype%.
GANGLION_EXPORT void ganglion_js_global(uint64_t* out)
{
    write(out, Value::from_object(Bridge::realm()->global_object));
}

// The global object of the current realm (the topmost execution context's): the realm a script being run belongs to.
GANGLION_EXPORT void ganglion_js_current_global(uint64_t* out)
{
    auto* r = current_realm(vm());
    if (!r)
        r = Bridge::realm();
    write(out, Value::from_object(r->global_object));
}

namespace Ganglion::Bridge {
void* worker_environment_global(char const* url, unsigned long url_length); // Host.cpp
}

// The Window of the page's workers' environment (Host.cpp worker_environment_global) in `out`: 1, or 0 for none.
GANGLION_EXPORT int ganglion_worker_environment(char const* url, size_t url_length, uint64_t* out)
{
    auto* global = Bridge::worker_environment_global(url, url_length);
    if (!global)
        return 0;
    write(out, Value::from_object(reinterpret_cast<Object*>(global)));
    return 1;
}

// Frame realms on or off (glue/engine/55-realms.js).
GANGLION_EXPORT void ganglion_js_frame_realms(int on)
{
    s_frame_realms = on != 0;
}

// The Window a WindowProxy currently stands for: 1 with it in `out`, or 0 (not a WindowProxy, or none).
GANGLION_EXPORT int ganglion_v_window_proxy_window(uint64_t const* slot, uint64_t* out)
{
    auto* object = object_at(slot);
    if (!object)
        return 0;
    auto* proxy = Web::HTML::WindowProxy::from_object(*reinterpret_cast<JS::Object*>(object));
    if (!proxy || !proxy->window())
        return 0;
    auto& global = proxy->window()->principal_realm().global_object();
    write(out, Value::from_object(reinterpret_cast<Object*>(&global)));
    return 1;
}

// The realm page code acts in when it calls this object with no engine frame under it (glue/engine/40-bridge.js
// idleEntry): a function's [[Realm]], a WindowProxy's window's realm, a global object's own realm; 0 for anything else
// (the principal realm is entered then).
GANGLION_EXPORT uintptr_t ganglion_js_realm_of(uint64_t const* slot)
{
    auto* object = object_at(slot);
    if (!object)
        return 0;
    if (is_callable(Value::from_object(object))) {
        auto* function = static_cast<FunctionObject*>(object);
        return reinterpret_cast<uintptr_t>(function->realm);
    }
    if (auto* proxy = Web::HTML::WindowProxy::from_object(*reinterpret_cast<JS::Object*>(object)); proxy && proxy->window())
        return reinterpret_cast<uintptr_t>(&proxy->window()->principal_realm());
    if (object->flags & JS_LAYOUT_OBJECT_FLAG_IS_GLOBAL_OBJECT)
        return reinterpret_cast<uintptr_t>(&realm_of_object(*object));
    return 0;
}

GANGLION_EXPORT void ganglion_js_object_prototype(uint64_t* out)
{
    write(out, Value::from_object(intrinsic(vm(), *Bridge::realm(), JS_INTRINSIC_OBJECT_PROTOTYPE)));
}

// A trusted event from the host: a message from another segment (a nested frame's parent or child, docs/architecture.md
// "Nested segments") or on a port bridged to one. The glue makes the event with the engine's own constructor;
// dispatchEvent() from script would mark it untrusted (DOM "dispatchEvent" step 2), so the host dispatches it
// here, as the engine does for its own postMessage. Returns 1 when dispatched, 0 when the values are not an
// EventTarget and an undispatched Event.
GANGLION_EXPORT int ganglion_dispatch_trusted(uint64_t const* target_slot, uint64_t const* event_slot)
{
    auto* target_object = object_at(target_slot);
    auto* event_object = object_at(event_slot);
    if (!target_object || !event_object)
        return 0;
    auto* target = as_if<Web::DOM::EventTarget>(Web::Bindings::wrappable_impl_from(reinterpret_cast<JS::Object*>(target_object)));
    auto* event = as_if<Web::DOM::Event>(Web::Bindings::wrappable_impl_from(reinterpret_cast<JS::Object*>(event_object)));
    if (!target || !event || event->dispatched() || !event->initialized())
        return 0;
    event->set_is_trusted(true);
    target->dispatch_event(*event);
    return 1;
}

// --- Import maps (docs/architecture.md "Import maps") ------------------------------------------------------------------
// The document's import map is LibWeb's (HTMLScriptElement registers each <script type=importmap>, merging them as the
// spec says). Page modules run on the host's V8, which knows no map in a Worker; the segment's service worker replaces
// the mapped specifier strings with the URLs the map gives (harness/segment/specifiers.js). These two calls are all the
// glue needs: the map as JSON (resolution is done in the glue, in the spec's order of keys), and the record of a
// resolved specifier, which a later map's merge must respect ("merge existing and new import maps").

static Web::HTML::Window* window_of_global(uint64_t const* slot)
{
    auto* object = object_at(slot);
    if (!object)
        return nullptr;
    return as_if<Web::HTML::Window>(Web::Bindings::wrappable_impl_from(reinterpret_cast<JS::Object*>(object)));
}

// --- Window named properties (docs/surface.md "Named access on the window") --------------------------------------------
// The global of the segment cannot carry a named properties object of its own making (its prototype chain is immutable), so the
// glue keeps accessors for the Window's supported property names on WindowProperties. This hands it those names (into the keys
// list, ganglion_keys_count / at) when the document's tree version moved since `known` (which every id, name and child navigable
// change bumps), and the version now in *version. Returns 1 when the list was refilled, 0 when nothing moved or no Window.
GANGLION_EXPORT int ganglion_window_named_keys(uint64_t const* slot, double known, double* version)
{
    auto* window = window_of_global(slot);
    if (!window)
        return 0;
    auto now = static_cast<double>(window->associated_document().dom_tree_version());
    *version = now;
    if (now == known)
        return 0;
    s_keys.clear_with_capacity();
    for (auto& name : window->supported_property_names()) {
        s_keys.append(Key::from_fly_string(name));
        own_key_names().set(name);
    }
    return 1;
}

static String s_import_map_json;

static JsonObject specifier_map_json(Web::HTML::ModuleSpecifierMap const& map)
{
    JsonObject out;
    for (auto const& [key, value] : map) {
        if (value.has_value())
            out.set(key.to_well_formed_utf8(), JsonValue(value->serialize()));
        else
            out.set(key.to_well_formed_utf8(), JsonValue());
    }
    return out;
}

// {"imports":{specifier:url|null}, "scopes":{prefix:{...}}, "integrity":{url:metadata}} for the Window whose global is in
// `slot`, as UTF-8 (valid until the next call), or null when it is no Window.
GANGLION_EXPORT char const* ganglion_import_map_json(uint64_t const* slot, uint32_t* length)
{
    auto* window = window_of_global(slot);
    if (!window) {
        *length = 0;
        return nullptr;
    }
    auto const& map = window->import_map();
    JsonObject out;
    out.set("imports"sv, specifier_map_json(map.imports()));
    JsonObject scopes;
    for (auto const& [prefix, imports] : map.scopes())
        scopes.set(prefix.serialize(), specifier_map_json(imports));
    out.set("scopes"sv, move(scopes));
    JsonObject integrity;
    for (auto const& [url, metadata] : map.integrity())
        integrity.set(url.serialize(), JsonValue(metadata.to_well_formed_utf8()));
    out.set("integrity"sv, move(integrity));
    s_import_map_json = out.serialized();
    *length = s_import_map_json.bytes().size();
    return reinterpret_cast<char const*>(s_import_map_json.bytes().data());
}

// Add a specifier resolution record to the Window's resolved module set ("add module to resolved module set"):
// `special` is whether asURL is null or special.
GANGLION_EXPORT void ganglion_import_map_resolved(uint64_t const* slot, uint16_t const* base, size_t base_length, uint16_t const* specifier, size_t specifier_length, int special)
{
    auto* window = window_of_global(slot);
    if (!window)
        return;
    window->append_resolved_module(Web::HTML::SpecifierResolution {
        .serialized_base_url = Utf16String::from_utf16({ reinterpret_cast<char16_t const*>(base), base_length }),
        .specifier = Utf16String::from_utf16({ reinterpret_cast<char16_t const*>(specifier), specifier_length }),
        .specifier_is_null_or_url_like_that_is_special = special != 0,
    });
}
