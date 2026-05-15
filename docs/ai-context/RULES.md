# RULES — hard guardrails

> Read `CURSOR_START_HERE.md` first. These are non-negotiable rules for any change to
> Connect Communications. They exist because each one has been violated in the past
> and caused a regression. The platform is in production. Do not bend these without
> explicit human approval in the chat.

---

## Tenant isolation

1. **Every Prisma query that returns tenant-scoped data must include `tenantId` in
   the `where` clause.** No exceptions for "convenience" reads.
2. **Telephony WS payloads are tenant-filtered.** The filter is:
   `record.tenantId === viewer.tenantId` extended by `tenantAliasMatcher` (handles
   `vpbx:<slug>` ↔ Connect CUID). Do not bypass this matcher.
3. **AstDB family writes must scope to `connect/t_<tenantSlug>`** (or `connect/didmap/<e164>`
   when the DID belongs to that tenant, or the `connect/system` global family).
   The endpoint `/telephony/internal/ivr-publish` enforces this with a hard check —
   do not relax `family_scope_mismatch`.
4. **MOH and IVR runtime keys must never reference another tenant's slug.**
5. **JWTs must always carry `tenantId` for normal users.** Admin/superadmin tokens
   may carry `tenantId=null` but must satisfy a `requireSuperAdmin`/`requireAdmin`
   check before reaching tenant-scoped data.

---

## Do not break existing tenants

6. **No backwards-incompatible API contract change without a migration plan.**
   Renaming a field, removing a route, or changing a field's type can crash
   live tenant clients (browser portal, desktop, mobile).
7. **No silent default-flip.** If you change a default (e.g. `PBX_TIMEZONE`,
   `MOBILE_PUSH_SIMULATE`, `SMS_PROVIDER_TEST_MODE`), call it out in the PR/chat
   summary.
8. **Mobile push fields are part of the contract.** The worker stringifies all FCM
   data values to keep Android cold-start delivery working. Do not remove fields
   from `INCOMING_CALL`, `INVITE_CANCELED`, or `MISSED_CALL` payloads without
   updating native Android handlers.

---

## Server safety

9. **SSH port 22 must remain open and configured exactly as it is.** No firewall,
   nginx, or iptables/ufw edits.
10. **Never edit `/etc/nginx`, `/etc/ssh`, `/etc/ufw`, `/opt/connectcomms/env/`,
    or `/etc/systemd/...`** from the codebase, scripts, or agent commands. These are
    operator-owned.
11. **Do not change Docker network names, volume mounts, or compose service names**
    without coordinated docs + deploy plan. Service discovery (e.g.
    `http://api:3001`, `http://telephony:3003`) and persistent volumes
    (`moh-assets`, `ivr-prompts`, `chat-attachments`) must keep the same names.

---

## Data exposure

12. **Tenant data must never leak across tenants.** Audit any new endpoint that
    accepts a `tenantId` from the body/query — verify it matches `request.user.tenantId`
    or a super-admin scope.
13. **Recording, voicemail, and chat attachment URLs must be signed.** Do not
    bypass `mohStorage.ts::buildSignedDownloadUrl`, `chatSignedUrl`, or the equivalent
    prompt signing.
14. **Encrypted credentials stay encrypted.** Use `@connect/security`
    (`encryptJson`/`decryptJson`). Never log decrypted secrets.

---

## CRM module (Phase 16A)

- **`DELETE /crm/contacts/:id` is soft-archive only** — sets `Contact.active=false` and `archivedAt=now()`. Must not hard-delete contacts, phones, emails, timeline, tasks, notes, or campaign members in that request.
- **Archiving preserves historical CRM data** — timeline, SMS-linked events, campaign memberships, and tasks stay in the database for admin review. Default list/search and screen-pop exclude archived rows; admins may use `GET /crm/contacts?includeArchived=true` or open an archived contact in the portal to audit before **Restore**.
- **Archived or inactive contacts are not live actionable queue work (Phase 16C)** — `GET /crm/queue`, its tab counts, `POST /crm/queue/next`, and agent metrics that represent “my queue” / live callbacks exclude members whose `Contact` is `active=false` or `archivedAt != null`. `CrmCampaignMember` rows are not deleted; campaign history and `/crm/reports/campaigns` roster-style totals can still include archived contacts unless the metric is explicitly live-queue scoped.

---

## Concurrency & duplication

15. **Do not duplicate background workers, telephony consumers, or BullMQ queue
    consumers.** One process per role:
    - One AMI client (telephony).
    - One ARI client + bridged poller (telephony).
    - One BullMQ `sms-send` consumer (worker).
    - One per-cycle setInterval per scheduled job (worker).
    Spawning a second instance breaks at-least-once into duplicate-call-counted.
16. **Do not introduce aggressive polling** when AMI/ARI events already cover the
    state. The 5 s ARI bridged poll, 60 s presence refresh, 60 s voicemail fallback,
    5 s call invite expiry, and 5 min IVR/MOH reconcile cycles are deliberately tuned.
17. **Honor the global serialization in the deploy queue.** Only one deploy job runs
    at a time. Do not bypass with parallel `docker compose` or `deploy-tag.sh`.

---

## Architecture posture

18. **Do not rewrite architecture unless explicitly requested.** Surgical fixes only.
    Refactors must be standalone PRs / chats with explicit approval.
19. **Prefer surgical fixes over generalizations.** Adding a feature flag/env switch is
    cheaper than rewriting a module.
20. **Preserve backwards compatibility** in JSON shapes returned to portal/mobile
    clients. Add fields, do not remove or rename.

---

## Deployment, security, infra

