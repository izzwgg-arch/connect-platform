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
EMAIL="smokeemail${NOW}@connectcomunications.com"
fail(){ echo "[smoke-email] FAIL: $*" >&2; exit 1; }
api(){ local method="$1" path="$2" token="${3:-}" body="${4:-}"; local h=(); [[ -n "$token" ]] && h+=(-H "Authorization: Bearer $token"); [[ -n "$body" ]] && h+=(-H "content-type: application/json"); curl -sS -X "$method" "$BASE_URL$path" "${h[@]}" ${body:+-d "$body"}; }
signup="$(api POST /auth/signup "" "{\"tenantName\":\"Smoke Email ${NOW}\",\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}")"
token="$(echo "$signup" | jq -r '.token // empty')"; [[ -n "$token" ]] || fail "token"
cfg="$(api PUT /settings/email "$token" '{"providerType":"GOOGLE_WORKSPACE","fromName":"Smoke","fromEmail":"noreply@example.com","replyTo":"ops@example.com","simulate":true,"credentials":{"smtpUser":"u","smtpPass":"p","smtpHost":"smtp-relay.gmail.com","smtpPort":587}}')"
echo "$cfg" | jq -e '.configured == true' >/dev/null || fail "email config"
test="$(api POST /settings/email/test "$token" '{"to":"qa@example.com"}')"
echo "$test" | jq -e '.ok == true or .error != null' >/dev/null || fail "test shape"
echo "[smoke-email] PASS"
