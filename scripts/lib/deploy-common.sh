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

deploy_common_resolve_target_commit() {
  local ROOT="$1"
  local BRANCH="$2"
  local COMMIT="${3:-}"
  local REF_KIND="${4:-branch}"
  cd "$ROOT" || deploy_common_fail "cd $ROOT"

  if [[ -n "$COMMIT" ]]; then
    git cat-file -e "${COMMIT}^{commit}" 2>/dev/null || deploy_common_fail "unknown commit: $COMMIT"
    git rev-parse "${COMMIT}^{commit}"
    return 0
  fi

  if [[ "$REF_KIND" == "tag" ]]; then
    [[ -n "$BRANCH" ]] || deploy_common_fail "tag is required"
    git rev-parse --verify "refs/tags/${BRANCH}^{commit}" 2>/dev/null || deploy_common_fail "tag not found: $BRANCH"
    return 0
  fi

  [[ -n "$BRANCH" ]] || deploy_common_fail "branch is required"
  git rev-parse --verify "origin/${BRANCH}^{commit}" 2>/dev/null || deploy_common_fail "origin/${BRANCH} not found (git fetch origin?)"
}

deploy_common_dry_run_checkout_safety() {
  local ROOT="$1"
  local BRANCH="$2"
  local COMMIT="${3:-}"
  local REF_KIND="${4:-branch}"
  export GIT_TERMINAL_PROMPT=0
  cd "$ROOT" || deploy_common_fail "cd $ROOT"

  deploy_common_emit_stage "dry-run"
  deploy_common_log "DRY RUN checkout safety: fetching refs"
  git fetch origin --prune --tags >&2 || deploy_common_fail "git fetch origin --prune --tags failed"

  local old_head target_head
  old_head="$(git rev-parse HEAD)" || deploy_common_fail "unable to read current HEAD"
  target_head="$(deploy_common_resolve_target_commit "$ROOT" "$BRANCH" "$COMMIT" "$REF_KIND")" || deploy_common_fail "unable to resolve target commit"
  deploy_common_emit_deployed_commit "$target_head"
  deploy_common_log "DRY RUN checkout safety: current=${old_head:0:12} target=${target_head:0:12}"

  local dirty_file changed_file blocking_file
  dirty_file="$(mktemp)" || deploy_common_fail "mktemp failed"
  changed_file="$(mktemp)" || deploy_common_fail "mktemp failed"
  blocking_file="$(mktemp)" || deploy_common_fail "mktemp failed"

  {
    git diff --name-only
    git diff --name-only --cached
    git ls-files --others --exclude-standard
  } | sort -u > "$dirty_file"

  git diff --name-only "${old_head}..${target_head}" | sort -u > "$changed_file"
  comm -12 "$dirty_file" "$changed_file" > "$blocking_file"

  if [[ -s "$blocking_file" ]]; then
    deploy_common_log "DRY RUN checkout safety: BLOCKED; dirty paths would be overwritten by target checkout:"
    sed 's/^/[deploy-common]   /' "$blocking_file" >&2
    rm -f "$dirty_file" "$changed_file" "$blocking_file"
    deploy_common_fail "dry-run checkout safety failed; clean/commit/port the blocking paths before real deploy"
  fi

  deploy_common_log "DRY RUN checkout safety: OK; no dirty paths overlap target changes"
  deploy_common_log "DRY RUN checkout safety: dirty_path_count=$(wc -l < "$dirty_file" | tr -d '[:space:]') target_changed_path_count=$(wc -l < "$changed_file" | tr -d '[:space:]')"
  rm -f "$dirty_file" "$changed_file" "$blocking_file"
}

deploy_common_git_sync() {
  local ROOT="$1"
  local BRANCH="$2"
  local COMMIT="${3:-}"
  export GIT_TERMINAL_PROMPT=0
  cd "$ROOT" || deploy_common_fail "cd $ROOT"

  # Redirect all git output to stderr so the command substitution that captures
  # the return value of this function (the old HEAD SHA) is not polluted by
  # git's fast-forward summary, fetch progress, or checkout messages.
  git fetch origin --prune >&2 || deploy_common_fail "git fetch origin --prune failed"

  local old_head
  old_head="$(git rev-parse HEAD)"

  if [[ -n "$COMMIT" ]]; then
    git cat-file -e "${COMMIT}^{commit}" 2>/dev/null || deploy_common_fail "unknown commit: $COMMIT"
    git checkout --detach "$COMMIT" >&2 || deploy_common_fail "git checkout --detach $COMMIT failed"
  else
    git rev-parse --verify "origin/${BRANCH}" >/dev/null 2>&1 || deploy_common_fail "origin/${BRANCH} not found (git fetch origin?)"
    git checkout -B "$BRANCH" "origin/${BRANCH}" >&2 || deploy_common_fail "git checkout -B $BRANCH origin/$BRANCH failed"
    git pull --ff-only origin "$BRANCH" >&2 || deploy_common_fail "git pull --ff-only failed"
  fi

  local new_head
  new_head="$(git rev-parse HEAD)"
  deploy_common_emit_deployed_commit "$new_head"

  # Only the SHA reaches stdout — the caller captures it via $()
  echo "$old_head"
}

deploy_common_head_sha() {
  git rev-parse HEAD
}

