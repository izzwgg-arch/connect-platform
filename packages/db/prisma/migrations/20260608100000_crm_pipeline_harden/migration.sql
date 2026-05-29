-- Migration: crm_pipeline_harden
-- Adds recoveredAt to CrmImportBatchPipelineRun.
-- This field is set when a stale RUNNING run is automatically recovered to FAILED.

ALTER TABLE "CrmImportBatchPipelineRun"
  ADD COLUMN IF NOT EXISTS "recoveredAt" TIMESTAMP(3);
