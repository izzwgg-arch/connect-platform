# Billing — quick reference

> Read `CURSOR_START_HERE.md` first. High-risk: payments and invoices.

## Where the code lives

| Concern | Location |
|--------|----------|
| Tenant + platform REST (`registerBillingRoutes`) | `apps/api/src/billing/routes.ts` |
| JWT role gates for those routes | `apps/api/src/billing/billingAuth.ts` |
| Invoice preview / create | `apps/api/src/billing/invoiceEngine.ts` |
| Tax profiles (sales / E911 / regulatory math) | `apps/api/src/billing/taxes.ts` |
| Tax provider abstraction + audit snapshot shape | `apps/api/src/billing/taxProvider.ts` |
| SOLA adapter selection (per-tenant vs env) | `apps/api/src/billing/solaGateway.ts` |
| Public billing URLs (SOLA webhook) | `apps/api/src/billing/solaPublicUrls.ts` |
| Token charges, hosted session helper, webhook apply + dedupe | `apps/api/src/billing/solaBillingPayments.ts` |
| Cardknox client (`gatewayjson`, parse/verify) | `packages/integrations/src/sola-cardknox/index.ts` |
| Legacy + subscription + `POST /webhooks/sola-cardknox` | `apps/api/src/server.ts` (large file — grep paths) |
| Invoice email lifecycle (queue, dedupe, URLs) | `apps/api/src/billing/billingEmailLifecycle.ts` |
| Autopay dunning metadata + retry picker | `apps/api/src/billing/billingDunning.ts` |
| HTML email bodies (billing) | `apps/api/src/billing/emailTemplates.ts` |
| Monthly autopay + dunning sweep | `apps/worker/src/main.ts` (`runMonthlyBillingAutomation`, `runBillingDunningRetries`, `chargeWorkerInvoice`) |
| Platform admin billing UI (overview) | `apps/portal/app/(platform)/admin/billing/page.tsx` |
| Platform admin payment operations UI (invoices + transactions) | `apps/portal/app/(platform)/admin/billing/invoices/page.tsx` |
| Platform admin billing settings UI | `apps/portal/app/(platform)/admin/billing/settings/page.tsx` |
| Nav visibility for Admin Billing | `apps/portal/navigation/navConfig.ts` → `isNavItemVisibleForUser` |
| Tenant billing settings UI (shared) | `apps/portal/app/(platform)/billing/TenantBillingSettingsContent.tsx` |
| Admin per-tenant config forms (pricing, branding, SOLA) | `apps/portal/app/(platform)/admin/billing/_components/tenantBillingConfigForms.tsx` |

## Auth rules (JWT `UserRole`, not only portal permissions)

1. **Tenant routes** under `apps/api/src/billing/routes.ts` (`/billing/settings`, `/billing/platform/*`, `/billing/payment-methods`, …): allowed DB roles are **`SUPER_ADMIN`, `TENANT_ADMIN`, `ADMIN`, `BILLING_ADMIN`, `BILLING`** — aligned with `canManageBilling()` in `server.ts`. Portal must still pass prefix permission `can_view_billing_overview` (see `PORTAL_API_PERMISSION_RULES` in `server.ts`).

2. **Platform admin routes** (`/admin/billing/*` in the same file): **`SUPER_ADMIN` only** inside the route handler. Portal: **Admin Billing** and **Admin Billing Settings** nav and **`/admin/billing`** / **`/admin/billing/settings`** pages require **`backendJwtRole === "SUPER_ADMIN"`** and `can_view_admin_billing`.

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

