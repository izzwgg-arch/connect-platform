# ⛔⛔ AGENT HANDOFF — the Desk Phone Wizard identifies what it discovers and drives maker clouds through one provider interface; RESET-FIRST governs Prepare Device too; GDMS card on Admin → Integrations (2026-09-14, round 2 `acb994a3`) — READ FIRST before touching `apps/api/src/deskPhoneSetup/device*.ts` / `gdms*.ts` / `grandstreamProvider.ts`, `packages/shared/src/deskPhoneSetup/deviceIdentification.ts`, or before storing GDMS credentials

Full handoff: **`docs/ai-context/AGENT_HANDOFF_DEVICE_IDENTIFICATION_2026-09-14.md`**.
Memory: [[desk-phone-device-identification-built]], [[reset-first-is-izzys-decision-cost-stated]].

- **Rule served:** the wizard asks "what device did we discover?", never "what brand did the customer pick?".
- **Identification** (`identifyDevice`, shared, pure): maker from MAC OUI only; model from multi-source evidence
  (vendor cloud > PBX record > device API > SIP UA > HTTP banner > label > manual) with confidence, conflicts reported.
- **Providers:** Grandstream GDMS = lookup/claim/reboot/reset/status (field names UNVERIFIED on a real account);
  Yealink RPS = lookup only; Fanvil + Poly = `not_supported`. GDMS simulator is test-only.
- ⛔⛔ **Reset-first (Izzy, round 2: "reset every time you connect the phone"):** `planDevicePreparation` clears every
  TICKED phone not yet reset in this setup BEFORE reprovision/reboot/SIP. Never: registered to us, held by another
  account, unknown model, no settings profile. Unticked → nothing at the maker at all. `/prepare`: tick = consent (no
  separate reset-permission gate, same as the ladder); reset is the last step of that request; spent atomically first,
  given back only on a definite refusal.
- **GDMS card:** Admin → Integrations → "Grandstream device cloud (GDMS)": Save (write-only), Verify, Clear, read-only
  Look up by MAC (`POST /admin/desk-phones/gdms-credentials/lookup`). ⛔ There is no "Admin → GDMS" page.
- **Migration** `20260914190000_desk_phone_identification` (six nullable columns + macAddress index).
- **Desktop** (installer): Poly + extra families named; one Grandstream `phone_model` read only for Grandstream pages.
- **Portal:** card shows device type + MAC · IP; "type or scan what the label says" box — built WITHOUT a mockup review.
- ✅ **DEPLOYED + container-verified 2026-09-14:** api 19:13Z and portal 19:22Z, both `acb994a3`, 0 restarts;
  migration `20260914190000` applied (six columns present). ✅ Desktop `0.1.17-rc.14` built from a clean export of
  `f8e11424` and INSTALLED on Izzy's PC — ⛔ NOT published (feed stays rc.10).
- ⛔⛔ **Round 3 (`7e54716a`, DEPLOYED api+portal 2026-09-14 ~21:00Z): PER-BRAND MECHANISMS.** Shared
  `deviceMechanismsFor(vendor, readiness)` is the ONE answer for how a brand is cleared / restarted / given
  settings. `/advance` adds `via:"vendor_cloud"` from it; the driver listens first, then runs the step through
  `/prepare` (GDMS claim → reset; later a GDMS restart, ≤2, 3 min apart; one cloud ask per 30 s). Serial screen;
  one read-only maker-cloud lookup for unnamed phones. Other brands unchanged. Why: Izzy's 20:13Z run — a ticked
  GXP2170 was told "reset over LAN", skipped it, and waited for a power-cycle while GDMS sat unused. Handoff §10b.
- ⛔⛔ **Round 4 (`c7f5459c`, desktop rc.15): GRANDSTREAM RESETS OVER THE LAN WITH THE PASSWORD, no serial.**
  New `apps/desktop/src/phoneSetup/grandstream.ts` (session `dologin` → `api-sys_operation REBOOT|RESET`);
  `deviceMechanismsFor` prefers `lan_http` reset over the serial-based GDMS reset. Settings stay on PnP (no
  Grandstream HTTP config write, no P237 trap). Handoff §10c. ⏳ The authenticated write is UNPROVEN on a real
  handset — Izzy types the phone password into the wizard once; a wrong shape fails safe to the PnP power-cycle.
