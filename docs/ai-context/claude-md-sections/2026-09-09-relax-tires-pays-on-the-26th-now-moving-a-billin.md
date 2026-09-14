# ⛔ AGENT HANDOFF — Relax Tires pays on the 26th now; moving a billing day LATER needs the OPEN invoice re-dated or the customer is charged on the OLD day anyway (2026-09-09) — READ FIRST before changing ANY tenant's `billingDayOfMonth` when an OPEN invoice already exists

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(**PRODUCTION DATA ONLY — no code, no deploy, no migration, no PBX write, no money
moved, no email sent.** Backup: `loopcom:/root/relax-billing-day-backup-20260909.json`
(600) — the settings row + invoice `CC-202609-00004` + its 5 line items as they were.)
Izzy, 2026-09-09: *"change relax tires payment date to the 26th of each month."*
Memory: [[moving-a-billing-day-earlier-skips-a-cycle]] (later-move recipe appended).

- ✅ **DONE AND LIVE.** Relax Tires (`cmnlgryme000up9paz1w40fg0`) `billingDayOfMonth`
  **10 → 26** through the sanctioned `PUT /admin/billing/tenants/:id/settings` (body =
  `{billingDayOfMonth: 26}` ONLY, 60-s self-signed SUPER_ADMIN token against
  `127.0.0.1:3001` inside `app-api-1`). Read back: `billingEmail` intact, metadata
  byte-identical, shared `tax_profile_ny_orange` untouched (`updatedAt` still 08-31).
- ⛔⛔ **THE TRAP THE EARLIER-MOVE MEMORY DID NOT COVER: the move happened the day
  BEFORE the old payment date, with the T-3 invoice ALREADY CREATED.** The worker had
  made `CC-202609-00004` ($45, Sep 10 → Oct 10, due Sep 10) on Sep 7 and emailed the
  "due in 3 days" reminder. Changing the day alone stops tomorrow's charge (`due` is
  false on Sep 10 under day 26) — but the OPEN invoice still said due Sep 10 with
  `nextPaymentDate 2026-10-10` in its metadata, and on Sep 23 the T-3 lookup
  (`autopayPeriodInvoiceWhere`: exact period OR period CONTAINS `scheduledChargeAt`)
  would have found it only by containment. **Re-date the open invoice in the same
  pass:** `dueDate` → the new `scheduledChargeAt` (2026-09-26T04:00Z), `periodEnd` →
  the new period end (2026-10-26T03:59:59.999Z), metadata
  `paymentDate/nextPaymentDate/scheduledChargeAt`, AND every line item's
  `metadata.servicePeriodEnd` (the two-places rule from the earlier-move fix, in the
  other direction). Money columns untouched: still OPEN, $45, balance $45.
  ⛔ **Take the dates from the DEPLOYED `buildBillingSchedule`, never by hand** — DST
  decides whether local midnight is 04:00Z or 05:00Z.
- ⛔ **A LATER move is one LONG transition period at the same price** — Sep 10 → Oct 26
  (47 days) for $45. That is the mirror of the B Visible/Gesheft short month and costs
  the customer nothing extra; prorating the 16 days would be a money decision, not
  made. Without the extension the same 16 days are free anyway (the guard only skips
  on PAID overlap), just with a dishonest record.
- ✅ **PROVEN BY REPLAYING THE DEPLOYED CODE against the live DB** (`buildBillingSchedule`
  + `buildUpcomingBillingSchedule` + `findPaidBillingPeriodCoverage` +
  `autopayPeriodInvoiceWhere` inside `app-api-1`): **Sep 10 `due:false`** (no charge
  tomorrow); **Sep 23 `reminderDue:true` and the T-3 lookup finds CC-202609-00004**
  (no second invoice); **Sep 26 `due:true`, charge lookup returns CC-202609-00004**;
  **Oct 23 finds nothing → creates Oct 26 → Nov 26; Oct 26 `due:true`**; paid-coverage
  block `null` on every date (the Sep invoice's periodEnd is 1 ms before Oct 26's
  periodStart, by construction).
- ⚠️ **The customer was already emailed "due in 3 days" on Sep 7 naming Sep 10, and
  `queueAutopayReminderEmailOnce` de-dupes per INVOICE — so no corrected reminder goes
  out on Sep 23.** The pay link in that email still opens the same invoice (now due
  Sep 26). Sending a corrected note is a customer email and is Izzy's call — not sent.
- ⏳ **NOT PROVEN: no charge has run on the 26th.** Acceptance is **Sep 26**: an APPROVED
  `PaymentTransaction` for CC-202609-00004 and a receipt to relaxtires@gmail.com; then
  **Oct 23** an invoice for Oct 26 → Nov 26 created by the worker with no human. The
  negative that matters: **nothing charges on Sep 10** (check `BillingEventLog` for
  `billing.autopay_skipped_not_due_yet` on that tenant, no `autopay_charge_*`).
