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
EMAIL="msgsmoke${NOW}@connectcomunications.com"
TENANT_NAME="Messaging Smoke ${NOW}"

fail(){ echo "[v1.5.2-messaging] FAIL: $*" >&2; exit 1; }
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

wa_twilio_payload="$(jq -nc '{accountSid:"AC1234567890",authToken:"wa-smoke-token",fromWhatsAppNumber:"whatsapp:+15551234567"}')"
wa_twilio_json="$(api PUT /settings/providers/whatsapp/twilio "$TOKEN" "$wa_twilio_payload")"
echo "$wa_twilio_json" | jq -e '.ok == true and .provider == "WHATSAPP_TWILIO"' >/dev/null || fail "twilio whatsapp save failed"

wa_enable_json="$(api POST /settings/providers/whatsapp/enable "$TOKEN" '{"provider":"WHATSAPP_TWILIO"}')"
echo "$wa_enable_json" | jq -e '.ok == true and .isEnabled == true' >/dev/null || fail "whatsapp enable failed"

wa_test_json="$(api POST /whatsapp/test-send "$TOKEN" '{"to":"+15555550199","message":"hello"}')"
echo "$wa_test_json" | jq -e '.ok == true' >/dev/null || { echo "$wa_test_json" >&2; fail "whatsapp test-send failed"; }

wa_list_json="$(api GET /settings/providers/whatsapp "$TOKEN")"
echo "$wa_list_json" | jq -e '.providers | length >= 1' >/dev/null || fail "whatsapp providers list failed"
if echo "$wa_list_json" | jq -e --arg s "wa-smoke-token" 'tostring | contains($s)' >/dev/null; then
  fail "plaintext WhatsApp secret leaked"
fi

campaign_payload="$(jq -nc '{name:"Smoke Campaign",message:"Hello messaging smoke",audienceType:"manual",recipients:["+15555550101","+15555550102"],autoSend:false}')"
campaign_json="$(api POST /sms/campaigns "$TOKEN" "$campaign_payload")"
CAMPAIGN_ID="$(echo "$campaign_json" | jq -r '.campaign.id // empty')"
[[ -n "$CAMPAIGN_ID" ]] || { echo "$campaign_json" >&2; fail "campaign draft create failed"; }

preview_json="$(api POST "/sms/campaigns/${CAMPAIGN_ID}/preview" "$TOKEN")"
echo "$preview_json" | jq -e '.campaignId != null and .recipientCount == 2' >/dev/null || fail "campaign preview failed"

send_json="$(api POST "/sms/campaigns/${CAMPAIGN_ID}/send" "$TOKEN")"
echo "$send_json" | jq -e '.ok == true' >/dev/null || { echo "$send_json" >&2; fail "campaign send failed"; }

detail_json="$(api GET "/sms/campaigns/${CAMPAIGN_ID}" "$TOKEN")"
echo "$detail_json" | jq -e '.metrics.total == 2' >/dev/null || fail "campaign detail metrics missing"

echo "[v1.5.2-messaging] PASS: whatsapp + campaign flows validated"
