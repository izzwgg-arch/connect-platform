# Data Model Cheat Sheet — Prisma / Postgres

> **Goal:** keep agents from re-deriving the schema every chat.
> **Scope:** the ~20 highest-traffic / highest-risk models. Full schema is
> at `packages/db/prisma/schema.prisma` (~2,840 lines, ~95 models).
>
> Rule of thumb: if the model is here, **read this doc instead of the
> schema first.** If you do load the schema, jump to the line ranges below.

## How to read this doc

- **Tenant-scoped?** "Yes" means the model has a `tenantId` (or
  derivable equivalent). Every read/write **must** filter by tenant unless
  you are operating in `SUPER_ADMIN` context.
- **High-risk?** "Yes" means a single bad write has visible business
  impact (mis-routes calls, charges money, exposes another tenant's data,
  or breaks PBX state).
- **Modified by**: which service most commonly writes this model.
- All UNKNOWN items are exactly that — verify in the schema before changing.

---

## Tenant
- **Schema:** `schema.prisma` line 278
- **Purpose:** Top-level account boundary. Every other model in this file
  hangs off of `tenantId`.
- **Key relationships:** owns `User[]`, `Extension[]`, `PhoneNumber[]`,
  `MobileDevice[]`, `CallInvite[]`, `ConnectChatThread[]`,
  `IvrRouteProfile[]`, `MohProfile[]`, `BillingInvoice[]`,
  `PaymentTransaction[]`, `DidRouteMapping[]`, `TenantPbxLink?` (1-1 to
  the PBX it lives on), and many more.
- **Sensitive fields:** `smsLiveEnabledByUserId`, `smsProviderLock*`,
  `iceServers` (TURN/STUN URIs), `outboundProxy`, `sipWsUrl`, `sipDomain`.
  Some of these can leak provider/PBX topology if exposed cross-tenant.
- **Tenant-scoped?** Self.
- **High-risk?** **Extreme.** This model is the boundary; cross-tenant
  reads are the worst defect class in this app.
- **Modified by:** `apps/api` (admin tenant routes) and `apps/worker`
  (turn validation / media test / sms routing locks).
- **Warnings:**
  - Adding a column requires a migration in `packages/db/prisma/migrations`.
    Production migrations only run via the `api` deploy-queue job; never
    run them manually.
  - Many enums (`SmsSendMode`, `MediaPolicy`, `TurnValidationStatus`,
    `MediaTestStatus`, `DtmfMode`) live next to this model — do not
    reorder enum values; that breaks Postgres `enum` ordering and forces
    a destructive migration.

## User
- **Schema:** line 407
- **Purpose:** Auth identity inside a tenant.
- **Key relationships:** `tenantId`, `ownedExtensions: Extension[]`
  (via `ExtensionOwner` relation), `mobileDevices: MobileDevice[]`,
  `callInvites`, `callWakeEvents`, `connectChatParticipants`.
- **Sensitive fields:** `passwordHash`, `email` (also unique globally,
  not per-tenant — UNKNOWN whether this is intentional; cross-tenant
  email collisions are rejected).
- **Tenant-scoped?** Yes via `tenantId`.
- **High-risk?** **Yes** — auth + role assignment.
- **Modified by:** `apps/api` (auth, admin user CRUD).
- **Warnings:**
  - `UserRole` enum has 11 values including `SUPER_ADMIN`,
    `TENANT_ADMIN`, `BILLING_ADMIN`, `EXTENSION_USER`. Role-permission
    snapshots are tracked in `PlatformRolePermissionSnapshot`.
  - `forcePasswordReset` is checked in `auth/login`; do not bypass.

## Extension
- **Schema:** line 1491
- **Purpose:** A tenant's phone extension number. Maps to a VitalPBX PJSIP
  extension via `PbxExtensionLink`.
- **Key relationships:** `tenant`, `ownerUser?`, `pbxLink: PbxExtensionLink?`
  (1-1), `mobileDevices: MobileDevice[]`, `callInvites`, `callWakeEvents`,
  `connectChatParticipants`.
- **Sensitive fields:** `pbxUserEmail`.
- **Tenant-scoped?** Yes.
- **High-risk?** **Yes** — wrong assignment can ring the wrong phone.
- **Unique:** `(tenantId, extNumber)` — never two extensions with the
  same number per tenant.
- **Modified by:** `apps/api` (extension CRUD, provisioning).

## PhoneNumber
- **Schema:** line 942
- **Purpose:** A real DID owned by a tenant (Twilio / VoIP.ms / Bandwidth-style).
- **Key relationships:** `tenant`, `pbxDidLinks: PbxDidLink[]` (when
  routed through PBX), `smsMessages` (SMS history).
- **Sensitive fields:** `providerId`, `provider`, `friendlyName`.
- **Tenant-scoped?** Yes.
- **High-risk?** **Yes** — number purchase / release moves real money
  and changes carrier state.
- **Unique:** `phoneNumber` is **globally** unique (E.164).
- **Modified by:** `apps/api` (number search/purchase/release).

## ConnectCdr — *the* call-history model
- **Schema:** line 1686
- **Purpose:** Connect-owned canonical row per completed call. Source of
  truth for the live calls list and dashboard call-history widgets.
- **Key relationships:** No FK to `Tenant` (uses string `tenantId`
  including `vpbx:{slug}` placeholder when not yet linked to a Connect
  tenant). Indexed by `(tenantId, startedAt)` and `(startedAt)`.
