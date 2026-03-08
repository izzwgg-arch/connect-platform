#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR_LOCAL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_QUIET_SH="${SCRIPT_DIR_LOCAL}/ops/run-quiet.sh"
SCRIPT_BASENAME="$(basename "$0" .sh)"
LOG_DIR="${OPS_LOG_DIR:-/opt/connectcomms/ops/logs}"
LOG_TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_FILE_DEFAULT="${LOG_DIR}/${SCRIPT_BASENAME}-${LOG_TIMESTAMP}.log"
if [[ "${_QUIET_WRAPPED:-0}" != "1" ]]; then
  mkdir -p "$LOG_DIR"; LOG_FILE="${LOG_FILE:-$LOG_FILE_DEFAULT}"; export LOG_FILE
  exec "$RUN_QUIET_SH" "$SCRIPT_BASENAME" -- env _QUIET_WRAPPED=1 LOG_FILE="$LOG_FILE" bash "$0" "$@"
fi
BASE_URL="${BASE_URL:-https://app.connectcomunications.com/api}"
PASSWORD="${PASSWORD:-Passw0rd!234}"
NOW="$(date +%s)"
EMAIL="smokeivr${NOW}@connectcomunications.com"
fail(){ echo "[smoke-ivr-schedule] FAIL: $*" >&2; exit 1; }
api(){ local method="$1" path="$2" token="${3:-}" body="${4:-}"; local h=(); [[ -n "$token" ]] && h+=(-H "Authorization: Bearer $token"); [[ -n "$body" ]] && h+=(-H "content-type: application/json"); curl -sS -X "$method" "$BASE_URL$path" "${h[@]}" ${body:+-d "$body"}; }
signup="$(api POST /auth/signup "" "{\"tenantName\":\"Smoke IVR ${NOW}\",\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}")"
token="$(echo "$signup" | jq -r '.token // empty')"; [[ -n "$token" ]] || fail "token"
created="$(api POST /voice/ivr/schedules "$token" '{"ivrId":"ivr-main","recordingId":"rec-business","startTime":"2030-01-01T09:00:00Z","endTime":"2030-01-01T18:00:00Z","timezone":"UTC","enabled":true}')"
echo "$created" | jq -e '.schedule.id != null or .error != null' >/dev/null || fail "create schedule shape"
list="$(api GET /voice/ivr/schedules "$token")"
echo "$list" | jq -e '.rows != null or .error != null' >/dev/null || fail "list schedules shape"
echo "[smoke-ivr-schedule] PASS"