21. **All deploys go through the queue.** See `AGENTS.md`. Never run
    `pnpm prisma migrate`, `docker compose ...`, or `deploy-tag.sh` manually on the
    server.
22. **Migrations only run during the `api` deploy job**, and only when
    `packages/db/prisma/**` actually changed.
23. **Never restart all PM2 processes.** Touch only the target service.
24. **Never change deployment, security, or firewall configs** unless the user
    explicitly asks for it in this chat.

---

## Risky changes

25. **All risky changes must include rollback notes** in the chat summary:
    - What files changed.
    - Exact revert command (`git revert <sha>` or list of file rollbacks).
    - Whether the deploy queue rollback flow applies.
26. **All telephony changes must include forensic validation** — a before/after
    capture from `GET /forensic`, `GET /diagnostics`, plus VitalPBX active channel
    count. See `docs/LIVE_CALL_FORENSIC_RUNBOOK.md`.
27. **All PBX-impacting changes must include a validation plan** even if no
    AstDB writes occur. State the expected behavior, the test method, and the
    failure mode.

---

## Mobile call state

28. **Mobile call state is HIGH risk.** Any change in `NotificationsContext.tsx`,
    `SipContext.tsx`, `CallSessionManager.tsx`, `voipPush.ts`, `callkeep.ts`,
    `telecom.ts`, or the native FCM/keepalive code must be:
    - reproduced with logs first,
    - paired with a clear root cause, and
    - tested on a real device (UNKNOWN how reliably emulators reproduce push-wake).
29. **Never silently change the FCM payload shape.** Cold-killed Android apps
    rely on `data`-only messages to wake `FirebaseMessagingService` and stop the
    ringtone — see the long inline comment in
    `apps/worker/src/main.ts::sendPushToUserDevices`.

---

## Voicemail and recordings

30. **Voicemail rows must dedupe by `pbxMessageId`.** The worker upsert prefers
    VitalPBX's `msg_id` and falls back to a deterministic composite. Do not invent
    new keys.
31. **Recording streaming must always go through `apps/api`**, never the PBX
    directly. Do not link clients to PBX URLs.

---

## CRM module (Phase 1A+)

32. **CRM is optional — never make it a hard dependency for any telephony or core Connect feature.**
    - If `CrmTenantSettings` row is absent or `enabled=false`, all CRM API routes must return
      gracefully (settings endpoint returns defaults; write endpoints return 403 `crm_not_enabled`).
    - No CRM code in the telephony service (`apps/telephony`). CRM reads telephony events; telephony must never read CRM.
    - No CDR hooks in CRM until explicitly designed. The existing `ConnectCdr` and `CallRecord` models are telephony-owned; CRM may *read* them but must not write or delete them.
    - `CrmUserAccess` absence = no CRM agent access, but normal phone system works unchanged.
    - All future CRM tables must include `tenantId` and be filtered by it in every query.

33. **Every `/crm/*` route (except `GET /crm/settings`) must call `requireCrmAccess` from `apps/api/src/crm/guard.ts`.**
    - `requireCrmAccess` checks: (1) JWT present, (2) `CrmTenantSettings.enabled`, (3) `CrmUserAccess.enabled` for regular users (admins bypass step 3).
    - Do not inline these checks in individual handlers — always use the guard.
    - Error codes must be: `crm_not_enabled` (403), `crm_user_not_enabled` (403), `crm_permission_denied` (403).
    - Admin-only CRM operations (settings write, user management) must use `requireCrmAdmin` instead.

34. **`CrmContactMeta` is a metadata overlay, not a duplicate contact store.**
    - All contact data (names, phones, emails, addresses) lives in `Contact` and `ContactPhone`/`ContactEmail`.
    - Never copy or mirror phone numbers or emails into `CrmContactMeta`.
    - The existing `/contacts/*` API is NOT the CRM contacts API — they are separate surfaces sharing the same underlying `Contact` row.

35. **`CrmTimelineEvent` is append-only. Never delete or update timeline event rows directly.**
    - The only allowed update is patching `body` on a `NOTE_ADDED` event when its linked note is edited — done via `updateLinkedTimelineBody()` in `timelineHelper.ts`.
    - Always use `writeTimelineEvent()` from `timelineHelper.ts` to write new events. Never call `db.crmTimelineEvent.create()` directly from route handlers.
    - `CDR_INBOUND` / `CDR_OUTBOUND` event types are **reserved**. Do not write them until the Phase 2 CDR hook is implemented.

36. **CRM timeline events must be non-blocking.**
    - `writeTimelineEvent()` catches and logs all errors internally. Timeline failures must never propagate to the caller or cause a 500 on the primary operation (contact create, note create, stage change, etc.).

37. **CRM import uses synchronous in-request processing.**
    - Max file size: 5 MB. Max rows: 5,000. CSV only; XLSX deferred.
    - Row errors are captured in `CrmImportBatch.errors` JSON and never abort the entire batch.
    - Import dedup uses `ContactPhone.numberNormalized` and `ContactEmail.email` — always within the tenant. Never creates duplicate contacts for the same normalized phone or email.
    - Import never downgrades an existing `CrmContactMeta.stage`. It only upserts a LEAD stage if no CrmContactMeta exists yet.
    - Import uses `source: "IMPORT"` on new `Contact` rows so they can be distinguished from manually-created contacts.

39. **CRM screen pop must never modify telephony behavior.**
    - `CrmScreenPop` only *reads* from `useTelephony().activeCalls`. It never writes to the WS, does not call any telephony API, and does not affect call routing.
    - API: `GET /crm/contacts/lookup` returns 403 silently when CRM is disabled — screen pop catches the error and shows nothing.
    - Deduplication is `seenLinkedIds` ref — never re-pops the same `linkedId` in the same session.
    - Do not add `await` to any CRM lookup inside a telephony event handler.

