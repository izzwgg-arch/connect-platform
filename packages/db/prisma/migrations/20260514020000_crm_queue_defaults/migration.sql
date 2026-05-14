-- Phase 12C: Add defaultQueueSort and defaultQueueFilter to CrmTenantSettings
-- Existing rows default to SMART / PENDING — preserves current behaviour.

ALTER TABLE "CrmTenantSettings"
  ADD COLUMN IF NOT EXISTS "defaultQueueSort"   TEXT NOT NULL DEFAULT 'SMART',
  ADD COLUMN IF NOT EXISTS "defaultQueueFilter" TEXT NOT NULL DEFAULT 'PENDING';
