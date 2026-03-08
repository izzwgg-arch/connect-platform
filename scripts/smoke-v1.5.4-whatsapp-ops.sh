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
EMAIL="waops${NOW}@connectcomunications.com"
TENANT_NAME="WhatsApp Ops Smoke ${NOW}"

fail(){ echo "[v1.5.4-whatsapp-ops] FAIL: $*" >&2; exit 1; }
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

wa_twilio_payload="$(jq -nc '{accountSid:"AC5555555555",authToken:"wa-ops-smoke-token",fromWhatsAppNumber:"whatsapp:+15551230000"}')"
wa_twilio_json="$(api PUT /settings/providers/whatsapp/twilio "$TOKEN" "$wa_twilio_payload")"
echo "$wa_twilio_json" | jq -e '.ok == true and .provider == "WHATSAPP_TWILIO"' >/dev/null || fail "twilio whatsapp save failed"

wa_enable_json="$(api POST /settings/providers/whatsapp/enable "$TOKEN" '{"provider":"WHATSAPP_TWILIO"}')"
echo "$wa_enable_json" | jq -e '.ok == true and .isEnabled == true' >/dev/null || fail "whatsapp enable failed"

wa_status_json="$(api GET /whatsapp/status "$TOKEN")"
echo "$wa_status_json" | jq -e '.activeProvider == "WHATSAPP_TWILIO"' >/dev/null || fail "whatsapp status missing active provider"

wa_webhook_payload='{"AccountSid":"AC5555555555","MessageSid":"SM-OPS-1","From":"whatsapp:+15550001111","To":"whatsapp:+15551230000","Body":"hello from inbound","MessageStatus":"received"}'
wa_webhook_json="$(api POST /webhooks/whatsapp/twilio/status "" "$wa_webhook_payload")"
echo "$wa_webhook_json" | jq -e '.ok == true and .tenantMatched == true' >/dev/null || fail "twilio webhook ingest failed"

threads_json="$(api GET /whatsapp/threads "$TOKEN")"
THREAD_ID="$(echo "$threads_json" | jq -r '.[0].id // empty')"
[[ -n "$THREAD_ID" ]] || { echo "$threads_json" >&2; fail "thread list missing rows"; }

thread_json="$(api GET "/whatsapp/threads/${THREAD_ID}" "$TOKEN")"
echo "$thread_json" | jq -e '.id != null and (.messages | length) >= 1' >/dev/null || fail "thread detail shape invalid"

send_json="$(api POST "/whatsapp/threads/${THREAD_ID}/send" "$TOKEN" '{"message":"reply smoke"}')"
echo "$send_json" | jq -e '.ok == true and .messageId != null' >/dev/null || fail "thread send shape invalid"

recent_json="$(api GET /whatsapp/messages/recent "$TOKEN")"
echo "$recent_json" | jq -e 'length >= 1 and .[0].threadId != null and .[0].status != null' >/dev/null || fail "recent message shape invalid"

if echo "$threads_json" | jq -e --arg s "wa-ops-smoke-token" 'tostring | contains($s)' >/dev/null; then
  fail "plaintext WhatsApp secret leaked"
fi

echo "[v1.5.4-whatsapp-ops] PASS: whatsapp ops endpoints validated"
