// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Arrays, iterator records, Map and Set, the console, Date, source code, and the parts of the ABI that
// this runtime answers without implementing: scripts and modules (nothing compiles or runs JavaScript
// here), JSON and RegExp.

#include <AK/Format.h>
#include <AK/StringBuilder.h>
#include <Ganglion/Runtime.h>
#include <math.h>
#include <stdlib.h>

namespace Ganglion {

// --- Arrays --------------------------------------------------------------------------------------------

static Object* create_array(VM& vm, Realm& realm, Object* prototype)
{
    auto* array = create_object(vm, realm, prototype ? prototype : intrinsic(vm, realm, JS_INTRINSIC_ARRAY_PROTOTYPE), class_array);
    array->flags |= JS_LAYOUT_OBJECT_FLAG_HAS_MAGICAL_LENGTH_PROPERTY;
    return array;
}

extern "C" JSCompletion js_array_create(JSVM* abi_vm, JSRealm* realm, uint64_t length, JSObject* prototype)
{
    auto& vm = vm_of(abi_vm);
    if (length > 0xFFFFFFFFull)
        return throw_range_error(vm, "Invalid array length"sv);
    auto* array = create_array(vm, *realm_of(realm), object_of(prototype));
    array->array_length = static_cast<u32>(length);
    return normal_cell(array);
}

extern "C" JSObject* js_array_create_from(JSVM* abi_vm, JSRealm* realm, JSValue const* elements, size_t count)
{
    auto& vm = vm_of(abi_vm);
    auto* array = create_array(vm, *realm_of(realm), nullptr);
    for (size_t i = 0; i < count; ++i)
        define_direct_property(vm, *array, Key::from_index(i), Value { elements[i] }, JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_ENUMERABLE | JS_ATTRIBUTE_CONFIGURABLE);
    array->array_length = count;
    return object_abi(array);
}

extern "C" JSCompletion js_array_length_of_array_like(JSVM* abi_vm, JSObject* object, uint64_t* length)
{
    auto& vm = vm_of(abi_vm);
    auto value = internal_get(vm, *object_of(object), vm.keys->length, Value::from_object(object_of(object)), JS_PROPERTY_LOOKUP_PHASE_OWN_PROPERTY);
    if (is_throw(value))
        return value;
    return js_value_to_length(abi_vm, value.payload, length);
}

extern "C" uint32_t js_array_indexed_array_like_size(JSObject* object)
{
    return object_of(object)->array_length;
}

extern "C" void js_array_indexed_append(JSObject* abi_object, JSValue value)
{
    auto& object = *object_of(abi_object);
    define_direct_property(*g_vm, object, Key::from_index(object.array_length), Value { value }, JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_ENUMERABLE | JS_ATTRIBUTE_CONFIGURABLE);
    ++object.array_length;
}

extern "C" JSValue js_array_indexed_take_first(JSObject* abi_object)
{
    auto& object = *object_of(abi_object);
    auto* first = find_own_property(object, Key::from_index(0));
    Value value = first && first->kind == PropertyKind::Data ? first->value : Value::undefined();
    // Shift every index down by one.
    for (u32 i = 1; i < object.array_length; ++i) {
        auto* property = find_own_property(object, Key::from_index(i));
        Value moved = property && property->kind == PropertyKind::Data ? property->value : Value::undefined();
        define_direct_property(*g_vm, object, Key::from_index(i - 1), moved, JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_ENUMERABLE | JS_ATTRIBUTE_CONFIGURABLE);
    }
    if (object.array_length > 0) {
        auto last = Key::from_index(object.array_length - 1);
        js_object_storage_delete(vm_abi(*g_vm), abi_object, reinterpret_cast<JSPropertyKey const*>(&last.bits));
        --object.array_length;
    }
    return value.bits;
}

// --- Iterator records ----------------------------------------------------------------------------------

extern "C" JSObject* js_iterator_create_result_object(JSVM* abi_vm, JSRealm* realm, JSValue value, bool done)
{
    auto& vm = vm_of(abi_vm);
    auto* object = create_object(vm, *realm_of(realm), intrinsic(vm, *realm_of(realm), JS_INTRINSIC_OBJECT_PROTOTYPE));
    define_direct_property(vm, *object, vm.keys->value, Value { value }, JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_ENUMERABLE | JS_ATTRIBUTE_CONFIGURABLE);
    define_direct_property(vm, *object, vm.keys->done, Value::boolean(done), JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_ENUMERABLE | JS_ATTRIBUTE_CONFIGURABLE);
    return object_abi(object);
}

extern "C" JSCompletion js_iterator_complete(JSVM* abi_vm, JSObject* result)
{
    auto& vm = vm_of(abi_vm);
    auto done = internal_get(vm, *object_of(result), vm.keys->done, Value::from_object(object_of(result)), JS_PROPERTY_LOOKUP_PHASE_OWN_PROPERTY);
    if (is_throw(done))
        return done;
    return normal(to_boolean(value_of(done)));
}

extern "C" JSCompletion js_iterator_value(JSVM* abi_vm, JSObject* result)
{
    auto& vm = vm_of(abi_vm);
    return internal_get(vm, *object_of(result), vm.keys->value, Value::from_object(object_of(result)), JS_PROPERTY_LOOKUP_PHASE_OWN_PROPERTY);
}

extern "C" JSCompletion js_iterator_get_fields_from_method(JSVM* abi_vm, JSValue value, JSObject* method, JSIteratorRecordFields* fields)
{
    auto& vm = vm_of(abi_vm);
    auto iterator = call(vm, Value::from_object(object_of(method)), Value { value }, nullptr, 0);
    if (is_throw(iterator))
        return iterator;
    if (!value_of(iterator).is_object())
        return throw_type_error(vm, "Iterator is not an object"sv);
    auto next = internal_get(vm, *value_of(iterator).as_object(), vm.keys->next, value_of(iterator), JS_PROPERTY_LOOKUP_PHASE_OWN_PROPERTY);
    if (is_throw(next))
        return next;
    fields->done = false;
    fields->iterator = object_abi(value_of(iterator).as_object());
    fields->next_method = next.payload;
    return normal();
}

extern "C" JSCompletion js_iterator_get_fields(JSVM* abi_vm, JSValue abi_value, JSIteratorHint hint, JSIteratorRecordFields* fields)
{
    auto& vm = vm_of(abi_vm);
    Value value { abi_value };
    // Symbol.iterator (5) or Symbol.asyncIterator (1)
    auto key = Key::from_symbol(vm.well_known_symbols[hint == 1 ? 1 : 5]);
    auto method = js_function_get_method(abi_vm, abi_value, reinterpret_cast<JSPropertyKey const*>(&key.bits));
    if (is_throw(method))
        return method;
    if (value_of(method).is_undefined())
        return throw_type_error(vm, "Value is not iterable"sv);
    return js_iterator_get_fields_from_method(abi_vm, abi_value, object_abi(value_of(method).as_object()), fields);
}

extern "C" JSCompletion js_iterator_fields_next(JSVM* abi_vm, JSIteratorRecordFields* fields, JSValue const* value)
{
    auto& vm = vm_of(abi_vm);
    auto result = call(vm, Value { fields->next_method }, Value::from_object(object_of(fields->iterator)), reinterpret_cast<Value const*>(value), value ? 1 : 0);
    if (is_throw(result))
        return result;
    if (!value_of(result).is_object())
        return throw_type_error(vm, "Iterator result is not an object"sv);
    return result;
}

extern "C" JSCompletion js_iterator_fields_step_value(JSVM* abi_vm, JSIteratorRecordFields* fields, JSValue* value)
{
    auto result = js_iterator_fields_next(abi_vm, fields, nullptr);
    if (is_throw(result)) {
        fields->done = true;
        return result;
    }
    auto* result_object = value_of(result).as_object();
    auto done = js_iterator_complete(abi_vm, object_abi(result_object));
    if (is_throw(done)) {
        fields->done = true;
        return done;
    }
    if (done.payload) {
        fields->done = true;
        return normal(false);
    }
    auto v = js_iterator_value(abi_vm, object_abi(result_object));
    if (is_throw(v)) {
        fields->done = true;
        return v;
    }
    *value = v.payload;
    return normal(true);
}

extern "C" JSCompletion js_iterator_fields_to_list(JSVM* abi_vm, JSIteratorRecordFields* fields, JSValueSink const* values)
{
    while (true) {
        JSValue value;
        auto step = js_iterator_fields_step_value(abi_vm, fields, &value);
        if (is_throw(step))
            return step;
        if (!step.payload)
            return normal();
        values->append(values->context, value);
    }
}

// --- Map and Set ---------------------------------------------------------------------------------------

static MapObject& map_of(JSObject* object)
{
    return *static_cast<MapObject*>(object_of(object));
}

static Vector<Value>& entries_of(MapObject& map)
{
    if (!map.entries)
        map.entries = new Vector<Value>;
    return *map.entries;
}

extern "C" JSObject* js_collections_map_create(JSVM* abi_vm, JSRealm* realm)
{
    auto& vm = vm_of(abi_vm);
    return object_abi(create_object(vm, *realm_of(realm), intrinsic(vm, *realm_of(realm), JS_INTRINSIC_OBJECT_PROTOTYPE), class_map));
}

extern "C" JSObject* js_collections_set_create(JSVM* abi_vm, JSRealm* realm)
{
    auto& vm = vm_of(abi_vm);
    return object_abi(create_object(vm, *realm_of(realm), intrinsic(vm, *realm_of(realm), JS_INTRINSIC_OBJECT_PROTOTYPE), class_set));
}

extern "C" size_t js_collections_map_size(JSObject* map)
{
    auto& m = map_of(map);
    return m.entries ? m.entries->size() / 2 : 0;
}

extern "C" void js_collections_map_set(JSVM*, JSObject* map, JSValue key, JSValue value)
{
    auto& entries = entries_of(map_of(map));
    for (size_t i = 0; i < entries.size(); i += 2) {
        if (same_value_zero(entries[i], Value { key })) {
            entries[i + 1] = Value { value };
            return;
        }
    }
    entries.append(Value { key });
    entries.append(Value { value });
}

extern "C" bool js_collections_map_remove(JSVM*, JSObject* map, JSValue key)
{
    auto& entries = entries_of(map_of(map));
    for (size_t i = 0; i < entries.size(); i += 2) {
        if (same_value_zero(entries[i], Value { key })) {
            entries.remove(i, 2);
            return true;
        }
    }
    return false;
}

extern "C" void js_collections_map_clear(JSVM*, JSObject* map)
{
    entries_of(map_of(map)).clear();
}

extern "C" JSCompletion js_collections_map_for_each_entry(JSObject* map, JSMapEntryCallback callback, void* context)
{
    auto entries = entries_of(map_of(map)); // a copy: the callback may change the map
    for (size_t i = 0; i < entries.size(); i += 2) {
        auto completion = callback(context, entries[i].bits, entries[i + 1].bits);
        if (is_throw(completion))
            return completion;
    }
    return normal();
}

extern "C" size_t js_collections_set_size(JSObject* set)
{
    auto& s = map_of(set);
    return s.entries ? s.entries->size() : 0;
}

extern "C" void js_collections_set_add(JSVM*, JSObject* set, JSValue value)
{
    auto& entries = entries_of(map_of(set));
    for (auto& entry : entries) {
        if (same_value_zero(entry, Value { value }))
            return;
    }
    entries.append(Value { value });
}

extern "C" bool js_collections_set_remove(JSVM*, JSObject* set, JSValue value)
{
    auto& entries = entries_of(map_of(set));
    for (size_t i = 0; i < entries.size(); ++i) {
        if (same_value_zero(entries[i], Value { value })) {
            entries.remove(i);
            return true;
        }
    }
    return false;
}

extern "C" void js_collections_set_clear(JSVM*, JSObject* set)
{
    entries_of(map_of(set)).clear();
}

extern "C" JSCompletion js_collections_set_for_each_value(JSObject* set, JSSetValueCallback callback, void* context)
{
    auto entries = entries_of(map_of(set));
    for (auto& entry : entries) {
        auto completion = callback(context, entry.bits);
        if (is_throw(completion))
            return completion;
    }
    return normal();
}

// Map and Set iterators (CreateMapIterator, CreateSetIterator): an object of the realm's %Iterator.prototype% with its
// own `next`, a native function that keeps the collection and a position in its two slots. (The real ones share a
// %MapIteratorPrototype%; nothing a page can observe through the iteration protocol depends on that.) The position
// is an index into the entries, which a removal during iteration shifts, as the entries do.
static JSCompletion collection_iterator_next(JSVM* abi_vm)
{
    auto& vm = vm_of(abi_vm);
    auto& function = *static_cast<FunctionObject*>(vm.running_execution_context->function);
    auto& collection = *static_cast<MapObject*>(function.slot0.as_object());
    bool is_map = collection.klass == &class_map;
    i32 state = function.slot1.as_i32();
    u32 index = static_cast<u32>(state) >> 2;
    u32 kind = static_cast<u32>(state) & 3;
    auto& realm = *function.realm;
    auto& entries = entries_of(collection);
    size_t stride = is_map ? 2 : 1;
    auto result = [&](Value value, bool done) {
        return normal(Value::from_object(object_of(js_iterator_create_result_object(abi_vm, realm_abi(&realm), value.bits, done))));
    };
    if (index == 0xFFFFFFFu || index * stride >= entries.size()) {
        function.slot1 = Value::from_i32(static_cast<i32>((0xFFFFFFFu << 2) | kind)); // exhausted stays exhausted
        return result(Value::undefined(), true);
    }
    Value key = entries[index * stride];
    Value value = is_map ? entries[index * stride + 1] : key;
    function.slot1 = Value::from_i32(static_cast<i32>(((index + 1) << 2) | kind));
    if (kind == JS_PROPERTY_KIND_KEY)
        return result(key, false);
    if (kind == JS_PROPERTY_KIND_VALUE)
        return result(value, false);
    JSValue pair[2] = { key.bits, value.bits };
    auto* array = js_array_create_from(abi_vm, realm_abi(&realm), pair, 2);
    return result(Value::from_object(object_of(array)), false);
}

static JSObject* create_collection_iterator(JSVM* abi_vm, JSRealm* abi_realm, JSObject* collection, JSPropertyKind kind)
{
    auto& vm = vm_of(abi_vm);
    auto& realm = *realm_of(abi_realm);
    auto* iterator = create_object(vm, realm, intrinsic(vm, realm, JS_INTRINSIC_ITERATOR_PROTOTYPE));
    auto* next = create_native_function(vm, &realm, FunctionKind::Native, collection_iterator_next, nullptr, nullptr, 0, Utf16FlyString::from_utf8_without_validation("next"sv), {}, true);
    next->slot0 = Value::from_object(object_of(collection));
    next->slot1 = Value::from_i32(static_cast<i32>(kind));
    // Enumerable: the glue's snapshot of a plain object copies enumerable own properties.
    define_direct_property(vm, *iterator, vm.keys->next, Value::from_object(next), JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_ENUMERABLE | JS_ATTRIBUTE_CONFIGURABLE);
    return object_abi(iterator);
}

extern "C" JSObject* js_collections_map_iterator_create(JSVM* vm, JSRealm* realm, JSObject* map, JSPropertyKind kind)
{
    return create_collection_iterator(vm, realm, map, kind);
}

extern "C" JSObject* js_collections_set_iterator_create(JSVM* vm, JSRealm* realm, JSObject* set, JSPropertyKind kind)
{
    return create_collection_iterator(vm, realm, set, kind);
}

// %Array.prototype%.values and @@iterator (CreateArrayIterator, kind value): the engine's own arrays (the [key, value] pairs of
// an iterable interface's entries(), a sequence the engine made) are iterable by the engine's own sequence conversions
// (WebIDL "create a sequence from an iterable": GetMethod(@@iterator)). Like the collection iterators, the iterator is an
// object of %Iterator.prototype% with an own enumerable `next`; the array and the index are in its slots, and the length is
// read on every step.
static JSCompletion array_iterator_next(JSVM* abi_vm)
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
    auto& array = *function.slot0.as_object();
    auto length = internal_get(vm, array, vm.keys->length, Value::from_object(&array), JS_PROPERTY_LOOKUP_PHASE_PROTOTYPE_CHAIN);
    if (is_throw(length))
        return length;
    if (!value_of(length).is_number() || static_cast<double>(index) >= value_of(length).as_double()) {
        function.slot1 = Value::from_i32(-1); // exhausted stays exhausted
        return result(Value::undefined(), true);
    }
    function.slot1 = Value::from_i32(index + 1);
    auto element = internal_get(vm, array, Key::from_index(static_cast<u32>(index)), Value::from_object(&array), JS_PROPERTY_LOOKUP_PHASE_PROTOTYPE_CHAIN);
    if (is_throw(element))
        return element;
    return result(value_of(element), false);
}

