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

log(){ echo "[smoke:fast] $*"; }
fail(){ echo "[smoke:fast] FAIL: $*" >&2; exit 1; }

log "running migration consistency check"
./scripts/check-migrations.sh

log "health checks"
curl -fsS "${LOCAL_API}/health" >/dev/null || fail "local API health failed"
curl -kfsS "${BASE_URL}/health" >/dev/null || fail "public API health failed"

log "minimal API route probes"
code_login="$(curl -ksS -o /tmp/smoke_fast_login.json -w '%{http_code}' -X POST "${BASE_URL}/auth/login" -H 'content-type: application/json' -d '{"email":"nobody@example.com","password":"wrong-pass"}' )"
[[ "$code_login" == "400" || "$code_login" == "401" || "$code_login" == "422" ]] || fail "unexpected /auth/login status ${code_login}"

code_sbc="$(curl -ksS -o /tmp/smoke_fast_sbc_status.json -w '%{http_code}' "${BASE_URL}/voice/sbc/status" )"
[[ "$code_sbc" == "200" || "$code_sbc" == "401" || "$code_sbc" == "403" ]] || fail "unexpected /voice/sbc/status status ${code_sbc}"

code_admin_cfg="$(curl -ksS -o /tmp/smoke_fast_admin_sbc_config.json -w '%{http_code}' "${BASE_URL}/admin/sbc/config" )"
[[ "$code_admin_cfg" == "200" || "$code_admin_cfg" == "401" || "$code_admin_cfg" == "403" ]] || fail "unexpected /admin/sbc/config status ${code_admin_cfg}"

log "PASS: fast smoke checks completed"