38. **The CRM CDR hook (`fireCrmCdrHook`) must NEVER block CDR ingest.**
    - Call site in `/internal/cdr-ingest` (server.ts) must be: `fireCrmCdrHook({...}).catch(() => {})` — no `await`.
    - The hook itself is fully wrapped in try/catch at every level and never throws.
    - If CRM is disabled for the tenant, the hook returns immediately without any DB queries.
    - Only contacts with `CrmContactMeta` (CRM-enrolled) are linked. Do not write timeline events for un-enrolled contacts.
    - Do not create duplicate `CrmTimelineEvent` rows for the same `(contactId, linkedId, type)` combination. The partial unique index on `CrmTimelineEvent` and the lookup-before-create in the hook both guard this.

39. **CRM checklist responses must NOT block the calling API route.**
    - `writeTimelineEvent()` for `CHECKLIST_COMPLETED` is called without `await` in `checklistRoutes.ts`.
    - A failed timeline write must not cause the `POST /crm/checklists/:id/respond` route to return an error.
    - `answers` JSON is stored as-is; never mutate it after save.

40. **CRM scripts and checklists are soft-deleted only.**
    - Use `isActive = false` (archive). Do NOT hard-delete `CrmScript` or `CrmChecklist` rows.
    - `CrmChecklistItem` rows are deleted only when their parent checklist's items are replaced via `PATCH /crm/checklists/:id` with a new `items` array (full replace).
    - `CrmChecklistResponse` rows are immutable once created. No update or delete endpoints.

42. **Disposition saves are transactional for primary data, non-blocking for timeline.**
    - `POST /crm/contacts/:id/disposition` wraps `CrmContactMeta` update + optional `CrmContactNote` + optional `CrmContactTask` in a single `db.$transaction([...])`.
    - All `writeTimelineEvent()` calls happen **after** the transaction, without `await`.
    - A timeline write failure must not roll back or fail the disposition save.
    - The disposition endpoint returns `{ ok, disposition, stageChanged, noteCreated, taskCreated }` — callers should use these flags to update the UI without re-fetching when possible.

43. **`STAGE_CHANGED` from disposition only fires if the stage actually changes.**
    - Compare `nextStage` against `CrmContactMeta.stage` before writing the event.
    - Do not write `STAGE_CHANGED` if `nextStage === currentStage` or if `nextStage` is not provided.

41. **Live Call Workspace must not call or modify telephony state.**
    - `LiveCallBanner` reads from `useTelephony()` (read-only context).
    - No hangup, mute, hold, or transfer actions implemented in the workspace.
    - Script/checklist data is CRM-only; no coupling to Asterisk, VitalPBX, or AMI.

---

## Logging & telemetry

35. **Do not log secrets, JWTs, decrypted credentials, raw SIP passwords, or
    Twilio/VoIP.ms tokens.**
36. **Use the `[CALL_TIMELINE]` structured log lines** when adding tracepoints to
    call flow — they are parsed by ops scripts.
37. **Use Pino's `childLogger("Telephony")` (or equivalent)** for telephony logs to
    keep filters working.

44. **Campaign queue uses `CrmCampaignMember` directly — no separate queue table.**
    - `GET /crm/queue` queries `CrmCampaignMember` filtered by: `assignedToUserId = currentUser`, campaign/status predicates for the selected tab, `campaign.status = ACTIVE` (or scoped campaign), and **live contact only:** `contact.active = true` AND `contact.archivedAt IS NULL` (Phase 16C).
    - Order: `sortOrder ASC`, `createdAt ASC`.
    - Do not add a separate queue model; the member row IS the queue item.

45. **`PATCH /crm/queue/:memberId { action: "defer" }` moves item to end of queue, not next day.**
    - Sets `sortOrder = max(sortOrder in campaign) + 1`, resets status to `PENDING`.
    - Do not set a date/time for deferred items — use `CrmContactTask` if a specific callback time is needed.

46. **Campaign member status is updated by `PATCH /crm/queue/:memberId { action: "outcome", disposition }` only if memberId is present.**
    - This is called non-blocking from `live-call/page.tsx` after a successful disposition save.
    - Disposition → member status mapping: "convert"/"closed" → `CONVERTED`, "callback" → `CALLBACK`, "not interest"/"dnc" → `DO_NOT_CALL`, else → `CONTACTED`.
    - Always increments `attemptCount` and sets `lastAttemptAt = now()` for outcome actions.

47. **Campaigns must always be tenant-scoped.**
    - All `CrmCampaign` and `CrmCampaignMember` queries must include `tenantId` in their `where` clause.
    - No cross-tenant member or campaign access is possible by design.

48. **Campaign auto-completion is non-blocking and fire-and-forget.**
    - `checkAndAutoCompleteCampaign(campaignId, tenantId)` is called with `.catch(() => {})` — never awaited.
    - Terminal statuses (campaign can complete): `CONVERTED`, `SKIPPED`, `DO_NOT_CALL`, `CONTACTED`.
    - **Phase 16D — actionable non-terminal:** `PENDING`, `IN_PROGRESS`, `CALLBACK` **only on live contacts** (`active=true` and `archivedAt` null). Archived/inactive contacts do not block auto-completion; historical `CrmCampaignMember` rows are unchanged.
    - Auto-complete only fires on ACTIVE or PAUSED campaigns (uses `updateMany` with status filter).
    - Empty campaigns (zero members) are never auto-completed.
    - After a contact is soft-archived, affected campaigns are re-checked so a campaign whose only remaining non-terminal rows were archived can move to `COMPLETED` without mutating member rows.

