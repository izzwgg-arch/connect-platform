-- Check PbxTenantDirectory for the PBX instance
SELECT id, "vitalTenantId", "tenantSlug", "tenantCode", "displayName"
FROM "PbxTenantDirectory"
WHERE "pbxInstanceId" = 'cmmi7huxy0000qq3igj493o5q'
ORDER BY "tenantCode";

-- Check pbx hints for A plus center extension 103
SELECT h."extensionNumber", h."connectTenantId", h."pbxTenantCode"
FROM "PbxExtensionHint" h
WHERE h."connectTenantId" = 'cmnlgnumi0000p9g6l7t1t0z7'
LIMIT 10;
