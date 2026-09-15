# LoopCom Mobile: the APPROVED FULL PRODUCT AREA IS BUILT AND WIRED — own sidebar section, ten customer pages, 13-view console, LM- invoice ledger, eight transactional emails — 2026-09-16

Full handoff: **`docs/ai-context/AGENT_HANDOFF_LOOPCOM_MOBILE_UI_2026-09-15.md` §7**
(the build; §0–6 are the mockup phase). Backend foundation handoff:
`AGENT_HANDOFF_LOOPCOM_MOBILE_2026-09-15.md`.

- **Izzy approved the v2 mockups verbatim** ("Approved. Build it. Everything should be
  wired and working, end-to-end, production-ready, with proof.") and mid-build added the
  emails ("real Loopcom logo… wire the emails in to work end-to-end"). Commit
  **`5232cba2`** (30 files, +6,112) on `feat/ivr-migration-takeover`, pushed.
- **Customer side = its OWN sidebar section "LoopCom Mobile"** (after Workspace): ten
  pages under `/mobile/*` — Dashboard (hero + KPIs + attention queue + line cards +
  next-invoice recount), Users (subscribers ≠ portal users), Lines (+detail with
  provisioning stepper, E911 modal, member-gated actions), Plans, Usage (projections,
  per-line risk, past cycles), **Mobile Billing on its own LM- ledger** (+invoice
  document), Porting (wizard + tracker; encrypted transfer PIN), Devices & SIMs (eSIM
  QR that polls and flips the line active live), Support (diagnostics), Settings.
  ⛔ One key per page + `can_view_section_mobile`, ALL in NO default bucket, NO force
  lines; the Dashboard KEEPS `can_view_workspace_mobile` (rename = stripped grants);
  **granting the keys IS the launch**. Both permission editors picked the rows up from
  navItems automatically (the fourth rule; coverage suite 40/40).
- **Owner side = /admin/mobile-console rebuilt to the 13 approved views** (Overview w/
  live Telnyx balance + margin, Subscribers, Lines w/ the cannot-be-un-bought eSIM
  confirm, Plans w/ margin editor, Inventory, Porting status-mirror (⛔ files NOTHING
  with the carrier), Usage Analytics, **Invoicing: LM- generation — previous month
  only, confirm-gated, idempotent by `@@unique(tenantId, periodStart)`, never touches
  the Voice invoiceEngine**, Carrier Status, Diagnostics, Webhooks payload viewer,
  Compliance, Settings & Controls persisted in MobilePlatformSettings).
- **Emails wired end-to-end on the platform's ONE outbound lane** (EmailJob rows,
  hardened billing shell, real wordmark, eyebrow "LoopCom Mobile"): WELCOME (fires
  ONCE per tenant at their first line — the once-guard is the send's own
  `mobile.email.welcome` audit row), eSIM ready, usage
  warning (once/cycle via `usageAlertSentAt`), paused/lost/resumed, plan changed, port
  status, LM- invoice. Recipient ladder subscriber → mobile billing contacts → tenant
  billing email → billing users. ⛔ The eSIM activation code is NEVER emailed
  (guard-tested). Mockup artifact v4 (same URL JGi8xGn5FnAVPPPJKvdvmt) shows all
  eight rendered FROM the production templates.
- **Schema**: additive migration `20260916030000_loopcom_mobile_product`
  (MobileSubscriber, MobileTenantSettings, MobilePlatformSettings, MobileInvoice +
  four MobileLine columns). API: `mobileProductRoutes.ts` (~35 routes, tenant from
  JWT only, requireOwner on every console route) + nine per-page prefix rules in
  PORTAL_API_PERMISSION_RULES so the API agrees with the sidebar.
