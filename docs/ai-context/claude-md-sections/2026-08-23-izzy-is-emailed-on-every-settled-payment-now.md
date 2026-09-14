# ⛔⛔ AGENT HANDOFF — Izzy is emailed on EVERY settled payment now (2026-08-23) — READ FIRST before adding ANY notification to a money or call event, before touching `paymentTransactionAlerts.ts`, or for "I got four emails for one payment" / "I got no email for that charge"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_PAYMENT_TRANSACTION_ALERTS_2026-08-23.md`**
(`4eed014c` on `feat/ivr-migration-takeover`. ✅ **api DEPLOYED and
container-verified 2026-08-23** — `app-api-1` `.build-commit` = `4eed014c`,
migration applied (7.4 s; both columns present and nullable in the live DB),
boot line `PAYMENT_TRANSACTION_ALERTS_ARMED` reading `izzy@loopcom.net` /
60 s / cutover 21:00Z, **0 restarts, 0 error-level lines**, health 200 on both
hostnames. No PBX write, no env change, no portal change, no tenant row, and no
customer-facing email was changed.)
Memory: [[payment-alerts-are-a-sweep-not-a-hook]].
Izzy, 2026-08-23: *"Every time there is a successful transaction, I should get an
email to Izzy@loopcom.net, same every time there is a declined transaction."*

- ⛔⛔ **IT IS A SWEEP OVER `PaymentTransaction`, NEVER A HOOK INSIDE A CHARGE —
  and both halves of that are load-bearing.** **Safety:** nothing in
  `apps/api/src/billing/paymentTransactionAlerts.ts` runs inside a payment, so a
  fault there cannot fail, delay or double a customer's charge; the worst case is
  a late email. A source guard fails if `solaBillingPayments.ts`,
  `payLinkRoutes.ts`, `externalPayment.ts` or `publicPayRoutes.ts` ever imports
  it. **Coverage:** money settles from **FIVE** places — autopay/admin retry
  (`chargeBillingInvoice`), the public pay page (`chargeBillingInvoiceWithSut`),
  the combined pay link, the Sola webhook reconciler, and an operator posting a
  check (`externalPayment.ts`) — and **all five converge on one row reaching a
  settled status**. Hooking each is exactly how the two IVR publish paths and the
  two invite paths shipped half-broken. **Watch the convergence point, not the
  writers** — that is the reusable rule for the next notifier of this shape.
- ⛔ **`PENDING` is the ONLY status never alerted** (nothing true to say yet).
  Every other member of `BillingPaymentTransactionStatus` is, so a new one can
  never silently vanish — a test parses the enum out of `schema.prisma` and fails
  if one is added that the file would drop. **`ERROR` is alerted on purpose:**
  Izzy named approved and declined, and a charge that *errors* is neither and
  would otherwise reach nobody (prod had 4 in 90 days). **External/manual
  payments are alerted too** (check/Zelle/cash), labelled as operator-posted —
  so the success stream is every dollar collected, not just cards. Both are
  stated choices, not omissions; narrowing either is a one-line filter.
- ⛔⛔ **PAY-LINK ALLOCATION ROWS ARE SKIPPED, and this is the trap a naive
  version gets wrong.** A combined pay link is **ONE** card charge that then
  writes a child `PaymentTransaction` **per invoice** it covered
  (`rawResponseSafeJson.allocation === true`). Alerting on those would report one
  $300 charge as four separate payments and quadruple the day's total. The parent
  is alerted and says *"3 invoices (combined payment)"*.
- ⛔ **Claim the slot BEFORE the email** (`updateMany` conditioned on the value
  read — the compliance-calendar pattern), so the second api process during a
  blue/green rollout cannot double-send. ⛔ **But RELEASE the claim if the email
  fails** — the opposite of a money operation, where a spent claim must stay
  spent: a repeated alert is harmless, a missing one is the entire failure.
