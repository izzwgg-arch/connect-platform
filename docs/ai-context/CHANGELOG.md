# Changelog

Tracks notable product and agent-delivered changes. Newest entry first.

---

## 2026-05-30 — CRM Email access for Agent and Manager roles

**Task:** CRM / email / permissions / UI  
**Risk:** medium

### Gap

CRM Email sidebar and routes required `can_view_crm_settings` (CRM Admin bucket only). CRM Agent and CRM Manager could not reach templates, send flows, or the Email nav item despite having CRM access.

### What changed

- **Shared permissions:** `can_view_crm_email` added to `can_view_crm` and `can_manage_crm` expansions (`packages/shared/src/portalPermissions.ts`). CRM Admin retains `can_view_crm_settings` for settings/wallboard only.
- **Portal:** `navConfig` CRM Email → `can_view_crm_email`; `PermissionGate` on `/crm/email` and `/crm/email/templates`; `/crm/email/settings` gated by `can_view_crm_settings`; agents connect USER Gmail from landing page (OAuth redirect → `/crm/email`).
- **API:** All `/crm/email/*` routes (except OAuth callback) use `requireCrmAccess`; `POST /crm/email/send` uses `assertCrmContactAllowed` (campaign/assignment scope); fleet diagnostics use `requireCrmEmailSettingsAccess` (platform admin or CrmUserAccess ADMIN).
- **Shared helper:** `apps/api/src/crm/crmContactAccess.ts` (reused by inbound caller match).

### Deploy

Requires **`api`** and **`portal`**. No Prisma migration.

### Verify

```bash
pnpm --dir packages/shared exec node --import tsx --test src/portalPermissions.crm.test.ts src/portalPermissions.crmEmail.test.ts
pnpm --dir apps/api exec node --import tsx --test src/crm/crmContactAccess.test.ts src/crm/emailRoutes.crmAccess.test.ts src/crm/emailRoutes.test.ts
```

1. CRM Agent — sidebar **Email**, `/crm/email`, `/crm/email/templates`; no `/crm/email/settings`.
2. CRM Manager — same; no CRM settings unless CRM Admin role.
3. Send to contact outside agent campaign scope → API `403`.
4. CRM Admin / tenant admin — settings + fleet diagnostics still work.

---

## 2026-05-30 — Inbound CRM caller ID on dialer + telephony WS

**Task:** Telephony / CRM / dialer UI  
**Risk:** high

### Gap

Inbound calls showed only PBX/SIP caller ID. CRM lead names and profile links were not on the telephony WebSocket payload, and the floating dialer had no permission-safe server match.

### What changed

- **API:** `apps/api/src/crm/inboundCallerMatch.ts` — tenant-scoped phone match (E.164 + exact `ContactPhone`, safe last-10 suffix), per-viewer CRM/campaign access filter; internal `POST /internal/telephony/inbound-crm-match` (CDR secret).
- **Telephony:** `CrmInboundCallerEnricher` — per-WS-client enrichment on `telephony.call.upsert` and snapshots; optional fields `crmContactId`, `crmContactName`, `crmCompanyName`, `crmProfileUrl`, `crmMatchSource` (inbound only).
- **Portal:** Floating dialer + `ActiveCallsPanel` prefer CRM display name; compact **Open CRM Profile** on matched inbound calls; `CrmScreenPop` uses WS fields first.

### Deploy

Requires **`api`** and **`telephony`** (same `CDR_INGEST_URL` / `CDR_INGEST_SECRET` as CDR ingest). No Prisma migration.

### Verify

```bash
pnpm --dir apps/api exec node --import tsx --test src/crm/inboundCallerMatch.test.ts
pnpm --filter @connect/telephony test
pnpm --dir apps/portal exec vitest run lib/crmInboundCallDisplay.test.ts
```

1. CRM-enabled tenant, contact with primary phone matching inbound DID.
2. Ring extension from that number — floating dialer shows contact name + **Open CRM Profile**.
3. User without CRM access or campaign assignment — no CRM fields on WS payload, no button.

---

## 2026-05-30 — CRM lead timezone: Arizona/Phoenix display polish

**Task:** CRM / leads / timezone UI polish  
**Risk:** low

### Gap

Phoenix (`America/Phoenix`) was stored and displayed as generic **Mountain / MT**, which implies DST. Arizona does not observe DST and needs a distinct display label while staying in the Mountain filter bucket.

### What changed

- `America/Phoenix` now stores `timezoneLabel: "Arizona"` (Denver remains `"Mountain"`).
- Mountain filter (`timezoneZone=mountain`) matches labels `Mountain` + `Arizona` and IANAs `America/Denver`, `America/Boise`, `America/Phoenix` (includes legacy Phoenix rows still labeled Mountain).
- Row badge: Phoenix → **AZ**; detail → **Arizona (MST)** with tooltip noting no DST.
- Shared display helpers: `leadTimezoneBadgeShort`, `leadTimezoneDetailLabel` (API + portal).

### Verify

```bash
pnpm --dir apps/api exec node --import tsx --test src/crm/leadTimezoneResolver.test.ts
```

---

## 2026-05-30 — CRM lead timezone resolution + filtering

**Task:** CRM / leads / data normalization / filtering  
**Risk:** medium

### Gap

CRM leads stored city/state on `ContactAddress` but had no derived timezone, no server-side persistence, and no list filtering by US timezone bucket.

### What changed

- Added timezone fields on `CrmContactMeta`: `timezoneIana`, `timezoneLabel`, `timezoneOffsetMinutes`, `timezoneResolvedAt`, `timezoneResolutionStatus`.
- Added deterministic US resolver (`city-timezones` dataset) in `apps/api/src/crm/leadTimezoneResolver.ts`.
- Timezone sync runs on lead create, lead update when city/state changes, CSV import rows, and admin backfill.
- `GET /crm/contacts` accepts `timezoneZone`, `timezoneLabel`, and `timezoneIana` filters (tenant-scoped via existing `crmMeta.tenantId`).
- `GET /crm/campaigns/:id/members` accepts the same timezone query params for campaign-safe roster filtering.
- CRM contacts list UI adds a timezone dropdown and compact row badge; contact detail shows timezone near address.
- Admin backfill: `POST /crm/admin/lead-timezone/backfill?dryRun=true&limit=200&cursor=`.

### Migration

- `packages/db/prisma/migrations/20260609000000_crm_lead_timezone`

### Verify

```bash
pnpm --dir apps/api exec node --import tsx --test src/crm/leadTimezoneResolver.test.ts src/crm/leadTimezoneService.test.ts
```

Backfill (CRM admin JWT):

```bash
curl -s -X POST "$API/crm/admin/lead-timezone/backfill?dryRun=true&limit=50" -H "Authorization: Bearer $JWT"
```

Filter example:

```bash
curl -s "$API/crm/contacts?timezoneZone=eastern&limit=10" -H "Authorization: Bearer $JWT"
```

### Deliberately not changed

- Telephony, billing, worker jobs, VitalPBX, mobile.
- Frontend-only timezone calculation (all values stored server-side).
