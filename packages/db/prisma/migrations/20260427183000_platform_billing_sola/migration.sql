-- Platform billing system for ConnectComms tenant invoices and SOLA card-on-file payments.
-- Existing customer Invoice/Subscription tables are left unchanged.

CREATE TYPE "BillingInvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'FAILED', 'OVERDUE', 'VOID');
CREATE TYPE "BillingLineItemType" AS ENUM ('EXTENSION', 'PHONE_NUMBER', 'SMS_PACKAGE', 'SALES_TAX', 'E911_FEE', 'REGULATORY_FEE', 'CREDIT', 'DISCOUNT', 'MANUAL_ADJUSTMENT');
CREATE TYPE "BillingPaymentMethodProcessor" AS ENUM ('SOLA');
CREATE TYPE "BillingPaymentTransactionStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'ERROR', 'VOIDED', 'REFUNDED');
CREATE TYPE "BillingRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

ALTER TABLE "Extension" ADD COLUMN "billable" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "BillingPlan" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "extensionPriceCents" INTEGER NOT NULL DEFAULT 3000,
  "additionalPhoneNumberPriceCents" INTEGER NOT NULL DEFAULT 1000,
  "smsPriceCents" INTEGER NOT NULL DEFAULT 1000,
  "firstPhoneNumberFree" BOOLEAN NOT NULL DEFAULT true,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TaxProfile" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "county" TEXT,
  "salesTaxRate" DECIMAL(7,6) NOT NULL DEFAULT 0,
  "e911FeePerExtension" INTEGER NOT NULL DEFAULT 0,
  "regulatoryFeePercent" DECIMAL(7,6) NOT NULL DEFAULT 0,
  "regulatoryFeeEnabled" BOOLEAN NOT NULL DEFAULT true,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TaxProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentMethod" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "processor" "BillingPaymentMethodProcessor" NOT NULL DEFAULT 'SOLA',
  "tokenEncrypted" TEXT NOT NULL,
  "tokenKeyId" TEXT NOT NULL DEFAULT 'v1',
  "brand" TEXT,
  "last4" TEXT,
  "expMonth" TEXT,
  "expYear" TEXT,
  "cardholderName" TEXT,
  "billingZip" TEXT,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TenantBillingSettings" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "billingPlanId" TEXT,
  "extensionPriceCents" INTEGER NOT NULL DEFAULT 3000,
  "additionalPhoneNumberPriceCents" INTEGER NOT NULL DEFAULT 1000,
  "smsPriceCents" INTEGER NOT NULL DEFAULT 1000,
  "firstPhoneNumberFree" BOOLEAN NOT NULL DEFAULT true,
  "smsBillingEnabled" BOOLEAN NOT NULL DEFAULT false,
  "taxEnabled" BOOLEAN NOT NULL DEFAULT false,
  "taxProfileId" TEXT,
  "autoBillingEnabled" BOOLEAN NOT NULL DEFAULT false,
  "billingDayOfMonth" INTEGER NOT NULL DEFAULT 1,
  "paymentTermsDays" INTEGER NOT NULL DEFAULT 15,
  "defaultPaymentMethodId" TEXT,
  "billingEmail" TEXT,
  "billingAddress" JSONB,
  "serviceAddress" JSONB,
  "creditsCents" INTEGER NOT NULL DEFAULT 0,
  "discountPercent" DECIMAL(7,6) NOT NULL DEFAULT 0,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TenantBillingSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillingInvoice" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "invoiceNumber" TEXT NOT NULL,
  "status" "BillingInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dueDate" TIMESTAMP(3) NOT NULL,
  "subtotalCents" INTEGER NOT NULL DEFAULT 0,
  "taxCents" INTEGER NOT NULL DEFAULT 0,
  "totalCents" INTEGER NOT NULL DEFAULT 0,
  "amountPaidCents" INTEGER NOT NULL DEFAULT 0,
  "balanceDueCents" INTEGER NOT NULL DEFAULT 0,
  "paymentMethodId" TEXT,
  "paidAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "voidedAt" TIMESTAMP(3),
  "lastEmailStatus" TEXT,
  "lastEmailedAt" TIMESTAMP(3),
  "pdfStorageKey" TEXT,
  "pdfGeneratedAt" TIMESTAMP(3),
  "notes" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingInvoice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillingInvoiceLineItem" (
  "id" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "type" "BillingLineItemType" NOT NULL,
  "description" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "unitPriceCents" INTEGER NOT NULL DEFAULT 0,
  "amountCents" INTEGER NOT NULL,
  "taxable" BOOLEAN NOT NULL DEFAULT true,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingInvoiceLineItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentTransaction" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "invoiceId" TEXT,
  "paymentMethodId" TEXT,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "status" "BillingPaymentTransactionStatus" NOT NULL DEFAULT 'PENDING',
  "processor" "BillingPaymentMethodProcessor" NOT NULL DEFAULT 'SOLA',
  "processorTransactionId" TEXT,
  "responseCode" TEXT,
  "responseMessage" TEXT,
  "rawResponseSafeJson" JSONB,
  "idempotencyKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillingRun" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "status" "BillingRunStatus" NOT NULL DEFAULT 'RUNNING',
  "dryRun" BOOLEAN NOT NULL DEFAULT false,
  "totals" JSONB,
  "errorMessage" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillingEventLog" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "invoiceId" TEXT,
  "runId" TEXT,
  "type" TEXT NOT NULL,
  "message" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingEventLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingPlan_tenantId_key" ON "BillingPlan"("tenantId");
