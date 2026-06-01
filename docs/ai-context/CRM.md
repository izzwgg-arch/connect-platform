# CRM Context

Scope: portal CRM UI/data-flow guardrails. Telephony, billing, workers, database schema, and onboarding are out of scope unless a task explicitly says otherwise.

## Inbound call caller ID (telephony WS)

- Matching is **server-side only** (`apps/api/src/crm/inboundCallerMatch.ts`). Telephony calls `POST /internal/telephony/inbound-crm-match` with `CDR_INGEST_SECRET` (same as CDR ingest).
- **Tenant isolation:** all `ContactPhone` queries include `contact.tenantId`.
- **Per-user fields:** telephony enriches each WebSocket client separately; users without CRM access or campaign assignment do not receive `crmContactId` / name / profile URL.
- **Match order:** exact normalized phone → other `ContactPhone` rows on the contact → safe last-10 suffix (NANP only).
- **Portal:** optional WS fields on `LiveCall` — `crmContactName` overrides PBX `fromName` in Connect UI only (PBX caller ID unchanged). Floating dialer quick action: **Open CRM Profile** when `crmContactId` + `crmProfileUrl` present on inbound calls.
- **Do not** rely on client-only `GET /crm/contacts/lookup` for live call identity when WS enrichment is enabled (`CrmScreenPop` prefers WS fields).

## Lead timezone (city/state → stored timezone)

- Every CRM lead should have city + state on a `ContactAddress` (import or API). Timezone is **derived server-side** and stored on `CrmContactMeta` — do not compute in the portal for filtering.
- Resolver: `apps/api/src/crm/leadTimezoneResolver.ts` (`city-timezones` dataset). Status: `RESOLVED`, `NEEDS_REVIEW`, `MISSING_LOCATION`.
- Sync triggers: contact create, contact patch when city/state changes, CSV import row processing, admin backfill `POST /crm/admin/lead-timezone/backfill`.
- List filters: `GET /crm/contacts?timezoneZone=eastern|central|mountain|pacific|alaska|hawaii|other` (also `timezoneIana`, `timezoneLabel`). Same params on `GET /crm/campaigns/:id/members`. Always tenant-scoped.
- **Mountain bucket** includes both `America/Denver` (label `Mountain`) and `America/Phoenix` (label `Arizona`). Filter uses label + IANA OR so legacy Phoenix rows labeled `Mountain` still match.
- **Display:** row badge `AZ` + detail `Arizona (MST)` for Phoenix — never generic `MT` (DST-implying). Denver stays `MT` / `Mountain`. Helpers in `leadTimezoneResolver.ts` (API) and `components/crm/contact/leadTimezoneDisplay.ts` (portal).
- UI: compact timezone badge on `/crm/contacts` rows and contact detail near address — no extra columns or noisy panels.

## Contacts filters and My Queue assignment

- `/crm/contacts` filter chrome is a compact single-row toolbar: search, All campaigns, All tags, All timezones, All stages, then Filters. Status-style quick filters live inside the Filters panel, not in a second row.
- Contact filter dropdowns use `ConnectSelect` / `ViewportDropdown` styling instead of native select controls. Keep campaign/tag/timezone/stage option mapping in `components/crm/contact/contactFilterOptions.ts`.
- `GET /crm/contacts?campaignId=...` is tenant-scoped and uses existing campaign allow-list checks before filtering contacts by `CrmCampaignMember`.
- On desktop, the contacts list and right insights rail scroll independently below sticky filter chrome. Tablet/mobile should fall back to normal page scroll.
- My Queue is campaign-member based: `GET /crm/queue` reads `CrmCampaignMember.assignedToUserId`, not just `CrmContactMeta.assignedToUserId`.
- Standalone `/crm/import` requires a destination active campaign for queue assignment. `POST /crm/import/upload` accepts `campaignId` + `assignToMe=true`, creates/skips campaign members for imported contacts, and assigns eligible members to the importer only.
- Contacts bulk self-assignment uses `POST /crm/contacts/assign-to-me` with `contactIds` + `campaignId`. It requires CRM access, contact scope, campaign access, active campaign status, tenant-scoped contacts, and only writes `assignedToUserId = current user`. It must not accept arbitrary assignee IDs for regular users.
- Admin/global contact assignment remains separate (`/crm/contacts/bulk-reassign`, `/crm/contacts/smart-assign`) and writes contact meta assignment; do not use those endpoints to grant regular users cross-user assignment.

