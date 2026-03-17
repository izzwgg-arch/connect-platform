#!/bin/bash
set -e
DB="docker exec connectcomms-postgres psql -U connectcomms -d connectcomms -t -A"

echo "=== Step 1: Find the correct PbxInstance for m.connectcomunications.com ==="
INST_ID=$($DB -c "SELECT id FROM \"PbxInstance\" WHERE \"baseUrl\" = 'https://m.connectcomunications.com' LIMIT 1")
echo "Instance ID: [$INST_ID]"

if [ -z "$INST_ID" ]; then
  echo "ERROR: No PbxInstance with baseUrl https://m.connectcomunications.com"
  echo "Checking all real instances..."
  $DB -c "SELECT id, \"baseUrl\", \"isEnabled\" FROM \"PbxInstance\" WHERE \"baseUrl\" LIKE '%connectcomunications%'"
  exit 1
fi

echo ""
echo "=== Step 2: Enable this instance ==="
$DB -c "UPDATE \"PbxInstance\" SET \"isEnabled\" = true WHERE id = '$INST_ID'"
echo "Enabled instance $INST_ID"

echo ""
echo "=== Step 3: Verify token is present ==="
TOKEN_LEN=$($DB -c "SELECT length(\"apiAuthEncrypted\") FROM \"PbxInstance\" WHERE id = '$INST_ID'")
echo "apiAuthEncrypted length: $TOKEN_LEN"

echo ""
echo "=== Step 4: Check admin tenant ==="
ADMIN_TENANT=$($DB -c "SELECT id FROM \"Tenant\" LIMIT 1")
echo "First tenant: [$ADMIN_TENANT]"

echo ""
echo "=== Step 5: Check existing links for this instance ==="
$DB -c "SELECT id, \"tenantId\", status FROM \"TenantPbxLink\" WHERE \"pbxInstanceId\" = '$INST_ID'"

echo ""
echo "=== Step 6: Create or update TenantPbxLink for admin tenant ==="
EXISTING_LINK=$($DB -c "SELECT id FROM \"TenantPbxLink\" WHERE \"tenantId\" = '$ADMIN_TENANT' LIMIT 1")
if [ -n "$EXISTING_LINK" ]; then
  echo "Updating existing link $EXISTING_LINK -> LINKED, instanceId=$INST_ID"
  $DB -c "UPDATE \"TenantPbxLink\" SET status = 'LINKED', \"pbxInstanceId\" = '$INST_ID', \"updatedAt\" = NOW() WHERE id = '$EXISTING_LINK'"
else
  LINK_ID="link_$(date +%s)"
  echo "Creating new TenantPbxLink $LINK_ID for tenant $ADMIN_TENANT"
  $DB -c "INSERT INTO \"TenantPbxLink\" (id, \"tenantId\", \"pbxInstanceId\", status, \"createdAt\", \"updatedAt\") VALUES ('$LINK_ID', '$ADMIN_TENANT', '$INST_ID', 'LINKED', NOW(), NOW())"
fi

echo ""
echo "=== Step 7: Verify final state ==="
$DB -c "SELECT id, \"baseUrl\", \"isEnabled\" FROM \"PbxInstance\" WHERE id = '$INST_ID'"
$DB -c "SELECT id, \"tenantId\", \"pbxInstanceId\", status FROM \"TenantPbxLink\" WHERE \"pbxInstanceId\" = '$INST_ID'"

echo ""
echo "=== Step 8: Count tenants that need links ==="
TOTAL_TENANTS=$($DB -c "SELECT count(*) FROM \"Tenant\"")
LINKED_TENANTS=$($DB -c "SELECT count(*) FROM \"TenantPbxLink\" WHERE status = 'LINKED'")
echo "Total tenants: $TOTAL_TENANTS, Linked: $LINKED_TENANTS"

echo ""
echo "=== DONE. Restart API container to clear cache ==="