- **Tenant:** **`/billing`** (overview — balances, invoices, usage metrics, activity; configuration links to **`/billing/settings`**), **`/billing/settings`** (same content as **`/settings/billing`**: SOLA/Cardknox tenant config + invoice branding via existing APIs), **`/billing/invoices`**, **`/billing/invoices/[id]`**, **`/billing/payments`**, **`/billing/receipts`** — see `apps/portal/app/(platform)/billing/**`. Uses tenant routes only (`/billing/...`). Invoice detail shows **`BillingEventLog`** via fields on **`GET /billing/platform/invoices/:id`** (no extra events route). Actions call **`POST .../email-invoice`**, **`POST .../email-payment-link`**, **`POST .../pay`**, PDF query on the API host — buttons stay disabled while a request is in flight; email actions require **`billingEmail`** on tenant settings (portal shows a hint when missing).
- **Platform admin:** **`/admin/billing`** (operational overview, tenant rail, preview, payment methods, recent invoices, platform monthly run) and **`/admin/billing/settings?tenantId=…`** (per-tenant **Monthly Pricing**, invoice branding, **SOLA Gateway** forms) — **`SUPER_ADMIN`** + `can_view_admin_billing`; uses **`/admin/billing/...`** only. Recent failures table comes from **`GET /admin/billing/overview`**. Run history from **`GET /admin/billing/runs/recent`**. Per-invoice **Activity** loads **`GET /admin/billing/invoices/:id/events`**.
- **Payment Operations page:** **`/admin/billing/invoices`** — cross-tenant operator view with two tabs:
  - **Invoices tab:** paginated list of all `BillingInvoice` records via **`GET /admin/billing/invoices?status=&search=&page=&limit=`**. Actions per row:
    - **Detail** — opens `InvoiceDetailModal` (slide-over drawer) with full line items, all payment attempts with card/response, and `BillingEventLog` timeline (loaded via `GET /admin/billing/invoices/:id`).
    - **Cards** — opens `PaymentMethodsModal` to list, set-default, remove, and **add** saved cards for the tenant. List loaded via `GET /admin/billing/platform/tenants/:tenantId/payment-methods`. Add card uses iFields tokenization (see "Admin add-card iFields" below).
    - **Charge card** — opens `ManualPayModal`: pick saved card, enter optional operator note, 2-step confirmation with **LIVE CHARGE** or SANDBOX badge. Calls `POST /admin/billing/invoices/:id/pay` with `{ paymentMethodId, note, confirmLive: true }`.  Duplicate submits disabled; exact API error shown on failure.
    - **Mark Paid** — direct `POST /admin/billing/invoices/:id/mark-paid` (full balance only). **Phase-0 guard (2026-05):** `markBillingInvoicePaid` now rejects any `amountCents` less than `invoice.totalCents` with `PARTIAL_PAYMENT_NOT_SUPPORTED` before touching the DB. Passing no amount or passing the exact total still marks the invoice `PAID` with `balanceDueCents = 0`. This prevents a `PAID + balanceDueCents > 0` impossible state until a `PARTIALLY_PAID` enum is added in Phase 1.
    - **Send invoice**, **Email link**, **Void**, **Activity log** (inline expand) — unchanged.
    - Disabled **SMS link** placeholder (deferred).
  - **Transactions tab:** paginated audit of all `PaymentTransaction` records via **`GET /admin/billing/transactions?status=&tenantId=&page=&limit=`**. Each row has a **Detail** button opening `TransactionDetailModal` — shows amount, card, processor ref, response code/message, idempotency key, and full gateway response JSON (loaded via `GET /admin/billing/transactions/:id`).
  - **Collections tab:** operator-grade dunning visibility and per-invoice controls. All data is lazy-loaded. Phase 1 only (controls stored; worker enforcement requires Phase 2). Two sections:
    - **Collections Overview** — on-demand via `GET /admin/billing/collections/overview`. Shows count badges (failed/open, retry-eligible, paused, exhausted, do-not-charge) and three tables: "Ready to retry", "Paused / Do-not-charge", "Retries exhausted". Each row has an invoice button that opens `InvoiceDetailModal`.
    - **Preview Next Dunning Sweep** — on-demand via `GET /admin/billing/collections/preview-retries`. Lists invoices the dunning worker would pick up on the next sweep, given current `nextRetryAt` and attempt counts. Flags shown but **not yet enforced by worker** (Phase 1).
    - A yellow **Phase 1 notice** is always visible: "Controls stored, worker enforcement pending."
  - **Reports tab:** lazy-loaded operator reports and CSV exports. No data is fetched until the operator clicks "Load report". Three sections:
    - **CSV Exports** — direct `<a download>` links to `GET /admin/billing/reports/export/invoices` and `GET /admin/billing/reports/export/transactions`. Optional status filter. Files named `billing-invoices-YYYY-MM-DD.csv` / `billing-transactions-YYYY-MM-DD.csv`. Generated-At and Generated-By metadata rows at the top.
    - **Aging Report** — on-demand load via `GET /admin/billing/reports/aging`. Shows all OPEN/FAILED/OVERDUE invoices with outstanding balance: tenant, invoice #, status, due date, days overdue (red/bold when > 30), balance due. "⬇ CSV" button (`GET /admin/billing/reports/aging/export`, file `billing-aging-YYYY-MM-DD.csv`) appears after load.
    - **Failed Payments** — on-demand load via `GET /admin/billing/reports/failed-payments`. Shows FAILED/OVERDUE invoices with last processor response code and reason. "⬇ CSV" button (`GET /admin/billing/reports/failed-payments/export`, file `billing-failed-payments-YYYY-MM-DD.csv`) appears after load.
    - A **"results capped"** yellow banner appears when the row cap is reached (2 000 aging, 1 000 failed, 5 000 exports).
    - All tables are read-only. Overflow is scrollable for mobile.
  - Linked from **`/admin/billing`** via a **Payment Operations** button.
  - All admin billing routes are `requirePlatformBilling` (`SUPER_ADMIN` only). No DB migration needed.
