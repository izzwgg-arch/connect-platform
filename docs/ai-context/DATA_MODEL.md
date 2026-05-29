# Data Model Cheat Sheet — Prisma / Postgres

> **Goal:** keep agents from re-deriving the schema every chat.
> **Scope:** the ~20 highest-traffic / highest-risk models. Full schema is
> at `packages/db/prisma/schema.prisma` (~2,840 lines, ~95 models).
>
> Rule of thumb: if the model is here, **read this doc instead of the
> schema first.** If you do load the schema, jump to the line ranges below.

---

## CRM Email (Phase 1 — send-only, metadata-first)

Not a full inbox archive. Stores CRM-linked email metadata and summaries; does not store full incoming bodies by default.

- Models: `CrmEmailConnection`, `CrmEmailThread`, `CrmEmailMessage`, `CrmEmailSendLog` in `packages/db/prisma/schema.prisma`.
- Enums: `EmailPrivacyMode` with `METADATA_ONLY` (default), `METADATA_WITH_CACHE_30D`, `FULL_RETENTION` (future/disabled).
- Timeline: adds `EMAIL_SENT`, `EMAIL_RECEIVED`, `EMAIL_REPLY` to `CrmTimelineEventType`.

### CrmEmailConnection
- Per-user Gmail OAuth connection: `emailAddress`, `displayName`, `googleAccountId`, `encryptedAccessToken`, `encryptedRefreshToken`, `tokenExpiresAt`, `scopes[]`.
- Privacy/Flags: `replyTrackingEnabled=false` (Phase 1), `gmailHistoryId?`, `bodyCacheMode=METADATA_ONLY`, `bodyCacheRetentionDays=30`.
- Indexes: unique `(tenantId,userId)`, `(tenantId,status)`.

### CrmEmailThread
- Thread metadata only: `gmailThreadId` (unique per-tenant), `subject?`, `lastMessageAt?`, `unreadCount`.
- Indexes: unique `(tenantId,gmailThreadId)`, `(tenantId,contactId,lastMessageAt)`.

### CrmEmailMessage (metadata + minimal cache only)
- No permanent `htmlBody`/`textBody`.
- Fields: `gmailMessageId` (unique per-tenant), `direction`, `subject?`, `fromEmail?`, `toEmail?`, `previewSnippet?`, `aiSummary?`, `hasCachedBody` (default false), `bodyCacheEncrypted?`, `bodyCacheExpiresAt?`, `sentAt?`, `receivedAt?`.
- Indexes: unique `(tenantId,gmailMessageId)`, `(threadId,createdAt)`, `(tenantId,hasCachedBody,bodyCacheExpiresAt)`.

### CrmEmailSendLog
- Outbound send log; no body persisted.
- Fields: `toEmail`, `subject?`, `gmailMessageId?`, `gmailThreadId?`, `status=SENT\|FAILED`, `errorMessage?`, `sentAt`.

### Security
- Token fields are AES-256-GCM envelopes via `@connect/security` (`CREDENTIALS_MASTER_KEY`). Never exposed to the frontend; never logged.

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
- **Billing classification (no DB column):** There is no `numberType` / `isTollFree`
  field on the row. Purchase search uses provider `type: "local" | "tollfree"` but
  type is not persisted. Billing splits DIDs in `apps/api/src/billing/billingPhoneNumbers.ts`
  by **NANP toll-free NPA** on E.164: `800`, `833`, `844`, `855`, `866`, `877`, `888`.
  **First-number-free** applies to **local** DIDs only; all active toll-free numbers are billable.
- **Tenant toll-free unit price:** optional `TenantBillingSettings.metadata.billingTollFreeDidPriceCents`
  (API `tollFreeDidPriceCents` on settings PUT); falls back to local DID price / default.
- **Quantity overrides:** `metadata.billingQuantityOverrides.tollFreeNumbers` — `{ mode: "auto"|"manual", quantity }`;
  must be parsed/validated with the same key list as other billing lines (`BILLING_QUANTITY_OVERRIDE_KEYS`).
- **Telecom fees (admin UI):** `metadata.billingTelecomFees` — per-tenant fee card config (`salesTax`, `e911`, `regulatory`, `telecomSurcharge`, `usfRecovery`, `customFee`). Invoice lines still driven by `TaxProfile` for the three core types until Phase B.

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

### PBX tenant sync behavior and canonical dropdown source

`POST /admin/pbx/refresh-tenants` (updated 2026-05-27) performs a **full sync** in sequence:

1. `client.listTenants()` → `syncPbxTenantDirectoryFromRows()` → updates `PbxTenantDirectory`. Does **not** create or update Connect `Tenant` rows directly.
2. `syncExtensionsFromPbx()` → for every `TenantPbxLink` on the instance, fetches extensions from VitalPBX and upserts `Extension` + `PbxExtensionLink`. Extension sync failure is **non-fatal** (tenant directory already saved).
3. `syncPbxTenantInboundDids()` → reads Ombutel MySQL (`ombu_inbound_routes`) and upserts `PbxTenantInboundDid` rows. Sets `connectTenantId` from `TenantPbxLink`. Automatically **skipped** (non-fatal) if `ombuMysqlUrlEncrypted` is not configured on the instance. DID sync failure is also non-fatal.

After `POST /admin/pbx/refresh-tenants` succeeds, `useAppContext.refreshPbxTenants()`:
1. Calls `reloadTenantOptions()` → updates `TenantSwitcher`.
2. Dispatches `cc-pbx-tenants-refreshed` → `useTenantOptions()` consumers refetch.
3. Dispatches `cc-pbx-sync-complete` (with summary payload) → `useTenantOptions()` + `useExtensionOptions()` consumers refetch + PBX Extensions page increments `reloadKey`.

**Canonical admin tenant dropdown endpoint:** `GET /admin/tenant-options` (added 2026-05-26).
- Returns merged Connect tenants (`source: "connect" | "linked"`) + PBX-only tenants (`source: "pbx"`, id `vpbx:{slug}`).
- See `API_ROUTES.md` § Canonical tenant dropdown source for full shape and security rules.

**Canonical extension options hook:** `useExtensionOptions` (`apps/portal/hooks/useExtensionOptions.ts`).
- Wraps `GET /admin/users/catalog?tenantId=&userFacingOnly=`.
- Auto-refetches on `cc-pbx-sync-complete`.
- Used by `UserModal` in `admin/users/page.tsx`.

**Affected dropdowns/pages (as of 2026-05-26):**
- `TenantSwitcher` — `useAppContext().tenants` via `loadTenantOptions()` → ✅ updated by `reloadTenantOptions()`.
- `Admin → Users filter` — `useTenantOptions()` → ✅ updated on `cc-pbx-tenants-refreshed` / `cc-pbx-sync-complete`.
- `Admin → Users create/edit modal (tenant)` — `useTenantOptions()` → ✅ same. PBX-only tenants visible; `resolveManagedTenant` auto-provisions Connect tenant on first user save.
- `Admin → Users create/edit modal (extension)` — `useExtensionOptions()` → ✅ updated on `cc-pbx-sync-complete`.
- `/pbx/extensions/` page — `useAsyncResource` + `reloadKey` → ✅ incremented on `cc-pbx-sync-complete`.
- `Admin Billing shell` — `GET /admin/billing/platform/tenants` → ❌ billing-specific source, not affected by PBX sync.
- `CDR tenant map` — `GET /admin/pbx/tenants` direct fetch → not connected to canonical hook (low priority).

