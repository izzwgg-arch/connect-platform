# ⛔⛔ AGENT HANDOFF — TELNYX 10DLC REGISTRATION ADMIN PAGE: BUILT + DEPLOYED, LIVE-PROVEN TO READY-TO-FILE, NO REAL FILING YET (2026-09-16) — READ FIRST before building /admin/texting-registration or any Telnyx 10DLC code

Izzy, 2026-09-16: *"Does Loopcom already have a place where I can submit the 10DLC into
Telnyx?"* → answer was NO → *"Build it end-to-end. Make sure it works, is rock-hard, solid,
and sustainable for years to come, and put it in the admin section (new page). Show me
mockups before you build it."*

✅ **Approved and BUILT the same day** (§000). The mockup sections below are the design record.

- Mockup file: `docs/mockups/telnyx-10dlc/index.html`
- Artifact: https://claude.ai/artifact/UjnMidL2iSzitYgutQCvbk (Version 3 is current — customer-link flow + decisions)

## 000. ✅ BUILT, DEPLOYED, LIVE-PROVEN UP TO "READY TO FILE" (2026-09-16 evening) — READ THIS FIRST

Izzy: *"Go ahead and build it end-to-end, stress test it, and be ready to send it out today."*
Plus, on the email: *"should not say anything about Telnyx … just explain that these are the
regulations, and to continue using SMS, you need to fill out the 10DLC form. That's it. Then a link
to the form."*

**Commits:** `85dee5bc` (module, pages, schema, keys) + `34ff3aae` (server.ts wiring).
⛔ Worktree hazard hit on the way: another session's `2acf52b8` swept this module's UNCOMMITTED
server.ts wiring into its own commit (origin would not boot); a third session took it back in
`5f279499`; this task committed the module on a PRIVATE INDEX (only its 24 files) and re-wired
by pathspec. The shared index was then re-synced for every path (it showed the new files as
deleted — a plain `git commit` by anyone would have deleted them).

