#!/usr/bin/env bash
set -euo pipefail
set -a
source /opt/connectcomms/env/.env.deploy-queue
set +a

BASE="http://127.0.0.1:3910"
AUTH=(-H "x-deploy-queue-token: ${DEPLOY_QUEUE_TOKEN}" -H "Content-Type: application/json")

echo "=== Enqueue api ==="
curl -sS -X POST "${BASE}/ops/deploy/enqueue" "${AUTH[@]}" -d '{"service":"api","branch":"main"}'
echo
echo "=== Queue status ==="
curl -sS "${BASE}/ops/deploy/status" "${AUTH[@]}"
echo
