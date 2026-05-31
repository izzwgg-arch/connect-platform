# Changelog

Tracks notable product and agent-delivered changes. Newest entry first.

---

## 2026-05-31 — CRM contact workspace visual polish

**Task:** CRM / contact workspace / visual polish  
**Risk:** medium

### Root cause

The compact workspace structure was correct, but remaining presentation details still felt uneven: the Quick Disposition card used older borders/button styling, collapsed right-rail sections displayed noisy summary text, card wrappers varied between sections, and empty states often rendered inside dashed/bordered containers.

### What changed

- **Quick Disposition:** kept the compact footprint and workflow, but updated typography, pill buttons, white card surface, hover states, and softer shadow treatment.
- **Right rail sections:** collapsed state now shows only the section title. Section wrappers use a consistent white card surface, radius, border, and soft shadow.
- **Empty states:** replaced bordered empty containers in contact workspace panels with simple text states.
- **Header actions:** kept the same actions and functionality while ensuring Call remains the primary far-right action next to VM Drop, Edit, and Archive.

### Deliberately unchanged

- Three-column layout, workspace order, quick disposition save behavior, APIs, database schema, and permissions.

### Verify

- Open a campaign contact workspace and confirm the Quick Disposition card remains compact, collapsed sections show title-only rows, empty states are plain text, and header actions remain Call / VM Drop / Edit / Archive from the right-side action cluster.

---

## 2026-05-31 — CRM campaign workspace UI polish

**Task:** CRM / campaign workspace / UI polish  
**Risk:** medium

### Root cause

After the quick disposition rollout, the sticky header duplicated communication actions already available in the left workspace nav, secondary contact actions sat below the KPI strip, the Quick Disposition card consumed too much right-rail height, and timeline rows used bordered edit/delete controls with generous vertical spacing — pushing Relationship Health and other right-rail cards below the fold.

### What changed

- **Header:** removed SMS, Email, and Note from `ContactCampaignStickyHeader`; Call stays top-right. Voicemail Drop, Edit, and Archive moved to the header action cluster on the right.
- **Quick Disposition card:** compact layout — active phone, last disposition, four primary one-click buttons, expandable **More…** for remaining labels, and **Manage** for custom dispositions. Removed title, subtitle, channel selector row, and note field from the card (channel still follows Call/SMS/Email/VM outreach context).
- **Timeline:** icon-only note edit/delete (✏️ / 🗑️, no button borders); reduced event padding and inter-event gap for higher density.
- **Right rail:** tighter spacing below the disposition slot so Relationship Health, Activity Summary, and downstream cards appear sooner.

### Deliberately unchanged

- Workspace three-column layout, left sidebar navigation, disposition API, permissions, and all workspace tabs (Email, SMS, Notes, etc.).

### Verify

- Call button remains in header; SMS/Email/Note reachable via left nav only.
- Quick Disposition card is ~70% shorter; right-rail summary cards visible with less scroll.
- One-click dispositions still save; timeline updates with phone/channel metadata.

---

## 2026-05-31 — CRM campaign workspace disposition redesign

**Task:** CRM / campaign workspace / disposition redesign  
**Risk:** high

### Root cause

Disposition controls lived inside the scrolling center workspace card, so agents lost quick access while reading timeline/script content. Panel scroll only activated at very wide breakpoints and the right rail had no pinned action area. Quick disposition labels were hardcoded and not tenant-configurable, and per-phone/channel dispositions needed a dedicated sticky workflow surface.

### What changed

- **Scroll shell:** left, center, and right panels now use dedicated inner scroll regions (`crm-contact-left-scroll`, `crm-contact-center-scroll`, `crm-contact-right-rail-scroll`) with sticky header + pinned quick disposition slot.
- **Navigation cleanup:** removed duplicate center mini-tabs; left sidebar remains sole workspace navigation; removed Next Step card.
- **Quick Disposition card:** sticky right-rail card (`ContactQuickDispositionCard`) with channel + phone target, one-click disposition buttons, optional note save, and manager custom label management.
- **Quick disposition API:** `GET/PUT /crm/quick-dispositions` with tenant defaults + custom JSON on `CrmTenantSettings.quickDispositions`.
- **Per-phone/channel dispositions:** reuses `CrmContactPhoneDisposition` + extended `POST /crm/contacts/:id/disposition`.
- **Tests:** quick disposition merge/permissions, workspace scroll class helpers, phone disposition helpers.

