// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Cells: the classes, allocation through LibGC's C API, visiting and finalizing.

#include <AK/Format.h>
#include <Ganglion/Runtime.h>

namespace Ganglion {

static void visit_properties(PropertyTable* table, GCVisitor* v)
{
    if (!table)
        return;
    for (auto& property : table->entries) {
        if (property.kind == PropertyKind::Deleted)
            continue;
        if (property.key.is_symbol())
            visit_cell(v, property.key.as_symbol());
        visit_value(v, property.value);
        if (property.setter)
            visit_cell(v, property.setter);
    }
}

static void finalize_properties(PropertyTable* table)
{
    if (!table)
        return;
    for (auto& property : table->entries) {
        if (property.kind != PropertyKind::Deleted && property.key.is_string())
            Utf16FlyString::unref_raw(property.key.bits);
    }
    delete table;
}

static void visit_object(Cell* cell, GCVisitor* v)
{
    auto& object = *static_cast<Object*>(cell);
    visit_cell(v, object.shape);
    visit_properties(object.properties, v);
}

static void finalize_object(Cell* cell)
{
    auto& object = *static_cast<Object*>(cell);
    finalize_properties(object.properties);
    object.properties = nullptr;
}

static void visit_shape(Cell* cell, GCVisitor* v)
{
    auto& shape = *static_cast<Shape*>(cell);
    visit_cell(v, shape.realm);
    visit_cell(v, shape.prototype);
}

static void visit_realm(Cell* cell, GCVisitor* v)
{
    auto& realm = *static_cast<Realm*>(cell);
    visit_cell(v, realm.global_object);
    visit_cell(v, realm.global_environment);
    visit_cell(v, realm.host_defined);
    if (auto* intrinsics = realm.intrinsics) {
        for (auto* slot : intrinsics->slots)
            visit_cell(v, slot);
        for (auto* slot : intrinsics->error_prototypes)
            visit_cell(v, slot);
        visit_cell(v, intrinsics->promise_prototype);
        visit_cell(v, intrinsics->array_buffer_prototype);
        visit_cell(v, intrinsics->shared_array_buffer_prototype);
        visit_cell(v, intrinsics->typed_array_base_prototype);
        for (auto* slot : intrinsics->typed_array_prototypes)
            visit_cell(v, slot);
    }
}

static void finalize_realm(Cell* cell)
{
    auto& realm = *static_cast<Realm*>(cell);
    delete realm.intrinsics;
    realm.intrinsics = nullptr;
}

static void finalize_string(Cell* cell)
{
    auto& string = *static_cast<PrimitiveString*>(cell);
    if (string.string_raw)
        (void)Utf16String::adopt_raw(string.string_raw);
    string.string_raw = 0;
}

static void finalize_symbol(Cell* cell)
{
    auto& symbol = *static_cast<Symbol*>(cell);
    if (symbol.description_raw)
        (void)Utf16String::adopt_raw(symbol.description_raw);
    symbol.description_raw = 0;
}

static void visit_function(Cell* cell, GCVisitor* v)
{
    visit_object(cell, v);
    auto& function = *static_cast<FunctionObject*>(cell);
    visit_cell(v, function.realm);
    visit_cell(v, function.closure_context);
    visit_value(v, function.slot0);
    visit_value(v, function.slot1);
}

static void finalize_function(Cell* cell)
{
    finalize_object(cell);
    auto& function = *static_cast<FunctionObject*>(cell);
    if (function.name_raw)
        Utf16FlyString::unref_raw(function.name_raw);
    function.name_raw = 0;
}

static void visit_host_object(Cell* cell, GCVisitor* v)
{
    visit_object(cell, v);
    auto& object = *static_cast<HostObject*>(cell);
    visit_cell(v, object.wrappable);
    visit_cell(v, object.host_data);
}

static void finalize_host_object(Cell* cell)
{
    auto& object = *static_cast<HostObject*>(cell);
    if (object.host_class) {
        if (object.host_class->kind == JS_HOST_CLASS_OBJECT || object.host_class->kind == JS_HOST_CLASS_ARRAY) {
            auto const* hooks = static_cast<JSHostObjectHooks const*>(object.host_class->hooks);
            if (object.host_class->kind == JS_HOST_CLASS_OBJECT && hooks && hooks->finalize)
                hooks->finalize(object_abi(&object));
        }
    }
    finalize_object(cell);
}

static void visit_host_function(Cell* cell, GCVisitor* v)
{
    visit_function(cell, v);
    auto& function = *static_cast<HostFunction*>(cell);
    visit_cell(v, function.host_data);
}

static void finalize_host_function(Cell* cell)
{
    auto& function = *static_cast<HostFunction*>(cell);
    if (function.host_class && function.host_class->kind == JS_HOST_CLASS_FUNCTION) {
        auto const* hooks = static_cast<JSHostFunctionHooks const*>(function.host_class->hooks);
        if (hooks && hooks->finalize)
            hooks->finalize(object_abi(&function));
    }
    finalize_function(cell);
}

static void visit_promise(Cell* cell, GCVisitor* v)
{
    visit_object(cell, v);
    auto& promise = *static_cast<Promise*>(cell);
    visit_value(v, promise.result);
    for (auto* reactions : { promise.fulfill_reactions, promise.reject_reactions }) {
        if (!reactions)
            continue;
        for (auto& reaction : *reactions) {
            visit_cell(v, reaction.capability);
            visit_value(v, reaction.handler);
        }
    }
}

static void finalize_promise(Cell* cell)
{
    auto& promise = *static_cast<Promise*>(cell);
    delete promise.fulfill_reactions;
    delete promise.reject_reactions;
    promise.fulfill_reactions = promise.reject_reactions = nullptr;
    finalize_object(cell);
}

static void visit_promise_capability(Cell* cell, GCVisitor* v)
{
    auto& capability = *static_cast<PromiseCapability*>(cell);
    visit_cell(v, capability.promise);
    visit_cell(v, capability.resolve);
    visit_cell(v, capability.reject);
}

static void visit_promise_job(Cell* cell, GCVisitor* v)
{
    auto& job = *static_cast<PromiseJob*>(cell);
    visit_value(v, job.argument);
    visit_value(v, job.handler);
    visit_cell(v, job.capability);
    visit_cell(v, job.promise);
    visit_cell(v, job.thenable);
    visit_cell(v, job.then);
}

static void visit_job_callback(Cell* cell, GCVisitor* v)
{
    auto& callback = *static_cast<JobCallback*>(cell);
    visit_cell(v, callback.callback);
    visit_cell(v, callback.custom_data);
}

static void visit_environment(Cell* cell, GCVisitor* v)
{
    auto& environment = *static_cast<Environment*>(cell);
    visit_cell(v, environment.outer);
    visit_cell(v, environment.binding_object);
    visit_cell(v, environment.declarative_record);
    visit_cell(v, environment.object_record);
    visit_cell(v, environment.function);
    if (environment.bindings) {
        for (auto& it : *environment.bindings)
            visit_value(v, it.value.value);
    }
}

static void finalize_environment(Cell* cell)
{
    auto& environment = *static_cast<Environment*>(cell);
    if (environment.bindings) {
        for (auto& it : *environment.bindings)
            Utf16FlyString::unref_raw(it.key);
        delete environment.bindings;
    }
    environment.bindings = nullptr;
}

static void visit_map(Cell* cell, GCVisitor* v)
{
    visit_object(cell, v);
    auto& map = *static_cast<MapObject*>(cell);
    if (map.entries)
        visit_values(v, map.entries->data(), map.entries->size());
}

static void finalize_map(Cell* cell)
{
    auto& map = *static_cast<MapObject*>(cell);
    delete map.entries;
    map.entries = nullptr;
    finalize_object(cell);
}

static void visit_primitive_wrapper(Cell* cell, GCVisitor* v)
{
    visit_object(cell, v);
    visit_value(v, static_cast<PrimitiveWrapper*>(cell)->primitive);
}

static void visit_console(Cell* cell, GCVisitor* v)
{
    auto& console = *static_cast<Console*>(cell);
    visit_cell(v, console.realm);
    visit_cell(v, console.client);
}

static void visit_console_client(Cell* cell, GCVisitor* v)
{
    visit_cell(v, static_cast<ConsoleClient*>(cell)->console);
}

static void visit_console_object(Cell* cell, GCVisitor* v)
{
    visit_object(cell, v);
    visit_cell(v, static_cast<ConsoleObject*>(cell)->console);
}

#define GANGLION_CLASS(symbol, id_, parent_, name_, type, kind_, visit_, finalize_) \
    Class const symbol { .id = (id_), .flags = 0, .parent = (parent_), .name = name_, .name_length = sizeof(name_) - 1, .cell_size = sizeof(type), .cell_kind = (kind_), .visit = (visit_), .finalize = (finalize_), .allocator = nullptr };

GANGLION_CLASS(class_object, JS_LAYOUT_CLASS_ID_OBJECT, nullptr, "Object", Object, GC_CELL_KIND_OBJECT, visit_object, finalize_object)
GANGLION_CLASS(class_shape, JS_LAYOUT_CLASS_ID_SHAPE, nullptr, "Shape", Shape, GC_CELL_KIND_OTHER, visit_shape, nullptr)
GANGLION_CLASS(class_realm, JS_LAYOUT_CLASS_ID_REALM, nullptr, "Realm", Realm, GC_CELL_KIND_OTHER, visit_realm, finalize_realm)
GANGLION_CLASS(class_string, JS_LAYOUT_CLASS_ID_PRIMITIVE_STRING, nullptr, "PrimitiveString", PrimitiveString, GC_CELL_KIND_PRIMITIVE_STRING, nullptr, finalize_string)
GANGLION_CLASS(class_symbol, JS_LAYOUT_CLASS_ID_SYMBOL, nullptr, "Symbol", Symbol, GC_CELL_KIND_SYMBOL, nullptr, finalize_symbol)
GANGLION_CLASS(class_function, JS_LAYOUT_CLASS_ID_NATIVE_FUNCTION, &class_object, "NativeFunction", FunctionObject, GC_CELL_KIND_OBJECT, visit_function, finalize_function)
GANGLION_CLASS(class_host_object, JS_LAYOUT_CLASS_ID_HOST_OBJECT, &class_object, "HostObject", HostObject, GC_CELL_KIND_OBJECT, visit_host_object, finalize_host_object)
GANGLION_CLASS(class_host_function, JS_LAYOUT_CLASS_ID_HOST_FUNCTION, &class_function, "HostFunction", HostFunction, GC_CELL_KIND_OBJECT, visit_host_function, finalize_host_function)
GANGLION_CLASS(class_host_array, JS_LAYOUT_CLASS_ID_HOST_ARRAY, &class_object, "HostArray", HostObject, GC_CELL_KIND_OBJECT, visit_host_object, finalize_host_object)
GANGLION_CLASS(class_array, JS_LAYOUT_CLASS_ID_ARRAY, &class_object, "Array", Object, GC_CELL_KIND_OBJECT, visit_object, finalize_object)
GANGLION_CLASS(class_error, JS_LAYOUT_CLASS_ID_ERROR, &class_object, "Error", ErrorObject, GC_CELL_KIND_OBJECT, visit_object, finalize_object)
Class const class_native_error[10] {
    class_error,
    { .id = JS_LAYOUT_CLASS_ID_EVAL_ERROR, .flags = 0, .parent = &class_error, .name = "EvalError", .name_length = 9, .cell_size = sizeof(ErrorObject), .cell_kind = GC_CELL_KIND_OBJECT, .visit = visit_object, .finalize = finalize_object, .allocator = nullptr },
    { .id = JS_LAYOUT_CLASS_ID_INTERNAL_ERROR, .flags = 0, .parent = &class_error, .name = "InternalError", .name_length = 13, .cell_size = sizeof(ErrorObject), .cell_kind = GC_CELL_KIND_OBJECT, .visit = visit_object, .finalize = finalize_object, .allocator = nullptr },
    { .id = JS_LAYOUT_CLASS_ID_RANGE_ERROR, .flags = 0, .parent = &class_error, .name = "RangeError", .name_length = 10, .cell_size = sizeof(ErrorObject), .cell_kind = GC_CELL_KIND_OBJECT, .visit = visit_object, .finalize = finalize_object, .allocator = nullptr },
    { .id = JS_LAYOUT_CLASS_ID_REFERENCE_ERROR, .flags = 0, .parent = &class_error, .name = "ReferenceError", .name_length = 14, .cell_size = sizeof(ErrorObject), .cell_kind = GC_CELL_KIND_OBJECT, .visit = visit_object, .finalize = finalize_object, .allocator = nullptr },
    { .id = JS_LAYOUT_CLASS_ID_SYNTAX_ERROR, .flags = 0, .parent = &class_error, .name = "SyntaxError", .name_length = 11, .cell_size = sizeof(ErrorObject), .cell_kind = GC_CELL_KIND_OBJECT, .visit = visit_object, .finalize = finalize_object, .allocator = nullptr },
    { .id = JS_LAYOUT_CLASS_ID_TYPE_ERROR, .flags = 0, .parent = &class_error, .name = "TypeError", .name_length = 9, .cell_size = sizeof(ErrorObject), .cell_kind = GC_CELL_KIND_OBJECT, .visit = visit_object, .finalize = finalize_object, .allocator = nullptr },
    { .id = JS_LAYOUT_CLASS_ID_URI_ERROR, .flags = 0, .parent = &class_error, .name = "URIError", .name_length = 8, .cell_size = sizeof(ErrorObject), .cell_kind = GC_CELL_KIND_OBJECT, .visit = visit_object, .finalize = finalize_object, .allocator = nullptr },
    { .id = JS_LAYOUT_CLASS_ID_AGGREGATE_ERROR, .flags = 0, .parent = &class_error, .name = "AggregateError", .name_length = 14, .cell_size = sizeof(ErrorObject), .cell_kind = GC_CELL_KIND_OBJECT, .visit = visit_object, .finalize = finalize_object, .allocator = nullptr },
    { .id = JS_LAYOUT_CLASS_ID_SUPPRESSED_ERROR, .flags = 0, .parent = &class_error, .name = "SuppressedError", .name_length = 15, .cell_size = sizeof(ErrorObject), .cell_kind = GC_CELL_KIND_OBJECT, .visit = visit_object, .finalize = finalize_object, .allocator = nullptr },
};
GANGLION_CLASS(class_error_data_cell, JS_LAYOUT_CLASS_ID_ERROR_DATA_CELL, nullptr, "ErrorDataCell", ErrorDataCell, GC_CELL_KIND_OTHER, nullptr, nullptr)
GANGLION_CLASS(class_promise, JS_LAYOUT_CLASS_ID_PROMISE, &class_object, "Promise", Promise, GC_CELL_KIND_OBJECT, visit_promise, finalize_promise)
GANGLION_CLASS(class_promise_capability, JS_LAYOUT_CLASS_ID_PROMISE_CAPABILITY, nullptr, "PromiseCapability", PromiseCapability, GC_CELL_KIND_OTHER, visit_promise_capability, nullptr)
GANGLION_CLASS(class_promise_job, JS_LAYOUT_CLASS_ID_PROMISE_REACTION, nullptr, "PromiseJob", PromiseJob, GC_CELL_KIND_OTHER, visit_promise_job, nullptr)
GANGLION_CLASS(class_job_callback, JS_LAYOUT_CLASS_ID_JOB_CALLBACK, nullptr, "JobCallback", JobCallback, GC_CELL_KIND_OTHER, visit_job_callback, nullptr)
Class const class_environment[5] {
    { .id = JS_LAYOUT_CLASS_ID_DECLARATIVE_ENVIRONMENT, .flags = 0, .parent = nullptr, .name = "DeclarativeEnvironment", .name_length = 22, .cell_size = sizeof(Environment), .cell_kind = GC_CELL_KIND_OTHER, .visit = visit_environment, .finalize = finalize_environment, .allocator = nullptr },
    { .id = JS_LAYOUT_CLASS_ID_FUNCTION_ENVIRONMENT, .flags = 0, .parent = nullptr, .name = "FunctionEnvironment", .name_length = 19, .cell_size = sizeof(Environment), .cell_kind = GC_CELL_KIND_OTHER, .visit = visit_environment, .finalize = finalize_environment, .allocator = nullptr },
    { .id = JS_LAYOUT_CLASS_ID_MODULE_ENVIRONMENT, .flags = 0, .parent = nullptr, .name = "ModuleEnvironment", .name_length = 17, .cell_size = sizeof(Environment), .cell_kind = GC_CELL_KIND_OTHER, .visit = visit_environment, .finalize = finalize_environment, .allocator = nullptr },
    { .id = JS_LAYOUT_CLASS_ID_GLOBAL_ENVIRONMENT, .flags = 0, .parent = nullptr, .name = "GlobalEnvironment", .name_length = 17, .cell_size = sizeof(Environment), .cell_kind = GC_CELL_KIND_OTHER, .visit = visit_environment, .finalize = finalize_environment, .allocator = nullptr },
    { .id = JS_LAYOUT_CLASS_ID_OBJECT_ENVIRONMENT, .flags = 0, .parent = nullptr, .name = "ObjectEnvironment", .name_length = 17, .cell_size = sizeof(Environment), .cell_kind = GC_CELL_KIND_OTHER, .visit = visit_environment, .finalize = finalize_environment, .allocator = nullptr },
};
GANGLION_CLASS(class_map, JS_LAYOUT_CLASS_ID_MAP, &class_object, "Map", MapObject, GC_CELL_KIND_OBJECT, visit_map, finalize_map)
GANGLION_CLASS(class_set, JS_LAYOUT_CLASS_ID_SET, &class_object, "Set", MapObject, GC_CELL_KIND_OBJECT, visit_map, finalize_map)
GANGLION_CLASS(class_boolean_object, JS_LAYOUT_CLASS_ID_BOOLEAN_OBJECT, &class_object, "Boolean", PrimitiveWrapper, GC_CELL_KIND_OBJECT, visit_primitive_wrapper, finalize_object)
GANGLION_CLASS(class_number_object, JS_LAYOUT_CLASS_ID_NUMBER_OBJECT, &class_object, "Number", PrimitiveWrapper, GC_CELL_KIND_OBJECT, visit_primitive_wrapper, finalize_object)
GANGLION_CLASS(class_string_object, JS_LAYOUT_CLASS_ID_STRING_OBJECT, &class_object, "String", PrimitiveWrapper, GC_CELL_KIND_OBJECT, visit_primitive_wrapper, finalize_object)
static void visit_script(Cell* cell, GCVisitor* v)
{
    auto& script = *static_cast<ScriptObject*>(cell);
    if (script.host_defined)
        visit_cell(v, script.host_defined);
    if (script.realm)
        visit_cell(v, script.realm);
}

static void finalize_script(Cell* cell)
{
    auto& script = *static_cast<ScriptObject*>(cell);
    if (script.source_raw)
        (void)Utf16String::adopt_raw(script.source_raw);
    if (script.filename_raw)
        (void)Utf16String::adopt_raw(script.filename_raw);
    script.source_raw = script.filename_raw = 0;
    if (script.source_code)
        js_source_code_release(static_cast<JSSourceCode const*>(script.source_code));
    script.source_code = nullptr;
}

static void finalize_dynamic_function(Cell* cell)
{
    auto& data = *static_cast<DynamicFunction*>(cell);
    for (auto* raw : { &data.source_raw, &data.parameters_raw, &data.body_raw }) {
        if (*raw)
            (void)Utf16String::adopt_raw(*raw);
        *raw = 0;
    }
}

GANGLION_CLASS(class_dynamic_function, JS_LAYOUT_CLASS_ID_SHARED_FUNCTION_INSTANCE_DATA, nullptr, "DynamicFunction", DynamicFunction, GC_CELL_KIND_OTHER, nullptr, finalize_dynamic_function)
GANGLION_CLASS(class_script, JS_LAYOUT_CLASS_ID_SCRIPT, nullptr, "Script", ScriptObject, GC_CELL_KIND_OTHER, visit_script, finalize_script)
GANGLION_CLASS(class_module, JS_LAYOUT_CLASS_ID_SOURCE_TEXT_MODULE, nullptr, "SourceTextModule", ScriptObject, GC_CELL_KIND_OTHER, visit_script, finalize_script)
GANGLION_CLASS(class_date, JS_LAYOUT_CLASS_ID_DATE, &class_object, "Date", DateObject, GC_CELL_KIND_OBJECT, visit_object, finalize_object)
GANGLION_CLASS(class_console, JS_LAYOUT_CLASS_ID_CONSOLE, nullptr, "Console", Console, GC_CELL_KIND_OTHER, visit_console, nullptr)
GANGLION_CLASS(class_console_client, JS_LAYOUT_CLASS_ID_HOST_CONSOLE_CLIENT, nullptr, "ConsoleClient", ConsoleClient, GC_CELL_KIND_OTHER, visit_console_client, nullptr)
GANGLION_CLASS(class_console_object, JS_LAYOUT_CLASS_ID_CONSOLE_OBJECT, &class_object, "console", ConsoleObject, GC_CELL_KIND_OBJECT, visit_console_object, finalize_object)
GANGLION_CLASS(class_global_object, JS_LAYOUT_CLASS_ID_GLOBAL_OBJECT, &class_object, "GlobalObject", Object, GC_CELL_KIND_OBJECT, visit_object, finalize_object)
GANGLION_CLASS(class_promise_constructor, JS_LAYOUT_CLASS_ID_PROMISE_CONSTRUCTOR, &class_function, "Promise", FunctionObject, GC_CELL_KIND_OBJECT, visit_function, finalize_function)

#undef GANGLION_CLASS

void visit_object_edges(Cell* cell, GCVisitor* v) { visit_object(cell, v); }
void finalize_object_fields(Cell* cell) { finalize_object(cell); }

// --- LibGC glue ----------------------------------------------------------------------------------------

static void visit_edges_thunk(GCCell* raw, GCVisitor* visitor)
{
    auto* cell = reinterpret_cast<Cell*>(raw);
    if (cell->klass->visit)
        cell->klass->visit(cell, visitor);
}

static void finalize_thunk(GCCell* raw)
{
    auto* cell = reinterpret_cast<Cell*>(raw);
    if (cell->klass->finalize)
        cell->klass->finalize(cell);
}

static char const* class_name_thunk(GCCell const* raw, size_t* length)
{
    auto const* cell = reinterpret_cast<Cell const*>(raw);
    *length = cell->klass->name_length;
    return cell->klass->name;
}

static GCAllocator* allocator_for(Class const& klass)
{
    if (klass.allocator)
        return klass.allocator;
    auto* info = new GCCellTypeInfo {
        .cell_size = klass.cell_size,
        .alignment = 8,
        .kind = klass.cell_kind,
        .visit_edges = visit_edges_thunk,
        .finalize = finalize_thunk,
        .destroy = nullptr,
        .external_memory_size = nullptr,
        .class_name = class_name_thunk,
    };
    klass.allocator = gc_allocator_create(info, klass.name, klass.name_length);
    return klass.allocator;
}

Cell* allocate_cell(VM& vm, Class const& klass)
{
    bool must_mark = false;
    auto* raw = gc_heap_allocate_cell(vm.heap, allocator_for(klass), &must_mark);
    VERIFY(raw);
    auto* cell = reinterpret_cast<Cell*>(raw);
    __builtin_memset(cell, 0, klass.cell_size);
    cell->klass = &klass;
    cell->mark = must_mark ? 1 : 0;
    cell->state = GC_CELL_STATE_LIVE;
    cell->kind = klass.cell_kind;
    return cell;
}

void visit_cell(GCVisitor* v, void const* cell)
{
    if (cell)
        gc_visitor_visit_cell(v, reinterpret_cast<GCCell*>(const_cast<void*>(cell)));
}

void visit_value(GCVisitor* v, Value value)
{
    if (value.is_cell())
        gc_visitor_visit_values(v, &value.bits, 1);
}

void visit_values(GCVisitor* v, Value const* values, size_t count)
{
    if (count)
        gc_visitor_visit_values(v, reinterpret_cast<u64 const*>(values), count);
}

static void visit_execution_context(ExecutionContext* context, GCVisitor* v)
{
    visit_cell(v, context->function);
    visit_cell(v, context->realm);
    visit_cell(v, context->script_or_module.cell);
    visit_cell(v, context->lexical_environment);
    visit_cell(v, context->variable_environment);
    visit_cell(v, context->private_environment);
    visit_value(v, context->this_value);
    visit_cell(v, context->executable);
    visit_values(v, context->slots(), context->registers_and_constants_and_locals_and_arguments_count);
}

void gather_roots(void* context, GCVisitor* v)
{
    auto& vm = *static_cast<VM*>(context);
    if (vm.realms) {
        for (auto* realm : *vm.realms)
            visit_cell(v, realm);
    }
    for (auto* symbol : vm.well_known_symbols)
        visit_cell(v, symbol);
    visit_cell(v, vm.empty_string);
    visit_cell(v, vm.type_error_realm_override);
    for (u32 i = 0; i < vm.execution_context_stack_length; ++i)
        visit_execution_context(vm.execution_context_stack_entries[i].execution_context, v);
    if (vm.saved_stacks) {
        for (auto& stack : *vm.saved_stacks) {
            for (auto& entry : stack)
                visit_execution_context(entry.execution_context, v);
        }
    }
    if (vm.own_job_queue) {
        for (auto* job : *vm.own_job_queue)
            visit_cell(v, job);
    }
}

extern "C" void js_execution_context_visit(JSExecutionContext const* execution_context, GCVisitor* visitor)
{
    visit_execution_context(reinterpret_cast<ExecutionContext*>(const_cast<JSExecutionContext*>(execution_context)), visitor);
}

}
