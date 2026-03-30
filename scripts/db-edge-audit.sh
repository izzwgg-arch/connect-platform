#!/usr/bin/env bash
# Run on app server: bash /opt/connectcomms/app/scripts/db-edge-audit.sh
set -e
DB="postgresql://connectcomms:7d5b4ceaaa74883911a6fb06a3c1b6a6ec8054c507393bab@127.0.0.1:5432/connectcomms"

run_q() {
  local label="$1"
  local query="$2"
  echo ""
  echo "=== $label ==="
  docker exec connectcomms-postgres psql "$DB" -c "$query"
}

run_q "1. Direction totals (today)" \
  "SELECT direction, COUNT(*) AS cnt FROM \"ConnectCdr\" WHERE \"startedAt\" >= NOW() - INTERVAL '24 hours' GROUP BY direction ORDER BY cnt DESC;"

run_q "2. From-length distribution (today)" \
  "SELECT direction, LENGTH(REGEXP_REPLACE(COALESCE(\"fromNumber\",''),'[^0-9]','','g')) AS from_len, COUNT(*) AS cnt FROM \"ConnectCdr\" WHERE \"startedAt\" >= NOW() - INTERVAL '24 hours' GROUP BY 1,2 ORDER BY 1,cnt DESC LIMIT 30;"

run_q "3. Unknown-direction samples (today, limit 10)" \
  "SELECT \"linkedId\", \"fromNumber\", \"toNumber\", \"tenantId\", disposition, \"durationSec\" FROM \"ConnectCdr\" WHERE direction='unknown' AND \"startedAt\" >= NOW() - INTERVAL '24 hours' LIMIT 10;"

run_q "4. Null-tenant: direction breakdown (today)" \
  "SELECT direction, COUNT(*) AS cnt FROM \"ConnectCdr\" WHERE \"tenantId\" IS NULL AND \"startedAt\" >= NOW() - INTERVAL '24 hours' GROUP BY direction ORDER BY cnt DESC;"

run_q "5. Calls with 7-9 digit destination (ambiguous local PSTN, today)" \
  "SELECT \"linkedId\", \"fromNumber\", \"toNumber\", direction, \"tenantId\" FROM \"ConnectCdr\" WHERE \"startedAt\" >= NOW() - INTERVAL '24 hours' AND LENGTH(REGEXP_REPLACE(COALESCE(\"toNumber\",''),'[^0-9]','','g')) BETWEEN 7 AND 9 LIMIT 15;"

run_q "6. Calls with E.164 plus-prefix (from starts with +)" \
  "SELECT \"linkedId\", \"fromNumber\", \"toNumber\", direction FROM \"ConnectCdr\" WHERE \"startedAt\" >= NOW() - INTERVAL '24 hours' AND \"fromNumber\" LIKE '+%' LIMIT 10;"

run_q "7. All-time summary" \
  "SELECT direction, COUNT(*) AS cnt, COUNT(*) FILTER (WHERE \"tenantId\" IS NULL) AS null_tenant FROM \"ConnectCdr\" GROUP BY direction ORDER BY cnt DESC;"

echo ""
echo "Done."