- **Sensitive fields:** `fromNumber`, `fromName` (CNAM), `recordingPath`.
- **Tenant-scoped?** Yes (string), but values can be `null` or `vpbx:<slug>`
  pre-resolution.
- **High-risk?** **Yes** — directly drives KPIs and call-history UI.
  Mis-counting here = "the dashboard is wrong".
- **Unique:** `linkedId` (Asterisk Linkedid — the canonical dedupe key).
- **Modified by:** `apps/telephony` writes via `/internal/cdr-ingest`
  to `apps/api`; the worker reconciles late-arriving rows.
- **Warnings:**
  - Direction values are `"incoming" | "outgoing" | "internal" | "unknown"`.
  - Disposition values are
    `"answered" | "missed" | "busy" | "failed" | "canceled" | "unknown"`.
  - `dcontext` and `dcontextsSeen` are the most authoritative direction
    signal — do not "improve" direction logic without referencing
    `docs/DASHBOARD_KPI_SOURCE.md` and `docs/LIVE_CALL_FORENSIC_RUNBOOK.md`.
  - `recordingPath` follows `YYYY/MM/DD/<linkedId>.wav`. Never let a
    user-supplied path land here.

## CallRecord
- **Schema:** line 1666
- **Purpose:** Older / parallel call-history row, keyed by
  `(tenantId, pbxCallId)`.
- **Tenant-scoped?** Yes.
- **High-risk?** Yes — parallels `ConnectCdr`. **UNKNOWN — verify
  before changing**: it is unclear whether `CallRecord` is being phased
  out in favour of `ConnectCdr` or whether both are still authoritative
  for different views. Read `apps/api/src/server.ts` `/calls/*` routes
  before refactoring either.
- **Modified by:** `apps/telephony` and `apps/api`.

## CallInvite
- **Schema:** line 2020
- **Purpose:** A push-driven invite to ring a specific user/extension on
  their mobile device(s) for an active inbound call.
- **Key relationships:** `tenant`, `user`, `extension?`, `acceptedByDevice?`.
- **Status:** `CallInviteStatus` enum: `PENDING | ACCEPTED | DECLINED | CANCELED | EXPIRED | HELD | RESUMED | ENDED`.
- **Tenant-scoped?** Yes.
- **High-risk?** **Extreme** — if this row is wrong, the user either
  doesn't ring or rings forever, or the wrong device gets the call.
- **Unique:** `(tenantId, pbxCallId)`.
- **Modified by:** `apps/api` (creates), mobile app (accepts/declines via
  `/me/...` routes), `apps/worker` (`callInviteExpiry` cycle marks
  expired rows).

## CallWakeEvent
- **Schema:** line 2060
- **Purpose:** Append-only timeline of every step in the
  `PBX → backend → FCM → device → SIP → INVITE → answer` pipeline. Used
  by the call-wake diagnostics admin UI to reconstruct exactly what
  happened.
- **Stages (free-form string):**
  `WAKE_REQUESTED | WAKE_DEVICES_RESOLVED | WAKE_PUSH_QUEUED | WAKE_PUSH_DELIVERED | WAKE_PUSH_FAILED | DEVICE_PUSH_RECEIVED | DEVICE_REGISTER_TRIGGERED | DEVICE_REGISTER_COMPLETE | DEVICE_INVITE_RECEIVED | DEVICE_ANSWER_TAPPED | WAKE_TIMED_OUT`.
- **Source values:** `pbx_dialplan | api | device`.
- **Tenant-scoped?** Yes.
- **High-risk?** Low for the row itself, but absence of rows is the
  primary signal that "calls don't ring on mobile".
- **Modified by:** PBX dialplan helper, `apps/api`, mobile app.
- **Warnings:** `details` JSON is capped at ~4 KB by convention; keep
  it small so the diagnostics UI stays cheap.

## Voicemail
- **Schema:** line 1748
- **Purpose:** Mailbox messages synced from VitalPBX.
- **Key relationships:** Loosely tied to a tenant via `tenantId`
  (nullable) and an extension number string.
- **Sensitive fields:** `pbxRecfile` (token-authenticated playback path),
  `callerNumber`.
- **Tenant-scoped?** Yes (when resolved).
- **High-risk?** Yes — voicemails are private.
- **Unique:** `pbxMessageId = "{pbxTenantId}|{ext}|{origtime}|{callerDigits10}"` (synthetic).
- **Modified by:** `apps/worker` (`runVoicemailSyncCycle`), `apps/api` (`/internal/voicemail-notify`).

## VoicemailIngestIncident
- **Schema:** line 1493
- **Purpose:** Durable **super-admin** incidents when voicemail **ingestion** stalls or diverges (notify path, worker sync, helper HTTP errors, REST vs spool). Not end-user voicemail rows.
- **Key fields:** `fingerprint`, `scenario`, `severity`, `status`, `tenantId` (nullable = platform-wide), `metadata` (sanitized JSON — **no** secrets or full helper URLs).
- **Tenant-scoped?** Optional — `tenantId` null allowed.
- **High-risk?** Low direct PII — operational visibility only; still super-admin gated.
- **Modified by:** `packages/db/src/voicemailIngestIncidentService.ts` (called from `apps/api` notify handler + `apps/worker` sync cycle). Listed via **`GET /admin/voicemail-ingest/incidents`** and merged into **`GET /admin/ops-center`** / **`GET /admin/incidents`** when open.

## MobileDevice
- **Schema:** line 1788
- **Purpose:** A user's installed mobile app instance.
- **Key relationships:** `tenant`, `user`, `extension?`.
- **Sensitive fields:** `expoPushToken` (unique), `voipPushToken`,
  `deviceId`, `manufacturer`, `model`, `osVersion`.
