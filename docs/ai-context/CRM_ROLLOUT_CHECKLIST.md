# CRM Rollout Checklist

> Verified in Phase 6A (2026-05-12). Run this checklist against a real tenant before
> declaring the CRM module production-ready for a new tenant.

---

## 1. CRM Enablement

| Step | How to verify |
|------|--------------|
| Admin navigates to `/crm/settings` | CRM layout gate shows "CRM is not enabled" with an **Enable CRM** button |
| Admin clicks **Enable CRM** | `PUT /crm/settings { enabled: true }` → 200. Page shows settings panel. |
| Admin toggles a user ON in the user access table | `PUT /crm/users/:userId { enabled: true }` → 200. Toggle shows enabled. |
| Enabled user logs out + back in (or portal refreshes `/me`) | CRM nav section appears in sidebar |
| Disabled user stays out | CRM nav NOT shown. Direct navigation to `/crm/*` → redirected to `/dashboard` |
| API access: disabled user calls `GET /crm/contacts` | 403 `crm_user_not_enabled` |
| API access: non-CRM tenant calls any CRM route | 403 `crm_not_enabled` |

---

## 2. Contacts

| Step | How to verify |
|------|--------------|
| Create contact via **Add Contact** button | `POST /crm/contacts` → 201. Contact appears in list. |
| Add phone to contact | Click `+ Phone` on contact detail → `POST /crm/contacts/:id/phones` → 201 |
| Add email to contact | Click `+ Email` on contact detail → `POST /crm/contacts/:id/emails` → 201 |
| Edit display name / company inline | Click pencil → save → `PATCH /crm/contacts/:id` → field updated |
| Search contacts | Search box filters list, server-side query returns correct results |
| Contact detail page loads | Shows phones, emails, stage, timeline |
| Stage change | Change stage dropdown → `PATCH /crm/contacts/:id { stage: "CONTACTED" }` → `STAGE_CHANGED` appears in timeline |

---

## 3. Import

| Step | How to verify |
|------|--------------|
| Upload CSV with `phone` + `name` columns | `POST /crm/import/upload` (multipart) → batch returned with `imported` count |
| Duplicate phone in import | No duplicate `Contact` or `ContactPhone` row created; existing contact updated/enrolled |
| Duplicate email in import | Same as phone — deduplicated |
| Import batch visible in history | `GET /crm/import/batches` → batch row with status |

---

## 4. Timeline

| Step | Expected timeline event |
|------|------------------------|
| Create contact | `CONTACT_CREATED` |
| Change stage | `STAGE_CHANGED` with `metadata.from` / `metadata.to` |
| Save note | `NOTE_ADDED` with note body |
| Create task | `TASK_CREATED` |
| Complete task | `TASK_COMPLETED` |
| Save checklist response | `CHECKLIST_COMPLETED` |
| Save outcome/disposition | `DISPOSITION_SET` |
| Inbound CDR fires for contact's phone | `CDR_INBOUND` with call metadata |
| Individual assignment change | `ASSIGNED_TO_USER` with `fromName`/`toName` metadata |
| Bulk reassign | NO timeline event (intentional — too noisy) |
| Merge contacts (admin) | `CONTACT_MERGED` on `keepContact` |
| Unknown event type in UI | Renders with **Clock** icon, does not crash |

---

## 5. Live Workflow

| Step | How to verify |
|------|--------------|
| Inbound call → screen pop | `GET /crm/contacts/lookup?phone=…` returns matched contact(s) |
| Open Live Workspace | `/crm/live-call?contactId=…` loads contact card, open tasks, timeline, script, checklist |
| Script loads | Select a script from dropdown → body renders |
| Checklist loads | Select checklist → items render with checkboxes |
| Save note | Note body textarea → **Save Note** → `POST /crm/contacts/:id/notes` → `NOTE_ADDED` in timeline |
| Save outcome | Select disposition → **Save Outcome** → `POST /crm/contacts/:id/disposition` → `DISPOSITION_SET` in timeline |
| Follow-up task created | Outcome with follow-up date → task appears in Open Tasks |
| CRM Call button | Dispatches `crm:dial` CustomEvent → `FloatingDialer` listens → `phone.dial()` fires |

---

## 6. Campaign / Queue

| Step | How to verify |
|------|--------------|
| Create campaign | `POST /crm/campaigns` → campaign in list |
| Add contacts to campaign | Campaign detail → Add Contacts button → `POST /crm/campaigns/:id/members/add` |
| Assign members to agent | Bulk assign → `POST /crm/campaigns/:id/members/bulk-assign` |
| Queue shows assigned leads | Agent opens `/crm/queue` → sees PENDING members assigned to them |
| Open workspace from queue | Click **Work** → `/crm/live-call?contactId=…&memberId=…&campaignId=…` |
| Outcome updates member status | Save Outcome → `POST /crm/contacts/:id/disposition` + `PATCH /crm/queue/:memberId { action: "outcome" }` |
| Callback scheduling | Outcome with "Callback" + date → member `callbackAt` set, member appears in **Due** tab |
| Export CSV | `GET /crm/campaigns/:id/export.csv` → downloads CSV with all members |
| Campaign auto-completes | When all **live-contact** non-terminal work is done (Phase 16D) — `PENDING`/`IN_PROGRESS`/`CALLBACK` only on active, non-archived contacts — campaign may become `status: "COMPLETED"` (also re-checked after contact soft-archive). |
| Campaign CSV import preview (17A) | Admin opens Import CSV on campaign detail → select file → **Preview import** → `POST /crm/campaigns/:id/import/preview` returns counts + sample rows (no DB writes) → **Run import** stays disabled until preview succeeds for that file **and assignee** → final **Run import** calls `POST /crm/campaigns/:id/import`. |
| Campaign CSV import preview UX (17B) | Preview shows **bucket cards** (new contacts, updated, new members, already in campaign, invalid rows), **warnings** when invalid or already-enrolled rows > 0, **grouped sample tables** by outcome (fallback flat table if grouping is not possible), **Ready to import** only when preview matches current file+assignee. After import, **comparison table** preview vs actual with mismatch callout if core totals diverge. |
| Campaign import history (17C) | Campaign detail shows **Recent imports**: rows from `GET /crm/campaigns/:id/imports` only; **Batch details →** opens `/crm/import?batch=…` (full batch from `GET /crm/import/batches/:id`). Empty state when no tagged batches. |
| Import batch drilldown (17D) | `/crm/import?batch=` shows **Import batch detail** (file, who, when, status, counts, campaign vs standalone, link to campaign). Row issues only from stored `errors`; if totals imply issues but `errors` is empty, UI states that row-level detail is unavailable—no fake rows. Recent Imports list highlights the linked batch and offers **Batch detail →**. |

### Phase 17A — Campaign CSV import preview (smoke)

| Check | Expected |
|-------|----------|
| Preview dry-run | `POST .../import/preview` with test CSV → **200**; response has `wouldCreateContacts` / `wouldUpdateContacts` / `wouldAddMembers` / `wouldSkipExistingMembers`; **no** new `CrmImportBatch` row and **no** new contacts or members until real import. |
| Changing file | After choosing a different CSV, preview panel clears and **Run import** disabled until preview again. |
| Changing assignee | After **Assign new members to** changes, preview clears; **Run import** disabled until preview again. |
| Real import unchanged | `POST .../import` still creates batch, contacts, and members as before; totals should align with preview for the same file (allow minor timing if DB changed between calls). |

### Phase 17B — Import preview clarity (UI smoke)

| Check | Expected |
|-------|----------|
| Bucket summary | Preview panel shows distinct counts for new contacts, contacts updated, new campaign members, already in campaign, and invalid rows. |
| Warnings | If `invalidRows > 0` or `wouldSkipExistingMembers > 0`, amber warning copy appears (not hidden). |
| Sample grouping | Sample rows render in outcome groups when `outcome` / `member` are present; otherwise a single flat table with an honest caption. |
| Import guard | **Run import** disabled until preview succeeded for the current CSV **and** assignee selection. |
| Post-import compare | After a successful import, modal shows preview vs actual table; **Data may have changed since preview** appears when created/updated/added/skipped counts diverge. |

### Phase 17C — Campaign import history (smoke)

| Check | Expected |
|-------|----------|
| API empty | `GET /crm/campaigns/:id/imports` on campaign with no CSV imports → **200**, `imports: []`. |
| API populated | After `POST /crm/campaigns/:id/import`, same campaign → newest batch appears with correct `fileName` (human name, no `campaign:…` prefix), counts, status, `createdBy`. |
| Tenant scope | Unknown or other-tenant `campaignId` in the URL path → **404** `not_found`. Listed batches are always `tenantId`-scoped. |
| Portal panel | **Recent imports** lists same data; **Batch details** deep-links to Import Leads with batch expanded. |
| No fake rows | Panel must **not** list imports inferred only from membership changes. |

### Phase 17D — Import batch detail drilldown (smoke)

| Check | Expected |
|-------|----------|
| API shape | `GET /crm/import/batches/:id` returns `importSource`, `campaignId`, display `fileName`, counts, `errors`, `mapping` when present. |
| 404 | Invalid id → **404**; portal shows safe not-found copy (no stack). |
| Detail UI | `/crm/import?batch=<id>` loads detail card; **Clear link** returns to bare Import Leads. |
| Honest gaps | If `errorCount` or `skippedCount` > 0 but `errors` is empty, amber notice explains row-level data missing—no invented rows. |
| List | Recent Imports keeps listing; highlighted row matches `?batch=`; **Batch detail →** on each card. |

### Phase 18A — CRM Command Center dashboard (smoke)

| Check | Expected |
|-------|----------|
| Route | `/crm/dashboard` loads for CRM users with `can_view_crm_dashboard`; layout gating unchanged (CRM off → existing enable panel). |
| Command strip | Greeting + **Today** line uses `GET /crm/reports/daily` (calls linked, dispositions, new contacts); links to `/crm/reports` where allowed. |
| Next up | Overdue / due chips match tenant admin (`follow-ups`) vs agent (`tasks/stats` buckets); no full-width alert banner for the happy path. |
| KPI row | Tiles show real counts only (campaigns, leads, queue workload, imports today when import permission, outcomes, calls linked); drilldown links unchanged in spirit (`/crm/campaigns?status=ACTIVE`, `/crm/contacts?stage=LEAD`, queue, import, reports). |
| Work columns | Queue preview uses `GET /crm/queue` overdue + due (smart sort, limit 4); campaigns lists paused + active from `GET /crm/campaigns`; recent imports from `GET /crm/import/batches?limit=8`. |
| Admin health | Compact **Workspace health** row still reflects `GET /crm/admin/pilot-readiness` + settings. |
| No polling | Hard reload — no `setInterval` / polling added on this page. |
| Typecheck | `pnpm exec tsc -p apps/portal` passes. |

### Phase 18B — My Queue SaaS UX (smoke)

| Check | Expected |
|-------|----------|
| Route | `/crm/queue` loads; data from existing `GET /crm/queue` (and related) only — no placeholder leads or fake recommendations. |
| Work header (manual) | **My Queue** title, compact counts (pending / due / overdue / upcoming), smart vs original sort, campaign filter, refresh — visually grouped, not a dense default table as the primary surface. |
| Next best lead | First queue item shown as the primary card with contact, campaign, stage, priority reason, attempts / last attempt, callback when set; **Open workspace**, **Call** only when SIP ready, outcome / skip / defer / DNC per existing gates; archived / `queueWorkEligible === false` rows read-only, not actionable. |
| Queue list | Remaining items as compact cards or split layout — scanable, no wide table overflow as the default experience on tablet width. |
| Empty states | Contextual copy (e.g. no due / caught up / switch to pending) with real navigation to filters — no invented coaching. |
| Power mode | Sticky session bar, pause and wrap-up behavior unchanged; due/overdue filter toggle intact; SIP gating and keyboard guards unchanged; no auto-dial. |
| Power campaign | Campaign filter available in power mode (same `campaignId` / clear behavior as manual). |
| Typecheck | `pnpm exec tsc -p apps/portal` passes. |

