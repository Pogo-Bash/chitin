const bc = new BroadcastChannel('anura');
bc.onmessage = (e) => {
    if (e.data && e.data.from === 'sw')
        postMessage('worker saw sw ' + e.data.got);
};
postMessage('worker-ready');
