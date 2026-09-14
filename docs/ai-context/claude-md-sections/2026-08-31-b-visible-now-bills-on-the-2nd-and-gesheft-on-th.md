# ⛔⛔ AGENT HANDOFF — B Visible now bills on the 2nd and Gesheft on the 3rd, and moving a billing day EARLIER silently skips a whole cycle (2026-08-31) — READ FIRST before changing ANY tenant's `billingDayOfMonth`, or for "we changed their payment date and they never got charged"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(**PRODUCTION DATA ONLY — no code, no deploy, no migration, no PBX write, and no
money moved: no charge, no refund, no email to a customer.** Fully reversible;
backups below.) Izzy, 2026-08-31: *"change 'be visible payment day' to the second
of every month, and change 'gesheft payment date' to the third of every month.
And that's when the auto pay should charge."*
Memory: [[moving-a-billing-day-earlier-skips-a-cycle]].

- ✅ **DONE AND LIVE.** **B Visible** (`cmnlgryp8001lp9pajhatv3t9`)
  `billingDayOfMonth` **5 → 2**; **Gesheft** (`cmnlgnumu0001p9g6xyl1pbdd`)
  **5 → 3**. Both `autoBillingEnabled: true` with a card on file, both
  `America/New_York`. Applied through the sanctioned
  **`PUT /admin/billing/tenants/:id/settings`** (200 each) with a 60-second
  self-signed SUPER_ADMIN token against `127.0.0.1:3001` inside `app-api-1`.
- ⛔ **There is no separate "autopay charge day" to set — `billingDayOfMonth` IS
  it.** `buildBillingSchedule` derives the charge date from that one field and
  `buildUpcomingBillingSchedule` derives the T-3 invoice-creation window from the
  same field, so one integer moves both. Do not go looking for a second setting.
- ⛔⛔ **THE TRAP, AND IT COSTS A FULL MONTH OF REVENUE SILENTLY: moving a payment
  day EARLIER lands inside the period the customer has ALREADY PAID for, and
  `findPaidBillingPeriodCoverage` then skips the entire next cycle** — no invoice,
  no charge, no alert, just a `period_already_paid` line in the results. A cycle's
  `periodEnd` is `nextChargeAt - 1ms` precisely so ADJACENT months never overlap;
  move the day back by even one day and the new period starts INSIDE the paid one
  and the overlap check fires. **Measured here with the real deployed guard: both
  paid August invoices ran Aug 5 → Sep 5, the new periods began Sep 2 / Sep 3, and
  the guard returned `paid_invoice_period_overlap` — September would have been
  FREE for both (~$140 + ~$450) with the first charge not until Oct 2 / Oct 3.**
  ⛔ Waiting and changing it after the next charge does NOT help; the overlap is
  structural on every earlier move.
- ✅ **THE FIX IS TO END THE OLD CYCLE ON THE NEW PAYMENT DAY** — one short
  transition month (28 / 29 days instead of 31), which is how a billing date
  normally moves earlier. `CC-202608-00004` (B Visible) `periodEnd` Sep 5 → **Sep
  2**, `CC-202608-00002` (Gesheft) Sep 5 → **Sep 3**.
  ⛔⛔ **TWO PLACES, NOT ONE.** `coverageReason()` checks `invoicePeriodOverlaps`
  **OR** `lineServicePeriodOverlaps`, so trimming the invoice alone leaves the
  guard firing off the line items' own `metadata.servicePeriodEnd` — which every
  line carries. Both were trimmed (1 invoice + 5 lines, 1 invoice + 6 lines).
  ⛔ **No money column was touched** — `totalCents`, `balanceDueCents`, `status`,
  `paidAt` are byte-identical; both still read PAID with a 0 balance. Every UPDATE
  was guarded on the exact expected prior value, so a re-run is a no-op.
- ✅ **PROVEN BY DRIVING THE DEPLOYED CODE, not by reading it**: the real
  `buildUpcomingBillingSchedule` + `findPaidBillingPeriodCoverage` run inside
  `app-api-1` against the live database now return **next payment 2026-09-02 /
  2026-09-03**, `reminderDue: true`, and **`septBlockedByPaidInvoice: null`** —
  where before the trim they named the blocking invoice. October reads Oct 2 /
  Oct 3, unblocked.
- ⛔ **`PUT …/settings` carrying ONLY `billingDayOfMonth` is safe, and that is
  load-bearing here**: the shared-`TaxProfile` write is gated on
  `billingTelecomFees` being present in the body (B Visible links
  `tax_profile_ny_default` — verified untouched, still `updatedAt 2026-05-19`),
  an absent `billingEmail` stays `undefined` and is dropped (both addresses
  verified intact), and metadata is merged only when a metadata-bearing key is
  sent (both metadata hashes unchanged). **Never add `billingTelecomFees` to a
  settings PUT you are making for an unrelated reason.**
- ⛔ **There is NO audit log for billing settings.** Backups on loopcom:
  `/root/billing-day-backup-20260831.json` (both settings rows, day 5) and
  `/root/invoice-period-backup-20260831.json` (both invoices + every line item).
  Reversal is those values back, in that order.
- ⚠️ **B Visible carries a stale `metadata.billingScheduleOverride` from
  2026-05-21 with `nextPaymentDate: "2026-06-05"`** — read on the CHARGE path by
  `getAndConsumeBillingScheduleOverride`. It is **inert** (the date is in the
  past, so it falls through to `"charge"`, and `skipNextPayment` is false) and was
  deliberately left alone, but it reads like a June payment date to anyone
  inspecting the row. ⛔ If a future `nextPaymentDate` is ever written there it
  SILENTLY suppresses autopay.
- ⏳ **NOT PROVEN: no charge has run on the new dates.** It is proven as the
  stored setting, as the deployed scheduler's own answer, and as an unblocked
  guard — never as money moving. **Acceptance is Sep 2 (B Visible) and Sep 3
  (Gesheft):** an invoice for period Sep 2 → Oct 2 / Sep 3 → Oct 3 and an
  APPROVED `PaymentTransaction` on the day. The T-3 window is ALREADY OPEN for
  both, so the next hourly worker pass creates the invoice and queues the
  customer's autopay reminder email.