49. **`CALLBACK` is intentionally non-terminal for campaign auto-completion.**
    - A member in `CALLBACK` status means there is still work to do (call them back).
    - Campaign will not auto-complete while any **live-contact** member is `PENDING`, `IN_PROGRESS`, or `CALLBACK`.

50. **`GET /crm/campaigns/:id/contacts/available` excludes existing members server-side.**
    - Do not load all contacts in the UI and filter client-side.
    - This route returns only CRM-enrolled (`crmMeta IS NOT NULL`), active contacts not already in the campaign.
    - Supports `?q=` search (name/phone/email) and `?page=`/`?limit=` pagination. Limit cap: 50.

51. **Live Workspace campaign prefill does not force selection — it only sets a default.**
    - `ScriptPanel` and `ChecklistPanel` use a `didPrefill` ref to apply the default once on first render.
    - If the campaign has no scriptId/checklistId, panels remain at "— Select —" (user picks manually).
    - User can always override the prefilled selection.

52. **`callbackAt` on `CrmCampaignMember` is set via three paths — they must not conflict.**
    - **Queue action** `PATCH /crm/queue/:memberId { action: "set-callback", callbackAt, callbackNote }` — explicit scheduling from the queue UI or campaign detail.
    - **Campaign member PATCH** `PATCH /crm/campaigns/:id/members/:memberId { callbackAt, callbackNote }` — inline editing from campaign detail table.
    - **Disposition endpoint** `POST /crm/contacts/:id/disposition { memberId, followUpAt, disposition }` — auto-set when disposition contains "callback" and `followUpAt` is provided. This is non-blocking and does NOT update `status`; the queue PATCH action handles that separately.
    - These paths write `callbackAt` only — they do NOT conflict because status is managed by the queue PATCH.

53. **Queue callback tab filters are time-bounded to avoid stale data.**
    - `?filter=overdue` → `callbackAt < startOfToday` (past due, need immediate action)
    - `?filter=due` → `callbackAt <= endOfToday` (includes overdue — call today)
    - `?filter=upcoming` → `callbackAt >= startOfTomorrow OR callbackAt IS NULL`
    - All filters also require `status = CALLBACK`, `assignedToUserId = currentUser`, `campaign.status = ACTIVE`.
    - Tab badge counts are returned alongside the queue data in `counts: { pending, due, overdue, upcoming }`.

54. **`clear-callback` action resets member to `PENDING`, not `CALLBACK`.**
    - Sets `callbackAt = null`, `callbackNote = null`, `status = PENDING`.
    - This re-queues the contact in the "Next Up" tab for normal outreach.
    - Do not set status to CONTACTED on clear — the contact hasn't been reached.

55. **`assign-to-me` queue action is tenant-scoped by design.**
    - `PATCH /crm/queue/:memberId { action: "assign-to-me" }` sets `assignedToUserId = JWT.sub`.
    - The route already verifies `tenantId` ownership before updating, so no cross-tenant assignment is possible.

56. **CRM report endpoints use `groupBy` for aggregate counts — no per-row loops.**
    - `GET /crm/reports/campaigns`: fetches all campaigns (cap 200) + one `groupBy(campaignId, status)` for member counts + one `groupBy(campaignId)` for attempt sums. O(1) queries regardless of member count.
    - `GET /crm/reports/agents`: fetches CRM user list + 5 parallel `groupBy` queries. Never loops over users.
    - `GET /crm/reports/follow-ups`: 5 counts + 5 `findMany` (capped at 100 rows each). No correlated subqueries.
    - Do NOT add per-user or per-campaign subqueries inside report endpoints. If the data isn't available in a groupBy, omit it or document the gap.

57. **Report endpoints have no caching layer — they hit the database on every request.**
    - This is intentional for Phase 4A. Volume is low (manager use, not polling).
    - If reports become slow (> 500ms p95), add a `reportCache` table or Redis TTL cache — do NOT add it preemptively.
    - All queries are bounded: `take: 200` on campaigns, `take: 100` on follow-up detail rows, all filtered by `tenantId`.

58. **`can_view_crm_reports` permission is required for all report endpoints and the `/crm/reports` page.**
    - It is included in both `can_view_crm` and `can_manage_crm` permission bundles.
    - Report endpoints use `requireCrmAccess` (not admin-only) — all CRM users can view reports.
    - The `/crm/reports?tab=` URL param enables deep-linking from dashboard stat cards.
    - **Agent grant via `CrmUserAccess`:** `GET /me` expands `["can_view_crm"]` into `portalPermissionSet`, which includes `can_view_section_crm`, `can_view_crm_reports`, and Wallboard — but **not** `can_view_crm_import` or `can_view_crm_settings` (those sit in the `can_manage_crm` bundle). The portal sidebar hides **Import Leads** and **CRM Settings** for agents. At the HTTP layer, `POST /crm/import/upload` still uses `requireCrmAccess` only; tightening import to admin would be a separate RBAC change.

59. **CRM local presence is advisory only. It does NOT touch the PBX or SIP call setup.**
    - `selectCrmCallerId()` returns a DID to display to the agent, but the actual SIP caller ID
      is still controlled by the PBX per-extension configuration.
    - `POST /crm/calls/originate` must never contain AMI originate, ARI channel create, or any
      PBX action. It only selects a caller ID and logs the intent.
    - The actual call is placed client-side: the UI dispatches `crm:dial` event (or calls
      `phone.dial()` directly), which goes through the existing `useSipPhone` → JsSIP path.
    - `selectCrmCallerId()` never throws. If anything fails, it returns `undefined` and the
      call proceeds with the default PBX caller ID.

