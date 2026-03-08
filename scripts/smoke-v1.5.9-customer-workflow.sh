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
EMAIL="custwf${NOW}@connectcomunications.com"
TENANT_NAME="Customer Workflow Smoke ${NOW}"

fail(){ echo "[v1.5.9-customer-workflow] FAIL: $*" >&2; exit 1; }
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
docker exec -i "$PG_CONTAINER" psql -U connectcomms -d connectcomms -c "UPDATE \"User\" SET role='BILLING' WHERE email='${EMAIL}';" >/dev/null

login_payload="$(jq -nc --arg em "$EMAIL" --arg pw "$PASSWORD" '{email:$em,password:$pw}')"
login_json="$(api POST /auth/login "" "$login_payload")"
TOKEN="$(echo "$login_json" | jq -r '.token // empty')"
[[ -n "$TOKEN" ]] || fail "login token missing"

customer_payload="$(jq -nc --arg n "Workflow Customer ${NOW}" --arg em "$EMAIL" --arg ph "+1555333${NOW: -4}" '{displayName:$n,primaryEmail:$em,primaryPhone:$ph,whatsappNumber:$ph}')"
customer_json="$(api POST /customers "$TOKEN" "$customer_payload")"
CUSTOMER_ID="$(echo "$customer_json" | jq -r '.id // empty')"
[[ -n "$CUSTOMER_ID" ]] || fail "customer create missing id"

invoice_payload="$(jq -nc --arg cid "$CUSTOMER_ID" --arg em "$EMAIL" '{customerId:$cid,customerEmail:$em,amountCents:2600,currency:"USD",sendEmail:false}')"
invoice_json="$(api POST /billing/invoices "$TOKEN" "$invoice_payload")"
INVOICE_ID="$(echo "$invoice_json" | jq -r '.id // empty')"
[[ -n "$INVOICE_ID" ]] || fail "invoice create missing id"

note_json="$(api POST "/customers/${CUSTOMER_ID}/notes" "$TOKEN" '{"body":"Followed up on overdue payment."}')"
echo "$note_json" | jq -e '.id != null and .body != null' >/dev/null || fail "create note failed"

tags_json="$(api PUT "/customers/${CUSTOMER_ID}/tags" "$TOKEN" '{"tags":["vip","collections"],"status":"PAST_DUE"}')"
echo "$tags_json" | jq -e '.id != null and .status == "PAST_DUE"' >/dev/null || fail "update tags failed"

activity_json="$(api GET "/customers/${CUSTOMER_ID}/activity" "$TOKEN")"
echo "$activity_json" | jq -e '.customer.id != null and (.timeline | type == "array")' >/dev/null || fail "activity shape invalid"

reminder_json="$(api POST "/customers/${CUSTOMER_ID}/send-reminder" "$TOKEN")"
echo "$reminder_json" | jq -e '.ok == true or .error == "REMINDER_THROTTLED" or .error == "PAY_LINK_MISSING"' >/dev/null || fail "send reminder shape invalid"

segment_json="$(api GET "/customers/segments/summary" "$TOKEN")"
echo "$segment_json" | jq -e '.totals != null and .totals.customers >= 1 and .totals.unpaidCustomers >= 1' >/dev/null || fail "segment summary shape invalid"

echo "[v1.5.9-customer-workflow] PASS: customer workflow endpoints validated"