### Phase 18C — Campaign detail SaaS UX (smoke)

| Check | Expected |
|-------|----------|
| Route | `/crm/campaigns/[id]` loads; campaign, members, imports, and workload data from existing CRM APIs only — no fabricated metrics. |
| Hero | Campaign name, status, priority, description or factual status line; primary actions: **Import leads** (admin), **Add existing contacts**, **Distribute leads** (admin), **View My Queue** with `campaignId` filter; secondary: start/pause/resume, archive, export CSV. |
| Health row | Tiles use real `statusCounts` / `memberCount`; unassigned total from admin `GET .../workload` when available; callback count labeled as CALLBACK status (not implied overdue totals); progress line uses converted / total and honest import timestamp. |
| Next operational actions | Conditional rows only (unassigned → distribute / filter; CALLBACK → queue due/overdue links; empty campaign → import/add; optional high-pending note). No fake “insights.” |
| Settings | Script, checklist, smart priority in collapsible **Campaign settings** — same `PATCH` behavior as before. |
| Recent imports | Phase 17C data unchanged; card-style list; **Batch details →** still links to `/crm/import?batch=`. |
| Members | Compact cards (not primary wide table); archived / `queueWorkEligible === false` remains non-actionable; status `PATCH`, callback cell, bulk assign, filters, and workspace link unchanged. |
| Workload (admin) | Scannable cards per assignee row from `GET .../workload`; **Redistribute unassigned** opens existing distribute modal. |
| Import modal | Preview / import guard and Phase 17A/17B preview UI unchanged (`POST .../import/preview`, `POST .../import` via portal proxy). |

### Phase 18D — Campaigns index SaaS UX (smoke)

| Check | Expected |
|-------|----------|
| Route | `/crm/campaigns` loads; list data from `GET /crm/campaigns` only — summary tiles and cards use fields returned by that response (status counts and `memberCount` aggregated client-side); no contacted/converted/progress on the index unless the list API adds those fields. |
| Command header | Title **Campaigns**, short operational subtitle, primary **New campaign** for CRM admins only (`ADMIN` / `TENANT_ADMIN` / `SUPER_ADMIN`); secondary **Import leads** when `can_view_crm_import`, **My Queue** when `can_view_crm_queue` — no promotional banners. |
| Summary row | Tiles for Active, Paused, Completed, Draft, Archived, and **Members (this list)** from the loaded campaigns array; footnote explains API default (All statuses excludes archived until Archived filter). |
| Filters | Status filter and name search remain compact; no new sort unless added elsewhere. |
| List | Card-style rows (not a dense primary table); each row: name, status, priority, members, updated/created, **Open campaign** and **View queue** (`?campaignId=`) when queue permission; Start/Pause/Resume/Archive only for admins. |
| Empty states | No campaigns: create/import guidance; filtered-by-search empty: clear search — professional copy, no fake metrics. |
| Typecheck | `pnpm exec tsc -p apps/portal` passes. |

### Phase 18E — Contacts index SaaS UX (smoke)

| Check | Expected |
|-------|----------|
| Route | `/crm/contacts` loads; data from `GET /crm/contacts` only — summary and cards use fields returned by that response (`total`, rows); no engagement scores or invented tenant-wide health. |
| Command header | Title **Contacts**, short operational subtitle, primary **New contact**; **Import leads** when `can_view_crm_import`; no promotional banners. |
| Summary | Compact strip: server **matching** total + **showing** range; **Active (page)** / **Archived (page)** (admin) / missing phone & email on page; stage line; footnote stays honest about page scope — not a giant KPI grid. |
| Pagination | **Previous / Next** uses existing `page` query (0-based) + `limit` 50; changing filters resets to page 0. |
| Filters | Prominent search (debounced); stage chips; **Assigned to me**; admin-only **Active / Archived / All** toggles map to existing `includeArchived` / `archivedOnly` query params; non-admin never sees archived scope. |
| List | Card-style rows (not a dense primary table); each row: name, primary phone/email, company, CRM stage, last activity when present; **Open contact**; **Workspace** link only when `can_view_crm_live_call` and contact is not archived; archived rows muted + badge. |
| Empty states | Zero directory vs filtered vs archived-empty — contextual copy and real actions (new/import, clear search, switch to Active); no fake suggestions. |
| Bulk assign | Admin-only bulk reassign behavior unchanged if present; archive/restore remains on detail page unless bulk already existed. |
| Typecheck | `pnpm exec tsc -p apps/portal` passes. |

### Phase 18F — Contact detail SaaS UX (smoke)

| Check | Expected |
|-------|----------|
| Route | `/crm/contacts/[id]` loads; all data from existing CRM contact/timeline/tasks/SMS APIs — no fabricated activity or AI summaries. |
| Command header | Name, stage, archived/DNC badges, primary phone/email, lifecycle subtitle (**last activity** copy only when `lastActivityAt` is present); primary actions: **Workspace** when `can_view_crm_live_call` and not archived, **Add note**, **Schedule task**, **Send SMS** when not blocked; **Edit fields** + calm **Archive** / **Restore** (admin) secondary. |
| Quick facts | Real fields only: phone/email counts, stage, owner, last activity timestamp or em dash, SMS allowed vs opt-out. |
| Next step | Rule-based card only (archived read-only, add phone, open/due task, SMS opt-out messaging, or catch-up note) — no scoring or recommendations beyond listed rules. |
| Timeline | Scan-friendly card rows; recordings + SMS metadata unchanged; note edit/delete still author-gated. |
| SMS | Conversation + composer stay Phase 11C–compatible; integrated panel styling; opt-out and archived read-only messaging; composer hidden/disabled when archived or `doNotSms`. |
| Tasks / notes | Same `POST`/`PATCH`/`DELETE` behavior; archive hides mutating controls where applicable. |
| Typecheck | `pnpm exec tsc -p apps/portal` passes. |

### Portal Tailwind — Phase 18 styling (smoke)

| Check | Expected |
|-------|----------|
| Build | `apps/portal` has `tailwind.config.js`, `postcss.config.js`, `@tailwind` in `globals.css`, `preflight: false`; production CSS includes utilities (`.flex`, `.grid`, `.rounded-2xl`, `.bg-white`, `.gap-4`). |
| `/crm/contacts` | Card/flex layout — not unstyled bullet list. |
| `/crm/queue` | Queue member cards styled — not raw white bars. |
| `/crm/campaigns` | Command header + summary grid styled. |
| `/crm/contacts/[id]` | Hero / quick facts / Next step panels styled. |
| `/crm/dashboard` | Command center unchanged; dark shell not reset by Tailwind preflight. |

### Phase 19A — CRM unified SaaS theme (smoke)

| Check | Expected |
|-------|----------|
| Theme | All Phase 19A routes use dark `bg-crm-surface` cards — no white/gray-50 page backgrounds or card shells. |
| Dashboard | Command center uses `CRMCard` / `CRMPageShell`; matches queue/contacts card radius and borders. |
| Queue | Power dialer bar uses `crm-surface-2` (not bright blue banner); member cards share border/radius with contacts. |
| Campaigns index + detail | Headers, summary tiles, member rows, import preview modal — same surface system. |
| Contacts index + detail | List cards, filters, hero, Next step, timeline rows — dark surfaces only. |
| Workspace fit | Sidebar/topbar unchanged; CRM content does not look like a separate light admin app. |
| Function | Filters, queue actions, campaign controls, contact mutations, recordings, archive read-only — unchanged. |
| Typecheck | `pnpm exec tsc -p apps/portal` passes. |

---

## 7. Reports

| Step | How to verify |
|------|--------------|
| Reports page loads | `/crm/reports` renders without error |
| Daily report — empty tenant | `GET /crm/reports/daily` → 200, all counts zero |
| Daily report — populated tenant | Non-zero calls, dispositions |
| Campaign report | `GET /crm/reports/campaigns` → per-campaign summary |
| Agent report | `GET /crm/reports/agents` → per-agent performance |
| Follow-up report | `GET /crm/reports/follow-ups` → overdue + due-today tasks |

---

## 7A. First-day pilot dashboard (Phase 15A)

**Phase 18A portal note:** the dashboard UI is now a **Command Center** layout (hero, KPI tiles, focused work lists). API expectations below still apply; the large multi-card **Pilot readiness** grid is replaced by a compact **Workspace health** row for admins.

| Step | How to verify |
|------|--------------|
| CRM dashboard copy | `/crm/dashboard` surfaces priorities, live snapshot, and shortcuts (command-center framing). |
| Admin readiness cards | Log in as TENANT_ADMIN/ADMIN. **Workspace health** shows CRM enabled, CRM user count, active campaigns, tenant queue depth, tenant overdue callbacks. SMS appears in the same row only when applicable. |
| Admin-only API | `GET /crm/admin/pilot-readiness` → 200 for admins; → 403 `crm_permission_denied` for agents. |
| Agent readiness cards | Agent sees **My queue depth**, **Team queue**, **My overdue callbacks** (not tenant-wide callback totals). |
| Agent alert strip | Non-admin strip uses per-user callback + task buckets from `GET /crm/tasks/stats` (not tenant-wide `follow-ups`). |
| Admin vs agent actions | **Admin — start here** lists only links the role may access (`can()` gates + platform admin for Diagnostics). **Agent — start here** lists queue, contacts, live workspace per permissions. |
| Empty campaign CTA | With zero ACTIVE campaigns, admins see **Create or import a campaign** linking `/crm/campaigns`. |
| Empty queue message | Agent with zero `queueRemaining` sees the manager-assign hint. |
| Overdue CTA | Personal overdue callbacks link `/crm/queue?filter=overdue`; manual queue honors `?filter=` on first paint. |
| No polling | Hard reload dashboard — no background interval for these panels. |

---

## 8. Safety Checks

| Check | Result |
|-------|--------|
| No duplicate Fastify route registrations | ✅ Phase 5C removed the placeholder duplicate `GET /crm/contacts/:id/timeline` |
| Every CRM route uses a guard | ✅ guard count ≥ route count in every `*Routes.ts` file |
| No cross-tenant leakage | ✅ All Prisma queries use `tenantId` from JWT |
| CDR hook is non-blocking | ✅ `fireCrmCdrHook(...).catch(() => {})` — never awaited in CDR ingest path |
| Telephony untouched | ✅ No AMI/ARI/SIP/WebRTC files modified in CRM phases |
| Admin bypass in `requireCrmAccess` | ✅ `isAdminRole()` check — ADMIN/TENANT_ADMIN/SUPER_ADMIN skip CrmUserAccess lookup |
| `requireCrmAdmin` for destructive ops | ✅ Merge, bulk-reassign, import management use `requireCrmAdmin` |

---

## 9. Known Limitations (non-blockers)

- **Bulk reassign** does not write `ASSIGNED_TO_USER` timeline events (intentional — prevents noise for multi-hundred-contact operations).
- The `PATCH /crm/queue/:memberId` update (line 805 campaignRoutes.ts) uses `where: { id: memberId }` without `tenantId` in the final `update` call. The tenant is verified in the prior `findFirst`, so it is safe from cross-tenant mutation but slightly fragile under theoretical race conditions. Acceptable for current scale.
- CRM nav only appears after the user's next `/me` refresh (the permission is not yet live-pushed). Agents should re-login or hard-reload after being granted CRM access for the first time.

