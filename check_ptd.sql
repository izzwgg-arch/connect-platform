-- PbxTenantDirectory: maps numeric vitalTenantId to tenantSlug
SELECT "vitalTenantId", "tenantSlug", "pbxInstanceId" FROM "PbxTenantDirectory" ORDER BY "tenantSlug" LIMIT 30;
