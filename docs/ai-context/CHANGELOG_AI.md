# AI Agent Changelog

Tracks changes made by Cursor AI agents. Newest entry first.

---

## 2026-05-14 — billing: platform BillingPlan catalog API (SUPER_ADMIN)

**Task:** billing / billing plan management API  
**Risk:** medium (Connect billing plans + audit logging; no charges, no SOLA, no worker/dunning edits)

### What changed

**`apps/api/src/billing/billingPlanCatalog.ts`** (new): Slug + price validation (`BILLING_PLAN_PRICE_MAX_CENTS` = 25_000_000), `aggregateBillingPlanUsageCounts`, tenant preview helpers, `catalogBillingPlansListWhere`, `deactivateBillingPlanBlockedReason`, `assertBillingPlanScheduleEligibility`, `logBillingCatalogEvent` (writes `BillingEventLog` with `catalogScope: billing_plan_catalog` on first `Tenant` by id — schema requires FK `tenantId`), `prismaUniqueViolation`.

**`apps/api/src/billing/routes.ts`**: Extended `GET /admin/billing/platform/billing-plans` (`?includeInactive=true`, counts, timestamps, full list fields); added `POST` / `GET :id` / `PATCH :id` / `POST :id/clone` for **catalog plans only** (`tenantId` null). Deactivate blocked if any tenant uses plan as **current** or **scheduled**. No `DELETE`. Scheduled plan POST now uses **`assertBillingPlanScheduleEligibility`** (same inactive response as before).

**`apps/api/src/billing/billingPlanCatalog.test.ts`** (new): Validation, counts, list `where`, schedule eligibility, auth gate parity, clone copy contract.

**`docs/ai-context/BILLING.md`**, **`docs/ai-context/DATA_MODEL.md`** — catalog routes + `BillingPlan` section.

### What was NOT changed

- **Portal** (no UI).
- **Worker / dunning / SOLA** (no edits to charge paths, webhooks, or worker main loop).
- **Telephony / PBX / mobile / CRM.**
- **Prisma migrations** (none).
- **`PARTIALLY_PAID` / proration** (not implemented).

### Deploy

- **API deploy required** to expose new routes and list shape.

### Verification

```bash
pnpm --filter @connect/api test:billing
pnpm --filter @connect/api typecheck
```

---

## 2026-05-14 — billing: scheduled plan changes phase 2 (worker consumption)

**Task:** billing / scheduled plan changes phase 2 worker  
**Risk:** high (worker + billing settings persistence; **no** SOLA/charge logic edits)

### What changed

**`apps/api/src/billing/billingScheduledPlanConsume.ts`** (new):
- `consumeScheduledPlanChange` — after monthly invoice exists for `periodStart`, if `periodStart >= nextBillingPlanEffectiveAt` and the next `BillingPlan` exists and is active: sets `billingPlanId`, copies plan price fields + `firstPhoneNumberFree`, clears `nextBillingPlanId` / `nextBillingPlanEffectiveAt`, logs `billing_plan.change_applied`. Inactive or missing plan: logs `billing_plan.change_skipped`, leaves schedule. Idempotent via conditional `updateMany`.

**`apps/worker/src/main.ts`** (modified):
- `runMonthlyBillingAutomation`: after resolving/creating the period invoice, calls `consumeScheduledPlanChange` in inner `try/catch` (failure → `billing_plan.change_consume_error` + `console.warn`; does not fail tenant billing / charge).

**`apps/api/src/billing/billingScheduledPlanConsume.test.ts`** (new): unit tests for apply, before-effective, inactive, idempotent, concurrent, missing plan, DB error propagation.

**`docs/ai-context/BILLING.md`** — Phase 2 worker section (replaces “deferred” stub).  
**`docs/ai-context/CHANGELOG_AI.md`** — this entry.

### What was NOT changed

