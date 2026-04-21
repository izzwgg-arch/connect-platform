-- Migration: add isForwarded flag to ConnectCdr
-- Marks :out rows (inbound call forwarded to an external PSTN number) so KPI queries
-- can distinguish pure outgoing calls from call-forwarding legs.
-- Backward-compatible: all existing rows default to false.

ALTER TABLE "ConnectCdr" ADD COLUMN "isForwarded" BOOLEAN NOT NULL DEFAULT false;

-- Optional historical backfill (NOT run automatically).
-- Run manually after verifying on staging:
--
-- UPDATE "ConnectCdr"
-- SET "isForwarded" = true
-- WHERE "linkedId" ~ ':out[0-9]*$'
--   AND "direction" = 'outgoing';
