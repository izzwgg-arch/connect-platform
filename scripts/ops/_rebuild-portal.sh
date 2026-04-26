#!/usr/bin/env bash
set -euo pipefail

ROOT="/opt/connectcomms/app"
COMPOSE="${DEPLOY_COMPOSE_FILE:-$ROOT/docker-compose.app.yml}"
source /opt/connectcomms/ops/run-heavy.sh 2>/dev/null || true  # just to check the path
HEAVY="/opt/connectcomms/ops/run-heavy.sh"

echo "=== git HEAD ==="
git -C "$ROOT" log --oneline -3

echo
echo "=== building portal image ==="
if [[ -x "$HEAVY" ]]; then
  "$HEAVY" "manual:portal:compose-build" -- docker compose -f "$COMPOSE" build portal
else
  docker compose -f "$COMPOSE" build portal
fi

echo
echo "=== starting portal ==="
docker compose -f "$COMPOSE" up -d portal

echo
echo "=== waiting for portal to come up ==="
ok=0
for i in $(seq 1 90); do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 10 \
    -H 'Host: app.connectcomunications.com' 'http://127.0.0.1:3000/login' 2>/dev/null || echo 000)"
  printf 'iter=%02d http=%s\n' "$i" "$code"
  if [[ "$code" =~ ^(200|301|302|303|307|308)$ ]]; then
    ok=1
    break
  fi
  sleep 5
done

if [[ "$ok" == "1" ]]; then
  echo "=== PORTAL UP ==="
else
  echo "=== PORTAL FAILED TO COME UP ==="
  docker logs --tail 30 app-portal-1 2>&1
  exit 1
fi
