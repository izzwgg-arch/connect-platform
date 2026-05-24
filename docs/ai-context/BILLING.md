# Billing — quick reference
---

## Customer billing workspace redesign (2026-05-23)

This pass converts `/billing` into a premium SaaS finance workspace with light-mode default and dark-mode parity.

- Visual system
  - Wrapper `.billing-workspace` with dual-theme tokens (`--bw-*`), soft layered background, large-radius cards, thin borders, premium shadows.
  - Cards use `.billing-card`; KPI tiles in `.bw-kpi-grid` adopt calm spacing and status tones (good/neg based on balance/health).
  - Light by default; dark follows portal `data-theme="dark"` automatically. No forced black boxes.

- Content structure
  - Hero greeting with account-standing message and pay-now CTA when balance > 0.
  - KPI tiles: Current balance, Next autopay, Payment method (brand/last4/exp), Estimated next invoice (from `GET /billing/invoice-preview`), Active services (from `GET /billing/usage/current`), Billing health (worst invoice status).
  - Estimate preview: real itemized table (Item, Qty, Unit, Amount) with estimated total and tax note.
  - Billing timeline: reuses `BillingActivityList` against the latest open or most recent invoice.
  - Recent invoices: compact list with status pill and amount; links to detail.
  - Trust + security footer: PCI/SSL badges, accepted cards, and secure-processing copy.

- Data rules
  - All data sources are existing tenant routes: `/billing/settings`, `/billing/platform/invoices`, `/billing/payment-methods`, `/billing/usage/current`, `/billing/invoice-preview`.
  - No new backend routes or schema changes.

- Mobile
  - Tiles collapse to a single column; body sections stack; rows remain tappable with comfortable hit targets.


### Customer billing workspace — visual polish recap (2026-05-24)

- **KPI chips**
  - `.bw-kpi-chips` holds status chips on tiles.
  - `.bw-chip` standard pill; `.bw-chip--accent` for positive/high-signal states (e.g., Autopay).
  - Keep chip copy concise (e.g., "Default", "Autopay").

- **Empty states**
  - Use `.state-illus`, `.state-title`, `.state-text`, `.state-actions` under `.billing-workspace`.
  - Estimate preview, timeline, and invoices use a small inline icon, one-line helpful copy, and a relevant CTA.

- **Finance-card polish**
  - `.bw-kpi--pm` adds a subtle accent radial to the Payment method tile.
  - KPI tiles align CTAs via `.bw-kpi-cta { margin-top: auto; }` to keep consistent vertical rhythm.
  - Panel blending/shadows follow `--bw-*` tokens (no hardcoded hex); borders are thin and consistent.

- **Trust footer / logos**
  - Real brand SVGs for Visa/Mastercard/Amex/Discover under `.bw-card-logos`.
  - Sizing unified: `.cc-logo { height: 18px; width: auto; }`.
  - Maintain equal visual weight; avoid stretching.

> Read `CURSOR_START_HERE.md` first. High-risk: payments and invoices.

## Canonical production hostname

- **Portal + same-origin API:** `https://app.connectcomunications.com` (browser calls `/api/...` on that host unless `NEXT_PUBLIC_API_URL` overrides in a custom build).
- **Avoid typo domains** such as `app.connect.communications.com` (extra dot — *connect.communications*) — they are **not** the production app and cause confusing auth, API origin, or caching issues.

**Operator smoke, capture list for incidents, caps, dangerous actions:** see **`docs/ai-context/BILLING_OPERATOR_RUNBOOK.md`**.

## Billing timezone

- **Connect billing timezone:** `America/New_York`. Production servers may physically run outside the US (for example, Germany), so billing code must not infer billing dates from the host locale or system clock timezone.
- **Runtime default:** production `api` and `worker` containers run with `TZ=America/New_York` for operational consistency, but billing calculations still use explicit helpers in `apps/api/src/billing/billingTime.ts`.
- **Database timestamps:** remain UTC instants. Prisma/Postgres `DateTime` values such as `createdAt`, `updatedAt`, payment attempts, webhook events, and audit timestamps should continue to be stored as UTC.
- **Billing dates:** invoice periods, due dates, invoice-number month prefixes, billing CSV date suffixes, and customer-facing invoice email dates are interpreted in New York time.

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
| SOLA adapter selection (resolved effective config) | `apps/api/src/billing/solaGateway.ts` |
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

