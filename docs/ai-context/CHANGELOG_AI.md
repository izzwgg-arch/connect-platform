# AI Agent Changelog

Tracks changes made by Cursor AI agents. Newest entry first.

---

## 2026-05-13 — billing: collections controls phase 2 worker enforcement

**Task:** billing / collections controls phase 2 worker enforcement  
**Risk:** high (worker changes — dunning sweep logic, idempotency keys)

### What changed

**`apps/api/src/billing/billingDunning.ts`** (modified):
- Added inline helpers `readInvoiceCollectionsLocal` and `readTenantDunningOverrideLocal` — read collections flags without importing `billingCollections.ts` (keeps module dependency-free).
- `mergeDunningAfterFailure` now accepts optional `overrides: { maxAttempts?, retryDelayMs? }` — used to apply per-tenant dunning parameters when setting the next retry window.
- `applyDunningAfterAutopayFailure` now accepts optional `overrides` and passes them through to `mergeDunningAfterFailure` and the event log.
- **New:** `runDunningSweepEligibility(take, dbOverride?)` — Phase 2 sweep classifier. Returns `{ toCharge, skipNextRetryInvoices, skipped }`. Applies all collections controls and per-tenant maxAttempts/retryDelayHours overrides. `listInvoicesEligibleForDunningRetry` kept unchanged for portal preview routes and backward-compat tests.
- **New:** `consumeSkipNextRetryFlag(invoiceId, tenantId, dbOverride?)` — clears `metadata.collections.skipNextRetry` and writes `collections_action: skip_next_retry_consumed` to `BillingEventLog`.

**`apps/worker/src/main.ts`** (modified):
- `runBillingDunningRetries` now calls `runDunningSweepEligibility` instead of `listInvoicesEligibleForDunningRetry`.
  - Invoices in `skipped` → one `collections_action: sweep_skipped_<reason>` log each (best-effort).
  - Invoices in `skipNextRetryInvoices` → `consumeSkipNextRetryFlag` called (no charge).
  - Invoices in `toCharge` → charged with deterministic idempotency key + per-tenant overrides.
- `chargeWorkerInvoice` now accepts `attemptNumber` (default 1) and `dunningOverrides?`.
  - **Idempotency key changed** from `worker:billing:sale:${invoice.id}:${Date.now()}` → `worker:billing:sale:${invoice.id}:a${attemptNumber}`. Restart-safe: same attempt number cannot produce a second charge.
  - Per-tenant `effectiveMaxAttempts` / `effectiveDelayMs` are forwarded to `applyDunningAfterAutopayFailure`.
- Monthly billing initial charge uses `attemptNumber = 1` (existing call site unchanged, default covers it).

**`apps/api/src/billing/billingDunning.test.ts`** (modified):
- Added 16 new test cases covering: per-tenant maxAttempts/retryDelayMs overrides in `mergeDunningAfterFailure`; `runDunningSweepEligibility` — paused/doNotCharge/tenantDisabled/skipNextRetry skips, eligible charge, maxAttempts allow/restrict, retryDelayMs propagation, timing miss silent skip; `consumeSkipNextRetryFlag` — clears flag + logs, preserves other metadata; deterministic idempotency key format.
- Total: 134 tests, 0 failures.

**Portal** (`apps/portal/app/(platform)/admin/billing/invoices/page.tsx`, `settings/page.tsx`):
- Replaced yellow Phase 1 warning banners with green "Worker enforcement active" notices.
- Dunning sweep cadence (every 6 h) noted inline.

**Docs:**
- `BILLING.md` — Phase 2 behaviour documented; Phase 1/Phase 2 boundary table updated to show all capabilities complete.
- `CHANGELOG_AI.md` — this entry.

### What was deliberately NOT changed
- SOLA auth/webhooks — untouched.
- Manual charge routes (`POST /admin/billing/invoices/:id/pay`) — untouched.
- `listInvoicesEligibleForDunningRetry` — kept for portal preview routes.
- No `PARTIALLY_PAID` enum.
- No schema migration.
- Monthly billing automation flow — only `chargeWorkerInvoice` call site gains a default `attemptNumber=1`; logic unchanged.

