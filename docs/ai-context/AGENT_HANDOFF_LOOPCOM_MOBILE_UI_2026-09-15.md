# ⛔ AGENT HANDOFF — LOOPCOM MOBILE UI: the full-product MOCKUP PASS (2026-09-15) — READ FIRST before building any LoopCom Mobile portal UI. The mockups are AWAITING IZZY'S APPROVAL; production build starts ONLY after he approves.

Sibling handoff (backend, read it too): `AGENT_HANDOFF_LOOPCOM_MOBILE_2026-09-15.md`.

## 0. The instruction and the gate

Izzy reviewed the shipped `/mobile` page and `/admin/mobile-console` and rejected them as
"too sparse, looks like a placeholder." He ordered a **full, complete, separate mobile
product area inside the existing platform** — same auth/tenants/permissions/support/
billing-engine/admin shell, separate everything mobile (sidebar section, dashboard,
subscribers, lines, plans, usage, billing+invoicing, porting, devices/SIMs, support,
settings, owner console). His hard process rule, verbatim in the brief:

> DO NOT BUILD THE FINAL UI FIRST. … create FULL MOCKUPS … show me those mockups clearly
> … wait for approval / revision feedback. ONLY AFTER THE MOCKUPS ARE COMPLETE AND
> APPROVED: build the real production UI.

⛔ So: if you are a later session and approval has not been recorded (check the summary
file / a newer handoff / ask Izzy), the next step is REVISIONS TO THE MOCKUP, never code.

## 1. The deliverable

**`docs/mockups/loopcom-mobile/index.html`** — one self-contained file, 30 screens,
published as artifact **https://claude.ai/artifact/JGi8xGn5FnAVPPPJKvdvmt**.

