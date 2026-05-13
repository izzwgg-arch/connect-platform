-- Add SMS_RECEIVED to CrmTimelineEventType enum for CRM Phase 11B
-- Additive-only change; safe for existing data.
ALTER TYPE "CrmTimelineEventType" ADD VALUE IF NOT EXISTS 'SMS_RECEIVED';
