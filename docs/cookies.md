# Cookies (M4)

Built 2026-10-22 on branch `cookies`. HTTP cookies for the engine's own network, kept the way Chrome keeps them
(RFC 6265bis, draft 20, plus Chrome's own rules where the draft leaves room), with one difference by design for third-party
subresources (below). Compared against Chrome for Testing 154 on our own two-site server (`make chrome-test`, group
"cookies").

## Where the cookies are

```
 carapace (our origin, no site code)
   CookieStore (harness/carapace/cookie-store.mjs): every cookie of the browser
     IndexedDB 'chitin-cookies': persistent cookies, AES-GCM, non-extractable key in the same database
     memory: session cookies (for the life of the carapace, a browser session)
        ▲ changes (checked)            │ the records a segment may hold, at start; other segments' changes
        │                              ▼
 segment of site S (its own origin, its own process)
   jar (glue/cookies.js createJar), in the engine glue
     the engine asks it for each request's Cookie header and gives it each response's Set-Cookie (Host.cpp, Network.cpp)
     document.cookie reads it (page_did_request_cookie) and writes it with the raw string (patch 0041)
```

- **One store, per site of the cookie.** The carapace's store is the only place all cookies are. A cookie belongs to the
  registrable domain of its Domain (Public Suffix List: `third_party/psl`, the copy the engine's libpsl has, private rules
  included as Chrome does). Two tabs of one site, or a site at top level and the same site in a cross-site iframe, share its
  cookies: each live segment keeps a copy of what it is entitled to and the store forwards every change to the others.
- **What a segment may hold** (cookie-store.mjs `entitled`): the unpartitioned cookies of its own site (the segment is that
  site's process anyway, its engine sends them), and the partitions of its own context: `<top-level schemeful site> 0` for a
  top-level segment, `<top-level site> 1` for a cross-site iframe's segment (CHIPS keys, with Chrome's cross-site ancestor
  bit). The store refuses any other record a segment sends and counts a strike against it (guard.mjs); the records a segment
  starts with are only its own. So **a segment never receives another site's unpartitioned cookies**.
- **HttpOnly never reaches page code.** The jar's `forScript` (document.cookie) drops HttpOnly cookies, a script cannot set
  or replace one, and Set-Cookie is removed from every response after the jar took it (Host.cpp, Network.cpp; Chrome's
  network service does the same), so neither LibWeb nor the page's service worker nor the host's WebSocket code ever sees it.
  The jar runs in the realm page code shares (the segment Worker), so it is written like the rest of the glue: every builtin
  captured before page code runs, lists without prototypes while they are filled, the change messages posted with the
  host's captured `postMessage`. Cookie values go from the jar into engine memory directly (`ganglion_host_cookie_get`).
- **The relay never sees a cookie.** TLS is the engine's; the relay and Spiracle carry ciphertext. Cookies are added to
  the request inside the engine, after the page's service worker had its look (a `FetchEvent` has no Cookie header, as in
  Chrome).
- **At rest.** Persistent cookies are written as AES-GCM ciphertext (a random IV per row) under a non-extractable
  `CryptoKey` that lives in the same IndexedDB: script on the carapace origin can use it but cannot read it out, and a copy
  of the profile's files does not hold readable values without the browser's key storage. Session cookies are never
  written. `?cookies.persist=0` keeps everything in memory (tests that start empty).

## What the jar does (glue/cookies.js)

