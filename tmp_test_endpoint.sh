#!/bin/bash
echo "=== Testing upload endpoint with bad token ==="
curl -s -X POST http://127.0.0.1:3001/mobile/flight-recorder/upload \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer badtoken" \
  -d '{"session":{"id":"test-fix-001","startedAt":"2026-01-01T00:00:00Z"},"stats":{}}'
echo ""

echo "=== Checking API logs for errors ==="
docker logs app-api-1 --since=1m 2>&1 | grep -E '"url":"/mobile/flight-recorder|error.*requireAuth|500' | tail -5
