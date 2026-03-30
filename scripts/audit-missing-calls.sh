#!/usr/bin/env bash
# Audit missing calls: PBX unique linkedId count vs Connect unique linkedId count
# Run on app server: bash /opt/connectcomms/app/scripts/audit-missing-calls.sh
set -euo pipefail
DB="postgresql://connectcomms:7d5b4ceaaa74883911a6fb06a3c1b6a6ec8054c507393bab@127.0.0.1:5432/connectcomms"

echo ""
echo "=== CONNECT DB: unique linkedId count (today: America/New_York) ==="
docker exec connectcomms-postgres psql "$DB" -c "
  SELECT
    COUNT(DISTINCT \"linkedId\") AS unique_linked_ids,
    COUNT(*) AS total_rows,
    COUNT(*) FILTER (WHERE \"tenantId\" IS NULL) AS null_tenant_rows,
    COUNT(*) FILTER (WHERE direction='incoming') AS incoming,
    COUNT(*) FILTER (WHERE direction='outgoing') AS outgoing,
    COUNT(*) FILTER (WHERE direction='internal') AS internal,
    COUNT(*) FILTER (WHERE direction='unknown') AS unknown,
    MIN(\"startedAt\") AS earliest,
    MAX(\"startedAt\") AS latest
  FROM \"ConnectCdr\"
  WHERE \"startedAt\" >= '2026-03-29 04:00:00+00'
    AND \"startedAt\" <  '2026-03-30 04:00:00+00';
"

echo ""
echo "=== CONNECT DB: by-tenant count today (top 20 tenants) ==="
docker exec connectcomms-postgres psql "$DB" -c "
  SELECT
    COALESCE(\"tenantId\",'(null)') AS tenant,
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE direction='incoming') AS inc,
    COUNT(*) FILTER (WHERE direction='outgoing') AS out,
    COUNT(*) FILTER (WHERE direction='internal') AS int_
  FROM \"ConnectCdr\"
  WHERE \"startedAt\" >= '2026-03-29 04:00:00+00'
    AND \"startedAt\" <  '2026-03-30 04:00:00+00'
  GROUP BY \"tenantId\"
  ORDER BY total DESC
  LIMIT 20;
"

echo ""
echo "=== CONNECT DB: distinct tenants ever seen ==="
docker exec connectcomms-postgres psql "$DB" -c "
  SELECT COUNT(DISTINCT \"tenantId\") AS tenant_count,
         COUNT(DISTINCT \"tenantId\") FILTER (WHERE \"tenantId\" IS NOT NULL) AS non_null_tenants
  FROM \"ConnectCdr\";
"

echo ""
echo "=== CONNECT DB: all-time unique linkedId ==="
docker exec connectcomms-postgres psql "$DB" -c "
  SELECT
    COUNT(DISTINCT \"linkedId\") AS unique_linked_ids,
    COUNT(*) AS total_rows,
    MIN(\"startedAt\") AS earliest,
    MAX(\"startedAt\") AS latest
  FROM \"ConnectCdr\";
"

echo ""
echo "=== CONNECT DB: calls per day (last 7 days) ==="
docker exec connectcomms-postgres psql "$DB" -c "
  SELECT
    DATE(\"startedAt\" AT TIME ZONE 'America/New_York') AS day,
    COUNT(*) AS total_rows
  FROM \"ConnectCdr\"
  WHERE \"startedAt\" >= NOW() - INTERVAL '8 days'
  GROUP BY 1
  ORDER BY 1;
"

echo ""
echo "=== CONNECT DB: sample null-tenant rows (to see what's missing tenant) ==="
docker exec connectcomms-postgres psql "$DB" -c "
  SELECT \"linkedId\", \"fromNumber\", \"toNumber\", direction, \"durationSec\", \"startedAt\"
  FROM \"ConnectCdr\"
  WHERE \"tenantId\" IS NULL
    AND \"startedAt\" >= '2026-03-29 04:00:00+00'
  ORDER BY \"startedAt\" DESC
  LIMIT 10;
"

echo ""
echo "Done."
