> **Draft — not legal advice; to be reviewed by a lawyer before publication.**

# Chitin: legal documents, lawyer checklist and issues memo

Written 2026-10-11 by the project's drafting assistant (an AI), not by a lawyer. Everything here is a
starting point for a lawyer to correct. Nothing here is legal advice, and nothing here should be
published, relied on or presented to users as legal advice until a qualified lawyer has reviewed it
for the jurisdictions that matter.

How this was researched: statute, regulation and court texts were read from official or
near-official sources (listed in section 7 with what each was used for). Where a source could not be
read, or a point rests only on a secondary source or on my own understanding, the text says so. If a
claim below has no source and no "unverified" label, treat that as my mistake and tell the lawyer.

## 1. What is in this folder

| File | What it is | Who it is for |
|---|---|---|
| `../../LICENSE.md` | GNU GPL version 2, official text unchanged; Chitin's code is GPL-2.0-or-later (SPDX headers and the `Required Notice:` line in each file) | everyone who copies or changes the code |
| `TERMS.md` | Terms of Use for anyone using a Chitin build or a site running Chitin | users |
| `ACCEPTABLE_USE.md` | Plain-language rules on what Chitin must not be used for | users, operators |
| `PRIVACY.md` | What Chitin does and does not do with data; a template for a demo site | users |
| `relay-operators.md` | Disclaimer and guide for people who run the Docker relay | operators |
| `../../TRADEMARKS.md` | Name and logo policy; forks must rename | forks, press, anyone |
| `takedown.md` | How the project handles licence (GPL) violations by clone sites; templates; how to report misuse of the name | the owner, hosts, reporters |
| `rvwasm-notes.md` | Checklist: what changes if these documents are reused for rvwasm | the owner |
| this file | overview, lawyer checklist, issues memo, sources | the lawyer, the owner |

Placeholders to fill in everywhere: `[OWNER NAME]`, `[PROJECT URL]`, `[OFFICIAL ORIGIN]`,
`[CONTACT EMAIL]`, `[ABUSE EMAIL]`, `[LEGAL EMAIL]`, `[GOVERNING LAW]`, `[VENUE]`. No name has been
invented.

## 2. The shape of the project, as it matters legally

From `README.md`, `docs/architecture.md`, `docs/plan.md` and `CREDITS.md`:

- Chitin is a browser that runs in a web page. Each site runs in its own sandbox with a rendering
  engine built on Ladybird (BSD-2-Clause). Network traffic leaves through a relay or through Tor.
- The relay is not hosted by the project. It ships as a Docker image and whoever runs it is
  responsible for the traffic through it. The project collects no data.
- Chitin's own code is GPL-2.0-or-later. The engine carries watermarks and behaviour
  fingerprints. There is a trademark policy. Forks must rename.
- Users may be 13-17, and the tool can be used for good reasons (privacy, access) and bad ones
  (breaking laws, or breaking a school's or employer's network rules).
- It must never be marketed as a school or firewall unblocker.

Two facts the "collects nothing" line depends on, which the lawyer should keep in view:

1. Somebody serves the web app. `docs/architecture.md` says the shell page lives on "our origin
   (e.g. `chitin.app`)". Whoever hosts those files (a static host, a CDN) sees visitors' IP
   addresses in the normal course of serving them. The project's own client collects nothing, but
   the delivery path is not nothing. See 5.3 and 5.4.
2. `docs/architecture.md` still describes "Relay: our servers", "signed, short-lived tokens per
   account" and "the public relay" in phase 3, while `docs/plan.md` (decision of 2026-10-11) says there
   is no hosted relay. The architecture text needs to be brought in line before anyone reads it
   as a statement about what the project does. If the project ever mints accounts or tokens itself,
   the privacy and children's-privacy analysis below changes (5.3, 5.4).

## 3. Messaging rules (these follow from the memo and are the cheapest protection)

Why: sections 5.1 and 5.3 explain that how the product is described is evidence of what it is for,
under copyright inducement law and under the US children's privacy rule. These rules are suggestions
for the owner to adopt and for the lawyer to tighten.

Do not, anywhere (site, README, store listings, social posts, videos, replies to users, issue
tracker, domain names, search-engine keywords, file names):
- say or imply "unblock", "unblocked", "bypass", "get around", "evade", "defeat", "beat" or
  "undetectable" about a school, workplace, library, parental-control or ISP filter or monitoring;
- name schools, students, classrooms, Chromebooks, "free time", or "games" as an audience or use case;
- say "anonymous", "untraceable" or "invisible" about any mode (see `TERMS.md` section 7);
- suggest using it for piracy, scraping against a site's rules, scanning, spam or any other thing
  `ACCEPTABLE_USE.md` forbids; name or list piracy sites, even as examples;
- use a "Napster alternative" style comparison to a tool that was shut down for illegal use;
- give support (in chat, issues or email) on how to defeat a particular filter or monitor;
- make a clone or mirror easier, or offer rotating domains whose purpose is to stay ahead of a
  filter list.

Do say (accurate and still compelling):
- "A web browser that runs inside a web page. Every site runs in its own sandbox."
- "Route through Tor: hides your IP address from the sites you visit. It does not make you anonymous."
  (Wording from `docs/research/tor.md`.)