---

---

## 10. Migration Safety (Phase 6B — pre-rollout confirmation)

| Migration | Applies | Safe? |
|-----------|---------|-------|
| `20260522000000_crm_foundation` | Creates `CrmTenantSettings`, `CrmUserAccess` | ✅ New tables only |
| `20260522010000_crm_contact_meta` | Creates `Contact`, `CrmContactMeta`, `CrmContactPhone`, `CrmContactEmail` | ✅ New tables only |
| `20260522020000_crm_timeline_notes` | **Creates `CrmTimelineEventType` enum**, `CrmTimelineEvent`, `CrmContactNote` | ✅ New tables + enum |
| `20260522030000_crm_tasks` | Adds `TASK_*` to enum; creates `CrmContactTask` | ✅ Additive only |
| `20260522040000_crm_import` | Creates `CrmImportBatch`, `CrmImportRow` | ✅ New tables only |
| `20260522050000_crm_cdr_dedup_index` | Adds partial unique index for CDR dedup | ✅ Additive only |
| `20260522060000_crm_scripts_checklists` | Adds `CHECKLIST_COMPLETED`; creates script/checklist tables | ✅ Additive only |
| `20260522070000_crm_disposition` | Adds `DISPOSITION_SET`; adds columns to `CrmContactMeta` | ✅ Additive only |
| `20260522080000_crm_campaigns` | Creates `CrmCampaign`, `CrmCampaignMember` | ✅ New tables only |
| `20260522090000_crm_campaign_member_callback` | Adds `callbackAt`, `callbackNote` to `CrmCampaignMember` | ✅ Additive only |
| `20260522100000_crm_caller_id_pool` | Creates `CrmCallerIdPool` | ✅ New table only |
| `20260522110000_crm_contact_merged_event` | Adds `CONTACT_MERGED` to enum | ✅ Additive only |
| `20260522120000_crm_assigned_to_user_event` | Adds `ASSIGNED_TO_USER` to enum | ✅ Additive only |

**No migration drops any table, column, or enum value. All are additive.**

> **Note:** The two enum-extension migrations were originally timestamped `20260512*` (Phase 5A/5C)
> which would have run before the `CREATE TYPE` in `20260522020000`. This was fixed in Phase 6B:
> they were moved to `20260522110000` / `20260522120000` to guarantee correct order on fresh installs.

---

## 11. Rollback Expectations

Because all CRM migrations are **purely additive**, a DB-level rollback is not needed and not safe.

**Rollback = disable the CRM tenant flag via API:**

```bash
# Disable CRM for a tenant (admin JWT required)
curl -s -X PUT https://app.connectcomunications.com/api/crm/settings \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

This hides the CRM nav, blocks all CRM API routes with `403 crm_not_enabled`, and stops the CDR hook from writing timeline events. No data is deleted. Re-enabling is instant.

**What a rollback does NOT do:**
- Does not drop CRM tables or enum values
- Does not remove existing contacts, timeline events, campaign members, or import batches
- Does not affect telephony, PBX, or the normal call path in any way

---

## 12. Deploy Verification Checklist (run after `api` deploy)

Use these commands after the first `api` deploy that includes the CRM migrations.

```bash
# 1. Confirm the deploy log line matches expected SHA
#    GET /ops/deploy/jobs/:id/log?lines=200
#    Must end: [deploy-api] done <expected-sha> ...

# 2. Confirm CRM schema is live in running container
ssh connect "docker exec app-api-1 grep -c 'CrmTimelineEventType' /app/packages/db/prisma/schema.prisma"
# Expected: 2 (the enum definition + the field type)

# 3. Health check
curl -s https://app.connectcomunications.com/api/health
# Expected: {"ok":true}

# 4. CRM settings returns clean shape for any tenant JWT (enabled=false by default)
curl -s https://app.connectcomunications.com/api/crm/settings \
  -H "Authorization: Bearer <ANY_TENANT_JWT>"
# Expected: {"enabled":false,"localPresenceEnabled":false,"transcriptionEnabled":false}

# 5. Enable CRM for test tenant (admin JWT)
curl -s -X PUT https://app.connectcomunications.com/api/crm/settings \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true}'
# Expected: {"enabled":true,"localPresenceEnabled":false,"transcriptionEnabled":false}

# 6. Grant CRM access to a test user
curl -s -X PUT https://app.connectcomunications.com/api/crm/users/<USER_ID> \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true,"role":"AGENT"}'
# Expected: {"userId":"...","enabled":true,"role":"AGENT"}

# 7. Verify /me returns CRM permissions for the granted user
curl -s https://app.connectcomunications.com/api/me \
  -H "Authorization: Bearer <USER_JWT>"
# Expected: portalPermissionSet includes "can_view_section_crm"

# 8. Create a test contact
curl -s -X POST https://app.connectcomunications.com/api/crm/contacts \
  -H "Authorization: Bearer <USER_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"displayName":"Test Contact 6B","phones":[{"numberRaw":"+15550000001"}]}'
# Expected: 201, contact id returned

# 9. Verify portal CRM nav appears after /me reload
#    Navigate to portal → confirm "CRM" section visible in sidebar

# 10. Verify existing calling still works (telephony unaffected)
#     Place a test call via SIP → call connects → confirm no regression
#     GET /telephony/calls should still return normal structure
```

---

## Phase 8A — Power Dialer Smoke Test

Run after deploying Phase 8A portal changes. All checks are manual browser-based.

### Prerequisites
- CRM enabled for test tenant (Phase 7A already done)
- At least 3 PENDING campaign members assigned to your test user
- SIP softphone registered (portal phone connected)

### Checklist

```
[ ] 1. Manual queue still works
       - Navigate to /crm/queue
       - "Start Power Dialer" button is visible in header
       - Existing Next Up card, tabs, and actions all work normally

[ ] 2. Power mode starts
       - Click "Start Power Dialer"
       - URL changes to /crm/queue?mode=power
       - Blue sticky action bar appears at top: "Power Dialer • N leads remaining"
       - Filter tabs disappear (power mode uses pending filter only)
       - PowerCard shows for first pending member
       - Large green "Call [phone]" button is visible

[ ] 3. SIP not registered — Call button disabled
       - Disconnect SIP softphone
       - Amber warning appears: "SIP phone not registered"
       - Call button is gray/disabled, cannot be clicked
       - Reconnect SIP → warning disappears → button re-enables

[ ] 4. Call button dispatches crm:dial
       - With SIP registered, click "Call [number]"
       - FloatingDialer / phone dialer activates (same as manual click-to-call)
       - No automatic second call placed

[ ] 5. Keyboard shortcuts (C / S / D)
       - With power mode active and SIP registered:
         - Press C → FloatingDialer activates (same as Call button)
         - Press S → current lead is skipped → next lead appears automatically
         - Press D → current lead is deferred (moved to end) → next lead appears
       - Click in a text input, then press C/S/D → nothing fires

[ ] 6. Skip action advances queue
       - Click "Skip" on current lead
       - Brief "Skipped ✓ — loading next lead…" feedback shown
       - Queue reloads → next PENDING lead becomes the PowerCard
       - Skipped lead no longer appears at top

[ ] 7. Defer action advances queue
       - Click "Defer" on current lead
       - Queue reloads → deferred lead moves to end
       - Next PENDING lead becomes current card

[ ] 8. DNC action
       - Click "DNC" → confirmation dialog appears
       - Confirm → lead disappears → next lead loads

[ ] 9. Pause / Resume
       - Click "Pause" → PAUSED badge appears in action bar
       - Pause notice shown on card
       - Keyboard shortcuts C/S/D do nothing while paused
       - Skip/Defer buttons also disabled while paused
       - Click "Resume" → returns to normal

[ ] 10. Open Workspace from power mode
        - Click "Open Workspace" button on PowerCard
        - URL: /crm/live-call?contactId=...&memberId=...&mode=power
        - Back button says "Back to Queue" and returns to /crm/queue?mode=power

[ ] 11. Save Outcome & Next Lead from live workspace
        - Open workspace from power mode
        - Select a disposition (e.g. "Contacted")
        - Button says "Save Outcome & Next Lead →"
        - Click → brief "Outcome saved" flash → navigates to /crm/queue?mode=power
        - Queue shows next PENDING lead (not the just-processed one)

[ ] 12. Keyboard shortcut O in live workspace
        - Open workspace from power mode
        - Select a disposition
        - Press O (not in text field) → saves outcome + navigates back to queue

[ ] 13. Queue complete state
        - Work through all pending leads via skip/defer/outcome until none remain
        - "Queue Complete!" screen appears with "Exit Power Dialer" button
        - Clicking exit → /crm/queue (no mode param)

[ ] 14. Stop Power Dialer
        - Click "Stop" in sticky bar → URL becomes /crm/queue (no mode param)
        - Normal queue view with tabs restored
        - "Start Power Dialer" button re-appears

[ ] 15. Manual queue unaffected
        - Confirm normal MemberCard, tabs, actions still work after stopping
        - No regressions to skip/defer/DNC/set-callback in manual mode
```

---

## Phase 8B — Inline Outcome Panel Smoke Test

Run after deploying Phase 8B portal changes. All checks are manual browser-based.
Prerequisites same as Phase 8A (CRM enabled, ≥3 PENDING members, SIP registered).

### Checklist

```
[ ] 1. Outcome panel is visible on PowerCard
       - Enter power mode (/crm/queue?mode=power)
       - Below the green Call button, a "Log Outcome" section is visible
       - 6 buttons in a 3-column grid: No Answer, Voicemail, Interested,
         Not Interested, Callback, Converted
       - All buttons are clearly labeled and have icons

[ ] 2. No Answer — saves and advances
       - Click Call, then click "No Answer"
       - No confirmation required — saves immediately
       - "No Answer saved ✓ — loading next lead…" flash appears briefly
       - Queue reloads → next PENDING lead appears on card
       - In DB / contact timeline: disposition "No Answer" is recorded
       - Queue member status → CONTACTED

[ ] 3. Voicemail — saves and advances
       - Same as No Answer but with "Voicemail" button
       - Disposition "Voicemail" recorded; member status CONTACTED

[ ] 4. Interested — saves and advances
       - Click "Interested"
       - Saves immediately, advances queue
       - Disposition "Interested" recorded; member status CONTACTED

[ ] 5. Not Interested — confirmation then saves
       - Click "Not Interested"
       - Inline orange confirmation box appears:
         "Mark as 'Not Interested'? This will remove this lead from your
          active queue (Do Not Call for this campaign)."
       - Click Cancel → confirmation disappears, no action taken
       - Click "Not Interested" again → confirm → click "Confirm"
       - Lead disappears from queue; member status → DO_NOT_CALL
       - Disposition "Not Interested" recorded on contact

[ ] 6. Callback — inline time picker then saves
       - Click "Callback"
       - Inline yellow picker appears with datetime-local input + optional note field
       - Datetime defaults to 1 hour from now
       - Click Cancel → picker closes, no action taken
       - Pick a future date/time, optionally add note
       - "Save Callback →" button is disabled until datetime is chosen
       - Click "Save Callback →"
       - "Callback saved ✓ — loading next lead…" flash
       - Queue reloads (lead may move to callback tab, not shown in pending)
       - Contact timeline: disposition "Callback" recorded; task created (follow-up)
       - Queue member: status → CALLBACK, callbackAt set

[ ] 7. Converted — saves and advances
       - Click "Converted"
       - Saves immediately, advances queue
       - Disposition "Converted" recorded; member status → CONVERTED

