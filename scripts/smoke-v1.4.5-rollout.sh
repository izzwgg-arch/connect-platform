#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://app.connectcomunications.com/api}"
PORTAL_URL="${PORTAL_URL:-https://app.connectcomunications.com}"
PASSWORD="${PASSWORD:-Passw0rd!234}"
NOW="$(date +%s)"
EMAIL="rollout${NOW}@connectcomunications.com"
TENANT_NAME="SBC Rollout Smoke ${NOW}"
INFRA_ENV="${INFRA_ENV:-/opt/connectcomms/infra/.env}"

log(){ echo "[v1.4.5] $*"; }
fail(){ echo "[v1.4.5] FAIL: $*" >&2; exit 1; }

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

log "starting SBC rollout smoke"

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

log "hit readiness endpoint"
readiness_json="$(api GET /admin/sbc/readiness "$TOKEN")"
echo "$readiness_json" | jq -e '.ok == true and .probes.nginxSipProxy and .probes.kamailioUp and .probes.rtpengineUp and .probes.rtpengineControlReachableFromKamailio and .probes.pbxReachableFromKamailio' >/dev/null || fail "readiness payload missing expected probes"

log "resolve tenant id via rollout tenant list"
tenants_json="$(api GET /admin/sbc/rollout/tenants "$TOKEN")"
TENANT_ID="$(echo "$tenants_json" | jq -r --arg tn "$TENANT_NAME" '.[] | select(.name==$tn) | .id' | head -n1)"
[[ -n "$TENANT_ID" ]] || fail "unable to resolve smoke tenant id"

log "toggle sbcUdpExposureConfirmed=true"
set_json="$(api PUT "/admin/sbc/rollout/tenant/${TENANT_ID}" "$TOKEN" '{"sbcUdpExposureConfirmed":true}')"
echo "$set_json" | jq -e '.ok == true and .tenant.sbcUdpExposureConfirmed == true' >/dev/null || fail "failed to set sbcUdpExposureConfirmed=true"

verify_json="$(api GET "/admin/sbc/rollout/tenant/${TENANT_ID}" "$TOKEN")"
echo "$verify_json" | jq -e '.ok == true and .tenant.sbcUdpExposureConfirmed == true' >/dev/null || fail "verify endpoint did not return updated sbcUdpExposureConfirmed"

log "load rollout wizard portal route"
http_code="$(curl -sS -o /tmp/v145_rollout_page.html -w '%{http_code}' "$PORTAL_URL/dashboard/admin/sbc/rollout")"
[[ "$http_code" == "200" ]] || fail "portal rollout route did not return HTTP 200 (got $http_code)"

log "PASS: readiness probe endpoint, UDP confirmation toggle, and rollout route availability verified"