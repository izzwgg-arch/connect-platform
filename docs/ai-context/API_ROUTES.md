# API Route Inventory — `apps/api/src/server.ts`

> **Purpose:** Let agents jump to the right ~50-line slice of `server.ts`
> instead of loading the whole 27,801-line file. Always confirm the
> current line numbers with `Grep` (the file changes often) — the ranges
> below are accurate at time of writing but not guaranteed forever.

## File facts

- Path: `apps/api/src/server.ts`
- Size: **27,801 lines / ~1.3 MB** (top single-file token cost in the repo)
- Inline `app.<method>("/...")` registrations: **407**
- Plus four delegated route registrars (loaded near end of file):
  - `registerBillingRoutes(app)` → `apps/api/src/billing/routes.ts` (line ~30198)
  - `registerPlatformRolePermissionRoutes(app)` (line ~30199)
  - `registerUserExtensionProvisioningRoutes(app, …)` → `apps/api/src/userExtensionProvisioning.ts` (line ~30200)
  - `registerConnectChatRoutes(app, …)` → `apps/api/src/connectChatRoutes.ts` (line ~30265)

### Request profiling (CPU / hot routes)

- **Prometheus:** histogram **`connect_api_request_duration_seconds`** (`method`, `route`, `status`) — see **`GET /metrics`** in `server.ts`.
- **Temporary logs:** **`CONNECT_API_PROFILE=1`** (and optional **`CONNECT_API_PROFILE_EACH=1`**) — see **`apps/api/src/apiRequestProfiler.ts`** and **`docs/ai-context/DEBUGGING.md`** § *API CPU spike — profiling HTTP hot routes*.
- **No route semantics change** from profiling flags alone — they only add log output.

### Operational note — `GET /admin/sms/provider-health`

Returns aggregate SMS provider health for **admin / ops** dashboards. **Do not** wire
this into **high-frequency background loops** (e.g. 30 s desktop notification timers) —
it is heavier than tenant **`GET /sms/messages`**. Connect Desktop notifications use
**`fetchTenantSmsInboxThreads()`** in **`apps/portal/services/platformData.ts`** instead.

## Why the line ranges are huge

`server.ts` is **not grouped by feature**. Routes for the same prefix are
scattered — for example, `/admin/*` routes appear at lines 3586, 4603,
6217, 6375, 6414, 6424, 6844, 6851, 6864, all the way out past line 30000.
Always grep for the exact path before assuming a "section".

## Discovery cheat sheet

```pwsh
# Find all route lines for a given prefix (PowerShell, no rg required):
Select-String -Path "apps\api\src\server.ts" -Pattern '^app\.(get|post|put|patch|delete)\("\/voice/'
```

```bash
# Find all route lines for a given prefix (bash):
grep -nE '^app\.(get|post|put|patch|delete)\("/voice/' apps/api/src/server.ts
```

---

## Route groups (by URL prefix)

The table below counts every `app.<method>("/<prefix>/…")` call at column 0
in `server.ts`, plus first/last line numbers in the file. Counts and ranges
are at time of writing.

| Prefix | Count | First line | Last line |
|---|---:|---:|---:|
| `/voice/*` | 120 | 3592 | 23313 |
| `/admin/*` | 108 | 3586 | 30122 |
| `/settings/*` | 25 | 5346 | 21996 |
| `/billing/*` | 22 | 21595 | 27438 |
| `/pbx/*` | 19 | 6925 | 28748 |
| `/customers/*` | 16 | 22700 | 23339 |
| `/mobile/*` | 15 | 3756 | 25111 |
| `/contacts/*` | 9 | 22476 | 22687 |
| `/auth/*` | 8 | 4053 | 4265 |
| `/sms/*` | 7 | 6457 | 6838 |
| `/dashboard/*` | 7 | 25764 | 26929 |
| `/internal/*` | 7 | 20731 | 25252 |
| `/me/*` | 6 | 4517 | 5104 |
| `/whatsapp/*` | 6 | 5752 | 5919 |
| `/webhooks/*` | 6 | 6878 | 27709 |
| `/numbers/*` | 5 | 6053 | 6174 |
| `/voicemail/*` | 5 | 14512 | 14767 |
| `/outbound-routes/*` | 4 | 4954 | 5055 |
| `/automation/*` | 3 | 23228 | 23259 |
| `/ten-dlc/*` | 2 | 6302 | 6346 |
| `/calls/*` | 2 | 20843 | 21517 |
| `/health` | 1 | 3623 | 3623 |
| `/metrics` | 1 | 4016 | 4016 |
| `/forensic/*` | 1 | 21556 | 21556 |
| `/search` | 1 | 27007 | 27007 |
| `/downloads/*` | 1 | 3776 | 3776 |

Plus four delegated registrars at lines ~30198–30265 (see top of file).

---

## Auth Routes

**Approx lines:** 4053 – 4265
**Purpose:** signup / login / invite acceptance / password reset / mobile QR exchange.
**Auth requirements:** mostly **public** (these are the entry points). `auth/mobile-qr-exchange` is gated by an admin-issued QR token.
**Risk:** **HIGH** — password / invite / token logic. Any change must preserve tenant scoping and rate limiting (`rate-limit` plugin registered at line 117).
**Key endpoints:**
- `POST /auth/signup` (4053)
- `POST /auth/login` (4110)
- `GET /auth/invite/validate` (4156)
- `POST /auth/invite/accept` (4176)
- `POST /auth/password/forgot` (4210)
- `GET /auth/password/reset/validate` (4229)
- `POST /auth/password/reset` (4239)
- `POST /auth/mobile-qr-exchange` (4265)

> Token issuance / signing config is at `app.register(jwt, …)` (line 118).

---

## Health / Metrics / Downloads / Mobile-app

**Approx lines:** 3586 – 4016, plus scattered `/mobile/*` routes
**Purpose:** liveness, Prometheus scrape, mobile APK download, SBC status, Android "latest" pointer.
**Auth requirements:** `/health` and `/metrics` are open (Prometheus scrape uses network ACL, not JWT). `/admin/sbc/status` is admin-gated.
**Risk:** **LOW** for `/health`, **MEDIUM** for `/metrics` (do not include PII in label cardinality), **MEDIUM** for `/mobile/android/*` and `/downloads/:filename` (touches release artifacts on disk).
**Key endpoints:**
- `GET /health` (3623)
- `GET /metrics` (4016)
- `GET /admin/sbc/status` (3586) / `GET /voice/sbc/status` (3592)
- `GET /mobile/android/download` (3756)
- `GET /downloads/:filename` (3776)
- `GET /mobile/android/latest` (3886) — JSON includes `publishedAt` (prefers
  `createdAt` / `publishedAt` from `connectcomms-latest.json` when present, else
  APK `mtime`).
