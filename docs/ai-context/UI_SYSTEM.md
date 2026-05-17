# UI system — Portal, Workspace, and CRM

> **Scope:** `apps/portal` visual language. Telephony/PBX/mobile are out of scope here.

---

## Principles

1. **One product** — CRM routes must feel like the same app as the Workspace shell (`console-shell`, sidebar, topbar), not a separate light admin theme.
2. **Dark operational UI** — Default is dark-only (`:root` / `data-theme="dark"`). No accidental `bg-white` / `bg-gray-50` cards on CRM pages.
3. **Calm SaaS** — Compact cards, honest metrics, no marketing gradients or banner spam.
4. **CSS variables first** — Surfaces inherit `--panel`, `--text`, `--border`, `--accent` via CRM tokens.

---

## CRM tokens (`globals.css`)

| Token | Maps to | Use |
|-------|---------|-----|
| `--crm-bg` | `--bg-soft` | Page backdrop inside shell |
| `--crm-surface` | `--panel` | Cards, panels |
| `--crm-surface-2` | `--panel-2` | Inputs, chips, nested rows |
| `--crm-border` | `--border` | Card and control borders |
| `--crm-text` | `--text` | Primary copy |
| `--crm-text-muted` | `--text-dim` | Secondary copy |
| `--crm-accent` | `--accent` | Primary actions, links |
| `--crm-danger` / `--warning` / `--success` | semantic vars | Status only |

Tailwind utilities: `bg-crm-surface`, `text-crm-muted`, `rounded-crm-lg`, `shadow-crm`, etc. (`apps/portal/tailwind.config.js`).

**Tailwind preflight is disabled** — do not enable without auditing `globals.css` layout.

---

## CRM primitives (`apps/portal/components/crm/`)

| Component | Role |
|-----------|------|
| `CRMPageShell` | Max-width page column + section gap (replaces `min-h-screen bg-gray-50`) |
| `CRMCard` | Standard bordered surface (replaces ad-hoc `SoftPanel` / white Tailwind cards) |
| `CRMPageHeader` | Command header: icon, title, subtitle, actions |
| `CRMSection` | Titled block with optional actions |
| `CRMStat` | Compact label/value in summary strips |
| `CRMEmptyState` | Dashed empty panel |
| `CRMActionBar` | Filter / bulk toolbar card |
| `crm` (`crmClasses.ts`) | Shared class strings for buttons, inputs, chips |

Prefer primitives + `crm.*` classes over one-off `gray-*` / `white` utilities on CRM routes.

---

## Dashboard visualization (Phase 19B)

The CRM command center (`/crm/dashboard`) uses **operational visuals only** — data from existing CRM APIs, no demo series or fake realtime.

| Pattern | Component | Use |
|---------|-----------|-----|
| Distribution | `CRMDonutChart` + `CRMChartLegend` | Pipeline mix, campaign status, growth split |
| Pressure / volume | `CRMHorizontalBars` | Follow-up backlog, today’s activity |
| Workload ring | `CRMRingMetric` | Task overdue vs open load |
| KPI strip | `DashboardKpiTile` | Scannable today metrics (number + label, no paragraphs) |
| Priority actions | `DashboardActionCard` | Needs-attention queue (count + link) |

**Layout:** `crm.pageInnerWide` (`max-w-[1400px]`) — 8+4 column grid on large screens; charts and lists stay stacked on tablet/mobile.

**Copy rules:** Section titles are short labels; no multi-sentence hints under headings. Empty states are one line + link.

Chart colors live in `components/crm/charts/chartColors.ts` (aligned with `--crm-accent`, danger, warning, success).

---

## Queue operational workspace (Phase 19C / 19C.1)

`/crm/queue` is a **full-width outbound workbench**, not a narrow centered list.

