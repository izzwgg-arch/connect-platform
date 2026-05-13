-- CRM Phase 1E: Lead/Contact import batch tracking.
-- Adds CrmImportBatch table to record CSV import runs.
-- No existing tables modified.

-- CreateEnum
CREATE TYPE "CrmImportBatchStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'DONE',
  'PARTIAL',
  'FAILED'
);

-- CreateTable: CrmImportBatch
CREATE TABLE "CrmImportBatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "status" "CrmImportBatchStatus" NOT NULL DEFAULT 'PENDING',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "mapping" JSONB,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CrmImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrmImportBatch_tenantId_createdAt_idx" ON "CrmImportBatch"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "CrmImportBatch" ADD CONSTRAINT "CrmImportBatch_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CrmImportBatch" ADD CONSTRAINT "CrmImportBatch_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