Parsing (6265bis 5.6): the first `;` ends name=value; no `=` is a nameless cookie; empty name and value is refused; a
control character other than HTAB anywhere refuses the cookie (Chrome's CookieControlCharacters); name + value over 4096
bytes is refused, an attribute value over 1024 is ignored; Expires by the cookie-date algorithm (a date that does not exist,
such as 30 Feb, or a year before 1601 is ignored); Max-Age (digits with an optional `-`; zero or less is "expired") wins over
Expires; both are capped at 400 days. Domain loses a leading dot; Path must start with `/` or the default path is used;
SameSite `Strict`/`Lax`/`None`, anything else is "unspecified"; `Partitioned`.

Storage (6265bis 5.7 and Chrome):
- Domain: a public suffix only as the host itself (then host-only), else refused; it must domain-match the host; an IP host
  takes no other Domain.
- `Secure` only from a secure URL: https, wss, or a potentially trustworthy http host (`localhost`, `*.localhost`, loopback),
  as Chrome allows. An insecure URL may not set a cookie that would shadow a Secure one (same name, domains matching either
  way, path within): "leave secure cookies alone".
- `HttpOnly` from a script is refused, and a script cannot replace an HttpOnly cookie.
- Prefixes, case-insensitively: `__Secure-` needs Secure from a secure URL; `__Host-` also host-only and Path `/`. A nameless
  cookie whose value starts with a prefix is refused.
- SameSite: `None` needs Secure (Chrome). `Lax`, `Strict` and unspecified are refused from a cross-site context (a cross-site
  subresource, a script in a cross-site iframe), but kept on the response to a top-level navigation.
- `Partitioned` needs Secure; it is kept under the context's partition key. Without a top-level site (no partition) the cookie
  is unpartitioned.
- Replacing a cookie keeps its creation time; an expiry in the past deletes it.
- Limits (Chrome's CookieMonster, simplified): over 180 cookies of one site in one jar the least recently used go, non-Secure
  first, down to 150; a partition keeps at most 10 KiB of one site's cookies; over 3300 in all the least recently used go
  down to 3000.

Sending (6265bis 5.8, Chrome's SameSite and schemeful same-site):
- host-only / domain-match, path-match, Secure only to a secure URL, HttpOnly not for a script. Order: longer paths first,
  then the older. `name=value` joined by `; `, a nameless cookie as its value alone.
- The context: a segment's documents have the site for cookies of their top-level document (schemeful: http and https of
  one domain are two sites), except a cross-site iframe's segment, whose site for cookies is null.
  - Same-site request (subresource, frame navigation, WebSocket, script): all SameSite values.
  - Cross-site subresource or a request from a cross-site iframe: `None` only.
  - Top-level navigation (the first document of a segment, every hop of its redirects): Lax and unspecified always with a
    safe method; Strict only when the page that asked for the navigation was same-site or the user typed it (the carapace
    passes the asking segment's schemeful site as the initiator, `null` from the address bar). With an unsafe method
    (POST), Chrome's "Lax-allowing-unsafe": a cookie without SameSite that is under two minutes old still goes.
- Credentials modes are LibWeb's Fetch (omit, same-origin, include, and CORS's Access-Control-Allow-Credentials); a request
  that does not include credentials neither sends nor stores cookies.

## Third-party cookies: Chrome's default and Chitin's difference

Chrome 154 allows third-party cookies by default (Google kept them in 2025 instead of phasing them out; Incognito blocks
them). The chrome-test group shows it: a `SameSite=None; Secure` cookie that ckb.localhost set on a credentialed fetch from
a www.cka.localhost page is sent by Chrome when ckb.localhost is later visited at top level.

Chitin follows that default **for cross-site iframes**: a cross-site iframe is a nested segment of its own site, so it gets
its site's unpartitioned `SameSite=None` cookies and may set them, as in Chrome.

It differs **for cross-site subresources** (a fetch, an image, a script of another site from a page). Here the request is
made by the top-level page's segment: TLS is in that segment's engine, so whatever cookie goes on the wire is in that
segment's memory first. Sending ckb's own cookies would hand them to cka's process, which the security model does not allow
(docs/security.md item 2: a segment never reads another site's cookies). So a cookie set or sent on a third-party
subresource lives in the top-level site's partition (bucket `<partition key>\tu`): it works within the same top-level site
(set on one request, sent on the next, as in Chrome), it is never sent when ckb is visited itself, and ckb's own cookies are
never sent from cka's page. This is the same shape as Safari's and Firefox's partitioned third-party cookies. The chrome-test
group checks that this is the only difference. Measured (Chrome 154): A's credentialed fetches to B carried B's own `fu`, `fjs` (set by the B iframe) and also `fp`, a cookie
the iframe set with `Partitioned` (so Chrome's partition for A's own subresources and for the B iframe in A was the same
there); Chitin sent only `tp`. B at top level got `tp` in Chrome, not in Chitin. Every other request and every document.cookie
matched.

## Where each piece is

| Piece | File |
| --- | --- |
| Parser, storage model, retrieval, SameSite, CHIPS, PSL, limits | glue/cookies.js (bundled into the engine glue; build/cookies.mjs for the carapace and tests) |
| The Public Suffix List as a constant | tools/psl-gen.py, third_party/psl/public_suffix_list.dat (MPL-2.0) |
| Cookie header and Set-Cookie per request, hop by hop | engine/platform/Host.cpp (loader, `submit_to_network`), Network.cpp (`fetch_document_step`, `cookie_header`, `store_cookies`) |
| document.cookie | Host.cpp `page_did_request_cookie`, `ganglion_document_set_cookie` (patches/ladybird/0041) |
| WebSocket handshake | Host.cpp `ganglion_tunnel_open` (the engine adds Cookie and takes Set-Cookie; websocket.js never sees them) |
| A page's service worker's and dedicated Workers' fetch() | harness/segment/pagesw-host.js `netFetch` (credentials mode), Host.cpp `ganglion_net_request` |
| The store, entitlement, persistence, clear | harness/carapace/cookie-store.mjs, carapace.js (Cookies panel: per-site clear) |
| The segment's side | harness/segment/worker.js (init records, `cookies` messages both ways) |
| Message shape | harness/carapace/guard.mjs (`cookies`) |

The site rule for segments (guard.mjs `siteOf`, glue/engine/50-frames.js `urlSite`) is the same PSL now, so a segment's
site and a cookie's site always agree (`user.github.io` is its own site, as in Chrome).

## Clearing

The carapace's side panel lists the sites with cookies (how many, how many partitioned) with a **clear** button each.
Clearing a site removes its cookies everywhere (its own jar and its cookies in other sites' partitions) and every partition
whose top-level site it is, from the store, from IndexedDB and from every live segment at once (Chrome's "delete site data"
for cookies).

## Tests

- `make test`: tests/cookies.test.mjs (parsing, dates, storage, prefixes, SameSite contexts, CHIPS, third-party partitions,
  limits, the store's entitlement and clear).
- `make engine-js-test`: tests/cookies-net.test.mjs (the engine over local https: a document's Set-Cookie, HttpOnly hidden
  from document.cookie, Set-Cookie hidden from fetch, credentials modes, redirect hops, cross-site fetch, top-level
  navigation initiators, a nested segment, Partitioned from document.cookie, the WebSocket handshake).
- `make chrome-test` group "cookies" (`CHITIN_ONLY=cookies`): the Set-Cookie matrix and every request's Cookie header,
  Chitin against Chrome, plus the panel's clear and persistence across carapaces with ciphertext at rest.
- `make wpt`: the cookies/ areas of tools/wpt/subset.json (attributes, domain, encoding, name, value, ordering, path, size,
  prefix, secure, samesite, samesite-none-secure, schemeful-same-site, partitioned-cookies, third-party-cookies).

## Not done

- The Cookie Store API is LibWeb's (`cookieStore.get/getAll/set/delete` over the jar: names and values, writes as a script's);
  its `change` events, `Partitioned` in `set()` (LibWeb's FIXME) and `cookieStore` in workers are not there.
- `cookiechange` events, `navigator.cookieEnabled` beyond LibWeb's, the Storage Access API (`document.requestStorageAccess`),
  Related Website Sets, `Cookie` priority (`Priority=High`), Chrome's per-cookie size reporting, origin-bound (scheme/port)
  cookies (behind flags in Chrome 154, off).
- SameSite across a redirect chain of a navigation (Chrome downgrades Strict when a hop is cross-site): each hop is judged
  by the navigation's initiator only.
- Form POST navigations to another site become GET navigations in a new segment (the carapace's navigate-request carries
  no body yet), so the POST rules apply only to same-segment POSTs.
- The panel lists sites, not individual cookies, and there is no "block third-party cookies" setting.

## Results (2026-10-22)

- `make test` 82/82, `make engine-test` 13/13, `make engine-js-test` 250/251 (the media clock test that fails on main too under
  this load), `make chrome-test` 239/240; the one failure was the frames check, whose expectation is now corrected (not re-run) (a child's `document.cookie`
  without SameSite is refused in a cross-site iframe, as Chrome does); group "cookies" 7/7.
- WPT cookies/ areas (docs/results/wpt-cookies-2026-10-22.json): Chitin 202 subtests pass (of 745 reported) against Chrome's
  346/861; before M4 the cookies area passed 6. Most of the gap is cookies/samesite (11/34 against 107/128) and
  third-party-cookies, whose tests open windows (`window.open` is blocked in a segment, docs/wpt.md item 10) or time out;
  cookies/path and prefix lose tests that time out on the fallback-font load, not on a cookie answer.
