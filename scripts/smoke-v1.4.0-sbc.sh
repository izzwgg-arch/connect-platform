#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

log(){ echo "[v1.4.0-sbc] $*"; }
fail(){ echo "FAIL: $*" >&2; exit 1; }

log "starting SBC smoke"
cd "$REPO_ROOT"

docker compose -f docker-compose.app.yml up -d api >/dev/null
PBX_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}' app-api-1 2>/dev/null | head -n1 | tr -d '\r')"
[[ -n "$PBX_IP" ]] || fail "unable to resolve app-api-1 container IP"
SBC_PBX_HOST="$PBX_IP" docker compose -f docker-compose.sbc.yml up -d >/dev/null

for _ in $(seq 1 30); do
  k_state="$(docker inspect -f '{{.State.Running}}' sbc-kamailio 2>/dev/null || true)"
  r_state="$(docker inspect -f '{{.State.Running}}' sbc-rtpengine 2>/dev/null || true)"
  if [[ "$k_state" == "true" && "$r_state" == "true" ]]; then
    break
  fi
  sleep 1
done

[[ "$(docker inspect -f '{{.State.Running}}' sbc-kamailio 2>/dev/null || true)" == "true" ]] || fail "kamailio container not running"
[[ "$(docker inspect -f '{{.State.Running}}' sbc-rtpengine 2>/dev/null || true)" == "true" ]] || fail "rtpengine container not running"

docker port sbc-kamailio 5060/udp | grep -q '127.0.0.1:5060' || fail "kamailio localhost UDP 5060 publish missing"
docker port sbc-kamailio 5061/tcp | grep -q '127.0.0.1:5061' || fail "kamailio localhost TCP 5061 publish missing"
docker port sbc-kamailio 7443/tcp | grep -q '127.0.0.1:7443' || fail "kamailio localhost TCP 7443 publish missing"
docker logs --tail 120 sbc-kamailio 2>&1 | grep -E 'Listening on' >/dev/null || fail "kamailio listener log not found"

# Inject SIP OPTIONS internally (best-effort non-blocking).
timeout 5 docker exec sbc-kamailio sh -lc "cat <<'SIP' | nc -u -w1 127.0.0.1 5060 >/dev/null 2>&1 || true
OPTIONS sip:sbc.connectcomunications.local SIP/2.0
Via: SIP/2.0/UDP 127.0.0.1:5098;branch=z9hG4bK-smoke-v140-self
Max-Forwards: 5
From: <sip:smoke@localhost>;tag=12345
To: <sip:sbc.connectcomunications.local>
Call-ID: smoke-v140-self@localhost
CSeq: 1 OPTIONS
Content-Length: 0

SIP" || true

timeout 5 docker exec sbc-kamailio sh -lc "cat <<SIP | nc -u -w1 127.0.0.1 5060 >/dev/null 2>&1 || true
OPTIONS sip:health@${PBX_IP}:5060 SIP/2.0
Via: SIP/2.0/UDP 127.0.0.1:5099;branch=z9hG4bK-smoke-v140-fwd
Max-Forwards: 5
From: <sip:smoke@localhost>;tag=99999
To: <sip:health@${PBX_IP}:5060>
Call-ID: smoke-v140-fwd@localhost
CSeq: 1 OPTIONS
Content-Length: 0

SIP" || true

# Verify dispatcher is configured to forward toward the intended PBX hop.
docker exec sbc-kamailio sh -lc "grep -q \"sip:${PBX_IP}:5060\" /etc/kamailio/dispatcher.list" || fail "dispatcher target not configured for PBX IP"

log "PASS: SBC containers up, Kamailio listening, SIP OPTIONS injected, dispatcher target configured for PBX forwarding"
