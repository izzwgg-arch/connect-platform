-- AddBillingProfiles: additive migration — no data loss, no drops

-- Create TenantBillingProfile table
CREATE TABLE IF NOT EXISTS "TenantBillingProfile" (
    "id"                 TEXT        NOT NULL,
    "tenantId"           TEXT        NOT NULL,
    "label"              TEXT        NOT NULL,
    "paymentMethodId"    TEXT,
    "autoBillingEnabled" BOOLEAN     NOT NULL DEFAULT false,
    "billingEmail"       TEXT,
    "notes"              TEXT,
    "lineItemsJson"      JSONB,
    "createdByUserId"    TEXT,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantBillingProfile_pkey" PRIMARY KEY ("id")
);

-- FK: tenantId → Tenant.id (cascade delete)
ALTER TABLE "TenantBillingProfile"
    ADD CONSTRAINT "TenantBillingProfile_tenantId_fkey"
    FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

-- FK: paymentMethodId → PaymentMethod.id (set null on delete)
ALTER TABLE "TenantBillingProfile"
    ADD CONSTRAINT "TenantBillingProfile_paymentMethodId_fkey"
    FOREIGN KEY ("paymentMethodId")
    REFERENCES "PaymentMethod"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;

-- Indexes
CREATE INDEX IF NOT EXISTS "TenantBillingProfile_tenantId_idx"
    ON "TenantBillingProfile"("tenantId");

CREATE INDEX IF NOT EXISTS "TenantBillingProfile_tenantId_autoBillingEnabled_idx"
    ON "TenantBillingProfile"("tenantId", "autoBillingEnabled");

-- Add billingProfileId FK to BillingInvoice
ALTER TABLE "BillingInvoice"
    ADD COLUMN IF NOT EXISTS "billingProfileId" TEXT;

ALTER TABLE "BillingInvoice"
    ADD CONSTRAINT "BillingInvoice_billingProfileId_fkey"
    FOREIGN KEY ("billingProfileId")
    REFERENCES "TenantBillingProfile"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "BillingInvoice_tenantId_billingProfileId_idx"
    ON "BillingInvoice"("tenantId", "billingProfileId");
