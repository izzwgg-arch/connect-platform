-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'SIGNALWIRE';

-- CreateTable
CREATE TABLE "TenantSmsRegistration" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "submissionId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'signalwire',
    "classification" TEXT NOT NULL,
    "senderSystem" TEXT,
    "brandId" TEXT,
    "brandState" TEXT,
    "campaignId" TEXT,
    "campaignState" TEXT,
    "phoneE164" TEXT,
    "numberAssignedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "legalName" TEXT,
    "entityType" TEXT,
    "vertical" TEXT,
    "website" TEXT,
    "messageFlow" TEXT,
    "sample1" TEXT,
    "sample2" TEXT,
    "status" TEXT NOT NULL DEFAULT 'collected',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantSmsRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantSmsRegistration_submissionId_key" ON "TenantSmsRegistration"("submissionId");

-- CreateIndex
CREATE INDEX "TenantSmsRegistration_status_idx" ON "TenantSmsRegistration"("status");

-- CreateIndex
CREATE INDEX "TenantSmsRegistration_tenantId_idx" ON "TenantSmsRegistration"("tenantId");

-- AddForeignKey
ALTER TABLE "TenantSmsRegistration" ADD CONSTRAINT "TenantSmsRegistration_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

