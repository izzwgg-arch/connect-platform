#!/usr/bin/env bash
set -u
SHA="${1:-910c239}"
REASON="${2:-tenant-scoped presence map fix}"
for SVC in telephony portal; do
  echo "=== enqueue $SVC @ $SHA ==="
  body="$(printf '{"service":"%s","branch":"main","commit":"%s","requestedBy":"cursor:agent","reason":"%s"}' "$SVC" "$SHA" "$REASON")"
  curl -sS -X POST http://127.0.0.1:3910/ops/deploy/enqueue \
    -H "Content-Type: application/json" \
    --data "$body"
  echo
done
