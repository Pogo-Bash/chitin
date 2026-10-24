// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Promises: creation, resolving functions, reactions and jobs, the capability record. The jobs go to the
// embedder's HostEnqueuePromiseJob hook (LibWeb's microtask queue), which runs them with js_promise_job_run.

#include <AK/Format.h>
#include <Ganglion/Runtime.h>

namespace Ganglion {

Promise* create_promise(VM& vm, Realm& realm)
{
    auto* promise = static_cast<Promise*>(create_object(vm, realm, promise_prototype(vm, realm), class_promise));
    promise->state = JS_PROMISE_STATE_PENDING;
    promise->result = Value::undefined();
    return promise;
}

void enqueue_promise_job(VM& vm, PromiseJob* job, Realm* realm)
{
    if (vm.hooks && vm.hooks->enqueue_promise_job) {
        vm.hooks->enqueue_promise_job(vm.hooks_data, vm_abi(vm), reinterpret_cast<JSPromiseJob*>(job), realm_abi(realm));
        return;
    }
    vm.own_job_queue->append(job);
}

static void trigger_reactions(VM& vm, Vector<PromiseReaction>* reactions, Value argument, Realm* realm)
{
    if (!reactions)
        return;
    for (auto& reaction : *reactions) {
        auto* job = allocate<PromiseJob>(vm, class_promise_job);
        job->job_kind = 0;
        job->reaction_type = reaction.type;
        job->argument = argument;
        job->handler = reaction.handler;
        job->capability = static_cast<PromiseCapability*>(reaction.capability);
        enqueue_promise_job(vm, job, realm);
    }
}

static void settle(VM& vm, Promise& promise, u8 state, Value result)
{
    VERIFY(promise.state == JS_PROMISE_STATE_PENDING);
    promise.state = state;
    promise.result = result;
    auto* reactions = state == JS_PROMISE_STATE_FULFILLED ? promise.fulfill_reactions : promise.reject_reactions;
    auto* realm = &realm_of_object(promise);
    if (state == JS_PROMISE_STATE_REJECTED && !promise.is_handled && vm.hooks && vm.hooks->promise_rejection_tracker)
        vm.hooks->promise_rejection_tracker(vm.hooks_data, vm_abi(vm), object_abi(&promise), JS_PROMISE_REJECTION_OPERATION_REJECT);
    trigger_reactions(vm, reactions, result, realm);
    delete promise.fulfill_reactions;
    delete promise.reject_reactions;
    promise.fulfill_reactions = promise.reject_reactions = nullptr;
}

static void reject_promise(VM& vm, Promise& promise, Value reason)
{
    settle(vm, promise, JS_PROMISE_STATE_REJECTED, reason);
}

static void fulfill_promise(VM& vm, Promise& promise, Value value)
{
    settle(vm, promise, JS_PROMISE_STATE_FULFILLED, value);
}

// The [[Resolve]] and [[Reject]] functions of CreateResolvingFunctions, as native functions whose slot0 holds
// the promise and whose shared "already resolved" record is the promise's own flag.
JSCompletion promise_resolving_function_behaviour(VM& vm, FunctionObject& function)
{
    auto& promise = *static_cast<Promise*>(function.slot0.as_object());
    auto argument = vm.running_execution_context->argument(0);
    if (promise.already_resolved)
        return normal(Value::undefined());
    promise.already_resolved = true;
    if (function.function_kind == FunctionKind::PromiseReject) {
        reject_promise(vm, promise, argument);
        return normal(Value::undefined());
    }
    if (argument.is_object() && argument.as_object() == &promise) {
        auto error = throw_type_error(vm, "Cannot resolve a promise with itself"sv);
        reject_promise(vm, promise, value_of(error));
        return normal(Value::undefined());
    }
    if (!argument.is_object()) {
        fulfill_promise(vm, promise, argument);
        return normal(Value::undefined());
    }
    // The runtime's own promises have a bare prototype (no `then` property): one is adopted by its internal then, in a
    // job as NewPromiseResolveThenableJob would (WebIDL "resolve p with q", Web Locks' waiting promise: without this the
    // resolved promise fulfilled at once with q as its value).
    if (argument.as_object()->klass == &class_promise) {
        auto* job = allocate<PromiseJob>(vm, class_promise_job);
        job->job_kind = 1;
        job->promise = &promise;
        job->thenable = argument.as_object();
        job->then = nullptr;
        enqueue_promise_job(vm, job, &realm_of_object(promise));
        return normal(Value::undefined());
    }
    auto then = internal_get(vm, *argument.as_object(), vm.keys->then, argument, JS_PROPERTY_LOOKUP_PHASE_OWN_PROPERTY);
    if (is_throw(then)) {
        reject_promise(vm, promise, value_of(then));
        return normal(Value::undefined());
    }
    if (!is_callable(value_of(then))) {
        fulfill_promise(vm, promise, argument);
        return normal(Value::undefined());
    }
    auto* job = allocate<PromiseJob>(vm, class_promise_job);
    job->job_kind = 1;
    job->promise = &promise;
    job->thenable = argument.as_object();
    job->then = value_of(then).as_object();
    enqueue_promise_job(vm, job, static_cast<FunctionObject*>(value_of(then).as_object())->realm);
    return normal(Value::undefined());
}

void create_resolving_functions(VM& vm, Promise& promise, Object*& resolve, Object*& reject)
{
    auto& realm = realm_of_object(promise);
    auto* resolve_function = create_native_function(vm, &realm, FunctionKind::PromiseResolve, nullptr, nullptr, nullptr, 1, {}, {}, true);
    auto* reject_function = create_native_function(vm, &realm, FunctionKind::PromiseReject, nullptr, nullptr, nullptr, 1, {}, {}, true);
    resolve_function->slot0 = Value::from_object(&promise);
    reject_function->slot0 = Value::from_object(&promise);
    promise.already_resolved = false;
    resolve = resolve_function;
    reject = reject_function;
}

JSCompletion run_promise_job(VM& vm, PromiseJob& job)
{
    if (job.job_kind == 1) {
        // NewPromiseResolveThenableJob: call then(resolve, reject) on the thenable.
        Object* resolve;
        Object* reject;
        create_resolving_functions(vm, *static_cast<Promise*>(job.promise), resolve, reject);
        if (!job.then) // a runtime promise: its internal then
            return normal(perform_then(vm, *static_cast<Promise*>(job.thenable), Value::from_object(resolve), Value::from_object(reject), nullptr));
        Value arguments[2] = { Value::from_object(resolve), Value::from_object(reject) };
        auto completion = call(vm, Value::from_object(job.then), Value::from_object(job.thenable), arguments, 2);
        if (is_throw(completion)) {
            Value reason = value_of(completion);
            return call(vm, Value::from_object(reject), Value::undefined(), &reason, 1);
        }
        return completion;
    }
    // NewPromiseReactionJob
    JSCompletion handler_result;
    if (job.handler.is_empty() || job.handler.is_undefined()) {
        handler_result = job.reaction_type == 0 ? normal(job.argument) : throw_value(job.argument);
    } else {
        handler_result = call(vm, job.handler, Value::undefined(), &job.argument, 1);
    }
    if (!job.capability)
        return is_throw(handler_result) ? normal(Value::undefined()) : handler_result;
    Value result = value_of(handler_result);
    auto* function = is_throw(handler_result) ? job.capability->reject : job.capability->resolve;
    return call(vm, Value::from_object(function), Value::undefined(), &result, 1);
}

Value perform_then(VM& vm, Promise& promise, Value on_fulfilled, Value on_rejected, PromiseCapability* capability)
{
    PromiseReaction fulfill { .capability = capability, .handler = is_callable(on_fulfilled) ? on_fulfilled : Value::empty(), .type = 0 };
    PromiseReaction reject { .capability = capability, .handler = is_callable(on_rejected) ? on_rejected : Value::empty(), .type = 1 };
    auto* realm = &realm_of_object(promise);
    if (promise.state == JS_PROMISE_STATE_PENDING) {
        if (!promise.fulfill_reactions)
            promise.fulfill_reactions = new Vector<PromiseReaction>;
        if (!promise.reject_reactions)
            promise.reject_reactions = new Vector<PromiseReaction>;
        promise.fulfill_reactions->append(fulfill);
        promise.reject_reactions->append(reject);
    } else {
        auto& reaction = promise.state == JS_PROMISE_STATE_FULFILLED ? fulfill : reject;
        if (promise.state == JS_PROMISE_STATE_REJECTED && !promise.is_handled && vm.hooks && vm.hooks->promise_rejection_tracker)
            vm.hooks->promise_rejection_tracker(vm.hooks_data, vm_abi(vm), object_abi(&promise), JS_PROMISE_REJECTION_OPERATION_HANDLE);
        Vector<PromiseReaction> one;
        one.append(reaction);
        trigger_reactions(vm, &one, promise.result, realm);
    }
    promise.is_handled = true;
    if (!capability)
        return Value::undefined();
    return Value::from_object(capability->promise);
}

static PromiseCapability* capability_for(VM& vm, Promise& promise)
{
    auto* capability = allocate<PromiseCapability>(vm, class_promise_capability);
    capability->promise = &promise;
    create_resolving_functions(vm, promise, capability->resolve, capability->reject);
    return capability;
}

// NewPromiseCapability ( C ): for this runtime's own %Promise%, the capability is built directly.
JSCompletion new_promise_capability(VM& vm, Value constructor)
{
    if (!is_constructor(constructor))
        return throw_type_error(vm, "Not a constructor"sv);
    auto& function = *static_cast<FunctionObject*>(constructor.as_object());
    if (function.function_kind != FunctionKind::PromiseConstructor)
        return throw_type_error(vm, "Promise subclasses are not available in this build"sv);
    auto& realm = *function.realm;
    auto* promise = create_promise(vm, realm);
    return normal_cell(capability_for(vm, *promise));
}

// new Promise(executor)
JSCompletion promise_constructor_behaviour(JSVM* abi_vm)
{
    auto& vm = vm_of(abi_vm);
    auto executor = vm.running_execution_context->argument(0);
    if (!is_callable(executor))
        return throw_type_error(vm, "Promise executor must be a function"sv);
    auto* promise = create_promise(vm, *current_realm(vm));
    Object* resolve;
    Object* reject;
    create_resolving_functions(vm, *promise, resolve, reject);
    Value arguments[2] = { Value::from_object(resolve), Value::from_object(reject) };
    auto completion = call(vm, executor, Value::undefined(), arguments, 2);
    if (is_throw(completion)) {
        Value reason = value_of(completion);
        auto rejected = call(vm, Value::from_object(reject), Value::undefined(), &reason, 1);
        if (is_throw(rejected))
            return rejected;
    }
    return normal(Value::from_object(promise));
}

extern "C" JSCompletion js_promise_job_run(JSVM* vm, JSPromiseJob* job)
{
    return run_promise_job(vm_of(vm), *reinterpret_cast<PromiseJob*>(job));
}

extern "C" JSPromiseState js_promise_state(JSObject* promise)
{
    return static_cast<Promise*>(object_of(promise))->state;
}

extern "C" JSValue js_promise_result(JSObject* promise)
{
    return static_cast<Promise*>(object_of(promise))->result.bits;
}

extern "C" bool js_promise_is_handled(JSObject* promise)
{
    return static_cast<Promise*>(object_of(promise))->is_handled;
}

extern "C" void js_promise_set_is_handled(JSObject* promise)
{
    static_cast<Promise*>(object_of(promise))->is_handled = true;
}

extern "C" JSValue js_promise_perform_then(JSVM* vm, JSObject* promise, JSValue on_fulfilled, JSValue on_rejected, JSPromiseCapability* capability)
{
    return perform_then(vm_of(vm), *static_cast<Promise*>(object_of(promise)), Value { on_fulfilled }, Value { on_rejected }, reinterpret_cast<PromiseCapability*>(capability)).bits;
}

extern "C" JSPromiseResolvingFunctions js_promise_create_resolving_functions(JSVM* vm, JSObject* promise)
{
    Object* resolve;
    Object* reject;
    create_resolving_functions(vm_of(vm), *static_cast<Promise*>(object_of(promise)), resolve, reject);
    return JSPromiseResolvingFunctions { object_abi(resolve), object_abi(reject) };
}

extern "C" JSCompletion js_promise_capability_new(JSVM* vm, JSValue constructor)
{
    return new_promise_capability(vm_of(vm), Value { constructor });
}

extern "C" JSObject* js_promise_capability_promise(JSPromiseCapability* capability)
{
    return object_abi(reinterpret_cast<PromiseCapability*>(capability)->promise);
}

extern "C" JSObject* js_promise_capability_resolve(JSPromiseCapability* capability)
{
    return object_abi(reinterpret_cast<PromiseCapability*>(capability)->resolve);
}

extern "C" JSObject* js_promise_capability_reject(JSPromiseCapability* capability)
{
    return object_abi(reinterpret_cast<PromiseCapability*>(capability)->reject);
}

extern "C" void js_vm_default_host_enqueue_promise_job(JSVM* vm, JSPromiseJob* job, JSRealm*)
{
    vm_of(vm).own_job_queue->append(reinterpret_cast<PromiseJob*>(job));
}

extern "C" bool js_vm_default_host_promise_job_queue_is_empty(JSVM* vm)
{
    return vm_of(vm).own_job_queue->is_empty();
}

extern "C" void js_vm_default_host_enqueue_finalization_registry_cleanup_job(JSVM*, JSObject*)
{
}

}
