-- Backfill: mark recent answered calls with talk time as pending for recording resolution
UPDATE "ConnectCdr"
SET "recordingStatus" = 'pending'
WHERE "recordingStatus" = 'none'
  AND disposition = 'answered'
  AND "talkSec" >= 3
  AND "startedAt" >= NOW() - INTERVAL '7 days';

SELECT 'Backfilled ' || COUNT(*) || ' calls to pending' as result
FROM "ConnectCdr"
WHERE "recordingStatus" = 'pending';
