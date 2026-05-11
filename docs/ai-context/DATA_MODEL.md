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

## MohExtensionOverride / MohAssignmentJob (Phase 1, 2026-05-11 — schema only)
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
- **`MohPublishRecord.extensionOverridesSnapshot`:** new nullable JSON
  column, default `'[]'`. Populated in a later phase when the publish
  helper writes per-extension keys; legacy rows read as empty array.
- **High-risk?** Currently **no** (no runtime path). Becomes high-risk in
  later phases when AstDB writes go live.
- **Modified by:** **nothing in Phase 1.** Future: `apps/api` per-extension
  override routes (Phase 2), bulk-job worker (Phase 4).

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

## BillingInvoice / BillingInvoiceLineItem / BillingRun / BillingEventLog
- **Schema:** lines 683 / 721 / 790 / 809
- **Purpose:** Connect-owned invoicing pipeline (driven by `apps/worker`
  `monthlyBilling` cycle and admin actions).
- **Tenant-scoped?** Yes.
- **High-risk?** **Extreme** — money.
- **Modified by:** `apps/worker` (billing run), `apps/api/src/billing/*`.

## Subscription
- **Schema:** line 549
- **Purpose:** Tenant subscription + payment-method snapshot, dunning
  state (`status`, `pastDueSince`, `retryCount`, `nextRetryAt`).
- **Sensitive fields:** `provider*` IDs, `paymentMethodLast4`,
  `paymentMethodExpMonth/Year`.
- **Tenant-scoped?** Yes (1-1 with tenant).
- **High-risk?** **Extreme**.
- **Modified by:** `apps/api/src/billing/*`, `apps/worker` dunning cycle.

## PaymentTransaction
- **Schema:** line 765
- **Purpose:** Single payment attempt against a `BillingInvoice`.
- **Sensitive fields:** `processorTransactionId`, `responseCode`,
  `responseMessage`, `rawResponseSafeJson`, `idempotencyKey` (unique).
- **High-risk?** **Extreme**.
- **Modified by:** `apps/api/src/billing/*`.

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
