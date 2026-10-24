// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Ganglion's runtime behind LibJS's embedding ABI (docs/phase1.md, "The js_* runtime").
//
// Ladybird's LibJS C++ is a facade over a runtime that implements the js_* functions of
// LibJS/Embedding/ABI.h and lays its cells out as LibJS/Embedding/Layout.h says. Upstream that runtime is
// Rust; here it is this small C++ object model, enough for LibWeb to create its realms, global objects,
// platform objects, promises and errors, and nothing that compiles or runs JavaScript (page JS runs on the
// host's V8 in phase 2, through handles that these same cells will carry).
//
// Every cell is allocated from LibGC's heap through LibGC/CAPI.h, with the header of a GC::ForeignCell:
// the first word is ours (the Class), then LibGC's mark, state and kind bytes.

#pragma once

#include <AK/HashMap.h>
#include <AK/Utf16FlyString.h>
#include <AK/Utf16String.h>
#include <AK/Vector.h>
#include <LibGC/CAPI.h>
#include <LibJS/Embedding/ABI.h>
#include <LibJS/Embedding/Layout.h>

namespace Ganglion {

struct Cell;
struct Class;
struct Object;
struct Shape;
struct Realm;
struct Environment;
struct PrimitiveString;
struct Symbol;
struct FunctionObject;
struct ExecutionContext;
struct VM;

// --- Values: the NaN-boxing of LibGC/NanBoxedValue.h and LibJS/Runtime/Value.h -----------------------

constexpr u64 TAG_SHIFT = 48;
constexpr u64 BASE_TAG = 0x7FF8;
constexpr u64 IS_CELL_BIT = 0x8000 | BASE_TAG;
constexpr u64 IS_CELL_PATTERN = 0xFFF8;
constexpr u64 OBJECT_TAG = 0b001 | IS_CELL_BIT;
constexpr u64 STRING_TAG = 0b010 | IS_CELL_BIT;
constexpr u64 SYMBOL_TAG = 0b011 | IS_CELL_BIT;
constexpr u64 ACCESSOR_TAG = 0b100 | IS_CELL_BIT;
constexpr u64 BIGINT_TAG = 0b101 | IS_CELL_BIT;
constexpr u64 UNDEFINED_TAG = 0b110 | BASE_TAG;
constexpr u64 NULL_TAG = 0b111 | BASE_TAG;
constexpr u64 BOOLEAN_TAG = 0b001 | BASE_TAG;
constexpr u64 INT32_TAG = 0b010 | BASE_TAG;
constexpr u64 EMPTY_TAG = 0b011 | BASE_TAG;
constexpr u64 PAYLOAD_MASK = (u64(1) << TAG_SHIFT) - 1;
constexpr u64 CANON_NAN_BITS = 0x7FF8000000000000ULL;

struct Value {
    u64 bits { UNDEFINED_TAG << TAG_SHIFT };

    constexpr Value() = default;
    constexpr explicit Value(u64 raw)
        : bits(raw)
    {
    }
    static constexpr Value undefined() { return Value { UNDEFINED_TAG << TAG_SHIFT }; }
    static constexpr Value null() { return Value { NULL_TAG << TAG_SHIFT }; }
    static constexpr Value empty() { return Value { EMPTY_TAG << TAG_SHIFT }; }
    static constexpr Value boolean(bool b) { return Value { (BOOLEAN_TAG << TAG_SHIFT) | (b ? 1 : 0) }; }
    static constexpr Value from_i32(i32 i) { return Value { (INT32_TAG << TAG_SHIFT) | (u64(static_cast<u32>(i))) }; }
    static Value from_double(double d);
    static Value from_cell(void const* cell, u64 tag) { return Value { (tag << TAG_SHIFT) | (reinterpret_cast<uintptr_t>(cell) & PAYLOAD_MASK) }; }
    static Value from_object(Object const* o) { return from_cell(o, OBJECT_TAG); }
    static Value from_string(PrimitiveString const* s) { return from_cell(s, STRING_TAG); }
    static Value from_symbol(Symbol const* s) { return from_cell(s, SYMBOL_TAG); }

