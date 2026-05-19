# AI Agent Changelog

Tracks changes made by Cursor AI agents. Newest entry first.

---

## 2026-05-18 — Billing: Sola recurring schedule cutover to Connect autopay (Phases A–D)

**Task:** Build safe cutover flow so Connect can take over billing from existing Sola/Cardknox recurring schedules without re-entering cards and without double charging.  
**Risk:** High (money, autopay, schema migration, worker).

### Shipped

**Schema migration (`20260518100000_billing_sola_cutover`):**
- `PaymentMethod`: +`isImported`, `importedAt`, `processorCustomerId`, `processorPaymentMethodId`, `metadata`
- `BillingSolaExternalScheduleLink`: +`cutoverStatus`, `linkedPaymentMethodId`, `tokenLinkedAt`, `cutoverAt`, `cutoverByUserId`, `disabledSolaAt`, `disableAttemptedAt`, `disableError`, `connectAutopayEnabledAt`

**`packages/integrations/src/sola-cardknox/recurring.ts`:**
- `getPaymentMethodWithToken()` — fetches raw vault Token for server-side encryption only (never logged/returned to browser)
- `updateSchedule(scheduleId, { isActive })` — Phase C: disable old Sola recurring schedule

**`apps/api/src/billing/solaCutover.ts`** (new):
- `linkSolaTokenToPaymentMethod()` — Phase A: encrypt token → PaymentMethod (isImported=true), mark TOKEN_LINKED
- `getBillingCutoverReadiness()` — Phase B: readiness checklist including doubleChargeRisk
- `takeOverBillingFromSola()` — Phase C: atomic disable Sola → set default PM → enable Connect autopay → CUTOVER_COMPLETE. Abort if Sola disable fails.

**`apps/api/src/billing/routes.ts`:**
- `POST /admin/billing/platform/sola-import/schedules/:id/link-token`
- `GET /admin/billing/platform/tenants/:tenantId/billing-cutover/readiness`
- `POST /admin/billing/platform/tenants/:tenantId/billing-cutover/take-over`

**`apps/worker/src/main.ts`:**
- `checkActiveSolaScheduleBlock()` — Phase D guard: returns active non-cutover Sola link if found
- `getAndConsumeBillingScheduleOverride()` — consumes `skipNextPayment` once; respects `nextPaymentDate`
- Both called in `runMonthlyBillingAutomation` before `chargeWorkerInvoice`
- Events: `billing.autopay_skipped_active_sola_schedule`, `billing.autopay_skipped_schedule_override`, `billing.autopay_skipped_future_payment_date`

**`apps/api/src/billing/solaCutover.test.ts`** (new): 12 test cases covering all safety rules

**Portal:**
- `adminBillingSolaImportsWorkspace.tsx`: new cutover-status column, Link card token button, Take over billing button with 2-step confirmation drawer
- `billingWorkspaceSections.tsx` `SolaLinkedSchedulesSection`: shows cutover status, enriched warnings
- `billingSolaImports.css`: new styles for token-linked chip, active-warn badge, cutover drawer

**Docs:**
- `BILLING.md`: updated Sola schedule import section with full cutover architecture
- `DATA_MODEL.md`: new PaymentMethod and BillingSolaExternalScheduleLink fields documented
- `CHANGELOG_AI.md`: this entry

### Safety guarantees enforced in code

1. Worker never charges if active non-cutover Sola schedule → `billing.autopay_skipped_active_sola_schedule`
2. Cutover aborts if Sola disable API fails → CUTOVER_FAILED, Connect autopay NOT enabled
3. Take-over route never creates invoice or charges card immediately
4. No raw token ever logged, returned to browser, or stored unencrypted

### Explicitly NOT changed

- No charges were run during implementation
- Telephony, PBX, CRM, mobile code untouched
- Sola webhook handler unchanged
- Dunning/collections logic unchanged
- billingScheduleOverride was already stored — now CONSUMED by worker (first real consumer)

---

## 2026-05-18 — Billing: Jurisdiction tax auto-suggestions (NY / Orange County)

**Task:** Taxes page auto-fills sensible suggested defaults instead of showing 0.000 everywhere.  
**Risk:** Medium (portal only, no API/schema changes).

### Shipped

- **`apps/portal/lib/billingTaxSuggestions.ts`** (new): `NY_ORANGE_COUNTY_TAX_TEMPLATE` with sales tax 8.125%, E911 $3.00 flat monthly, regulatory 1.000%, USF off, surcharge off. `detectJurisdictionFromTenant` checks assigned TaxProfile → serviceAddress → billingAddress → known Orange County cities (Middletown, Newburgh, etc.). `applyJurisdictionTemplate` merges template over current fees without mutating input. `JURISDICTION_TEMPLATES` list for future expansion.
- **`apps/portal/lib/billingTelecomFees.ts`**: Fixed `defaultFeesFromTaxProfile` E911 basis from `per_did` → `flat_monthly` to match the $3.00 flat-monthly spec.
- **`AdminTaxesFeesWorkspace.tsx`**: Jurisdiction quick-start panel — auto-detects label, template selector dropdown, "Apply suggested" button, "Last applied from: …" chip, summary of suggested values, disclaimer copy.
- **`billingTaxFees.css`**: `billing-tax-suggestion-panel` styles.
- **`apps/portal/lib/billingTaxSuggestions.test.ts`** (new): 18 tests covering template values, detection from all address sources, city-based detection, `applyJurisdictionTemplate` mutation guard.
- **`apps/portal/package.json`**: Added new test file to `test` script.