60. **Only tenant-owned ACTIVE PhoneNumber rows may be added to `CrmCallerIdPool`.**
    - The API validates `PhoneNumber.tenantId === requestingTenant.id` on POST.
    - `selectCrmCallerId()` double-checks `phoneNumber.tenantId === tenantId` after the join.
    - This prevents cross-tenant caller ID spoofing.
    - If a PhoneNumber is released (status → RELEASED/INACTIVE) its pool entries are still
      filtered out by `selectCrmCallerId` because it checks `status === "ACTIVE"`.

62. **`crm:dial` CustomEvent must always route through the existing FloatingDialer `dialTarget()` path.**
    - `FloatingDialer` is the single owner of `phone.dial()` for all UI-triggered calls.
    - No CRM code may call `phone.dial()` directly — it must dispatch `crm:dial` and let
      the FloatingDialer listener handle it.
    - `dialTarget()` already guards: trims the target, sets dialpad input, opens the dialer,
      and only calls `phone.dial()` when `regState === "registered"`.
    - The `crm:dial` handler must NEVER: modify SIP headers, change caller ID at SIP level,
      add extra dial prefixes, or bypass the regState check.
    - If `dialTarget` is ever renamed or moved, the `crm:dial` listener must be updated too.

61. **Local presence `areaCode3` is admin-set, not auto-detected from PhoneNumber.areaCode.**
    - `PhoneNumber.areaCode` may be null or inconsistently formatted for ported numbers.
    - Pool entries have their own `areaCode3` field (exactly 3 digits) set by the admin.
    - The "Add to pool" UI pre-fills `areaCode3` from `PhoneNumber.areaCode` if available,
      but the admin can override it. This is intentional.

65. **Phone/email add deduplicates at the DB level.**
    - `POST /crm/contacts/:id/phones` normalises the raw number with `normalisePhone()` and rejects
      if the same `(contactId, numberNormalized)` pair already exists (409). No silent overwrite.
    - `POST /crm/contacts/:id/emails` lowercases the email and checks the `(contactId, email)` unique
      index. 409 on collision.
    - Delete is unconditional — no "must keep one primary" guard at the API layer. UI confirms before
      deleting. If the deleted entry was the only primary, the contact will have no primary phone/email
      until the user designates one.

66. **Bulk reassign is admin-only, capped at 500, and never crosses tenants.**
    - `POST /crm/contacts/bulk-reassign` uses `requireCrmAdmin` and the `where: { tenantId, contactId: { in: ids } }`
      filter — contacts from other tenants are silently excluded.
    - `assignedToUserId` is validated to belong to the same tenant before the update runs.
    - No timeline events are written for bulk reassign (too noisy for multi-contact ops).
    - Clear assignment (`assignedToUserId: null`) is allowed explicitly.
    - Individual `PATCH /crm/contacts/:id` assignment changes DO write a non-blocking
      `ASSIGNED_TO_USER` timeline event with `{ fromUserId, toUserId, fromName, toName }` metadata.

63. **Contact merge is admin-only and atomic.**
    - Only `ADMIN / TENANT_ADMIN / SUPER_ADMIN` roles may call `POST /crm/contacts/merge`.
    - Both contacts must belong to the same tenant (enforced by DB query + `tenantId`).
    - The merge transaction moves CRM data (timeline, notes, tasks, checklist responses,
      campaign memberships) from `mergeContactId` → `keepContactId` before archiving the
      merged contact. Cross-tenant data movement is impossible.
    - Campaign membership conflicts (keepContact already enrolled in the same campaign) are
      silently skipped — never error, never double-enroll.
    - Merged contact is archived via `active=false, archivedAt=now`. It is NOT hard-deleted.
      Its ID remains valid in foreign keys for audit purposes.
    - A `CONTACT_MERGED` timeline event is written on `keepContact` after the transaction.

64. **Duplicate detection is suggestion-only.**
    - `GET /crm/contacts/:id/duplicates` returns at most 5 candidates matched by phone,
      email, or display name. It never auto-merges or hides contacts.
    - Match is based on `numberNormalized` (phone) or `email` (email) or
      case-insensitive `displayName`. No fuzzy/Levenshtein — keep it cheap.
    - Any CRM user can view duplicates. Only admins see the Merge button in the UI.

---

## CRM Power Dialer (Phase 8A+)

65. **Power Dialer must never bypass the existing dialer path.**
    - The Call button in Power Dialer mode dispatches `window.dispatchEvent(new CustomEvent("crm:dial", { detail: { target: phoneNumber } }))`.
    - This fires the existing `FloatingDialer` listener → `phone.dial()` path.
    - Do not call SIP APIs, JsSIP, or any SIP stack directly from the power dialer UI.

66. **Power Dialer must never auto-dial in Phase 8A.**
    - No countdown that places a call automatically.
    - No "dial next" triggered without explicit user action (button click or `C` key press).
    - Optional countdown UI may show the next lead's info after an action, but must never
      call `phone.dial()` or dispatch `crm:dial` without the agent pressing the button.

67. **SIP registration gate is mandatory.**
    - If `phone.regState !== "registered"`, the Call button must be disabled and a visible
      amber warning must be shown.
    - Never dispatch `crm:dial` when SIP is not registered.

68. **Power mode state is URL-based (`?mode=power`), not stored in global state.**
    - This keeps it simple, survives refresh, and allows direct linking.
    - `pause` state is local React state (intentionally not persisted — resets on page load).

69. **Keyboard shortcuts (C/S/D on queue, O on live-call) must not fire while the user
    is typing.**
    - Guard: `if (["INPUT","TEXTAREA","SELECT"].includes(tgt.tagName)) return;`
    - Guard: `if (tgt.getAttribute("contenteditable") === "true") return;`
    - Guard: `if (e.metaKey || e.ctrlKey || e.altKey) return;`
    - These guards must never be removed.