## CRM role permissions (portal + API)

| CrmUserAccess role | Portal legacy keys | CRM Email nav (`can_view_crm_email`) | CRM Email settings (`can_view_crm_settings`) |
|--------------------|----------------------|--------------------------------------|-----------------------------------------------|
| AGENT | `can_view_crm` | Yes — send/use templates through tenant sender when configured | No |
| MANAGER | `can_manage_crm` | Yes — same as agent | No |
| ADMIN | `can_manage_crm` + `can_manage_crm_admin` | Yes | Yes — `/crm/email/settings`, fleet diagnostics API |

- Permissions are merged in `resolvePortalPermissionsWithCrmUserAccess` only when tenant CRM is enabled and `CrmUserAccess.enabled`.
- **API:** `/crm/email/*` (except OAuth callback) requires `requireCrmAccess`. `POST /crm/email/send` checks `assertCrmContactAllowed` (assignment or allowed campaign when user has campaign restrictions). Fleet diagnostics and tenant sender management are admin-only (`requireCrmEmailSettingsAccess` semantics: platform admin or CRM ADMIN).
- **Contact scope:** `assertCrmContactAllowed` enforces campaign assignment for AGENT users on contact-scoped mutations (disposition, checklist respond, voicemail drop, notes, tasks, email send, contact detail). **List/search** (`GET /crm/contacts`, `GET /crm/contacts/lookup`, stats, duplicate suggestions) apply the same scope at query time so restricted Agents never see out-of-scope rows or inflated totals. CRM MANAGER / CRM ADMIN bypass campaign restrictions within the tenant (still tenant-scoped via `contact.tenantId`).
- **Voicemail drops:** list/use/drop/upload/edit/archive routes use `requireCrmAccess` (Agent + Manager + CRM Admin). PBX/system recording settings remain outside this feature (`/pbx/call-recordings`, admin-only).
- **CRM SMS:** `/crm/contacts/:id/sms` uses regular Connect Chat SMS as the source of truth. The route requires `requireCrmAccess`, `assertCrmContactAllowed`, and `can_send_sms`, then creates/reuses the normal `ConnectChatThread` and queues a `ConnectChatMessage` through the existing Connect Chat SMS send path. The CRM contact SMS panel reads `ConnectChatMessage` rows from that thread; timeline `SMS_SENT` / `SMS_RECEIVED` rows are supplemental activity feed mirrors only.
- **CRM SMS labels in Chat:** main Chat may show `CRM SMS` and a contact/company title only after the API verifies the viewer has CRM access and contact scope for exactly one matching contact phone in the tenant. If CRM is disabled, the user lacks CRM access, the contact is out of scope, or multiple contacts share the phone, Chat falls back to normal SMS phone labeling and must not expose CRM contact metadata.

### CRM permission matrix (Agent / Manager / Admin)

