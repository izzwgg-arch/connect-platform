#!/usr/bin/env bash
set -e
curl -s -X POST http://127.0.0.1:3910/ops/deploy/enqueue \
  -H "Content-Type: application/json" \
  -d '{"service":"api","branch":"main","requestedBy":"cursor:agent","reason":"modern invite + password-created email templates","dryRun":false,"source":"auto"}'
