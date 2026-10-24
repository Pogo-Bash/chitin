<!--
SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
Copyright (c) 2026 [OWNER NAME]
Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
-->
# Third-party sign-in: the provider's step happens in your real browser

When a page in Chitin starts "Sign in with Google / Apple / Microsoft / GitHub / ..." Chitin does **not** show the identity
provider's login page inside itself. It hands that step to your real browser and brings the result back. This follows
RFC 8252 ("OAuth 2.0 for Native Apps", section 8.12): an embedded user agent should not host the provider's login, because
the embedding app could read what you type, and because you have your passwords, passkeys and existing sessions in your
real browser, not in Chitin. Providers block embedded logins for the same reason (Google refuses them outright).

What Chitin never does: read, store or send your credentials or tokens. The provider's page runs only in your real browser.
The site's own pages, before and after, run in Chitin as usual; tokens stay in the site's own flow (its cookies, its
storage, its messages between its own windows).

## What you see

1. You click "Sign in with X" on a site in Chitin.
2. Above the page, the carapace shows **"Continue sign-in in your browser"**: which site wants you to sign in, with which
   provider, and the provider's address. Buttons: *Continue sign-in in your browser*, *Cancel*.
3. *Continue* opens the provider's page in a real top-level window of your browser (`window.open` from the carapace, on your
   click; `noopener`, so that page gets no handle on Chitin). You sign in there.
4. The provider sends that window to the site's return address (its `redirect_uri`). Copy that page's address from the
   address bar and paste it into the box Chitin now shows, then *Return to <site>*. Chitin checks the address (below) and
   opens it in the site's segment, where the site's own return page finishes the sign-in with Chitin's cookies and storage
   for that site. The pasted address is used once and not kept.
5. *Cancel* drops it; for a popup flow, the site's page sees its sign-in window as closed (as if you had closed it).

The header also has **"open in your browser"**: the page shown, opened in your real browser, for anything Chitin cannot do.

### What counts as a sign-in page (harness/carapace/signin.mjs)

- Known provider hosts (accounts.google.com, appleid.apple.com, login.microsoftonline.com, login.live.com, ...), and known
  sign-in paths on mixed hosts (github.com/login/oauth, facebook.com/dialog/oauth, discord.com/oauth2/authorize, x.com
  /i/oauth2/authorize, ...).
