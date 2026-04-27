#!/usr/bin/env bash
# Shared helpers for scripts/deploy-*.sh (used by ops/deploy-queue worker).
# Do not run directly.
#
# The worker exports:
#   DEPLOY_REPO_ROOT, DEPLOY_BRANCH, DEPLOY_COMMIT, DEPLOY_REQUESTED_BY,
#   DEPLOY_JOB_ID, DEPLOY_QUEUE_STATE_DIR, DEPLOY_DRY_RUN
# All helpers here tolerate any of those being empty (manual runs still work).

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

# --------------------------------------------------------------------------
# Stage emission — writes a tiny JSON file the deploy-queue worker polls so
# /ops/deploy/jobs/:id can show currentStage + skipReason + deployedCommit
# without parsing logs. Atomic via rename-from-tmp so the worker never sees a
# half-written file.
# --------------------------------------------------------------------------

_deploy_common_state_file() {
  [[ -n "${DEPLOY_QUEUE_STATE_DIR:-}" && -n "${DEPLOY_JOB_ID:-}" ]] || return 1
  echo "${DEPLOY_QUEUE_STATE_DIR%/}/job-${DEPLOY_JOB_ID}.state.json"
}

# Current in-memory state keys (read back when emitting another key).
_DQ_STAGE=""
_DQ_SKIP_REASON=""
_DQ_DEPLOYED_COMMIT=""

_deploy_common_state_write() {
  local dest
  dest="$(_deploy_common_state_file)" || return 0
  mkdir -p "$(dirname "$dest")" 2>/dev/null || true
  local tmp="${dest}.tmp"
  {
    printf '{'
    local first=1
    if [[ -n "$_DQ_STAGE" ]]; then
      printf '"stage":"%s"' "$_DQ_STAGE"
      first=0
    fi
    if [[ -n "$_DQ_SKIP_REASON" ]]; then
      [[ $first -eq 1 ]] || printf ','
      printf '"skipReason":"%s"' "$_DQ_SKIP_REASON"
      first=0
    fi
    if [[ -n "$_DQ_DEPLOYED_COMMIT" ]]; then
      [[ $first -eq 1 ]] || printf ','
      printf '"deployedCommit":"%s"' "$_DQ_DEPLOYED_COMMIT"
    fi
    printf '}\n'
  } > "$tmp" 2>/dev/null || return 0
  mv -f "$tmp" "$dest" 2>/dev/null || true
}

# Publish the current coarse-grained stage.
# Allowed examples: git-sync, install, change-detect, migrate, build, restart, health, rollback, done
deploy_common_emit_stage() {
  local stage="$1"
  _DQ_STAGE="$stage"
  _deploy_common_state_write
  echo "[deploy-common] stage=${stage}"
}

# Publish a short-circuit reason (no_changes, unrelated_paths, …). Caller
# should still exit 0 so the queue records `success` with skipReason set.
deploy_common_emit_skip() {
  local reason="$1"
  _DQ_SKIP_REASON="$reason"
  _deploy_common_state_write
  echo "[deploy-common] skip=${reason}"
}

# Publish the SHA that was actually checked out (may differ from DEPLOY_COMMIT
# when branch was passed). Useful for audit trails.
deploy_common_emit_deployed_commit() {
  local sha="$1"
  _DQ_DEPLOYED_COMMIT="$sha"
  _deploy_common_state_write
}

# Stopwatch helpers — append timing to the job log so logs show the breakdown
# the AGENTS.md "Part 3.10" spec asks for.
deploy_common_stopwatch_start() {
  date +%s%N
}
deploy_common_stopwatch_elapsed_ms() {
  local start="$1"
  local now
  now="$(date +%s%N)"
  echo $(( (now - start) / 1000000 ))
}
deploy_common_log_timing() {
  local label="$1"
  local ms="$2"
  echo "[timing] ${label}=${ms}ms"
}

# --------------------------------------------------------------------------
# Git sync + change detection
# --------------------------------------------------------------------------

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

  local new_head
  new_head="$(git rev-parse HEAD)"
  deploy_common_emit_deployed_commit "$new_head"

  echo "$old_head"
}

deploy_common_head_sha() {
  git rev-parse HEAD
}

