### Calls — Call History (tenant-scoped)

- `GET /calls/history` supports tenant-wide scope for users holding the custom-role permission `can_view_tenant_call_history`. Without it, non–super-admin users are restricted to their own extension activity. Tenant isolation is always enforced.

### Call Recordings (tenant-scoped)

- `GET /voice/recording/:linkedId/(stream|download)` enforces the same scope as call history. Users with `can_view_tenant_call_recordings` may access recordings for any call in their tenant; others are limited to calls involving their owned extension. SUPER_ADMIN behavior unchanged.

### Chat (tenant-scoped view)

- `GET /chat/threads` and `GET /chat/threads/:threadId/messages` allow tenant-wide read-only viewing when the user holds `can_view_tenant_chats`. Without it, users only see threads they participate in. Sending/moderation permissions are unchanged.

Chat route notes (2026-05-24):

- `GET /chat/threads`
  - Cheap self-heal ensures the tenant default group exists and the current user is a member. No per-request full-tenant upsert.
  - Unread counts are aggregated in one query per list, not per-thread (avoids N+1 counting on mobile/thread list).
- `GET /chat/threads/:threadId/messages` supports pagination and deltas without changing the default behavior:
  - Default: oldest-first, up to 200 rows (unchanged).
  - Query params:
    - `?before=<ISO>`: fetch older messages strictly before timestamp; returns newest-first internally, normalized to oldest-first in the response (client receives chronological order).
    - `?after=<ISO>`: fetch messages strictly after timestamp; oldest-first.
    - `?since=<ISO>`: alias for `after` when `after` is not supplied (useful for delta polling).
    - `?limit=<1..200>`: max rows (cap 200).
  - Soft-deleted-for-user rows are filtered out server-side.

#### WhatsApp — API roadmap (docs-only)
- Unification (Option A)
  - No new `/whatsapp/*` inbox APIs. WhatsApp threads/messages will appear under existing `/chat/threads` and `/chat/threads/:id/messages` once implemented (runtime not changed by this doc).
  - `POST /chat/threads` will accept `type: "whatsapp"` to create/find a WA thread by contact number (normalized) when shipped.
  - `POST /chat/threads/:id/send` dispatches to a WhatsApp adapter when `thread.type === "WHATSAPP"` (server-side only; clients call the same unified send route).
- Provider settings/webhooks (unchanged paths)
  - Keep `/settings/providers/whatsapp/*` for tenant credential/config management (masked responses, encrypted at rest).
  - Keep `/webhooks/whatsapp/*` (Meta verify, inbound messages/status updates). Webhooks project payloads into unified chat models; legacy WA tables may be dual-written during migration only.
  - PR1 safety defaults:
    - `WHATSAPP_META_VERIFY_SIGNATURE=required` (Meta POST uses route-scoped raw body; 403 on invalid)
    - `WHATSAPP_TWILIO_VERIFY_SIGNATURE=required` (403 on invalid)
    - Enqueue is off by default: `WHATSAPP_WEBHOOK_ENQUEUE_ENABLED=false` (legacy behavior unchanged until enabled)
    - Workers in PR1 only log sanitized summaries and ack; no projection/media/push yet
- Compliance policy guard
  - Enforce 24‑hour customer‑service window; outside window, free‑form sends return a structured error that instructs the client to use an approved template.
  - Respect tenant opt‑out/block lists; reject sends with explicit error when blocked.
  - Official providers only (Meta Business API, Twilio WhatsApp). No Status/Stories automation.
- Templates (docs-only endpoints to be added when implemented)
  - `GET /whatsapp/templates` — list cached provider templates for the tenant (name, language, category, approval status/rejection reason, variables schema).
  - `POST /whatsapp/templates/sync` — admin-only refresh from provider.
  - Unified send accepts `{ template: { name, language, params } }` and returns clear errors on variable mismatch or unapproved templates.
- Media handling
  - Inbound provider media is downloaded server-side to Connect storage and referenced from chat via signed URLs. Provider media URLs are never surfaced directly to clients.
- Push types
  - Add `wa_message` push payload aligned with existing `dm_message` / `sms_message` semantics (title/body minimal; deeplink to thread).
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

Billing note: `apps/api/src/billing/routes.ts` uses `resolveBillingGatewayConfig()` from
`apps/api/src/billing/solaGateway.ts` for effective Cardknox/SOLA status and live-charge guards
with source precedence (tenant override -> main tenant -> env/global -> missing).

Itemized invoice note: `POST /admin/billing/tenants/:tenantId/invoices` creates Connect-native
`BillingInvoice` rows through `invoiceEngine.ts` and may accept optional JSON
`serviceStartDate`, `serviceEndDate`, `billingMonthCount`, and `prorate`. Recurring totals must
derive from persisted `BillingInvoiceLineItem.amountCents`; avoid creating opaque recurring
manual-adjustment invoices for monthly service balances.

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
- `GET /admin/users/:id/crm-access`, `PUT /admin/users/:id/crm-access` (`apps/api/src/admin/userCrmAccessRoutes.ts`)

### Canonical tenant dropdown source (`GET /admin/tenant-options`)

**Auth:** `canManageUsers` (SUPER_ADMIN / TENANT_ADMIN / ADMIN). End-users never receive this list.
**Placement in `server.ts`:** added after `PATCH /admin/tenants/:id` (near `GET /admin/tenants`).
**Purpose:** Single endpoint powering all admin tenant dropdowns throughout the portal.

**Response shape:**
```json
{
  "options": [
    {
      "id": "connect-cuid",
      "name": "Acme Corp",
      "source": "linked",
      "pbxTenantId": "2",
      "pbxTenantCode": "T2",
      "pbxSlug": "acme_corp"
    },
    {
      "id": "vpbx:new_tenant",
      "name": "New Tenant",
      "source": "pbx",
      "pbxTenantId": "5",
      "pbxTenantCode": "T5",
      "pbxSlug": "new_tenant"
    }
  ]
}
```

**`source` values:**
- `"connect"` — a Connect `Tenant` row with no PBX link.
- `"linked"` — a Connect `Tenant` row linked to VitalPBX via `TenantPbxLink`.
- `"pbx"` — a VitalPBX tenant in `PbxTenantDirectory` with no Connect `Tenant` row yet (id `vpbx:{slug}`).

**Security:** SUPER_ADMIN sees all; non-SUPER_ADMIN sees only their own tenant.

**Cache invalidation:** After `POST /admin/pbx/refresh-tenants` succeeds, `useAppContext.refreshPbxTenants()` dispatches two browser CustomEvents:
- `cc-pbx-tenants-refreshed` — legacy, fired first
- `cc-pbx-sync-complete` — full sync complete (includes extension sync); carries sync summary as `event.detail`

Any component using `useTenantOptions()` (`apps/portal/hooks/useTenantOptions.ts`) automatically refetches on either event.

**Connect-only filter:** Pass `connectOnly: true` to `useTenantOptions()` to see only tenants with real Connect rows (`source: "connect" | "linked"`). Use this when restricting to real tenant rows.

**PBX-only tenants in dropdowns:** By default `useTenantOptions()` (no `connectOnly`) shows PBX-only tenants too. `resolveManagedTenant()` on the API auto-provisions a real `Tenant` + `TenantPbxLink` when a `vpbx:` ID is submitted for a user-creation operation.

**Do NOT use for billing** — billing has its own tenant list at `GET /admin/billing/platform/tenants`.

### Canonical PBX sync pipeline (`POST /admin/pbx/refresh-tenants`)

**Auth:** SUPER_ADMIN only. **Rate-limited:** 30 s per instance.

**What it does (as of 2026-05-26):**
1. `client.listTenants()` → `syncPbxTenantDirectoryFromRows()` → updates `PbxTenantDirectory`.
2. `syncExtensionsFromPbx()` → for all linked tenants (`TenantPbxLink`), fetches extensions from VitalPBX and upserts `Extension` + `PbxExtensionLink` rows.
3. Invalidates `PBX_TENANT_LIST_CACHE` for the instance.

**Response:**
```json
{
  "ok": true,
  "instanceId": "...",
  "pbxTenantCount": 10,
  "directoryCreated": 1,
  "directoryUpdated": 0,
  "directoryDeleted": 0,
  "extensionsFound": 45,
  "extensionsUpserted": 3,
  "extensionsSkippedTenants": 2,
  "extensionErrors": 0,
  "linkedTenants": 8,
  "didSource": "ombutel_mysql",
  "didTenantsProcessed": 8,
  "didNumbersUpserted": 24,
  "didErrors": 0,
  "lastSyncedAt": "2026-05-27T23:00:00.000Z",
  "durationMs": 4800
}
```