- **Tenant-scoped?** Yes.
- **High-risk?** Yes — wrong row = wrong device gets a push.
- **Modified by:** `apps/api` `/mobile/devices/register` (and downstream
  `lastPushSentAt`/`lastPushStatus`/`lastPushError` updates from the
  push fan-out helper).

## PbxInstance / TenantPbxLink / PbxExtensionLink / PbxDidLink / PbxCdrCursor / PbxJob
- **Schema:** lines 1517 / 1593 / 1609 / 1639 / 1655 / 1769
- **Purpose:** Connect's bookkeeping for VitalPBX. Each tenant in Connect
  links 1-1 to a `PbxInstance` via `TenantPbxLink`, and each Extension
  links 1-1 to a `PbxExtensionLink`.
- **Sensitive fields:** `apiAuthEncrypted`, `ombuMysqlUrlEncrypted`,
  `sipPasswordEncrypted` (AES-256-GCM via `@connect/security`).
- **Tenant-scoped?** Yes (each link row).
- **High-risk?** **Extreme** — these tables drive every PBX call.
- **Modified by:** `apps/api` (admin link/unlink), `apps/worker`
  (`runPbxJobsCycle`), `apps/telephony` (read-only via API).
- **Warnings:** Never decrypt these fields and write them back in
  plaintext anywhere — encryption envelope is keyed by
  `CREDENTIALS_MASTER_KEY`.

## PbxTenantDirectory / PbxTenantInboundDid
- **Schema:** lines 1538 / 1555
- **Purpose:** Cached VitalPBX tenant rows + DID assignments. Powers
  deterministic `(VitalPBX tenant_id | slug | T8 code) → Connect tenant`
  resolution at CDR ingest.
- **Tenant-scoped?** Indirectly (via `connectTenantId` once linked).
- **High-risk?** Yes — tenant resolution defects = cross-tenant CDR
  contamination.
- **Modified by:** `apps/api` (admin "PBX tenant refresh"), not polled.

## CdrTenantRule
- **Schema:** line 1756
- **Purpose:** Fallback DID/extension-prefix rules to assign a `tenantId`
  on `ConnectCdr` ingest when AMI events don't resolve cleanly.
- **Tenant-scoped?** Indirectly.
- **High-risk?** Yes — wrong rule routes another tenant's CDR rows.
- **Modified by:** `apps/api` `/admin/cdr/tenant-rules`.

## IvrRouteProfile / IvrOptionRoute / IvrScheduleConfig / IvrOverrideState / IvrPublishRecord
- **Schema:** lines 2106 / 2150 / 2173 / 2194 / 2212
- **Purpose:** Connect-owned IVR routing for Option A. The publish path
  writes AstDB keys under `connect/t_<slug>` (see `ASTDB_KEYS.md`).
- **Tenant-scoped?** Yes.
- **High-risk?** **Extreme** — drives every inbound call's destination.
- **Modified by:** `apps/api` `/voice/ivr/*` (manual publish + rollback)
  and `apps/worker` `runIvrScheduleCycle()` (automatic mode switch).
- **Warnings:**
  - `IvrPublishRecord.previousKeys` is the rollback snapshot. Never
    write a publish without first capturing the snapshot via
    `POST /telephony/internal/astdb-read-family`. See
    `docs/pbx/option-a-runtime-keys.md` for the contract.
  - `optionDigit` is `"0".."9" | "star" | "hash"` (NOT `"*"` / `"#"`).

## MohProfile / MohScheduleConfig / MohScheduleRule / MohOverrideState / MohPublishRecord / MohLastPublishedState / MohAsset / PbxMohClass
- **Schema:** lines 2315 / 2346 / 2369 / 2393 / 2412 / 2436 / 2587 / 2558
- **Purpose:** Same shape as IVR but for music-on-hold. `MohProfile` has
  `holdMode` and `mohClass` fields; publish writes the active MOH class
  + hold announcement keys to AstDB.
- **Tenant-scoped?** Yes.
- **High-risk?** Yes — wrong publish = the wrong audio plays during hold,
  or worse, no audio at all.
- **Modified by:** `apps/api` `/voice/moh/*`, `apps/worker`
  `runMohScheduleCycle()`.

## MohExtensionOverride / MohAssignmentJob (Phase 1, 2026-05-11 — schema only; Phase 2, 2026-05-11 — API routes live, DB-only; Phase 3A, 2026-05-11 — publish wiring + rollback)
- **Schema:** `MohExtensionOverride` and `MohAssignmentJob` in
  `packages/db/prisma/schema.prisma`; migration
  `packages/db/prisma/migrations/20260521090000_moh_extension_override_phase1/`.
- **Purpose:** Data foundation for per-extension MOH overrides. Phase 1 is
  **inert**: no API route, no portal UI, no worker consumer, no AstDB write.
  `MohExtensionOverride` will (in a later phase) drive the AstDB family
  `connect/t_<slug>/extensions/<extension>/moh_class` and the fallback
  `…/active_moh_class`. `MohAssignmentJob` will (in a later phase) persist
  bulk "selected tenants" / "all tenants" / "selected extensions in a tenant"
  assignment requests with status + per-target audit.
- **Tenant-scoped?** `MohExtensionOverride` is tenant-scoped via
  `tenantId` (FK → `Tenant`, `onDelete: Cascade`); unique
  `(tenantId, extension)`. `MohAssignmentJob` has **no FK to `Tenant`** —
  `targetTenantIds` is opaque so a tenant deletion never cascade-deletes
  history.