- `POST /contacts` — creates external/personal contacts; gated by
  `canCreateContacts` (directory viewers except READ_ONLY), not the narrower
  `canManageCustomerWorkflow` used for bulk admin contact writes.

---

## User / Admin User Routes

**Approx lines:** 4517 – 5346
**Purpose:** current user (`/me/*`), admin user CRUD, role updates, invites, disable/enable, avatar.
**Auth requirements:** `/me/*` requires JWT; `/admin/users/*` requires admin role (verify `req.user` shape on read).
**Risk:** **HIGH** — touches `User`, `Tenant`, role-permission graph, and `Extension` provisioning side-effects.
**Key endpoints:**
- `GET /me` (4517), avatar GET/POST/DELETE (4547 / 4564 / 4592)
- `GET /admin/users` (4603), `POST /admin/users` (4719), `GET /admin/users/:id` (4836), `PATCH /admin/users/:id` (5236)
- `GET /admin/users/extension-prefill` (4700)
- `POST /admin/users/:id/role` (5295)
- `POST /admin/users/:id/resend-invite` (5308)
- `POST /admin/users/:id/disable` (5323), `/enable` (5335)
- `GET /admin/users/:id/outbound-routes` (5170), `PUT /admin/users/:id/outbound-routes` (5193)

---

## Outbound Routes

**Approx lines:** 4954 – 5193
**Purpose:** tenant-scoped outbound dial routes + per-user permissions + dial-resolution.
**Auth requirements:** JWT.
**Risk:** **HIGH** — directly impacts call routing; one wrong write can mis-route an entire tenant's outbound traffic.
**Key endpoints:**
- `GET /outbound-routes` (4954), `POST /outbound-routes` (4971), `PATCH /outbound-routes/:id` (5012), `DELETE /outbound-routes/:id` (5055)
- `GET /me/outbound-routes` (5080), `POST /me/outbound-routes/resolve-dial` (5104)

---

## Settings — SMS, providers, WhatsApp routing

**Approx lines:** 5346 – 6044
**Purpose:** tenant settings for SMS limits, Twilio / VoIP.ms / WhatsApp providers, SMS routing.
**Auth requirements:** admin/owner JWT.
**Risk:** **HIGH** — these write provider credentials (encrypted via `@connect/security`) and toggle live messaging providers per-tenant.
**Key endpoints:**
- `GET/POST /settings/sms-limits` (5346/5359)
- `GET /settings/providers` (5429), Twilio enable/disable (5453/5475/5509), VoIP.ms enable/disable (5523/5544/5577)
- `GET /settings/providers/whatsapp` (5591), Twilio/Meta config (5611/5665), enable/disable (5723/5738)
- `GET/POST /settings/sms-routing` (5965/5993), lock/unlock (6022/6044)

---

## WhatsApp Threads

**Approx lines:** 5752 – 5919
**Purpose:** WhatsApp test send + thread/message read/send.
**Auth requirements:** JWT.
**Risk:** **HIGH** — sends real WhatsApp messages.
**Key endpoints:**
- `POST /whatsapp/test-send` (5752)
- `GET /whatsapp/status` (5785), `GET /whatsapp/messages/recent` (5813)
- `GET /whatsapp/threads` (5845), `GET /whatsapp/threads/:id` (5887), `POST /whatsapp/threads/:id/send` (5919)

---

## Numbers / Ten-DLC / Number Provisioning

**Approx lines:** 6053 – 6358
**Purpose:** phone-number search/purchase/release, default-SMS toggle, Ten-DLC submission lifecycle.
**Auth requirements:** JWT (admin for `/admin/numbers`, `/admin/tenants/:id/number-purchase-enabled`, `/admin/ten-dlc/*`).
**Risk:** **HIGH** — purchases/releases real DIDs and submits Ten-DLC campaigns to carriers.
**Key endpoints:**
- `GET /numbers` (6053), `POST /numbers/search` (6077), `POST /numbers/purchase` (6105)
- `POST /numbers/:id/set-default-sms` (6160), `POST /numbers/:id/release` (6174)
- `GET /admin/numbers` (6200), `POST /admin/tenants/:id/number-purchase-enabled` (6217)
- `POST /ten-dlc/submit` (6302), `GET /ten-dlc/status` (6346)
- `GET /admin/ten-dlc/submissions` (6351), `…/:id` (6358), `…/:id/status` (6365)

---

## SMS Campaigns

**Approx lines:** 6457 – 6878
**Purpose:** campaign CRUD + preview + send + status webhooks + admin moderation.
**Auth requirements:** JWT for tenant routes; `webhooks/*` is bearer-via-signature.
**Risk:** **HIGH** — sends real SMS at scale.
**Key endpoints:**
- `POST /sms/campaigns` (6457), `PUT /sms/campaigns/:id` (6596)
- `POST /sms/campaigns/:id/preview` (6674), `POST /sms/campaigns/:id/send` (6715)
- `GET /sms/campaigns` (6792), `GET /sms/campaigns/:id` (6813), `GET /sms/messages` (6838)
- `GET /admin/sms/campaigns` (6844), `…/:id/approve` (6851), `…/:id/reject` (6864)
- `POST /webhooks/twilio/sms-status` (6878)

---

## PBX Routes (link / extensions / extension password mgmt)

**Approx lines:** 6925 – 7150 (and other `/pbx/*` scattered later)
**Purpose:** PBX instance link/unlink, extension CRUD, suspend/unsuspend, SIP password rotation.
**Auth requirements:** admin JWT.
**Risk:** **EXTREME** — these write to VitalPBX. Any break can knock a tenant off-line. Always verify with `GET /pbx/status` before/after a write.
**Key endpoints:**
- `GET /pbx/status` (6925)
- `POST /pbx/link` (6944), `POST /pbx/unlink` (6981)
- `GET /pbx/extensions` (6992), `POST /pbx/extensions` (6999)
- `POST /pbx/extensions/:id/suspend` (7046), `…/unsuspend` (7069)
- `POST /pbx/extensions/:id/reset-sip-password` (7091), `…/set-sip-password` (7122)

