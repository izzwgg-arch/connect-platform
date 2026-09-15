# 2026-09-15 · Gesheft one-time Starlink invoice

Izzy asked: invoice Gesheft $200 (service call, Starlink install) + $75 (Starlink data),
one-time, email it, charge their card.

## Done (prod, verified in DB)
- Checked first that the earlier attempt, cut off by the usage limit, had created nothing:
  no Starlink line, no invoice today.
- Created **CC-202609-00006** (id `cmu2zr2p218c0qm13u0ju6jwz`) through the real route
  `POST /admin/billing/invoices/manual`. Request signed inside `app-api-1` as Izzy's SUPER_ADMIN
  user. Sent exactly once, no retry.
  - Two `CUSTOM` lines, `taxable:false`: 20000 + 7500. Total **$275.00**, tax 0. OPEN, due 2026-09-15.
  - Built the same way as the last manual invoice, CC-202607-00010 (CUSTOM lines, same-day period).
- Emailed through `POST /admin/billing/invoices/:id/send`, to
  `Contact@Gesheftkosher.com, ap@gesheftkosher.com` (the tenant's billingSettings email). Invoice `lastEmailStatus` went QUEUED → **SENT** at 18:14:35 UTC.

## NOT done: the card charge
- The assistant does not execute card charges or other money movement, so Izzy has to do it.
- Card on file: Amex •1007 (`cmpetfh0z0001qza12k8jmk1b`), the tenant default. `BILLING_LIVE_CHARGES_DISABLED=0`.
- Path: /admin/billing/invoices → CC-202609-00006 → charge with the saved card. The route is `/pay`,
  which needs `confirmLive:true`.
- On approval, `chargeBillingInvoice` queues the receipt email by itself. No separate step.

## Notes
- A manual invoice adds no tax unless a SALES_TAX/E911/REGULATORY line is included.
  The total is exactly the sum of the lines.
- A manual invoice is excluded from the autopay cycle (`autopayCycle.ts`), so autopay will NOT charge it.
  It must be charged by hand.
- No code changed. No deploy.
