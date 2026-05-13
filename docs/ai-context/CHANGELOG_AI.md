# AI Agent Changelog

Tracks changes made by Cursor AI agents. Newest entry first.

---

## 2026-05-13 — billing: block partial admin mark-paid until partial status exists

**Task:** billing / API guard (Phase 0)
**Risk:** low
**Commit message:** `fix(billing): block partial admin mark-paid until partial status exists`

### Root cause

`markBillingInvoicePaid` in `apps/api/src/billing/invoiceEngine.ts` accepted an
optional `amountCents` parameter but always wrote `status: "PAID"` unconditionally.
If the caller passed `amountCents < invoice.totalCents` (e.g. via the admin
`mark-paid` route), the resulting DB row had `status = "PAID"` with
`balanceDueCents > 0` — an impossible state that caused:

- Customer portal hid the "Pay now" button (invoice appeared fully paid)
- Dunning/autopay worker ignored the invoice (only targets OPEN/FAILED)
- PDF watermarked "PAID" on an invoice with outstanding balance
- Admin overview overcounted collected MRR and undercounted open balance
- Receipt email showed the full `totalCents` for a partial payment

### Changes

| File | Change |
|------|--------|
| `apps/api/src/billing/invoiceEngine.ts` | Added Phase-0 guard before the DB update in `markBillingInvoicePaid`: if `paid < invoice.totalCents`, throws `PARTIAL_PAYMENT_NOT_SUPPORTED` with a clear hint. Full payments (no arg or exact total) are unchanged. |
| `apps/api/src/billing/invoiceEngine.test.ts` | Added three sub-tests inside the existing module-mock test: (1) partial amount rejects + update not called, (2) no-arg defaults to full PAID, (3) exact totalCents produces PAID. |
| `docs/ai-context/BILLING.md` | Updated "Mark Paid" entry to document the guard and its PARTIAL_PAYMENT_NOT_SUPPORTED error. |
| `docs/ai-context/CHANGELOG_AI.md` | This file (created). |

### Tests

```
pnpm --filter @connect/api test:billing   → 62 pass, 0 fail
pnpm --filter @connect/api typecheck      → clean
```

### What was NOT changed (Phase 0 scope)

- No `PARTIALLY_PAID` enum added
- No Prisma migration
- Worker unchanged
- Portal unchanged
- Email templates unchanged
- Dunning logic unchanged
- Webhook logic unchanged

### Phase 1 deferred

A full `PARTIALLY_PAID` status requires:
1. Prisma migration: add `PARTIALLY_PAID` to `BillingInvoiceStatus` enum
2. `markBillingInvoicePaid` to set `PARTIALLY_PAID` when `paid < totalCents`
3. Worker dunning to target `PARTIALLY_PAID` invoices
4. Portal: show "Pay now" for `PARTIALLY_PAID`, fix dashboard filter, fix receipt display
5. PDF: different watermark for partial vs full paid
6. Email: receipt email triggered from admin mark-paid; correct amount shown
7. Admin overview: correct MRR/open balance accounting
8. Tests for all changed layers

See the partial payments audit (2026-05-13) for full file plan and migration risk.

---
