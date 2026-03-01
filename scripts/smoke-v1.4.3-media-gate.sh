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
EMAIL="mediagate${NOW}@connectcomunications.com"
TENANT_NAME="Media Gate Smoke ${NOW}"
INFRA_ENV="${INFRA_ENV:-/opt/connectcomms/infra/.env}"

log(){ echo "[v1.4.3] $*"; }
fail(){ echo "[v1.4.3] FAIL: $*" >&2; exit 1; }

api(){
  local method="$1" path="$2" token="${3:-}" body="${4:-}"
  local headers=(-H "content-type: application/json")
  if [[ -n "$token" ]]; then headers+=(-H "Authorization: Bearer $token"); fi
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" "$BASE_URL$path" "${headers[@]}" -d "$body"
  else
    curl -sS -X "$method" "$BASE_URL$path" "${headers[@]}"
  fi
}

log "starting media gate smoke"

signup_payload="$(jq -nc --arg tn "$TENANT_NAME" --arg em "$EMAIL" --arg pw "$PASSWORD" '{tenantName:$tn,email:$em,password:$pw}')"
signup_json="$(api POST /auth/signup "" "$signup_payload")"
echo "$signup_json" | jq -e . >/dev/null || fail "invalid signup response"

POSTGRES_USER="$(grep -E '^POSTGRES_USER=' "$INFRA_ENV" | head -n1 | cut -d= -f2-)"
POSTGRES_DB="$(grep -E '^POSTGRES_DB=' "$INFRA_ENV" | head -n1 | cut -d= -f2-)"
PG_CONTAINER="$(docker ps --format '{{.Names}}' | grep -m1 postgres || true)"
[[ -n "$PG_CONTAINER" ]] || fail "postgres container not found"

docker exec -i "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE \"User\" SET role='SUPER_ADMIN' WHERE email='${EMAIL}';" >/dev/null

login_payload="$(jq -nc --arg em "$EMAIL" --arg pw "$PASSWORD" '{email:$em,password:$pw}')"
login_json="$(api POST /auth/login "" "$login_payload")"
TOKEN="$(echo "$login_json" | jq -r '.token // empty')"
[[ -n "$TOKEN" ]] || fail "login missing token"

log "enable media gate"
enable_json="$(api PUT /voice/media-test/status "$TOKEN" '{"mediaReliabilityGateEnabled":true}')"
echo "$enable_json" | jq -e '.ok == true and .mediaReliabilityGateEnabled == true' >/dev/null || fail "failed to enable media gate"

log "start media test run"
start_json="$(api POST /voice/media-test/start "$TOKEN" '{"platform":"WEB"}')"
RUN_TOKEN="$(echo "$start_json" | jq -r '.token // empty')"
[[ -n "$RUN_TOKEN" ]] || fail "media-test/start missing token"

log "report media test pass (simulated deterministic payload)"
report_payload="$(jq -nc --arg t "$RUN_TOKEN" '{token:$t,hasRelay:true,iceSelectedPairType:"relay",wsOk:true,sipRegisterOk:true,rtpCandidatePresent:true,durationMs:123,platform:"WEB"}')"
report_json="$(api POST /voice/media-test/report "$TOKEN" "$report_payload")"
echo "$report_json" | jq -e '.ok == true and (.status == "PASSED")' >/dev/null || fail "media-test/report did not return PASSED"

status_json="$(api GET /voice/media-test/status "$TOKEN")"
echo "$status_json" | jq -e '.ok == true and .mediaTestStatus == "PASSED" and .mediaReliabilityGateEnabled == true' >/dev/null || fail "media status not PASSED after report"

log "simulate stale transition by aging mediaTestedAt"
docker exec -i "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE \"Tenant\" SET \"mediaTestStatus\"='PASSED', \"mediaTestedAt\"=NOW() - INTERVAL '8 days' WHERE id=(SELECT id FROM \"Tenant\" WHERE name='${TENANT_NAME}' LIMIT 1);" >/dev/null

log "waiting for worker maintenance cycle to mark STALE (up to 7 minutes)"
max_wait=420
elapsed=0
while (( elapsed < max_wait )); do
  s="$(api GET /voice/media-test/status "$TOKEN")"
  current="$(echo "$s" | jq -r '.mediaTestStatus // "UNKNOWN"')"
  if [[ "$current" == "STALE" ]]; then
    log "STALE transition observed"
    break
  fi
  sleep 10
  elapsed=$((elapsed + 10))
done

final_status="$(api GET /voice/media-test/status "$TOKEN")"
echo "$final_status" | jq -e '.ok == true and .mediaTestStatus == "STALE"' >/dev/null || fail "media status did not transition to STALE"

log "PASS: media gate toggle, media test pass report, and stale transition verified"