### Disclaimer copy used
> "Suggested starting rates only. Confirm with your tax advisor before billing customers."

### Tests
- Portal test suite: **24 pass, 0 fail** (18 new + 6 existing desktop-poll).
- Portal typecheck: pass.

### Explicitly NOT changed
- API, worker, invoice engine, Prisma schema.
- No charges run. No Sola schedules touched.

### Deploy
- **Portal only**.

---

## 2026-05-18 — Billing: Production readiness — taxes, cards, schedules, past-due

**Task:** Five production-readiness fixes to make billing usable for real cutover.  
**Risk:** High (invoice engine, payment flows, metadata schema).

### Shipped

**A — Tax estimate fix:**
- `apps/api/src/billing/invoiceEngine.ts`: `BillingInvoicePreview` now includes `taxableSubtotalCents` (sum of taxable service lines before taxes). Exposed in API preview response.
- `apps/portal/…/AdminTaxesFeesWorkspace.tsx`: estimate prefers `taxableSubtotalCents` from API; fallback includes flat-rate + toll-free + phone quantities for tenants without live extensions.
- `apps/api/src/billing/billingPricingDiagnostics.test.ts` + `billingPricingState.test.ts`: added `taxableSubtotalCents` to stub objects.

**B — Add-card iFields error message fix:**
- `adminBillingOpsPanels.tsx` + `adminBillingPaymentDrawers.tsx`: distinguish "gateway enabled but iFields key missing" (guides to iFields public key field) from "gateway not configured at all".

**C — Sola schedule visibility:**
- `billingWorkspaceSections.tsx`: new `SolaLinkedSchedulesSection` shows mapped external schedules (status, masked card, amount, frequency, next run) — read-only, no charge implied.
- Integrated into Methods page (`BillingPaymentMethodsSection`) and Payments workspace (`adminBillingPaymentsWorkspace.tsx`).

**D — Billing schedule override (store + display, no worker change):**
- `billingTenantSettingsMetadata.ts`: `BillingScheduleOverride` type + `validateBillingScheduleOverrideInput` + `mergeBillingScheduleOverrideIntoMetadata`. Added to `TenantBillingMetaPatchInput`.
- `apps/api/src/billing/routes.ts`: `PUT /admin/billing/tenants/:tenantId/settings` accepts `billingScheduleOverride` in Zod schema; validates and merges into metadata with operator `updatedBy`/`updatedAt`.
- `adminBillingPaymentsWorkspace.tsx`: `BillingScheduleOverrideCard` — set next payment date, skip next billing run, clear override. Worker behavior unchanged.

**E — Past-due billing workflow:**
- `adminBillingPaymentsWorkspace.tsx`: `PastDueBillingPanel` — guided prior-period or custom invoice creation with collection method selector (invoice only / card on file / new card). No automatic charges; confirms before any charge.
- `adminBillingPaymentDrawers.tsx`: `OneTimeChargeDrawer` gains `initialDescription`, `initialAmountCents`, `initialChargeMode` props for pre-filling from the past-due panel.

### Tests
- `pnpm --filter @connect/api test:billing`: 240 pass, 2 skipped (credential-gated), 0 fail.
- `pnpm --filter @connect/api typecheck`: pass.
- `pnpm --filter @connect/portal typecheck`: pass.

### Explicitly NOT changed
- Telephony, mobile, CRM, worker billing logic, Prisma schema.
- No charges run during implementation. No Sola schedules disabled.

### Deploy
- **API** (invoice engine + settings route) + **portal** (all UI).

---

## 2026-05-17 — Billing: Taxes & fees workspace (Phase A)

**Task:** Redesign Admin Billing → Taxes into a telecom tax/fee management UI; move cycle/branding elsewhere.  
**Risk:** High (tax configuration UX + metadata; TaxProfile sync on save).

### Shipped (Phase A)

- **`AdminTaxesFeesWorkspace`**: fee cards (sales tax, E911, regulatory, surcharge, USF, custom) with enabled / customer-visible / rate or amount / basis; jurisdiction chip; estimate panel; customer-visible preview; advanced provider settings.
- **`metadata.billingTelecomFees`**: per-tenant fee config via `billingTelecomFees.ts` (API validate/merge + PUT settings).
- **TaxProfile sync** on save for sales tax, E911, regulatory (shared profile warning in UI).
- **Settings tabs**: Taxes & fees | Invoice & billing (cycle + branding) | Payment gateway — top-level billing nav unchanged.
- **Tests:** `billingTelecomFees.test.ts` — **235/235** `test:billing` pass.

### Phase B (not in this change)

- Invoice engine filtering by `customerVisible`; telecom surcharge/USF/custom invoice lines; E911 basis per-DID on invoices (estimate UI supports per-DID; engine still uses `e911FeePerExtension` × extension count).