- "You are responsible for following the law and the rules of the networks you use."
- For access: describe the underlying need (privacy from sites, working on locked-down devices where
  you are allowed to install nothing and the device's owner permits it) only with the permission
  qualifier. Ask the lawyer to approve wording for censorship circumvention before it is used.

Review marketing the way a hostile lawyer would: read the page as if it were Exhibit A.

## 4. Checklist for the lawyer

### 4.1 Decisions to confirm with the owner first

- Who is the legal person behind "the project"? An individual (personal liability), an LLC or
  company, a nonprofit, or a fiscal sponsor? Which one would hold the copyright, the trademark and
  any DMCA agent registration? (Everything is currently written as `[OWNER NAME]`.)
- Where is the owner, and where are the likely users? These choose the governing law (4.3).
- Will the project ever run a demo site, accounts, a hosted relay, an extension or theme store, a
  forum, or any user-generated content? Each one changes the answers in 5.2, 5.3 and 5.4. The
  documents assume the answer is "no" and say what to do if it becomes "yes".
- Is the web app (the shell page) served by the project, or only offered as source/Docker to be self-hosted?
- Is a copyright registration in the US wanted? See 5.2 (registration gates suits and some remedies).

### 4.2 Open questions, most important first

1. **Marketing and product design (5.1).** Review the messaging rules in section 3 and the design
   choices in section 6. Is the line between "censorship circumvention is a legitimate use" and
   "school/work filter evasion" workable in public text, given that `docs/research/relay.md` and
   `docs/research/tor.md` describe fallbacks designed for networks that block the relay or Tor?
2. **Children (5.3, 5.4).** The Terms bar under-13s and allow 13-17 with a parent or guardian's
   permission where local law allows. Is that the right shape? Is a first-run acknowledgement that
   stores nothing on any server enough, and does a self-declared age ever matter when nothing is
   collected? Can a minor be bound by Terms at all in the relevant jurisdictions?
3. **Is the delivery host a "collector"? (5.3, 5.4).** If a static host or CDN serves the shell page,
   does its logging make the project an "operator" under COPPA or a controller under GDPR/UK GDPR?
   Does the "support for the internal operations" provision cover log-only IP handling? Does COPPA's
   "operator" definition (commercial websites, nonprofit carve-out) reach a non-profit
   open-source project run by an individual?
4. **Licence structure (5.7).** (a) The GPL does not allow further restrictions (GPLv2 section 6), so the
   Terms' acceptable-use rules cannot be conditions of the code licence; confirm they work as a contract
   for project-run services and builds, and as rules for use of the name. (b) Whether serving the code
   (the shell and the wasm engine) to visitors' browsers counts as "distribution" under the GPL, so that a
   clone site must offer the corresponding source. (c) The engine is mostly Ladybird's BSD-2-Clause code.
   The GPL and any DMCA claim can reach only Chitin-authored code and assets. How should
   Chitin-authored files be identified (SPDX headers, a directory split) so claims can be specific?
5. **Provenance marks and DMCA 1202 (5.7).** Do the watermarks and behaviour fingerprints count as
   "copyright management information" (17 U.S.C. 1202(c) includes identifying numbers or symbols and
   terms of use)? Is removing them by a clone then actionable on its own? Conversely, any mark that
   is false, or that identifies a user, creates risk. Confirm the design rule in section 6: marks
   identify the work and build, never a person.
6. **Export controls (5.6).** Confirm the classification path for the shipped wasm (object code) and
   for the source, whether the Tor client or Chitin's own TLS counts as "non-standard cryptography"
   (which would trigger the BIS/NSA email notification), and confirm that GPL source
   counts as "publicly available". Confirm the position outside the US.
7. **Tor naming (5.8).** Is the feature label "Route through Tor" acceptable, and does the credits
   notice in `TRADEMARKS.md` meet the Tor Project's policy? Should the project ask Tor in writing?
8. **Relay operators (5.2, `relay-operators.md`).** Does the operator guide say enough to keep the
   project out of the operator's liability, and is the project exposed by shipping an image whose
   safe defaults it chose? Does the project become a "service provider" or a joint actor in any
   jurisdiction by publishing recommended settings and templates?
9. **The GPL and the aim.** The owner chose GPL-2.0-or-later (2026-10-23, replacing PolyForm
   Noncommercial). It allows commercial use, including ad-funded copies that follow its terms, so
   clones are now handled mainly through the trademark policy and GPL compliance (source, notices).
   "Or later" lets recipients use GPLv3 terms too. Is a contributor licence agreement or developer
   certificate of origin needed so the owner can enforce and, if ever needed, relicense?
10. **Trademark clearance (`TRADEMARKS.md`).** No search for existing uses of CHITIN has been done.
    Run clearance before registration or before building a brand on the name.
11. **Contractual form.** The Terms are drafted to be accepted on first run (click-through). Is
    that necessary, or does a notice plus the licence suffice? What is the enforceability of
    limitations of liability against consumers in the EU/UK/other places (statutory floors)?
12. **Liability caps and indemnities.** The Terms contain an optional user indemnity (marked). Keep
    it or drop it?
13. **Insurance and entity.** Is there cover (or is it affordable) for IP, media or cyber claims at
    this size?

### 4.3 Jurisdiction choice (for the lawyer to decide; the owner's location is not recorded here)

Considerations I can see, none of them verified against local law:
- The Terms need a governing law and a venue, left as `[GOVERNING LAW]` and `[VENUE]`. The natural
  choice is the owner's home jurisdiction or the jurisdiction of the entity chosen in 4.1.
- Consumer-protection rules in the user's own country may override a choice of law or venue for
  consumers, and may override limitations of liability. The Terms say so ("nothing limits rights that
  cannot be limited by law") but the lawyer should decide whether to add per-region clauses.
- The documents assume US law for copyright, children's privacy, computer misuse and export, and
  point out EU and UK rules where relevant. If the owner is outside the US, the US analysis may
  matter less for the owner and more for US-hosted infrastructure and US users.
- A representative or local presence may be required under EU/UK data protection law for a project
  outside those regions that processes their residents' data (GDPR Article 27; I did not read it
  and it matters only if the project ever processes personal data).
- Arbitration and class-action waivers are common in US consumer terms. I have not included any;
  say whether you want one.

### 4.4 Not researched (the lawyer should cover these)

CIPA (the US Children's Internet Protection Act, which governs school filtering funded by certain
programmes; the FCC page was not readable); the UK Computer Misuse Act 1990 and equivalents outside
the US; the EU Digital Services Act and the e-Commerce Directive in full (only the UK regulation
implementing the mere-conduit rule was read); the UK Online Safety Act; US Section 230; US state
laws (state computer-crime laws, California's and other states' children's privacy and age-appropriate
design statutes, state comprehensive privacy laws); sanctions law beyond the EAR's mention of OFAC;
EU/Wassenaar export rules beyond the US EAR; Ladybird's and Servo's own contribution terms and
trademark policy; patents (including those around video codecs and TLS).

## 5. Issues memo

Plain-language summaries of the law as I understand it from the sources in section 7. Short quotations
are marked. Where I say "the lawyer should check", it is a real open point.

### 5.1 Inducement and why marketing matters (copyright)

**What the law says.**
- *MGM Studios v. Grokster*, 545 U.S. 913 (2005): "one who distributes a device with the object of
  promoting its use to infringe copyright, as shown by clear expression or other affirmative steps
  taken to foster infringement, is liable for the resulting acts of infringement by third parties."
  The Court said that "mere knowledge of infringing potential or of actual infringing uses would not
  be enough" to make a distributor liable. What did tip the case: the companies marketed themselves
  as alternatives to Napster, answered users' requests for help finding and playing copyrighted
  material, depended for revenue on high-volume use that was mostly infringing, and made no effort
  to filter. The Court also described the older Sony (Betamax) rule: a product capable of substantial
  noninfringing uses does not by itself create liability.
- *Cox Communications v. Sony Music Entertainment*, No. 24-171 (decided March 25, 2026): a provider
  of a service is contributorily liable for a user's infringement only if it "intended that the provided
  service be used for infringement", shown by inducement or by a service tailored to infringement;
  knowledge that some users infringe is not enough. The Court also said the DMCA safe harbors create
  defences and do not themselves impose liability. It did not decide vicarious liability. I read the
  Cornell LII text and several law-firm summaries; the lawyer should read the opinion itself.

**What it means for Chitin.**
- Chitin has plainly substantial noninfringing uses (it is a general-purpose browser), and the
  project does not know of, filter or profit from specific infringements. On the current law, the main
  thing that could turn a neutral tool into an inducing one is the project's own words and conduct.
- That is why section 3 bans "unblocked", piracy examples and the rest, even though Grokster is about
  copyright and school filters are not copyright. Two reasons: copyright is the claim most likely to be
  made against a relay-based browser; and the same marketing would be Exhibit A in non-copyright
  claims, which have their own doctrines that I did not research.
- Ad-funded "unblocked" clone sites are the closest modern equivalent of the Grokster facts (revenue
  tied to volume, audience attracted by what the tool lets them evade). Their liability is theirs, but
  their existence next to the Chitin name is a reputational and enforcement problem, which is what
  `TRADEMARKS.md` and `takedown.md` address.
- Do not add features "tailored" to infringement (a built-in directory of piracy sites, pre-set
  scrapers, one-click download of streamed paid media, and similar).
- Inducement is about copyright. For a user who breaks a school or workplace rule, or breaks the law
  with the tool, the question is different (5.5). The lawyer should say whether the project has any
  exposure for "aiding" those uses and what words in the Terms best help.

### 5.2 DMCA section 512: the software publisher versus relay operators

**The text** (17 U.S.C. 512, read at Cornell LII):
- 512(a), *transitory digital network communications*: no monetary relief and limited injunctions for
  "transmitting, routing, or providing connections" for material, if: the transmission was initiated
  by someone other than the provider; it happens through an automatic process without selection of the
  material; the provider does not select the recipients except automatically; no copy is kept
  ordinarily accessible beyond what is reasonably necessary; and the material passes without
  modification. 512(k)(1)(A) defines the "service provider" for (a) as an entity offering transmission,
  routing or connections "between or among points specified by a user, of material of the user's
  choosing, without modification to the content".
- 512(b) caching and 512(d) information location tools have their own conditions.
- 512(c), *information residing on systems at the direction of users* (hosting): no liability if the
  provider lacks actual knowledge and is not aware of facts or circumstances from which infringement is
  apparent, acts expeditiously to remove on notice, does not receive a financial benefit directly
  attributable to the infringement when it has the right and ability to control it, and has designated an
  agent with the Copyright Office. Notices must contain the elements in 512(c)(3)(A) (signature,
  identification of the work, identification and location of the material, contact details, a good-faith
  statement, and an accuracy and authority statement under penalty of perjury).
- 512(i): every safe harbor is conditional on adopting and reasonably implementing a repeat-infringer
  termination policy (and telling subscribers) and on not interfering with "standard technical
  measures".
- 512(f): knowingly material misrepresentations in a notice or counter-notice create liability.
- 512(g): counter-notice and restoration process. 512(h): subpoena to identify an alleged infringer.
  512(j): limits on injunctions. 512(m): no duty to monitor.
- 37 CFR 201.38, "Periodic renewal" (read at eCFR): a designation of an agent expires three years after registration unless renewed.

**The publisher of Chitin.**
- The safe harbors protect a "service provider" against claims about material stored, transmitted
  or linked "at the direction of users". A project that only publishes software and documentation is
  not hosting users' material, so 512 is mostly irrelevant to it. Its exposure is secondary liability
  for the software itself, analysed under Grokster and Cox in 5.1.
- If the project ever hosts user content (a forum, a theme or extension store, bookmark sync, a demo
  site that stores anything users supply), 512(c) becomes relevant. Then: register a designated agent
  with the Copyright Office, publish the agent's details on the site, adopt a repeat-infringer policy,
  and renew every three years. Until then, none of that is required and the documents say the project
  hosts no user content.
- On the owner's side as a rights holder, 512(c)(3) tells the project how to write a takedown notice
  to a host, and 512(f) is the price of getting one wrong (`takedown.md`).

**Relay operators** (the people who run the Docker image):
- A relay that forwards a user's byte streams, selects neither material nor recipient beyond the
  user's own request, keeps no accessible copy and does not modify content looks like the 512(a)
  conduit. Because Chitin does TLS inside the engine, a relay carries ciphertext and cannot select or
  alter content, which helps with (a)(2), (a)(5) and with wiretap concerns.
- 512(a) has no notice-and-takedown step and no designated-agent requirement in its text, but the
  512(i) conditions still apply, and the repeat-infringer policy needs the operator to be able to
  identify and cut off repeat offenders. An open, tokenless relay cannot do that. Operators who want
  the protection should require per-user tokens or accounts (with the data protection consequences in
  5.3 and 5.4) or take other advice. Whether (a) protects a particular operator is for that operator's lawyer.
- The UK analogue is the "mere conduit" rule in regulation 17 of the Electronic Commerce (EC Directive)
  Regulations 2002 (read at legislation.gov.uk): no liability for damages or criminal sanction where the
  provider did not initiate the transmission, did not select the receiver and did not select or modify
  the information. The EU rule sits in the Digital Services Act, which I could not read.
- Safe harbors are about copyright (in the US). They do not stop law-enforcement requests, other
  claims, or the operator's hosting provider from closing the account. `relay-operators.md` says so.

### 5.3 US COPPA (children under 13)

**What I read** (16 CFR part 312, eCFR as of 2026-10-01; FTC COPPA FAQ):
- "Child" means under 13. The rule makes it unlawful for an operator of a website or online service
  *directed to children*, or an operator with *actual knowledge* that it is collecting personal
  information from a child, to collect it other than as the rule allows (312.3). In outline: notice,
  verifiable parental consent before collection, parental review rights, no over-collection as a
  condition of participation, and reasonable security.
- "Personal information" includes a persistent identifier that can recognise a user over time and
  across sites, and it names "an Internet Protocol (IP) address" as an example (312.2).
- "Operator" covers a person who operates a site or service and collects or maintains personal
  information from or about its users, where it is operated "for commercial purposes". The
  definition excludes a nonprofit entity that would be exempt under Section 5 of the FTC Act. The
  FTC FAQ (B.5) says COPPA applies to commercial sites and that most nonprofits are exempt. Whether a
  noncommercial open-source project run by an individual is "commercial" is not answered by anything I read.
- "Directed to children" is judged by subject matter, visual content, child-oriented activities,
  audio, models, advertising, and also "marketing or promotional materials or plans, representations to
  consumers or to third parties, reviews by users or third parties", with a "mixed audience" category
  (312.2). This is the second reason for the messaging rules: marketing to students would be evidence
  that the service is directed to children.
- The FTC FAQ (A.12, H.3, D.4) says a general-audience operator need not investigate age, gains "actual
  knowledge" when it later learns a user's age, and may use a *neutral* age screen; it should not
  invite false answers (for example by only accepting birth years that make the user 13 or older).
- Persistent identifiers collected solely to support the "internal operations" of the service (maintain
  or analyse functioning, perform network communications, security) can be collected without parental
  consent (FAQ I.2; the 312.2 definition of "support for the internal operations").
- The rule was amended in 2025: published April 22, 2025, effective June 23, 2025, with a general
  compliance date of April 22, 2026 (from law-firm summaries of the Federal Register notice, not the
  notice itself). The eCFR text I read already contains the amendments (for example biometric
  identifiers in the personal-information list).

**Analysis for Chitin.**
- The Chitin client collects nothing and sends nothing to the project, so the project does not
  collect personal information from anyone, children included. On that footing COPPA does not impose
  its notice-and-consent duties on the client. That is the position the Privacy document takes.
- The weak point is the delivery path in section 2 (host and CDN logs). If a host logs IP addresses,
  those logs include children's IPs. Log-only handling for operating and securing the service falls
  within the "internal operations" provision on its face, but only if the data is not used for anything
  else (no profiling, no analytics, no advertising). The lawyer should confirm, and the owner should
  pick a host whose logs are short-lived and configured for security only. Third-party analytics,
  fonts, embedded widgets and error-reporting scripts on the shell page would break the "collects
  nothing" claim and should not be added without a new review.
- Do not direct the product to children. Chitin is general-audience. Keep the design, copy and
  marketing adult-neutral (section 3).
- The Terms bar under-13s and require parent or guardian permission for 13-17. If an under-13 uses
  it anyway, nothing is collected by the project, so there is nothing to delete or consent to.
- **If a demo site or any accounts are added**, COPPA starts to matter in earnest, and the project
  would become an "operator" if the site is commercial or the exemption does not apply. The options,
  best first:
  1. Do not collect anything (no accounts, no analytics, no tokens issued by the project). A demo that
     is only the static shell page with a locally stored setting is the same as today.
  2. If something must be collected, put a *neutral* age screen first, collect nothing before it, and
     block under-13s without collecting more from them (FAQ H.3).
  3. Only if under-13s are to be allowed: verifiable parental consent (312.5), the notices (312.4),
     parental review (312.6), minimisation and a retention limit. This is a different, larger product
     and not recommended.
- The same logic governs a relay run by someone else: the relay operator who issues accounts or logs
  IPs may be an "operator" in their own right. `relay-operators.md` tells them to read this section.

### 5.4 GDPR and UK GDPR (children, ages 13-16) and the UK children's code

**What I read.**
- GDPR Article 8 (gdpr-info.eu, which reproduces the EU text): where consent is the legal basis and an
  "information society service" is offered directly to a child, the processing is lawful if the child
  is at least 16; below 16, only if the holder of parental responsibility consents or authorises it.
  Member States may lower the age by law but "not below 13 years". The controller must make
  reasonable efforts to verify parental consent, taking available technology into account. Article 8
  does not affect contract law on the validity of contracts with a child. Each Member State has chosen
  its own age; I did not read a current table of them. The lawyer should supply the table if EU
  availability is intended.
- UK GDPR Article 8 (legislation.gov.uk): the UK age is 13; below 13, parental consent or authorisation is needed.
  The text now includes a Secretary of State power to change the age within 13-16 and a clarification
  that the term does not include preventive or counselling services.
- UK GDPR Article 2(2)(a): the regulation does not apply to processing "by an individual in the course
  of a purely personal or household activity" (I read the UK text; the EU text has the same
  exemption in Article 2(2)(c), which I did not read).
