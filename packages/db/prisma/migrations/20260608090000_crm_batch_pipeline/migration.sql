-- Migration: crm_batch_pipeline
-- Adds the CrmImportBatchPipelineRun model for tracking orchestrated batch
-- pipeline runs (Drive match → document import → text extraction →
-- contact discovery → AI intelligence).

CREATE TYPE "CrmPipelineRunStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'COMPLETE',
  'PARTIAL',
  'FAILED',
  'CANCELLED'
);

-- One run per "Process Batch" invocation. Multiple runs per batch are allowed
-- (each Start creates a new run). Continue updates the latest PARTIAL run.
CREATE TABLE "CrmImportBatchPipelineRun" (
  "id"               TEXT          NOT NULL,
  "tenantId"         TEXT          NOT NULL,
  "importBatchId"    TEXT          NOT NULL,
  "status"           "CrmPipelineRunStatus"  NOT NULL DEFAULT 'PENDING',
  "startedByUserId"  TEXT,

  -- The step currently executing, or last completed step.
  -- Values: drive_match | document_import | text_extraction | contact_discovery | ai_intelligence
  "currentStep"      TEXT,

  -- JSON: per-step results. Shape documented in batchPipelineService.ts.
  -- Example: { "drive_match": { "status": "complete", "matchesCreated": 3, ... } }
  "steps"            JSONB         NOT NULL DEFAULT '{}',

  -- JSON: aggregate totals across all runs for this pipeline invocation.
  -- Example: { "documentsImported": 5, "textExtracted": 4, "discoveries": 2, "aiReports": 1 }
  "totals"           JSONB         NOT NULL DEFAULT '{}',

  -- JSON: array of safe error summaries (capped at 10).
  -- Example: [{ "step": "document_import", "error": "Drive token expired", "at": "..." }]
  "errors"           JSONB         NOT NULL DEFAULT '[]',

  "startedAt"        TIMESTAMP(3),
  "completedAt"      TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CrmImportBatchPipelineRun_pkey" PRIMARY KEY ("id")
);

-- Fast lookup: latest run for a batch
CREATE INDEX "CrmImportBatchPipelineRun_tenantId_importBatchId_idx"
  ON "CrmImportBatchPipelineRun"("tenantId", "importBatchId");

-- Fast lookup: all RUNNING/PARTIAL runs (worker heartbeat pattern later)
CREATE INDEX "CrmImportBatchPipelineRun_tenantId_status_idx"
  ON "CrmImportBatchPipelineRun"("tenantId", "status");

ALTER TABLE "CrmImportBatchPipelineRun"
  ADD CONSTRAINT "CrmImportBatchPipelineRun_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "CrmImportBatchPipelineRun_importBatchId_fkey"
    FOREIGN KEY ("importBatchId") REFERENCES "CrmImportBatch"("id") ON DELETE CASCADE;