### Billing gateway resolution order (Cardknox/SOLA)

- Source of truth is `resolveBillingGatewayConfig(tenantId)` in `apps/api/src/billing/solaGateway.ts`.
- Resolution order: valid tenant override (when tenant overrides are enabled) -> enabled platform/main-tenant `BillingSolaConfig` -> explicit env fallback -> missing.
- When `BILLING_MAIN_TENANT_ID` (or `PLATFORM_TENANT_ID`) is set, only that tenant may provide the `main_tenant` source. The resolver must not borrow from a SUPER_ADMIN/latest-enabled customer tenant. If the configured main tenant has no enabled, decryptable config, resolution returns `missing` unless the requesting tenant has a valid tenant override.
- Env fallback is intentionally off by default. It is only used when there is no explicit main tenant id and `BILLING_GATEWAY_ALLOW_ENV_FALLBACK=1` is set.
- A tenant-local row that is disabled, stale, or has invalid credentials does not block inheritance; resolution falls through to the configured main tenant, then to explicit env fallback only when allowed.
- Live-charge confirmation checks in billing routes use the resolved effective config (mode/simulate/source), not `tenant.billingSolaConfig` directly.
- Worker autopay reuses the same resolver path via `getBillingSolaAdapter` imported from the API billing gateway module.

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

## Itemized telecom invoices (2026-05-21)

- Connect invoices must explain every dollar charged. Avoid opaque catch-all descriptions such as "monthly service balance" for recurring service. Monthly invoices should be created through `createBillingInvoice` / `buildBillingInvoicePreview`, which persist normal `BillingInvoiceLineItem` rows for extensions, local DIDs, toll-free DIDs, SMS packages, discounts/credits, E911, sales tax, regulatory recovery, USF/surcharge/custom telecom fees, and manual adjustments where appropriate.
- Totals must reconcile from line items: `subtotalCents`, `taxCents`, and `totalCents` are derived from `lineItems[].amountCents` in `invoiceEngine.ts`. PDF/admin/customer rendering should display line item type, quantity, unit price, service period metadata, taxes/fees, and grand total instead of recomputing hidden amounts in the UI.
- Editable service periods are represented by `BillingInvoice.periodStart` / `periodEnd` plus line item metadata: `servicePeriodStart`, `servicePeriodEnd`, `billingMonthCount`, `prorated`, and base monthly quantity/price fields when a recurring line is scaled.
- Admin monthly invoice creation accepts an optional billing period payload on `POST /admin/billing/tenants/:tenantId/invoices`: `serviceStartDate`, `serviceEndDate`, `billingMonthCount`, and `prorate`. If omitted, the tenant's configured billing schedule is used.
- Multi-month invoices scale recurring extension/DID/SMS service lines before tax/fee calculation. Integer month counts multiply quantities (for example, 2 extensions x 3 months = quantity 6 at the monthly unit price). Prorated periods keep integer quantities and prorate amounts/unit display, with the exact factor stored in metadata.

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
- Card number and CVV use **`@cardknox/react-ifields`** (`IField` components) in `PaymentMethodsModal` and **`OneTimeChargeDrawer`** (via shared **`CardknoxIFieldsForm`**) — PCI-safe hosted fields; only the card SUT is sent to Connect (`POST .../payment-methods/sola/save`, `POST .../one-time-charges` with `xSut`). Legacy CDN `ifield.htm` iframes remain on tenant **`/billing/payments`** only.
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

### Customer public pay (BillingInvoice, no login)

Signed pay links for **`BillingInvoice`** (platform stack) — distinct from legacy **`Invoice.payToken`** in `server.ts`.

| Piece | Location |
|-------|----------|
| Token | `createBillingInvoicePayToken` / `verifyBillingInvoicePayToken` in `billingPayToken.ts` (HMAC, 30-day TTL, bound to `invoiceId` + `tenantId`) |
| Public API (JWT bypass) | `GET /billing/platform/invoices/pay/:token`, `GET …/public-config`, `POST …/pay` in `publicPayRoutes.ts` |
| Portal page | `/pay/invoice/[token]` — light checkout UI + `CardknoxIFieldsForm` |
| Email URLs | `billingInvoicePublicPayUrl()` in `billingEmailLifecycle.ts` — invoice sent + payment-link emails use public pay URL (not login-gated `/billing/invoices/:id`) |

