// Where am I running: what libraries ask of a service worker's global before choosing `self` or `window`.
self.addEventListener('message', (event) => {
    event.source.postMessage([
        'ServiceWorkerGlobalScope' in globalThis,
        typeof ServiceWorkerGlobalScope === 'function' && self instanceof ServiceWorkerGlobalScope,
        typeof WorkerGlobalScope === 'function' && self instanceof WorkerGlobalScope,
        Object.prototype.toString.call(self),
        'DedicatedWorkerGlobalScope' in globalThis,
        typeof window,
    ].join(','));
});