> Additional `/pbx/*` routes exist further down — search for `app\.(get|post|put|patch|delete)\("/pbx/` to find them all.

---

## Voice Routes — biggest cluster (120 routes)

**Approx lines:** 3592 – 23313 (scattered)
**Purpose:** WebRTC config, TURN/STUN management, IVR publish/rollback, MOH publish/rollback, voicemail, recording management, DID routing, WebRTC tests, mobile-provisioning, healing engine, media metrics.

The `/voice/*` cluster is **the most surgical area of this file** because it
talks to the telephony service (and through it, to AMI/ARI/AstDB).

Breakdown by sub-prefix (count / approximate scope):

| Sub-prefix | Count | What it does |
|---|---:|---|
| `/voice/ivr/*` | 32 | IVR profile CRUD, schedule config, override state, publish, rollback. **EXTREME** — writes AstDB via telephony. |
| `/voice/moh/*` | 26 | MOH profile/schedule/override + publish + rollback + assets + per-extension overrides (Phase 2, DB-only). **EXTREME** — same path as IVR (the per-extension routes are MEDIUM until the resolver lands). |
| `/voice/did/*` | 11 | DID → route mapping + switch log. **HIGH** — wrong write reroutes inbound calls. |
| `/voice/diag/*` | 9 | Read-only diagnostics. **LOW**. |
| `/voice/voicemail/*` | 5 | VM mailbox config + greetings. **HIGH**. |
| `/voice/extensions/*` | 4 | Extension lookup. **MEDIUM**. |
| `/voice/turn/*` | 4 | TURN credential issuance + validation. **HIGH** (rotation). |
| `/voice/webrtc/*` | 4 | WebRTC config / register helpers. **HIGH**. |
| `/voice/media-test/*` | 4 | Synthetic media reachability tests. **MEDIUM**. |
| `/voice/me/*` | 3 | Per-user voice config (e.g. extension lookup for the caller). **HIGH**. |
| `/voice/sbc-test/*` | 2 | SBC reachability. **MEDIUM**. |
| `/voice/recording/*` | 2 | Recording fetch / metadata. **HIGH** — touches CDR-linked storage. |
| `/voice/pbx/*` | 8 | Extra PBX-via-voice helpers. **HIGH**. |
| `/voice/mobile-provisioning/*` | 2 | Mobile app provisioning helpers. **HIGH**. |
| `/voice/calls/*` | 1 | Per-user call list helpers. **HIGH**. |
| Other (`/voice/sbc`, `/voice/health`, `/voice/effective-config`, `/voice/media-metrics`, `/voice/provisioning`, `/voice/pending-jobs`) | 6 | Mixed. |

**Auth requirements:** JWT; admin role for IVR/MOH publish, TURN issuance, mobile-provisioning.
**Risk:** **HIGH → EXTREME** depending on sub-prefix.

> When investigating a `/voice/ivr/*` or `/voice/moh/*` bug, **always** load
> `docs/ai-context/ASTDB_KEYS.md` first. Those endpoints are writers into
> the AstDB key family `connect/t_<slug>` and any change must preserve key
> shape and the snapshot-then-write contract.

### `/voice/moh/extension-overrides/*` — per-extension MOH overrides (Phase 2, 2026-05-11; consumed by publish in Phase 3A, 2026-05-11)

**Approx lines:** ~20449–20591 in `apps/api/src/server.ts` (between `DELETE /voice/moh/profiles/:id` and `PUT /voice/moh/schedule`).
**Purpose:** CRUD for `MohExtensionOverride` rows that drive the AstDB key family `connect/t_<slug>/extensions/<ext>/{moh_class,active_moh_class}`. **The CRUD routes themselves remain DB-only** — they do **NOT** call `publishMohToAstDb`. **Phase 3A** wires the next call to `POST /voice/moh/publish` to read every enabled override and append the per-extension keys to the AstDB write; the dialplan resolver that actually reads them lands in Phase 3B.
**Auth requirements:**
- `GET` — `canViewCustomers` (any tenant-staff JWT).
- `PUT` / `DELETE` — `canManageMoh` (`SUPER_ADMIN` | `ADMIN`); non-super-admin can only target own tenant (mirrors `/voice/moh/profiles`).
**Risk:** **MEDIUM** — CRUD writes do not touch AstDB, but a subsequent `POST /voice/moh/publish` will. Becomes **HIGH** when the Phase 3B resolver starts honouring the keys on live calls.

**Endpoints:**

| Method | Path | Notes |
|---|---|---|
| `GET` | `/voice/moh/extension-overrides?tenantId=…` | Returns `{ overrides: [...] }` ordered by `extension` ASC. Includes both enabled and disabled rows so the portal can render the toggle. Disabled rows do **not** leak into the publish path (`readEnabledExtensionOverridesForTenant` filters them). |
| `PUT` | `/voice/moh/extension-overrides` | Body: `{ tenantId, extension, vitalPbxMohClassName, mohProfileId?, enabled? }`. Idempotent upsert keyed on `(tenantId, extension)`. **`201`** on create, **`200`** on update. Body returns `{ override, enabled, created }`. |
| `DELETE` | `/voice/moh/extension-overrides` | Body: `{ tenantId, extension }`. Idempotent — returns `{ ok: true, deleted: 0 \| 1 }`. |

**Error codes:**

| HTTP | `error` | When |
|---|---|---|
| 400 | `invalid_payload` | Zod validation fail or extension contains chars not allowed in an AstDB key segment (allowed: `A-Z a-z 0-9 _ -`, max 32). |
| 400 | `tenant_not_linked` | `vpbx:<slug>` could not be resolved to a Connect tenant. |
| 400 | `tenantId required` | Super-admin `GET` with no `tenantId` query and no JWT tenant. |
| 400 | `profile_not_in_tenant` | `mohProfileId` was supplied but the profile belongs to a different tenant. |
| 403 | `forbidden` | Non-super-admin tried to manage another tenant. |
| 404 | `extension_not_found` | No `Extension` row matches `(tenantId, extNumber)`, or the matched row has `status === "DELETED"`. ACTIVE and SUSPENDED both pass. |
| 400 / 409 | `invalid_moh_runtime_class` / `connect_asset_not_pbx_ready` / `connect_asset_not_in_sync_manifest` / `moh_runtime_class_not_synced` | Same readiness pipeline as `POST /voice/moh/profiles` (`assertMohRuntimeReadiness`). Failure body includes `detail` and `readiness`. |