- ICO Age Appropriate Design Code (Children's code): applies to "information society services" that
  are likely to be accessed by under-18s, including services not aimed at children but used by "a
  significant number" of them; 15 standards, including best interests, data protection impact
  assessments, transparency, default settings, data minimisation, and "detrimental use of data". The pages I read did not
  say whether the code applies to services that do not process personal data. My understanding
  (unverified) is that its legal hook is the processing of personal data, so a service that
  genuinely processes none would not be caught, but the ICO treats "likely to be accessed by
  children" broadly.

**Analysis for Chitin.**
- Article 8 matters only when (a) consent is the legal basis for processing and (b) there is processing
  in the first place. A client that collects nothing has no consent flow. Under 16 (EU) or under 13 (UK),
  the age rule would apply to any consent-based feature added later (analytics, accounts,
  newsletters, personalised anything). Do not use consent as a lever to collect from minors; do not
  add features that need it.
- The delivery host's logs: if there is a legal basis, it is normally "legitimate interests" (security,
  operation), not consent, so Article 8 is not engaged, but the legitimate-interest balance weighs
  children's interests more heavily (GDPR recital 38 is titled "Special Protection of Children's
  Personal Data"; I did not read its text). IP addresses can be personal data (relay.md cites the
  CJEU's *Breyer* decision, C-582/14; I did not read it).