### Verify

- Desktop: each column scrolls independently; Quick Disposition stays visible in right rail while scrolling center content.
- One-click disposition saves immediately with phone + channel context.
- Manager can add/reorder custom quick dispositions.

---

## 2026-05-31 — CRM campaign workspace disposition UX

**Task:** CRM / campaign workspace / disposition UX  
**Risk:** medium

### Root cause

The campaign contact workspace duplicated navigation (left sidebar + center mini-tab row), buried disposition controls in the left rail, and stored dispositions only at contact level (`CrmContactMeta.lastDisposition`) with no phone/channel metadata. The redundant right-rail “Next step” card duplicated guidance already available via tasks, notes, and timeline.

### What changed

- **Portal:** removed center `ContactWorkspaceTabBar` mini-tabs and the right-rail Next Step card; left sidebar remains the sole workspace navigation.
- **Portal:** added `ContactWorkspaceDispositionBar` in the center workspace header — channel selector (Call/SMS/Email/VM Drop), active phone target, quick disposition buttons, note, and save.
- Call/SMS picker and single-phone flows now set the active disposition phone + channel before outreach.
- Per-phone disposition labels appear in contact info, SMS select, and Call/SMS picker.
- **API + schema:** new `CrmContactPhoneDisposition` model and migration; `POST /crm/contacts/:id/disposition` accepts optional `phoneId` + `channel`, writes phone-level history, enriches timeline metadata (phone label/number/channel), and returns latest disposition on each phone via `GET /crm/contacts/:id`.
- Contact-level `lastDisposition` behavior preserved for backward compatibility.
- **Tests:** `contactPhoneDisposition.test.ts`, expanded `contactWorkspaceHelpers.test.ts`.

### Deliberately unchanged

- Notes, timeline, scripts, checklist, email, SMS, tasks, and intelligence tabs remain in the left sidebar.
- CRM permission model unchanged (`requireCrmAccess` + `assertCrmContactAllowed` on disposition).

### Verify

- Multi-phone contact: Call → pick Mobile → save “No answer” → Mobile shows disposition; SMS → pick Office → save “Interested” → both numbers retain separate latest dispositions.
- Timeline entries include phone type, number, channel, and disposition.
- Center mini-tabs and Next Step card are gone; sidebar navigation still switches workspace panels.

---

## 2026-05-31 — CRM campaign active workspace UX polish

**Task:** CRM / campaign workspace / UX polish  
**Risk:** medium

### Root cause

The first workspace redesign still trapped wheel scroll inside desktop panels (`overscroll-behavior: contain`), only partially applied collapsible summaries, and left call/SMS actions tied to the primary phone even when contacts had multiple numbers. The existing CRM phone record already exposes a per-phone `type`, but the UI did not consistently display or use it.

### What changed

- **Portal only:** removed scroll trapping from campaign contact workspace panels.
- Right-rail informational panels now use collapsed-by-default summaries.
- Sticky contact header gets subtle CRM accent/gradient treatment while staying compact.
- Campaign Prev/Next lead navigation is now a smaller segmented floating pill.
- Call/SMS actions open a phone picker for multi-phone contacts; single-phone contacts execute immediately.
- Phone `type` labels are shown in the header, contact info, SMS panel, and Call/SMS picker. Existing add-phone flow now offers Mobile, Office, Direct, Main, Billing, Home, Cell, Work, Other.
- **Tests:** expanded `contactWorkspaceHelpers.test.ts` for phone label formatting and single vs multi-phone picker behavior.

### Deliberately unchanged

