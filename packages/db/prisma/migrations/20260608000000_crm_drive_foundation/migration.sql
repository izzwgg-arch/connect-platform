-- CRM Drive Foundation — Phase 1
-- Adds: CrmDriveFolderPurpose enum, CrmLeadDocumentSource enum, CrmLeadDocumentStatus enum,
--        CrmDriveFolder table, CrmLeadDocument table.
-- Additive-only: no existing tables or enums modified.

DO $$
BEGIN
  CREATE TYPE "CrmDriveFolderPurpose" AS ENUM ('LEAD_IMPORT_INBOX');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "CrmLeadDocumentSource" AS ENUM ('GOOGLE_DRIVE', 'MANUAL_UPLOAD');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "CrmLeadDocumentStatus" AS ENUM ('DISCOVERED', 'IMPORT_PENDING', 'IMPORTED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CrmDriveFolder: tenant-scoped Google Drive folder configuration.
-- Each row stores one selected Drive folder for a given purpose (e.g. lead import inbox).
-- Strict tenant isolation: tenantId is required; FK to CrmEmailConnection enforces the
-- Drive-capable connection belongs to the same tenant (enforced at the app layer).
CREATE TABLE IF NOT EXISTS "CrmDriveFolder" (
  "id"                 TEXT NOT NULL,
  "tenantId"           TEXT NOT NULL,
  "googleConnectionId" TEXT NOT NULL,
  "folderId"           TEXT NOT NULL,
  "folderName"         TEXT NOT NULL,
  "purpose"            "CrmDriveFolderPurpose" NOT NULL DEFAULT 'LEAD_IMPORT_INBOX',
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmDriveFolder_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  ALTER TABLE "CrmDriveFolder"
    ADD CONSTRAINT "CrmDriveFolder_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "CrmDriveFolder"
    ADD CONSTRAINT "CrmDriveFolder_googleConnectionId_fkey"
    FOREIGN KEY ("googleConnectionId") REFERENCES "CrmEmailConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- One active folder config per (tenant, purpose). Prevents duplicate inbox configs.
CREATE UNIQUE INDEX IF NOT EXISTS "CrmDriveFolder_tenantId_purpose_key"
  ON "CrmDriveFolder"("tenantId", "purpose");

CREATE INDEX IF NOT EXISTS "CrmDriveFolder_tenantId_idx"
  ON "CrmDriveFolder"("tenantId");

CREATE INDEX IF NOT EXISTS "CrmDriveFolder_googleConnectionId_idx"
  ON "CrmDriveFolder"("googleConnectionId");

-- CrmLeadDocument: foundation model for per-lead document references.
-- leadId is nullable because the lead import pipeline is not yet built in Phase 1.
-- This model is inert in Phase 1 (no worker consumer, no OCR, no auto-matching).
CREATE TABLE IF NOT EXISTS "CrmLeadDocument" (
  "id"                  TEXT NOT NULL,
  "tenantId"            TEXT NOT NULL,
  "leadId"              TEXT,
  "source"              "CrmLeadDocumentSource" NOT NULL DEFAULT 'GOOGLE_DRIVE',
  "googleDriveFileId"   TEXT,
  "googleDriveFolderId" TEXT,
  "originalFileName"    TEXT NOT NULL,
  "mimeType"            TEXT,
  "sizeBytes"           BIGINT,
  "contentHash"         TEXT,
  "storageKey"          TEXT,
  "status"              "CrmLeadDocumentStatus" NOT NULL DEFAULT 'DISCOVERED',
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmLeadDocument_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  ALTER TABLE "CrmLeadDocument"
    ADD CONSTRAINT "CrmLeadDocument_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "CrmLeadDocument_tenantId_status_idx"
  ON "CrmLeadDocument"("tenantId", "status");

CREATE INDEX IF NOT EXISTS "CrmLeadDocument_tenantId_leadId_idx"
  ON "CrmLeadDocument"("tenantId", "leadId");

CREATE INDEX IF NOT EXISTS "CrmLeadDocument_tenantId_googleDriveFolderId_idx"
  ON "CrmLeadDocument"("tenantId", "googleDriveFolderId");

-- Prevent duplicate Drive file rows per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS "CrmLeadDocument_tenantId_googleDriveFileId_key"
  ON "CrmLeadDocument"("tenantId", "googleDriveFileId")
  WHERE "googleDriveFileId" IS NOT NULL;
