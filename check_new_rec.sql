SELECT "linkedId", "tenantId", disposition, "talkSec", "recordingPath"
  FROM "ConnectCdr"
 WHERE "recordingPath" IS NOT NULL
 ORDER BY "startedAt" DESC
 LIMIT 10;

SELECT COUNT(*) AS total_with_path
  FROM "ConnectCdr"
 WHERE "recordingPath" IS NOT NULL;

SELECT COUNT(*) AS answered_since_deploy
  FROM "ConnectCdr"
 WHERE disposition = 'answered'
   AND "endedAt" > NOW() - INTERVAL '10 minutes';