- **Admin Billing Settings** (`/admin/billing/settings`): now includes a **Collections Automation** card (alongside Monthly Pricing, Invoice Branding, SOLA Gateway). Calls `GET/PUT /admin/billing/platform/tenants/:tenantId/collections-config` to read/write `TenantBillingSettings.metadata.collections`. Same Phase 1 notice.

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

### Collections automation controls — Phase 1 (API + Portal)

**Phase 1 (2026-05):** Stores and displays controls. Worker enforcement requires Phase 2.  
**Phase 2 (deferred):** Worker reads metadata flags before retrying invoices.

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

#### Phase 1 / Phase 2 boundary

| Capability | Phase 1 (done) | Phase 2 (deferred) |
|-----------|---------------|-------------------|
| Store pause/do-not-charge/skip flags | ✅ | — |
| Show flags in Collections tab UI | ✅ | — |
| Show flags in InvoiceDetailModal | ✅ | — |
| Worker respects `paused` flag | ❌ | ✅ |
| Worker respects `doNotCharge` flag | ❌ | ✅ |
| Worker respects `skipNextRetry` flag | ❌ | ✅ |
| Worker reads per-tenant `maxAttempts`/`retryDelayHours` overrides | ❌ | ✅ |
| Deterministic idempotency keys (`worker:billing:sale:${invoice.id}:a${attempt}`) | ❌ | ✅ |

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
3. **Webhook/Postback URL:** Connect exposes exactly **`{PUBLIC_API_BASE_URL or PUBLIC_API_URL}/webhooks/sola-cardknox`** (computed in **`apps/api/src/billing/solaPublicUrls.ts`**). Copy this URL from **Billing → Settings** or **Admin Billing → Settings → SOLA Gateway** into the vendor’s webhook/postback URL field.
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

**API:** `PUT /billing/settings/branding` (tenant JWT billing roles) and optional keys on `PUT /admin/billing/tenants/:tenantId/settings`. **Portal:** **`/billing/settings`** and **`/settings/billing`** (shared `TenantBillingSettingsContent`), and Admin Billing Settings (**`/admin/billing/settings`**) branding card.

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