static JSCompletion array_prototype_values(JSVM* abi_vm)
{
    auto& vm = vm_of(abi_vm);
    auto this_value = vm.running_execution_context->this_value;
    if (!this_value.is_object())
        return throw_type_error(vm, "Array.prototype.values called on a non-object"sv);
    auto& realm = *static_cast<FunctionObject*>(vm.running_execution_context->function)->realm;
    auto* iterator = create_object(vm, realm, intrinsic(vm, realm, JS_INTRINSIC_ITERATOR_PROTOTYPE));
    auto* next = create_native_function(vm, &realm, FunctionKind::Native, array_iterator_next, nullptr, nullptr, 0, Utf16FlyString::from_utf8_without_validation("next"sv), {}, true);
    next->slot0 = this_value;
    next->slot1 = Value::from_i32(0);
    define_direct_property(vm, *iterator, vm.keys->next, Value::from_object(next), JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_ENUMERABLE | JS_ATTRIBUTE_CONFIGURABLE);
    return normal(Value::from_object(iterator));
}

// %Iterator.prototype%[@@iterator] returns this: an iterator the engine made (the entries() of Headers) is iterable itself, so
// WebIDL's union conversion takes it as a sequence rather than a record.
static JSCompletion iterator_prototype_iterator(JSVM* abi_vm)
{
    return normal(vm_of(abi_vm).running_execution_context->this_value);
}

