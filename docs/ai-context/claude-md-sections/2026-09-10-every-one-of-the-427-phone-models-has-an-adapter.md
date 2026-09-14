# ⛔⛔ AGENT HANDOFF — EVERY ONE OF THE 427 PHONE MODELS HAS AN ADAPTER NOW, and the catalogue is GENERATED from the PBX (2026-09-10) — READ FIRST before hand-editing `vendorCatalog.generated.ts`, before adding a vendor, before upgrading ANY adapter to `confidence: "proven"`, or for "does the wizard support brand X?"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/PLAN_DESK_PHONE_WIZARD_WORKS_EVERYWHERE_2026-09-10.md` §14**
(`830101a8` + `a98a70f1` on `feat/ivr-migration-takeover`, pushed. **Shared package
only — NOTHING is wired into the wizard, the desktop app or the server, and nothing is
deployed.** No migration, no PBX write, no env change.)
Proof page for Izzy: <https://claude.ai/code/artifact/c233fc3a-fa7e-469b-a879-5304a2bda80f>
Izzy's scope, verbatim: *"every single phone needs to have an adapter, and the template
should be connected to it. all 427 should have"* + *"I want you to come back with proof
to me that every single one has an adapter."*

- ✅ **427 of 427 models carry an adapter**, checked by walking the catalogue in the test,
  not asserted. 20 brands, **1,143 OUI prefixes**, and per model two independent stored
  facts: `hasBaseTemplate` and `templateWritesProvisioningPath`.
- ⛔⛔ **`vendorCatalog.generated.ts` IS GENERATED — never hand-edit it.**
  `scripts/deskPhoneSetup/gen-vendor-catalog.py` reads three read-only dumps in
  `scripts/deskPhoneSetup/data/` and regenerates it byte-identically. It **asserts its own
  invariants and refuses to write** if the PBX's data has moved — `KNOWN_TEMPLATE_GAPS` and
  `KNOWN_ORPHAN_TEMPLATES` are hard-coded and a change throws, so the gap can never widen
  silently. The hand-written half is `vendorAdapters.ts`; keep the two apart.
- ⛔⛔ **`confidence: "proven"` MEANS SOMEBODY WATCHED IT WORK ON A REAL HANDSET ON THIS
  PLATFORM. Today that is YEALINK ALONE.** `vendorCoverage.test.ts` pins the proven set to
  exactly `["yealink"]`, forbids a `proven` HTTP endpoint on an unproven brand, and fails any
  unproven adapter that lists no gaps. **A label cannot be upgraded without changing that test
  in the same commit as the evidence.** Counts: proven **82**, documented **333** (14 brands),
  inferred **10**, nothing published **2**.
- ⛔ **It is 426 of 427 RENDERABLE, not 427.** `Gigaset P820 IP PRO` (id 407) has a catalogue
  row and **no template on disk** (its p810/p810b/p825/p850w neighbours all have one);
  `base_templates/atcom/a20/` is the mirror image — a 99 KB template matching **no** catalogue
  row, so nothing can ever be pointed at it. Both are named in code. Fixing the P820 is one
  folder on the PBX and is Izzy's call.
- ⛔ **31 models across four brands (Alcatel-Lucent 15, Dinstar 14, Nurivoice 1, Hanyang 1)
  have NO mechanism a computer on the LAN can drive at all.** `hasLocallyDrivableMechanism()`
  is what the wizard must consult **before it shows a progress bar** — the alternative is
  pretending to work on a phone we cannot touch. The test pins that list.
- ⛔ **"Template does not write the URL back" is NOT "cannot be provisioned"** — they are
  separate fields for a reason. **359** templates write it; the other **67** are pointed once
  and remember it (all 17 Aastra-Mitel, 23 older Polycom SoundPoint/Edge, 7 Dinstar DAG,
  6 Gigaset DECT, 13 Sangoma A/D/P, 1 Snom DECT). That is why Aastra's
  `templateProvisioningKey` is `null`.
- ⛔ **`0c383e` is registered to BOTH Fanvil and Attimo**, so a MAC can never name which:
  `vendorsForMac` returns **both**, `vendorForMac` returns **null** rather than choosing.
  ⛔ And **two manufacturer OUI blocks are missing from `provisioning.brand_macs`** —
  Flyingvoice's own `789912` (the table holds only `0021f2`, the Easy3Call ODM block on older
  stock) and Snom's second block `1c7126` — so **current-production stock of either brand is
  not recognised by MAC at all.** Two rows, no code.