- ⛔⛔ **Round 5 (THIS ROUND): THE PASSWORD PROMPT IS GONE — the serial is asked ONCE, on the
  extension screen.** Izzy: *"I don't want it to ask for the password … where they select the
  extension, they should also be prompted to enter the serial number."* So round 4's precedence is
  **INVERTED ON PURPOSE**: `deviceMechanismsFor` returns `reset:"vendor_cloud"` primary and
  `resetFallback:"lan_http"` (the password) second, for a brand with a connected wiping cloud.
  ⛔ `/advance` converts **all three shapes** of the ladder's password question —
  `try_default_credentials`, `ask_for_password`, and the `halt` it returns on `passwordUnavailable` —
  into the cloud route, gated on: reset unspent, ticked+approved, not registered to us, and
  `makerCloudUnavailable !== true`. Both doors shut still ends at the honest hands-on halt.
  `customerPhoneView` gained `serialOnFile`; the match step shows a serial box (+ the sticker
  drawing) only when it is false, and `supplySerial` re-reads the run so the box removes itself.
  ⛔ The LAN/password path is NOT deleted — it is the fallback, and is what a Grandstream with no
  cloud still uses (desktop rc.16 login shape unchanged).
- ⛔⛔ **Round 6 (THIS ROUND): PARTS 2 AND 3 — the label as a PHOTO, uploaded or texted in.**
  Three doors now reach ONE gate (`recordLabel` in `deviceCloudRoutes.ts`): typed/scanned, an
  uploaded photo, and a photo texted to the business number. New routes: `POST …/label-photo`
  (multipart, OCR'd in memory, **image never stored**), `POST …/label-photo/expect` (the customer
  says which number they'll text FROM; we answer with the tenant's MMS-capable number), and
  `POST …/label-photo/check` (**one** read of the chat, on demand — nothing polls).
  New columns `labelPhotoFromE164` / `labelPhotoAskedAt` (migration `20260915000000`, additive).
