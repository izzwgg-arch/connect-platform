#!/bin/bash
DB="postgresql://connectcomms:7d5b4ceaaa74883911a6fb06a3c1b6a6ec8054c507393bab@localhost/connectcomms"

echo "=== Extensions with extNumber=103 ==="
PGPASSWORD=7d5b4ceaaa74883911a6fb06a3c1b6a6ec8054c507393bab psql -U connectcomms -h localhost -d connectcomms -c 'SELECT e.id, e."extNumber", e."tenantId", e."ownerUserId", t.name as tenant_name FROM "Extension" e JOIN "Tenant" t ON t.id = e."tenantId" WHERE e."extNumber" = '\''103'\'''

echo ""
echo "=== PbxExtensionLink for those extensions ==="
PGPASSWORD=7d5b4ceaaa74883911a6fb06a3c1b6a6ec8054c507393bab psql -U connectcomms -h localhost -d connectcomms -c 'SELECT pel.id, pel."extensionId", pel."tenantId", pel."pbxSipUsername", (pel."sipPasswordEncrypted" IS NOT NULL) as has_pass FROM "PbxExtensionLink" pel WHERE pel."extensionId" IN (SELECT id FROM "Extension" WHERE "extNumber" = '\''103'\'')'

echo ""
echo "=== Admins for A plus center ==="
PGPASSWORD=7d5b4ceaaa74883911a6fb06a3c1b6a6ec8054c507393bab psql -U connectcomms -h localhost -d connectcomms -c 'SELECT u.id, u.email, u.role, u."tenantId", t.name FROM "User" u JOIN "Tenant" t ON t.id = u."tenantId" WHERE t.name ILIKE '\''%plus%'\'' AND u.role IN ('\''ADMIN'\'', '\''SUPER_ADMIN'\'')'