**PCI:** Server never receives PAN/CVV; amount due is computed server-side from `balanceDueCents`. Optional **save card** + **enable autopay** on public pay (default off): vault then charge saved token.

**Public pay UI/iFields refresh (2026-05-21):** `/pay/invoice/[token]` uses a centered Connect-branded checkout card (`pay-invoice.css`) with a light default and dark styling only when the portal theme is dark. `CardknoxIFieldsForm` still renders real Cardknox `IField` components for card number and CVV; the wrappers clip overflow and the hosted-field style is transparent/no-border/no-resize/no-scrollbar so PCI fields visually match native inputs. Do not replace these with fake inputs or send PAN/CVV to Connect. Visual verification used a local mock public-pay API plus Chrome screenshots for light desktop, dark desktop, and mobile (`_tmp_payment_page_light_desktop.png`, `_tmp_payment_page_dark_desktop.png`, `_tmp_payment_page_mobile.png`).

**Autopay scheduling + double-charge guard:** Worker monthly run computes an explicit `scheduledChargeAt` for each tenant billing cycle. Billing periods are anchored to the payment date in the configured billing timezone (`TenantBillingSettings.metadata.billingTimeZone` / `billingTimezone`, default `America/New_York`), not calendar-month UTC bounds. Example: `billingDayOfMonth=21` means service period **May 21 00:00 local → June 20 23:59:59.999 local**, with card charge eligibility starting at **May 21 00:00 local**. Worker startup catch-up may only charge when `now >= scheduledChargeAt`; "invoice exists" or UTC day matching is not sufficient. Worker monthly run + `chargeWorkerInvoice` also skip when `status === PAID` or `balanceDueCents <= 0` (`billing.autopay_skipped_already_paid`). `chargeBillingInvoice` / `chargeBillingInvoiceWithSut` throw `INVOICE_ALREADY_PAID` if paid before charge.

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

> **Shipped:** read-only sync + operator tenant mapping, token linking, readiness, manual schedule take-over, and worker guard. Sync/map/link still do **not** charge cards or disable Sola schedules.

### What this is

Many tenants already have saved cards and recurring schedules inside Sola (Cardknox).
Connect imports **safe** recurring schedule metadata from the Cardknox Recurring API and lets a **SUPER_ADMIN** map each schedule to a Connect tenant. Mapping only records the link — it does not move billing execution to Connect.

Important ownership rule: **tenant != recurring obligation**. A single Connect tenant may legitimately have multiple independent Sola recurring schedules, each representing a separate service/subscription/billing obligation and potentially a different amount or card. Do not merge, ignore, or suppress schedules solely because they map to the same tenant name.

### Hard constraints (sync/map/link — enforced in code)

- **No raw card / CVV.** Masked card metadata only (`Issuer`, `MaskedCardNumber`, `Exp` MMYY) during sync. Token linking fetches the reusable Sola token server-side and immediately stores it encrypted as `PaymentMethod.tokenEncrypted`; raw tokens are never returned to the browser or logged.
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

Sync uses: `/ListSchedules`, `/GetSchedule`, `/GetPaymentMethod` (masked fields only; token redacted before persistence). Token linking uses `/GetPaymentMethod` to fetch the vault token server-side, then encrypts it into `PaymentMethod`.

### Token reuse

The `Token` from `/GetPaymentMethod` is the same `xToken` used by `chargeToken()`. `POST /admin/billing/platform/sola-import/schedules/:id/link-token` encrypts it into `PaymentMethod.tokenEncrypted` after explicit operator action. Sync/map alone never stores it.

### Schema

Imported cards are tracked with `PaymentMethod.processorCustomerId`, `processorPaymentMethodId`, `isImported`, and `importedAt`.

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

Current Connect-native autopay is still tenant-settings based: one `TenantBillingSettings.autoBillingEnabled`, one `billingDayOfMonth`, and one `defaultPaymentMethodId` per tenant. That is sufficient for the current single monthly tenant invoice path, but it is **not** a recurring-obligation model. Until an explicit recurring obligation/subscription/service model exists, imported Sola schedules remain the source of truth for multiple independent recurring obligations during migration.

### Recurring ownership model

Connect must treat each recurring schedule/profile as its own business obligation:

