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
| Campaign auto-completes | When all members are in terminal status → campaign `status: "COMPLETED"` |

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