| Feature | UI route / nav permission | API route / action | Guard | Agent | Manager | CRM Admin | Platform admin |
|---------|---------------------------|-------------------|-------|-------|---------|-----------|------------------|
| Checklists — view | `can_view_crm_checklists` → `/crm/checklists` | `GET /crm/checklists` | `requireCrmAccess` | Yes | Yes | Yes | Yes |
| Checklists — create/edit/archive | same page | `POST/PATCH/DELETE /crm/checklists` | `requireCrmAccess` | Yes | Yes | Yes | Yes |
| Checklists — save UX | `/crm/checklists` | POST/PATCH return `{ checklist }`; page uses `mergeChecklistSummaries` + silent refetch | — | Create/edit appear in library immediately | Same | Same | Same |
| Checklists — complete on contact | Live workspace panel | `POST /crm/checklists/:id/respond` | `requireCrmAccess` + `assertCrmContactAllowed` | Yes (in scope) | Yes (tenant) | Yes (tenant) | Yes |
| Contacts — list/search | `can_view_crm_contacts` → `/crm/contacts` | `GET /crm/contacts`, `GET /crm/contacts/lookup` | `requireCrmAccess` + list scope filter | In-scope only | Tenant-wide | Tenant-wide | Tenant-wide |
| Contacts — stats | Dashboard | `GET /crm/contacts/stats` | `requireCrmAccess` + scoped meta counts | In-scope totals | Tenant-wide | Tenant-wide | Tenant-wide |
| Dispositions — view options | Client `DISPOSITION_OPTIONS` | — | — | Yes | Yes | Yes | Yes |
| Dispositions — set on contact | Contact profile / live workspace | `POST /crm/contacts/:id/disposition` | `requireCrmAccess` + `assertCrmContactAllowed` | Yes (in scope) | Yes (tenant) | Yes (tenant) | Yes — optional `phoneId` + `channel` write per-phone history (`CrmContactPhoneDisposition`) while still updating contact-level `lastDisposition` |
| CRM email — compose/send | `can_view_crm_email` → `/crm/email` | `POST /crm/email/send` | `requireCrmAccess` + `assertCrmContactAllowed` | Yes (in scope) | Yes (tenant) | Yes (tenant) | Yes |
| Email templates — view/create | `can_view_crm_email` → `/crm/email/templates` | `GET/POST /crm/email/templates` | `requireCrmAccess` | Yes | Yes | Yes | Yes |
| Email templates — edit | same | `PUT /crm/email/templates/:id` | `requireCrmAccess` + creator or CRM Manager+ | Own + shared use | Own + shared edit | Own + shared edit | All |
| Email templates — attachments/logo | Utility panels | `POST …/attachments`, `POST …/branding/logo` | `requireCrmAccess` + edit check on template | Own templates | Own + shared | Own + shared | All |
| Email templates — send test | Builder | `POST …/templates/:id/send-test` | `requireCrmAccess` | Yes | Yes | Yes | Yes |
| Email settings / diagnostics | `can_view_crm_settings` → `/crm/email/settings` | `GET /crm/email/diagnostics/*` | `requireCrmEmailSettingsAccess` | No | No | Yes | Yes |
| Voicemail drops — view | `can_view_crm_voicemail_drops` | `GET /crm/voicemail-drops` | `requireCrmAccess` | Yes | Yes | Yes | Yes |
| Voicemail drops — upload/edit/archive | `/crm/voicemail-drops` | `POST/PATCH/DELETE /crm/voicemail-drops` | `requireCrmAccess` | Yes | Yes | Yes | Yes |
| Voicemail drops — use on call | Live workspace | `POST /crm/voicemail-drops/drop` | `requireCrmAccess` + `assertCrmContactAllowed` | Yes (in scope) | Yes (tenant) | Yes (tenant) | Yes |
| Scripts — view/use | `can_view_crm_scripts` | `GET /crm/scripts` | `requireCrmAccess` | Yes | Yes | Yes | Yes |
| Scripts — create/edit | `/crm/scripts` | `POST/PATCH /crm/scripts` | `requireCrmAccess` | Yes | Yes | Yes | Yes |
| Live call workspace | `can_view_crm_live_call` | Quick actions → disposition, checklist, email, voicemail, notes, tasks (routes above) | Mixed per action | Yes (in scope) | Yes (tenant) | Yes (tenant) | Yes |
| CRM settings (tenant) | `can_view_crm_settings` | `GET/PUT /crm/settings` | `requireCrmAdmin` (platform JWT) | No | No | Portal yes / API platform admin | Yes |
| Notes / tasks on contact | Live workspace / contact | `POST /crm/contacts/:id/notes`, `…/tasks` | `requireCrmAccess` + `assertCrmContactAllowed` | Yes (in scope) | Yes (tenant) | Yes (tenant) | Yes |
| Document summary — contact profile | `/crm/contacts/[id]` card | `GET /crm/contacts/:id/document-summary` | `requireCrmAccess` + `assertCrmContactAllowed` | Yes (in scope) | Yes (tenant) | Yes (tenant) | Yes |