- If a demo site is added and is available in the UK, treat it as likely to be accessed by children and
  walk the Children's code standards before launch (a short data protection impact assessment). Because the main
  design rule is "collect nothing", most standards are met by design; the work is writing it down.
- The Terms' 13-17 permission requirement and the Privacy page's clear language are consistent with
  the Children's code's transparency standard.
- Relay operators in the EU/UK are controllers of the data their relay logs (source IPs, destination
  IPs and ports, timing). `relay-operators.md` tells them so.

### 5.5 The CFAA, and using the tool against an institution's network policy

**What I read.**
- 18 U.S.C. 1030(a)(2)(C) (obtaining information from a protected computer without authorization or
  exceeding authorized access), (a)(5) (damage), (e)(6) ("exceeds authorized access" means to access a
  computer with authorization "and to use such access to obtain or alter information in the computer
  that the accesser is not entitled so to obtain or alter"), (e)(2) (protected computer, which
  covers essentially any computer connected to the internet) and (g) (civil actions for damage or loss).
- *Van Buren v. United States*, 593 U.S. 374 (2021): "exceeds authorized access" is a "gates-up-or-down"
  question about areas of a computer that are off limits. Footnote 8 left open whether the inquiry looks
  "only [to] technological (or 'code-based') limitations on access, or instead also looks to limits
  contained in contracts or policies."
