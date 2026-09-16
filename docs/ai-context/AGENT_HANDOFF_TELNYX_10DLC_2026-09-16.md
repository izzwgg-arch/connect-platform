# ⛔⛔ AGENT HANDOFF — TELNYX 10DLC REGISTRATION ADMIN PAGE: MOCKUPS AWAITING IZZY, NOTHING BUILT (2026-09-16) — READ FIRST before building /admin/texting-registration or any Telnyx 10DLC code

Izzy, 2026-09-16: *"Does Loopcom already have a place where I can submit the 10DLC into
Telnyx?"* → answer was NO → *"Build it end-to-end. Make sure it works, is rock-hard, solid,
and sustainable for years to come, and put it in the admin section (new page). Show me
mockups before you build it."*

⛔ **His gate: mockups → approval → build.** Mockups are published; NO code, schema or
deploy exists. Do not start implementation until he approves and answers §4.

- Mockup file: `docs/mockups/telnyx-10dlc/index.html`
- Artifact: https://claude.ai/artifact/UjnMidL2iSzitYgutQCvbk (Version 3 is current — customer-link flow + decisions)

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
