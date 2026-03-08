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
EMAIL="smokecrm${NOW}@connectcomunications.com"
fail(){ echo "[smoke-crm] FAIL: $*" >&2; exit 1; }
api(){ local method="$1" path="$2" token="${3:-}" body="${4:-}"; local h=(); [[ -n "$token" ]] && h+=(-H "Authorization: Bearer $token"); [[ -n "$body" ]] && h+=(-H "content-type: application/json"); curl -sS -X "$method" "$BASE_URL$path" "${h[@]}" ${body:+-d "$body"}; }
signup="$(api POST /auth/signup "" "{\"tenantName\":\"Smoke CRM ${NOW}\",\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}")"
token="$(echo "$signup" | jq -r '.token // empty')"; [[ -n "$token" ]] || fail "token"
customer="$(api POST /customers "$token" "{\"displayName\":\"Smoke CRM ${NOW}\",\"primaryEmail\":\"${EMAIL}\",\"primaryPhone\":\"+1555555${NOW: -4}\"}")"
cid="$(echo "$customer" | jq -r '.id // empty')"; [[ -n "$cid" ]] || fail "customer id"
task="$(api POST "/customers/${cid}/tasks" "$token" '{"title":"Follow-up"}')"
echo "$task" | jq -e '.task.id != null' >/dev/null || fail "task create"
activity="$(api GET "/customers/${cid}/activity" "$token")"
echo "$activity" | jq -e '.timeline != null' >/dev/null || fail "activity"
rules="$(api POST /automation/rules "$token" '{"name":"Tag new customer","triggerType":"NEW_CUSTOMER","actionType":"TAG_CUSTOMER","actionPayload":{"tag":"new"}}')"
echo "$rules" | jq -e '.rule.id != null' >/dev/null || fail "rule create"
echo "[smoke-crm] PASS"