- **Charge / gateway:** `chargeWorkerInvoice`, SOLA adapter calls, idempotency keys, amounts — **unchanged**.
- No proration, no `PARTIALLY_PAID`.
- No Portal code (docs only above).
- No telephony / PBX / mobile / CRM.

### Deploy

- **Worker:** required (`main.ts`).
- **API:** optional for runtime (new module only used by worker import path); ship same commit for consistency.

### Verification

```bash
pnpm --filter @connect/api test:billing
pnpm --filter @connect/api typecheck
pnpm --filter @connect/worker typecheck
```

---

## 2026-05-14 — billing: scheduled plan changes phase 1 (schema + API + preview logic + portal UI)

**Task:** billing / scheduled plan changes phase 1  
**Risk:** high (schema migration + API + Portal — no worker changes, no charge behavior changes)

### What changed

**`packages/db/prisma/schema.prisma`** (modified):
- Added `TenantBillingSettings.nextBillingPlanId String?` — FK → `BillingPlan.id`, SetNull on delete, named relation `"NextBillingPlan"`.
- Added `TenantBillingSettings.nextBillingPlanEffectiveAt DateTime?` — UTC midnight first-of-month when the plan change takes effect.
- Added index `TenantBillingSettings_nextBillingPlanId_idx`.
- Renamed existing `billingPlan` / `tenantSettings` relations to `"CurrentBillingPlan"` on both sides (required by Prisma when a model has two FK columns pointing to the same model).
- Added `BillingPlan.nextPlanSettings TenantBillingSettings[] @relation("NextBillingPlan")`.

**`packages/db/prisma/migrations/20260530000000_billing_scheduled_plan_change/migration.sql`** (new):
- `ALTER TABLE "TenantBillingSettings" ADD COLUMN "nextBillingPlanId" TEXT, ADD COLUMN "nextBillingPlanEffectiveAt" TIMESTAMP(3);`
- FK constraint `TenantBillingSettings_nextBillingPlanId_fkey` with SET NULL / CASCADE.
- Index `TenantBillingSettings_nextBillingPlanId_idx`.

**`apps/api/src/billing/billingScheduledPlan.ts`** (new):
- `validateScheduledPlanChangeEffectiveAt(rawEffectiveAt, now?)` — validates that effectiveAt is a parseable date, UTC midnight on the 1st of a month, and strictly after the first of the current UTC month. Returns `{ ok: true, effectiveAt }` or `{ ok: false, error }`.

**`apps/api/src/billing/invoiceEngine.ts`** (modified):
- `ensureTenantBillingSettings` now includes `nextBillingPlan` in the Prisma include clause.
- `BillingInvoicePreview` type extended with optional `scheduledPlanChange?: { planId, planName, effectiveAt }`.
- `buildBillingInvoicePreview` resolves `activePlan`: if `nextBillingPlanId` is set and `periodStart >= nextBillingPlanEffectiveAt`, uses `nextBillingPlan` as the price fallback instead of `billingPlan`. Returns `scheduledPlanChange` field in the preview when the next plan is active for the requested period.

**`apps/api/src/billing/routes.ts`** (modified):
- Added import `validateScheduledPlanChangeEffectiveAt` from `"./billingScheduledPlan"`.
- Added `GET /admin/billing/platform/billing-plans` — lists all active `BillingPlan` rows (id, code, name, prices). SUPER_ADMIN only.
- Added `GET /admin/billing/platform/tenants/:tenantId/scheduled-plan-change` — returns current `nextBillingPlanId`, `nextBillingPlanEffectiveAt`, and resolved `nextBillingPlan` object.
- Added `POST /admin/billing/platform/tenants/:tenantId/scheduled-plan-change` — schedules a plan change. Validates effectiveAt via helper, checks plan `active`, logs `billing_plan.scheduled_change_set` event. Overwrites any existing scheduled change.
- Added `DELETE /admin/billing/platform/tenants/:tenantId/scheduled-plan-change` — cancels scheduled change, clears both fields, logs `billing_plan.scheduled_change_cancelled`. Returns `404 no_scheduled_plan_change` when nothing is scheduled.