**Helpers (testable in isolation):** `apps/api/src/mohExtensionOverride.ts` exports `listExtensionOverridesForTenant`, `upsertExtensionOverride`, `deleteExtensionOverrideForTenant`, `assertExtensionExistsForTenant`, `canManageExtensionOverrideFor`, the Phase-1 key builders, and the Phase-3A publish helpers `readEnabledExtensionOverridesForTenant`, `buildExtensionOverrideSnapshot`, `buildExtensionOverrideKeys`, `extractExtensionSnapshotFromKeys`, `computeExtensionKeysClearForRollback`. Test coverage: `apps/api/src/mohExtensionOverride.test.ts` (41 tests including cross-tenant isolation, missing extension, soft-delete behaviour, role gating, disabled-row leak guard, key-build/extract round-trip, and rollback tombstone semantics).

**Phase 3A publish wiring:** When `POST /voice/moh/publish` runs `doMohPublish`, it now also calls `readEnabledExtensionOverridesForTenant`, builds the per-extension key list, and appends it to `keysWritten` + the AstDB write payload. The same publish persists `MohPublishRecord.extensionOverridesSnapshot` and surfaces evidence on `nativeSync` (`extensionOverrideCount`, `extensionOverrideExtensions`, `extensionOverrideKeysPublished`). The rollback handler additionally writes empty-string tombstones for keys that the rolled-back publish ADDED relative to its own `previousKeysSnapshot` and reports `extensionOverrideKeysCleared` on `nativeSync` and the response body. **Asterisk does not consume these keys yet** — that arrives in Phase 3B.

### `POST /voice/moh/publish` — error codes (added 2026-05)

Successful response is unchanged: `{ ok, mohClass, mode, slug, recordId, profile, nativeSync }`.
Failure responses now distinguish readiness vs runtime failures and always include `detail`:

| HTTP | `error` | When | Body fields |
|---|---|---|---|
| 400 | `invalid_moh_runtime_class` | Class is not `mohN` or `connect_<slug>_<name>` (path traversal / bad chars). | `error`, `detail`, `readiness` |
| 409 | `connect_asset_not_pbx_ready` | Selected `connect_*` class but the matching `MohAsset` is missing or has `status!=ready` / `conversionStatus!=ready` / no `pbxStorageKey` / unsafe `pbxFormat`. | `error`, `detail`, `readiness` |
| 409 | `connect_asset_not_in_sync_manifest` | Asset is "PBX-ready" but no row matches the `/voice/moh/sync-manifest` filter (`endsWith(".wav")`, `pbxStorageKey` set). | `error`, `detail`, `readiness` |
| 409 | `moh_runtime_class_not_synced` | Selected `mohN` is not in the synced `PbxMohClass` catalog. | `error`, `detail` |
| 409 | `no_schedule_configured` / `no_hold_profile_resolved` | Tenant has no schedule config / no profile resolves at this time. | `error`, `detail` |
| 502 | `native_tenant_moh_sync_failed` | AstDB write succeeded but the PBX route helper failed (`mohN` only). | `error`, `detail`, `nativeSync` |
| 503 | `publish_failed` | Telephony service unreachable or other unexpected error. | `error`, `detail` |

`readiness` (when present) is the same `MohRuntimeReadiness` shape stored on
`MohPublishRecord.nativeSync`:

```json
{
  "selectedClass": "connect_acme_jazz",
  "classKind": "connect",
  "assetReady": false,
  "pbxStorageKey": null,
  "pbxFormat": null,
  "manifestFileCount": 0,
  "pbxGroupId": null,
  "reason": "connect_asset_not_pbx_ready"
}
```

On **success**, `MohPublishRecord.nativeSync` (returned in the publish
response and persisted) carries publish-time breadcrumbs:

```json
{
  "skipped": false,
  "selectedClass": "connect_acme_jazz",
  "assetReady": true,
  "manifestFileCount": 1,
  "canonicalSlug": "acme",
  "coverage": {
    "connectManagedInbound": true,
    "nativePbxInboundExtensionsQueues": false
  },
  "...": "raw helper response fields preserved"
}
```

`coverage.nativePbxInboundExtensionsQueues` is **always false** for
`connect_*` classes — they do not write `music_group_id` columns. UI clients
should surface this so operators know native VitalPBX extensions/queues
will keep playing `mohN`.

---

## Voicemail (top-level)

**Approx lines:** 14512 – 14767
**Purpose:** mailbox listing, greeting upload/download, voicemail playback. Distinct from `/voice/voicemail/*` admin endpoints.
**Auth requirements:** JWT.
**Risk:** **HIGH** — touches recordings and audio assets per-tenant.
**Playback:** `GET /voice/voicemail/:id/stream` and `GET /voice/voicemail/:id/download` (`apps/api/src/server.ts`,
`streamVoicemailAudio`) — VitalPBX **`pbxRecfile`** / REST first; **Phase 2** may call on-PBX **`POST /voicemail/spool/audio`**
and log **`helper_audio_fallback: true`** (`TELEPHONY.md`).

---

## Customers / Contacts / Automation

**Approx lines:** 22476 – 23339
**Purpose:** CRM-style contact and customer CRUD, tags, addresses, tasks, notes; automation rules.
**Auth requirements:** JWT.
**Risk:** **MEDIUM** — standard CRUD, but tenant scope is critical.
**Key endpoints (representative):**
- `Contacts` 9 routes (22476–22687)
- `Customers` 16 routes incl. tasks/notes/tags (22700–23339)
- `Automation` 3 routes (23228–23259)

---

## CRM Module (`/crm/*`) — Phases 1A–2D

All routes registered via `registerCrmRoutes(app)` in `server.ts`.
**Auth:** JWT + CRM access guard (`requireCrmAccess` / `requireCrmAdmin`).
**Risk:** **MEDIUM** — CRM-only data, no telephony coupling except CDR hook.
**Source files:** `apps/api/src/crm/`

### Settings & Access (Phase 1A)
| Method | Path | Guard | Notes |
|--------|------|-------|-------|
| GET | `/crm/settings` | any CRM user | Returns `CrmTenantSettings` including `defaultQueueSort` and `defaultQueueFilter` (Phase 12C) |
| PUT | `/crm/settings` | admin | Update CRM settings. Body fields: `enabled`, `localPresenceEnabled`, `transcriptionEnabled`, `defaultQueueSort: SMART\|ORIGINAL`, `defaultQueueFilter: PENDING\|DUE\|OVERDUE\|UPCOMING` |
| GET | `/crm/users/:userId` | admin | User's CRM access record |
| PUT | `/crm/users/:userId` | admin | Enable/set role (AGENT/MANAGER/ADMIN) |

