-- TenantPbxLinks for the real PBX (m.connectcomunications.com)
SELECT tpl.id, tpl."tenantId", tpl."pbxTenantId", tpl.status, pi."baseUrl"
FROM "TenantPbxLink" tpl
JOIN "PbxInstance" pi ON pi.id = tpl."pbxInstanceId"
WHERE pi."baseUrl" LIKE '%connectcomunications%'
ORDER BY tpl."pbxTenantId"
LIMIT 20;
