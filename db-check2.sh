#!/bin/bash
echo "=== TenantPbxLink columns ==="
docker exec connectcomms-postgres psql -U connectcomms -d connectcomms -c '\d "TenantPbxLink"'

echo ""
echo "=== TenantPbxLink sample ==="
docker exec connectcomms-postgres psql -U connectcomms -d connectcomms -c 'SELECT * FROM "TenantPbxLink" LIMIT 3'

echo ""
echo "=== PbxInstance count ==="
docker exec connectcomms-postgres psql -U connectcomms -d connectcomms -c 'SELECT count(*) FROM "PbxInstance"'

echo ""
echo "=== How many real-URL instances? ==="
docker exec connectcomms-postgres psql -U connectcomms -d connectcomms -c 'SELECT "baseUrl", count(*) FROM "PbxInstance" GROUP BY "baseUrl"'