### Explicitly NOT changed

- SOLA / payment execution, Prisma schema.

### Deploy

- **API** + **portal**.

---

## 2026-05-17 — Billing: fix toll-free manual quantity override persistence

**Task:** Manual `billingQuantityOverrides.tollFreeNumbers` did not survive save/reload.  
**Risk:** High (invoice quantities).

### Root cause

`parseBillingQuantityOverrides` and `validateBillingQuantityOverridesInput` iterated only `extensions`, `virtualExtensions`, `phoneNumbers`, `smsPackages` — **`tollFreeNumbers` was dropped on PUT** even though Zod and the portal payload included it.

### Shipped

- **`billingQuantityOverrides.ts`**: shared `BILLING_QUANTITY_OVERRIDE_KEYS` includes `tollFreeNumbers` in parse + validate.
- **Tests:** validate/parse/merge round-trip; invoice preview manual qty 1 with zero active toll-free DIDs; qty 0 omits line.

### Explicitly NOT changed

- Portal UI, SOLA, payment execution, Prisma schema.

### Deploy

- **API** and **worker** (shared billing override resolution).

---

## 2026-05-17 — Billing: local vs toll-free DID pricing (invoice engine + admin UI)

**Task:** Split local and toll-free phone number billing — separate quantities, unit prices, invoice lines, monthly estimate, and admin overrides.  
**Risk:** Medium (invoice line math; metadata only).

### Shipped

- **`billingPhoneNumbers.ts`**: NANP toll-free NPA detection on E.164 (`800/833/844/855/866/877/888`); splits active DIDs into local vs toll-free. No `PhoneNumber` type column — purchase flow does not persist provider `tollfree` type.
- **`usage.ts`**: `localPhoneNumberCount`, `tollFreePhoneNumberCount`, billable counts/ids; first-free applies to **local** only.
- **`billingTollFreePricing.ts`**: `metadata.billingTollFreeDidPriceCents`; resolve unit price (tenant override → local DID price → default).
- **`billingQuantityOverrides.ts`**: `tollFreeNumbers` override key.
- **`invoiceEngine.ts`**: separate **Local phone numbers** and **Toll-free phone numbers** lines (`PHONE_NUMBER` type + `metadata.lineItemKind`); toll-free line omitted when qty 0.
- **`routes.ts`**: `tollFreeDidPriceCents` + `tollFreeNumbers` in settings PUT schema.
- **Portal `AdminPricingWorkspace`**: two DID cards, toll-free price editable when catalog-locked; estimate + overrides table rows.
- **Tests:** `billingPhoneNumbers.test.ts`, `billingTollFreePricing.test.ts`, `usage.tollfree.test.ts`, invoice engine mixed local/toll-free — **222/222** `test:billing` pass; API + portal typecheck pass.

### Explicitly NOT changed

- SOLA / payment execution, Prisma schema, `BillingLineItemType` enum.

### Deploy

- **API**, **portal**, **worker** (worker imports `invoiceEngine`).

---

## 2026-05-17 — Billing: tenant billing quantity overrides (auto vs manual)

**Task:** Let SUPER_ADMIN override billable quantities per tenant (extensions, virtual extensions, phone numbers, SMS) while keeping system counts as suggestions.  
**Risk:** High (invoice line quantities; metadata only).

### Shipped

- **`billingQuantityOverrides.ts`**: parse/validate/merge metadata; **`resolveBillingQuantities`** for preview/create.
- **`invoiceEngine.ts`**: all service lines use billing quantities; virtual extensions as **`EXTENSION`** + `metadata.lineItemKind: "virtual_extensions"`; E911 uses billing extension count.
- **`routes.ts`**: **`PUT …/settings`** accepts **`billingQuantityOverrides`**; **`400 invalid_billing_quantity_overrides`**.
- **Portal `AdminPricingWorkspace`**: suggested + Auto/Manual + billing qty per card; live estimate; overrides table rows for manual qty.
- **Tests:** `billingQuantityOverrides.test.ts`; invoice engine cases in main test block — **217/217** `test:billing` pass.

### Explicitly NOT changed

- SOLA/payment execution, Prisma schema, `BillingLineItemType` enum (virtual line uses **`EXTENSION`** + metadata).

### Deploy

- **API**, **portal**, **worker** (worker imports `invoiceEngine`).

---

## 2026-05-17 — Billing: tenant extensions flat monthly rate (invoice engine + admin UI)

**Task:** Allow SUPER_ADMIN to set a tenant-specific **flat monthly rate for all extensions** (real billing, not display-only).  
**Risk:** High (invoice line math; metadata on `TenantBillingSettings`).

### Shipped

- **`billingFlatRate.ts`**: parse/validate/merge metadata; **`buildExtensionInvoiceLine`** — flat line `quantity: 1`, metadata `flatRate` + `extensionCount`.
- **`invoiceEngine.ts`**: extension lines via flat-rate builder; preview/create persist same shape.
- **`billingTenantSettingsMetadata.ts` + `routes.ts`**: **`PUT …/settings`** accepts **`billingFlatRate`**; **`400 invalid_billing_flat_rate`** if enabled without positive cents.
- **Portal `AdminPricingWorkspace`**: flat-rate card, live estimate, overrides row, save payload; **`billingUi.ts`** helpers.
- **Tests:** `billingFlatRate.test.ts`; flat-rate cases in main **`invoiceEngine.test.ts`** block — **212/212** `test:billing` pass.