- **`extension` field:** opaque normalized string (digits / ASCII letters /
  underscore / hyphen, max 32 chars) — the canonical channel-name token
  parsed from `CHANNEL(name)` (`PJSIP/T<id>_<extension>-…`). NOT an FK to
  `Extension`; cross-validation is the API write layer's responsibility
  (Phase 2). Helpers: `apps/api/src/mohExtensionOverride.ts`.
- **`MohPublishRecord.extensionOverridesSnapshot`:** nullable JSON column,
  default `'[]'`. **Populated as of Phase 3A (2026-05-11)** by `doMohPublish`
  (sorted ASC by extension; only enabled rows with non-empty class) and by
  the rollback handler (reconstructed from `previousKeysSnapshot` via
  `extractExtensionSnapshotFromKeys`). Legacy rows still read as empty array.
- **High-risk?** **Low at call-time** — Asterisk does not yet read the
  per-extension keys. The dialplan resolver lands in Phase 3B; until then
  the keys are persisted but functionally inert on live calls.
- **Modified by (Phase 2, 2026-05-11):** `apps/api` `/voice/moh/extension-overrides`
  (`GET` / `PUT` / `DELETE`) — see `API_ROUTES.md`. Routes are **DB-only**:
  no AstDB write, no telephony call, no `publishMohToAstDb` change.
- **Modified by (Phase 3A, 2026-05-11):** `apps/api` `POST /voice/moh/publish`
  (`doMohPublish`) appends `connect/t_<slug>/extensions/<ext>/{moh_class,active_moh_class}`
  keys for every enabled override to the AstDB write, persists the snapshot on
  the new `MohPublishRecord`, and exposes evidence (`extensionOverrideCount`,
  `extensionOverrideExtensions`, `extensionOverrideKeysPublished`) on
  `nativeSync`. The rollback handler (`POST /voice/moh/publish/:id/rollback`)
  writes empty-string tombstones for keys the target publish ADDED relative to
  its `previousKeysSnapshot`, surfaces `extensionOverrideKeysCleared` on
  `nativeSync`, and replays the prior snapshot verbatim. Future: bulk-job
  worker (Phase 4) consumes `MohAssignmentJob`; dialplan resolver (Phase 3B)
  is the first consumer of these AstDB keys.

## DidRouteMapping / DidRouteSwitchLog
- **Schema:** lines 2465 / 2520
- **Purpose:** Per-DID routing config: which IVR profile + MOH profile +
  hold announcement to use, plus `routingMode` ("pbx" vs "connect")
  with snapshot fields capturing the original VitalPBX
  `inbound_number` payload before takeover.
- **Tenant-scoped?** Yes.
- **High-risk?** **Extreme** — flipping `routingMode` actually re-points
  a real DID. Always preserve `originalPbx*` snapshot fields so the
  "restore to PBX" path can `PATCH` back verbatim.
- **Modified by:** `apps/api` (admin DID-routing UI).

## OutboundRoute / UserOutboundRoutePermission
- **Schema:** lines 1405 / 1425
- **Purpose:** Tenant outbound dial routes + per-user grant.
- **Tenant-scoped?** Yes.
- **High-risk?** Yes — drives outbound call routing.
- **Modified by:** `apps/api` `/outbound-routes` and
  `/admin/users/:id/outbound-routes`.

## TenantBillingSettings (invoice presentation)

- **Schema:** `TenantBillingSettings` in `packages/db/prisma/schema.prisma` — core pricing/autopay plus optional **`invoiceCompanyName`**, **`invoiceLogoUrl`** (https, used in HTML emails only), **`invoiceSupportEmail`**, **`invoiceSupportPhone`**, **`invoiceFooterNote`**, **`invoicePaymentInstructions`** (migration `20260512120000_tenant_invoice_branding`).
- **Purpose:** Resolved in **`invoiceBranding.ts`** for **`renderBillingInvoicePdf`** (`pdf.ts`) and billing emails (`emailTemplates.ts`, `billingEmailLifecycle.ts`). **`paymentTermsDays`** remains the due offset / “Net N days” source.
- **`metadata` JSON:** optional. **`taxProviderId`** (`tax_profile_v1` \| `external_telecom_stub`) selects the tax engine for invoice preview/create (`taxProvider.ts`). Other keys may be added later; **`PUT /admin/billing/tenants/:id/settings`** merges **`taxProviderId`** without wiping unrelated metadata.
- **Scheduled plan change fields (migration `20260530000000_billing_scheduled_plan_change`):**
  - `nextBillingPlanId String?` — FK → `BillingPlan.id` (SetNull on delete). Named relation `"NextBillingPlan"`.
  - `nextBillingPlanEffectiveAt DateTime?` — UTC midnight on the first day of the billing period when the new plan takes effect.
  - Both nullable; null = no change scheduled.
  - Existing `billingPlan` relation renamed to `"CurrentBillingPlan"` (Prisma requires names when a model has two FK columns pointing to the same target model).
  - Index `TenantBillingSettings_nextBillingPlanId_idx`.
  - Phase 2 (worker, deferred): worker `consumeScheduledPlanChange` copies plan prices into direct fields and clears these columns after invoice creation for the effective period.

## BillingInvoice / BillingInvoiceLineItem / BillingRun / BillingEventLog
- **Schema:** lines 683 / 721 / 790 / 809
- **Purpose:** Connect-owned invoicing pipeline (driven by `apps/worker`
  `runMonthlyBillingAutomation` + `runBillingDunningRetries`, and admin/API actions).
