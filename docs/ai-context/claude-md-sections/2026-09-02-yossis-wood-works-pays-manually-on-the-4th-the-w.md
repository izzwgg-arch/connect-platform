# ⛔ AGENT HANDOFF — Yossis Wood Works pays MANUALLY, on the 4th, the worker invoices+emails manual-pay tenants automatically, and a worker invoice's DUE DATE IS ITS PAYMENT DATE now (2026-09-02) — READ FIRST before enabling autopay for Yossis, before touching `manualInvoiceAutomation.ts`, or for "an autopay-off tenant never gets an invoice"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(`53fb9c52` + `fc934849` on `feat/ivr-migration-takeover` — worker + one
additive api export. Deploy state at the end of this section. Data changes,
all backed up to `/root/yossis-day4-backup-20260902-*.json`: Yossis
`billingDayOfMonth` 5→4 (Izzy: "Payment date shouldn't be changed. Stay on
the 4th" — the DB had said 5 since May), the Sept invoice CC-202609-00002
trimmed to the transition period **Sep 5 → Oct 4** (invoice row AND all 5
line items, money untouched — the earlier-move skip-a-cycle fix), and
`metadata.billingManualInvoiceAutomation: true` set on Yossis' settings row.)
Memory: [[yossis-bills-manually-autopay-off-on-purpose]].

- ⛔⛔ **THE GAP THIS CLOSES: the autopay sweep selects ONLY
  `autoBillingEnabled: true`, so an autopay-off tenant got NO invoice and NO
  email, EVER** — Yossis' August had to be invoiced by hand, and September
  simply never appeared. Izzy's rules (2026-09-02): autopay stays OFF for
  Yossis ("they usually do it themselves"), the invoice email goes at T-3,
  every month, automatically.
- ✅ **`apps/worker/src/manualInvoiceAutomation.ts`** (hourly + boot run,
  wired in main.ts beside the autopay sweep): T-3 creates the period invoice —
  the finalize hook emails the pay link. ⛔ **OPT-IN PER TENANT**
  (`TenantBillingSettings.metadata.billingManualInvoiceAutomation: true`; only
  Yossis holds it) — a blanket autopay-off sweep would start emailing a dozen
  companies nobody decided to bill this way. ⛔ **It can NEVER charge**
  (source-guarded: no chargeBillingInvoice/paymentMethod reference survives).
- ⛔⛔ **THE PAYMENT-DAY RESEND WAS ASKED FOR AND WITHDRAWN THE SAME HOUR**
  (Izzy: "don't resend the email to Yossi's Woodworks") — the phase is built
  and **DORMANT**: it needs a SECOND flag,
  `metadata.billingManualInvoicePaymentDayResend: true`, which **no tenant
  carries**. Do not "complete" the feature by setting it. Its lookup, if ever
  armed, is `periodEnd >= scheduledChargeAt`, NEVER `autopayPeriodInvoiceWhere`
  — a transition month after a billing-day move starts AFTER the payment
  instant, so containment finds last month's PAID invoice (where-shape test
  pins it). Its dedupe (`queueInvoicePaymentDayResendOnce`,
  `billingEmailLifecycle.ts`) is on EmailJob `createdAt >=` the payment
  instant, never a best-effort log row.
- ⛔⛔ **A WORKER-CREATED INVOICE'S `dueDate` IS `schedule.scheduledChargeAt`
  NOW** (Izzy: "The due date is always the day of payment. The day the card is
  supposed to be charged, that's the due date. That's what it should say in
  the email."). `createBillingInvoice`'s `now + paymentTermsDays` default made
  every automated invoice email say a date ~12 days after the money moves.
  Covers autopay T-3 + monthly + manual T-3 (all ride
  `createWorkerBillingInvoice`); admin/hand-created invoices keep their own
  dueDate. ⛔ Checked before shipping: NOTHING enforces on a passed dueDate —
  `OVERDUE` is only ever a read filter, enforcement keys on failed charges —
  so this is display-truth, not a behavior change. Source-guard-pinned.
- ✅ Proven: 15 worker tests on the real schedule math + 4 source guards; api
  billing suites 47/47; typechecks add 0 (worker's 8 and api's 81 pre-exist at
  HEAD). ✅✅ **SEPTEMBER SETTLED THE SAME DAY, proving the reminder works:**
  invoice created + emailed 15:12Z (hand-run of the same engine), **PAID
  $206.96 at 15:33Z — 21 minutes after the email** — receipt SENT. ⛔ That
  invoice keeps its old Sep 17 dueDate on purpose (PAID; the record stays what
  the customer saw).
- ⏳ **NOT PROVEN: the first fully-automated cycle is Oct 1** (T-3 for the
  Oct 4 payment day) — the invoice should appear with dueDate **Oct 4** and
  the email land at billing@yossiswoodworx.com with no human involved. Watch
  `BillingEventLog` types `manual_invoice_created` /
  `manual_invoice_automation_failed`.
