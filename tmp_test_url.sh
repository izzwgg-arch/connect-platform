#!/bin/bash
echo "=== Test 1: API direct (should return 401) ==="
curl -sv -X POST http://127.0.0.1:3001/mobile/flight-recorder/upload \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer badtoken" \
  -d '{"session":{"id":"test","startedAt":"2026-01-01T00:00:00Z"},"stats":{}}' 2>&1 | grep -E 'HTTP|{"'

echo ""
echo "=== Test 2: Via nginx https (should return 401) ==="
curl -s -X POST https://app.connectcomunications.com/api/mobile/flight-recorder/upload \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer badtoken" \
  -d '{"session":{"id":"test","startedAt":"2026-01-01T00:00:00Z"},"stats":{}}'
echo ""

echo "=== Checking nginx config for /api/ proxy ==="
nginx -T 2>/dev/null | grep -A5 'location /api' | head -20 || echo "nginx -T not available"
cat /etc/nginx/conf.d/*.conf 2>/dev/null | grep -A10 'location /api' | head -20 || true