| Zone | Width (xl / 2xl) | Role |
|------|------------------|------|
| Feed | 7 / 8 cols | Live queue rows, featured next lead, power session card |
| Overview | 3 / 2 cols | Queue mix bars, due/overdue tiles, today stats from `/crm/tasks/stats` |
| Attention | 2 cols | Compact alert links (overdue, tasks, campaign) — only when counts > 0 |

**Layout shell:** `crm.pageInnerQueue` (`max-w-[min(100%,1680px)]`, tighter horizontal padding on large screens). **Primitives:** `CRMPageHeader`, `CRMActionBar`, `QueueCountPill`, `QueueOperationalRow`, `QueuePowerSessionBar`, `QueueEmptyOperational`, side panels in `components/crm/queue/*`.

**Dark surfaces (19C.1):** count pills use `crm.queueCountPill*`; banners use `crm.bannerSuccess|Warning|Danger`; power call CTA uses `crm.btnCallSuccess`. **No** `bg-white`, `bg-gray-50`, `bg-green-50`, or Tailwind `*-100` status chips on queue routes.

**Power mode:** sticky `QueuePowerSessionBar` (gradient session bar, filter chips, progress, pause/end) — not toggle chips in empty space.

**Visual priority:** overdue / due callbacks use `crm-danger` / `crm-warning` on rows and side tiles; “next best lead” uses accent ring.

**Empty queue:** `QueueEmptyOperational` — single compact caught-up card; today metrics live only in the command sidebar (`Your activity today`), not duplicated in the feed.

**Information hierarchy (19C.2):** Top `QueueCountPill` row is the **only** place for pending/due/overdue/upcoming counts. Right column is one stack: command context (`QueueOverviewPanel`: in-view total, next action, activity today, campaign) + exceptions (`QueueAttentionPanel`: tasks/callback exceptions only — no repeat queue snapshot counts).

---

## Campaign operational workspace (Phase 19E / 19E.1)

Campaign routes use **`crm.pageInnerCampaign`** (wide desk, up to ~1680px) and **`components/crm/campaign/*`**.

| Zone | Pattern |
|------|---------|
| Index | `CRMPageHeader` + compact summary strip + **dense** `CampaignIndexCard` rows (status accent strip, inline metrics, primary Open/Queue) |
| Detail header | `CampaignCommandHeader` — identity / live snapshot / operations (queue primary when active, power secondary) |
| Detail body | 8+4 grid (`gap-3`): `CampaignMemberCard` feed + sticky `CampaignOperationalSidebar` |
| Performance | `CampaignPerformancePanel` — single compact card: donut + funnel + rings from `statusCounts` only |
| Imports | `CampaignImportEventCard` in sidebar; empty imports use `CampaignGuidedEmpty` |
| Empties | `CampaignGuidedEmpty` — numbered steps + actions (import / add / distribute / queue when meaningful) |

**Density (19E.1):** No oversized sparse cards, no centered narrow column on wide screens. Index cards are one horizontal operational row, not a tall side-rail layout.

**Index card readability (19E.2):** `CampaignIndexCard` uses a **3-zone** row on `lg+`: identity · metric clusters · actions. Compact `min-h-[6rem]` — not sparse, not cramped shorthand. Campaign list is `list-none` (no bullet markers).

**Operational polish (19E.3):** Index cards group metrics into **Volume** (Members, In queue) and **Outcome** (Callbacks, Converted) clusters (`crm.campaignMetricCluster*`). `getCampaignQueuePressure()` renders one-line interpretation from report counts only (e.g. “Queue healthy”, “High callback pressure · N waiting”) — no fake overdue analytics. **Action tiers:** primary Open campaign · secondary Queue/Power (`crm.campaignBtnSecondaryCompact`) · tertiary Pause/Archive (`crm.campaignBtnTertiary`). Active cards: subtle strip pulse + live dot (`crm-campaign-live-dot`), hover lift, soft glow when `pending > 0`. Status uses restrained index badges (`CampaignStatusBadge variant="index"`). Sticky command bar: `crm.campaignCommandSticky` + `crm.campaignSearchInput` + dark `filterPill*` status filters.

