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
EMAIL="sbcremote${NOW}@connectcomunications.com"
TENANT_NAME="SBC Remote Smoke ${NOW}"
SBC_REMOTE_WSS_URL="${SBC_REMOTE_WSS_URL:-}"

log(){ echo "[v1.4.12] $*"; }
fail(){ echo "[v1.4.12] FAIL: $*" >&2; exit 1; }

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

log "run migration consistency check"
./scripts/check-migrations.sh

log "check local API health"
health_json="$(curl -sS "$LOCAL_API/health")"
echo "$health_json" | jq -e '.ok == true' >/dev/null || fail "local API health failed"

signup_payload="$(jq -nc --arg tn "$TENANT_NAME" --arg em "$EMAIL" --arg pw "$PASSWORD" '{tenantName:$tn,email:$em,password:$pw}')"
signup_json="$(api POST /auth/signup "" "$signup_payload")"
echo "$signup_json" | jq -e . >/dev/null || fail "invalid signup response"

INFRA_ENV="${INFRA_ENV:-/opt/connectcomms/infra/.env}"
POSTGRES_USER="$(awk -F= '/^POSTGRES_USER=/{print $2; exit}' "$INFRA_ENV")"
POSTGRES_DB="$(awk -F= '/^POSTGRES_DB=/{print $2; exit}' "$INFRA_ENV")"
PG_CONTAINER="$(docker ps --format '{{.Names}}' | awk '/postgres/{print; exit}')"
[[ -n "$PG_CONTAINER" ]] || fail "postgres container not found"

docker exec -i "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE \"User\" SET role='SUPER_ADMIN' WHERE email='${EMAIL}';" >/dev/null

login_payload="$(jq -nc --arg em "$EMAIL" --arg pw "$PASSWORD" '{email:$em,password:$pw}')"
login_json="$(api POST /auth/login "" "$login_payload")"
TOKEN="$(echo "$login_json" | jq -r '.token // empty')"
[[ -n "$TOKEN" ]] || fail "login missing token"

log "check /admin/sbc/config"
config_json="$(api GET /admin/sbc/config "$TOKEN")"
echo "$config_json" | jq -e '.ok == true and .config.mode' >/dev/null || fail "config endpoint missing expected payload"

if [[ -z "$SBC_REMOTE_WSS_URL" ]]; then
  log "SKIP: SBC_REMOTE_WSS_URL not set; remote probe path skipped"
  exit 0
fi

parsed="$(python3 - <<'PY'
import os
from urllib.parse import urlparse
raw = os.environ.get('SBC_REMOTE_WSS_URL', '').strip()
u = urlparse(raw)
if u.scheme not in ('wss', 'https') or not u.hostname:
    print('INVALID')
else:
    print(f"{u.hostname}|{u.port or 7443}")
PY
)"
[[ "$parsed" != "INVALID" ]] || fail "SBC_REMOTE_WSS_URL must be wss://host[:port] or https://host[:port]"
REMOTE_HOST="${parsed%%|*}"
REMOTE_PORT="${parsed##*|}"

log "switch to REMOTE mode"
set_remote_payload="$(jq -nc --arg h "$REMOTE_HOST" --argjson p "$REMOTE_PORT" '{mode:"REMOTE",remoteUpstreamHost:$h,remoteUpstreamPort:$p}')"
set_remote_json="$(api PUT /admin/sbc/config "$TOKEN" "$set_remote_payload")"
echo "$set_remote_json" | jq -e '.ok == true and .config.mode == "REMOTE"' >/dev/null || fail "unable to set REMOTE mode"

log "readiness remote probe"
readiness_json="$(api GET /admin/sbc/readiness "$TOKEN")"
echo "$readiness_json" | jq -e '.ok == true and (.readiness.services.lastProbeAt != null) and (.readiness.services.remoteWsOk != false)' >/dev/null || fail "remote readiness failed"

log "switch back to LOCAL mode"
set_local_json="$(api PUT /admin/sbc/config "$TOKEN" '{"mode":"LOCAL","remoteUpstreamPort":7443}')"
echo "$set_local_json" | jq -e '.ok == true and .config.mode == "LOCAL"' >/dev/null || fail "unable to return to LOCAL mode"

log "PASS: quick checks passed; remote path validated"