[ ] 8. API failure handling
       - (Simulate by temporarily navigating while save is in flight, or test
         against a member with no contact — check that error banner appears)
       - If either API call fails: red inline error message appears below buttons
       - Queue does NOT advance (lead stays on card)
       - Error message clears next time an outcome is attempted

[ ] 9. Buttons disabled while saving
       - All 6 outcome buttons show disabled (opacity-40) while a save is in progress
       - Call button also disabled while saving
       - "Saving outcome…" text appears

[ ] 10. Full Workspace still accessible
        - "Full Workspace" button is still present in Queue Actions section
        - Opens /crm/live-call?...&mode=power as before
        - Notes, scripts, checklists, and full outcome flow still work there

[ ] 11. DNC queue action still works
        - "DNC" button in Queue Actions section (below outcome panel) still works
        - Shows confirm dialog, marks member as DO_NOT_CALL

[ ] 12. Skip / Defer / Reschedule still work
        - All existing Queue Actions buttons still behave as in Phase 8A

[ ] 13. Manual queue mode completely unaffected
        - Stop power mode, verify normal MemberCard has no outcome panel
        - Manual mode: Skip/Defer/DNC all work as before

[ ] 14. Outcome panel resets between leads
        - After an outcome saves and a new lead loads, confirm that:
          - No stale error message shown
          - No inline picker open
          - Note field is cleared / hidden (key={member.id} forces full remount)

[ ] 15. Keyboard shortcuts still work
        - C, S, D shortcuts still fire correctly (guards against input still active)
        - Typing in the callback note field must NOT trigger C/S/D shortcuts
```

---

## Phase 8C — Outcome Semantics Fix + Inline Notes Smoke Test

Run after deploying Phase 8C portal changes.

### Checklist

```
[ ] 1. Not Interested — maps to CONTACTED, NOT DO_NOT_CALL
       - Enter power mode with a PENDING lead
       - Click "Not Interested"
       - Lead advances to next (no confirmation required)
       - Verify: contact's lastDisposition = "Not Interested" (check contact detail page
         or CRM timeline — disposition event should say "Not Interested")
       - Verify: queue member status = CONTACTED (NOT DO_NOT_CALL)
       - Lead should still appear if you visit the queue's callback/contacted tabs

[ ] 2. DNC still requires explicit action + confirmation
       - Click "DNC" in the Queue Actions section (below outcome panel)
       - Native confirm dialog appears: "Mark [Name] as Do Not Call?"
       - Cancel → nothing happens
       - Confirm → member status set to DO_NOT_CALL
       - Lead does not appear in any queue tab (filtered out permanently)

[ ] 3. Not Interested vs DNC are distinct flows
       - "Not Interested" button saves without any confirmation (fast path)
       - "DNC" in Queue Actions shows confirmation (deliberate path)
       - Both record different things: "Not Interested" = CONTACTED, DNC = DO_NOT_CALL

[ ] 4. Outcome note — "+ Add note" toggle
       - In power mode, click "No Answer" directly (no note) → saves, advances
       - Go to next lead, click "+ Add note" link
       - Note textarea appears (2 rows, gray background)
       - "Clear" link collapses it and empties the text
       - Type a note, click "No Answer" → saves with "No Answer saved with note ✓"
       - Check contact's CRM timeline — DISPOSITION_SET event should include note body

[ ] 5. Note with Interested — creates real CRM note
       - Open "+ Add note", type "Interested in the Pro plan"
       - Click "Interested"
       - Contact detail page → Notes tab: note "Interested in the Pro plan" exists
       - Timeline: DISPOSITION_SET event shows the note

[ ] 6. Empty note does not create blank note
       - Open "+ Add note" textarea, leave it blank (or just whitespace)
       - Click any outcome
       - Contact notes: no blank note created
       - Feedback shows "X saved ✓" not "X saved with note ✓"

[ ] 7. Callback note still works
       - Click "Callback" → inline picker opens
       - "+ Add note" toggle is hidden (callback has its own note field)
       - Fill in a datetime and a callback note
       - Save → contact timeline: DISPOSITION_SET event; queue member: callbackNote set

[ ] 8. Note clears between leads
       - Add a note, save an outcome → next lead appears
       - "+ Add note" link is shown (collapsed) — textarea is not pre-filled
       - Confirms key={member.id} forces a clean remount

[ ] 9. Keyboard shortcut guard: typing in note textarea does NOT trigger C/S/D
       - Click "+ Add note", focus the textarea
       - Press C, S, D — no call/skip/defer fires
       - This is the keyboard input guard working correctly

[ ] 10. Manual queue mode unchanged
        - Stop power mode — MemberCards have no note textarea or outcome panel
        - Manual skip/defer/DNC all work as before
```

---

## Phase 8F — Wrap-Up Timer + Callback-Focused Power Flow

### Automated/API checks
```bash
# Queue endpoint still returns 200 with all filter variants
curl -s -H "Authorization: Bearer $JWT" "$API/crm/queue?filter=pending" | python -c "import sys,json; d=json.load(sys.stdin); print('OK pending', len(d['queue']))"
curl -s -H "Authorization: Bearer $JWT" "$API/crm/queue?filter=due" | python -c "import sys,json; d=json.load(sys.stdin); print('OK due', len(d['queue']))"
curl -s -H "Authorization: Bearer $JWT" "$API/crm/queue?filter=overdue" | python -c "import sys,json; d=json.load(sys.stdin); print('OK overdue', len(d['queue']))"

# Zero API changes — no migration, no new routes
# Verify queue page bundle contains Phase 8F code
docker exec app-portal-1 grep -l "WrapUpOverlay\|WRAP_UP_SECONDS\|crm_power_queue_paused" /app/apps/portal/.next/server/app/ -r 2>/dev/null | head -3
```

### Browser smoke test (manual, requires real lead in queue)
```
[ ] 1. Wrap-up timer after outcome save
       - Enter power mode (?mode=power)
       - Dial a lead (C) then click any outcome button (e.g. "No Answer")
       - WrapUpOverlay appears showing: countdown (5→4→3…), lead preview, Go Now / Pause / Skip Next buttons
       - Countdown reaches 0 → overlay disappears → next PowerCard shows
       - VERIFY: no call was placed; FloatingDialer was not triggered

[ ] 2. Go Now button
       - After saving outcome, WrapUpOverlay appears
       - Click "Go Now" (or press G) → immediately advances to next PowerCard

[ ] 3. Pause from wrap-up
       - After outcome save, WrapUpOverlay appears with countdown running
       - Click "Pause" → countdown freezes; amber banner appears; PAUSED badge in header
       - WrapUpOverlay still shows but countdown is frozen at current value
       - Press P or click Resume → countdown restarts

[ ] 4. Skip Next Lead during wrap-up
       - WrapUpOverlay is showing with lead preview
       - Click "Skip Next Lead" (or press X) → overlay closes, lead is skipped via API
       - Next PowerCard shows the lead AFTER the skipped one

[ ] 5. Persistent pause survives reload
       - Pause the queue (click Pause or P)
       - Reload the page (?mode=power still in URL)
       - Queue opens in paused state (PAUSED badge in header, amber health banner)
       - Resume → PAUSED badge clears; localStorage key removed

[ ] 6. Callback filter toggle
       - While in power mode, click "Due" in the filter toggle group (header)
       - URL changes to ?mode=power&filter=due
       - Queue reloads showing only callbacks due
       - Click "Overdue" → URL = ?mode=power&filter=overdue
       - Click "Pending" → URL = ?mode=power (no filter param)
       - VERIFY: manual queue tabs are unchanged (not URL-driven)

[ ] 7. Queue health banner
       - Simulate SIP disconnected (unregister softphone) → amber banner: "SIP disconnected…"
       - With queue paused → amber banner: "Queue paused…"
       - With overdue callbacks and Pending filter active → red banner: "N callbacks overdue"
         + "Switch to Overdue →" link navigates to overdue filter
       - All banners disappear when conditions are resolved

[ ] 8. Keyboard shortcuts — new
       - During wrap-up: G → Go Now (immediate advance)
       - Anytime in power mode: P → toggles pause (works even when paused)
       - During wrap-up: X → Skip Next Lead
       - Typing in a textarea: G/P/X do NOT fire (input guard working)

[ ] 9. Keyboard shortcuts — existing preserved
       - Outside wrap-up, not paused: C = dial, S = skip, D = defer
       - While paused: C/S/D/G/X do NOT fire; only P works

[ ] 10. Next lead preview in WrapUpOverlay
        - After saving outcome, WrapUpOverlay shows the upcoming lead's: name, stage, last
          disposition with relative time, attempt count, callback time if present
        - Uses already-loaded queue data (no extra API request in network tab)
        - If queue has only one lead remaining, "no more leads" message shows instead

[ ] 11. Wrap-up with empty queue
        - Save outcome on the LAST lead in the queue
        - WrapUpOverlay shows "No more leads" message
        - Countdown reaches 0 → "Queue Complete!" state shows
        - Go Now → "Queue Complete!" state

[ ] 12. No regressions — manual mode
        - Stop power mode → manual queue page works normally
        - Tabs: Next Up / Due Today / Overdue / Upcoming all switch correctly
        - Skip/Defer/DNC/Set Callback all function as before
        - No wrap-up overlay appears in manual mode
```

---

## Phase 9A — Manager Live Wallboard

```
[ ] 1. Wallboard route loads
        - Navigate to /crm/wallboard
        - Page renders without error
        - Blue summary strip visible with 8 stat tiles
        - "WS Live" or "Connecting…" badge visible top-left

[ ] 2. Permission gating
        - Log in as agent user without can_view_crm_reports
        - "Live Wallboard" nav item is NOT visible
        - Direct access to /crm/wallboard returns 401 or redirects

[ ] 3. CRM disabled tenant
        - Disable CRM for tenant (CrmTenantSettings.enabled = false)
        - Wallboard responds with appropriate error (403 or CRM disabled page)

[ ] 4. Summary strip — values
        - "Active Calls" shows real-time telephony active call count (from WS)
        - "Queue Remaining" matches /crm/reports/daily.queueRemaining
        - "Overdue Callbacks" shown in red when > 0
        - "Dispositions Today" increments as agents work

[ ] 5. Live Calls panel
        - Panel shows all active (non-hungup) calls for the tenant
        - Direction icon: green PhoneIncoming for inbound, blue PhoneOutgoing for outbound
        - Call state badge: "ringing" = yellow, "up" = green, "held" = gray
        - Duration updates every ~10 seconds (ticking display)
        - Empty state: "No active calls" when no calls
        - NO dial / hold / transfer / end buttons anywhere on panel

[ ] 6. Agent Activity panel
        - Rows rendered for each CRM user (with can_view_crm access)
        - Columns: Agent, Dispositions, Queue, Callbacks, Tasks, Conv.
        - Blue bold number for dispositionsToday > 0
        - Orange for callbacksDueToday > 0
        - Green bold for conversions > 0
        - Empty state when no CRM agents configured

[ ] 7. Campaign Progress panel
        - Shows only ACTIVE campaigns
        - Progress bar segments: purple (contacted) + yellow (callbacks) + green (converted) + gray (dnc)
        - Conversion rate badge visible when > 0%
        - Link to campaign detail page (/crm/campaigns/:id)
        - Empty state when no active campaigns

[ ] 8. Follow-Up Urgency panel
        - 4 mini summary tiles: Overdue Callbacks, Due Today (CB), Overdue Tasks, Tasks Due Today
        - Overdue tiles show red border when count > 0
        - Top 10 actionable rows list: red dot = overdue, yellow dot = due today
        - Rows link to /crm/contacts/:id
        - Empty state: "All caught up!" with green checkmark
        - "View all" links point to /crm/reports and /crm/tasks

