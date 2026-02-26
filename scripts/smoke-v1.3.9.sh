#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://app.connectcomunications.com/api}"
PASSWORD="${PASSWORD:-Passw0rd!234}"
NOW="$(date +%s)"
EMAIL="invlife${NOW}@connectcomunications.com"
TENANT_NAME="Invite Lifecycle Smoke ${NOW}"
WEBHOOK_TOKEN="smoke-webhook-token"
CALL1="smoke-call-${NOW}-1"
CALL2="smoke-call-${NOW}-2"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_ENV="/opt/connectcomms/infra/.env"

log(){ echo "[v1.3.9] $*"; }
fail(){ echo "FAIL: $*" >&2; exit 1; }

api(){
  local method="$1" path="$2" token="${3:-}" body="${4:-}" header="${5:-}"
  local headers=(-H "content-type: application/json")
  if [[ -n "$token" ]]; then headers+=(-H "Authorization: Bearer $token"); fi
  if [[ -n "$header" ]]; then headers+=(-H "$header"); fi
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" "$BASE_URL$path" "${headers[@]}" -d "$body"
  else
    curl -sS -X "$method" "$BASE_URL$path" "${headers[@]}"
  fi
}

query_status_by_invite(){
  local invite_id="$1"
  docker exec -i "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c "SELECT status FROM \"CallInvite\" WHERE id='${invite_id}' LIMIT 1;" | tr -d '\r\n '
}

log "starting invite lifecycle smoke"
cd "$REPO_ROOT"
PBX_WEBHOOK_VERIFY_MODE=token PBX_WEBHOOK_TOKEN="$WEBHOOK_TOKEN" MOBILE_PUSH_SIMULATE=true PBX_SIMULATE=true VOICE_SIMULATE=true docker compose -f docker-compose.app.yml up -d api worker >/dev/null

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

ext_create="$(api POST /pbx/extensions "$TOKEN" '{"extensionNumber":"1001","displayName":"Invite Lifecycle","enableWebrtc":true,"enableMobile":true}')"
echo "$ext_create" | jq -e '.pbxLink.id' >/dev/null || fail "failed to create extension: $ext_create"

ring1_payload="$(jq -nc --arg cid "$CALL1" '{eventType:"call.ringing",state:"RINGING",pbxCallId:$cid,toExtension:"1001",fromNumber:"+13055550111",timestamp:(now|todateiso8601),eventId:("evt-"+$cid)}')"
ring1="$(api POST /webhooks/pbx "" "$ring1_payload" "x-pbx-webhook-token: $WEBHOOK_TOKEN")"
echo "$ring1" | jq -e '.ok == true and .state == "RINGING"' >/dev/null || fail "ring1 failed: $ring1"
INVITE1_ID="$(echo "$ring1" | jq -r '.result.inviteId // empty')"
[[ -n "$INVITE1_ID" ]] || fail "missing invite id after ringing"
status1="$(query_status_by_invite "$INVITE1_ID")"
[[ "$status1" == "PENDING" ]] || fail "expected PENDING after ringing, got '$status1'"

cancel1_payload="$(jq -nc --arg cid "$CALL1" '{eventType:"call.canceled",state:"CANCELED",cause:"NO_ANSWER",pbxCallId:$cid,toExtension:"1001",timestamp:(now|todateiso8601),eventId:("evt-cancel-"+$cid)}')"
cancel1="$(api POST /webhooks/pbx "" "$cancel1_payload" "x-pbx-webhook-token: $WEBHOOK_TOKEN")"
echo "$cancel1" | jq -e '.ok == true and (.state == "CANCELED" or .state == "HANGUP")' >/dev/null || fail "cancel1 failed: $cancel1"

status1c="$(query_status_by_invite "$INVITE1_ID")"
[[ "$status1c" == "CANCELED" || "$status1c" == "EXPIRED" ]] || fail "expected CANCELED/EXPIRED after cancel, got '$status1c'"

cancel1_again="$(api POST /webhooks/pbx "" "$cancel1_payload" "x-pbx-webhook-token: $WEBHOOK_TOKEN")"
echo "$cancel1_again" | jq -e '.ok == true' >/dev/null || fail "cancel replay failed: $cancel1_again"

ring2_payload="$(jq -nc --arg cid "$CALL2" '{eventType:"call.ringing",state:"RINGING",pbxCallId:$cid,toExtension:"1001",fromNumber:"+13055550112",timestamp:(now|todateiso8601),eventId:("evt-"+$cid)}')"
ring2="$(api POST /webhooks/pbx "" "$ring2_payload" "x-pbx-webhook-token: $WEBHOOK_TOKEN")"
echo "$ring2" | jq -e '.ok == true and .state == "RINGING"' >/dev/null || fail "ring2 failed: $ring2"
INVITE2_ID="$(echo "$ring2" | jq -r '.result.inviteId // empty')"
[[ -n "$INVITE2_ID" ]] || fail "missing second invite id after ringing"

ans2_payload="$(jq -nc --arg cid "$CALL2" '{eventType:"call.answered",state:"ANSWERED",pbxCallId:$cid,toExtension:"1001",timestamp:(now|todateiso8601),eventId:("evt-answer-"+$cid)}')"
ans2="$(api POST /webhooks/pbx "" "$ans2_payload" "x-pbx-webhook-token: $WEBHOOK_TOKEN")"
echo "$ans2" | jq -e '.ok == true and .state == "ANSWERED"' >/dev/null || fail "answer2 failed: $ans2"

status2="$(query_status_by_invite "$INVITE2_ID")"
[[ "$status2" == "ACCEPTED" ]] || fail "expected ACCEPTED after answer, got '$status2'"

ans2_again="$(api POST /webhooks/pbx "" "$ans2_payload" "x-pbx-webhook-token: $WEBHOOK_TOKEN")"
echo "$ans2_again" | jq -e '.ok == true' >/dev/null || fail "answer replay failed: $ans2_again"

log "PASS: PBX event lifecycle updates invites (ringing->canceled/accepted) and replay is idempotent"