**`apps/portal/app/(platform)/admin/billing/settings/page.tsx`** (modified):
- Added `apiDelete`, `apiPost` to imports.
- Added types: `BillingPlanRow`, `ScheduledPlanChange`, `InvoicePreviewScheduledChange`. Extended `InvoicePreview` with optional `scheduledPlanChange`.
- Added `ScheduledPlanChangeCard` component: loads plans from `GET /admin/billing/platform/billing-plans` and current scheduled change from `GET …/scheduled-plan-change`. When none scheduled: plan dropdown + date picker + "Schedule plan change" button. When scheduled: blue notice + "Cancel scheduled change" button. Calls `POST`/`DELETE` routes accordingly. Logs toast on success/error.
- Updated `AdminInvoicePreviewCard`: when `preview.scheduledPlanChange` is present, shows a yellow notice "⚡ Scheduled plan change applied: This preview uses prices from plan X (effective Y)."
- `ScheduledPlanChangeCard` rendered between the SOLA/Collections grid section and `AdminInvoicePreviewCard`.

**`apps/api/src/billing/invoiceEngine.test.ts`** (modified):
- Added 5 new preview tests for scheduled plan change logic.

**`apps/api/src/billing/billingScheduledPlan.test.ts`** (new):
- 8 `validateScheduledPlanChangeEffectiveAt` tests (invalid date, non-1st, non-midnight, current month, past month, next month, far future, year rollover).
- 2 auth tests reusing `canAccessPlatformAdminBillingRoutes` (SUPER_ADMIN passes, all others fail).

**`docs/ai-context/BILLING.md`** — added "Scheduled plan change (Phase 1)" section.  
**`docs/ai-context/DATA_MODEL.md`** — updated `TenantBillingSettings` entry with new fields.

### What was NOT changed

- Worker (`apps/worker/src/main.ts`) — **untouched**. No `consumeScheduledPlanChange` logic yet (Phase 2 deferred).
- No invoice creation behavior changes.
- No charge / SOLA / webhook changes.
- No dunning changes.
- No proration.
- No `PARTIALLY_PAID` implementation.
- No tenant-facing UI for scheduled changes (operator-only).
- No CRM / telephony / PBX / mobile changes.

### Verification

```bash
# Billing tests (should be 146+ passing, 0 fail)
pnpm --filter @connect/api test:billing
# Typechecks
pnpm --filter @connect/api typecheck
pnpm --filter @connect/portal typecheck
```

After API deploy with migration:
- `GET /admin/billing/platform/billing-plans` returns active plans (SUPER_ADMIN JWT).
- `POST /admin/billing/platform/tenants/:id/scheduled-plan-change` with `{ nextBillingPlanId, effectiveAt: "2027-07-01T00:00:00.000Z" }` sets fields and logs event.
- `GET /admin/billing/platform/tenants/:id/invoice-preview?periodMonth=7&periodYear=2027` returns `scheduledPlanChange` field.
- `/admin/billing/settings` shows Scheduled Plan Change card; no change scheduled on fresh tenant.

### Revert

1. Cancel any scheduled change via `DELETE /admin/billing/platform/tenants/:id/scheduled-plan-change`.
2. Deploy previous API + Portal commits via deploy queue.
3. The migration columns (`nextBillingPlanId`, `nextBillingPlanEffectiveAt`) are nullable and default to null — leaving them in schema is safe. Do not reverse the migration; rollback of additive null columns is unnecessary.

---

## 2026-05-13 — billing: invoice preview phase A (discount fix + preview routes + portal UI)

**Task:** billing / invoice preview phase A  
**Risk:** medium (API + Portal only — no schema changes, no worker changes, no charge behavior changes)

### What changed

