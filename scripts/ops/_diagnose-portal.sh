#!/usr/bin/env bash
set -uo pipefail

echo "=== container status ==="
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -E 'portal|api|telephony|realtime|nginx' || true

echo ""
echo "=== portal env (NEXT_PUBLIC / API) ==="
PORTAL=$(docker ps -qf name=portal | head -1)
[[ -n "$PORTAL" ]] && docker exec "$PORTAL" printenv 2>/dev/null | grep -E '^(NEXT_PUBLIC|PORTAL_API_INTERNAL_URL)=' || echo "portal container not found"

echo ""
echo "=== api /health ==="
curl -sS -o /tmp/api_health -w 'http=%{http_code} time=%{time_total}s\n' http://127.0.0.1:3001/health || true
cat /tmp/api_health 2>/dev/null | head -c 400; echo

echo ""
echo "=== telephony /health ==="
curl -sS -o /tmp/tel_health -w 'http=%{http_code} time=%{time_total}s\n' http://127.0.0.1:3003/health || true
cat /tmp/tel_health 2>/dev/null | head -c 400; echo

echo ""
echo "=== portal /login (via nginx host header) ==="
curl -sS -o /dev/null -w 'http=%{http_code} time=%{time_total}s\n' \
  -H 'Host: app.connectcomunications.com' http://127.0.0.1:3000/login

echo ""
echo "=== nginx -> WS route (expect 101 Upgrade OR 401/400, not 404) ==="
for HOST in app.connectcomunications.com app.connectcomms.com; do
  echo "--- Host: $HOST"
  curl -sS -o /dev/null -w 'http=%{http_code}\n' -I \
    -H "Host: $HOST" http://127.0.0.1:80/ws/telephony || true
done

echo ""
echo "=== /admin/pbx/tenants via api (no auth — expect 401) ==="
curl -sS -o /tmp/pbx_tenants_unauth -w 'http=%{http_code}\n' \
  http://127.0.0.1:3001/admin/pbx/tenants || true
head -c 400 /tmp/pbx_tenants_unauth 2>/dev/null; echo

echo ""
echo "=== portal logs (last 40) ==="
[[ -n "$PORTAL" ]] && docker logs --tail 40 "$PORTAL" 2>&1 | sed 's/^/  /'

echo ""
echo "=== api logs (last 40, filter errors + pbx) ==="
API=$(docker ps -qf name=api | head -1)
[[ -n "$API" ]] && docker logs --tail 200 "$API" 2>&1 | grep -iE 'error|pbx|tenant|unauthor|fail' | tail -40 | sed 's/^/  /'

echo ""
echo "=== telephony logs (last 40) ==="
TEL=$(docker ps -qf name=telephony | head -1)
[[ -n "$TEL" ]] && docker logs --tail 40 "$TEL" 2>&1 | sed 's/^/  /'

echo ""
echo "=== nginx upstream map for /ws/telephony ==="
grep -rE 'ws/telephony|proxy_pass' /etc/nginx 2>/dev/null | grep -v '^\s*#' | head -20 || true

echo ""
echo "=== done ==="
