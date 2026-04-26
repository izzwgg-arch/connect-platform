#!/usr/bin/env bash
# Shared helpers for scripts/deploy-*.sh (used by ops/deploy-queue worker).
# Do not run directly.

deploy_common_log() { echo "[deploy-common] $*"; }

deploy_common_fail() { echo "[deploy-common] FAIL: $*" >&2; exit 1; }

# Optional: serialize heavy steps with the same helper full deploy-tag uses.
deploy_common_run_heavy() {
  local label="$1"
  shift
  if [[ -x /opt/connectcomms/ops/run-heavy.sh ]]; then
    /opt/connectcomms/ops/run-heavy.sh "$label" -- "$@"
  else
    "$@"
  fi
}

deploy_common_export_database_url() {
  local DB_URL_FILE="${DEPLOY_DB_URL_FILE:-/opt/connectcomms/env/.env.platform}"
  if [[ -f "$DB_URL_FILE" ]]; then
    local raw_db_url
    raw_db_url="$(awk -F= '/^DATABASE_URL=/{print $2; exit}' "$DB_URL_FILE")"
    if [[ -n "$raw_db_url" ]]; then
      export DATABASE_URL="${raw_db_url//connectcomms-postgres/127.0.0.1}"
    fi
  fi
}

deploy_common_git_sync() {
  local ROOT="$1"
  local BRANCH="$2"
  local COMMIT="${3:-}"
  export GIT_TERMINAL_PROMPT=0
  cd "$ROOT" || deploy_common_fail "cd $ROOT"

  git fetch origin --prune

  local old_head
  old_head="$(git rev-parse HEAD)"

  if [[ -n "$COMMIT" ]]; then
    git cat-file -e "${COMMIT}^{commit}" 2>/dev/null || deploy_common_fail "unknown commit: $COMMIT"
    git checkout --detach "$COMMIT"
  else
    git rev-parse --verify "origin/${BRANCH}" >/dev/null 2>&1 || deploy_common_fail "origin/${BRANCH} not found (git fetch origin?)"
    git checkout -B "$BRANCH" "origin/${BRANCH}"
    git pull --ff-only origin "$BRANCH" || deploy_common_fail "git pull --ff-only failed"
  fi

  echo "$old_head"
}

deploy_common_lock_hash() {
  ( sha256sum pnpm-lock.yaml 2>/dev/null || shasum -a 256 pnpm-lock.yaml 2>/dev/null ) | awk '{print $1}'
}

deploy_common_maybe_pnpm_install() {
  local label="$1"
  local before="$2"
  local after="$3"
  if [[ "$before" != "$after" ]]; then
    deploy_common_log "lockfile changed -> pnpm install"
    deploy_common_run_heavy "${label}:pnpm-install" pnpm install --frozen-lockfile
  else
    deploy_common_log "lockfile unchanged -> skipping pnpm install"
  fi
}

deploy_common_compose_file() {
  echo "${DEPLOY_COMPOSE_FILE:-docker-compose.app.yml}"
}

deploy_common_rollback_git() {
  local ROOT="$1"
  local OLD_HEAD="$2"
  cd "$ROOT" || return 1
  [[ -n "$OLD_HEAD" ]] || return 1
  git checkout "$OLD_HEAD" 2>/dev/null || true
}
