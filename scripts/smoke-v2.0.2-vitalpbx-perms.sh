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

BASE_URL="${BASE_URL:-http://127.0.0.1:3001}"
PASSWORD="${PASSWORD:-Passw0rd!234}"
NOW="$(date +%s)"
EMAIL="vpbx-perm-${NOW}@connectcomunications.com"
TENANT_NAME="VPBX Perm ${NOW}"

fail(){ echo "[v2.0.2-vitalpbx-perms] FAIL: $*" >&2; exit 1; }
api(){
  local method="$1" path="$2" token="${3:-}" body="${4:-}"
  local headers=()
  if [[ -n "$token" ]]; then headers+=(-H "Authorization: Bearer $token"); fi
  if [[ -n "$body" ]]; then
    headers+=(-H "content-type: application/json")
    curl -sS -X "$method" "$BASE_URL$path" "${headers[@]}" -d "$body"
  else
    curl -sS -X "$method" "$BASE_URL$path" "${headers[@]}"
  fi
}

signup_payload="$(jq -nc --arg tn "$TENANT_NAME" --arg em "$EMAIL" --arg pw "$PASSWORD" '{tenantName:$tn,email:$em,password:$pw}')"
signup_json="$(api POST /auth/signup "" "$signup_payload")"
echo "$signup_json" | jq -e . >/dev/null || fail "invalid signup response"

PG_CONTAINER="$(docker ps --format '{{.Names}}' | awk '/postgres/{print; exit}')"
[[ -n "$PG_CONTAINER" ]] || fail "postgres container not found"

set_role() {
  local role="$1"
  docker exec -i "$PG_CONTAINER" psql -U connectcomms -d connectcomms -c "UPDATE \"User\" SET role='${role}' WHERE email='${EMAIL}';" >/dev/null
}

login_payload="$(jq -nc --arg em "$EMAIL" --arg pw "$PASSWORD" '{email:$em,password:$pw}')"

# READ_ONLY must be denied mutation
set_role "READ_ONLY"
ro_login="$(api POST /auth/login "" "$login_payload")"
RO_TOKEN="$(echo "$ro_login" | jq -r '.token // empty')"
[[ -n "$RO_TOKEN" ]] || fail "read-only login failed"
ro_resp="$(api POST /voice/pbx/resources/queues "$RO_TOKEN" '{"payload":{"extension":"7000","description":"x"}}')"
echo "$ro_resp" | jq -e '.error == "forbidden"' >/dev/null || fail "read-only mutation should be forbidden"

# MESSAGING can create queue action (may still fail for link/config), but must not be forbidden
set_role "MESSAGING"
msg_login="$(api POST /auth/login "" "$login_payload")"
MSG_TOKEN="$(echo "$msg_login" | jq -r '.token // empty')"
[[ -n "$MSG_TOKEN" ]] || fail "messaging login failed"
msg_resp="$(api POST /voice/pbx/resources/queues "$MSG_TOKEN" '{"payload":{"extension":"7001","description":"x"}}')"
if echo "$msg_resp" | jq -e '.error == "forbidden"' >/dev/null; then
  fail "messaging queue create should not be forbidden"
fi

# BILLING cannot create queue action
set_role "BILLING"
bill_login="$(api POST /auth/login "" "$login_payload")"
BILL_TOKEN="$(echo "$bill_login" | jq -r '.token // empty')"
[[ -n "$BILL_TOKEN" ]] || fail "billing login failed"
bill_resp="$(api POST /voice/pbx/resources/queues "$BILL_TOKEN" '{"payload":{"extension":"7002","description":"x"}}')"
echo "$bill_resp" | jq -e '.error == "forbidden"' >/dev/null || fail "billing queue create should be forbidden"

echo "[v2.0.2-vitalpbx-perms] PASS: vitalpbx permission gates validated"
