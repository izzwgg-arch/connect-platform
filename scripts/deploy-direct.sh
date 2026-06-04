#!/usr/bin/env bash
# Direct production deploy for api | portal — bypasses ops/deploy-queue HTTP worker.
# Invokes the same scripts/deploy-{api,portal}.sh the queue worker runs (blue/green,
# prisma migrate gating, health checks). Prefer this for routine api/portal deploys.
#
# Run on the Connect app host (/opt/connectcomms/app). From a workstation use
# scripts/release/deploy-direct.ps1 or scripts/release/deploy-direct.sh (SSH).
#
# Usage:
#   bash scripts/deploy-direct.sh api --branch main
#   bash scripts/deploy-direct.sh portal --commit <sha>
#   bash scripts/deploy-direct.sh api --branch main --dry-run
#
# Env (optional):
#   DEPLOY_REPO_ROOT          default /opt/connectcomms/app or repo root
#   DEPLOY_ENV_FILE           default /opt/connectcomms/env/.env.deploy-queue
#   DEPLOY_REQUESTED_BY       default direct:$USER
#   DEPLOY_DIRECT_LOG_DIR     default /var/log/connect-deploys
#   DEPLOY_DIRECT_SKIP_QUEUE_CHECK=1  skip running-job guard (break-glass)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib/deploy-common.sh"

SERVICE=""
BRANCH=""
COMMIT=""
DRY_RUN=0
SKIP_QUEUE_CHECK="${DEPLOY_DIRECT_SKIP_QUEUE_CHECK:-0}"

log() { echo "[deploy-direct] $*"; }
fail() { echo "[deploy-direct] FAIL: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: bash scripts/deploy-direct.sh <api|portal> (--branch NAME | --commit SHA) [--dry-run] [--skip-queue-check]

Direct deploy bypasses the deploy queue. Same rollout scripts as queue jobs.

Examples (on app host):
  bash scripts/deploy-direct.sh api --branch main
  bash scripts/deploy-direct.sh portal --commit abc123def456
  bash scripts/deploy-direct.sh api --branch main --dry-run

Queue fallback (serialized, audit UI): scripts/ops/_deploy-queue-api.sh
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    api|portal) SERVICE="$1" ;;
    --branch) BRANCH="${2:?--branch requires a value}"; shift ;;
    --commit) COMMIT="${2:?--commit requires a value}"; shift ;;
    --dry-run) DRY_RUN=1 ;;
    --skip-queue-check) SKIP_QUEUE_CHECK=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

[[ -n "$SERVICE" ]] || { usage; fail "service is required (api|portal)"; }
[[ -n "$BRANCH" || -n "$COMMIT" ]] || fail "pass --branch or --commit"
[[ -z "$BRANCH" || -z "$COMMIT" ]] || fail "pass only one of --branch or --commit"

ROOT="${DEPLOY_REPO_ROOT:-$ROOT}"
cd "$ROOT"

DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-/opt/connectcomms/env/.env.deploy-queue}"
if [[ -f "$DEPLOY_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$DEPLOY_ENV_FILE"
  set +a
  log "sourced deploy env from ${DEPLOY_ENV_FILE}"
else
  log "note: ${DEPLOY_ENV_FILE} not found — using script defaults for blue/green nginx paths"
fi

export DEPLOY_QUEUE_ACK=1
export DEPLOY_REPO_ROOT="$ROOT"
export DEPLOY_BRANCH="$BRANCH"
export DEPLOY_COMMIT="$COMMIT"
export DEPLOY_REQUESTED_BY="${DEPLOY_REQUESTED_BY:-direct:${USER:-manual}}"
[[ "$DRY_RUN" == "1" ]] && export DEPLOY_DRY_RUN=1

deploy_direct_queue_preflight() {
  [[ "$SKIP_QUEUE_CHECK" == "1" ]] && return 0
  local status_url="http://127.0.0.1:${DEPLOY_QUEUE_PORT:-3910}/ops/deploy/status"
  local body
  body="$(curl -fsS --connect-timeout 3 --max-time 8 "$status_url" 2>/dev/null)" || {
    log "queue status unavailable (${status_url}) — continuing (queue may be stopped)"
    return 0
  }
  local running
  running="$(printf '%s' "$body" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("runningCount",0))' 2>/dev/null || echo 0)"
  if [[ "${running:-0}" != "0" ]]; then
    fail "deploy queue has runningCount=${running} — wait for the active job or use --skip-queue-check (break-glass). Status: GET ${status_url}"
  fi
  local queued_count
  queued_count="$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("queuedCount",0))' 2>/dev/null || echo 0)"
  if [[ "${queued_count:-0}" != "0" ]]; then
    log "warning: deploy queue has queuedCount=${queued_count} — cancel stale jobs if you do not want a follow-up queue deploy"
  fi
}

deploy_direct_queue_preflight

LOG_DIR="${DEPLOY_DIRECT_LOG_DIR:-/var/log/connect-deploys}"
mkdir -p "$LOG_DIR" 2>/dev/null || true
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_FILE="${LOG_DIR}/direct-${SERVICE}-${STAMP}.log"

TARGET_SCRIPT="$ROOT/scripts/deploy-${SERVICE}.sh"
[[ -x "$TARGET_SCRIPT" || -f "$TARGET_SCRIPT" ]] || fail "missing ${TARGET_SCRIPT}"

log "service=${SERVICE} branch=${BRANCH:-} commit=${COMMIT:-} dry_run=${DRY_RUN} requested_by=${DEPLOY_REQUESTED_BY}"
log "log_file=${LOG_FILE}"
log "invoking ${TARGET_SCRIPT}"

set +e
bash "$TARGET_SCRIPT" 2>&1 | tee -a "$LOG_FILE"
exit_code="${PIPESTATUS[0]}"
set -e

rollback_doc="docs/ai-context/DEPLOYMENT_API_ROLLBACK.md"
[[ "$SERVICE" == "portal" ]] && rollback_doc="docs/ai-context/DEPLOYMENT_PORTAL_ROLLBACK.md"

if [[ "$exit_code" -eq 0 ]]; then
  log "success — verify: docker exec app-${SERVICE}-1 grep -n '<unique line>' /app/... (see AGENTS.md post-deploy SHA checks)"
else
  log "failed with exit ${exit_code} — see ${LOG_FILE} and ${rollback_doc}"
fi
exit "$exit_code"
