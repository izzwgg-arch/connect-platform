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
EMAIL="emailsmoke${NOW}@connectcomunications.com"
TENANT_NAME="Email Invoice Smoke ${NOW}"

fail(){ echo "[v1.5.2-email] FAIL: $*" >&2; exit 1; }
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

email_put_payload="$(jq -nc '{provider:"GOOGLE_WORKSPACE",fromName:"Connect Communications",fromEmail:"billing@connectcomunications.com",replyTo:"support@connectcomunications.com",smtpHost:"smtp-relay.gmail.com",smtpPort:587,smtpUser:"workspace-user",smtpPass:"workspace-pass",smtpSecure:false}')"
email_put_json="$(api PUT /settings/email "$TOKEN" "$email_put_payload")"
echo "$email_put_json" | jq -e '.ok == true and .provider == "GOOGLE_WORKSPACE"' >/dev/null || fail "email settings save failed"

email_test_json="$(api POST /settings/email/test "$TOKEN")"
echo "$email_test_json" | jq -e '.ok == true' >/dev/null || fail "email provider test failed"

invoice_create_payload="$(jq -nc --arg ce "$EMAIL" '{customerEmail:$ce,amountCents:3500,currency:"USD",sendEmail:true}')"
invoice_create_json="$(api POST /billing/invoices "$TOKEN" "$invoice_create_payload")"
INVOICE_ID="$(echo "$invoice_create_json" | jq -r '.id // empty')"
PAY_TOKEN="$(echo "$invoice_create_json" | jq -r '.payToken // empty')"
[[ -n "$INVOICE_ID" && -n "$PAY_TOKEN" ]] || { echo "$invoice_create_json" >&2; fail "invoice create failed"; }

pay_view_json="$(api GET "/billing/invoices/pay/${PAY_TOKEN}" "")"
echo "$pay_view_json" | jq -e '.invoiceId != null and .status != null' >/dev/null || fail "public pay lookup failed"

simulate_success_json="$(api POST "/billing/invoices/${INVOICE_ID}/simulate-webhook" "$TOKEN" '{"status":"SUCCEEDED"}')"
echo "$simulate_success_json" | jq -e '.ok == true and .invoice.status == "PAID"' >/dev/null || fail "simulate success failed"

simulate_fail_json="$(api POST "/billing/invoices/${INVOICE_ID}/simulate-webhook" "$TOKEN" '{"status":"FAILED"}')"
echo "$simulate_fail_json" | jq -e '.ok == true and .invoice.status == "SENT"' >/dev/null || fail "simulate failure failed"

EMAIL_JOB_COUNT="$(docker exec -i "$PG_CONTAINER" psql -U connectcomms -d connectcomms -Atc "SELECT count(*) FROM \"EmailJob\" WHERE \"tenantId\"=(SELECT id FROM \"Tenant\" WHERE name='${TENANT_NAME}' LIMIT 1);")"
[[ "${EMAIL_JOB_COUNT}" =~ ^[0-9]+$ ]] || fail "unable to read email job count"
if [[ "$EMAIL_JOB_COUNT" -lt 3 ]]; then
  fail "expected at least 3 email jobs, got ${EMAIL_JOB_COUNT}"
fi

echo "[v1.5.2-email] PASS: email provider + invoice + email queue validated"