Extension sync failure is **non-fatal** — tenant directory sync succeeds even if extensions fail. DID sync failure is also **non-fatal** — `didSource: "skipped"` when MySQL not configured.

**Frontend invalidation sequence after success:**
1. `useAppContext.reloadTenantOptions()` → sidebar `TenantSwitcher` updates.
2. `cc-pbx-tenants-refreshed` event → `useTenantOptions()` refetches `GET /admin/tenant-options`.
3. `cc-pbx-sync-complete` event → all `useTenantOptions()` consumers refetch + `useExtensionOptions()` consumers refetch + PBX Extensions page increments `reloadKey`.

**Structured logs emitted:**
- `pbx_sync_start`
- `tenant_options_refreshed` (counts: created/updated/deleted)
- `extension_sync_complete` (counts: total/upserted/skipped/errors/linkedTenants)
- `did_sync_complete` (source/tenantsProcessed/numbersUpserted/errors/skipReason)
- `pbx_sync_complete` (total durationMs)
- `pbx_sync_tenant_failed` / `extension_sync_failed` / `did_sync_failed` on errors

### Canonical extension options hook (`useExtensionOptions`)

**Portal hook:** `apps/portal/hooks/useExtensionOptions.ts`
**Endpoint:** `GET /admin/users/catalog?tenantId=...&userFacingOnly=...`
**Auto-refetches on:** `cc-pbx-sync-complete` event
**Used by:** `UserModal` in `admin/users/page.tsx`

### PBX DID billing (`PbxTenantInboundDid` → invoice line items)

**Invoice line item type:** `DID` (`BillingLineItemType.DID`)
**Source:** `PbxTenantInboundDid` where `{ connectTenantId: tenantId, active: true }`
**Pricing:** `TenantBillingSettings.pbxDidPriceCents` — defaults to `0` (always shown, no charge). Set per-tenant to bill for DIDs.
**Built in:** `apps/api/src/billing/invoiceEngine.ts` › `buildBillingInvoicePreviewWithLoadedSettings`
**Metadata on line item:** `lineItemKind: "pbx_inbound_dids"`, `e164Numbers: string[]`, `pbxDidCount: number`
**DID sync trigger:** `POST /admin/pbx/refresh-tenants` step 3 (`syncPbxTenantInboundDids`). Only populates when `ombuMysqlUrlEncrypted` is set on the `PbxInstance`.
**Note:** These are separate from `PhoneNumber` (Twilio/VoIP.ms purchased numbers). Both can appear on the same invoice.
**Returns:** `{ extensions, totalExtensions, filteredOut, isLoading, reload }`
**Source:** Connect DB `Extension` table (not live VitalPBX) — always reflects the last sync result.

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
**Tenant-wide permission:** Users with `can_view_tenant_voicemails` may list and access voicemails for all mailboxes within their own tenant. Others remain limited to their owned mailbox extensions. SUPER_ADMIN unchanged.
**Playback:** `GET /voice/voicemail/:id/stream` and `GET /voice/voicemail/:id/download` (`apps/api/src/server.ts`,
`streamVoicemailAudio`) — VitalPBX **`pbxRecfile`** / REST first; **Phase 2** may call on-PBX **`POST /voicemail/spool/audio`**
and log **`helper_audio_fallback: true`** (`TELEPHONY.md`).

**Stream query params:**
- `?token=<JWT>` — auth for clients that cannot set `Authorization` header (e.g. `<audio>` element).
- `?raw=1` — skip ffmpeg transcode; returns original audio (WAV/PCM from PBX) without MP3 conversion.
  Android MediaPlayer handles WAV natively. Used by the mobile preloader
  (`useVoicemailAudioCache`) to download audio ~0.5–2s faster. Non-breaking;
  existing callers without `?raw=1` receive the same transcoded MP3 as before.
  Already-compressed formats (mp3/m4a/aac/ogg) also skip transcode unconditionally.

**Transcode behavior (updated 2026-05-17):**
- `asAttachment=false` (stream): run ffmpeg WAV→MP3 **unless** `?raw=1` or source is already mp3/m4a/aac/ogg.
- `asAttachment=true` (download): never transcodes (unchanged).

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
| GET | `/crm/users` | admin | List all tenant users with CRM access status |
| GET | `/crm/users/:userId` | admin | One user's CRM access + campaign assignments (`assignedCampaignIds`, `campaigns[]`) |
| PUT | `/crm/users/:userId` | admin | Enable/set role; optional `campaignIds[]` (tenant-validated). Disabling clears campaign assignments. |

**Admin Users page (tenant-scoped user management):**

| Method | Path | Guard | Notes |
|--------|------|-------|-------|
| GET | `/admin/users/:id/crm-access` | `canManageUsers` | Read CRM access + tenant campaigns for target user. Tenant admin: same tenant only (`403` cross-tenant). Super admin: any customer user. |
| PUT | `/admin/users/:id/crm-access` | `canManageUsers` | Body: `{ enabled, role?, campaignIds? }`. Upserts `CrmUserAccess`; replaces `CrmUserCampaignAssignment` when enabled. `400 invalid_campaign` for cross-tenant campaign ids. Audits `USER_CRM_ACCESS_UPDATED`. |

### Contacts (Phase 1B)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/crm/contacts` | List CRM contacts with filters (stage, assignedToMe, search, page/limit). **Default** excludes archived (`active=false`). **Phase 16A:** `?includeArchived=true` includes active + archived rows; **CRM admin only** (`403` otherwise). **Phase 16B:** `?includeArchived=true&archivedOnly=true` lists **archived only** (same admin gate); `archivedOnly` without `includeArchived` → `400 invalid_query`. Rows include `active`, `archivedAt`. |
| POST | `/crm/contacts` | Create contact + CrmContactMeta |
| GET | `/crm/contacts/stats` | Counts: total, leads, mine, recentlyAdded (**active, non-archived** contacts only — Phase 16A) |
| GET | `/crm/contacts/lookup?phone=` | Phone search. Returns `openTasksCount` + `nextDueTask` per result. Used by screen pop. Excludes archived contacts. |
| GET | `/crm/contacts/:id` | Full contact with phones, emails, crmMeta. Includes `lastDisposition`, `lastDispositionAt`, `active`, `archivedAt`. **Phase 16A:** platform admins (`ADMIN` / `TENANT_ADMIN` / `SUPER_ADMIN`) may load **archived** contacts; other CRM users get `404` if archived. |
| DELETE | `/crm/contacts/:id` | **Phase 16A — CRM admin only.** Soft-archives: sets `active=false`, `archivedAt=now()`. Does **not** delete phones, timeline, tasks, or campaign members. Idempotent if already archived. Returns `{ ok: true, contactId }`. **Phase 16D:** non-blocking campaign auto-completion is re-run for each campaign this contact was enrolled in (actionable non-terminal counts use live contacts only). |
| POST | `/crm/contacts/:id/restore` | **Phase 16A — CRM admin only.** Sets `active=true`, `archivedAt=null`. Idempotent if already active. Returns `{ ok: true, contactId }`. |
| PATCH | `/crm/contacts/:id` | Update contact fields + CRM stage. **Active contacts only** (archived → 404). Writes `STAGE_CHANGED` only if stage changes. Writes `ASSIGNED_TO_USER` (non-blocking, fire-and-forget) only if `assignedToUserId` changes individually — **not** written for bulk reassign. |
| POST | `/crm/contacts/:id/disposition` | **Phase 2D** — save call outcome. Body: `{ disposition, note?, linkedId?, followUpAt?, nextStage?, memberId? }`. Updates `CrmContactMeta.lastDisposition/lastDispositionAt/lastActivityAt`, optionally creates note + task, writes non-blocking timeline events. **Phase 3C:** if `memberId` is provided and disposition contains "callback" and `followUpAt` is set, non-blocking updates `CrmCampaignMember.callbackAt`+`callbackNote`. |