- ⛔⛔ **THE TWO JUDGEMENT RULES, both tested — do not "simplify" either:**
  **(a)** a serial read off a picture we cannot vouch for is WORSE than no serial (it is stored, the
  maker's cloud rejects it later, and the customer sees an error about a number they never typed),
  so a photo is accepted only when OCR confidence ≥ 55 **or** the MAC on the sticker matches this
  very phone; **(b)** a LOW-confidence MAC mismatch reports "unreadable", never "that is a different
  device" — on a soft photo the address is the first thing OCR mangles, and that accusation is one
  a person holding the right handset cannot argue with. A HIGH-confidence mismatch still refuses.
- ⛔ Part 3 is bounded on every axis: the caller's own tenant, the one number they named, INBOUND
  only, **after** `labelPhotoAskedAt`, newest first, one message, one image. An older picture
  already in the thread can never answer this question (tested). An unreadable text keeps the
  expectation open so a better photo works; only an accepted label clears it.
- ⏳ **NOT PROVEN (rounds 5–6):** no customer has typed a serial, uploaded a photo or texted one;
  no phone has been cleared through GDMS from a serial; **OCR has never run on a real photograph
  here** (the suite fakes the engine deliberately — what is tested is our judgement, not Tesseract's).
- ⛔⛔ **ROUND 9 (`4011fa5f`, 2026-09-15): THE LABEL'S BARCODES ARE READ FIRST — OCR is the fallback,
  not the front door.** The first real label photo (Izzy's T42S, upside-down flash shot) went through
  all four Tesseract passes and read NOTHING, while both Code-128 barcodes on the same sticker carry
  the MAC and the serial exactly. New `apps/api/src/deskPhoneSetup/labelBarcodes.ts` (zxing-cpp via
  `zxing-wasm`, offline, no native deps) decodes every symbol, emits a 12-hex value bare (parses as
  MAC) and anything else plausible as `SN <value>` (parseDeviceLabel only takes serials behind a
  prefix), and returns confidence 100 — a Code-128 read is checksum-verified, not a guess. ⛔ The ONE
  gate (`recordLabel`) is still the only judge; a decoded MAC that mismatches the phone refuses
  exactly as before; junk/no-symbol input answers empty and the OCR passes run unchanged. Round-trip
  proven at all four rotations with the real values (`labelBarcodes.test.ts`, real engine, 4 tests;
  bwip-js devDep generates the symbols — ⛔ its default PNG background is TRANSPARENT, which flattens
  to black-on-black and decodes as nothing; tests set backgroundcolor FFFFFF). ⛔ zxing answers junk
  with one EMPTY error entry, not a throw — only entries carrying text count as symbols.
- ✅ **SAME COMMIT: the delivery form stops asking for what the system knows.** `provision` reuses the
  vouched serial on file for the MAC (same tenant; setup rows only ever store serials that passed the
  label gate — "a serial we cannot vouch for is never stored"), so the panel's serial box is optional
  with honest copy; `serial_number_required` only when nothing is on file anywhere. And
  `YEALINK_MANAGED_MODELS` grew **7 → 37** — every Yealink model with a PBX template
  (vendorCatalog.generated) and a vendor-template key range (buttonLayout `YEALINK_KEY_COUNTS`;
  `lineKeys` is the only field the config generator consumes — the BLF cap — and under-filling is
  harmless by that file's own rule). Izzy's own **T42S** (identity "confirmed" from his scan) had NO
  row, which is why the dropdown offered 7 models and he picked T31P. All new models stay
  `pending_handset_validation`.
- ⛔⛔ **LIVE FINDING, same day: Izzy's own T42S (`805ec0b3b2d0`) is RPS-CLAIMED BY ANOTHER
  ORGANIZATION.** His provision attempt (audit 14:49:07→14:49:13) got Yealink code 800004 →
  `rps_ownership_conflict`; his release then honestly removed nothing (the add never landed; our
  account reads 0 devices, checkMac existed:false — ⛔ v2 checkMac only ever sees OUR devices, so
  "not found" is NOT "free"). Consequence: shipped-style zero-touch for THIS unit needs the holder or
  Yealink support to release the MAC (proof of possession = the label photo + serial, tickets
  #530705 open); on his own LAN it still provisions fine — a factory-booting Yealink asks local PnP
  BEFORE RPS, and the office machine answers first.
- ⛔⛔ **ROUND 8 (`7e427c28`, DEPLOYED api+portal 2026-09-15 ~10:35Z): THE WIZARD OWNS A PHONE ON ITS
  OWN NETWORK.** Izzy, verbatim: *"the desktop wizard gets priority, and anything else is deleted.
  That phone belongs to the wizard."* Cause: his GXP2170 (…8C:60:5F), factory-reset in his house,
  halted on "Loopcom Support needs to finish" — its MAC still recorded under Create A Box T7_102
  whose REAL 102 is live on other devices, and `decideRehome` refused on ANY stranger registration.
  New policy in `decideRehome` (shared `provisioningRecord.ts`): stranger registrations stop
  blocking (releasing a MAC record never touches another device's registration); the release names
  them (`releasedOverLive`) and rides the existing auditRehome. ⛔ TWO FENCES SURVIVE, not
  negotiable: the presence pair (discoveredIp+requesterIp — without it a forged report could name
  another company's MAC) and the FORGER SHAPE (this handset's own LAN address live from another
  public address still refuses). Unreadable registration state still refuses. 33 rehome tests, 4
  rewritten, forger cases kept. Memory: [[the-wizard-owns-a-phone-on-its-own-network]].
- ⛔⛔ **SAME COMMIT: the driver's `rediscover` submits ONLY hardware ids the run already knows.**
  It posted the RAW host list — the pre-filter bug back through a second door: one post-reset sweep
  imported 87 of Izzy's home devices (router included) as "Desk phone / Finding" cards. New devices
  are the initial discovery's job, behind `classifyDiscoveredHosts`. Also `parseGdmsDevice` maps the
  PROVEN numeric `status: 1` → online (first real GDMS row; unobserved numbers stay unknown, never a
  guessed offline — offline gates cloud tasks).
- ✅ **THE FIRST REAL GDMS LIFECYCLE HAPPENED 2026-09-15 on Landau Home:** claim VERIFIED (device
  "Home" in the account, site Default), factory reset delivered through the cloud (twice — reset-first
  on the resumed selection), real device-row field shapes recorded in handoff §10h/§10i. The stale
  T7 record was released by hand under Izzy's explicit instruction (backup
  `pbx:/root/landau-gxp-record-release-20260915T100155Z/`), and the wizard then wrote the phone's
  record under tenant 21 ext 101 — the writer path proven end to end.
- ⛔⛔ **ROUND 7 (`3040f2bc`, DEPLOYED api 2026-09-15): GDMS `device/add` IS A BATCH ENDPOINT —
  the envelope's `retCode 0` does NOT mean the device was added.** First live GDMS write proved it:
  Izzy typed a serial that belongs to his OTHER Grandstream unit (serial tail `8C605F` vs this
  phone's MAC `…8C:65:4E`); GDMS answered retCode 0 with the refusal inside `data`
  (`success:0, failure:1, errorDeviceList[0].errorMsg "30010"`). `addDevice` ignored `data`, so the
  refusal read as success, read-back produced `claim_not_verified` (retryable) and the wizard spun
  on "Finding" until the 10-minute watchdog. Now a per-item failure throws → `gdms_request_rejected`
  (non-retryable; wording already names the serial-mismatch case). Simulator gained an "unowned"
  factory-registry state; the new test fails against the pre-fix client. ⛔ A stuck run keeps its
  wrong serial — cancel + rerun asks for the serial fresh. ⏳ No successful GDMS claim yet.
- ✅ **PARTS 2 AND 3 ARE LIVE IN PRODUCTION SINCE 2026-09-15** — Izzy hit the off-door while
  testing (Landau Home, GXP2170) and decided: *"every customer that has access to deskphone setup
  should have that photo reading turned on."* `CRM_OCR_ENABLED=true` is in `.env.platform` (backup
  `.env.platform.bak-20260915-ocr`), carried by commit `5adb347a` (a real `apps/api/.env.example`
  correction — an env-only change has NO deploy path, see the 2026-08-17 SIP-split handoff; a
  same-commit redeploy skips as `no_changes`, PROVEN AGAIN this day). Blue/green deployed,
  container-verified: `.build-commit` = `5adb347a`, `CRM_OCR_ENABLED="true"` read from the running
  container, 0 restarts, health 200. Client gate confirmed: the "Text the photo" door now asks
  "Which phone will you text it from?" instead of refusing. ⛔ The switch is SHARED — it also
  turns on CRM image-document OCR (Phase 5B) platform-wide; that is the round-6 one-engine design.
- ⏳ **NOT PROVEN:** GDMS credential IS saved (round 2 Verify passed), but no real reset yet (Izzy enters it on the card → Verify → Look up `C0:74:AD:8C:60:5F`);
  GDMS field names unverified; no real phone has gone through reset-first Prepare Device; neither screen seen in a browser.
- ⛔⛔ **ROUND 18 (2026-09-15): THE CUSTOMER SCANS THEIR OWN PHONES** (mockups approved first). New
  `DeskPhoneScanToken` + migration `20260916120000_desk_phone_scan_link` (additive): staff mint one
  link per run from the wizard's done screen; the customer opens `/phone-setup/<token>` on their
  phone, points the camera at each sticker, and the phones match themselves. ⛔ **Only the token's
  SHA-256 hash is stored** — the raw token is shown once, in the URL. ⛔⛔ **The browser decodes
  NOTHING**: it posts a frame every 1.5 s and the SERVER reads it through the same barcode→OCR chain
  and the same ONE gate (`recordLabel`) as the typed/uploaded/texted doors, so an old browser is
  never a dead end and there is one set of rules for what may be attached to a phone. ⛔ Matching is
  **by hardware address, never "the next phone in the list"**; an address not on the order is refused
  with the maker NAMED from its OUI, brand-agnostically across the four we are approved for
  (Fanvil / Grandstream / Yealink / Poly — Izzy: *"Not all 20 vendors for now"*; nothing widened).
  `/phone-setup/*` is anchored into the JWT bypass (the token IS the credential, re-checked every
  request) while minting and revoking stay JWT-gated behind `can_setup_desk_phones`. One live link
  per run — minting again revokes the last, so a link sent to the wrong person dies; missing/revoked/
  expired are ONE flat refusal that never says which; the serial never crosses to the customer view,
  only `serialOnFile`. Light + dark both shipped. Suite **287 tests, 286 pass, 0 fail, 1 skip** (+9).
  ✅ **DEPLOYED + container-verified `7d93d23a`:** api `69ba6ae4`→`7d93d23a806c…` and portal
  `6e3cc2b5`→`7d93d23a806c…`, both restarts **0**, health **200**; migration `20260916120000` applied
  and the `DeskPhoneScanToken` table proven present with all 12 columns and **0 rows** (inert until a
  link is minted); the shipped portal build carries the `phone-setup/[token]` route, its chunks and
  `ps-shell`. ⛔ The portal half was deployed by an **auto Deploy Center job** that picked up the push —
  my manual deploy was correctly refused with `runningCount=1`; never `--skip-queue-check` past that
  without reading `/ops/deploy/status`, because it means a real job is running.
  ⏳ **NOT PROVEN: nobody has opened the link on a real phone; no camera frame decoded in production.**
