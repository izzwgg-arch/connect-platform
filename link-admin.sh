#!/bin/bash
set -e
DB="docker exec connectcomms-postgres psql -U connectcomms -d connectcomms -t -A"
INST_ID="cmmi7huxy0000qq3igj493o5q"

echo "=== Admin user's tenant ==="
ADMIN_TID=$($DB -c "SELECT \"tenantId\" FROM \"User\" WHERE role = 'SUPER_ADMIN' LIMIT 1")
echo "Admin tenantId: [$ADMIN_TID]"

echo ""
echo "=== Check if link exists for admin tenant ==="
EXISTING=$($DB -c "SELECT id, status FROM \"TenantPbxLink\" WHERE \"tenantId\" = '$ADMIN_TID' LIMIT 1")
echo "Existing link: [$EXISTING]"

if [ -z "$EXISTING" ]; then
  LINK_ID="link_admin_$(date +%s)"
  echo "Creating TenantPbxLink $LINK_ID for tenant $ADMIN_TID"
  $DB -c "INSERT INTO \"TenantPbxLink\" (id, \"tenantId\", \"pbxInstanceId\", status, \"createdAt\", \"updatedAt\") VALUES ('$LINK_ID', '$ADMIN_TID', '$INST_ID', 'LINKED', NOW(), NOW())"
else
  echo "Updating existing link to LINKED with correct instance"
  LINK_ID=$(echo "$EXISTING" | cut -d'|' -f1)
  $DB -c "UPDATE \"TenantPbxLink\" SET status = 'LINKED', \"pbxInstanceId\" = '$INST_ID', \"updatedAt\" = NOW() WHERE id = '$LINK_ID'"
fi

echo ""
echo "=== Verify all LINKED links ==="
$DB -c "SELECT tpl.id, tpl.\"tenantId\", tpl.status, pi.\"baseUrl\", pi.\"isEnabled\" FROM \"TenantPbxLink\" tpl JOIN \"PbxInstance\" pi ON pi.id = tpl.\"pbxInstanceId\" WHERE tpl.status = 'LINKED'"

echo ""
echo "=== Restarting API container to clear cache ==="
docker restart app-api-1

echo ""
echo "=== DONE ==="