### Contacts (Phase 1B)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/crm/contacts` | List CRM contacts with filters (stage, assignedToMe, search, page/limit) |
| POST | `/crm/contacts` | Create contact + CrmContactMeta |
| GET | `/crm/contacts/stats` | Counts: total, leads, mine, recentlyAdded |
| GET | `/crm/contacts/lookup?phone=` | Phone search. Returns `openTasksCount` + `nextDueTask` per result. Used by screen pop. |
| GET | `/crm/contacts/:id` | Full contact with phones, emails, crmMeta. Includes `lastDisposition`, `lastDispositionAt`. |
| PATCH | `/crm/contacts/:id` | Update contact fields + CRM stage. Writes `STAGE_CHANGED` only if stage changes. Writes `ASSIGNED_TO_USER` (non-blocking, fire-and-forget) only if `assignedToUserId` changes individually — **not** written for bulk reassign. |
| POST | `/crm/contacts/:id/disposition` | **Phase 2D** — save call outcome. Body: `{ disposition, note?, linkedId?, followUpAt?, nextStage?, memberId? }`. Updates `CrmContactMeta.lastDisposition/lastDispositionAt/lastActivityAt`, optionally creates note + task, writes non-blocking timeline events. **Phase 3C:** if `memberId` is provided and disposition contains "callback" and `followUpAt` is set, non-blocking updates `CrmCampaignMember.callbackAt`+`callbackNote`. |

### Timeline & Notes (Phase 1C — fixed Phase 5C)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/crm/contacts/:id/timeline` | All events, newest-first, max 200. Returns `{ contactId, events[] }` where each event has `id, type, title, body, metadata, linkedId, createdAt, createdBy`. **Phase 5C fix:** removed Phase 1B placeholder from `contactRoutes.ts`; real query in `timelineRoutes.ts` now serves all requests. |
| POST | `/crm/contacts/:id/notes` | Create note + `NOTE_ADDED` event |
| PATCH | `/crm/contacts/:id/notes/:noteId` | Edit note body/pin; writes `NOTE_EDITED` |
| DELETE | `/crm/contacts/:id/notes/:noteId` | Soft-delete note |

### SMS from Contact (Phase 11A)
| Method | Path | Notes |
|--------|------|-------|
| POST | `/crm/contacts/:id/sms` | **Phase 11A** — Send a real SMS to a CRM contact. Body: `{ message: string, phone?: string }`. Resolves tenant SMS provider (Twilio or VoIP.ms) via `ProviderCredential`. Checks `CrmContactMeta.doNotSms` (→ 400 `do_not_sms`). Checks contact has a phone (→ 400 `no_phone`). Sends via provider; on success writes `SMS_SENT` `CrmTimelineEvent` with `metadata: { to, from, provider, providerMessageId }`. Returns `{ ok, to, from, provider, providerMessageId }`. Errors: 404 contact not found, 503 `sms_not_configured` (no credentials), 502 `sms_send_failed` (provider error). File: `apps/api/src/crm/smsRoutes.ts`. |

### Tasks (Phase 1D)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/crm/tasks/stats` | Dashboard counts: `{ myOpen, dueToday, overdue, callsLinkedToday, dispositionsToday }` |
| GET | `/crm/tasks` | Global tasks list with filters |
| POST | `/crm/contacts/:id/tasks` | Create task + `TASK_CREATED` event |
| GET | `/crm/contacts/:id/tasks` | Contact tasks (filter: status, limit) |
| PATCH | `/crm/contacts/:id/tasks/:taskId` | Update task; status transitions write `TASK_COMPLETED`/`TASK_CANCELED` |
| DELETE | `/crm/contacts/:id/tasks/:taskId` | Delete task |

### Contact Phone & Email Management (Phase 5B)
| Method | Path | Notes |
|--------|------|-------|
| POST | `/crm/contacts/:id/phones` | Add a phone to a contact. Body: `{ numberRaw, type?, isPrimary? }`. Deduplicates by normalised number (`contactId_numberNormalized` unique index). Returns 409 on duplicate. If `isPrimary=true`, clears existing primary first. Returns updated full contact. |
| DELETE | `/crm/contacts/:id/phones/:phoneId` | Remove a specific phone. Tenant-scoped. Returns `{ ok: true }`. |
| POST | `/crm/contacts/:id/emails` | Add an email. Body: `{ email, type?, isPrimary? }`. Deduplicates by lowercased email. Returns 409 on duplicate. Returns updated full contact. |
| DELETE | `/crm/contacts/:id/emails/:emailId` | Remove a specific email. Tenant-scoped. Returns `{ ok: true }`. |

### Bulk Contact Reassign (Phase 5B)
| Method | Path | Notes |
|--------|------|-------|
| POST | `/crm/contacts/bulk-reassign` | **Admin only.** Body: `{ contactIds: string[], assignedToUserId: string \| null }`. Updates `CrmContactMeta.assignedToUserId` for all matching contacts in the tenant. Max 500 IDs per call. `null` clears assignment. Returns `{ ok, updated }`. No timeline events written (bulk action). |

### Contact Duplicate Detection & Merge (Phase 5A)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/crm/contacts/:id/duplicates` | Suggests potential duplicate contacts matching by shared normalised phone, email, or exact display name. Returns up to 5 results with `matchReasons[]`. Any CRM user can view; merging is admin-only. |
| POST | `/crm/contacts/merge` | **Admin only.** Body: `{ keepContactId, mergeContactId }`. Both must be active and in the same tenant. Moves CrmTimelineEvent, CrmContactNote, CrmContactTask, CrmChecklistResponse, CrmCampaignMember (skips campaign conflicts), unique phones/emails to `keepContact`. Archives `mergeContact` (`active=false, archivedAt=now`). Writes `CONTACT_MERGED` timeline event on `keepContact`. Returns `{ ok, phonesAdded, emailsAdded, campaignMembersMoved, campaignMembersSkipped }`. |