- **`BillingInvoice.metadata`:** optional JSON. **`dunning`** holds `{ attempts, maxAttempts, nextRetryAt }` for autopay retry backoff (see `billingDunning.ts`). **`taxCalculationAudit`** (set at invoice creation in `invoiceEngine.ts`) stores the tax provider snapshot: provider id/version, inputs, line summaries, notes — see `taxProvider.ts`. Dunning merges preserve existing keys (root object spread).
- **`BillingEventLog.type` (examples):** `invoice_created`, `invoice_emailed`, `payment_link_emailed`, `autopay_attempted`, `payment_succeeded`, `payment_failed`, `dunning_scheduled`, `dunning_exhausted`, `receipt_emailed` / `payment_failed_emailed` (also used as dedupe markers with `message` = `PaymentTransaction.id`).
- **Tenant-scoped?** Yes.
- **High-risk?** **Extreme** — money.
- **Modified by:** `apps/worker` (billing run + dunning sweep), `apps/api/src/billing/*`.

## Subscription
- **Schema:** line 549
- **Purpose:** Tenant subscription + payment-method snapshot, dunning
  state (`status`, `pastDueSince`, `retryCount`, `nextRetryAt`).
- **Sensitive fields:** `provider*` IDs, `paymentMethodLast4`,
  `paymentMethodExpMonth/Year`.
- **Tenant-scoped?** Yes (1-1 with tenant).
- **High-risk?** **Extreme**.
- **Modified by:** `apps/api/src/billing/*` (subscription UI); legacy worker references only where still wired.

## PaymentTransaction
- **Schema:** line 765
- **Purpose:** Single payment attempt against a `BillingInvoice`.
- **Sensitive fields:** `processorTransactionId`, `responseCode`,
  `responseMessage`, `rawResponseSafeJson`, `idempotencyKey` (unique).
- **High-risk?** **Extreme**.
- **Modified by:** `apps/api/src/billing/*`.

## EmailJob (billing subset)
- **Schema:** line 1368
- **Purpose:** Outbound email queue; processor in **`apps/api/src/server.ts`** (`processEmailJobsBatch`).
- **Billing rows:** `tenantId` + optional **`invoiceId`** (BillingInvoice) + **`type`** (`BILLING_INVOICE_SENT`, `BILLING_INVOICE_READY`, `BILLING_PAYMENT_LINK`, `BILLING_RECEIPT`, `BILLING_PAYMENT_FAILED`, …). Payload shape: **`buildBillingEmailJobCreateData`** in `billingAuth.ts`.
- **High-risk?** High — duplicate sends hurt trust; rely on **`BillingEventLog`** dedupe rows + idempotent queue helpers in **`billingEmailLifecycle.ts`**.

## ConnectChatThread / ConnectChatParticipant / ConnectChatMessage / ConnectChatMessageAttachment / ConnectChatMessageReaction
- **Schema:** lines 2696 / 2724 / 2745 / 2776 / 2802
- **Purpose:** Internal team chat (separate from SMS / WhatsApp).
- **Tenant-scoped?** Yes.
- **Modified by:** `apps/api/src/connectChatRoutes.ts` (delegated; see
  `API_ROUTES.md`).

## SmsCampaign / SmsMessage / SmsWebhookEvent / SmsRoutingLog / TenantSmsNumber
- **Schema:** lines 866 / 884 / 908 / 2815 / 2671
- **Purpose:** SMS campaign lifecycle, per-message rows, carrier
  webhook events, routing decisions, per-tenant SMS number assignment.
- **Tenant-scoped?** Yes.
- **High-risk?** Yes — carrier compliance and per-tenant rate limits.
- **Modified by:** `apps/api` (admin + tenant routes), `apps/worker`
  (`sms-send` BullMQ consumer, `runSmsRetryCycle`).

## ProviderCredential / BillingSolaConfig / WhatsAppProviderConfig / EmailProviderConfig
- **Schema:** lines 967 / 986 / 1012 / 1081
- **Purpose:** Encrypted credentials for outbound integrations.
- **Sensitive fields:** All `*Encrypted` fields.
- **Tenant-scoped?** Yes.
- **High-risk?** Extreme — these are the live API keys for paid
  integrations.
- **Modified by:** `apps/api` (admin settings).

## TurnConfig / TurnValidationJob / MediaTestRun
- **Schema:** lines 1871 / 1886 / 1907
- **Purpose:** Per-tenant TURN/STUN config + media-reachability test
  results. Tenant-level `turnValidationStatus` / `mediaTestStatus` on
  `Tenant` derive from these.
- **Tenant-scoped?** Yes.
- **High-risk?** Yes — wrong config = WebRTC clients can't connect.
- **Modified by:** `apps/api` (issuance), `apps/worker` (validation +
  media test cycles).

## VoiceClientSession / VoiceDiagEvent
- **Schema:** lines 1926 / 1953
- **Purpose:** Live WebRTC session bookkeeping + per-event diagnostic
  log (used by the admin call-wake diagnostics UI).
- **Tenant-scoped?** Yes.
- **Modified by:** `apps/api` and the WebRTC client.

## CallFlightSession
- **Schema:** line 1974
- **Purpose:** UNKNOWN — verify before changing. Likely tracks a
  short-lived "flight" of a call between WebRTC client and PBX (used to
  correlate INVITE → answer → media). Read `apps/api` and
  `apps/telephony` references before modifying.