    constexpr u16 tag() const { return static_cast<u16>(bits >> TAG_SHIFT); }
    constexpr bool is_cell() const { return (tag() & IS_CELL_PATTERN) == IS_CELL_PATTERN; }
    constexpr bool is_undefined() const { return bits == (UNDEFINED_TAG << TAG_SHIFT); }
    constexpr bool is_null() const { return bits == (NULL_TAG << TAG_SHIFT); }
    constexpr bool is_nullish() const { return is_undefined() || is_null(); }
    constexpr bool is_empty() const { return bits == (EMPTY_TAG << TAG_SHIFT); }
    constexpr bool is_boolean() const { return tag() == BOOLEAN_TAG; }
    constexpr bool is_int32() const { return tag() == INT32_TAG; }
    constexpr bool is_double() const { return !is_special() && !is_int32(); }
    constexpr bool is_number() const { return is_int32() || is_double(); }
    constexpr bool is_object() const { return tag() == OBJECT_TAG; }
    constexpr bool is_string() const { return tag() == STRING_TAG; }
    constexpr bool is_symbol() const { return tag() == SYMBOL_TAG; }
    constexpr bool is_bigint() const { return tag() == BIGINT_TAG; }
    constexpr bool is_accessor() const { return tag() == ACCESSOR_TAG; }
    // Any tagged value: a quiet NaN whose low three tag bits are not 000 (the canonical NaN and its negative
    // have 000 there, and so do infinities, which have a zero mantissa).
    constexpr bool is_special() const { return (tag() & 0x7FF8) == 0x7FF8 && (tag() & 7) != 0; }
    bool as_bool() const { return (bits & 1) != 0; }
    i32 as_i32() const { return static_cast<i32>(static_cast<u32>(bits & 0xFFFFFFFF)); }
    double as_double() const;
    template<typename T>
    T* as_cell() const { return reinterpret_cast<T*>(static_cast<uintptr_t>(bits & PAYLOAD_MASK)); }
    Object* as_object() const { return as_cell<Object>(); }
    PrimitiveString* as_string() const { return as_cell<PrimitiveString>(); }
    Symbol* as_symbol() const { return as_cell<Symbol>(); }
    bool operator==(Value const& other) const { return bits == other.bits; }
};
static_assert(sizeof(Value) == 8);

// --- Property keys: the bits of JS::PropertyKey (LibJS/Runtime/PropertyKey.h) -----------------------------

struct Key {
    uintptr_t bits { 0 };
    bool is_string() const { return (bits & 3) <= 1; }
    bool is_symbol() const { return (bits & 3) == 2; }
    bool is_number() const { return (bits & 3) == 3; }
    u32 as_number() const { return static_cast<u32>(bits >> 2); }
    Symbol* as_symbol() const { return reinterpret_cast<Symbol*>(bits & ~uintptr_t(3)); }
    // A fly string that borrows the key's reference (the caller must not keep it past the key's life).
    Utf16FlyString as_fly_string() const { return Utf16FlyString::from_raw(bits); }
    static Key from_fly_string(Utf16FlyString const& s) { return Key { s.raw_identity() }; }
    static Key from_index(u32 index) { return Key { (static_cast<uintptr_t>(index) << 2) | 3 }; }
    static Key from_symbol(Symbol const* s) { return Key { reinterpret_cast<uintptr_t>(s) | 2 }; }
    static Key from_abi(JSPropertyKey const* key) { return Key { key->bits }; }
    bool operator==(Key const& other) const { return bits == other.bits; }
};

// --- Cells ---------------------------------------------------------------------------------------------

// The header LibGC lays out for a GC::ForeignCell on wasm32: our word, then mark, state and kind.
struct Cell {
    Class const* klass;
    u8 mark;
    u8 state;
    u8 kind;
    u8 reserved;
};
static_assert(sizeof(Cell) == 8);
static_assert(__builtin_offsetof(Cell, klass) == JS_LAYOUT_CELL_CLASS_OFFSET);
static_assert(__builtin_offsetof(Cell, mark) == JS_LAYOUT_CELL_MARK_OFFSET);
static_assert(__builtin_offsetof(Cell, state) == JS_LAYOUT_CELL_STATE_OFFSET);
static_assert(__builtin_offsetof(Cell, kind) == JS_LAYOUT_CELL_KIND_OFFSET);

// A class, which the first word of every cell points to: its JS_LAYOUT_CLASS_ID_*, the class it extends,
// and how LibGC visits and finalizes its cells.
struct Class {
    u16 id;
    u16 flags;
    Class const* parent;
    char const* name;
    u32 name_length;
    u32 cell_size;
    u8 cell_kind;
    void (*visit)(Cell*, GCVisitor*);
    void (*finalize)(Cell*);
    mutable GCAllocator* allocator;
};
static_assert(__builtin_offsetof(Class, id) == JS_LAYOUT_CLASS_ID_OFFSET);
static_assert(__builtin_offsetof(Class, parent) == JS_LAYOUT_CLASS_PARENT_OFFSET);

struct Shape : Cell {
    Realm* realm;
    Object* prototype;
};
static_assert(__builtin_offsetof(Shape, realm) == JS_LAYOUT_SHAPE_REALM_OFFSET);
static_assert(__builtin_offsetof(Shape, prototype) == JS_LAYOUT_SHAPE_PROTOTYPE_OFFSET);

enum class PropertyKind : u8 {
    Data,
    Accessor,
    // A property whose value an intrinsic accessor computes on first read (js_object_define_intrinsic_accessor).
    IntrinsicPending,
    Deleted,
};

struct Property {
    Key key;
    Value value; // the value of a data property, the getter of an accessor
    Object* setter { nullptr };
    JSIntrinsicAccessor intrinsic { nullptr };
    u8 attributes { 0 };
    PropertyKind kind { PropertyKind::Data };
};

struct PropertyTable {
    Vector<Property> entries;
    HashMap<uintptr_t, u32> index;
    u32 deleted { 0 };
};

struct Object : Cell {
    u16 flags;
    u16 extra_flags;
    Shape* shape;
    PropertyTable* properties;
    u32 array_length; // JS_LAYOUT_CLASS_ID_ARRAY objects: the "length" they report
};
static_assert(sizeof(Object) == JS_LAYOUT_OBJECT_SIZE);
static_assert(__builtin_offsetof(Object, flags) == JS_LAYOUT_OBJECT_FLAGS_OFFSET);
static_assert(__builtin_offsetof(Object, shape) == JS_LAYOUT_OBJECT_SHAPE_OFFSET);

enum class FunctionKind : u8 {
    Native,       // behaviour(vm)
    Closure,      // closure_call(closure_context, vm)
    DirectGetter, // behaviour(vm), a getter the runtime may have fast-pathed; here a native function
    Host,         // JSHostFunctionHooks of the host class (HostFunction)
    PromiseResolve,
    PromiseReject,
    PromiseConstructor,
    Stub, // a builtin constructor this runtime does not implement: calling it throws
};

struct FunctionObject : Object {
    Realm* realm;
    FunctionKind function_kind;
    u8 is_constructor;
    u8 pad[2];
    JSNativeFunction behaviour;
    JSClosureCall closure_call;
    void* closure_context; // a GC cell of the embedder's heap, which the function keeps alive
    FlatPtr name_raw;      // Utf16FlyString, for call stacks
    i32 length;
    u32 pad2;
    Value slot0; // PromiseResolve/Reject: the promise
    Value slot1;
};
static_assert(sizeof(FunctionObject) == 72);

// Host objects, functions and arrays: the embedder's fields sit at the offsets LibJS/HostObjectABI.h fixes.
struct HostObject : Object {
    u8 pad[JS_HOST_OBJECT_HOST_CLASS_OFFSET - sizeof(Object)];
    JSHostClass const* host_class;
    u32 pad1;
    void* wrappable;
    u32 pad2;
    void* host_data;
    u32 pad3;
};
static_assert(sizeof(HostObject) == JS_HOST_OBJECT_SIZE);
static_assert(__builtin_offsetof(HostObject, host_class) == JS_HOST_OBJECT_HOST_CLASS_OFFSET);
static_assert(__builtin_offsetof(HostObject, wrappable) == JS_HOST_OBJECT_WRAPPABLE_OFFSET);
static_assert(__builtin_offsetof(HostObject, host_data) == JS_HOST_OBJECT_HOST_DATA_OFFSET);

struct HostFunction : FunctionObject {
    JSHostClass const* host_class;
    u32 pad1;
    void* wrappable;
    u32 pad2;
    void* host_data;
    u32 pad3;
};
static_assert(sizeof(HostFunction) == JS_HOST_OBJECT_SIZE);
static_assert(__builtin_offsetof(HostFunction, host_class) == JS_HOST_OBJECT_HOST_CLASS_OFFSET);
static_assert(__builtin_offsetof(HostFunction, host_data) == JS_HOST_OBJECT_HOST_DATA_OFFSET);

struct ErrorData {
    u8 error_kind;
    u8 pad[3];
    u32 traceback_length; // always 0: this runtime runs no JavaScript, so there are no frames to record
};

struct ErrorObject : Object {
    ErrorData error_data;
};

struct ErrorDataCell : Cell {
    ErrorData error_data;
};

struct PromiseReaction {
    void* capability; // PromiseCapability* or null
    Value handler;    // a callable, or empty
    u8 type;          // 0 fulfill, 1 reject
};

struct Promise : Object {
    u8 state; // JS_PROMISE_STATE_*
    bool is_handled;
    bool already_resolved;
    u8 pad[5];
    Value result;
    Vector<PromiseReaction>* fulfill_reactions;
    Vector<PromiseReaction>* reject_reactions;
};

struct PromiseCapability : Cell {
    Object* promise;
    Object* resolve;
    Object* reject;
};

struct PromiseJob : Cell {
    u8 job_kind; // 0 reaction job, 1 resolve-thenable job
    u8 reaction_type;
    u8 pad[6];
    Value argument;
    Value handler;
    PromiseCapability* capability;
    Object* promise;  // thenable job
    Object* thenable; // thenable job
    Object* then;     // thenable job
};

struct JobCallback : Cell {
    Object* callback;
    void* custom_data; // a GC cell, or null
};

struct Binding {
    Value value;
    bool is_mutable { true };
    bool initialized { false };
    bool strict { false };
};

struct Environment : Cell {
    u8 env_kind; // JS_ENVIRONMENT_KIND_*
    u8 pad[3];
    Environment* outer;
    Object* binding_object; // object environment: the object; global environment: the this value
    Environment* declarative_record; // global environment
    Environment* object_record;      // global environment
    FunctionObject* function;        // function environment
    HashMap<FlatPtr, Binding>* bindings; // declarative, keyed by the fly string's raw identity
    bool is_with_environment;
};

struct PrimitiveString : Cell {
    FlatPtr string_raw; // Utf16String
};

struct Symbol : Cell {
    FlatPtr description_raw; // Utf16String, or 0 for no description
    bool is_global;
};

struct MapObject : Object {
    Vector<Value>* entries; // key, value pairs for a Map; values for a Set
};

struct PrimitiveWrapper : Object {
    Value primitive;
};

struct DateObject : Object {
    double date_value;
};

struct Console : Cell {
    Realm* realm;
    void* client; // ConsoleClient*
};

struct ConsoleClient : Cell {
    Console* console;
    JSConsoleClientMethods const* methods;
    void* context;
};

struct ConsoleObject : Object {
    Console* console;
};

struct TypedArray : Object {
    Object* viewed_array_buffer;
    u8 array_kind;
    u8 element_size;
    u8 pad[2];
    u32 array_length_value;
    u8 array_length_kind; // JS_BYTE_LENGTH_*
    u8 pad2[3];
    u32 byte_offset;
    u32 byte_length_value;
    u8 byte_length_kind; // JS_BYTE_LENGTH_*
};

// ArrayBuffer and SharedArrayBuffer (one class, LibJS tells them apart by js_array_buffer_is_shared_array_buffer).
struct ArrayBufferObject : Object {
    GCPrimitiveStorageHandle handle; // owned or external storage; null for none
    u8 storage_kind;                 // JS_ARRAY_BUFFER_STORAGE_*
    bool shared;
    bool has_max_byte_length;
    bool external_has_fixed_byte_length;
    size_t max_byte_length;
    size_t external_fixed_byte_length;
    void* external_owner; // a GC cell
    Value detach_key;
};
static_assert(__builtin_offsetof(TypedArray, array_kind) == JS_LAYOUT_TYPED_ARRAY_KIND_OFFSET);
static_assert(__builtin_offsetof(TypedArray, element_size) == JS_LAYOUT_TYPED_ARRAY_ELEMENT_SIZE_OFFSET);
static_assert(__builtin_offsetof(TypedArray, array_length_value) == JS_LAYOUT_TYPED_ARRAY_ARRAY_LENGTH_OFFSET);
static_assert(__builtin_offsetof(TypedArray, array_length_kind) == JS_LAYOUT_TYPED_ARRAY_ARRAY_LENGTH_ALTERNATIVE_INDEX_OFFSET);
static_assert(__builtin_offsetof(TypedArray, byte_offset) == JS_LAYOUT_TYPED_ARRAY_BYTE_OFFSET_OFFSET);

struct Intrinsics {
    Object* slots[JS_INTRINSIC_COUNT];
    Object* error_prototypes[10]; // by JSErrorKind
    Object* promise_prototype;
    Object* array_buffer_prototype;
    Object* shared_array_buffer_prototype;
    Object* typed_array_base_prototype;
    Object* typed_array_prototypes[12]; // by JS_LAYOUT_TYPED_ARRAY_KIND_*
};

struct Realm : Cell {
    Object* global_object;
    Environment* global_environment;
    Intrinsics* intrinsics;
    void* host_defined;
};
static_assert(__builtin_offsetof(Realm, global_object) == JS_LAYOUT_REALM_GLOBAL_OBJECT_OFFSET);
static_assert(__builtin_offsetof(Realm, global_environment) == JS_LAYOUT_REALM_GLOBAL_ENVIRONMENT_OFFSET);
static_assert(__builtin_offsetof(Realm, intrinsics) == JS_LAYOUT_REALM_INTRINSICS_OFFSET);
static_assert(__builtin_offsetof(Realm, host_defined) == JS_LAYOUT_REALM_HOST_DEFINED_OFFSET);

// --- Execution contexts: JS::ExecutionContext, field for field -------------------------------------------

struct ScriptOrModule {
    u8 tag;
    u8 pad[3];
    void* cell;
};

struct ExecutionContext {
    FunctionObject* function;
    Realm* realm;
    ScriptOrModule script_or_module;
    Environment* lexical_environment;
    Environment* variable_environment;
    void* private_environment;
    u64 frame_id;
    u32 program_counter;
    u32 skip_when_determining_incumbent_counter;
    u32 yield_continuation;
    bool yield_is_await;
    bool yield_value_is_iterator_result;
    bool caller_is_construct;
    bool frame_initialized;
    Value this_value; // Optional<Value>: the empty value when absent
    void* executable;
    ExecutionContext* caller_frame;
    u32 passed_argument_count;
    u32 caller_return_pc;
    u32 caller_dst_raw;
    u32 registers_and_constants_and_locals_and_arguments_count;
    u32 argument_count;
    bool returns_to_native_caller;
    bool runs_jit_code;

