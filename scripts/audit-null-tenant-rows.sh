#!/bin/bash
# Step 5: Null-tenant row audit via direct psql
# Run on server: bash /opt/connectcomms/app/scripts/audit-null-tenant-rows.sh
set -e
DB_URL=$(grep DATABASE_URL /opt/connectcomms/env/.env.platform | cut -d= -f2- | tr -d '"' | tr -d "'")
PG="docker exec connectcomms-postgres psql $DB_URL --csv -c"

echo "=== Null-Tenant Row Audit $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

echo ""
echo "--- 1. Count and direction breakdown of null-tenant rows (last 24h) ---"
$PG "SELECT direction, COUNT(*) as cnt, COUNT(CASE WHEN dcontext IS NOT NULL THEN 1 END) as has_dcontext FROM \"ConnectCdr\" WHERE \"tenantId\" IS NULL AND \"startedAt\" >= NOW() - INTERVAL '24 hours' GROUP BY direction ORDER BY cnt DESC;"

echo ""
echo "--- 2. Distinct dcontext patterns in null-tenant rows ---"
$PG "SELECT COALESCE(dcontext, '(null)') as dcontext, COUNT(*) as cnt, MIN(\"fromNumber\") as sample_from, MIN(\"toNumber\") as sample_to FROM \"ConnectCdr\" WHERE \"tenantId\" IS NULL AND \"startedAt\" >= NOW() - INTERVAL '24 hours' GROUP BY dcontext ORDER BY cnt DESC LIMIT 30;"

echo ""
echo "--- 3. Most common TO numbers in null-tenant rows ---"
$PG "SELECT \"toNumber\", COUNT(*) as cnt, COUNT(DISTINCT \"linkedId\") as unique_calls, MIN(direction) as sample_dir FROM \"ConnectCdr\" WHERE \"tenantId\" IS NULL AND \"startedAt\" >= NOW() - INTERVAL '24 hours' AND \"toNumber\" ~ '^[0-9]{7,}$' GROUP BY \"toNumber\" ORDER BY cnt DESC LIMIT 20;"

echo ""
echo "--- 4. Most common FROM numbers in null-tenant rows ---"
$PG "SELECT \"fromNumber\", COUNT(*) as cnt, MIN(\"toNumber\") as sample_to FROM \"ConnectCdr\" WHERE \"tenantId\" IS NULL AND \"startedAt\" >= NOW() - INTERVAL '24 hours' AND \"fromNumber\" ~ '^[0-9]{7,}$' GROUP BY \"fromNumber\" ORDER BY cnt DESC LIMIT 10;"

echo ""
echo "--- 5. Sample null-tenant rows with full context ---"
$PG "SELECT \"linkedId\", \"fromNumber\", \"toNumber\", direction, dcontext, \"accountCode\", \"durationSec\" FROM \"ConnectCdr\" WHERE \"tenantId\" IS NULL AND \"startedAt\" >= NOW() - INTERVAL '24 hours' ORDER BY \"startedAt\" DESC LIMIT 15;"

echo ""
echo "--- 6. Total null-tenant vs total rows ---"
$PG "SELECT COUNT(*) as total, COUNT(CASE WHEN \"tenantId\" IS NULL THEN 1 END) as null_tenant, COUNT(DISTINCT \"tenantId\") as distinct_tenants FROM \"ConnectCdr\" WHERE \"startedAt\" >= NOW() - INTERVAL '24 hours';"

echo "Done."