### Import (Phase 1E)
| Method | Path | Notes |
|--------|------|-------|
| POST | `/crm/import/upload` | CSV upload (`multipart/form-data`, field `file`). Uses shared `importPipeline` (parse, header auto-map, dedupe by phone/email, create/update `Contact` + `CrmContactMeta`). Max 5 MB, 5,000 rows. Returns `CrmImportBatch` summary. |
| GET | `/crm/import/batches` | List batches |
| GET | `/crm/import/batches/:id` | Single batch detail |

### Scripts (Phase 2C)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/crm/scripts` | List active scripts (`includeInactive=true` for archived) |
| GET | `/crm/scripts/:id` | Single script with full body |
| POST | `/crm/scripts` | Create (admin); requires `name` + `body` |
| PATCH | `/crm/scripts/:id` | Update name/body/isActive (admin) |
| DELETE | `/crm/scripts/:id` | Archive — sets `isActive=false` (admin) |

### Checklists (Phase 2C)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/crm/checklists` | List active checklists with items |
| GET | `/crm/checklists/:id` | Single checklist with items |
| POST | `/crm/checklists` | Create + items (admin) |
| PATCH | `/crm/checklists/:id` | Update; `items` array replaces all items atomically (admin) |
| DELETE | `/crm/checklists/:id` | Archive (admin) |
| POST | `/crm/checklists/:id/respond` | Save `CrmChecklistResponse`. Body: `{ contactId, linkedId?, answers }`. Writes `CHECKLIST_COMPLETED` event. |

**CDR hook (Phase 2A):** `POST /internal/cdr-ingest` calls `fireCrmCdrHook()` (no await) after `ConnectCdr` upsert. Writes `CDR_INBOUND`/`CDR_OUTBOUND` timeline events for CRM-enrolled contacts matched by phone.

**Campaign routes (Phase 3A):** `apps/api/src/crm/campaignRoutes.ts`

| Method | Path | Notes |
|--------|------|-------|
| GET | `/crm/campaigns` | List campaigns (default: exclude ARCHIVED). Filter: `?status=`. Each campaign includes `priority`. |
| POST | `/crm/campaigns` | Create campaign (admin). Body: `{ name, description?, status?, priority?: LOW\|NORMAL\|HIGH\|URGENT, scriptId?, checklistId? }`. Defaults `priority=NORMAL`. |
| GET | `/crm/campaigns/:id` | Campaign detail + statusCounts per member status. Includes `priority`. |
| PATCH | `/crm/campaigns/:id` | Update name/description/status/priority/scriptId/checklistId (admin) |
| DELETE | `/crm/campaigns/:id` | Archive campaign (sets status=ARCHIVED, admin) |
| POST | `/crm/campaigns/:id/members/add` | Add contacts (by contactId array). Skips duplicates. Only CRM-enrolled contacts. (admin) |
| POST | `/crm/campaigns/:id/import` | **Multipart** `file` (CSV) + optional text field `assignedToUserId`. Same limits and column auto-mapping as `POST /crm/import/upload` (shared `importPipeline` — dedupe by phone/email, no duplicate contacts). Creates/updates contacts + CRM meta, then adds `CrmCampaignMember` rows; skips contacts already in the campaign. Optional assignee must be a tenant user with CRM access enabled. Returns `batchId`, `createdContacts`, `updatedContacts`, `skippedRows`, `addedMembers`, `skippedExistingMembers`, `errors`, etc. Admin only. |
| GET | `/crm/campaigns/:id/members` | List members with contact details. Filters: `?status=`, `?assignedToMe=true`, `?assignedToUserId=<id>` (validates userId is in tenant), `?unassigned=true`. All filters combine with `?page=` / `?limit=`. |
| GET | `/crm/campaigns/:id/workload` | Per-agent assignment summary. Returns `{ workload: [{ userId, displayName, pending, inProgress, callbacks, contacted, converted, skipped, dnc, total }] }`. Includes an Unassigned row. Admin only. |
| POST | `/crm/campaigns/:id/members/distribute` | Round-robin distribute all unassigned PENDING/IN_PROGRESS members across provided agents. Body: `{ userIds: string[] }` (1–50 users). Validates userIds belong to tenant. Returns `{ distributed, assignments: [{ userId, count }] }`. Admin only. Explicit manager action only — never automatic. |
| PATCH | `/crm/campaigns/:id/members/:memberId` | Update member status/assignment/sortOrder/attemptCount/callbackAt/callbackNote (Phase 3C: adds callbackAt+callbackNote) |
| GET | `/crm/queue` | My Queue with filter + sort + campaign scope. `?filter=pending\|due\|overdue\|upcoming`. `?sort=smart\|original`. `?campaignId=<id>` — scope queue to one active campaign (must belong to tenant; returns 404 if not found; cross-tenant blocked). `?sort=smart` — composite-score ranking (callbacks first, then lead tiers with campaign priority offset). Candidate cap 500, ranked in-process. Each member includes `campaign.priority`. Tab counts (pending/due/overdue/upcoming) also respect the campaignId filter. Returns `{ queue, total, sort, campaignId, counts }`. |
| POST | `/crm/queue/next` | Fetch next PENDING item and set it to IN_PROGRESS |
| PATCH | `/crm/queue/:memberId` | Queue action. `action`: `skip`, `defer`, `dnc`, `outcome` (maps disposition→status, increments attemptCount), `assign-to-me` (sets assignedToUserId=currentUser), `set-callback` (sets status=CALLBACK, callbackAt, callbackNote), `clear-callback` (sets callbackAt=null, callbackNote=null, status=PENDING). Body also accepts `callbackAt?`, `callbackNote?` alongside explicit `status`. |
| POST | `/crm/campaigns/:id/members/bulk-assign` | Bulk-assign (or clear) selected members to a user. Body: `{ memberIds: string[], assignedToUserId: string\|null }`. Returns `{ updated: number }`. Admin only. |
| GET | `/crm/campaigns/:id/contacts/available` | Search CRM contacts NOT already in campaign. Params: `?q=`, `?limit=`, `?page=`. Returns paginated contacts. Admin only. |
| GET | `/crm/campaigns/:id/export.csv` | Export all campaign members as CSV download. Columns: Name, Phone, Email, Company, Stage, Status, Assigned To, Attempts, Last Attempt, Last Disposition. |

**Guard errors:** `crm_not_enabled` (403), `crm_user_not_enabled` (403), `crm_permission_denied` (403), `contact_not_in_crm` (400 for disposition on non-enrolled contact).

### CRM Reports _(Phase 4A)_

