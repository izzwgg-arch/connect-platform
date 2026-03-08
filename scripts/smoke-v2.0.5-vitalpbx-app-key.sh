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
EMAIL="vpbx-header-${NOW}@connectcomunications.com"
TENANT_NAME="VPBX Header ${NOW}"
PBX_TOKEN="APPKEY_SMOKE_${NOW}"
PORT="${VITALPBX_SMOKE_PORT:-18081}"
TMP_DIR="$(mktemp -d)"
HEADERS_FILE="${TMP_DIR}/headers.txt"

fail(){ echo "[v2.0.5-vitalpbx-app-key] FAIL: $*" >&2; exit 1; }
cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

api() {
  local method="$1" path="$2" token="${3:-}" body="${4:-}"
  local headers=()
  if [[ -n "$token" ]]; then headers+=(-H "authorization: Bearer $token"); fi
  if [[ -n "$body" ]]; then
    headers+=(-H "content-type: application/json")
    curl -sS -X "$method" "$BASE_URL$path" "${headers[@]}" --data-binary "$body"
  else
    curl -sS -X "$method" "$BASE_URL$path" "${headers[@]}"
  fi
}

python3 - "$PORT" "$HEADERS_FILE" <<'PY' &
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

port = int(sys.argv[1])
headers_file = sys.argv[2]

class H(BaseHTTPRequestHandler):
    def _log_headers(self):
        with open(headers_file, "a", encoding="utf-8") as fh:
            for k, v in self.headers.items():
                fh.write(f"{k.lower()}: {v}\n")

    def do_GET(self):
        self._log_headers()
        if self.path.startswith("/api/v2/tenants"):
            body = json.dumps({"status": "success", "data": [{"id": 1, "name": "Tenant"}]}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, format, *args):
        return

HTTPServer(("0.0.0.0", port), H).serve_forever()
PY
SERVER_PID=$!
sleep 1

signup_payload="$(jq -nc --arg tn "$TENANT_NAME" --arg em "$EMAIL" --arg pw "$PASSWORD" '{tenantName:$tn,email:$em,password:$pw}')"
signup_json="$(api POST /auth/signup "" "$signup_payload")"
echo "$signup_json" | jq -e . >/dev/null || fail "invalid signup response"

docker exec -i connectcomms-postgres psql -U connectcomms -d connectcomms -c "UPDATE \"User\" SET role='SUPER_ADMIN' WHERE email='${EMAIL}';" >/dev/null

login_payload="$(jq -nc --arg em "$EMAIL" --arg pw "$PASSWORD" '{email:$em,password:$pw}')"
login_json="$(api POST /auth/login "" "$login_payload")"
ADMIN_TOKEN="$(echo "$login_json" | jq -r '.token // empty')"
[[ -n "$ADMIN_TOKEN" ]] || fail "admin login failed"

GATEWAY_IP="$(docker exec app-api-1 sh -lc "ip route | sed -n 's/^default via \\([^ ]*\\).*/\\1/p' | head -n1")"
[[ -n "$GATEWAY_IP" ]] || fail "could not resolve API container gateway IP"

create_payload="$(jq -nc --arg name "Header Smoke ${NOW}" --arg url "http://${GATEWAY_IP}:${PORT}" --arg token "$PBX_TOKEN" '{name:$name,baseUrl:$url,token:$token,isEnabled:true}')"
created="$(api POST /admin/pbx/instances "$ADMIN_TOKEN" "$create_payload")"
INSTANCE_ID="$(echo "$created" | jq -r '.id // empty')"
[[ -n "$INSTANCE_ID" ]] || fail "instance create failed"

test_resp="$(api POST "/admin/pbx/instances/${INSTANCE_ID}/test" "$ADMIN_TOKEN")"
echo "$test_resp" | jq -e '.ok == true' >/dev/null || fail "test endpoint failed: $test_resp"

[[ -s "$HEADERS_FILE" ]] || fail "no headers captured"
grep -qi '^app-key: '"$PBX_TOKEN"'$' "$HEADERS_FILE" || fail "app-key header not sent"
if grep -qi '^authorization:' "$HEADERS_FILE"; then
  fail "authorization header should not be sent for VitalPBX"
fi

echo "[v2.0.5-vitalpbx-app-key] PASS: app-key header verified and authorization absent"
