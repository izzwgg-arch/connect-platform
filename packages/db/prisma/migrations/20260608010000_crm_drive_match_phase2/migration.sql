-- Phase 2: CRM Drive document matching
-- Extends CrmLeadDocument with contact/batch/match fields.
-- Adds CrmImportBatchRow for per-row import audit with company + contactId.

-- 1. Add REJECTED value to CrmLeadDocumentStatus enum
ALTER TYPE "CrmLeadDocumentStatus" ADD VALUE IF NOT EXISTS 'REJECTED';

-- 2. Extend CrmLeadDocument with Phase 2 fields
ALTER TABLE "CrmLeadDocument"
  ADD COLUMN IF NOT EXISTS "contactId"          TEXT,
  ADD COLUMN IF NOT EXISTS "importBatchId"      TEXT,
  ADD COLUMN IF NOT EXISTS "matchConfidence"    TEXT,
  ADD COLUMN IF NOT EXISTS "matchReason"        TEXT,
  ADD COLUMN IF NOT EXISTS "reviewedByUserId"   TEXT,
  ADD COLUMN IF NOT EXISTS "reviewedAt"         TIMESTAMPTZ;

-- 3. Foreign keys for the new columns
ALTER TABLE "CrmLeadDocument"
  ADD CONSTRAINT "CrmLeadDocument_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "CrmLeadDocument_importBatchId_fkey"
    FOREIGN KEY ("importBatchId") REFERENCES "CrmImportBatch"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "CrmLeadDocument_reviewedByUserId_fkey"
    FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL;

-- 4. New indexes for the extended columns
CREATE INDEX IF NOT EXISTS "CrmLeadDocument_tenantId_contactId_idx"
  ON "CrmLeadDocument"("tenantId", "contactId");

CREATE INDEX IF NOT EXISTS "CrmLeadDocument_importBatchId_idx"
  ON "CrmLeadDocument"("importBatchId");

-- 5. New table: CrmImportBatchRow
-- Stores per-row results from an import run so the match engine can map
-- normalised company names → contactIds for a given batch.
CREATE TABLE IF NOT EXISTS "CrmImportBatchRow" (
  "id"                    TEXT        NOT NULL,
  "tenantId"              TEXT        NOT NULL,
  "batchId"               TEXT        NOT NULL,
  "rowNumber"             INT         NOT NULL,
  "contactId"             TEXT,
  "companyName"           TEXT,
  "companyNameNormalized" TEXT,
  "action"                TEXT        NOT NULL,
  "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "CrmImportBatchRow_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CrmImportBatchRow_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE,
  CONSTRAINT "CrmImportBatchRow_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "CrmImportBatch"("id") ON DELETE CASCADE,
  CONSTRAINT "CrmImportBatchRow_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "CrmImportBatchRow_batchId_idx"
  ON "CrmImportBatchRow"("batchId");

CREATE INDEX IF NOT EXISTS "CrmImportBatchRow_tenantId_contactId_idx"
  ON "CrmImportBatchRow"("tenantId", "contactId");

CREATE INDEX IF NOT EXISTS "CrmImportBatchRow_tenantId_companyNorm_idx"
  ON "CrmImportBatchRow"("tenantId", "companyNameNormalized");