**Security rules:**
- SUPER_ADMIN: sees all tenant options from `GET /admin/tenant-options`.
- TENANT_ADMIN / ADMIN: sees only their own tenant.
- End-users: never receive any admin tenant list.
- PBX-only tenants (`vpbx:` ids) appear in dropdowns but cannot own Connect Users, Extensions, Billing rows until a Connect `Tenant` + `TenantPbxLink` is created (auto-provisioned on first user-creation action).

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

## BillingPlan (platform catalog)

- **Schema:** `BillingPlan` in `packages/db/prisma/schema.prisma`; optional **`tenantId`** (`String?` unique): **catalog** rows use `tenantId = null`; non-null links to at most one tenant-private row (legacy/extension — platform catalog APIs manage **`tenantId` null** only).
- **Purpose:** Named price template (`code`, `name`, `extensionPriceCents`, `additionalPhoneNumberPriceCents`, `smsPriceCents`, `firstPhoneNumberFree`, `active`). Used as fallback in `buildBillingInvoicePreview` / invoice create when `TenantBillingSettings` price fields are falsy, and as FK targets `TenantBillingSettings.billingPlanId` / `nextBillingPlanId`.
- **`BillingEventLog` (catalog admin):** SUPER_ADMIN create/update/deactivate/clone emits `billing_plan.created`, `billing_plan.updated`, `billing_plan.deactivated`, `billing_plan.cloned` with **`metadata.catalogScope = billing_plan_catalog`** and **`operatorId`**; `tenantId` on the log row is the lexicographically first `Tenant` (FK requires a tenant — not a null platform row).
- **Tenant-scoped?** Catalog rows are global; optional `tenantId` ties a row to one tenant.
- **High-risk?** **High** — changes affect future invoice previews and scheduled plan application.
- **Modified by:** `apps/api/src/billing/routes.ts` (platform catalog routes) + seed/migrations.

## TenantBillingSettings (invoice presentation)

- **Schema:** `TenantBillingSettings` in `packages/db/prisma/schema.prisma` — core pricing/autopay plus optional **`invoiceCompanyName`**, **`invoiceLogoUrl`** (https, used in HTML emails only), **`invoiceSupportEmail`**, **`invoiceSupportPhone`**, **`invoiceFooterNote`**, **`invoicePaymentInstructions`** (migration `20260512120000_tenant_invoice_branding`).
- **Autopay scope:** tenant-level. `autoBillingEnabled`, `billingDayOfMonth`, `defaultPaymentMethodId`, and `metadata.billingScheduleOverride` describe the current Connect-native tenant invoice path, not an individual recurring obligation. Do not use this row to infer that a tenant can only have one Sola/Cardknox recurring profile.
- **Purpose:** Resolved in **`invoiceBranding.ts`** for **`renderBillingInvoicePdf`** (`pdf.ts`) and billing emails (`emailTemplates.ts`, `billingEmailLifecycle.ts`). **`paymentTermsDays`** remains the due offset / “Net N days” source.
- **`metadata` JSON:** optional. **`taxProviderId`** (`tax_profile_v1` \| `external_telecom_stub`) selects the tax engine for invoice preview/create (`taxProvider.ts`). **`billingPricingMode`** (`catalog` \| `custom`, or absent/`null`): see **`BILLING.md`** § Tenant pricing mode. **`billingFlatRate`** — tenant extensions flat monthly rate (`enabled`, `amountCents`, `appliesTo: "extensions"`). **`billingQuantityOverrides`** — per-line **auto** vs **manual** billing quantities (`extensions`, `virtualExtensions`, `phoneNumbers`, `smsPackages`; each `{ mode, quantity }`; manual requires non-negative integer). **`PUT /admin/billing/tenants/:id/settings`** merges keys without wiping unrelated metadata (`null` on a patch object removes that slice).
- **Scheduled plan change fields (migration `20260530000000_billing_scheduled_plan_change`):**
  - `nextBillingPlanId String?` — FK → `BillingPlan.id` (SetNull on delete). Named relation `"NextBillingPlan"`.
  - `nextBillingPlanEffectiveAt DateTime?` — UTC midnight on the first day of the billing period when the new plan takes effect.
  - Both nullable; null = no change scheduled.
  - Existing `billingPlan` relation renamed to `"CurrentBillingPlan"` (Prisma requires names when a model has two FK columns pointing to the same target model).
  - Index `TenantBillingSettings_nextBillingPlanId_idx`.
  - Phase 2 (worker, deferred): worker `consumeScheduledPlanChange` copies plan prices into direct fields and clears these columns after invoice creation for the effective period.
- **Operator diagnostics (read-only JSON):** `GET /admin/billing/platform/tenants/:id/pricing-diagnostics` (same **`periodMonth`/`periodYear`** as invoice preview); see **`BILLING.md`** — derives **`warnings`**, **`pricingPreviewExplanation`**, **`pricingState`** (**normalized flags + warnings via **`deriveBillingPricingState`**), **`resetToPlanPreview`**, **`differsFromPlan`** — does not persist anything.
- **Schema:** lines 683 / 721 / 790 / 809
- **Purpose:** Connect-owned invoicing pipeline (driven by `apps/worker`
  `runMonthlyBillingAutomation` + `runBillingDunningRetries`, and admin/API actions).
- **`BillingInvoice.metadata`:** optional JSON. **`dunning`** holds `{ attempts, maxAttempts, nextRetryAt }` for autopay retry backoff (see `billingDunning.ts`). **`taxCalculationAudit`** (set at invoice creation in `invoiceEngine.ts`) stores the tax provider snapshot: provider id/version, inputs, line summaries, notes — see `taxProvider.ts`. **`billingPeriodFactor`** stores the recurring billing month count/proration factor used when scaling service lines. Dunning merges preserve existing keys (root object spread).
- **`BillingInvoiceLineItem.metadata`:** used for itemized telecom rendering without a migration. Recurring invoice lines may store `lineItemKind`, `servicePeriodStart`, `servicePeriodEnd`, `billingMonthCount`, `prorated`, `baseQuantity`, `baseUnitPriceCents`, and `baseAmountCents`. Totals must derive from `BillingInvoiceLineItem.amountCents`; do not add hidden fee math in UI or payment paths.
- **`BillingEventLog.type` (examples):** `invoice_created`, `invoice_emailed`, `payment_link_emailed`, `autopay_attempted`, `payment_succeeded`, `payment_failed`, `dunning_scheduled`, `dunning_exhausted`, `receipt_emailed` / `payment_failed_emailed` (also used as dedupe markers with `message` = `PaymentTransaction.id`). **Pricing operators:** **`billing_plan.current_assigned`** (**`operatorUserId`**, **`before`/`after`** **`billingPlanId`**, stored **`billingPricingMode`**, four unit-price fields), **`billing.pricing_reset_to_plan`** (`metadata.before` / **`metadata.after`** pricing snapshots plus **`operatorId`**), **`billing.pricing_mode_changed`** (`operatorId`, **`fromMode`**, **`toMode`**, stored mode key snapshot).
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