- DOJ Justice Manual 9-48.000 (updated May 2022 per the page): prosecutors should not bring a CFAA
  case on the theory that a defendant exceeded authorized access *solely* by violating a term of
  service or contract, and should decline cases of good-faith security research. This is internal
  prosecutorial policy, not law, and it does not bind private plaintiffs or other prosecutors.

**Analysis.**
- Using a general browser to reach a public website is not access to a protected computer without
  authorization of that website, even if a school or employer has told the user not to. That is a
  policy breach with consequences under the institution's rules, and perhaps under local law I did not
  research. It is not, on what I read, a CFAA problem by itself, but the Van Buren footnote and state
  laws leave room, and the user bears that risk.
- Where CFAA does bite is conduct the Terms forbid anyway: scanning or attacking systems, using
  credentials or access one is not given, tampering with or exploiting a school or employer's filter
  or monitor (as opposed to simply using a different path), or causing damage. Chitin must not include
  features for attacking networks, bypassing authentication or captchas, or hiding from forensic logging.
- The Terms put responsibility for lawful use and for obeying network rules on the user (section 5 of
  `TERMS.md`) and the Acceptable Use document says in plain words not to use Chitin to break a network's
  rules. Those sentences are not a shield if the marketing says the opposite, which is the point of section 3.
- UK Computer Misuse Act and equivalents elsewhere were not researched (4.4).

### 5.6 Export controls on encryption, including the Tor client (US EAR)

I checked the current text rather than assume it. All quotations are from the eCFR (title 15, as of
2026-10-01; the latest amendment recorded for 742.15 is 89 FR 23885, April 4, 2024).

- 15 CFR 742.15(b)(1): "publicly available (see 734.3(b)(3) of the EAR) encryption source code
  classified under ECCN 5D002 is not subject to the EAR", and it is publicly available even if there is
  "an express agreement for the payment of a licensing fee or royalty for commercial production or sale
  of any product developed using the source code".
- 742.15(b)(2): the notification requirement now applies only to "non-standard cryptography". For that
  case you must email BIS and the ENC Encryption Request Coordinator the internet location of the source
  (or a copy), at crypt@bis.doc.gov and enc@nsa.gov, and re-notify if the location changes or the cryptographic functionality
  is updated. This reflects the March 29, 2021 rule, which removed the email step for publicly
  available source code that does not implement non-standard cryptography (per law-firm summaries; the eCFR amendment history
  lists "86 FR 16488, Mar. 29, 2021").
- 15 CFR 772.1 defines "non-standard cryptography" as "any implementation of 'cryptography' involving the
  incorporation or use of proprietary or unpublished cryptographic functionality, including encryption
  algorithms or protocols that have not been adopted or approved by a duly recognized international
  standards body (e.g., IEEE, IETF, ISO, ITU, ETSI, 3GPP, TIA, and GSMA) and have not otherwise been
  published."
- 15 CFR 734.7(a): software is "published" when made available to the public without restrictions on its
  further dissemination, including by posting on the internet on public sites. 734.7(b): published
  encryption software classified 5D002 remains subject to the EAR *unless* it is publicly available
  encryption *object code* and the corresponding source code meets 742.15(b). 734.3(b)(3)(i) says
  published information and software is not subject to the EAR.
