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
EMAIL="solasmoke${NOW}@connectcomunications.com"
TENANT_NAME="Billing SOLA Smoke ${NOW}"

fail(){ echo "[v1.5.2-billing] FAIL: $*" >&2; exit 1; }

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
curl -fsS "${LOCAL_API}/health" >/dev/null || fail "local health check failed"

signup_payload="$(jq -nc --arg tn "$TENANT_NAME" --arg em "$EMAIL" --arg pw "$PASSWORD" '{tenantName:$tn,email:$em,password:$pw}')"
signup_json="$(api POST /auth/signup "" "$signup_payload")"
echo "$signup_json" | jq -e . >/dev/null || fail "invalid signup response"

# promote smoke user to ADMIN for billing settings endpoints
PG_CONTAINER="$(docker ps --format '{{.Names}}' | awk '/postgres/{print; exit}')"
[[ -n "$PG_CONTAINER" ]] || fail "postgres container not found"
docker exec -i "$PG_CONTAINER" psql -U connectcomms -d connectcomms -c "UPDATE \"User\" SET role='ADMIN' WHERE email='${EMAIL}';" >/dev/null

login_payload="$(jq -nc --arg em "$EMAIL" --arg pw "$PASSWORD" '{email:$em,password:$pw}')"
login_json="$(api POST /auth/login "" "$login_payload")"
TOKEN="$(echo "$login_json" | jq -r '.token // empty')"
[[ -n "$TOKEN" ]] || fail "login token missing"

put_payload="$(jq -nc '{apiBaseUrl:"https://sandbox.solapayments.com",mode:"sandbox",simulate:true,authMode:"xkey_body",apiKey:"smoke-api-key",apiSecret:"smoke-secret",webhookSecret:"smoke-webhook",pathOverrides:{hostedSessionPath:"/hosted-checkout/sessions",chargePath:"/subscriptions/charge",cancelPath:"/subscriptions/cancel"}}')"
put_json="$(api PUT /billing/sola/config "$TOKEN" "$put_payload")"
echo "$put_json" | jq -e ' .ok == true and .config.configured == true and .config.isEnabled == false ' >/dev/null || { echo "$put_json" >&2; fail "save SOLA config failed"; }

got_json="$(api GET /billing/sola/config "$TOKEN")"
echo "$got_json" | jq -e '.configured == true and .config.masked.apiKey != null and .config.masked.apiSecret == "********" and .config.masked.webhookSecret == "********"' >/dev/null || fail "masked GET check failed"
if echo "$got_json" | jq -e --arg k "smoke-api-key" 'tostring | contains($k)' >/dev/null; then
  fail "plaintext apiKey leaked in response"
fi

# test should pass in simulate mode
post_test_json="$(api POST /billing/sola/config/test "$TOKEN")"
echo "$post_test_json" | jq -e ' .ok == true ' >/dev/null || { echo "$post_test_json" >&2; fail "SOLA config test failed"; }

post_enable_json="$(api POST /billing/sola/config/enable "$TOKEN")"
echo "$post_enable_json" | jq -e '.ok == true and .isEnabled == true' >/dev/null || fail "enable failed"

echo "[v1.5.2-billing] PASS: SOLA config endpoints validated"
