#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://app.connectcomunications.com/api}"
PASSWORD="${PASSWORD:-Passw0rd!234}"
NOW="$(date +%s)"
EMAIL="mediametrics${NOW}@connectcomunications.com"
TENANT_NAME="Media Metrics Smoke ${NOW}"
INFRA_ENV="${INFRA_ENV:-/opt/connectcomms/infra/.env}"

log(){ echo "[v1.4.4] $*"; }
fail(){ echo "[v1.4.4] FAIL: $*" >&2; exit 1; }

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

log "starting media metrics smoke"

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

log "check tenant media metrics endpoint"
tenant_metrics="$(api GET '/voice/media-metrics?range=24h' "$TOKEN")"
echo "$tenant_metrics" | jq -e '.ok == true and (.totalMediaTests|type=="number") and (.relayTrueCount|type=="number") and (.relayFalseCount|type=="number")' >/dev/null || fail "voice/media-metrics missing expected fields"

log "check admin media metrics endpoint"
admin_metrics="$(api GET '/admin/voice/media-metrics?range=24h' "$TOKEN")"
echo "$admin_metrics" | jq -e '.ok == true and (.totalMediaTests|type=="number") and (.tenantsFailingMost|type=="array")' >/dev/null || fail "admin/voice/media-metrics missing expected fields"

log "set tenant media policy to RTPENGINE_PREFERRED"
set_policy="$(api PUT /voice/media-test/status "$TOKEN" '{"mediaPolicy":"RTPENGINE_PREFERRED"}')"
echo "$set_policy" | jq -e '.ok == true and .mediaPolicy == "RTPENGINE_PREFERRED"' >/dev/null || fail "failed to set mediaPolicy"

read_policy="$(api GET /voice/media-test/status "$TOKEN")"
echo "$read_policy" | jq -e '.ok == true and .mediaPolicy == "RTPENGINE_PREFERRED"' >/dev/null || fail "mediaPolicy not persisted"

log "check super-admin SBC ops plan output"
ops_plan="$(api GET /admin/sbc/ops-plan "$TOKEN")"
echo "$ops_plan" | jq -e '.ok == true and (.plan | test("35000-35199/udp"))' >/dev/null || fail "ops-plan missing UDP range recommendation"

echo "$ops_plan" | jq -e '.plan | test("ufw allow 35000:35199/udp")' >/dev/null || fail "ops-plan missing expected ufw command"

log "PASS: media metrics endpoints, mediaPolicy set/read, and ops-plan output verified"