#!/usr/bin/env bash
# Deploy API only (Docker service `api`). Safe for ops/deploy-queue worker.
# - Only this per-service script runs `prisma migrate deploy`, and only when
#   `packages/db/prisma/**` actually changed between old and new HEAD.
# - Skips docker build when the target commit equals the deployed commit, or
#   when the diff touches no API-relevant paths.
# - Restarts only the `api` compose service. Never other PM2 processes.
#
# Env (set by worker or manually):
#   DEPLOY_REPO_ROOT   default /opt/connectcomms/app
#   DEPLOY_BRANCH      required unless DEPLOY_COMMIT set
#   DEPLOY_COMMIT      optional SHA (detached); wins over branch
#   DEPLOY_REQUESTED_BY
#   DEPLOY_COMPOSE_FILE default docker-compose.app.yml
#   DEPLOY_JOB_ID, DEPLOY_QUEUE_STATE_DIR (set by worker — used for stage file)
#
# Blue/green (zero-downtime API, default DEPLOY_API_BLUEGREEN=1):
#   DEPLOY_NGINX_API_UPSTREAM_ACTIVE_FILE — nginx include path (single line server 127.0.0.1:PORT;)
#   DEPLOY_API_UPSTREAM_BOOTSTRAP=1 — one-time create upstream file pointing at :3001
#   DEPLOY_API_PUBLIC_VERIFY_URL — optional HTTPS/HTTP URL curl after nginx cutovers (often /api/ready)
#   DEPLOY_API_PUBLIC_VERIFY_TLS_INSECURE=1 — curl -k for https verify URLs
#   DEPLOY_API_BLUEGREEN=0 — legacy single-container compose_up (no nginx flip)
#
# Rollback: docs/ai-context/DEPLOYMENT_API_ROLLBACK.md
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib/deploy-common.sh"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib/deploy-api-rollout.sh"

ROOT="${DEPLOY_REPO_ROOT:-$ROOT}"
SERVICE="api"
COMPOSE="$(deploy_common_compose_file)"
BRANCH="${DEPLOY_BRANCH:-}"
COMMIT="${DEPLOY_COMMIT:-}"
REQ="${DEPLOY_REQUESTED_BY:-manual}"

log() { echo "[deploy-api] $*"; }
fail() { echo "[deploy-api] FAIL: $*" >&2; exit 1; }

[[ -n "$BRANCH" || -n "$COMMIT" ]] || fail "DEPLOY_BRANCH or DEPLOY_COMMIT is required"

cd "$ROOT"
[[ -f "$COMPOSE" ]] || fail "compose file missing: $COMPOSE"

if [[ "${DEPLOY_DRY_RUN:-0}" == "1" ]]; then
  log "DRY RUN — checkout safety + clone sync only (no docker/prisma/build)"
  deploy_common_dry_run_checkout_safety "$ROOT" "${BRANCH:-main}" "$COMMIT"
  _dry_pre=""
  deploy_common_git_sync "$ROOT" "${BRANCH:-main}" "$COMMIT" _dry_pre
  _dry_new="$(deploy_common_head_sha)"
  if [[ "$_dry_pre" != "$_dry_new" ]]; then
    log "[deploy-api] DRY RUN: tree advanced ${_dry_pre:0:12}→${_dry_new:0:12}; re-exec for latest deploy-api.sh body"
    exec bash "$ROOT/scripts/deploy-api.sh"
  fi
  log "Would next: pnpm install if lock/pkg changed,"
  log "  prisma migrate deploy IF prisma/** changed, docker compose build api [+ api_candidate], blue/green OR legacy compose up"
  log "Blue/green steps when DEPLOY_API_BLUEGREEN=${DEPLOY_API_BLUEGREEN:-1}:"
  deploy_api_rollout_dry_run_steps | while IFS= read -r line; do log "  $line"; done
  log "(requested_by=${REQ})"
  exit 0
fi

JOB_START_NS="$(deploy_common_stopwatch_start)"

deploy_common_emit_stage "git-sync"
LOCK_BEFORE="$(deploy_common_lock_hash)"
PKG_BEFORE="$(deploy_common_pkg_hash)"
# Track what *this service* last shipped, not the checkout HEAD — a prior deploy
# job may have already advanced the shared working tree to the new commit.
PERSISTED_OLD_HEAD="$(deploy_common_last_deployed_commit "$SERVICE" || true)"
PRE_SYNC_HEAD=""
deploy_common_git_sync "$ROOT" "${BRANCH:-main}" "$COMMIT" PRE_SYNC_HEAD
OLD_HEAD="${PERSISTED_OLD_HEAD:-$PRE_SYNC_HEAD}"
NEW_HEAD="$(deploy_common_head_sha)"
LOCK_AFTER="$(deploy_common_lock_hash)"
PKG_AFTER="$(deploy_common_pkg_hash)"

if [[ "$PRE_SYNC_HEAD" != "$NEW_HEAD" ]]; then
  log "[deploy-api] checkout advanced ${PRE_SYNC_HEAD:0:12}→${NEW_HEAD:0:12}; re-exec deploy-api.sh so rollout logic matches disk"
  exec bash "$ROOT/scripts/deploy-api.sh"
fi

