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

## Operator portal (billing)

- **Tenant:** **`/billing`** (overview — balances, invoices, usage metrics, activity; configuration links to **`/billing/settings`**), **`/billing/settings`** (same content as **`/settings/billing`**: SOLA/Cardknox tenant config + invoice branding via existing APIs), **`/billing/invoices`**, **`/billing/invoices/[id]`**, **`/billing/payments`**, **`/billing/receipts`** — see `apps/portal/app/(platform)/billing/**`. Uses tenant routes only (`/billing/...`). Invoice detail shows **`BillingEventLog`** via fields on **`GET /billing/platform/invoices/:id`** (no extra events route). Actions call **`POST .../email-invoice`**, **`POST .../email-payment-link`**, **`POST .../pay`**, PDF query on the API host — buttons stay disabled while a request is in flight; email actions require **`billingEmail`** on tenant settings (portal shows a hint when missing).
- **Platform admin:** **`/admin/billing`** (operational overview, tenant rail, preview, payment methods, recent invoices, platform monthly run) and **`/admin/billing/settings?tenantId=…`** (per-tenant **Monthly Pricing**, invoice branding, **SOLA Gateway** forms) — **`SUPER_ADMIN`** + `can_view_admin_billing`; uses **`/admin/billing/...`** only. Recent failures table comes from **`GET /admin/billing/overview`**. Run history from **`GET /admin/billing/runs/recent`**. Per-invoice **Activity** loads **`GET /admin/billing/invoices/:id/events`**.
- **Payment Operations page:** **`/admin/billing/invoices`** — cross-tenant operator view with two tabs:
  - **Invoices tab:** paginated list of all `BillingInvoice` records via **`GET /admin/billing/invoices?status=&search=&page=&limit=`**. Columns: invoice #, tenant, period, total/balance, status, due/paid dates, card last4, last processor ref. Actions per row: Mark Paid, Charge card (if saved card present), Send invoice email, Email payment link, Void, Activity log (inline expand). Disabled **SMS link** placeholder (deferred). Filter by status pill; live search by invoice # or tenant name.
  - **Transactions tab:** read-only paginated audit of all `PaymentTransaction` records via **`GET /admin/billing/transactions?status=&tenantId=&page=&limit=`**. Columns: date, tenant, invoice #, amount, status, card, processor ref, response code. No action buttons.
  - Linked from **`/admin/billing`** via a **Payment Operations** button.
  - Both routes are `requirePlatformBilling` (`SUPER_ADMIN` only). No DB migration needed — queries existing tables.

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