### Timeline & Notes (Phase 1C — fixed Phase 5C)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/crm/contacts/:id/timeline` | All events, newest-first, max 200. **Phase 16A:** platform admins may read timeline for **archived** contacts; **note/task mutations** remain blocked for archived rows (`404`). |
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
| GET | `/crm/tasks/stats` | Dashboard counts: `{ myOpen, dueToday, overdue, callsLinkedToday, dispositionsToday, activeCampaigns, queueRemaining, myOverdueCallbacks, myCallbacksDueToday, myTasksOverdue, myTasksDueToday }`. Membership-based fields (`queueRemaining`, `myOverdueCallbacks`, `myCallbacksDueToday`) use the **live-contact** queue definition (Phase 16C: exclude archived/inactive contacts). Per-user task buckets unchanged. |
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
| POST | `/crm/contacts/bulk-reassign` | **Admin only.** Body: `{ contactIds: string[], assignedToUserId: string \| null }`. Updates `CrmContactMeta.assignedToUserId` for **active, non-archived** contacts only. Max 500 IDs per call. `null` clears assignment. Returns `{ ok, updated }`. No timeline events written (bulk action). |

### Contact Duplicate Detection & Merge (Phase 5A)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/crm/contacts/:id/duplicates` | Suggests potential duplicate contacts matching by shared normalised phone, email, or exact display name. Returns up to 5 results with `matchReasons[]`. Any CRM user can view **active** anchor; **platform admins** may run detection from an **archived** anchor (Phase 16A). Merging is admin-only. |
| POST | `/crm/contacts/merge` | **Admin only.** Body: `{ keepContactId, mergeContactId }`. Both must be active and in the same tenant. Moves CrmTimelineEvent, CrmContactNote, CrmContactTask, CrmChecklistResponse, CrmCampaignMember (skips campaign conflicts), unique phones/emails to `keepContact`. Archives `mergeContact` (`active=false, archivedAt=now`). Writes `CONTACT_MERGED` timeline event on `keepContact`. Returns `{ ok, phonesAdded, emailsAdded, campaignMembersMoved, campaignMembersSkipped }`. |

### Import (Phase 1E)
| Method | Path | Notes |
|--------|------|-------|
| POST | `/crm/import/upload` | CSV upload (`multipart/form-data`, field `file`). Uses shared `importPipeline` (parse, header auto-map, dedupe by phone/email, create/update `Contact` + `CrmContactMeta`). Max 5 MB, 5,000 rows. Returns `CrmImportBatch` summary. |
| GET | `/crm/import/batches` | List batches (same `formatBatch` shape as detail). |
| GET | `/crm/import/batches/:id` | Single batch. **`requireCrmAccess`**, tenant-scoped; **404** `not_found` if missing/cross-tenant. Returns display `fileName` (campaign tag stripped), **`importSource`**: `standalone` \| `campaign` (from stored `fileName`), **`campaignId`**: string \| null, status, row/processed counts, `errors` JSON (may be empty), `mapping`, timestamps, `createdBy`. No invented row-level data. |

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

### CRM Email (Phase 1 — send-only, metadata-first)

- Feature flag: `CRM_EMAIL_PHASE1_ENABLED=true`
- OAuth scopes (Phase 1): `openid email profile https://www.googleapis.com/auth/gmail.send`
- No inbox sync; no body fetch; no `gmail.readonly` yet.

| Method | Path | Notes |
|--------|------|-------|
| GET | `/crm/email/connection` | Returns current user connection status. No secrets/tokens. |
| POST | `/crm/email/oauth/start` | Returns Google OAuth URL (send-only scope). Body may include `bodyCacheMode` (defaults METADATA_ONLY). |
| GET | `/crm/email/oauth/callback` | Exchanges code, encrypts tokens at rest, upserts `CrmEmailConnection` with `replyTrackingEnabled=false`. Redirects to `/crm/email/settings?connected=1`. |
| DELETE | `/crm/email/connection` | Revokes (best-effort) and marks DISCONNECTED. Audited. |
| POST | `/crm/email/connection/test` | Queues a test email to self on `crm-email-send` worker. Audited. |
| POST | `/crm/email/send` | Queues a basic outbound email to a contact or explicit `toEmail`. Persists metadata + preview snippet only. Rate-limited. |

DB models: `CrmEmailConnection`, `CrmEmailThread`, `CrmEmailMessage`, `CrmEmailSendLog` (see `DATA_MODEL.md`).

**CDR hook (Phase 2A):** `POST /internal/cdr-ingest` calls `fireCrmCdrHook()` (no await) after `ConnectCdr` upsert. Writes `CDR_INBOUND`/`CDR_OUTBOUND` timeline events for CRM-enrolled contacts matched by phone.

**Campaign routes (Phase 3A):** `apps/api/src/crm/campaignRoutes.ts`

| Method | Path | Notes |
|--------|------|-------|
| GET | `/crm/campaigns` | List campaigns (default: exclude ARCHIVED). Filter: `?status=`. Each campaign includes `priority`. |
| POST | `/crm/campaigns` | Create campaign (admin). Body: `{ name, description?, status?, priority?: LOW\|NORMAL\|HIGH\|URGENT, scriptId?, checklistId? }`. Defaults `priority=NORMAL`. |
| GET | `/crm/campaigns/:id` | Campaign detail + statusCounts per member status. Includes `priority`. **Phase 16D:** when all **live-contact** actionable work reaches terminal statuses (or only archived contacts remain non-terminal), background auto-complete may set campaign `status` to `COMPLETED` (see `checkAndAutoCompleteCampaign` + `DELETE /crm/contacts/:id` re-check). |
| PATCH | `/crm/campaigns/:id` | Update name/description/status/priority/scriptId/checklistId (admin) |
| DELETE | `/crm/campaigns/:id` | Archive campaign (sets status=ARCHIVED, admin) |
| POST | `/crm/campaigns/:id/members/add` | Add contacts (by contactId array). Skips duplicates. Only CRM-enrolled contacts. (admin) |
| POST | `/crm/campaigns/:id/import/preview` | **Phase 17A — dry-run only.** Multipart `file` (CSV) + optional `assignedToUserId`. Same 5 MB / 5,000-row caps, CSV parse, header mapping, and row resolution as `POST /crm/campaigns/:id/import` (`runCampaignImportPreview` + in-batch synthetic dedupe). **Does not** create `CrmImportBatch`, contacts, phones, emails, meta, or campaign members. Returns `totalRows`, `validRows`, `invalidRows`, `wouldCreateContacts`, `wouldUpdateContacts`, `wouldAddMembers`, `wouldSkipExistingMembers`, `sampleRows` (max 25), `errors` (max 25). Admin only. |
| POST | `/crm/campaigns/:id/import` | **Multipart** `file` (CSV) + optional text field `assignedToUserId`. Same limits and column auto-mapping as `POST /crm/import/upload` (shared `importPipeline` — dedupe by phone/email, no duplicate contacts). Creates/updates contacts + CRM meta, then adds `CrmCampaignMember` rows; skips contacts already in the campaign. Optional assignee must be a tenant user with CRM access enabled. Returns `batchId`, `createdContacts`, `updatedContacts`, `skippedRows`, `addedMembers`, `skippedExistingMembers`, `errors`, etc. Admin only. Persists a `CrmImportBatch` whose `fileName` is tagged `campaign:{campaignId}:…` for history listing. |
| GET | `/crm/campaigns/:id/imports` | **Phase 17C — real batch-backed history only.** `requireCrmAccess` (same as campaign detail read). Query: `?limit=` (default **20**, max **50**). Returns `{ imports: [...] }` where each row is an actual `CrmImportBatch` for this campaign (`fileName` starts with `campaign:{id}:`). Fields: `id`, `createdAt`, `completedAt`, `status`, display `fileName` (prefix stripped), `totalRows`, `processedRows`, `createdCount`, `updatedCount`, `skippedCount`, `errorCount`, `createdBy: { id, displayName } \| null`. **No inferred rows** — empty `imports` when no linked batches (e.g. legacy data predating the tag). Tenant-scoped. |
| GET | `/crm/campaigns/:id/members` | List members with contact details (includes archived/inactive contacts for campaign history). Each row includes `queueWorkEligible`, `contact.active`, and `contact.archivedAt`. Filters: `?status=`, `?assignedToMe=true`, `?assignedToUserId=<id>` (validates userId is in tenant), `?unassigned=true`. All filters combine with `?page=` / `?limit=`. |
| GET | `/crm/campaigns/:id/workload` | Per-agent assignment summary. Returns `{ workload: [{ userId, displayName, pending, inProgress, callbacks, contacted, converted, skipped, dnc, total }] }`. Includes an Unassigned row. Counts include only members on **active, non-archived** contacts (Phase 16C — aligns with live queue). Admin only. |
| POST | `/crm/campaigns/:id/members/distribute` | Round-robin distribute all unassigned PENDING/IN_PROGRESS members across provided agents. Only **live-contact** members (active, not archived) are distributed (Phase 16C). Body: `{ userIds: string[] }` (1–50 users). Validates userIds belong to tenant. Returns `{ distributed, assignments: [{ userId, count }] }`. Admin only. Explicit manager action only — never automatic. |
| PATCH | `/crm/campaigns/:id/members/:memberId` | Update member status/assignment/sortOrder/attemptCount/callbackAt/callbackNote (Phase 3C: adds callbackAt+callbackNote). **Phase 16C:** non-admin callers receive **403** `crm_member_contact_not_live` when the member's contact is inactive (`active=false`) or archived (`archivedAt` set). CRM admins may still PATCH for maintenance. |
| GET | `/crm/queue` | My Queue with filter + sort + campaign scope. `?filter=pending\|due\|overdue\|upcoming\|all`. `?sort=smart\|original`. `?campaignId=<id>` — scope queue to one active campaign (must belong to tenant; returns 404 if not found; cross-tenant blocked). **Phase 16C — live queue only:** results and tab `counts` exclude members whose contact is `active=false` or has `archivedAt` set (no deletion of `CrmCampaignMember`; campaign history unchanged). Each row includes `queueWorkEligible` and contact `active`/`archivedAt` for UI. `?sort=smart` — composite-score ranking (callbacks first, then lead tiers with campaign priority offset). Candidate cap 500, ranked in-process. Each member includes `campaign.priority`. Returns `{ queue, total, sort, campaignId, counts }`. |
| POST | `/crm/queue/next` | Fetch next **live-contact** PENDING item and set it to IN_PROGRESS (same archived/inactive exclusion as `GET /crm/queue`). |
| PATCH | `/crm/queue/:memberId` | Queue action. `action`: `skip`, `defer`, `dnc`, `outcome` (maps disposition→status, increments attemptCount), `assign-to-me` (sets assignedToUserId=currentUser), `set-callback` (sets status=CALLBACK, callbackAt, callbackNote), `clear-callback` (sets callbackAt=null, callbackNote=null, status=PENDING). Body also accepts `callbackAt?`, `callbackNote?` alongside explicit `status`. **Phase 16C:** non-admin callers receive **409** `crm_queue_contact_not_live` if the contact is archived/inactive (admins may still PATCH). |
| POST | `/crm/campaigns/:id/members/bulk-assign` | Bulk-assign (or clear) selected members to a user. Body: `{ memberIds: string[], assignedToUserId: string\|null }`. Returns `{ updated: number }`. Admin only. |
| GET | `/crm/campaigns/:id/contacts/available` | Search CRM contacts NOT already in campaign. Params: `?q=`, `?limit=`, `?page=`. Returns paginated contacts. Admin only. |
| GET | `/crm/campaigns/:id/export.csv` | Export all campaign members as CSV download. Columns: Name, Phone, Email, Company, Stage, Status, Assigned To, Attempts, Last Attempt, Last Disposition. |

