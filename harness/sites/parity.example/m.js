let t;
try { importScripts('inner.js'); t = 'imported'; } catch (e) { t = e.name + ': ' + e.message; }
postMessage([t, typeof WorkerGlobalScope, self instanceof DedicatedWorkerGlobalScope].join('|'));
