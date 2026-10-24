# Operators: what hosting Chitin and a relay makes you responsible for

Status: 2026-10-21. Plain-language orientation, **not legal advice**. The longer draft for relay
operators is docs/legal/relay-operators.md (also not legal advice, marked for lawyer review). Read both
before you put anything on the public internet.

## The project runs no public service

The Chitin project does not host a relay, a Tor exit, a proxy or an open Chitin site for the public.
The only thing it runs is an allowlisted demo for named people. Everything below is about **you**
hosting Chitin (the pages: carapace, segment files, wasm) and, separately, a **relay** for it. The two
are different jobs with different exposure.

## Hosting the Chitin pages

You serve static files: the carapace page, the segment origin (a wildcard host such as
`*.your-sites.example`), the engine wasm. This is an ordinary website. Your responsibilities are the
ordinary ones (TLS, keeping the files current, the headers in harness/segment-headers.mjs, a privacy
notice for whatever your web server logs). It does not send anyone's browsing anywhere by itself.

Two caveats. A segment host must serve only our files (no open redirects, no proxying), because the
segment Worker's CSP names it. And the pages are only as safe as the relay and Tor setting they point
at.

## Running a relay: you are the visitor, to every site your users open

When a user of your Chitin site opens a page, the engine inside their browser tab speaks TLS to the
site, and your relay carries those bytes to the site's server. The site sees **your relay's IP
address**, not the user's. That is the point and it is the whole risk:

- **Abuse reports come to you.** Hosting providers, the abuse contact on your IP's WHOIS record, and the
  sites themselves will see your address attached to whatever a user did: scanning, credential
  stuffing, scraping, harassment, fraud, copyright infringement, worse. You cannot see the content (TLS
  is end to end between the engine and the site), only metadata: when, how much, to which host and
  port if you log it.
- **Your IP's reputation is shared by every user.** One abusive user gets the address blocklisted, and
  then it fails CAPTCHAs and bot checks for everyone, and for any other service on the same address.
  Keep the relay on its own address. A datacenter address is flagged by bot-management systems by
  default (docs/security.md section 3); that is not something configuration fixes.
- **Your hosting provider's rules apply.** Many forbid open proxies, VPN-like services or anything that
  looks like scanning, and will suspend the account on a complaint. Read the acceptable-use policy first.
- **Legal exposure depends on where you are and where the traffic goes, and it is not settled.** In
  general terms: many jurisdictions treat a pure conduit that does not choose, modify or inspect traffic
  more leniently than a host or a publisher, but that protection can depend on conditions (acting on
  notices, repeat-infringer policies, not knowingly facilitating), differs between countries, and does
  not stop police or civil claimants from contacting you, seizing equipment, or asking for logs. Some
  places regulate anonymising or circumvention services, some require data retention from
  communications providers, some penalise helping people bypass filters. Telling users "this evades
  your school or employer filter" can create liability for you. Talk to a lawyer where you live before
  you offer a relay to anyone you do not personally know.
- **Tor.** Chitin's Tor mode is meant to run Tor's own client inside the user's browser tab; the relay
  then carries Tor cells to Tor guards, and your IP is the user's apparent *entry* to the Tor network,
  not an exit. That is a much smaller risk than a clear-web relay, and still not nothing (some networks
  and providers dislike Tor traffic, and the relay sees timing and volume). If you ever run a Tor
  **exit** you are in a different and heavier category (the Tor Project publishes guidance for exit
  operators); Chitin does not need you to, and this project does not ask you to.
- **You hold personal data.** Connection logs with client IPs are personal data in many places (GDPR and
  similar). Decide what you keep, why, and for how long, and say so to your users.

## Restricting what your relay will do

The shipped relay (relay/relay.py, relay/README.md) already defaults to the cautious side: ports 80 and
443 only, no private, loopback, link-local or cloud-metadata destinations (checked on every resolved
address; the relay's own addresses and `168.63.129.16` too), caps on streams and new connections per
socket and per client (IPv6 per /64; `--trusted-proxy` behind a reverse proxy), a global connection cap,
byte caps on buffered data, a cap on concurrent name lookups, a default bandwidth cap of 8192 KiB/s
per socket, scan throttling, an Origin check, an optional shared secret, no inbound ports,
metadata-only logs. Do not loosen those. Note what the Origin check is not: any non-browser client
can send any Origin, so a relay without a shared secret is open to everyone who reads the page source.
If the machine has a public address that is not on one of its interfaces (NAT, a floating IP), pass it
with `--own-address`.

For anything beyond yourself, narrow it further:

1. **Run it for a known group.** Shared secret (`--token-file`), the exact web origins you serve
   (`--origin`), and bind to the interface you mean (`--bind`). Rotate the secret when someone leaves.
2. **Allowlist destinations if you can.** The strongest restriction is the one rvwasm's relay uses:
   only named hosts, not "the internet". relay.py has one now: `--host-allow PATTERN` (a name,
   `*.suffix`, repeatable) or `RELAY_HOSTS`. It is required: with no list the relay refuses to start,
   and `--allow-any-host` (an open proxy to the internet) must be said out loud. The Docker image
   defaults to the demo's hosts. The list is checked before any DNS lookup, on top of the port and
   address-range filters, which stay. A demo for a handful of sites can be
   completely closed this way, and then there is almost nothing to abuse.
3. **Rate limits.** `--max-streams`, `--max-connects-per-minute`, `--max-conns-per-ip`,
   `--max-connections`, `--max-kbps` (default 8192; `0` is unlimited), `--max-lookups`,
   `--max-lookups-per-connection`, `--conn-idle-timeout`, `--scan-hosts-per-minute`,
   `--scan-failures-per-minute`. Set them to what your users need, not what the machine can take.
   Behind a reverse proxy, add `--trusted-proxy` with the proxy's address, or every user shares one
   client's limit.
4. **Logging choices.** The relay logs connections by default (`--log 1`) and per-stream destinations
   only on request (`--log 2`); it never logs content. Each step up is more to protect and more to be
   asked for. A common choice: connection logs with a short retention (days), stream logs only while
   investigating a specific report. `--log 0` leaves you unable to answer an abuse report with anything
   but "we do not know", which some hosts will not accept.
5. **Be reachable.** A working abuse mailbox, reverse DNS that names the service, a notice page on the
   egress address saying what it is and how to contact you, and a way to cut off one user without
   stopping everyone. docs/legal/relay-operators.md section 4 has the details.
6. **Say what you are.** Do not present your relay as official or run it under Chitin's name
   (TRADEMARKS.md).

## What the project does and does not do for you

It publishes software under the licence in LICENSE.md, with the defaults above. It does not monitor,
vouch for or insure any relay, does not receive your logs, and cannot answer a legal request on your
behalf. If you cannot take an abuse email within a day or two, do not run a relay.