**Guard errors:** `crm_not_enabled` (403), `crm_user_not_enabled` (403), `crm_permission_denied` (403), `contact_not_in_crm` (400 for disposition on non-enrolled contact).

### CRM Drive Integration (Phase 1)

Registered via `registerCrmDriveRoutes(app)` in `apps/api/src/crm/driveRoutes.ts`.
**Auth:** JWT (any authenticated user — no separate CRM admin gate for status/folders; folder config write uses connection ownership check).
**Risk:** **LOW** — no telephony coupling; no file content; metadata + config only.
**Source:** `apps/api/src/crm/driveRoutes.ts` + `apps/api/src/crm/driveService.ts`

**Drive scope:** `https://www.googleapis.com/auth/drive.readonly` — see `DATA_MODEL.md` § CRM Drive Foundation for scope rationale.

| Method | Path | Notes |
|--------|------|-------|
| GET | `/crm/drive/status` | Drive + Gmail connection status + saved folder config. No tokens. Returns `{ gmailConnected, gmailEmail, driveConnected, driveEmail, driveConnectionId, folderConfig }`. |
| POST | `/crm/drive/oauth/start` | Returns Google OAuth URL with Gmail + Drive scopes. Body: `{ connectionId? }`. Incremental auth — upgrades an existing connection if `connectionId` provided. |
| GET | `/crm/drive/oauth/callback` | OAuth callback. Upserts `CrmEmailConnection` with Drive scopes; redirects to `/crm/drive?connected=1`. |
| GET | `/crm/drive/folders` | Lists Drive folders. Query: `?connectionId=`, `?parentId=`, `?pageToken=`. Returns `{ folders: [{id, name, modifiedTime}], nextPageToken }`. 400 `drive_not_connected` if no Drive-capable connection. |
| GET | `/crm/drive/folder-config` | Returns saved folder config for this tenant (`purpose=LEAD_IMPORT_INBOX`). Returns `{ folderConfig: {...} \| null }`. |
| POST | `/crm/drive/folder-config` | Upserts folder config. Body: `{ connectionId, folderId, folderName }`. Validates connection belongs to tenant + has Drive scope. Audited. |
| DELETE | `/crm/drive/folder-config` | Removes saved folder config. Idempotent. Audited. |
| POST | `/crm/drive/folder-config/test` | Tests folder access. Body: `{ folderId?, connectionId? }` — uses saved config if omitted. Returns `{ ok, folderName, fileCount }`. |
| GET | `/crm/drive/folder-config/files` | Lists recent files in saved folder. Query: `?limit=<1..20>`. Returns `{ folderName, folderId, files: [{id, name, mimeType, size, modifiedTime, webViewLink}], nextPageToken }`. |

**Error codes:**

| Code | When |
|------|------|
| `drive_not_connected` | No Drive-capable connection found for this tenant |
| `drive_scope_missing` | Connection found but lacks `drive.readonly` scope |
| `connection_not_found` | Specified `connectionId` does not exist or belongs to different tenant |
| `no_folder_config` | Route requires a saved folder config but none exists |
| `drive_api_error` | Drive API call failed (502) |
| `token_revoked` | Google revoked the OAuth grant — reconnect required |
| `not_a_folder` | Specified Drive item is not a folder |

**Tenant isolation:**
- All DB queries filter by `tenantId`. `loadConnectionForTenant(id, tenantId)` uses `WHERE id=? AND tenantId=?`.
- `CrmDriveFolder` upsert is keyed by `{ tenantId_purpose: { tenantId, purpose } }` — Tenant A cannot overwrite Tenant B's config.
- Folder listing uses the OAuth token from the tenant's own connection — no shared token pool.

**Audit actions emitted:** `CRM_DRIVE_CONNECTED`, `CRM_DRIVE_FOLDER_SAVED`, `CRM_DRIVE_FOLDER_REMOVED`.

### CRM Drive Match (Phase 2 + Phase 2 Harden)

Registered via `registerCrmDriveMatchRoutes(app)` in `apps/api/src/crm/driveMatchRoutes.ts`.
**Auth:** `requireCrmAccess` (same as all CRM routes).
**Risk:** LOW — metadata only; no file content; no OCR.
**Source:** `apps/api/src/crm/driveMatchRoutes.ts` + `apps/api/src/crm/driveMatchService.ts`

| Method | Path | Notes |
|--------|------|-------|
| POST | `/crm/drive/match/run` | Runs the Drive match engine for a batch. Body: `{ batchId }`. Requires `CrmDriveFolder.LEAD_IMPORT_INBOX` configured. Returns `DriveMatchRunResult` (see below). **Idempotent** — uses `createMany({ skipDuplicates: true })`; existing `IMPORT_PENDING` / `REJECTED` records are never overwritten. Returns 422 `no_audit_rows` if batch rows exist but no `CrmImportBatchRow` records were captured. |
| GET | `/crm/drive/match/results` | Returns `CrmLeadDocument` records for a batch + unmatched company list + audit health. Query: `?batchId=`. Returns `{ batch, documents, unmatchedCompanies }` where `batch` includes `auditRowCount`, `auditErrorCount`, `auditWarning`. |
| POST | `/crm/drive/match/:docId/confirm` | Confirms a DISCOVERED match → status `IMPORT_PENDING`. Records `reviewedByUserId` + `reviewedAt`. |
| POST | `/crm/drive/match/:docId/reject` | Rejects a DISCOVERED match → status `REJECTED`. Records reviewer. |
| GET | `/crm/contacts/:id/documents` | Lists attached `CrmLeadDocument` for a contact. Excludes `REJECTED` by default; pass `?includeRejected=1` to include. |

**`DriveMatchRunResult` shape (POST `/crm/drive/match/run`):**

