#!/usr/bin/env bash
# Deploy queue fallback — serialized, audited path when direct deploy is unsuitable.
# Usage: bash scripts/ops/_deploy-queue-fallback.sh api|portal [--dry-run] [--branch main] [--commit SHA]
set -euo pipefail

SERVICE="${1:?usage: $0 api|portal [--dry-run] [--branch BRANCH] [--commit SHA]}"
shift

DRY_RUN=false
BRANCH="main"
COMMIT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --branch) BRANCH="${2:?}"; shift ;;
    --commit) COMMIT="${2:?}"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
  shift
done

set -a
source /opt/connectcomms/env/.env.deploy-queue
set +a

BASE="http://127.0.0.1:${DEPLOY_QUEUE_PORT:-3910}"
AUTH=(-H "x-deploy-queue-token: ${DEPLOY_QUEUE_TOKEN}" -H "Content-Type: application/json")

dry_json="false"
[[ "$DRY_RUN" == true ]] && dry_json="true"
payload="$(python3 - <<PY
import json
body = {
  "service": "$SERVICE",
  "branch": "$BRANCH",
  "requestedBy": "human:queue-fallback",
  "reason": "queue fallback deploy",
  "dryRun": $dry_json,
  "source": "manual",
}
if "$COMMIT":
    body["commitHash"] = "$COMMIT"
print(json.dumps(body))
PY
)"

echo "=== Preflight queue status ==="
curl -sS "${BASE}/ops/deploy/status" "${AUTH[@]}"
echo
echo "=== Enqueue ${SERVICE} ==="
resp="$(curl -sS -X POST "${BASE}/ops/deploy/enqueue" "${AUTH[@]}" -d "$payload")"
echo "$resp"
job_id="$(printf '%s' "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("job",{}).get("id",""))' 2>/dev/null || true)"
[[ -n "$job_id" ]] || exit 1
echo "=== Poll job ${job_id} (5s interval) ==="
for i in $(seq 1 180); do
  curl -sS "${BASE}/ops/deploy/jobs/${job_id}" "${AUTH[@]}" > /tmp/dq_job.json
  status="$(python3 -c 'import json; print(json.load(open("/tmp/dq_job.json"))["job"]["status"])')"
  printf 'iter=%03d status=%s\n' "$i" "$status"
  case "$status" in
    success|failed|cancelled) break ;;
  esac
  sleep 5
done
echo "=== Log tail ==="
curl -sS "${BASE}/ops/deploy/jobs/${job_id}/log?lines=80" "${AUTH[@]}"
echo
