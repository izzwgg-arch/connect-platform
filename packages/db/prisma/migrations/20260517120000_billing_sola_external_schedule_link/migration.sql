-- CreateEnum
CREATE TYPE "SolaScheduleLinkMappingStatus" AS ENUM ('UNMAPPED', 'MAPPED', 'IGNORED', 'CONFLICT');

-- CreateTable
CREATE TABLE "BillingSolaExternalScheduleLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "suggestedTenantId" TEXT,
    "solaCustomerId" TEXT NOT NULL,
    "solaPaymentMethodId" TEXT,
    "solaScheduleId" TEXT NOT NULL,
    "customerName" TEXT,
    "customerEmail" TEXT,
    "companyName" TEXT,
    "maskedCard" TEXT,
    "brand" TEXT,
    "last4" TEXT,
    "expMonth" TEXT,
    "expYear" TEXT,
    "amountCents" INTEGER,
    "intervalType" TEXT,
    "intervalCount" INTEGER,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastTransactionStatus" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "mappingStatus" "SolaScheduleLinkMappingStatus" NOT NULL DEFAULT 'UNMAPPED',
    "matchConfidence" TEXT,
    "matchReason" TEXT,
    "rawSafeJson" JSONB,
    "mappedByUserId" TEXT,
    "mappedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingSolaExternalScheduleLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingSolaExternalScheduleLink_solaScheduleId_key" ON "BillingSolaExternalScheduleLink"("solaScheduleId");

-- CreateIndex
CREATE INDEX "BillingSolaExternalScheduleLink_tenantId_idx" ON "BillingSolaExternalScheduleLink"("tenantId");

-- CreateIndex
CREATE INDEX "BillingSolaExternalScheduleLink_suggestedTenantId_idx" ON "BillingSolaExternalScheduleLink"("suggestedTenantId");

-- CreateIndex
CREATE INDEX "BillingSolaExternalScheduleLink_mappingStatus_idx" ON "BillingSolaExternalScheduleLink"("mappingStatus");

-- CreateIndex
CREATE INDEX "BillingSolaExternalScheduleLink_solaCustomerId_idx" ON "BillingSolaExternalScheduleLink"("solaCustomerId");

-- CreateIndex
CREATE INDEX "BillingSolaExternalScheduleLink_solaPaymentMethodId_idx" ON "BillingSolaExternalScheduleLink"("solaPaymentMethodId");

-- CreateIndex
CREATE INDEX "BillingSolaExternalScheduleLink_isActive_idx" ON "BillingSolaExternalScheduleLink"("isActive");

-- AddForeignKey
ALTER TABLE "BillingSolaExternalScheduleLink" ADD CONSTRAINT "BillingSolaExternalScheduleLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingSolaExternalScheduleLink" ADD CONSTRAINT "BillingSolaExternalScheduleLink_mappedByUserId_fkey" FOREIGN KEY ("mappedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
