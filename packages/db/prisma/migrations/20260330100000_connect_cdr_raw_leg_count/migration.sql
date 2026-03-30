-- AddColumn rawLegCount to ConnectCdr
-- Tracks how many CDR notifications (AMI Cdr events / channel legs) were received
-- and upserted for each linkedId. Existing rows default to 1.
-- SUM("rawLegCount") gives the raw PBX-style channel-leg CDR count;
-- COUNT(*) gives the deduplicated logical call count.

ALTER TABLE "ConnectCdr" ADD COLUMN "rawLegCount" INTEGER NOT NULL DEFAULT 1;
