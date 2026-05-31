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

## CRM role permissions (portal + API)

| CrmUserAccess role | Portal legacy keys | CRM Email nav (`can_view_crm_email`) | CRM Email settings (`can_view_crm_settings`) |
|--------------------|----------------------|--------------------------------------|-----------------------------------------------|
| AGENT | `can_view_crm` | Yes — send, templates, USER OAuth from `/crm/email` | No |
| MANAGER | `can_manage_crm` | Yes — same as agent | No |
| ADMIN | `can_manage_crm` + `can_manage_crm_admin` | Yes | Yes — `/crm/email/settings`, fleet diagnostics API |

- Permissions are merged in `resolvePortalPermissionsWithCrmUserAccess` only when tenant CRM is enabled and `CrmUserAccess.enabled`.
- **API:** `/crm/email/*` (except OAuth callback) requires `requireCrmAccess`. `POST /crm/email/send` checks `assertCrmContactAllowed` (assignment or allowed campaign when user has campaign restrictions). Fleet diagnostics: `requireCrmEmailSettingsAccess`.
- **Contact scope:** `assertCrmContactAllowed` enforces campaign assignment for AGENT users on contact-scoped mutations (disposition, checklist respond, voicemail drop, notes, tasks, email send, contact detail). **List/search** (`GET /crm/contacts`, `GET /crm/contacts/lookup`, stats, duplicate suggestions) apply the same scope at query time so restricted Agents never see out-of-scope rows or inflated totals. CRM MANAGER / CRM ADMIN bypass campaign restrictions within the tenant (still tenant-scoped via `contact.tenantId`).
- **Voicemail drops:** list/use/drop/upload/edit/archive routes use `requireCrmAccess` (Agent + Manager + CRM Admin). PBX/system recording settings remain outside this feature (`/pbx/call-recordings`, admin-only).

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
| Dispositions — set on contact | Contact profile / live workspace | `POST /crm/contacts/:id/disposition` | `requireCrmAccess` + `assertCrmContactAllowed` | Yes (in scope) | Yes (tenant) | Yes (tenant) | Yes |
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

**Scope legend:** *in scope* = assigned to agent or in an assigned campaign when `CrmUserCampaignAssignment` rows exist; *tenant* = any contact in the tenant (Managers/CRM Admins bypass campaign allow-list).

## Dashboard And Email UI

- CRM dashboard modernization is UI-only. Keep existing API calls in `apps/portal/app/(platform)/crm/dashboard/page.tsx`; derive status from the values already loaded there.
- CRM Email landing uses only `/crm/email/connection`, `/crm/email/recent`, and `/crm/email/replies/recent` (agents skip fleet diagnostics).
- CRM Email Settings uses only `/crm/email/connections`, `/crm/email/oauth/start`, `/crm/email/sync-now`, `/crm/email/connection/test`, `/crm/email/connections/:id`, and `/crm/email/sync-last`.
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
- Preserve the existing queue APIs, hooks, URL filters, power session behavior, SIP actions, campaign filter, and live-call/contact routing. The redesign is presentation and layout only.
- Queue KPI cards use `QueueCountPill` variants for Pending, Due, Overdue, Upcoming, Completed Today, and Session Efficiency. Do not duplicate these headline counts elsewhere unless the second location adds different action context.
- Empty state rules: `QueueEmptyOperational` should feel intentional when there is no queue work. It may link only to real routes/actions: `/crm/campaigns`, `/crm/import`, `/crm/queue?mode=power`, `/crm/reports`, clear campaign, or switch pending.
- Right rail architecture: `QueueOverviewPanel` owns Today's Snapshot and Session; `QueueAttentionPanel` owns Queue Health and Recent Activity. Keep data honest and derived from existing queue/task/campaign stats.
- Active campaign strip and priority cards belong below the main workspace. They should support real campaign context and queue/task counts without adding backend fields.
- Responsive behavior: desktop 8+4 layout, tablet two-column right rail, mobile single-column stack. Avoid fixed widths that can create horizontal overflow.
- Dark mode remains operational and token-based. Light-mode polish should stay under queue-scoped CSS so theme toggles do not remount or reset queue state.

## CRM Scripts Light Mode

- `/crm/scripts` is a UI-only redesign around the existing scripts list/create APIs. It keeps `GET /crm/scripts?includeInactive=true`, `POST /crm/scripts`, keyboard `N`, and real template prefill behavior.
- `/crm/scripts/[id]` loads and edits a single script through existing `/crm/scripts/:id` APIs. Visible actions remain real: edit/save, archive, restore, copy, duplicate, and Live Call navigation.
- The create/edit modal only exposes fields backed by current state/API: script name, optional starter template, and editable sections serialized to the existing body format. Do not add fake category/tag persistence unless backend support is added.
- Light-mode styling is scoped by `.crm-scripts-workspace` and `.scripts-edit-modal`; dark mode continues through CRM tokens.
- Right-rail instructions, tips, quick actions, metadata, and shortcuts must use real routes/actions only.

## Verification

- For CRM portal UI changes, run portal typecheck and portal build.
- Confirm mobile responsiveness by keeping grids stacked on small screens and avoiding fixed desktop-only widths.
- For CRM visual redesigns, use local visual QA mode for authenticated screenshots:
  - Start: `pnpm --dir apps/portal dev:crm-visual-qa`
  - Capture: `pnpm --dir apps/portal screenshots:crm -- --routes /crm/dashboard,/crm/queue,/crm/contacts --theme light`
  - Output: `_tmp_diag/crm-visual-qa-screenshots/`
- Visual QA mode is local-development only. It is gated by `NODE_ENV=development`, `NEXT_PUBLIC_CRM_VISUAL_QA=1`, and a loopback browser host. It must not be used as evidence for backend behavior, production auth, tenant isolation, billing, telephony, or onboarding.
