// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Chitin segment glue: captured primordials.
//
// Page JS shares this realm with the glue, so every builtin the glue relies on is captured here,
// before any page script runs, in the style of Node.js's lib/internal/per_context/primordials.js.
// After this point the glue never looks up a property the page could have replaced:
//   - methods are called through uncurried captured functions, never as obj.method();
//   - internal records, tables and lists are null-prototype objects or arrays, so reads and
//     writes never reach a prototype the page can define accessors on (Array.prototype[0] setters
//     would otherwise see every value the glue stores);
//   - typed-array views over linear memory are only indexed, never passed to anything that reads
//     .length, .buffer or .constructor (a patched %TypedArray%.prototype getter would receive the
//     view and could reach memory.buffer, i.e. the whole engine);
//   - glue code is strict mode, so V8's Error.prepareStackTrace CallSites cannot hand page JS a
//     glue function or receiver (getThis/getFunction return undefined in strict frames).

const {
    Array,
    ArrayBuffer: HostArrayBuffer,
    DOMException: HostDOMException,
    Error: HostError,
    FinalizationRegistry,
    Float32Array,
    Float64Array,
    Function: HostFunction,
    Math: HostMath,
    Number: HostNumber,
    Object: HostObject,
    Reflect: HostReflect,
    String: HostString,
    Symbol: HostSymbol,
    TextDecoder,
    TypeError: HostTypeError,
    Uint16Array,
    Uint32Array,
    WeakMap,
    WeakRef,
    WebAssembly: HostWebAssembly,
} = globalThis;

const uncurryThis = HostFunction.prototype.bind.bind(HostFunction.prototype.call);

const ReflectApply = HostReflect.apply;
const ReflectSet = HostReflect.set;
const ReflectConstruct = HostReflect.construct;
const ObjectDefineProperty = HostObject.defineProperty;
const ObjectGetOwnPropertyDescriptor = HostObject.getOwnPropertyDescriptor;
const ObjectSetPrototypeOf = HostObject.setPrototypeOf;
const ObjectGetPrototypeOf = HostObject.getPrototypeOf;
const ObjectFreeze = HostObject.freeze;
const ObjectKeys = HostObject.keys;
const HostDate = globalThis.Date;
const DatePrototypeGetTime = HostDate.prototype.getTime;
const ObjectHasOwn = HostObject.hasOwn;
const NumberIsFinite = HostNumber.isFinite;
const MathFloor = HostMath.floor;
const MathMin = HostMath.min;
const MathMax = HostMath.max;
const StringFromCharCode = HostString.fromCharCode;
const StringPrototypeCharCodeAt = uncurryThis(HostString.prototype.charCodeAt);
const StringPrototypeIncludes = uncurryThis(HostString.prototype.includes);
const StringPrototypeIndexOf = uncurryThis(HostString.prototype.indexOf);
const StringPrototypeTrim = uncurryThis(HostString.prototype.trim);
const MapPrototypeClear = uncurryThis(globalThis.Map.prototype.clear);
// The host's microtask queue: promise jobs run on it, and the page's queueMicrotask joins it (see 40-bridge.js).
const HostQueueMicrotask = typeof queueMicrotask === 'function' ? queueMicrotask : null;
// A host task that runs after the host's microtasks, unclamped (setTimeout nests to 4 ms): one MessageChannel of the host's.
const HostMessageChannel = typeof MessageChannel === 'function' && typeof MessagePort === 'function' ? MessageChannel : null;
// (Node's ports are own properties of the channel, Chrome's are accessors on the prototype.)
const channelPortGetter = (name) => {
    const d = HostMessageChannel ? ObjectGetOwnPropertyDescriptor(HostMessageChannel.prototype, name) : undefined;
    return d && d.get ? uncurryThis(d.get) : (channel) => channel[name];
};
const MessageChannelPort1 = channelPortGetter('port1');
const MessageChannelPort2 = channelPortGetter('port2');
const MessagePortPostMessage = HostMessageChannel ? uncurryThis(globalThis.MessagePort.prototype.postMessage) : null;
const portOnmessage = HostMessageChannel ? ObjectGetOwnPropertyDescriptor(MessagePort.prototype, 'onmessage') : undefined;
const MessagePortSetOnmessage = portOnmessage && portOnmessage.set ? uncurryThis(portOnmessage.set) : (port, f) => { port.onmessage = f; };
const SymbolUnscopables = HostSymbol.unscopables;
const SymbolToStringTag = HostSymbol.toStringTag;
const WeakRefPrototypeDeref = uncurryThis(WeakRef.prototype.deref);
const FinalizationRegistryPrototypeRegister = uncurryThis(FinalizationRegistry.prototype.register);
const WeakMapPrototypeGet = uncurryThis(WeakMap.prototype.get);
const WeakMapPrototypeSet = uncurryThis(WeakMap.prototype.set);
const TextDecoderPrototypeDecode = uncurryThis(TextDecoder.prototype.decode);
const WebAssemblyModule = HostWebAssembly.Module;
const WebAssemblyInstance = HostWebAssembly.Instance;
const WebAssemblyMemoryPrototypeGetBuffer = uncurryThis(ObjectGetOwnPropertyDescriptor(HostWebAssembly.Memory.prototype, 'buffer').get);
const WebAssemblyInstancePrototypeGetExports = uncurryThis(ObjectGetOwnPropertyDescriptor(HostWebAssembly.Instance.prototype, 'exports').get);
const indirectEval = globalThis.eval;
const hostReportError = typeof globalThis.reportError === 'function' ? globalThis.reportError : undefined;
const hostConsoleError = globalThis.console && globalThis.console.error ? uncurryThis(globalThis.console.error) : undefined;
const hostConsole = globalThis.console;
const hostPerformanceNow = globalThis.performance ? uncurryThis(globalThis.performance.now) : undefined;
const hostPerformance = globalThis.performance;

// A null-prototype array: indexed writes never consult Array.prototype.
function safeArray() {
    return ObjectSetPrototypeOf([], null);
}

function typeError(message) {
    return new HostTypeError(message);
}
