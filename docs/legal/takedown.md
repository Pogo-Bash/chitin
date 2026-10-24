> **Draft — not legal advice; to be reviewed by a lawyer before publication.**

# Licence violations, clone sites and misuse of the name: how the project responds

Version: DRAFT 0.1 (2026-10-11).

What this is for: copies of Chitin that break the licence (for example ad-funded "unblocked" clone sites that
copy the code and carry advertising), and uses of the Chitin name that mislead. It describes what the project
will do, in what order, with templates. It also tells other people how to report misuse.

What this is not: a licence to bully. The aim is narrow: remove clear violations, as gently as
works. A takedown notice is a legal statement made under penalty of perjury, and a careless one can make the
sender liable (17 U.S.C. 512(f)). Where in doubt, ask the lawyer first, or do nothing and watch.

[LAWYER: decide whether notices should always go out on a lawyer's or agent's letterhead.]

## 1. Know what can be claimed

1. **Only Chitin's own code and assets are covered by the noncommercial licence.** The engine is mostly
   Ladybird's code under BSD-2-Clause, which lets anyone use it commercially if they keep the notices. A site that
   copies only Ladybird's code is not breaking Chitin's licence by running ads, though it still has to keep
   Ladybird's copyright notice and licence text. Before sending anything, identify which files or assets in
   the copy are Chitin-authored. (Chitin-authored files should carry an SPDX header, or live in directories the repository lists as
   Chitin-authored; that list does not exist yet, so create it first.)
2. **Violations of the PolyForm licence** are mainly: using or sharing Chitin's code for commercial purposes (ads,
   payment, selling access); distributing without the licence terms or the `Required Notice:` line; and
   anything else outside the licence. The licence says a violator who is told in writing and comes into full
   compliance within 32 days keeps their licences; otherwise they end. So the first step is a *notice of
   violation* (template A), not a takedown.
3. **Trademark and "passing off"** is a separate claim: using the name or logo in a way likely to confuse about
   affiliation or source. The US statute is 15 U.S.C. 1125(a)(1)(A) (false designation of origin,
   "likely to cause confusion ... as to the affiliation, connection, or association ... or as to the origin,
   sponsorship, or approval"). Hosts treat these through their own trademark or impersonation policies rather
   than through the DMCA.
4. **Registration.** In the US, a copyright owner generally must register before suing for infringement, and
   statutory damages and attorney's fees are limited for infringement that began before registration (17 U.S.C.
   411(a), 412). A DMCA notice to a host does not require registration, but a lawsuit does. See
   `docs/legal/README.md` section 5.7.

## 2. Identify copies (provenance)

The engine carries structural watermarks and behaviour fingerprints (planned: `docs/provenance.md`).
How they may be used:

- Use them to *recognise* a copy: load the suspect site in a clean browser profile, read whatever a test
  page or the public build identifiers show, compare file hashes and unique strings with the official
  build, and compare the dates. Do this without logging in, without bypassing anything and without sending
  data to the suspect site beyond ordinary page requests.
- Record evidence: date and time (UTC), the exact URL, screenshots, saved copies or archive links of
  the pages and files, the hashes, the method used, and which of the project's own files match. Keep it.
  If the copy is later changed, you still have the record.
- Be honest about confidence. Levels: (1) identical files or strings (strong); (2) fingerprints and
  watermarks match (strong, explain how they work if asked); (3) looks similar (not enough alone).
- Check for innocent explanations before acting: a compliant fork (renamed, noncommercial, notices intact)
  is allowed; a research group, school or charity using it noncommercially is allowed; the "copy" may be
  Ladybird-only; the site may be an official mirror.
- The marks are build identifiers. They must never identify a user. If a mark ever turns out to be able to
  identify a person, stop using it and tell the lawyer. (`docs/legal/README.md` sections 5.7 and 6.)

## 3. Order of response

1. **Verify** (section 2). Write down the claim in one sentence: which Chitin-authored work, in what form, is
   being used how, in breach of what term.
