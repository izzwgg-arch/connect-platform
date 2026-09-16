# ⛔⛔ AGENT HANDOFF — TELNYX 10DLC REGISTRATION ADMIN PAGE: MOCKUPS AWAITING IZZY, NOTHING BUILT (2026-09-16) — READ FIRST before building /admin/texting-registration or any Telnyx 10DLC code

Izzy, 2026-09-16: *"Does Loopcom already have a place where I can submit the 10DLC into
Telnyx?"* → answer was NO → *"Build it end-to-end. Make sure it works, is rock-hard, solid,
and sustainable for years to come, and put it in the admin section (new page). Show me
mockups before you build it."*

⛔ **His gate: mockups → approval → build.** Mockups are published; NO code, schema or
deploy exists. Do not start implementation until he approves and answers §4.

- Mockup file: `docs/mockups/telnyx-10dlc/index.html`
- Artifact: https://claude.ai/artifact/UjnMidL2iSzitYgutQCvbk (Version 1)

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