[ ] 9. 60-second auto-refresh
        - Watch Network tab: /crm/reports/daily, /crm/reports/agents,
          /crm/reports/campaigns, /crm/reports/follow-ups all fire ~every 60 s
        - Refresh button forces immediate re-fetch and updates "Updated X ago"
        - No polling > 4 requests/minute for CRM endpoints

[ ] 10. Timer cleanup
        - Open wallboard, navigate away → no ongoing interval fires after leaving
          (confirm no repeated API calls in Network tab after page change)
        - Live call duration tick also stops

[ ] 11. No telephony regressions
        - Existing phone calls still work after opening wallboard
        - useTelephony() WS connection not duplicated
        - No new WS connection created by wallboard page
        - Phone system /health still returns {"ok":true}

[ ] 12. Bundle artifact verification
        # In compiled portal bundle chunk for /crm/wallboard:
        grep -r "Live Wallboard" .next/static/chunks/
        grep -r "Active Calls" .next/static/chunks/
        grep -r "Agent Activity" .next/static/chunks/
        grep -r "crm_power_queue_paused" .next/static/chunks/  # must NOT appear in wallboard chunk
        # Confirm no crm:dial near wallboard code
```

---

## Phase 9B — Wallboard Polish (TV Mode, Countdown, Agent Badges)

```
[ ] 1. Normal wallboard loads with all Phase 9A features intact
        - /crm/wallboard renders without error
        - Summary strip, all 4 panels visible
        - "WS Live" badge present

[ ] 2. Refresh countdown — normal mode
        - Header shows "Refreshes in Xs" with X counting down from 60
        - Countdown turns amber when ≤ 10 seconds remain
        - Clicking "Refresh" button:
          - Shows "Refreshing…" while loading
          - Resets countdown to 60 after data returns
          - Updates "Updated X ago" timestamp

