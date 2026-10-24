// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// The host's doors, removed before site code exists: shared by the segment Worker (worker.js) and the runner of a page's
// service worker (pagesw.js), which get the same lists and the same allowlist check. Loaded with importScripts first
// thing; the caller takes `__chitinDoors` and deletes it from the global.
'use strict';
(() => {
// --- Removing the host's doors before page code exists -------------------------------------------
// docs/security.md section 1.2, layer 2. This script is the only code that ever holds the host's
// network, messaging and storage APIs: what it needs it has captured above, and the members are
// deleted from where they live (the prototypes WorkerGlobalScope, DedicatedWorkerGlobalScope and
// the interface objects on the global), not shadowed on the instance. Then every name left on the
// global and its prototype chain is checked against an allowlist; a name this list has never seen
// (a new Chrome API) refuses the page, so a new door is a failed start instead of a leak.
const DENY_MEMBERS = ['fetch', 'importScripts', 'indexedDB', 'caches', 'postMessage', 'close', 'onmessage', 'onmessageerror', 'onrtctransform',
    'webkitRequestFileSystem', 'webkitRequestFileSystemSync', 'webkitResolveLocalFileSystemURL', 'webkitResolveLocalFileSystemSyncURL'];
const DENY_INTERFACES = ['XMLHttpRequest', 'XMLHttpRequestEventTarget', 'XMLHttpRequestUpload', 'WebSocket', 'WebSocketStream', 'WebSocketError', 'EventSource',
    'WebTransport', 'WebTransportBidirectionalStream', 'WebTransportDatagramDuplexStream', 'WebTransportError', 'WebTransportReceiveStream', 'WebTransportSendStream',
    'Worker', 'SharedWorker', 'BroadcastChannel', 'WorkerGlobalScope', 'DedicatedWorkerGlobalScope', 'WorkerNavigator', 'WorkerLocation',
    'IDBFactory', 'IDBDatabase', 'IDBObjectStore', 'IDBIndex', 'IDBCursor', 'IDBCursorWithValue', 'IDBKeyRange', 'IDBRequest', 'IDBOpenDBRequest', 'IDBTransaction', 'IDBVersionChangeEvent',
    'Cache', 'CacheStorage', 'StorageManager', 'FileSystemHandle', 'FileSystemFileHandle', 'FileSystemDirectoryHandle', 'FileSystemSyncAccessHandle', 'FileSystemWritableFileStream',
    'LockManager', 'Lock', 'NavigationPreloadManager', 'Notification', 'PushManager', 'SyncManager', 'PeriodicSyncManager', 'BackgroundFetchManager', 'RTCPeerConnection',
    // Chrome 155 (the owner's first run): doors that exist as interface objects in a Worker.
    'ServiceWorkerRegistration', 'StorageBucket', 'StorageBucketManager', 'IDBRecord', 'FileSystemObserver',
    'Permissions', 'PermissionStatus', 'NetworkInformation', 'IdleDetector', 'PressureObserver', 'PressureRecord',
    'ReportingObserver', 'ReportBody', 'CreateMonitor'];
// Door families by name, so the next Chrome's additions to them are removed instead of stopping the page:
// WebRTC (RTCDataChannel and the encoded-frame/transform types reach peers and leak addresses), device access
// (USB, HID, Serial, Bluetooth, NFC), Push and Background Fetch (browser-run network), WebXR, Credentials.
const DENY_PATTERNS = [/^RTC/, /^USB/, /^HID/, /^Serial/, /^Bluetooth/, /^NFC/, /^Push/, /^BackgroundFetch/, /^BackgroundSync/, /^PeriodicSync/, /^XR/, /^Credential/, /^PasswordCredential/, /^FederatedCredential/, /^Sensor/, /^Gamepad/, /^MIDI/, /^WebTransport/, /^WebSocket/, /^FileSystem/, /^IDB/];
// The part of the host's navigator a page may see: the fingerprint surface (which Chrome's own
// pages show), never storage, locks, the service worker or beacons.
const NAVIGATOR_KEEP = ['userAgent', 'appVersion', 'platform', 'product', 'vendor', 'language', 'languages', 'hardwareConcurrency', 'deviceMemory', 'onLine', 'userAgentData'];
const ALLOWED_NAMES = new Set([
    // ECMAScript and V8
    ...'Object Function Array Number parseFloat parseInt Infinity NaN undefined Boolean String Symbol Date Promise RegExp Error AggregateError EvalError RangeError ReferenceError SyntaxError TypeError URIError globalThis JSON Math Intl ArrayBuffer Atomics Uint8Array Int8Array Uint16Array Int16Array Uint32Array Int32Array Float32Array Float64Array Uint8ClampedArray BigUint64Array BigInt64Array DataView Map BigInt Set WeakMap WeakSet Proxy Reflect FinalizationRegistry WeakRef decodeURI decodeURIComponent encodeURI encodeURIComponent escape unescape eval isFinite isNaN console Iterator SharedArrayBuffer WebAssembly Float16Array Temporal DisposableStack AsyncDisposableStack SuppressedError Math constructor prototype __proto__ __defineGetter__ __defineSetter__ __lookupGetter__ __lookupSetter__ hasOwnProperty isPrototypeOf propertyIsEnumerable toLocaleString toString valueOf'.split(' '),
    // WorkerGlobalScope, DedicatedWorkerGlobalScope and EventTarget members that are not doors
    ...'self location navigator onerror onlanguagechange onoffline ononline onrejectionhandled onunhandledrejection atob btoa clearInterval clearTimeout createImageBitmap queueMicrotask reportError setInterval setTimeout structuredClone crossOriginIsolated crypto fonts isSecureContext origin performance scheduler trustedTypes name requestAnimationFrame cancelAnimationFrame addEventListener removeEventListener dispatchEvent TEMPORARY PERSISTENT'.split(' '),
    // Interface objects with no way out of the Worker by themselves
    ...'AbortController AbortSignal Blob ByteLengthQueuingStrategy CanvasGradient CanvasPattern CompressionStream CountQueuingStrategy Crypto CryptoKey CustomEvent DOMException DOMMatrix DOMMatrixReadOnly DOMPoint DOMPointReadOnly DOMQuad DOMRect DOMRectReadOnly DecompressionStream ErrorEvent Event EventTarget File FileReader FileReaderSync FontFace FontFaceSet FontFaceSetLoadEvent FormData Headers ImageBitmap ImageBitmapRenderingContext ImageData ImageDecoder ImageTrack ImageTrackList MessageChannel MessageEvent MessagePort OffscreenCanvas OffscreenCanvasRenderingContext2D Path2D Performance PerformanceEntry PerformanceMark PerformanceMeasure PerformanceObserver PerformanceObserverEntryList PerformanceResourceTiming PerformanceServerTiming ProgressEvent PromiseRejectionEvent ReadableByteStreamController ReadableStream ReadableStreamBYOBReader ReadableStreamBYOBRequest ReadableStreamDefaultController ReadableStreamDefaultReader Request Response Scheduler SubtleCrypto TaskController TaskPriorityChangeEvent TaskSignal TextDecoder TextDecoderStream TextEncoder TextEncoderStream TextMetrics TransformStream TransformStreamDefaultController TrustedHTML TrustedScript TrustedScriptURL TrustedTypePolicy TrustedTypePolicyFactory URL URLPattern URLSearchParams VideoColorSpace VideoDecoder VideoEncoder VideoFrame AudioData AudioDecoder AudioEncoder EncodedAudioChunk EncodedVideoChunk WritableStream WritableStreamDefaultController WritableStreamDefaultWriter CloseEvent PerformanceEventTiming PerformanceLongTaskTiming PerformancePaintTiming CSSStyleValue CSSNumericValue CSSUnitValue CSSKeywordValue CSSTransformValue CSSMathValue GPU GPUAdapter GPUDevice GPUBuffer GPUTexture GPUCanvasContext GPUSupportedFeatures GPUSupportedLimits GPUAdapterInfo GPUError GPUValidationError GPUOutOfMemoryError GPUInternalError GPUUncapturedErrorEvent GPUDeviceLostInfo GPUBindGroup GPUBindGroupLayout GPUCommandBuffer GPUCommandEncoder GPUCompilationInfo GPUCompilationMessage GPUComputePassEncoder GPUComputePipeline GPUExternalTexture GPUPipelineError GPUPipelineLayout GPUQuerySet GPUQueue GPURenderBundle GPURenderBundleEncoder GPURenderPassEncoder GPURenderPipeline GPUSampler GPUShaderModule GPUTextureView GPUMapMode GPUBufferUsage GPUColorWrite GPUShaderStage GPUTextureUsage WebGLRenderingContext WebGL2RenderingContext WebGLActiveInfo WebGLBuffer WebGLContextEvent WebGLFramebuffer WebGLProgram WebGLQuery WebGLRenderbuffer WebGLSampler WebGLShader WebGLShaderPrecisionFormat WebGLSync WebGLTexture WebGLTransformFeedback WebGLUniformLocation WebGLVertexArrayObject Navigator NavigatorUAData RestrictionTarget CropTarget Origin QuotaExceededError UserActivation Observable Subscriber when SourceBuffer SourceBufferList MediaSource MediaSourceHandle MediaCapabilities BarcodeDetector WebGLObject SecurityPolicyViolationEvent FileList DOMStringList CSSUnparsedValue CSSSkewX CSSSkewY CSSNumericArray CSSMathSum CSSMathProduct CSSMathNegate CSSMathMin CSSMathMax CSSMathInvert CSSMathClamp WGSLLanguageFeatures'.split(' '),
]);
// `navigatorExtras`: name -> getter, members the caller's own objects add to the page's navigator (storage: OPFS, harness/segment/opfs.js).
function removeHostDoors(G, extraAllowed, navigatorExtras) {
    for (const n of extraAllowed || [])
        ALLOWED_NAMES.add(String(n));
    const chain = [];
    for (let o = G; o && o !== Object.prototype; o = Object.getPrototypeOf(o))
        chain.push(o);
    const own = (o, n) => Object.prototype.hasOwnProperty.call(o, n);
    // The host's navigator instance, read before its accessor is replaced.
    let hostNavigator;
    try { hostNavigator = G.navigator; } catch { hostNavigator = undefined; }
    for (const o of chain)
        for (const n of DENY_MEMBERS)
            if (own(o, n))
                Reflect.deleteProperty(o, n);
    // The fingerprint surface is copied out of the host's navigator before its interface (WorkerNavigator) is
    // emptied below: its values live on that prototype, and Chrome 154 showed an empty navigator when the
    // copy came after.
    let safe = null;
    if (hostNavigator) {
        safe = Object.create(null);
        for (const n of NAVIGATOR_KEEP) {
            if (!(n in hostNavigator))
                continue;
            const value = hostNavigator[n];
            if (n === 'onLine') {
                // Live value through the accessor function captured now (the prototype is emptied below).
                let desc;
                for (let o = hostNavigator; o && !desc; o = Object.getPrototypeOf(o))
                    desc = Object.getOwnPropertyDescriptor(o, 'onLine');
                const getter = desc && desc.get;
                Object.defineProperty(safe, n, { get: () => (getter ? Reflect.apply(getter, hostNavigator, []) : true), enumerable: true });
                continue;
            }
            if (n === 'userAgent' || n === 'appVersion') {
                // The platform identity (docs/surface.md): Chrome's own string plus the coarse Chitin token, Edge-style.
                const token = ' Chitin/0';
                Object.defineProperty(safe, n, { value: typeof value === 'string' && !value.endsWith(token) ? value + token : value, enumerable: true });
                continue;
            }
            if (n === 'userAgentData' && value) {
                const hostData = value;
                const brands = Object.freeze([...hostData.brands].filter((b) => b.brand !== 'Chitin').map((b) => ({ brand: b.brand, version: b.version })).concat([{ brand: 'Chitin', version: '0' }]));
                const data = {
                    brands, mobile: hostData.mobile, platform: hostData.platform,
                    async getHighEntropyValues(hints) {
                        const out = await hostData.getHighEntropyValues(hints);
                        if (Array.isArray(out.fullVersionList))
                            out.fullVersionList = out.fullVersionList.filter((b) => b.brand !== 'Chitin').concat([{ brand: 'Chitin', version: '0.0.0.0' }]);
                        out.brands = brands;
                        return out;
                    },
                    toJSON() { return { brands, mobile: hostData.mobile, platform: hostData.platform }; },
                };
                Object.defineProperty(safe, n, { value: Object.freeze(data), enumerable: true });
                continue;
            }
            Object.defineProperty(safe, n, { value: Array.isArray(value) ? Object.freeze([...value]) : value, enumerable: true });
        }
    }
    const denied = [...DENY_INTERFACES];
    for (const o of chain)
        for (const n of Object.getOwnPropertyNames(o))
            if (!denied.includes(n) && DENY_PATTERNS.some((re) => re.test(n)))
                denied.push(n);
    DENY_INTERFACES.push(...denied.filter((n) => !DENY_INTERFACES.includes(n)));
    for (const n of denied) {
        if (!own(G, n))
            continue;
        // Methods go from the interface's prototype too, in case an instance turns up some other way.
        const proto = G[n] && G[n].prototype;
        if (proto && proto !== Object.prototype && !chain.includes(proto))
            for (const m of Reflect.ownKeys(proto))
                if (m !== 'constructor')
                    Reflect.deleteProperty(proto, m);
        Reflect.deleteProperty(G, n);
    }
    if (safe) {
        for (const n of Object.keys(navigatorExtras || {}))
            Object.defineProperty(safe, n, { get: navigatorExtras[n], enumerable: true });
        Object.freeze(safe);
        for (const o of chain)
            if (own(o, 'navigator'))
                Object.defineProperty(o, 'navigator', { get: () => safe, set: undefined, configurable: true, enumerable: true });
    }
    const left = [];
    const unknown = [];
    for (const o of chain)
        for (const n of Object.getOwnPropertyNames(o)) {
            if (DENY_MEMBERS.includes(n) || DENY_INTERFACES.includes(n))
                left.push(n);
            else if (!ALLOWED_NAMES.has(n))
                unknown.push(n);
        }
    if (left.length)
        return `could not remove: ${[...new Set(left)].join(', ')}`;
    if (unknown.length)
    {
        const all = [...new Set(unknown)];
        // The whole list goes to the console of this Worker target (the panel text truncates).
        console.error('[chitin] host members this build has never seen (' + all.length + '): ' + all.join(', '));
        return `host members this build has never seen (a browser update?): ${all.join(', ')}. The full list is in the console of the chitin-segment target; to see it, pick "chitin-segment" in the console's context menu (top of the Console panel), not "top".`;
    }
    return null;
}
self.__chitinDoors = Object.freeze({ removeHostDoors, DENY_MEMBERS, DENY_INTERFACES, ALLOWED_NAMES });
})();
