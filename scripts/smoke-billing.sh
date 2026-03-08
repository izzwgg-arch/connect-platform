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
EMAIL="smokebill${NOW}@connectcomunications.com"

fail(){ echo "[smoke-billing] FAIL: $*" >&2; exit 1; }
api(){ local method="$1" path="$2" token="${3:-}" body="${4:-}"; local h=(); [[ -n "$token" ]] && h+=(-H "Authorization: Bearer $token"); [[ -n "$body" ]] && h+=(-H "content-type: application/json"); curl -sS -X "$method" "$BASE_URL$path" "${h[@]}" ${body:+-d "$body"}; }

curl -fsS "${LOCAL_API}/health" >/dev/null || fail "api health"
signup="$(api POST /auth/signup "" "{\"tenantName\":\"Smoke Billing ${NOW}\",\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}")"
echo "$signup" | jq -e .token >/dev/null || fail "signup token"
token="$(echo "$signup" | jq -r '.token')"
cfgPut="$(api PUT /billing/sola/config "$token" '{"apiBaseUrl":"https://api.solapayments.local","mode":"sandbox","simulate":true,"authMode":"xkey_body","apiKey":"x-test","apiSecret":"y-test","webhookSecret":"z-test"}')"
echo "$cfgPut" | jq -e '.configured == true and .config.masked.apiKey != "x-test"' >/dev/null || fail "masking"
sum="$(api GET /billing/invoices/summary "$token")"
echo "$sum" | jq -e '.counts != null' >/dev/null || fail "summary"
echo "[smoke-billing] PASS"