void install_iterator_iteration(VM& vm, Realm& realm, Object& iterator_prototype)
{
    auto* function = create_native_function(vm, &realm, FunctionKind::Native, iterator_prototype_iterator, nullptr, nullptr, 0, Utf16FlyString::from_utf8_without_validation("[Symbol.iterator]"sv), {}, true);
    define_direct_property(vm, iterator_prototype, Key::from_symbol(vm.well_known_symbols[5]), Value::from_object(function), JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_CONFIGURABLE);
}

void install_array_iteration(VM& vm, Realm& realm, Object& array_prototype)
{
    auto* values = create_native_function(vm, &realm, FunctionKind::Native, array_prototype_values, nullptr, nullptr, 0, Utf16FlyString::from_utf8_without_validation("values"sv), {}, true);
    define_direct_property(vm, array_prototype, Key::from_symbol(vm.well_known_symbols[5]), Value::from_object(values), JS_ATTRIBUTE_WRITABLE | JS_ATTRIBUTE_CONFIGURABLE);
}

// --- Console -------------------------------------------------------------------------------------------

extern "C" JSConsole* js_console_object_console(JSObject* console_object)
{
    return reinterpret_cast<JSConsole*>(static_cast<ConsoleObject*>(object_of(console_object))->console);
}

extern "C" JSRealm* js_console_realm(JSConsole* console)
{
    return realm_abi(reinterpret_cast<Console*>(console)->realm);
}

