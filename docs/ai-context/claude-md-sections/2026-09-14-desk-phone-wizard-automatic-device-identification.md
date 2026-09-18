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
- ⛔⛔ **ROUND 19 (2026-09-16, Izzy ran it himself — handoff §10r): three "done" things were NOT.**
  (1) his T42S hit a PASSWORD screen → new `known-credential` route: a password OUR provisioning
  wrote is read back from the phone's own cfg and auto-stored in the DESKTOP vault via
  `rememberCredential` — never in React state/logs/audit; proven live (200 for his real phone,
  wizard called it twice). ⛔ HONEST LIMIT: his unit holds the PREVIOUS provider's password
  (same unit RPS-claimed by another org), so ONE hand reset (OK ~10s) is physics, then never
  again. (2) the scan link only lived on the DONE screen → one shared offer on found/match/
  live/password/done, proven on his screen mid-run. (3) his own link answered **"All your phones
  are ready" with NO camera** (serial already on file → remaining=0 hid the button — the
  unconditional-tick lie rebuilt): camera is NEVER hidden now ("Scan another phone") and the
  all-scanned heading talks about STICKERS, not readiness; "All your phones are ready" greps 0
  in the shipped bundle. Deployed+container-verified: api `3ace3d4e` (has the route), portal tip
  `47584ef6`. ⛔⛔ deploy at the ORIGIN TIP, never your own sha — deploying `9c0fefde` rolled
  back a peer's live work (they caught it, redeployed tip). ⏳ app crashed once mid-scan; one
  scan took ~2 min vs the promised ~30s (slow probing, not frozen — /discovered landed);
  physical leg still open: his T42S needs its one hand reset; no phone yet registered
  end-to-end from a customer scan.
- ⛔⛔ **ROUND 20 (2026-09-16, handoff §10s — `020298b1`, tip `6c2ef93e`): THE SCAN PAGE IS A REAL
  SCANNER NOW.** Izzy: *"It doesn't really go into focus to actually scan. It needs to scan very
  efficiently right away."* Round 18 was a PHOTOGRAPHER — one JPEG POSTed to the server every 1.5s,
  camera asked for nothing → blurry at reading distance, almost never decodes. Now the browser runs
  the SAME `zxing-wasm/reader` ON-DEVICE (~7×/s on a centre crop), asks `getUserMedia` for 1080p +
  `focusMode:"continuous"`, shows a torch button where the phone has `torch`, and sends only the
  decoded TEXT to NEW `POST /phone-setup/:token/scan-text`. ⛔ THE SERVER STAYS THE ONLY JUDGE:
  shared `labelTextsFromSymbols` (extracted from `labelBarcodes.ts`) → `parseDeviceLabel` →
  match-by-MAC → the one gate, same refusals (maker-named 409, `nothing_matched_yet`, dies-with-link).
  Old browser with no wasm → the original photo-POST path still runs. ⛔ reader wasm served from OUR
  origin (`public/zxing/zxing_reader.wasm`; CSP blocks the CDN) — live `200 application/wasm`. Tests:
  deviceCloudRoutes 66 (+4 scan-text); both apps tsc clean on touched files. ⏳ nobody has scanned a
  real sticker through the on-device path — next, on Izzy's phone.
