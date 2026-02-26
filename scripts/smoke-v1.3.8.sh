#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://app.connectcomunications.com/api}"
PASSWORD="${PASSWORD:-Passw0rd!234}"
NOW="$(date +%s)"
EMAIL="prov${NOW}@connectcomunications.com"
TENANT_NAME="Mobile Provisioning Smoke ${NOW}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_ENV="/opt/connectcomms/infra/.env"

log(){ echo "[v1.3.8] $*"; }
fail(){ echo "FAIL: $*" >&2; exit 1; }

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

log "starting mobile provisioning token smoke"
cd "$REPO_ROOT"
MOBILE_PUSH_SIMULATE=true PBX_SIMULATE=true VOICE_SIMULATE=true docker compose -f docker-compose.app.yml up -d api worker >/dev/null

for _ in $(seq 1 40); do
  if curl -fsS "$BASE_URL/health" >/dev/null; then break; fi
  sleep 2
done
curl -fsS "$BASE_URL/health" >/dev/null || fail "api not healthy"

"$REPO_ROOT/scripts/check-migrations.sh" || fail "migration check failed"

signup_payload="$(jq -nc --arg tn "$TENANT_NAME" --arg em "$EMAIL" --arg pw "$PASSWORD" '{tenantName:$tn,email:$em,password:$pw}')"
signup_json="$(api POST /auth/signup "" "$signup_payload")"
echo "$signup_json" | jq -e . >/dev/null || fail "invalid signup response"

POSTGRES_USER="$(grep -E '^POSTGRES_USER=' "$INFRA_ENV" | head -n1 | cut -d= -f2-)"
POSTGRES_DB="$(grep -E '^POSTGRES_DB=' "$INFRA_ENV" | head -n1 | cut -d= -f2-)"
PG_CONTAINER="$(docker ps --format '{{.Names}}' | grep -m1 postgres || true)"
[[ -n "$PG_CONTAINER" ]] || fail "postgres not found"
docker exec -i "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE \"User\" SET role='SUPER_ADMIN' WHERE email='${EMAIL}';" >/dev/null

login_payload="$(jq -nc --arg em "$EMAIL" --arg pw "$PASSWORD" '{email:$em,password:$pw}')"
login_json="$(api POST /auth/login "" "$login_payload")"
TOKEN="$(echo "$login_json" | jq -r '.token // empty')"
[[ -n "$TOKEN" ]] || fail "login missing token"

pbx_create_payload='{"name":"Smoke PBX","baseUrl":"https://pbx-smoke.example.com","token":"smoke-token","secret":"smoke-secret","isEnabled":true}'
pbx_create="$(api POST /admin/pbx/instances "$TOKEN" "$pbx_create_payload")"
PBX_INSTANCE_ID="$(echo "$pbx_create" | jq -r '.id // empty')"
[[ -n "$PBX_INSTANCE_ID" ]] || fail "failed to create PBX instance: $pbx_create"

pbx_link_payload="$(jq -nc --arg id "$PBX_INSTANCE_ID" '{pbxInstanceId:$id,pbxTenantId:"smoke-tenant",pbxDomain:"pbx-smoke.example.com"}')"
pbx_link="$(api POST /pbx/link "$TOKEN" "$pbx_link_payload")"
echo "$pbx_link" | jq -e '.id and .status == "LINKED"' >/dev/null || fail "failed to link PBX: $pbx_link"

ext_create="$(api POST /pbx/extensions "$TOKEN" '{"extensionNumber":"1001","displayName":"Provisioning Smoke","enableWebrtc":true,"enableMobile":true}')"
echo "$ext_create" | jq -e '.pbxLink.id' >/dev/null || fail "failed to create extension: $ext_create"

token_json="$(api POST /voice/mobile-provisioning/token "$TOKEN" '{}')"
PROV_TOKEN="$(echo "$token_json" | jq -r '.token // empty')"
[[ -n "$PROV_TOKEN" ]] || fail "missing provisioning token: $token_json"

redeem_payload="$(jq -nc --arg t "$PROV_TOKEN" '{token:$t,deviceInfo:{platform:"smoke",model:"ci"}}')"
redeem_json="$(api POST /voice/mobile-provisioning/redeem "$TOKEN" "$redeem_payload")"
echo "$redeem_json" | jq -e '.sipPassword and .provisioning.sipUsername and .provisioning.sipDomain' >/dev/null || fail "redeem failed: $redeem_json"

redeem_again="$(api POST /voice/mobile-provisioning/redeem "$TOKEN" "$redeem_payload")"
echo "$redeem_again" | jq -e '.error == "TOKEN_ALREADY_USED"' >/dev/null || fail "second redeem should fail with TOKEN_ALREADY_USED: $redeem_again"

log "PASS: provisioning token issues, redeems once, and rejects reuse"
