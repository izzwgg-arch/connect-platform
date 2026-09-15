# 2026-09-15 · B Visible missed charges ($25 Lester ext + $40 Contabo) — caught up one-time AND made recurring via a NEW engine feature

Izzy: ext added last month for Lester ($25/mo) + $40/mo Contabo server were never
charged. Check this month; if missed, one-time invoice for both, email it, and put
both on the bill every month going forward.

Full handoff: `docs/ai-context/AGENT_HANDOFF_BVISIBLE_RECURRING_CUSTOM_LINES_2026-09-15.md`

## Why it was never charged — verified, not guessed
- **B Visible is a FLAT-RATE tenant**: `metadata.billingFlatRate` $105/mo for
  extensions, ANY count ([[flat-rate-inverts-the-extension-billing-rule]]).
  Lester Tan = **ext 111, created 2026-08-17** — it entered the count
  ("11 billing extensions") and added **$0**. September's cycle invoice
  CC-202608-00027 (Sep 2 – Oct 2) is PAID at the usual **$140** — no $25, no $40.
  August ($140) likewise. Both months missed.

## One-time catch-up — DONE, verified in prod DB
- **CC-202609-00010, $65.00 OPEN** (id `cmu32cn8i02qenl13r6z09pgm`), created via
  `POST /admin/billing/invoices/manual` signed as Izzy's SUPER_ADMIN inside
  `app-api-1` (the Gesheft CC-202609-00006 pattern, sent exactly once). Two CUSTOM
  lines, `taxable:false`: "Extension 111 - Lester Tan (added Aug 17) - one-time
  catch-up" 2500 + "Contabo server - one-time catch-up" 4000. source MANUAL →
  additive → **chargeable despite the paid Sep period** (`74e7730a` guard fix) and
  **excluded from autopay**.
- **Emailed: lastEmailStatus SENT** to `ap@bvisible.us` 19:27:41 UTC
  ("Invoice CC-202609-00010 — $65.00 due").
- ⛔ **NOT charged to the card** — Izzy asked invoice + send, not charge. Autopay
  will NEVER pick up a manual invoice; if he wants it on the saved card it must be
  charged by hand (admin /pay).

## Recurring going forward — NEW ENGINE FEATURE, DEPLOYED + LIVE-PROVEN
- The engine had NO named recurring add-on mechanism (only flat rate / virtual
  extensions / telecom fees — and ⛔ B Visible links shared `tax_profile_ny_default`,
  so `billingTelecomFees` must NEVER be sent for them,
  [[shared-tax-profile-rewrites-other-tenants]]).
- **Built `metadata.billingRecurringCustomLines`** (commit `5573d567`, api):
  opt-in per tenant, array of `{description, amountCents, taxable?}` → named
  CUSTOM lines on every cycle invoice. `taxable` defaults **false** = the amount
  is FINAL, outside tax/fee + all-inclusive math. Pushed before the period stamp
  so multi-month invoices scale them. Parser caps 20 lines / 200 chars /
  $250k-unit, skips junk. Tenants without the key build byte-identical invoices.
- Tests: `billingRecurringCustomLines.test.ts` (8 asserts incl. a CRLF-normalised
  source guard that the push stays BEFORE `applyBillingPeriodToRecurringLines`),
  **registered in the api runner's explicit list**. billingPeriodGuards suite still
  green. Typecheck adds nothing new (pre-existing errors only, none in billing/*
  beyond the documented accountPricing pair).
- **DEPLOYED** via `deploy-direct.sh api --commit 5573d567`; container
  `.build-commit` = `5573d567`, health 200, shipped source carries the module.
- **B Visible metadata set** (guarded UPDATE, only-if-absent; backup:
  `/root/bvisible-billing-metadata-backup-20260915.json`):
  Contabo server 4000 + Extension 111 - Lester Tan 2500.
- **LIVE-PROVEN through the deployed preview route**
  (`GET /admin/billing/platform/tenants/:id/invoice-preview`): next cycle AND
  October both read **$205.00** = $140 usual + $40 + $25, tax 0, the two CUSTOM
  lines present. September cannot regenerate (paid-period guard).
- ⏳ **NOT PROVEN: no real October invoice/charge yet.** Acceptance = worker
  creates the Oct 2 – Nov 2 invoice at $205 in the T-3 window (~Sep 29) and
  autopay charges it Oct 2.
- ⛔ **Do not ALSO bump the flat rate for Lester** — the $25 rides as a recurring
  custom line; raising flat $105 → $130 too would double-charge him.
