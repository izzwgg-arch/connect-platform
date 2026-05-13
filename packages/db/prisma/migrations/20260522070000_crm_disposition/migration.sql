-- Phase 2D: CRM Disposition persistence
-- ALTER TYPE must run outside a transaction block in PostgreSQL.

ALTER TYPE "CrmTimelineEventType" ADD VALUE IF NOT EXISTS 'DISPOSITION_SET';

-- Add lastDisposition and lastDispositionAt columns to CrmContactMeta
ALTER TABLE "CrmContactMeta"
  ADD COLUMN IF NOT EXISTS "lastDisposition"   TEXT,
  ADD COLUMN IF NOT EXISTS "lastDispositionAt" TIMESTAMP(3);
