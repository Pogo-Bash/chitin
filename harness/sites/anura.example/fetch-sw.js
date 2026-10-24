// Fetch handler failures, as Chrome treats them: a throw before respondWith falls back to the network; a rejected
// respondWith is a network error for that request; a handler that never calls respondWith falls back.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
    const u = new URL(event.request.url);
    if (u.searchParams.get('t') === 'throw')
        throw new Error('handler threw');
    if (u.searchParams.get('t') === 'reject')
        event.respondWith(Promise.reject(new Error('rejected')));
    if (u.searchParams.get('t') === 'notresponse')
        event.respondWith(Promise.resolve('not a response'));
});
