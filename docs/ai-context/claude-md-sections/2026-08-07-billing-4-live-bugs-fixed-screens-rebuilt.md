# ⛔ AGENT HANDOFF — billing: 4 live bugs fixed, screens rebuilt (2026-08-07) — READ FIRST for ANY billing work, `{ not: … }` Prisma filters, or a new screen under /admin/billing

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_BILLING_REBUILD_2026-08-07.md`**
(`e20776c6` → `a75344b9` on `feat/ivr-migration-takeover`, api + worker + portal
all DEPLOYED and container-verified).

- **`billingDayOfMonth = 1` could NEVER generate an invoice** — and it is the
  Prisma DEFAULT, which onboarding never changes, so **16 of 30 live tenants sat
  on it**. Invoices are only created inside `reminderDue`, and the payment date
  is clamped into the CURRENT month, so for day 1 the window is permanently in
  the past: **0 of 365 days**, proven by simulating a full year. On the due date
  the worker logged `CRITICAL: manual intervention required` and never created
  the invoice it had just proved was missing. Fixed via
  `buildUpcomingBillingSchedule()`. ⛔ It survived years of "it's fixed" because
  **all 11 scheduler tests used day 21 — the one broken value was the one never
  tested.**
- **A charge is now an event on a date, not a condition true all month.** `due`
  was `today.day >= paymentDay`, i.e. true for the rest of the month and
  re-evaluated hourly *and on every worker restart* — which is why autopay felt
  like it "charges every minute" and why **14 guard clauses** were the only
  thing preventing a double charge. ⛔ A missed date is **never charged late**;
  it is surfaced (`chargeWindowMissed`) with the invoice left open.
- ⛔ **`field: { not: "X" }` in Prisma DROPS every NULL row.** Self-inflicted and
  caught before damage: `source: { not: "MANUAL" }` matched **0 of 53 invoices**
  across all 30 tenants (auto invoices have `source = NULL`; `NULL <> 'MANUAL'`
  is NULL, not true) and would have blocked **every** autopay charge. Use
  `AND[ OR[ field: null, field: { not: X } ], … ]`. **A unit test cannot see
  this — after deploying, run the real query and assert the row count.**
- ⛔ **billingEmail was erased by every save, at TWO sites** — a zod transform
  ending `: v ?? null` turns an ABSENT field into null, which survives the
  undefined-filter. The second site was found only by grepping the RUNNING
  container for the OLD pattern and getting `2`, not `0`. 18 of 30 tenants had
  no billing email; 5 were recovered from `EmailJob` history. ⛔ Backups reach
  only 15 days and there is **no audit log for billing settings at all**.
- ⛔ **New screen under `/admin/billing`? Add its path to `REBUILT` in
  `layout.tsx`.** That layout wraps every route in `AdminBillingShell` (its own
  toolbar, nine-tab nav, ten old stylesheets). Seven rebuilt pages shipped
  underneath the old chrome and **looked nothing like the approved design** —
  the single biggest waste of that engagement.
- ⛔ **Deploy traps:** `deploy-direct.sh --branch` hard-resets to **origin**, so
  a commit only in the server clone is silently rolled back and "deployed" as a
  no-op — push to GitHub first. `deploy-worker.sh` self-skips `no_changes` right
  after an api deploy, leaving the OLD container running while reporting done —
  use `DEPLOY_FORCE_RESTART=1` and grep the running container.
- ⏳ **The rebuilt screens have NEVER been opened in a browser** (auth gate makes
  curl useless — it only ever returns the login shell). Open them before
  trusting them. **The engine work — a schedule row per customer per month, and
  a priority lane for billing email — was never started.**
