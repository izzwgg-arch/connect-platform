-- Multi-invoice short pay link: one card charge pays every open invoice in the set.
-- Purely additive — new enum + new table, no changes to existing tables.

CREATE TYPE "BillingPayLinkStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'EXPIRED', 'VOID');

CREATE TABLE "BillingPayLink" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceIds" TEXT[],
    "status" "BillingPayLinkStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidTransactionId" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingPayLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingPayLink_code_key" ON "BillingPayLink"("code");
CREATE INDEX "BillingPayLink_tenantId_status_idx" ON "BillingPayLink"("tenantId", "status");
CREATE INDEX "BillingPayLink_expiresAt_idx" ON "BillingPayLink"("expiresAt");

ALTER TABLE "BillingPayLink" ADD CONSTRAINT "BillingPayLink_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