## AuditLog
- **Schema:** line 1390
- **Purpose:** General audit trail of admin actions.
- **Tenant-scoped?** Yes.
- **Modified by:** `apps/api` (everywhere).

---

## CRM models (Phase 1A + 1B)

### `CrmContactMeta` (Phase 1B)
- **Schema:** end of `packages/db/prisma/schema.prisma` (after CrmUserAccess)
- **Purpose:** CRM overlay on an existing `Contact` row. A Contact becomes a CRM contact when this row is created. **No contact data is duplicated** — phones/emails/names all live on `Contact`.
- **Tenant-scoped?** Yes — both `tenantId` and via `contact.tenantId`.
- **High-risk?** No.
- **Modified by:** `apps/api` via `POST /crm/contacts`, `PATCH /crm/contacts/:id`.

Key fields:
- `contactId`: FK → `Contact.id` (CASCADE, **@unique** — strict 1:1)
- `stage`: `CrmContactStage` enum (LEAD / CONTACTED / QUALIFIED / CUSTOMER / CLOSED_LOST)
- `assignedToUserId`: FK → `User.id` (SetNull on delete)
- `doNotCall`, `doNotSms`: compliance flags
- `lastActivityAt`: updated by timeline events (Phase 2)
- `lastDisposition` _(Phase 2D)_: last saved disposition string (e.g. "Answered", "No Answer")
- `lastDispositionAt` _(Phase 2D)_: timestamp of last disposition save; exposed on contact API response

To read a CRM contact: `db.contact.findFirst({ where: { id, tenantId }, include: { crmMeta: true, phones: true, emails: true } })`

**Important:** A `Contact` without a `crmMeta` row is a regular phone-book contact, NOT a CRM contact. Do not list it in `/crm/contacts`.

---

## CRM Foundation models (Phase 1A)

Added in migration `20260522000000_crm_foundation`. All new tables — no existing models modified.

### `CrmTenantSettings`
- **Schema:** end of `packages/db/prisma/schema.prisma` (last section)
- **Purpose:** Per-tenant CRM enablement flag + feature flags.
- **Tenant-scoped?** Yes — `tenantId UNIQUE`.
- **High-risk?** No (settings only — no telephony impact).
- **Modified by:** `apps/api` via `PUT /crm/settings` (admin-only).
- **Absence of a row = CRM disabled.** Do not read this model expecting a row to always exist.

Key fields: `enabled`, `localPresenceEnabled` (Phase 2), `transcriptionEnabled` (Phase 3).

### `CrmUserAccess`
- **Schema:** end of `packages/db/prisma/schema.prisma` (last section)
- **Purpose:** Per-user CRM access grant: role (AGENT / MANAGER / ADMIN) + enabled flag.
- **Tenant-scoped?** Yes — `@@unique([tenantId, userId])`.
- **High-risk?** No.
- **Modified by:** `apps/api` via `PUT /crm/users/:userId` (admin-only).
- **Absence of a row = no CRM access for that user**, even if `CrmTenantSettings.enabled=true`.

Key fields: `enabled`, `role` (`CrmUserRole` enum: `AGENT | MANAGER | ADMIN`).

### `CrmContactMeta`
- **Schema:** end of `packages/db/prisma/schema.prisma`
- **Purpose:** CRM-specific overlay on `Contact`. One row per CRM-managed contact.
- **Tenant-scoped?** Yes — `tenantId` index + `contactId UNIQUE`.
- **High-risk?** No.
- **Do NOT store identity data here.** Name, phone, email live on `Contact`.

Key fields: `stage` (`CrmContactStage`: `LEAD | CONTACTED | QUALIFIED | CUSTOMER | CLOSED_LOST`),
`assignedToUserId`, `doNotCall`, `doNotSms`, `lastActivityAt`.

### `CrmTimelineEvent` _(Phase 1C)_
- **Schema:** end of `packages/db/prisma/schema.prisma`
- **Purpose:** Append-only audit log of CRM activity for a contact.
- **Tenant-scoped?** Yes — `tenantId` on all indexes.
- **High-risk?** No. **Never delete timeline events** — they are an immutable log.
- **Written by:** `apps/api/src/crm/timelineHelper.ts` `writeTimelineEvent()`.

Key fields: `type` (`CrmTimelineEventType`: `CONTACT_CREATED | STAGE_CHANGED | NOTE_ADDED | NOTE_EDITED | CDR_INBOUND | CDR_OUTBOUND | TASK_CREATED | TASK_COMPLETED | TASK_CANCELED | CHECKLIST_COMPLETED | DISPOSITION_SET | CONTACT_MERGED | ASSIGNED_TO_USER`),
`title`, `body` (human-readable text), `metadata` (JSON), `linkedId` (for CDR events = `ConnectCdr.linkedId`; for notes = `CrmContactNote.id`),
`createdByUserId`.

**Phase 5C — `ASSIGNED_TO_USER` event:** Written non-blocking in `PATCH /crm/contacts/:id` only when `assignedToUserId` changes on an individual contact edit.
`metadata`: `{ fromUserId, toUserId, fromName, toName }`. Not written for bulk reassign (would create noise).
Migration: `20260512140000_crm_assigned_to_user_event`.

**Phase 5A — `CONTACT_MERGED` event:** Written on the `keepContact` after a successful merge.
`metadata`: `{ mergedContactId, mergedContactName, phonesAdded, emailsAdded, campaignMembersMoved, campaignMembersSkipped }`.
Timeline events, notes, tasks, checklist responses, and non-conflicting campaign memberships are moved from the archived contact to the kept contact atomically.

