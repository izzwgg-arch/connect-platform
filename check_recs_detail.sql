-- Check the 14 created CallRecording rows
SELECT "linkedId", status, "pbxFilePath", "pbxFileDate", extension, attempts, "tenantId" FROM "CallRecording" ORDER BY "createdAt" DESC LIMIT 15;
-- Check corresponding CDR info
SELECT c."linkedId", c."fromNumber", c."toNumber", c."startedAt", c."talkSec", c."tenantId" 
FROM "ConnectCdr" c 
JOIN "CallRecording" r ON r."linkedId" = c."linkedId"
LIMIT 15;
