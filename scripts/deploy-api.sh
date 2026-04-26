#!/usr/bin/env bash
# Deploy API only (Docker service `api`). Safe for ops/deploy-queue worker.
# - Runs Prisma migrate deploy (ONLY this script among per-service deploys).
# - Restarts only the `api` compose service.
#
# Env (set by worker or manually):
#   DEPLOY_REPO_ROOT   default /opt/connectcomms/app
#   DEPLOY_BRANCH      required unless DEPLOY_COMMIT set
#   DEPLOY_COMMIT      optional SHA (detached); wins over branch
#   DEPLOY_REQUESTED_BY
#   DEPLOY_COMPOSE_FILE default docker-compose.app.yml
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib/deploy-common.sh"

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
  log "DRY RUN — no git/docker/prisma/health changes"
  log "Would: git sync (branch=${BRANCH:-} commit=${COMMIT:-}), pnpm install if lock changed,"
  log "  prisma migrate deploy, docker compose build/up ${SERVICE}, curl /health"
  log "(requested_by=${REQ})"
  exit 0
fi

LOCK_BEFORE="$(deploy_common_lock_hash)"
OLD_HEAD="$(deploy_common_git_sync "$ROOT" "${BRANCH:-main}" "$COMMIT")"
LOCK_AFTER="$(deploy_common_lock_hash)"

deploy_common_maybe_pnpm_install "deploy-queue:${SERVICE}" "$LOCK_BEFORE" "$LOCK_AFTER"
deploy_common_export_database_url

rollback() {
  trap - ERR
  log "rollback: restoring git + rebuilding ${SERVICE}"
  deploy_common_rollback_git "$ROOT" "$OLD_HEAD" || true
  deploy_common_run_heavy "deploy-queue:${SERVICE}:rollback-build" \
    docker compose -f "$COMPOSE" build "$SERVICE"
  docker compose -f "$COMPOSE" up -d "$SERVICE" || true
}

trap 'rollback' ERR

log "prisma migrate deploy (api deploy only)"
deploy_common_run_heavy "deploy-queue:${SERVICE}:prisma" \
  pnpm --filter @connect/db exec prisma migrate deploy --schema prisma/schema.prisma

log "docker build ${SERVICE}"
deploy_common_run_heavy "deploy-queue:${SERVICE}:compose-build" \
  docker compose -f "$COMPOSE" build "$SERVICE"

log "docker up ${SERVICE}"
docker compose -f "$COMPOSE" up -d "$SERVICE"

log "health check http://127.0.0.1:3001/health"
ok=0
for i in $(seq 1 45); do
  if curl -sfS --connect-timeout 2 --max-time 15 "http://127.0.0.1:3001/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done
if [[ "$ok" != "1" ]]; then
  rollback
  fail "health check failed after deploy (requested by ${REQ})"
fi

trap - ERR
log "done $(git rev-parse --short HEAD) requested_by=${REQ}"
