#!/usr/bin/env bash
# Inspect live state to diagnose why BLF/Team Directory does not match Dashboard Live Calls.
set -u

echo "=== git HEAD on server ==="
cd /opt/connectcomms/app && git rev-parse --short HEAD

echo
echo "=== container ages ==="
docker ps --filter name=app-telephony-1 --filter name=app-portal-1 --filter name=app-api-1 --format 'table {{.Names}}\t{{.Status}}\t{{.CreatedAt}}'

echo
echo "=== telephony: fix markers in RUNNING source ==="
echo -n "normalizers dir exists:     "
docker exec app-telephony-1 test -d /app/apps/telephony/src/telephony/normalizers && echo YES || echo NO
echo -n "CallStateStore uses fix:    "
docker exec app-telephony-1 grep -c normalizeExtensionFromChannel /app/apps/telephony/src/telephony/state/CallStateStore.ts
echo -n "TenantResolver uses fix:    "
docker exec app-telephony-1 grep -c resolveExtensionTenant /app/apps/telephony/src/telephony/state/TenantResolver.ts
echo -n "PbxTenantMapCache has ext:  "
docker exec app-telephony-1 grep -c resolveExtensionTenant /app/apps/telephony/src/telephony/state/PbxTenantMapCache.ts
echo -n "presenceFromLiveCalls fix:  "
docker exec app-portal-1 grep -rc presenceFromLiveCalls /app/apps/portal/.next/standalone 2>/dev/null | head -1

echo
echo "=== portal: isValidTenantExtension regex in bundle ==="
docker exec app-portal-1 sh -c 'grep -rohE "isValidTenantExtension[^;]{0,200}" /app/apps/portal/.next/standalone 2>/dev/null | head -3'

echo
echo "=== telephony /telephony/diag (first 2KB) ==="
curl -sS --max-time 5 http://127.0.0.1:3003/telephony/diag 2>&1 | head -c 2000
echo

echo
echo "=== api /admin/telephony/live-sync-diagnostics (no auth — expect 401) ==="
curl -sS --max-time 5 -o /tmp/_diag_noauth.txt -w "HTTP %{http_code}\n" http://127.0.0.1:3001/admin/telephony/live-sync-diagnostics
head -c 500 /tmp/_diag_noauth.txt
echo

echo
echo "=== api with SUPER_ADMIN JWT (if /opt/connectcomms/env/.env.platform has ADMIN_JWT) ==="
ADMIN_JWT="$(awk -F= '/^ADMIN_DIAG_JWT=/{print $2; exit}' /opt/connectcomms/env/.env.platform 2>/dev/null)"
if [[ -n "$ADMIN_JWT" ]]; then
  curl -sS --max-time 5 -H "authorization: Bearer $ADMIN_JWT" \
    "http://127.0.0.1:3001/admin/telephony/live-sync-diagnostics" | head -c 3000
  echo
else
  echo "(no ADMIN_DIAG_JWT env; skipping)"
fi

echo
echo "=== telephony /telephony/presence (first 1.5KB) ==="
curl -sS --max-time 5 http://127.0.0.1:3003/telephony/presence 2>&1 | head -c 1500
echo
