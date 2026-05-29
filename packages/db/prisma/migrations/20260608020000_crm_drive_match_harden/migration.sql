-- CRM Drive Match Hardening (Phase 2 audit + idempotency)
--
-- Changes:
--  1. Add auditErrorCount to CrmImportBatch so silent audit row failures are visible.
--  2. Drop the broad (tenantId, googleDriveFileId) unique index on CrmLeadDocument
--     which incorrectly prevented the same Drive file from appearing in a second
--     import batch for the same tenant.
--  3. Add a scoped (tenantId, importBatchId, googleDriveFileId) partial unique index
--     so that Drive matching is idempotent per (tenant, batch, file) — the only
--     semantically correct duplicate boundary.

-- 1. Add auditErrorCount to CrmImportBatch
ALTER TABLE "CrmImportBatch"
  ADD COLUMN IF NOT EXISTS "auditErrorCount" INT NOT NULL DEFAULT 0;

-- 2. Drop the old over-broad unique index (created in Phase 1 migration).
--    Safe: IF EXISTS prevents failure when run against a DB that skipped Phase 1.
DROP INDEX IF EXISTS "CrmLeadDocument_tenantId_googleDriveFileId_key";

-- 3. Add the correct scoped partial unique index.
--    One CrmLeadDocument per (tenant, import batch, Drive file).
--    Partial (WHERE both NOT NULL) so manual-upload rows with no Drive file ID
--    or no batch link are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS "CrmLeadDocument_tenantId_batchId_fileId_key"
  ON "CrmLeadDocument"("tenantId", "importBatchId", "googleDriveFileId")
  WHERE "importBatchId" IS NOT NULL AND "googleDriveFileId" IS NOT NULL;