70. **Inline outcome buttons on PowerCard (Phase 8B+) must call real API endpoints — never
    UI-only state changes.**
    - Every outcome button (No Answer, Voicemail, Interested, Not Interested, Callback,
      Converted) must call `POST /crm/contacts/:id/disposition` to record the disposition
      on the contact, and `PATCH /crm/queue/:memberId` with `action: "outcome"` to update
      member status + increment attempt count.
    - Outcomes must **not** be simulated client-side. An API error must surface an inline
      error message; the queue must not advance until both calls succeed.
    - The Callback outcome **must** collect a `followUpAt` datetime before saving. Saving
      without a datetime is not allowed (Save button is disabled until datetime is chosen).
    - These rules apply to any future outcome added to the inline panel.

71. **"Not Interested" ≠ "Do Not Call". Never conflate them.**
    - "Not Interested" is a soft outcome: the agent spoke to the contact and they declined.
      The contact's `lastDisposition` is set to "Not Interested" on the contact record, but
      the queue member status is set to `CONTACTED` (not `DO_NOT_CALL`).
    - Implementation: send `disposition: "Not Interested"` to `POST /crm/contacts/:id/disposition`
      (the real record) but send `disposition: "contacted"` to `PATCH /crm/queue/:memberId`
      (avoids the server-side `d.includes("not interest")` → `DO_NOT_CALL` pattern match).
    - "Do Not Call" (`action: "dnc"`) is a **hard, explicit action** in the Queue Actions
      section with its own confirmation dialog. It sets `DO_NOT_CALL` and should never be
      triggered automatically by a soft outcome.
    - Do not change this split without a product decision.

72. **Optional outcome notes on PowerCard (Phase 8C+) must write real CRM notes.**
    - The "Add note" textarea in the outcome panel passes `note` to
      `POST /crm/contacts/:id/disposition`, which creates a real `CrmContactNote` row and
      a `DISPOSITION_SET` timeline event with the note body.
    - Empty or whitespace-only notes must not be sent (the endpoint would create a blank
      note row). Only send `note` if `outcomeNoteText.trim()` is non-empty.
    - After a successful save the note field must be cleared. This is handled automatically
      by `key={member.id}` on `<PowerCard>` which forces a full unmount on member change.

73. **Wrap-up timer (Phase 8F+) must NEVER auto-dial or trigger `crm:dial`.**
    - The `WrapUpOverlay` countdown auto-advances ONLY by changing UI state
      (`setWrapUpActive(false)`), never by dispatching telephony events.
    - All `setInterval` / `setTimeout` instances created by the wrap-up effect must be
      cleared in the `useEffect` cleanup function. Do not leave dangling timers on unmount
      or navigation. Use `useRef` to track the interval ID and clear it on every state branch.
    - The countdown MUST NOT start when `paused === true`. If the user pauses mid-countdown
      the timer must stop immediately (handled by including `paused` in the effect deps).
    - "Skip Next Lead" during wrap-up calls the existing `handleAction(id, "skip")` endpoint;
      it does not restart the wrap-up countdown.

74. **Persistent Power Dialer pause (`localStorage`).**
    - Pause state is stored under the key `"crm_power_queue_paused"` in `localStorage`.
    - On mount, read this key to restore the paused state so agents are not surprise-unpaused
      after a page reload or navigation.
    - When unpausing, `localStorage.removeItem(PAUSE_STORAGE_KEY)` — do not write `"false"`.
    - Never read/write this key outside `QueuePageInner`. It is a UI preference, not data.

75. **Power mode queue filter is URL-driven (`?filter=` param).**
    - The filter toggle in the Power Dialer sticky header navigates to
      `?mode=power&filter=due` or `?mode=power&filter=overdue` (pending = no `filter` param).
    - This keeps the selected filter in browser history and survives hard reload.
    - Manual mode tabs are NOT URL-driven and must remain unchanged (local `filter` state).
    - Do not mix manual-mode tab state with power-mode URL filter state.

76. **CRM Wallboard is read-only; no telephony controls.**
    - `/crm/wallboard` aggregates existing report endpoints and live telephony WS data.
    - It MUST NOT render any button that dials, transfers, holds, or terminates a call.
    - Live call data comes from `useTelephony().activeCalls` (TelephonyContext); never add
      SIP or AMI commands to the wallboard page.
    - Do not add a new WebSocket service for the wallboard. Use the existing telephony WS
      for live call state and REST polling (≤ 60 s) for CRM report data.
    - Timer cleanup: use `useRef` for interval IDs and clear them in the `useEffect` return.
      The per-call duration ticker, the report-refresh interval, the 1-second countdown tick,
      and the TV-mode clock tick must ALL be cleaned up on unmount.

77. **Wallboard TV mode is a CSS overlay, not a layout change.**
    - TV mode (`?tv=1`) renders a `position: fixed; inset: 0; z-index: 50` div that overlays
      the global `AppShell` sidebar. Do NOT modify `AppShell`, `PlatformLayout`, or any shared
      layout/provider file to achieve fullscreen.
    - The TV mode URL param is written with `window.history.replaceState` to avoid a full
      page navigation; `setTvMode` state is toggled in-memory alongside the URL update.
    - The TV mode clock ticks every 10 s (not every 1 s) to minimise re-renders.

