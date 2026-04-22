SELECT status, COUNT(*) FROM "TenantPbxLink" GROUP BY status;
SELECT id, "tenantId", "pbxTenantId", status FROM "TenantPbxLink" LIMIT 5;
