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
EMAIL="customerhub${NOW}@connectcomunications.com"
TENANT_NAME="Customer Hub Smoke ${NOW}"

fail(){ echo "[v1.5.6-customers] FAIL: $*" >&2; exit 1; }
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
echo "$signup_json" | jq -e . >/dev/null || fail "invalid signup"
PG_CONTAINER="$(docker ps --format '{{.Names}}' | awk '/postgres/{print; exit}')"
[[ -n "$PG_CONTAINER" ]] || fail "postgres container not found"
docker exec -i "$PG_CONTAINER" psql -U connectcomms -d connectcomms -c "UPDATE \"User\" SET role='ADMIN' WHERE email='${EMAIL}';" >/dev/null

login_payload="$(jq -nc --arg em "$EMAIL" --arg pw "$PASSWORD" '{email:$em,password:$pw}')"
login_json="$(api POST /auth/login "" "$login_payload")"
TOKEN="$(echo "$login_json" | jq -r '.token // empty')"
[[ -n "$TOKEN" ]] || fail "login token missing"

customer_payload="$(jq -nc --arg n "Smoke Customer ${NOW}" --arg em "$EMAIL" --arg ph "+1555555${NOW: -4}" '{displayName:$n,primaryEmail:$em,primaryPhone:$ph,whatsappNumber:$ph}')"
customer_json="$(api POST /customers "$TOKEN" "$customer_payload")"
CUSTOMER_ID="$(echo "$customer_json" | jq -r '.id // empty')"
[[ -n "$CUSTOMER_ID" ]] || fail "customer create missing id"

customers_json="$(api GET /customers "$TOKEN")"
echo "$customers_json" | jq -e --arg cid "$CUSTOMER_ID" 'map(.id) | index($cid) != null' >/dev/null || fail "customer list missing created customer"

invoice_payload="$(jq -nc --arg cid "$CUSTOMER_ID" --arg em "$EMAIL" '{customerId:$cid,customerEmail:$em,amountCents:1900,currency:"USD",sendEmail:false}')"
invoice_json="$(api POST /billing/invoices "$TOKEN" "$invoice_payload")"
INVOICE_ID="$(echo "$invoice_json" | jq -r '.id // empty')"
[[ -n "$INVOICE_ID" ]] || fail "invoice create missing id"
echo "$invoice_json" | jq -e --arg cid "$CUSTOMER_ID" '.customerId == $cid' >/dev/null || fail "invoice not linked to customer"

summary_json="$(api GET "/customers/${CUSTOMER_ID}/summary" "$TOKEN")"
echo "$summary_json" | jq -e '.customer.id != null and .invoices != null and .smsActivity != null and .whatsappActivity != null and .emailActivity != null' >/dev/null || fail "customer summary shape invalid"

echo "[v1.5.6-customers] PASS: customer hub endpoints validated"