78. **Wallboard agent idle badges are advisory only, never punitive.**
    - Idle/attention badges are derived from fields already in the `/crm/reports/agents`
      response (`dispositionsToday`, `callbacksDueToday`, `assignedQueue`).
    - Do NOT invent a "presence" or "online" concept; there is no real-time user presence
      system. Badges reflect report-period activity (today), not live keyboard/mouse presence.
    - Badge hierarchy: "Needs attention" (overdue CBs + no dispositions) > "Callbacks due" >
      "No outcomes today" > silent (active or idle with no queue). Active agents show no badge.

79. **Wallboard "On call" badge must use verified extension ownership only.**
    - The on-call match is performed by checking `Extension.extNumber` (for extensions where
      `Extension.ownerUserId = agentUserId` and `status = "ACTIVE"`) against the live call's
      `extensions[]`, `source_extension`, and `destination_extension` fields from the WS.
    - The `extensions[]` array is returned by `GET /crm/reports/agents` as an additive field.
    - If `extensions[]` is empty (agent has no owned extension), show NO badge — never guess.
    - If the call data has missing/null `from`/`to` fields, the Set-based match still works
      safely because `null` is never added to the `extSet`.
    - "On call" badge suppresses idle/attention badges for that agent row (one badge at a time).
    - This is read-only. Do not add any telephony control action to the on-call row.
    - The extension lookup is a single `findMany` scoped to `{ tenantId, ownerUserId: { in: userIds }, status: "ACTIVE" }` — bounded, no N+1.

80. **CRM recording playback must always route through the existing safe recording endpoint.**
    - Use `GET /voice/recording/:linkedId/stream` (or `/download`). These are the ONLY paths
      that proxy audio from the PBX — they never expose `recordingPath` to the client.
    - Pass the JWT as `?token=<jwt>` for browser `<audio>` elements (this pattern is explicitly
      supported by the endpoint; the token is read server-side and Authorization is injected).
    - Read the token from `localStorage.getItem("token") || localStorage.getItem("cc-token")`
      (same pattern as `apiClient.ts` `browserToken()`).
    - The endpoint already enforces tenant isolation: non-SUPER_ADMIN users are blocked if
      `cdr.tenantId !== user.tenantId`.
    - Never construct a raw PBX URL in the portal. Never expose `recordingPath` in any API
      response visible to the browser.
    - The "Play recording" button must only render when `recordingAvailable === true`
      AND `event.linkedId` is present in the timeline event.
    - No new API route is needed for CRM recording playback — the existing stream endpoint
      covers all CRM roles (`canViewCustomers` permission includes all authenticated roles).

85. **CRM SMS conversation panel must use timeline/provider-backed SMS events only.**
    - The SMS conversation view on `/crm/contacts/:id` is derived by filtering
      `CrmTimelineEvent` rows (`SMS_SENT`, `SMS_RECEIVED`) from the already-loaded
      timeline state. No separate "SMS inbox" endpoint, no fake chat history.
    - The composer calls the real `POST /crm/contacts/:id/sms` and refreshes
      the timeline via `loadTimeline()` after success.
    - `doNotSms` contacts must see the opted-out notice instead of the composer.
    - No global SMS inbox, no unread counters, no MMS preview, no bulk SMS from
      this panel. Keep it scoped to the single-contact conversation view.

84. **CRM inbound SMS hook must be non-blocking and must never duplicate the inbound system.**
    - `crmInboundSmsHook` (API: `apps/api/src/crm/inboundSmsHook.ts`; worker:
      `apps/worker/src/crmInboundSmsHook.ts`) is fire-and-forget. Callers MUST use
      `.catch(() => {})` so any error in the CRM hook cannot fail the inbound webhook.
    - The hook writes `SMS_RECEIVED` CrmTimelineEvent ONLY after the `ConnectChatMessage`
      row is already persisted. It never creates the chat message itself.
    - Idempotency: keyed on `linkedId = connectChatMessage.id`. A pre-check prevents
      duplicate events even if both the webhook path and poll path process the same message.
    - The hook must check `CrmTenantSettings.enabled` before any further DB queries.
    - Never add CRM business logic to the inbound webhook response path. Always fire-and-forget.
    - `SMS_RECEIVED` is for inbound only; `SMS_SENT` (Phase 11A) is for agent-initiated sends.

83. **CRM SMS must use the real tenant SMS provider and must never fake success.**
    - `POST /crm/contacts/:id/sms` must call `provider.sendMessage()` (Twilio or VoIP.ms via
      `packages/integrations`) and only write the `SMS_SENT` CrmTimelineEvent AFTER the provider
      call resolves successfully.
    - If the provider throws or returns an error, return 502 `sms_send_failed` and do NOT write
      the timeline event.
    - Always check `CrmContactMeta.doNotSms` before sending. Return 400 `do_not_sms` if true.
    - Never expose raw provider credentials or intermediate error details that could leak secrets.
    - Do NOT create fake/simulated SMS sends. If the tenant has no SMS provider configured,
      return 503 `sms_not_configured` — do not silently succeed.
    - The Send SMS panel in the portal must be hidden when `contact.doNotSms === true`.
    - Schema: `CrmTimelineEventType.SMS_SENT` added via migration
      `20260523010000_crm_sms_timeline_event`. This is the only CRM SMS timeline event type.

81. **CRM browser notification reminders are one-time, page-resident, non-background.**
    - The "Enable reminders" button on the CRM dashboard uses `window.Notification.requestPermission()`
      — it fires ONE real OS-level notification with current overdue counts when permission is granted.
    - Do NOT set up `setInterval` for recurring notifications without confirming the page will stay
      open (no background service worker in this phase).
    - Do NOT request notification permission automatically on page load — wait for explicit user click.
    - The button must only render when `'Notification' in window` AND `Notification.permission !== 'denied'`.
    - This is intentionally simple. Background recurring reminders require a service worker and are
      deferred to a future phase.

