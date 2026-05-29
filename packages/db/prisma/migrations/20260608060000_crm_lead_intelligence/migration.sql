-- Migration: crm_lead_intelligence
-- Phase 7 — AI Lead Intelligence Reports
--
-- Changes:
--   1. Create enum CrmLeadIntelligenceStatus
--   2. Create table CrmLeadIntelligenceReport

-- 1. Status enum
--    PENDING    — report requested, not yet started
--    PROCESSING — AI call in progress
--    COMPLETE   — report generated successfully
--    FAILED     — AI call failed; error stored in `error` field
CREATE TYPE "CrmLeadIntelligenceStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETE', 'FAILED');

-- 2. CrmLeadIntelligenceReport
--    One row per contact (UNIQUE on contactId). Upserted on force-regeneration.
CREATE TABLE "CrmLeadIntelligenceReport" (
  "id"                   TEXT          NOT NULL,
  "tenantId"             TEXT          NOT NULL,
  -- One report per contact. Foreign key cascades on delete.
  "contactId"            TEXT          NOT NULL,
  "importBatchId"        TEXT,
  "status"               "CrmLeadIntelligenceStatus" NOT NULL DEFAULT 'PENDING',
  -- AI-generated output fields (null until status = COMPLETE)
  "summary"              TEXT,
  "businessOverview"     TEXT,
  -- Structured JSON blobs (array / object of strings/numbers)
  "keyFindings"          JSONB,
  "discoveredEntities"   JSONB,
  "riskFlags"            JSONB,
  "missingInformation"   JSONB,
  -- 0.0 – 1.0; determined by AI based on data quality
  "confidenceScore"      DOUBLE PRECISION,
  -- e.g. "gpt-4o-mini", "gpt-4o"
  "modelName"            TEXT,
  "generatedAt"          TIMESTAMP(3),
  -- Safe error message (no document content, no tokens)
  "error"                TEXT,
  -- Source counts used as input to the AI call
  "sourceDocumentCount"  INTEGER       NOT NULL DEFAULT 0,
  "sourceTextCount"      INTEGER       NOT NULL DEFAULT 0,
  "sourceDiscoveryCount" INTEGER       NOT NULL DEFAULT 0,
  "createdAt"            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CrmLeadIntelligenceReport_pkey" PRIMARY KEY ("id")
);

-- One report per contact
CREATE UNIQUE INDEX "CrmLeadIntelligenceReport_contactId_key"
  ON "CrmLeadIntelligenceReport"("contactId");

CREATE INDEX "CrmLeadIntelligenceReport_tenantId_status_idx"
  ON "CrmLeadIntelligenceReport"("tenantId", "status");

CREATE INDEX "CrmLeadIntelligenceReport_tenantId_contactId_idx"
  ON "CrmLeadIntelligenceReport"("tenantId", "contactId");

CREATE INDEX "CrmLeadIntelligenceReport_importBatchId_idx"
  ON "CrmLeadIntelligenceReport"("importBatchId");

-- FK to contact
ALTER TABLE "CrmLeadIntelligenceReport"
  ADD CONSTRAINT "CrmLeadIntelligenceReport_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE;

-- FK to tenant
ALTER TABLE "CrmLeadIntelligenceReport"
  ADD CONSTRAINT "CrmLeadIntelligenceReport_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE;
