-- CRM Forms Foundation — Phase 1
-- Adds reusable tenant-scoped PDF form templates, fields, secure contact requests,
-- and structured submissions. Additive-only; no existing rows are rewritten.

ALTER TYPE "CrmTimelineEventType" ADD VALUE IF NOT EXISTS 'FORM_SENT';
ALTER TYPE "CrmTimelineEventType" ADD VALUE IF NOT EXISTS 'FORM_OPENED';
ALTER TYPE "CrmTimelineEventType" ADD VALUE IF NOT EXISTS 'FORM_COMPLETED';
ALTER TYPE "CrmTimelineEventType" ADD VALUE IF NOT EXISTS 'FORM_REVOKED';

DO $$
BEGIN
  CREATE TYPE "CrmFormTemplateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "CrmFormFieldType" AS ENUM ('TEXT', 'DATE', 'CHECKBOX', 'SIGNATURE', 'INITIALS');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "CrmFormRequestStatus" AS ENUM ('SENT', 'OPENED', 'COMPLETED', 'EXPIRED', 'REVOKED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "CrmFormTemplate" (
  "id"               TEXT NOT NULL,
  "tenantId"         TEXT NOT NULL,
  "name"             TEXT NOT NULL,
  "description"      TEXT,
  "category"         TEXT,
  "originalFileName" TEXT NOT NULL,
  "storageKey"       TEXT NOT NULL,
  "mimeType"         TEXT NOT NULL,
  "sizeBytes"        BIGINT NOT NULL,
  "status"           "CrmFormTemplateStatus" NOT NULL DEFAULT 'DRAFT',
  "pageCount"        INTEGER,
  "pdfMetadata"      JSONB,
  "createdByUserId"  TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmFormTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CrmFormField" (
  "id"             TEXT NOT NULL,
  "tenantId"       TEXT NOT NULL,
  "formTemplateId" TEXT NOT NULL,
  "fieldType"      "CrmFormFieldType" NOT NULL,
  "label"          TEXT NOT NULL,
  "required"       BOOLEAN NOT NULL DEFAULT false,
  "pageNumber"     INTEGER NOT NULL,
  "x"              DOUBLE PRECISION NOT NULL,
  "y"              DOUBLE PRECISION NOT NULL,
  "width"          DOUBLE PRECISION NOT NULL,
  "height"         DOUBLE PRECISION NOT NULL,
  "sortOrder"      INTEGER NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmFormField_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CrmFormRequest" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "contactId"       TEXT NOT NULL,
  "formTemplateId"  TEXT NOT NULL,
  "status"          "CrmFormRequestStatus" NOT NULL DEFAULT 'SENT',
  "recipientEmail"  TEXT NOT NULL,
  "tokenHash"       TEXT NOT NULL,
  "message"         TEXT,
  "expiresAt"       TIMESTAMP(3) NOT NULL,
  "sentAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "openedAt"        TIMESTAMP(3),
  "completedAt"     TIMESTAMP(3),
  "revokedAt"       TIMESTAMP(3),
  "createdByUserId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmFormRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CrmFormSubmission" (
  "id"                     TEXT NOT NULL,
  "tenantId"               TEXT NOT NULL,
  "formRequestId"          TEXT NOT NULL,
  "contactId"              TEXT NOT NULL,
  "formTemplateId"         TEXT NOT NULL,
  "submittedData"          JSONB NOT NULL,
  "completedPdfStorageKey" TEXT,
  "ipAddressHash"          TEXT,
  "userAgent"              TEXT,
  "submittedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmFormSubmission_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  ALTER TABLE "CrmFormTemplate"
    ADD CONSTRAINT "CrmFormTemplate_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "CrmFormTemplate"
    ADD CONSTRAINT "CrmFormTemplate_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "CrmFormField"
    ADD CONSTRAINT "CrmFormField_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "CrmFormField"
    ADD CONSTRAINT "CrmFormField_formTemplateId_fkey"
    FOREIGN KEY ("formTemplateId") REFERENCES "CrmFormTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "CrmFormRequest"
    ADD CONSTRAINT "CrmFormRequest_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "CrmFormRequest"
    ADD CONSTRAINT "CrmFormRequest_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "CrmFormRequest"
    ADD CONSTRAINT "CrmFormRequest_formTemplateId_fkey"
    FOREIGN KEY ("formTemplateId") REFERENCES "CrmFormTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "CrmFormRequest"
    ADD CONSTRAINT "CrmFormRequest_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "CrmFormSubmission"
    ADD CONSTRAINT "CrmFormSubmission_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "CrmFormSubmission"
    ADD CONSTRAINT "CrmFormSubmission_formRequestId_fkey"
    FOREIGN KEY ("formRequestId") REFERENCES "CrmFormRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "CrmFormSubmission"
    ADD CONSTRAINT "CrmFormSubmission_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "CrmFormSubmission"
    ADD CONSTRAINT "CrmFormSubmission_formTemplateId_fkey"
    FOREIGN KEY ("formTemplateId") REFERENCES "CrmFormTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "CrmFormRequest_tokenHash_key"
  ON "CrmFormRequest"("tokenHash");

CREATE UNIQUE INDEX IF NOT EXISTS "CrmFormSubmission_formRequestId_key"
  ON "CrmFormSubmission"("formRequestId");

CREATE INDEX IF NOT EXISTS "CrmFormTemplate_tenantId_status_idx"
  ON "CrmFormTemplate"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "CrmFormTemplate_tenantId_category_idx"
  ON "CrmFormTemplate"("tenantId", "category");
CREATE INDEX IF NOT EXISTS "CrmFormTemplate_tenantId_updatedAt_idx"
  ON "CrmFormTemplate"("tenantId", "updatedAt");

CREATE INDEX IF NOT EXISTS "CrmFormField_tenantId_formTemplateId_idx"
  ON "CrmFormField"("tenantId", "formTemplateId");
CREATE INDEX IF NOT EXISTS "CrmFormField_formTemplateId_sortOrder_idx"
  ON "CrmFormField"("formTemplateId", "sortOrder");

CREATE INDEX IF NOT EXISTS "CrmFormRequest_tenantId_contactId_createdAt_idx"
  ON "CrmFormRequest"("tenantId", "contactId", "createdAt");
CREATE INDEX IF NOT EXISTS "CrmFormRequest_tenantId_formTemplateId_createdAt_idx"
  ON "CrmFormRequest"("tenantId", "formTemplateId", "createdAt");
CREATE INDEX IF NOT EXISTS "CrmFormRequest_tenantId_status_expiresAt_idx"
  ON "CrmFormRequest"("tenantId", "status", "expiresAt");

CREATE INDEX IF NOT EXISTS "CrmFormSubmission_tenantId_contactId_submittedAt_idx"
  ON "CrmFormSubmission"("tenantId", "contactId", "submittedAt");
CREATE INDEX IF NOT EXISTS "CrmFormSubmission_tenantId_formTemplateId_submittedAt_idx"
  ON "CrmFormSubmission"("tenantId", "formTemplateId", "submittedAt");