deploy_common_emit_stage "change-detect"
if [[ "$OLD_HEAD" == "$NEW_HEAD" ]]; then
  deploy_common_emit_stage "done"
  deploy_common_emit_skip "no_changes"
  log "deployed commit already at ${NEW_HEAD:0:12} — skipping install/build/restart"
  exit 0
fi

if ! deploy_common_needs_rebuild "$SERVICE" "$OLD_HEAD"; then
  deploy_common_mark_deployed "$SERVICE" "$NEW_HEAD"
  deploy_common_emit_stage "done"
  deploy_common_emit_skip "unrelated_paths"
  log "commit changed ${OLD_HEAD:0:12}..${NEW_HEAD:0:12} but no api-relevant paths changed — skipping build/restart"
  exit 0
fi

deploy_common_emit_stage "install"
INSTALL_START="$(deploy_common_stopwatch_start)"
deploy_common_maybe_pnpm_install "deploy-queue:${SERVICE}" "$LOCK_BEFORE" "$LOCK_AFTER" "$PKG_BEFORE" "$PKG_AFTER"
deploy_common_log_timing "install" "$(deploy_common_stopwatch_elapsed_ms "$INSTALL_START")"

deploy_common_export_database_url

rollback() {
  trap - ERR
  deploy_common_emit_stage "rollback"
  log "rollback: restoring git + rebuilding ${SERVICE} (stop api_candidate if present)"
  deploy_api_rollout_stop_candidate "$COMPOSE" 2>/dev/null || true
  deploy_common_rollback_git "$ROOT" "$OLD_HEAD" || true
  deploy_common_run_heavy "deploy-queue:${SERVICE}:rollback-build" \
    docker compose -f "$COMPOSE" build "$SERVICE"
  deploy_common_compose_up "$COMPOSE" "$SERVICE" || true
}

trap 'rollback' ERR

if deploy_common_needs_migrate "$OLD_HEAD"; then
  deploy_common_emit_stage "migrate"
  MIGRATE_START="$(deploy_common_stopwatch_start)"
  log "prisma migrate deploy (schema/migrations changed)"
  deploy_common_run_heavy "deploy-queue:${SERVICE}:prisma" \
    pnpm --filter @connect/db exec prisma migrate deploy --schema prisma/schema.prisma
  deploy_common_log_timing "migrate" "$(deploy_common_stopwatch_elapsed_ms "$MIGRATE_START")"
else
  log "prisma: no schema/migrations changes -> skipping migrate deploy"
fi

deploy_common_emit_stage "build"
BUILD_START="$(deploy_common_stopwatch_start)"
if [[ "${DEPLOY_API_BLUEGREEN:-1}" == "1" ]]; then
  log "docker build api + api_candidate (shared Dockerfile; candidate uses profile)"
  deploy_common_run_heavy "deploy-queue:${SERVICE}:compose-build-api" \
    docker compose -f "$COMPOSE" build api
  deploy_common_run_heavy "deploy-queue:${SERVICE}:compose-build-api-candidate" \
    docker compose -f "$COMPOSE" --profile api_rollout build api_candidate
else
  log "docker build ${SERVICE}"
  deploy_common_run_heavy "deploy-queue:${SERVICE}:compose-build" \
    docker compose -f "$COMPOSE" build "$SERVICE"
fi
deploy_common_log_timing "build" "$(deploy_common_stopwatch_elapsed_ms "$BUILD_START")"

trap - ERR
deploy_common_emit_stage "restart"
RESTART_START="$(deploy_common_stopwatch_start)"
JOB_TAG="${DEPLOY_JOB_ID:-manual}"
if [[ "${DEPLOY_API_BLUEGREEN:-1}" == "1" ]]; then
  if ! deploy_api_rollout_run "$COMPOSE" "$ROOT" "$REQ" "$JOB_TAG"; then
    fail "blue/green API rollout failed (requested by ${REQ}); nginx/containers may be in a partial state — see docs/ai-context/DEPLOYMENT_API_ROLLBACK.md"
  fi
else
  log "docker up ${SERVICE} (DEPLOY_API_BLUEGREEN=0 legacy compose_up)"
  deploy_common_compose_up "$COMPOSE" "$SERVICE"
fi
deploy_common_log_timing "restart" "$(deploy_common_stopwatch_elapsed_ms "$RESTART_START")"

trap 'rollback' ERR

deploy_common_emit_stage "health"
HEALTH_START="$(deploy_common_stopwatch_start)"
log "health check http://127.0.0.1:3001/health"
if ! deploy_common_wait_http_ok "http://127.0.0.1:3001/health" 150 2; then
  # Capture container state BEFORE rollback replaces app-api-1.
  log "--- health failed: docker compose ps api ---"
  docker compose -f "$COMPOSE" ps api 2>&1 || true
  log "--- health failed: app-api-1 last 120 lines ---"
  docker logs --tail=120 app-api-1 2>&1 || true
  log "--- end health-failure container logs ---"
  rollback
  fail "health check failed after deploy (requested by ${REQ})"
fi
deploy_common_log_timing "health" "$(deploy_common_stopwatch_elapsed_ms "$HEALTH_START")"

trap - ERR
deploy_common_mark_deployed "$SERVICE" "$NEW_HEAD"
deploy_common_emit_stage "done"
deploy_common_log_timing "total" "$(deploy_common_stopwatch_elapsed_ms "$JOB_START_NS")"
log "done $(git rev-parse --short HEAD) requested_by=${REQ}"
