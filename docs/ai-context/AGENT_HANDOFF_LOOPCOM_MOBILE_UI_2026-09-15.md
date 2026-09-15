# ⛔ AGENT HANDOFF — LOOPCOM MOBILE UI: mockups (2026-09-15) → ✅ APPROVED AND BUILT (2026-09-16, commit `5232cba2`). §0–§6 below are the mockup phase kept for the record; **§7 is the production build** — read §7 first when touching the live product area.

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

### 1b. v2 revision (2026-09-15, after Izzy's first feedback)

Izzy: make it "a lot more user-friendly, SaaS 2026, professional-looking", a polished
dashboard, and "an admin page for all the settings and controls", staying on the Loopcom
theme. v2 = an append-only **polish CSS layer** at the end of the `<style>` block (do not
scatter edits through the base rules — override there) + three structural changes:
the customer dashboard's pagehead replaced by a **hero** (greeting, cycle progress bar
with today-marker, action rail, autopay note) and iconized KPI tiles (`.kico`, `.delta`);
`a-settings` rebuilt as **"Settings & Controls"** (master `.gatecards` strip with locked
gates stating why, + Access & visibility, Notifications, Data & sync, Maintenance).
Inter is loaded from fonts.googleapis (allowed host). `<meta charset>` sits at byte 0 for
file/localhost opens; the artifact skeleton supplies its own. Both themes verified in
real Chrome. Published as artifact **Version 2**, same URL.

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

## 7. THE PRODUCTION BUILD (2026-09-16, `5232cba2`) — what exists now and its traps

Izzy approved v2 with: "Approved. Build it. Everything should be wired and working,
end-to-end, production-ready, with proof." Mid-build he added: "Create all the emails
as well… with the real Loopcom logo… wire the emails in to work end-to-end."

### 7.1 What shipped (all in `5232cba2` unless noted)

**Schema** (`20260916030000_loopcom_mobile_product`, purely additive):
`MobileSubscriber` (people ≠ portal users; `role` member|manager, `notifyEmail`),
`MobileTenantSettings` (warn %, billingEmails, notify switches, member switches),
`MobilePlatformSettings` (single row id "default": SPN, balance floor, anomaly ×,
reorder floor, nudge days, selfServeLines/topUps gates, LM- prefix, fraud caps),
`MobileInvoice` (⛔ `@@unique(tenantId, periodStart)` IS the idempotency — a
generation run can never double-bill), plus MobileLine.{subscriberId, e911Status,
e911Address, usageAlertSentAt}.

