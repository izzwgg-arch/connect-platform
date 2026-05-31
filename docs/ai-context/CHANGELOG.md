# Changelog

Tracks notable product and agent-delivered changes. Newest entry first.

---

## 2026-05-31 — CRM contact list/search scope filter

**Task:** CRM / permissions / contact list scope fix
**Risk:** high

### Root cause

The prior CRM permission audit scoped detail and mutation routes via `assertCrmContactAllowed`, but `GET /crm/contacts`, stats, phone lookup, and duplicate suggestions still queried all tenant contacts — restricted Agents could see names and totals for out-of-scope leads.

### What changed

- **`crmContactAccess.ts`:** added `resolveCrmContactScopeContext`, `buildCrmContactListScopeWhere`, `buildCrmContactMetaListScopeWhere`, and `mergeAndWhereClauses` — same assigned-or-allowed-campaign rules as single-contact access.
- **`contactRoutes.ts`:** list, stats, lookup, and duplicate candidate queries now apply scope filters; lookup also post-filters with `userCanAccessCrmContact`.
- **Tests:** `crmContactListScope.test.ts` (pure helpers + route contract tests).
- **Docs:** CRM permission matrix updated for list/search/stats scope.

### Deploy

Requires **`api`** only. No Prisma migration.

### Verify

```bash
pnpm --dir apps/api exec node --import tsx --test src/crm/crmContactListScope.test.ts src/crm/crmContactAccess.test.ts
```

Manual QA: restricted Agent — `/crm/contacts` and search show only assigned/in-campaign contacts; totals match visible rows; Manager sees full tenant list.

---

## 2026-05-31 — CRM Agent/Manager permission audit

**Task:** CRM / permissions / access audit (checklists, dispositions, email, templates, voicemail drops, scripts, live workspace)
**Risk:** high

### Root cause

Several CRM features were visible in the portal nav for Agent/Manager roles but API guards were inconsistent: voicemail drop upload/edit used platform-admin `requireCrmAdmin` instead of `requireCrmAccess`; contact-scoped actions (disposition, checklist respond, voicemail drop, notes, tasks, contact detail) did not call `assertCrmContactAllowed`; email template edit only honored platform JWT admin or creator, not CRM Manager; CRM Manager/Admin `CrmUserAccess.role` did not bypass campaign contact restrictions.

### What changed

- **Voicemail drops:** `POST/PATCH/DELETE /crm/voicemail-drops` now use `requireCrmAccess` so Agents/Managers can upload, rename, and archive tenant-scoped recordings. Drop-on-call still tenant-scoped; now also contact-scoped for restricted agents.
- **Contact scope:** `assertCrmContactAllowed` added to disposition, checklist respond, voicemail drop, contact detail GET, notes, and tasks. CRM MANAGER / CRM ADMIN bypass campaign allow-list within tenant via `crmRoleBypassesContactRestriction`.
- **Email templates:** `canEditTemplate` is async and grants edit on shared templates to CRM Manager/Admin (not only platform admins).
- **Portal:** `PermissionGate` added on `/crm/checklists`, `/crm/scripts`, `/crm/voicemail-drops`, `/crm/live-call` matching nav permissions.
- **Tests:** `crmPermissionAudit.test.ts`, expanded `scriptChecklistAccess.test.ts` and `crmContactAccess.test.ts`.
- **Docs:** CRM permission matrix added to `CRM.md`.

### Deploy

Requires **`api`** and **`portal`**. No Prisma migration.

### Verify

```bash
pnpm --dir apps/api exec node --import tsx --test src/crm/crmPermissionAudit.test.ts src/crm/scriptChecklistAccess.test.ts src/crm/crmContactAccess.test.ts src/crm/emailRoutes.crmAccess.test.ts
pnpm --dir packages/shared exec node --import tsx --test src/portalPermissions.crm.test.ts src/portalPermissions.crmEmail.test.ts
pnpm --dir apps/api typecheck
pnpm --dir apps/portal typecheck
```

Manual QA: log in as CRM Agent with campaign restriction — confirm visible actions work in-scope and return 403 out-of-scope; log in as CRM Manager — confirm upload voicemail, edit shared email template, set disposition; confirm `/crm/email/settings` and fleet diagnostics remain blocked for Agent/Manager.

---

## 2026-05-31 — CRM Email Template backend completion

**Task:** CRM / email templates / backend implementation
**Risk:** high

### Gap

The UI had controls for branding logos and template attachments, but the backend still needed the final production path: uploaded logos must not expose storage keys, final emails need inline logo images instead of expiring links, and attachment send behavior needed tighter tenant/template scoping and allowlist coverage.

### What changed

- **Branding logos:** API branding responses now resolve uploaded logos to a safe preview route and never return raw `logoStorageKey`. Final server-side renders use `cid:connect-crm-business-logo` for uploaded tenant logos.
- **Worker sends:** Gmail MIME construction now supports inline CID logo parts plus normal template attachments in the same multipart send.
- **Attachments:** ZIP was removed from the CRM template attachment allowlist. Allowed types are PDF, DOCX, XLSX, CSV, JPG, PNG, and WEBP.
- **Tenant isolation:** worker attachment loading now scopes selected attachment IDs by tenant and template, preventing cross-template/cross-tenant attachment injection.
- **Tests:** added focused storage, source-safety, shared rendering, and MIME tests for logo scoping, safe preview rendering, CID logo sends, ZIP rejection, attachment inclusion, cross-tenant scoping, missing merge values, and plain-template compatibility.