- ✅ **ONE PnP responder covers 369 of the 427 models**: Yealink, Snom, VTech ET6xx, Fanvil,
  Htek, Sangoma S-series, Atcom, Flyingvoice, Gigaset and (inferred) Attimo all send a SIP
  `SUBSCRIBE` for `Event: ua-profile` to **224.0.1.75:5060** at boot and obey a `NOTIFY`
  carrying `Content-Type: application/url`. ⛔ **The `Event` header CANNOT identify the
  model** — Snom and VTech both send `vendor="OEM" model="OEM"`, Fanvil sends
  `model="VOIP PHONE"`, Atcom sends `vendor="ATCOM"`. **Recognise the brand by OUI, never by
  the SUBSCRIBE.**
- ⛔ **Per-brand facts worth not re-deriving** (full list in §14e): **Htek is the OEM behind
  the Sangoma S-series** (Hanlong's `001fc1`) and behind ClearlyIP (identical `P237` key);
  **Sangoma is two unrelated platforms in one brand** — S-series = Htek, A/D/P = Sangoma's own
  (mDNS `_digiumproxy._udp`, password **789** not admin, and ⛔ **its web UI locks once
  provisioned — only a factory reset gets it back**); **Gigaset reads DHCP option 114, not
  66**; **Atcom's action URI is NOT a cold-start lever** (the handset asks a person to allow
  remote control from an unlisted address — PnP is the only cold path); **Fanvil has no
  documented HTTP call that SETS the URL**; **Grandstream randomises the admin password on a
  sticker** since 2017 and its sources disagree on port (5060 vs 5080) and content type, so
  **the listener must accept both rather than pick one**; **Polycom UCS 5.9.7+ forces the
  `456` password to change at first login**; **Cisco MPP usually ships with web administration
  disabled**.
- ✅ **Cross-check that validated both sources:** the PBX's own `brand_macs` agrees with the
  manufacturers' IEEE registrations on every block checked (`808287` Atcom, `001fc1` Htek,
  `0c383e` Fanvil, `005058` Sangoma, `000413` Snom, `7c2f80` Gigaset, `0021f2` Flyingvoice's
  ODM block).
- ⛔ **`provisioning.brand_macs` MIXES FORMATS and 10 rows are silently dropped if you don't
  normalise.** Most rows are bare 6-hex; later rows carry colons (`EC:74:D7`); two ClearlyIP
  rows are IEEE **MA-M/MA-S** assignments **7 and 9 hex digits long**. Strip non-hex,
  lowercase, accept length **6–9**, and match by **prefix (longest wins)**.
- ⛔ **Traps paid for:** a bash heredoc turns an escaped newline inside a Python string into a
  REAL newline (unterminated string literal — **write any file containing escapes with the
  editor, never a heredoc**; it bit twice, including writing the handoff section itself); **a
  generator that prints "success" is not a generator that wrote what you asked** (three writer
  patches silently failed to apply — caught only by grepping the OUTPUT file, never the
  script); the template scan must count **models, not template directories** (the atcom/a20
  orphan writes `provisioning_path` and is the difference between 360 and 359);
  `git commit -F - -- <paths>` commits **only** the pathspec (two modified files were left
  behind and needed a second commit).
- ✅ **Proven as:** shared suite **597/597**, shared typecheck **0**, 17 coverage checks
  registered in `packages/shared/package.json`, and the digest constant
  `VENDOR_CATALOG_DIGEST = "3dfcb30d00f181c9"` pinned in the generated file.
- ⏳ **NOT DONE — the catalogue and the adapters exist and NOTHING CONSUMES THEM YET.**
  ⛔⛔ **SUPERSEDED 2026-09-11 for items (2), (3) and (4) — read the section at the TOP of
  this file (`dac3aab2`), which is the live state.** Items 2–4 below are the HISTORY of
  what was wrong, not what is wrong now: the resident joins on every network and holds two
  ports, `vendorSupportsLocalActions` is split into a speak gate and a listen gate so every
  PnP brand is driven, and the hour-long give-up is deleted. **Items (1), (5) and (6) are
  still genuinely open.**
  (1) `VendorAdapter` is not wired into `apps/desktop/src/phoneSetup/` (`yealink.ts` is still
  the only executor, and the desktop cannot import the monorepo — it needs a drift-guarded
  copy the way `coworker/policyCore.ts` does); *(2) ~~`pnpResident.ts` still joins the multicast
  group on the OS default interface only and still assumes Yealink's port and content
  type~~ — FIXED;* *(3) ~~`vendorSupportsLocalActions()` returns true ONLY for Yealink, so
  every other brand stalls in "Preparing"~~ — FIXED, and it was the original defect Izzy
  reported;* *(4) ~~the server ladder halts to Support after about an hour on
  `provisioningHandoffFailed`~~ — FIXED, the clock is gone;* (5) nothing writes a
  `provisioning.devices` row per model (`save_phone` exists; the wizard does not call it) and
  the no-MAC common files (Polycom `000000000000.cfg`) do not exist per tenant; (6) Phases A
  and B of the plan — the log wiring and the in-app firewall prompt — are untouched.
