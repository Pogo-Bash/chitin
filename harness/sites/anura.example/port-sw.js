// A MessagePort inside the message's data (Comlink's init): the worker answers on it.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
    const p = event.data && event.data.value;
    const same = event.ports.length === 1 && p === event.ports[0];
    const tag = typeof p.addEventListener + ' ' + typeof p.start;
    p.addEventListener('message', (m) => p.postMessage('echo ' + m.data));
    p.start();
    const back = new MessageChannel();
    back.port1.onmessage = (m) => back.port1.postMessage('back ' + m.data);
    event.source.postMessage({ back: back.port2 }, [back.port2]);
    p.postMessage([tag, same, event.ports.length].join(','));
});