- ⛔⛔ **ROUND 21 (2026-09-17, handoff §10t): "NOTHING SCANS" ROOT CAUSE = the portal CSP blocked
  WASM ITSELF.** `script-src 'self' 'unsafe-inline' https:` lacks `'wasm-unsafe-eval'`, so
  `WebAssembly.instantiate()` threw (proven in real Chrome with the browser's own CSP error) and
  the decoder silently fell back to the slow photo path — a wasm file that returns 200 still
  cannot COMPILE. ✅ FIXED LIVE, NOT IN GIT: `/etc/nginx/connectcomms/security-headers.conf` line
  17 now carries `'wasm-unsafe-eval'` (backup `/root/security-headers.conf.bak-20260917-021803`),
  both hostnames verified serving it, and post-fix `WebAssembly.instantiate()` SUCCEEDS in the
  same real Chrome. ⛔ if scanning ever silently dies again with no code change, check that header
  FIRST — a server rebuild can revert it and no deploy can restore it. ⏳ real-sticker decode by a
  human still unproven (link must be RELOADED to pick up the new CSP); ⛔ Izzy's own T42S is
  unfixable in software (previous provider's password + RPS claimed by another org, 800004) — one
  physical factory reset, hold OK ~10 s.
- ⛔⛔ **ROUND 22 (2026-09-17, handoff §10u — Izzy: "not one successful register … start with Yealink …
  scanning rock solid, integrated with both databases"). FIVE READ-ONLY AGENTS MEASURED THE WHOLE CHAIN
  FIRST:** the office PC's PnP resident is armed, bound, joined, firewall-allowed on the (Public) Wi-Fi
  profile and **heard a synthetic multicast SUBSCRIBE in 5 ms** — it has heard nothing real because the
  T42S never reboots (27/27 LAN resets `refused:locked`); the rendered T21_101 cfg is structurally
  identical to the working A plus T53W's and the PBX auth matches; ⛔⛔ **13 days of PBX nginx logs hold
  ZERO fetches of this MAC from any real client** (Izzy's IP polls the same folder every 2 min for his
  Grandstreams); the registration mirror is seconds-fresh; our YMCS RPS account is live (server "Loopcom",
  0 devices). **Verdict: the product is correct; the one phone on his desk is locked by its previous
  provider AND RPS-claimed by another org (800004) — no software passes either wall.** Path for THAT unit:
  hold OK ~10 s once + Yealink's MAC-removal ticket (MAC + serial + photo). A factory-fresh Yealink is the
  acceptance test. ✅ BUILT: **(1) the office wizard claims every Yealink it knows into OUR RPS** (MAC +
  serial from the sticker, per-device redirect = the tenant's own `/phoneprov/<hash>/` folder, so a
  factory boot anywhere with internet self-provisions with no LAN/PnP/password) — `yealinkRedirectClaim.ts`
  → `ManagedPhoneService.claimForOfficeWizard` (ONE RPS writer; cross-tenant only with the presence pair;
  `options.redirectUrl`; no migration), hooked into the one label gate + `/assign` `/identify` `/retry`;
  800004 → `vendorCloudState=conflict` + honest note + staff link to the release form; customer chip
  "Zero-touch on" / "Held by previous provider" (`zeroTouch` on the customer view); Yealink stays OFF
  every cloud-reset path (`redirectOnly`, test-pinned). **(2) scan page rock solid:** decoder canary at
  page LOAD (built-in Code-128 "LOOPCOMSELFTEST" through the real wasm), honest chip "Fast scanner
  ready" / "Slow mode…", `mode` reported on every scan post (`DESK_PHONE_SCAN_MODE` audit, 1/token/hour),
  `deploy-portal.sh` verify FAILS a deploy whose CSP lacks `'wasm-unsafe-eval'` (warn-only when the edge
  can't be reached), `docs/ops/nginx-security-headers.REQUIRED.md`. Tests: api deskPhoneSetup
  **327/328** (+37; the 1 fail = the pre-existing local-Postgres test), shared **228/228**, portal
  **130/131** (the 1 fail = the documented pre-existing standing-listener test), api tsc **0 new** vs
  baseline, portal tsc 0. ⏳ NOT PROVEN: no phone has been claimed through the new door against real
  RPS; no clean Yealink has registered end to end (needs the handset).
- ✅✅ **ROUND 22 DEPLOYED + CONTAINER-VERIFIED 2026-09-17 ~16:07Z at the origin tip `e6adad6b`** (api 16:03Z then portal — sequential, one checkout): `app-api-1` `.build-commit` = `e6adad6b118e…`, 0 restarts, healthy, health 200 on both hostnames, `yealinkRedirectClaim.ts` present, `claimForOfficeWizard` ×2 / `zeroTouch` / the honest conflict sentence grepped in the running source; `app-portal-1` `.build-commit` = `e6adad6b118e…`, 0 restarts, the shipped `.next` carries "Fast scanner ready", "Slow mode", "Zero-touch on", "Held by previous provider", `LOOPCOMSELFTEST` and `decoderExpected`; `/phone-setup/x` + `/settings/desk-phones` 200 on both hostnames; CSP `wasm-unsafe-eval` served on both (the new deploy-portal verify stage ran and passed); `POST /api/phone-setup/<bogus>/scan-text` answers `link_not_found`. api level-50 lines after the deploy = only the standing IVR_MODE sweep / unattributed-calls monitors. ⏳ NOT PROVEN: nobody has opened the scan link (a reloaded link must now show "Fast scanner ready"), no Yealink has been claimed through the new door against real RPS, no clean handset has registered.
- ⛔⛔ **ROUND 22b (2026-09-17 evening, Izzy live: "I keep pressing Try Again and nothing happens" — 14 presses, ZERO attempts on the phone). TWO DEFECTS, BOTH FIXED (portal + api):** (1) `/retry` made the SERVER forget the halt, but the driver in the open window still remembered `locked` + `passwordUnavailable`, so every press re-halted in <1 s without touching the phone — after a hand reset the fresh phone would never be tried; NEW `driver.retried(phoneId)` drops every old observation (keeps a typed `credentialRef`), called from both retry call sites; (2) the round-22 RPS-conflict note was written from a STALE "ASSIGNED" snapshot ~1 s after the ladder halted and REPLACED the "hold OK ~10 s" instruction — `writeOutcome` now re-reads the row and never writes onto a halted phone or over anybody else's sentence. Tests: driver +2, redirect claim +2 (api deskPhoneSetup subset 154/154; portal 96/97, the 1 = the pre-existing standing-listener test; portal tsc 0). ⛔ AND THE HANDSET DID NOT RESET: 6 min of continuous ping, no PnP heard, no cfg fetch, still `refused:locked` at 21:26 — whatever happened at the keypad, the phone never rebooted factory-fresh (a T42S with a changed admin password may demand it for the keypad reset too; unconfirmed, Izzy asked what the screen showed).
- ✅ **ROUND 22b DEPLOYED + CONTAINER-VERIFIED 2026-09-17 ~21:55Z at the origin tip `64746df2`:** api + portal both `.build-commit` = `64746df2`, 0 restarts, health 200 on both hostnames; the re-read guard grepped in the running api source and `.retried(` in the shipped portal bundle; Izzy's desktop re-armed the listener at 22:00:45Z on the new bundle (joined 192.168.6.102). ⏳ The T42S itself still had not factory-reset by 22:03Z (web page up throughout, no PnP heard, no cfg fetch, no registration).
- ⛔⛔ **ROUND 23 (2026-09-17, Izzy after the register: "a robot and a browser hidden inside the wizard… the actual AI agent (OpenAI) runs the wizard and is taught everything, and should be able to improvise. The only thing the customer will have to do is factory reset the phones"). BUILT (not yet deployed at this bullet — see the deploy line below when added):** LIVE PROOF FIRST — a Playwright headless-Chrome prototype logged into Izzy's factory-reset T42S (admin/admin — the previous provider's RPS entry had planted its URL but NOT a lock), overwrote `AutoProvisionServerURL` with the Landau folder, triggered autoprovision, and the phone **REGISTERED as T21_101 in 65 s** (PBX log: `<mac>.boot`+`<mac>.cfg` fetched, first fetch of this MAC in 13 days; the mirror shows REGISTERED). Then productionised as THE ROBOT: **(1) desktop** `phoneWebRobot.ts` + `playwrightRobotBrowser.ts` — four fenced ops `web_probe`/`web_provision`/`web_reset`/`web_act` driving the phone's own web UI through the already-shipped headless Chrome, **caged to the one phone's IP** (context.route aborts any other host), only ever able to type a Loopcom `/phoneprov/<hex>/` folder; a factory phone that refuses an action-URI is no longer called "locked" (`webLoginMayWork`). **(2) driver** falls FORWARD to the robot: `factory_reset`→locked+webLoginMayWork → `web_probe`; PnP `delivered:false` → `web_provision` (save re-read to verify); an unknown screen → the improviser. **(3) brain** — `/robot-advise` calls the agent (`apps/agent` `phone_web_robot` task = **OpenAI primary**, `PHONE_ROBOT_PLAYBOOK.md`) for screens the script doesn't know; strict action schema; a customer never sees AI/robot/OpenAI words. **(4) the RPS wall** — the office-wizard RPS claim (round 22) fires the NEW **automatic Yealink MAC-removal** filer (`yealinkMacRemoval.ts`, capped 15/day under Yealink's 20, deduped) when a MAC is held elsewhere; a card on Admin → Integrations takes the one-time ticket.yealink.com cookie. ⛔⛔ **THE ONE FENCE THAT CANNOT BE DELEGATED**, HARDENED in review to catch bare hostnames/IPs and any fill into a server/URL-named field — enforced in BOTH the desktop op and the api `/robot-advise` endpoint, each with its own test. Tests: desktop 214/214, api deskPhone subset all green, portal driver 53/53, agent advisor 9/9, every touched file tsc-clean; desktop bumped rc.19. ⏳ NOT PROVEN: the wizard itself (not the prototype) driving a factory phone end to end; `playwrightRobotBrowser.ts` against a real handset; the agent improviser on a real unknown screen; a real MAC-removal filing.
- ⛔⛔ **ROUND 24 (2026-09-18, Izzy: "Build the GDMS redirect for Grandstream"). BUILT — the passwordless Grandstream zero-touch, hardened.** FACT ESTABLISHED FIRST from Grandstream's own machine-readable spec (doc.grandstream.dev api_data.json, 41 endpoints): **GDMS has NO API for a site/model/template-level provisioning redirect** — that is a web-console-only setting; the ONLY API redirect is per-device `device/config/xml` (already proven live 2026-09-15), which sets the phone's own P237/P212 at our phoneprov folder so it pulls from us on every boot. This round made that push trustworthy: **(1) THE TARGET FENCE** (`gdmsRedirect.ts` `assertRedirectConfigSafe`) — a config whose provisioning server (P237) or SIP server (P47) is a private/VPN/loopback/CGNAT address is REFUSED before the cloud is touched (the proven 10.8.0.1 Create-A-Box-VPN bug that made a phone flap), a config with NO P237 is refused (a redirect to nowhere), and a public HOSTNAME P237 must be a Loopcom host (a bare public IP passes — the real config uses the public PBX IP; the list's teeth are for look-alike hostnames); enforced inside `GrandstreamProvider.pushConfig` (always, list-free address gate) AND in `/prepare` with the tenant's own provisioning host. **(2) THE HONEST DELIVERY READ** — `GdmsDevice.synchronized` (GDMS's `isSynchronized`, 1→true/0→false/else null, never guessed) + `GrandstreamProvider.deviceStatus` + **`deliverRedirect`** which returns `delivered` (phone took the config) | `sent_applying` | `queued_offline` (pushed but the phone hasn't checked into GDMS — GDMS holds it; the 2026-09-15 silent-queue trap is now SAID to the person: "waiting for the phone to check in") | `not_claimed` | `refused`; `/prepare`'s cloud send uses it and writes the state onto the row + audit (`redirect:` in the PREPARE_STEP metadata). Simulator models isSynchronized (online push → synced; offline → queued). Tests: NEW `gdmsRedirect.test.ts` 15/15 (incl. deliverRedirect never pushes a VPN-targeted config), `/prepare` +2 (fence refusal reported not hidden; offline = honest "waiting" words + still pushed), deviceProviders/deviceCloudRoutes configs updated to the real fenced shape; api deskPhoneSetup **381: 380 pass, 1 fail = the pre-existing local-Postgres test**; tsc 0 in every touched file. ⏳ NOT PROVEN: a factory Grandstream going claim→check-in→redirect→register hands-off (needs the handset; Izzy's GXP2170s are GDMS-claimed and ready); the account-wide console template stays manual (no API — a GDMS web-console robot is the future path if wanted).
- ✅ **ROUND 24 DEPLOYED + CONTAINER-VERIFIED 2026-09-18 at the origin tip `bffc5ea6` (api only — no portal/desktop change):** `app-api-1` `.build-commit` = `bffc5ea6`, 0 restarts, healthy, health 200 on both hostnames; the fence (`assertRedirectConfigSafe` ×3 in the provider, `gdms_redirect_target_refused` ×5 in the module) and `deliverRedirect` ×2 in the /prepare wiring all grepped in the running source.
- ✅✅ **ROUND 25 (2026-09-17/18): GRANDSTREAM ZERO-TOUCH PROVEN LIVE, and "CONNECTED" IS PER-DEVICE
  TRUTH NOW (`828a07a8`, api deployed + container-verified).** Two facts from Izzy's live rig:
  **(a) the GDMS redirect worked autonomously** — the factory-reset GXP2170 at .172
  (c074ad8c605f, claimed into our GDMS 09-15) phoned home to fm.grandstream.com/gs, GDMS
  redirected it to our phoneprov folder, it pulled `cfgc074ad8c605f.xml` (200, 458KB ×2) and
  registered as T21_101 with NO wizard/LAN/password — GDMS probe (AgentSecret creds via
  `resolveGdmsCredentials(db)`, ⛔ NOT env) reads it **online:true, synchronized:true**; .171
  (c074ad8c654e) is NOT in GDMS, which is exactly why it did nothing. **(b) the wizard's status
  lied both ways** (Izzy: *"The wizard can never say that a phone is connected without it actually
  being connected... real data, not fake data"*): the PBX had BOTH .170 (Yealink) and .172
  registered on ext 101 at once (max_contacts=5) while the wizard knew neither correctly —
  because `PbxEndpointRegistration` is ONE ROW PER ENDPOINT and two contacts overwrite each other
  (the event table also masks per-contact re-registers: no endpoint-status transition → no event).
  ✅ FIX: new `PbxContactRegistration` (one row per (endpoint, phone's own LAN IP from
  `x-ast-orig-host`, which NAT cannot rewrite); migration `20260918040000`), upserted by
  `/internal/pbx/contact-status`; pure `phoneRegistrationTruth()` in
  `apps/api/src/deskPhoneSetup/phoneRegistrationTruth.ts` answers per phone — own contact decides
  outright (+ `registeredAsExt`, so a self-provisioned GDMS/RPS phone shows as the connected thing
  it is), extension held by a DIFFERENT device = refused, cold mirror = old extension-level
  fallback; `withConnectedNow` + advance's `registeredToUs` both go through it, and green
  additionally requires registered AS THE MAPPED EXTENSION. 11 new tests replay the live run
  (incl. the .171 lie); 260 desk-phone tests green. LIVE-VERIFIED: within seconds of cutover the
  table held real rows (T7_103/10.88.0.2, T8_104/192.168.7.18). ⛔ deploy runs from
  `/opt/connectcomms/app` with `bash scripts/deploy-direct.sh` (NOT /opt/connect; NOT ./ — the
  script is not executable). ⏳ T21 rows appear as the phones re-register (≤1h); Izzy has not yet
  re-opened the wizard to see honest statuses; "delivered-but-not-registered → robot reboots via
  phone UI" is designed, not wired.
  re-opened the wizard to see honest statuses; "delivered-but-not-registered → robot reboots via
  phone UI" is designed, not wired.
- 🎨 **ROUND 26 (2026-09-18): THE WIZARD REDESIGN — MOCKUPS ONLY, awaiting Izzy (artifact
  `Tty5aheU7hviHCMGi5vToG`).** Izzy's directive, verbatim in substance: *"this is how every phone is
  going to be done. The wizard is going to have browsers, the backend, and literally open the UIs and
  put the link in… All we have to do is get the customer to factory reset the phones… harden the fuck
  out of this… Laybel live with the customer… powered behind the GPT… ready for every situation, able
  to improvise, and get the phones connected at all costs… an illustration for each phone, for each
  brand, on how to factory reset… connect one phone at a time… check the last 4 of the MAC."*
  Seven artboards, Signal Core palette (#22A8FF/#4F7BFF on #0C1218): (1) which extension, (2) which
  phone — cards keyed by the LAST 4 of the MAC + fresh/old-settings/already-connected state, (3)
  factory reset with a per-MODEL illustration (Yealink T42S: hold OK 10 s; a Grandstream GXP2170
  variant board proves the per-model library), the screen advances ITSELF when the network watch sees
  the phone come back fresh (robot admin/admin login = proof of reset), (4) connecting — robot
  timeline in plain words, green ONLY from per-device registration truth (R25), (5) connected → ring
  it → next phone, (6) STUCK: the old-provider RPS claim case with the auto-filed Yealink release
  (R23) and "I'll finish it myself when they let go" — never a dead end. Laybel = permanent left rail:
  Anam face (customer rollout still OFF, 300 s cap, slow — see the Laybel summary) with captions that
  never stop + quick-reply chips + text/mic; brain = the R23 OpenAI robot advisor + the wizard rules.
  ⛔ NOT BUILT: nothing in the portal changed; the per-model reset recipe/illustration library does not
  exist yet (427 models → recipes per FAMILY, verify each against the maker's manual before it ships);
  Laybel-in-the-wizard is to be built on the APPROVED shape, not bolted onto the 11-step batch wizard
  it replaces. ⛔ container note: `deskPhoneRoutes.test.ts` cannot run inside app-api-1 (its
  `mock.module("@connect/db")` has no workspace alias there — pre-existing, passes locally).
- ✅ **ROUND 27 (2026-09-18, Izzy: "go"): THE GUIDED SETUP IS BUILT — one phone at a time, Laybel in
  the rail, per-model reset pictures, last-4 sticker check.** Additive: the classic
  `DeskPhoneWizard.tsx` is untouched and one click away ("Classic setup"); the settings page now opens
  `GuidedPhoneSetup.tsx` by default. Same run, same routes, same `setupDriver.ts` — this is a different
  SCREEN on the same engine, never a second engine.
  • `packages/shared/src/deskPhoneSetup/resetRecipes.ts` — the reset-recipe library, one per MODEL
    FAMILY (yealink T-series PROVEN hold-OK-10s; yealink DECT base, grandstream GXP/GRP menu path,
    grandstream HT pinhole, polycom VVX = DOCUMENTED; fanvil/cisco/snom/htek = INFERRED with a caveat
    on screen; everything else = the generic card). ⛔ `confidence` is the honesty flag — never dress
    an inferred recipe up as certain. 7 tests incl. a customer-words guard (no "provisioning"/"LCD").
  • `apps/api/src/deskPhoneSetup/laybelGuide.ts` + `POST /desk-phones/runs/:id/laybel` — Laybel's
    brain: SCRIPTED lines per situation (13 situations, built from run facts incl. per-device
    `connectedNow`) + the IMPROVISER (gpt-4o-mini via `resolveOpenAiKey(db)` — ⛔ the api's env key is
    the "(paste…" placeholder, the real one is in AgentSecret) behind the TRUTH FENCE: any sentence
    claiming connected/registered/live while `connected=false` is DROPPED, password asks dropped,
    URLs/IPs stripped, empty → scripted fallback. 60 model calls per run (in-process). 14 tests.
  • `apps/portal/components/deskPhones/GuidedPhoneSetup.tsx` (+ `guidedFlow.ts` pure screen logic,
    11 tests; `ResetIllustration.tsx` per-shape SVGs; `guidedSetup.css` gps- classes on the dps
    tokens): extension → phone cards keyed by the LAST 4 of the MAC (typed to confirm; a mismatch is
    refused on screen) → reset screen with the recipe + picture that ADVANCES ITSELF (every 8 s a
    Yealink `web_probe`; factory password opening the page = proof, then `/retry` + `driver.retried`)
    → robot timeline from the driver's hints → connected (ONLY `connectedNow` + registered AS the
    mapped ext; "Ring it now" = `crm:dial`) → next. Stuck screen wording from the server's note
    (old_provider / password / not_checking_in / unsupported). ⛔ The confirm click ("Set it up — this
    wipes it") is the reset authorization: `authorize-reset` is sent ONCE for the focused phone only.
    Discovery runs in the background from the first screen and the robot logs into every Yealink in
    parallel (3 workers) to mark "fresh out of the box". Laybel rail: captions ALWAYS (server words),
    chips, text ask; the Anam `LaybelVideoCall` mounts on "Turn on video" when `/support/laybel/status`
    allows it (owner preview today) and `onSpeaker` makes her SAY every caption.
  ⏳ NOT PROVEN by a human yet: no customer has walked it; Laybel video in the rail untested live; the
  robot family is Yealink-only so "fresh" is unknown (honest "Not connected yet") for other makers.
- ✅ **ROUND 28 (2026-09-18): A SUPER-ADMIN RUNS THE WIZARD FOR ANY CUSTOMER FROM THE TENANT
  SWITCHER.** Izzy: *"if I'm at the tenant's location, connected to their network, I can just run
  the wizard for them from my computer, from my account."* The portal already sends the switcher's
  tenant as `x-tenant-context` on every call; the desk-phone doors read `req.user.tenantId` (the
  admin's OWN tenant), so a super-admin's run, extensions, provisioning folder, PnP pending list
  and Laybel were all Loopcom's. ✅ `apps/api/src/deskPhoneSetup/effectiveUser.ts`
  (`effectiveDeskPhoneUser`): SUPER_ADMIN + UUID-shaped `x-tenant-context` → `tenantId` = that
  tenant; every other role keeps the token's tenant (header ignored). Wired at the ONE source —
  `deskPhoneRoutes.ts`'s `getUser` (shared by deviceCloudRoutes/phoneRobotRoutes/MAC-removal via
  deps) and `managedPhoneRoutes.ts`'s `actor`. Ownership checks (`ownRun`) stay tenant-scoped, so
  switching tenants mid-run 404s the other run (correct). Audit rows keep `actorUserId` = the admin.
  The guided screen shows a standing banner "Setting up phones for <Tenant>" whenever acting as a
  customer. 5 new tests; desk-phone api suites 155/155 with it. ⏳ Not yet done live by Izzy on a
  customer LAN. ⛔ The desktop's PnP responder gets its folder through the PORTAL's `/pnp-config`
  call (PnpResidentHost), so it follows the switcher too — the desktop itself never calls the api.
- ✅ **ROUND 29 (2026-09-18): GRANDSTREAM ROBOT FAMILY + YIDDISH + THE MIC.** Izzy: *"add
  Grandstream to the robot's web login families… I should be able to select Yiddish also, and the
  agent should communicate through Yiddish Labs… Add a mic so they can talk for transcription."*
  • **Grandstream family** (`apps/desktop/src/phoneSetup/grandstreamWebRobot.ts`, desktop rc.21): the
    same three fenced ops through the phone's cgi surface (`access`→`dologin`→`api-sys_operation`,
    proven live 09-14; admin/admin on a factory GXP proven 09-17) — probe (login + `api.values.get`
    identity + `config_get` P237/P212), provision (URL fence → wrong-device check on the MAC the phone
    reports → `config_update` P237/P212 → **READ-BACK; a phone that kept its own value is refused
    `save_not_verified`, never "provisioned"** — that is the GDMS-claimed case, which the server's R24
    redirect road then handles — → REBOOT), reset (RESET). `robotFamilyFor(vendor)` picks the family;
    `vendor` now rides every `web_*` request (capability.ts, driver, guided screen); the driver's
    Yealink-only gates (reset-fallback + web_provision) admit grandstream; the desktop's shared
    3-failure lockout gate is what keeps a GXP off its 5-attempt lockout. 11 new desktop tests
    (fake GXP2170 incl. the claimed no-op). ⛔ `mac_addr`/`sw_version` key names on `api.values.get`
    are inferred (only `phone_model` is proven) — identity fields are optional and a missing MAC does
    NOT block provisioning (the IP came from the same discovery as the MAC).
  • **Yiddish** (`laybelLanguage.ts` + `ylClient.ts`, api): `language: "yi"` on `/laybel` → the
    customer's Yiddish is translated to English for the brain (YL `translate-english`), the fenced
    English reply is rendered in Yiddish (YL `translate-yiddish`, cached in-process) as
    `sayYiddish`/`chipsYiddish`; the avatar still SPEAKS the English (owner's language contract);
    YL failure → English on screen, never silence; YL never retried. Rail: English/ייִדיש toggle
    (remembered per computer), RTL captions/chips/input.
  • **The mic**: `POST /desk-phones/runs/:id/laybel/hear` (webm ≤1.3 MB base64) → YL
    `transcriptions/sync` (auto Yiddish/English) → `{transcript, english, yiddish}`; the rail's
    press-to-talk (MediaRecorder, ≤30 s) shows the transcript as the customer's caption and sends the
    English to Laybel. 8 new api tests. ⏳ NOT PROVEN live: no Grandstream has been driven by the
    cgi family from the wizard; no Yiddish turn or mic clip has gone through a real YL call from
    this screen; desktop rc.21 build/install status in the next bullet.
- ✅ **ROUND 30 (2026-09-18, Izzy's first WALK of the guided setup): "stuck on 'We found 4 phones —
  loading extensions'"** — the DB says why: run `cmu72hhgg…` was created on `connect-admin-tenant-v1`
  (the platform's own tenant, 0 extensions) because the tenant menu was not on the customer; the
  screen then showed an EMPTY list as "Loading…" for ever and Laybel had nothing to say about it.
  ✅ Fixed: (1) a super-admin with no customer picked gets NO run — the screen says "Whose phones are we
  setting up? Pick the customer in the tenant menu" and Laybel says it too; the run starts the moment
  a customer is picked; (2) extensions have four honest states (loading / ready / empty "add the
  people under Team first" / failed + Try again), each with a Laybel line; (3) THE STICKER
  DEMONSTRATION on the phone screen (Izzy: "a few stickers… it has to be the MAC… give a
  demonstration… how many digits, hyphens"): a drawn sticker line `MAC: 00-0B-82-1A-2B-3C` with the
  last four lit, "12 characters in pairs, with - or : between or none, only 0–9 and A–F"; Laybel's
  choose_phone line says the same; (4) **O → 0** (Izzy: "MAC addresses never have O's… take it as a
  zero"): `normalizeSticker()` upper-cases, maps O→0, strips the word MAC (⛔ "MAC" is hex-shaped —
  A, C — and was counted as digits until stripped) and everything non-hex; the field shows the
  normalized value as they type; 1 new test. ⛔ Landau has ONE Active extension in Connect's
  `Extension` table (101) — 102 exists on the PBX only, so the guided screen offers 101 alone until
  102 is added in Connect. ⏳ Izzy walks it again.
  ✅ **Desktop `0.1.17-rc.21` BUILT + INSTALLED on Izzy's PC (2026-09-18 15:37Z):** tsc exit 0,
  electron-builder exit 0, `Connect-Setup-0.1.17-rc.21.exe` 102,592,251 bytes; asar carries
  `dist/phoneSetup/grandstreamWebRobot.js`; installed asar sha256 `acd25f1e…ca699` IDENTICAL to the
  build; relaunched, log banner rc.21, 0 error lines; updater refuses the rc.10 fleet feed as a
  downgrade (⛔ NOT published — the fleet stays at rc.10). ⛔ Build recipe that works under Node 24:
  `npx tsc -p tsconfig.json` then `npx electron-builder --win` (never `pnpm build` — its schema
  guard trips on line endings), install with `powershell Start-Process <exe> -ArgumentList '/S' -Wait`,
  then relaunch `%LOCALAPPDATA%\Programs\@connectdesktop\Loopcom.exe` (the silent install closes
  the app and does not reopen it); the app's log is `%APPDATA%\@connect\desktop\logs\connect.log`.
