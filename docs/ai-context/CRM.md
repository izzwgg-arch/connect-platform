# CRM Context

Scope: portal CRM UI/data-flow guardrails. Telephony, billing, workers, database schema, and onboarding are out of scope unless a task explicitly says otherwise.

## Dashboard And Email UI

- CRM dashboard modernization is UI-only. Keep existing API calls in `apps/portal/app/(platform)/crm/dashboard/page.tsx`; derive status from the values already loaded there.
- CRM Email landing uses only `/crm/email/connection`, `/crm/email/recent`, and `/crm/email/replies/recent`.
- CRM Email Settings uses only `/crm/email/connections`, `/crm/email/oauth/start`, `/crm/email/sync-now`, `/crm/email/connection/test`, `/crm/email/connections/:id`, and `/crm/email/sync-last`.
- Sender cards should feel like production infrastructure: connection state, reply tracking, sync health, last sync/activity, and compact diagnostics.
- Do not invent backend fields, fake metrics, demo activity, placeholder buttons, or inbox archive behavior.

## Visual System

- Prefer `CRMPageShell`, `CRMPageHeader`, `CRMCard`, and `crm.*` class tokens.
- Use operational classes from `crmClasses.ts` for premium CRM surfaces: `opCard`, `opCardGlow`, `opInset`, `opCardHover`, and `statusDot*`.
- Keep density practical: compact grids, sticky summary bars when useful, status dots, stat pills, and hover lift.
- Dark mode must remain first-class. Avoid `bg-white`, `bg-gray-*`, and ad hoc light-only surfaces on CRM routes.

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

## Verification

- For CRM portal UI changes, run portal typecheck and portal build.
- Confirm mobile responsiveness by keeping grids stacked on small screens and avoiding fixed desktop-only widths.
- For CRM visual redesigns, use local visual QA mode for authenticated screenshots:
  - Start: `pnpm --dir apps/portal dev:crm-visual-qa`
  - Capture: `pnpm --dir apps/portal screenshots:crm -- --routes /crm/dashboard,/crm/queue,/crm/contacts --theme light`
  - Output: `_tmp_diag/crm-visual-qa-screenshots/`
- Visual QA mode is local-development only. It is gated by `NODE_ENV=development`, `NEXT_PUBLIC_CRM_VISUAL_QA=1`, and a loopback browser host. It must not be used as evidence for backend behavior, production auth, tenant isolation, billing, telephony, or onboarding.