extern "C" void js_console_set_client(JSConsole* console, JSConsoleClient* client)
{
    reinterpret_cast<Console*>(console)->client = client;
}

extern "C" JSConsoleClient* js_console_client_create(JSVM* abi_vm, JSConsole* console, JSConsoleClientMethods const* methods, void* context)
{
    auto* client = allocate<ConsoleClient>(vm_of(abi_vm), class_console_client);
    client->console = reinterpret_cast<Console*>(console);
    client->methods = methods;
    client->context = context;
    return reinterpret_cast<JSConsoleClient*>(client);
}

extern "C" void js_console_report_exception(JSConsole* abi_console, JSUtf16View name, JSUtf16View message, JSErrorData const* error_data, bool in_promise)
{
    auto& console = *reinterpret_cast<Console*>(abi_console);
    auto* client = static_cast<ConsoleClient*>(console.client);
    if (client && client->methods && client->methods->report_exception) {
        client->methods->report_exception(client->context, name, message, error_data, in_promise);
        return;
    }
    dbgln("ganglion: uncaught exception {}: {}", view_of(name), view_of(message));
}

extern "C" bool js_console_print_value(JSVM* vm, JSValue value, JSByteSink const* sink, bool, bool)
{
    auto text = to_string_without_side_effects(vm_of(vm), Value { value }).to_utf8_but_should_be_ported_to_utf16();
    return sink->append(sink->context, reinterpret_cast<u8 const*>(text.bytes().data()), text.bytes().size());
}

