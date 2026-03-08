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
EMAIL="invlifecycle${NOW}@connectcomunications.com"
TENANT_NAME="Invoice Lifecycle Smoke ${NOW}"

fail(){ echo "[v1.5.5-invoice-lifecycle] FAIL: $*" >&2; exit 1; }
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

invoice_payload="$(jq -nc --arg em "$EMAIL" --arg due "$(date -u -d '2 days ago' +%Y-%m-%dT%H:%M:%SZ)" '{customerEmail:$em,amountCents:2500,currency:"USD",sendEmail:true,dueAt:$due}')"
invoice_json="$(api POST /billing/invoices "$TOKEN" "$invoice_payload")"
INVOICE_ID="$(echo "$invoice_json" | jq -r '.id // empty')"
PAY_TOKEN="$(echo "$invoice_json" | jq -r '.payToken // empty')"
[[ -n "$INVOICE_ID" ]] || fail "invoice create missing id"
[[ -n "$PAY_TOKEN" ]] || fail "invoice create missing pay token"

summary_json="$(api GET /billing/invoices/summary "$TOKEN")"
echo "$summary_json" | jq -e '.totalInvoices >= 1 and .byStatus != null and .totals != null' >/dev/null || fail "summary shape invalid"

run_overdue_json="$(api POST /billing/invoices/overdue/run "$TOKEN")"
echo "$run_overdue_json" | jq -e '.ok == true' >/dev/null || fail "overdue run failed"

remind_json="$(api POST "/billing/invoices/${INVOICE_ID}/remind" "$TOKEN")"
echo "$remind_json" | jq -e '.ok == true' >/dev/null || fail "remind failed"

void_json="$(api POST "/billing/invoices/${INVOICE_ID}/void" "$TOKEN" '{"reason":"smoke void"}')"
echo "$void_json" | jq -e '.ok == true and .invoice.status == "VOID"' >/dev/null || fail "void failed"

events_json="$(api GET "/billing/invoices/${INVOICE_ID}/events" "$TOKEN")"
echo "$events_json" | jq -e 'length >= 2 and map(.type) | any(. == "CREATED") and any(. == "VOIDED")' >/dev/null || fail "events timeline invalid"

pay_shape="$(api GET "/billing/invoices/pay/${PAY_TOKEN}")"
echo "$pay_shape" | jq -e '.invoiceId != null and .status != null and .state != null and (.canPay | type == "boolean")' >/dev/null || fail "pay-link shape invalid"

echo "[v1.5.5-invoice-lifecycle] PASS: invoice lifecycle endpoints validated"
