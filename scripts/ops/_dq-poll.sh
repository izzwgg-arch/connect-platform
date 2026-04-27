#!/usr/bin/env bash
set -euo pipefail
ENV_FILE=/opt/connectcomms/env/.env.deploy-queue
set -a; . "$ENV_FILE"; set +a
echo "=== status ==="
curl -sS -H "x-deploy-queue-token: ${DEPLOY_QUEUE_TOKEN}" http://127.0.0.1:3910/ops/deploy/status | python3 -m json.tool 2>/dev/null || true
echo
echo "=== recent jobs (auto cursor:agent) ==="
curl -sS -H "x-deploy-queue-token: ${DEPLOY_QUEUE_TOKEN}" "http://127.0.0.1:3910/ops/deploy/jobs?limit=6" \
  | python3 -c '
import json, sys
d = json.load(sys.stdin)
for j in d["jobs"]:
    print("{:<10} {:<9} stage={:<10} skip={:<12} dur={}ms commit={} err={}".format(
        j["service"], j["status"],
        str(j.get("currentStage")),
        str(j.get("skipReason")),
        j.get("durationMs"),
        j.get("deployedCommit") or j.get("commitHash") or "-",
        (j.get("errorMessage") or "")[:80],
    ))
'