2. **Contact the operator** (template A). Use contact details on the site, the WHOIS record or the repository.
   Say what is wrong and what putting it right means (remove the ads and payments, restore notices,
   rename, or take it down). Give 32 days, which is the licence's own period, or a shorter period if the
   lawyer agrees for trademark confusion. Keep a copy of what you sent and when.
3. **If there is no cure, or the operator is hidden:** send a DMCA notice to the host (template B). Find
   the host from the site's DNS, IP address and hosting information. If the site is behind a CDN or proxy
   such as Cloudflare, use the CDN's abuse form (template C), which forwards complaints to the real host.
4. **Impersonation or confusion:** send the host a trademark/impersonation report (template D), citing the
   host's own policy.
5. **Other channels** (check each one's current policy before use; I have not read them all): the domain
   registrar's abuse process (registrars generally act on illegal activity and on their own terms; a DMCA
   notice is not what they normally require), search engines' copyright removal forms, app stores or code
   hosts if the copy is there, and the advertising networks whose ads fund the clone site (ad networks have
   policies of their own about copyright and about misleading sites).
6. **Escalate** to the lawyer if: the operator replies with a counter-notice (section 4), the violator is a
   business, there is money involved, or there are threats.
7. **Record** what was done in a log: date, who, what, result.

## 4. If a counter-notice arrives

A host that took material down after a DMCA notice must give the user notice and, under 17 U.S.C. 512(g),
restore the material after a valid counter-notice in roughly 10 to 14 business days unless the copyright owner
has filed a court action. So: when a counter-notice comes in, send it to the lawyer immediately. Decide
within a few days whether to sue (needs registration, section 1.4) or let the material go back up. Do
not ignore it.

A copyright owner or its agent can also ask a US court clerk for a subpoena to identify an alleged infringer
(17 U.S.C. 512(h)); that is a lawyer's job.

## 5. Templates

Fill in the square brackets. Do not change facts to make them stronger. Send these from a mailbox that can be
answered. Keep a copy.

### Template A: notice of licence violation, to the operator of a copy

```
Subject: Notice of violation of the PolyForm Noncommercial License 1.0.0 (Chitin)

To: [operator / contact]
From: [OWNER NAME] ([LEGAL EMAIL])
Date: [DATE]

I am the copyright holder of Chitin, which is licensed under the PolyForm Noncommercial License 1.0.0
(https://polyformproject.org/licenses/noncommercial/1.0.0; the text is in LICENSE.md in the repository at
[PROJECT URL]).

I believe that the site at [URL] ("the site") is using [copying / distributing / hosting] Chitin's code
in a way the licence does not allow:

- [e.g. the site contains advertising / takes payment for access, which is not a noncommercial purpose]
- [e.g. the copy does not include the Required Notice line or a copy of the licence terms]
- [e.g. the site uses the name Chitin / my logo for a modified or unofficial copy (see TRADEMARKS.md)]

Evidence: [files, strings, hashes, build identifiers that match; dates; screenshots / archive links].

This is notice in writing under the "Violations" section of the licence. If you come into full compliance
with the licence, and take practical steps to correct past violations, within 32 days of receiving this
notice, your licences can continue. Otherwise, all your licences end immediately and further use is
unlicensed.

To comply, please: [list: remove the advertising and payments, or take the site down; restore the notices;
rename and rebrand as described in TRADEMARKS.md; stop describing it as official]. Please reply by [DATE]
to confirm what you have done.

I reserve all rights, including the right to notify your hosting provider.

[OWNER NAME]
```

### Template B: DMCA notice of claimed infringement, to a host (17 U.S.C. 512(c)(3)(A))

A notice must substantially contain each of the six items below or it may not count. Send it to the
host's designated DMCA agent (the US Copyright Office keeps a directory at https://dmca.copyright.gov/osp/,
or look on the host's site).