**Phase 2A — CDR events:** `CDR_INBOUND`/`CDR_OUTBOUND` are now live. Written by `apps/api/src/crm/cdrHook.ts`
`fireCrmCdrHook()` after `ConnectCdr` upsert. Metadata shape:
`{ direction, fromNumber, toNumber, durationSec, talkSec, disposition, recordingAvailable, cdrLinkedId }`.
`linkedId` field = `ConnectCdr.linkedId` (used to link to recording stream endpoint).
**Deduplication:** partial unique index `CrmTimelineEvent_contactId_linkedId_type_unique` (WHERE linkedId IS NOT NULL)
plus lookup-before-create in hook prevents duplicate CDR events.
Index `@@index([contactId, linkedId])` added for fast dedup lookups.

### `CrmContactNote` _(Phase 1C)_
- **Schema:** end of `packages/db/prisma/schema.prisma`
- **Purpose:** Structured per-author notes on a contact. Multiple notes per contact.
- **Tenant-scoped?** Yes.
- **High-risk?** No.
- **Creating a note always also writes a `CrmTimelineEvent(NOTE_ADDED)`** via `timelineHelper`.
- **Editing a note body also updates the linked `CrmTimelineEvent(NOTE_ADDED)` body** and writes `NOTE_EDITED`.

Key fields: `body`, `pinned` (bool), `createdByUserId`.

Note: `Contact.notes` (single string) remains as a scratch-pad field and is separate from `CrmContactNote`.

### `CrmContactTask` _(Phase 1D)_
- **Schema:** end of `packages/db/prisma/schema.prisma`
- **Purpose:** Follow-up tasks / action items linked to a CRM contact.
- **Tenant-scoped?** Yes.
- **High-risk?** No.
- **Timeline events written for:** `TASK_CREATED` (on create), `TASK_COMPLETED` (on status→DONE), `TASK_CANCELED` (on status→CANCELED or DELETE).
- **No timeline events for minor edits** (title, body, dueAt, priority changes).

Key fields: `title`, `body`, `dueAt`, `assignedToUserId`, `priority` (`CrmTaskPriority`: `LOW | MEDIUM | HIGH | URGENT`),
`status` (`CrmTaskStatus`: `OPEN | IN_PROGRESS | DONE | CANCELED`), `completedAt`, `completedByUserId`, `createdByUserId`.

Important: `onDelete: Restrict` on `createdByUserId` — a user cannot be deleted if they have created tasks (same as notes).

### `CrmScript` _(Phase 2C)_
- **Schema:** end of `packages/db/prisma/schema.prisma`
- **Purpose:** Plain-text call scripts displayed in the Live Call Workspace.
- **Tenant-scoped?** Yes.
- **High-risk?** No (read-only by agents during calls; no telephony coupling).
- **Soft-delete:** `isActive = false` (archive). No hard deletes.
- **Routes:** `apps/api/src/crm/scriptRoutes.ts`

Key fields: `name`, `body` (Text), `isActive`, `createdByUserId`.

---

### `CrmChecklist` _(Phase 2C)_
- **Schema:** end of `packages/db/prisma/schema.prisma`
- **Purpose:** Named checklist templates containing ordered `CrmChecklistItem` rows.
- **Tenant-scoped?** Yes.
- **High-risk?** No.
- **Soft-delete:** `isActive = false` (archive).
- **Routes:** `apps/api/src/crm/checklistRoutes.ts`

Key fields: `name`, `isActive`, `createdByUserId`. Related: `items CrmChecklistItem[]`, `responses CrmChecklistResponse[]`.

---

### `CrmChecklistItem` _(Phase 2C)_
- **Purpose:** A single item inside a `CrmChecklist` template.
- **Cascade-deletes** with checklist.

Key fields: `checklistId`, `label`, `required`, `sortOrder`.

---

### `CrmChecklistResponse` _(Phase 2C)_
- **Purpose:** Agent's filled answer-set for a checklist, linked to a contact and optionally to a CDR `linkedId`.
- **Tenant-scoped?** Yes.
- **Writes timeline event:** `CHECKLIST_COMPLETED` (non-blocking) after successful create.
- **`answers`:** JSON map `{ [itemId]: boolean }`.

Key fields: `checklistId`, `contactId`, `linkedId?`, `completedByUserId`, `answers`.

**Phase 2C — CHECKLIST_COMPLETED timeline events:** Written by `checklistRoutes.ts` `POST /crm/checklists/:id/respond`.
Metadata shape: `{ checklistName, checklistId, responseId, itemsTotal, itemsChecked, allRequiredDone, linkedId }`.

---

### `CrmCampaign` _(Phase 3A)_
- **Purpose:** Named outbound calling campaign. Groups contacts for coordinated calling workflows.
- **Tenant-scoped?** Yes.
- **Status lifecycle:** `DRAFT → ACTIVE → PAUSED → COMPLETED | ARCHIVED`
- **Optional links:** `scriptId? → CrmScript`, `checklistId? → CrmChecklist` (applied to all members).
- **Creator:** `createdByUserId → User`.
- **`priority` _(Phase 12B)_:** `CrmCampaignPriority` enum — `LOW | NORMAL | HIGH | URGENT`. Default `NORMAL`. Controls Smart Queue ranking of non-callback leads within this campaign. URGENT campaigns surface above HIGH above NORMAL above LOW within the same attempt tier. Overdue/due callbacks always outrank any lead regardless of campaign priority. Existing campaigns default to `NORMAL`.