```json
{
  "batchId": "...",
  "filesScanned": 42,
  "auditRowCount": 10,
  "rowsWithCompany": 10,
  "matchesCreated": 7,
  "duplicatesSkipped": 0,
  "ambiguousMatches": 2,
  "unmatchedCompanies": ["Acme Corp"],
  "unmatchedFiles": ["Random File.pdf"]
}
```

**`GET /crm/drive/match/results` — batch sub-object:**

```json
{
  "id": "...",
  "fileName": "leads.csv",
  "status": "DONE",
  "totalRows": 50,
  "auditRowCount": 50,
  "auditErrorCount": 0,
  "auditWarning": null,
  "createdAt": "...",
  "completedAt": "..."
}
```
`auditWarning` is non-null when audit rows are missing or `auditErrorCount > 0`.

**Error codes:**

| Code | HTTP | When |
|------|------|------|
| `batchId_required` | 400 | Missing `batchId` in request |
| `batch_not_found` | 404 | Batch does not belong to this tenant |
| `no_drive_folder` | 409 | No `CrmDriveFolder` configured for `LEAD_IMPORT_INBOX` |
| `no_audit_rows` | 422 | Batch has rows but no `CrmImportBatchRow` records — audit writes failed during import |
| `document_not_found` | 404 | Doc does not belong to this tenant |
| `invalid_status` | 409 | Confirm/reject called on a doc that is not `DISCOVERED` |
| `contact_not_found` | 404 | Contact does not belong to this tenant |

**`GET /crm/import/batches` and `GET /crm/import/batches/:id`** — batch objects now include `auditErrorCount` (stored). The `:id` detail endpoint additionally returns `auditRowCount` (live count of `CrmImportBatchRow` records for the batch).

**Matching confidence levels:**

| Value | Meaning |
|-------|---------|
| `HIGH` | Normalised company name exactly equals normalised file name |
| `MEDIUM` | One token contains the other, min 4 chars |
| `AMBIGUOUS` | One file matched multiple companies OR one company matched multiple files |
| _(discarded)_ | `LOW` matches are never written to DB |

**Tenant isolation:** every DB query includes `tenantId` in `WHERE` clause. Cross-tenant batch, document, or contact access returns 404.

### CRM Document Import (Phase 3 + Phase 4 security hardening)

Registered via `registerCrmDocImportRoutes(app)` in `apps/api/src/crm/docImportRoutes.ts`.
**Auth:** `requireCrmAccess` (JWT) required for **all** routes including `/crm/documents/:id/open`.
**Risk:** MEDIUM — reads Drive file content; stores to local FS.
**Source:** `apps/api/src/crm/docImportService.ts` + `apps/api/src/crm/docImportStorage.ts`

#### Phase 4 — dual-gate document access (security hardening)

`GET /crm/documents/:id/open` now requires **both** checks to pass:

1. **Gate 1 — JWT auth**: `requireCrmAccess` validates the Bearer token and resolves `tenantId` + `userId` from it.
2. **Gate 2 — HMAC signature**: `verifySignedCrmDocUrl(docId, tenantId, userId, exp, sig)` verifies the signature is bound to the authenticated user and tenant.

A leaked URL (browser history, proxy log, referer header) is useless without a matching valid JWT for the same tenant and user. A stolen JWT is useless without a fresh valid HMAC signature.

**Signed URL format (v2):** `?exp=<unix_ts>&sig=<hex_hmac>`
HMAC message: `crm-doc-open:v2:<docId>:<tenantId>:<userId>:<exp>` — binds purpose, document, tenant, user, and expiry.
Old v1 Phase 3 signatures (format `crm-doc:<docId>:<storageKey>:<exp>`) automatically fail.

**Frontend open flow (authenticated blob):**
```
1. GET /crm/documents/:id/open-url  →  { signedUrl }   (JWT required)
2. fetch(signedUrl, { Authorization: Bearer <jwt> })    (JWT + HMAC required)
3. URL.createObjectURL(blob)  →  window.open(blobUrl)
```
`window.open(signedUrl)` alone is rejected because it drops the Authorization header.

**Audit log events** (no content, no storage paths, no tokens logged):
| Event key | When |
|---|---|
| `crm_doc_opened` | Successful stream — logs `{ docId, tenantId, userId, bytes }` |
| `crm_doc_invalid_signature` | HMAC mismatch, v1 sig, wrong tenant/user — logs `{ docId, tenantId, userId, event: "invalid_signature" }` |
| `crm_doc_link_expired` | `exp` is in the past — logs `{ docId, tenantId, userId, event: "expired_link" }` |
| `crm_doc_cross_tenant_attempt` | JWT tenant ≠ document tenant — logs `{ docId, callerTenantId, docTenantId }` |