    Value* slots() { return reinterpret_cast<Value*>(reinterpret_cast<u8*>(this) + sizeof(ExecutionContext)); }
    Value* arguments() { return slots() + (registers_and_constants_and_locals_and_arguments_count - argument_count); }
    Value argument(size_t i) { return i < argument_count ? arguments()[i] : Value::undefined(); }
};
static_assert(sizeof(ExecutionContext) == JS_LAYOUT_EXECUTION_CONTEXT_SIZE);
static_assert(alignof(ExecutionContext) == JS_LAYOUT_EXECUTION_CONTEXT_ALIGN);
static_assert(__builtin_offsetof(ExecutionContext, realm) == JS_LAYOUT_EXECUTION_CONTEXT_REALM_OFFSET);
static_assert(__builtin_offsetof(ExecutionContext, script_or_module) == JS_LAYOUT_EXECUTION_CONTEXT_SCRIPT_OR_MODULE_OFFSET);
static_assert(__builtin_offsetof(ExecutionContext, this_value) == JS_LAYOUT_EXECUTION_CONTEXT_THIS_VALUE_OFFSET);
static_assert(__builtin_offsetof(ExecutionContext, executable) == JS_LAYOUT_EXECUTION_CONTEXT_EXECUTABLE_OFFSET);
static_assert(__builtin_offsetof(ExecutionContext, argument_count) == JS_LAYOUT_EXECUTION_CONTEXT_ARGUMENT_COUNT_OFFSET);
static_assert(__builtin_offsetof(ExecutionContext, runs_jit_code) == JS_LAYOUT_EXECUTION_CONTEXT_RUNS_JIT_CODE_OFFSET);

struct StackEntry {
    ExecutionContext* execution_context;
    ExecutionContext* previous_running_execution_context;
};
static_assert(sizeof(StackEntry) == JS_LAYOUT_EXECUTION_CONTEXT_STACK_ENTRY_SIZE);

// --- The VM, at the start of JS::VM's engine storage ----------------------------------------------------

struct CommonKeys {
    Key length, name, message, constructor, prototype, then, cause, value, done, next, to_string, value_of, stack, errors;
    Vector<Utf16FlyString> owned; // keeps the fly strings alive
};

struct alignas(16) VM {
    // The head, as Layout.h describes it (the facade reads and writes these fields inline).
    ExecutionContext* running_execution_context;
    void* interpreter_stack_top;
    void* interpreter_stack_limit;
    u32 execution_generation;
    void* primitive_storage_cage_base;
    StackEntry* execution_context_stack_entries;
    u32 execution_context_stack_length;
    u32 execution_context_stack_capacity;
    Realm* type_error_realm_override;
    u32 type_error_realm_override_depth;

