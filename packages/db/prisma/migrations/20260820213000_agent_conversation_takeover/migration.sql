-- Support-desk take-over (2026-08-20): while humanTakeoverAt is set, the agent
-- engine stores the customer's messages but never answers — a person is
-- talking. Both columns nullable; no existing row changes.
ALTER TABLE "AgentConversation" ADD COLUMN "humanTakeoverAt" TIMESTAMP(3);
ALTER TABLE "AgentConversation" ADD COLUMN "humanTakeoverBy" TEXT;
