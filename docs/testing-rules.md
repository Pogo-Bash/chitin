# Testing rules

House rules for Chitin's comparison testing (Chitin vs Chrome for Testing, per spec). Agents follow these.

## Determinism
- Pin what can be pinned (seeds, the workbench clock) and prove it by reading the value back, not by the run passing.
- Give each pinned random source its own stream; pages draw randomness from more places than `crypto.getRandomValues`.
- Counters shared between the two sides of a comparison are scoped to a realm (frame or worker), never to a thread or process.
- A determinism claim needs N identical runs (N >= 5), not two that happen to agree.
- Groups of a run do not share state: each chrome-test group runs in a browser context of its own (cookies, storage, service
  worker registrations, tabs), so a full run answers as each group does alone.

## Process
- Read the output: grep build and test logs for errors and counts; an exit status alone proves nothing.
- Test topologies, not just pages: multi-frame, cross-site frames, workers, service workers.
- A page loading is not proof of where its bytes came from; check the request log.
- "Not visible to reflection" is not "no observable effect"; test behaviour, not just shape.
- A metric nobody reads is not a metric: every count we collect lands in a report or a gate.

## Recording and replay (workbench, corpus)
- Key recorded responses by URL plus ordinal; keep headers, status and redirects.
- A replay miss is a reported divergence, not a silent error.
- Both sides read from stores that are equally permissive.
- Remember side channels that skip the normal fetch path (`sendBeacon`, prefetch, workers) when recording.
- Never label bytes with a content encoding they are not in.

## Method
- Fix divergences by matching the spec and Chrome's observable behaviour, never by special-casing a test or a site.
- Ladybird and Chrome are the references; when they disagree, the spec decides.
