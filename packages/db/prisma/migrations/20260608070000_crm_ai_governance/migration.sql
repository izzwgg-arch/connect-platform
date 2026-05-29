-- Migration: crm_ai_governance
-- Phase 7B — Tenant AI settings + report metadata hardening
--
-- Changes:
--   1. Create table CrmAiSettings (one row per tenant, all limits configurable)
--   2. Add metadata columns to CrmLeadIntelligenceReport

-- 1. CrmAiSettings
--    One row per tenant. Absence = defaults (see Prisma model).
--    All limit fields have safe minimums enforced by the service layer.
CREATE TABLE "CrmAiSettings" (
  "id"                           TEXT          NOT NULL,
  "tenantId"                     TEXT          NOT NULL,
  -- Master switch. false = block all AI generation for this tenant.
  "aiEnabled"                    BOOLEAN       NOT NULL DEFAULT true,
  -- Max imported documents sent to the AI per report (hard cap: 10).
  "maxDocumentsPerReport"        INTEGER       NOT NULL DEFAULT 5,
  -- Max characters of extracted text per document (hard cap: 5000).
  "maxCharsPerDocument"          INTEGER       NOT NULL DEFAULT 2000,
  -- Max total characters of all document snippets combined (hard cap: 25000).
  "maxTotalCharsPerReport"       INTEGER       NOT NULL DEFAULT 10000,
  -- Whether POST /crm/import/batches/:batchId/intelligence is permitted.
  "allowBatchGeneration"         BOOLEAN       NOT NULL DEFAULT true,
  -- Max contacts processed per batch call (hard cap: 25).
  "maxBatchReportsPerRun"        INTEGER       NOT NULL DEFAULT 25,
  -- Minimum minutes between force-regenerations for the same contact.
  -- 0 = no cooldown. Admin role can bypass this.
  "regenerationCooldownMinutes"  INTEGER       NOT NULL DEFAULT 60,
  "createdAt"                    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CrmAiSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CrmAiSettings_tenantId_key"
  ON "CrmAiSettings"("tenantId");

-- FK to tenant
ALTER TABLE "CrmAiSettings"
  ADD CONSTRAINT "CrmAiSettings_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE;

-- 2. New metadata columns on CrmLeadIntelligenceReport
--    Tracking what was actually sent to the AI and how long it took.
ALTER TABLE "CrmLeadIntelligenceReport"
  ADD COLUMN "promptCharCount"       INTEGER,
  ADD COLUMN "documentsIncluded"     INTEGER,
  ADD COLUMN "documentsExcluded"     INTEGER,
  ADD COLUMN "generationDurationMs"  INTEGER,
  ADD COLUMN "providerName"          TEXT;
