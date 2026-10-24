// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin engine glue: boot. Instantiates ganglion.wasm with the imports of 20-wasi.js and 30-host.js,
// built from the module's own import list so that a name nothing here provides fails at instantiation
// (loudly, with its name) instead of at the first call.

const WebAssemblyModuleImports = HostWebAssembly.Module.imports;

// invoke_<sig>(index, ...args): calls table[index] and turns a longjmp (a thrown number) into setThrew.
function makeInvoke(signature) {
    return function invoke(index, ...args) {
        const sp = X.emscripten_stack_get_current();
        try {
            return ReflectApply(TableGet(X.__indirect_function_table, index), undefined, args);
        } catch (e) {
            X._emscripten_stack_restore(sp);
            if (e !== e + 0)
                throw e;
            X.setThrew(1, 0);
            return signature[0] === 'v' ? undefined : signature[0] === 'j' ? 0n : 0;
        }
    };
}
const TableGet = uncurryThis(HostWebAssembly.Table.prototype.get);

// A wasm trap (AK's VERIFY, an unreachable, a stack overflow) unwinds no C++ frame: whatever the engine was
// in the middle of stays half done, and the next call finds the debris (the owner's run of 2026-10-11:
// one failed VERIFY in the parser, then every frame tick, the network and the Worker died in their own
// ways). So the first trap stops the engine: it is reported once, through options.stopped, with the
// engine's own last words, and every later call refuses with the same reason instead of a new trap.
let stoppedReason = null;
// How many engine calls are on the stack: the host calls the engine (dispatchTrusted), the engine calls the page, the page calls
// the host (ws.close() writes a frame to the tunnel) and the host calls the engine again. A pump inside that nesting would run
// timers and a microtask checkpoint with the outer call's JavaScript execution context still on the stack (VERIFY
// execution_context_stack().is_empty(), EventLoop.cpp:1460): it waits for the outermost call to return.
let engineDepth = 0;
let pumpDeferred = false;
const WebAssemblyRuntimeError = HostWebAssembly.RuntimeError;
// A trap (a WebAssembly RuntimeError: a failed VERIFY, unreachable) stops the engine for good: it unwound the engine's
// C++ frames without their cleanup, so nothing in it is to be trusted (the execution context stack, locks, half-made
// objects). Called where a trap can arrive: the API (guardApi) and page code calling into the engine (invoke in
// 40-bridge.js), where the page would otherwise catch the error and go on calling a broken engine.
let stoppedCallback = null;
function engineTrapped(e, name) {
    if (!(e instanceof WebAssemblyRuntimeError) || stoppedReason !== null)
        return;
    stoppedReason = (lastFatalLog !== null ? lastFatalLog + ' ' : '') + '(' + String(e.message) + ', in ' + name + ')';
    // The wasm frames of the first trap (function names come from the linked module's name section): where the
    // engine stopped, kept in the engine log for whoever reads the stop.
    try {
        const frames = 'trap in ' + name + ': ' + String(e.message) + '\n' + StringPrototypeSlice(String(e.stack), 0, 6000);
        engineLog(frames);
        // The panel's engine log keeps one line; the host console keeps all of them.
        if (hostConsoleError)
            hostConsoleError(hostConsole, frames);
    } catch { /* the stop is reported either way */ }
    if (stoppedCallback !== null)
        stoppedCallback(stoppedReason, e);
}

// Any other exception out of an engine export unwound engine frames too (no C++ frame raises one): a stack overflow
// (V8's RangeError, not a RuntimeError, when the stack runs out inside the engine under deep or runaway recursion) or a host
// import that threw instead of answering. The engine stops as for a trap, wherever the exception is then caught: page code
// catching the RangeError of a binding call went on with the engine's execution context stack and half-done steps left
// behind, and the next clean-up or microtask checkpoint failed its VERIFY (tests/ctx.test.mjs).
// Only an overflow raised by the call into the engine itself, before any engine frame ran, leaves the engine whole.
//
// The catch only records (an assignment needs no stack, and the stack is all but gone here): what it saw is judged at the next
// call into the engine, or when page code the engine called returns to it (settleUnwound, from 40-bridge.js's host calls).
let unwoundError = null; // the exception last seen leaving an engine export
let unwoundTwice = false; // it left an export that an inner export's exception unwound: the outer export's frames went too
function settleUnwound() {
    if (unwoundError === null)
        return;
    const e = unwoundError;
    const twice = unwoundTwice;
    let harmless = false;
    if (!twice && e !== null && typeof e === 'object') {
        const lines = StringPrototypeSplit(String(e.stack), '\n');
        harmless = lines.length > 1 && StringPrototypeIncludes(lines[1], 'engineExport');
    }
    unwoundError = null;
    unwoundTwice = false;
    if (harmless || stoppedReason !== null || e instanceof WebAssemblyRuntimeError)
        return; // a trap: engineTrapped, at the API or binding call it came through, says where
    const message = e !== null && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
    stoppedReason = (lastFatalLog !== null ? lastFatalLog + ' ' : '') + '(' + message + ': an exception unwound the engine)';
    try {
        const frames = 'exception through the engine: ' + message + '\n' + StringPrototypeSlice(String(e && e.stack), 0, 6000);
        engineLog(frames);
        if (hostConsoleError)
            hostConsoleError(hostConsole, frames);
    } catch { /* the stop is reported either way */ }
    if (stoppedCallback !== null)
        stoppedCallback(stoppedReason, e);
}
// What may still be called once the engine stopped: reading its state for a report, and the stack and memory helpers.
const AFTER_STOP = { __proto__: null, memory: true, ganglion_alloc: true, ganglion_free: true, malloc: true, free: true,
    emscripten_stack_get_current: true, _emscripten_stack_restore: true, setThrew: true };