- ✅✅ **GRANDSTREAM IS CAPTURED, FROM THE DEVICE AND FROM OUR OWN PBX (2026-09-10,
  `38c618b1`, plan §16) — nothing here is inferred.** ⛔⛔ **`GET /cgi-bin/metaconfig_get`
  answers UNAUTHENTICATED with the handset's own alias→P-code map** — 2,632 entries on
  Izzy's GXP2170 — so **never guess a Grandstream P-code again**; `api.values.get?request=
  phone_model` is also unauthenticated and returns the model, a credential-free fingerprint
  (useful because the admin password is on a sticker nobody has read). ⛔⛔ **P237 IS NOT A
  URL**: our PBX renders it `209.145.60.79/phoneprov/<tenant-hash>` — **no scheme, no
  trailing slash** — with the transport in **P212 separately**, so a Yealink-shaped
  `https://…/` configures NOTHING. ⛔ And the two surfaces disagree on P212's type — the
  config FILE takes an integer (`<P212>2</P212>`), the metaconfig declares the STRINGS
  `"TFTP"…"FTPS"`. ✅ **Izzy's HT flow needs no new machinery**: the PBX already ships
  templates for **60 Grandstream models incl. gxp2170 AND ht812**, already renders
  **`cfg<MAC>.xml`** (NOT Yealink's `<mac>.cfg`) for the **7 Grandstream devices live on
  this platform** (2× GXP2170, 2× HT801, 2× HT802, 1× HT812), and that file **serves 200 /
  118,646 bytes over HTTPS, byte-identical to disk** — it carries the SIP account AND points
  P237/P212 back at the same folder, so uploading it once provisions and STAYS provisioned.
  What is missing is only the wizard step that fetches it and hands it over. ⏳ **The WRITE
  is still unexercised** (`dologin` needs the sticker password) so the adapter stays
  `documented`; ⛔ **the HT812 was NOT touched**, per Izzy — every HT fact above came from
  the PBX. ⚠️ Do not brute-force `dologin`; Grandstream locks out.
- ✅ **THE WIZARD'S PICTURE TELLS THE TRUTH NOW (`38c618b1`, plan §17).** Izzy's mockup
  exception ("the photos are supposed to be next to the phone") was **not a missing photo** —
  `PhonePhoto` has rendered them since 2026-08-25. ⛔⛔ **94 of the 427 models ship NO product
  image (22%), and not a random 94: EVERY Grandstream HT and EVERY Dinstar DAG — the whole
  ATA family — plus 39 newer Polycom and 33 Flying Voice.** 5 of the 7 live Grandstream
  devices are HTs, so for that brand a missing photo is the COMMON case, and Izzy's own two
  devices split exactly this way (GXP2170 has one, **HT812 does not and never will**). The
  old fallback drew ONE telephone glyph for all of them — pointing a customer at a phone that
  is not on their shelf. `KindGlyph` now draws what the thing IS (ATA box / cordless cradle /
  ceiling speaker / door panel), and **a plain box for `unknown`, because drawing a telephone
  would be a claim**. ⛔ **76 models still have neither photo nor kind** (mostly Polycom
  VVX/CCX/IP and Flying Voice) and **300 of 427 resolve to `unknown`** — left honestly
  unknown rather than pattern-guessed, because a WRONG kind is worse than an unspecific one;
  only `DAG\d → ata` was added (the product line is literally "Dinstar Analog Gateway").
- ✅ **The make dropdown is live and reads the catalogue**, never a typed list (a make we
  cannot provision must not be offered; a make the PBX gains later must appear by itself).
  ⛔⛔ **IT ORDERS THE FOUND LIST AND NEVER FILTERS IT** (`apps/portal/components/deskPhones/
  makeHint.ts`) — misreading a sticker is ordinary, and filtering would show an EMPTY found
  screen while the scan HAD found their phone, whose only reading is "the wizard is broken".
  Exercised, not grepped. ⏳ **NOT PROVEN: nobody has opened the wizard in a browser and
  nothing is deployed.**
