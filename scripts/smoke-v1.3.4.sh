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
PASSWORD="${PASSWORD:-Passw0rd!234}"
NOW="$(date +%s)"
EMAIL="support${NOW}@connectcomunications.com"
TENANT_NAME="Mobile Invite Race Smoke ${NOW}"
FAKE_TOKEN_A="ExponentPushToken[smoke-a-${NOW}]"
FAKE_TOKEN_B="ExponentPushToken[smoke-b-${NOW}]"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_ENV="/opt/connectcomms/infra/.env"

log(){ echo "[v1.3.4] $*"; }
fail(){ echo "FAIL: $*" >&2; exit 1; }

run_compose() {
  local label="$1"
  local cmd="$2"
  if [[ "${FORCE_REBUILD:-0}" == "1" ]]; then
    cmd="${cmd/ up -d / up -d --build }"
    log "FORCE_REBUILD=1 -> ${label} uses --build"
  fi
  /opt/connectcomms/ops/run-heavy.sh "$label" -- bash -lc "$cmd"
}

api(){
  local method="$1" path="$2" token="${3:-}" body="${4:-}" header="${5:-}"
  local auth=()
  local extra=()
  if [[ -n "$token" ]]; then auth=(-H "Authorization: Bearer $token"); fi
  if [[ -n "$header" ]]; then extra=(-H "$header"); fi
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" "$BASE_URL$path" -H "content-type: application/json" "${auth[@]}" "${extra[@]}" -d "$body"
  else
    curl -sS -X "$method" "$BASE_URL$path" -H "content-type: application/json" "${auth[@]}" "${extra[@]}"
  fi
}

log "starting first-answer-wins smoke"
cd "$REPO_ROOT"
run_compose "smoke-v1.3.4.sh:compose-up" "MOBILE_PUSH_SIMULATE=true PBX_SIMULATE=true VOICE_SIMULATE=true docker compose -f docker-compose.app.yml up -d api worker >/dev/null"

for _ in $(seq 1 40); do
  if curl -fsS "$BASE_URL/health" >/dev/null; then break; fi
  sleep 2
done
curl -fsS "$BASE_URL/health" >/dev/null || fail "api not healthy"

"$REPO_ROOT/scripts/check-migrations.sh" || fail "migration check failed"

signup_payload="$(jq -nc --arg tn "$TENANT_NAME" --arg em "$EMAIL" --arg pw "$PASSWORD" '{tenantName:$tn,email:$em,password:$pw}')"
signup_json="$(api POST /auth/signup "" "$signup_payload")"
echo "$signup_json" | jq -e . >/dev/null || fail "invalid signup response"

POSTGRES_USER="$(grep -E '^POSTGRES_USER=' "$INFRA_ENV" | head -n1 | cut -d= -f2-)"
POSTGRES_DB="$(grep -E '^POSTGRES_DB=' "$INFRA_ENV" | head -n1 | cut -d= -f2-)"
PG_CONTAINER="$(docker ps --format '{{.Names}}' | grep -m1 postgres || true)"
[[ -n "$PG_CONTAINER" ]] || fail "postgres not found"

docker exec -i "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE \"User\" SET role='SUPER_ADMIN' WHERE email='${EMAIL}';" >/dev/null

login_payload="$(jq -nc --arg em "$EMAIL" --arg pw "$PASSWORD" '{email:$em,password:$pw}')"
login_json="$(api POST /auth/login "" "$login_payload")"
TOKEN="$(echo "$login_json" | jq -r '.token // empty')"
[[ -n "$TOKEN" ]] || fail "login missing token"

reg_a="$(api POST /mobile/devices/register "$TOKEN" "$(jq -nc --arg tok "$FAKE_TOKEN_A" '{platform:"IOS",expoPushToken:$tok,deviceName:"smoke-device-a"}')")"
reg_b="$(api POST /mobile/devices/register "$TOKEN" "$(jq -nc --arg tok "$FAKE_TOKEN_B" '{platform:"ANDROID",expoPushToken:$tok,deviceName:"smoke-device-b"}')")"
DEVICE_A="$(echo "$reg_a" | jq -r '.id // empty')"
DEVICE_B="$(echo "$reg_b" | jq -r '.id // empty')"
[[ -n "$DEVICE_A" && -n "$DEVICE_B" ]] || fail "device registration missing ids"

me_json="$(api GET /me "$TOKEN")"
USER_ID="$(echo "$me_json" | jq -r '.id // empty')"
[[ -n "$USER_ID" ]] || fail "missing /me id"

invite_payload="$(jq -nc --arg uid "$USER_ID" '{userId:$uid,fromNumber:"+13055550111",toExtension:"1001"}')"
invite_json="$(api POST /mobile/call-invites/test "$TOKEN" "$invite_payload")"
INVITE_ID="$(echo "$invite_json" | jq -r '.inviteId // empty')"
[[ -n "$INVITE_ID" ]] || fail "invite create failed"

first_accept="$(api POST /mobile/call-invites/${INVITE_ID}/respond "$TOKEN" '{"action":"ACCEPT"}' "x-mobile-device-id: ${DEVICE_A}")"
echo "$first_accept" | jq -e '.ok == true and .code == "INVITE_CLAIMED_OK" and .status == "ACCEPTED"' >/dev/null || fail "first accept failed: $first_accept"

second_accept="$(api POST /mobile/call-invites/${INVITE_ID}/respond "$TOKEN" '{"action":"ACCEPT"}' "x-mobile-device-id: ${DEVICE_B}")"
echo "$second_accept" | jq -e '.ok == false and .code == "INVITE_ALREADY_HANDLED" and .status == "ACCEPTED"' >/dev/null || fail "second accept race handling failed: $second_accept"

late_decline="$(api POST /mobile/call-invites/${INVITE_ID}/respond "$TOKEN" '{"action":"DECLINE"}' "x-mobile-device-id: ${DEVICE_B}")"
echo "$late_decline" | jq -e '.ok == false and .code == "INVITE_ALREADY_HANDLED" and .status == "ACCEPTED"' >/dev/null || fail "decline-after-accepted race handling failed: $late_decline"

sql="SELECT status, \"acceptedByDeviceId\", \"acceptedAt\", \"declinedAt\" FROM \"CallInvite\" WHERE id='${INVITE_ID}';"
row="$(docker exec -i "$PG_CONTAINER" psql -t -A -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$sql")"
[[ "$row" == ACCEPTED* ]] || fail "invite not in ACCEPTED state: $row"
[[ "$row" == *"${DEVICE_A}"* ]] || fail "acceptedByDeviceId mismatch: $row"

log "PASS: first-answer-wins + race handling works"