extern "C" JSCompletion js_console_client_generically_format_values(JSVM* vm, JSConsoleClient*, JSValue const* values, size_t value_count, JSOwnedUtf16String* out_formatted)
{
    StringBuilder builder;
    for (size_t i = 0; i < value_count; ++i) {
        if (i)
            builder.append(' ');
        builder.append(to_string_without_side_effects(vm_of(vm), Value { values[i] }).to_utf8_but_should_be_ported_to_utf16());
    }
    *out_formatted = Utf16String::from_utf8(builder.string_view()).into_raw();
    return normal();
}

// --- Date ----------------------------------------------------------------------------------------------

extern "C" JSObject* js_date_create(JSVM* abi_vm, JSRealm* realm, double date_value)
{
    auto& vm = vm_of(abi_vm);
    auto* date = static_cast<DateObject*>(create_object(vm, *realm_of(realm), intrinsic(vm, *realm_of(realm), JS_INTRINSIC_OBJECT_PROTOTYPE), class_date));
    date->date_value = date_value;
    return object_abi(date);
}

extern "C" double js_date_date_value(JSObject* date)
{
    return static_cast<DateObject*>(object_of(date))->date_value;
}

static double day(double t) { return floor(t / 86400000.0); }
static double time_within_day(double t) { return fmod(fmod(t, 86400000.0) + 86400000.0, 86400000.0); }
static double days_in_year(double y) { return (fmod(y, 4) != 0) ? 365 : (fmod(y, 100) != 0) ? 366 : (fmod(y, 400) != 0) ? 365 : 366; }
static double day_from_year(double y) { return 365 * (y - 1970) + floor((y - 1969) / 4) - floor((y - 1901) / 100) + floor((y - 1601) / 400); }
static double year_from_time(double t)
{
    double y = floor(t / (86400000.0 * 365.2425)) + 1970;
    while (day_from_year(y) * 86400000.0 > t)
        --y;
    while (day_from_year(y + 1) * 86400000.0 <= t)
        ++y;
    return y;
}
static double in_leap_year(double t) { return days_in_year(year_from_time(t)) == 366 ? 1 : 0; }
static double day_within_year(double t) { return day(t) - day_from_year(year_from_time(t)); }
static double month_from_time(double t)
{
    double d = day_within_year(t), leap = in_leap_year(t);
    if (d < 31) return 0;
    if (d < 59 + leap) return 1;
    if (d < 90 + leap) return 2;
    if (d < 120 + leap) return 3;
    if (d < 151 + leap) return 4;
    if (d < 181 + leap) return 5;
    if (d < 212 + leap) return 6;
    if (d < 243 + leap) return 7;
    if (d < 273 + leap) return 8;
    if (d < 304 + leap) return 9;
    if (d < 334 + leap) return 10;
    return 11;
}
static double date_from_time(double t)
{
    double d = day_within_year(t), leap = in_leap_year(t);
    static constexpr double starts[] = { 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334 };
    auto month = static_cast<int>(month_from_time(t));
    return d - starts[month] - (month >= 2 ? leap : 0) + 1;
}

extern "C" int32_t js_date_year_from_time(double t) { return static_cast<i32>(year_from_time(t)); }
extern "C" uint8_t js_date_month_from_time(double t) { return static_cast<u8>(month_from_time(t)); }
extern "C" uint8_t js_date_date_from_time(double t) { return static_cast<u8>(date_from_time(t)); }
extern "C" uint8_t js_date_hour_from_time(double t) { return static_cast<u8>(floor(time_within_day(t) / 3600000.0)); }
extern "C" uint8_t js_date_min_from_time(double t) { return static_cast<u8>(fmod(floor(time_within_day(t) / 60000.0), 60)); }
extern "C" uint8_t js_date_sec_from_time(double t) { return static_cast<u8>(fmod(floor(time_within_day(t) / 1000.0), 60)); }
extern "C" uint16_t js_date_ms_from_time(double t) { return static_cast<u16>(fmod(time_within_day(t), 1000)); }

extern "C" double js_date_make_time(double hour, double min, double sec, double ms)
{
    if (!isfinite(hour) || !isfinite(min) || !isfinite(sec) || !isfinite(ms))
        return NAN;
    return trunc(hour) * 3600000.0 + trunc(min) * 60000.0 + trunc(sec) * 1000.0 + trunc(ms);
}

extern "C" double js_date_make_day(double year, double month, double date)
{
    if (!isfinite(year) || !isfinite(month) || !isfinite(date))
        return NAN;
    double y = trunc(year), m = trunc(month), dt = trunc(date);
    double ym = y + floor(m / 12);
    double mn = fmod(fmod(m, 12) + 12, 12);
    static constexpr double starts[] = { 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334 };
    double day_of_year = starts[static_cast<int>(mn)] + (mn >= 2 && days_in_year(ym) == 366 ? 1 : 0);
    return day_from_year(ym) + day_of_year + dt - 1;
}

extern "C" double js_date_make_date(double day, double time)
{
    if (!isfinite(day) || !isfinite(time))
        return NAN;
    return day * 86400000.0 + time;
}