### Metadata shape

`TenantBillingSettings.metadata.billingFlatRate`: `{ enabled, amountCents, label?, appliesTo: "extensions" }` — no migration.

### Explicitly NOT changed

- SOLA / Cardknox charge execution, payment execution, Prisma schema, collections worker behavior beyond bundling updated engine.

### Deploy

- **API**, **portal**, and **worker** (worker imports `invoiceEngine` for monthly billing).

### Files (primary)

- `apps/api/src/billing/billingFlatRate.ts`, `invoiceEngine.ts`, `billingTenantSettingsMetadata.ts`, `routes.ts`, `*.test.ts`
- `apps/portal/.../AdminPricingWorkspace.tsx`, `billingPricing.css`, `lib/billingUi.ts`
- `docs/ai-context/BILLING.md`, `BILLING_UX_OVERHAUL_PHASE1_IA.md`, `CHANGELOG_AI.md`

---

## 2026-05-17 — Billing: tenant pricing workspace operational redesign (portal)

**Task:** Redesign admin **Plans & pricing** into a tenant billing control center — quantities, live monthly estimate, inline unit pricing, overrides visibility.  
**Risk:** Medium (portal UX; display-only estimate helpers).

### Shipped

- **`AdminPricingWorkspace`**: billing profile strip, four **billing-item cards** (extensions, virtual extensions, phone numbers, SMS), live **monthly estimate** panel, compact overrides table (default / override / qty / monthly), sticky **Save pricing** bar, collapsed **Advanced** (diagnostics + reset).
- **`billingUi.ts`**: `computeTenantMonthlyEstimate`, `previewServiceSubtotalCents` (operational preview only).
- **`billingPricing.css`**: profile strip, item cards, steppers, summary panel, save bar (dark-native).

### Quantity truth (no fake persistence)

- **Extensions / phone numbers:** read-only counts from `GET …/platform/tenants/:id` → `usage` (`calculateTenantBillingUsage`).
- **SMS:** `0` or `1` via existing **`smsBillingEnabled`** setting (stepper saves settings).
- **Virtual extensions:** not billed separately — UI labels **planned** / uses extension rate.

### Explicitly NOT changed

- Invoice engine, worker, recurring/SOLA charge execution, Prisma billing math, billing IA/routes.

### Deploy

- **Portal only** (no API/worker).

### Files (primary)

- `apps/portal/.../AdminPricingWorkspace.tsx`, `billingPricing.css`, `lib/billingUi.ts`
- `docs/ai-context/BILLING.md`, `BILLING_UX_OVERHAUL_PHASE1_IA.md`, `CHANGELOG_AI.md`

---

## 2026-05-17 — Billing: Sola external schedule import Phase B (read-only sync + mapping UI)

**Task:** Implement read-only Sola recurring schedule sync and SUPER_ADMIN mapping UI.  
**Risk:** High (billing metadata; **no charges**, **no token storage**, **no autopay**).

### Shipped

- **Schema:** `BillingSolaExternalScheduleLink` + `SolaScheduleLinkMappingStatus` (`UNMAPPED` | `MAPPED` | `IGNORED` | `CONFLICT`); migration `20260517120000_billing_sola_external_schedule_link`.
- **Integrations:** `SolaRecurringClient` in `packages/integrations/src/sola-cardknox/recurring.ts` (`listSchedules`, `getSchedule`, `getPaymentMethodMasked`, payload redaction).
- **API:** `solaExternalSchedules.ts` — sync upsert, tenant suggestions, map/ignore/unmap; routes under `/admin/billing/platform/sola-import/*` (SUPER_ADMIN only).
- **Portal:** `/admin/billing/sola-imports` — sync button, filters, table, map/ignore/unmap; trust callout (“does not charge”, “does not disable Sola schedules”); cutover warning on mapped active schedules.
- **Tests:** `solaExternalSchedules.test.ts` (redaction, parsing, sync upsert, map without PaymentMethod); **205/205** `test:billing` pass.

### Explicitly NOT done (Phase B boundaries)

- No `PaymentMethod` / `tokenEncrypted` creation
- No charges, invoices, autopay, worker/dunning changes
- No Sola schedule disable (`/UpdateSchedule`)
- No telephony / mobile / CRM changes

### Deploy

- **API** (schema + routes) and **portal** (UI) required; **no worker** deploy.

### Files (primary)

- `packages/db/prisma/schema.prisma`, migration `20260517120000_billing_sola_external_schedule_link/`
- `packages/integrations/src/sola-cardknox/recurring.ts`, `index.ts`
- `apps/api/src/billing/solaExternalSchedules.ts`, `solaExternalSchedules.test.ts`, `routes.ts`
- `apps/portal/.../admin/billing/sola-imports/`, `adminBillingSolaImportsWorkspace.tsx`
- `docs/ai-context/BILLING.md`, `CHANGELOG_AI.md`

### Next: Phase C

