#!/usr/bin/env bash
set -euo pipefail
set -a
source /opt/connectcomms/env/.env.deploy-queue
set +a

BASE="http://127.0.0.1:3910"
AUTH=(-H "x-deploy-queue-token: ${DEPLOY_QUEUE_TOKEN}")

for id in "$@"; do
  echo "=== waiting on $id ==="
  for i in $(seq 1 180); do
    curl -sS "${BASE}/ops/deploy/jobs/${id}" "${AUTH[@]}" > /tmp/job.json
    st=$(python3 -c 'import json; print(json.load(open("/tmp/job.json"))["job"]["status"])')
    printf "  [%3d] status=%s\n" "$i" "$st"
    case "$st" in
      success|failed|cancelled)
        python3 -m json.tool < /tmp/job.json
        break ;;
    esac
    sleep 5
  done
done

echo
echo "=== final queue status ==="
curl -sS "${BASE}/ops/deploy/status" "${AUTH[@]}" | python3 -m json.tool