- 15 CFR 740.17 (License Exception ENC) covers other cases (for example closed-source or non-public
  releases) with classification and reporting rules; the part I read says mass-market items are
  classified 5A992/5D992. I did not analyse it further.

What this means for Chitin (the lawyer should confirm each step):
1. If the source is public (the plan), it is "publicly available encryption source code" and is
   outside the EAR. The wasm that is built from it is "publicly available encryption object code" and is
   likewise outside the EAR under 734.7(b) and 734.3(b), provided the source meets 742.15(b).
2. A notification is needed only if the code is "non-standard cryptography". Chitin's TLS (in the
   engine) and the Tor client (Arti, via the Tor protocol) use standard, published primitives, and the Tor protocol specification is
   published, so on the definition above they should not be "non-standard" ("...and have not otherwise
   been published"). This is a judgment, not a certainty: Tor's protocol is documented but is not an IETF
   standard, and I did not read the specifications. The lawyer should decide; the safe course, if in
   doubt, is to send the notification once (cost: one email) and keep the record.
3. The GPL puts no restriction on who may read, copy or further distribute the source, so it should not be
   a "restriction on further dissemination" under 734.7(a). This is the lawyer's call.
4. If anyone ships a closed-source or customised build, it falls outside the public-source route and
   needs its own classification.
5. Sanctions are separate. 734.3(b)(1)(ii) records that OFAC's regulations impose embargoes
   independent of the EAR. The Terms bar use where sanctions or export laws forbid it; the lawyer
   should decide whether to name countries or lists, and whether a geo-block is warranted (I think not, but it is not for me to say).
6. Outside the US (the EU dual-use regulation, the UK, Wassenaar implementing laws) was not researched.
   Third parties who redistribute Chitin are responsible for their own export compliance, and the Terms say so.

### 5.7 Licence design, provenance and enforcement

- **GPL-2.0-or-later.** (Replaced PolyForm Noncommercial 1.0.0 on 2026-10-23.) `LICENSE.md` holds the
  GNU GPL version 2 text unchanged; each Chitin-authored file carries `SPDX-License-Identifier:
  GPL-2.0-or-later`, a copyright line and a `Required Notice:` line. Points that matter here:
  - Any use, including commercial use, is allowed. Running the program is not restricted (section 0).
  - Distribution, modified or not, must keep the copyright notices and the licence, and must come with the
    corresponding source or a written offer of it (sections 1-3). Modified versions stay under the GPL.
  - No further restrictions may be added (section 6), so acceptable-use rules and the trademark policy
    sit beside the licence, not inside it.
  - Violations: under version 2, distributing other than as the licence allows ends the violator's rights
    automatically (section 4), with no cure period. Because recipients may choose a later version, a
    violator may point to GPLv3's reinstatement rules (cure within 30 days of a first notice). `takedown.md`
    template A is written so it works either way.
  - No warranty (sections 11-12): the program is provided "as is", and no copyright holder is liable for
    damages, "unless required by applicable law".
  - Ad-funded or paid clones are not a licence violation in themselves. What remains enforceable is
    missing source, stripped notices, a changed licence, and (separately) misuse of the name. The lawyer
    should confirm whether serving the web app to a visitor's browser is "distribution" that triggers the
    source obligation.
- **Ladybird is BSD-2-Clause** (`third_party/ladybird/LICENSE`, copyright 2018-present the Ladybird
  developers). Redistributions in source form keep the notice, conditions and disclaimer; in binary form the
  same must be reproduced "in the documentation and/or other materials provided with the distribution". Practical rule: the shell's
  `about:credits` page and the downloadable bundle carry the Ladybird text. Consequence for
  enforcement: BSD-2-Clause lets anyone use Ladybird's code commercially. A clone that includes only Ladybird-origin code owes
  only Ladybird's notices, not the GPL's obligations. The enforceable part of Chitin is what
  Chitin's author wrote: the shell, bindings, glue, relay and the Chitin-specific engine changes. Identifying
  those precisely (file headers, directories) is the first step of any notice.
- **Patches back to Ladybird** are offered under BSD-2-Clause (owner's decision, recorded in `LICENSE.md`). Confirm
  that does not weaken the position on the rest.
- **Registration.** 17 U.S.C. 411(a): "no civil action for infringement of the copyright in any United
  States work shall be instituted until preregistration or registration of the copyright claim has been
  made" (with an exception where registration was refused). 17 U.S.C. 412: no statutory damages or
  attorney's fees for infringement commenced before registration unless registered within three months
  of first publication (or the other cases listed there). A DMCA notice to a host does not require
  registration, but a lawsuit does and the remedies are worse without it. If the owner wants
  teeth, registering early is cheap; the lawyer should advise on timing and on how to register a
  work that continues to change.
- **Watermarks and fingerprints as "copyright management information".** 17 U.S.C. 1202(c) lists as
  CMI, among other things, the title and other information identifying the work, the author, the
  copyright owner, "terms and conditions for use of the work", and "identifying numbers or symbols
  referring to such information"; it excludes "any personally identifying information about a user of
  a work". 1202(b) prohibits intentionally removing or altering CMI without authority, or distributing
  copies knowing it has been removed, knowing (or having reasonable grounds to know, for civil
  remedies) that this will "induce, enable, facilitate, or conceal an infringement". 1202(a) prohibits
  providing false CMI. So (i) structural marks that identify the work and owner could be CMI, and
  removal by a clone could be a second claim beyond copyright infringement; (ii) the marks must be
  true and must not identify any user; (iii) fingerprints that do not identify the work or owner but
  merely help recognise copies may not be CMI at all, and are evidence rather than a claim. The lawyer
  should say which design gets the most protection with the least risk.
- **Transparency.** Disclose in `docs/provenance.md` (planned) and in the privacy policy that the
  engine contains build identifiers that do not identify or track users and that nothing is sent anywhere.
  Hidden tracking in a "no tracking" product would be a reputational disaster and a possible legal
  one (deception).
- **Trademark** is `TRADEMARKS.md` and 5.8. **Process** for acting against copies is `takedown.md`.
  The 512(c)(3) elements and 512(f) liability are summarised in 5.2.

### 5.8 Saying "Tor" (Tor Project trademark rules)

From the Tor Project's *Copyright, Trademark and Brand Policy* (last updated Feb 1, 2025, read on
torproject.org):
- The Tor Marks include the word marks "Tor", "The Tor Project" and "Tails" and the "Tor", "Tor Onion"
  and "Tails" logos.
- You may not use the Tor Marks "in, or as a part of, any project or product name, software title, trade
  name, trademark, domain name, virtual or currency token ... or internet account name" without
  express written permission.
- For things that work with Tor: "you may use Tor's word marks (but not logos or design marks, unless
  otherwise authorized in writing) in truthfully describing your offering", provided you do not mislead people into thinking it is
  official. Allowed examples: "providing third party access on the Tor network", "Unofficial support
  services for Tor users". Not allowed: "Tor Access services", "Tor Help support services". The policy
  suggests the word "unofficial" as a good signal.