**Scope legend:** *in scope* = assigned to agent or in an assigned campaign when `CrmUserCampaignAssignment` rows exist; *tenant* = any contact in the tenant (Managers/CRM Admins bypass campaign allow-list).

## CRM document import — lead profile summary

Pipeline (unchanged): Google Drive match → import (`CrmLeadDocument`) → text extraction/OCR (`CrmLeadDocumentText`) → contact discovery (phones/emails) → optional AI intelligence (`CrmLeadIntelligenceReport`).

**Contact profile card:** `ContactDocumentSummary` on `/crm/contacts/[id]` calls `GET /crm/contacts/:id/document-summary`. Three sections:

1. **Verified CRM fields** — company, timezone, address from `Contact` / `CrmContactMeta` (never overwritten by extraction).
2. **From imported documents** — EIN, revenue, industry, credit score, business start date, business/home addresses from regex extraction + AI `keyFindings.documentProfile` (advisory).
3. **All phones on file** — every `ContactPhone` plus pending/accepted discoveries (deduped).

**Field priority:** CRM record → document regex → AI advisory. Conflicting values set `meta.hasConflicts` (UI badge).

**SSN security:** SSN is regex-extracted only during summary assembly — **never persisted** (stripped from AI `documentProfile` before save). API returns masked display only (`***-**-1234`). No full-SSN permission exists; raw SSN must not appear in API responses, logs, or audit events.

**Raw OCR text** is never returned by the summary endpoint.

## Dashboard And Email UI

- CRM dashboard modernization is UI-only. Keep existing API calls in `apps/portal/app/(platform)/crm/dashboard/page.tsx`; derive status from the values already loaded there.
- CRM Email landing uses only `/crm/email/connection`, `/crm/email/recent`, and `/crm/email/replies/recent` (agents skip fleet diagnostics).
- CRM Email Settings uses only `/crm/email/connections`, `/crm/email/oauth/start`, `/crm/email/sync-now`, `/crm/email/connection/test`, `/crm/email/connections/:id`, and `/crm/email/sync-last`.
- CRM email sender resolution is tenant-first for implicit sends: explicit `connectionId` wins; otherwise use tenant default TENANT sender, lone connected TENANT sender, caller USER sender, then no sender. This keeps normal CRM sends on the tenant-connected Gmail account when one exists.
- Contact workspace Email tab is template-first: agents see saved templates directly, select one, preview merged subject/body for the current contact, optionally make small edits, optionally CC themselves, and send one email to the current contact. It must not add bulk email or expose Google connection controls to agents.
- CC myself uses only the logged-in user's email. Do not add arbitrary CC fields in the workspace flow unless a separate reviewed permission model exists.
- Reply tracking uses the existing Gmail thread sync on the sender connection. Contact replies to the tenant sender are tracked when reply tracking is enabled. Agent self-CC is for visibility; personal inbox replies are only tracked if the tenant sender remains in the Gmail thread/recipient chain. Do not invent a fake CRM tracking/BCC address.
- CRM Email landing keeps Sent, Delivered, Replies, and Reply Rate directly under the header/top health banner; the Google sender/connect card lives lower on the page and can be hidden per tenant/user in local storage. When hidden, keep a compact Connect Google/Manage affordance available.
- CRM Email Recent Replies and Recent Sent panels use bounded independent scroll regions with visible panel headers. Empty states should be simple text/icon states, not dashed or bordered empty containers.
- Sender cards should feel like production infrastructure: connection state, reply tracking, sync health, last sync/activity, and compact diagnostics.
- Do not invent backend fields, fake metrics, demo activity, placeholder buttons, or inbox archive behavior.

