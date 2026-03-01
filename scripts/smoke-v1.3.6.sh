#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://app.connectcomunications.com/api}"
PASSWORD="${PASSWORD:-Passw0rd!234}"
NOW="$(date +%s)"
EMAIL="diag${NOW}@connectcomunications.com"
TENANT_NAME="Voice Diagnostics Smoke ${NOW}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_ENV="/opt/connectcomms/infra/.env"

log(){ echo "[v1.3.6] $*"; }
fail(){ echo "FAIL: $*" >&2; exit 1; }

run_compose() {
  local label="$1"
  local cmd="$2"
  if [[ "${FORCE_REBUILD:-0}" == "1" ]]; then
    cmd="${cmd/ up -d / up -d --build }"
    log "FORCE_REBUILD=1 -> ${label} uses --build"
  fi
  /opt/connectcomms/ops/run-heavy.sh "$label" -- bash -lc "$cmd"
}

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

log "starting voice diagnostics smoke"
cd "$REPO_ROOT"
run_compose "smoke-v1.3.6.sh:compose-up" "MOBILE_PUSH_SIMULATE=true PBX_SIMULATE=true VOICE_SIMULATE=true docker compose -f docker-compose.app.yml up -d api worker >/dev/null"

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

start_json="$(api POST /voice/diag/session/start "$TOKEN" '{"platform":"WEB","appVersion":"smoke-v1.3.6","sipWsUrl":"wss://pbx.example/ws","sipDomain":"pbx.example","iceHasTurn":false}')"
SESSION_ID="$(echo "$start_json" | jq -r '.sessionId // empty')"
[[ -n "$SESSION_ID" ]] || fail "session start failed: $start_json"

hb_json="$(api POST /voice/diag/session/heartbeat "$TOKEN" "$(jq -nc --arg sid "$SESSION_ID" '{sessionId:$sid,lastRegState:"REGISTERED",lastCallState:"IDLE"}')")"
echo "$hb_json" | jq -e '.ok == true' >/dev/null || fail "heartbeat failed: $hb_json"

ev_json="$(api POST /voice/diag/event "$TOKEN" "$(jq -nc --arg sid "$SESSION_ID" '{sessionId:$sid,type:"ERROR",payload:{code:"SMOKE_ERROR",reason:"synthetic"}}')")"
echo "$ev_json" | jq -e '.ok == true and .eventId' >/dev/null || fail "event write failed: $ev_json"

sessions_json="$(api GET /voice/diag/sessions "$TOKEN")"
echo "$sessions_json" | jq -e --arg sid "$SESSION_ID" 'map(select(.id == $sid)) | length >= 1' >/dev/null || fail "sessions list missing session"

events_json="$(api GET /voice/diag/sessions/${SESSION_ID}/events "$TOKEN")"
echo "$events_json" | jq -e 'map(select(.type == "ERROR")) | length >= 1' >/dev/null || fail "events list missing ERROR"

log "PASS: diagnostics session + heartbeat + event + list endpoints work"