- If you modify Tor software you may not distribute it under the Tor brand.
- Authorized use needs credit text: "[Tor Mark you are referencing] is a trademark of The Tor Project; all rights reserved",
  with a link to https://torproject.org and a note that your project is not sponsored by the Tor Project
  ("This product is not endorsed or sponsored by, or affiliated with, the Tor Project").
- Report misuse to tor-brand@rt.torproject.org.

How Chitin follows it (also reflected in `TRADEMARKS.md`, `TERMS.md` and `PRIVACY.md`):
- The feature is described as "Route through Tor" with the sentence that it does not provide
  anonymity; no "Tor" in the product name, domain, social handles or file names; no onion logo; the
  credit notice and the "not endorsed" notice appear on the credits page and next to the setting.
- The lawyer should consider whether a feature button reading "Tor mode" is safer or riskier than
  "Route through Tor". I think the descriptive form is safer, but it is the Tor Project's call.
- The policy also covers "Tails", which Chitin does not use.

### 5.9 No warranty and limitation of liability: the GPL versus the Terms

What the GPL already says (sections 11-12): the program comes "as is", without warranty, and no copyright
holder is liable for damages arising out of its use, "unless required by applicable law".

What it does not cover, and what `TERMS.md` therefore adds:
- It binds licensee and licensor over the *software*. It says nothing about a website, a hosted
  demo, or documentation, nor about conduct. The Terms cover use of any build or site running Chitin.
- No acceptable-use rules, no age rules, no responsibility for following the law or network rules,
  and no explanation of what Tor mode does. The Terms add them.
- No statement that the project does not operate relays, that relays are third parties, or that there
  is no anonymity guarantee. These matter because users may rely on the product.
- No cap or structure for other limits of liability, and no acknowledgment that some rights cannot be
  excluded by law ("as far as the law allows" does some of that work, but the Terms spell it out for consumers).
