> **Draft — not legal advice; to be reviewed by a lawyer before publication.**

# Chitin Privacy Notice

Version: DRAFT 0.1 (2026-10-11). Last updated: [DATE].

The short version: **the Chitin client collects nothing and sends nothing to the project.** What you
browse and what is stored stays in your own browser. But your traffic still goes through other people's
computers, and this page tells you who can see what.

## 1. Who we are

[OWNER NAME] publishes Chitin ("the project"). Contact: [CONTACT EMAIL].

## 2. What Chitin collects: nothing

- No accounts, no sign-in, no analytics, no tracking, no advertising, no crash reports, no usage
  statistics, no "phone home". The project does not receive your browsing history, your IP address from
  the client, your settings or any identifier.
- The project does not run a relay. Nothing you browse passes through any server the project operates.
  [LAWYER AND OWNER: this must stay true. If it stops being true, update this page first.]
- The engine in Chitin carries build identifiers (marks that show which build a copy came from; see
  `docs/provenance.md` when written). They identify the software, never you. They are not sent anywhere.

## 3. What is stored, and where

Everything Chitin stores is stored by your own browser, on your own device, for the site (origin) that
needs it: cookies, local storage, IndexedDB, caches, your bookmarks, history, settings and downloads.
The project cannot see it. Each site you visit runs in its own sandbox with its own storage, so one site
cannot read another's.

To clear it: use Chitin's "new identity" (molt) option for a site, clear the data in your host
browser's settings, or clear all site data for [OFFICIAL ORIGIN] in your host browser. Private
browsing in your host browser may erase it when you close the window.

## 4. What other people can see

Chitin does not make you invisible. Depending on how you use it:

| Who | What they may see |
|---|---|
| **The website you visit** | Normal website things: your IP address (the relay's or Tor's exit address if you use them, otherwise your own), what you request, cookies the site itself set, and what your browser reveals about itself. |
| **The relay you connect through** | Your IP address, the destination host name and port of each connection, when it happened and how much data moved, and any token or account the operator issues. Chitin does the encryption of secure website connections inside the browser, so a relay should not be able to read the content of those connections, but it can see where they go. A relay can log what it sees. |
| **Tor** (if you choose it) | The first Tor relay you use sees your IP address (or the address of whatever you reach it through: see below). The exit relay sees where you are going and the content of connections that are not themselves encrypted. The website sees the exit relay's address. |
| **Your network** (school, work, home, ISP, a cafe) | That you are using a Chitin page, and the address of the relay or the Tor entry you connect to. They may not see which sites you visit, but they may see how much data you use and when. Anyone who monitors your network may be able to tell Tor is in use. |
| **The host of the web app** | See section 6: whoever delivers the Chitin web page to your browser sees the request for it. |

**Relays are run by third parties.** Whoever runs the relay you use decides what to log, how long to keep
it and what to hand to authorities. Their own privacy policy and the law where they live apply. The project
does not control it and does not receive it. `relay-operators.md` asks operators to keep logs minimal, but
we cannot check it.

## 5. Tor: what it does and does not do

- "Route through Tor" hides your IP address from the websites you visit by sending traffic through the Tor
  network. **It does not make you anonymous.** Websites can still recognise you from your logins, your cookies
  and how your browser behaves. Chitin is a very small user group with its own browser fingerprint, so it is
  easier to single out than the Tor Browser, which is built to make everyone look the same.
- If Chitin reaches Tor through a relay, that relay can see that you are connecting to the Tor network and when
  (it cannot see inside the Tor connection). If your network blocks Tor, Chitin can use a transport meant
  for that case; it may reveal different things to different parties.
- If you need real anonymity, use the Tor Browser.
- Tor is a separate project. "Tor" is a trademark of The Tor Project; all rights reserved. Chitin is not
  endorsed or sponsored by, or affiliated with, the Tor Project. https://torproject.org

## 6. Where Chitin's web page comes from

The Chitin web app is delivered to your browser as files from [OFFICIAL ORIGIN], which is served by
[HOSTING PROVIDER / CDN]. [OWNER: fill this in once chosen.] When your browser asks for those files, that
provider normally sees your IP address, the time, the file requested and your browser's
user-agent string, and it may keep that in logs for [RETENTION PERIOD]. The project uses this only to keep
the site working and secure, does not combine it with anything, does not use it for advertising or
profiling, and [does not / cannot] see the provider's logs. The provider's own privacy policy applies:
[LINK]. The project adds no cookies, no third-party scripts, no fonts from other servers, and no analytics
to the page. [LAWYER AND OWNER: confirm each of these statements is true of the chosen host before publishing.]

If you run Chitin from your own copy of the files, none of this applies to the project.

## 7. Children

Chitin is for people 13 and older (see `TERMS.md`). It is a general-purpose browser, not aimed at
children, and it collects nothing from anyone, including children. We do not knowingly collect anything from a
child under 13. If you are a parent or guardian and have questions, write to [CONTACT EMAIL].

## 8. Your rights

Because the project holds no data about you, there is nothing for it to give you, correct or delete.
If you have questions about data held by others (a relay operator, a website, your host's logs for the web app),
ask them. Laws such as the GDPR and the UK GDPR give you rights over data held about you by those who hold it.

## 9. Changes

We will change this page if Chitin's behaviour changes, and the date at the top will change. Any change that
means the project would collect something will be shown clearly before it takes effect.

## 10. [Section to fill in only if the project ever runs a demo site or accounts]

**Do not publish a demo site, accounts, a newsletter, analytics or a hosted relay until the sections below are
done and a lawyer has reviewed them.** See `docs/legal/README.md` sections 5.3 and 5.4 for why.

Fill in:

- **What is collected**, field by field: (e.g. IP address, account name, email address, token ID, settings, anything else).
  Collect the least that works.
- **Why** each item is collected and the legal basis if the GDPR or UK GDPR applies (consent is hard with minors;
  legitimate interests need a written balance).
- **Who sees it:** the project, a hosting provider, any other processor (list them).
- **How long it is kept,** and when it is deleted.
- **Where it is stored,** and any transfer across borders.
- **Children:** age screen design (neutral, collect nothing before it; see the FTC's COPPA FAQ), what happens
  to under-13s (blocked; nothing else collected), what happens for 13-15/16 (parental consent where Article 8 of
  the GDPR or UK law requires), and a check against the UK Children's code if the site is available in the UK.
- **Rights and contact:** how to ask for access, correction or deletion, and who the contact is
  (and the representative in the EU/UK if one is required).
- **Security:** what is done to protect it, and how breaches will be handled.
- **Cookies and similar:** list any, and say so on the page.
- **A data protection impact assessment,** short and written down.
- **Terms and acceptable use** for the site, and a DMCA agent if users can post anything.
