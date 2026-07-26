-- SMS-to-Email (Part 2: send-tracking on each inbound text).
-- Additive only: two new nullable columns. No backfill, no data rewrite.
-- The whole existing inbound-SMS backlog has NULL emailForwardedAt, but the
-- forwarding job also applies a hard fresh-window guard, so the backlog can
-- never be back-emailed regardless.

ALTER TABLE "ConnectChatMessage" ADD COLUMN "emailForwardedAt" TIMESTAMP(3);
ALTER TABLE "ConnectChatMessage" ADD COLUMN "emailForwardError" TEXT;