**`apps/api/src/billing/invoiceEngine.ts`** (modified):
- **Discount bug fix:** `TenantBillingSettings.discountPercent` was stored in the DB but silently not applied in `buildBillingInvoicePreview`. Added a `DISCOUNT` line item (type `DISCOUNT`, `taxable: true`) computed as `−round(serviceChargeCents × discountPercent)`. Applied to service charges only (excludes existing credit lines). Because `taxable: true`, the discount naturally reduces `taxableSubtotalCents` — tax is computed on the post-discount amount. No change when `discountPercent === 0`.

**`apps/api/src/billing/routes.ts`** (modified):
- Added `GET /billing/invoice-preview` — tenant-billing-scoped, read-only, calls `buildBillingInvoicePreview` for the authenticated tenant. Returns `BillingInvoicePreview`. No DB writes, no invoice created.
- Added `GET /admin/billing/platform/tenants/:tenantId/invoice-preview` — SUPER_ADMIN only. Accepts optional `?periodMonth=1-12&periodYear=2020-2099` query params to preview any calendar month. Falls back to current month when params are absent or invalid. No DB writes.
- Existing `POST /admin/billing/tenants/:tenantId/invoices/preview` retained unchanged.

**`apps/portal/app/(platform)/admin/billing/settings/page.tsx`** (modified):
- Added `AdminInvoicePreviewCard` component. Placed below the SOLA + Collections cards.
- Month/year period selectors. "Preview next invoice" button loads `GET /admin/billing/platform/tenants/:tenantId/invoice-preview`.
- Renders line items table (description, qty, unit, amount), total, tax notice, period + due date.
- Blue "Preview only — no invoice created" notice.
- Added `import { dollars, formatDate } from "../../../../../lib/billingUi"`.

**`apps/portal/app/(platform)/billing/page.tsx`** (modified):
- Added `InvoicePreviewSection` component. Shown above the quick nav.
- Lazy-loaded on first click ("Preview" button). Calls `GET /billing/invoice-preview`.
- Shows period, due date, line items, estimated total, and tax notice.
- Blue "Preview only — no invoice created" notice. No charge or send buttons.

**`apps/api/src/billing/invoiceEngine.test.ts`** (modified):
- Added discount assertions inside the existing `invoiceEngine preview + create` test block (ESM module cache constraint — mutations to `state.settings` are the reliable pattern for this file):
  - `discountPercent=0.1` → DISCOUNT line = −300 cents; tax computed on discounted base (293 cents: sales + E911 + regulatory on 2700 cent base).
  - `discountPercent=0` → no DISCOUNT line.
- Added two standalone tests (isolated mocks via fresh `makePreviewDb` factory):
  - Period bounds: `periodStart`/`periodEnd` passed to preview returns correct month.
  - No-DB-write: `billingInvoice.create` call count = 0 after `buildBillingInvoicePreview`.

**`docs/ai-context/BILLING.md`** (modified):
- Updated "Invoice preview / create" table entry.
- Added "Invoice preview (Phase A — complete)" section with routes, discount math, what was NOT changed, and test coverage summary.

### What was NOT changed

- No schema migrations.
- No worker changes.
- No dunning changes.
- No SOLA auth/webhook changes.
- No charge behavior changes.
- No `PARTIALLY_PAID` implementation.
- No proration.
- No add-ons or base fee.
- `POST /admin/billing/tenants/:tenantId/invoices/preview` retained.

### Verification

```bash
pnpm --filter @connect/api test:billing    # 136/136 pass
pnpm --filter @connect/api typecheck       # clean
pnpm --filter @connect/portal typecheck    # clean
```

### Revert

API: revert `invoiceEngine.ts` (remove discount block) and `routes.ts` (remove the 2 new GET routes).  
Portal: revert `settings/page.tsx` (remove `AdminInvoicePreviewCard`) and `billing/page.tsx` (remove `InvoicePreviewSection`).  
No DB migration to reverse.

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