# Paths that should trigger a rebuild for a given service. Keep in sync with
# AGENTS.md "change detection" section.
_deploy_common_service_paths() {
  local service="$1"
  case "$service" in
    api)
      echo "apps/api/ packages/db/ packages/shared/ packages/integrations/ packages/security/ pnpm-lock.yaml package.json docker-compose.app.yml Dockerfile* tsconfig*.json"
      ;;
    portal)
      echo "apps/portal/ packages/shared/ packages/integrations/ pnpm-lock.yaml package.json docker-compose.app.yml Dockerfile* tsconfig*.json"
      ;;
    telephony)
      echo "apps/telephony/ packages/shared/ packages/integrations/ pnpm-lock.yaml package.json docker-compose.app.yml Dockerfile* tsconfig*.json"
      ;;
    realtime)
      echo "apps/realtime/ packages/shared/ packages/integrations/ pnpm-lock.yaml package.json docker-compose.app.yml Dockerfile* tsconfig*.json"
      ;;
    worker)
      echo "apps/worker/ packages/db/ packages/shared/ packages/integrations/ packages/security/ pnpm-lock.yaml package.json docker-compose.app.yml Dockerfile* tsconfig*.json"
      ;;
    *)
      echo ""
      ;;
  esac
}

# 0 = rebuild needed, 1 = skip rebuild.
# OLD_HEAD empty OR equal to HEAD → treated as "no change" (callers handle the
# extra no_changes vs unrelated_paths distinction).
deploy_common_needs_rebuild() {
  local service="$1"
  local old_head="$2"
  local new_head
  new_head="$(git rev-parse HEAD)"
  if [[ -z "$old_head" || "$old_head" == "$new_head" ]]; then
    return 1
  fi
  local paths
  paths="$(_deploy_common_service_paths "$service")"
  [[ -n "$paths" ]] || return 0
  # shellcheck disable=SC2086
  if git diff --name-only "${old_head}..${new_head}" -- $paths 2>/dev/null | grep -q .; then
    return 0
  fi
  return 1
}

# 0 = prisma migration should run (only for `api` deploys), 1 = skip.
deploy_common_needs_migrate() {
  local old_head="$1"
  local new_head
  new_head="$(git rev-parse HEAD)"
  if [[ -z "$old_head" || "$old_head" == "$new_head" ]]; then
    return 1
  fi
  if git diff --name-only "${old_head}..${new_head}" -- \
        'packages/db/prisma/schema.prisma' \
        'packages/db/prisma/migrations/' 2>/dev/null | grep -q .; then
    return 0
  fi
  return 1
}

# --------------------------------------------------------------------------
# Install (skip unless lockfile/package.json changed)
# --------------------------------------------------------------------------

deploy_common_lock_hash() {
  ( sha256sum pnpm-lock.yaml 2>/dev/null || shasum -a 256 pnpm-lock.yaml 2>/dev/null ) | awk '{print $1}'
}

deploy_common_pkg_hash() {
  ( sha256sum package.json 2>/dev/null || shasum -a 256 package.json 2>/dev/null ) | awk '{print $1}'
}

deploy_common_maybe_pnpm_install() {
  local label="$1"
  local before="$2"
  local after="$3"
  local pkg_before="${4:-}"
  local pkg_after="${5:-}"
  if [[ "$before" != "$after" || ( -n "$pkg_before" && "$pkg_before" != "$pkg_after" ) ]]; then
    deploy_common_log "lockfile/package.json changed -> pnpm install --prefer-offline"
    deploy_common_run_heavy "${label}:pnpm-install" \
      pnpm install --frozen-lockfile --prefer-offline --reporter=silent
  else
    deploy_common_log "lockfile + package.json unchanged -> skipping pnpm install"
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

# --------------------------------------------------------------------------
# Health checks — short timeout, few retries. Callers wrap with their own
# rollback on failure.
# --------------------------------------------------------------------------

deploy_common_wait_http_ok() {
  local url="$1"
  local attempts="${2:-30}"
  local delay="${3:-2}"
  local n=0
  while [[ "$n" -lt "$attempts" ]]; do
    if curl -sfS --connect-timeout 2 --max-time 10 "$url" >/dev/null 2>&1; then
      return 0
    fi
    n=$((n + 1))
    sleep "$delay"
  done
  return 1
}

# Accepts 2xx and common redirect codes (Next.js /login -> 307 etc.).
deploy_common_wait_http_2xx_3xx() {
  local url="$1"
  local host_hdr="${2:-}"
  local attempts="${3:-30}"
  local delay="${4:-2}"
  local n=0
  while [[ "$n" -lt "$attempts" ]]; do
    local args=(-sS -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 15)
    if [[ -n "$host_hdr" ]]; then args+=(-H "Host: ${host_hdr}"); fi
    local code
    code="$(curl "${args[@]}" "$url" 2>/dev/null || echo 000)"
    if [[ "$code" =~ ^(200|301|302|303|307|308)$ ]]; then
      return 0
    fi
    n=$((n + 1))
    sleep "$delay"
  done
  return 1
}