WhatsApp-ready unified message extensions (additive)
- New optional fields on `ConnectChatMessage` to support provider idempotency and reconciliation across channels (no runtime coupling yet):
  - `externalProvider String?`, `externalMessageId String?`, `externalConversationId String?`
  - `providerStatus String?`, `providerMetadata Json?`, `deliveredAt DateTime?`
- Indexes added for reconciliation:
  - `@@index([tenantId, externalProvider, externalMessageId])`
  - `@@index([tenantId, externalConversationId])`
- Enum `ConnectChatThreadType` now includes `WHATSAPP` (appended).

- Migration note — provider message idempotency index:
  - Future dedicated SQL migration may add a partial unique index on `ConnectChatMessage` for `(tenantId, externalProvider, externalMessageId)` only where `externalProvider IS NOT NULL` and `externalMessageId IS NOT NULL`.
  - Do not use a nullable Prisma `@@unique` for that.

Idempotency fallback (inbound WhatsApp only; runtime behavior)
- If a provider `externalMessageId` is missing, the worker derives a deterministic fallback and stores it in `externalMessageId` with a `fallback:` prefix. Basis: provider|tenant|accountRef|from|to|timestamp|normalized body hash. This prevents silent message loss while avoiding obvious duplicates.

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

### WhatsApp (Option A — data-model foundation implemented)
- **Runtime source of truth (design):** `ConnectChatThread` with `type = "WHATSAPP"` and `ConnectChatMessage` projects all WA traffic into the unified message shape (attachments, reactions, replies, delivery/read fields, signed media).
- **Credentials/config:** `WhatsAppProviderConfig` stays as the encrypted credential/config store (Meta/Twilio). Mask in responses; decrypt only server-side.
- **Legacy WA tables:** `WhatsAppThread` / `WhatsAppMessage` remain for migration/backfill; not the future runtime source once projection lands.
- **Implemented fields:** `ConnectChatMessage` now has `externalProvider`, `externalMessageId`, `externalConversationId`, `providerStatus`, `providerMetadata`, `deliveredAt` with reconciliation indexes.
- **Media:** Inbound provider media will be downloaded to Connect storage and referenced by `ConnectChatMessageAttachment` via signed URLs.

### WhatsAppAccount — tenant WhatsApp identities (multi-number ready)
- **Schema:** `WhatsAppAccount`
- **Purpose:** Represents a tenant-wide (or future user-owned) WhatsApp Business identity and number; supports multiple numbers per tenant later.
- **Key fields:** `tenantId`, `provider`, `phoneE164`, `phoneNumberId?`, `wabaId?`, `messagingServiceSid?`, `displayName?`, `profilePhotoUrl?`, `aboutText?`, lifecycle/verification/webhook fields, `ownershipKind` (TENANT|USER), `ownerUserId?`, `providerConfigId?`, `settings`, `isEnabled`.
- **Lifecycle/verification fields:** `lifecycleStatus`, `verificationStatus`, `verificationMethod`, `verifiedAt`, `lastVerificationAttemptAt`, `lastProviderError`, `webhookStatus`, `lastWebhookAt`.
- **Indexes/uniques:** `@@unique([tenantId, provider, phoneE164])`, `@@index([tenantId, provider, phoneNumberId])`, `@@index([tenantId, isEnabled])`.

### WhatsAppTemplate — per-account template catalog
- **Schema:** `WhatsAppTemplate` (account-required by design)
- **Purpose:** Stores synced provider templates for a specific WhatsApp account (WABA) owned by the tenant.
- **Key fields:** `tenantId`, `whatsappAccountId` (required), `provider`, `providerTemplateId?`, `name`, `language`, `category`, `status`, `rejectionReason?`, `variableSchema?`, `lastSyncedAt?`.
- **Uniqueness:** `@@unique([tenantId, provider, whatsappAccountId, name, language])` (prevents cross-account collisions).

### WhatsAppUsageEvent — immutable ledger (minor units)
- **Schema:** `WhatsAppUsageEvent`
- **Purpose:** Append-only usage ledger for billing and reconciliation (monthly billing suitability).
- **Key fields:** `tenantId`, `whatsappAccountId?`, `provider`, `category`, `country?`, `conversationId?`, `externalMessageId?`, `connectChatMessageId?`, `templateId?`, money fields `providerCostMinor`, `billAmountMinor`, `currency`, `markupBps`, `mediaBytes?`, pricing snapshot fields, `reconciliationStatus`, `reconciledAt?`, `idempotencyKey @unique`, `occurredAt`, timestamps.
- **Indexes:** `@@index([tenantId, occurredAt])`, `@@index([whatsappAccountId, occurredAt])`, `@@index([provider, category, occurredAt])`, `@@index([conversationId])`, `@@index([connectChatMessageId])`.
- **Invariants:**
  - `WhatsAppUsageEvent` is append-only/immutable for billing audit.
  - Corrections must be recorded as explicit reversal/adjustment events; do not edit prior rows.
  - All money amounts use integer minor units only.
  - Message idempotency is enforced in application code for now; a partial unique SQL index on `ConnectChatMessage` for non-null `externalProvider`/`externalMessageId` may be added later.

### WhatsAppPricingRate — reference pricing
- **Schema:** `WhatsAppPricingRate`
- **Purpose:** Provider pricing by `provider`, `country`, `category`, with `currency`, `providerCostMinor`, and effective window.
- **Indexes:** `@@index([provider, country, category, effectiveFrom])`.

### Compliance foundations
- **WhatsAppContactPreference**: tenant+contact scoped opt-in/opt-out/block.
  - `@@unique([tenantId, contactE164])`, `@@index([tenantId, optedOutAt])`, `@@index([tenantId, blockedAt])`.
- **WhatsAppPolicyAuditEvent**: policy and guardrail audit breadcrumbs.
  - Indexes on `(tenantId, createdAt)` and `(tenantId, eventType, createdAt)`.

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
- **Modified by:** `apps/api` via `PUT /crm/users/:userId` (CRM admin) or `PUT /admin/users/:id/crm-access` (user admin).
- **Absence of a row = no CRM access for that user**, even if `CrmTenantSettings.enabled=true`.

Key fields: `enabled`, `role` (`CrmUserRole` enum: `AGENT | MANAGER | ADMIN`).

### `CrmUserCampaignAssignment`
- **Schema:** `packages/db/prisma/schema.prisma` (CRM section)
- **Purpose:** Optional per-user campaign allow-list. When rows exist for a user, non-admin CRM users only see those campaigns in `GET /crm/campaigns` and `GET /crm/queue` (and cannot open other campaigns by id).
- **Tenant-scoped?** Yes — `@@unique([tenantId, userId, campaignId])`.
- **Absence of rows = unrestricted** (all non-archived tenant campaigns allowed).
- **Modified by:** `PUT /admin/users/:id/crm-access` or `PUT /crm/users/:userId` with `campaignIds`.

Key fields: `tenantId`, `userId`, `campaignId`.

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
`auditErrorCount` _(added Phase 2 harden)_ — count of `CrmImportBatchRow` writes that failed; non-zero means Drive matching may miss those rows,
`errors` (JSON array of `{ row, reason }` objects, capped at 50 in API response),
`mapping` (JSON: detected column mapping `{ csvColumnIndex: fieldName }`).