## CRM Email Template Builder

- `/crm/email/templates` is a no-code builder, not a raw admin form. The layout is library rail + visual editor + live preview, with bottom panels for Branding, Attachments, Merge Fields, and AI Assistant.
- Templates remain backward-compatible with Phase 1 `bodyText`, but new records can also store `bodyHtml`, `bodyJson`, `previewText`, `category`, favorite/draft flags, and usage metadata.
- Merge fields are canonicalized in `packages/shared/src/crmEmailTemplates.ts`. Preserve missing-value fallback to empty strings. Do not reintroduce client-only or worker-only token lists.
- Final sends render server-side. Portal preview can be immediate/client-side, but production email output must be rendered by API/worker logic before Gmail delivery.
- CRM email delivery supports multipart HTML + plain-text fallback, inline CID branding logos, and tenant-scoped template attachments. Attachment storage must use persistent CRM email asset storage under the CRM document volume pattern; never ephemeral container paths or exposed raw storage keys.
- Uploaded branding logos are tenant assets. API branding responses expose a safe preview URL only (`/api/crm/email/branding/logo`), never `logoStorageKey`. Final sent emails render uploaded logos as `cid:connect-crm-business-logo` and the worker attaches the image inline; do not replace this with short-lived signed URLs.
- Template attachment allowlist is intentionally narrow: PDF, DOCX, XLSX, CSV, JPG, PNG, and WEBP. ZIP is not allowed. Attachment loads for sends must stay scoped by both `tenantId` and `templateId` when a template send is involved.
- Branding is tenant-scoped (`CrmEmailBranding`) and signatures are user-scoped within tenant (`CrmEmailSignature`). Never leak branding/signatures across tenants.
- CRM Agent and Manager can create/use templates and send test emails through `/crm/email/*` guarded by `requireCrmAccess`. Email settings/diagnostics remain admin-only through `requireCrmEmailSettingsAccess`.
- AI Assistant uses real OpenAI-backed CRM infrastructure only. If `OPENAI_API_KEY` is absent, return a clear unavailable state (`ai_not_configured`); do not hardcode demo responses.
- Starter templates must use merge tokens and neutral placeholders, never hardcoded tenant/company/customer data.
- The portal builder UI is componentized under `apps/portal/components/crm/email/templates/`:
  - `TemplateLibraryPanel` owns search, category/folder filters, compact cards, inline favorite/rename/duplicate/archive/restore actions, timestamps, and usage counts.
  - `EmailBuilderCanvas` owns TipTap editing, toolbar controls, block rail, drag/drop block insertion, dirty/autosave status, and template actions.
  - `EmailPreviewPanel` owns inbox preview, desktop/mobile frame, light/dark preview, footer and attachment preview.
  - `UtilityPanels` owns Branding, Attachments, Merge Fields, and AI Assistant controls.
  - `StarterTemplatesStrip` owns starter template selection.
- UI polish passes must preserve existing CRM email API contracts, permissions, and database schema unless a UI action is impossible without a compatible backend fix.
- Autosave is a portal UX layer that saves existing templates as drafts after edits settle; new unsaved templates still require the first explicit save before attachment upload or send-test.

## Visual System

- Prefer `CRMPageShell`, `CRMPageHeader`, `CRMCard`, and `crm.*` class tokens.
- Use operational classes from `crmClasses.ts` for premium CRM surfaces: `opCard`, `opCardGlow`, `opInset`, `opCardHover`, and `statusDot*`.
- Keep density practical: compact grids, sticky summary bars when useful, status dots, stat pills, and hover lift.
- Dark mode must remain first-class. Avoid `bg-white`, `bg-gray-*`, and ad hoc light-only surfaces on CRM routes.

