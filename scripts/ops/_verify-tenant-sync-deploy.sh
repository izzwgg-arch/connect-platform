#!/usr/bin/env bash
set -u

echo "=== git HEAD ==="
cd /opt/connectcomms/app && git rev-parse --short HEAD

echo
echo "=== container state ==="
docker ps --filter name=app-telephony-1 --filter name=app-portal-1 --filter name=app-api-1 --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.CreatedAt}}'

echo
echo "=== telephony /health ==="
curl -sS --max-time 5 http://127.0.0.1:3003/health || echo "curl_fail"
echo

echo "=== portal /api/healthz ==="
curl -sS --max-time 5 http://127.0.0.1:3000/api/healthz || echo "curl_fail"
echo

echo "=== api /health ==="
curl -sS --max-time 5 http://127.0.0.1:3001/health || echo "curl_fail"
echo

echo "=== new endpoint: GET /admin/telephony/live-sync-diagnostics (expect 401 without auth) ==="
curl -sS -o /dev/null -w "HTTP %{http_code}\n" --max-time 5 "http://127.0.0.1:3001/admin/telephony/live-sync-diagnostics"

echo
echo "=== telephony container log (tail 30) ==="
docker logs --tail 30 app-telephony-1 2>&1 | sed 's/^/  /'

echo
echo "=== portal container log (tail 20) ==="
docker logs --tail 20 app-portal-1 2>&1 | sed 's/^/  /'