- Multiple `BillingSolaExternalScheduleLink` rows may map to the same `tenantId`.
- Multiple imported `PaymentMethod` rows may exist for the same tenant and Sola customer.
- A same-tenant schedule with a different Sola customer/profile, amount, payment method, or service is **not** a duplicate by tenant name alone.
- Duplicate detection and idempotency must happen at the exact business operation level: invoice/subscription/service/obligation + amount + payment instrument + charge type.
- Cutover must not disable a Sola schedule until that specific obligation has a linked token/default choice and a Connect-side owner.
- If one tenant has multiple Sola schedules, cutover/readiness must be evaluated per schedule/obligation. The current tenant-level autopay switch should not be used as proof that all obligations for that tenant are migrated.

Example: tenant `Nexus Realty` may have separate recurring obligations for service `101`, service `102`, and service `103`, each with its own Sola schedule, amount, and card. Mapping all three to the same tenant is valid; auto-merging them would be wrong.

| Piece | Location |
|-------|----------|
| Service functions (token link, readiness, take-over) | `apps/api/src/billing/solaCutover.ts` |
| Recurring client additions (getPaymentMethodWithToken, updateSchedule) | `packages/integrations/src/sola-cardknox/recurring.ts` |
| API routes (link-token, readiness, take-over) | `apps/api/src/billing/routes.ts` (end of `registerBillingRoutes`) |
| Worker guard + schedule override consumption | `apps/worker/src/main.ts` (`checkActiveSolaScheduleBlock`, `getAndConsumeBillingScheduleOverride`) |
| Worker payment-date schedule math | `apps/worker/src/billingSchedule.ts` (`buildBillingSchedule`, `scheduledChargeAt`) |
| Sola imports UI (new states + actions) | `apps/portal/.../adminBillingSolaImportsWorkspace.tsx` |
| Migration | `packages/db/prisma/migrations/20260518100000_billing_sola_cutover/` |

### Cutover safety rules (enforced in code)

1. **Worker guard (Phase D):** Before charging any tenant, `checkActiveSolaScheduleBlock` checks for active Sola schedule links with `mappingStatus=MAPPED`, `isActive=true`, and `cutoverStatus != CUTOVER_COMPLETE`. If found → skip Connect autopay charge and log `billing.autopay_skipped_active_sola_schedule`.
2. **Take-over sequence:** disable Sola `/UpdateSchedule IsActive=false` MUST succeed before `autoBillingEnabled` is set to true. If Sola disable fails → `CUTOVER_FAILED`, Connect autopay NOT enabled.
3. **No immediate charge:** the take-over route never creates an invoice or calls chargeToken. Future charges happen via the normal worker billing day, and only after that tenant's local `scheduledChargeAt`.
4. **Double-charge detection:** `getBillingCutoverReadiness` returns `doubleChargeRisk=true` if Connect autopay is enabled AND an active non-cutover Sola schedule exists for the tenant.
5. **Payment-date billing periods:** worker-created invoices use payment-date → next-payment-date periods. Do not use UTC calendar-month bounds as charge eligibility.

### Known recurring-model gaps

- `TenantBillingSettings.defaultPaymentMethodId` is tenant-level. It cannot express a different default card per recurring obligation.
- `runMonthlyBillingAutomation` creates/charges one tenant invoice for the billing period. It is not yet a per-obligation scheduler.
- `takeOverBillingFromSola` disables one Sola schedule, then sets the tenant default PM and enables tenant-level autopay. With multiple schedules under one tenant, use it only when the operator has verified how the specific obligation maps to Connect.
- `getBillingCutoverReadiness` returns a representative `scheduleLink`; use the schedule import table for full per-schedule review when a tenant has more than one active Sola schedule.
- `POST /admin/billing/runs/monthly` should be treated carefully during migration because the worker has the active-Sola-schedule guard; any admin-run parity should be verified before use in cutover operations.

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
| `billing.autopay_skipped_not_due_yet` | Worker saw enabled autopay, but `now < scheduledChargeAt` in billing timezone |
| `billing.autopay_skipped_missing_default_payment_method` | Worker skipped because no active default payment method was available |
| `billing.autopay_skipped_live_charges_disabled` | Worker skipped because `BILLING_LIVE_CHARGES_DISABLED=1` |
| `billing.autopay_skipped_pending_operation_exists` | Worker skipped because an approved/pending `BillingChargeOperation` already exists |
| `billing.autopay_skipped_already_paid` | Worker skipped because the invoice is already paid or has no balance due |
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

