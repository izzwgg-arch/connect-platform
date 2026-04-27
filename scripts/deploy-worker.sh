#!/usr/bin/env bash
# Deploy worker only (Docker service `worker`). Does NOT run Prisma migrations
# (the api image/job owns migrate deploy for the platform DB).
# Skips build/restart when the target commit matches the deployed commit or
# when the diff touches no worker-relevant paths.
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
  deploy_common_emit_stage "dry-run"
  log "DRY RUN — no git/docker changes"
  log "Would: git sync, pnpm install if lock changed, docker compose build/up ${SERVICE}, container running check"
  log "(branch=${BRANCH:-} commit=${COMMIT:-} requested_by=${REQ})"
  exit 0
fi

JOB_START_NS="$(deploy_common_stopwatch_start)"

deploy_common_emit_stage "git-sync"
LOCK_BEFORE="$(deploy_common_lock_hash)"
PKG_BEFORE="$(deploy_common_pkg_hash)"
OLD_HEAD="$(deploy_common_git_sync "$ROOT" "${BRANCH:-main}" "$COMMIT")"
NEW_HEAD="$(deploy_common_head_sha)"
LOCK_AFTER="$(deploy_common_lock_hash)"
PKG_AFTER="$(deploy_common_pkg_hash)"

deploy_common_emit_stage "change-detect"
if [[ "$OLD_HEAD" == "$NEW_HEAD" ]]; then
  deploy_common_emit_stage "done"
  deploy_common_emit_skip "no_changes"
  log "deployed commit already at ${NEW_HEAD:0:12} — skipping install/build/restart"
  exit 0
fi

if ! deploy_common_needs_rebuild "$SERVICE" "$OLD_HEAD"; then
  deploy_common_emit_stage "done"
  deploy_common_emit_skip "unrelated_paths"
  log "commit changed ${OLD_HEAD:0:12}..${NEW_HEAD:0:12} but no worker-relevant paths changed — skipping build/restart"
  exit 0
fi

deploy_common_emit_stage "install"
INSTALL_START="$(deploy_common_stopwatch_start)"
deploy_common_maybe_pnpm_install "deploy-queue:${SERVICE}" "$LOCK_BEFORE" "$LOCK_AFTER" "$PKG_BEFORE" "$PKG_AFTER"
deploy_common_log_timing "install" "$(deploy_common_stopwatch_elapsed_ms "$INSTALL_START")"

rollback() {
  trap - ERR
  deploy_common_emit_stage "rollback"
  log "rollback: restoring git + rebuilding ${SERVICE}"
  deploy_common_rollback_git "$ROOT" "$OLD_HEAD" || true
  deploy_common_run_heavy "deploy-queue:${SERVICE}:rollback-build" \
    docker compose -f "$COMPOSE" build "$SERVICE"
  docker compose -f "$COMPOSE" up -d "$SERVICE" || true
}

trap 'rollback' ERR

deploy_common_emit_stage "build"
BUILD_START="$(deploy_common_stopwatch_start)"
log "docker build ${SERVICE}"
deploy_common_run_heavy "deploy-queue:${SERVICE}:compose-build" \
  docker compose -f "$COMPOSE" build "$SERVICE"
deploy_common_log_timing "build" "$(deploy_common_stopwatch_elapsed_ms "$BUILD_START")"

deploy_common_emit_stage "restart"
RESTART_START="$(deploy_common_stopwatch_start)"
log "docker up ${SERVICE}"
docker compose -f "$COMPOSE" up -d "$SERVICE"
deploy_common_log_timing "restart" "$(deploy_common_stopwatch_elapsed_ms "$RESTART_START")"

deploy_common_emit_stage "health"
HEALTH_START="$(deploy_common_stopwatch_start)"
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
deploy_common_log_timing "health" "$(deploy_common_stopwatch_elapsed_ms "$HEALTH_START")"

trap - ERR
deploy_common_emit_stage "done"
deploy_common_log_timing "total" "$(deploy_common_stopwatch_elapsed_ms "$JOB_START_NS")"
log "done $(git rev-parse --short HEAD) requested_by=${REQ}"