**Dark surfaces (19E.1+):** Wrap campaign pages in `crm.campaignWorkspace` (forces dark tokens under light portal theme). Index filters use `crm.campaignFilterBar` + `crm.input` / `crm.select`. Modals use `crm.campaignModalBackdrop`, `crm.campaignPriorityPill*`. Ban `bg-white`, `bg-gray-50`, `bg-green-100`, light native inputs, and duplicate metric panels.

**Layout (19E.3 detail):** No skinny right rail. Vertical `crm.campaignDetailStack`: `CampaignCommandHeader` (12-col at `lg+`: identity / live snapshot / operations) → `CampaignPerformancePanel` (funnel only) → full-width `CampaignDetailCommandPanel` (next actions, workload, imports, settings in responsive grid) → full-width members feed. Counts once in header snapshot; performance panel does not repeat member totals.

**Queue continuity:** `/crm/queue?campaignId=…` and `/crm/queue?mode=power&campaignId=…`. No fake realtime or AI analytics.

---

## Live call workspace / communication cockpit (Phase 19F)

`/crm/live-call` is the **agent communication desk** — operational even with no contact selected.

| Zone | Width (xl+) | Role |
|------|-------------|------|
| Session rail | 3 / 12 | Queue/campaign/contact context, back/next links, library shortcuts |
| Main | 6 / 12 | Live call status, contact header, note, SMS, outcome, **timeline center** |
| Helpers | 3 / 12 | Script, checklist, open tasks |

**Layout shell:** `crm.pageInnerLive` (`max-w-[1440px]`). **Primitives:** `LiveWorkspace*` in `components/crm/live/*` + shared `ContactTimeline` / `ContactSmsPanel`.

**Idle state:** `LiveWorkspaceIdle` — ready desk, quick links, optional `/crm/tasks/stats` snapshot — not a dead centered message.

**Live call visual language:** `LiveCallStatusBanner` uses `useTelephony()` when matched; otherwise honest placeholders. No fabricated timers or demo calls.

**Continuity:** Preserve `contactId`, `memberId`, `campaignId`, `returnTo`, `mode=power`, `linkedId`, `from` — screen-pop and queue URLs unchanged.

---

## Task command desk (Phase 19H)

`/crm/tasks` is the **CRM task triage and action desk** — not a generic todo list.

| Zone | Width (lg+) | Role |
|------|-------------|------|
| Feed | 8 / 9 cols | KPI strip, tab pills with counts, quick-add row, urgency-partitioned task cards |
| Sidebar | 4 / 3 cols | `TaskSidebar`: urgency ring (my overdue vs. open), workload tiles, quick-focus links, workspace shortcuts |

**Layout shell:** `crm.pageInnerTasks` (`max-w-[1500px]`). **Workspace lock:** `crm.tasksWorkspace` (same dark token override as campaigns/contacts so inputs stay dark under light portal theme).

**KPI strip (`TaskKpiStrip`):** four clickable tiles — Overdue (danger tint when > 0), Due today (warning when > 0), Assigned to me, All open. Clicking a tile changes the active tab.

**Tab pills (`TaskTabRow`):** compact pills with inline counts and urgency tones (danger for overdue, warning for due-today). Count badges use data from `/crm/tasks/stats` — real API, never fabricated.

**Task cards (`TaskCard`):** operational card with **left priority rail** (crm-border/accent/warning/danger by priority), contact name link, due date with overdue countdown, assignee, body preview. Quick-action column: Workspace link, Contact record.

**Urgency partitioning (`TaskFeed`):** For `mine` and `all` tabs, tasks are partitioned client-side into Overdue → Due today → Upcoming → No due date sections. Each section has a color-coded header. Overdue / today tabs show flat list (already server-filtered).