All report endpoints require `requireCrmAccess` (not admin-only). Tenant-isolated. No pagination on aggregate endpoints; detail rows are capped at 100.

| Method | Path | Description |
|---|---|---|
| GET | `/crm/reports/daily` | Tenant-wide today snapshot: `dispositionsToday`, `callsLinkedToday`, `contactsCreatedToday`, `tasksDueToday`, `overdueTasks`, `callbacksDueToday`, `overdueCallbacks`, `activeCampaigns`, `queueRemaining`. Always "today" — no date range parameter. |
| GET | `/crm/reports/campaigns` | Per-campaign performance. `?status=all\|ACTIVE\|PAUSED\|COMPLETED` (default: all non-archived). Returns array: `{ id, name, status, total, pending, contacted, callbacks, converted, dnc, conversionRate, totalAttempts, lastActivityAt }`. Uses a single `groupBy` query for member counts. Cap 200 campaigns. |
| GET | `/crm/reports/agents` | Per-agent activity summary. `?days=1\|7\|30` (default 30, max 90). Returns `{ agents: [...], lookbackDays }` where each agent has: `assignedQueue`, `callbacksDueToday`, `dispositionsToday`, `convertedLast` (in lookback window), `openTasks`. Uses `groupBy` — no per-user loops. Only CRM-enabled users included. |
| GET | `/crm/reports/follow-ups` | Bucketed follow-up health. Returns `{ callbacks: { overdue, dueToday, dueThisWeek }, tasks: { overdue, dueToday } }`. Each bucket has `{ count, rows[] }` with contact name/phone, assignedTo, campaign, due time. Rows capped at 100 per bucket. |

---

## Calls / Forensic / Internal

**Approx lines:** 20731 – 21556 (scattered)
**Purpose:** live calls list / per-call detail, forensic snapshots, internal-only deploy + CDR-ingest endpoints.
**Auth requirements:** JWT for `/calls/*`; admin JWT for `/forensic/*`; `/internal/*` is **blocked at nginx** + secret-header (see AGENTS.md and `docs/safe-deploy-queue.md`).
**Risk:**
- `/calls/*` — **HIGH** (reads `connectCdr` and live state)
- `/forensic/*` — **HIGH** (full PBX snapshot capture)
- `/internal/*` — **EXTREME** (deploy enqueue + CDR ingest; mis-call breaks deploys or pollutes CDR)
**Key endpoints:**
- `GET /calls/...` (20843), `…/:id` (21517)
- `GET /forensic/snapshot` (21556)
- `/internal/deploy/auto`, `/internal/cdr-ingest`, etc. (20731 onward — grep for full list)
- `POST /internal/voicemail-notify` — telephony → api (CDR secret). Body: `mailbox`,
  `context` (AMI voicemail context), `newCount` (AMI “new” count). Tries VitalPBX REST
  first; if **no rows** and `newCount > 0`, calls PBX helper `POST /voicemail/spool/list`
  when `PBX_ROUTE_HELPER_*` is configured. Response may include `rest_count`,
  `helper_count`, `source_used`, `fallback_reason`. If the helper binary is still
  **pre-`2026.05.08.1`**, expect `fallback_reason` such as `helper_error:not_found` (no
  spool route) until the PBX installer is upgraded (`TELEPHONY.md`, `DEPLOYMENT.md`).

**Super-admin voicemail ingest incidents (in `server.ts`):** `GET /admin/voicemail-ingest/incidents` (list + cursor), `GET /admin/voicemail-ingest/incidents/:id` (detail), `POST /admin/voicemail-ingest/incidents/:id/ack` (acknowledge). **Super-admin JWT only.** Open rows are also merged into **`GET /admin/ops-center`** and **`GET /admin/incidents`** for ops visibility. Feature flag: **`VOICEMAIL_INGEST_INCIDENTS_ENABLED`** (default true on **api** + **worker**).

