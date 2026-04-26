#!/usr/bin/env bash
set -euo pipefail
APP=/opt/connectcomms/app
cd "$APP"

COMPOSE_FILE="docker-compose.app.yml"
[[ -f "$COMPOSE_FILE" ]] || { echo "missing $COMPOSE_FILE"; exit 1; }

echo "=== before ==="
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -E 'portal|api|telephony|realtime' || true

echo ""
echo "=== ps -a (stopped) ==="
docker ps -a --format 'table {{.Names}}\t{{.Status}}' | grep -E 'portal|api|telephony|realtime' || true

echo ""
echo "=== docker compose up -d (all services in compose file) ==="
docker compose -f "$COMPOSE_FILE" up -d

echo ""
echo "=== wait for readiness ==="
for svc in "api:3001" "telephony:3003" "realtime:3002" "portal:3000"; do
  name="${svc%:*}"
  port="${svc#*:}"
  ok=0
  for i in $(seq 1 45); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${port}/health" 2>/dev/null || echo 000)"
    if [[ "$code" =~ ^(200|301|302|401|403|404)$ ]]; then
      echo "  $name:$port ready (http=$code)"
      ok=1
      break
    fi
    sleep 2
  done
  [[ "$ok" == "1" ]] || echo "  WARN: $name:$port never became reachable"
done

echo ""
echo "=== after ==="
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -E 'portal|api|telephony|realtime' || true

echo ""
echo "=== health probes ==="
for p in 3001 3002 3003 3000; do
  printf '  :%s  ' "$p"
  curl -sS -o /dev/null -w 'http=%{http_code} t=%{time_total}s\n' --max-time 4 "http://127.0.0.1:${p}/health" || echo "(fail)"
done
echo "  portal /login:"
curl -sS -o /dev/null -w '    http=%{http_code}\n' -H 'Host: app.connectcomunications.com' http://127.0.0.1:3000/login || true

echo ""
echo "=== last 20 lines of each newly-started service ==="
for n in api telephony realtime; do
  cid="$(docker ps -qf name=${n} | head -1)"
  [[ -z "$cid" ]] && { echo "[$n] NOT RUNNING"; continue; }
  echo "--- $n ---"
  docker logs --tail 20 "$cid" 2>&1 | sed 's/^/  /'
done

echo ""
echo "=== done ==="