- ⛔ **A cutover constant is what stops a back-catalogue burst.**
  `DEFAULT_PAYMENT_ALERT_CUTOVER_AT = 2026-08-23T21:00:00Z`; without it the first
  sweep would have mailed all **77** historical rows at once. Newest pre-cutover
  row was 04:35Z the same day, so the backlog is zero by construction.
- ⛔ **Type `PAYMENT_TRANSACTION_ALERT`, never `ADMIN_ALERT`** (muted at the send
  door — it would build clean, log clean and reach nobody), and it carries
  **neither** `connect-billing-transaction:` nor `connect-billing-invoice:` —
  those markers are parsed at the send door and would attach a receipt or invoice
  **PDF** to every alert. Both guard-tested. Times render **New York, zone named**
  (the server is in France). It rides `emailShell`, so it inherits the Outlook
  VML frame — and also the known 81 KB logo, which stays Izzy's call.
- **Sized before it was built, not after:** 60 transactions in 90 days (APPROVED
  46 / DECLINED 10 / ERROR 4), ~0.7/day, busiest day 6 — against the one
  mailbox's 500/day Google cap, which currently sends ~14/day. ✅ And
  **`izzy@loopcom.net` is PROVEN deliverable** — a `COMPLIANCE_REMINDER` reached
  it `SENT` at 2026-08-23T16:26Z, which settles the
  domain-verified-≠-mailbox-exists question for that address.
- **Switches:** `PAYMENT_TRANSACTION_ALERTS_DISABLED=1` kills it (env + restart,
  no rebuild); `PAYMENT_ALERT_EMAIL`, `PAYMENT_ALERT_CUTOVER_AT`,
  `PAYMENT_ALERT_SWEEP_INTERVAL_MS` (default 60 s) and
  `PAYMENT_ALERT_BOOT_DELAY_MS` (default 45 s) tune it. ⛔ The boot kick is
  mandatory beside the interval — a bare `setInterval` is starved to nothing on a
  busy deploy day (the voicemail watchdog's 67 silent minutes).
- ✅ **Proven:** 38 tests (registered — ⛔ `apps/api` names billing test files
  **explicitly**, `src/billing/` is not globbed, so an unregistered billing test
  never runs); the arming guard **fails all three assertions replayed against
  `HEAD`**; the new columns verified against the **REAL generated Prisma client**,
  not just the schema (the `(db as any)` transposition trap); migration generated
  by `prisma migrate diff`, two nullable columns, no table rewrite; api typecheck
  **76 = the exact baseline**, none in an edited file; billing suites 190/190;
  and both emails were **rendered and read**.
- ✅✅ **PROVEN ON REAL PRODUCTION DATA WITHOUT SENDING ANYTHING.** The real sweep
  was driven inside `app-api-1` against the real database with the claim and the
  `emailJob.create` intercepted, and an earlier cutover: over the last two weeks
  of genuine transactions it built **exactly 9 correct alerts** — 6 approved
  (Yossis $206.96, Create A Box $130, TYH $45, McNamara Lion $46.65, Luxure $75,
  Trust $155), **1 DECLINED** (Create A Box $130) and **2 errors** (the TYH
  2026-08-18 pair that preceded its successful retry) — every one addressed to
  izzy@loopcom.net, with real company names and amounts, **0 errors, nothing
  written**. ⛔ **That read-through-stub-the-writes shape is the way to prove a
  sweep on live data**; it exercises the real query, the real decision and the
  real template without a single side effect.
- ⏳ **NOT PROVEN: no alert has landed in a human inbox** — no payment has settled
  since it shipped, and the deliberate replay above wrote nothing on purpose.
  **The acceptance test is the next real payment:**
  `select "createdAt", status, "toEmail", subject from "EmailJob" where type =
  'PAYMENT_TRANSACTION_ALERT' order by "createdAt" desc limit 5;` — and the
  negatives that matter are **exactly one row per transaction** and a combined
  pay link producing **one** alert rather than one per invoice.