**Phase 2 harden note:** `CrmImportBatchRow` writes are now awaited (previously fire-and-forget). Failures increment `auditErrorCount` and are logged as `crm_import_audit_row_write_failed`. The import itself still completes, but non-zero `auditErrorCount` is surfaced in the batch detail UI and blocks Drive matching with a warning.

---

---

## CRM Drive Foundation (Phase 1)

Added in migration `20260608000000_crm_drive_foundation`. All additive — no existing models modified.

### `CrmDriveFolder`
- **Schema:** end of `packages/db/prisma/schema.prisma` (CRM Drive section)
- **Purpose:** Tenant-scoped Google Drive folder configuration. Stores which Drive folder to use for lead document discovery per purpose (e.g. `LEAD_IMPORT_INBOX`).
- **Tenant-scoped?** Yes — `tenantId` FK (CASCADE) + `@@unique([tenantId, purpose])` prevents cross-tenant collision and duplicate folder configs per purpose.
- **High-risk?** No — config only; no telephony coupling; no immediate data transfer.
- **Modified by:** `apps/api/src/crm/driveRoutes.ts` via `POST /crm/drive/folder-config`.

Key fields:
- `googleConnectionId`: FK → `CrmEmailConnection.id` (CASCADE). The connection must have the `drive.readonly` scope in its `scopes[]` array.
- `folderId`: Google Drive folder ID (opaque string from Drive API).
- `folderName`: Human-readable folder name stored at config time.
- `purpose`: `CrmDriveFolderPurpose` enum — `LEAD_IMPORT_INBOX` only in Phase 1.
- Unique: `(tenantId, purpose)` — one folder config per purpose per tenant.

**Security rules:**
- A tenant can only save a folder config using a `CrmEmailConnection` that belongs to their tenant (`loadConnectionForTenant` enforces `WHERE id=? AND tenantId=?`).
- Tenant A cannot read or write Tenant B's `CrmDriveFolder` rows.

---

### `CrmLeadDocument`
- **Schema:** end of `packages/db/prisma/schema.prisma` (CRM Drive section)
- **Purpose:** Foundation model for per-lead document references. **Phase 1 is inert** — no worker consumer, no download, no OCR. The model exists so the document pipeline can be built incrementally.
- **Tenant-scoped?** Yes — `tenantId` FK (CASCADE).
- **High-risk?** No.
- **Modified by:** No active writer in Phase 1. Ready for Phase 2 worker.

Key fields:
- `leadId String?` — nullable FK to a future lead/contact row. Not linked yet because the lead import pipeline is not built.
- `source`: `CrmLeadDocumentSource` enum — `GOOGLE_DRIVE | MANUAL_UPLOAD`.
- `googleDriveFileId String?` — Drive file ID; partial unique index prevents duplicate rows per tenant.
- `googleDriveFolderId String?` — which folder this file came from.
- `originalFileName`, `mimeType`, `sizeBytes` — metadata from Drive API.
- `contentHash String?` — for deduplication (Phase 2).
- `storageKey String?` — path in Connect storage after download (Phase 2+).
- `status`: `CrmLeadDocumentStatus` enum — `DISCOVERED | IMPORT_PENDING | IMPORTED | FAILED`.

**Note:** Google Drive file content is **never** fetched or stored in Phase 1. Only metadata (name, size, mimeType, modifiedTime) is available.

---

### New enums (Phase 1)
- `CrmDriveFolderPurpose`: `LEAD_IMPORT_INBOX`
- `CrmLeadDocumentSource`: `GOOGLE_DRIVE | MANUAL_UPLOAD`
- `CrmLeadDocumentStatus`: `DISCOVERED | IMPORT_PENDING | IMPORTED | FAILED`

---

### Drive scope choice
Google Drive scope used: `https://www.googleapis.com/auth/drive.readonly`.
Narrower `drive.metadata.readonly` does not support `files.list` with folder traversal.
`drive.readonly` is the narrowest scope covering: listing folders, listing files by folder, and reading file metadata without file content. Using `drive.readonly` now avoids a second incremental re-auth when file download capability ships in Phase 2.

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

## Manual invoice + external payment fields (migration 20260605000000_billing_manual_external)

### New enum `ExternalPaymentMethod`
Values: `QUICKPAY | ZELLE | CHECK | CASH | CARD_EXTERNAL | ACH_EXTERNAL | OTHER`.
Used on `PaymentTransaction.externalMethod` when `source = "MANUAL"`.

### `BillingPaymentMethodProcessor` — added `MANUAL`
Existing value `SOLA` unchanged. `MANUAL` is used for external payments that never touch the gateway.

### `BillingLineItemType` — added `TRUNK`, `DID`, `ONE_TIME`, `CUSTOM`
New types for the full invoice line item editor.

### `BillingInvoice` — new nullable columns

| Column | Type | Purpose |
|--------|------|---------|
| `source` | `String?` | `"SYSTEM"` = auto-generated by billing run; `"MANUAL"` = operator-created |
| `createdByUserId` | `String?` | userId of operator who created (null = system) |
| `billingEmail` | `String?` | Override billing recipient email for this invoice |

### `PaymentTransaction` — new nullable columns

| Column | Type | Purpose |
|--------|------|---------|
| `source` | `String?` | `"GATEWAY"` = Cardknox/Sola; `"MANUAL"` = posted by operator |
| `externalMethod` | `ExternalPaymentMethod?` | Method when `source = "MANUAL"` |
| `externalReference` | `String?` | Check number, Zelle ref, QuickPay confirmation |
| `payerName` | `String?` | Name of person/entity who paid |
| `paymentDate` | `DateTime?` | Actual payment date (may differ from `createdAt` for back-dated entries) |
| `externalNotes` | `String?` | Operator notes |
| `createdByUserId` | `String?` | userId of operator who posted this transaction |

**Invariant:** When `source = "MANUAL"`, `processor = "MANUAL"`, `status = "APPROVED"`, no gateway call is made. The transaction is an administrative record only.

---

## PaymentMethod — new fields (migration 20260518100000_billing_sola_cutover)

Added for Sola vault token import and cutover:

| Field | Type | Purpose |
|-------|------|---------|
| `isImported` | `Boolean @default(false)` | True for cards imported from Sola recurring schedules |
| `importedAt` | `DateTime?` | When the token was imported |
| `processorCustomerId` | `String?` | Sola CustomerId (for imported cards) |
| `processorPaymentMethodId` | `String?` | Sola PaymentMethodId (for imported cards) |
| `metadata` | `Json?` | `{ solaScheduleLinkId, solaCustomerId, solaPaymentMethodId, source: "sola_recurring_import" }` |

Multiple active/imported payment methods per tenant are supported. `PaymentMethod.isDefault` and `TenantBillingSettings.defaultPaymentMethodId` are tenant-level defaults for the current Connect autopay path; they are not proof that every recurring obligation for that tenant should use the same card.

---

## CRM Drive — Phase 2 (migration 20260608010000_crm_drive_match_phase2)

### CrmImportBatchRow (new)

Per-row audit record written during `POST /crm/import/upload`. Captures the company name and resolved `contactId` for each CSV row so the Drive match engine can map normalised company names → contacts.