CREATE UNIQUE INDEX "BillingPlan_code_key" ON "BillingPlan"("code");
CREATE INDEX "BillingPlan_active_code_idx" ON "BillingPlan"("active", "code");
CREATE UNIQUE INDEX "TaxProfile_state_county_key" ON "TaxProfile"("state", "county");
CREATE INDEX "TaxProfile_enabled_state_county_idx" ON "TaxProfile"("enabled", "state", "county");
CREATE INDEX "PaymentMethod_tenantId_active_idx" ON "PaymentMethod"("tenantId", "active");
CREATE INDEX "PaymentMethod_tenantId_isDefault_idx" ON "PaymentMethod"("tenantId", "isDefault");
CREATE UNIQUE INDEX "TenantBillingSettings_tenantId_key" ON "TenantBillingSettings"("tenantId");
CREATE INDEX "TenantBillingSettings_taxProfileId_idx" ON "TenantBillingSettings"("taxProfileId");
CREATE INDEX "TenantBillingSettings_autoBillingEnabled_billingDayOfMonth_idx" ON "TenantBillingSettings"("autoBillingEnabled", "billingDayOfMonth");
CREATE UNIQUE INDEX "BillingInvoice_invoiceNumber_key" ON "BillingInvoice"("invoiceNumber");
CREATE INDEX "BillingInvoice_tenantId_status_dueDate_idx" ON "BillingInvoice"("tenantId", "status", "dueDate");
CREATE INDEX "BillingInvoice_tenantId_periodStart_periodEnd_idx" ON "BillingInvoice"("tenantId", "periodStart", "periodEnd");
CREATE INDEX "BillingInvoice_createdAt_idx" ON "BillingInvoice"("createdAt");
CREATE INDEX "BillingInvoiceLineItem_invoiceId_idx" ON "BillingInvoiceLineItem"("invoiceId");
CREATE INDEX "BillingInvoiceLineItem_tenantId_type_idx" ON "BillingInvoiceLineItem"("tenantId", "type");
CREATE UNIQUE INDEX "PaymentTransaction_idempotencyKey_key" ON "PaymentTransaction"("idempotencyKey");
CREATE INDEX "PaymentTransaction_tenantId_createdAt_idx" ON "PaymentTransaction"("tenantId", "createdAt");
CREATE INDEX "PaymentTransaction_invoiceId_createdAt_idx" ON "PaymentTransaction"("invoiceId", "createdAt");
CREATE INDEX "PaymentTransaction_processor_processorTransactionId_idx" ON "PaymentTransaction"("processor", "processorTransactionId");
CREATE INDEX "BillingRun_status_startedAt_idx" ON "BillingRun"("status", "startedAt");
CREATE INDEX "BillingRun_tenantId_startedAt_idx" ON "BillingRun"("tenantId", "startedAt");
CREATE INDEX "BillingEventLog_tenantId_createdAt_idx" ON "BillingEventLog"("tenantId", "createdAt");
CREATE INDEX "BillingEventLog_invoiceId_createdAt_idx" ON "BillingEventLog"("invoiceId", "createdAt");
CREATE INDEX "BillingEventLog_runId_createdAt_idx" ON "BillingEventLog"("runId", "createdAt");

ALTER TABLE "BillingPlan" ADD CONSTRAINT "BillingPlan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaxProfile" ADD CONSTRAINT "TaxProfile_state_county_nonempty" CHECK (length(trim("state")) = 2);
ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantBillingSettings" ADD CONSTRAINT "TenantBillingSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantBillingSettings" ADD CONSTRAINT "TenantBillingSettings_billingPlanId_fkey" FOREIGN KEY ("billingPlanId") REFERENCES "BillingPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TenantBillingSettings" ADD CONSTRAINT "TenantBillingSettings_taxProfileId_fkey" FOREIGN KEY ("taxProfileId") REFERENCES "TaxProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TenantBillingSettings" ADD CONSTRAINT "TenantBillingSettings_defaultPaymentMethodId_fkey" FOREIGN KEY ("defaultPaymentMethodId") REFERENCES "PaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TenantBillingSettings" ADD CONSTRAINT "TenantBillingSettings_billingDay_check" CHECK ("billingDayOfMonth" >= 1 AND "billingDayOfMonth" <= 28);
ALTER TABLE "TenantBillingSettings" ADD CONSTRAINT "TenantBillingSettings_terms_check" CHECK ("paymentTermsDays" >= 0 AND "paymentTermsDays" <= 90);
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "PaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BillingInvoiceLineItem" ADD CONSTRAINT "BillingInvoiceLineItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "BillingInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "BillingInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "PaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BillingRun" ADD CONSTRAINT "BillingRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BillingEventLog" ADD CONSTRAINT "BillingEventLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BillingEventLog" ADD CONSTRAINT "BillingEventLog_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "BillingInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BillingEventLog" ADD CONSTRAINT "BillingEventLog_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BillingRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "BillingPlan" ("id", "code", "name", "extensionPriceCents", "additionalPhoneNumberPriceCents", "smsPriceCents", "firstPhoneNumberFree", "active", "updatedAt")
VALUES ('billing_plan_connect_default', 'connectcomms-default', 'ConnectComms Default', 3000, 1000, 1000, true, true, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "TaxProfile" ("id", "name", "state", "county", "salesTaxRate", "e911FeePerExtension", "regulatoryFeePercent", "enabled", "updatedAt")
VALUES
  ('tax_profile_ny_default', 'New York Default', 'NY', NULL, 0.040000, 0, 0.000000, true, CURRENT_TIMESTAMP),
  ('tax_profile_ny_orange', 'Orange County, NY', 'NY', 'Orange', 0.081250, 0, 0.000000, true, CURRENT_TIMESTAMP),
  ('tax_profile_ny_rockland', 'Rockland County, NY', 'NY', 'Rockland', 0.083750, 0, 0.000000, true, CURRENT_TIMESTAMP)
ON CONFLICT ("state", "county") DO NOTHING;
