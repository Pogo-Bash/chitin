// Many cache puts (anura caches its system in chunks): each entry and its body must read back; overwrite and delete too.
self.addEventListener('message', async (event) => {
    const cache = await caches.open('chunks');
    for (let i = 0; i < 40; i++)
        await cache.put('/chunk/' + i, new Response(new Uint8Array(65536).fill(i), { headers: { 'content-type': 'application/octet-stream' } }));
    await cache.put('/chunk/7', new Response('replaced'));
    await cache.delete('/chunk/8');
    const keys = await cache.keys();
    const c5 = new Uint8Array(await (await cache.match('/chunk/5')).arrayBuffer());
    const c7 = await (await cache.match('/chunk/7')).text();
    const c8 = await cache.match('/chunk/8');
    event.source.postMessage([keys.length, c5.length, c5[100], c7, String(c8)].join(','));
});
