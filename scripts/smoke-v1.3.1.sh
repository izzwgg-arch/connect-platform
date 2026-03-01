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
TENANT_NAME="Mobile Invite Smoke ${NOW}"
FAKE_TOKEN="ExponentPushToken[smoke-${NOW}]"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_ENV="/opt/connectcomms/infra/.env"

log(){ echo "[v1.3.1] $*"; }
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
  local method="$1" path="$2" token="${3:-}" body="${4:-}"
  local auth=()
  if [[ -n "$token" ]]; then auth=(-H "Authorization: Bearer $token"); fi
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" "$BASE_URL$path" -H "content-type: application/json" "${auth[@]}" -d "$body"
  else
    curl -sS -X "$method" "$BASE_URL$path" -H "content-type: application/json" "${auth[@]}"
  fi
}

log "starting mobile push + invite smoke"
cd "$REPO_ROOT"
run_compose "smoke-v1.3.1.sh:compose-up" "MOBILE_PUSH_SIMULATE=true PBX_SIMULATE=true VOICE_SIMULATE=true docker compose -f docker-compose.app.yml up -d api worker >/dev/null"

for _ in $(seq 1 40); do
  if curl -fsS "$BASE_URL/health" >/dev/null; then break; fi
  sleep 2
done
curl -fsS "$BASE_URL/health" >/dev/null || fail "api not healthy"

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

reg_payload="$(jq -nc --arg tok "$FAKE_TOKEN" '{platform:"IOS",expoPushToken:$tok,deviceName:"smoke-device"}')"
reg_json="$(api POST /mobile/devices/register "$TOKEN" "$reg_payload")"
echo "$reg_json" | jq -e '.ok == true' >/dev/null || fail "device register failed: $reg_json"

me_json="$(api GET /me "$TOKEN")"
USER_ID="$(echo "$me_json" | jq -r '.id // empty')"
[[ -n "$USER_ID" ]] || fail "missing /me id"

invite_payload="$(jq -nc --arg uid "$USER_ID" '{userId:$uid,fromNumber:"+13055550111",toExtension:"1001"}')"
invite_json="$(api POST /mobile/call-invites/test "$TOKEN" "$invite_payload")"
echo "$invite_json" | jq -e '.ok == true and .inviteId and (.push.simulated == true)' >/dev/null || fail "invite test failed: $invite_json"
INVITE_ID="$(echo "$invite_json" | jq -r '.inviteId')"

pending_json="$(api GET /mobile/call-invites/pending "$TOKEN")"
echo "$pending_json" | jq -e --arg id "$INVITE_ID" 'map(select(.id==$id)) | length >= 1' >/dev/null || fail "pending invite not found"

resp_json="$(api POST /mobile/call-invites/${INVITE_ID}/respond "$TOKEN" '{"action":"DECLINED"}')"
echo "$resp_json" | jq -e '.ok == true and .status == "DECLINED"' >/dev/null || fail "invite decline failed"

unreg_payload="$(jq -nc --arg tok "$FAKE_TOKEN" '{expoPushToken:$tok}')"
unreg_json="$(api POST /mobile/devices/unregister "$TOKEN" "$unreg_payload")"
echo "$unreg_json" | jq -e '.ok == true and .removed >= 1' >/dev/null || fail "device unregister failed"

log "PASS: device register + invite test + simulated push + invite response"
