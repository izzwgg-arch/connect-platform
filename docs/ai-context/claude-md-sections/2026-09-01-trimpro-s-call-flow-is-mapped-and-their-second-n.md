# ⛔ AGENT HANDOFF — Trimpro's call flow is MAPPED and their SECOND NUMBER GOES NOWHERE (2026-09-01) — READ FIRST before answering anything about Trimpro's menus/extensions, and before decoding an `ombu_destinations` row

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(**Read-only — no code, no deploy, no PBX write, no data change.** Delivered to Izzy as
`Trimpro-Phone-System-Guide.pdf`, 5 pages, from the live PBX tenant **11** + 30 days of CDRs.
Full map + the six findings: [[trimpro-call-flow-map]].)
Izzy, 2026-09-01: *"make me a visual PDF for TrimPro … a diagram of the whole call flow."*

- **The flow, so nobody re-derives it:** DID **8452483973** → time condition **TC-10**
  (Mon–Thu 09:00–18:00, Fri 09:00–12:00, `America/New_York`) → open = **IVR-21 "Main"**,
  closed = **IVR-32 "After Hours"**. Main keys: 1 → IVR-19 Trimming (1 RG800 / 2 RG801 /
  3 custom app 109 "Closet" → external 845-251-0972), 2 → RG802, 3 → RG804, 4 → RG806,
  5 → RG805, 6 → IVR-20 Accounting (1 → ext 102 direct, 2 → RG300), 7/8 → announcements
  that **return to IVR-21**. Timeout ×3 → voicemail 103 (IVR-20 → 105).
- ⛔⛔ **READ THE RENDERED DIALPLAN, NEVER `ombu_destinations`** — the file already records
  this trap and it bit again: dest 126/212 decode as `module_id 29 index 1/10`, which is
  meaningless, while `extensions__50-11-dialplan.conf` states the routing unambiguously.
- ⛔⛔ **THEIR SECOND DID `8455577816` IS NOT ROUTED.** It reaches the tenant, but the
  inbound route "Default" ends at `Goto(verify-did,...)` — a system test prompt, then hangup.
  **Proven harmless before reporting it: 481 of 481 inbound calls in 30 days came to
  8452483973 and ZERO to it.** Pointing it somewhere (or dropping it) is Izzy's call.
- ⛔ **Ext 104 Shamshon Wertzberger has NO desk phone and NO app** — only a `virtual` device
  forwarding to cell **845-662-5569** — and menu options **4 (Orders)** and **5 (Site
  Manager)** BOTH ring only it. One mobile is the single point of failure for two departments.
- ⛔ **Voicemail email lives in Connect's `VoicemailEmailRecipient`, and the PBX's blank
  email column is CORRECT** (the 2026-08-17 cutover). **104 and 107 have no recipient row,
  so their messages notify nobody** — the blind-mailbox class, still open for those two.
- ⚠️ Also found, none acted on: after-hours key **9** plays the hours then drops the caller
  into the **daytime** Main Menu; **RG 807 "Accounts Payable" is on no menu** (6→1 rings ext
  102 instead); RG 800/801/802 have **identical members**, so three menu choices reach the
  same two people; and Connect bills **9** extensions (incl. `106 "1001"`, on no PBX tenant,
  and `109 "Closet"`, a custom application) against **7** real ones.
- ⛔ **Rendering the PDF: headless Chrome reports `NNNNN bytes written` while printing an
  ERR_FILE_NOT_FOUND page.** Build the `file://` URL with **`cygpath -m`** (`pwd -W` and
  both sed/bash backslash substitutions mangle it here) and **verify with PyMuPDF** — page
  count plus a rasterised look, never the exit line. Recipe: [[render-a-pdf-with-headless-chrome]].
- ⏳ **NOT DONE: nothing was changed and Trimpro has not seen the document.** Every finding
  above needs Izzy's word before any PBX or Connect write.