### What exists (all under platform-staff + key gates)
- **api `apps/api/src/textingRegistration/`** — `content.ts` (generated carrier wording, the
  business's own privacy policy + SMS terms, every published rejection-cause check),
  `tokens.ts` (EIN AES-GCM token bound to the registration id, masked last-4, 14-day TTL; link
  token = 32 random bytes, only SHA-256 stored, one live link per registration, 30 days),
  `phases.ts` (raw registry states → Loopcom states; unknown NEVER approves),
  `registryClient.ts` (Telnyx 10DLC per the OpenAPI spec — separate from the wizard's
  `telnyxOnboardingClient.ts` whose early "approved" would be wrong here), `engine.ts`
  (create/link/draft/submit/send-back/file/advance/appeal/deactivate/PIN/sweep),
  `emails.ts`, `routes.ts`, `wire.ts` (ALL dependencies; server.ts is 3 lines).
- **Tables** (migration `20260916210000_texting_registration`, additive): `TextingRegistration`,
  `TextingRegistrationLink`, `TextingRegistrationEin`, `TextingRegistrationEvent`.
  ⛔ Deliberately NOT `TenantSmsRegistration` — the wizard's sweep would advance these rows.
  A tenant the wizard already registered at Telnyx is refused (one brand per EIN).
- **Routes**: `/admin/texting-registration/*` (board, customers, prefill, create, detail, link
  [+email], revoke, email-preview, reveal-ein, content, business, send-back, file, refresh,
  appeal, deactivate); public `/texting-registration/:token` (+draft, submit, pin, resend-pin),
  `/texting-registration/policy/:slug`; webhook `/webhooks/telnyx/10dlc` (Ed25519 fail-closed,
  a TRIGGER to re-read only). JWT bypass anchored; api prefix rule
  `/admin/texting-registration → can_view_admin_texting_registration`.
- **Portal**: `/admin/texting-registration` (board: Needs you / Waiting on customer / In review /
  Live; New registration picker) and `/admin/texting-registration/[id]` (send email / create &
  copy link / turn off, business with source tags + "Fill it in myself", EIN Show (audited),
  wording editor — locked after filing except samples/HELP/opt-in, checks, charges,
  File with Telnyx confirm, send back with ticked fields + note + auto-email, progress per
  carrier + numbers, appeal, history, deactivate by typing the name). Public
  `/texting-registration/[token]` (logo, light/dark via the sign-in toggle, EDITABLE only legal
  name / type / EIN / IRS address / website (+ owner mobile for sole prop) / signature / consent;
  account facts + carrier wording LOCKED; fix mode unlocks only `fixFields`; PIN step; sent
  receipt). Public `/texting-policy/[slug]` — ⛔ SERVER-RENDERED (reviewer tools read raw HTML),
  fetched via `PORTAL_API_INTERNAL_URL`.
- **Keys**: page `can_view_admin_texting_registration` + actions `can_send_texting_registration_link`,
  `can_view_texting_registration_ein`, `can_file_texting_registration`,
  `can_fix_texting_registration`, `can_deactivate_texting_registration`; none in a default bucket;
  nav id `admin.texting_registration` is SUPER_ADMIN-forced + in OWNER_ONLY_FIXED (Locked).
- **The invite email** (`TEXTING_REGISTRATION_INVITE`, never ADMIN_ALERT): subject "Action needed:
  complete the 10DLC form for <business>"; body = carriers now require registration (10DLC) →
  "To continue using SMS for <business>, please fill out the 10DLC form" → button + plain link.
  Ready email `TEXTING_REGISTRATION_READY` once on live. No carrier name anywhere.

### The money path (traced before building — do not change without re-tracing)
Registration charge = `createOneTimeChargeInvoice` for **$24.00** "Business texting (10DLC)
registration", created once (claim on `chargeAddedAt`) when the BRAND is created, with DEFAULT
dates (start = end = the filing moment). Traced: autopay selects only invoices whose period
contains the payment instant; a paid `one_time_charge` never counts as covering a period unless its
text says "monthly service"; the service cutoff counts only FAILED/OVERDUE (never auto-set);
creation sends no email. ⛔ So it is a SEPARATE OPEN invoice that a person collects — not a line
on the next cycle invoice (billing has no one-shot-line mechanism; adding one touches the
preview builder used by ~7 read routes). Monthly campaign fee + marketing: DEFERRED, shown nowhere.

### Rules the engine keeps
States advance only from registry re-reads; creating writes claim a `…StartedAt` column
atomically and are reconciled (brand by display name, campaign by referenceId) after a timeout,
never resent; after 20 min unreconciled → `error` for a person. Per-registration in-flight lock
(the stress run found two concurrent checks double-assigning a number). EIN destroyed on
verification or 14 days unfiled. Usecase spelling read from `/10dlc/enum/usecase` at first
filing. Sweep every 10 min, boot kick 2 min, kill switch `TEXTING_REGISTRATION_SWEEP_DISABLED=1`,
boot line `TEXTING_REGISTRATION_SWEEP_ARMED`. Numbers: only tenant `TenantSmsNumber` rows with
provider TELNYX are attached; VoIP.ms numbers wait until moved (checked hourly while live).

### Proven (see TESTS_RUN.md for numbers)
41 unit/engine/stress tests incl. 300 customers; api + portal typecheck clean in these files;
deployed api `34ff3aae` (migration applied, sweep armed); LIVE inside the container on the
"Loopcom Telnyx Test" tenant up to Ready to file: 25 concurrent submits → 1; EIN token has no
digits; audited reveal; 422 field errors; invite email really SENT; random-token flood 404 +
per-IP 429; forged webhooks 401; TENANT_ADMIN 403.

### Browser proof + the two bugs only it found
In real Chrome on app.loopcom.net: public form light+dark with logo, empty Send → 10 errors + focus, typed submit → thank-you; admin board, review page, audited EIN Show, Close. ⛔ Found: (1) the public page could not scroll — the portal locks `html/body { overflow: hidden }` for the signed-in shell, so ANY public page must be its own scroll container (`.tr-page { height:100dvh; overflow-y:auto }`); (2) ConnectSelect sets `width:160px` inline — fill a column with `!important`. Both fixed (`6c2ef93e`, then `9a04bb2c` — ⛔ ConnectSelect's `.cs-wrap` also carries `min-width:160px`, so `min-width:0 !important` is needed too). Portal live = `9a04bb2c`. ⚠️ After a portal deploy a browser holding an old HTTP/2 connection can get 502s for minutes (old nginx workers route to removed blue/green ports) — use the other hostname to get a fresh connection when verifying; platform fix spawned as its own task.

### ⏳ NOT PROVEN — the acceptance test is the first REAL customer filing
Nothing has been filed with Telnyx (costs $24 and needs a real EIN): brand verification, campaign
review, number assignment, the charge invoice, the ready email and a real 10DLC webhook have only
run against the simulated registry. The sole-prop PIN on a real phone. A human filling the form in
a browser. ⛔ Customer links use `canonicalPortalOrigin()` = **app.connectcomunications.com**
(the same domain every customer email uses today) — Izzy may want app.loopcom.net for this.

## 00. ⛔⛔ REVISION 3 (same day) — IZZY'S DECISIONS + THE PRIVACY-POLICY RESEARCH

Izzy, verbatim: *"Yes, EIN should be tokenized. So, the $25 a month that's on the customer. The
$150 a month, I will decide later. For now, don't say anything about that. The same with the
marketing. What do you mean? I cannot have a business text message if I don't have a privacy
policy page?"* then *"check on the internet what people say and what Telnyx says … Dig in."*

**Decided (mockup V3, same artifact, Version 3):**
- ✅ **EIN is TOKENIZED**: encrypted token, masked last-4, reveal = permission + audit row,
  token destroyed when the registry verifies the brand (or 14 days unfiled). Legacy base64 EINs
  get the same treatment.
- ✅ **Up-front charge goes on the customer's invoice.** Read as the ~$24 up-front Telnyx cost
  (brand $4.50 + carrier review $15 + campaign $4.50) — he said "$25 a month"; the only ~$25
  figure shown was the $24 up-front, so that is the interpretation. ⚠️ Confirm on the build if
  in doubt. Mockup shows a one-time "Business texting registration $24.00" on the next invoice.
- ⛔ **The monthly campaign fee ("$1.50") and MARKETING are deferred — "don't say anything about
  that."** Removed from EVERY screen (guarded in the mockup build: no "$1.50", "$10/mo",
  "Marketing ·"). Every customer is filed as the conversational program with no price shown.
  Do not add a program picker or monthly line until he decides.

**Privacy policy research (2026-09-16, full cited report in this session; key facts):**
- **Not a hard registry field** — TCR CSP User Guide Oct 2025: *"While this field is optional in
  TCR, having a compliant Privacy Policy is required."* Telnyx `campaignBuilder.privacyPolicyLink`
  is optional. Reviewers (DCAs) reject without one.
- **Customer-texts-first does NOT waive it** — CTIA / T-Mobile / Telnyx only waive extra
  PERMISSION for customer-initiated threads; no source waives the policy. Bandwidth 7107 even
  wants verbal opt-in scripts to reference it.
- **Telnyx (support 10645583, updated 2026-01-12):** reseller *"cannot substitute your privacy
  policy in lieue of the brand's"*; Google's policy not accepted; must say mobile info is not
  sold **or shared**. Telnyx 9940291 (2025-11-06): no website → Google Business Profile or social
  links. Sole-prop guide asks only for a website/social URL.
- **Hosting**: TCR accepts uploaded PDFs (CTA/Privacy/T&C multimedia upload, 10MB, 5 files);
  Bandwidth accepts PDFs and Drive/Dropbox links; Vonage/Plivo/RingCentral/Quo want a real
  website. **No official source addresses a policy written in the customer's name but hosted on
  the ISV's domain — UNCONFIRMED either way.**
- **Twilio made Privacy + T&C URLs REQUIRED for API campaign registrations from 2026-06-30**
  (errors 30933/30934) — the direction of travel is stricter.
- **Accepted wording** (Plivo/Telnyx/HawkSoft-TCR): *"No mobile information will be shared with
  third parties/affiliates for marketing/promotional purposes. All the above categories exclude
  text messaging originator opt-in data and consent; this information will not be shared with any
  third parties."* Don't mention marketing on a non-marketing campaign (Bandwidth 7200).
- ⏳ UNCONFIRMED: whether Telnyx's API exposes TCR's document-upload field (not found in the
  research); Reddit first-hand reports were unreachable.

**Plan in V3 (awaiting his OK):** Loopcom generates a privacy policy + SMS terms in each customer's
LEGAL name, publishes them on a public page (e.g. loopcom.net/sms/<slug>), and attaches them if
the API allows; the form's website field accepts a Google Business or Facebook link for
no-website customers. First real filings are the proof.

**Remaining open:** (1) privacy plan OK?; (2) auto-move approved numbers' texting to Telnyx with
backup; (3) fix the two broken legacy 10DLC gates.

## 0. ⛔⛔ REVISION 2 (same day) — THE CUSTOMER FILLS IT IN; IZZY PRESSES "FILE WITH TELNYX"

Izzy, verbatim: *"for each customer, it should create a link that I'll be able to copy and then
send it to them, or just send out an email to them … just like all the other Loopcom emails with
the real Loopcom logo in it. … wherever the system could fill in, the system should already have
filled it in. Only the EIN address and all that stuff they have to fill in. The legal stuff, the
opt-in, opt-out, all that, the system should already fill that in automatically. … dark and light
mode … Once they fill it in, it uploads … then I have to press a button to upload it to Telnyx for
now, but maybe later we'll make it automated."* Then: *"I don't want to confuse them either, so
they could see it, just not edit it, only the information that we need from them."*

Mockup **V2** (same artifact URL, Version 2) replaces the v1 staff-typed wizard with:
- **Admin board** per customer: No link → Link sent → Opened → **Ready to file** → Filed →
  Carriers reviewing → Live; actions Create link / Copy link / Remind / Review & file.
- **Create-link dialog**: private link (30-day expiry, replaced when regenerated, dead once sent
  back), recipient prefilled from account owner, Send email, "Fill it in myself".
- **The email** = the `loopcomEmailShell` look (packages/shared/src/loopcomEmailShell.ts), real
  `loopcom-wordmark-email-336.png`, footer names the tenant, its own EmailJob type (⛔ never
  ADMIN_ALERT — muted at the send door), links from `canonicalPortalOrigin()`. Lists what they'll
  need before they click. ⛔ NO carrier name anywhere on customer surfaces.
- **Public customer page** `/texting-registration/<token>` (login-card idiom `.lc-login-*`,
  `loopcom-wordmark-560.png`, follows light/dark): **ONLY editable inputs = legal name, EIN,
  business type, IRS address, website, typed signature, consent.** Everything else is SHOWN
  READ-ONLY: account facts (display name, phone, email, contact, numbers) and the generated
  carrier wording (use description, samples, STOP/HELP/START replies, opt-in flow, keywords,
  privacy link) — three shown, the rest behind "Show". Autosave excludes the EIN. A sent link
  becomes a read-only receipt; expired/replaced links show a calm page with the phone number.
- **Admin review & file**: every value tagged customer / system / account; admin CAN edit the
  generated wording (the customer couldn't); pre-filing checks; itemised charges; one button
  "File with Telnyx · $24.00" which then runs brand → verify → campaign → assign unattended.
- **Needs a fix**: brand refusal → the same link reopens with ONLY the refused field(s) unlocked
  plus admin's note; EIN re-entered; brand updated in place (no new fee). Campaign-wording
  rejections are admin-side (the customer never wrote them).
- **Settings**: "File automatically when a customer sends the form" designed in, ships OFF; when
  on, files only all-green cases with sufficient balance.
- **Six keys**: view / send link / view EIN (audited) / file / fix / deactivate.
- Sole-prop PIN goes on the customer's link (resolves v1 decision 5).

⛔ **EIN storage CHANGES vs v1**: filing happens later, so the EIN must be held. Proposed:
encrypted (`encryptJson`) in its own column, masked last-4, reveal needs a key + audit row,
**purged when the registry verifies the brand**, or after 14 days unfiled. Awaiting Izzy.

**V2 open decisions**: (1) EIN hold-then-purge as above; (2) customers with no privacy policy —
a Loopcom-hosted page in their name (carrier acceptance UNCONFIRMED) vs requiring their own;
(3) who pays $24 + monthly; (4) marketing program chosen by admin on review (recommended) vs by
the customer; (5) auto-move approved numbers' texting to Telnyx with backup; (6) fix the two
broken legacy 10DLC gates.

(The v1 design record below is superseded where it conflicts.)

## 1. What exists today (verified 2026-09-16, Explore inventory)

- **No Telnyx 10DLC code anywhere.** `apps/api/src/telnyx/telnyxClient.ts` has messaging
  profiles (list/create), RCS, SMS send — zero brand/campaign/number-campaign calls. No
  Telnyx messaging-profile id is stored in the DB.
- **Two older 10DLC systems, both unrelated to Telnyx:**
  1. `TenDlcSubmission` (schema.prisma ~1863) + `POST /ten-dlc/submit`, `GET /ten-dlc/status`,
     `/admin/ten-dlc/submissions*` (server.ts ~9254-9358) — a form + manual approve/reject,
     never filed anywhere. ⛔⛔ **Its `einEncrypted` column is plain base64** (`encodeEin`,
     server.ts ~1467) — not encryption. No portal page posts to `/ten-dlc/submit`.
  2. `TenantSmsRegistration` (schema ~4660) + `signalwire/signalWireTenDlc.ts` — the automated
     SignalWire chain (collected → brand_filed → … → active), sweep every 10 min, EIN pass-through
     with NO column (guard-tested), activation upserts `TenantSmsNumber` (provider SIGNALWIRE,
     tenant default) + sets `Tenant.dailySmsCap` + emails `SMS_REGISTRATION_ACTIVE`. Fed by the
     onboarding texting step (`POST /onboarding/:token/texting-registration`, SignalWire-only).
     Read-only board at `/admin/onboarding/ports` (no nav entry).
- ⛔ **`/settings/sms-mode` LIVE gate** reads `latestTenDlcStatus` (the OLD TenDlcSubmission
  table) — a Telnyx-approved customer would still be refused LIVE unless this is reconciled.
- ⛔ **SMS Campaigns page gate is broken regardless**: `apps/portal/app/(platform)/apps/sms-campaigns/page.tsx`
  expects `{ submission: { status: "approved"|… } }` but `/ten-dlc/status` returns the raw row
  with uppercase statuses → it ALWAYS shows "not registered". (Decision 6.)
- Carrier-migration board's `tendlc` gate counts `TenantSmsRegistration` rows only
  (`carrierMigration/board.ts` ~99-181, 350, 486) and says "not registered on SignalWire".
- Telnyx webhook door: `telnyx/telnyxWebhooks.ts` → `/webhooks/telnyx/sms` only, Ed25519 via
  `verifyTelnyxSignature` in `loopcomMobile/mobileWebhookRoutes.ts:39`, public key from the
  bench credentials. A 10DLC status route would reuse it + need a `jwtPublicRouteBypass` entry.
- Encryption helper: `encryptJson/decryptJson` (@connect/security, AES-256-GCM).
  Telnyx events audit via `recordTelnyxEvent` → `AgentAuditLog` (`telnyx.*`).
- Admin nav pattern: navConfig entry (section admin) + `SIDEBAR_ITEMS` row in
  `packages/shared/src/portalPermissions.ts` (creates the key) + `OWNER_ONLY_FIXED_NAV_ITEMS`
  + SUPER_ADMIN force line in `isNavItemVisibleForUser` + api prefix permission rule
  (server.ts ~3085-3099). FOURTH RULE: both permission screens in the same commit.

## 2. Telnyx 10DLC API — the facts the build must follow (research 2026-09-16)

⛔ **Source of truth = Telnyx's OpenAPI spec** (github.com/team-telnyx/openapi
`openapi/spec3.json`; the Node SDK is generated from it). **Their docs pages contradict the
spec in at least five places** — follow the spec:
- vetting path: spec `/10dlc/brand/{id}/externalVetting` with `evpId` (docs say `/vetting`)
- number assignment: spec `/10dlc/phone_number_campaigns` (docs say `/phoneNumberCampaign`)
- campaign create: spec `POST /10dlc/campaignBuilder` (ISV page says `/10dlc/campaign`)
- rejected campaign: spec HAS `POST /10dlc/campaign/{id}/appeal` (docs say "create a new one")
- webhook payload: docs show an envelope (`event_type` 10dlc.brand.update / 10dlc.campaign.update /
  10dlc.phone_number.update, `payload.type`), spec shows a FLAT body — parse BOTH, log a real
  delivery before trusting either.

**Brand** `POST /10dlc/brand` — spec-required: entityType, displayName(100), country(2),
email(100), vertical. Docs also require companyName, ein, phone, street, city, state(2),
postalCode(5), website for non-sole-prop → require them in the form. PUBLIC_PROFIT needs
stockSymbol+stockExchange+businessContactEmail. Optional webhookURL/webhookFailoverURL,
isReseller, mock. Returns brandId, tcrBrandId, identityStatus
(SELF_DECLARED | VERIFIED | VETTED_VERIFIED | UNVERIFIED), status
(OK | REGISTRATION_PENDING | REGISTRATION_FAILED), failureReasons.
`GET /10dlc/brand/feedback/{id}` → categories TAX_ID/STOCK_SYMBOL/GOVERNMENT_ENTITY/NONPROFIT/OTHERS.
PUT updates in place; `PUT …/revet` once, then once per 3 months. DELETE refused with active
campaigns. **One brand per EIN.** Max 5 campaigns per brand. Live enums:
`GET /10dlc/enum/{usecase|vertical|entityType|campaignStatus|mno|…}` — ⛔ read usecase
spellings from here (LOW_VOLUME_MIXED spelling UNCONFIRMED).
UNVERIFIED almost always = legal name/address/EIN not EXACTLY the IRS CP-575 record.

**Sole proprietor**: entityType SOLE_PROPRIETOR + mobilePhone; `POST …/smsOtp`
`{pinSms (must contain @OTP_PIN@), successSms}` → referenceId; `PUT …/smsOtp {otpPin}` → 204,
identityStatus VERIFIED; PIN 6 digits, 24h expiry; **no campaign until verified**; 1 campaign,
1 number, ~1,000/day; no LLC/Inc/Corp in the name; no PO boxes.

**Campaign** `POST /10dlc/campaignBuilder` — spec-required brandId, description, usecase;
in practice also sample1/2, messageFlow, helpMessage, opt keywords, and
subscriberOptin/Optout/Help = true (else TCR rejects). Limits: description 40–4096,
messageFlow 40–2048, opt/help messages 20–320, keywords ≤255 comma-no-space. MIXED/LVM need
2–5 subUsecases (qualify endpoint returns min/max). `referenceId` must be unique → **use it as
the idempotency key** (the never-retry-a-creating-write rule). Pre-check:
`GET /10dlc/campaignBuilder/brand/{brandId}/usecase/{usecase}` returns fees + mnoMetadata.
**After creation only samples, helpMessage, messageFlow, autoRenewal, webhook URLs are editable.**
campaignStatus: TCR_PENDING, TCR_SUSPENDED, TCR_EXPIRED, TCR_ACCEPTED, TCR_FAILED,
TELNYX_ACCEPTED, TELNYX_FAILED, MNO_PENDING, MNO_ACCEPTED, MNO_REJECTED, MNO_PROVISIONED,
MNO_PROVISIONING_FAILED. Per-carrier: `GET …/operationStatus` (map of MNO network id →
status; get id→name from `/10dlc/enum/mno`). DELETE = permanent deactivation. Campaigns with no
activity 15+ days and no numbers may be suspended.

**Numbers** `POST /10dlc/phone_number_campaigns {phoneNumber, campaignId}` (bulk:
`POST /10dlc/phoneNumberAssignmentByProfile {messagingProfileId, campaignId}` → taskId).
assignmentStatus PENDING_ASSIGNMENT | ASSIGNED | FAILED_ASSIGNMENT | PENDING_UNASSIGNMENT |
FAILED_UNASSIGNMENT. Number must be on a messaging profile first; US 10-digit only (toll-free
is a separate `/messaging_tollfree/verification` API); one campaign per number; ~2h typical,
up to 72h; texts sent before ASSIGNED usually fail; T-Mobile caps 49 numbers/campaign.

**Webhooks**: set per brand and per campaign (no account-wide setting); same Ed25519 headers
(`telnyx-signature-ed25519`, `telnyx-timestamp`); 5 retries 30s apart then failover URL.

**Errors — THREE shapes**: standard `{errors:[{code,title,detail,source}]}`; 422
`{detail:[{loc,msg,type}]}`; campaignBuilder/appeal 400/402 possibly an UNWRAPPED
`{code,title,detail}`. 402 on campaignBuilder ≈ insufficient balance. 429 code 10011 with
retry-after. Parse all three defensively.

**Fees** (support 5634625, updated 2026-07-22; verify before billing customers): brand $4.50
(spec text still says $4); campaign carrier review $15 per review; campaign monthly LVM $1.50,
sole-prop $2, charity $3, emergency $5, standard $10, agents/franchises $30 — **3 months charged
up front, non-refundable**; vetting $4.50/$41.50/$101.50; surcharges T-Mobile $0.003 SMS,
AT&T $0.003, Verizon $0.0045, USC $0.005; T-Mobile number pool $50.
Throughput: T-Mobile daily cap by score (unvetted 2,000; sole prop 1,000); AT&T LVM 75 SMS/min.

**Timelines**: brand verify minutes; Telnyx review same/next business day; carrier review
~3 business days (T-Mobile fastest); assignment ~2h. Account must be Level 2 (izzy@loopcom.net
is VERIFIED — satisfied). ISV rule: separate brand per end customer; never share numbers
across brands; privacy policy must be the CUSTOMER'S own, not Loopcom's; keep opt-in records ≥4 years.

## 3. The design in the mockups (12 screens)

Board with "Needs you" default filter + balance/webhook health line → 4-step wizard (Business
→ Campaign with live compliance checks → Numbers (only Telnyx-registrable numbers selectable,
reasons shown) → itemised-charges confirm, one deliberate file, referenceId idempotency) →
detail with per-carrier review + history + edit samples / check now / deactivate (type name) →
rejected (appeal via spec endpoint, or new campaign with price on button) + unverified brand
fix-in-place (EIN re-entered) → sole-prop PIN (staff entry or owner link) → requests (turn
SignalWire manual-queue / old-form rows into Telnyx drafts; refuse if already moving on
SignalWire) → settings/health → four permission keys → decisions.

Engine design: states advance ONLY from re-reads of Telnyx (webhook = trigger, like
SignalWire); 10-min sweep with boot kick + kill switch + ARMED line; activation reuses the
SignalWire activation semantics (TenantSmsNumber upsert → provider TELNYX, previous provider as
`fallbackProvider` per the Phase-1 router, dailySmsCap, customer email with NO carrier name).

Proposed keys: `can_view_admin_texting_registration`, `can_file_texting_registration`,
`can_fix_texting_registration`, `can_deactivate_texting_registration` — no default bucket.

## 4. Decisions awaiting Izzy (the build is blocked on these)
1. Never store the EIN (recommended) — and clean up the base64 `einEncrypted` legacy column?
2. Who pays fees: customer invoice (one-time + recurring line) or Loopcom absorbs?
   (onboarding currently tells customers $15 one-time, monthly included)
3. Platform staff only (recommended)?
4. Auto-move approved numbers' texting to Telnyx with previous carrier as backup (recommended)
   vs a per-number switch button?
5. Sole-prop PIN: staff entry, owner link, or both (recommended both, link default)?
6. Also fix the SMS Campaigns page gate + the LIVE-mode gate to read this system's status?

## 5. ⏳ NOT PROVEN / NOT DONE
Everything. No code, no schema, no tests, no deploy, no Telnyx call made. Every fee and
status above is from web research, not a live filing — the first live filing (proposed: Loopcom's
own business) is the acceptance test.

## 000b. 2026-09-16 late — nine real customer drafts prepared (Izzy sends the links)
Izzy: *"I'm going to need a 10DLC from all of them. Prepare a 10DLC for all of them, filled in with all the information we already have, and then leave the boxes they need to fill in empty, and then I will send them the link."* "All of them" = the nine tenants with outbound SMS in the last 30 days (census in `2026-08-07-turning-sms-on-for-a-customer.md`). Created via the deployed route with an HS256 SUPER_ADMIN token minted inside `app-api-1` (sub = izzywgg SUPER_ADMIN, tenantId `connect-admin-tenant-v1`). Registration ids: B Visible `cmu4l96b3023qru13t87nkcrj`, Create A Box `cmu4l96fr023uru13doyowq1t`, Displaydex `cmu4l96jh023yru13v02ma3tu`, Fixup `cmu4l96lv0242ru13qrl2xa1x`, Gesheft `cmu4l96or0246ru13wg6jtq6r`, Hanna `cmu4l96sw024aru13vzpwjzf2`, Luxure `cmu4l96vu024iru13n2rzd428`, Relax Tires `cmu4l96zw024mru13ob191fd3`, Trust `cmu4l971x024qru13v8cv3rmw`. Deliberately NO link created: `createLink` revokes older links and only a hash is stored, so a link made now could not be shown to Izzy later and would start its 30-day clock early. Gaps and the VoIP.ms-number caveat: see the summary file bullet of the same date.

## 000c. 2026-09-16 night — THE SWITCHER (VoIP.ms → Telnyx texting moves by itself)
Izzy: *"build the switcher"* → *"The switches will automatically detect when it's switched to telnyx and kick in."*
Code: `apps/api/src/textingRegistration/switcher.ts` + `switcher.test.ts`, wired at the end of `wire.ts` (commit `56879d0f`, deployed by a parallel session's `deploy-direct.sh api --commit 56879d0f` — container verified). Flow and traced blast radius are in the file header and the summary bullet. Operational notes:
- Detection = `findOwnedNumber` (Telnyx `/phone_numbers?filter[phone_number]=`) per active VOIPMS row with a tenant, status must read `active`; `port-pending` waits.
- The flip is `updateMany({ where: { id, provider: "VOIPMS" }, data: { provider: "TELNYX" } })` — the ONLY TenantSmsNumber write in the module (source-guarded). Never add a second writer.
- It logs only when it acts (`texting switcher took action`, `texting_switcher_switched`), so a quiet log after boot is normal; proof it did nothing = provider counts unchanged + 0 `telnyx.texting_switched` rows in AgentAuditLog.
- ⛔ Deploy lesson hit on the way: a server-side waiter written as `while pgrep -f "deploy-direct.sh"` matches ITS OWN `bash -c` command line and waits forever; so does any `ssh … 'pgrep -f "x"'` probe. Use `pgrep -f "[d]eploy-direct.sh"` or wait on a PID.
- ⏳ First real proof = 845-723-1213 going active on Friday 9/18 (Connect Communications, no campaign) or a customer's port: expect the row TELNYX within 5 min + a `number_switched` History event.
## 000c. 2026-09-17 — Trust Bookkeepings: the first real customer link
Izzy: *"Prepare me a 10DLC link for trust bookkeeping."* Created via the deployed link route
(same HS256-from-`JWT_SECRET` recipe as §000b; the container has no `@prisma/client` at `/app`,
so a Prisma script fails — go through the api on 3001). Result: registration
`cmu4l971x024qru13v8cv3rmw` `draft` → `awaiting_customer`, link expires 2026-10-17T15:29Z,
`emailed:false` (Izzy sends it). Verified from outside: `/texting-registration/<token>` 200 and
`/api/texting-registration/<token>` 200 — ⛔ and that api GET stamps `openedAt` (the public read
route marks the link opened), so the board now shows Trust "opened" before the customer saw it.
Verify a link through the portal page, never the api. ⛔ Only the hash is stored — the URL lives in
the chat reply; a second Create link revokes it (older links turned off). Board state after this:
links out for Gesheft, Relax Tires, Fixup (09-16 night, not recorded here until now) + Trust; still
`draft` with no link: Displaydex, B Visible, Luxure, Hanna, Create A Box.

## 000d. 2026-09-18 — Gesheft: the first REAL "File with Telnyx" press, refused at brand creation
Izzy: *"gesheft has submitted their 10DLC, and I think it was denied. Check why."* Read straight off
the live row (`TextingRegistration` `cmu4l96or0246ru13wg6jtq6r`) + its `TextingRegistrationEvent`s:
`customer_submitted` 13:47:47Z (fields legalName/entityType/street/city/state/postalCode/website,
einUpdated true, signature "Pinches Meisels", IP 199.16.53.3) → `filing` 13:55:30Z → `filing_refused`
→ `filing` 13:55:54Z → `filing_refused`. `lastError` = *"Telnyx refused the business details: 400:
10015 Bad Request stockExchange, stockSymbol, and businessContactEmail are required for public profit
entity."* Cause: the customer chose `entityType = PUBLIC_PROFIT` ("Publicly traded company"). Telnyx
requires stock exchange + symbol + business contact email for that type (§2 says so) and the form
collects none of them, so brand creation is impossible for any PUBLIC_PROFIT submission. State after:
`status submitted`, no brand id, `chargeAddedAt` null (the $24 claim happens only after a brand is
created), `brandCreateStartedAt` null (reset by the refusal branch) — clean to refile.
Two remedies, Izzy's call: (a) staff correct it on the review page ("Fill it in myself" →
`staffUpdateBusiness`, allowed in `submitted`, `entityType` is in CUSTOMER_FIELDS) to PRIVATE_PROFIT
and refile; (b) `sendBackToCustomer(["entityType","legalName"], note)` so the customer attests it
themselves. Also: legal name "Gesheft " (trailing space, no LLC/Inc) is unlikely to be the IRS
record → expect `UNVERIFIED` on the brand unless corrected; address "Suit 316-207" looks like a
mailbox suite (TCR may flag). ⛔ Product hole to close (not done 09-18): either drop PUBLIC_PROFIT
from the public form's choices, or add the three fields + a `fail` check in `runFilingChecks`. The
$24 only lands after `brand_created`, so refusals never bill.
