#!/bin/bash
: "${PGPASSWORD:?Set PGPASSWORD to the connectcomms DB password before running. It is intentionally NOT stored in this repo; provide it from your environment.}"
# Probe VitalPBX extension fields
DB="postgresql://connectcomms:${PGPASSWORD}@connectcomms-postgres:5432/connectcomms"

# Get first PBX instance base_url
BASE_URL=$(docker exec connectcomms-postgres psql "$DB" -t -c 'SELECT base_url FROM "PbxInstance" WHERE is_enabled=true LIMIT 1' | tr -d ' \n')
echo "PBX base_url: $BASE_URL"

# Get API token from encrypted field - we'll use a Node script instead
# Get first vitalTenantId
VITAL_ID=$(docker exec connectcomms-postgres psql "$DB" -t -c 'SELECT vital_tenant_id FROM "PbxTenantDirectory" LIMIT 1' | tr -d ' \n')
echo "vitalTenantId: $VITAL_ID"

# Use the API via the running app endpoint to list extensions
# Trigger a sync and capture logs
echo "Done getting IDs"
