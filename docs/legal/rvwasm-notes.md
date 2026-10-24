> **Draft — not legal advice; to be reviewed by a lawyer before publication.**

# Reusing these documents for rvwasm: what changes (checklist)

Version: DRAFT 0.1 (2026-10-11). Checklist only. Nothing below has been researched in depth; each item is
a prompt for the lawyer and the owner. rvwasm is the owner's other project: a Linux OS (riscv64, Debian,
KDE Plasma and more) running in the browser, with networking through a relay. Chitin is a separate
product and depends on none of it; these notes cover only what is different if the same legal documents are
reused.

## 1. Different product, different risk

- [ ] **Users run arbitrary software, not just a browser.** In Chitin the only thing that talks to the
      network is a sandboxed browser engine. In rvwasm a user can run any program (scanners, servers,
      torrent clients, SSH, scripts). The acceptable-use rules (`ACCEPTABLE_USE.md`) need extra clauses:
      no scanning or attack tooling aimed at others, no running servers for abuse, no mining, no spam. State
      the rules for the guest OS itself, not only the browser.
- [ ] **Networking is general-purpose egress.** Raw TCP/UDP from a guest is a bigger abuse surface than
      browser HTTP. `docs/research/relay.md` already recommends not offering raw IP on a public relay and
      terminating TCP in the page; the relay-operators guide must be rewritten for that design (port
      allowlist, UDP limits, no ICMP, no inbound), and a stricter default policy chosen. Re-check the
      hosting-provider rules, which are stricter for scanning-like behaviour.
- [ ] **The CFAA and computer-misuse risk goes up** (`docs/legal/README.md` section 5.5): a tool that includes SSH
      clients, compilers and network utilities makes "scanning" and "access without authorisation" easier. The
      messaging rules should ban any "pentest distro" or "hacking" marketing.
- [ ] **Inducement exposure (Grokster, Cox).** Review the product's default image: does it ship torrent
      clients, scrapers, Tor-proxy bundles or similar that could be read as "tailored" to infringement? Do
      not pre-install them. Keep the same messaging rules.
- [ ] **Daily-driver positioning** brings more, and more varied, users (including minors, school users,
      workplace users). The age rule and the network-rule paragraph in the Terms matter more. Decide
      whether a first-run acknowledgement is required before the machine boots.

## 2. Licences

- [ ] **rvwasm contains a lot of software under other licences.** The Linux kernel (GPL-2.0), BusyBox,
      the Debian userland (GPL, LGPL, MPL, MIT, BSD and non-free or restricted packages), KDE, Chromium
      if included, and so on. Distributing the images means complying with each licence: provide corresponding source or a
      written offer for GPL parts, keep notices, and publish the licence texts (an about/credits page or a
      directory in the image). Own-code licence (PolyForm Noncommercial) applies only to the owner's code
      (emulator, JIT, tooling), not to the image as a whole. Make the split explicit in `LICENSE.md` for
      rvwasm.
- [ ] **Is the PolyForm Noncommercial licence compatible with how the owner's code links to or ships with
      GPL code?** A separate-programs boundary (the emulator and the guest are separate) is
      usually the point; the lawyer should check where code is combined (kernel patches, drivers
      written for the guest, a guest-side agent), because GPL code that is combined may not be covered by a noncommercial licence.
- [ ] **Kernel and distro patches the owner wrote** (framebuffer and input drivers, sound card, GPU path) may
      be derived works of GPL code and then must be GPL. Decide and label.
- [ ] **Ladybird/BSD-2** applies only if rvwasm includes Ladybird code. If not, drop that paragraph.
- [ ] **Software installed later by users** (`apt-get`, downloads) is under its own licences; the
      Terms should say the user is responsible and that the project does not control what they install.
- [ ] **Codecs and patents.** If rvwasm includes or makes available video, audio or image codecs through
      the host browser (WebCodecs) or the guest, patent licensing may matter. Not researched.

