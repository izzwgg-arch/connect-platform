#!/usr/bin/env bash
# Deploy portal only (Docker service `portal`). Does NOT run Prisma migrations.
# Skips build/restart when the target commit matches the deployed commit or
# when the diff touches no portal-relevant paths.
#
# Env: same as deploy-api.sh (DEPLOY_REPO_ROOT, DEPLOY_BRANCH, DEPLOY_COMMIT, …)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib/deploy-common.sh"

ROOT="${DEPLOY_REPO_ROOT:-$ROOT}"
SERVICE="portal"
COMPOSE="$(deploy_common_compose_file)"
BRANCH="${DEPLOY_BRANCH:-}"
COMMIT="${DEPLOY_COMMIT:-}"
REQ="${DEPLOY_REQUESTED_BY:-manual}"
PORTAL_IMAGE="${DEPLOY_PORTAL_IMAGE:-app-portal:latest}"
ROLLBACK_IMAGE="app-portal:rollback-${DEPLOY_JOB_ID:-manual-$(date +%s)}"
BACKUP_IMAGE=""

log() { echo "[deploy-portal] $*"; }
fail() { echo "[deploy-portal] FAIL: $*" >&2; exit 1; }

[[ -n "$BRANCH" || -n "$COMMIT" ]] || fail "DEPLOY_BRANCH or DEPLOY_COMMIT is required"
cd "$ROOT"
[[ -f "$COMPOSE" ]] || fail "compose file missing: $COMPOSE"

if [[ "${DEPLOY_DRY_RUN:-0}" == "1" ]]; then
  deploy_common_emit_stage "dry-run"
  log "DRY RUN — no git/docker/health changes"
  log "Would: git sync, pnpm install if needed, tag current ${SERVICE} image, docker compose build/up ${SERVICE}, portal /login check"
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
  log "commit changed ${OLD_HEAD:0:12}..${NEW_HEAD:0:12} but no portal-relevant paths changed — skipping build/restart"
  exit 0
fi

deploy_common_emit_stage "install"
INSTALL_START="$(deploy_common_stopwatch_start)"
deploy_common_maybe_pnpm_install "deploy-queue:${SERVICE}" "$LOCK_BEFORE" "$LOCK_AFTER" "$PKG_BEFORE" "$PKG_AFTER"
deploy_common_log_timing "install" "$(deploy_common_stopwatch_elapsed_ms "$INSTALL_START")"

tag_current_portal_image() {
  local current_ref=""
  current_ref="$(docker inspect -f '{{.Image}}' app-portal-1 2>/dev/null || true)"
  if [[ -z "$current_ref" ]] && docker image inspect "$PORTAL_IMAGE" >/dev/null 2>&1; then
    current_ref="$PORTAL_IMAGE"
  fi

  if [[ -z "$current_ref" ]]; then
    log "rollback backup: no existing portal image found"
    return 0
  fi

  if docker tag "$current_ref" "$ROLLBACK_IMAGE"; then
    BACKUP_IMAGE="$ROLLBACK_IMAGE"
    log "rollback backup: tagged ${current_ref} as ${BACKUP_IMAGE}"
  else
    log "rollback backup: failed to tag ${current_ref}"
  fi
}

cleanup_backup_image() {
  [[ -n "$BACKUP_IMAGE" ]] || return 0
  docker image rm "$BACKUP_IMAGE" >/dev/null 2>&1 || true
}

run_portal_build() {
  local output_file
  output_file="$(mktemp)"

  set +e
  deploy_common_run_heavy "deploy-queue:${SERVICE}:compose-build" \
    docker compose -f "$COMPOSE" build "$SERVICE" 2>&1 | tee "$output_file"
  local status=${PIPESTATUS[0]}
  set -e

  local context_ms
  context_ms="$(
    awk '
      /^\#[0-9]+ \[internal\] load build context/ { id = $1 }
      id != "" && $1 == id && /DONE [0-9.]+s/ {
        for (i = 1; i <= NF; i++) {
          if ($i == "DONE") {
            val = $(i + 1)
            sub(/s$/, "", val)
            print int(val * 1000)
          }
        }
      }
    ' "$output_file" | tail -n 1
  )"
  if [[ -n "$context_ms" ]]; then
    deploy_common_log_timing "context-upload" "$context_ms"
  else
    log "context upload timing unavailable; see docker build '[internal] load build context' output"
  fi

  rm -f "$output_file"
  return "$status"
}

rollback() {
  trap - ERR
  deploy_common_emit_stage "rollback"
  local ROLLBACK_START
  ROLLBACK_START="$(deploy_common_stopwatch_start)"
  log "rollback: restoring git + previous ${SERVICE} image"
  deploy_common_rollback_git "$ROOT" "$OLD_HEAD" || true
  if [[ -n "$BACKUP_IMAGE" ]] && docker image inspect "$BACKUP_IMAGE" >/dev/null 2>&1; then
    docker tag "$BACKUP_IMAGE" "$PORTAL_IMAGE"
    docker compose -f "$COMPOSE" up -d --no-build --force-recreate "$SERVICE" || true
  else
    log "rollback: backup image missing; rebuilding previous ${SERVICE} image"
    deploy_common_run_heavy "deploy-queue:${SERVICE}:rollback-build" \
      docker compose -f "$COMPOSE" build "$SERVICE"
    docker compose -f "$COMPOSE" up -d --no-build "$SERVICE" || true
  fi
  deploy_common_log_timing "rollback" "$(deploy_common_stopwatch_elapsed_ms "$ROLLBACK_START")"
  cleanup_backup_image
}

trap 'rollback' ERR

tag_current_portal_image

deploy_common_emit_stage "build"
BUILD_START="$(deploy_common_stopwatch_start)"
log "docker build ${SERVICE}"
run_portal_build
deploy_common_log_timing "build" "$(deploy_common_stopwatch_elapsed_ms "$BUILD_START")"

deploy_common_emit_stage "restart"
RESTART_START="$(deploy_common_stopwatch_start)"
log "docker up ${SERVICE} (prebuilt image)"
docker compose -f "$COMPOSE" up -d --no-build "$SERVICE"
deploy_common_log_timing "container-start" "$(deploy_common_stopwatch_elapsed_ms "$RESTART_START")"
deploy_common_log_timing "restart" "$(deploy_common_stopwatch_elapsed_ms "$RESTART_START")"

deploy_common_emit_stage "health"
HEALTH_START="$(deploy_common_stopwatch_start)"
log "health check portal /login"
if ! deploy_common_wait_http_2xx_3xx "http://127.0.0.1:3000/login" "app.connectcomunications.com" 180 2; then
  rollback
  fail "portal health check failed (requested by ${REQ})"
fi
deploy_common_log_timing "health" "$(deploy_common_stopwatch_elapsed_ms "$HEALTH_START")"

trap - ERR
deploy_common_emit_stage "done"
cleanup_backup_image
deploy_common_log_timing "total" "$(deploy_common_stopwatch_elapsed_ms "$JOB_START_NS")"
log "done $(git rev-parse --short HEAD) requested_by=${REQ}"
