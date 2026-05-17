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

## Queue operational workspace (Phase 19C)

`/crm/queue` is a **full-width outbound workbench**, not a narrow centered list.

| Zone | Width (xl+) | Role |
|------|-------------|------|
| Feed | 7 / 12 | Live queue rows, featured next lead, power session card |
| Overview | 3 / 12 | Queue pressure bars, callback due/overdue, today stats from `/crm/tasks/stats` |
| Attention | 2 / 12 | Actionable alerts (overdue callbacks, tasks, campaign focus) — links only when counts > 0 |

**Layout shell:** `crm.pageInnerQueue` (`max-w-[1440px]`). **Primitives:** `CRMPageHeader`, `CRMActionBar`, `QueueCountPill`, `QueueOperationalRow`, `QueuePowerSessionBar`, `QueueEmptyOperational`, side panels in `components/crm/queue/*`.

**Power mode:** sticky `QueuePowerSessionBar` (session badge, filter chips, progress bar, pause/end) — not toggle chips floating in empty space.

**Visual priority:** overdue / due callbacks use `crm-danger` / `crm-warning` borders on rows; “next best lead” uses accent ring.

**Empty queue:** `QueueEmptyOperational` shows today snapshot from real task stats — not AI suggestions.

---

## Campaign operational workspace (Phase 19E)

Campaign routes use **`crm.pageInnerCampaign`** (~1400px) and **`components/crm/campaign/*`**.

| Zone | Pattern |
|------|---------|
| Index | `CRMPageHeader` + summary strip + `CampaignIndexCard` (metrics from `GET /crm/reports/campaigns` + `GET /crm/campaigns`) |
| Detail header | `CampaignCommandHeader` — identity / live snapshot / operations (queue, power, import, distribute) |
| Detail body | 8+4 grid: `CampaignMemberCard` feed + sticky `CampaignOperationalSidebar` |
| Performance | `CampaignPerformancePanel` — donut, funnel bars, rings from `statusCounts` only |
| Imports | `CampaignImportEventCard` in sidebar — real `GET /crm/campaigns/:id/imports` rows |

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

## Aligned routes (Phase 19A+)

- `/crm/dashboard` (Phase 19B: command-center charts + wide layout)
- `/crm/queue` (Phase 19C: operational workbench layout)
- `/crm/campaigns`, `/crm/campaigns/[id]` (Phase 19E: operational workspace)
- `/crm/contacts`, `/crm/contacts/[id]` (Phase 19D: contact relationship workspace)
- `/crm/live-call` (Phase 19F: live agent workspace)

Reports, wallboard, tasks, scripts, checklists: migrate opportunistically; live-call is aligned in 19F.

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

## Do / Don't

| Do | Don't |
|----|-------|
| Use `CRMPageShell` + `CRMCard` on new CRM pages | `bg-white`, `bg-gray-50`, light modals on dark shell |
| Use `text-crm-muted` for secondary text | Random `text-gray-500` |
| Keep spacing `gap-4`, radius `rounded-crm-lg` | Mixed `rounded-2xl` / `rounded-xl` / inline radii |
| Reuse Workspace density (compact stacks) | Giant tables as primary layout |

---

## Verification

```bash
pnpm exec tsc -p apps/portal --noEmit
# Grep CRM routes for light-mode regressions:
# bg-white | bg-gray-50 | text-gray- on dashboard/queue/campaigns/contacts
```