- **Proof**: api mobile suite 19/19 (money math, ONE-request purchase, real Ed25519,
  source guards incl. no-money/no-carrier-filing/email-lane/PIN-never-echoed +
  nav/bucket/prefix contract); portal nav+coverage 40/40; portal full 638/642 and the
  api publicOrigins sweep failure are ⛔ PRE-EXISTING AT HEAD in other areas
  (deskPhone driver, coworkerHands, CRM campaigns, webrtc codec; server.ts hostname
  literal from `2ade3422` 2026-08-21) — none reads a file this build touched. tsc:
  api = exactly the 87 pre-existing ambient (0 in loopcomMobile/*), portal 0.
- **DEPLOYED 2026-09-16**: api + portal via deploy-direct on loopcom (migration ran
  with the api deploy). Container verification recorded below in this file's deploy
  addendum — if the addendum is missing, the deploy verification never finished:
  check `docker inspect app-api-1/app-portal-1` labels before trusting it.
- ⏳ **NOT PROVEN**: no real subscriber/line/eSIM/port/invoice has been created through
  the new UI (fleet is still 0 lines); no MOBILE_* email seen in a real inbox; the
  Owner launch (granting the section keys to a first tenant role) has not happened;
  Voice/SMS stay carrier-gated by design.

## Deploy addendum — VERIFIED 2026-09-16 (session of 09-15 ET)

- api deploy `direct-api-20260915T191405Z`: **migration
  `20260916030000_loopcom_mobile_product` APPLIED to the live DB** ("All
  migrations have been successfully applied", migrate=5.3 s), done at tip
  `6e3cc2b5` (contains `5232cba2`). `app-api-1` label revision = `6e3cc2b5`,
  healthy. (An earlier 18:41Z api deploy in the same window was ANOTHER
  session's `74e7730a` — the Gesheft period-guard fix; both landed cleanly.)
- portal deploy done `6e3cc2b5`; `app-portal-1` revision `6e3cc2b5`,
  **0 restarts**, running. Shipped `.next/server` carries ALL ten
  `(platform)/mobile/*` page dirs; client chunks carry "PURCHASES 1 eSIM"
  (console) and the porting page copy — the built bundles, not just source.
- Live probes: `/mobile`, `/mobile/lines`, `/mobile/billing`,
  `/admin/mobile-console` = **200 on BOTH hostnames**;
  `/api/mobile-service/{dashboard,lines,settings}` and
  `/api/admin/mobile-service/{overview,platform-settings}` = **401**
  (exist + gated; a 404 would have meant unrouted); legacy
  `/mobile-service/{overview,plans}` still 401 (no regression);
  unsigned POST `/api/webhooks/telnyx/mobile` = **401 (fail-closed)**;
  `/healthz` 200.

## Welcome email addendum — DEPLOYED + VERIFIED (`69ba6ae4`)

- Eighth email, "Welcome to LoopCom Mobile": fires from the console's
  create-line handler ONLY when it is the tenant's first line AND no
  `mobile.email.welcome` audit row exists (the send's own audit is the
  once-guard; a recipient-less first line audits `welcome_skipped`).
- api deploy done `69ba6ae4`; `app-api-1` revision `69ba6ae4`, healthy,
  0 restarts. ⛔ The api container runs from `/app/apps/api/src` (tsx) —
  there is NO `dist/`, so grep `src/`, not `dist/`, when verifying a deploy.
  Container grep: `export function welcomeEmail` = 1 in mobileEmails.ts, the
  `lineCount === 1 && !alreadyWelcomed` guard = 1 in mobileRoutes.ts.
- Suite 20/20; api tsc still the 87 baseline. Portal untouched (no redeploy
  needed). Artifact v4 shows it rendered from the production template.
- ⏳ Not proven: no tenant has had a first line created since, so no welcome
  has reached a real inbox.

## Next round — MOCKUPS ONLY, awaiting Izzy (2026-09-16)

Custom plans (builder + private per-customer plans), buying eSIMs / ordering
SIM cards, and a one-page Create-a-line flow (console + customer self-serve /
request variants): `docs/mockups/loopcom-mobile/plans-and-lines.html`,
artifact https://claude.ai/artifact/EpAZXqGsGaQVPnhfk5XvXC. ⛔ Nothing built.
New back-end work it needs (incl. a Telnyx address client for SIM orders) is
listed in the UI handoff §8.

## Gap pass — 2026-09-15 evening (mockups only, awaiting Izzy)

Izzy re-sent the original brief. He chose a live review plus a gap list plus mockups for the gaps only. Live, every page is an empty state (0 lines), and the owner side is one chip-tab page. ⚠️ Telnyx balance is $26.32, under the $50 floor. Verified defects:
- 9 console settings are saved but never enforced.
- The invoice uses a CSS "L" placeholder and `window.print()`, with no pay button.
- Line service pills are hard-coded.
- "Add a line" goes to Users.
- The assign-line API has no UI.

Mockups: `docs/mockups/loopcom-mobile/gap-pass.html` (https://claude.ai/artifact/1i8SFgTZ98WXdLe4NXrf9n). Details in UI handoff §9. ⛔ Nothing built.