// --- Source code, scripts, modules, JSON, RegExp: not in this runtime ----------------------------------

struct SourceCode {
    u32 references;
    JSOwnedUtf16String filename_raw;
    JSOwnedUtf16String code_raw;
    Vector<u16>* utf16 { nullptr }; // the code as UTF-16 code units, made on first request (the string may be Latin-1)
};

extern "C" JSSourceCode const* js_source_code_create(JSOwnedUtf16String filename, JSOwnedUtf16String code)
{
    auto* source = new SourceCode { 1, filename, code, nullptr };
    return reinterpret_cast<JSSourceCode const*>(source);
}

extern "C" void js_source_code_retain(JSSourceCode const* source)
{
    ++const_cast<SourceCode*>(reinterpret_cast<SourceCode const*>(source))->references;
}

extern "C" void js_source_code_release(JSSourceCode const* abi_source)
{
    auto* source = const_cast<SourceCode*>(reinterpret_cast<SourceCode const*>(abi_source));
    if (--source->references == 0) {
        (void)Utf16String::adopt_raw(source->filename_raw);
        (void)Utf16String::adopt_raw(source->code_raw);
        delete source->utf16;
        delete source;
    }
}

extern "C" size_t js_source_code_length_in_code_units(JSSourceCode const* source)
{
    auto code = Utf16String::from_raw(reinterpret_cast<SourceCode const*>(source)->code_raw);
    return code.length_in_code_units();
}

extern "C" JSOwnedUtf16String const* js_source_code_filename_address(JSSourceCode const* source)
{
    return &reinterpret_cast<SourceCode const*>(source)->filename_raw;
}

extern "C" JSOwnedUtf16String const* js_source_code_code_address(JSSourceCode const* source)
{
    return &reinterpret_cast<SourceCode const*>(source)->code_raw;
}

extern "C" uint16_t const* js_source_code_utf16_data(JSSourceCode const* abi_source)
{
    auto* source = const_cast<SourceCode*>(reinterpret_cast<SourceCode const*>(abi_source));
    if (!source->utf16) {
        auto code = Utf16String::from_raw(source->code_raw);
        auto view = code.utf16_view();
        source->utf16 = new Vector<u16>;
        source->utf16->ensure_capacity(view.length_in_code_units());
        for (size_t i = 0; i < view.length_in_code_units(); i++)
            source->utf16->unchecked_append(view.code_unit_at(i));
    }
    return source->utf16->is_empty() ? nullptr : source->utf16->data();
}

bool (*g_dynamic_function_check)(VM&, Utf16View, Utf16View, u8, JSOwnedUtf16String*) = nullptr;
Object* (*g_dynamic_function_instantiate)(VM&, Realm&, DynamicFunction&, Environment*) = nullptr;
JSCompletion (*g_run_script)(VM&, ScriptObject&) = nullptr;
JSCompletion (*g_run_module)(VM&, ScriptObject&) = nullptr;
JSCompletion (*g_json_parse)(VM&, Utf16View) = nullptr;
JSCompletion (*g_json_stringify)(VM&, Value, Value, Value, JSOwnedUtf16String*) = nullptr;

// A script is kept, not parsed: the host's JavaScript engine runs it (g_run_script). Without one,
// ParseScript reports that there is no engine, and LibWeb's ClassicScript records a parse error.
extern "C" JSScript* js_script_parse(JSVM* abi_vm, JSRealm* realm, JSUtf16View source, JSUtf16View filename, JSUtf16View, void* host_defined, size_t line_number_offset, JSParserErrorSink const* errors)
{
    if (!g_run_script) {
        if (errors && errors->append)
            errors->append(errors->context, "Ganglion runs no JavaScript in phase 1 (scripting is off)"_utf16.into_raw(), 1, 1);
        return nullptr;
    }
    auto* script = allocate<ScriptObject>(vm_of(abi_vm), class_script);
    script->source_raw = Utf16String::from_utf16(view_of(source)).into_raw();
    script->filename_raw = Utf16String::from_utf16(view_of(filename)).into_raw();
    script->host_defined = host_defined;
    script->realm = realm_of(realm);
    script->line_number_offset = static_cast<u32>(line_number_offset);
    return reinterpret_cast<JSScript*>(script);
}

// --- Parsed and compiled programs: nothing is parsed or compiled here; the host's engine does that when the
// script runs. A program is its source text (docs/phase2.md section 2.3).

struct Program {
    Utf16String source;
    u8 type;
    u32 line_number_offset;
};

extern "C" JSParsedProgram* js_compile_parse(JSUtf16View source, JSProgramType type, size_t line_number_offset)
{
    return reinterpret_cast<JSParsedProgram*>(new Program { Utf16String::from_utf16(view_of(source)), type, static_cast<u32>(line_number_offset) });
}

extern "C" bool js_compile_parsed_program_has_errors(JSParsedProgram const*)
{
    return false; // syntax errors surface when the host's engine runs the script
}

extern "C" JSParsedProgram* js_compile_parsed_program_clone(JSParsedProgram const* parsed)
{
    auto const& program = *reinterpret_cast<Program const*>(parsed);
    return reinterpret_cast<JSParsedProgram*>(new Program { program.source, program.type, program.line_number_offset });
}