### How to verify
1. Deploy worker — check deploy log ends with `done <sha>`.
2. Confirm `chargeWorkerInvoice` inside container: `docker exec app-worker-1 grep -n 'a\${attemptNumber}' /app/apps/worker/src/main.ts` (or check compiled bundle).
3. In DB: `SELECT id, metadata FROM "BillingInvoice" WHERE metadata->'collections'->>'paused' = 'true'` — those invoices should not get `autopay_attempted` events on next sweep.
4. In `BillingEventLog`: after a sweep containing a `skipNextRetry` invoice, look for `type='collections_action'` with `action='skip_next_retry_consumed'`.

### How to revert
- Revert `apps/worker/src/main.ts` to call `listInvoicesEligibleForDunningRetry` directly with `chargeWorkerInvoice(inv, method, null)`.
- Revert `chargeWorkerInvoice` idempotency key to `Date.now()`.
- No DB rollback needed — metadata writes by the worker are additive.

---

## 2026-05-13 — billing: add collections automation controls (Phase 1)

**Task:** billing / collections automation controls — Phase 1 (API + Portal)  
**Risk:** low-medium (metadata-only, no schema migration, no worker changes)

### Phase 1 / Phase 2 boundary

**Phase 1 (this change):** Stores operator decisions in metadata and exposes them via API + Portal UI.  
**Phase 2 (deferred):** Worker reads `metadata.collections` flags before retrying invoices, and idempotency keys become deterministic.

### What changed

**New helpers** (`apps/api/src/billing/billingCollections.ts`):
- `readTenantCollectionsConfig` / `writeTenantCollectionsConfig` — merge `TenantBillingSettings.metadata.collections` (dunningEnabled, maxAttempts, retryDelayHours). Preserves all other metadata keys.
- `readInvoiceCollectionsSlice` / `writeInvoiceCollectionsSlice` — merge `BillingInvoice.metadata.collections` (paused, skipNextRetry, doNotCharge, audit fields). Preserves dunning slice and all other metadata keys.
- `validateTenantCollectionsConfigUpdate` — validates bounds (maxAttempts 1–10, retryDelayHours 1–336, dunningEnabled boolean|null).
- `queryCollectionsOverview` — returns count badges + retry-eligible / paused / exhausted invoice tables (up to 50 each, from OPEN/FAILED/OVERDUE invoices with balance > 0).
- `queryPreviewRetries` — simulates next dunning sweep (read-only, no mutations).
- `pauseInvoiceCollections`, `resumeInvoiceCollections`, `skipNextRetry`, `markDoNotCharge` — per-invoice action helpers. All reject PAID/VOID invoices. Each writes a `BillingEventLog` `collections_action` event with `prevState`/`nextState`.

**New API routes** (`apps/api/src/billing/routes.ts`):
- `GET /admin/billing/collections/overview`
- `GET /admin/billing/collections/preview-retries`
- `GET /admin/billing/platform/tenants/:tenantId/collections-config`
- `PUT /admin/billing/platform/tenants/:tenantId/collections-config`
- `POST /admin/billing/invoices/:id/collections/pause`
- `POST /admin/billing/invoices/:id/collections/resume`
- `POST /admin/billing/invoices/:id/collections/skip-next-retry`
- `POST /admin/billing/invoices/:id/collections/do-not-charge`

All `requirePlatformBilling` (SUPER_ADMIN only). No schema migration.

**Portal changes:**
- `apps/portal/app/(platform)/admin/billing/invoices/page.tsx` — new **Collections tab** (4th tab) with overview section (lazy-loaded, count badges, 3 tables) and preview-retries section. A yellow Phase 1 notice is always shown. Each row opens `InvoiceDetailModal`. `InvoiceDetailModal` now shows a **Collections Controls** panel (for non-PAID/VOID invoices) with current status badge, pause/resume/skip/do-not-charge buttons, and a Phase 1 warning. Actions call the new API routes and refresh the modal.
- `apps/portal/app/(platform)/admin/billing/settings/page.tsx` — new **Collections Automation** card (`AdminTenantCollectionsConfigForm`) in the settings page. Reads and writes per-tenant `dunningEnabled`, `maxAttempts`, `retryDelayHours`. Phase 1 notice shown.