**Quick add (`TaskQuickAdd`):** Collapsed to a dashed "Add a task…" row. Expands to inline composer (title → contact search → due + priority). Accepts `forceOpen` prop for imperative open from header button or keyboard `N`. On submit calls real `POST /crm/contacts/:id/tasks`.

**Empty states (`TaskEmptyState`):** Per-tab contextual content — overdue empty = success state + go to queue; today empty = actionable links to overdue or add; mine empty = add task CTA + queue link; all empty = onboarding copy + contacts link.

**Dark surfaces:** All components use `crm.*` class strings. No `bg-white`, `bg-gray-50`, light inputs, or inline color hacks.

**Keyboard:** `N` opens quick-add (guarded against input/textarea focus and modifier keys).

---

## Scripts playbook workspace (Phase 19I / 19I.1)

`/crm/scripts` is the **premium outbound sales playbook command center** — live enablement, not a textarea CRUD page.

| Zone | Width (lg+) | Role |
|------|-------------|------|
| Hero | full width | `ScriptCommandHeader` — gradient command bar + KPI tiles |
| Library | 3 / 12 | `ScriptLibraryPanel` — accent template cards, script list, search |
| Workspace | 6 / 12 | `ScriptWorkspace` / `ScriptWorkspaceIdle` — live playbook or onboarding |
| Sidebar | 3 / 12 | `ScriptOperationalSidebar` — ring metric, workload, shortcuts |
| Tips | full width | `ScriptQuickTipsStrip` — keyboard + checklist + live-call hints |

**Layout shell:** `crm.pageInnerScripts` (~1680px) + `crm.scriptsWorkspace` (dark token lock). **Grid:** `crm.scriptsGrid` → `scriptsLibraryCol` / `scriptsWorkspaceCol` / `scriptsSideCol`.

**Premium visual language (19I.1):** Layered navy gradients (`scriptsHero`, `scriptsPanelPrimary`), accent glow strips per template (`SCRIPT_TEMPLATE_ACCENT_CLASSES`), glass KPI tiles, hover lift on template cards. Idle center = glowing document visual + feature row (Proven Playbooks, Live Playbook View, Checklist Mode, Win More Calls). **No flat gray slabs.**

**Library:** Template cards use per-type accents (cyan cold call, violet follow-up, amber re-engagement, green callback, blue voicemail, rose closing). Collapsible template rail when scripts exist. **+ New script** primary CTA in library header.

**Workspace:** `ScriptSectionBlock` per `---` section; Playbook vs Checklist mode; copy-per-section; live-call link. **Keyboard:** `N` opens new script (guarded).

**Dark surfaces:** `crm.scriptTplCard`, `scriptsPanelPrimary`, `scriptsSidePanel`, `scriptsTipsStrip`. Ban `bg-white`, `bg-gray-50`, flat gray admin cards.

---

## Checklist operational workspace (Phase 19J)

`/crm/checklists` is a **workflow checklist management desk** — structured like the live call workspace so agents can build and organize call checklists in context.

| Zone | Width (lg+) | Role |
|------|------------|------|
| Library | 3 / 12 | Checklist list, archive, starter templates |
| Workspace | 6 / 12 | Active checklist editor / viewer with numbered workflow steps |
| Progress panel | 3 / 12 | Item stats, required warnings, quick actions |

**Layout shell:** `crm.pageInnerChecklist` (`max-w-[min(100%,1600px)]`). **Dark lock:** `crm.checklistWorkspace` (same CSS-var override pattern as campaigns/tasks/scripts). **Primitives:** `ChecklistLibraryPanel`, `ChecklistWorkspace`, `ChecklistProgressPanel` in `components/crm/checklists/*`.

**Step visual language:** Items render as **numbered workflow steps** (`crm.checklistStepCard`) — required steps use warning accent ring (`crm.checklistStepRequired`), optional steps use standard surface (`crm.checklistStepPending`). Step numbers are badge circles (`crm.checklistStepNum` / `crm.checklistStepNumRequired`).

