#!/usr/bin/env bash
set -euo pipefail
set -a
source /opt/connectcomms/env/.env.deploy-queue
set +a

JOB_ID="${1:?usage: $0 <job_id>}"
BASE="http://127.0.0.1:3910"
AUTH=(-H "x-deploy-queue-token: ${DEPLOY_QUEUE_TOKEN}")

echo "=== Waiting for job ${JOB_ID} ==="
for i in $(seq 1 120); do
  curl -sS "${BASE}/ops/deploy/jobs/${JOB_ID}" "${AUTH[@]}" > /tmp/dq_job.json 2>/dev/null || true
  STATUS=$(python3 - <<'PY'
import json
try:
  with open("/tmp/dq_job.json") as f:
    j = json.load(f)
  print(j.get("job", {}).get("status", "unknown"))
except Exception:
  print("parse_error")
PY
  )
  printf 'iter=%02d status=%s\n' "$i" "$STATUS"
  case "$STATUS" in
    done|failed|cancelled) break ;;
  esac
  sleep 5
done
echo
echo "=== Final job record ==="
cat /tmp/dq_job.json
echo
