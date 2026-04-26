#!/usr/bin/env bash
# Run on the production host (queue listens on 127.0.0.1:3910). Loads token from env file.
set -euo pipefail
set -a
source /opt/connectcomms/env/.env.deploy-queue
set +a
BASE="http://127.0.0.1:3910"
AUTH=( -H "x-deploy-queue-token: ${DEPLOY_QUEUE_TOKEN}" -H "Content-Type: application/json" )

post() {
  curl -sS -X POST "$BASE$1" "${AUTH[@]}" -d "$2"
}
post_code() {
  curl -sS -o /tmp/dq_body.json -w "%{http_code}" -X POST "$BASE$1" "${AUTH[@]}" -d "$2"
}
get() {
  curl -sS "$BASE$1" "${AUTH[@]}"
}

py() { python3 -c "$1"; }

wait_terminal() {
  local id="$1" max="${2:-90}" n=0
  while (( n < max )); do
    get "/ops/deploy/jobs/${id}" > /tmp/dq_job.json
    local st
    st="$(py "import json; print(json.load(open('/tmp/dq_job.json'))['job']['status'])")"
    echo "  … ${id:0:8}… status=${st}"
    case "$st" in success|failed|cancelled) return 0 ;; esac
    sleep 2
    ((n+=2)) || true
  done
  echo "timeout waiting for $id" >&2
  return 1
}

cancel_queued_portal() {
  get "/ops/deploy/jobs?status=queued&limit=50" > /tmp/dq_queued.json
  python3 <<'PY' || true
import json, os, subprocess

j = json.load(open("/tmp/dq_queued.json"))
tok = os.environ["DEPLOY_QUEUE_TOKEN"]
for row in j.get("jobs", []):
    if row.get("service") != "portal":
        continue
    jid = row["id"]
    subprocess.run(
        [
            "curl",
            "-sS",
            "-X",
            "POST",
            f"http://127.0.0.1:3910/ops/deploy/jobs/{jid}/cancel",
            "-H",
            f"x-deploy-queue-token: {tok}",
        ],
        check=False,
    )
    print("cancelled queued portal", jid)
PY
}

echo "=== cleanup: cancel any queued portal jobs ==="
cancel_queued_portal

echo ""
echo "=== 1. Duplicate protection (same service while active) ==="
C1="$(post_code /ops/deploy/enqueue "{\"service\":\"portal\",\"branch\":\"main\",\"requestedBy\":\"dq-test-dup-a\",\"dryRun\":true}")"
echo "first portal dry-run HTTP ${C1}"
[[ "$C1" == "201" ]]
JOB_DUP="$(py "import json; print(json.load(open('/tmp/dq_body.json'))['job']['id'])")"
echo "job id: $JOB_DUP"

C2="$(post_code /ops/deploy/enqueue "{\"service\":\"portal\",\"branch\":\"main\",\"requestedBy\":\"dq-test-dup-b\",\"dryRun\":true}")"
echo "second portal dry-run HTTP ${C2} (expect 409)"
[[ "$C2" == "409" ]]
py "import json; d=json.load(open('/tmp/dq_body.json')); assert d.get('error')=='duplicate_active_job_for_service', d"

echo ""
echo "=== 2. Log endpoint (after job has log_path + file) ==="
wait_terminal "$JOB_DUP"
get "/ops/deploy/jobs/${JOB_DUP}/log?lines=50" > /tmp/dq_log.json
py "import json; j=json.load(open('/tmp/dq_log.json')); assert 'text' in j and 'lines' in j, j; print('log lines field:', j['lines']); print('log text preview:', repr(j['text'][:200]))"

echo "log 404 for unknown id:"
get "/ops/deploy/jobs/00000000-0000-0000-0000-000000000000/log" > /tmp/dq_log404.json || true
py "import json; j=json.load(open('/tmp/dq_log404.json')); assert j.get('error')=='log_not_available', j; print('ok:', j['error'])"

echo ""
echo "=== 3. Dry-run enqueue (all services) ==="
DRY_IDS=()
for spec in \
  'api:{"service":"api","branch":"main","requestedBy":"dq-dry-matrix","dryRun":true}' \
  'portal:{"service":"portal","branch":"main","requestedBy":"dq-dry-matrix","dryRun":true}' \
  'worker:{"service":"worker","branch":"main","requestedBy":"dq-dry-matrix","dryRun":true}' \
  'telephony:{"service":"telephony","branch":"main","requestedBy":"dq-dry-matrix","dryRun":true}' \
  'realtime:{"service":"realtime","branch":"main","requestedBy":"dq-dry-matrix","dryRun":true}' \
  'full-stack:{"service":"full-stack","branch":"v0.0.0-dryonly","requestedBy":"dq-dry-matrix","dryRun":true}'; do
  name="${spec%%:*}"
  body="${spec#*:}"
  code="$(post_code /ops/deploy/enqueue "$body")"
  echo "  ${name}: HTTP ${code}"
  [[ "$code" == "201" ]]
  jid="$(py "import json; print(json.load(open('/tmp/dq_body.json'))['job']['id'])")"
  DRY_IDS+=( "$jid" )
done

echo "waiting for all dry-run jobs to finish…"
for jid in "${DRY_IDS[@]}"; do
  wait_terminal "$jid"
  st="$(py "import json; print(json.load(open('/tmp/dq_job.json'))['job']['status'])")"
  echo "  ${jid:0:8}… -> ${st}"
  [[ "$st" == "success" ]]
done

echo ""
echo "=== 4. Real portal deploy (low-risk: same script as manual; branch=main) ==="
echo "waiting for idle queue…"
idle=0
for _ in {1..90}; do
  get "/ops/deploy/status" > /tmp/dq_status.json
  qc="$(py "import json; print(json.load(open('/tmp/dq_status.json'))['queuedCount'])")"
  rc="$(py "import json; print(json.load(open('/tmp/dq_status.json'))['runningCount'])")"
  if [[ "$qc" == "0" && "$rc" == "0" ]]; then
    echo "queue idle (queued=$qc running=$rc)"
    idle=1
    break
  fi
  echo "  queued=$qc running=$rc …"
  sleep 2
done
[[ "$idle" == "1" ]] || { echo "queue did not go idle in time" >&2; exit 1; }

C_REAL="$(post_code /ops/deploy/enqueue "{\"service\":\"portal\",\"branch\":\"main\",\"requestedBy\":\"dq-real-portal-test\",\"dryRun\":false}")"
echo "real portal enqueue HTTP ${C_REAL}"
[[ "$C_REAL" == "201" ]]
JOB_REAL="$(py "import json; print(json.load(open('/tmp/dq_body.json'))['job']['id'])")"
echo "job id: $JOB_REAL"
wait_terminal "$JOB_REAL" 900
get "/ops/deploy/jobs/${JOB_REAL}" > /tmp/dq_real.json
st="$(py "import json; print(json.load(open('/tmp/dq_real.json'))['job']['status'])")"
echo "final status: $st"
get "/ops/deploy/jobs/${JOB_REAL}/log?lines=80" > /tmp/dq_real_log.json
py "import json; t=json.load(open('/tmp/dq_real_log.json')).get('text',''); print('log tail preview:', repr(t[-min(400,len(t)):]))"
[[ "$st" == "success" ]]

echo ""
echo "=== all checks passed ==="
