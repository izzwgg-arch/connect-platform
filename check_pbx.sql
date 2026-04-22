-- All PbxInstance records
SELECT id, "baseUrl", "createdAt" FROM "PbxInstance" ORDER BY "createdAt" DESC LIMIT 20;
-- Count TenantPbxLinks per PbxInstance
SELECT pi."baseUrl", COUNT(tpl.id) as link_count FROM "PbxInstance" pi LEFT JOIN "TenantPbxLink" tpl ON tpl."pbxInstanceId" = pi.id GROUP BY pi."baseUrl";
-- What does a recent real CDR look like?
SELECT "linkedId", "tenantId", "fromNumber", "toNumber", "startedAt", disposition, "talkSec" FROM "ConnectCdr" WHERE disposition = 'answered' AND "talkSec" >= 3 ORDER BY "startedAt" DESC LIMIT 3;
