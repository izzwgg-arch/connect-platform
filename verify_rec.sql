-- Fresh ingest check: new call should have recordingPath set
SELECT "linkedId", "startedAt", disposition, "talkSec", "recordingPath"
FROM "ConnectCdr"
ORDER BY "createdAt" DESC
LIMIT 5;

-- Summary
SELECT
  COUNT(*) FILTER (WHERE "recordingPath" IS NOT NULL) as with_rec,
  COUNT(*) FILTER (WHERE "recordingPath" IS NULL) as without_rec,
  COUNT(*) as total
FROM "ConnectCdr";

-- Confirm no CallRecording table
SELECT tablename FROM pg_tables WHERE tablename = 'CallRecording';