Mechanics: a mock chrome bar (persona Customer/Owner, theme Dark/Light, width
Desktop/Laptop/Tablet, Start-here + States buttons); the sidebar IS the proposed
navigation and switches screens; each screen ends in a collapsible "Design notes" with
wiring tags. All data is sample data; the eSIM QR is a drawn, watermarked fake. Tokens
were copied from `apps/portal/app/globals.css` — dark root (#0c1218/#141f2b/#26374a/
#22a8ff…), light stamp block, console sidebar tokens (#0b1016/#131b26/#2ba5ff), the
drawer-nav-link geometry (34px icon well, 3px accent left border), billing-card 1.25rem
radius, uppercase 10.5px table headers, pill/state-box/KPI patterns. To update it: edit
the file, republish the artifact from a session in this repo (same path), commit.

## 2. Screen inventory (30)

Customer (sidebar section "LoopCom Mobile", routes `/mobile/*`):
`c-dash` Dashboard · `c-users` Users · `c-user-detail` · `c-user-new` (modal) ·
`c-lines` Lines · `c-line-detail` (tabs incl. provisioning stepper) · `c-plans` (+
change-plan modal w/ proration choice) · `c-usage` · `c-billing` · `c-invoice` (LM-
invoice document) · `c-porting` (wizard + tracker w/ rejection state) · `c-devices` (+
replace-eSIM confirm) · `c-esim` (QR install flow) · `c-support` (diagnostics +
guided fixes) · `c-settings` (notifications, billing contacts, member permissions,
E911 table, restrictions).

Owner (Admin → Mobile Console, ONE sidebar item, 13 internal views):
`a-overview` (fleet KPIs, revenue/cost/margin, action queue, capability table) ·
`a-subscribers` · `a-lines` (fleet + needsReconcile filter) · `a-plans` (retail/
wholesale/margin + editor) · `a-inventory` (SIM stock, stale eSIMs) · `a-porting`
(queue + detail + resubmit) · `a-usage` (analytics + anomalies) · `a-invoicing`
(recount preview, exceptions, cost-vs-bill, Generate DISABLED with honesty banner) ·
`a-carrier` (Telnyx health, capability gates, webhook door) · `a-diag` (our-record vs
carrier-record + recovery tools) · `a-webhooks` (event ledger, dead letters) ·
`a-compliance` (E911 gaps, 10DLC checklist, audit slice, fraud) · `a-settings`
(defaults, thresholds, fraud controls, feature gates).

Shared: `s-start` (IA + wiring legend) · `s-states` (6 empty/loading + 8 failure/gated
states: provisioning failed ×2, webhook misconfigured, carrier down, feature off,
Voice beta, SMS off, E911 missing).

## 3. IA decisions to confirm with Izzy at approval

1. **Customer nav = a NEW sidebar section** `mobile` ("LoopCom Mobile"), not more
   Workspace items: new `PortalSidebarSectionKey`, `can_view_section_mobile`, one key
   per page (~11 new keys) in SIDEBAR_SECTIONS/SIDEBAR_ITEMS + navConfig + both
   permission editors (the fourth rule; permissionToggleCoverage enforces). The
   existing `workspace.mobile` item/key would migrate into the section (decide: keep
   the key name to avoid stripping existing grants, or rename with a migration).
2. **Owner console stays ONE Admin sidebar item** (`admin.mobile_console`,
   SUPER_ADMIN-forced, Locked chip) with internal sub-navigation — the PBX-Console
   pattern; 13 forced rows in the matrix would be noise.
3. **Routes**: portal pages `/mobile`, `/mobile/users|lines|plans|usage|billing|
   porting|devices|support|settings`; console stays `/admin/mobile-console` (views by
   query/tab). ⛔ API prefixes remain `/mobile-service` + `/admin/mobile-service`.
4. **Mobile invoices are their own series `LM-`**, own list/detail/PDF, rendered in the
   Voice invoice's visual frame with a "LoopCom Mobile" submark. Autopay reuses the
   stored Sola card; no second payment stack.
5. **Customer money actions** (change plan w/ proration, 1 GB top-up, self-serve line
   create) are drawn but each is feature-gated in a-settings; default OFF pending
   Izzy's call.
6. **Port filing stays console-only**; the customer "Start transfer" creates the draft.
7. Carrier honesty everywhere: Voice=beta chip, SMS locked until 10DLC, E911 gaps
   surfaced on customer settings AND owner compliance, provision-eSIM keeps the
   cannot-be-un-bought confirm, purchase timeout = "unknown — reconcile, never re-click".

## 4. Backend the screens need (build order after approval)

Backend exists, UI new: fleet search+actions, capability probe, webhook ledger,
diagnostics read, reconcile/orphan import, plan CRUD+margin, recount preview,
suspend/resume/lost/replace-eSIM, activation QR, SIM order/preview/register client.

Needs NEW backend: **MobileSubscriber** model (people ≠ lines ≠ portal users);
daily usage series + voice/SMS rollups + projections; **MobileInvoice** persistence
(LM- numbering, PDF, payments/credits) — ⛔ the invoiceEngine wiring itself stays its
own traced change per the money-path rule; port submission to carrier + LOA + status
folding + docs-request; settings persistence (thresholds, contacts, member-permission
flags, feature gates); per-tenant rollups (MRR/cost/margin) + balance watch + floor
alert; anomaly dismiss workflow; E911 per-line address flow + coverage rollup; nudge
actions (stale eSIM, E911); event-interleave view; re-fold action; exports.

Carrier-gated (ship as the drawn disabled states): Mobile Voice (beta), SMS (10DLC),
premium-SMS toggle, roaming controls where plan-driven.

## 5. Traps

- ⛔ The gate in §0: mockup revisions, not code, until approval is recorded.
- ⛔ `/mobile/*` and `/admin/mobile/*` API prefixes belong to the PHONE APP.
- ⛔ When production build starts: new nav section touches BOTH permission screens +
  shared catalog + navConfig in the same commit (fourth rule), and
  `permissionToggleCoverage.test.ts` + `loopcomMobileNav.test.ts` must be extended.
- ⛔ The mockup file is committed in-repo; if you regenerate it, keep the artifact URL
  by republishing the SAME path (or pass the url), or Izzy's link dies.
- The mockup opened from disk needs its own `[hidden]{display:none!important}` (it's
  in the file) — the artifact skeleton normally provides it; don't remove it.
