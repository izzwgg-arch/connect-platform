#!/bin/bash
DB="docker exec connectcomms-postgres psql -U connectcomms -d connectcomms -t -A"

echo "=== Setting both new links to LINKED ==="
$DB -c "UPDATE \"TenantPbxLink\" SET status = 'LINKED', \"updatedAt\" = NOW() WHERE id IN ('link_admin_1773163618', 'link_1773163582')"

echo ""
echo "=== Disable the trailing-slash instance (wrong baseUrl) ==="
$DB -c "UPDATE \"PbxInstance\" SET \"isEnabled\" = false WHERE \"baseUrl\" = 'https://m.connectcomunications.com/'"

echo ""
echo "=== Verify ==="
$DB -c 'SELECT id, "tenantId", "pbxInstanceId", status FROM "TenantPbxLink" WHERE status = '"'"'LINKED'"'"''
$DB -c 'SELECT id, "baseUrl", "isEnabled" FROM "PbxInstance" WHERE "isEnabled" = true'