| Method | Path | Notes |
|--------|------|-------|
| POST | `/crm/documents/:id/import` | Imports a single doc. Body: `{ force?: boolean }`. Transitions `IMPORT_PENDING → IMPORTING → IMPORTED` or `IMPORT_FAILED`. Returns `DocImportResult`. |
| POST | `/crm/import/batches/:batchId/import-documents` | Imports up to 20 `IMPORT_PENDING` docs for a batch. Body: `{ limit?: number }`. Returns `BatchImportResult`. Call repeatedly until `attempted === 0` for large batches. |
| GET | `/crm/import/batches/:batchId/document-import-status` | Returns document count by status + per-doc list. |
| GET | `/crm/documents/:id/open-url` | Returns a 10-minute signed URL for the imported file. Requires `status=IMPORTED`. Signature binds `docId + tenantId + userId + expiry (v2)`. |
| GET | `/crm/documents/:id/open` | **Phase 4:** Streams the imported file. Requires valid CRM JWT **AND** valid HMAC signature bound to the authenticated user+tenant. Denied if either check fails. Returns `Content-Type`, `Content-Disposition: inline`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`. |
| GET | `/crm/documents/:id/status` | Returns safe metadata and current import status for one doc. |

**`DocImportResult` shape:**

```json
{ "docId": "...", "status": "IMPORTED", "storageKey": "...", "contentHash": "...", "storedBytes": 123456, "importedMimeType": "application/pdf" }
```

or on failure:

```json
{ "docId": "...", "status": "IMPORT_FAILED", "errorCode": "file_too_large", "errorMessage": "..." }
```

**Google Workspace files:** `application/vnd.google-apps.document`, `spreadsheet`, `presentation`, and `drawing` are exported to PDF via Drive export API. `importedMimeType` is set to `application/pdf`. Other Workspace types result in `IMPORT_FAILED` with `unsupported_workspace_type`.

**Size limit:** `CRM_DOC_IMPORT_MAX_BYTES` env var (default: 50 MB). Files exceeding the limit result in `IMPORT_FAILED` with `file_too_large`.

**Storage:** `CRM_DOC_STORAGE_DIR` env var (default: `data/crm-lead-docs`). Tenant-scoped path. Raw storage keys are NEVER returned to callers — access is via HMAC-signed URLs only.

**Error codes:**

| Code | HTTP | When |
|------|------|------|
| `doc_not_found` | 404 | Document not found for this tenant |
| `invalid_status` | 409 | Doc is not in a state that allows import |
| `no_drive_folder` | 409 | No `CrmDriveFolder` configured for `LEAD_IMPORT_INBOX` |
| `no_drive_file_id` | 422 | Document has no Drive file ID |
| `batch_not_found` | 404 | Batch does not belong to this tenant |
| `doc_not_imported` | 404 | `/open-url` called on a doc that is not `IMPORTED` |
| `link_expired` | 410 | `/open` called with an expired signature (audit: `crm_doc_link_expired`) |
| `invalid_signature` | 403 | `/open` HMAC mismatch — tampered params, wrong tenant/user, or old v1 sig (audit: `crm_doc_invalid_signature`) |
| `cross_tenant_attempt` | 403 | JWT tenant does not match document tenant (audit: `crm_doc_cross_tenant_attempt`) |

---

### CRM Document Text Extraction (Phase 5)

Registered via `registerCrmDocTextExtractionRoutes(app)` in `apps/api/src/crm/docTextExtractionRoutes.ts`.
**Auth:** `requireCrmAccess` (JWT) required for all routes.
**Risk:** LOW — reads only locally-stored files; no external API calls.
**Source:** `apps/api/src/crm/docTextExtractionService.ts`

**Supported file types:**

| MIME / Extension | Provider | Library |
|---|---|---|
| `application/pdf` / `.pdf` | `pdf_text_layer` | `pdf-parse` |
| `text/plain`, `text/csv` / `.txt`, `.csv` | `plain_text` | Node `fs` |
| `application/vnd.openxmlformats-officedocument.wordprocessingml.document` / `.docx` | `docx_text` | `mammoth` |
| Everything else | `unsupported` → `TEXT_FAILED` | — |
| Scanned / image-only PDF (no text layer) | `future_ocr` → `TEXT_FAILED` | — |

| Method | Path | Notes |
|--------|------|-------|
| POST | `/crm/documents/:id/text-extraction` | Trigger text extraction for a single IMPORTED doc. Body: `{ force?: boolean }`. If `TEXT_COMPLETE` and `force=false`, returns `{ status: "skipped" }`. |
| GET | `/crm/documents/:id/text-extraction` | Get extraction status, provider, error, and extracted text for a single doc. Returns null text if never extracted. |
| POST | `/crm/import/batches/:batchId/text-extraction` | Extract text for up to 5 docs in a batch. Body: `{ limit?: number, force?: boolean }`. Returns `BatchExtractionSummary`. Loop until `attempted === 0` for large batches. |
| GET | `/crm/import/batches/:batchId/text-extraction-status` | Returns aggregate counts by extraction status for IMPORTED docs in a batch. |

**`BatchExtractionSummary` shape:**
```json
{ "attempted": 3, "complete": 2, "failed": 1, "skipped": 0 }
```

**Idempotency:**
- `TEXT_COMPLETE` with `force=false` → `{ status: "skipped", reason: "already_complete" }`
- `TEXT_FAILED` → always retried (no `force` required)
- `CrmLeadDocumentText` row is **upserted** on each run — never duplicated

**Max chars stored:** 500,000 (truncated; configurable by changing `MAX_STORED_CHARS` in service)
**Max docs per batch call:** 5 (hard-coded `min(5, limit)`)

**Error codes:**

| Code | Status | Meaning |
|---|---|---|
| `doc_not_imported` | 404 | Document not found or `status ≠ IMPORTED` for this tenant |
| `no_storage_key` | 422 | IMPORTED document has no storage key (storage inconsistency) |
| `batch_not_found` | 404 | Batch does not belong to this tenant |
| `scanned_or_image_ocr_not_configured` | (in error field) | PDF has no text layer — OCR not yet available |
| `unsupported_file_type` | (in error field) | File format not supported by any extractor |

### CRM Contact Discovery _(Phase 6)_

**Auth:** `requireCrmAccess` on all routes. Strict tenant isolation — tenant B cannot read or act on tenant A discoveries.

**Security constraint:** extracted document text is never returned from any discovery endpoint. Only `sourceSnippet` (≤ 200 chars) is exposed.

| Method | Path | Notes |
|--------|------|-------|
| POST | `/crm/documents/:id/discover` | Run phone + email discovery for a single `IMPORTED` + `TEXT_COMPLETE` document. Returns `{ phonesFound, emailsFound, phonesSkipped, emailsSkipped }`. |
| GET | `/crm/contacts/:id/discoveries` | Get discoveries for a contact. Default: PENDING only. `?includeAll=true` includes ACCEPTED + REJECTED. Returns `{ contactId, phones[], emails[] }`. |
| POST | `/crm/discoveries/phones/:id/accept` | Accept a phone discovery — creates `ContactPhone` (isPrimary=false), marks ACCEPTED. Returns `{ ok: true, phoneId }`. |
| POST | `/crm/discoveries/phones/:id/reject` | Reject a phone discovery — marks REJECTED, record kept for audit. Returns `{ ok: true }`. |
| POST | `/crm/discoveries/emails/:id/accept` | Accept an email discovery — creates `ContactEmail` (isPrimary=false), marks ACCEPTED. Returns `{ ok: true, emailId }`. |
| POST | `/crm/discoveries/emails/:id/reject` | Reject an email discovery — marks REJECTED, record kept for audit. Returns `{ ok: true }`. |
| POST | `/crm/import/batches/:batchId/discover` | Run discovery for up to 10 `IMPORTED + TEXT_COMPLETE` docs in a batch. Body: `{ limit?: number }`. Returns `{ documentsProcessed, totalPhonesFound, totalEmailsFound }`. Loop until `documentsProcessed === 0` for large batches. |
| GET | `/crm/import/batches/:batchId/discovery-status` | Aggregate discovery counts for a batch. Returns `{ phones: { pending, accepted, rejected }, emails: { pending, accepted, rejected } }`. |

**Idempotency:**
- Existing `ACCEPTED` or `REJECTED` discoveries are never overwritten on rerun.
- Existing `PENDING` discoveries are reused (unique constraint on `(tenantId, contactId, normalizedPhone, documentId)`).
- Values already on the contact (`ContactPhone`, `ContactEmail`) are silently skipped — not stored as discoveries.

**Max docs per batch call:** 10 (hard-coded `min(10, limit)`)

**Error codes:**

| Code | Status | Meaning |
|---|---|---|
| `doc_not_found` | 404 | Document not found, not IMPORTED, or belongs to another tenant |
| `doc_no_contact` | 404 | Document not attached to a contact — run Drive match first |
| `text_not_extracted` | 422 | `extractionStatus ≠ TEXT_COMPLETE` — run text extraction first |
| `not_found` | 404 | Discovery record not found or belongs to another tenant |
| `already_accepted` | 422 | Cannot reject an already-accepted discovery |
| `already_rejected` | 422 | Cannot accept an already-rejected discovery |
| `batch_not_found` | 404 | Batch not found or belongs to another tenant |

---

### CRM Lead Intelligence _(Phase 7)_

**Auth:** `requireCrmAccess` on all routes. Strict tenant isolation.

**Advisory only:** no contact data is modified by any intelligence route. AI output is informational only.

**Requires:** `OPENAI_API_KEY` env var on the API server. Missing key → `503 ai_not_configured`.

| Method | Path | Notes |
|--------|------|-------|
| POST | `/crm/contacts/:id/intelligence` | Generate intelligence for a contact. Body: `{ force?: boolean }`. Returns `{ reportId, status, skipped?, cooldownActive?, retryAfterMs?, retryAfterMessage? }`. CRM admin bypasses cooldown. |
| GET | `/crm/contacts/:id/intelligence` | Get the latest intelligence report for a contact. Returns `{ report }` (may be `null`). |
| POST | `/crm/import/batches/:batchId/intelligence` | Batch generation respecting `CrmAiSettings`. Body: `{ force?: boolean, limit?: number }`. Returns `{ contactsProcessed, complete, failed, skipped_existing, skipped_limit }`. |
| GET | `/crm/import/batches/:batchId/intelligence-status` | Aggregate status counts. Returns `{ pending, processing, complete, failed, noReport }`. |
| GET | `/crm/ai-settings` | Get current AI settings for the tenant (or defaults). Any CRM user. |
| PUT | `/crm/ai-settings` | Update AI settings. **CRM admin only.** Body: partial `CrmAiSettings` fields. Hard caps enforced server-side. Returns saved settings. |

**GET /crm/contacts/:id/intelligence — report shape when COMPLETE:**
```json
{
  "report": {
    "id": "...",
    "status": "COMPLETE",
    "summary": "...",
    "businessOverview": "...",
    "keyFindings": { "phoneCount": 2, "emailCount": 1, "documentCount": 3, "namesFound": [...], "addressesFound": [...], "additionalNotes": [...] },
    "discoveredEntities": { "phones": [...], "emails": [...], "websites": [...], "names": [...], "addresses": [...] },
    "riskFlags": ["missing_primary_phone"],
    "missingInformation": ["missing_address"],
    "confidenceScore": 0.72,
    "modelName": "gpt-4o-mini",
    "providerName": "openai",
    "generatedAt": "...",
    "sourceDocumentCount": 5,
    "sourceTextCount": 4,
    "sourceDiscoveryCount": 6,
    "promptCharCount": 8432,
    "documentsIncluded": 5,
    "documentsExcluded": 0,
    "generationDurationMs": 3210
  }
}
```

**POST /crm/import/batches/:batchId/intelligence — result shape:**
```json
{
  "contactsProcessed": 10,
  "complete": 7,
  "failed": 1,
  "skipped_existing": 1,
  "skipped_limit": 2
}
```
- `skipped_existing` — contacts already had a COMPLETE report (and `force=false`)
- `skipped_limit` — contacts beyond `maxBatchReportsPerRun`

**GET /crm/ai-settings — shape:**
```json
{
  "aiEnabled": true,
  "maxDocumentsPerReport": 5,
  "maxCharsPerDocument": 2000,
  "maxTotalCharsPerReport": 10000,
  "allowBatchGeneration": true,
  "maxBatchReportsPerRun": 25,
  "regenerationCooldownMinutes": 60,
  "isDefault": false
}
```

**Risk flag codes:** `missing_primary_phone`, `missing_primary_email`, `conflicting_phone_numbers`, `conflicting_addresses`, `insufficient_documentation`, `extraction_failures`, `scanned_documents`, `no_company_identified`, `stale_contact_data`

**Missing info codes:** `missing_owner`, `missing_address`, `missing_email`, `missing_phone`, `missing_financial_docs`, `missing_business_description`, `missing_website`

**Idempotency:**
- `COMPLETE` + `force=false` → `{ skipped: true, status: "COMPLETE" }`
- `FAILED` → always retried (no `force` required)
- `PROCESSING` → returns `{ skipped: true, status: "PROCESSING" }` (no duplicate AI call)
- `force=true` within cooldown window → `429 cooldown_active` with `retryAfterMs`

**Error codes:**

| Code | Status | Meaning |
|---|---|---|
| `contact_not_found` | 404 | Contact not found or belongs to another tenant |
| `ai_not_configured` | 503 | `OPENAI_API_KEY` is not set |
| `ai_disabled` | 403 | `aiEnabled=false` in `CrmAiSettings` |
| `cooldown_active` | 429 | Force-regen within cooldown window; `retryAfterMs` in body |
| `batch_generation_disabled` | 403 | `allowBatchGeneration=false` in `CrmAiSettings` |
| `generation_failed` | 422 | AI call failed; safe error stored in report |
| `batch_not_found` | 404 | Batch not found or belongs to another tenant |
| `forbidden` | 403 | Non-admin attempted `PUT /crm/ai-settings` |

---

### CRM Import Batch Pipeline (Phase 8)

Registered via `registerCrmBatchPipelineRoutes(app)` in `apps/api/src/crm/batchPipelineRoutes.ts`.
**Auth:** `requireCrmAccess` required on all routes. All routes are tenant-scoped by JWT `tenantId`.
**Source:** `batchPipelineService.ts` orchestrates existing services; does not duplicate logic.

| Method | Path | Description |
|---|---|---|
| POST | `/crm/import/batches/:batchId/pipeline/start` | Start a new pipeline run. Recovers stale RUNNING runs first. Returns **409** `already_running` if a non-stale RUNNING run exists. Returns **404** `batch_not_found` for unknown/cross-tenant batch. Returns `PipelineRunResult`. |
| POST | `/crm/import/batches/:batchId/pipeline/continue` | Continue the most recent PARTIAL run. Recovers stale RUNNING runs first. If no PARTIAL/RUNNING run exists, starts fresh. Returns `PipelineRunResult`. |
| GET | `/crm/import/batches/:batchId/pipeline/status` | Get the latest pipeline run for a batch. Returns `{ run: PipelineRunResult | null }`. `run` is null when no runs exist yet. |
| GET | `/crm/import/batches/:batchId/pipeline/runs/:runId` | Get a specific pipeline run by id. Returns **404** `run_not_found` if not found or cross-tenant. |
| POST | `/crm/import/batches/:batchId/pipeline/cancel` | Cancel the latest PENDING, **RUNNING**, or PARTIAL run. Returns `{ cancelled: boolean, runId?: string, reason?: string }`. No-op when no cancellable run exists. COMPLETE, FAILED, and CANCELLED runs cannot be cancelled. |
| GET | `/crm/import/batches/:batchId/pipeline/health` | Health check: stale detection, active run count, hasMore. No sensitive data. Returns `PipelineHealthResult`. |

**`PipelineRunResult` shape:**
```json
{
  "runId": "clxyz...",
  "batchId": "clxyz...",
  "status": "PARTIAL",
  "currentStep": "text_extraction",
  "steps": {
    "drive_match":      { "status": "complete", "attempted": 12, "succeeded": 12, "skipped": 0, "failed": 0, "errorSummary": null, ... },
    "document_import":  { "status": "complete", "attempted": 10, "succeeded": 10, "skipped": 0, "failed": 0, "errorSummary": null, ... },
    "text_extraction":  { "status": "partial",  "attempted": 5,  "succeeded": 4,  "skipped": 0, "failed": 1, "errorSummary": null, ... },
    "contact_discovery":{ "status": "pending",  "attempted": 0, ... },
    "ai_intelligence":  { "status": "skipped",  "errorSummary": "AI is disabled for this tenant.", ... }
  },
  "totals": {
    "driveFilesScanned": 12,
    "documentsMatched": 12,
    "documentsImported": 10,
    "textExtracted": 4,
    "discoveriesFound": 0,
    "aiReportsGenerated": 0
  },
  "errors": [{ "step": "text_extraction", "error": "File exceeds OCR limit", "at": "..." }],
  "overallProgressPercent": 50,
  "hasMore": true,
  "nextAction": "5 document(s) still need text extraction. Click Continue to extract the next batch.",
  "startedAt": "2026-06-08T09:00:00Z",
  "completedAt": null,
  "recoveredAt": null
}
```

**`overallProgressPercent`:** Integer 0–100. Derived from step states:
- complete / skipped → 20 pts each (5 steps × 20 = 100)
- partial → 10 pts (half credit)
- running → 5 pts (quarter credit, in-progress)
- failed / pending → 0 pts

**`recoveredAt`:** ISO timestamp set when a stale RUNNING run was auto-recovered to FAILED. `null` for normal runs.

**Step behavior:**
- `drive_match` — calls `runDriveMatchForBatch`. Idempotent; skips already-matched files. No Drive folder → run status `FAILED`, no further steps run.
- `document_import` — calls `importBatchDocuments`. Effective limit = `min(20, CRM_PIPELINE_MAX_STEP_ITEMS)`. Only processes `IMPORT_PENDING` docs.
- `text_extraction` — calls `extractBatchDocumentText`. Effective limit = `min(5, CRM_PIPELINE_MAX_STEP_ITEMS)`. Only `IMPORTED` docs without `TEXT_COMPLETE`. OCR limits apply.
- `contact_discovery` — calls `extractDiscoveriesForBatch`. Effective limit = `min(10, CRM_PIPELINE_MAX_STEP_ITEMS)`. Only `TEXT_COMPLETE` docs.
- `ai_intelligence` — calls `generateBatchIntelligence`. Effective limit = `min(5, CRM_PIPELINE_MAX_STEP_ITEMS)`. `force=false` — never force-regenerates. Skipped (not failed) when AI or batch generation disabled.

**`hasMore` flag:** Set to `true` on `PARTIAL` runs when import, extraction, or AI work remains. The UI shows a "Continue Processing" button. When `hasMore=false` and `status=PARTIAL`, the pipeline is stalled (e.g. all remaining docs failed extraction); manual investigation needed.

**`PipelineHealthResult` shape** (returned by `GET .../pipeline/health`):
```json
{
  "healthy": true,
  "latestRunStatus": "COMPLETE",
  "staleDetected": false,
  "activeRunCount": 0,
  "hasMore": false,
  "lastUpdatedAt": "2026-06-08T09:05:00Z"
}
```
`healthy=true` when: `activeRunCount ≤ 1`, no stale runs, and `latestRunStatus ≠ FAILED`. No sensitive data.

**Stale run recovery:** `start` and `continue` automatically recover stale RUNNING runs before checking for active ones. A stale run has `status=RUNNING` and `updatedAt < now - CRM_PIPELINE_STALE_MINUTES`. Recovered runs are marked `FAILED` with `recoveredAt` set and a `stale_run_recovered` error entry.

**Cancellation rules:** Only `PENDING`, `RUNNING`, and `PARTIAL` may be cancelled. `COMPLETE`, `FAILED`, and `CANCELLED` cannot. Returns `{ cancelled: false, reason: "no_cancellable_run" }` when nothing cancellable exists.

**Error codes:**
| Code | HTTP | Description |
|---|---|---|
| `batch_not_found` | 404 | Batch not found or belongs to another tenant |
| `already_running` | 409 | A non-stale RUNNING pipeline run exists for this batch |
| `run_not_found` | 404 | Specific run ID not found |

---

### CRM Batch Diagnostics _(Phase 9)_

Requires `requireCrmAccess` (tenant-scoped). All routes return 404 `batch_not_found` for unknown or cross-tenant batches.

| Method | Path | Description |
|---|---|---|
| GET | `/crm/import/batches/:batchId/diagnostics` | Full diagnostics: batch overview, pipeline summary, document/extraction/discovery/AI counts, health score, warnings, failures. |
| GET | `/crm/import/batches/:batchId/diagnostics/failures` | Categorized failures only. Returns `{ failures: DiagnosticsFailure[] }`. |
| GET | `/crm/import/batches/:batchId/diagnostics/timeline` | Pipeline step timeline from the latest run. Returns `{ steps: TimelineStep[] }`. Always returns 5 steps (pending if no run exists). |
| GET | `/crm/import/batches/:batchId/diagnostics/support-bundle` | Safe JSON export for internal support. Returns `SupportBundle` with `Content-Disposition: attachment`. Never includes doc text, AI prompts, storage keys, or tokens. |

**`BatchDiagnostics` shape:**
```json
{
  "generatedAt": "2026-06-08T09:00:00Z",
  "healthScore": 85,
  "batch": { "batchId": "...", "fileName": "leads.csv", "status": "COMPLETE", ... },
  "pipeline": {
    "latestRunId": "...", "latestRunStatus": "COMPLETE", "overallProgressPercent": 100,
    "staleRecoveries": 0, "totalRuns": 1, "durationMs": 45000
  },
  "documents": { "total": 10, "matched": 8, "imported": 8, "importPending": 0, "importFailed": 0, "importSkipped": 2 },
  "extraction": { "total": 8, "complete": 7, "failed": 1, "ocrComplete": 1, "ocrFailed": 0, "totalCharsExtracted": 52000 },
  "discovery": { "phonesTotal": 5, "phonesAccepted": 3, "emailsTotal": 3, "emailsAccepted": 2, ... },
  "ai": { "total": 5, "complete": 4, "failed": 1, "pending": 0 },
  "warnings": [{ "code": "extraction_failures_present", "message": "...", "count": 1 }],
  "failures": [{ "category": "DOCUMENT", "count": 1, "latestOccurrence": "...", "exampleMessage": "import_failed" }]
}
```

**Health score:** 0–100 integer. See DATA_MODEL.md §CRM Batch Diagnostics for full penalty table.

**`SupportBundle`** adds `timeline`, `config` (safe operational context), and `version: "1"`. Contains no document text, prompts, storage paths, API keys, or tokens.

**Error codes:**
| Code | HTTP | Description |
|---|---|---|
| `batch_not_found` | 404 | Batch not found or belongs to another tenant |

---

### CRM Reports _(Phase 4A)_

All report endpoints require `requireCrmAccess` (not admin-only). Tenant-isolated. No pagination on aggregate endpoints; detail rows are capped at 100.

| Method | Path | Description |
|---|---|---|
| GET | `/crm/reports/daily` | Tenant-wide today snapshot: `dispositionsToday`, `callsLinkedToday`, `contactsCreatedToday`, `tasksDueToday`, `overdueTasks`, `callbacksDueToday`, `overdueCallbacks`, `activeCampaigns`, `queueRemaining`. Always "today" — no date range parameter. **Phase 16C:** `callbacksDueToday`, `overdueCallbacks`, and `queueRemaining` count only members on **active, non-archived** contacts (live queue definition). Historical totals (e.g. raw campaign roster in `/crm/reports/campaigns`) are unchanged. |
| GET | `/crm/reports/campaigns` | Per-campaign performance. `?status=all\|ACTIVE\|PAUSED\|COMPLETED` (default: all non-archived). Returns array: `{ id, name, status, total, pending, contacted, callbacks, converted, dnc, conversionRate, totalAttempts, lastActivityAt }`. Uses a single `groupBy` query for member counts. Cap 200 campaigns. |
| GET | `/crm/reports/agents` | Per-agent activity summary. `?days=1\|7\|30` (default 30, max 90). Returns `{ agents: [...], lookbackDays }` where each agent has: `assignedQueue`, `callbacksDueToday`, `dispositionsToday`, `convertedLast` (in lookback window), `openTasks`. Uses `groupBy` — no per-user loops. Only CRM-enabled users included. |
| GET | `/crm/reports/follow-ups` | Bucketed follow-up health. Returns `{ callbacks: { overdue, dueToday, dueThisWeek }, tasks: { overdue, dueToday } }`. Each bucket has `{ count, rows[] }` with contact name/phone, assignedTo, campaign, due time. Rows capped at 100 per bucket. **Phase 16C:** callback buckets (counts + rows) include only members on **active, non-archived** contacts. Task buckets unchanged. |

### CRM Admin — pilot readiness (Phase 15A)

| Method | Path | Description |
|---|---|---|
| GET | `/crm/admin/pilot-readiness` | **Admin only** (`requireCrmAdmin`). Bounded read-only snapshot for the first-day dashboard: `{ crmEnabled, usersWithCrmAccess, activeCampaigns, queuePendingOrInProgress, overdueCallbacks, smsProviderConfigured, smsReadinessApplicable }`. `queuePendingOrInProgress` and `overdueCallbacks` use the **live-contact** queue definition (Phase 16C). `smsReadinessApplicable` is true when the tenant has CRM SMS timeline history and/or a resolvable outbound SMS provider (contact-composer path). |

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

---

## Onboarding (public wizard + admin)

Public wizard routes are registered via `registerOnboardingPublicRoutes(app)` in `apps/api/src/onboarding/publicRoutes.ts`.
Admin provisioning workspace routes are registered via `registerOnboardingProvisioningRoutes(app)` in `apps/api/src/onboarding/provisioningRoutes.ts`.

Auth:
- Public token routes under `/onboarding/*` are JWT-bypassed via `jwtPublicRouteBypass.ts` but strictly token-scoped and expiry-gated.
- Admin routes under `/admin/onboarding/*` require `SUPER_ADMIN`.

Endpoints:

Public:
- `GET /onboarding/:token/validate` — Validate token; lazily creates an `OnboardingSubmission` on first access. Returns `{ invite, submission }`.
- `GET /onboarding/:token/public-config` — Returns `{ ifieldsKey, mode, canTokenize, ifieldsVersion }` for card tokenization UI. Today `canTokenize=false` and `ifieldsKey=null` (card on file is optional).
- `PUT /onboarding/:token/save` — Autosave wizard state. Body: `{ currentStep?, answers? }` is preserved under a wizard envelope (JSON) for resume.
- `POST /onboarding/:token/upload-bill` — Multipart upload (field `file`) for optional latest bill. Stored via shared storage driver and linked as `OnboardingUploadedFile`.
- `POST /onboarding/:token/card` — Temporarily returns `{ error: "card_disabled" }` with 503. No raw PAN/CVV is ever stored.
- `POST /onboarding/:token/submit` — Finalize: validates required fields, rejects duplicate/non-numeric extensions, persists requested extensions, sets `smsMonthlyPriceCents` to 1000 when enabled, marks `status=SUBMITTED`, sets `submittedAt`, appends an onboarding event. Does not auto-create a tenant or touch PBX.

Admin:
- `GET /admin/onboarding/submissions` — List recent submissions (summary rows for admin table).
- `GET /admin/onboarding/submissions/:id/vitalpbx.csv` — Download VitalPBX extension CSV (validated, CSV-escaped).
- `GET /admin/onboarding/submissions/:id/files/:fileId/download` — Download stored onboarding artifact (e.g., uploaded bill). SUPER_ADMIN only; enforces submission/file match.

DB models: `OnboardingSubmission`, `OnboardingRequestedExtension`, `OnboardingUploadedFile`, `OnboardingEvent`.

Security notes:
- Tokens are high-entropy (48 hex chars). Expired/canceled/submitted tokens reject save/submit.
- Public routes never expose tenant/admin state; all writes are submission-scoped.

### Onboarding — Provisioning workspace (Phase 2)

Registered via `registerOnboardingProvisioningRoutes(app)` (end of `server.ts`). SUPER_ADMIN only.

- `GET /admin/onboarding/submissions/:id` — load a submission with requested extensions, files, and recent events.
- `GET /admin/onboarding/submissions` — list recent submissions (summary fields: counts, csvAvailable, hasCardOnFile).
- `POST /admin/onboarding/submissions/:id/status` — `{ status }` guarded by allowed transitions; appends a `STATUS_CHANGED` event.
- `POST /admin/onboarding/submissions/:id/checklist` — `{ checklist: Record<string, boolean> }`; persists JSON and appends `CHECKLIST_UPDATED`.
- `POST /admin/onboarding/submissions/:id/notes` — `{ notes }`; updates internal notes and appends `NOTE_ADDED`.
- `GET /admin/onboarding/submissions/:id/vitalpbx.csv` — CSV export using latest requested extensions; safe CSV escaping; deterministic filename.
- `GET /admin/onboarding/submissions/:id/files/:fileId/download` — admin-only file download; does not expose public URLs.