[ ] 3. Countdown cleanup
        - Navigate away from /crm/wallboard
        - Confirm no interval continues to fire (Network tab should show
          no more /crm/reports/* requests after leaving the page)

[ ] 4. TV Mode toggle
        - "TV Mode" button visible in top-right of header
        - Clicking it:
          - URL changes to ?tv=1 (no page reload)
          - Dark full-screen overlay appears (covers sidebar)
          - Large clock displayed center-header (HH:MM format)
          - Stat tiles show text-5xl numbers
          - Panel headers/table text is larger
        - "Exit TV" button in TV header returns to normal mode (?tv removed)

[ ] 5. TV Mode URL persistence
        - Navigate to /crm/wallboard?tv=1 directly
        - TV mode activates automatically on load
        - Page reload at ?tv=1 stays in TV mode

[ ] 6. TV Mode clock
        - Clock shows correct local time in HH:MM
        - Date shown below clock (e.g. "Wed, May 13")
        - Clock updates every ~10 seconds (not every second)

[ ] 7. TV Mode refresh countdown
        - Countdown "Refreshes in Xs" shown in top-right of TV header
        - Turns amber at ≤ 10s remaining
        - "Refreshing…" shows during active fetch
        - Resets to 60 after each refresh

[ ] 8. Agent idle badges (normal and TV mode)
        - Create or simulate an agent with:
          - callbacksDueToday > 0 AND dispositionsToday === 0
          → "Needs attention" badge (red) appears under agent name
        - Agent with callbacksDueToday > 0 AND dispositionsToday > 0
          → "Callbacks due" badge (orange)
        - Agent with assignedQueue > 0 AND dispositionsToday === 0
          → "No outcomes today" badge (amber)
        - Active agent (dispositionsToday > 0, no callbacks due)
          → No badge
        - Badges show in both normal and TV mode

[ ] 9. Agent on-call hint — NOT implemented
        - Extension-to-user mapping is not available without an API change.
        - Confirm: no "On call" indicator exists. Do not add fake presence.

[ ] 10. Empty states are informative
        - Disable all campaigns → CampaignPanel shows:
          "No active campaigns · Activate a campaign to track progress here"
        - No CRM agents → AgentPanel shows:
          "No CRM agents configured · Enable CRM access for users in CRM Settings"
        - No active calls → LiveCallsPanel shows:
          "No active calls right now · New calls will appear here in real time"
        - No overdue items → FollowUpsPanel shows:
          "All caught up! · No overdue callbacks or tasks"

[ ] 11. Urgent alert in normal mode header
        - If totalUrgent (overdue CBs + overdue tasks) > 0:
          Red "N urgent" badge appears next to title in normal mode header

[ ] 12. No regressions
        - Manual queue still loads normally
        - Existing CRM nav items work
        - Phone calls unaffected
        - /health returns {"ok":true}
        - No console errors on wallboard load or TV mode toggle
```

---

## Phase 9C — Wallboard On-Call Indicators

```
[ ] 1. API: GET /crm/reports/agents includes extensions field
        - Hit the endpoint (with valid CRM JWT)
        - Each agent object has "extensions": [] or ["101"] or ["101","102"]
        - Agents with no owned ACTIVE extension get extensions: []
        - No schema migration required; extensions come from existing Extension model

[ ] 2. Agent with extension assigned shows ext number in sub-line
        - Open /crm/wallboard → Agent Activity panel
        - Agent row sub-line shows "AGENT · ext 101" when extension is owned
        - Agent without extension shows only "AGENT" (no "· ext" text)

[ ] 3. On-call badge appears during active call
        - Place an outbound call from an agent's SIP extension
        - Within the WS refresh cycle, that agent row shows:
          - Green "On call · Xm Ys" badge with outbound arrow icon
        - Inbound call to agent's extension shows inbound arrow icon instead

[ ] 4. On-call badge suppresses idle badges
        - Agent has callbacksDueToday > 0 AND dispositionsToday === 0
          (would normally show "Needs attention")
        - While that agent is on a live call:
          → "On call · Xs" badge shown instead
          → "Needs attention" badge NOT shown simultaneously

[ ] 5. Agent without extension — no fake badge
        - Remove extension ownership from a test user
        - That agent shows no "On call" badge even when other calls are active
        - Confirm: no crash, no false positive

[ ] 6. Call ends — badge disappears
        - Hang up the call
        - On next WS event, "On call" badge disappears from agent row
        - Idle/attention badge reappears if applicable (next 60s data refresh)

[ ] 7. TV mode — on-call badge is large and readable
        - Activate ?tv=1
        - "On call" badge shows in dark green (bg-green-900/70 text-green-300)
        - Badge is legible from wallboard viewing distance

[ ] 8. Match covers all three call fields
        - Confirm match works for:
          a) Extension in call.extensions[] array
          b) Extension equals call.source_extension
          c) Extension equals call.destination_extension
        - (All three are checked by findAgentCall helper)

[ ] 9. API typecheck passes
        pnpm tsc --noEmit (apps/api)  → 0 errors

[ ] 10. Portal typecheck passes
        pnpm tsc --noEmit (apps/portal) → 0 errors

[ ] 11. No schema changes
        - Confirm: no new migration files
        - Confirm: no changes to packages/db/prisma/schema.prisma

[ ] 12. No telephony regressions
        - /health returns {"ok":true}
        - Existing phone calls are unaffected
        - No new WS connection; useTelephony() shared context unchanged
```

---

## Phase 10A — Recording Playback from CRM Timeline

```
[ ] 1. Recording player component exists
        - apps/portal/components/CrmRecordingPlayer.tsx created
        - Renders "Play recording" button (collapsed) and <audio controls> (expanded)
        - Token read from localStorage ("token" or "cc-token")
        - URL: /api/voice/recording/:linkedId/stream?token=...
        - Error state shown if audio fails to load

[ ] 2. Contact detail page shows inline player
        - /crm/contacts/:id → CDR_INBOUND / CDR_OUTBOUND events with recordingAvailable=true
          render <CrmRecordingPlayer> (not an <a> link)
        - Events with recordingAvailable=false (or missing) show NO play button

[ ] 3. Live-call workspace shows compact inline player
        - /crm/live-call → CDR events with hasRecording=true render
          <CrmRecordingPlayer compact> (not an <a> link)

[ ] 4. Inline playback works end-to-end
        - Click "Play recording" → audio element appears with the recording
        - Audio can be played, paused, and seeked (Range header support confirmed)
        - Collapse button (■) hides the audio element

[ ] 5. Error state is handled
        - If recording file is missing on PBX → "Unavailable" text + red icon shown
        - No console errors for missing recordings

[ ] 6. CDR events without recording show no button
        - Events where recordingAvailable is false/null: no play button rendered

[ ] 7. Cross-tenant access blocked
        - Tenant isolation enforced server-side (user.tenantId !== cdr.tenantId → 403)
        - No way to play a recording from a different tenant

[ ] 8. No API changes
        - Confirm: no changes to apps/api/**
        - Confirm: no new Prisma migrations
        - Confirm: no telephony changes

[ ] 9. Portal typecheck passes
        pnpm tsc --noEmit (apps/portal) → 0 errors

[ ] 10. Bundle verification
        - Confirm portal bundle contains: "Play recording", "Unavailable", "CrmRecordingPlayer"
          (or minified equivalent)
        - Confirm bundle does NOT contain raw "recordingPath" strings passed to <audio> src

[ ] 11. Phone system /health unaffected
        - /health returns {"ok":true}
        - No telephony changes; PBX untouched
```

---

## Phase 12A — Smart Queue Prioritization

```
[ ] 1. API: sort=smart on GET /crm/queue
        - sort=smart accepted; sort=original preserves exact pre-12A ordering
        - No schema change, no migration

[ ] 2. Smart ranking tiers (overdue → due today → upcoming → fresh → low-attempt → stale)
        - Overdue callbacks (callbackAt < now) rank before due-today
        - Due-today callbacks rank before zero-attempt fresh leads
        - Zero-attempt leads rank before 1-3 attempt leads
        - 1-3 attempt leads rank before 4+ attempt leads
        - Within callbacks: ordered callbackAt ASC (most overdue first)
        - Within leads: sortOrder ASC then createdAt ASC

[ ] 3. filter=pending + sort=smart includes CALLBACK members
        - WHERE status IN (PENDING, IN_PROGRESS, CALLBACK) when sort=smart
        - Overdue/due callbacks appear at top of the pending list
        - filter=original still uses status IN (PENDING, IN_PROGRESS) only

[ ] 4. DNC/converted/skipped excluded
        - DO_NOT_CALL, CONVERTED, SKIPPED never appear in smart sort results
        - Same exclusion as original mode

[ ] 5. Candidate cap: 500 rows
        - Smart sort fetches max 500 candidates, ranks in-process, slices to limit
        - Does not load unbounded rows

[ ] 6. Power mode defaults to sort=smart
        - Power Dialer opens with sortMode=smart (localStorage default)
        - Manual mode opens with sortMode=original (localStorage default)
        - Both are user-toggleable via the sort button

[ ] 7. UI: sort toggle
        - Power mode header: Smart/Original toggle button (Sparkles icon)
        - Manual mode header: Smart/Original toggle button
        - "Smart priority on" text shown in power bar when smart is active
        - Toggling reloads queue immediately with the new sort param

[ ] 8. Power mode: priority reason badge on current lead
        - "Overdue callback" badge — red chip, Sparkles icon
        - "Due today" badge — red chip, Sparkles icon
        - "Fresh lead" badge — indigo chip, Sparkles icon
        - "Fewer attempts" badge — indigo chip, Sparkles icon
        - Badge only shows when sort=smart
        - Badge derived client-side from member.status/callbackAt/attemptCount

[ ] 9. No auto-dial, no predictive dial
        - Toggling sort mode does NOT trigger any call
        - Power Dialer call still requires explicit agent action (button or C key)
        - No telephony code changed

[ ] 10. API typecheck passes (0 errors)
[ ] 11. Portal typecheck passes (0 errors)
```

---

## Phase 13A — Import CSV Leads Directly Into a Campaign

```
[ ] 1. POST /crm/campaigns/:id/import (multipart: file + optional assignedToUserId)
        - Same 5 MB / 5,000 row limits as POST /crm/import/upload
        - Invalid CSV / no phone+email columns returns 400 with clear error
        - campaign_not_found for wrong tenant / unknown id

[ ] 2. Contact dedupe
        - Duplicate phone/email updates existing contact, does not create second contact
        - New rows create Contact with source IMPORTED + CrmContactMeta

[ ] 3. Campaign member enrollment
        - New contacts and updated contacts get CrmCampaignMember when not already in campaign
        - Already a member: skippedExistingMembers incremented, no duplicate member row

[ ] 4. assignedToUserId optional
        - When set, new members have assignedToUserId set
        - Invalid user or user without CRM access → 400 invalid_assignee
        - Omitted → members unassigned

[ ] 5. CrmImportBatch
        - Batch row created with fileName prefixed campaign:<id>:
        - createdCount / updatedCount / skippedCount align with contact pipeline

[ ] 6. POST /crm/import/upload unchanged
        - Still works for standalone import (same pipeline module)

[ ] 7. Campaign detail UI (admin)
        - Import CSV button opens modal
        - Column guidance shown (no fake preview)
        - After success: summary counts + members/workload/campaign stats refresh

[ ] 8. Queue
        - New members appear in GET /crm/campaigns/:id/members and agent queue when assigned

[ ] 9. Safety
        - No schema migration
        - No telephony changes

[ ] 10. API typecheck (0 errors)
[ ] 11. Portal typecheck (0 errors)
```

---

## Phase 13B — Pilot readiness, cleanup, and first day

> Run before pointing a **first real pilot tenant** at CRM in production. Combines
> database hygiene, API smoke, and ops checks. **Do not hard-delete** CRM rows if soft
> archive or `ARCHIVED` campaign status is enough — hard deletes can violate FKs.

### Pilot tenant go-live checklist

| Step | Pass if |
|------|--------|
| `CrmTenantSettings.enabled = true` for the tenant | Admin sees CRM settings; `GET /crm/settings` returns `"enabled": true` |
| At least one **admin-class** user can use CRM | `CrmUserAccess` row with `enabled=true` for an admin, or user has `SUPER_ADMIN` / `TENANT_ADMIN` / `ADMIN` and CRM gate passes |
| At least one **agent-class** user can see CRM nav | `CrmUserAccess` with `role` `AGENT` (or equivalent) + user reloads `/me` so `can_view_section_crm` appears |
| CRM **Settings** page loads | `/crm/settings` renders; queue defaults save (`defaultQueueSort`, `defaultQueueFilter`) |
| Queue defaults are sane | e.g. `SMART` + `PENDING` unless the pilot asked for different documented behavior |
| Core CRM pages return **200** (authenticated) | `/crm/campaigns`, `/crm/import`, `/crm/queue`, `/crm/reports` (API: `GET /crm/campaigns`, `GET /crm/import/batches`, `GET /crm/queue`, `GET /crm/reports/daily`) |
| **Reports** and **Wallboard** load for permitted roles | `/crm/reports`, `/crm/wallboard` — managers need report permission per product rules |
| Phone | `GET` telephony **/health** from API host shows `status: ok` / healthy PBX link |
| Deploy queue idle | `GET /ops/deploy/status` → `runningCount: 0`, `queuedCount: 0` (no surprise deploy during cutover) |
| **Service SHAs aligned (recommended)** | Compare last log lines `[deploy-api] done <sha>` and `[deploy-portal] done <sha>`. If they diverge widely, confirm portal is not missing CRM UI fixes shipped only on API |

### Cleanup checklist (after smoke / QA naming like `SMOKE13A-*`)

| Step | Notes |
|------|------|
| **Campaigns** | Prefer `DELETE /crm/campaigns/:id` (sets `ARCHIVED`) or direct DB `status = ARCHIVED` — keeps history. Do not delete campaigns that still have members unless using an API path that cleans members first. |
| **Campaign members** | Remove smoke members (`CrmCampaignMember`) for test campaigns before or with campaign archive. |
| **Contacts (Phase 16A)** | **`DELETE /crm/contacts/:id`** (CRM admin JWT) soft-archives (`active=false`, `archivedAt=now()`). **`POST /crm/contacts/:id/restore`** reverses it. **`GET /crm/contacts?includeArchived=true`** (admin only) lists archived contacts for verification. Does not remove timeline, tasks, notes, or campaign members. |
| **Contacts** | Default CRM list/search uses **active** contacts only. Prefer soft-archive (above) or merge (archives merged-away row) over hard `DELETE`, unless a supported admin path exists. |
| **Verify list** | `GET /crm/campaigns` should not show `ARCHIVED` smoke names in the default **active** list. |
| **Verify search** | `GET /crm/contacts?q=<smoke tag>` returns **no** active rows after cleanup. |
| **Duplicates** | `SELECT campaignId, contactId, count(*) … HAVING count(*) > 1` on `CrmCampaignMember` should return **0** rows. |
| **Phase 13D / 15 / smoke naming** | Hunt campaigns and contacts whose names or emails match `SMOKE`, `AGENT-SMOKE`, `Phase13`, `Phase15`, `example.invalid`, or obvious `555` / `+1555` test numbers; archive campaigns and soft-archive contacts the same way as above. |

### CRM Archive Lifecycle Smoke — 16A–16D

> **Single end-to-end operator path** covering **16A** archive/restore, **16B** list scopes, **16C** queue exclusion + PATCH guard, **16D** campaign auto-complete vs archived members. Portal nuances live in **Phase 16B–16D** below; HTTP contracts in **`docs/ai-context/API_ROUTES.md`**; invariants **48–49** in **`docs/ai-context/RULES.md`**.

**Safety (required)**

- Use a **QA tenant** or clearly tagged smoke data — **not** production customer records.
- **No voice calls** and **no SMS** during this smoke.
- Prefer emails under **`example.invalid`** and phones in the **`555` / `+1555…`** test range.
- Set `$env:ADMIN_JWT` and `$env:AGENT_JWT` in your shell; **never** print, log, or paste tokens.

**What this proves**

| Area | Confirmed |
|------|-----------|
| History | Timeline, members, and campaign rows stay present after archive where documented — **soft-archive does not hard-delete**. |
| Live queue | Archived contacts **do not** appear in actionable queue or related live counts (**16C**). |
| Campaign completion | **`COMPLETED`** when no **live-contact** actionable non-terminal work remains — archived **`PENDING`/`IN_PROGRESS`/`CALLBACK`** rows **do not** block (**16D**). |
| Restore | **`POST /restore`** does **not** automatically re-open a campaign that already reached **`COMPLETED`** (**16D**). |

**Expected HTTP / error keys**

| Call | Role | Expected |
|------|------|----------|
| `DELETE /crm/contacts/:id` | CRM admin | **200** `{ ok: true, contactId }` (soft-archive; idempotent if already archived) |
| `POST /crm/contacts/:id/restore` | CRM admin | **200** `{ ok: true, contactId }` |
| `GET /crm/contacts?includeArchived=true` | Agent / non-admin | **403** `crm_permission_denied` (`detail` explains admin requirement) |
| `GET /crm/contacts?archivedOnly=true` without `includeArchived=true` | Admin | **400** `invalid_query` (`archivedOnly requires includeArchived=true`) |
| `PATCH /crm/queue/:memberId` (write) | Agent; member’s contact archived | **409** `crm_queue_contact_not_live` |

**Operator flow (recommended order)**

| Step | Action | Pass if |
|------|--------|---------|
| 1 | Admin: create **safe** contact (`POST /crm/contacts` or portal) | `contactId` returned; fake email / 555 phone only |
| 2 | Admin: create **`ACTIVE`** campaign | `campaignId` returned |
| 3 | Admin: enroll contact + assign member to **agent** user (`members/add`, bulk-assign) | Member **`PENDING`** (or qualifying non-terminal); note `memberId` |
| 4 | Agent: `GET /crm/queue` | Member **visible**; counts include it |
| 5 | Admin: `DELETE /crm/contacts/:contactId` | **200** |
| 6 | Admin: archived list — portal **Contacts → Archived**, or `GET /crm/contacts?includeArchived=true&archivedOnly=true` | Contact **listed** (**16B**) |
| 7 | Agent: `GET /crm/queue` | Member **absent**; counts dropped (**16C**) |
| 8 | Agent: `PATCH /crm/queue/:memberId` (e.g. skip / outcome — any write) | **409** `crm_queue_contact_not_live` (**16C**) |
| 9 | Admin or agent: `GET /crm/campaigns/:campaignId` | Member row **still present** with archived / muted presentation; not actionable in queue (**16A**, **16C**) |
| 10 | **16D** — campaign completion | If this member was the **only** live-actionable non-terminal row, campaign becomes **`COMPLETED`** after archive (auto-complete runs on archive path — allow a short delay; re-fetch). *Alternatively:* terminal-out other live members or archive their contacts until no live non-terminal rows remain — then **`COMPLETED`**. |
| 11 | Admin: `POST /crm/contacts/:contactId/restore` | **200** |
| 12 | Admin: `GET /crm/campaigns/:campaignId` after restore | If step 10 showed **`COMPLETED`**, status stays **`COMPLETED`** — **no auto-reopen** (**16D**) |
| 13 | Cleanup | Archive campaign (`DELETE /crm/campaigns/:id`), soft-archive contact if still active, per **Cleanup checklist** above |

**PowerShell skeleton** (Invoke-RestMethod; tokens from environment only):

```powershell
$ErrorActionPreference = 'Stop'
$Base = 'https://app.connectcomunications.com/api'

function CrmHeaders([string]$Token) {
  return @{ Authorization = "Bearer $Token"; 'Content-Type' = 'application/json' }
}

# Set in the shell before running (do not echo):
#   $env:ADMIN_JWT = '…'
#   $env:AGENT_JWT = '…'

# Examples (adjust paths / bodies to your tenant):
# Invoke-RestMethod -Method Get -Uri "$Base/crm/queue" -Headers (CrmHeaders $env:AGENT_JWT)
# Invoke-RestMethod -Method Delete -Uri "$Base/crm/contacts/<contactId>" -Headers (CrmHeaders $env:ADMIN_JWT)
# Invoke-RestMethod -Method Patch -Uri "$Base/crm/queue/<memberId>" -Headers (CrmHeaders $env:AGENT_JWT) -Body '{"action":"skip"}'
```

**curl.exe skeleton** (same env vars; Windows: `curl.exe` avoids PowerShell alias):

```powershell
curl.exe -sS -H "Authorization: Bearer $env:AGENT_JWT" "$Base/crm/queue"
curl.exe -sS -X DELETE -H "Authorization: Bearer $env:ADMIN_JWT" "$Base/crm/contacts/<contactId>"
```

### Phase 16B — Contacts list: Active / Archived / All (smoke)

Portal `/crm/contacts`: CRM **admin** sees **List** scope **Active** (default), **Archived**, **All**. **Agent** sees no scope control and the list stays **active-only** (default `GET /crm/contacts`). **Real API only** — Archived uses `GET /crm/contacts?includeArchived=true&archivedOnly=true`; All uses `includeArchived=true`; Active uses default query (no archive flags).

| Check | Expected |
|-------|----------|
| **Admin — Active** | Default list matches pre–16B behavior; archived contacts **not** shown; rows are normal (not muted); bulk checkboxes on non-archived rows only. |
| **Admin — Archived** | Only archived contacts; each row shows **Archived** badge and muted styling; row opens detail; search returns **only** archived matches from the API. |
| **Admin — All** | Active and archived contacts in one list; archived rows badge + muted; active rows unchanged. |
| **Agent** | No **List** scope UI; list shows **active** contacts only (no archived rows); search behavior unchanged from default active list. |
| **API (optional curl)** | Non-admin JWT + `?includeArchived=true` → `403`. `?archivedOnly=true` without `includeArchived` → `400`. |

### Phase 16C — Archived contacts excluded from live queue (smoke)

**Setup:** Pick (or create) a contact that is enrolled in an **ACTIVE** campaign with a `CrmCampaignMember` assigned to a test agent, status `PENDING`/`IN_PROGRESS`/`CALLBACK` so it appears on **My Queue**.

| Check | Expected |
|-------|----------|
| **Before archive** | Agent `GET /crm/queue` (and tab counts) includes the member; campaign detail shows the row normally. |
| **Archive contact** | CRM admin `DELETE /crm/contacts/:id` (soft-archive). |
| **Queue** | Same agent: member **absent** from `GET /crm/queue` for all relevant filters (`pending`, `due`, `overdue`, `upcoming`, `all`, smart + original sort); tab `counts` drop accordingly; `POST /crm/queue/next` does not return that member. |
| **Campaign detail** | Member row still listed with **Archived** badge and muted styling; agent cannot change status, callback, or **Call** workspace link (controls disabled); admin can still PATCH member for maintenance. |
| **Restore** | `POST /crm/contacts/:id/restore`. If member status still qualifies, row **returns** to queue and counts. |
| **Reports alignment (optional)** | `GET /crm/reports/daily` fields `queueRemaining`, `callbacksDueToday`, `overdueCallbacks` move with live queue (exclude archived). `GET /crm/reports/campaigns` campaign totals may still count archived members — historical roster. |

### Phase 16D — Campaign auto-complete vs archived contacts (smoke)

**Setup:** ACTIVE campaign with at least one member whose contact is **live** and in a **non-terminal** status (`PENDING` / `IN_PROGRESS` / `CALLBACK`), plus another member on an archived contact still in `PENDING` (or soft-archive one member’s contact after setup).

| Check | Expected |
|-------|----------|
| **Only archived rows non-terminal** | After the last **live** member is terminal (or after soft-archiving every remaining non-terminal contact), campaign becomes **`COMPLETED`** when auto-complete runs (member PATCH / queue PATCH to terminal, or **soft-archive** path that re-checks campaigns). No `CrmCampaignMember` rows mutated solely because the contact archived. |
| **Campaign detail** | Archived members still visible with badge/muted styling; `queueWorkEligible` false. |
| **Restore** | Restoring a contact does not by itself revert campaign from `COMPLETED` to `ACTIVE` (no automatic un-complete in 16D). |

### Phase 15D — Seeded / test portal password hygiene (pre–live pilot)

Any account created for QA or seed scripts (for example `crm.pilot.agent.p13c@connect-internal.test`) may still have a predictable or shared password. **Treat that as high risk until rotated.** Do not paste passwords or reset tokens into logs, chat, or tickets.

**Safe rotation paths (pick one):**

1. **Self-service forgot password (no admin JWT)**  
   - Portal: use **Forgot password** with the user’s email, **or**  
   - `POST https://app.connectcomunications.com/api/auth/password/forgot` with JSON `{"email":"<user email>"}` (always returns `{ ok: true }` to callers).  
   - User completes the link to `/auth/password/reset?token=…` and sets a new password via `POST /api/auth/password/reset` (portal handles this).

2. **Admin resend invite (tenant admin / super admin with user-management permission)**  
   - `POST https://app.connectcomunications.com/api/admin/users/:id/resend-invite`  
   - Header: `Authorization: Bearer <ADMIN_JWT>`  
   - Sends a fresh **INVITE** email and sets the user to invited / force password setup; user finishes at `/auth/invite/accept`.  
   - Never commit or print the JWT or email token.

### First-day monitoring checklist

| Watch | What “good” looks like |
|-------|-------------------------|
| errors | API logs: no spike in `5xx` on `/crm/*` |
| CDR hook | Inbound/outbound CDR still ingests; CRM timeline receives `CDR_*` when numbers match contacts |
| queue | Agents can open queue and workspace; power mode unchanged from Phase 8 regressions |
| telephony | AMI connected, `/health` stable — CRM must not correlate with PBX regressions |
| wallboard | Refreshes ~60s; WS “live” badge sane; no runaway client polling |
| deploy queue | Jobs finish with log line `done <expected-sha>` — see `AGENTS.md` post-deploy verification |

---

## Phase 13C — CRM agent (`CrmUserAccess` AGENT) validation

> Validates **non–platform-admin** users with `UserRole` such as `USER` or `EXTENSION_USER`
> and `CrmUserAccess.role = AGENT`. SUPER_ADMIN / TENANT_ADMIN / ADMIN **bypass** the
> per-user access row for `requireCrmAccess` but still hit `requireCrmAdmin` on management routes.

### Create / enable pilot agent (one-time)

| Step | Action |
|------|--------|
| User | Create tenant user with **`EXTENSION_USER`** or **`USER`** (not `SUPER_ADMIN`). |
| CRM row | `PUT /crm/users/:userId` from a CRM admin JWT: `{ "enabled": true, "role": "AGENT" }`, or insert/upsert `CrmUserAccess` in DB. |
| Session | User **reloads** the portal (or re-logs in) so `GET /me` picks up expanded CRM permissions. |

### `/me` permission expectations (AGENT)

| Permission | Expected |
|------------|----------|
| `can_view_section_crm` | **true** (via `expandLegacyPortalPermissions(["can_view_crm"]`) when CRM enabled + access row) |
| `can_view_crm_dashboard`, contacts, tasks, live_call, scripts, checklists, campaigns, queue, **reports** | **true** |
| `can_view_crm_import`, `can_view_crm_settings` | **false** (manage bundle only — sidebar hides Import + CRM Settings) |
| Wallboard nav | Uses `can_view_crm_reports` → **visible** for agents |

