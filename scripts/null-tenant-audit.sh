#!/bin/bash
# Null-tenant CDR row audit — columns that actually exist in ConnectCdr schema
DB_URL=$(grep DATABASE_URL /opt/connectcomms/env/.env.platform | cut -d= -f2- | tr -d '"')
PG="docker exec connectcomms-postgres psql $DB_URL --csv"

echo "=== Null-Tenant Audit $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

echo ""
echo "-- 1. Direction breakdown (null-tenant rows, last 24h) --"
$PG -c "SELECT direction, COUNT(*) as cnt FROM \"ConnectCdr\" WHERE \"tenantId\" IS NULL AND \"startedAt\" >= NOW() - INTERVAL '24 hours' GROUP BY direction ORDER BY cnt DESC;"

echo ""
echo "-- 2. Most common TO numbers in null-tenant rows --"
$PG -c "SELECT \"toNumber\", COUNT(*) as cnt, MIN(direction) as sample_dir FROM \"ConnectCdr\" WHERE \"tenantId\" IS NULL AND \"startedAt\" >= NOW() - INTERVAL '24 hours' AND \"toNumber\" ~ '^[0-9]{7,}$' GROUP BY \"toNumber\" ORDER BY cnt DESC LIMIT 20;"

echo ""
echo "-- 3. Most common FROM numbers in null-tenant rows --"
$PG -c "SELECT \"fromNumber\", COUNT(*) as cnt, MIN(\"toNumber\") as sample_to FROM \"ConnectCdr\" WHERE \"tenantId\" IS NULL AND \"startedAt\" >= NOW() - INTERVAL '24 hours' AND \"fromNumber\" ~ '^[0-9]{7,}$' GROUP BY \"fromNumber\" ORDER BY cnt DESC LIMIT 10;"

echo ""
echo "-- 4. Sample null-tenant rows (15 most recent) --"
$PG -c "SELECT \"linkedId\", \"fromNumber\", \"toNumber\", direction, disposition, \"durationSec\", \"startedAt\" FROM \"ConnectCdr\" WHERE \"tenantId\" IS NULL AND \"startedAt\" >= NOW() - INTERVAL '24 hours' ORDER BY \"startedAt\" DESC LIMIT 15;"

echo ""
echo "-- 5. Total overview --"
$PG -c "SELECT COUNT(*) as total, COUNT(CASE WHEN \"tenantId\" IS NULL THEN 1 END) as null_tenant FROM \"ConnectCdr\" WHERE \"startedAt\" >= NOW() - INTERVAL '24 hours';"

echo "Done."
