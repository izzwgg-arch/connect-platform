#!/usr/bin/env bash
# Capture telephony API state for real-world test plan.
# Usage:
#   TELEPHONY_URL=http://localhost:3003 TOKEN=<jwt> ./scripts/capture-telephony-state.sh
#   TELEPHONY_URL=http://localhost:3003 TOKEN=<jwt> TENANT_ID=tenant-a ./scripts/capture-telephony-state.sh
# Optional: TENANT_ID set to scope /telephony/calls to that tenant (pass tenantId in JWT or query).
set -euo pipefail

BASE="${TELEPHONY_URL:-http://localhost:3003}"
TOKEN="${TOKEN:-}"
TENANT_ID="${TENANT_ID:-}"
AUTH="${TOKEN:+Authorization: Bearer $TOKEN}"

echo "=============================================="
echo "TELEPHONY STATE CAPTURE"
echo "Time (UTC): $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "Base URL:  $BASE"
echo "Tenant:    ${TENANT_ID:-<none (master)>}"
echo "=============================================="

# Prefer jq when available for readable JSON
_jq() { if command -v jq >/dev/null 2>&1; then jq "$@"; else cat; fi; }

# Health
echo ""
echo "--- GET /telephony/health ---"
if [ -n "$TOKEN" ]; then
  curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/telephony/health" | _jq .
else
  echo "(No TOKEN; 401 expected)"
  curl -sS -w "\nHTTP %{http_code}\n" "$BASE/telephony/health" 2>/dev/null || true
fi

# Calls (scoped by tenant when tenantId is in JWT)
echo ""
echo "--- GET /telephony/calls ---"
if [ -n "$TOKEN" ]; then
  curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/telephony/calls" | _jq 'if type == "array" then { count: length, rows: . } else . end'
else
  echo "(No TOKEN; 401 expected)"
  curl -sS -w "\nHTTP %{http_code}\n" "$BASE/telephony/calls" 2>/dev/null || true
fi

# Diagnostics (only when ENABLE_TELEPHONY_DEBUG=true; often no auth)
echo ""
echo "--- GET /diagnostics ---"
curl -sS -H "Authorization: Bearer ${TOKEN:-}" "$BASE/diagnostics" | _jq . 2>/dev/null || echo "(404 or not enabled)"

echo ""
echo "=============================================="
echo "END CAPTURE"
echo "=============================================="
