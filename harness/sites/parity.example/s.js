let n = 0;
onconnect = (e) => {
    const p = e.ports[0];
    const k = ++n;
    p.onmessage = (m) => p.postMessage([m.data, k, self.name, typeof postMessage, self instanceof SharedWorkerGlobalScope, typeof DedicatedWorkerGlobalScope, JSON.stringify(e.data), e.source === p, Object.prototype.toString.call(self)].join(','));
};