## Campaign Member Dense Rows

- `/crm/campaigns/[id]` member rosters are operational tables, not card feeds. Desktop rows should stay near 44-52px with compact avatars, tight cell padding, aligned columns, and readable 11-13px support text.
- Contact identity is mandatory in-row: full name on the primary line, then email, phone, and company on a subtle secondary line. Do not move these fields into hover-only panels.
- Row actions must be single-purpose: one premium Connect-blue `Open workspace` button that opens the CRM contact workspace with campaign/member context. Do not add duplicate Workspace, Contact, callback, or icon-only action clusters to member rows.
- Member status pills/selects should be compact, semantic, and consistent width. Use subtle backgrounds and borders; avoid large glossy pills or tall native controls.
- Responsive behavior: desktop is a dense table; tablet/mobile stack each member into a compact card row with visible labels and an easy-tap workspace action. No horizontal overflow.

## Campaign Active Workspace (contact detail)

- Entry: `/crm/contacts/[id]?campaignId=…&memberId=…` (from campaign member **Open workspace** or queue deep-links). Presentation lives in `apps/portal/app/(platform)/crm/contacts/[id]/page.tsx` with scoped CSS `.crm-contact-detail-workspace`.
- **Sticky header:** `ContactCampaignStickyHeader` keeps lead name, company, phone, stage, campaign chip, and compact KPI strip visible (`position: sticky` within the workspace frame). Top-right actions: **Call** (primary), **VM Drop**, **Edit**, **Archive**. SMS, Email, and Note are not duplicated in the header — agents use the left workspace nav for those channels.
- **Independent scroll (desktop ≥1280px):** left workspace nav rail, center workspace content, and right summary rail each scroll inside `.crm-contact-workspace-panel`, but wheel scroll is allowed to chain naturally when a panel reaches its top/bottom.
- **Navigation:** left sidebar is the sole workspace tab switcher (Timeline, Script, Checklist, Email, SMS, Notes, Files, etc.). The center panel no longer duplicates that row.
- **Quick Disposition (right rail):** `ContactQuickDispositionCard` is pinned at the top of the right column (`crm-contact-quick-disposition-slot`) in a compact modern card: active phone (plain display text), last disposition, four primary one-click pill buttons, text-style **More** / **Manage** utility actions, and manager custom label editing. Channel context follows the last Call/SMS/Email/VM outreach action (no channel picker in the card). One-click save only — notes belong in the Notes workspace tab.
- **Scroll shell:** at desktop widths, left/center/right panels each scroll inside dedicated inner regions; sticky contact header remains fixed above the workspace grid.
- **Timeline density:** `ContactTimelineItem` uses compact row padding and icon-only note edit/delete controls (no bordered action buttons) so more history fits on screen.
- **Per-phone dispositions:** `POST /crm/contacts/:id/disposition` accepts optional `phoneId` + `channel`. Latest disposition per phone is returned on `GET /crm/contacts/:id` phone rows (`lastDisposition`, `lastDispositionChannel`, `lastDispositionAt`). Timeline `DISPOSITION_SET` metadata includes phone label, number, channel, and note.
- **Campaign lead navigation:** when `campaignId` is present, `ContactCampaignLeadNav` loads members from `GET /crm/campaigns/:id/members` and provides fixed Prev/Next (+ `ArrowLeft` / `ArrowRight` when not typing in an input).
- **Start outreach:** empty timeline CTA switches to **Notes**, focuses the composer, shows a toast; does not silently no-op when the composer was unmounted.
- **Right rail sections:** informational panels use `ContactCollapsibleSection` with title-only collapsed rows, a consistent white card surface, and simple text empty states instead of bordered empty containers. On desktop (fine pointer, viewport ≥1280px), agents can reorder the seven summary sections by dragging the section header itself — no drag handle or extra icon. Order persists per user in `localStorage` (`crm-contact-workspace-right-rail-order[:userId]`). Quick Disposition and Possible duplicates stay pinned outside the reorder list. Touch/coarse-pointer viewports disable drag so scrolling is unaffected. Keyboard reorder is not implemented; expand/collapse still works via click (8px movement threshold before drag activates).
- **Phone numbers:** `ContactPhone.type` is the per-phone business label shown in the sticky header, contact info, SMS panel, and Call/SMS picker. Multi-phone Call/SMS actions open a picker; single-phone contacts continue immediately. Current API supports add/delete phones but does not expose a phone update route, so existing phone label editing is not implemented in the portal.
- **Do not** break `assertCrmContactAllowed` scope — workspace uses existing contact/timeline/task/disposition APIs only.

