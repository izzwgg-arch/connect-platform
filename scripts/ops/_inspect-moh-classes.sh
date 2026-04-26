#!/usr/bin/env bash
set -uo pipefail

PG="docker exec connectcomms-postgres psql -U connectcomms -d connectcomms"

echo "=== PbxMohClass row count ==="
$PG -tAc 'SELECT COUNT(*) FROM "PbxMohClass";'

echo ""
echo "=== Per-tenantSlug count (active) ==="
$PG -c 'SELECT COALESCE("tenantSlug", '"'"'(unassigned)'"'"') AS slug, COUNT(*) AS total,
               SUM(CASE WHEN "isActive" THEN 1 ELSE 0 END) AS active
        FROM "PbxMohClass"
        GROUP BY 1 ORDER BY 2 DESC;'

echo ""
echo "=== All synced PBX MOH classes ==="
$PG -c 'SELECT "tenantSlug", "pbxTenantId", "mohClassName", "fileCount", "isActive"
        FROM "PbxMohClass" ORDER BY "tenantSlug" NULLS LAST, "mohClassName" LIMIT 60;'

echo ""
echo "=== PbxInstance ==="
$PG -c 'SELECT id, name, "baseUrl", "isEnabled" FROM "PbxInstance";'

echo ""
echo "=== Tenant directory (vitalTenantId -> tenantSlug) ==="
$PG -c 'SELECT "vitalTenantId", "tenantSlug", "displayName" FROM "PbxTenantDirectory" ORDER BY "vitalTenantId";'

echo ""
echo "=== Hold profiles already created ==="
$PG -c 'SELECT "tenantId", name, "vitalPbxMohClassName" FROM "MohProfile" ORDER BY "tenantId" LIMIT 20;'