```
Subject: DMCA notice of claimed infringement: [URL]

To: Designated Agent, [HOST]
From: [OWNER NAME], [address], [phone], [email]
Date: [DATE]

1. I am the owner of the copyright in the work(s) identified below, or am authorised to act on the
   owner's behalf.
   [signature: physical or electronic]

2. Copyrighted work(s) claimed to have been infringed: Chitin, [list the specific files or
   components, e.g. "the shell and glue code in the repository at [PROJECT URL], files [paths]"],
   first published [DATE]. [US copyright registration number(s), if any.] It is available under the
   PolyForm Noncommercial License 1.0.0, which permits noncommercial use only.

3. Material claimed to be infringing and its location: [exact URLs on your service, and the file
   names / paths that contain the copied material]. [Short explanation of how the material matches: e.g.
   identical files, build identifiers, hashes.]

4. My contact information: [name, postal address, telephone, email].

5. I have a good faith belief that the use of the material in the manner complained of is not
   authorised by the copyright owner, its agent, or the law. [The site is using the code for commercial
   purposes (advertising), which the licence does not allow.]

6. The information in this notice is accurate, and, under penalty of perjury, I am authorised to act on
   behalf of the owner of an exclusive right that is allegedly infringed.

Please remove or disable access to the material identified above.

[signature]
[OWNER NAME]
```

Check before sending: have I identified specific Chitin-authored material (not Ladybird-only code)?
Did I consider whether this is a licensed use? Is the claim true? (512(f).)

### Template C: report to a CDN or reverse proxy that forwards complaints

Cloudflare's published approach (https://www.cloudflare.com/trust-hub/abuse-approach/): for sites that use its proxy
and CDN it forwards complaints to the website operator and the host, and gives the host the origin IP address,
because it "cannot remove from the Internet content that it does not host"; content it hosts itself (Pages, Workers,
Stream and similar) goes through the notice-and-takedown process; complaints go through the abuse form at
abuse.cloudflare.com. Use the same text as template B in the form, add that you are asking the CDN to forward it and
to provide the host's identity if its policy allows. Check the CDN's current policy first.

### Template D: trademark / impersonation report to a host or platform

```
Subject: Trademark and impersonation report: [URL / account]

To: [Trust & Safety / abuse contact of HOST or PLATFORM]
From: [OWNER NAME] ([LEGAL EMAIL])
Date: [DATE]

I am the owner of the CHITIN name and logo for the Chitin software project ([PROJECT URL]). The project's
only official presence is [OFFICIAL ORIGIN] and [REPOSITORY URL]. Its trademark policy is at
[TRADEMARKS URL].

The [site / account / app / package] at [URL] uses the name [and logo] in a way that is likely to cause
confusion as to source or affiliation: [describe: e.g. presents an unofficial copy as official; is named
"Chitin Unblocked"; displays advertising under our name].

Evidence: [screenshots, archive links, dates].

I have not authorised this use. Please [remove / suspend / rename] it under your [trademark / impersonation
/ brand policy: LINK]. If you require a different form or more information, please tell me.

[OWNER NAME]
```

## 6. How others can report misuse

Anyone may write to [LEGAL EMAIL] (see `TRADEMARKS.md` section 7) with: the address and a screenshot or
archive link, the date seen, what looks wrong (using the Chitin name or logo, copying the code with ads or
payment, claiming to be official, scam or unblocker marketing), and their contact details. We will look at
reports, may ask for more detail, and may contact the site and its host. We cannot tell you the outcome in
every case, and we will not act on reports we cannot verify. Do not send us anything unlawful (for example
leaked material); describe what you saw.

Reports of misuse of Tor's name go to the Tor Project (tor-brand@rt.torproject.org), not to us.

## 7. If the project is asked to take something down

If someone sends the project a notice (copyright or trademark) about Chitin's own site or repository: do not
ignore it and do not reply to the sender alone. Forward it to the lawyer. If the project ever hosts
users' content, set up a designated agent first (17 U.S.C. 512(c)(2), renewable every three years under
37 CFR 201.38). Today the project hosts none.

## 8. Log

Keep a table of every case: date found, URL, claim, evidence location, step taken, date, reply, result, lawyer
involved. It is your best protection if a notice is ever challenged.