    // Ganglion's own state
    GCHeap* heap;
    JSVmHostHooks const* hooks;
    void* hooks_data;
    JSAgent agent;
    bool has_agent;
    Symbol* well_known_symbols[16];
    PrimitiveString* empty_string;
    Vector<Realm*>* realms;
    Vector<PromiseJob*>* own_job_queue;
    Vector<Vector<StackEntry>>* saved_stacks;
    CommonKeys* keys;
    u32 unimplemented_property_accesses;
};
static_assert(sizeof(VM) <= JS_LAYOUT_VM_SIZE);
static_assert(alignof(VM) <= JS_LAYOUT_VM_ALIGN);
static_assert(__builtin_offsetof(VM, running_execution_context) == JS_LAYOUT_VM_RUNNING_EXECUTION_CONTEXT_OFFSET);
static_assert(__builtin_offsetof(VM, interpreter_stack_top) == JS_LAYOUT_VM_INTERPRETER_STACK_TOP_OFFSET);
static_assert(__builtin_offsetof(VM, execution_context_stack_entries) == JS_LAYOUT_VM_EXECUTION_CONTEXT_STACK_ENTRIES_OFFSET);
static_assert(__builtin_offsetof(VM, execution_context_stack_length) == JS_LAYOUT_VM_EXECUTION_CONTEXT_STACK_LENGTH_OFFSET);
static_assert(__builtin_offsetof(VM, execution_context_stack_capacity) == JS_LAYOUT_VM_EXECUTION_CONTEXT_STACK_CAPACITY_OFFSET);
static_assert(__builtin_offsetof(VM, type_error_realm_override) == JS_LAYOUT_VM_TYPE_ERROR_REALM_OVERRIDE_OFFSET);
static_assert(__builtin_offsetof(VM, type_error_realm_override_depth) == JS_LAYOUT_VM_TYPE_ERROR_REALM_OVERRIDE_DEPTH_OFFSET);

// --- Classes (Classes.cpp) ------------------------------------------------------------------------------

extern Class const class_object;
extern Class const class_array_buffer;
extern Class const class_typed_array[12]; // by JS_LAYOUT_TYPED_ARRAY_KIND_*
extern Class const class_shape;
extern Class const class_realm;
extern Class const class_string;
extern Class const class_symbol;
extern Class const class_function; // NativeFunction and closures
extern Class const class_host_object;
extern Class const class_host_function;
extern Class const class_host_array;
extern Class const class_array;
extern Class const class_error;
extern Class const class_native_error[10]; // by JSErrorKind; [0] is class_error itself
extern Class const class_error_data_cell;
extern Class const class_promise;
extern Class const class_promise_capability;
extern Class const class_promise_job;
extern Class const class_job_callback;
extern Class const class_environment[5]; // by JS_ENVIRONMENT_KIND_*
extern Class const class_map;
extern Class const class_set;
extern Class const class_boolean_object;
extern Class const class_number_object;
extern Class const class_string_object;
extern Class const class_date;
extern Class const class_console;
extern Class const class_console_client;
extern Class const class_console_object;
extern Class const class_global_object;
extern Class const class_promise_constructor;
extern Class const class_script;
extern Class const class_dynamic_function;
extern Class const class_module;

// A script record: the source and filename a ParseScript was asked for, run by the host's JavaScript
// engine through the hooks below (docs/phase2.md section 2.3). Nothing is parsed here.
struct ScriptObject : Cell {
    FlatPtr source_raw;   // Utf16String
    FlatPtr filename_raw; // Utf16String
    void* host_defined;   // a LibWeb cell the script keeps alive
    Realm* realm;         // the realm the script was parsed for (its execution context's realm)
    u32 line_number_offset;
    void const* source_code; // the JSSourceCode handed out by js_compile_top_level_source_code_of_script, or null
};

// A function the engine was asked to create from source text (CreateDynamicFunction's front half: LibWeb compiles an
// event handler content attribute this way). Nothing is compiled here: js_function_compile_dynamic checks the text with
// the host's engine and keeps it, js_function_instantiate_dynamic has the host's engine compile it with its scope.
struct DynamicFunction : Cell {
    FlatPtr source_raw;     // Utf16String: the whole function's source text, which toString shows
    FlatPtr parameters_raw; // Utf16String
    FlatPtr body_raw;       // Utf16String
    u8 kind;                // JS_FUNCTION_KIND_*
};

// The host's JavaScript engine, when there is one (engine/platform/Bridge.cpp sets these): runs a
// script, parses and stringifies JSON. Null means "no engine": scripts fail with the phase-1 error.
extern JSCompletion (*g_run_script)(VM&, ScriptObject&);
// Evaluates a module record (a ScriptObject of class_module): a normal completion whose value is the host's promise
// for the module graph (the host's engine loads the imports itself: the record has no requested modules).
extern JSCompletion (*g_run_module)(VM&, ScriptObject&);
// Checks a dynamic function's parameters and body (the host's parser): true, or false with the message of the first
// syntax error in `error`.
extern bool (*g_dynamic_function_check)(VM&, Utf16View parameters, Utf16View body, u8 kind, JSOwnedUtf16String* error);
// The function for a checked one: its scope is the chain of `scope` (object environments are with-scopes, the global
// environment ends the chain).
extern Object* (*g_dynamic_function_instantiate)(VM&, Realm&, DynamicFunction&, Environment* scope);
extern JSCompletion (*g_json_parse)(VM&, Utf16View);
// Property hooks a host function class carries in its `user_data` (set by the bridge for its foreign functions).
extern JSHostObjectHooks const* g_function_property_hooks;
extern JSCompletion (*g_json_stringify)(VM&, Value value, Value replacer, Value space, JSOwnedUtf16String* out);

// --- Helpers shared by the implementation files ---------------------------------------------------------

inline VM& vm_of(JSVM* vm) { return *reinterpret_cast<VM*>(vm); }
inline JSVM* vm_abi(VM& vm) { return reinterpret_cast<JSVM*>(&vm); }
template<typename T>
T* cell_from_abi(void* p) { return static_cast<T*>(p); }
inline JSObject* object_abi(Object* o) { return reinterpret_cast<JSObject*>(o); }
inline Object* object_of(JSObject* o) { return reinterpret_cast<Object*>(o); }
inline Realm* realm_of(JSRealm* r) { return reinterpret_cast<Realm*>(r); }
inline JSRealm* realm_abi(Realm* r) { return reinterpret_cast<JSRealm*>(r); }

// Allocation: zeroed storage with the cell header written (Heap.cpp).
Cell* allocate_cell(VM&, Class const&);
template<typename T>
T* allocate(VM& vm, Class const& klass) { return static_cast<T*>(allocate_cell(vm, klass)); }
void visit_cell(GCVisitor*, void const* cell);
// What every Object's visit and finalize do (shape, properties), for classes defined outside Heap.cpp.
void visit_object_edges(Cell*, GCVisitor*);
void finalize_object_fields(Cell*);
void visit_value(GCVisitor*, Value);
void visit_values(GCVisitor*, Value const*, size_t);

// Strings
Utf16View view_of(JSUtf16View);
JSUtf16View abi_view(Utf16View);
PrimitiveString* create_string(VM&, Utf16String);
PrimitiveString* create_string(VM&, Utf16View);
Utf16View string_view(PrimitiveString const*);
Utf16String string_of(PrimitiveString const*);
Utf16String number_to_string(double);
PrimitiveString* key_to_string(VM&, Key);
Value key_to_value(VM&, Key);

// Objects and properties (Object.cpp)
Object* create_object(VM&, Realm&, Object* prototype, Class const& = class_object);
// An ordinary object with a Symbol.toStringTag of `name`: the prototypes of built-ins nothing calls.
Object* named_prototype(VM&, Realm&, Object* parent, StringView name);
// %Uint8Array% and its siblings (ArrayBuffer.cpp): constructors over an existing buffer, which LibWeb's streams use.
Object* typed_array_constructor(VM&, Realm&, u8 kind);
// A new ArrayBuffer holding a copy of `length` bytes, or null when its storage cannot be allocated (ArrayBuffer.cpp).
Object* try_create_array_buffer_from_bytes(VM&, Realm&, u8 const* bytes, size_t length);
Shape* create_shape(VM&, Realm&, Object* prototype);
Realm& realm_of_object(Object const&);
Object* prototype_of(Object const&);
void set_prototype(Object&, Object*);
Property* find_own_property(Object&, Key);
void define_direct_property(VM&, Object&, Key, Value, u8 attributes);
void define_direct_accessor(VM&, Object&, Key, Object* getter, Object* setter, u8 attributes);
JSCompletion internal_get(VM&, Object&, Key, Value receiver, u8 phase);
JSCompletion internal_set(VM&, Object&, Key, Value, Value receiver, u8 phase);
JSCompletion internal_get_own_property(VM&, Object&, Key, JSPropertyDescriptor& out);
JSCompletion internal_define_own_property(VM&, Object&, Key, JSPropertyDescriptor&, JSPropertyDescriptor const* precomputed);
JSCompletion internal_delete(VM&, Object&, Key);
JSCompletion internal_has_property(VM&, Object&, Key);
JSCompletion internal_get_prototype_of(VM&, Object&);
JSCompletion internal_set_prototype_of(VM&, Object&, Object*);
JSCompletion internal_own_property_keys(VM&, Object&, JSValueSink*);
JSCompletion ordinary_get_own_property(VM&, Object&, Key, JSPropertyDescriptor& out);
JSCompletion ordinary_define_own_property(VM&, Object&, Key, JSPropertyDescriptor&, JSPropertyDescriptor const* precomputed);
JSCompletion ordinary_get(VM&, Object&, Key, Value receiver, u8 phase);
JSCompletion ordinary_set(VM&, Object&, Key, Value, Value receiver, u8 phase);
JSCompletion ordinary_delete(VM&, Object&, Key);
JSCompletion ordinary_own_property_keys(VM&, Object&, JSValueSink*);
JSHostClass const* host_class_of(Object const&);
void const* host_hooks_of(Object const&); // the class's hook table for its kind, or null
bool is_callable(Value);
bool is_constructor(Value);
bool is_function_object(Object const&);
StringView class_name_of(Object const&);

// Functions (Function.cpp)
FunctionObject* create_native_function(VM&, Realm*, FunctionKind, JSNativeFunction, JSClosureCall, void* context, i32 length, Utf16FlyString const& name, StringView prefix, bool with_own_properties);
JSCompletion call(VM&, Value function, Value this_value, Value const* arguments, size_t count);
void pop_execution_context(VM&);
JSCompletion construct(VM&, Object& function, Value const* arguments, size_t count, Object* new_target);
JSCompletion call_method(VM&, Value receiver, Key, Value const* arguments, size_t count);

// Realms (Realm.cpp)
Realm* current_realm(VM&);
Object* intrinsic(VM&, Realm&, JSIntrinsic);
void install_iterator_iteration(VM&, Realm&, Object& iterator_prototype); // @@iterator of %Iterator.prototype% (Misc.cpp)
void install_array_iteration(VM&, Realm&, Object& array_prototype); // @@iterator of the engine's arrays (Misc.cpp)
Object* error_prototype_for(VM&, Realm&, u8 kind);
Object* promise_prototype(VM&, Realm&);
Environment* create_environment(VM&, u8 kind, Environment* outer);

// Errors and completions (Error.cpp)
inline JSCompletion normal(u64 payload = 0) { return JSCompletion { payload, JS_COMPLETION_NORMAL }; }
inline JSCompletion normal(Value value) { return JSCompletion { value.bits, JS_COMPLETION_NORMAL }; }
inline JSCompletion normal(bool b) { return JSCompletion { b ? 1u : 0u, JS_COMPLETION_NORMAL }; }
inline JSCompletion normal_cell(void const* cell) { return JSCompletion { reinterpret_cast<uintptr_t>(cell), JS_COMPLETION_NORMAL }; }
inline JSCompletion throw_value(Value value) { return JSCompletion { value.bits, JS_COMPLETION_THROW }; }
inline bool is_throw(JSCompletion const& c) { return c.variant == JS_COMPLETION_THROW; }
inline Value value_of(JSCompletion const& c) { return Value { c.payload }; }
Object* create_error(VM&, Realm&, u8 kind, Utf16View message);
JSCompletion throw_error(VM&, u8 kind, StringView message);
JSCompletion throw_error(VM&, u8 kind, Utf16View message);
JSCompletion throw_type_error(VM&, StringView message);
JSCompletion throw_range_error(VM&, StringView message);
ErrorData* error_data_of(Object&);

// Values (Value.cpp)
JSCompletion to_primitive(VM&, Value, int hint /* 0 default, 1 string, 2 number */);
JSCompletion to_string(VM&, Value, Utf16String& out);
JSCompletion to_number(VM&, Value, double& out);
JSCompletion to_object(VM&, Value);
bool to_boolean(Value);
Utf16String to_string_without_side_effects(VM&, Value);
bool same_value(Value, Value);
bool same_value_zero(Value, Value);
bool strict_equals(Value, Value);

// Promises (Promise.cpp)
Promise* create_promise(VM&, Realm&);
void enqueue_promise_job(VM&, PromiseJob*, Realm*);
JSCompletion run_promise_job(VM&, PromiseJob&);
void create_resolving_functions(VM&, Promise&, Object*& resolve, Object*& reject);
Value perform_then(VM&, Promise&, Value on_fulfilled, Value on_rejected, PromiseCapability*);
JSCompletion new_promise_capability(VM&, Value constructor);
JSCompletion promise_constructor_behaviour(JSVM*);
JSCompletion promise_resolving_function_behaviour(VM&, FunctionObject&);
extern VM* g_vm;

// Unimplemented ABI functions trap here with their name (Stubs.gen.cpp and Runtime.cpp).
[[noreturn]] void unimplemented(char const* name);

// Everything the VM holds that is not reachable from a cell: the heap visits it as roots.
void gather_roots(void* context, GCVisitor*);

}
