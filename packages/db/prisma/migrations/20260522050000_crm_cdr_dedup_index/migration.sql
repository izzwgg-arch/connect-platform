-- Phase 2A: CRM CDR timeline deduplication index
-- Adds a non-unique index for fast dedup lookups (contactId + linkedId)
-- and a partial unique constraint to prevent duplicate CDR timeline events
-- for the same contact + CDR linkedId + event type.
--
-- The WHERE clause ensures the constraint only applies when linkedId is set
-- (i.e. CDR-linked events), so it does not affect notes, tasks, or other
-- events that share a linkedId for their own internal reasons.

CREATE INDEX IF NOT EXISTS "CrmTimelineEvent_contactId_linkedId_idx"
  ON "CrmTimelineEvent"("contactId", "linkedId");

-- Prevent duplicate CDR timeline events per (contact, CDR linkedId, type)
CREATE UNIQUE INDEX IF NOT EXISTS "CrmTimelineEvent_contactId_linkedId_type_unique"
  ON "CrmTimelineEvent"("contactId", "linkedId", "type")
  WHERE "linkedId" IS NOT NULL;