## CRM Dashboard Light Mode

- `/crm/dashboard` has a dedicated light-mode presentation scoped through `.crm-dashboard-shell` and `.crm-dashboard-workspace`; do not reuse these classes on other CRM routes unless the whole route adopts the same light system.
- Shared data, hooks, permissions, links, and derived metrics stay in `apps/portal/app/(platform)/crm/dashboard/page.tsx`. Light mode is presentation-only CSS plus small component presentation hooks.
- Light tokens use warm page backgrounds, soft elevated white/cream panels, blue and purple accents, semantic KPI color wells, 24-30px card radii, and modern soft shadows.
- Typography hierarchy: large cardless greeting header, compact but readable section titles, large tabular KPI values, and short uppercase metadata labels.
- KPI cards use `DashboardKpiTile` with the `accent` prop. Add new accent variants only in `globals.css` and keep the tile data-driven.
- Sidebar and topbar refinements are route-scoped by `.crm-dashboard-shell` so the rest of the portal shell is not visually changed.
- Right-side panels should be real operational groups: reminders, recent activity, action required, shortcuts, and optional import status. No fake reminders, demo data, or inactive buttons.
- In light mode, the right rail starts beside the KPI strip to match the dashboard reference. Keep dark-mode grid placement scoped so the existing dark dashboard posture is not unintentionally rearranged.
- Responsiveness: preserve the 8+4 desktop grid, collapse the right rail to two columns on tablet, and stack everything on mobile with no fixed-width overflow.
- Theme switching must preserve route state and loaded data. Do not branch into separate fetching trees for light vs. dark.

## CRM Queue Light Mode

- `/crm/queue` is a premium operational workspace in light mode, scoped by `.crm-queue-shell` and `.crm-queue-workspace`; do not reuse dashboard route classes directly.
- Preserve the existing queue APIs, hooks, URL filters, SIP actions, campaign filter, and live-call/contact routing. The redesign is presentation and layout only.
- Queue KPI cards use `QueueCountPill` variants for Pending, Due, Overdue, Upcoming, Completed Today, and Session Efficiency. Do not duplicate these headline counts in secondary snapshot cards.
- Empty state rules: `QueueEmptyOperational` should feel intentional when there is no queue work. It may link only to real routes/actions: `/crm/campaigns`, `/crm/import`, `/crm/reports`, clear campaign, or switch pending.
- Workbench layout: page title, sort/refresh actions, KPI row, and campaign filter live in fixed `CRMWorkspaceChrome`; the center assigned queue/list lives in `CRMWorkspaceScrollRegion` and is the only desktop work area expected to scroll.
- Right rail architecture: keep a compact `Priority Focus` panel visible beside the list with exactly Due Today, Overdue, Follow Ups, and High Priority cards. Do not reintroduce Today's Snapshot, Session, Queue Health, or Active Campaign summary cards on My Queue.
- Responsive behavior: desktop split layout, tablet/mobile stacked flow with normal page scroll. Avoid fixed widths that can create horizontal overflow.
- Dark mode remains operational and token-based. Light-mode polish should stay under queue-scoped CSS so theme toggles do not remount or reset queue state.

