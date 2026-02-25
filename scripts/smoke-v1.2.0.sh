#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://app.connectcomunications.com/api}"
PORTAL_URL="${PORTAL_URL:-https://app.connectcomunications.com}"
PASSWORD="${PASSWORD:-Passw0rd!234}"
NOW="$(date +%s)"
EMAIL="support${NOW}@connectcomunications.com"
TENANT_NAME="Voice Smoke ${NOW}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_ENV="/opt/connectcomms/infra/.env"

log(){ echo "[v1.2.0] $*"; }
fail(){ echo "FAIL: $*" >&2; exit 1; }

api(){
  local method="$1" path="$2" token="${3:-}" body="${4:-}"
  local auth=()
  if [[ -n "$token" ]]; then auth=(-H "Authorization: Bearer $token"); fi
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" "$BASE_URL$path" -H "content-type: application/json" "${auth[@]}" -d "$body"
  else
    curl -sS -X "$method" "$BASE_URL$path" -H "content-type: application/json" "${auth[@]}"
  fi
}

log "starting WebRTC smoke (VOICE_SIMULATE=true PBX_SIMULATE=true)"
cd "$REPO_ROOT"
VOICE_SIMULATE=true PBX_SIMULATE=true docker compose -f docker-compose.app.yml up -d api worker portal >/dev/null

for _ in $(seq 1 40); do
  if curl -fsS "$BASE_URL/health" >/dev/null; then break; fi
  sleep 2
done
curl -fsS "$BASE_URL/health" >/dev/null || fail "api health not ready"

signup_json="$(api POST /auth/signup "" "{\"tenantName\":\"$TENANT_NAME\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")"
echo "$signup_json" | jq -e . >/dev/null || fail "invalid signup response"

POSTGRES_USER="$(grep -E '^POSTGRES_USER=' "$INFRA_ENV" | head -n1 | cut -d= -f2-)"
POSTGRES_DB="$(grep -E '^POSTGRES_DB=' "$INFRA_ENV" | head -n1 | cut -d= -f2-)"
PG_CONTAINER="$(docker ps --format '{{.Names}}' | grep -m1 postgres || true)"
[[ -n "$PG_CONTAINER" ]] || fail "postgres container not found"

docker exec -i "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE \"User\" SET role='SUPER_ADMIN' WHERE email='${EMAIL}';" >/dev/null

login_json="$(api POST /auth/login "" "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")"
TOKEN="$(echo "$login_json" | jq -r '.token // empty')"
[[ -n "$TOKEN" ]] || fail "no token from login"

inst_json="$(api POST /admin/pbx/instances "$TOKEN" '{"name":"Voice Smoke PBX","baseUrl":"https://pbx.sim.local","token":"sim-token","secret":"sim-secret","isEnabled":true}')"
INST_ID="$(echo "$inst_json" | jq -r '.id // empty')"
[[ -n "$INST_ID" ]] || fail "pbx instance create failed: $inst_json"

link_json="$(api POST /pbx/link "$TOKEN" "{\"pbxInstanceId\":\"$INST_ID\",\"pbxTenantId\":\"tenant-sim-voice\",\"pbxDomain\":\"pbx.sim.local\"}")"
echo "$link_json" | jq -e '.status == "LINKED"' >/dev/null || fail "pbx link failed: $link_json"

ext_json="$(api POST /pbx/extensions "$TOKEN" '{"extensionNumber":"1101","displayName":"Voice User","enableWebrtc":true,"enableMobile":true}')"
echo "$ext_json" | jq -e '.extension.id or .queued == true' >/dev/null || fail "extension create failed: $ext_json"

me_json="$(api GET /voice/me/extension "$TOKEN")"
echo "$me_json" | jq -e '.extensionId and .sipUsername and (.webrtcEnabled|type=="boolean")' >/dev/null || fail "voice/me/extension invalid: $me_json"

cfg_json="$(api POST /voice/webrtc/test-config "$TOKEN" '{"sipWsUrl":"wss://pbx.sim.local:8089/ws","sipDomain":"pbx.sim.local","iceServers":[{"urls":"stun:stun.l.google.com:19302"}],"dtmfMode":"RFC2833"}')"
echo "$cfg_json" | jq -e '.ok == true' >/dev/null || fail "webrtc/test-config invalid: $cfg_json"

reset_json="$(api POST /voice/me/reset-sip-password "$TOKEN" "{}")"
SIP_PASS="$(echo "$reset_json" | jq -r '.sipPassword // empty')"
[[ "$SIP_PASS" == sim-webrtc-* ]] || fail "reset did not return simulated one-time secret: $reset_json"

portal_status="$(curl -sk -o /dev/null -w '%{http_code}' "$PORTAL_URL/dashboard/voice/phone")"
[[ "$portal_status" == "200" || "$portal_status" == "307" || "$portal_status" == "308" ]] || fail "phone route not reachable, status=$portal_status"

log "PASS: voice routes + reset secret + portal phone route reachable"