Operator-approved token linking into `PaymentMethod`, processor ID fields, enriched cutover UX.

---

## 2026-05-17 — Billing: Sola vault schedule linking audit (Phase A, no code)

**Task:** Audit existing Sola/Cardknox integration to design external vault schedule linking.  
**Risk:** High (billing; audit-only phase, no code written).

### Audit findings

**Sola Recurring API** (`https://api.cardknox.com/v2`) is fully capable:
- `/ListCustomers`, `/ListPaymentMethods`, `/ListSchedules`, `/GetSchedule`, `/GetPaymentMethod` — all exist, paginated, POST-only, same API key as Transaction API
- `/GetPaymentMethod` returns the actual `Token` (xToken) — safe to store encrypted; works directly with existing `chargeToken()` / `chargeBillingInvoice()`
- `/ListSchedules` returns `Amount`, `IntervalType`, `IntervalCount`, `IsActive`, `NextScheduledRunTime`, masked customer data
- **None of these endpoints are currently implemented** in the Connect Sola adapter

**Schema gaps identified** (migration not yet written):
- `PaymentMethod` needs: `processorCustomerId`, `processorPaymentMethodId`, `isImported`, `importedAt`
- New table needed: `BillingSolaExternalScheduleLink` — tracks Sola schedule metadata + Connect tenant mapping

**xToken reuse confirmed:** Imported Sola tokens work with existing `chargeToken()` / `chargeBillingInvoice()` with zero adapter changes.

**Webhook limitation confirmed:** Old Sola recurring schedule webhooks cannot be auto-reconciled to Connect `BillingInvoice` rows. The current handler requires a `CONNECT:` prefixed `xInvoice` which old schedules do not have.

**Double-charge risk documented:** Admin UI must show both Sola schedule status and Connect autopay status simultaneously. No automatic disabling of old schedules in any early phase.

### What was NOT done (intentional)
- No code written
- No migration written
- No charges
- No schema changes
- No deploy

### Files changed
- `docs/ai-context/BILLING.md` — added "Sola Vault Schedule Linking" section with full architecture, constraints, phase plan, schema gaps, webhook limitations
- `docs/ai-context/CHANGELOG_AI.md` — this entry

### Next: Phase B (when approved)
Schema migration + `SolaRecurringClient` in `packages/integrations` + read-only sync API route + admin list UI under `/admin/billing/sola-imports`.

---

## 2026-05-17 — Admin billing: enforce global tenant data scoping

**Task:** Fix correctness bug — UI followed workspace switcher but list/report APIs returned all tenants.  
**Risk:** high (billing data visibility; filtering only).

### Root cause

List tabs (`InvoicesTab`, `TransactionsTab`, collections, reports) called platform-wide endpoints **without** `?tenantId=`. `useAdminBillingTenant` also preferred stale URL `tenantId` over the global switcher in tenant mode.

### Portal

- `useAdminBillingTenant` — tenant workspace prefers `useAppContext().tenantId` over URL
- `adminBillingTenantQuery()` — shared query builder for scoped fetches
- Invoices, payments/transactions, collections, reports pass `tenantId` when a workspace is selected
- Methods, activity, payments workspace use hook (not raw `searchParams`)

### API (minimal)

- `GET /admin/billing/reports/aging` (+ export), `failed-payments` (+ export), `collections/overview`, `collections/preview-retries` accept optional `?tenantId=`

### Verification

| Check | Result |
|-------|--------|
| `pnpm --filter @connect/portal typecheck` | pass |
| `pnpm run test:billing` (api) | 197 pass |

---

## 2026-05-17 — Admin billing: global workspace tenant context (rail removed)

**Task:** Remove duplicate billing company sidebar; scope Admin Billing from the portal **workspace switcher** (`TenantSwitcher` / `useAppContext`).  
**Risk:** medium (portal layout + routing only; no billing math / API / workers).

### Behavior

- **Tenant scope** (`adminScope === "TENANT"`): billing auto-scopes to `tenantId`; `?tenantId=` synced for deep links; compact toolbar shows company name, balance due, standing chip.
- **All workspaces** (`adminScope === "GLOBAL"`): cross-tenant overview on `/admin/billing`; invoices/collections/reports use platform list APIs; `/admin/billing/payments` without `tenantId` shows **TransactionsTab** (aggregate). Deep links with `?tenantId=` still honored.
- **Removed:** billing companies rail, in-billing tenant search, duplicate tenant cards.

### Portal

- `useAdminBillingTenant.ts`, `AdminBillingShell.tsx` (full-width `billing-ws-shell--context-wide`), `billingPhase7.css`
- Overview global dashboard; payments global fallback; empty-state copy on methods/activity/settings

### Verification

| Check | Result |
|-------|--------|
| `pnpm --filter @connect/portal typecheck` | pass |

---

## 2026-05-17 — Admin billing payments operations workspace

**Task:** Redesign `/admin/billing/payments` into a tenant-scoped payment operations center (charge customer, cards on file, void/refund, dark finance UI).  
**Risk:** high (payments UX + surgical API; no billing math / IA / worker changes).

### Portal

