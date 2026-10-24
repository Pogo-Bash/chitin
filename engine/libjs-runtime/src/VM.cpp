// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// The VM: its construction in the facade's storage, host hooks, the agent, execution contexts and the
// execution context stack, well-known symbols.

#include <AK/Format.h>
#include <Ganglion/Runtime.h>
#include <stdlib.h>

extern "C" [[noreturn]] void ganglion_js_unimplemented(char const* name);

namespace Ganglion {

// There is one VM per process (JS::VM::create() verifies that), and operations that take no VM reach it here.
VM* g_vm = nullptr;

static CommonKeys* make_common_keys()
{
    auto* keys = new CommonKeys;
    auto make = [&](StringView name) {
        auto fly = Utf16FlyString::from_utf8_without_validation(name);
        auto key = Key::from_fly_string(fly);
        keys->owned.append(move(fly));
        return key;
    };
    keys->length = make("length"sv);
    keys->name = make("name"sv);
    keys->message = make("message"sv);
    keys->constructor = make("constructor"sv);
    keys->prototype = make("prototype"sv);
    keys->then = make("then"sv);
    keys->cause = make("cause"sv);
    keys->value = make("value"sv);
    keys->done = make("done"sv);
    keys->next = make("next"sv);
    keys->to_string = make("toString"sv);
    keys->value_of = make("valueOf"sv);
    keys->stack = make("stack"sv);
    keys->errors = make("errors"sv);
    return keys;
}

static Symbol* create_symbol(VM& vm, StringView description)
{
    auto* symbol = allocate<Symbol>(vm, class_symbol);
    symbol->description_raw = Utf16String::from_utf8(description).into_raw();
    return symbol;
}

extern "C" bool js_vm_construct_at(void* storage, size_t size, size_t align, JSVmOptions const* options)
{
    if (!storage || size < sizeof(VM) || align < alignof(VM) || (reinterpret_cast<uintptr_t>(storage) % alignof(VM)) != 0)
        return false;
    auto& vm = *new (storage) VM {};
    g_vm = &vm;
    bool become_default = options ? options->become_process_default_heap : false;
    vm.heap = gc_heap_create(gather_roots, &vm, become_default);
    VERIFY(vm.heap);
    // Collections happen only at task boundaries, where the segment host asks for them (docs/phase1.md,
    // "LibGC on wasm32"): no engine frame is on the stack then, so nothing live hides in wasm locals.
    gc_heap_set_incremental_sweep_enabled(vm.heap, false);
    vm.execution_context_stack_capacity = 64;
    vm.execution_context_stack_entries = static_cast<StackEntry*>(calloc(vm.execution_context_stack_capacity, sizeof(StackEntry)));
    vm.realms = new Vector<Realm*>;
    vm.own_job_queue = new Vector<PromiseJob*>;
    vm.saved_stacks = new Vector<Vector<StackEntry>>;
    vm.keys = make_common_keys();
    vm.empty_string = create_string(vm, Utf16String {});
    static constexpr StringView well_known_names[] = {
        "Symbol.asyncDispose"sv, "Symbol.asyncIterator"sv, "Symbol.dispose"sv, "Symbol.hasInstance"sv,
        "Symbol.isConcatSpreadable"sv, "Symbol.iterator"sv, "Symbol.match"sv, "Symbol.matchAll"sv,
        "Symbol.replace"sv, "Symbol.replaceAll"sv, "Symbol.search"sv, "Symbol.species"sv, "Symbol.split"sv,
        "Symbol.toPrimitive"sv, "Symbol.toStringTag"sv, "Symbol.unscopables"sv
    };
    for (size_t i = 0; i < 16; ++i)
        vm.well_known_symbols[i] = create_symbol(vm, well_known_names[i]);
    return true;
}

extern "C" void js_vm_destroy_at(JSVM* abi_vm)
{
    auto& vm = vm_of(abi_vm);
    vm.hooks = nullptr;
    vm.has_agent = false;
    gc_heap_destroy(vm.heap);
    vm.heap = nullptr;
    free(vm.execution_context_stack_entries);
    delete vm.realms;
    delete vm.own_job_queue;
    delete vm.saved_stacks;
    delete vm.keys;
    if (g_vm == &vm)
        g_vm = nullptr;
    vm.~VM();
}

extern "C" GCHeap* js_vm_heap(JSVM* vm)
{
    return vm_of(vm).heap;
}

extern "C" void js_vm_finish_execution_generation(JSVM* vm)
{
    ++vm_of(vm).execution_generation;
}

extern "C" bool js_vm_did_reach_stack_space_limit(JSVM*)
{
    // The shadow stack of wasm is the only one this runtime uses for native functions; Emscripten's
    // default of 64 KiB leaves no room for a guess here, so the host sizes the stack generously.
    return false;
}

extern "C" void js_vm_stack_trace(JSVM* vm, JSStackTraceSink const* sink)
{
    // No frame runs bytecode, so every element has no source range.
    auto& v = vm_of(vm);
    for (u32 i = v.execution_context_stack_length; i > 0; --i) {
        JSDebuggerStackFrame frame {
            .execution_context = reinterpret_cast<JSExecutionContext*>(v.execution_context_stack_entries[i - 1].execution_context),
            .source_range = { .source_code = nullptr, .line = 0, .column = 0 },
        };
        sink->append(sink->context, &frame);
    }
}

extern "C" void js_vm_clear_system_time_zone_cache(void)
{
}

extern "C" void js_vm_set_embedder(JSVM* vm, JSVmHostHooks const* hooks, void* data)
{
    vm_of(vm).hooks = hooks;
    vm_of(vm).hooks_data = data;
}

extern "C" void js_vm_set_agent(JSVM* vm, JSAgent const* agent)
{
    auto& v = vm_of(vm);
    v.has_agent = agent != nullptr;
    if (agent)
        v.agent = *agent;
}

extern "C" int64_t js_vm_default_host_system_utc_epoch_nanoseconds(JSVM*, JSObject*)
{
    return 0;
}

// --- Execution contexts --------------------------------------------------------------------------------

static ExecutionContext* new_execution_context(u32 registers_and_locals_count, u32 constant_count, u32 argument_count)
{
    u32 slots = registers_and_locals_count + constant_count + argument_count;
    size_t size = sizeof(ExecutionContext) + sizeof(Value) * slots;
    auto* context = static_cast<ExecutionContext*>(aligned_alloc(alignof(ExecutionContext), (size + 15) & ~size_t(15)));
    VERIFY(context);
    __builtin_memset(context, 0, size);
    context->yield_continuation = 0xFFFFFFFFu;
    context->this_value = Value::empty();
    context->registers_and_constants_and_locals_and_arguments_count = slots;
    context->argument_count = argument_count;
    for (u32 i = 0; i < slots; ++i)
        context->slots()[i] = Value::undefined();
    return context;
}

extern "C" JSExecutionContext* js_execution_context_create(uint32_t registers_and_locals_count, uint32_t constant_count, uint32_t argument_count)
{
    return reinterpret_cast<JSExecutionContext*>(new_execution_context(registers_and_locals_count, constant_count, argument_count));
}

extern "C" JSExecutionContext* js_execution_context_copy(JSExecutionContext const* abi_context)
{
    auto const* source = reinterpret_cast<ExecutionContext const*>(abi_context);
    u32 slots = source->registers_and_constants_and_locals_and_arguments_count;
    auto* copy = new_execution_context(slots - source->argument_count, 0, source->argument_count);
    __builtin_memcpy(copy, source, sizeof(ExecutionContext) + sizeof(Value) * slots);
    copy->caller_frame = nullptr;
    return reinterpret_cast<JSExecutionContext*>(copy);
}

extern "C" void js_execution_context_destroy(JSExecutionContext* context)
{
    free(context);
}

extern "C" JSExecutionContext* js_execution_context_interpreter_stack_allocate(JSVM*, uint32_t registers_and_locals_count, uint32_t constant_count, uint32_t argument_count)
{
    // The runtime has no interpreter stack; these contexts live in malloc memory like the others and are
    // freed by js_execution_context_interpreter_stack_deallocate, whose mark is the context itself.
    return reinterpret_cast<JSExecutionContext*>(new_execution_context(registers_and_locals_count, constant_count, argument_count));
}

extern "C" void js_execution_context_interpreter_stack_deallocate(JSVM*, void* mark)
{
    free(mark);
}

extern "C" void js_execution_context_push(JSVM* abi_vm, JSExecutionContext* abi_context)
{
    auto& vm = vm_of(abi_vm);
    auto* context = reinterpret_cast<ExecutionContext*>(abi_context);
    if (vm.execution_context_stack_length == vm.execution_context_stack_capacity) {
        vm.execution_context_stack_capacity *= 2;
        vm.execution_context_stack_entries = static_cast<StackEntry*>(realloc(vm.execution_context_stack_entries, vm.execution_context_stack_capacity * sizeof(StackEntry)));
        VERIFY(vm.execution_context_stack_entries);
    }
    context->caller_frame = nullptr;
    context->caller_return_pc = 0;
    context->caller_dst_raw = 0;
    context->caller_is_construct = false;
    auto& entry = vm.execution_context_stack_entries[vm.execution_context_stack_length++];
    entry.execution_context = context;
    entry.previous_running_execution_context = vm.running_execution_context;
    vm.running_execution_context = context;
}

void pop_execution_context(VM& vm)
{
    VERIFY(vm.execution_context_stack_length > 0);
    auto& entry = vm.execution_context_stack_entries[--vm.execution_context_stack_length];
    vm.running_execution_context = entry.previous_running_execution_context;
}

extern "C" void js_execution_context_save_stack(JSVM* abi_vm)
{
    auto& vm = vm_of(abi_vm);
    Vector<StackEntry> saved;
    for (u32 i = 0; i < vm.execution_context_stack_length; ++i)
        saved.append(vm.execution_context_stack_entries[i]);
    vm.saved_stacks->append(move(saved));
}

extern "C" void js_execution_context_clear_stack(JSVM* abi_vm)
{
    auto& vm = vm_of(abi_vm);
    vm.execution_context_stack_length = 0;
    vm.running_execution_context = nullptr;
}

extern "C" void js_execution_context_restore_stack(JSVM* abi_vm)
{
    auto& vm = vm_of(abi_vm);
    VERIFY(!vm.saved_stacks->is_empty());
    auto saved = vm.saved_stacks->take_last();
    vm.execution_context_stack_length = 0;
    vm.running_execution_context = nullptr;
    for (auto& entry : saved)
        js_execution_context_push(abi_vm, reinterpret_cast<JSExecutionContext*>(entry.execution_context));
}

extern "C" JSOwnedUtf16String js_execution_context_function_name(JSExecutionContext const* abi_context)
{
    auto const* context = reinterpret_cast<ExecutionContext const*>(abi_context);
    if (context->function && context->function->name_raw)
        return Utf16String { Utf16FlyString::from_raw(context->function->name_raw) }.into_raw();
    return Utf16String {}.into_raw();
}

extern "C" JSSourceCode const* js_source_code_of_execution_context(JSExecutionContext const*)
{
    return nullptr;
}

// --- Symbols -------------------------------------------------------------------------------------------

extern "C" JSSymbol* js_symbol_well_known(JSVM* vm, JSWellKnownSymbol symbol)
{
    VERIFY(symbol < 16);
    return reinterpret_cast<JSSymbol*>(vm_of(vm).well_known_symbols[symbol]);
}

extern "C" JSOwnedUtf16String js_symbol_descriptive_string(JSSymbol* abi_symbol)
{
    auto* symbol = reinterpret_cast<Symbol*>(abi_symbol);
    StringBuilder builder;
    builder.append("Symbol("sv);
    if (symbol->description_raw) {
        auto description = Utf16String::from_raw(symbol->description_raw);
        builder.append(description.utf16_view());
    }
    builder.append(")"sv);
    return Utf16String::from_utf8(builder.string_view()).into_raw();
}

// --- Unimplemented ABI functions ------------------------------------------------------------------------

[[noreturn]] void unimplemented(char const* name)
{
    dbgln("ganglion: unimplemented LibJS ABI function {}", name);
    __builtin_trap();
}

}

extern "C" [[noreturn]] void ganglion_js_unimplemented(char const* name)
{
    Ganglion::unimplemented(name);
}

// --- The debugger: there is none. LibWeb asks whether one is attached (VM::debugger(), from report_exception after an
// uncaught exception in a requestAnimationFrame callback, among others); the answer is no, and the notifications it would
// get are dropped. Until these were stubs that trapped, so a throwing rAF callback stopped the engine.
extern "C" bool js_debugger_is_enabled(JSVM*)
{
    return false;
}

extern "C" bool js_debugger_is_paused(JSVM*)
{
    return false;
}

extern "C" void js_debugger_did_finish_exception_propagation(JSVM*, JSValue)
{
}