## CRM Scripts Light Mode

- `/crm/scripts` is a UI-only redesign around the existing scripts list/create APIs. It keeps `GET /crm/scripts?includeInactive=true`, `POST /crm/scripts`, keyboard `N`, and real template prefill behavior.
- `/crm/scripts/[id]` loads and edits a single script through existing `/crm/scripts/:id` APIs. Visible actions remain real: edit/save, archive, restore, copy, duplicate, and Live Call navigation.
- The create/edit modal only exposes fields backed by current state/API: script name, optional starter template, and editable sections serialized to the existing body format. Do not add fake category/tag persistence unless backend support is added.
- Light-mode styling is scoped by `.crm-scripts-workspace` and `.scripts-edit-modal`; dark mode continues through CRM tokens.
- Right-rail instructions, tips, quick actions, metadata, and shortcuts must use real routes/actions only.

## CRM workspace shell (list pages)

Layout-only pattern for CRM desk pages (Queue, Funders, Tasks, Scripts, Checklists, Voicemail Drops). No API, permission, or data-loading changes.

### Components

- `apps/portal/components/crm/CRMWorkspaceShell.tsx` — compound layout:
  - `CRMWorkspaceShell` — root; fills page inner area
  - `CRMWorkspaceChrome` — fixed header + toolbar stack (`flex-shrink: 0`)
  - `CRMWorkspaceHeader` / `CRMWorkspaceToolbar` / `CRMWorkspaceFooter`
  - `CRMWorkspaceBody` — `split` prop enables main + right rail grid
  - `CRMWorkspaceMain` / `CRMWorkspaceScrollRegion` — independent list/library scroll
  - `CRMWorkspaceRightRail` — visible side panel with inner scroll

### CSS

- Class strings in `crmClasses.ts`: `workspaceShell`, `workspaceChrome`, `workspaceScrollRegion`, etc.
- Global rules in `globals.css` under “CRM workspace shell”:
  - `.console-content:has(.crm-workspace-shell)` → no page scroll, `padding: 0`
  - Desktop: `max-height: calc(100dvh - var(--topbar-height))` on shell
  - `<1280px`: split bodies stack; page scroll allowed for graceful mobile use
- `/crm/funders` keeps search/filter controls sticky in the Funders chrome, renders the bulk action bar only for selected rows, and uses independent desktop scroll regions for the funder list and right rail.

### When adding a new CRM list page

1. Wrap content in `CRMPageShell` + `CRMWorkspaceShell`.
2. Put title, KPIs, search, filters, and bulk controls in `CRMWorkspaceChrome`.
3. Put tables/lists in `CRMWorkspaceScrollRegion` (or a nested scroll inside a panel, e.g. Scripts library).
4. Put summary rails in `CRMWorkspaceRightRail` when applicable.
5. Do not duplicate height/overflow logic per page — extend shared utilities only.

## Verification

- For CRM portal UI changes, run portal typecheck and portal build.
- Confirm mobile responsiveness by keeping grids stacked on small screens and avoiding fixed desktop-only widths.
- For CRM visual redesigns, use local visual QA mode for authenticated screenshots:
  - Start: `pnpm --dir apps/portal dev:crm-visual-qa`
  - Capture: `pnpm --dir apps/portal screenshots:crm -- --routes /crm/dashboard,/crm/queue,/crm/contacts --theme light`
  - Output: `_tmp_diag/crm-visual-qa-screenshots/`
- Visual QA mode is local-development only. It is gated by `NODE_ENV=development`, `NEXT_PUBLIC_CRM_VISUAL_QA=1`, and a loopback browser host. It must not be used as evidence for backend behavior, production auth, tenant isolation, billing, telephony, or onboarding.
