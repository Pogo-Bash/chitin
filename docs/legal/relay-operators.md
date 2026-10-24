> **Draft — not legal advice; to be reviewed by a lawyer before publication.**

# Running a Chitin relay: disclaimer and operator guide

Version: DRAFT 0.1 (2026-10-11).

Read this before you run the Chitin relay. By running it you accept the points in section 1.

Background: Chitin is a web browser that runs inside a web page. When it is not routing through Tor, it
sends each connection to a relay, and the relay opens the connection to the website on the user's
behalf. **The project does not run any relay.** It publishes the relay software as a Docker image, and
anyone can run one. The design and the sources behind the defaults are in `docs/research/relay.md`.

## 1. The disclaimer

1. **You are the operator, and you are responsible.** Traffic that leaves your relay comes from your
   server and your IP address. Websites, hosting providers, abuse desks, police and courts will see you,
   not the project and not the user.
2. **The project provides software only.** It does not run, monitor, vouch for, certify, insure or
   indemnify your relay or any other. There is no warranty of any kind (see `LICENSE.md` and `TERMS.md`
   sections 10 and 11). The software may have bugs, including security bugs. You run it at your own risk.
3. **The project does not receive your logs, your users' data or any report from you.** You are
   the only one who can answer abuse reports and legal requests aimed at your relay.
4. **You must follow the law** where your server is, where you live and (as far as it applies to you)
   where your users are, and **you must follow your hosting provider's acceptable-use policy.** Many
   providers do not allow public proxies, VPN-like services or anything that looks like scanning, and a
   complaint can get your account locked or closed. Read the policy before you start (section 8).
5. **The licence.** The relay is part of Chitin's own code and is under the GNU General Public License,
   version 2 or (at your option) any later version (`LICENSE.md`). You may run it for any purpose,
   including as a paid service or inside a company. If you distribute it, modified or not, the GPL's terms
   apply, including offering the source. The rest of this guide still applies however you run it.
6. **Do not describe your relay as official** or use Chitin's name or logo in a way that suggests the
   project runs, backs or endorses it (`TRADEMARKS.md`). Do not advertise it as a way to bypass school,
   work or other filters; your wording can create liability for you (see `docs/legal/README.md` section 5.1).
7. **You must not loosen the safe defaults to run an "open" relay for strangers** unless you have taken
   advice and accept the consequences. If you do change them, say so to your users.
8. **If something goes wrong,** that is between you, your users, your host and the authorities. The project
   is not a party and cannot help with legal matters.

## 2. Who should and should not run one

Safest: a relay for yourself, your family, or a small group of people you know, where you can
decide who gets in and stop them if needed.

Think hard before: a relay open to the public. Public relays attract abuse (scanning, spam, harassment,
copyright complaints, worse), and the abuse is attributed to you.

Do not run one if you are not willing to answer an abuse email within a day or two.

## 3. Keep the safe defaults

These are the settings the image is designed to ship with, taken from `docs/research/relay.md`. Do
not turn them off. [The relay image does not exist yet; check the release notes for the version you run.]

| Setting | What it does | Why |
|---|---|---|
| **Port allowlist** | Only allows connections to a short list of ports, for example 80, 443, 22 and 9418 (git), 21, plus DNS to the relay's own resolver (53/853). Everything else is refused. If you need a blocklist, include at least the Tor default rejects (25, 119, 135-139, 445, 563, 1214, 4661-4666, 6346-6429, 6699, 6881-6999) and block 465/587. | Stops mail spam, file-sharing and most abuse. Many hosts block port 25 anyway. |
| **No private or special ranges** | Refuses destinations in private, loopback, link-local, carrier-grade NAT, benchmarking, reserved and multicast ranges, the cloud metadata address 169.254.169.254, and your own and your provider's addresses. Checks the *resolved* IP and connects to that same IP; does not follow redirects. | Stops users reaching your internal network or cloud credentials (a "server-side request forgery"). |
| **No inbound or listening ports** | The relay opens outgoing connections only. | Stops it becoming a way to host abusive services. |
| **Rate and quota limits** | Bandwidth caps, limits on new connections per user and per IP, and caps on simultaneous streams in total and per destination. | Limits damage from one user, and keeps costs bounded. |
| **Scan detection** | Counts distinct destinations and ports per user per minute and the share of failed connections; throttles, then blocks. | Hosting providers ban scanning outright, so one user's scan can close your account. |
| **Tokens, not open access** | Users need a short-lived signed token; the relay also checks that the request comes from the expected web origin (a browser safeguard, not authentication). | So that you can stop one user without stopping everyone, and so repeat offenders can be cut off. |
| **Minimal logs** | See section 5. | Less to leak, less to be forced to hand over. |
| **UDP only for DNS (and port 443)** | No general UDP. | Stops reflection and scanning abuse. |

## 4. Abuse contact and handling