- **`PaymentsWorkspace`** — `adminBillingPaymentsWorkspace.tsx`, `billingPayments.css`, `adminBillingPaymentDrawers.tsx`
- Summary chips, **Charge customer** drawer (one-time invoice + card on file / new card / invoice-only), cards grid, transaction table + **PaymentTransactionDrawer** (refund, retry, email payment link)
- **`/admin/billing/methods`** — Manage cards modal + link to payments
- Exported **`PaymentMethodsModal`** from `adminBillingOpsPanels.tsx`
- **`transactionFinanceStatusTone`**, VOIDED/REFUNDED labels in `billingUi.ts`

### API (surgical)

- `POST /admin/billing/platform/tenants/:tenantId/one-time-charges` — `createOneTimeChargeInvoice` (single `MANUAL_ADJUSTMENT` line, no usage/tax math)
- `POST /admin/billing/transactions/:id/refund` — SOLA `cc:refund` via `refundBillingTransaction`
- `chargeBillingInvoiceWithSut` — charge without persisting `PaymentMethod` when operator does not save card
- `GET /admin/billing/transactions/:id` — includes invoice activity events

### Known gap

- Successful **refund** updates `PaymentTransaction.status` only; invoice balance/status is not auto-reversed (documented in `BILLING.md`).

### Verification

| Check | Result |
|-------|--------|
| `pnpm run test:billing` (api) | 196 pass |
| `pnpm --filter @connect/portal typecheck` | pass (after CRM `CRMCard` close fix) |

---

## 2026-05-17 — portal: deploy blocker — CRM barrel exports (invoice UI not at fault)

**Task:** Unblock portal deploy after invoice UI commit `0c756ae` failed on server `next build`.  
**Risk:** low (portal barrel only; no billing/API/worker changes).

### Root cause

Deploy job **`de88bdba-5e18-4892-a28e-8f0292d259ad`** (portal, `0c756ae`) failed at TypeScript check:

- `contacts/[id]/page.tsx` imports `ContactContextBar`, `formatDate`, `stageLabel`, etc. from `components/crm`
- `campaigns` pages import `CampaignCommandHeader` and related symbols the same way
- At **`0c756ae`**, workspace modules under `apps/portal/components/crm/{contact,campaign,live}/` were **committed**, but **`components/crm/index.ts` did not re-export** `./contact`, `./campaign`, or `./live` — only queue + dashboard barrels were wired

The **billing invoice UI diff was valid**; the failure was a **missing CRM public barrel**, not invoice code.

### Fix (already on `billing/restore-platform-lifecycle`)

- **`50cd1fd`** — `export * from "./contact";`
- **`6e87303`** — `export * from "./contact"`, `export * from "./campaign"`, `export * from "./live";`
- Later CRM phase commits (`ae93716`, `cd86c45`) add campaign/live page wiring; HEAD includes invoice UI + fixes

### Verification

| Check | Result |
|-------|--------|
| `pnpm --filter @connect/portal typecheck` | pass @ `cd86c45` |
| `pnpm --filter @connect/portal build` | pass (local) |
| Portal deploy | **`70eac1f2-beea-426a-afd0-2fa005bb1cf8`** → `[deploy-portal] done cd86c45` |
| Invoice bundle (`billing-fin-chip`, `billing-fin-drawer`, `billing-fin-row`) | present in `app-portal-1` static chunks |

**No API, worker, Prisma, SOLA, or billing math changes.**

---

## 2026-05-17 — billing: premium invoice operations UI (portal)

**Task:** Redesign admin **Invoices** tab — finance-grade table rows, `BillingFinanceChip`, icon action menu, premium detail drawer, upgraded filter bar. **Portal only.**  
**Risk:** medium (UI only).

### What changed

- **`billingInvoices.css`**: `billing-fin-row`, `billing-fin-chip`, `billing-fin-menu`, `billing-fin-drawer`, `billing-fin-toolbar` — hover accent, tabular amounts, dark-native surfaces.
- **`BillingFinanceChip.tsx`**, **`InvoiceRowMenu.tsx`**: refined status pills + compact ⋯ menu (send, payment link, retry, mark paid, PDF, SMS, void, activity).
- **`adminBillingOpsPanels.tsx`**: clickable rows open drawer; filter pills use human labels (`Pending` for OPEN); drawer hero + sectioned line items / payments / activity.
- **`billingUi.ts`**: `invoiceFinanceStatusTone`, `invoiceFilterStatusLabel`.

**No API, Prisma, worker, or billing math changes.**

### Deploy verification (portal bundle)

```bash
docker exec app-portal-1 sh -c 'grep -rl billing-fin-chip /app/apps/portal/.next/static 2>/dev/null | head -1'
docker exec app-portal-1 sh -c 'grep -rl billing-fin-drawer /app/apps/portal/.next/static 2>/dev/null | head -1'
docker exec app-portal-1 sh -c 'grep -rl billing-fin-row /app/apps/portal/.next/static 2>/dev/null | head -1'
```

---

## 2026-05-17 — billing: admin pricing page SaaS redesign (portal)

**Task:** Redesign **`/admin/billing/settings?billingSection=plans-pricing`** into a dark-native SaaS pricing workspace — plan card, override summary, four rate cards, compact overrides table, collapsed **Advanced pricing details**. **Portal only.**  
**Risk:** medium (UI/copy only).