extern "C" void js_compile_parsed_program_destroy(JSParsedProgram* parsed)
{
    delete reinterpret_cast<Program*>(parsed);
}

extern "C" JSCompiledProgram* js_compile_parsed_program(JSParsedProgram* parsed)
{
    return reinterpret_cast<JSCompiledProgram*>(parsed); // the same record: the source
}

extern "C" JSCompiledProgram* js_compile_parsed_program_with_all_functions(JSParsedProgram* parsed)
{
    return reinterpret_cast<JSCompiledProgram*>(parsed);
}

extern "C" void js_compile_compiled_program_destroy(JSCompiledProgram* compiled)
{
    delete reinterpret_cast<Program*>(compiled);
}

static JSScript* script_from_program(JSVM* abi_vm, Program* program, JSRealm* realm, JSUtf16View filename, void* host_defined)
{
    if (!g_run_script) {
        delete program;
        return nullptr;
    }
    auto* script = allocate<ScriptObject>(vm_of(abi_vm), class_script);
    script->source_raw = move(program->source).into_raw();
    script->filename_raw = Utf16String::from_utf16(view_of(filename)).into_raw();
    script->host_defined = host_defined;
    script->realm = realm_of(realm);
    script->line_number_offset = program->line_number_offset;
    delete program;
    return reinterpret_cast<JSScript*>(script);
}

extern "C" JSScript* js_compile_create_script_from_parsed_program(JSVM* vm, JSParsedProgram* parsed, JSSourceCode const*, JSRealm* realm, JSUtf16View filename, void* host_defined, JSParserErrorSink const* errors)
{
    auto* script = script_from_program(vm, reinterpret_cast<Program*>(parsed), realm, filename, host_defined);
    if (!script && errors && errors->append)
        errors->append(errors->context, "Ganglion runs no JavaScript in phase 1 (scripting is off)"_utf16.into_raw(), 1, 1);
    return script;
}

extern "C" JSScript* js_compile_create_script_from_compiled_program(JSVM* vm, JSCompiledProgram* compiled, JSSourceCode const*, JSRealm* realm, JSUtf16View filename, void* host_defined)
{
    return script_from_program(vm, reinterpret_cast<Program*>(compiled), realm, filename, host_defined);
}

// The script's source as a JSSourceCode the script keeps alive (a caller that keeps it longer retains it).
extern "C" JSSourceCode const* js_compile_top_level_source_code_of_script(JSScript* abi_script)
{
    auto& script = *reinterpret_cast<ScriptObject*>(abi_script);
    if (!script.source_code)
        script.source_code = js_source_code_create(Utf16String::from_raw(script.filename_raw).into_raw(), Utf16String::from_raw(script.source_raw).into_raw());
    return static_cast<JSSourceCode const*>(script.source_code);
}

extern "C" void js_compile_remaining_functions_of_script_off_thread(JSVM*, JSScript*, JSOffThreadCompilationCallbacks const*)
{
    // Nothing to compile ahead of time: the host's engine compiles lazily.
}

extern "C" JSCompletion js_script_run(JSVM* vm, JSScript* script, JSEnvironment*)
{
    if (!g_run_script || !script)
        return throw_type_error(vm_of(vm), "Ganglion runs no JavaScript in phase 1"sv);
    return g_run_script(vm_of(vm), *reinterpret_cast<ScriptObject*>(script));
}

extern "C" void* js_script_host_defined(JSScript* script)
{
    return script ? reinterpret_cast<ScriptObject*>(script)->host_defined : nullptr;
}

extern "C" JSCompletion js_json_parse(JSVM* vm, JSUtf16View text)
{
    if (g_json_parse)
        return g_json_parse(vm_of(vm), view_of(text));
    return throw_type_error(vm_of(vm), "JSON.parse is not available in this build"sv);
}

extern "C" JSCompletion js_json_stringify(JSVM* vm, JSValue value, JSValue replacer, JSValue space, JSOwnedUtf16String* out)
{
    if (g_json_stringify)
        return g_json_stringify(vm_of(vm), Value { value }, Value { replacer }, Value { space }, out);
    return throw_type_error(vm_of(vm), "JSON.stringify is not available in this build"sv);
}

extern "C" JSCompletion js_regexp_create(JSVM* vm, JSValue, JSValue)
{
    return throw_type_error(vm_of(vm), "RegExp is not available in this build"sv);
}

// --- Modules. The host's engine loads and links a module's imports itself (through the segment's service worker,
// docs/phase2.md section 2.3), so a module record is its source, its name and its host-defined cell, with no
// requested modules; Evaluate hands it to the host and settles a capability with what the host's import returns.

static ScriptObject* module_from_source(JSVM* abi_vm, Utf16View source, Utf16View filename, JSRealm* realm, void* host_defined, u32 line_number_offset)
{
    auto* module = allocate<ScriptObject>(vm_of(abi_vm), class_module);
    module->source_raw = Utf16String::from_utf16(source).into_raw();
    module->filename_raw = Utf16String::from_utf16(filename).into_raw();
    module->host_defined = host_defined;
    module->realm = realm_of(realm);
    module->line_number_offset = line_number_offset;
    return module;
}