**Templates:** 6 starter templates (`ChecklistTemplates.ts`) — Cold call, Appointment booking, Insurance verification, Callback workflow, Objection handling, Follow-up. Templates pre-fill the create form; no API call until the user confirms.

**Progress panel:** Progress ring shows required-step ratio. Banners surface actionable warnings: no required steps, no steps at all, archived state. "Ready for live call" confirmation when isActive + items.length > 0 + requiredCount > 0.

**Empty state (19J.1):** `TemplateGrid` command-center hero — "Choose a playbook to begin", template count chip, accent-colored template cards (`TEMPLATE_ACCENT_CLASSES`: cyan/amber/blue/green/violet/rose), "Start from blank" footer CTA. Not a dead centered icon.

**Visual hierarchy (19J.1):** Center column uses **`crm.checklistPanelPrimary`** (navy gradient + radial glow). Library and progress use **`crm.checklistPanelSupport`** (quieter support surfaces). Template cards: left accent strip, icon glow box, hover lift (`checklist-template-card` in globals.css, `prefers-reduced-motion` safe). Progress panel: richer ring + compact stat rows.

**Dark surfaces:** Ban `bg-white`, `bg-gray-*`, inline `style={{ background: '#fff' }}`, native white inputs. Use `crm.input`, `crm.checkbox`, `crm.btn*` throughout.

---

## Aligned routes (Phase 19A+)

- `/crm/dashboard` (Phase 19B: command-center charts + wide layout)
- `/crm/queue` (Phase 19C: operational workbench layout)
- `/crm/campaigns`, `/crm/campaigns/[id]` (Phase 19E: operational workspace)
- `/crm/contacts` (Phase 19D.1 index + 19D.2 dark command controls)
- `/crm/contacts/[id]` (Phase 19D: contact relationship workspace)
- `/crm/live-call` (Phase 19F: live agent workspace)
- `/crm/tasks` (Phase 19H: task command desk)
- `/crm/scripts` (Phase 19I: scripts playbook workspace)
- `/crm/checklists` (Phase 19J: checklist operational workspace)

Reports, wallboard: migrate opportunistically.

---

## Contacts index — relationship command center (Phase 19D.1)

`/crm/contacts` is the **tenant relationship directory**, not a narrow database table.

| Pattern | Rule |
|---------|------|
| Layout width | `crm.pageInnerContacts` (~1400px) — use horizontal space on desktop |
| Header | `CRMPageHeader` + primary **New contact**; optional **My queue** / **Import** when permitted |
| Summary | `SummaryStatTile` grid — total from API + honest page-scoped active/archived/missing phone/email/stage |
| Command bar | Full-width search (`crm.input`) + stage pills + admin archive scope + assigned-to-me |
| Rows | Divided list inside `CRMCard` — avatar, stage chip, contact channels, owner/activity, **Open** (primary) + **Workspace** |

**Don't:** `max-w-6xl` centered directory; text-only summary strip; light skeletons (`gray-50`); bullet separators between meta fields.

### Contacts command bar — dark controls only (Phase 19D.2)

| Pattern | Rule |
|---------|------|
| Theme lock | `crm.pageInnerContacts` + **`crm.contactsWorkspace`** — same CSS-var override as campaigns when portal `data-theme=light` |
| Filter pills | `crm.filterPill` / `crm.filterPillActive` for stage, list scope (Active/Archived/All), and **Assigned to me** — never white capsules or `bg-crm-surface` idle pills |
| Inputs | Search = `crm.input`; bulk assign select = `crm.selectCompact`; `[color-scheme:dark]` on native controls |
| Checkboxes | `crm.checkbox` — dark surface + accent; row column aligned with avatar (`items-center`, fixed width) |
| Row actions | `crm.btnPrimary` (Open) + `crm.btnSecondary` (Workspace) in a single aligned flex row |