| Field | Type | Notes |
|-------|------|-------|
| `tenantId` | `String` | Strict tenant isolation |
| `batchId` | `String` | FK → `CrmImportBatch` (cascade delete) |
| `rowNumber` | `Int` | 1-based row number from the CSV |
| `contactId` | `String?` | FK → `Contact` (SetNull on delete); null when row was skipped |
| `companyName` | `String?` | Raw company name from CSV |
| `companyNameNormalized` | `String?` | Result of `normalizeForMatch(companyName)` |
| `action` | `String` | `"created"` \| `"updated"` \| `"skipped"` |

- Writes are now **awaited** (Phase 2 harden). Failure increments `CrmImportBatch.auditErrorCount` and logs `crm_import_audit_row_write_failed`. The import itself still succeeds.
- Indexes: `(batchId)`, `(tenantId, contactId)`, `(tenantId, companyNameNormalized)`.

### CrmLeadDocument — Phase 2 extensions

New fields added in migration `20260608010000_crm_drive_match_phase2`:

| Field | Type | Notes |
|-------|------|-------|
| `contactId` | `String?` | FK → `Contact`. The real CRM entity (no separate Lead model exists). |
| `importBatchId` | `String?` | FK → `CrmImportBatch` — which batch triggered discovery |
| `matchConfidence` | `String?` | `HIGH` \| `MEDIUM` \| `AMBIGUOUS` |
| `matchReason` | `String?` | Machine reason: `exact_company_name`, `file_contains_company`, `company_contains_file`, or those with `:ambiguous` suffix |
| `reviewedByUserId` | `String?` | FK → `User` — who confirmed or rejected |
| `reviewedAt` | `DateTime?` | When reviewed |

`CrmLeadDocumentStatus` enum values (Phase 1–3):

| Status | Meaning |
|---|---|
| `DISCOVERED` | Match found by Drive match engine — not yet reviewed |
| `IMPORT_PENDING` | User confirmed the match — queued for local copy |
| `IMPORTING` | Download + storage in progress (set at start of import attempt) |
| `IMPORTED` | File successfully stored locally with hash computed |
| `IMPORT_FAILED` | Download/storage/export failed — check `importError` |
| `FAILED` | Legacy generic failure value (Phase 1; prefer `IMPORT_FAILED` for new code) |
| `REJECTED` | User rejected the match — not attached to this contact |

Status lifecycle:
- Match flow: `DISCOVERED` → (confirm) → `IMPORT_PENDING` or (reject) → `REJECTED`
- Import flow: `IMPORT_PENDING` → `IMPORTING` → `IMPORTED` or `IMPORT_FAILED`
- Retry: set status back to `IMPORT_PENDING` to re-queue, or call with `force=true`

**Phase 3 fields added (migration 20260608030000_crm_lead_doc_import_phase3):**

| Field | Type | Notes |
|---|---|---|
| `importedAt` | `DateTime?` | When file was successfully stored locally |
| `importError` | `String?` | Short safe error message for `IMPORT_FAILED` records |
| `importedMimeType` | `String?` | MIME type actually stored (may differ from `mimeType` for exported Workspace files) |

Fields that were already present but now actively used: `storageKey` (tenant-scoped FS path), `contentHash` (SHA-256 of stored bytes), `sizeBytes` (actual stored bytes).

**Storage location:** `CRM_DOC_STORAGE_DIR` (default: `data/crm-lead-docs`). Path layout: `tenants/<tenantId>/<docId>/file<ext>`. Served via HMAC-signed URLs from `GET /crm/documents/:id/open`.

**Environment variables (Phase 3):**
- `CRM_DOC_STORAGE_DIR` — absolute path for stored files (default: `data/crm-lead-docs` relative to CWD)
- `CRM_DOC_IMPORT_MAX_BYTES` — max file size in bytes (default: 52428800 / 50 MB)
- `CRM_DOC_URL_SIGNING_SECRET` — HMAC key for signed open URLs; falls back to `PROMPT_URL_SIGNING_SECRET` / `MOH_URL_SIGNING_SECRET` / `CDR_INGEST_SECRET`

---

### CrmLeadDocument — Phase 5 extensions (text extraction)

New fields added in migration `20260608040000_crm_lead_doc_text_extraction`:

| Field | Type | Notes |
|---|---|---|
| `textExtractionStatus` | `CrmDocTextExtractionStatus?` | Denormalized mirror of `CrmLeadDocumentText.extractionStatus`. Null = not yet attempted. |
| `textExtractionError` | `String?` | Safe error message if text extraction failed. |
| `textExtractedAt` | `DateTime?` | When text extraction last completed successfully. |

These fields are denormalized for fast filtering (e.g. "find all IMPORTED docs without completed extraction") without always joining `CrmLeadDocumentText`.

**Text extraction status lifecycle:**

| Status | Meaning |
|---|---|
| `TEXT_PENDING` | Queued for extraction |
| `TEXT_PROCESSING` | Extraction in progress |
| `TEXT_COMPLETE` | Text extracted and stored in `CrmLeadDocumentText` |
| `TEXT_FAILED` | Extraction failed — check `extractionError`. Retryable. |

Full lifecycle: `null → TEXT_PENDING → TEXT_PROCESSING → TEXT_COMPLETE` or `TEXT_FAILED`
Text extraction runs only on docs with `status = IMPORTED`.

---

### `CrmLeadDocumentText` (Phase 5 / 5B)

