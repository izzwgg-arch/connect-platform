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
PORTAL_URL="${PORTAL_URL:-https://app.connectcomunications.com}"
PASSWORD="${PASSWORD:-Passw0rd!234}"
NOW="$(date +%s)"
EMAIL="sbcswitch${NOW}@connectcomunications.com"
TENANT_NAME="SBC Switch Smoke ${NOW}"

log(){ echo "[v1.4.6] $*"; }
fail(){ echo "[v1.4.6] FAIL: $*" >&2; exit 1; }

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

log "starting SBC switchable upstream smoke"

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

log "GET /admin/sbc/config"
config_json="$(api GET /admin/sbc/config "$TOKEN")"
echo "$config_json" | jq -e '.ok == true and .config.mode and .activeUpstream' >/dev/null || fail "config endpoint missing expected payload"

log "PUT /admin/sbc/config LOCAL idempotent"
set_local_json="$(api PUT /admin/sbc/config "$TOKEN" '{"mode":"LOCAL","remoteUpstreamPort":7443}')"
echo "$set_local_json" | jq -e '.ok == true and .config.mode == "LOCAL"' >/dev/null || fail "unable to set LOCAL mode"

log "verify /sip route responds to websocket probe"
ws_resp="$(curl -ksS -i -N -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Host: app.connectcomunications.com' -H 'Origin: https://app.connectcomunications.com' -H 'Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==' -H 'Sec-WebSocket-Version: 13' https://app.connectcomunications.com/sip || true)"
echo "$ws_resp" | grep -Eiq '101|websocket|Sec-WebSocket' || fail "websocket probe did not show expected handshake indicators"

log "REMOTE mode apply test skipped (no deterministic remote SBC host available in smoke environment)"

log "check portal admin SBC config route"
code="$(curl -ksS -o /tmp/v146_sbc_config_page.html -w '%{http_code}' "$PORTAL_URL/dashboard/admin/sbc/config")"
[[ "$code" == "200" ]] || fail "portal SBC config route not reachable (HTTP $code)"

log "PASS: config endpoints, LOCAL apply, /sip probe, and portal route verified"