extern "C" JSModule* js_module_parse_source_text_module(JSVM* vm, JSRealm* realm, JSUtf16View source, JSUtf16View filename, JSUtf16View, void* host_defined, size_t line_number_offset, JSParserErrorSink const* errors)
{
    if (!g_run_module) {
        if (errors && errors->append)
            errors->append(errors->context, "Ganglion runs no JavaScript in phase 1 (scripting is off)"_utf16.into_raw(), 1, 1);
        return nullptr;
    }
    return reinterpret_cast<JSModule*>(module_from_source(vm, view_of(source), view_of(filename), realm, host_defined, static_cast<u32>(line_number_offset)));
}

static JSModule* module_from_program(JSVM* vm, Program* program, JSRealm* realm, JSUtf16View filename, void* host_defined)
{
    if (!g_run_module) {
        delete program;
        return nullptr;
    }
    auto* module = module_from_source(vm, program->source.utf16_view(), view_of(filename), realm, host_defined, program->line_number_offset);
    delete program;
    return reinterpret_cast<JSModule*>(module);
}

extern "C" JSModule* js_compile_create_module_from_parsed_program(JSVM* vm, JSParsedProgram* parsed, JSSourceCode const*, JSRealm* realm, JSUtf16View filename, void* host_defined, JSParserErrorSink const* errors)
{
    auto* module = module_from_program(vm, reinterpret_cast<Program*>(parsed), realm, filename, host_defined);
    if (!module && errors && errors->append)
        errors->append(errors->context, "Ganglion runs no JavaScript in phase 1 (scripting is off)"_utf16.into_raw(), 1, 1);
    return module;
}

extern "C" JSModule* js_compile_create_module_from_compiled_program(JSVM* vm, JSCompiledProgram* compiled, JSSourceCode const*, JSRealm* realm, JSUtf16View filename, void* host_defined)
{
    return module_from_program(vm, reinterpret_cast<Program*>(compiled), realm, filename, host_defined);
}

extern "C" JSSourceCode const* js_compile_top_level_source_code_of_module(JSModule*)
{
    return nullptr; // callers register the source with the debugger's registry only when there is one
}

extern "C" void js_compile_remaining_functions_of_module_off_thread(JSVM*, JSModule*, JSOffThreadCompilationCallbacks const*)
{
}

extern "C" JSRealm* js_module_realm(JSModule* module)
{
    return reinterpret_cast<JSRealm*>(reinterpret_cast<ScriptObject*>(module)->realm);
}

extern "C" void* js_module_host_defined(JSModule* module)
{
    return reinterpret_cast<ScriptObject*>(module)->host_defined;
}

extern "C" JSEnvironment* js_module_environment(JSModule*)
{
    return nullptr;
}

extern "C" size_t js_module_requested_module_count(JSModule*)
{
    return 0;
}

static JSCompletion module_capability(VM& v, ScriptObject& module, PromiseCapability*& capability)
{
    auto& realm = *module.realm;
    auto result = new_promise_capability(v, Value::from_object(intrinsic(v, realm, JS_INTRINSIC_PROMISE_CONSTRUCTOR)));
    if (is_throw(result))
        return result;
    capability = reinterpret_cast<PromiseCapability*>(result.payload);
    return normal();
}

extern "C" JSPromiseCapability* js_module_load_requested_modules(JSVM* abi_vm, JSModule* abi_module, void*)
{
    auto& v = vm_of(abi_vm);
    auto& module = *reinterpret_cast<ScriptObject*>(abi_module);
    PromiseCapability* capability = nullptr;
    VERIFY(!is_throw(module_capability(v, module, capability)));
    Value undefined = Value::undefined();
    (void)call(v, Value::from_object(capability->resolve), Value::undefined(), &undefined, 1);
    return reinterpret_cast<JSPromiseCapability*>(capability);
}

extern "C" JSCompletion js_module_link(JSVM*, JSModule*)
{
    return normal();
}

extern "C" JSCompletion js_module_evaluate(JSVM* abi_vm, JSModule* abi_module)
{
    auto& v = vm_of(abi_vm);
    auto& module = *reinterpret_cast<ScriptObject*>(abi_module);
    PromiseCapability* capability = nullptr;
    if (auto c = module_capability(v, module, capability); is_throw(c))
        return c;
    auto outcome = g_run_module(v, module);
    Value argument = value_of(outcome);
    (void)call(v, Value::from_object(is_throw(outcome) ? capability->reject : capability->resolve), Value::undefined(), &argument, 1);
    return normal_cell(capability);
}

extern "C" void js_module_resolve_export(JSVM*, JSModule*, JSUtf16View, JSResolvedBinding* out)
{
    out->type = JS_RESOLVED_BINDING_NULL;
}

extern "C" JSCompletion js_vm_default_host_resize_array_buffer(JSVM*, JSObject*, size_t)
{
    return normal(static_cast<u64>(JS_HANDLED_BY_HOST_UNHANDLED));
}

extern "C" JSCompletion js_vm_default_host_grow_shared_array_buffer(JSVM*, JSObject*, size_t)
{
    return normal(static_cast<u64>(JS_HANDLED_BY_HOST_UNHANDLED));
}

extern "C" void js_vm_default_host_load_imported_module(JSVM*, JSImportedModuleReferrer, JSModuleRequest const*, void*, JSImportedModulePayload)
{
    unimplemented("js_vm_default_host_load_imported_module");
}

}

using namespace Ganglion;