**Env:** `BILLING_DUNNING_MAX_ATTEMPTS` (default 3, max 10), `BILLING_DUNNING_RETRY_DELAY_HOURS` (default 72). **`PUBLIC_PORTAL_URL`** for portal and public pay links in emails.

## Invoice PDF & email presentation (`TenantBillingSettings`)

| Field | Use |
|-------|-----|
| `invoiceCompanyName` | PDF header / bill-from branding. In HTML invoice emails it may appear only as **Billed company** context, never as the sender. |
| `invoiceLogoUrl` | **HTTPS only**, sanitized. PDF uses bundled local logo (`apps/api/src/billing/assets/connect-logo.png`) — no remote fetch. HTML invoice emails currently use the Connect logo for consistent sender identity. |
| `invoiceSupportEmail` / `invoiceSupportPhone` | PDF branding fields. HTML invoice emails use fixed Connect billing support details for sender clarity. |
| `invoiceFooterNote` / `invoicePaymentInstructions` | Plain text, length-capped. HTML invoice emails omit tenant footer notes to keep the Connect sender footer unambiguous; payment instructions may still appear as a concise body block. |
| `paymentTermsDays` | PDF detail row. Visible HTML invoice email copy intentionally stays short and omits terms clutter. |

**API:** `PUT /billing/settings/branding` (tenant JWT billing roles) and optional keys on `PUT /admin/billing/tenants/:tenantId/settings`. **Portal:** **`/billing/settings`** and **`/settings/billing`** (shared `TenantBillingSettingsContent`), and Company billing setup (**`/admin/billing/settings`**) branding card.

**Code:** `apps/api/src/billing/invoiceBranding.ts` (sanitize + resolve), `emailTemplates.ts` (shared HTML shell), `pdf.ts` (`renderBillingInvoicePdf`), `billingEmailLifecycle.ts` (passes resolved brand into templates).

### Invoice & email redesign (2026-05-19)

**Email templates (white/light theme):** All five billing email templates now use a white card layout with Connect blue (`#0284c7`) accent header. Previously dark-themed (`#0b1220`). Customer-friendly and mobile-responsive.