## 3. Names and trademarks

- [ ] **"Linux", "Debian", "KDE", "Plasma", "Chromium", "Chrome", "Firefox", "Ubuntu", "Windows", "macOS" and others
      are other people's marks.** Check each project's trademark policy before using it in a product name, a
      domain name, or in marketing ("Debian in your browser" is a use that needs reading the Debian policy; I have
      not read it). Descriptive references with an "unofficial, not endorsed" line are the usual route.
- [ ] **rvwasm's own name and logo:** decide whether the same TRADEMARKS rules apply (forks rename and
      rebrand). Run a clearance search on the name.
- [ ] **Desktop look-alikes.** The owner's direction is a window server of the project's own with its own
      aesthetic; do not copy another OS's look or trade dress, and "nothing from anuraOS" should be a stated rule.
- [ ] **Tor naming** rules are the same as for Chitin if rvwasm offers Tor (`docs/legal/README.md` section 5.8).

## 4. Privacy and children

- [ ] **Where the guest's data lives.** In rvwasm the user's home directory is in the browser's own storage (a
      browser-only disk). Say so. If a sync, backup, cloud disk or account is ever added, everything in
      `PRIVACY.md` section 10 and the COPPA/GDPR work in `docs/legal/README.md` sections 5.3 and 5.4 applies, and a
      full OS stores far more personal data than a browser does.
- [ ] **Software inside the guest has its own telemetry and network behaviour** (package managers, browsers,
      desktop services, crash reporters). The "collects nothing" claim covers only what the project ships and
      controls. Audit the default image for phone-home behaviour; disable it or disclose it.
- [ ] **Guest-visible identifiers.** Make sure the image has no hard-coded hostnames or machine IDs that
      identify the owner or the user.
- [ ] **The web app host** (section 6 of `PRIVACY.md`) matters the same way.

## 5. Relay, Tor and export

- [ ] **The relay for rvwasm is a separate decision.** No project-hosted relay is the safest line; if the
      owner keeps "self-hosted Docker relay" for rvwasm, reuse `relay-operators.md` with the tightened
      defaults from section 1 above, and keep it away from Chitin's relay if the policy differs.
- [ ] **Export controls: much more crypto is shipped.** A Debian image includes OpenSSL, OpenSSH, GnuPG
      and more. Re-run the analysis in `docs/legal/README.md` section 5.6 for the image as a whole, not for one Tor
      client: classification, public availability of source for everything (GPL source is public, but
      confirm each component and who is the "exporter" of an image the owner assembles), and the
      notification question for any non-standard cryptography.
- [ ] **Sanctions and embargoed destinations.** Same as Chitin; a general-purpose OS is no easier.
- [ ] **Hosting.** Large image downloads cost bandwidth and may trigger terms of the host or CDN.

## 6. Documents to adapt

- [ ] `TERMS.md`: change "browser" to "operating system and browser"; add the guest-software and
      user-installed-software paragraphs; replace the sandbox claims with what rvwasm really isolates
      (an emulator in a page protects the host browser, but the guest is a full machine the user controls);
      check the age paragraph again.
- [ ] `ACCEPTABLE_USE.md`: add the guest-OS rules in section 1 above.
- [ ] `PRIVACY.md`: what is stored where; audit of default image; relay as in Chitin.
- [ ] `relay-operators.md`: tightened egress policy; no raw IP; operators must know that a guest can run
      anything.
- [ ] `TRADEMARKS.md`: list third-party marks used; own name and logo.
- [ ] `takedown.md`: the sets of "Chitin-authored" files do not apply; list the owner's code (emulator, JIT,
      tooling) and make sure provenance marks identify rvwasm builds. Remember that most of an image is other people's code
      and cannot be the subject of a notice from the owner.
- [ ] `LICENSE.md`: add the third-party and GPL notes and a list of what is and is not under PolyForm.