- Any OAuth 2.0 / OpenID Connect authorization request: a URL with `client_id` plus `response_type` or `redirect_uri`
  (Auth0, Okta, Keycloak, Cognito, a site's own provider).

### Which pasted addresses are accepted

- http(s) only; on the same site (registrable domain) as the page that started the sign-in, since it runs in that site's segment.
- When the request named a `redirect_uri`: the same origin and path (only the query/fragment the provider added may differ).
- Anything else is refused with a reason in plain words.

## Which flows work, honestly

| Flow | Works? | How |
|---|---|---|
| **Redirect** (the page navigates to the provider, the provider redirects back) | Yes | The top-level navigation to a sign-in page (a link, `location.assign`, or a server's 302 to the provider) becomes the handoff. The pasted return address loads in the tab; the navigation's initiator is the provider's site, so SameSite=Lax cookies (the state cookie) go with it, as in Chrome. |
| **Popup + postMessage to the opener** (Auth0 `loginWithPopup`, most hand-written popup flows, `targetOrigin` = the site's origin) | Yes | `window.open` with a user gesture returns a cross-origin WindowProxy stand-in. After paste-back the return page runs in a hidden **popup segment** of the site whose `window.opener` is a stand-in for the opener; its `postMessage` reaches the opener through the carapace (origin stamped, `targetOrigin` checked, `event.source` is the popup), and its `window.close()` closes the popup (`popup.closed` becomes true). |
| **Popup + the opener polls the popup's location** (MSAL.js `loginPopup`) | Yes | While the popup segment shows a page of the opener's own origin, the stand-in's `location` is readable (href, search, hash, ...); `popup.close()` closes it. |
| **The site's own page in a popup** (same site, e.g. `/auth/start` that then redirects to the provider) | Yes | It runs in the popup segment (not shown); when it navigates to the provider, that is the handoff. |
| **The real browser delivering the result by itself** (no paste) | No | The real window is outside Chitin: its page is on the site's real origin, and its opener (if it had one) would be the carapace, whose origin is not the site's, so the browser drops the site's `postMessage(…, siteOrigin)`. A carapace-hosted relay page would need the site to register a redirect URI on Chitin's origin, which is a change to the site's configuration; Chitin does not do that. Keeping an opener handle would also let any page the site sends you to navigate Chitin's own window, so the real window is opened `noopener`. |
| **FedCM** (`navigator.credentials.get({ identity })`, Google One Tap in Chrome) | No | It is a browser-mediated API whose token comes back through the browser itself; nothing can be handed off. Chitin's engine does not offer it, so sites fall back to their popup or redirect flow (Google Identity Services does). |
| **Popups opened without a user gesture** | No (as in Chrome) | The popup blocker: `window.open` returns null. |
| **Window features** (`noopener`, `noreferrer`) | Yes | `window.open` returns null, as in Chrome; the window is still opened (handed off or a popup segment), and its page gets no opener. |

Caveats, also honest:

- **Your real browser loads the return page first.** Before you paste it, the site's return page runs in your real browser,
  where it is usually harmless: a server that checks its `state` (cookie or session) refuses there without redeeming the
  code (the mock shows "state mismatch"); a popup page finds no opener. A site whose return page redeems the code without
  checking state would use it up there, and the pasted copy then fails; that site needs "open in your browser".
- **Implicit-flow tokens in the fragment** pass through the address you copy. That is your own token moving between your own
  browsers; Chitin uses it once and keeps nothing.
- The popup segment is not shown: return pages post and close. A popup of the site's own that wants to be seen (a share
  dialog of the same site) runs invisibly; the panel's "open in your browser" is the way out.
- Popups opened from a cross-site iframe (a nested segment) or from a popup are not handled yet (the status panel says so).
- `window.open` from a same-site frame's realm (55-realms.js) still goes to the engine (null).
- The stand-in's same-origin `location` is a read-only copy (href, origin, protocol, host, hostname, port, pathname, search,
  hash, assign, replace); `popup.document` stays inaccessible. A flow that reaches into the popup's DOM does not work.

## How it is built

- **Engine glue** (glue/engine/52-popups.js): replaces the global's `open` (and, in a popup segment, `opener` and `close`) when
  the global is installed (40-bridge.js `globalReplacements`, which now accepts a function that wraps the engine's own member).
  With transient activation (`navigator.userActivation.isActive`) and an http(s) or empty URL, it makes a stand-in
  (50-frames.js `makeRemoteWindow` with a popup's `closed`, `close`, navigating `location`) and asks the host
  (`callbacks.popups.open`). Without activation, or for `_self`/`_parent`/`_top`, the engine's own `open` runs.
- **Segment Worker** (harness/segment/worker.js): `popup-open`, `popup-navigate`, `popup-close`, `window-close` to the carapace;
  `popup-state` from it.
- **Carapace** (harness/carapace/carapace.js; rules in signin.mjs, checks in guard.mjs, routing in frames.mjs): the handoff
  panel, popup segments (`startSegment` with `popup`: first-party cookies of the site, hidden, not composited), `opener` /
  `popup:<id>` postMessage routing with the same origin rules as frames, and the redirect-flow interception in
  `navigate-request`. At most 4 open windows per page; one handoff at a time.

## Tests

- `tests/popups.test.mjs` (Node, in `make engine-js-test`): gesture and popup blocker, the stand-in, popup + postMessage,
  popup + polling, origin checks, signin.mjs rules.
- `tests/chrome/run.mjs` group "sign-in handoff" (`CHITIN_ONLY=oauth`): a mock relying party (rp.cka.localhost,
  harness/sites/rp.example) and a mock provider on another site (ckb.localhost, harness/sites/idp.example). Each flow runs in
  Chrome itself, then in Chitin with the provider in a real window of the same Chrome and the address pasted back; the outcomes
  must match Chrome's, and the provider's server must never see a request from Chitin's engine.
- Owner steps: docs/user-tests/oauth.md.
