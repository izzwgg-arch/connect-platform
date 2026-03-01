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
EMAIL="turn${NOW}@connectcomunications.com"
TENANT_NAME="TURN Reliability Smoke ${NOW}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_ENV="/opt/connectcomms/infra/.env"

log(){ echo "[v1.3.7] $*"; }
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
  local auth=() extra=()
  if [[ -n "$token" ]]; then auth=(-H "Authorization: Bearer $token"); fi
  if [[ -n "$header" ]]; then extra=(-H "$header"); fi
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" "$BASE_URL$path" -H "content-type: application/json" "${auth[@]}" "${extra[@]}" -d "$body"
  else
    curl -sS -X "$method" "$BASE_URL$path" -H "content-type: application/json" "${auth[@]}" "${extra[@]}"
  fi
}

log "starting TURN reliability smoke"
cd "$REPO_ROOT"
run_compose "smoke-v1.3.7.sh:compose-up" "MOBILE_PUSH_SIMULATE=true PBX_SIMULATE=true VOICE_SIMULATE=true docker compose -f docker-compose.app.yml up -d api worker >/dev/null"

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

me_json="$(api GET /me "$TOKEN")"
USER_ID="$(echo "$me_json" | jq -r '.id // empty')"
TENANT_ID="$(echo "$me_json" | jq -r '.tenantId // empty')"
[[ -n "$USER_ID" && -n "$TENANT_ID" ]] || fail "missing /me id or tenantId"

turn_put="$(api PUT /voice/turn "$TOKEN" '{"urls":["turn:turn.example.com:3478"],"username":"turn-user","credential":"turn-pass","turnRequiredForMobile":false}')"
echo "$turn_put" | jq -e '.ok == true' >/dev/null || fail "turn config update failed: $turn_put"

val_start="$(api POST /voice/turn/validate "$TOKEN" '{}')"
VAL_TOKEN="$(echo "$val_start" | jq -r '.token // empty')"
[[ -n "$VAL_TOKEN" ]] || fail "missing validation token: $val_start"
val_report="$(api POST /voice/turn/validate/report "$TOKEN" "$(jq -nc --arg t "$VAL_TOKEN" '{token:$t,hasRelay:true,durationMs:120,platform:"WEB"}')")"
echo "$val_report" | jq -e '.ok == true and .status == "VERIFIED"' >/dev/null || fail "validation report failed: $val_report"

turn_state="$(api GET /voice/turn "$TOKEN")"
echo "$turn_state" | jq -e '.status == "VERIFIED"' >/dev/null || fail "tenant not VERIFIED after relay=true"

turn_require="$(api PUT /voice/turn "$TOKEN" '{"turnRequiredForMobile":true}')"
echo "$turn_require" | jq -e '.ok == true and .turnRequiredForMobile == true' >/dev/null || fail "failed to enable turnRequiredForMobile"

docker exec -i "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE \"Tenant\" SET \"turnValidationStatus\"='FAILED', \"turnValidatedAt\"=NULL, \"turnLastErrorCode\"='SMOKE_FORCE_FAILED', \"turnLastErrorAt\"=NOW() WHERE id='${TENANT_ID}';" >/dev/null

invite_fail_json="$(api POST /mobile/call-invites/test "$TOKEN" "$(jq -nc --arg uid "$USER_ID" '{userId:$uid,fromNumber:"+13055550111",toExtension:"1001"}')")"
INVITE_FAIL_ID="$(echo "$invite_fail_json" | jq -r '.inviteId // empty')"
[[ -n "$INVITE_FAIL_ID" ]] || fail "invite creation failed for block test"

accept_block="$(api POST /mobile/call-invites/${INVITE_FAIL_ID}/respond "$TOKEN" '{"action":"ACCEPT"}')"
echo "$accept_block" | jq -e '.ok == false and .code == "TURN_REQUIRED_NOT_VERIFIED"' >/dev/null || fail "accept should be blocked: $accept_block"

val2_start="$(api POST /voice/turn/validate "$TOKEN" '{}')"
VAL2_TOKEN="$(echo "$val2_start" | jq -r '.token // empty')"
[[ -n "$VAL2_TOKEN" ]] || fail "missing second validation token"
val2_report="$(api POST /voice/turn/validate/report "$TOKEN" "$(jq -nc --arg t "$VAL2_TOKEN" '{token:$t,hasRelay:true,durationMs:95,platform:"WEB"}')")"
echo "$val2_report" | jq -e '.ok == true and .status == "VERIFIED"' >/dev/null || fail "second validation report failed"

invite_ok_json="$(api POST /mobile/call-invites/test "$TOKEN" "$(jq -nc --arg uid "$USER_ID" '{userId:$uid,fromNumber:"+13055550112",toExtension:"1002"}')")"
INVITE_OK_ID="$(echo "$invite_ok_json" | jq -r '.inviteId // empty')"
[[ -n "$INVITE_OK_ID" ]] || fail "invite creation failed for verified test"

accept_ok="$(api POST /mobile/call-invites/${INVITE_OK_ID}/respond "$TOKEN" '{"action":"ACCEPT"}')"
echo "$accept_ok" | jq -e '.ok == true and .code == "INVITE_CLAIMED_OK" and .status == "ACCEPTED"' >/dev/null || fail "accept should succeed when VERIFIED: $accept_ok"

log "PASS: TURN config + validation + mobile reliability enforcement works"
