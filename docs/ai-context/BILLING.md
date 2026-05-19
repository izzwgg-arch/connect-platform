# Billing — quick reference

> Read `CURSOR_START_HERE.md` first. High-risk: payments and invoices.

## Canonical production hostname

- **Portal + same-origin API:** `https://app.connectcomunications.com` (browser calls `/api/...` on that host unless `NEXT_PUBLIC_API_URL` overrides in a custom build).
- **Avoid typo domains** such as `app.connect.communications.com` (extra dot — *connect.communications*) — they are **not** the production app and cause confusing auth, API origin, or caching issues.

**Operator smoke, capture list for incidents, caps, dangerous actions:** see **`docs/ai-context/BILLING_OPERATOR_RUNBOOK.md`**.

## Two billing HTTP stacks (do not mix accidentally)

| Stack | Location | Typical paths |
|-------|----------|----------------|
| **Current platform billing (`BillingInvoice`)** | `apps/api/src/billing/routes.ts` | Tenant: `/billing/settings`, **`/billing/platform/invoices`** (`/billing/invoice-preview`, payment methods, etc.). Admin: **`/admin/billing/...`** (invoices, reports, collections, platform tenants, catalog plans). |
| **Legacy (subscription-era) routes** | `apps/api/src/server.ts` (grep `app.get/post("/billing/`)`) | Older **`/billing/invoices`**-style endpoints **without** **`/platform/`**. Still present; **not** interchangeable with **`BillingInvoice`**. |

Portal UIs documented in this file use the **`BillingInvoice`** stack unless noted otherwise. Future changes: extend **`billing/routes.ts`** for new platform billing behavior; do not “fix” admin invoice UI by editing legacy **`server.ts`** handlers unless deliberately migrating a path. **`KNOWN_ISSUES.md`** § Billing calls this **dual billing surfaces**.

## Portal UX phases (display only)

- **Phase 3 (2026-05):** Admin billing shell + company workspace layout; calmer invoices register (View + More actions); humanized pricing mode labels (`billingUi.ts`).
- **Phase 4 (2026-05):** Guided **`BillingActionPanel`** drawers for collect/retry pay, mark paid, void, remove card, collections “do not auto-charge”, assign plan, reset-to-plan; **`BillingActivityList`** + humanized **`billingEventLabel`** / **`billingEventIcon`** for audit text; operational **`BillingEmptyState`** blocks; **`billingPhase4.css`** table/timeline polish. **No** API, Prisma, worker, or invoice-engine changes in this phase.
- **Phase 7–8 (2026-05):** Dedicated admin billing routes (`/admin/billing/invoices`, `/payments`, `/methods`, `/collections`, `/reports`, `/activity`); compact segmented workspace nav; SaaS-style invoice/payment row grids; dark-native surfaces (`billingPhase7.css`, `billingPhase8.css`); pill filters; sticky table headers; **`BillingEmptyState`** refresh.
- **Tenant context (2026-05-17):** Admin Billing uses the **global workspace switcher** only — no in-billing company rail. **Tenant scope** → `useAdminBillingTenant` drives `effectiveTenantId` from `useAppContext` (URL synced by shell for deep links). **All list/report APIs** receive `?tenantId=` when scoped: `GET /admin/billing/invoices`, `/transactions`, `/collections/overview`, `/collections/preview-retries`, `/reports/aging`, `/reports/failed-payments` (+ CSV exports). **All workspaces** → omit `tenantId` for cross-tenant data; tenant-only pages (methods, activity, charge customer) require a selected workspace or deep link.
- **Invoice operations polish (2026-05-17):** **`billingInvoices.css`** + **`BillingFinanceChip`** + **`InvoiceRowMenu`** — finance-grade invoice rows (clickable, tabular amounts, glow hover), compact ⋯ actions, premium drawer sections (`billing-fin-drawer`). Portal display only.
- **Payments operations workspace (2026-05-17):** `/admin/billing/payments` — tenant-scoped **PaymentsWorkspace** (`adminBillingPaymentsWorkspace.tsx`, `billingPayments.css`, `adminBillingPaymentDrawers.tsx`): summary chips, **Charge customer** one-time flow, card-on-file grid, premium transaction table + side drawer. API: `POST /admin/billing/platform/tenants/:tenantId/one-time-charges`, `POST /admin/billing/transactions/:id/refund`, `createOneTimeChargeInvoice`, `chargeBillingInvoiceWithSut`, `refundBillingTransaction`. SOLA iFields unchanged. **Gap:** full refund does not auto-reopen invoice balance (transaction status only).
- **Phase 9 (2026-05):** Operational speed + perceived performance (**no IA change**). **`billingPhase9.css`**: sticky filter toolbar (`billing-inv-toolbar--sticky`), horizontal table scroll (`billing-p8-table-scroll`), table-shaped **`BillingTableSkeleton`**, theme-native invoice drawer (`billing-p8-overlay` / `billing-p8-drawer`), search clear + 200ms debounce, empty-search copy, activity timeline day groups (`groupBillingEventsByDay` in `billingUi.ts`), responsive breakpoints (1280 / 1024 / 768). **Escape** closes invoice detail drawer.
- **Production readiness — taxes, cards, schedules, past-due (2026-05-18):**
  - **Tax estimate fix (A):** `buildBillingInvoicePreviewWithLoadedSettings` now returns `taxableSubtotalCents` in `BillingInvoicePreview`. Portal tax estimate page (`AdminTaxesFeesWorkspace`) prefers this API field; falls back to flat-rate + quantity calculation for tenants without live extensions.
  - **Add-card error message fix (B):** `adminBillingOpsPanels.tsx` and `adminBillingPaymentDrawers.tsx` distinguish "gateway enabled but iFields key missing" from "gateway not configured" — guides operator to the exact missing field.
  - **Sola schedule visibility fix (C):** New `SolaLinkedSchedulesSection` component in `billingWorkspaceSections.tsx` shows mapped external schedules (status, masked card, amount, frequency, next run) on both the Methods page and Payments workspace. Read-only — no Connect charges implied.
  - **Billing schedule override (D):** `TenantBillingSettings.metadata.billingScheduleOverride` (`BillingScheduleOverride` type in `billingTenantSettingsMetadata.ts`) stores `nextPaymentDate`, `skipNextPayment`, `skipReason`, `updatedBy`, `updatedAt`. `PUT /admin/billing/tenants/:tenantId/settings` accepts and validates the new field. `BillingScheduleOverrideCard` in `adminBillingPaymentsWorkspace.tsx` provides operator UI. Worker behavior **unchanged** — stores/displays only.
  - **Past-due billing workflow (E):** `PastDueBillingPanel` in `adminBillingPaymentsWorkspace.tsx` guides operators through prior-period or custom invoice creation. Pre-fills `OneTimeChargeDrawer` (which gained `initialDescription`, `initialAmountCents`, `initialChargeMode` props). No automatic charges — full confirmation required.
- **Jurisdiction tax auto-suggestions (2026-05-18):** `apps/portal/lib/billingTaxSuggestions.ts` — `NY_ORANGE_COUNTY_TAX_TEMPLATE` (sales 8.125%, E911 $3.00 flat monthly, regulatory 1.000%, USF off, surcharge off), `detectJurisdictionFromTenant` (checks TaxProfile → serviceAddress → billingAddress → known Orange County cities). `AdminTaxesFeesWorkspace` shows a "Jurisdiction quick-start" panel with auto-detected label, template selector, and "Apply suggested" button. Applying pre-fills all fee cards, enables taxes, marks as unsaved. "Last applied from: …" chip shown after applying. Disclaimer: "Suggested starting rates only. Confirm with your tax advisor." Also fixed `defaultFeesFromTaxProfile` E911 basis from `per_did` → `flat_monthly`. API unchanged.

### Admin billing workspace routes (current)

| Route | Panel / purpose |
|-------|-----------------|
| `/admin/billing` | Company overview (summary; generation actions) |
| `/admin/billing/invoices` | Invoice register + row actions + detail drawer |
| `/admin/billing/payments` | **Payment operations workspace** — summary chips, charge customer (one-time), cards on file, transaction table + detail drawer (refund/retry/email link) |
| `/admin/billing/methods` | Saved cards + autopay summary |
| `/admin/billing/collections` | Retry queue overview + next-sweep preview |
| `/admin/billing/reports` | CSV exports + aging / failed-payment reports |
| `/admin/billing/activity` | Per-invoice activity timelines |
| `/admin/billing/settings` | Pricing, SOLA, collections config (`billingSection` query) |
| `/admin/billing/plans` | Catalog BillingPlan CRUD |
| `/admin/billing/sola-imports` | **Sola recurring schedule import** — read-only sync + operator tenant mapping (Phase B; no charges) |

Shell: **`AdminBillingShell`** + CSS scopes **`billing-ws-scope`**, **`billing-p8-scope`**. Ops tables: **`adminBillingOpsPanels.tsx`** (`InvoicesTab`, `TransactionsTab`, `ReportsTab`, `CollectionsTab`).

## Where the code lives

| Concern | Location |
|--------|----------|
| Tenant + platform REST (`registerBillingRoutes`) | `apps/api/src/billing/routes.ts` |
| JWT role gates for those routes | `apps/api/src/billing/billingAuth.ts` |
| Invoice preview / create (+ discount line, pricing modes + **preview explanations**) | `apps/api/src/billing/invoiceEngine.ts` |
| Tenant extensions **flat monthly rate** (metadata; invoice line builder) | `apps/api/src/billing/billingFlatRate.ts` |
| Tenant **billing quantity overrides** (auto vs manual per line) | `apps/api/src/billing/billingQuantityOverrides.ts` |
| Local vs **toll-free DID** classification (NANP NPA on E.164) | `apps/api/src/billing/billingPhoneNumbers.ts` |
| Tenant **toll-free DID unit price** (`metadata.billingTollFreeDidPriceCents`) | `apps/api/src/billing/billingTollFreePricing.ts` |
| Pricing preview explanations (derived only; **no totals math**) | `apps/api/src/billing/billingPricingExplanation.ts` |
| Tenant pricing mode resolver + reset payload helpers | `apps/api/src/billing/billingPricingResolution.ts` |
| Assembler for **pricing-diagnostics** (warnings + differsFromPlan + reset preview + **`pricingState`**) | `apps/api/src/billing/billingPricingDiagnostics.ts` |
| Normalized **`deriveBillingPricingState`** (modes, FK vs scheduled active plan, warnings) | `apps/api/src/billing/billingPricingState.ts` |
| Assign-plan simulation helpers (merge snapshot; catalog-plan guards) | `apps/api/src/billing/billingAssignment.ts` |
| Settings **metadata merge** (`taxProviderId` + `billingPricingMode`) | `apps/api/src/billing/billingTenantSettingsMetadata.ts` |
| Tax profiles (sales / E911 / regulatory math) | `apps/api/src/billing/taxes.ts` |
| Tax provider abstraction + audit snapshot shape | `apps/api/src/billing/taxProvider.ts` |
| SOLA adapter selection (per-tenant vs env) | `apps/api/src/billing/solaGateway.ts` |
| Public billing URLs (SOLA webhook) | `apps/api/src/billing/solaPublicUrls.ts` |
| Token charges, hosted session helper, webhook apply + dedupe | `apps/api/src/billing/solaBillingPayments.ts` |
| Cardknox client (`gatewayjson`, parse/verify) | `packages/integrations/src/sola-cardknox/index.ts` |
| Cardknox Recurring API client (read-only list/get) | `packages/integrations/src/sola-cardknox/recurring.ts` |
| Sola external schedule sync + mapping (Phase B) | `apps/api/src/billing/solaExternalSchedules.ts` |
| Admin Sola imports UI | `apps/portal/app/(platform)/admin/billing/sola-imports/page.tsx` |
| Legacy + subscription + `POST /webhooks/sola-cardknox` | `apps/api/src/server.ts` (large file — grep paths) |
| Invoice email lifecycle (queue, dedupe, URLs) | `apps/api/src/billing/billingEmailLifecycle.ts` |
| Autopay dunning metadata + retry picker | `apps/api/src/billing/billingDunning.ts` |
| HTML email bodies (billing) | `apps/api/src/billing/emailTemplates.ts` |
| Monthly autopay + dunning sweep | `apps/worker/src/main.ts` (`runMonthlyBillingAutomation`, `runBillingDunningRetries`, `chargeWorkerInvoice`) |
| Platform admin billing UI (overview) | `apps/portal/app/(platform)/admin/billing/page.tsx` |
| Platform admin billing catalog (BillingPlan CRUD) | `apps/portal/app/(platform)/admin/billing/plans/page.tsx` |
| Platform admin invoices & payments UI (invoices + transactions + reports + collections) | `apps/portal/app/(platform)/admin/billing/invoices/page.tsx` |
| Platform admin company billing setup UI (settings) | `apps/portal/app/(platform)/admin/billing/settings/page.tsx` |
| Nav visibility for Admin Billing | `apps/portal/navigation/navConfig.ts` → `isNavItemVisibleForUser` |
| Tenant billing settings UI (shared) | `apps/portal/app/(platform)/billing/TenantBillingSettingsContent.tsx` |
| Admin per-tenant config forms (pricing, branding, SOLA) | `apps/portal/app/(platform)/admin/billing/_components/tenantBillingConfigForms.tsx` |

## Auth rules (JWT `UserRole`, not only portal permissions)

1. **Tenant routes** under `apps/api/src/billing/routes.ts` (`/billing/settings`, `/billing/platform/*`, `/billing/payment-methods`, …): allowed DB roles are **`SUPER_ADMIN`, `TENANT_ADMIN`, `ADMIN`, `BILLING_ADMIN`, `BILLING`** — aligned with `canManageBilling()` in `server.ts`. Portal must still pass prefix permission `can_view_billing_overview` (see `PORTAL_API_PERMISSION_RULES` in `server.ts`).

2. **Platform admin routes** (`/admin/billing/*` in the same file): **`SUPER_ADMIN` only** inside the route handler. Portal: **Admin Billing** and **Company billing setup** nav and **`/admin/billing`** / **`/admin/billing/settings`** pages require **`backendJwtRole === "SUPER_ADMIN"`** and `can_view_admin_billing`. The admin billing area uses a shared shell with **`?tenantId=`** (and **`opsTab`** / **`billingSection`** query params) so operators keep company context while switching pages. **Phase 3 (2026-05) portal UX:** `/admin/billing` is a **company summary dashboard** (snapshot, health cards, five primary actions); **Invoices & payments** lists use **View** plus a **More actions** menu for email / charge / mark paid / PDF / void / SMS; pricing copy uses **`humanizeStoredPricingMode`** / **`humanizePricingStateMode`** in `apps/portal/lib/billingUi.ts` (display only — API field names unchanged).

## Tests

```bash
cd apps/api && pnpm run test:billing
```

Uses Node’s **`--experimental-test-module-mocks`** (see `apps/api/package.json` `test:billing`) so `invoiceEngine.test.ts` can mock `@connect/db`.

## Tax profiles, tax provider, and audit (not legal advice)

- **Configurable rates:** `TaxProfile` rows drive **sales tax**, **E911 per extension**, and **regulatory %** via `calculateTaxLines` in `taxes.ts`. Admins assign a profile on **TenantBillingSettings.taxProfileId**. **Orange County NY, VoIP, or any jurisdiction:** actual telecom tax and fee rules must be validated with a qualified accountant or telecom tax vendor — Connect does not ship verified jurisdiction tables.
- **Provider abstraction:** `taxProvider.ts` defines `TaxProvider.calculateTaxes` → line items + **`TaxCalculationAuditSnapshot`**. Default implementation **`tax_profile_v1`** wraps the existing profile math (no breaking change). **`external_telecom_stub`** returns **no** tax lines and exists only as a hook for a future external engine adapter.
- **Settings:** **`TenantBillingSettings.metadata.taxProviderId`** (`tax_profile_v1` \| `external_telecom_stub`). Optional env override: **`BILLING_TAX_PROVIDER`** (same values). Admin UI: **Admin Billing** → tenant → Monthly Pricing (notice + provider select).
- **Audit trail:** Each **`BillingInvoice`** stores **`metadata.taxCalculationAudit`** (JSON) at creation: provider id/version, `computedAt`, tax enabled flag, `taxProfileId`, jurisdiction summary from the profile, taxable inputs, calculated line summaries, optional notes (e.g. missing profile, stub). **Dunning** still uses **`metadata.dunning`**; merges preserve `taxCalculationAudit` (`billingDunning.ts` spreads root metadata).
- **Invoice lines:** Tax/fee rows are normal **`BillingInvoiceLineItem`** rows; provider stamps **`metadata.taxProviderId`** on profile-driven tax lines for traceability.

## Tenant pricing mode (`TenantBillingSettings.metadata.billingPricingMode`)

- **Legacy (default):** Key absent or `null`. Matches historic behavior: **cent fields** use **`settings ||`** effective **`BillingPlan` for the invoice period **`||`** platform defaults (**`||`** chain — tenant **`0`** still falls through). **`firstPhoneNumberFree`** is taken only from the tenant row (**`!== false`** means first number free).
- **Catalog (`"catalog"`):** All four unit-pricing inputs (**extension**, **additional phone**, **SMS**, **`firstPhoneNumberFree`**) come from the **effective plan for that period**: current **`billingPlan`**, or **`nextBillingPlan`** when the preview/run period **`periodStart` ≥ `nextBillingPlanEffectiveAt`**. Missing plan in catalog uses hard-coded fallback rates ( **`pricingResolution.missingCatalogPlan`** on preview ).
- **Custom (`"custom"`):** All four fields use **`TenantBillingSettings`** columns only; linked plan is informational for badges/overlap warnings.

**Preview:** **`buildBillingInvoicePreview`** returns **`pricingResolution`** (**mode**, **`fieldBadges`**, **`banner`**, plan names). It also returns **`pricingPreviewExplanation`** (**`pricingMode`**, **`effectiveSource`**, **`activePlanId`** / **`activePlanName`**, **`tenantOverridesDetected`**, **`scheduledPlanApplies`**, **`scheduledPlanSummary`**, **`explanationLines[]`**) — human-readable diagnostics only (no SOLA payloads; cents still come strictly from **`resolveTenantBillingPricing`** + invoice line builders).

**GET** **`/admin/billing/platform/tenants/:tenantId/pricing-diagnostics`** (**SUPER_ADMIN**): same **`periodMonth` / `periodYear`** query knobs as **`invoice-preview`**. Returns assembled **`warnings[]`**, **`notices[]`**, tenant vs catalog vs effective **`differsFromPlan`**, scheduled plan slice, **`resetToPlanPreview`**, echoes **`pricingPreviewExplanation`**, and **`pricingState`** (**`deriveBillingPricingState`** — mode, current vs effective plan for period, **`effectivePricingSource`**, **`resolution`**, **`flags`**, **`warnings`**, **`explanationLines`**).

**Assign current catalog plan (SUPER_ADMIN):**

- **`GET …/assign-plan-preview?billingPlanId=&periodMonth=&periodYear=&copyPlanPrices=&applyPricingMode=`** — read-only; compares **`pricingState`** / tenant quad / invoice totals **before vs after** simulation (**no DB writes**).
- **`POST …/assign-current-plan`** — body **`{ billingPlanId, applyPricingMode?: "catalog"|"custom", copyPlanPrices?: boolean }`**. Requires **catalog** **`BillingPlan`** (**`tenantId` null**) and **`active`**. Updates **`billingPlanId`** immediately; optionally copies four price columns; optionally merges **`metadata.billingPricingMode`**; **does not** clear or rewrite **`nextBillingPlan*`**; logs **`billing_plan.current_assigned`** with **`operatorUserId`**, **`before`/`after`** pricing quad + stored mode (**no invoice**, **no charge**).

**API:** **`PUT /admin/billing/tenants/:tenantId/settings`** — optional **`billingPricingMode`** (**`catalog` \| `custom` \| `null`** to clear). When the **resolved** normalized mode (**`legacy`** when key absent)** changes**, logs **`billing.pricing_mode_changed`** with **`operatorId`** (JWT **`sub`**), **`fromMode`**, **`toMode`**, and stored **`metadata.billingPricingMode`**. **`POST /admin/billing/platform/tenants/:tenantId/pricing/reset-to-plan`** — copies four price fields from the tenant's **current** **`billingPlan`** (**scheduled next plan is ignored**), sets mode to **`catalog`**, responds with **`billingSettings`** + **`pricingResetSummary`** (`before`/`after` pricing snapshots), logs **`billing.pricing_reset_to_plan`** (**`metadata.operatorId`**, **`before`**, **`after`**) (**`400`** if no **`billingPlanId`**).

Merge helpers for deterministic tests/admin parity: **`mergeTenantBillingSettingsMetadata`** in **`billingTenantSettingsMetadata.ts`**.

## Tenant extensions flat monthly rate (`TenantBillingSettings.metadata.billingFlatRate`)

Negotiated **one monthly charge for all billable extensions** (e.g. $500/mo for any extension count). **No Prisma migration** — JSON metadata only. **Real invoice math** in preview + create (not UI-only).

| Field | Type | Notes |
|-------|------|--------|
| `enabled` | `boolean` | When `true` and `amountCents ≥ 1`, flat rate applies |
| `amountCents` | `number` | Whole cents; rejected on save if enabled with `< 1` |
| `label` | `string?` | Optional line description prefix (max 120 chars) |
| `appliesTo` | `"extensions"` | Only scope implemented today |

**Invoice engine (`buildExtensionInvoiceLine` in `billingFlatRate.ts`, called from `invoiceEngine.ts`):**

- When active and **`usage.extensionCount > 0`**: one **`EXTENSION`** line — **`quantity: 1`**, **`unitPriceCents` = `amountCents`**, **`amountCents` = flat amount** (not × extension count).
- Description default: **`Extensions flat monthly rate (N active extension(s))`**; line **`metadata`**: `flatRate: true`, `flatRateAmountCents`, `extensionCount`, `extensionIds`.
- When flat rate off or zero extensions: unchanged per-extension math (`quantity = extensionCount`, `unitPriceCents` from pricing resolution).
- **E911 / tax:** `extensionCount` for tax provider input still comes from **`calculateTenantBillingUsage`** — flat rate does **not** reduce E911 quantity.
- **Discount:** flat extension amount is a normal taxable service line; percent discount applies to service subtotal as before.

**API:** **`PUT /admin/billing/tenants/:tenantId/settings`** — optional **`billingFlatRate`** object (same shape as metadata). **`400 invalid_billing_flat_rate`** when enabled without a positive amount. **`reset-to-plan`** does **not** clear flat rate (tenant-specific deal).

**Portal:** Plans & pricing → **Flat monthly rate for extensions** card (toggle, amount, helper copy, live estimate chip **Flat rate**); overrides table row **Extensions / Flat monthly rate / $X/month / Covers N active extensions**. Estimate uses flat cents when enabled (`billingUi.ts`).

**Explicitly unchanged:** SOLA charge execution, payment execution, Cardknox/iFields, worker dunning logic (worker rebuild only if it bundles updated `invoiceEngine`).

## Tenant billing quantity overrides (`TenantBillingSettings.metadata.billingQuantityOverrides`)

Per-line **suggested** (from `calculateTenantBillingUsage`) vs **billing** quantity (what invoices use).

| Key | Auto suggested | Manual billing quantity means |
|-----|----------------|------------------------------|
| `extensions` | Active billable extensions | Billable extension count (flat rate still emits qty `1` line; E911/tax use billing extension count) |
| `virtualExtensions` | `0` (not tracked in system) | Billable virtual extension count — invoice line type **`EXTENSION`** with description **Virtual extensions** and `metadata.lineItemKind: "virtual_extensions"` (no Prisma enum migration) |
| `phoneNumbers` | Billable **local** DIDs after first-free | Billable local phone number count (manual `4` bills 4 even if system suggests `2`) |
| `tollFreeNumbers` | All active toll-free DIDs (no first-free) | Billable toll-free count |
| `smsPackages` | `0` or `1` from SMS flags | Billable SMS package count |

Shape: `{ extensions?: { mode: "auto"|"manual", quantity: number|null }, … }`. **`PUT …/settings`** accepts **`billingQuantityOverrides`**; **`400 invalid_billing_quantity_overrides`** on invalid manual qty. Merge preserves **`billingFlatRate`**, **`billingPricingMode`**, etc.

**Worker / preview / create:** `resolveBillingQuantities` in `invoiceEngine.ts` before line builders — same path for monthly worker (`createBillingInvoice` → preview).

## Local vs toll-free phone numbers (billing)

**Detection:** `PhoneNumber` has no stored toll-free flag. `billingPhoneNumbers.ts` classifies active rows by **NANP toll-free NPA** on E.164 (`+1` then `800|833|844|855|866|877|888`). Purchase APIs use provider `type: "local"|"tollfree"` but do not persist type on the row.

**Usage (`calculateTenantBillingUsage`):** `localPhoneNumberCount`, `tollFreePhoneNumberCount`, billable counts/ids. **`firstPhoneNumberFree`** reduces billable **local** count only (minimum 0); every active toll-free DID is billable.

**Pricing:** Local unit price = `additionalPhoneNumberPriceCents` (plan/settings). Toll-free = `metadata.billingTollFreeDidPriceCents` when set, else local price, else default **1500¢**. Settings PUT: optional **`tollFreeDidPriceCents`**.

**Quantity overrides:** `phoneNumbers` = local billable qty; `tollFreeNumbers` = toll-free billable qty. Both keys must be accepted by `validateBillingQuantityOverridesInput` and `parseBillingQuantityOverrides` (`BILLING_QUANTITY_OVERRIDE_KEYS` in `billingQuantityOverrides.ts`) — omitting `tollFreeNumbers` from those loops caused manual toll-free qty to be stripped on save (fixed 2026-05-17).

**Invoice lines:** Both use `BillingLineItemType.PHONE_NUMBER` with `metadata.lineItemKind`:
- `local_phone_numbers` — description **Local phone numbers**
- `toll_free_phone_numbers` — description **Toll-free phone numbers** (omitted when qty 0)

**Portal:** Plans & pricing — separate **Local phone numbers** and **Toll-free phone numbers** cards; monthly estimate and overrides table list both lines.

**Portal:** Plans & pricing cards show **Suggested**, **Auto/Manual**, editable **Billing quantity**, chips **Auto** / **Manual override**; live estimate uses billing quantities.

**Portal:** **`/admin/billing/settings?billingSection=plans-pricing`** — **`AdminPricingWorkspace`** (2026-05-17, operational redesign): compact **billing profile** strip (plan, pricing mode, account standing, estimated monthly total, autopay); **billing items grid** with per-line quantity + unit price + monthly subtotal; **live monthly estimate** panel; compact **price overrides** table; **Advanced** (`<details>`, collapsed) for diagnostics + reset. **Change plan** via header + embedded **`AdminCurrentBillingPlanAssignCard`**. Sticky **Save pricing** bar when dirty. **Taxes & invoices** tab: **`AdminTenantBillingCycleForm`** + invoice branding.

**Quantity sources:**

| Line item | Suggested (auto) | Operator control |
|-----------|------------------|------------------|
| Extensions | `calculateTenantBillingUsage` — active billable extensions | **Auto** or **Manual** billing quantity (`metadata.billingQuantityOverrides`) |
| Local phone numbers | Active local DIDs; billable = total minus first-free when enabled | **Auto** or **Manual** billable local count (`phoneNumbers` override key) |
| Toll-free phone numbers | Active toll-free DIDs (all billable) | **Auto** or **Manual** billable toll-free count (`tollFreeNumbers` override key) |
| SMS package | `0` or `1` from SMS flags / `smsBillingEnabled` | **Auto** or **Manual** package count; SMS enabled toggle still affects auto suggestion |
| Virtual extensions | `0` (not tracked in system) | **Manual** quantity only — separate invoice line at extension unit price |

Monthly estimate uses **`computeTenantMonthlyEstimate`** with **billing** quantities (aligned with invoice engine when overrides saved).

## Admin Taxes & fees workspace (Phase A — 2026-05-17)

**Route:** `/admin/billing/settings?billingSection=tax-billing` — **`AdminTaxesFeesWorkspace`**.

**Scope:** Taxes, telecom fees, E911, regulatory charges, customer-visible preview, estimated taxes/fees panel. **Not** billing cycle, branding, payment terms, or gateway (moved to **`invoice-billing`** tab).

**Metadata:** `TenantBillingSettings.metadata.billingTelecomFees` — per-fee `enabled`, `customerVisible`, `label`, `mode` (`ratePercent` | `amountCents`), `basis`, rates/amounts. Validated on **`PUT …/settings`** (`invalid_billing_telecom_fees`). Code: `apps/api/src/billing/billingTelecomFees.ts`.

**Invoice engine today:** `calculateTaxLines` / `TaxProfile` emit **SALES_TAX**, **E911_FEE**, **REGULATORY_FEE** when `taxEnabled` + profile assigned. Saving the workspace syncs those three fields onto the linked **shared** `TaxProfile` row. **Surcharge / USF / custom** are estimate-only until Phase B. **customerVisible** is honored in the admin preview panel only (not invoice PDF filtering yet).

**E911:** UI default suggestion **$3.00** per local DID (NY/Orange suggested chip). Invoice math uses `e911FeePerExtension × extensionCount` via TaxProfile until Phase B basis expansion.

**Disclaimer copy:** Suggested rates are not legal advice; confirm with a tax advisor.

## Customer billing portal — page inventory

Customer-facing pages under `apps/portal/app/(platform)/billing/`. All use tenant routes (`/billing/…`) only.

| Page | Route | Permission | Key API calls |
|------|-------|------------|---------------|
| Dashboard | `/billing` | `can_view_billing_overview` | `GET /billing/settings`, `GET /billing/platform/invoices` |
| Invoice list | `/billing/invoices` | `can_view_billing_invoices` | `GET /billing/platform/invoices` |
| Invoice detail | `/billing/invoices/:id` | `can_view_billing_invoices` | `GET /billing/platform/invoices/:id`, `POST .../pay`, `.../email-invoice`, `.../email-payment-link` |
| Payment methods | `/billing/payments` | `can_view_billing_payments` | `GET /billing/payment-methods`, `POST .../sola/save`, `POST .../:id/default`, `DELETE .../:id`, `GET /billing/sola/public-config` |
| Receipts | `/billing/receipts` | `can_view_billing_receipts` | `GET /billing/platform/invoices` |

### `/billing` — Dashboard
- **Failed payment banner**: shown when the worst open invoice is FAILED or OVERDUE. Includes "Pay now" + "Update payment method" links.
- **3-stat summary**: Balance due (red when > 0) · Autopay (day or Off) · Default card (On file or None + Add link).
- **Unpaid callout**: first 4 unpaid invoices listed with status pill + "Pay now" direct link to detail. Shown only when balance > 0.
- **Recent payments**: last 3 PAID invoices with date and amount. Link to receipts.
- **All-clear state**: "✓ All paid" when `openBalance === 0`.
- **Usage metrics removed** from this view (extensions, phone numbers not relevant on billing overview).

### `/billing/invoices` — Invoice list
- Sorted: FAILED → OVERDUE → OPEN → DRAFT → PAID → VOID (unpaid always first).
- Status pills use `invoiceStatusLabel` (human-readable: "Pending", "Payment failed", "Overdue", "Paid", "Voided").
- **No inline "Charge card"** button — payment action is on the detail page only to prevent accidental charges.
- Period formatted as "Mar 1 – Mar 31, 2026". CTA says "Pay now" for failed/overdue rows, "Open" for others.

### `/billing/invoices/:id` — Invoice detail
- **Invoice header card**: invoice number, human-readable status pill, total, balance due (red when > 0), due date, billing period.
- **Pay this invoice** section (when not PAID/VOID):
  - With default PM: "Pay $X.XX" → **2-step inline confirm** ("Charge $X.XX to your default card?") → charge POSTed; APPROVED/DECLINED shown in toast.
  - Without PM: "Add payment method" CTA + optional "Email payment link".
  - Email actions (email invoice / email payment link) conditionally shown when `billingEmail` is set on tenant settings.
  - Hint shown when `billingEmail` missing, links to Billing Settings.
- **Paid banner** (when status === PAID): "✓ Paid {date}" + "Download PDF" + "Email receipt".
- **Line items**: `DataTable` with description, qty, unit price, amount.
- **Payment history**: renders `invoice.transactions` — each shows amount, date, card last4/brand, status pill, response message.
- **Activity timeline**: vertical timeline (`.billing-timeline`) showing all `invoice.events` descending; labels via `billingEventLabel`; good/bad dot colors for payment events.

### `/billing/payments` — Payment methods
- **"SOLA" vendor brand removed** from all customer-facing copy. References replaced with "secure card form", "PCI-compliant payment processor", "card details".
- **Advanced SUT token entry removed** (internal debug tool not appropriate for customers).
- **Add a card** section: iFields hosted form loads on `solaPublicConfig.enabled && ifieldsKey`; shows "Contact support" hint when not configured.
- `makeDefault` set to `true` only when no cards exist (first card is auto-default).
- **Card operations** (make default, remove) now use toast feedback (`showToast`) instead of silent `window.location.reload()`.
- **Remove confirmation**: click "Remove" shows "Remove this card?" + "Confirm remove" / "Cancel" inline (no modal).
- `submittedRef` prevents double-submit on card save.

### `/billing/receipts` — Receipts
- Shows only PAID invoices + invoices with at least one APPROVED transaction. Sorted by `paidAt` desc.
- Each row: invoice number, paid date, card used (brand + last4 from first APPROVED transaction), amount, PDF download button.
- Mobile: card label and PDF button hidden at `< 640px` (amount still visible).

### Shared helpers (`apps/portal/lib/billingUi.ts`)
| Export | Purpose |
|--------|---------|
| `invoiceStatusLabel(status)` | Human-readable: OPEN→"Pending", FAILED→"Payment failed", OVERDUE→"Overdue", etc. |
| `invoiceStatusClass(status)` | CSS modifier: good/warn/bad |
| `transactionStatusLabel(status)` | APPROVED→"Approved", DECLINED→"Declined", ERROR→"Error" |
| `transactionStatusClass(status)` | CSS modifier |
| `billingEventLabel(type)` | Human-readable event type for timeline |
| `formatDate(d)` | "May 13, 2026" |
| `formatDateTime(d)` | "May 13, 2026, 2:37 PM" |

### New CSS classes (`apps/portal/app/globals.css`)
| Class | Purpose |
|-------|---------|
| `.billing-alert-banner` | Failed payment / overdue prominent banner with icon, body, actions |
| `.billing-stat-grid` | 3-column responsive stat card row (collapses on mobile) |
| `.billing-stat-card` | Individual stat card with label, value, sub, cta slots |
| `.billing-unpaid-callout` | Unpaid invoices section (also used for recent payments) |
| `.billing-invoice-header` | Invoice detail header card with meta grid |
| `.billing-pay-confirm` | Inline 2-step pay confirmation row |
| `.billing-tx-list` / `.billing-tx-row` | Transaction history list |
| `.billing-timeline` / `.billing-timeline-item` | Vertical dot-line activity timeline |
| `.billing-receipt-row` | Receipt list rows with card/PDF columns hidden on mobile |

## Operator portal (billing)

- **Tenant:** **`/billing`** (overview — balances, invoices, usage metrics, activity; configuration links to **`/billing/settings`**), **`/billing/settings`** (invoice presentation preferences; processor setup lives under **Company billing setup**), **`/billing/invoices`**, **`/billing/invoices/[id]`**, **`/billing/payments`**, **`/billing/receipts`** — see `apps/portal/app/(platform)/billing/**`. Uses tenant routes only (`/billing/...`). Invoice detail shows **`BillingEventLog`** via fields on **`GET /billing/platform/invoices/:id`** (no extra events route). Actions call **`POST .../email-invoice`**, **`POST .../email-payment-link`**, **`POST .../pay`**, PDF query on the API host — buttons stay disabled while a request is in flight; email actions require **`billingEmail`** on tenant settings (portal shows a hint when missing).
- **Platform admin:** **`/admin/billing`** (operational overview — per-tenant when a workspace is selected, cross-tenant summary in **All workspaces** mode) and **`/admin/billing/settings?tenantId=…`** (per-tenant **Monthly Pricing**, invoice branding, **Payment gateway** UI — still backed by SOLA/Cardknox endpoints) — **`SUPER_ADMIN`** + `can_view_admin_billing`; uses **`/admin/billing/...`** only. Company scope comes from the **header workspace switcher** (`TenantSwitcher` / `adminScope`), not a billing-local rail. Recent failures table comes from **`GET /admin/billing/overview`**. Run history from **`GET /admin/billing/runs/recent`**. Per-invoice **Activity** loads **`GET /admin/billing/invoices/:id/events`**.
- **Billing plans catalog:** **`/admin/billing/plans`** — list/create/edit/clone/deactivate platform **`BillingPlan`** rows (`tenantId=null`) via **`GET/POST/PATCH /admin/billing/platform/billing-plans`** and **`POST …/:id/clone`**. Optional **`?includeInactive=true`** on list for retired plans. Inactive plans are excluded from the **Scheduled Plan Change** dropdown on Company billing setup (API also rejects scheduling an inactive plan). Linked from **`/admin/billing`** as **Billing plans (catalog)**.
- **Invoices & payments page:** **`/admin/billing/invoices`** — cross-tenant operator view with **Invoices**, **Payments** (transactions audit), **Collections**, and **Reports** sections. Tab selection is persisted as **`?opsTab=`** (`invoices` \| `transactions` \| `reports` \| `collections`):
  - **Invoices tab:** paginated list of all `BillingInvoice` records via **`GET /admin/billing/invoices?status=&search=&page=&limit=`**. **Dangerous actions:** **`Charge card`** uses the live gateway unless the deployment is sandbox — confirm environment before any confirmation; **`Mark paid`** is **full balance only** — **`PARTIAL_PAYMENT_NOT_SUPPORTED`** is intentional (see **`BILLING_OPERATOR_RUNBOOK.md`**). Do **not** run charges or live platform batch as part of casual smoke testing. Per-row actions:
    - **Detail** — opens `InvoiceDetailModal` (slide-over drawer) with full line items, all payment attempts with card/response, and `BillingEventLog` timeline (loaded via `GET /admin/billing/invoices/:id`). (slide-over drawer) with full line items, all payment attempts with card/response, and `BillingEventLog` timeline (loaded via `GET /admin/billing/invoices/:id`).
    - **Cards** — opens `PaymentMethodsModal` to list, set-default, remove, and **add** saved cards for the tenant. List loaded via `GET /admin/billing/platform/tenants/:tenantId/payment-methods`. Add card uses iFields tokenization (see "Admin add-card iFields" below).
    - **Charge card** — opens `ManualPayModal`: pick saved card, enter optional operator note, 2-step confirmation with **LIVE CHARGE** or SANDBOX badge. Calls `POST /admin/billing/invoices/:id/pay` with `{ paymentMethodId, note, confirmLive: true }`.  Duplicate submits disabled; exact API error shown on failure.
    - **Mark Paid** — direct `POST /admin/billing/invoices/:id/mark-paid` (full balance only). **Phase-0 guard (2026-05):** `markBillingInvoicePaid` now rejects any `amountCents` less than `invoice.totalCents` with `PARTIAL_PAYMENT_NOT_SUPPORTED` before touching the DB. Passing no amount or passing the exact total still marks the invoice `PAID` with `balanceDueCents = 0`. This prevents a `PAID + balanceDueCents > 0` impossible state until a `PARTIALLY_PAID` enum is added in Phase 1.
    - **Send invoice**, **Email link**, **Void**, **Activity log** (inline expand) — unchanged.
    - **SMS link** — sends a **payment link SMS** when the tenant can send SMS. **Capability:** **`GET /admin/billing/platform/tenants/:tenantId/sms-capability`** — if false, configure **Twilio** or **VoIP.ms** tenant messaging first. **Send:** **`POST /admin/billing/invoices/:id/sms-payment-link`** (**real SMS** when configured; not a placeholder).
  - **Transactions tab:** paginated audit of all `PaymentTransaction` records via **`GET /admin/billing/transactions?status=&tenantId=&page=&limit=`**. Each row has a **Detail** button opening `TransactionDetailModal` — shows amount, card, processor ref, response code/message, idempotency key, and full gateway response JSON (loaded via `GET /admin/billing/transactions/:id`).
  - **Collections tab:** operator-grade dunning visibility and per-invoice controls. All data is lazy-loaded. Phase 2 active (worker fully enforces all controls). Two sections:
    - **Collections Overview** — on-demand via `GET /admin/billing/collections/overview`. Shows count badges (failed/open, retry-eligible, paused, exhausted, do-not-charge) and three tables: "Ready to retry", "Paused / Do-not-charge", "Retries exhausted". Each row has an invoice button that opens `InvoiceDetailModal`.
    - **Preview Next Dunning Sweep** — on-demand via `GET /admin/billing/collections/preview-retries`. Lists invoices the dunning worker would pick up on the next sweep, given current `nextRetryAt` and attempt counts.
    - A green **"Worker enforcement active"** notice is shown: changes take effect on the next dunning sweep (every 6 h).
  - **Reports tab:** lazy-loaded operator reports and CSV exports. No data is fetched until the operator clicks "Load report". Three sections:
    - **CSV Exports** — direct `<a download>` links to `GET /admin/billing/reports/export/invoices` and `GET /admin/billing/reports/export/transactions`. Optional status filter. Files named `billing-invoices-YYYY-MM-DD.csv` / `billing-transactions-YYYY-MM-DD.csv`. Generated-At and Generated-By metadata rows at the top.
    - **Aging Report** — on-demand load via `GET /admin/billing/reports/aging`. Shows all OPEN/FAILED/OVERDUE invoices with outstanding balance: tenant, invoice #, status, due date, days overdue (red/bold when > 30), balance due. "⬇ CSV" button (`GET /admin/billing/reports/aging/export`, file `billing-aging-YYYY-MM-DD.csv`) appears after load.
    - **Failed Payments** — on-demand load via `GET /admin/billing/reports/failed-payments`. Shows FAILED/OVERDUE invoices with last processor response code and reason. "⬇ CSV" button (`GET /admin/billing/reports/failed-payments/export`, file `billing-failed-payments-YYYY-MM-DD.csv`) appears after load.
    - A **"results capped"** yellow banner appears when the row cap is reached — see **Report row caps** below.
    - All tables are read-only. Overflow is scrollable for mobile.
  - Linked from the **`/admin/billing`** shell as **Invoices & payments**.
  - All admin billing routes are `requirePlatformBilling` (`SUPER_ADMIN` only). No DB migration needed.
- **Company billing setup** (`/admin/billing/settings`): includes **Collections Automation** (alongside Monthly Pricing, Invoice Branding, **Payment gateway** card — same SOLA-backed APIs). Calls `GET/PUT /admin/billing/platform/tenants/:tenantId/collections-config` to read/write `TenantBillingSettings.metadata.collections`. Shows green "Worker enforcement active" notice.

### Report row caps and filtering

On-screen loads and CSV downloads are **hard-capped**:

| Report / export | Max rows |
|-----------------|---------:|
| Aging (JSON + CSV) | **2 000** |
| Failed payments (JSON + CSV) | **1 000** |
| Full invoice CSV export | **5 000** |
| Full transaction CSV export | **5 000** |

When the **results capped** banner appears, the underlying data may extend **beyond** what is shown — the export is **not** guaranteed complete for audit. **Mitigation:** use supported filters (**`tenantId`**, **`status`** on invoice/transaction exports where applicable), run **multiple narrower exports**, or use approved **database / BI** reporting for unconstrained extracts. Operator checklist: **`BILLING_OPERATOR_RUNBOOK.md`**.

### Billing reports — API routes

| Method | Route | Purpose | Row cap |
|--------|-------|---------|---------|
| `GET` | `/admin/billing/reports/aging` | JSON: all OPEN/FAILED/OVERDUE invoices with computed `daysOverdue` | 2 000 |
| `GET` | `/admin/billing/reports/aging/export` | CSV download: aging report | 2 000 |
| `GET` | `/admin/billing/reports/failed-payments` | JSON: FAILED/OVERDUE invoices + last DECLINED/ERROR transaction | 1 000 |
| `GET` | `/admin/billing/reports/failed-payments/export` | CSV download: failed payments report | 1 000 |
| `GET` | `/admin/billing/reports/export/invoices?status=&tenantId=` | CSV download: full invoice export | 5 000 |
| `GET` | `/admin/billing/reports/export/transactions?status=&tenantId=` | CSV download: full transaction export | 5 000 |

All routes: `SUPER_ADMIN` only (`requirePlatformBilling`). Read-only. No schema changes.

**CSV safety:** cells starting with `=`, `+`, `-`, `@`, TAB, or CR are prefixed with `'` to prevent spreadsheet formula injection. Helper lives in `apps/api/src/billing/billingReports.ts` (`csvCell`).

**CSV metadata rows:** every export begins with `# Report`, `# Generated At`, `# Generated By` comment rows.

**Filename convention:** `billing-{type}-YYYY-MM-DD.csv` (today's date at time of download).

### Collections automation controls — Phase 1 + Phase 2 (complete)

**Phase 1 (2026-05):** Stores and displays controls (API + Portal).  
**Phase 2 (2026-05):** Worker enforcement — dunning sweep fully honours all Phase 1 flags.

#### Metadata-only storage (no schema changes)

- **`TenantBillingSettings.metadata.collections`** — per-tenant dunning overrides:
  - `dunningEnabled` (boolean | null) — null = inherit `autoBillingEnabled`
  - `maxAttempts` (number | null) — null = use `BILLING_DUNNING_MAX_ATTEMPTS` env (default 3)
  - `retryDelayHours` (number | null) — null = use `BILLING_DUNNING_RETRY_DELAY_HOURS` env (default 72)

- **`BillingInvoice.metadata.collections`** — per-invoice controls:
  - `paused` (boolean) — operator explicitly paused this invoice's collection
  - `pausedAt`, `pausedBy`, `pauseReason` — audit trail for pause
  - `skipNextRetry` (boolean) — skip the single next scheduled retry
  - `doNotCharge` (boolean) — never auto-charge this invoice again
  - `updatedBy`, `updatedAt` — last operator + timestamp

All updates **preserve existing dunning/metadata keys** — only the `collections` sub-key is merged.

#### Collections API routes

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/admin/billing/collections/overview` | Overview with count badges + retry-eligible / paused / exhausted tables |
| `GET` | `/admin/billing/collections/preview-retries` | Simulate next dunning sweep without mutating anything |
| `GET` | `/admin/billing/platform/tenants/:tenantId/collections-config` | Read per-tenant collections config |
| `PUT` | `/admin/billing/platform/tenants/:tenantId/collections-config` | Update per-tenant config (logs `collections_action`) |
| `POST` | `/admin/billing/invoices/:id/collections/pause` | Pause invoice retries (requires body `{ reason? }`) |
| `POST` | `/admin/billing/invoices/:id/collections/resume` | Clear all pause/skip/do-not-charge flags |
| `POST` | `/admin/billing/invoices/:id/collections/skip-next-retry` | Set `skipNextRetry: true` |
| `POST` | `/admin/billing/invoices/:id/collections/do-not-charge` | Set `doNotCharge: true` (requires body `{ reason? }`) |

All routes: `SUPER_ADMIN` only (`requirePlatformBilling`). No schema migration. Helpers in `apps/api/src/billing/billingCollections.ts`.

#### Audit logging

Every operator action (per-invoice and per-tenant config) writes a `BillingEventLog` record:
- `type: "collections_action"`
- `metadata.action` — `pause | resume | skip_next_retry | do_not_charge | update_collections_config`
- `metadata.operatorId` — JWT `sub`
- `metadata.reason` — optional free-text from request body
- `metadata.prevState` and `metadata.nextState` — full collections slice before/after

#### Phase 1 / Phase 2 boundary (all complete)

| Capability | Phase 1 | Phase 2 |
|-----------|---------|---------|
| Store pause/do-not-charge/skip flags | ✅ | — |
| Show flags in Collections tab UI | ✅ | — |
| Show flags in InvoiceDetailModal | ✅ | — |
| Worker respects `paused` flag | — | ✅ |
| Worker respects `doNotCharge` flag | — | ✅ |
| Worker respects `skipNextRetry` (clears flag + logs) | — | ✅ |
| Worker reads per-tenant `maxAttempts`/`retryDelayHours` overrides | — | ✅ |
| Deterministic idempotency keys (`worker:billing:sale:${invoice.id}:a${attempt}`) | — | ✅ |
| Audit log `collections_action: skip_next_retry_consumed` | — | ✅ |
| Audit log `collections_action: sweep_skipped_<reason>` (one per skipped invoice per sweep) | — | ✅ |

#### Phase 2 worker behaviour

The worker's `runBillingDunningRetries` (runs every 6 h) now calls `runDunningSweepEligibility` which classifies timing-eligible invoices into three buckets:

1. **`toCharge`** — invoices that pass all collections checks → charged with deterministic idempotency key `worker:billing:sale:${invoice.id}:a${attemptNumber}`.
2. **`skipNextRetryInvoices`** — invoices with `skipNextRetry=true` → flag cleared via `consumeSkipNextRetryFlag` (writes `collections_action: skip_next_retry_consumed` to `BillingEventLog`), not charged this sweep.
3. **`skipped`** — invoices blocked by `paused`, `doNotCharge`, or tenant-level `dunningEnabled=false` → one `collections_action: sweep_skipped_<reason>` log per invoice per sweep (best-effort, does not fail the sweep).

Per-tenant `maxAttempts` and `retryDelayHours` overrides are passed through to `applyDunningAfterAutopayFailure` so the next retry window is also tenant-scoped. Env defaults are preserved when the tenant override is null.

### Admin manual payment flow — safeguards
- `POST /admin/billing/invoices/:id/pay` checks SOLA config mode: if `isEnabled && mode === "PROD" && !simulate`, it is a **live charge** and requires `confirmLive: true` in the body — returns `400 confirm_live_required` otherwise.
- UI shows **⚡ LIVE CHARGE** badge and requires a 2-step confirmation before calling the endpoint.
- Duplicate submits are prevented client-side with a `submitted` ref.
- The operator's `note` (if provided) is written to `BillingEventLog` as `payment.admin_charge_note` before the charge is attempted.
- `chargeBillingInvoice` accepts a `note` field in `ChargeBillingInvoiceOptions` and stamps it in the initial event log metadata.

### Admin tenant payment-method management
| Route | Purpose |
|-------|---------|
| `GET /admin/billing/platform/tenants/:tenantId/payment-methods` | List active cards with `lastSuccessfulCharge` and `isLiveCharge` flag |
| `GET /admin/billing/platform/tenants/:tenantId/sola/public-config` | Return `{ configured, enabled, ifieldsKey, mode }` for admin iFields form |
| `POST /admin/billing/platform/tenants/:tenantId/payment-methods/sola/save` | Save card from SUT token collected by admin iFields form |
| `POST /admin/billing/platform/tenants/:tenantId/payment-methods/:methodId/default` | Set default card (updates `TenantBillingSettings.defaultPaymentMethodId`) |
| `DELETE /admin/billing/platform/tenants/:tenantId/payment-methods/:methodId` | Soft-deactivate card (sets `active: false`, clears default if matched) |

All routes log a `BillingEventLog` event and are `SUPER_ADMIN`-only (`requirePlatformBilling`).

### Admin add-card iFields

Operators can add a card on behalf of a tenant from the `PaymentMethodsModal` inside `/admin/billing/invoices`.

**PCI boundary** — raw PAN and CVV never hit Connect API:
- The modal fetches `GET .../sola/public-config` which returns only the **public** `ifieldsKey` (safe to expose client-side; no API secret is included).
- Card number and CVV are entered into Cardknox-hosted `<iframe>` fields (`ifield.htm`). The `getTokens()` call returns a single-use token (SUT) in a hidden `<input name="xCardNum">`. Raw card data never leaves the browser for Cardknox-hosted iframes.
- Only the SUT is sent to Connect API (`POST .../payment-methods/sola/save` body: `{ xSut, cardholderName?, billingZip?, makeDefault? }`).
- `xSut` is **not logged** in `BillingEventLog` metadata; only `paymentMethodId`, masked `brand`/`last4`, and `adminUserId` are recorded.

**Server-side flow (`saveAdminCardWithSut` in `apps/api/src/billing/adminCardSave.ts`):**
1. Validate `xSut.length >= 8` → `400 sola_token_too_short` if not.
2. Confirm tenant exists → `404 tenant_not_found` if not.
3. Call `getBillingSolaAdapter(tenantId).saveCardWithSut({ sut: xSut, ... })`.
4. If `response.approved === false` → `402 card_save_failed`.
5. Call `storeSolaPaymentMethod(...)` to persist the vault token.
6. Log `payment_method.saved` event (no SUT in metadata).
7. Return `{ id, brand, last4, expMonth, expYear, isDefault }`.

**Portal UX (`PaymentMethodsModal` in `apps/portal/app/(platform)/admin/billing/invoices/page.tsx`):**
- "+ Add card" toggle button below the card list (hidden until clicked).
- Fetches tenant public config on modal open; loads `ifields.min.js` from CDN once.
- Shows a **sandbox mode** warning banner if `mode === "sandbox"`.
- Shows "SOLA iFields not configured" message if not `enabled` or no `ifieldsKey`.
- Card number iframe + CVV iframe + cardholder name + billing ZIP inputs.
- On success: toast "Card saved successfully.", collapse form, refresh card list.
- Duplicate submit prevented via `submittedRef`.

**Tests:** `apps/api/src/billing/adminAddCard.test.ts` — 6 cases:
1. `xSut` empty → `400 sola_token_too_short`
2. `xSut` shorter than 8 chars → `400 sola_token_too_short`
3. Valid `xSut` → adapter `saveCardWithSut` called with correct token
4. Declined response → `402 card_save_failed`, `storeMethod` never called
5. Approved response → `storeMethod` + `logEvent` called, returns masked card info; `xSut` absent from log
6. `canAccessPlatformAdminBillingRoutes` only passes `SUPER_ADMIN`

### Admin SMS payment links

| Route | Purpose |
|-------|---------|
| `GET /admin/billing/platform/tenants/:tenantId/sms-capability` | Check whether the tenant has an enabled SMS provider + from-number. Returns `{ capable, fromNumber, provider, reason }` |
| `POST /admin/billing/invoices/:id/sms-payment-link` | Send a payment link SMS to an operator-supplied destination phone. Body: `{ phone: string, note?: string }` |

**Design:** Direct synchronous send from the API (not BullMQ). Billing payment links are low-volume and operator-triggered; immediate feedback is required. No new Prisma models or migrations needed.

**Provider resolution (`resolveTenantSmsProvider`):**
1. Load tenant `smsPrimaryProvider` (`TWILIO` | `VOIPMS`)
2. Load `ProviderCredential` for that provider (must be `isEnabled: true`)
3. Decrypt credentials (`decryptJson`) and construct `TwilioSmsProvider` or `VoipMsSmsProvider`
4. From-number: tenant `defaultSmsFromNumber`, else first active `PhoneNumber`
5. Returns `null` if any step fails → `sms_provider_unavailable`

**Safeguards:**
- Duplicate send: no same phone for the same invoice in the last 2 minutes (checked via `BillingEventLog` before send)
- Invalid phone: basic length check; provider returns its own error for truly invalid numbers
- Voided invoices blocked; PAID invoices allowed (operator may resend history)
- Operator note (if provided) appended to the `BillingEventLog` message
- Both success (`billing.sms_payment_link_sent`) and failure (`billing.sms_payment_link_failed`) events logged with `toPhone`, `fromPhone`, `providerMessageId`, `adminUserId`

**Portal `SmsPaymentLinkModal`:**
- Opens from the **SMS link** button on each actionable invoice row
- Loads SMS capability on open; shows "SMS not available" with reason if provider is unconfigured
- Step 1 (form): phone input + optional operator note
- Step 2 (confirm): message preview (showing exact text, from-number, destination)
- Step 3 (done): success confirmation; duplicate-submit blocked via `ref`
- Message format: `{tenantName}: Pay invoice {invNum} ({balance}): {paymentUrl}`

## Sola Vault Schedule Linking (external import)

> **Phase B (2026-05-17):** Read-only sync + operator tenant mapping shipped. **No charges, no token storage, no PaymentMethod creation, no autopay changes.** Phase C will add token linking.

### What this is

Many tenants already have saved cards and recurring schedules inside Sola (Cardknox).
Connect imports **safe** recurring schedule metadata from the Cardknox Recurring API and lets a **SUPER_ADMIN** map each schedule to a Connect tenant. Mapping only records the link — it does not move billing execution to Connect.

### Hard constraints (Phase B — enforced in code)

- **No raw card / CVV.** Masked card metadata only (`Issuer`, `MaskedCardNumber`, `Exp` MMYY). **`Token` is never persisted** in Phase B (`getPaymentMethodMasked` redacts before any storage).
- **No charges.** Sync and map/ignore/unmap routes never call `chargeToken`, invoice creation, or worker/dunning.
- **No Sola schedule disable.** Recurring `/UpdateSchedule` not called.
- **No Connect autopay activation.** Tenant autopay settings untouched.
- **No worker / invoice-math / telephony / CRM changes.**

### Double-charge risk (operator-facing)

If both the **old Sola recurring schedule** (still active in Cardknox) **and** Connect autopay run, the customer can be charged twice. The admin UI at **`/admin/billing/sola-imports`** shows a compact cutover note on **mapped + active** rows: disable the Sola schedule and complete cutover before enabling Connect autopay. Phase E will add an explicit “disable Sola schedule” action.

### Implementation (Phase B)

| Piece | Location |
|-------|----------|
| Prisma model | `BillingSolaExternalScheduleLink` + enum `SolaScheduleLinkMappingStatus` |
| Migration | `packages/db/prisma/migrations/20260517120000_billing_sola_external_schedule_link/` |
| Recurring client | `packages/integrations/src/sola-cardknox/recurring.ts` — `listSchedules`, `getSchedule`, `getPaymentMethodMasked`; `redactSolaRecurringPayload` |
| Sync + mapping service | `apps/api/src/billing/solaExternalSchedules.ts` |
| SUPER_ADMIN routes | `POST /admin/billing/platform/sola-import/sync`, `GET .../schedules`, `POST .../schedules/:id/map|ignore|unmap` |
| Admin UI | `apps/portal/.../admin/billing/sola-imports/` (+ link from Payments workspace) |

**Sync behavior:** Paginates `/ListSchedules`, optionally `/GetSchedule` + masked `/GetPaymentMethod` for card display fields. Upserts by `solaScheduleId`. Preserves **MAPPED** / **IGNORED** on re-sync. Suggests tenant match (billing email, company name, simple fuzzy name). **`rawSafeJson`** stores redacted API payloads only.

**Map behavior:** Sets `tenantId`, `mappingStatus=MAPPED`, `mappedByUserId`, `mappedAt`; logs `billing.sola_external_schedule_mapped`. Does **not** create `PaymentMethod`.

**Credentials:** Platform sync uses `SOLA_CARDKNOX_API_KEY` (env) or tenant `BillingSolaConfig` when scoped. **`SOLA_CARDKNOX_SIMULATE=1`** returns mock schedules for dev/tests.

### Sola Recurring API

| API Base URL | `https://api.cardknox.com/v2` |
|---|---|
| Auth | `Authorization: <apiKey>` header (same key as Transaction API) |
| Software headers | `SoftwareName` / `SoftwareVersion` (see `recurring.ts`) |
| Method | POST only |

Phase B uses: `/ListSchedules`, `/GetSchedule`, `/GetPaymentMethod` (masked fields only; token redacted before persistence).

### Token reuse (Phase C — not Phase B)

The `Token` from `/GetPaymentMethod` is the same `xToken` used by `chargeToken()`. Phase C will encrypt into `PaymentMethod.tokenEncrypted` after explicit operator approval. **Phase B never stores it.**

### Schema still planned (Phase C+)

`PaymentMethod` may gain `processorCustomerId`, `processorPaymentMethodId`, `isImported`, `importedAt` when token linking ships.

### Webhook/reconciliation limitations

Old Sola recurring schedule webhooks **cannot** be auto-linked to Connect invoices. The webhook handler requires a `CONNECT:` prefixed `xInvoice`. Old schedules have no Connect invoice IDs.

### Phase plan (updated 2026-05-18)

| Phase | Status |
|-------|--------|
| A | Audit complete |
| B | **Shipped** — schema, recurring client, read-only sync API, admin mapping UI |
| C (cutover) | **Shipped (2026-05-18)** — token linking (Phase A), readiness check (Phase B), manual take-over (Phase C), worker guard (Phase D) |

### Cutover architecture (2026-05-18)

After cutover: **Connect owns billing schedule, invoices, retries, taxes, and autopay timing. Sola/Cardknox is vault/payment processor only.**

| Piece | Location |
|-------|----------|
| Service functions (token link, readiness, take-over) | `apps/api/src/billing/solaCutover.ts` |
| Recurring client additions (getPaymentMethodWithToken, updateSchedule) | `packages/integrations/src/sola-cardknox/recurring.ts` |
| API routes (link-token, readiness, take-over) | `apps/api/src/billing/routes.ts` (end of `registerBillingRoutes`) |
| Worker guard + schedule override consumption | `apps/worker/src/main.ts` (`checkActiveSolaScheduleBlock`, `getAndConsumeBillingScheduleOverride`) |
| Sola imports UI (new states + actions) | `apps/portal/.../adminBillingSolaImportsWorkspace.tsx` |
| Migration | `packages/db/prisma/migrations/20260518100000_billing_sola_cutover/` |

### Cutover safety rules (enforced in code)

1. **Worker guard (Phase D):** Before charging any tenant, `checkActiveSolaScheduleBlock` checks for active Sola schedule links with `mappingStatus=MAPPED`, `isActive=true`, and `cutoverStatus != CUTOVER_COMPLETE`. If found → skip Connect autopay charge and log `billing.autopay_skipped_active_sola_schedule`.
2. **Take-over sequence:** disable Sola `/UpdateSchedule IsActive=false` MUST succeed before `autoBillingEnabled` is set to true. If Sola disable fails → `CUTOVER_FAILED`, Connect autopay NOT enabled.
3. **No immediate charge:** the take-over route never creates an invoice or calls chargeToken. Future charges happen via the normal worker billing day.
4. **Double-charge detection:** `getBillingCutoverReadiness` returns `doubleChargeRisk=true` if Connect autopay is enabled AND an active non-cutover Sola schedule exists for the tenant.

### New API routes

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/admin/billing/platform/sola-import/schedules/:id/link-token` | Fetch Sola vault token, encrypt, create PaymentMethod (isImported=true). No charge, no autopay. |
| `GET` | `/admin/billing/platform/tenants/:tenantId/billing-cutover/readiness` | Readiness checklist: pricing, token, schedule status, double-charge risk. |
| `POST` | `/admin/billing/platform/tenants/:tenantId/billing-cutover/take-over` | Full cutover: disable Sola schedule → set default PM → enable Connect autopay → CUTOVER_COMPLETE. |

### New worker events

| Event type | When |
|-----------|------|
| `billing.autopay_skipped_active_sola_schedule` | Worker guard blocked Connect autopay charge |
| `billing.autopay_skipped_schedule_override` | `skipNextPayment` override consumed and charge skipped |
| `billing.autopay_skipped_future_payment_date` | `nextPaymentDate` override in future, charge skipped |

### New BillingEventLog types

- `billing.sola_external_schedule_mapped` — Phase B (map)
- `billing.sola_import_sync` — sync summary
- `billing.sola_external_token_linked` — Phase A: token linked to Connect PaymentMethod
- `billing.sola_cutover_started` — Phase C: operator initiated cutover
- `billing.sola_schedule_disabled` — Phase C: old Sola schedule disabled
- `billing.sola_schedule_disable_failed` — Phase C: disable failed (cutover aborted)
- `billing.connect_autopay_enabled` — Phase C: Connect autopay enabled
- `billing.sola_cutover_completed` — Phase C: cutover complete

### `BillingSolaExternalScheduleLink` cutover status values (string, no enum migration)

| Value | Meaning |
|-------|---------|
| `TOKEN_LINKED` | Vault token retrieved and stored as encrypted PaymentMethod |
| `READY_FOR_CUTOVER` | (reserved; used by readiness logic) |
| `CUTOVER_COMPLETE` | Old Sola schedule disabled, Connect autopay enabled |
| `CUTOVER_FAILED` | Sola disable API failed; Connect autopay NOT enabled |

---

## SOLA / Cardknox (implementation facts)

- **Vendor:** SOLA (Cardknox). **Authoritative product docs:** [https://docs.solapayments.com/](https://docs.solapayments.com/)
- **Direct charge:** server-side Transaction API — `gatewayjson` with **`xCommand=cc:sale`** (default host `https://x1.cardknox.com`, path `/gatewayjson` unless overridden in config).
- **Hosted payment:** treat as **PaymentSITE URL generation / prefill** unless code proves a true hosted-session API; the repo still has a JSON `postJson` hosted-session path for legacy/subscription flows — verify against Sola before relying on it for tenant `BillingInvoice` checkout.
- **`xInvoice`:** Connect sends a **unique per attempt** value `CONNECT:<tenantId>:<invoiceId>:<timestamp>:<sanitizedInvoiceNumber>` for correlation and gateway duplicate detection; webhooks echo it — resolve invoices with `parseConnectBillingGatewayXInvoice` / `resolvePlatformBillingInvoiceForWebhookRef`, with fallback to legacy `invoiceNumber` / `id`.
- **`xRefNum` / `xRefNumber`:** stable processor reference — **always store as string** (never assume numeric).
- **Webhooks:** **form-encoded / key-value** POST bodies (not JSON-only); **`ck-signature`** verification runs **first** when webhook PIN/secret is configured, then Sola-style HMAC if applicable (`applySolaWebhookToBillingInvoice` / `server.ts` branches).
- **Duplicates:** repeated deliveries must **not** double-pay — dedupe uses `xRefNum`-derived keys + `PaymentTransaction` OR clause (see `buildBillingWebhookDedupeOrClause`).
- **Declines / errors:** **`PaymentTransaction` + `BillingEventLog`** rows are still created. **`xResult`:** **`A`** = approved, **`D`** = declined, **`E`** = error (mapped to transaction status and webhook handling in `solaBillingPayments.ts` / adapter `normalizeCardknoxResponse`).
- **Config precedence:** **`BillingSolaConfig`** for the tenant when enabled; otherwise **env** fallback (`SOLA_CARDKNOX_*` in `getBillingSolaAdapter` in `solaGateway.ts`) — same pattern for webhook verification adapters.

### SOLA setup (operators)

1. **API public base URL:** Set **`PUBLIC_API_BASE_URL`** or **`PUBLIC_API_URL`** on the API service to the HTTPS origin that SOLA and browsers use to reach Connect (same host as other billing links). The webhook URL is derived from this value.
2. **SOLA API Key (xKey):** From the SOLA/Cardknox merchant dashboard — stored encrypted in **`BillingSolaConfig`** (`credentialsEncrypted.apiKey`).
3. **Webhook/Postback URL:** Connect exposes exactly **`{PUBLIC_API_BASE_URL or PUBLIC_API_URL}/webhooks/sola-cardknox`** (computed in **`apps/api/src/billing/solaPublicUrls.ts`**). Copy this URL from **Admin Billing → Company billing setup → Payment gateway** (tenant self-serve settings do not expose gateway wiring) into the vendor’s webhook/postback URL field.
4. **Webhook Verification PIN:** Same secret in Connect (**Webhook Verification PIN**) and in SOLA/Cardknox postback security (supports **`ck-signature`** verification). **Required when mode is Production** — save and enable are rejected without it.
5. **Optional iFields public key:** Needed only for **Billing → Payments** tokenized card capture; not required for invoice charges if cards are vaulted another way.
6. **Test configuration:** Calls **`gatewayjson`** with a zero-amount auth-style check only (no real card, no capture). Run after saving xKey; **Enable** stays disabled until the test returns success.

Backward compatibility: existing rows keep **`apiBaseUrl`**, **`pathOverrides`**, **`authMode`**, and **`apiSecret`** in the database; the simplified portal forms no longer edit those fields but the API still accepts them for older clients and migrations.

## Automation & email (BillingInvoice)

| Step | Owner | What happens |
|------|--------|----------------|
| Invoice created (`createBillingInvoice` or worker delegating to it) | API `invoiceEngine` / worker monthly | `BillingEventLog` **`invoice_created`**; **`queueInvoiceSentOnFinalize`** queues **`BILLING_INVOICE_SENT`** once per invoice (needs `tenantBillingSettings.billingEmail`). Worker passes **`invoiceCreatedEventMetadata: { source: "worker_monthly" }`** on the log row. |
| Monthly billing day | Worker `runMonthlyBillingAutomation` (hourly tick) | Creates or reuses period invoice, emails if new, **`chargeWorkerInvoice`** when default card exists. |
| Dunning retry | Worker `runBillingDunningRetries` (every 6h) | Picks invoices with `metadata.dunning.nextRetryAt` due, balance due, and default PM; calls **`chargeWorkerInvoice`** (no endless loop: max attempts via env). |
| Tenant pay / admin retry | API `chargeBillingInvoice` | SOLA charge, **`payment_succeeded` / `payment_failed`** events; receipt / failure emails deduped by **`PaymentTransaction.id`** (`receipt_emailed` / `payment_failed_emailed` log rows). |
| SOLA webhook (platform invoice) | API `applySolaWebhookToBillingInvoice` | Deduped tx; receipt/failure emails same dedupe keys. |
| Email delivery | API `server.ts` | `processEmailJobsBatch` + interval — **not moved** in this phase. All billing jobs use `EmailJob.tenantId` + `invoiceId` + `type`. |

**EmailJob `type` (billing):** `BILLING_INVOICE_SENT`, `BILLING_INVOICE_READY` (admin resend), `BILLING_PAYMENT_LINK`, `BILLING_RECEIPT`, `BILLING_PAYMENT_FAILED`.

**Env:** `BILLING_DUNNING_MAX_ATTEMPTS` (default 3, max 10), `BILLING_DUNNING_RETRY_DELAY_HOURS` (default 72). **`PUBLIC_API_BASE_URL`** / **`PUBLIC_API_URL`** for PDF links in emails; **`PUBLIC_PORTAL_URL`** for portal links.

## Invoice PDF & email presentation (`TenantBillingSettings`)

| Field | Use |
|-------|-----|
| `invoiceCompanyName` | Header on PDF + email masthead (falls back to `Tenant.name`, then “Connect Communications”). |
| `invoiceLogoUrl` | **HTTPS only**, sanitized — embedded as `<img>` in **HTML emails only** (PDF does not fetch remote images). |
| `invoiceSupportEmail` / `invoiceSupportPhone` | Shown in email shell + PDF footer area. |
| `invoiceFooterNote` / `invoicePaymentInstructions` | Plain text, length-capped — PDF footer + email body blocks. |
| `paymentTermsDays` | Existing field — “Net N days” copy in invoice emails and PDF header. |

**API:** `PUT /billing/settings/branding` (tenant JWT billing roles) and optional keys on `PUT /admin/billing/tenants/:tenantId/settings`. **Portal:** **`/billing/settings`** and **`/settings/billing`** (shared `TenantBillingSettingsContent`), and Company billing setup (**`/admin/billing/settings`**) branding card.

**Code:** `apps/api/src/billing/invoiceBranding.ts` (sanitize + resolve), `emailTemplates.ts` (shared HTML shell), `pdf.ts` (`renderBillingInvoicePdf`), `billingEmailLifecycle.ts` (passes resolved brand into templates).

## Telecom tax compliance (process, not product law)

Connect stores **your** configured rates and an **immutable calculation snapshot** on each invoice. It does **not** assert compliance with FCC, state, county, or city telecom tax law. Before automated production billing of regulated telecom taxes, plan for an **external provider integration** (adapter slot: `external_telecom_stub` → future real provider).

---

## Go-live readiness (operators)

**Verdict (repo + docs review): yellow** — safe to use when prerequisites below are satisfied; not “green” because money/email/SOLA paths need live verification per environment and telecom tax remains operator/accountant responsibility.

### Deploy prerequisites

| Prerequisite | Notes |
|--------------|--------|
| **Deploy queue** | Ship **`api`** (REST + Prisma migrate when `packages/db/prisma/**` changed), **`portal`** (billing UI), **`worker`** (monthly billing + dunning). See **`AGENTS.md`** — no manual `docker compose` / `git pull` on prod. |
| **Migrations** | Platform billing schema: e.g. `20260427183000_platform_billing_sola`. Invoice branding columns: **`20260512120000_tenant_invoice_branding`**. Confirm `_prisma_migrations` after **`api`** deploy. |
| **Core env** | `DATABASE_URL`, `JWT_SECRET`, `CREDENTIALS_MASTER_KEY` (SOLA secrets at rest). |
| **SOLA / Cardknox** | Per-tenant **`BillingSolaConfig`** when used; else **`SOLA_CARDKNOX_*`** env fallback (`solaGateway.ts`). Webhook PIN/secret must match gateway for **`ck-signature`**. |
| **Email + links** | Global email processor in **`apps/api/src/server.ts`** (`processEmailJobsBatch`). Set **`PUBLIC_PORTAL_URL`** and **`PUBLIC_API_BASE_URL`** / **`PUBLIC_API_URL`** so invoice/PDF links in emails resolve. |
| **Dunning (optional)** | `BILLING_DUNNING_MAX_ATTEMPTS` (1–10, default 3), `BILLING_DUNNING_RETRY_DELAY_HOURS` (default 72). |
| **Tax (optional)** | `BILLING_TAX_PROVIDER` only if overriding tenant **`metadata.taxProviderId`**. Default **`tax_profile_v1`** uses **`TaxProfile`** rates — not verified telecom compliance. |

### Post-deploy verification (read-only / safe)

1. **Deploy integrity:** Per **`AGENTS.md`** — deploy log last line SHA matches expected; `docker exec app-api-1` spot-check a known-new string in `/app/...` if you shipped billing changes.
2. **DB:** `TenantBillingSettings` row exists per tenant; branding columns present if migration ran; **`BillingInvoice.metadata`** on a new invoice includes **`taxCalculationAudit`** (see **`DEBUGGING.md`** § Tax audit).
3. **API smoke (JWT):** `GET /billing/settings` and `GET /billing/platform/invoices` as a **`TENANT_ADMIN` / `BILLING` / …** role with portal **`can_view_billing_*`** aligned to **`navConfig.ts`**.
4. **Admin smoke:** `GET /admin/billing/overview` as **`SUPER_ADMIN`** only; confirm **`recentFailures`** shape if data exists.
5. **Worker:** `docker logs` worker container — no crash loop; monthly/dunning intervals depend on worker process running (see **`DEPLOYMENT.md`** compose table).

### Manual billing smoke (sandbox tenant + sandbox SOLA)

Use a **non-production** tenant, **sandbox** gateway mode, and test cards only.

1. **Permissions:** Log in as tenant billing role → **`/billing`** loads; as non–super-admin → **`/admin/billing`** hidden or 403.
2. **Settings:** Set **`billingEmail`**, pricing, optional **`TaxProfile`**, branding (HTTPS logo for email only).
3. **Card:** Add tokenized card (tenant **`/billing/payments`**).
4. **Invoice:** Admin **Generate Invoice** or tenant flow that creates **`BillingInvoice`** → line items + totals; open **PDF** (`GET /billing/platform/invoices/:id/pdf`).
5. **Audit:** Confirm **`metadata.taxCalculationAudit`** on that invoice row.
6. **Email:** **Send invoice** / wait for **`BILLING_INVOICE_SENT`** queue path; confirm **`EmailJob`** row and delivery (or provider logs).
7. **Payment link:** **`POST .../email-payment-link`** → recipient receives link; pay flow completes or declines **without** double-charge on retry (watch **`PaymentTransaction`** + **`BillingEventLog`**).
8. **Webhook:** Fire or simulate webhook (vendor docs) — signature valid, **`xInvoice`** resolves invoice, duplicate delivery → **`webhook.deduped`** / no second paid state.
9. **Autopay (optional):** Enable auto-billing + default PM + billing day; use **dry run** admin **`POST /admin/billing/runs/monthly`** with **`dryRun: true`** first when exercising batch behavior.

### Rollback

- **Application:** Re-deploy previous known-good **`api` / `portal` / `worker`** tags/commits via **deploy queue** only (`AGENTS.md`).
- **Data:** Do **not** bulk-delete financial rows. Void test **`BillingInvoice`** rows through product **`VOID`** actions if needed; preserve **`BillingEventLog`** / **`PaymentTransaction`** for audit.

### Remaining non-blocking improvements

- E2E or staging contract tests against **live-format** SOLA webhooks (idempotency, decline).
- CI running **`pnpm run test:billing`** on Node with **`--experimental-test-module-mocks`** (already in **`apps/api/package.json`**).
- Clarify **hosted session vs payment link** with vendor for any future hosted-field UX beyond current **`BILLING.md`** note.
- External **telecom tax engine** adapter replacing **`external_telecom_stub`** when legally required.

---

## Invoice preview (Phase A — complete)

### What was added

**Discount bug fix (`invoiceEngine.ts`):** `TenantBillingSettings.discountPercent` was stored in the DB but silently ignored in `buildBillingInvoicePreview`. Fixed: when `discountPercent > 0`, a `DISCOUNT` line item (type `BillingLineItemType.DISCOUNT`, `taxable: true`) is inserted covering only service charges (excluding credits). Because it is `taxable: true`, the existing `taxableSubtotalCents` sum automatically reduces the tax base — tax is computed on the post-discount amount.

**New API routes (read-only, no invoice created, no DB writes):**

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| `GET` | `/billing/invoice-preview` | Tenant billing JWT | Preview for the requesting tenant (current month) |
| `GET` | `/admin/billing/platform/tenants/:tenantId/invoice-preview` | SUPER_ADMIN | Preview for any tenant; optional `?periodMonth=3&periodYear=2027` |

The existing `POST /admin/billing/tenants/:tenantId/invoices/preview` is retained for backward compatibility.

**Portal — Company billing setup (`/admin/billing/settings`):** New "Invoice Preview" card at the bottom of the tenant settings section. Contains month/year dropdowns (current month to +2 years) and a "Preview next invoice" button. Shows line items table (description, qty, unit price, amount), total, tax notice, period, and due date. Blue "Preview only — no invoice created" notice prominent above the table.

**Portal — Customer Billing Overview (`/billing`):** New "Estimated next invoice" collapsible section above the quick nav. Lazy-loaded on first click (no auto-fetch). Shows line items, total, period/due date, and a "Preview only" notice. Does not show charge or send buttons.

### Discount math

```
serviceChargeCents = sum of line items where type ≠ CREDIT
discountCents      = -round(serviceChargeCents × discountPercent)
DISCOUNT line      = { type: "DISCOUNT", taxable: true, amountCents: discountCents }
taxableSubtotal    = sum of taxable lines (extensions + phones + SMS + DISCOUNT)
tax                = taxProvider.calculateTaxes({ taxableSubtotalCents })
```

### What was NOT changed

- No invoice creation side effects (preview is always read-only).
- No worker changes.
- No dunning changes.
- No SOLA auth/webhook changes.
- No migrations.
- No `PARTIALLY_PAID` implementation.
- No proration.
- `POST /admin/billing/tenants/:tenantId/invoices/preview` retained unchanged.

### Tests added (`invoiceEngine.test.ts`)

- `discountPercent=0.1` → DISCOUNT line = −300 cents, tax on discounted base (293 cents with full fakeTaxProfile)
- `discountPercent=0` → no DISCOUNT line
- Preview with custom `periodStart`/`periodEnd` → correct period bounds
- `buildBillingInvoicePreview` makes zero `billingInvoice.create` calls

---

## Scheduled plan change (Phase 1 — complete)

### What was added

**Schema migration (`20260530000000_billing_scheduled_plan_change`):**
- `TenantBillingSettings.nextBillingPlanId` — nullable FK → `BillingPlan.id` (SetNull on delete)
- `TenantBillingSettings.nextBillingPlanEffectiveAt` — nullable `DateTime` (UTC midnight on first of a future month)
- Prisma named relations: `"CurrentBillingPlan"` and `"NextBillingPlan"` (required because `TenantBillingSettings` now has two FK columns pointing to `BillingPlan`)
- Index `TenantBillingSettings_nextBillingPlanId_idx`

**New API routes (all `SUPER_ADMIN` only, `requirePlatformBilling`):**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/admin/billing/platform/billing-plans` | List **catalog** `BillingPlan` rows (`tenantId` null only). Query `?includeInactive=true` includes inactive rows. Each row includes `active`, `tenantId`, `createdAt`, `updatedAt`, price fields, `currentTenantCount`, `scheduledTenantCount` (coverage of FKs `TenantBillingSettings.billingPlanId` / `nextBillingPlanId`). Default: `active: true` only. Used by portal plan picker. |
| `POST` | `/admin/billing/platform/billing-plans` | Create **catalog** plan (`tenantId` forced null). Body: `{ code` (ASCII slug `a-z`, `0-9`, `_`, `-`), `name`, price fields (0 … 25 000 000 cents), `firstPhoneNumberFree`, optional `active` }. Logs **`billing_plan.created`** (`BillingEventLog` on sentinel tenant row; `metadata.catalogScope = billing_plan_catalog`, `operatorId`). |
| `GET` | `/admin/billing/platform/billing-plans/:id` | Full catalog row + usage counts + `currentTenantsPreview` / `scheduledTenantsPreview` (up to 25 tenant id/name pairs each). Non-catalog ids → **404**. |
| `PATCH` | `/admin/billing/platform/billing-plans/:id` | Update name/prices/`firstPhoneNumberFree`/`active`. **Forbidden:** `code`, `tenantId` (`.strict()` body). `active:false` rejected if **any** tenants reference plan as **current or scheduled** (`billing_plan_deactivate_blocked_current|…_scheduled`). Logs **`billing_plan.updated`** or **`billing_plan.deactivated`** (same catalog audit pattern). |
| `POST` | `/admin/billing/platform/billing-plans/:id/clone` | Body `{ code, name }`; copies prices + `firstPhoneNumberFree`; **`active: true`**; new slug must be unique. Logs **`billing_plan.cloned`**. |
| `GET` | `/admin/billing/platform/tenants/:tenantId/scheduled-plan-change` | Read current scheduled change (fields + resolved plan) |
| `POST` | `/admin/billing/platform/tenants/:tenantId/scheduled-plan-change` | Schedule a plan change. Body: `{ nextBillingPlanId, effectiveAt: ISO8601 UTC midnight first-of-month }`. Replaces any existing scheduled change. |
| `DELETE` | `/admin/billing/platform/tenants/:tenantId/scheduled-plan-change` | Cancel the scheduled change; clears both fields. Returns `404 no_scheduled_plan_change` if none set. |

**Validation (`billingScheduledPlan.ts` — `validateScheduledPlanChangeEffectiveAt`):**
- `effectiveAt` must parse as a valid date.
- Must be UTC midnight on the **1st day of a month** (all UTC components hour/min/sec = 0, day = 1).
- Must be strictly **after** the first day of the current UTC month (i.e., minimum = first of *next* month).
- `POST` also checks: plan must exist and `active: true` (`assertBillingPlanScheduleEligibility` in `billingPlanCatalog.ts`).

**Invoice preview logic (`invoiceEngine.ts`):**
`buildBillingInvoicePreview` now checks the scheduled change when building price fallbacks:
```
activePlan = (nextBillingPlanId && nextBillingPlanEffectiveAt && periodStart >= nextBillingPlanEffectiveAt)
             ? nextBillingPlan
             : billingPlan
extensionPrice = settings.extensionPriceCents || activePlan?.extensionPriceCents || 3000
```
When the next plan is active for the requested period, the preview response includes:
```json
"scheduledPlanChange": { "planId": "…", "planName": "Growth Plan", "effectiveAt": "2027-07-01T00:00:00.000Z" }
```
No DB writes from preview.

**Audit logging:**
Every `POST` writes `BillingEventLog { type: "billing_plan.scheduled_change_set", metadata: { operatorId, previousNextPlanId, previousEffectiveAt, nextBillingPlanId, planName, effectiveAt } }`.
Every `DELETE` writes `BillingEventLog { type: "billing_plan.scheduled_change_cancelled", metadata: { operatorId, cancelledNextPlanId, cancelledEffectiveAt } }`.

**Portal — Company billing setup (`/admin/billing/settings`):**
New **Scheduled Plan Change** card rendered between the SOLA/Collections section and the Invoice Preview card:
- When no change scheduled: plan dropdown (from `GET /admin/billing/platform/billing-plans`), effective date picker (defaults to first of next month), "Schedule plan change" button. Price summary shown below dropdown.
- When a change is scheduled: blue notice ("⚡ Scheduled: Switch to plan X effective Y"), "Cancel scheduled change" button (red ghost, no confirm modal).
- Invoice Preview card now shows a yellow notice when the selected preview period uses the next plan's prices.

### What was NOT changed (Phase 1 scope)

- Phase 1 did not include worker consumption (added in **Phase 2** below).
- No proration.
- No tenant-facing UI for scheduled changes (operator-only).
- No SOLA auth/webhook changes.
- No dunning changes.
- No `PARTIALLY_PAID` implementation.

### Tests added

**`invoiceEngine.test.ts`:**
- Preview uses current plan prices when no scheduled change
- Preview uses current prices when `periodStart < nextBillingPlanEffectiveAt`
- Preview uses next plan prices when `periodStart >= nextBillingPlanEffectiveAt`
- Preview uses next plan prices on period after effectiveAt
- `scheduledPlanChange` absent when `nextBillingPlanId` is null

**`billingScheduledPlan.test.ts` (new):**
- Rejects unparseable date
- Rejects non-1st-of-month date
- Rejects non-midnight time on 1st
- Rejects current month
- Rejects past month
- Accepts first of next month
- Accepts far future month
- Handles December→January year rollover
- SUPER_ADMIN accepted; all other roles rejected (uses `canAccessPlatformAdminBillingRoutes`)

### Phase 2 (worker) — complete

**Module:** `apps/api/src/billing/billingScheduledPlanConsume.ts` — `consumeScheduledPlanChange({ tenantId, periodStart, invoiceId?, runId? })`.

**When:** `apps/worker/src/main.ts` → `runMonthlyBillingAutomation` calls it **after** an invoice exists for the period (existing OPEN invoice or newly created), **before** autopay. `createBillingInvoice` / `buildBillingInvoicePreview` already price the period using the next plan when `periodStart >= nextBillingPlanEffectiveAt` (Phase 1); consumption **persists** the switch for subsequent months.

**Apply rules:**
- Runs only if `nextBillingPlanId` and `nextBillingPlanEffectiveAt` are set and `periodStart >= nextBillingPlanEffectiveAt` (same threshold as preview).
- Loads target `BillingPlan` by id. **Missing row** (deleted FK): logs `billing_plan.change_skipped` with `reason: plan_not_found`, **leaves** the schedule in place.
- **Inactive** plan (`active: false`): logs `billing_plan.change_skipped` with `reason: inactive_plan`, **leaves** the schedule in place.
- **Active** plan: `tenantBillingSettings.updateMany` with `billingPlanId = plan.id`, copies `extensionPriceCents`, `additionalPhoneNumberPriceCents`, `smsPriceCents`, `firstPhoneNumberFree` from the plan, clears `nextBillingPlanId` and `nextBillingPlanEffectiveAt`, then logs `billing_plan.change_applied` (metadata includes previous/new plan ids, effectiveAt).

**Idempotency:** conditional `updateMany` on the current `(nextBillingPlanId, nextBillingPlanEffectiveAt)` pair; if already cleared, early return `no_schedule`. Race: `count === 0` → `skipped` `concurrent_or_already_applied`, no duplicate `change_applied` log.

**Failure isolation:** worker wraps `consumeScheduledPlanChange` in `try/catch`. Exceptions → `console.warn` + `BillingEventLog` type `billing_plan.change_consume_error`. **Charge path unchanged** (`chargeWorkerInvoice` not modified).

**Tests:** `billingScheduledPlanConsume.test.ts` (apply, before-effective, inactive, idempotent, concurrent, missing plan, DB throw).