- No backend/API/schema changes. Existing API supports add/delete phones, but no phone update route exists for editing saved phone types.
- CRM permissions, telephony routing, SMS send route, and campaign APIs unchanged.

### Verify

- Desktop scroll continues naturally when a workspace panel reaches top/bottom.
- Right rail starts compact and expands on section header click.
- Multi-phone contacts show picker for Call and SMS; selected number is used.
- Single-phone contacts call/open SMS immediately.

---

## 2026-05-31 — CRM campaign active workspace UX redesign

**Task:** CRM / campaign workspace / UX redesign  
**Risk:** high

### Root cause

The campaign contact workspace (`/crm/contacts/[id]?campaignId=&memberId=`) used a single page scroll surface, a tall header that scrolled away, and a horizontally scrolling tab strip. **Start outreach** called `scrollToNoteComposer()` while the user was on the Timeline tab, but the note composer only mounted on the Notes tab — `noteComposerRef` was null, so the click appeared to do nothing (silent failure).

### What changed

- **`apps/portal/app/(platform)/crm/contacts/[id]/page.tsx`:** sticky compact header, three-panel independent scroll layout (desktop), campaign prev/next navigation (+ ArrowLeft/ArrowRight), Start outreach switches to Notes with toast feedback, explicit Notes tab branch.
- **New components:** `ContactCampaignStickyHeader`, `ContactWorkspaceTabBar` (primary tabs + More menu), `ContactCampaignLeadNav`, `ContactCollapsibleSection`, `contactWorkspaceHelpers.ts`.
- **`ContactDocumentSummary`:** collapsible summary-first sections (verified CRM, extracted docs, phones).
- **`ContactTimeline`:** Start outreach loading state on button.
- **`globals.css`:** `.crm-contact-detail-workspace` scoped layout/toast styles.
- **Tests:** `contactWorkspaceHelpers.test.ts` (tab overflow, campaign nav, start-outreach validation).

### Deliberately unchanged

- CRM permissions, API routes, campaign roster page, queue page, live-call workspace, telephony.

### Verify

- Open workspace from `/crm/campaigns/[id]` member row → sticky header stays visible while scrolling panels.
- Desktop: left / center / right panels scroll independently; no full-page scroll.
- Mobile/tablet: stacked layout, no horizontal tab swipe; More menu reaches overflow tabs.
- Empty timeline → Start outreach → Notes tab + toast + focused composer.
- Campaign context → fixed Prev/Next (bottom-right) and keyboard arrows move through roster order.
- Document summary sections collapse/expand with summary lines visible when closed.

### Deploy

**Portal only.** No API/worker/DB changes.

---

## 2026-05-31 — Shared tenant SMS inbox consistency (VoIP.ms / Connect Chat)

**Task:** SMS / VoIP.ms / shared inbox consistency  
**Risk:** high

### Root cause

Inbound SMS to tenant-assigned numbers with no extension used permission-blind fan-out to **all** tenant users and consistent shared `inboxScope=""`, but **outbound-first** thread creation only added the creator as participant and used a flawed `inboxScope` heuristic. Send routes checked JWT roles via `canSendSmsRole` instead of portal `can_send_sms`. Users with `can_view_tenant_chats` could read shared threads but got **404** on reply because `POST /chat/threads/:id/messages` required a participant row.

### What changed

- **`packages/shared/src/smsInbox.ts`:** shared inbox scope, dedupe key, permission eligibility helpers (+ unit tests).
- **`apps/api/src/smsInboxParticipants.ts`**, **`apps/worker/src/smsInboxParticipants.ts`:** permission-based participant fan-out; batch role snapshot + custom roles.
- **`connectChatRoutes.ts`:** outbound-first shared inbox uses same fan-out as inbound; send permission union; shared-inbox reply auto-participant or `403 SMS_VIEW_ONLY`; thread list `smsInboxKind`.
- **`voipMsInboundSyncJob.ts`:** uses shared dedupe + participant module.
- **Portal:** VoIP.ms “shared tenant inbox” label; chat badges; composer hidden for view-only SMS.
- **Tests:** `smsSharedInbox.test.ts`, `smsInbox.test.ts`.