- Publish a working abuse contact: an `abuse@` mailbox for your domain (RFC 2142), a `security.txt` at
  `/.well-known/security.txt` (RFC 9116), reverse DNS on the relay's egress address that names the
  service, and a short notice page on port 80 of the egress address explaining that this is a relay and
  how to reach you. Keep your registered contact in WHOIS/RIR records up to date.
- Use dedicated egress IP addresses, separate from any website you run, so a blocklisted address does
  not take your website down.
- Reply promptly. Keep a folder of reports and what you did.
- Be ready to cut off a user (revoke their token) when a report is credible. This is also what
  repeat-infringer policies expect (see `docs/legal/README.md` section 5.2).
- Have a plain-language template reply: what a relay is, that you did not initiate the traffic, that it
  is encrypted end to end between the user and the site so you cannot see content, what you can and cannot
  tell them, and what you are doing about it. The Tor Project publishes abuse reply templates and
  exit-operator guidance that can be adapted: https://community.torproject.org/relay/community-resources/tor-abuse-templates/
  and https://community.torproject.org/relay/community-resources/tor-exit-guidelines/
- Copyright complaints: in the US, a relay that only forwards data may fall within the "transitory digital
  network communications" safe harbor of 17 U.S.C. 512(a), which depends on conditions (including a
  repeat-infringer policy) and is a question for your own lawyer; elsewhere other rules apply. Do not
  copy or inspect content to decide.
- Law-enforcement requests: get legal advice before answering anything beyond the minimal logs you actually have.
  You cannot give what you do not keep.

## 5. Logs

- **Never log the content** of what users send or receive. In many places recording the content of
  communications is itself unlawful. (The Electronic Frontier Foundation's guidance for Tor operators says the same.)
- Keep only per-connection metadata, for as long as you need to answer an abuse report: the user or
  token ID, start and end time, the egress source address and port, the destination IP and port, and bytes
  sent. `docs/research/relay.md` suggests keeping this for about 7 to 14 days and then deleting it. Counters
  used for rate limiting can live in memory only.
- **Data protection.** IP addresses can be personal data under laws such as the GDPR and the UK GDPR, and
  you may be a "controller" of what you log: you need a lawful basis (usually legitimate interests, with
  a written balance), a short retention period, security, and a way to answer people who ask what you hold.
  Publish what you keep and for how long. `docs/legal/PRIVACY.md` section 4 tells users that relays can
  log, so tell them what yours does.
- **Children.** Chitin's Terms bar under-13s and require permission for 13-17, but you cannot rely
  on that. If you issue accounts, collect an email address, or otherwise collect personal information, US
  COPPA and the UK and EU children's rules may apply to you. The simplest approach is to issue
  tokens without collecting personal details. Read `docs/legal/README.md` sections 5.3 and 5.4.

## 6. Tell your users

Show a short notice with your relay (Wisp v2 has a "message of the day" feature meant for this): who
you are, how to reach you, what you log and for how long, the rate limits and blocked ports, and that
they must follow the law and `ACCEPTABLE_USE.md`.

## 7. What you should not do

- Do not market the relay as unblocked, free proxy or VPN, or as a way past school or work filters.
- Do not monitor, alter, inject into or sell the traffic. (Chitin does TLS inside the engine, so a relay
  cannot see secure content; if you ever find your relay can, stop and report it to the project's security contact.)
- Do not give out tokens to people you cannot stop.
- Do not run Tor exit-style services on the same address as a website you care about.
- Do not run it somewhere your provider forbids it. Hosting providers differ widely. The Tor Project's
  community list of relay-friendly providers (https://community.torproject.org/relay/community-resources/good-bad-isps/,
  cited in `docs/research/relay.md`) is a useful signal, not a guarantee, and may be out of date.

## 8. Before you start: checklist

- [ ] I have read my hosting provider's acceptable-use policy and it allows this, in writing if possible.
- [ ] I know the law where I live and where the server is on running a proxy, on logging, and on
      data protection. I have taken advice if I am running it for anyone beyond myself.
- [ ] I have an abuse contact that works, a notice page, and reverse DNS.
- [ ] I am keeping the port allowlist, private-range block, rate limits, scan detection and no inbound ports.
- [ ] My logs are metadata only, with a short written retention period, and I have written down what I keep.
- [ ] I will not collect anything from children, or I have checked the rules.
- [ ] I understand I am responsible, the project is not, and there is no warranty.
- [ ] If I distribute the relay (or a changed copy), I pass on the source, the licence and the notices.
- [ ] I will not call my relay official or advertise it as a way past filters.

## 9. Updating

Keep the image updated. Security fixes are published in the repository. The project cannot force you to
update; a relay that is not updated is your risk.

## 10. Contact

General: [CONTACT EMAIL]. Security issues in the relay software: [SECURITY EMAIL].
The project cannot give legal advice or handle abuse reports for your relay.