**On-PBX helper (not in `server.ts`):** `POST /voicemail/spool/list` — HMAC header
`x-connect-pbx-helper-secret` (must match **`CONNECT_PBX_HELPER_SECRET`** on the PBX and
**`PBX_ROUTE_HELPER_SECRET`** in Connect); JSON body `tenantId`, `extension`, optional `voicemailContext`
/ `context`. Read-only; lists `msg*.txt` under `INBOX` / `Old` / `Urgent`. **`POST /voicemail/spool/audio`**
(helper **`2026.05.08.2`+`): same HMAC; JSON **`tenantId`**, **`extension`**, **`folder`** (`INBOX` \| `Old` \| `Urgent`),
**`msgNum`** (`^msg[0-9]+$`), optional **`voicemailContext`**. Returns **raw audio** (**`audio/wav`**) on **200**;
**400** / **404** JSON for validation / missing file — **server-to-server only**; never exposed to mobile/portal.
Connect **api** calls this from **`streamVoicemailAudio`** after VitalPBX **`pbxRecfile`** / REST fails (`TELEPHONY.md`).
Installed by
`scripts/pbx/install-vitalpbx-inbound-route-helper.sh` (**pinned commit** **`cf4a1f61c9064144c6d9c54b8ac2570ba6cf3067`** — run the script; **do not** hand-edit helper Python on the PBX). **`/spool/list` 404** = helper older than **`2026.05.08.1`**;
**`/spool/audio` 404** = route missing (helper pre-**`2026.05.08.2`**);
**401** = wrong secret (**`CONNECT_PBX_HELPER_SECRET`** on PBX ≠ **`PBX_ROUTE_HELPER_SECRET`** on Connect);
can occur even when **`GET /health`** returns **`2026.05.08.1`** from the app host. **Preferred fix:** PBX env
follows Connect (**no** queue recycle); **alternate:** update Connect **`.env.platform`** + queue **api**/**worker**
(`DEPLOYMENT.md` § **helper secret alignment only**). If **401** persists after an edit, see **`DEPLOYMENT.md`**
§ **Troubleshooting: still 401** and § **Secret mismatch fingerprints** — **`/internal/voicemail-notify`** logs
**`helper_error:unauthorized`** the same way as manual app-host **`curl`**. After alignment, manual **`POST`** from
the app host returns **200** with **`ok: true`** (see **`DEPLOYMENT.md`** recorded verification); **worker** logs
may show **`source_used":"helper"`** on **`voicemail-sync-cycle`**.
**Connection refused** from the Connect app host (while PBX loopback `/health` works) = helper bind / firewall — see **`DEPLOYMENT.md`** § **listen bind** (**`CONNECT_PBX_HELPER_BIND`** = address only, **`CONNECT_PBX_HELPER_PORT=8757`**; not Python edits). Restrict **:8757** to the app host.
End-to-end checklist: **`DEPLOYMENT.md`** § **Phase 1 — production verification (A–G)**.
Operator copy/paste (PBX install pin, secret rotation, deploy queue): **`DEPLOYMENT.md`** § **Phase 1 — operator handoff**; Phase 2 helper **`2026.05.08.2`** on **`209.145.60.79`**: **`DEPLOYMENT.md`** § **Phase 2 — operator handoff** and **Recorded Phase 2 — helper `2026.05.08.2` live** (production verification). **Proof format:** **`DEPLOYMENT.md`** Phase 1 **operator execution transcript** (HTTP status, `ok`, counts, deploy job IDs, **no** secrets). Upgrading **`2026.05.07.x` → `2026.05.08.1`** adds **`POST /voicemail/spool/list`**; **`2026.05.08.2`** also adds **`POST /voicemail/spool/audio`** for api playback fallback. Aligned **`x-connect-pbx-helper-secret`** is required for all helper POSTs. IDE agents cannot typically reach PBX SSH or app-host **`:3910`** — **`DEPLOYMENT.md`** § **execution environment**.

---

## Billing (top-level inline + delegated routes)

**Approx lines:** 21595 – 27438 (inline) + delegated under `apps/api/src/billing/routes.ts` (registered at line ~30198)
**Purpose:** invoices, payment methods, billing runs, payment events, ledgers, plan management.
**Auth requirements:** JWT + portal permission prefix (see `PORTAL_API_PERMISSION_RULES` in `server.ts`: `/billing` → `can_view_billing_overview`, `/admin/billing` → `can_view_admin_billing`). **`apps/api/src/billing/routes.ts`** adds stricter **DB role** checks: tenant billing handlers allow **`SUPER_ADMIN`, `TENANT_ADMIN`, `ADMIN`, `BILLING_ADMIN`, `BILLING`** (`billingAuth.ts`); **`/admin/billing/*` in that file** requires **`SUPER_ADMIN`** only. Webhook routes use signature verification (no JWT).
**Risk:** **EXTREME** — touches `BillingInvoice`, `PaymentTransaction`, `PaymentEvent`, ledgers. Mis-firing a billing route can charge or refund real money.
**Key endpoints:** 22 inline + many more in `billing/routes.ts`. Tenant **`POST /billing/platform/invoices/:id/email-payment-link`** queues **`BILLING_PAYMENT_LINK`**; tenant **`POST /billing/platform/invoices/:id/email-invoice`** queues **`BILLING_INVOICE_READY`** (same template family as admin resend). Tenant **`PUT /billing/settings/branding`** updates invoice/email presentation (`invoiceCompanyName`, https-only `invoiceLogoUrl`, support contacts, footer, payment instructions). Admin **`PUT /admin/billing/tenants/:tenantId/settings`** accepts the same optional presentation keys merged with pricing. Admin **`GET /admin/billing/overview`** includes **`recentFailures`**. Admin **`GET /admin/billing/runs/recent?limit=5`** lists latest **`BillingRun`** rows (declare before **`GET /admin/billing/runs/:id`**). Admin **`GET /admin/billing/invoices/:id/events`** returns **`BillingEventLog`** rows (read-only). Always read `apps/api/src/billing/routes.ts` directly when working in this area.

### SOLA / Cardknox (`POST /webhooks/sola-cardknox`)

Form/key-value webhook (also accepts JSON-shaped bodies when parsed). Platform **`BillingInvoice`** updates go through **`applySolaWebhookToBillingInvoice`** (`solaBillingPayments.ts`) with **`ck-signature` first**, then Sola HMAC where configured. **`400`** `missing_event_id` when correlation id is missing; **`403`** `invalid_signature` on verification failure. Correlation: **`CONNECT:…` `xInvoice`** (see `BILLING.md`). Full behavior: **`docs/ai-context/BILLING.md`** § SOLA / Cardknox.

---

## Dashboard / Search

**Approx lines:** 25764 – 27007
**Purpose:** dashboard KPIs, search.
**Auth requirements:** JWT.
**Risk:** **MEDIUM** — but KPI sources are sensitive (see `docs/DASHBOARD_KPI_SOURCE.md`).

---

## Webhooks (non-Twilio-SMS)

**Approx lines:** 6878, 27709 (and elsewhere)
**Purpose:** carrier / provider webhooks. Signature-verified.
**Auth requirements:** signature header (no JWT).
**Risk:** **HIGH** — external callers; any auth bypass leaks tenant state.

---

## Delegated route bundles

These are registered near the **end** of `server.ts` (lines 30198–30265):

### `registerBillingRoutes(app)` — `apps/api/src/billing/routes.ts`
**Risk:** **EXTREME** — payment processor integrations, invoice generation, retries.
**Action:** When a billing change is requested, **load `billing/routes.ts` directly** instead of the slice of `server.ts`.

### `registerPlatformRolePermissionRoutes(app)`
**Risk:** **HIGH** — RBAC graph + role/permission snapshots.

### `registerUserExtensionProvisioningRoutes(app, …)` — `apps/api/src/userExtensionProvisioning.ts`
**Risk:** **HIGH** — provisions PJSIP extensions for a user; touches PBX.

### `registerConnectChatRoutes(app, { smsQueue, sendPushToUserDevices })` — `apps/api/src/connectChatRoutes.ts`
**Size:** 1,762 lines (a top-10 hotspot in its own right).
**Risk:** **HIGH** — chat threads + attachments + reactions + push fan-out.

---

## Reading rules (cost-saving)

1. **Never load all of `server.ts`** at once — that is ~1.3 MB of source.
2. Use the table above to find the line range, then `Read` with `offset`/`limit` to load **±50 lines** around the registration site.
3. For grouped feature work (e.g. anything `/billing/*`), load the dedicated file (`billing/routes.ts`) instead.
4. If the prefix is missing from the table, grep first:
   `Select-String -Path "apps\api\src\server.ts" -Pattern '"/<prefix>/'`
5. Any change to a row marked **EXTREME** requires reading `RULES.md` and the relevant subsystem doc (`TELEPHONY.md`, `ASTDB_KEYS.md`, or the billing equivalent) **before** editing.
