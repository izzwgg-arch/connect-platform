#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://app.connectcomunications.com/api}"
PASSWORD="${PASSWORD:-Passw0rd!234}"
NOW="$(date +%s)"
EMAIL="support${NOW}@connectcomunications.com"
TENANT_NAME="PBX Webhook Smoke ${NOW}"
WEBHOOK_TOKEN="smoke-pbx-token-${NOW}"
PBX_CALL_ID="pbx-call-${NOW}"
PBX_TENANT_ID="pbx-tenant-${NOW}"
EXT_NUM="1001"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_ENV="/opt/connectcomms/infra/.env"

log(){ echo "[v1.3.2] $*"; }
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

log "starting pbx webhook invite smoke"
cd "$REPO_ROOT"
PBX_SIMULATE=true VOICE_SIMULATE=true MOBILE_PUSH_SIMULATE=true PBX_WEBHOOK_VERIFY_MODE=token PBX_WEBHOOK_TOKEN="$WEBHOOK_TOKEN" docker compose -f docker-compose.app.yml up -d api worker >/dev/null

for _ in $(seq 1 40); do
  if curl -fsS "$BASE_URL/health" >/dev/null; then break; fi
  sleep 2
done
curl -fsS "$BASE_URL/health" >/dev/null || fail "api not healthy"

signup_payload="$(jq -nc --arg tn "$TENANT_NAME" --arg em "$EMAIL" --arg pw "$PASSWORD" '{tenantName:$tn,email:$em,password:$pw}')"
signup_json="$(api POST /auth/signup "" "$signup_payload")"
echo "$signup_json" | jq -e . >/dev/null || fail "invalid signup response"

POSTGRES_USER="$(grep -E '^POSTGRES_USER=' "$INFRA_ENV" | head -n1 | cut -d= -f2-)"
POSTGRES_DB="$(grep -E '^POSTGRES_DB=' "$INFRA_ENV" | head -n1 | cut -d= -f2-)"
PG_CONTAINER="$(docker ps --format '{{.Names}}' | grep -m1 postgres || true)"
[[ -n "$PG_CONTAINER" ]] || fail "postgres not found"

TENANT_ID="$(echo "$signup_json" | jq -r '.tenant.id // empty')"
USER_ID="$(echo "$signup_json" | jq -r '.user.id // empty')"
[[ -n "$TENANT_ID" && -n "$USER_ID" ]] || fail "signup missing tenant/user ids"

SQL=$(cat <<SQL
UPDATE "User" SET role='SUPER_ADMIN' WHERE id='${USER_ID}';
INSERT INTO "PbxInstance" ("id","name","baseUrl","apiAuthEncrypted","isEnabled","createdAt","updatedAt")
VALUES ('pbx_inst_${NOW}','Smoke PBX','https://pbx.example.com','{"token":"sim"}',true,NOW(),NOW())
ON CONFLICT ("id") DO NOTHING;
INSERT INTO "TenantPbxLink" ("id","tenantId","pbxInstanceId","pbxTenantId","pbxDomain","status","createdAt","updatedAt")
VALUES ('tenant_link_${NOW}','${TENANT_ID}','pbx_inst_${NOW}','${PBX_TENANT_ID}','pbx.example.com','LINKED',NOW(),NOW())
ON CONFLICT ("tenantId") DO UPDATE SET "pbxInstanceId"=EXCLUDED."pbxInstanceId", "pbxTenantId"=EXCLUDED."pbxTenantId", "status"='LINKED', "updatedAt"=NOW();
INSERT INTO "Extension" ("id","tenantId","extNumber","displayName","ownerUserId","status","createdAt","updatedAt")
VALUES ('ext_${NOW}','${TENANT_ID}','${EXT_NUM}','Webhook Owner','${USER_ID}','ACTIVE',NOW(),NOW())
ON CONFLICT ("tenantId","extNumber") DO UPDATE SET "ownerUserId"='${USER_ID}', "status"='ACTIVE', "updatedAt"=NOW();
INSERT INTO "PbxExtensionLink" ("id","tenantId","extensionId","pbxExtensionId","pbxSipUsername","isSuspended","createdAt","updatedAt")
VALUES ('ext_link_${NOW}','${TENANT_ID}','ext_${NOW}','pbx-ext-${NOW}','sip-${NOW}',false,NOW(),NOW())
ON CONFLICT ("extensionId") DO UPDATE SET "pbxExtensionId"='pbx-ext-${NOW}', "updatedAt"=NOW();
SQL
)
docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$SQL" >/dev/null

login_payload="$(jq -nc --arg em "$EMAIL" --arg pw "$PASSWORD" '{email:$em,password:$pw}')"
login_json="$(api POST /auth/login "" "$login_payload")"
TOKEN="$(echo "$login_json" | jq -r '.token // empty')"
[[ -n "$TOKEN" ]] || fail "login missing token"

event_payload="$(jq -nc --arg cid "$PBX_CALL_ID" --arg tid "$PBX_TENANT_ID" --arg ext "$EXT_NUM" '{eventType:"call.ringing",callId:$cid,from:"+13055550111",toExtension:$ext,pbxTenantId:$tid,startedAt:(now|todate)}')"
webhook_json="$(curl -sS -X POST "$BASE_URL/webhooks/pbx" -H 'content-type: application/json' -H "x-pbx-webhook-token: $WEBHOOK_TOKEN" -d "$event_payload")"

echo "$webhook_json" | jq -e '.ok == true and .result.ok == true' >/dev/null || fail "webhook processing failed: $webhook_json"
echo "$webhook_json" | jq -e '.result.push.simulated == true' >/dev/null || fail "push path not simulated/triggered"

pending_json="$(api GET /mobile/call-invites/pending "$TOKEN")"
INVITE_ID="$(echo "$pending_json" | jq -r --arg cid "$PBX_CALL_ID" 'map(select(.pbxCallId==$cid))[0].id // empty')"
[[ -n "$INVITE_ID" ]] || fail "pending invite with pbxCallId not found"

resp_json="$(api POST /mobile/call-invites/${INVITE_ID}/respond "$TOKEN" '{"action":"DECLINED"}')"
echo "$resp_json" | jq -e '.ok == true and .status == "DECLINED"' >/dev/null || fail "decline failed"

log "PASS: pbx webhook -> invite created -> push dispatched (simulated) -> invite declined"