- **Table:** `CrmLeadDocumentText`
- **Migrations:** `20260608040000_crm_lead_doc_text_extraction`, `20260608080000_crm_doc_ocr`
- **Purpose:** Stores extracted text content and metadata for imported CRM documents. One row per document (unique on `documentId`). Upserted on each extraction run — never duplicated.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` | cuid |
| `tenantId` | `String` | FK to `Tenant` — cascade delete |
| `documentId` | `String` | Unique FK to `CrmLeadDocument` — cascade delete |
| `contactId` | `String?` | Denormalized for fast tenant-scoped queries |
| `importBatchId` | `String?` | Denormalized for batch-level aggregation |
| `text` | `String` | Extracted text — capped at 500,000 chars |
| `pageCount` | `Int?` | Page count from PDF metadata; null for non-PDF |
| `charCount` | `Int` | Character count of `text` field |
| `extractionProvider` | `CrmDocTextExtractionProvider` | How text was extracted (see enum below) |
| `extractionStatus` | `CrmDocTextExtractionStatus` | Current status |
| `extractionError` | `String?` | Safe error message (no content, no paths) |
| `extractedAt` | `DateTime?` | When extraction completed successfully |
| `extractionConfidence` | `Float?` | OCR confidence (0–100). Null for non-OCR providers. *(Phase 5B)* |
| `extractionMetadata` | `Json?` | Provider-specific metadata. For `tesseract_js`: `{ "ocrEngine": "tesseract_js", "language": "eng", "pageCount": 1 }`. Never stores document content. *(Phase 5B)* |

**`CrmDocTextExtractionProvider` enum:**

| Value | Meaning |
|---|---|
| `pdf_text_layer` | PDF with embedded text (pdf-parse library) |
| `plain_text` | .txt / .csv / text/plain MIME (Node fs) |
| `docx_text` | DOCX via mammoth library |
| `unsupported` | File type has no supported extractor |
| `future_ocr` | Backward-compat: scanned PDFs without OCR. Stored for rows before Phase 5B. |
| `tesseract_js` | *(Phase 5B)* Tesseract.js WASM OCR for PNG/JPG/JPEG/TIFF images |

**`CrmDocTextExtractionStatus` enum:**

| Value | Meaning |
|---|---|
| `TEXT_PENDING` | Queued for extraction |
| `TEXT_PROCESSING` | Extraction in progress |
| `TEXT_COMPLETE` | Text extracted and stored |
| `TEXT_FAILED` | Extraction failed — retryable |

**Scanned PDF / image-only PDF behaviour:**
`pdf-parse` returns an empty text string for PDFs with no embedded text layer. The service stores a `TEXT_FAILED` record with `extractionProvider = future_ocr` and error `scanned_pdf_ocr_provider_not_configured`. PDF page rasterization is not supported (requires native binaries). See KNOWN_ISSUES.md.

**Image OCR behaviour (Phase 5B):**
When `CRM_OCR_ENABLED=true`, PNG/JPG/JPEG/TIFF files are routed to the `TesseractJsOcrProvider`. Tesseract.js runs WASM-based OCR, returns `text` and `confidence` (0–100). Size limit (`CRM_OCR_MAX_FILE_BYTES`, default 10 MB) is enforced before processing.

**Dependencies (in `apps/api`):**
- `pdf-parse` (+ `@types/pdf-parse`) — reads text layer from PDFs
- `mammoth` — extracts raw text from DOCX files (ships own types, no `@types/mammoth`)
- `tesseract.js` *(Phase 5B)* — pure WASM OCR, no native binaries required. Language data downloaded from CDN at runtime (set `CRM_OCR_LANG_PATH` for air-gapped environments).

**Unique constraint (Phase 2 harden — migration 20260608020000):** The Phase 1 constraint `UNIQUE (tenantId, googleDriveFileId)` was too broad — it prevented the same Drive file from being discovered across two separate import batches for the same tenant. Replaced with a scoped partial unique index:

```sql
UNIQUE (tenantId, importBatchId, googleDriveFileId)
WHERE importBatchId IS NOT NULL AND googleDriveFileId IS NOT NULL
```

This allows the same Drive file to appear in multiple batches. The match engine uses `createMany({ skipDuplicates: true })` for idempotent reruns — existing `IMPORT_PENDING` / `REJECTED` records are never overwritten.

---

### Contact Discovery (Phase 6)

**Migration:** `20260608050000_crm_contact_discovery`

Discovery models store phones and emails found in extracted document text, pending user review. All discoveries are **user-gated** — nothing is attached to a contact automatically.

#### `CrmDiscoveryStatus` enum

| Value | Meaning |
|---|---|
| `PENDING` | Found, awaiting user accept/reject |
| `ACCEPTED` | User approved — value has been attached to the contact |
| `REJECTED` | User dismissed — record kept for audit, never resurfaces |

Re-running discovery **never reopens** `ACCEPTED` or `REJECTED` records.

#### `CrmLeadDiscoveredPhone`

| Field | Type | Notes |
|---|---|---|
| `id` | `String` | cuid |
| `tenantId` | `String` | FK → Tenant (Cascade delete) |
| `contactId` | `String` | FK → Contact (Cascade delete) |
| `documentId` | `String` | FK → CrmLeadDocument (Cascade delete) |
| `documentTextId` | `String` | FK → CrmLeadDocumentText (Cascade delete) |
| `phoneNumber` | `String` | Raw text as found (e.g. "(555) 123-4567") |
| `normalizedPhone` | `String` | Digits-only (e.g. "5551234567") — used for dedup |
| `confidence` | `String` | `HIGH` or `MEDIUM` |
| `sourceSnippet` | `String?` | Up to 200 chars of surrounding text — never the full document |
| `sourcePage` | `Int?` | Page number if available |
| `status` | `CrmDiscoveryStatus` | Default: `PENDING` |
| `createdAt` | `DateTime` | |
| `updatedAt` | `DateTime` | |

**Unique constraint:** `(tenantId, contactId, normalizedPhone, documentId)` — prevents duplicate discoveries on rerun.

**Confidence scoring:**
- `HIGH` — valid US 10-digit phone AND appears within 80 chars of a phone label (`phone`, `mobile`, `cell`, `tel`, `contact`, `call`, `direct`).
- `MEDIUM` — valid US 10-digit phone but no label context.

**Normalization:** strip all non-digits; 10 digits → valid; 11 digits starting with `1` → strip leading 1 → valid; anything else discarded.

**Deduplication at accept time:** if `ContactPhone.numberNormalized` already matches, the acceptance reuses the existing phone row and marks the discovery `ACCEPTED` without duplicating.

#### `CrmLeadDiscoveredEmail`

| Field | Type | Notes |
|---|---|---|
| `id` | `String` | cuid |
| `tenantId` | `String` | FK → Tenant (Cascade delete) |
| `contactId` | `String` | FK → Contact (Cascade delete) |
| `documentId` | `String` | FK → CrmLeadDocument (Cascade delete) |
| `documentTextId` | `String` | FK → CrmLeadDocumentText (Cascade delete) |
| `email` | `String` | Lowercased |
| `confidence` | `String` | `HIGH` (standard email format) |
| `sourceSnippet` | `String?` | Up to 200 chars of surrounding text |
| `sourcePage` | `Int?` | Page number if available |
| `status` | `CrmDiscoveryStatus` | Default: `PENDING` |
| `createdAt` | `DateTime` | |
| `updatedAt` | `DateTime` | |

**Unique constraint:** `(tenantId, contactId, email, documentId)` — prevents duplicate discoveries on rerun.

**Suppression:** values already present on the contact (`ContactEmail.email`) are silently skipped when discovery runs — the discovery list only shows genuinely new values.

#### Security

- All discovery routes require `requireCrmAccess` (tenant JWT).
- Extracted document text is **never** returned from discovery endpoints — only `sourceSnippet` (≤ 200 chars) is exposed.
- Tenant B cannot read or act on Tenant A's discoveries (tenant-scoped `findFirst` on every lookup).
- Accepting a phone never overwrites an existing primary phone (`isPrimary: false` on create).

---

---

### AI Lead Intelligence (Phase 7)

**Migration:** `20260608060000_crm_lead_intelligence`

**Package added:** `openai ^6.x` in `apps/api`

#### `CrmLeadIntelligenceStatus` enum

| Value | Meaning |
|---|---|
| `PENDING` | Report queued, not yet started |
| `PROCESSING` | AI call in progress |
| `COMPLETE` | Report generated; all output fields populated |
| `FAILED` | AI call failed; `error` field has a safe message |

#### `CrmLeadIntelligenceReport`

One row per contact (`UNIQUE on contactId`). Upserted on `force` regeneration.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` | cuid |
| `tenantId` | `String` | FK → Tenant (Cascade delete) |
| `contactId` | `String @unique` | FK → Contact (Cascade delete). One report per contact. |
| `importBatchId` | `String?` | Optional link to the import batch that triggered generation |
| `status` | `CrmLeadIntelligenceStatus` | Default: `PENDING` |
| `summary` | `String?` | 2-3 sentence executive summary (≤ 2000 chars) |
| `businessOverview` | `String?` | Paragraph about the company (≤ 3000 chars) |
| `keyFindings` | `Json?` | `{ phoneCount, emailCount, documentCount, namesFound[], addressesFound[], additionalNotes[] }` |
| `discoveredEntities` | `Json?` | `{ phones[], emails[], websites[], names[], addresses[] }` |
| `riskFlags` | `Json?` | Array of risk-flag code strings |
| `missingInformation` | `Json?` | Array of missing-info code strings |
| `confidenceScore` | `Float?` | 0.0–1.0 AI-assessed confidence |
| `modelName` | `String?` | e.g. `"gpt-4o-mini"` |
| `providerName` | `String?` | e.g. `"openai"` — provider identifier |
| `generatedAt` | `DateTime?` | When the report was successfully generated |
| `error` | `String?` | Safe error message if FAILED (≤ 500 chars, no document content, no tokens) |
| `sourceDocumentCount` | `Int?` | All imported documents for contact |
| `sourceTextCount` | `Int?` | Documents with TEXT_COMPLETE extraction |
| `sourceDiscoveryCount` | `Int?` | Total phone + email discoveries (any status) |
| `promptCharCount` | `Int?` | Total characters of text sent to the AI provider |
| `documentsIncluded` | `Int?` | Documents actually included in the AI prompt |
| `documentsExcluded` | `Int?` | Documents excluded due to `maxDocumentsPerReport` limit |
| `generationDurationMs` | `Int?` | Wall-clock time of the AI provider call (milliseconds) |
| `createdAt` | `DateTime` | |
| `updatedAt` | `DateTime` | |