**Don't:** native white checkboxes; transparent/light archive-scope pills; mixed pill styles per control group.

---

## Contact relationship workspace (Phase 19D)

`/crm/contacts/[id]` is a **communication-centric operational workspace**, not a contact record form.

| Pattern | Component / rule | Use |
|---------|------------------|-----|
| Layout width | `crm.pageInnerContact` (~1400px) | Timeline-first main column + sticky operational sidebar |
| Header | `ContactWorkspaceHeader` | Identity left, operational pulse center, primary actions right |
| Sticky actions | `ContactStickyActionBar` | Call, workspace, SMS, note, task, return-to-queue while scrolling |
| Timeline | `ContactTimeline` + `ContactTimelineItem` | Primary feed — calls, SMS, notes, tasks, recordings from `GET …/timeline` |
| SMS thread | `ContactSmsPanel` | Bubble UI derived from timeline SMS events + `POST …/sms` composer |
| Sidebar | `ContactRelationshipHealth`, next-step card, tasks, outreach rules | Real metrics only (7d touches, overdue tasks, callback pressure) |
| Queue continuity | URL `returnTo`, `memberId`, `campaignId` + `GET /crm/queue` match | Back to queue, campaign chip, callback context |

**Do:** timeline-first column order (note → SMS → timeline); dark `crm-*` chips for disposition/SMS; `CRMEmptyState` for zero activity.

**Don't:** `bg-white` / light SMS bubbles; fake lead scores or sentiment; duplicate timeline + sidebar SMS panels; narrow `max-w-6xl` stacked form layout.

---

## Live wallboard / TV-ready operations command center (Phase 19G)

`/crm/wallboard` is the **tenant CRM operations command center** — designed for TV display and manager dashboards.

| Zone | Pattern |
|------|---------|
| Shell | `crm.wallboardWorkspace` + inline `background: var(--crm-bg, var(--bg-soft, #101923))` — forces dark tokens even when portal `data-theme=light` |
| Header | Sticky `bg-crm-surface/95 backdrop-blur-sm border-b border-crm-border`; icon box + title + live WS chip + urgent chip; right: countdown, last-updated, Refresh (`crm.btnGhost`), TV Mode (`crm.btnSecondary`) |
| KPI strip | 8-column responsive grid of `WallboardKpiTile` — `text-3xl` normal / `text-5xl` TV; `tone="danger|warn|positive|neutral"` tinted border; no blue gradient banner |
| Panels | `WallboardPanel` — `border-crm-border bg-crm-surface shadow-crm`; panel headers `bg-crm-surface-2/30 border-b border-crm-border` |
| Agent leaderboard | Visual bar rows — disposition bar (`bg-crm-accent`), callbacks-due bar (`bg-crm-warning`), queue bar (`bg-crm-muted/30`); normalized against team max. No spreadsheet table. |
| Campaign progress | Segmented bar: contacted/callbacks/converted/DNC with CSS `transition-[width] duration-300`; dark `bg-crm-surface-2` track |
| Follow-up urgency | `CRMRingMetric` pair (callback + task pressure) when urgent; "All caught up" `bg-crm-success/8` banner when zero; 4-tile count grid + actionable rows |
| TV mode | `fixed inset-0 z-50` overlay per Rule 77 — large center clock, same KPI/panel layout, `crm.wallboardWorkspace` dark tokens throughout |

**Token:** `crm.wallboardWorkspace` added to `crmClasses.ts` — same override pattern as `crm.campaignWorkspace`.

**No light surfaces:** never `bg-white`, `bg-gray-50`, `bg-gray-100`, or ad-hoc `gray-800/900`. All panels use `--crm-surface` / `--crm-border`.

**Live animation:** `animate-pulse` on WS Live dot; `transition-[width] duration-500` on leaderboard bars; `transition-[width] duration-300` on campaign bars. No JS-driven fake realtime.

