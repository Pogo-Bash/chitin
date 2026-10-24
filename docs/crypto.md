<!-- SPDX-License-Identifier: GPL-2.0-only
     Copyright (c) 2026 [OWNER NAME]
     Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL]) -->

# WebCrypto and the event loop's microtask checkpoints

## Whose `crypto` the page has

A page's `crypto`, `crypto.subtle`, `Crypto`, `SubtleCrypto` and `CryptoKey` are the engine's (LibWeb's
`Libraries/LibWeb/Crypto`, through the regenerated bindings): `crypto` is one of the Window members that replace the
segment Worker's own (glue/engine/40-bridge.js `WINDOW_OVERRIDES`). The host's `crypto` is used only by the glue and the
harness (random bytes for the engine's WASI `random_get`, the WebSocket mask, segment labels), never handed to the page.

## One task, then the microtasks

HTML's event loop runs one task and then performs a microtask checkpoint. Page JavaScript runs on the host's V8, whose
promise jobs and `queueMicrotask` callbacks run only when the host's stack unwinds: before 2026-10-22 one `engine.pump()`
(and the engine's own pumps inside a host call: network bytes, frame grants) ran every due task, so two `setTimeout(0)`
callbacks, a timer and a message, or a crypto result and a timer ran back to back and all their microtasks came after the
last of them. Chrome: `T1, T1.p, T1.q, T2, T2.p ...`; Chitin was `T1, T2, A0, T3, ..., T1.p, T1.q, T2.p ...`.

Now (glue/engine/30-host.js "One task, then the microtasks", engine/platform/EventLoop.cpp): every host import that can
reach page code (a call, a construct, a script or module, a property access on a page object) marks the host turn; while
the mark is set the engine's event loop runs nothing (`ganglion_host_turn_pending`), and a host task of ours (a
MessageChannel message, which is not clamped as nested timeouts are) clears it and pumps again. That task runs after the
host's microtasks, so each engine task that ran page code is followed by the page's microtasks before the next task. Tasks
that run no page code (network bytes, layout, a rendering step without callbacks) still run back to back. Rendering
opportunities do not gate this: a frame grant is an ordinary pump.

Not covered: the engine's own microtask queue (LibWeb "queue a microtask": mutation observer delivery, some IndexedDB steps)
is drained in the engine's checkpoint right after the task, before the host's; a page that interleaves a MutationObserver
callback with promise reactions of the same task can see them in another order than Chrome.

## Crypto results settle in tasks, in call order

WebCrypto's operations "return promise and perform the remaining steps in parallel", then queue a global task on the
crypto task source to settle it. Upstream Ladybird made digest, encrypt, decrypt, sign and verify do that (1ac12651f6 and
its neighbours); generateKey, importKey, exportKey, deriveBits, deriveKey, wrapKey and unwrapKey still settled the promise
from the deferred invocation itself, ahead of every queued crypto task and outside any task (an importKey started after a
digest settled first). Patch 0047 runs their remaining steps in a crypto task queued from the in-parallel point, so every
operation settles in call order, one task each. In this single-threaded build "in parallel" is a deferred invocation on the
same thread; the bytes of every BufferSource are copied by the call (changing the input after the call changes nothing).

Chrome 154 differs from the spec here: it settles most operations inside the call (their reactions run before a promise
reaction queued after the call in the same task, and several results' reactions run in one checkpoint); only PBKDF2 goes to
a worker thread and settles after the next timer. Chitin follows the spec, so a page sees the same relative order of
results as in Chrome, and each result's reactions before the next result's; it does not see the results before its own
later microtasks. tests/subtle-expected.mjs holds Chrome's logs and says which parts are compared exactly.

## getRandomValues, randomUUID

`crypto.getRandomValues` returns the same array, fills every integer typed array, and throws TypeMismatchError for float
arrays and DataView and QuotaExceededError over 65536 bytes, with Chrome's messages (glue/engine/45-surface.js
`shapeCrypto`: the engine's JS runtime has no DataView, the bridge handed it the bytes as a Uint8Array and it filled them).
`randomUUID` gives a version 4 UUID. SubtleCrypto has Chrome 154's members: the ML-KEM `encapsulate*`/`decapsulate*`
methods LibWeb has are removed (`shapeSubtleCrypto`).

## Tests

- tests/subtle.test.mjs (engine-js-test) and the chrome-test group "subtle" (`CHITIN_ONLY=subtle`) over
  harness/sites/subtle.example.
- `make wpt DIRS=WebCryptoAPI` (in tools/wpt/subset.json, cap 40). 2026-10-22: Chitin 7439 and Chrome 9296 of 10456
  subtests over 40 files, no harness errors. The gaps are LibWeb's algorithms, not ordering: symmetric importKey
  validation (166), AES-GCM IV lengths (112), generateKey failure cases for AES-CTR, RSA-PSS (public exponent), ECDH, HMAC.
- An OfflineAudioContext fires `complete` before `startRendering()`'s promise resolves (patch 0048, as Chrome): with one
  microtask checkpoint per task the spec's order (resolve, then a task for the event) became observable.
