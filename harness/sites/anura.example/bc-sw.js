// BroadcastChannel between a page, its service worker and its dedicated worker (one site).
const bc = new BroadcastChannel('anura');
bc.onmessage = (e) => {
    if (e.data && e.data.from === 'page')
        bc.postMessage({ from: 'sw', got: e.data.n, origin: e.origin });
};
self.addEventListener('message', (e) => e.source.postMessage(['sw-ready', String(bc), bc.name].join(',')));
