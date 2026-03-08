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
EMAIL="roles${NOW}@connectcomunications.com"
TENANT_NAME="Roles Smoke ${NOW}"

fail(){ echo "[v1.5.8-roles] FAIL: $*" >&2; exit 1; }
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

set_role() {
  local role="$1"
  docker exec -i "$PG_CONTAINER" psql -U connectcomms -d connectcomms -c "UPDATE \"User\" SET role='${role}' WHERE email='${EMAIL}';" >/dev/null
}

login_payload="$(jq -nc --arg em "$EMAIL" --arg pw "$PASSWORD" '{email:$em,password:$pw}')"

# billing-only: billing endpoints allowed
set_role "BILLING"
billing_login="$(api POST /auth/login "" "$login_payload")"
BILLING_TOKEN="$(echo "$billing_login" | jq -r '.token // empty')"
[[ -n "$BILLING_TOKEN" ]] || fail "billing login failed"
billing_resp="$(api GET /billing/sola/config "$BILLING_TOKEN")"
echo "$billing_resp" | jq -e '.configured != null' >/dev/null || fail "billing permission check failed"

# messaging-only: messaging endpoint should not be forbidden
set_role "MESSAGING"
messaging_login="$(api POST /auth/login "" "$login_payload")"
MESSAGING_TOKEN="$(echo "$messaging_login" | jq -r '.token // empty')"
[[ -n "$MESSAGING_TOKEN" ]] || fail "messaging login failed"
msg_payload='{"name":"role-smoke","message":"hello","audienceType":"manual","recipients":["+15555550101"],"autoSend":false}'
msg_resp="$(api POST /sms/campaigns "$MESSAGING_TOKEN" "$msg_payload")"
if echo "$msg_resp" | jq -e '.error == "forbidden" or .error.code == "forbidden"' >/dev/null; then
  fail "messaging permission check failed"
fi

# read-only: mutation denied
set_role "READ_ONLY"
readonly_login="$(api POST /auth/login "" "$login_payload")"
READ_ONLY_TOKEN="$(echo "$readonly_login" | jq -r '.token // empty')"
[[ -n "$READ_ONLY_TOKEN" ]] || fail "read-only login failed"
readonly_resp="$(api POST /billing/invoices "$READ_ONLY_TOKEN" '{"customerEmail":"ro@example.com","amountCents":1200,"currency":"USD","sendEmail":false}')"
echo "$readonly_resp" | jq -e '.error == "forbidden"' >/dev/null || fail "read-only denial check failed"

echo "[v1.5.8-roles] PASS: role permissions validated"