# --------------------------------------------------------------------------
# Per-service "last successfully deployed" commit tracker.
#
# The shared checkout means `git rev-parse HEAD` before a sync only reflects
# what the *previous deploy job* left behind — not what this service itself
# last rebuilt. When three services deploy back-to-back for the same new
# commit, the first advances HEAD; the second and third see OLD_HEAD ==
# NEW_HEAD and falsely skip their own build/restart.
#
# Fix: persist each service's last-deployed SHA to
#   ${DEPLOY_QUEUE_STATE_DIR}/last-deployed/<service>.sha
# Deploy scripts should use this value (when present) as OLD_HEAD, and
# call `deploy_common_mark_deployed <service>` at the very end of a
# successful build/restart cycle.
# --------------------------------------------------------------------------

_deploy_common_last_deployed_path() {
  local service="$1"
  [[ -n "${DEPLOY_QUEUE_STATE_DIR:-}" ]] || return 1
  echo "${DEPLOY_QUEUE_STATE_DIR%/}/last-deployed/${service}.sha"
}

# Echo the SHA of the last successful deploy for the given service, or empty
# string if no state file exists yet (first-ever deploy, or state dir unset).
deploy_common_last_deployed_commit() {
  local service="$1"
  local f
  if ! f="$(_deploy_common_last_deployed_path "$service" 2>/dev/null)"; then
    return 0
  fi
  [[ -n "$f" && -f "$f" ]] || return 0
  local sha
  sha="$(tr -d '[:space:]' < "$f")"
  echo "$sha"
}

# Record that <service> is now deployed at <sha>. Call this on the success
# path of deploy-<service>.sh only — never after a failure or rollback.
deploy_common_mark_deployed() {
  local service="$1"
  local sha="$2"
  local f
  if ! f="$(_deploy_common_last_deployed_path "$service" 2>/dev/null)"; then
    return 0
  fi
  [[ -n "$f" && -n "$sha" ]] || return 0
  mkdir -p "$(dirname "$f")" 2>/dev/null || true
  local tmp="${f}.tmp"
  printf '%s' "$sha" > "$tmp" 2>/dev/null || return 0
  mv -f "$tmp" "$f" 2>/dev/null || true
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

# Safe compose up: prune any Dead or Created containers for the service before
# recreating. Without this, Docker Compose can rename the dead container
# (e.g. f61e75b52945_app-api-1) and start the new one with the wrong name,
# which breaks health checks and leaves orphan containers behind.
deploy_common_compose_up() {
  local compose_file="$1"
  local service="$2"
  # Remove any stopped/dead/created containers for this service so Docker
  # Compose gets a clean slate. `rm -sf` is a no-op when nothing matches.
  docker compose -f "$compose_file" rm -sf "$service" 2>/dev/null || true
  docker compose -f "$compose_file" up -d "$service"
}

deploy_common_rollback_git() {
  local ROOT="$1"
  local OLD_HEAD="$2"
  cd "$ROOT" || return 1
  [[ -n "$OLD_HEAD" ]] || return 1
  git checkout "$OLD_HEAD" 2>/dev/null || true
}

# --------------------------------------------------------------------------
# Health checks — short per-attempt curl timeout; callers choose attempt count
# and sleep between tries. Callers wrap with their own rollback on failure.
# Retries stay quiet; one diagnostic line is logged only after the last try.
# --------------------------------------------------------------------------

deploy_common_wait_http_ok() {
  local url="$1"
  local attempts="${2:-30}"
  local delay="${3:-2}"
  local n=0
  local bodyf errf
  bodyf="$(mktemp 2>/dev/null || echo "/tmp/deploy_wait_http_ok_body.$$")"
  errf="$(mktemp 2>/dev/null || echo "/tmp/deploy_wait_http_ok_err.$$")"
  while [[ "$n" -lt "$attempts" ]]; do
    if curl -sfS --connect-timeout 2 --max-time 10 "$url" >/dev/null 2>&1; then
      rm -f "$bodyf" "$errf" 2>/dev/null || true
      return 0
    fi
    n=$((n + 1))
    sleep "$delay"
  done
  # Final diagnostic probe.
  #
  # Must run under `set +e` because bash 4.4/5.x fires the caller's ERR trap
  # for a variable-assignment whose command-substitution returns non-zero, even
  # when the assignment is guarded by `||`.  In deploy-api.sh that trap is
  # `rollback`, which would abort this function before the log line runs — the
  # confirmed root cause of "wait_http_ok FAILED" never appearing in logs.
  local http_code curl_ec snippet err_snip httpf
  http_code="000"; curl_ec=0; snippet=""; err_snip=""
  httpf="$(mktemp 2>/dev/null || printf '%s' "/tmp/deploy_wait_http_ok_http.$$")"
  set +e
  curl -sS -o "$bodyf" --write-out '%{http_code}' \
       --connect-timeout 2 --max-time 10 "$url" >"$httpf" 2>"$errf"
  curl_ec=$?
  http_code="$(cat "$httpf" 2>/dev/null)"
  [[ -n "$http_code" ]] || http_code="000"
  snippet="$(head -c 256 "$bodyf" 2>/dev/null | tr '\n\r' '  ')"
  err_snip="$(head -c 200 "$errf" 2>/dev/null | tr '\n\r' '  ')"
  deploy_common_log "wait_http_ok FAILED after ${attempts} tries url=${url} http_code=${http_code} curl_exit=${curl_ec} body_snippet=${snippet} stderr_snippet=${err_snip}"
  rm -f "$bodyf" "$errf" "$httpf" 2>/dev/null || true
  # Re-enable errexit before returning so the caller's set -e is restored.
  # return 1 does not trigger ERR trap in bash 4.4+ (return is not a simple
  # command for ERR-trap purposes), but we restore set -e regardless.
  set -e
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
