#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://app.connectcomunications.com/api}"
PASSWORD="${PASSWORD:-Passw0rd!234}"
NOW="$(date +%s)"
EMAIL="sbcfunc${NOW}@connectcomunications.com"
TENANT_NAME="SBC Functional Smoke ${NOW}"
DOMAIN="app.connectcomunications.com"
SIP_URL="https://${DOMAIN}/sip"
INFRA_ENV="/opt/connectcomms/infra/.env"

log(){ echo "[v1.4.2] $*"; }
fail(){ echo "[v1.4.2] FAIL: $*" >&2; exit 1; }

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

log "starting functional SBC smoke"

resp="$(curl -i -sS -N --max-time 20 \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  -H "Host: ${DOMAIN}" \
  -H "Origin: https://${DOMAIN}" \
  -H 'Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==' \
  -H 'Sec-WebSocket-Version: 13' \
  "$SIP_URL" || true)"

echo "$resp" | sed -n '1,20p'
echo "$resp" | grep -Eiq '101|websocket|Sec-WebSocket' || fail "/sip route handshake indicator missing"

signup_payload="$(jq -nc --arg tn "$TENANT_NAME" --arg em "$EMAIL" --arg pw "$PASSWORD" '{tenantName:$tn,email:$em,password:$pw}')"
signup_json="$(api POST /auth/signup "" "$signup_payload")"
echo "$signup_json" | jq -e . >/dev/null || fail "invalid signup response"

POSTGRES_USER="$(grep -E '^POSTGRES_USER=' "$INFRA_ENV" | head -n1 | cut -d= -f2-)"
POSTGRES_DB="$(grep -E '^POSTGRES_DB=' "$INFRA_ENV" | head -n1 | cut -d= -f2-)"
PG_CONTAINER="$(docker ps --format '{{.Names}}' | grep -m1 postgres || true)"
[[ -n "$PG_CONTAINER" ]] || fail "postgres container not found"
docker exec -i "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE \"User\" SET role='SUPER_ADMIN' WHERE email='${EMAIL}';" >/dev/null

login_payload="$(jq -nc --arg em "$EMAIL" --arg pw "$PASSWORD" '{email:$em,password:$pw}')"
login_json="$(api POST /auth/login "" "$login_payload")"
TOKEN="$(echo "$login_json" | jq -r '.token // empty')"
[[ -n "$TOKEN" ]] || fail "login missing token"

sbc_json="$(api GET /voice/sbc/status "$TOKEN")"
echo "$sbc_json" | jq -e '.ok == true and .services.kamailio and .services.rtpengine and .services.pbxViaSbc' >/dev/null || fail "voice/sbc/status missing expected fields"

webrtc_json="$(api GET /voice/webrtc/settings "$TOKEN")"
echo "$webrtc_json" | jq -e '.ok == true and (.webrtcRouteViaSbc == false)' >/dev/null || fail "webrtcRouteViaSbc toggle missing or default not false"

log "PASS: /sip route present, /voice/sbc/status reachable, and webrtcRouteViaSbc defaults false"