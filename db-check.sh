#!/bin/bash
echo "=== PbxInstance ==="
docker exec connectcomms-postgres psql -U connectcomms -d connectcomms -c 'SELECT * FROM "PbxInstance" LIMIT 5'

echo ""
echo "=== TenantPbxLink ==="
docker exec connectcomms-postgres psql -U connectcomms -d connectcomms -c 'SELECT id, "tenantId", "pbxInstanceId", status, "isActive" FROM "TenantPbxLink" LIMIT 10'
