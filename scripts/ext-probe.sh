#!/bin/bash
# Probe VitalPBX extension fields
DB="postgresql://connectcomms:7d5b4ceaaa74883911a6fb06a3c1b6a6ec8054c507393bab@connectcomms-postgres:5432/connectcomms"

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