82. **CRM alert strip data must come from real endpoints; counts must never be fabricated.**
    - Dashboard alert strip reads from `GET /crm/reports/follow-ups` (loaded once on mount).
    - Queue alert strip reads from `QueueCounts` already returned by `GET /crm/queue` — no extra API call.
    - If the follow-ups endpoint fails, the alert strip should hide gracefully (null data = no render).
    - Alert strip must link to real, working pages: `/crm/queue?filter=overdue`, `/crm/queue?filter=due`,
      `/crm/tasks?due=overdue`, `/crm/tasks?due=today`.

86. **CRM Smart Queue is ranking-only and must never auto-dial or predict calls.**
    - `?sort=smart` on `GET /crm/queue` re-orders candidates by priority tier (overdue callbacks →
      due-today callbacks → upcoming callbacks → fresh zero-attempt leads → low-attempt leads →
      stale leads). It NEVER changes which contacts get called — that decision stays with the agent.
    - Smart sort on `filter=pending` expands the status filter to include `CALLBACK` so overdue/due
      callbacks surface above zero-attempt leads. Candidate cap: 500 rows fetched, ranked in-process
      (`smartTier()`), then sliced to the requested `limit`.
    - No auto-dialing. No predictive dialing. No telephony changes. The Power Dialer "call" action
      is always explicitly triggered by the agent pressing the Call button or keyboard shortcut `C`.
    - `sort=original` must preserve the pre-12A ordering (sortOrder ASC, createdAt ASC for pending;
      callbackAt ASC for callback filters).
    - Sort preference is persisted in `localStorage` (`crm_queue_sort_mode`). Power mode defaults
      to `"smart"` on first use; manual mode defaults to `"original"`.

89. **CRM lead redistribution must always be explicit and never automatic.**
    - `POST /crm/campaigns/:id/members/distribute` only runs when an admin/manager explicitly triggers it.
    - The endpoint affects only unassigned PENDING/IN_PROGRESS members — already-assigned leads are never moved.
    - The UI must show a confirmation step (user list + count) before calling the endpoint.
    - No scheduled, triggered, or event-based redistribution is permitted.
    - Cross-tenant userIds are rejected with 400 before any assignment is written.

90. **CRM campaign CSV import must reuse the shared import pipeline and must not duplicate contacts or campaign members.**
    - `POST /crm/campaigns/:id/import` must call the same parse/dedup/contact upsert logic as `POST /crm/import/upload` (`importPipeline.ts` — `processImportRow`, limits, column mapping).
    - **`POST /crm/campaigns/:id/import/preview` (Phase 17A)** reuses the same parse, caps, header mapping, phone/email resolution order, in-batch dedupe (`CampaignImportPreviewRegistry`), and member skip-if-present checks as the real campaign import, but **performs no writes** (no `CrmImportBatch`, `Contact`, phones, emails, `CrmContactMeta`, or `CrmCampaignMember`). UI dry-run only.
    - Contacts are identified by normalized phone and/or email within the tenant; existing rows are updated (non-destructive fill-in) and must not be re-created.
    - Enrollment uses `CrmCampaignMember` with the same skip-if-already-member rule as `POST /crm/campaigns/:id/members/add`.
    - Standalone `/crm/import/upload` remains the general-purpose import; campaign import is an additive enrollment path only.

91. **CRM pilot readiness endpoint is read-only and admin-bounded (Phase 15A).**
    - `GET /crm/admin/pilot-readiness` uses `requireCrmAdmin` and returns only aggregate counts
      plus SMS applicability flags (same queue/callback definitions as `GET /crm/reports/daily`).
    - No mutations, no unbounded lists, no implied polling contract.

88. **CRM Queue preference precedence: URL > localStorage > tenant default > hardcoded fallback.**
    - `?sort=` URL param always wins. `?filter=` and `?campaignId=` URL params always win.
    - localStorage keys `crm_queue_sort_mode` and `crm_queue_campaign_id` are second priority.
    - Tenant defaults from `GET /crm/settings` (`defaultQueueSort`, `defaultQueueFilter`) apply only when
      both URL and localStorage have no value for that preference.
    - Hardcoded fallback: sort=smart for power mode, sort=original for manual mode, filter=pending.
    - `?campaignId=` must be validated tenant-scoped. A missing or cross-tenant campaign ID returns 404.
    - Campaign filter in the UI updates both the URL (via `router.replace`) and localStorage so
      navigation away and back preserves the selection.

87. **CRM Campaign priority must never override overdue or due-today callbacks.**
    - `CrmCampaign.priority` (`LOW | NORMAL | HIGH | URGENT`) is a tie-breaker within lead tiers
      only (tiers 30–53 in the composite score). It shifts leads within fresh/low-attempt/stale
      bands but NEVER beats callback tiers (0=overdue, 10=due-today, 20=upcoming).
    - An URGENT campaign's fresh lead (score 30) always ranks after any callback tier (max 20).
    - Existing campaigns default to `NORMAL`. Migration `20260514010000_crm_campaign_priority`
      applies `NORMAL` to all existing rows with `ALTER TABLE ... DEFAULT 'NORMAL'`.
    - `sort=original` is completely unaffected — campaign priority has no effect there.
    - Campaign priority is visible to managers on the campaign create/edit UI and to agents as
      the "Why this lead?" badge on PowerCard (e.g. "Urgent campaign · fresh lead").

---

## Documentation

39. **Update `docs/ai-context/KNOWN_ISSUES.md` whenever you discover or fix a fragile
    area.** Future agents will save tokens.
40. **Mark uncertain claims as "UNKNOWN — verify before changing".** Do not write
    fiction.