**Never stored:** raw prompt text, API keys, document content.

**Idempotency:** If `status=COMPLETE` and `force=false`, the existing report is returned immediately. `status=FAILED` can always be retried without `force`. `status=PROCESSING` skips to prevent duplicate AI calls.

**Cooldown:** `force=true` on a COMPLETE report within `regenerationCooldownMinutes` throws `cooldown_active` (HTTP 429) with `retryAfterMs` and a human-readable message. CRM admin roles bypass.

**Input limits:** Controlled by `CrmAiSettings` (see below). Defaults: 5 docs, 2000 chars/doc, 10000 total chars.

**Provider abstraction:** `LeadIntelligenceProvider` interface in `leadIntelligenceProvider.ts`. Currently: `OpenAiLeadIntelligenceProvider`. Switch provider in `getLeadIntelligenceProvider()` without touching routes or service.

**Environment variables:**
- `OPENAI_API_KEY` — required; if missing, routes return `503 ai_not_configured`
- `LEAD_INTELLIGENCE_MODEL` — optional override (default: `gpt-4o-mini`)

**Advisory only:** no contact data is modified, no discoveries are auto-accepted, no ContactPhone/ContactEmail rows are created by intelligence generation.

---

#### `CrmAiSettings` *(Phase 7B — governance)*

Per-tenant AI generation settings. Absence of a row means all defaults apply. One row per tenant (`UNIQUE on tenantId`).

| Field | Type | Default | Hard Server Cap |
|---|---|---|---|
| `id` | `String` | cuid | — |
| `tenantId` | `String @unique` | — | — |
| `aiEnabled` | `Boolean` | `true` | — |
| `maxDocumentsPerReport` | `Int` | `5` | `10` |
| `maxCharsPerDocument` | `Int` | `2000` | `5000` |
| `maxTotalCharsPerReport` | `Int` | `10000` | `25000` |
| `allowBatchGeneration` | `Boolean` | `true` | — |
| `maxBatchReportsPerRun` | `Int` | `25` | `25` |
| `regenerationCooldownMinutes` | `Int` | `60` | none (min: 0) |
| `createdAt` | `DateTime` | | |
| `updatedAt` | `DateTime` | | |

**Hard caps** are enforced server-side in `loadTenantAiSettings()` regardless of stored values.
Only CRM admin role can write this table via `PUT /crm/ai-settings`.
See `docs/ai-context/CRM_AI.md` for full governance documentation.

---

### CRM Import Batch Pipeline (Phase 8)

**Migration:** `20260608090000_crm_batch_pipeline`

Tracks orchestrated "Process Batch" pipeline runs that automate the five CRM pipeline steps for a given import batch.

#### `CrmPipelineRunStatus` enum

| Value | Meaning |
|---|---|
| `PENDING` | Run created but not yet started |
| `RUNNING` | Actively processing (short-lived since synchronous per call) |
| `COMPLETE` | All steps finished; no more work remaining |
| `PARTIAL` | Progress made but work remains or some documents failed |
| `FAILED` | Could not start (e.g. no Drive folder configured) |
| `CANCELLED` | Manually cancelled |

#### `CrmImportBatchPipelineRun`

