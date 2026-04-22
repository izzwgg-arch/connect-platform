-- Add the deterministic recording path column. Safe to re-run.
ALTER TABLE "ConnectCdr" ADD COLUMN IF NOT EXISTS "recordingPath" TEXT;

-- Drop the old index (recordingStatus-based) and column. We no longer need them — recordings
-- are tracked purely via recordingPath, set deterministically at ingest.
DROP INDEX IF EXISTS "ConnectCdr_recordingStatus_endedAt_idx";
ALTER TABLE "ConnectCdr" DROP COLUMN IF EXISTS "recordingStatus";

-- Backfill existing CDRs: answered calls with real talk time get a deterministic path
-- computed from startedAt + linkedId. Unanswered / zero-duration rows stay NULL.
UPDATE "ConnectCdr"
SET "recordingPath" =
      TO_CHAR("startedAt" AT TIME ZONE 'UTC', 'YYYY/MM/DD') || '/' || "linkedId" || '.wav'
WHERE disposition = 'answered'
  AND "talkSec" >= 3
  AND "recordingPath" IS NULL;

-- Drop the now-unused CallRecording table.
DROP TABLE IF EXISTS "CallRecording";

SELECT COUNT(*) FILTER (WHERE "recordingPath" IS NOT NULL) as with_recording,
       COUNT(*) FILTER (WHERE "recordingPath" IS NULL) as without_recording
FROM "ConnectCdr";