### Deploy

Requires **`api`** and **`worker`**. No new Prisma migration.

### Verify

```bash
pnpm --dir apps/api exec node --import tsx --test src/crm/emailTemplateAttachmentStorage.test.ts src/crm/emailTemplateRoutes.source.test.ts
pnpm --dir packages/shared exec node --import tsx --test src/crmEmailTemplates.test.ts
pnpm --dir apps/worker exec node --import tsx --test src/crmEmailSend.test.ts src/crmBulkEmail.test.ts
pnpm --dir apps/api typecheck
pnpm --dir apps/worker typecheck
```

Manual QA: upload branding logo, confirm API branding payload has `logoUrl` but no `logoStorageKey`; send a test email from a rich template and confirm the message includes the business logo inline; upload/send PDF/DOCX/XLSX/CSV/JPG/PNG/WEBP attachments; confirm ZIP upload is rejected; confirm another tenant/template attachment ID cannot be selected into a send.

---

## 2026-05-31 — CRM Email Template Builder UI polish

**Task:** CRM / email templates / UI polish
**Risk:** medium

### Gap

The CRM email builder had the right core feature set but still behaved like a dense first-pass implementation: one large page owned all state and panels, library cards lacked direct actions, autosave/dirty-state feedback was missing, and drag/drop/upload/preview affordances needed a more premium 2026 SaaS feel.

### What changed

- Split the templates page into reusable portal components under `apps/portal/components/crm/email/templates/`:
  - `TemplateLibraryPanel`
  - `EmailBuilderCanvas`
  - `EmailPreviewPanel`
  - `UtilityPanels`
  - `StarterTemplatesStrip`
- Polished the three-panel layout, library cards, hover states, shadows, compact filters, inline favorite/rename/duplicate/archive/restore actions, and responsive behavior.
- Added autosave/dirty-state UI, before-unload protection for unsaved edits, drag/drop block insertion, drag/drop attachment/logo upload affordances, and upload progress feedback.
- Improved Branding, Attachments, Merge Fields, AI Assistant, and live preview panels without changing schema or API contracts.

### Deploy

Requires **`portal`** only. No Prisma migration and no backend deploy required for this polish pass.

### Verify

```bash
pnpm --dir apps/portal typecheck
pnpm --dir packages/shared exec tsx --test src/crmEmailTemplates.test.ts
pnpm --dir apps/worker exec tsx --test src/crmBulkEmail.test.ts
```

Manual QA still recommended for `/crm/email/templates`: desktop/tablet/mobile layout, create/edit, autosave, duplicate, archive/restore, send test, logo upload, attachment upload, merge insert/copy, AI actions, and live preview modes.

---

## 2026-05-31 — CRM Email Template Builder rebuild

**Task:** CRM / email templates / UI rebuild / attachments / branding
**Risk:** high

### Gap

`/crm/email/templates` was still a Phase 1 plain-text CRUD form backed by `CrmEmailTemplate.bodyText`, and CRM Gmail sending emitted `text/plain` only. There was no reusable CRM branding, visual builder content, server-side merge contract, template attachments, starter gallery, or professional HTML email rendering.

### What changed

- **Data model:** added backward-compatible CRM email template metadata (`category`, favorite/draft flags, preview text, usage tracking, HTML/body JSON), tenant branding, per-user signature, and tenant-scoped template attachments.
- **API:** template routes now support rich fields, duplicate/archive/send-test, starters, branding/signature save, attachment upload/remove, merge field discovery, and real AI generation when `OPENAI_API_KEY` is configured.
- **Rendering:** CRM sends can render server-side HTML + plain-text fallback and include template attachments in Gmail multipart MIME.
- **Portal:** `/crm/email/templates` is now a three-panel no-code builder matching the mockup structure: template library, visual TipTap builder with block rail, live desktop/mobile preview, and bottom Branding/Attachments/Merge Fields/AI panels.
- **Compatibility:** compose and bulk email paths remain compatible with existing plain-text templates while tolerating new rich template fields.

### Migration

- `packages/db/prisma/migrations/20260610120000_crm_email_builder`

### Deploy

Requires **`api`**, **`worker`**, and **`portal`**. Prisma migration is required and should be run by the API deploy job only.

### Verify

```bash
pnpm --dir packages/shared exec tsx --test src/crmEmailTemplates.test.ts
pnpm --dir apps/worker exec tsx --test src/crmBulkEmail.test.ts
pnpm --dir apps/portal typecheck
pnpm --dir apps/api typecheck
pnpm --dir apps/worker typecheck
```

Manual QA: create blank/starter templates, save draft/template, add branding/signature, insert merge fields, upload PDF/XLSX/image attachment, preview desktop/mobile, send test email, confirm HTML email and attachment delivery, confirm Agent/Manager access and settings admin-only behavior.

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
