#!/usr/bin/env bash
# Deploy worker only (Docker service `worker`). Does NOT run Prisma migrations
# (the api image/job owns migrate deploy for the platform DB).
#
# Env: same as deploy-api.sh (DEPLOY_REPO_ROOT, DEPLOY_BRANCH, DEPLOY_COMMIT, …)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib/deploy-common.sh"

ROOT="${DEPLOY_REPO_ROOT:-$ROOT}"
SERVICE="worker"
COMPOSE="$(deploy_common_compose_file)"
BRANCH="${DEPLOY_BRANCH:-}"
COMMIT="${DEPLOY_COMMIT:-}"
REQ="${DEPLOY_REQUESTED_BY:-manual}"

log() { echo "[deploy-worker] $*"; }
fail() { echo "[deploy-worker] FAIL: $*" >&2; exit 1; }

[[ -n "$BRANCH" || -n "$COMMIT" ]] || fail "DEPLOY_BRANCH or DEPLOY_COMMIT is required"
cd "$ROOT"
[[ -f "$COMPOSE" ]] || fail "compose file missing: $COMPOSE"

if [[ "${DEPLOY_DRY_RUN:-0}" == "1" ]]; then
  log "DRY RUN — no git/docker changes"
  log "Would: git sync, pnpm install if lock changed, docker compose build/up ${SERVICE}, container running check"
  log "(branch=${BRANCH:-} commit=${COMMIT:-} requested_by=${REQ})"
  exit 0
fi

LOCK_BEFORE="$(deploy_common_lock_hash)"
OLD_HEAD="$(deploy_common_git_sync "$ROOT" "${BRANCH:-main}" "$COMMIT")"
LOCK_AFTER="$(deploy_common_lock_hash)"

deploy_common_maybe_pnpm_install "deploy-queue:${SERVICE}" "$LOCK_BEFORE" "$LOCK_AFTER"

rollback() {
  trap - ERR
  log "rollback: restoring git + rebuilding ${SERVICE}"
  deploy_common_rollback_git "$ROOT" "$OLD_HEAD" || true
  deploy_common_run_heavy "deploy-queue:${SERVICE}:rollback-build" \
    docker compose -f "$COMPOSE" build "$SERVICE"
  docker compose -f "$COMPOSE" up -d "$SERVICE" || true
}

trap 'rollback' ERR

log "docker build ${SERVICE}"
deploy_common_run_heavy "deploy-queue:${SERVICE}:compose-build" \
  docker compose -f "$COMPOSE" build "$SERVICE"

log "docker up ${SERVICE}"
docker compose -f "$COMPOSE" up -d "$SERVICE"

log "health check: worker container running"
ok=0
for i in $(seq 1 30); do
  rid="$(docker compose -f "$COMPOSE" ps -q "$SERVICE" 2>/dev/null || true)"
  if [[ -n "$rid" ]]; then
    running="$(docker inspect -f '{{.State.Running}}' "$rid" 2>/dev/null || echo false)"
    if [[ "$running" == "true" ]]; then
      ok=1
      break
    fi
  fi
  sleep 2
done
if [[ "$ok" != "1" ]]; then
  rollback
  fail "worker container not running (requested by ${REQ})"
fi

trap - ERR
log "done $(git rev-parse --short HEAD) requested_by=${REQ}"
