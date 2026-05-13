-- Add ASSIGNED_TO_USER to CrmTimelineEventType enum.
-- Phase 5C — contact assignment tracking.
-- Runs AFTER 20260522110000_crm_contact_merged_event.
-- ALTER TYPE must run outside a transaction block in PostgreSQL.

ALTER TYPE "CrmTimelineEventType" ADD VALUE IF NOT EXISTS 'ASSIGNED_TO_USER';
