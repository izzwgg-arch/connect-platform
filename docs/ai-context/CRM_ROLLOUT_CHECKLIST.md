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
