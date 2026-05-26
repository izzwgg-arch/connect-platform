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

## Verification

- For CRM portal UI changes, run portal typecheck and portal build.
- Confirm mobile responsiveness by keeping grids stacked on small screens and avoiding fixed desktop-only widths.
