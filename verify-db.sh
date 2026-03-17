#!/bin/bash
DB="docker exec connectcomms-postgres psql -U connectcomms -d connectcomms -t -A"

echo "=== ALL TenantPbxLink records ==="
$DB -c 'SELECT id, "tenantId", "pbxInstanceId", status FROM "TenantPbxLink"'

echo ""
echo "=== PbxLinkStatus enum values ==="
$DB -c "SELECT unnest(enum_range(NULL::\"PbxLinkStatus\"))"

echo ""
echo "=== Enabled PbxInstance records ==="
$DB -c 'SELECT id, "baseUrl", "isEnabled" FROM "PbxInstance" WHERE "isEnabled" = true'

echo ""
echo "=== Links with LINKED status and enabled instance (the exact query) ==="
$DB -c 'SELECT tpl.id, tpl."tenantId", tpl.status, pi."baseUrl", pi."isEnabled" FROM "TenantPbxLink" tpl JOIN "PbxInstance" pi ON pi.id = tpl."pbxInstanceId" WHERE tpl.status = '"'"'LINKED'"'"' AND pi."isEnabled" = true'
