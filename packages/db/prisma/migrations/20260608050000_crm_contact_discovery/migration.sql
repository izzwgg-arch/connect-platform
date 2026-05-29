-- Migration: crm_contact_discovery
-- Phase 6 — Contact Discovery from extracted document text
--
-- Changes:
--   1. Create enum CrmDiscoveryStatus
--   2. Create table CrmLeadDiscoveredPhone
--   3. Create table CrmLeadDiscoveredEmail

-- 1. Discovery status enum
--    PENDING  — discovered, awaiting user review
--    ACCEPTED — user approved; value has been attached to the contact
--    REJECTED — user dismissed; kept for audit, never resurfaces as a new discovery
CREATE TYPE "CrmDiscoveryStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- 2. CrmLeadDiscoveredPhone
CREATE TABLE "CrmLeadDiscoveredPhone" (
  "id"              TEXT          NOT NULL,
  "tenantId"        TEXT          NOT NULL,
  "contactId"       TEXT          NOT NULL,
  "documentId"      TEXT          NOT NULL,
  "documentTextId"  TEXT          NOT NULL,
  -- Raw phone as found in the text (no more than 30 chars)
  "phoneNumber"     TEXT          NOT NULL,
  -- Digits-only normalized form (e.g. "5551234567"), used for dedup
  "normalizedPhone" TEXT          NOT NULL,
  -- HIGH | MEDIUM
  "confidence"      TEXT          NOT NULL DEFAULT 'MEDIUM',
  -- Up to 200 chars of surrounding text (never the full document text)
  "sourceSnippet"   TEXT,
  "sourcePage"      INTEGER,
  "status"          "CrmDiscoveryStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt"       TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CrmLeadDiscoveredPhone_pkey" PRIMARY KEY ("id")
);

-- One discovery per (tenant, contact, phone, document) — prevents duplicates on rerun
CREATE UNIQUE INDEX "CrmLeadDiscoveredPhone_tenant_contact_phone_doc_key"
  ON "CrmLeadDiscoveredPhone"("tenantId", "contactId", "normalizedPhone", "documentId");

CREATE INDEX "CrmLeadDiscoveredPhone_tenantId_contactId_idx"
  ON "CrmLeadDiscoveredPhone"("tenantId", "contactId");

CREATE INDEX "CrmLeadDiscoveredPhone_tenantId_status_idx"
  ON "CrmLeadDiscoveredPhone"("tenantId", "status");

CREATE INDEX "CrmLeadDiscoveredPhone_documentId_idx"
  ON "CrmLeadDiscoveredPhone"("documentId");

-- FK to contact
ALTER TABLE "CrmLeadDiscoveredPhone"
  ADD CONSTRAINT "CrmLeadDiscoveredPhone_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE;

-- FK to document
ALTER TABLE "CrmLeadDiscoveredPhone"
  ADD CONSTRAINT "CrmLeadDiscoveredPhone_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "CrmLeadDocument"("id") ON DELETE CASCADE;

-- FK to document text
ALTER TABLE "CrmLeadDiscoveredPhone"
  ADD CONSTRAINT "CrmLeadDiscoveredPhone_documentTextId_fkey"
  FOREIGN KEY ("documentTextId") REFERENCES "CrmLeadDocumentText"("id") ON DELETE CASCADE;

-- FK to tenant
ALTER TABLE "CrmLeadDiscoveredPhone"
  ADD CONSTRAINT "CrmLeadDiscoveredPhone_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE;

-- 3. CrmLeadDiscoveredEmail
CREATE TABLE "CrmLeadDiscoveredEmail" (
  "id"             TEXT          NOT NULL,
  "tenantId"       TEXT          NOT NULL,
  "contactId"      TEXT          NOT NULL,
  "documentId"     TEXT          NOT NULL,
  "documentTextId" TEXT          NOT NULL,
  -- Email as extracted (lowercased)
  "email"          TEXT          NOT NULL,
  -- HIGH | MEDIUM
  "confidence"     TEXT          NOT NULL DEFAULT 'HIGH',
  -- Up to 200 chars of surrounding text
  "sourceSnippet"  TEXT,
  "sourcePage"     INTEGER,
  "status"         "CrmDiscoveryStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CrmLeadDiscoveredEmail_pkey" PRIMARY KEY ("id")
);

-- One discovery per (tenant, contact, email, document) — prevents duplicates on rerun
CREATE UNIQUE INDEX "CrmLeadDiscoveredEmail_tenant_contact_email_doc_key"
  ON "CrmLeadDiscoveredEmail"("tenantId", "contactId", "email", "documentId");

CREATE INDEX "CrmLeadDiscoveredEmail_tenantId_contactId_idx"
  ON "CrmLeadDiscoveredEmail"("tenantId", "contactId");

CREATE INDEX "CrmLeadDiscoveredEmail_tenantId_status_idx"
  ON "CrmLeadDiscoveredEmail"("tenantId", "status");

CREATE INDEX "CrmLeadDiscoveredEmail_documentId_idx"
  ON "CrmLeadDiscoveredEmail"("documentId");

-- FK to contact
ALTER TABLE "CrmLeadDiscoveredEmail"
  ADD CONSTRAINT "CrmLeadDiscoveredEmail_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE;

-- FK to document
ALTER TABLE "CrmLeadDiscoveredEmail"
  ADD CONSTRAINT "CrmLeadDiscoveredEmail_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "CrmLeadDocument"("id") ON DELETE CASCADE;

-- FK to document text
ALTER TABLE "CrmLeadDiscoveredEmail"
  ADD CONSTRAINT "CrmLeadDiscoveredEmail_documentTextId_fkey"
  FOREIGN KEY ("documentTextId") REFERENCES "CrmLeadDocumentText"("id") ON DELETE CASCADE;

-- FK to tenant
ALTER TABLE "CrmLeadDiscoveredEmail"
  ADD CONSTRAINT "CrmLeadDiscoveredEmail_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE;