**Tests** (`apps/api/src/billing/billingCollections.test.ts`):
- 38 test cases covering: `readTenantCollectionsConfig` (defaults, clamping), `writeTenantCollectionsConfig` (preserve, partial update), `validateTenantCollectionsConfigUpdate` (all edge cases), `readInvoiceCollectionsSlice` (status logic), `writeInvoiceCollectionsSlice` (preserves dunning), `pauseInvoiceCollections` (happy path, PAID rejection, already-paused, not-found), `resumeInvoiceCollections`, `skipNextRetry`, `markDoNotCharge`, audit log completeness.

### Test run
- `pnpm --filter @connect/api test:billing` → 119 pass (38 new), 0 fail
- `pnpm --filter @connect/api typecheck` → 0 errors
- `pnpm --filter @connect/portal typecheck` → 0 errors

### Not changed (explicit defers)
- Worker dunning sweep — does NOT yet read `metadata.collections` flags (Phase 2)
- No Prisma migration
- No `PARTIALLY_PAID` status
- No charge execution changes
- No SOLA/webhook changes
- No telephony/PBX/mobile/CRM

---

## 2026-05-13 — billing: add reports tab and CSV exports

**Task:** billing / reporting and exports
**Risk:** medium
**Commit message:** `feat(billing): add operator reports tab with aging, failed-payments, and CSV exports`

### What changed

**New API helpers** (`apps/api/src/billing/billingReports.ts`):
- `queryAgingReport` — all OPEN/FAILED/OVERDUE invoices with computed `daysOverdue`, cap 2 000
- `queryFailedPaymentsReport` — FAILED/OVERDUE invoices + last DECLINED/ERROR transaction, cap 1 000
- `queryInvoiceExport` / `queryTransactionExport` — unbounded SELECT up to 5 000 rows each
- `agingToCsv`, `failedPaymentsToCsv`, `invoiceExportToCsv`, `transactionExportToCsv` — CSV serialisers
- `csvCell` — CSV injection defence (prefixes `= + - @ TAB CR` starters with `'`)
- `csvMeta` — `# Report / # Generated At / # Generated By` header rows
- `computeDaysOverdue` — pure date math, testable without DB

**New API routes** (6 routes added to `apps/api/src/billing/routes.ts`):
- `GET /admin/billing/reports/aging` (JSON)
- `GET /admin/billing/reports/aging/export` (CSV)
- `GET /admin/billing/reports/failed-payments` (JSON)
- `GET /admin/billing/reports/failed-payments/export` (CSV)
- `GET /admin/billing/reports/export/invoices` (CSV, filters: status, tenantId)
- `GET /admin/billing/reports/export/transactions` (CSV, filters: status, tenantId)

**Portal** (`apps/portal/app/(platform)/admin/billing/invoices/page.tsx`):
- Added `"reports"` to tab union and tab bar
- New `ReportsTab` component: CSV export section + Aging Report section + Failed Payments section
- All reports are lazy-loaded (no fetch on page load)
- Row-cap yellow banner (`CappedNotice`) shown when results are truncated
- Tables wrap in `overflow-x: auto` for mobile
- CSV downloads use `<a download>` anchors (no JS fetch, direct browser download)

### What was NOT changed

- No Prisma migration, no schema change
- No payment mutations, no SOLA/webhook changes
- No worker, telephony, mobile, or CRM changes
- No email template changes
- No dunning logic changes

### Tests

```
pnpm --filter @connect/api test:billing   → 88 pass, 0 fail (was 62)
pnpm --filter @connect/api typecheck      → clean
pnpm --filter @connect/portal typecheck   → clean
```

26 new test cases in `billingReports.test.ts`:
- `computeDaysOverdue` — 6 cases (null, PAID, VOID, 10 days, today, future)
- `csvCell` — 9 cases (null, plain, formula starters =+-@, comma, quote, newline)
- `queryAgingReport` — 4 cases (empty, daysOverdue, row cap, no-cap)
- `queryFailedPaymentsReport` — 2 cases (with tx, without tx)
- Invoice export CSV — 2 cases (headers, metadata rows)
- Transaction export CSV — 1 case (headers + data row)
- `csvRow` — 2 cases (join, mixed types)

### Risks

| Risk | Mitigation |
|---|---|
| Large dataset slow query | Row caps (2 k/1 k/5 k) + `X-Report-Capped` header + UI banner |
| CSV formula injection | `csvCell` prefixes `=`, `+`, `-`, `@`, TAB, CR with `'` |
| Auth bypass | All 6 routes call `requirePlatformBilling` (SUPER_ADMIN only) |

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
