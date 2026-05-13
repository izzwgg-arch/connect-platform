-- Add CONTACT_MERGED to CrmTimelineEventType enum.
-- Phase 5A — contact merge feature.
-- Runs AFTER 20260522020000_crm_timeline_notes which creates the enum.
-- ALTER TYPE must run outside a transaction block in PostgreSQL.

ALTER TYPE "CrmTimelineEventType" ADD VALUE IF NOT EXISTS 'CONTACT_MERGED';
