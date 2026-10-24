let c;
try { new WorkerGlobalScope(); c = 'constructs'; } catch (e) { c = e.name + ': ' + e.message; }
postMessage([typeof WorkerGlobalScope, self instanceof WorkerGlobalScope, self instanceof DedicatedWorkerGlobalScope, typeof SharedWorkerGlobalScope, Object.prototype.toString.call(self), c, typeof onconnect, typeof Worker].join(','));
