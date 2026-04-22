-- Check what tenantId values look like in ConnectCdr
SELECT "tenantId", COUNT(*) FROM "ConnectCdr" GROUP BY "tenantId" ORDER BY COUNT(*) DESC LIMIT 10;
-- Check PbxInstance base URLs to understand which PBXes exist
SELECT id, "baseUrl" FROM "PbxInstance" LIMIT 5;
-- Check TenantPbxLink tenantId format vs ConnectCdr
SELECT tpl."tenantId", tpl."pbxTenantId", tpl.status FROM "TenantPbxLink" tpl LIMIT 5;
