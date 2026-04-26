#!/usr/bin/env bash
set -euo pipefail
set -a
source /opt/connectcomms/env/.env.deploy-queue
set +a

BASE="http://127.0.0.1:3910"
AUTH=(-H "x-deploy-queue-token: ${DEPLOY_QUEUE_TOKEN}")

echo "=== queue status ==="
curl -sS "${BASE}/ops/deploy/status" "${AUTH[@]}"
echo
echo "=== recent jobs ==="
curl -sS "${BASE}/ops/deploy/jobs?limit=10" "${AUTH[@]}" | python3 -c '
import json, sys
j = json.load(sys.stdin)
jobs = j.get("jobs") or j
if isinstance(jobs, list):
    for jb in jobs[:10]:
        import time
        t = lambda ms: time.strftime("%H:%M:%S", time.localtime(ms/1000)) if ms else "-"
        print(f'\''  {jb.get("id","")[:8]}  {jb.get("service","?"):<10} {jb.get("status","?"):<9} created={t(jb.get("created_at"))} started={t(jb.get("started_at"))} finished={t(jb.get("finished_at"))}  by={jb.get("requested_by","?")}'\'')
else:
    print(json.dumps(j, indent=2))
'