### Deploy

Requires **`api`**, **`worker`**, and **`portal`**. No Prisma migration.

### Verify

- Assign VoIP.ms DID to tenant with no extension → inbound and outbound-first threads show **Shared SMS** and same participants (users with SMS/chat permissions only).
- User with `can_view_tenant_chats` + `can_send_sms` can reply without 404.
- View-only user sees thread but composer hidden / `403 SMS_VIEW_ONLY` on send.
- Personal extension/user assignment unchanged.

---

## 2026-05-31 — CRM lead document summary on contact profile

**Task:** CRM / document import / lead profile summary
**Risk:** high

### Root cause

Google Drive import, OCR/text extraction, contact discovery, and AI intelligence already ran, but the lead profile had no structured “business profile” view. Required fields (EIN, revenue, industry, credit score, addresses, phones) were neither extracted into a summary schema nor rendered on the contact workspace — only a separate AI Intelligence tab showed generic entities.

### What changed

- **`documentProfileExtractor.ts`:** regex/heuristic extraction from document text (EIN, revenue, credit score, dates, labeled addresses). SSN extracted only in memory for masking — never persisted.
- **`leadDocumentSummaryService.ts`:** merges verified CRM contact fields, document extractions, and AI `documentProfile` (SSN stripped before DB persist). `GET /crm/contacts/:id/document-summary` with `assertCrmContactAllowed`.
- **`leadIntelligenceProvider.ts`:** extended AI schema with `documentProfile` business fields (no SSN in prompt/storage).
- **Portal:** `ContactDocumentSummary` card on contact profile — separate sections for verified CRM fields, document-extracted fields, and all phones.
- **Tests:** extractor, summary merge/masking, route contract (24 tests).
- **Docs:** CRM document summary fields + SSN policy in `CRM.md`.

### Deploy

Requires **`api`** and **`portal`**. No Prisma migration.

### Verify

```bash
pnpm --dir apps/api exec node --import tsx --test src/crm/documentProfileExtractor.test.ts src/crm/leadDocumentSummaryService.test.ts src/crm/leadDocumentSummaryRoutes.test.ts
pnpm --dir apps/portal typecheck
```

Manual QA: import/scan Drive docs → open lead profile → Extracted Business Profile card shows fields; SSN masked; all phones listed; restricted Agent blocked out-of-scope.

---

## 2026-05-31 — CRM checklist create/save list refresh

**Task:** CRM / checklists / permissions / save flow
**Risk:** high

### Root cause

Checklist create/update API routes already used `requireCrmAccess` (Agent/Manager allowed, tenant-scoped). The portal create flow only silent-refetched the list and replaced state wholesale — unlike scripts, it did not merge the saved checklist into local state, so a stale or failed refetch left the library panel empty until a full browser refresh. Create also lacked the success toast shown on edit save.

### What changed

- **`crmSaveHelpers.ts`:** added `mergeChecklistSummaries` (mirrors script merge helper).
- **`checklists/page.tsx`:** optimistic merge after create/edit; silent refetch with `mergeLocal`; success toast on create; 403/save errors still via `formatCrmSaveError`.
- **Tests:** `checklistRoutes.test.ts` (API list/create contract, tenant scoping, Agent/Manager portal permissions); `crmSaveHelpers.test.ts` (merge helper).
- **Docs:** CRM checklist save-flow note in `CRM.md`.

### Deploy

Requires **`portal`** only (API unchanged). No Prisma migration.

### Verify

```bash
pnpm --dir apps/api exec node --import tsx --test src/crm/checklistRoutes.test.ts src/crm/scriptChecklistAccess.test.ts
pnpm --dir apps/portal exec node --import tsx --test components/crm/crmSaveHelpers.test.ts
```

Manual QA: CRM Agent → create checklist → save → appears in library without refresh; repeat as Manager; confirm Admin still works; user without CRM access denied on page/API.

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
