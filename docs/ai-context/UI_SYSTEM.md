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

## Aligned routes (Phase 19A)

- `/crm/dashboard` (Phase 19B: command-center charts + wide layout)
- `/crm/queue`
- `/crm/campaigns`, `/crm/campaigns/[id]`
- `/crm/contacts`, `/crm/contacts/[id]`

Reports, wallboard, tasks, scripts, checklists, live-call: **not** part of 19A; migrate in a later phase if needed.

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