Key fields: `name`, `description?`, `status` (`CrmCampaignStatus`), `priority` (`CrmCampaignPriority`), `scriptId?`, `checklistId?`, `createdByUserId`.

---

### `CrmTenantSettings` — Queue Defaults _(Phase 12C)_
New fields added to the existing `CrmTenantSettings` model:
- **`defaultQueueSort`** (`String`, default `"SMART"`): Tenant-wide default sort for agents' queues — `SMART` or `ORIGINAL`. Applied when the agent has no localStorage preference and URL has no `?sort=` param.
- **`defaultQueueFilter`** (`String`, default `"PENDING"`): Default filter tab — `PENDING | DUE | OVERDUE | UPCOMING`. Applied when URL has no `?filter=` param.

---

### `CrmCampaignMember` _(Phase 3A)_
- **Purpose:** A single contact enrolled in a `CrmCampaign` — the primary queue row for agents.
- **Tenant-scoped?** Yes.
- **Unique constraint:** `(campaignId, contactId)` — one contact per campaign.
- **Status lifecycle:** `PENDING → IN_PROGRESS → CONTACTED | CALLBACK | CONVERTED | SKIPPED | DO_NOT_CALL`
- **attemptCount:** Incremented by the API each time an outcome (disposition) is saved with `memberId` present.
- **lastAttemptAt:** Set to now() each time an attempt is recorded.
- **Queue source:** `GET /crm/queue` = `CrmCampaignMember` where `status NOT IN [CONVERTED, DO_NOT_CALL, SKIPPED]` AND `campaign.status = ACTIVE` AND `assignedToUserId = currentUser`, ordered by `sortOrder / createdAt`.
- **Defer behavior:** Sets `status = PENDING`, increments `sortOrder` to max+1 (moves to end of queue).

Key fields: `campaignId`, `contactId`, `assignedToUserId?`, `status`, `attemptCount`, `lastAttemptAt?`, `sortOrder`, `callbackAt?`, `callbackNote?`.

**Phase 3A — Disposition → member status mapping:**  
`POST /crm/queue/:memberId { action: "outcome", disposition }` maps:
- contains "convert"/"closed" → `CONVERTED`
- contains "callback" → `CALLBACK`
- contains "not interest"/"dnc" → `DO_NOT_CALL`
- else → `CONTACTED`

**Phase 3C — Callback scheduling:**
- `callbackAt DateTime?` — when the agent should call back. Set by queue `action: "set-callback"`, by campaign member PATCH, or auto-set by disposition endpoint when `memberId` + CALLBACK + `followUpAt` are all present.
- `callbackNote String?` — optional reason for the callback.
- Index `(tenantId, assignedToUserId, status, callbackAt)` supports the Due/Overdue/Upcoming tab queries.
- **`CALLBACK` status is non-terminal** — it does NOT satisfy campaign auto-completion. Only `CONVERTED`, `SKIPPED`, `DO_NOT_CALL`, `CONTACTED` are terminal.
- Clearing a callback (`action: "clear-callback"`) sets `callbackAt = null`, `callbackNote = null`, `status = PENDING`.

---

### `CrmImportBatch` _(Phase 1E)_
- **Schema:** end of `packages/db/prisma/schema.prisma`
- **Purpose:** Tracks a single CSV import run with per-row result counts and error details.
- **Tenant-scoped?** Yes.
- **High-risk?** No (CRM-only, no telephony coupling).
- **Import logic:** Inline in `apps/api/src/crm/importRoutes.ts`. Synchronous for MVP (max 5 MB / 5000 rows).
- **Dedup strategy:** Match by `ContactPhone.numberNormalized` or `ContactEmail.email` within tenant. Never creates duplicate contacts for the same phone/email.
- **Always creates `CrmContactMeta`** (LEAD stage) on both new contacts and matched existing contacts. Never downgrades an existing stage.
- **XLSX:** Deferred — requires external dependency. CSV only for Phase 1E.

Key fields: `status` (`CrmImportBatchStatus`: `PENDING | PROCESSING | DONE | PARTIAL | FAILED`),
`totalRows`, `createdCount`, `updatedCount`, `skippedCount`, `errorCount`,
`errors` (JSON array of `{ row, reason }` objects, capped at 50 in API response),
`mapping` (JSON: detected column mapping `{ csvColumnIndex: fieldName }`).

---

## What is NOT in this cheat sheet (intentional)

To keep this file short and useful, the following lower-traffic models are
**deliberately omitted**. Read the schema directly when working on them:

`AuditLog` (limited summary), `Receipt`, `Alert`, `Customer`, `Contact`,
`ContactPhone`, `ContactEmail`, `ContactAddress`, `ContactTag`,
`ContactTagAssignment`, `CustomerNote`, `CustomerTask`, `AutomationRule`,
`Invoice` (legacy), `InvoiceEvent`, `EmailJob`, `UserPasswordToken`,
`UsageLedger`, `BillingPlan`, `TaxProfile`, `TenantBillingSettings`,
`PaymentEvent`, `PaymentMethod`, `BillingInvoiceLineItem`, `WhatsAppThread`,
`WhatsAppMessage`, `IvrSchedule` (legacy), `PbxCallEvent`, `Sbc*`,
`MobileProvisioningToken`, `TenantPbxPrompt`, `MohScheduleRule`,
`PlatformRolePermissionSnapshot`, `GlobalVoipMsConfig`,
`PbxWebhookRegistration`.

When in doubt, **grep `schema.prisma` for the model name before
touching it.**