**Data:** real API endpoints only — `/crm/reports/daily`, `/crm/reports/campaigns`, `/crm/reports/agents`, `/crm/reports/follow-ups`. Live calls from `useTelephony().activeCalls`. No fake data.

---

## CRM Intelligence workspace (Phase 19K)

`/crm/reports` is the **operational VoIP CRM intelligence hub** — dark command surface, not a generic admin dashboard.

| Zone | Component | Role |
|------|-----------|------|
| Sticky command header | `ReportsCommandHeader` | Tabs (Operations/Campaigns/Agents/Follow-ups/Intelligence), live pulse, refresh, export |
| Hero row | `ReportsHeroCard` (×4) | Queue Pressure, Callback Health, Today's Activity, Follow-up Pressure — large operational values with tones |
| Activity bars | `CRMHorizontalBars` | Distribution of today's activity types |
| Queue ring | `CRMRingMetric` | Work queue pending vs worked |
| Operational sidebar | `ReportsInsightFeed` | Derived alerts (queue exhaustion, callback SLA, stale campaigns, inactive agents) |
| Tables | `ReportsOperationalTable` | Dark-themed compact tables for campaigns/agents/follow-ups |
| Intelligence tab | all of the above | Full intelligence synthesis: top campaigns, needing attention, agent leaderboard, coaching ops |

**Layout shell:** `crm.reportsWorkspace` (forces dark tokens) + `crm.pageInnerReports` (`max-w-[min(100%,1680px)]`). Hero row uses `crm.reportsHeroGrid` (2×2 on mobile, 4×1 on `lg+`). Main content uses `crm.reportsGrid` (1 col on mobile, 3 cols on `lg+` — 2 main + 1 sidebar).

**Tabs:** Five command tabs replacing the old tiny button tabs — Operations (was Daily Summary), Campaigns, Agents, Follow-ups, Intelligence (new). URL `?tab=daily` mapped to `operations` for backwards compat.

**Operational language:** Hero cards carry `statusMessage` with phrasing like "Queue volume healthy", "Callback SLA risk — action needed", "Active session underway". The insight feed derives operational alerts purely from existing API data — no fake metrics.

**Dark surfaces (19K):** Wrap with `crm.reportsWorkspace`. Tables use `bg-crm-surface-2/60` headers, `divide-crm-border/50` rows, `hover:bg-crm-surface-2/40`. Filters use `crm.filterPill` / `crm.filterPillActive`. Hero glow uses inline shadow utilities matching tone (success/warning/danger). **No** `bg-white`, `bg-gray-50`, `bg-red-50`, `divide-gray-100`, `border-gray-200`.

**Data:** Same four endpoints — `/crm/reports/daily`, `/crm/reports/campaigns`, `/crm/reports/agents`, `/crm/reports/follow-ups`. Intelligence tab loads all four in parallel. No new backend routes or schema changes.

**Export:** Client-side CSV for campaigns, agents, and operations tabs. No new API.

---

## Do / Don't

| Do | Don't |
|----|-------|
| Use `CRMPageShell` + `CRMCard` on new CRM pages | `bg-white`, `bg-gray-50`, light modals on dark shell |
| Use `text-crm-muted` for secondary text | Random `text-gray-500` |
| Keep spacing `gap-4`, radius `rounded-crm-lg` | Mixed `rounded-2xl` / `rounded-xl` / inline radii |
| Reuse Workspace density (compact stacks) | Giant tables as primary layout |
| Use `crm.wallboardWorkspace` on wallboard pages | `bg-gray-50` / `bg-white` on wallboard panels |
| Use `crm.reportsWorkspace` on reports pages | Light `min-h-screen bg-gray-50` wrapper on reports |

---

## Verification

```bash
pnpm exec tsc -p apps/portal --noEmit
# Grep CRM routes for light-mode regressions:
# bg-white | bg-gray-50 | text-gray- on dashboard/queue/campaigns/contacts/wallboard
```