### API boundary (automated checks)

| Call | AGENT expectation |
|------|-------------------|
| `GET /crm/settings` | **200** (read defaults for queue; any authenticated tenant user) |
| `PUT /crm/settings` | **403** `forbidden` / CRM admin required (`routes.ts` `requireAdmin`) |
| `GET /crm/users` | **403** CRM admin |
| `POST /crm/campaigns` | **403** CRM admin |
| `PATCH /crm/campaigns/:id` (priority, etc.) | **403** CRM admin |
| `POST /crm/campaigns/:id/members/distribute` | **403** CRM admin |
| `POST /crm/contacts/bulk-reassign` | **403** `crm_permission_denied` |
| `GET /crm/reports/*`, `GET /crm/queue`, `GET /crm/import/batches` | **200** with CRM access (`requireCrmAccess` only on import list/upload) |
| `POST /crm/import/upload` | **200** if CSV valid — **API is not admin-gated**; nav hides Import for agents |

### Browser / workflow (manual — requires live data)

Prerequisites: at least one **ACTIVE** campaign with a **PENDING** (or callback) member **assigned to the agent**; SIP registered for power-dial tests; SMS provider configured for send tests.

```
[ ] CRM section appears in sidebar; Import + CRM Settings links absent
[ ] /crm/queue, /crm/contacts, /crm/contacts/:id, /crm/live-call load
[ ] Power mode: Call / outcomes guarded on SIP registration (no fake auto-dial)
[ ] SMS panel on contact detail; recording player when timeline has recordingAvailable
[ ] Save note, disposition, callback — timeline refreshes
[ ] /crm/reports and /crm/wallboard load (same report permission as agent bundle)
[ ] Telephony /health still ok after session
```

### Pilot tenant data note (2026-05-14)

After Phase 13B cleanup, a tenant may have **no ACTIVE campaigns**. Admin must create a campaign and members before **My Queue** and distribute tests return non-empty results.

---

## Phase 12D — Queue Assignment and Lead Redistribution

```
[ ] 1. GET /crm/campaigns/:id/members?assignedToUserId=<id>
        - Returns only members assigned to that user
        - Cross-tenant userId returns 404
        - Combines with ?status= filter

[ ] 2. GET /crm/campaigns/:id/members?unassigned=true
        - Returns only members with no assignee
        - Combines with ?status= filter

[ ] 3. GET /crm/campaigns/:id/workload
        - Returns per-agent row: pending+inProgress, callbacks, contacted, converted, total
        - Includes Unassigned row
        - Named agents sorted alphabetically, Unassigned last
        - Admin only (returns 403 for non-admins)

[ ] 4. POST /crm/campaigns/:id/members/distribute
        - Distributes unassigned PENDING/IN_PROGRESS members round-robin
        - Body: { userIds: ["..."] }
        - Returns { distributed, assignments: [{ userId, count }] }
        - Returns 400 if userIds empty or cross-tenant
        - Already-assigned leads untouched
        - No unassigned leads → { distributed: 0, message: "..." }
        - Admin only

[ ] 5. Assignee filter dropdown on campaign detail
        - Options: All agents / Unassigned / each CRM-enabled user
        - Selecting reloads members from API
        - Combines with status filter

[ ] 6. Workload panel on campaign detail (admin only)
        - Toggled by "Workload" button
        - Shows per-agent table with real counts
        - Unassigned row at bottom

[ ] 7. Distribute modal (admin only)
        - Opened by "Distribute" button
        - Checklist of CRM-enabled agents
        - No agents selected → blocked
        - Calls POST /distribute on confirm
        - Shows result: "Distributed N leads across M agents"
        - No unassigned leads → useful message

[ ] 8. Bulk-assign dropdown uses correct userId field (not id)
        - Options have real values (pre-existing bug fixed)

[ ] 9. Tenant isolation
        - assignedToUserId from another tenant → 404
        - distribute with cross-tenant userIds → 400

[ ] 10. Safety
        - No telephony changes
        - No auto-redistribution

[ ] 11. API typecheck (0 errors)
[ ] 12. Portal typecheck (0 errors)
```

---

## Phase 12C — Queue Campaign Filter + Default Queue Behavior Settings

```
[ ] 1. Migration applies cleanly
        - Migration 20260514020000_crm_queue_defaults runs without error
        - defaultQueueSort column added to CrmTenantSettings, DEFAULT 'SMART'
        - defaultQueueFilter column added to CrmTenantSettings, DEFAULT 'PENDING'
        - Existing rows unchanged

[ ] 2. GET /crm/settings returns defaultQueueSort and defaultQueueFilter
        - Returns SMART and PENDING for tenants with no settings row
        - Returns correct values for tenants with existing rows

[ ] 3. PUT /crm/settings persists defaultQueueSort and defaultQueueFilter
        - PATCH { defaultQueueSort: "ORIGINAL" } updates to ORIGINAL
        - PATCH { defaultQueueFilter: "DUE" } updates to DUE
        - Invalid values rejected with 400

[ ] 4. GET /crm/queue?campaignId=<id> filters to that campaign
        - Returns only members of that campaign assigned to current user
        - Campaign filter combines with sort=smart and sort=original
        - Campaign filter combines with filter=pending/due/overdue/upcoming
        - Tab counts (pending/due/overdue/upcoming) scoped to campaignId
        - Returns 404 if campaign not found for tenant (cross-tenant blocked)
        - Returns 404 if campaignId belongs to another tenant

[ ] 5. Campaign dropdown on queue page
        - Shows "All campaigns" + active campaign names
        - Selecting a campaign reloads queue filtered to that campaign
        - Clear button removes campaign filter
        - Selected campaign persisted in URL (?campaignId=) and localStorage
        - Empty state shows "No leads in this campaign for this view"
        - Empty state has "Show all campaigns →" link

[ ] 6. Tenant defaults applied on first load
        - When no URL ?sort= and no localStorage preference: tenant defaultQueueSort used
        - When no URL ?filter= and no localStorage preference: tenant defaultQueueFilter used
        - URL params override everything (URL > localStorage > tenant default > fallback)

[ ] 7. CRM Settings — Queue Defaults section
        - "Smart Priority" / "Original Order" buttons for default sort
        - "Next Up" / "Due Today" / "Overdue" / "Upcoming" buttons for default filter
        - Clicking saves immediately to real API via PUT /crm/settings
        - Section visible to admin users only
        - Saving indicator shown during save

[ ] 8. Campaign filter in power mode
        - Power mode sticky header shows campaign name when filtered
        - Megaphone icon + campaign name visible in power bar

[ ] 9. Safety
        - No telephony changes
        - No auto-dial
        - sort=original unaffected

[ ] 10. API typecheck passes (0 errors)
[ ] 11. Portal typecheck passes (0 errors)
[ ] 12. prisma validate passes
```