One record per pipeline invocation. Multiple runs per batch are allowed; `Start New Run` always creates a new record, while `Continue Processing` updates the latest `PARTIAL` run.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` | cuid |
| `tenantId` | `String` | FK → `Tenant` (cascade delete) |
| `importBatchId` | `String` | FK → `CrmImportBatch` (cascade delete) |
| `status` | `CrmPipelineRunStatus` | default `PENDING` |
| `startedByUserId` | `String?` | User who started or continued this run |
| `currentStep` | `String?` | Step currently executing or last completed |
| `steps` | `Json` | Per-step results (see below) |
| `totals` | `Json` | Aggregate counts across all steps |
| `errors` | `Json` | Safe error list (max 10 entries; no doc text/keys) |
| `startedAt` | `DateTime?` | |
| `completedAt` | `DateTime?` | Null while PARTIAL/RUNNING |
| `recoveredAt` | `DateTime?` | Set when a stale RUNNING run is auto-recovered to FAILED |
| `createdAt` | `DateTime` | |
| `updatedAt` | `DateTime` | Used as the staleness timestamp for RUNNING run detection |

**Indexes:** `(tenantId, importBatchId)`, `(tenantId, status)`

**`steps` JSON shape** — one key per pipeline step:
```json
{
  "drive_match": {
    "status": "complete",
    "startedAt": "2026-06-08T09:00:00Z",
    "completedAt": "2026-06-08T09:00:01Z",
    "attempted": 15,
    "succeeded": 12,
    "skipped": 3,
    "failed": 0,
    "errorSummary": null
  },
  "document_import": { ... },
  "text_extraction": { ... },
  "contact_discovery": { ... },
  "ai_intelligence": { ... }
}
```

Step statuses: `pending | running | complete | partial | skipped | failed`

**`totals` JSON shape:**
```json
{
  "driveFilesScanned": 15,
  "documentsMatched": 12,
  "documentsImported": 10,
  "textExtracted": 8,
  "discoveriesFound": 14,
  "aiReportsGenerated": 5
}
```

**`errors` JSON shape** (capped at 10 entries):
```json
[{ "step": "document_import", "error": "Drive token expired", "at": "2026-06-08T09:00:05Z" }]
```

**Pipeline step per-call limits** (bounded synchronous execution):
- Drive match: unlimited (fast idempotent scan)
- Document import: 20 per call
- Text extraction: 5 per call (OCR may be slow)
- Contact discovery: 10 per call
- AI intelligence: 5 per call (governed by `CrmAiSettings`)

**AI step skipping:**
- If `CrmAiSettings.aiEnabled=false` or `allowBatchGeneration=false`, the `ai_intelligence` step is recorded as `skipped` (not `failed`) and the pipeline can still complete as `COMPLETE`.

**Pipeline never force-regenerates AI reports.** Default pipeline passes `force=false` to `generateBatchIntelligence`.

#### Pipeline configuration (env vars)

| Variable | Default | Description |
|---|---|---|
| `CRM_PIPELINE_STALE_MINUTES` | `30` | Minutes before a RUNNING run is considered stale (crashed server recovery). Min: 1. |
| `CRM_PIPELINE_MAX_STEP_ITEMS` | `20` | Global ceiling for items per step per call. Range: 1–50. Each step also has its own natural limit (5 for extraction, 10 for discovery). Effective = min(natural, max_step_items). |

#### Stale RUNNING recovery (Phase 8 hardening)

When `startBatchPipeline` or `continueBatchPipeline` is called, the service first checks for any runs with `status=RUNNING` and `updatedAt < now - CRM_PIPELINE_STALE_MINUTES`. These are assumed to have been abandoned due to a server crash.

- Stale runs are marked `FAILED`.
- `recoveredAt` is set to the current timestamp.
- `errors` array gets a `{ step: "system", error: "stale_run_recovered" }` entry.
- Audit event `crm_pipeline_stale_recovered` is emitted.
- After recovery, a fresh run can start without getting a 409.

#### Pipeline audit events

| Event | When emitted |
|---|---|
| `crm_pipeline_started` | New run created and execution begins |
| `crm_pipeline_completed` | Run finishes with status COMPLETE |
| `crm_pipeline_partial` | Run finishes with status PARTIAL (more work remains) |
| `crm_pipeline_failed` | Run finishes with status FAILED |
| `crm_pipeline_cancelled` | Run is cancelled by user |
| `crm_pipeline_stale_recovered` | Stale RUNNING run auto-recovered to FAILED |

All audit events include: `tenantId`, `batchId`, `runId`, `durationMs` (where applicable). They NEVER include document text, AI prompts, storage paths, or API keys.

---

### CRM Batch Diagnostics (Phase 9)

`batchDiagnosticsService.ts` provides a unified read-only diagnostics view for a single import batch. **No new DB models** — all data is aggregated from existing tables.

#### Data sources

| Source table | Fields used |
|---|---|
| `CrmImportBatch` | id, fileName, status, totalRows, counts, createdAt, completedAt |
| `CrmLeadDocument` | status (IMPORT_PENDING/IMPORTED/IMPORT_FAILED), per-batch counts |
| `CrmLeadDocumentText` | extractionStatus, extractionProvider, charCount, extractionError |
| `CrmLeadDiscoveredPhone/Email` | status (PENDING/ACCEPTED/REJECTED), per-batch counts |
| `CrmLeadIntelligenceReport` | status (PENDING/PROCESSING/COMPLETE/FAILED), importBatchId |
| `CrmImportBatchPipelineRun` | latest run, staleRecoveries (recoveredAt != null), steps JSON |

#### Health score

Deterministic integer 0–100 derived from:

| Condition | Penalty |
|---|---|
| No Drive folder configured | -20 |
| Failed imports | -5 each, max -30 |
| Failed extractions | -5 each, max -20 |
| OCR failures | -5 each, max -10 |
| AI generation failures | -5 each, max -10 |
| Stale run recoveries | -15 each, max -30 |

Result clamped to 0–100. Score is **deterministic** — given the same DB state it always returns the same value.

**Interpretation:** ≥80 = healthy (green), 50–79 = degraded (amber), <50 = critical (red).

#### Failure categories

| Category | Trigger |
|---|---|
| `CONFIGURATION` | Missing Drive folder, AI/OCR disabled |
| `DOCUMENT` | `CrmLeadDocument.status = IMPORT_FAILED` or text extraction failed (non-OCR) |
| `OCR` | `CrmLeadDocumentText.extractionStatus = TEXT_FAILED` with OCR provider |
| `AI` | `CrmLeadIntelligenceReport.status = FAILED` |
| `PIPELINE` | Pipeline step `status = "failed"` in `CrmImportBatchPipelineRun.steps` |
| `SECURITY` | Reserved for future cross-tenant or access violation detection |

#### Warning codes

| Code | Condition |
|---|---|
| `no_drive_folder` | Drive match step failed with `no_drive_folder` error |
| `ocr_disabled` | `CRM_OCR_ENABLED` is not `"true"` |
| `ai_disabled` | `CrmAiSettings.aiEnabled = false` |
| `batch_ai_disabled` | `CrmAiSettings.allowBatchGeneration = false` |
| `stale_run_recovered` | One or more runs have `recoveredAt != null` |
| `import_failures_present` | Any `IMPORT_FAILED` documents |
| `extraction_failures_present` | Any `TEXT_FAILED` extraction records |
| `scanned_pdfs_unsupported` | PDF extraction failed with "scanned" in error |

#### Support bundle

Safe JSON export returned by `GET .../diagnostics/support-bundle`. Contains everything in `BatchDiagnostics` plus timeline and operational config. Intentionally excludes:
- Document text (any field)
- AI prompts or outputs
- Storage keys or file paths
- API keys, tokens, or credentials

---

### Matching algorithm (driveMatchService.ts)

- `normalizeForMatch(text)`: lowercase → replace `&` with `and` → strip punctuation → strip common legal words (llc, inc, corp, co, ltd, company, group, the, and, of, a, an) → collapse whitespace.
- `normalizeFileName(name)`: strip extension, then `normalizeForMatch`.
- `scoreMatch(companyNorm, fileNorm)`:
  - `HIGH` — exact token equality.
  - `MEDIUM` — one token contains the other AND contained token is ≥ 4 chars.
  - `LOW` — no meaningful overlap (discarded; no record written).
- Ambiguity: if one file matches N > 1 companies **or** one company matches N > 1 files, all those candidates are marked `AMBIGUOUS`.

### Security rules

- `runDriveMatchForBatch` filters by `(batchId, tenantId)` → Tenant B cannot trigger matching for Tenant A's batch.
- `folderConfig` loaded with `{ tenantId }` → cross-tenant Drive folder access is impossible.
- Confirm/reject routes load doc by `(docId, tenantId)` → cross-tenant doc access returns 404.
- Contact documents route verifies `(contactId, tenantId)` before any document query.

## BillingSolaExternalScheduleLink — new fields (migration 20260518100000_billing_sola_cutover)

One row mirrors one external Sola/Cardknox recurring schedule. `tenantId` is intentionally **not unique**: a single Connect tenant may have multiple independent recurring schedules/profiles with different amounts, cards, or service obligations. Duplicate detection must use the schedule/profile/obligation identity, not tenant name alone.

| Field | Type | Purpose |
|-------|------|---------|
| `cutoverStatus` | `String?` | `TOKEN_LINKED \| CUTOVER_COMPLETE \| CUTOVER_FAILED` |
| `linkedPaymentMethodId` | `String?` | FK → `PaymentMethod.id` (SetNull on delete) |
| `tokenLinkedAt` | `DateTime?` | When token was linked |
| `cutoverAt` | `DateTime?` | When cutover completed |
| `cutoverByUserId` | `String?` | Operator who triggered cutover |
| `disabledSolaAt` | `DateTime?` | When old Sola schedule was disabled |
| `disableAttemptedAt` | `DateTime?` | When disable was last attempted |
| `disableError` | `String?` | Error message if disable failed |
| `connectAutopayEnabledAt` | `DateTime?` | When Connect autopay was enabled |