### What changed

- **`AdminPricingWorkspace.tsx`** + **`billingPricing.css`**: pricing page layout (`billing-pricing-*`), edit-pricing modal, virtual extension **planned** card (no separate API field yet).
- **`settings/page.tsx`**: pricing section uses workspace; tax/autopay/billing cycle moved to **Taxes & invoices** via **`AdminTenantBillingCycleForm`**; compact section tabs on all three settings areas.
- **`tenantBillingConfigForms.tsx`**: **`AdminTenantBillingCycleForm`**; **`AdminCurrentBillingPlanAssignCard`** supports **`embedded`** + **Change plan** modal from workspace.
- **`billingUi.ts`**: **Standard pricing** label (display only).
- **No API, Prisma, worker, or billing math changes.**

### Deploy verification (portal bundle)

```bash
docker exec app-portal-1 sh -c 'grep -o billing-pricing-rate /app/apps/portal/.next/static/chunks/*.js | head -1'
docker exec app-portal-1 sh -c 'grep -o billing-pricing-advanced /app/apps/portal/.next/static/chunks/*.js | head -1'
docker exec app-portal-1 sh -c 'grep -o "Virtual extensions" /app/apps/portal/.next/static/chunks/*.js | head -1'
```

---

## 2026-05-17 — billing: admin portal operational polish (Phase 9)

**Task:** Billing workspace operational refinement — speed, responsiveness, perceived performance, drawer/skeleton polish. **Portal only.**  
**Risk:** medium (UI only).

### What changed

- **`billingPhase9.css`**: sticky filter toolbar, horizontal table scroll, shimmer table skeletons, dark-native overlay/drawer/modal, timeline day separators, responsive breakpoints (1280 / 1024 / 768).
- **`BillingTableSkeleton.tsx`**: invoice/tx loading placeholders (`billing-p8-skeleton`).
- **`BillingActivityList.tsx`**: day-grouped audit feed via **`groupBillingEventsByDay`** (`billingUi.ts`).
- **`adminBillingOpsPanels.tsx`**: faster search debounce (200ms), clear-search control, empty-search states, **`BillingTableSkeleton`** on invoices/payments load, invoice drawer uses **`billing-p8-drawer`** + **Escape** to close, theme modals (`billing-p8-modal--*`).
- **`billingWorkspaceSections.tsx`**: methods/activity aligned with Phase 8/9 components.
- **`layout.tsx`**: imports **`billingPhase9.css`**.

**Docs:** **`BILLING.md`**, **`BILLING_UX_OVERHAUL_PHASE1_IA.md`**, **`CHANGELOG_AI.md`**, **`DEBUGGING.md`**.

### What was NOT changed

- Billing **IA** (no nav/route restructure), **API**, Prisma, worker, SOLA, telephony, mobile, CRM.

### Deploy verification (portal bundle)

```bash
docker exec app-portal-1 sh -c 'grep -o billing-p8-skeleton /app/apps/portal/.next/static/chunks/*.js | head -1'
docker exec app-portal-1 sh -c 'grep -o billing-inv-toolbar--sticky /app/apps/portal/.next/static/chunks/*.js | head -1'
docker exec app-portal-1 sh -c 'grep -o billing-p8-drawer /app/apps/portal/.next/static/chunks/*.js | head -1'
```

---

## 2026-05-14 — billing: current-plan assignment + normalized pricing state

**Task:** SUPER_ADMIN **`assign-plan-preview`** / **`assign-current-plan`** routes (no invoices/charges), **`deriveBillingPricingState`** (`billingPricingState.ts`), **`pricingState`** on **`pricing-diagnostics`**, portal **Current Billing Plan** card + warnings banner + assign modal; audit **`billing_plan.current_assigned`**.  
**Risk:** medium (**tenant FK + optional metadata/prices**; invoice cent formulas unchanged).

### What changed

- **`billingPricingResolution.ts`**: **`activeBillingPlanRowForPeriod`** (same timing rule as previews/worker invoice period).
- **`invoiceEngine.ts`**: shared **`buildBillingInvoicePreviewWithLoadedSettings`** + **`buildBillingInvoicePreviewFromSettings`** for in-memory assign simulation (**math unchanged**).
- **`billingAssignment.ts`**: **`mergeTenantBillingSettingsForAssignPreview`**, **`validateCatalogBillingPlanForAssignment`**, **`tenantPricingQuadSnapshot`**.
- **`billingPricingState.ts`**: **`deriveBillingPricingState`**, **`billingPricingSettingsSliceFromLoaded`**.
- **`billingPricingDiagnostics.ts`**: adds **`pricingState`** to assembler output.
- **`routes.ts`**: **`GET …/assign-plan-preview`**, **`POST …/assign-current-plan`** (**SUPER_ADMIN**).
- **`billingPricingState.test.ts`**, **`billingAssignment.test.ts`**, updates to **`billingPricingDiagnostics.test.ts`**, **`billingPricingResolution.test.ts`**.
- **Portal:** **`tenantBillingConfigForms.tsx`** (**`AdminBillingPricingWarningsBanner`**, **`AdminCurrentBillingPlanAssignCard`**), **`settings/page.tsx`**.

