-- Add SMS_SENT to CrmTimelineEventType enum for CRM Phase 11A
-- This is an additive change and is safe for existing data.
ALTER TYPE "CrmTimelineEventType" ADD VALUE IF NOT EXISTS 'SMS_SENT';
