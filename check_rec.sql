SELECT COUNT(*) as call_recordings FROM "CallRecording";
SELECT "recordingStatus", COUNT(*) FROM "ConnectCdr" GROUP BY "recordingStatus" ORDER BY COUNT(*) DESC LIMIT 5;
SELECT COUNT(*) as answered_with_talk FROM "ConnectCdr" WHERE disposition = 'answered' AND "talkSec" >= 3;
SELECT "linkedId", disposition, "talkSec", "recordingStatus" FROM "ConnectCdr" WHERE disposition = 'answered' AND "talkSec" >= 3 ORDER BY "startedAt" DESC LIMIT 5;
