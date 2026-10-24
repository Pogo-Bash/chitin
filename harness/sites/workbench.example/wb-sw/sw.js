// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// The workers section's service worker: answers /wb-sw/<mode>/hello itself, passes everything else through.
const L = [];
self.addEventListener('install', () => { L.push('install'); self.skipWaiting(); });
self.addEventListener('activate', (e) => { L.push('activate'); e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
    const u = new URL(e.request.url);
    if (u.pathname.endsWith('/hello')) e.respondWith(new Response('from sw ' + L.join(',') + ' ' + e.request.mode + ' ' + e.request.destination, { headers: { 'x-sw': '1' } }));
    else if (u.pathname.endsWith('/page.html')) e.respondWith(fetch('/wb-sw/page.html'));
});