**API** — `mobileProductRoutes.ts` beside the untouched foundation file:
- Tenant: /mobile-service/{dashboard, subscribers CRUD+assign, lines (rich list w/
  per-line recount estimate + memberActions), lines/:id/activity, lines/:id/e911,
  lines/:id/change-plan, usage (daily rollup + projections + 6 past cycles),
  billing (+invoices/:id — the LM- ledger), port-requests/:id GET/PATCH (⛔ the
  transfer PIN is stored ENCRYPTED via @connect/security, `accountNumberLast4`
  only, `pinOnFile` boolean out — the raw PIN never echoes), devices
  (+/devices/:lineId/esim — same audited secret read, devices-page key),
  support/diagnostics/:lineId (customer-safe, no raw provider payloads), settings.
- Console: /admin/mobile-service/{overview (fleet+money+balance+action items),
  tenants (rollup), platform-settings GET/PUT, inventory, port-requests GET/PATCH
  (status mirror + notes → customer email; ⛔ FILES NOTHING with the carrier),
  invoices/generate (⛔ PREVIOUS month only, confirm:true, idempotent, emails per
  tenant setting), invoices GET/PATCH(status), usage-analytics, webhook-events/:id
  (payload), compliance, audit}.
- ⛔ ONE KEY PER PAGE ON THE API TOO: PORTAL_API_PERMISSION_RULES got nine
  longer-prefix rules (/mobile-service/lines → can_view_mobile_lines etc.,
  longest-prefix-wins); the base /mobile-service rule stays the dashboard's
  can_view_workspace_mobile. Guard-tested in loopcomMobile.test.ts.

**Emails** — `mobileEmails.ts`: 7 templates through the HARDENED billing shell
(`emailShell` from billing/emailTemplates — real wordmark URL, eyebrow "LoopCom
Mobile", footer "Sent by LoopCom Mobile."), queued as EmailJob rows type
`MOBILE_*` on the ONE outbound lane (500/day cap applies; these are customer
transactional, not ADMIN_ALERT — they flow). Triggers wired: esim_ready (in
provisionEsimForLine), line_suspended/lost + line_resumed (in suspendLine/
resumeLine — BOTH surfaces share them), plan_changed (both change-plan routes),
port_status (admin PATCH when status changes, honors notifyPorts), invoice
(generation, honors notifyInvoices), usage_warning
(`runMobileUsageWarningSweep` inside the usage-sync cycle — ⛔ once per cycle per
line via `usageAlertSentAt >= cycleStart`, stamped even with zero recipients so
it can't spin). Recipient ladder in `resolveMobileRecipients`: subscriber email
(if notifyEmail) → MobileTenantSettings.billingEmails →
tenant.billingSettings.billingEmail → billing-capable users. ⛔ The eSIM
activation code is NEVER in any email — guard-tested.

**Portal customer area** — section "mobile" ("LoopCom Mobile") in
NAV_SECTION_ORDER after workspace; ten pages under `app/(platform)/mobile/`
(+ lines/[id], billing/[id] details) on shared `mobile.css` (.lmx scope — the v2
mockup design system verbatim: hero, kico KPIs, gradient primaries) + MobileUi.tsx
helpers. Devices page POLLS while the install QR is open and flips the line
active live. All ConnectSelect, no native <select> (guard-swept).

**Console** — /admin/mobile-console rebuilt: 13 views in one client page (chip
strip), .lmx styles, `role === "SUPER_ADMIN"` gate kept, provision-eSIM keeps the
verbatim "PURCHASES 1 eSIM … cannot be un-bought" confirm (guard-tested), invoice
generation confirm states ledger + idempotency.

### 7.2 Keys & toggles (the fourth rule — satisfied in the same commit)

New: `can_view_section_mobile` + can_view_mobile_{users,lines,plans,usage,billing,
porting,devices,support,settings}. ⛔ Dashboard KEEPS `can_view_workspace_mobile`
(renaming strips grants — id moved workspace.mobile → mobile.dashboard). ⛔ ALL
mobile keys in NO default bucket (SUPER_ADMIN force-add only): granting is the
launch, per tenant, per role. Both permission editors render from navItems, so
all rows + the LoopCom Mobile section appeared automatically —
permissionToggleCoverage 40/40 incl. the honesty invariant and
one-toggle-per-page. Launch recipe: grant `can_view_section_mobile` + the page
keys to a role on /admin/roles/[id] (or per-page In-sidebar on /admin/permissions).

### 7.3 Proof (what is PROVEN vs ⏳)

- Tests: api loopcomMobile 19/19 (money math, ONE-request purchase, real Ed25519,
  ~15 source guards incl. product-route owner-gating count, no-money-in-product-
  routes, no-carrier-filing, email-lane, PIN-never-echoed, nav/catalog/bucket/
  prefix contract). Portal nav+coverage+select suites 40/40. Portal full suite
  638/642 — ⛔ the 4 failures are PRE-EXISTING AT HEAD in other areas
  (deskPhone setupDriver reboot guard, coworkerHands copy, CRM campaignsIndex
  layout, webrtcSdpDiagnostics codec) — none reads a file this build touched.
  Api full suite: publicOrigins tree-sweep fails on server.ts
  "m.connectcomunications.com" L42556 — introduced `2ade3422` 2026-08-21,
  pre-existing. tsc: api exactly the 87 pre-existing ambient (0 in
  loopcomMobile/*), portal 0.
- Mockup artifact v3 (same URL) gained the "Emails" screen: all 7 emails rendered
  FROM THE PRODUCTION TEMPLATES (logo embedded as data URI only for artifact CSP;
  real emails use the absolute wordmark URL).
- Deploy + container verification: recorded in the summary file (this handoff is
  written mid-deploy; the summary carries the final verified state).
- ⏳ NOT PROVEN until real objects exist: no subscriber/line/eSIM/port/invoice has
  been created through the new UI against production data; no MOBILE_* email has
  reached a real inbox (the queue rows + templates are tested, the worker lane is
  the platform's existing one); Voice/SMS remain carrier-gated as designed.

### 7.4 Traps for the next session

- ⛔ /mobile-service/lines/:id/esim (old key) AND /mobile-service/devices/:lineId/
  esim (devices key) BOTH exist — the devices page uses the second; don't
  "deduplicate" one away without moving the page.
- ⛔ `memberMay()` gates USER-jwt actions from MobileTenantSettings; TENANT_ADMIN+
  always passes. The switches live on the customer Settings page.
- ⛔ Invoice generation refuses nothing loudly when a tenant+period row exists —
  it SKIPS with reason "already_generated". That is the idempotency working.
- ⛔ The 4 pre-existing portal failures + the publicOrigins sweep failure belong
  to OTHER areas' sessions — do not "fix" them from mobile work.
- The old thin customer page is GONE (replaced by the dashboard at /mobile); the
  eSIM QR now lives on /mobile/devices.
