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
- `GET /mobile/android/latest` (3886)

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
| `/voice/moh/*` | 23 | MOH profile/schedule/override + publish + rollback + assets. **EXTREME** — same path as IVR. |
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

---

## Voicemail (top-level)

**Approx lines:** 14512 – 14767
**Purpose:** mailbox listing, greeting upload/download, voicemail playback. Distinct from `/voice/voicemail/*` admin endpoints.
**Auth requirements:** JWT.
**Risk:** **HIGH** — touches recordings and audio assets per-tenant.

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
  `helper_count`, `source_used`, `fallback_reason`.

**On-PBX helper (not in `server.ts`):** `POST /voicemail/spool/list` — HMAC header
`x-connect-pbx-helper-secret`; JSON body `tenantId`, `extension`, optional `voicemailContext`
/ `context`. Read-only; lists `msg*.txt` under `INBOX` / `Old` / `Urgent`. Installed by
`scripts/pbx/install-vitalpbx-inbound-route-helper.sh`.

---

## Billing (top-level inline + delegated routes)

**Approx lines:** 21595 – 27438 (inline) + delegated under `apps/api/src/billing/routes.ts` (registered at line ~30198)
**Purpose:** invoices, payment methods, billing runs, payment events, ledgers, plan management.
**Auth requirements:** admin/owner JWT; webhook routes use signature verification.
**Risk:** **EXTREME** — touches `BillingInvoice`, `PaymentTransaction`, `PaymentEvent`, ledgers. Mis-firing a billing route can charge or refund real money.
**Key endpoints:** 22 inline + many more in `billing/routes.ts`. Always read `apps/api/src/billing/routes.ts` directly when working in this area.

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