---

## Phase 12B — Campaign Priority Weights + "Why this lead?" explanation

```
[ ] 1. Migration applies cleanly
        - Migration 20260514010000_crm_campaign_priority runs without error
        - CrmCampaignPriority enum created: LOW, NORMAL, HIGH, URGENT
        - CrmCampaign.priority column added with DEFAULT 'NORMAL'
        - All existing campaigns have priority = NORMAL after migration

[ ] 2. Campaign CRUD supports priority
        - POST /crm/campaigns with priority=URGENT creates campaign with URGENT
        - PATCH /crm/campaigns/:id with priority=HIGH updates priority
        - GET /crm/campaigns returns priority on every campaign
        - GET /crm/campaigns/:id returns priority
        - Omitting priority on create defaults to NORMAL

[ ] 3. Smart Queue ranking: campaign priority affects lead tiers only
        - Composite score: callback tiers 0/10/20 unaffected by campaign priority
        - URGENT fresh lead (30) ranks above NORMAL fresh lead (32)
        - NORMAL fresh lead (32) ranks above HIGH low-attempt (41) — same tier group
        - Overdue callback (0) outranks URGENT fresh lead (30) ← critical safety check
        - Due-today callback (10) outranks URGENT fresh lead (30)
        - Within same score: sortOrder ASC, createdAt ASC

[ ] 4. sort=original completely unaffected
        - sort=original ignores campaign priority entirely
        - Results identical to pre-12B behaviour

[ ] 5. Queue response includes campaign.priority
        - GET /crm/queue returns campaign.priority on each member
        - Both smart and original modes include it

[ ] 6. Portal: campaign list shows priority badge
        - URGENT campaigns: red badge "Urgent"
        - HIGH campaigns: orange badge "High"
        - NORMAL campaigns: no badge (normal is baseline)

[ ] 7. Portal: campaign create modal has priority selector
        - Normal / High / Urgent options (no Low in create for simplicity)
        - Selection reflected in POST body

[ ] 8. Portal: campaign detail page has priority selector
        - LOW / NORMAL / HIGH / URGENT buttons
        - Clicking updates campaign immediately via PATCH
        - Header shows priority badge when not NORMAL
        - Help text explains Smart Queue impact

[ ] 9. Portal: PowerCard "Why this lead?" badge
        - "Urgent campaign · fresh lead" — red chip for URGENT
        - "High priority · fresh lead" — orange chip for HIGH
        - "Urgent campaign · fewer attempts" — red chip
        - "Fresh lead, no attempts" — indigo chip for NORMAL fresh
        - "Overdue callback" still red, still outranks campaign labels
        - Badge only shown when sort=smart

[ ] 10. No auto-dial, no predictive dial, no telephony changes
        - Priority only reorders. Agent must still explicitly press Call.

[ ] 11. API typecheck passes (0 errors)
[ ] 12. Portal typecheck passes (0 errors)
[ ] 13. prisma validate passes
```

---

## Phase 11C — SMS Conversation Panel on Contact Detail

```
[ ] 1. Data source: timeline filter only
        - SMS conversation derived from existing CrmTimelineEvent rows
        - No new API endpoint added
        - smsEvents = timeline filtered SMS_SENT + SMS_RECEIVED, newest first, max 25

[ ] 2. SMS conversation panel renders
        - Contact with no SMS: shows "No messages yet."
        - SMS_SENT message: right-aligned blue bubble, to-phone chip, timestamp
        - SMS_RECEIVED message: left-aligned purple bubble, from-phone chip, timestamp
        - Panel header shows message count

[ ] 3. Reply composer
        - Calls real POST /crm/contacts/:id/sms
        - ⌘↵ sends, or Send button
        - Multi-phone selector if contact has >1 phone
        - On success: clears box, refreshes timeline (loadTimeline called correctly)
        - On failure: shows real error from API
        - No fake success

[ ] 4. doNotSms handling
        - doNotSms=true: opted-out notice replaces composer
        - doNotSms=false: composer always visible (no collapse toggle)

[ ] 5. "Last SMS in" hint in CRM Details
        - Only shown when at least one SMS_RECEIVED event exists
        - Uses existing timeline data (no extra fetch)
        - formatTimeAgo shows relative time

[ ] 6. Bug fix
        - handleSendSms now calls loadTimeline() correctly
          (previously set timeline state to the wrapper object instead of events array)

[ ] 7. Portal typecheck passes (0 errors)
```

---

## Phase 11B — Inbound SMS Timeline Events (SMS_RECEIVED)

```
[ ] 1. Migration applied
        - CrmTimelineEventType enum has SMS_RECEIVED in Prisma schema
        - Migration: 20260523020000_crm_sms_received_event/migration.sql

[ ] 2. Hook files in place
        - apps/api/src/crm/inboundSmsHook.ts registered in connectChatRoutes.ts
        - apps/worker/src/crmInboundSmsHook.ts imported in voipMsInboundSyncJob.ts
        - Both hook calls use .catch(() => {}) and do NOT await the webhook response

[ ] 3. No contact match → no event written
        - Inbound SMS from unknown sender: no CrmTimelineEvent created
        - Tenant with CRM disabled: no CrmTimelineEvent created

[ ] 4. Contact match → SMS_RECEIVED event created
        - Inbound from number matching ContactPhone: SMS_RECEIVED event in timeline
        - Event body = SMS text (first 500 chars)
        - Event metadata = { from, to, smsProviderMessageId? }
        - Event linkedId = ConnectChatMessage.id

[ ] 5. Idempotency
        - Sending same message twice (webhook + poll both fire): only one SMS_RECEIVED
        - linkedId check prevents duplicate events for same ConnectChatMessage.id

[ ] 6. Portal timeline rendering
        - SMS_RECEIVED events show purple MessageSquareDot icon
        - from/to chips + "inbound" badge visible in timeline item
        - Existing SMS_SENT events unaffected

[ ] 7. No regressions
        - Inbound VoIP.ms webhook still returns "ok" immediately
        - Chat/SMS threads still created correctly
        - Push notifications still fire
        - API /health OK; telephony unaffected

[ ] 8. Typecheck passes (api + portal + worker) → 0 CRM errors each
```

---

## Phase 11A — SMS from CRM Contact

```
[ ] 1. Migration applied
        - CrmTimelineEventType enum has SMS_SENT value in Prisma schema
        - Migration SQL: 20260523010000_crm_sms_timeline_event/migration.sql

[ ] 2. API endpoint exists and works
        - POST /crm/contacts/:id/sms returns 200 with { ok, to, from, provider, providerMessageId }
        - doNotSms contact returns 400 do_not_sms
        - Contact with no phones returns 400 no_phone
        - Wrong tenant contact returns 404 not_found
        - Unauthenticated returns 401
        - SMS not configured for tenant returns 503 sms_not_configured
        - Provider error returns 502 sms_send_failed (no timeline event written)

[ ] 3. Timeline event written only on success
        - After real send, GET /crm/contacts/:id/timeline shows SMS_SENT event
        - Event body contains message text (up to 500 chars)
        - Event metadata contains { to, from, provider }

[ ] 4. Portal contact detail page
        - Send SMS panel visible when contact has phones and doNotSms is false
        - Send SMS panel hidden when doNotSms is true (shows "opted out" notice instead)
        - Panel collapsed by default (▼ toggle)
        - Phone selector shown when contact has multiple phones
        - Message counter: N/1600
        - Send button disabled while sending or when message is empty
        - On success: "✓ Sent" indicator + message cleared + timeline refreshed
        - On error: error message shown without fake success

[ ] 5. Timeline rendering
        - SMS_SENT events show MessageSquareDot icon (cyan)
        - SMS_SENT events show to/from/provider metadata chips
        - Body (message text) shown in timeline item

[ ] 6. No telephony/PBX changes
        - /health still returns {"ok":true}

[ ] 7. Portal + API typecheck passes
        pnpm tsc --noEmit (apps/portal, apps/api) → 0 errors each
```

---

## Phase 10B — Callback/Task Alert Strip and Activity Digest

```
[ ] 1. Dashboard alert strip renders from real data
        - /crm/dashboard fetches GET /crm/reports/follow-ups on load
        - Alert strip shows overdue callbacks (red), due today callbacks (amber),
          overdue tasks (red), due today tasks (amber)
        - Each item links to the correct real page:
            - overdue callbacks  → /crm/queue?filter=overdue
            - due today          → /crm/queue?filter=due
            - overdue tasks      → /crm/tasks?due=overdue
            - due today tasks    → /crm/tasks?due=today

[ ] 2. Dashboard "all caught up" state
        - When all 4 counts are 0 → shows green "All caught up" strip
        - When endpoint fails gracefully → strip hidden, no crash

[ ] 3. Queue manual-mode alert strip
        - Compact red/amber banner above the tabs when counts.overdue > 0 or counts.due > 0
        - "X overdue · Y due today" with "Call overdue →" and "Call due today →" buttons
        - Clicking the buttons calls switchFilter("overdue") / switchFilter("due") correctly
        - Strip is HIDDEN when both counts are 0
        - Strip does NOT appear in power mode (power mode already has health banner)

[ ] 4. Browser notification button
        - Button "Enable reminders" only appears when:
            a) 'Notification' in window
            b) Notification.permission !== 'denied'
        - NOT shown on page load automatically (explicit user action only)
        - On click: requests permission; if granted fires ONE OS notification with overdue count
        - Shows "Reminders on" indicator when permission already granted

[ ] 5. No API changes
        - Confirm: no changes to apps/api/**
        - Dashboard uses existing GET /crm/reports/follow-ups (already deployed)
        - Queue uses already-loaded QueueCounts from GET /crm/queue

[ ] 6. Portal typecheck passes
        pnpm tsc --noEmit (apps/portal) → 0 errors

[ ] 7. Phone system unaffected
        - /health returns {"ok":true}
        - No telephony changes
```

---

## Quick Commands

```bash
# Run typechecks
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/portal/tsconfig.json

# Verify migration order (all crm migrations should be 20260522*)
Get-ChildItem packages/db/prisma/migrations -Directory | Where-Object { $_.Name -like "*crm*" } | Sort-Object Name

# Check for duplicate CRM route registrations
grep -rn 'app\.get\|app\.post\|app\.patch\|app\.put\|app\.delete' apps/api/src/crm/

# Verify CDR hook is non-blocking
grep -n 'fireCrmCdrHook' apps/api/src/server.ts
```
