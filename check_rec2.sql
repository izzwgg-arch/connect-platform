SELECT "recordingStatus", COUNT(*) FROM "ConnectCdr" GROUP BY "recordingStatus" ORDER BY COUNT(*) DESC;
SELECT COUNT(*) as call_recordings FROM "CallRecording";
SELECT status, COUNT(*) FROM "CallRecording" GROUP BY status;