**Receipt email:** Structured summary box (amount paid, invoice #, payment date, card). Confirmation badge. Autopay note block. Copy states the invoice PDF is **attached** (not a download link).

**Invoice sent email:** Added optional `servicePeriod` field in the summary box. Computed from `invoice.periodStart`/`periodEnd` in `billingEmailLifecycle.ts`. Copy states the invoice PDF is **attached**.

**PDF (`renderBillingInvoicePdf`):**
- Modern light SaaS invoice layout inspired by Stripe/Linear/Ramp billing: thin Connect-blue top accent, white header, soft gray borders, generous whitespace, and compact card sections.
- Bundled local Connect logo PNG only (`apps/api/src/billing/assets/connect-logo.png`) — no remote image fetch. Keep this asset high-resolution (currently 960x264) because PDFKit rasterizes it into the PDF.
- Header row: logo left, invoice title/number right, modern rounded status pill. PAID uses soft green; unpaid/overdue states use soft orange/red; draft/void use muted gray.
- **Bill from** is fixed for the PDF: `Connect Communications, LLC`, `support@connectcomunications.com`, `845-723-1213`, and `connectcomunications.com`. The PDF intentionally omits the Connect physical address.
- **Bill to** uses tenant name, billing email, and billing/service address.
- Light balance card replaces the old dark/heavy panel. It shows large blue balance due, due date, and a clean blue **Pay Now Securely** button only when the invoice is not paid and has a positive balance. Paid invoices hide the button. The PDF does **not** display raw payment URLs.
- Metadata row: issue date, due date, and service period. Terms are intentionally omitted from the visible PDF metadata to keep the header area lighter.
- Line items use an inset, balanced table with inward-aligned QTY / UNIT PRICE / AMOUNT columns, subtle separators, generous row height, and safe wrapping for long descriptions.
- Totals render as a compact summary card with subtotal, credits, fees, taxes, amount paid, and blue emphasized balance due.
- Regulatory notices render as concise icon cards only with professional PDFKit-drawn icons and subtle light blue/cyan highlight backgrounds. The PDF intentionally avoids a heavy regulatory heading, "Telecom billing disclosures" title, or long legal paragraph.
- Footer renders four compact muted support columns with matching drawn icons: Billing Support, Customer Portal, Secure Payments, and Thank You.

**Fallback logo for HTML emails:** `{PUBLIC_PORTAL_URL}/connect-logo.png` from `apps/portal/public/connect-logo.png`.

### Invoice email responsive refresh (2026-05-21)

**Files touched:** `apps/api/src/billing/emailTemplates.ts`, `apps/api/src/billing/billingEmailTemplates.test.ts`, `apps/api/src/billing/invoiceBranding.test.ts`, and this doc. No invoice PDF generation, billing math, payment execution, queueing, or email infrastructure changed.

**Structure:** Billing HTML emails use a single responsive, Outlook-safe shell: light page background, centered 600px white table card, small Connect-blue top accent, Connect logo, “Connect Communications billing” heading, clean body copy, readable light summary card, optional CTA table button, attachment note, support block, and footer.

**Sender wording rule:** The footer must always be exactly `Sent by Connect Communications billing.` Never render `Sent by [tenant] via Connect Communications billing.` Tenant/customer names may appear only as billed company/customer context, such as the `Billed company` summary row.

**Support info:** HTML billing emails show fixed Connect support details: `Connect Communications, LLC`, `support@connectcomunications.com`, `connectcomunications.com`, and `845-723-1213`.

**Responsive / Outlook notes:** Core layout is table-based with inline styles, a max-width 600px card, mobile media query for full-width CTA and safer padding, and a VML conditional-comment fallback for the primary CTA in Outlook. Do not add JavaScript device/client detection to emails. Do not expose raw payment URLs as visible main HTML content; URLs belong in CTA `href` attributes and clean plain-text bodies.

**CTA behavior:** `invoiceSentEmail` / `invoiceReadyEmail` show **Pay Invoice** only when a payment URL exists. `paymentLinkEmail` shows **Pay Invoice** only when `payUrl` exists. Paid receipt emails do not show a Pay Invoice CTA; they may keep a non-payment “View invoice” link.

**Verification:** Run `pnpm --filter @connect/api typecheck` and the billing email template tests. Manually inspect generated unpaid invoice, paid receipt, mobile-width, desktop-width, and Outlook-safe HTML when preview tooling is available. Confirm the footer sender wording, Connect support info, no physical address, no visible raw payment URL, and that the PDF attachment marker remains present for invoice/receipt jobs.

### HTML invoice redesign (2026-05-20)

**Scope:** Tenant invoice detail page: `apps/portal/app/(platform)/billing/invoices/[id]/page.tsx` plus scoped stylesheet `apps/portal/app/(platform)/billing/invoices/[id]/invoicePrint.css`. The API PDF route is still `GET /billing/platform/invoices/:id/pdf`; billing math, schema, payment execution, email templates, and admin invoice pages are unchanged.

**Architecture:**
- The tenant invoice detail page now renders a dedicated **HTML invoice document** instead of generic `DetailCard` + `DataTable` blocks.
- Existing data sources are preserved: `GET /billing/platform/invoices/:id` for invoice/line items/transactions/events and `GET /billing/settings` for presentation/support/payment settings.
- The document layout is: premium neutral header + Connect logo, billing parties grid, payment CTA panel, invoice metadata strip, line-item table, payment instructions, billing summary, regulatory notices, then non-print payment history/activity.
- `Print / save PDF` calls `window.print()` and relies on `invoicePrint.css`; `Download PDF` uses the API-generated PDF attachment/download path.

**Telecom regulatory notice handling:**
- Bottom section title: **Regulatory & Billing Notices**.
- Notices are display-ready and conservative; they use “if applicable” language for E911, regulatory recovery, USF/FUSF, TRS/relay, taxes, surcharges, payment terms, disputes, and remittance support.
- Tenant-configurable text is appended from `TenantBillingSettings.invoiceFooterNote`; payment/remittance instructions come from `invoicePaymentInstructions`.
- Support contact wording uses `invoiceSupportEmail`, `invoiceSupportPhone`, or `billingEmail` when present. No fake legal claims, provider registrations, tax IDs, FCC claims, or jurisdiction-specific assertions are hardcoded.

**Line items / future extensibility:**
- The HTML invoice classifies displayed rows by existing `lineItem.type` and description text only: service, credit, tax, E911, regulatory, USF/FUSF, TRS/relay, and generic surcharge rows.
- Classification is presentation-only; totals use server-provided `subtotalCents`, `taxCents`, `totalCents`, `balanceDueCents`, and approved transactions.
- Future DID charges, usage, international minutes, credits, telecom taxes, and regulatory rows can be added as line items without changing the layout.

**Print/PDF considerations:**
- `invoicePrint.css` scopes styles to `.billing-html-page` / `.invoice-document` and includes `@media print`.
- Print hides topbar/sidebar/action controls/history, flattens shadows/backgrounds, keeps letter margins, and marks major invoice sections as `break-inside: avoid`.
- Keep invoice copy readable in grayscale: do not rely on color alone for status, totals, or fee categories.
- The API PDF route uses `apps/api/src/billing/pdf.ts` and is the source for both authenticated PDF downloads and outbound billing email attachments.
- The PDFKit renderer now mirrors the modern invoice structure with a neutral header, light balance card, billing parties, three-column metadata row, inward-aligned line-item table, compact billing summary, simplified regulatory notice cards, and professional footer.
- PDFKit registers the bundled Inter variable font from `apps/api/src/billing/assets/InterVariable.ttf` as the invoice sans face, with Helvetica as the emergency fallback. Spacing, larger body sizes, bold amounts, semibold headings, uppercase labels, and hierarchy are tuned for a modern SaaS invoice look.
- Pagination safeguards call `ensureSpace` before tall sections and line item rows. Long descriptions wrap inside the description column and should not overlap amount columns or totals. If invoices have many rows, notices/footer may continue to page 2; do not force all content onto page 1.

**Verification:**
- `pnpm typecheck` in `apps/api` for renderer type safety.
- Smoke-render unpaid invoice, paid invoice, long line item description, and multiple service/tax/fee rows.
- Check fixed contact details, absence of physical address, clean unpaid-only payment CTA, no raw payment URL, no Terms block, no legal paragraph under notice cards, table columns inside the page, and one-page behavior for normal invoices.

### Invoice PDF attachments + portal PDF routes (2026-05-19)

**Email PDF attachments (no schema migration):** When `processEmailJobsBatch` in `apps/api/src/server.ts` sends billing jobs (`BILLING_INVOICE_SENT`, `BILLING_INVOICE_READY`, `BILLING_RECEIPT`), it generates the invoice PDF at send time via `billingEmailAttachments.ts` and attaches it for **SendGrid** and **SMTP**. Templates embed a hidden HTML marker `<!-- connect-billing-invoice:{id} -->` so the processor can resolve the `BillingInvoice` without a JWT-protected API link. Invoice/receipt emails no longer link to `GET /billing/platform/invoices/:id/pdf` (that route requires login).

**PDF download in Connect:**
- **Tenant users:** `GET /billing/platform/invoices/:id/pdf` (JWT + `?token=` for new-tab download).
- **Platform admin:** `GET /admin/billing/invoices/:id/pdf` — admin billing **Download PDF** uses this route (`adminBillingOpsPanels.tsx`).
- **SUPER_ADMIN** may open any tenant’s invoice on the tenant PDF route (cross-tenant lookup in `billingInvoicePdfAccess.ts`).

**Code:** `billingInvoicePdfAccess.ts`, `billingEmailAttachments.ts`, `emailTemplates.ts` (`billingInvoiceEmailMarker`), `server.ts` (`sendEmailJobNow` attachments).

**No billing math changes. No payment execution changes. No charges run from this pass.**

**Legal/commercial gaps (display only — no billing math affected):**
- Provider legal address: not in schema.
- Provider tax ID: not in schema.

**No billing math changes. No schema migrations. No payment execution changes. No telephony/CRM/mobile changes.**
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
| **Email + PDF** | Global email processor in **`apps/api/src/server.ts`** (`processEmailJobsBatch` / `sendEmailJobNow`). Billing invoice/receipt jobs attach a generated PDF at send time. Set **`PUBLIC_PORTAL_URL`** for portal/pay links in email bodies. |
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
4. **Invoice:** Admin **Generate Invoice** or tenant flow that creates **`BillingInvoice`** → line items + totals; open **PDF** (tenant: `GET /billing/platform/invoices/:id/pdf`; admin: `GET /admin/billing/invoices/:id/pdf`).
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
