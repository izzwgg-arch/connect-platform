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
EMAIL="smokesms${NOW}@connectcomunications.com"
fail(){ echo "[smoke-sms] FAIL: $*" >&2; exit 1; }
api(){ local method="$1" path="$2" token="${3:-}" body="${4:-}"; local h=(); [[ -n "$token" ]] && h+=(-H "Authorization: Bearer $token"); [[ -n "$body" ]] && h+=(-H "content-type: application/json"); curl -sS -X "$method" "$BASE_URL$path" "${h[@]}" ${body:+-d "$body"}; }
signup="$(api POST /auth/signup "" "{\"tenantName\":\"Smoke SMS ${NOW}\",\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}")"
token="$(echo "$signup" | jq -r '.token // empty')"; [[ -n "$token" ]] || fail "token"
draft="$(api POST /sms/campaigns "$token" '{"name":"Smoke Campaign","message":"hello","recipients":["+15555550101"],"fromNumber":"+15555550100"}')"
cid="$(echo "$draft" | jq -r '.id // empty')"; [[ -n "$cid" ]] || fail "campaign id"
preview="$(api POST "/sms/campaigns/${cid}/preview" "$token")"
echo "$preview" | jq -e '.recipientSummary != null' >/dev/null || fail "preview summary"
send="$(api POST "/sms/campaigns/${cid}/send" "$token")"
echo "$send" | jq -e '.ok == true or .error != null' >/dev/null || fail "send shape"
echo "[smoke-sms] PASS"
