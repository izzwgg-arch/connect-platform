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
CONTAINER_HEADERS_FILE="/tmp/vpbx-smoke-headers.txt"
CONTAINER_PID_FILE="/tmp/vpbx-smoke.pid"

fail(){ echo "[v2.0.5-vitalpbx-app-key] FAIL: $*" >&2; exit 1; }
cleanup() {
  docker exec app-api-1 sh -lc "if [ -f '${CONTAINER_PID_FILE}' ]; then kill \$(cat '${CONTAINER_PID_FILE}') >/dev/null 2>&1 || true; rm -f '${CONTAINER_PID_FILE}'; fi; rm -f '${CONTAINER_HEADERS_FILE}'" >/dev/null 2>&1 || true
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

docker exec app-api-1 sh -lc "cat > /tmp/vpbx-smoke-server.js <<'JS'
const fs = require('fs');
const http = require('http');
const headersFile = process.env.HEADERS_FILE;
const port = Number(process.env.PORT || '18081');
fs.writeFileSync(headersFile, '');
http.createServer((req, res) => {
  const lines = Object.entries(req.headers).map(([k, v]) => `${String(k).toLowerCase()}: ${String(v)}\\n`).join('');
  fs.appendFileSync(headersFile, lines);
  if (req.url && req.url.startsWith('/api/v2/tenants')) {
    const body = JSON.stringify({ status: 'success', data: [{ id: 1, name: 'Tenant' }] });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) });
    res.end(body);
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(port, '127.0.0.1');
setInterval(() => {}, 1 << 30);
JS
HEADERS_FILE='${CONTAINER_HEADERS_FILE}' PORT='${PORT}' node /tmp/vpbx-smoke-server.js >/tmp/vpbx-smoke-server.log 2>&1 & echo \$! > '${CONTAINER_PID_FILE}'"
sleep 1

signup_payload="$(jq -nc --arg tn "$TENANT_NAME" --arg em "$EMAIL" --arg pw "$PASSWORD" '{tenantName:$tn,email:$em,password:$pw}')"
signup_json="$(api POST /auth/signup "" "$signup_payload")"
echo "$signup_json" | jq -e . >/dev/null || fail "invalid signup response"

docker exec -i connectcomms-postgres psql -U connectcomms -d connectcomms -c "UPDATE \"User\" SET role='SUPER_ADMIN' WHERE email='${EMAIL}';" >/dev/null

login_payload="$(jq -nc --arg em "$EMAIL" --arg pw "$PASSWORD" '{email:$em,password:$pw}')"
login_json="$(api POST /auth/login "" "$login_payload")"
ADMIN_TOKEN="$(echo "$login_json" | jq -r '.token // empty')"
[[ -n "$ADMIN_TOKEN" ]] || fail "admin login failed"

create_payload="$(jq -nc --arg name "Header Smoke ${NOW}" --arg url "http://127.0.0.1:${PORT}" --arg token "$PBX_TOKEN" '{name:$name,baseUrl:$url,token:$token,isEnabled:true}')"
created="$(api POST /admin/pbx/instances "$ADMIN_TOKEN" "$create_payload")"
INSTANCE_ID="$(echo "$created" | jq -r '.id // empty')"
[[ -n "$INSTANCE_ID" ]] || fail "instance create failed: $created"

test_resp="$(api POST "/admin/pbx/instances/${INSTANCE_ID}/test" "$ADMIN_TOKEN")"
echo "$test_resp" | jq -e '.ok == true' >/dev/null || fail "test endpoint failed: $test_resp"

docker exec app-api-1 sh -lc "cat '${CONTAINER_HEADERS_FILE}'" > "$HEADERS_FILE"
[[ -s "$HEADERS_FILE" ]] || fail "no headers captured"
grep -qi '^app-key: '"$PBX_TOKEN"'$' "$HEADERS_FILE" || fail "app-key header not sent"
if grep -qi '^authorization:' "$HEADERS_FILE"; then
  fail "authorization header should not be sent for VitalPBX"
fi

echo "[v2.0.5-vitalpbx-app-key] PASS: app-key header verified and authorization absent"
