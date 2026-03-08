#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR_LOCAL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_QUIET_SH="${SCRIPT_DIR_LOCAL}/ops/run-quiet.sh"
SCRIPT_BASENAME="$(basename "$0" .sh)"
LOG_DIR="${OPS_LOG_DIR:-/opt/connectcomms/ops/logs}"
LOG_TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_FILE_DEFAULT="${LOG_DIR}/${SCRIPT_BASENAME}-${LOG_TIMESTAMP}.log"

if [[ "${_QUIET_WRAPPED:-0}" != "1" ]]; then
  mkdir -p "$LOG_DIR"
  LOG_FILE="${LOG_FILE:-$LOG_FILE_DEFAULT}"
  export LOG_FILE
  exec "$RUN_QUIET_SH" "$SCRIPT_BASENAME" -- env _QUIET_WRAPPED=1 LOG_FILE="$LOG_FILE" bash "$0" "$@"
fi

BASE_URL="${BASE_URL:-https://app.connectcomunications.com/api}"
LOCAL_API="${LOCAL_API:-http://127.0.0.1:3001}"
PASSWORD="${PASSWORD:-Passw0rd!234}"
NOW="$(date +%s)"
EMAIL="pbxia${NOW}@connectcomunications.com"
TENANT_NAME="PBX IA Smoke ${NOW}"

fail(){ echo "[v2.0.3-portal-pbx-org] FAIL: $*" >&2; exit 1; }
api(){
  local method="$1" path="$2" token="${3:-}" body="${4:-}"
  local headers=()
  if [[ -n "$token" ]]; then headers+=(-H "Authorization: Bearer $token"); fi
  if [[ -n "$body" ]]; then
    headers+=(-H "content-type: application/json")
    curl -sS -X "$method" "$BASE_URL$path" "${headers[@]}" -d "$body"
  else
    curl -sS -X "$method" "$BASE_URL$path" "${headers[@]}"
  fi
}

./scripts/check-migrations.sh
curl -fsS "${LOCAL_API}/health" >/dev/null || fail "local API health failed"

signup_payload="$(jq -nc --arg tn "$TENANT_NAME" --arg em "$EMAIL" --arg pw "$PASSWORD" '{tenantName:$tn,email:$em,password:$pw}')"
signup_json="$(api POST /auth/signup "" "$signup_payload")"
echo "$signup_json" | jq -e . >/dev/null || fail "invalid signup response"

PG_CONTAINER="$(docker ps --format '{{.Names}}' | awk '/postgres/{print; exit}')"
[[ -n "$PG_CONTAINER" ]] || fail "postgres container not found"
docker exec -i "$PG_CONTAINER" psql -U connectcomms -d connectcomms -c "UPDATE \"User\" SET role='ADMIN' WHERE email='${EMAIL}';" >/dev/null

login_payload="$(jq -nc --arg em "$EMAIL" --arg pw "$PASSWORD" '{email:$em,password:$pw}')"
login_json="$(api POST /auth/login "" "$login_payload")"
TOKEN="$(echo "$login_json" | jq -r '.token // empty')"
[[ -n "$TOKEN" ]] || fail "login token missing"

tenants_json="$(api GET /admin/tenants "$TOKEN")"
echo "$tenants_json" | jq -e 'type == "array"' >/dev/null || fail "admin tenants response invalid"

instances_json="$(api GET /admin/pbx/instances "$TOKEN")"
echo "$instances_json" | jq -e 'type == "array"' >/dev/null || fail "pbx instances response invalid"

extensions_json="$(api GET /voice/pbx/resources/extensions "$TOKEN")"
if echo "$extensions_json" | jq -e '.resource == "extensions" and (.rows | type == "array")' >/dev/null 2>&1; then
  :
else
  echo "$extensions_json" | jq -e '.error == "PBX_LINK_NOT_FOUND" or .error == "forbidden" or .error == "resource_not_supported"' >/dev/null || fail "extensions resource response invalid"
fi

recordings_json="$(api GET /voice/pbx/call-recordings "$TOKEN")"
if echo "$recordings_json" | jq -e '.rows | type == "array"' >/dev/null 2>&1; then
  :
else
  echo "$recordings_json" | jq -e '.error == "PBX_LINK_NOT_FOUND" or .error == "forbidden"' >/dev/null || fail "call recordings response invalid"
fi

reports_json="$(api GET /voice/pbx/call-reports "$TOKEN")"
if echo "$reports_json" | jq -e '.report != null' >/dev/null 2>&1; then
  :
else
  echo "$reports_json" | jq -e '.error == "PBX_LINK_NOT_FOUND" or .error == "forbidden"' >/dev/null || fail "call reports response invalid"
fi

summary_json="$(api GET '/dashboard/summary?range=24h' "$TOKEN")"
echo "$summary_json" | jq -e '.invoiceSummary != null and .messagingSummary != null and .whatsappSummary != null and .attention != null' >/dev/null || fail "dashboard summary shape invalid"

activity_json="$(api GET '/dashboard/activity?range=24h' "$TOKEN")"
echo "$activity_json" | jq -e '.range != null and (.items | type == "array")' >/dev/null || fail "dashboard activity shape invalid"

billing_json="$(api GET /billing/invoices/summary "$TOKEN")"
echo "$billing_json" | jq -e '.counts != null' >/dev/null || fail "billing summary shape invalid"

echo "[v2.0.3-portal-pbx-org] PASS: pbx IA and operational endpoints validated"
