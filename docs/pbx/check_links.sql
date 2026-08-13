\echo === Real PBX tenants linked to Connect ===
SELECT l."pbxTenantId",
       l."tenantId",
       t.name AS connect_tenant_name,
       l.status
FROM "TenantPbxLink" l
LEFT JOIN "Tenant" t ON t.id = l."tenantId"
WHERE l."pbxTenantId" ~ '^[0-9]+$'
ORDER BY l."pbxTenantId"::int;

\echo
\echo === PbxInstance rows ===
SELECT id, "baseUrl", "vpbxDomain" FROM "PbxInstance";
