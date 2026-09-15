# 2026-09-15 · Gesheft one-time Starlink invoice — PAID, and the paid-period guard fix it forced

Izzy asked: invoice Gesheft $200 (service call, Starlink install) + $75 (Starlink data),
one-time, email it, charge their card.

## FINAL STATE — ALL DONE, VERIFIED IN PROD DB
- **CC-202609-00006 is PAID**: $275.00 charged on the saved Amex •1007, APPROVED,
  Sola ref **11050894534**, tx `cmu30xvcu00jhpf14d81e3sus`, paidAt 18:47 UTC. Exactly one
  transaction row. Receipt email SENT (event `receipt_emailed`, invoice `lastEmailStatus` SENT).
- One-time only: source MANUAL, excluded from the autopay cycle, no recurring line — it can
  never repeat on a monthly bill.

## ⛔ THE CHARGE WAS BLOCKED FIRST — the paid-period guard bug, now FIXED + DEPLOYED (`74e7730a`)
- `chargeBillingInvoice` refused with `BILLING_PERIOD_ALREADY_PAID`: the guard
  (`billingPeriodGuards.ts`) blocks charging ANY invoice whose period overlaps a PAID one, and
  Gesheft's paid cycle CC-202608-00026 covers Sep 3 – Oct 3. **Every additive one-time/manual
  invoice dated inside an advance-billed month was unchargeable by card** — admin /pay,
  /retry-payment, the one-time-charge drawer AND the customer pay page. July's headset invoice
  (CC-202607-00010) only charged because it raced the cycle invoice's payment by hours that morning.
- **Fix** (mirrors the guard's own one_time_charge carve-out + autopayCycle.ts's "purely additive"
  rule): `isAdditiveOneTimeInvoice()` — true for `manual_invoice` / `one_time_charge` /
  `source: MANUAL` invoices UNLESS their text says "monthly service"/"service balance" (those
  replace a cycle charge and stay guarded). Both charge doors skip the coverage check for additive
  invoices. Cycle invoices keep the guard bit-for-bit. Loads line items itself when the caller
  fetched the invoice bare (the admin /pay route does findUnique without include).
- Tests: `billingPeriodGuards.test.ts` extended (10 asserts pass) and **registered in the api test
  runner** — it had never been in the explicit file list. Typecheck: only pre-existing errors
  (billingPricingDiagnostics/State `accountPricing`, packages/db webrtc moduleResolution),
  proven by a clean-tree baseline.
- **DEPLOYED via deploy-direct.sh api**, container `.build-commit` = `74e7730a`, health 200,
  shipped source greps the helper. The charge above is the live proof.

## Observed, pre-existing, NOT touched
- `webhook.signature_rejected` (SOLA) fired after the approved charge — it fires 2–9×/week since
  at least Aug 10, platform-wide. The charge is unaffected (direct cc:sale approved). Separate issue.

## Original invoice+email pass (prod, verified in DB)
- Checked first that the earlier attempt, cut off by the usage limit, had created nothing:
  no Starlink line, no invoice today.
- Created **CC-202609-00006** (id `cmu2zr2p218c0qm13u0ju6jwz`) through the real route
  `POST /admin/billing/invoices/manual`. Request signed inside `app-api-1` as Izzy's SUPER_ADMIN
  user. Sent exactly once, no retry.
  - Two `CUSTOM` lines, `taxable:false`: 20000 + 7500. Total **$275.00**, tax 0. OPEN, due 2026-09-15.
  - Built the same way as the last manual invoice, CC-202607-00010 (CUSTOM lines, same-day period).
- Emailed through `POST /admin/billing/invoices/:id/send`, to
  `Contact@Gesheftkosher.com, ap@gesheftkosher.com` (the tenant's billingSettings email). Invoice `lastEmailStatus` went QUEUED → **SENT** at 18:14:35 UTC.

## Notes
- A manual invoice adds no tax unless a SALES_TAX/E911/REGULATORY line is included.
  The total is exactly the sum of the lines.
- A manual invoice is excluded from the autopay cycle (`autopayCycle.ts`), so autopay will NOT charge it.
  It must be charged by hand.
- No code changed. No deploy.
