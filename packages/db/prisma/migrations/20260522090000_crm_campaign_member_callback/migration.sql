-- Phase 3C: Add callbackAt + callbackNote to CrmCampaignMember
-- Allows agents to schedule callback times and notes on CALLBACK-status members.

ALTER TABLE "CrmCampaignMember"
  ADD COLUMN IF NOT EXISTS "callbackAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "callbackNote" TEXT;

-- Index for efficient callback tab queries:
-- tenant + assignedUser + status + callbackAt
CREATE INDEX IF NOT EXISTS "CrmCampaignMember_tenantId_assignedToUserId_status_callbackAt_idx"
  ON "CrmCampaignMember"("tenantId", "assignedToUserId", "status", "callbackAt");
