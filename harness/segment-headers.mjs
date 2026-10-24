// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Response headers for a segment's files (docs/security.md section 1.2, layer 1). Kept apart from the
// server so tests/escape.test.mjs can check them without opening a port.

// Powerful features a segment never gets itself. Anything the user grants is the carapace's prompt plus
// an engine-side capability. Set on the document (its Worker inherits) and repeated on the Worker script.
const PERMISSIONS_POLICY = [
    'camera', 'microphone', 'geolocation', 'usb', 'serial', 'hid', 'bluetooth', 'payment',
    'publickey-credentials-get', 'identity-credentials-get', 'browsing-topics', 'local-fonts',
].map((feature) => `${feature}=()`).join(', ');

// The segment *document* holds the page's capture tracks for it (docs/webrtc.md): camera, microphone and display capture are
// its own (self), asked of the carapace first and then of the host's prompt; its Worker, where page code runs, keeps none.
const DOCUMENT_POLICY = PERMISSIONS_POLICY.replace('camera=(), microphone=()', 'camera=(self), microphone=(self), display-capture=(self)');

export function segmentHeaders(kind, { CARAPACE, ORIGIN_HOST }) {
    const common = { 'Cross-Origin-Resource-Policy': 'same-origin', 'Permissions-Policy': kind === 'document' ? DOCUMENT_POLICY : PERMISSIONS_POLICY };
    if (kind === 'document')
        return {
            ...common,
            'Document-Isolation-Policy': 'isolate-and-require-corp',
            'Content-Security-Policy': [`default-src 'none'`, `script-src 'self'`, `worker-src 'self'`, `connect-src 'self'`, `media-src blob:`, `style-src 'unsafe-inline'`, `frame-ancestors ${CARAPACE}`].join('; '),
        };
    if (kind === 'worker')
        // Page JS runs in this Worker. The policy is the backstop under the deleted host APIs
        // (worker.js): a door nobody remembered still cannot connect anywhere. connect-src is this
        // origin (the engine's own files) and, in the phase-0 harness, the network stand-in; Spiracle
        // lives in the carapace, so nothing else is needed. script-src keeps https: for exactly one
        // reason: V8's module loader asks for the site's real URLs and the segment's service worker
        // answers them; worker.js refuses to run any page script without that service worker.
        return {
            ...common,
            'Content-Security-Policy': [
                `default-src 'none'`,
                `script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' https:`,
                `connect-src 'self' http://${ORIGIN_HOST}`,
                `worker-src 'none'`,
                `img-src 'none'`,
                `font-src 'none'`,
                `media-src 'none'`,
                `object-src 'none'`,
                `base-uri 'none'`,
            ].join('; '),
        };
    if (kind === 'pagesw')
        // The runner of a page's own service worker: no engine, no stand-in, no network at all. Its scripts are this
        // origin's (the runner, and the site's worker through the mirror, which the segment's service worker answers).
        return {
            ...common,
            'Content-Security-Policy': [
                `default-src 'none'`,
                `script-src 'self' 'unsafe-eval'`,
                `connect-src 'none'`,
                `worker-src 'none'`,
                `img-src 'none'`,
                `font-src 'none'`,
                `media-src 'none'`,
                `object-src 'none'`,
                `base-uri 'none'`,
            ].join('; '),
        };
    if (kind === 'sw')
        // script-src 'self': the service worker's own importScripts (the import maps' parser, /chitin/acorn.js and
        // /chitin/specifiers.js); nothing else.
        return { ...common, 'Content-Security-Policy': `default-src 'none'; script-src 'self'`, 'Service-Worker-Allowed': '/' };
    return common;
}