function guardedExports(exports) {
    const wrapped = { __proto__: null };
    const names = ObjectKeys(exports);
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const f = exports[name];
        if (typeof f !== 'function' || AFTER_STOP[name] === true || StringPrototypeStartsWith(name, 'ganglion_debug_')) {
            wrapped[name] = f;
            continue;
        }
        wrapped[name] = function engineExport() {
            if (unwoundError !== null)
                settleUnwound();
            if (stoppedReason !== null)
                throw new HostError('ganglion: the engine stopped: ' + stoppedReason);
            try {
                return ReflectApply(f, undefined, arguments);
            } catch (e) {
                if (e === unwoundError)
                    unwoundTwice = true;
                else if (unwoundError === null)
                    unwoundError = e;
                throw e;
            }
        };
    }
    return wrapped;
}

function guardApi(options) {
    if (typeof options.stopped === 'function')
        stoppedCallback = options.stopped;
    const names = ObjectKeys(api);
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const f = api[name];
        if (typeof f !== 'function')
            continue;
        if (name === 'stopped') // the way to ask whether the engine stopped must not itself refuse
            continue;
        api[name] = function guarded() {
            if (stoppedReason !== null)
                throw new HostError('ganglion: the engine stopped: ' + stoppedReason);
            if (name === 'pump' && engineDepth > 0) {
                pumpDeferred = true;
                return undefined;
            }
            engineDepth++;
            try {
                return ReflectApply(f, this, arguments);
            } catch (e) {
                engineTrapped(e, name);
                throw e;
            } finally {
                engineDepth--;
                if (engineDepth === 0 && pumpDeferred && stoppedReason === null) {
                    pumpDeferred = false;
                    api.pump();
                }
            }
        };
    }
}
api.stopped = () => stoppedReason;

function boot(options) {
    callbacks = options;
    cookieJarOf(); // the jar takes its records before any page script runs (docs/cookies.md)
    if (options.log)
        engineLog = options.log;
    const module = options.wasm instanceof WebAssemblyModule ? options.wasm : new WebAssemblyModule(options.wasm);
    const state = engineState();
    const wasi = makeWasiImports(state);
    const env = makeEnvImports(state);
    const host = makeHostImports();
    const bridge = makeBridgeImports();
    const imports = { __proto__: null };
    const missing = [];
    const list = WebAssemblyModuleImports(module);
    for (let i = 0; i < list.length; i++) {
        const entry = list[i];
        const moduleName = entry.module;
        const name = entry.name;
        if (!imports[moduleName])
            imports[moduleName] = { __proto__: null };
        let value;
        if (moduleName === 'wasi_snapshot_preview1')
            value = wasi[name];
        else if (moduleName === 'env')
            value = host[name] || bridge[name] || env[name];
        if (value === undefined && moduleName === 'env' && name.startsWith('invoke_'))
            value = makeInvoke(name.slice(7));
        if (value === undefined) {
            if (entry.kind === 'function') {
                missing.push(moduleName + '.' + name);
                value = () => {
                    throw new HostError('ganglion: the engine called an import nothing provides: ' + moduleName + '.' + name);
                };
            }
        }
        imports[moduleName][name] = value;
    }
    if (missing.length && options.onMissingImports)
        options.onMissingImports(missing);
    instance = new WebAssemblyInstance(module, imports);
    X = guardedExports(WebAssemblyInstancePrototypeGetExports(instance));
    // Debugging aid (options.debugContexts, docs/captcha.md): after each outermost call into the engine, the
    // execution context stack must be empty again; the first call that leaves one behind is reported with the stack.
    if (options.debugContexts && typeof X.ganglion_debug_context_depth === 'function')
        X = contextCheckedExports(X, typeof options.debugContexts === 'function' ? options.debugContexts : null);
    memory = X.memory;
    refreshEngineViews();
    // A WASI reactor: _initialize runs the C++ static constructors before anything else is called.
    if (typeof X._initialize === 'function')
        X._initialize();
    X.ganglion_init(options.width, options.height, options.dpr || 1);
    // The platform identity (45-surface.js): the User-Agent and Sec-CH-UA request headers say what navigator says.
    if (typeof X.ganglion_set_identity === 'function') {
        const identity = copyInString(identityHeaderBlock());
        try {
            X.ganglion_set_identity(identity, identityHeaderBlock().length);
        } finally {
            X.ganglion_free(identity);
        }
    }
    // The site-compatibility list (webcompat/*.json, docs/surface.md), plus any rules the host adds (options.siteCompatibility:
    // the harness's test rules). Before the first request, as the identity is.
    if (typeof X.ganglion_set_site_compatibility === 'function') {
        let rules = SITE_COMPATIBILITY;
        if (options.siteCompatibility !== undefined && options.siteCompatibility !== null)
            rules = uaConcat(rules, uaFrom(options.siteCompatibility));
        const text = JSONStringify(rules);
        const bytes = TextEncoderPrototypeEncode(encoderUtf8, text);
        const p = copyIn(bytes);
        try {
            if (!X.ganglion_set_site_compatibility(p, bytes.length) && engineLog)
                engineLog('site compatibility: the list did not parse; none applies');
        } finally {
            X.ganglion_free(p);
        }
    }
    guardApi(options);
    return api;
}