**Docs:** **`BILLING.md`**, **`DATA_MODEL.md`**, **`CHANGELOG_AI.md`**.

### What was NOT changed

- **`apps/worker`**, SOLA/webhooks/charges/dunning, telecom/PBX/mobile/CRM; **`PARTIALLY_PAID`** not implemented.
- Invoice **subtotal/discount/tax/total** arithmetic semantics unchanged (**only** preview builder refactor + optional snapshot input).

### Deploy

- **API** + **portal**.

### Verification

```bash
pnpm --filter @connect/api test:billing
pnpm --filter @connect/api typecheck
pnpm --filter @connect/portal typecheck
```

---

## 2026-05-14 — billing: pricing diagnostics, preview explanation fields, safeguards

**Task:** Pricing mode diagnostics (**GET** **`pricing-diagnostics`**), **`pricingPreviewExplanation`** on previews, **`billing.pricing_mode_changed`** + expanded **`billing.pricing_reset_to_plan`** audit metadata, portal warnings + reset diff UX.  
**Risk:** medium (**read-only diagnostics** / operator logs; **`invoiceEngine`** line-discount-tax math untouched).

### What changed

- **`billingPricingExplanation.ts`** (already landed): **`buildPricingPreviewExplanation`** — derives structured explanation from resolved pricing (**no cents math**).
- **`billingPricingDiagnostics.ts`**: **`buildTenantPricingDiagnosticsFromPreview`** (**warnings/notices**, **`differsFromPlan`**, **`resetToPlanPreview`**).
- **`billingTenantSettingsMetadata.ts`**: **`mergeTenantBillingSettingsMetadata`** for PUT-merge parity tests.
- **`routes.ts`**: **`GET …/pricing-diagnostics`**; **`PUT …/settings`** logs **`billing.pricing_mode_changed`** when normalized mode differs; **`POST …/pricing/reset-to-plan`** returns **`pricingResetSummary`** + logs **`before`/`after`**.
- **`billingPricingDiagnostics.test.ts`**: assembler + merge + SUPER_ADMIN gate coverage.
- **`settings/page.tsx`**, **`tenantBillingConfigForms.tsx`**: shared UTC preview period, diagnostics card, invoice preview explanation block, readable reset diff table (**JSON** collapsible).

**Docs:** **`BILLING.md`**, **`DATA_MODEL.md`**, **`CHANGELOG_AI.md`**.

### What was NOT changed

- **`apps/worker`**, SOLA webhook/charge handlers, telecom/PBX/mobile/CRM surfaces, **`createBillingInvoice`** cent formulas (beyond existing resolver wiring).
- No Prisma migrations.

### Deploy

- **API** + **portal** (same train recommended).

### Verification

```bash
pnpm --filter @connect/api test:billing
pnpm --filter @connect/api typecheck
pnpm --filter @connect/portal typecheck
```

---

## 2026-05-14 — billing: explicit pricing mode (`metadata.billingPricingMode`)

**Task:** tenant billing unit pricing resolution (legacy vs catalog vs custom), admin UI + previews  
**Risk:** medium (invoice **preview** math and admin settings; persisted invoices unchanged until next create with new settings)

### What changed

- **`apps/api/src/billing/billingPricingResolution.ts`:** `parseBillingPricingMode`, `legacyResolveCents`, **`resolveTenantBillingPricing`**, **`buildTenantSettingsResetToCatalog`** (reset payload helper).
- **`apps/api/src/billing/invoiceEngine.ts`:** uses resolver for previews/creates feeding the engine; attaches **`pricingResolution`** on **`buildBillingInvoicePreview`** responses.
- **`apps/api/src/billing/routes.ts`:** **`PUT …/settings`** accepts **`billingPricingMode`** (**merge** **`metadata`**); **`POST …/pricing/reset-to-plan`** resets four fields + catalog mode + audit log type **`billing.pricing_reset_to_plan`**.
- **`apps/api/src/billing/billingPricingResolution.test.ts`**, **`invoiceEngine.test.ts`:** legacy/catalog/custom pricing, scheduled catalog month, reset payload helper; existing test still asserts previews never call **`billingInvoice.create`**.

**Portal:** **`tenantBillingConfigForms.tsx`** (**`AdminTenantPricingSourceCard`** + catalog-locked **`AdminTenantMonthlyPricingForm`**), **`settings/page.tsx`** (card + **`pricingResolution`** preview banner), **`admin/billing/page.tsx`** overview preview banner.

**Docs:** **`BILLING.md`**, **`DATA_MODEL.md`**, **`CHANGELOG_AI.md`**.

### What was NOT changed

- **No Prisma migration** (metadata-only).
- **`apps/worker`** not modified for this feature (worker uses the shared **`invoiceEngine`** module when redeployed with API).
- SOLA webhook, charge amounts, **`PARTIALLY_PAID`**, proration.

### Deploy

- **API** + **portal** (same release recommended).

### Verification

```bash
pnpm --filter @connect/api test:billing
pnpm --filter @connect/api typecheck
pnpm --filter @connect/portal typecheck
```

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
