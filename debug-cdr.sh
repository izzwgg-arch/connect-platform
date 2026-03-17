#!/bin/bash
echo "=== Checking pbxInstance table ==="
docker exec app-db-1 psql -U connect -d connect -c 'SELECT id, "baseUrl", "isEnabled" FROM "PbxInstance" LIMIT 5' 2>/dev/null || echo "No PbxInstance table or no rows"

echo ""
echo "=== Checking tenantPbxLink table ==="
docker exec app-db-1 psql -U connect -d connect -c 'SELECT id, "tenantId", "pbxInstanceId", "isActive" FROM "TenantPbxLink" WHERE "isActive"=true LIMIT 5' 2>/dev/null || echo "No TenantPbxLink rows"

echo ""
echo "=== API env vars related to PBX ==="
docker exec app-api-1 env 2>/dev/null | grep -iE 'VITAL|PBX|ARI' || echo "No PBX env vars"

echo ""
echo "=== Done ==="