- No governing law, venue, severability, changes clause, or contact route for notices and abuse reports.
- No separate suspension right for project-operated services, and no mechanism for the project to
  refuse service to an abuser quickly (the licence's own termination rules apply only to the code).
- No indemnity. The Terms include an *optional* one, flagged for the lawyer; many consumer-facing
  terms avoid indemnities from individuals, and for minors they are unlikely to be enforceable.

The Terms are written to repeat the disclaimers in plain words rather than to replace the GPL's, and to give way to
the licence on rights in the code.

### 5.10 Other points for the lawyer

- **Impersonation and phishing risk.** A browser in a page invites lookalike sites. The Terms and
  Privacy say where the official origin is (`[OFFICIAL ORIGIN]`). Consider a verification
  mechanism the user can check (a signed build identifier shown on the about page).
- **Third-party relays that rewrite or inject content** would be outside the project's control, but the
  user-facing text says the engine does TLS itself, so a relay cannot read or alter content. If that
  design claim is ever not true, the Privacy text must change at once.
- **The licence change.** See 4.2 item 9.
- **Records.** Keep dated copies of each version of these documents (users who accepted version X).
  Since nothing is collected, there is no server-side acceptance log; the acceptance is a local
  setting. The lawyer should say whether that is enough evidence if a Terms issue arises.

## 6. What changes the product (decisions for the owner)

Owner decisions, 2026-10-11:
- The owner is an individual (no company yet) and has no lawyer for now; a free clinic (the
  college's student legal services, the USPTO Law School Clinic Certification Program, Volunteer
  Lawyers for the Arts) is the route if one is needed.
- No copyright registration for now. The code was written with an AI assistant (Claude); Anthropic's
  terms assign its rights in outputs to the user, but US copyright needs human authorship (Copyright
  Office guidance 2023 and its January 2025 copyrightability report; Thaler v. Perlmutter, D.C. Cir.
  2025), so protection of the code itself may be thin. The protection relied on instead: the
  licence (as terms people accept), the engine's provenance marks to identify copies, and the name.
  Takedown requests lead with licence and name misuse, not copyright alone.

1. **Marketing rules** (section 3). They bind the website, README, social posts, issues and replies.
2. **No analytics, error reporting, telemetry, fonts or third-party scripts** on the shell page,
   in the client or in the engine, unless a new review is done. The privacy position and the
   COPPA/GDPR analysis rest on it.
3. **Pick the delivery host for its logs.** Short retention, no cross-site tracking, security-only
   purposes, written down. Name it in `PRIVACY.md` once chosen.
4. **No accounts, tokens or sign-in run by the project.** Update `docs/architecture.md` ("Relay: our
   servers", "signed, short-lived tokens per account", "public relay") to say operators run their own.
   If the project ever adds them, stop and redo 5.3 and 5.4 first, and add an age screen designed per the FTC FAQ.
5. **An age gate on a demo site.** Not needed while nothing is collected. If a demo site collects
   anything (accounts, an email address, analytics, stored preferences on a server), add a *neutral*
   age screen before any collection, block under-13s without collecting more, and treat the site as
   likely to be accessed by children for the UK Children's code. For the downloadable/self-hosted
   product, a first-run acknowledgement of the Terms (13+, parent or guardian permission for under-18s
   where local law requires it) stored only in the browser is enough for the contract purpose.
6. **First-run notice** that shows the Terms and Acceptable Use, the "Route through Tor does not make
   you anonymous" line, and the fact that the relay is run by a third party. Stored only locally.
7. **Provenance marks** identify the work and the build, never a person, and the project says
   they exist (5.7). No phone-home.
8. **Relay defaults** (from `docs/research/relay.md`): keep them safe in the shipped image, make
   loosening them require an explicit setting, and have the image print a notice that the operator is
   responsible. Do not publish settings that disable the private-range block or the port allowlist as
   "recommended".
9. **Do not build features tailored to infringement, intrusion or evading monitoring** (5.1, 5.5).
   Review any future "stealth" or "disguise" feature (for example a disguised tab title or favicon, a
   panic button that hides the page, an unlisted rotating domain) against the messaging rules; these are
   the features most associated with school and workplace evasion.
10. **Official-origin signal.** To discourage ad-funded clones, the shell page can show a clear
    "official build" indicator when it runs on `[OFFICIAL ORIGIN]` and an "unofficial copy" notice
    elsewhere (a determined fork can remove it; the point is that honest forks are labelled and
    dishonest ones are removing a mark, which is evidence).
11. **Contributor terms.** Decide whether contributors sign a CLA or DCO so that licensing and
    enforcement stay clean.
12. **Copyright registration and trademark filing** are optional steps the owner should decide with the lawyer.

## 7. Sources

Read in full or in the relevant part on 2026-10-11 (URLs as fetched):

**Case law**
- *MGM Studios v. Grokster*, 545 U.S. 913 (2005): https://www.law.cornell.edu/supremecourt/text/04-480
- *Cox Communications v. Sony Music Entertainment*, No. 24-171 (Mar. 25, 2026):
  https://www.law.cornell.edu/supremecourt/text/24-171 ; and, as secondary summaries,
  https://cooley.com/news/insight/2026/2026-03-26-supreme-court-confirms-limits-on-contributory-liability-for-copyright-infringement ,
  https://www.mayerbrown.com/ja/insights/publications/2026/03/supreme-court-significantly-narrows-liability-for-contributory-copyright-infringement ,
  https://www.mofo.com/pdf/resources/insights/260409-supreme-court-narrows-internet-service-providers
- *Van Buren v. United States*, 593 U.S. 374 (2021): https://www.law.cornell.edu/supremecourt/text/19-783

**Statutes and regulations**
- 17 U.S.C. 512: https://www.law.cornell.edu/uscode/text/17/512
- 17 U.S.C. 1202: https://www.law.cornell.edu/uscode/text/17/1202
- 17 U.S.C. 411 and 412: https://www.law.cornell.edu/uscode/text/17/411 , https://www.law.cornell.edu/uscode/text/17/412
- 37 CFR 201.38 (DMCA agent designation, three-year renewal): eCFR, https://www.ecfr.gov/current/title-37/part-201/section-201.38 ; Copyright Office: https://www.copyright.gov/dmca-directory/
- 18 U.S.C. 1030: https://www.law.cornell.edu/uscode/text/18/1030
- DOJ Justice Manual 9-48.000: https://www.justice.gov/jm/jm-9-48000-computer-fraud
- 15 U.S.C. 1125(a) (false designation of origin, likelihood of confusion): https://www.law.cornell.edu/uscode/text/15/1125
- 15 CFR 742.15, 734.3, 734.7, 740.17, 772.1 (eCFR API, as of 2026-10-01): https://www.ecfr.gov/current/title-15 (part 742, 734, 740, 772)
- 16 CFR 312.2 and 312.3 (COPPA Rule): eCFR, https://www.ecfr.gov/current/title-16/part-312
- FTC, *Complying with COPPA: Frequently Asked Questions*: https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions
- COPPA 2025 amendments (dates only, secondary): https://www.whitecase.com/insight-alert/unpacking-ftcs-coppa-amendments-what-you-need-know
- GDPR Article 8: https://gdpr-info.eu/art-8-gdpr/ (reproduces the EU text; the EUR-Lex page would not load)
- UK GDPR Articles 8 and 2: https://www.legislation.gov.uk/eur/2016/679/article/8 , https://www.legislation.gov.uk/eur/2016/679/article/2
- ICO Age Appropriate Design Code: https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/age-appropriate-design-a-code-of-practice-for-online-services/ and the "likely to be accessed by children" page on the same site
- Electronic Commerce (EC Directive) Regulations 2002, regulation 17 (mere conduit): https://www.legislation.gov.uk/uksi/2002/2013/regulation/17
- BIS encryption notification change (March 29, 2021), secondary: https://www.wiley.law/alert-Commerce-Eases-Encryption-Export-Controls-Reporting-Requirements

**Licences, policies and practice**
- GNU General Public License, version 2: https://www.gnu.org/licenses/old-licenses/gpl-2.0.html (installed as `LICENSE.md`)
- Tor Project, Copyright, Trademark and Brand Policy: https://www.torproject.org/about/trademark/
- Cloudflare, abuse and DMCA handling: https://www.cloudflare.com/trust-hub/abuse-approach/
- Ladybird licence (BSD-2-Clause): `third_party/ladybird/LICENSE` in this repo
- Project research: `docs/research/relay.md`, `docs/research/tor.md`, `docs/plan.md`, `docs/architecture.md`, `CREDITS.md`

**Could not read / not relied on:** EUR-Lex (GDPR full text, Digital Services Act); FCC CIPA pages; the OSI
open-source definition; the CJEU *Breyer* decision (cited from `docs/research/relay.md`); the Federal Register
notices themselves; Google's, Cloudflare's and ad networks' own copyright complaint forms in detail.

Laws change. Every date and citation above should be re-checked by the lawyer on the day of review.
