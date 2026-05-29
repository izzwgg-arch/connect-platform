-- CRM Lead Document Import — Phase 3
--
-- Adds:
--  1. IMPORTING and IMPORT_FAILED values to CrmLeadDocumentStatus enum.
--  2. importedAt, importError, importedMimeType columns on CrmLeadDocument.
--     - importedAt: timestamp when file was successfully stored locally.
--     - importError: short safe error message for IMPORT_FAILED rows.
--     - importedMimeType: MIME type of the file actually stored (may differ from
--       original when Google Workspace files are exported to PDF).
--
-- Backward-compatible: existing DISCOVERED/IMPORT_PENDING/IMPORTED/FAILED/REJECTED
-- rows are unaffected.

DO $$
BEGIN
  ALTER TYPE "CrmLeadDocumentStatus" ADD VALUE IF NOT EXISTS 'IMPORTING';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TYPE "CrmLeadDocumentStatus" ADD VALUE IF NOT EXISTS 'IMPORT_FAILED';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "CrmLeadDocument"
  ADD COLUMN IF NOT EXISTS "importedAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "importError"      TEXT,
  ADD COLUMN IF NOT EXISTS "importedMimeType" TEXT;
