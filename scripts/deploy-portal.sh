#!/usr/bin/env bash
# Deploy portal only (Docker service `portal`). Does NOT run Prisma migrations.
# Skips build/restart when the target commit matches the deployed commit or
# when the diff touches no portal-relevant paths.
#
# Env: same as deploy-api.sh (DEPLOY_REPO_ROOT, DEPLOY_BRANCH, DEPLOY_COMMIT, …)
#
# Blue/green (default DEPLOY_PORTAL_BLUEGREEN=1):
#   DEPLOY_NGINX_PORTAL_UPSTREAM_ACTIVE_FILE — nginx include (single line server 127.0.0.1:PORT;)
#   DEPLOY_PORTAL_UPSTREAM_BOOTSTRAP=1 — one-time seed include -> :3000
#   DEPLOY_PORTAL_PUBLIC_VERIFY_URL — optional curl after nginx cutovers
#   DEPLOY_PORTAL_PUBLIC_VERIFY_RESOLVE_LOCAL=1 — PREFER curl --resolve host:443:127.0.0.1 for HTTPS (avoids hairpin 403);
#     falls back to ordinary DNS when nothing listens on 127.0.0.1:443, so a missing loopback listener cannot roll back a
#     healthy deploy (it did, platform-wide, on 2026-08-21)
#   DEPLOY_PORTAL_PUBLIC_VERIFY_TLS_INSECURE=1 — curl -k for HTTPS verify URLs
#   DEPLOY_PORTAL_BLUEGREEN=0 — legacy compose_up (docker rm -sf gap on :3000)
#
# Verify stage, CSP wasm check (round 21, 2026-09-17 — see the verify stage below):
#   DEPLOY_PORTAL_SKIP_CSP_CHECK=1 — skip the post-deploy check that the public CSP
#     script-src still carries 'wasm-unsafe-eval' (needed for the desk-phone scan
#     page's on-device barcode decoder to run at all). Skip only where there is no
#     public nginx in front of the portal to check.
#   DEPLOY_PORTAL_CSP_CHECK_HOST — hostname to probe (default app.loopcom.net)
#
# Rollback: docs/ai-context/DEPLOYMENT_PORTAL_ROLLBACK.md
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib/deploy-common.sh"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib/deploy-portal-rollout.sh"

ROOT="${DEPLOY_REPO_ROOT:-$ROOT}"
SERVICE="portal"
COMPOSE="$(deploy_common_compose_file)"
BRANCH="${DEPLOY_BRANCH:-}"
COMMIT="${DEPLOY_COMMIT:-}"
REQ="${DEPLOY_REQUESTED_BY:-manual}"

log() { echo "[deploy-portal] $*"; }
fail() { echo "[deploy-portal] FAIL: $*" >&2; exit 1; }

[[ -n "$BRANCH" || -n "$COMMIT" ]] || fail "DEPLOY_BRANCH or DEPLOY_COMMIT is required"
cd "$ROOT"
[[ -f "$COMPOSE" ]] || fail "compose file missing: $COMPOSE"

if [[ "${DEPLOY_DRY_RUN:-0}" == "1" ]]; then
  log "DRY RUN — checkout safety + clone sync (no docker/prisma/build); see steps below"
  deploy_common_dry_run_checkout_safety "$ROOT" "${BRANCH:-main}" "$COMMIT"
  _dry_pre=""
  deploy_common_git_sync "$ROOT" "${BRANCH:-main}" "$COMMIT" _dry_pre
  _dry_new="$(deploy_common_head_sha)"
  if [[ "$_dry_pre" != "$_dry_new" ]]; then
    log "[deploy-portal] DRY RUN: tree advanced ${_dry_pre:0:12}→${_dry_new:0:12}; re-exec for latest deploy-portal.sh"
    exec bash "$ROOT/scripts/deploy-portal.sh"
  fi
  log "Would next: pnpm install if needed,"
  log "  docker compose build portal [+ portal_candidate when DEPLOY_PORTAL_BLUEGREEN=${DEPLOY_PORTAL_BLUEGREEN:-1}], rollout OR legacy compose up"
  log "Portal blue/green steps when DEPLOY_PORTAL_BLUEGREEN=${DEPLOY_PORTAL_BLUEGREEN:-1}:"
  deploy_portal_rollout_dry_run_steps | while IFS= read -r line; do log "  $line"; done
  log "(branch=${BRANCH:-} commit=${COMMIT:-} requested_by=${REQ})"
  exit 0
fi

JOB_START_NS="$(deploy_common_stopwatch_start)"

deploy_common_emit_stage "git-sync"
LOCK_BEFORE="$(deploy_common_lock_hash)"
PKG_BEFORE="$(deploy_common_pkg_hash)"
PERSISTED_OLD_HEAD="$(deploy_common_last_deployed_commit "$SERVICE" || true)"
if [[ -z "$PERSISTED_OLD_HEAD" ]]; then
  PERSISTED_OLD_HEAD="$(docker exec app-portal-1 sh -lc 'cat /app/.build-commit 2>/dev/null | tr -d "\r\n"' 2>/dev/null || true)"
fi
PRE_SYNC_HEAD=""
deploy_common_git_sync "$ROOT" "${BRANCH:-main}" "$COMMIT" PRE_SYNC_HEAD
OLD_HEAD="${PERSISTED_OLD_HEAD:-$PRE_SYNC_HEAD}"
NEW_HEAD="$(deploy_common_head_sha)"
LOCK_AFTER="$(deploy_common_lock_hash)"
PKG_AFTER="$(deploy_common_pkg_hash)"

if [[ "$PRE_SYNC_HEAD" != "$NEW_HEAD" ]]; then
  log "[deploy-portal] checkout advanced ${PRE_SYNC_HEAD:0:12}→${NEW_HEAD:0:12}; re-exec deploy-portal.sh"
  exec bash "$ROOT/scripts/deploy-portal.sh"
fi

deploy_common_emit_stage "change-detect"
# ⛔⛔ A "no_changes" SKIP IS ONLY HONEST WHEN WE KNOW WHAT IS DEPLOYED.
# Proven on production 2026-09-16: DEPLOY_QUEUE_STATE_DIR was unset (no marker)
# AND app-portal-1:/app/.build-commit was 1 byte (a bare newline), so
# PERSISTED_OLD_HEAD came back empty and OLD_HEAD fell back to PRE_SYNC_HEAD --
# which the re-exec above had ALREADY advanced to the new commit. The script
# then compared the new commit against itself, reported
# "deployed commit already at <new sha> -- skipping", exited 0, and shipped
# NOTHING. The deploy said success; the container kept running the old code.
# An unknown baseline must mean BUILD, never SKIP: a wasted rebuild costs
# minutes, a false skip costs a person believing a fix is live when it is not.
if [[ "$OLD_HEAD" == "$NEW_HEAD" ]]; then
  if [[ -z "$PERSISTED_OLD_HEAD" ]]; then
    log "⛔ no record of what is deployed (no state marker, no /app/.build-commit) - refusing to skip; rebuilding to be certain"
  else
    deploy_common_emit_stage "done"
    deploy_common_emit_skip "no_changes"
    log "deployed commit already at ${NEW_HEAD:0:12} — skipping install/build/restart"
    exit 0
  fi
fi

if ! deploy_common_needs_rebuild "$SERVICE" "$OLD_HEAD"; then
  deploy_common_mark_deployed "$SERVICE" "$NEW_HEAD"
  deploy_common_emit_stage "done"
  deploy_common_emit_skip "unrelated_paths"
  log "commit changed ${OLD_HEAD:0:12}..${NEW_HEAD:0:12} but no portal-relevant paths changed — skipping build/restart"
  exit 0
fi

deploy_common_emit_stage "install"
INSTALL_START="$(deploy_common_stopwatch_start)"
deploy_common_maybe_pnpm_install "deploy-queue:${SERVICE}" "$LOCK_BEFORE" "$LOCK_AFTER" "$PKG_BEFORE" "$PKG_AFTER"
deploy_common_log_timing "install" "$(deploy_common_stopwatch_elapsed_ms "$INSTALL_START")"

rollback() {
  trap - ERR
  deploy_common_emit_stage "rollback"
  log "rollback: restoring git + rebuilding ${SERVICE} (stop portal_candidate if present)"
  deploy_portal_rollout_stop_candidate "$COMPOSE" 2>/dev/null || true
  deploy_common_rollback_git "$ROOT" "$OLD_HEAD" || true
  deploy_common_run_heavy "deploy-queue:${SERVICE}:rollback-build" \
    docker compose -f "$COMPOSE" build "$SERVICE"
  deploy_common_compose_up "$COMPOSE" "$SERVICE" || true
}

trap 'rollback' ERR

deploy_common_emit_stage "build"
BUILD_START="$(deploy_common_stopwatch_start)"
if [[ "${DEPLOY_PORTAL_BLUEGREEN:-1}" == "1" ]]; then
  log "docker build portal + portal_candidate (shared Dockerfile)"
  deploy_common_run_heavy "deploy-queue:${SERVICE}:compose-build-portal" \
    docker compose -f "$COMPOSE" build --build-arg BUILD_COMMIT="$NEW_HEAD" portal
  deploy_common_run_heavy "deploy-queue:${SERVICE}:compose-build-portal-candidate" \
    docker compose -f "$COMPOSE" --profile portal_rollout build --build-arg BUILD_COMMIT="$NEW_HEAD" portal_candidate
else
  log "docker build ${SERVICE} (DEPLOY_PORTAL_BLUEGREEN=0)"
  deploy_common_run_heavy "deploy-queue:${SERVICE}:compose-build" \
    docker compose -f "$COMPOSE" build --build-arg BUILD_COMMIT="$NEW_HEAD" "$SERVICE"
fi
deploy_common_log_timing "build" "$(deploy_common_stopwatch_elapsed_ms "$BUILD_START")"

trap - ERR
deploy_common_emit_stage "restart"
RESTART_START="$(deploy_common_stopwatch_start)"
JOB_TAG="${DEPLOY_JOB_ID:-manual}"
if [[ "${DEPLOY_PORTAL_BLUEGREEN:-1}" == "1" ]]; then
  if ! deploy_portal_rollout_run "$COMPOSE" "$ROOT" "$REQ" "$JOB_TAG"; then
    fail "blue/green portal rollout failed (requested by ${REQ}); see docs/ai-context/DEPLOYMENT_PORTAL_ROLLBACK.md"
  fi
else
  log "docker up ${SERVICE} (legacy deploy_common_compose_up)"
  deploy_common_compose_up "$COMPOSE" "$SERVICE"
fi
deploy_common_log_timing "restart" "$(deploy_common_stopwatch_elapsed_ms "$RESTART_START")"

trap 'rollback' ERR

deploy_common_emit_stage "health"
HEALTH_START="$(deploy_common_stopwatch_start)"
log "health check portal /login on stable :3000"
if ! deploy_common_wait_http_2xx_3xx "http://127.0.0.1:3000/login" "app.connectcomunications.com" 45 2; then
  rollback
  fail "portal health check failed (requested by ${REQ})"
fi
deploy_common_log_timing "health" "$(deploy_common_stopwatch_elapsed_ms "$HEALTH_START")"

VERIFY_START="$(deploy_common_stopwatch_start)"
deploy_common_emit_stage "verify"
verify_ok=1
container_commit="$(docker exec app-portal-1 sh -lc 'cat /app/.build-commit 2>/dev/null | tr -d "\r\n"' || true)"
if [[ -z "$container_commit" || "$container_commit" != "$NEW_HEAD" ]]; then
  log "verify: commit mismatch or missing (/app/.build-commit='${container_commit:0:12}', expected ${NEW_HEAD:0:12})"
  verify_ok=0
fi
if ! docker exec app-portal-1 sh -lc "grep -R -n -F 'sync-last' /app/apps/portal/.next 2>/dev/null | head -n 1 >/dev/null"; then
  log "verify: expected marker 'sync-last' not found in compiled bundle"
  verify_ok=0
fi

# ⛔⛔ Round 21 (2026-09-17): the customer scan page's on-device barcode decoder needs
# 'wasm-unsafe-eval' in the portal's CSP script-src, or WebAssembly.instantiate() throws
# SILENTLY (the page's own catch swallows it and falls back to the slow photo path) —
# live for a full day before anyone noticed, because the only check anyone had run
# proved the wasm FILE downloads (200, application/wasm), which says nothing about
# whether it can COMPILE. That header lives on the SERVER (nginx's shared
# security-headers.conf), not in this repo, so a deploy can never FIX a missing one —
# but it can catch a server-side regression (a config restore, a rebuilt nginx image,
# anybody hand-editing the shared file) before a customer notices instead of after.
# DEPLOY_PORTAL_SKIP_CSP_CHECK=1 skips this probe, for an environment with no public
# nginx in front of the portal yet (the check needs the real HTTPS edge, not :3000
# directly — that header is injected by nginx, never by the Next.js app itself).
if [[ "${DEPLOY_PORTAL_SKIP_CSP_CHECK:-0}" != "1" ]]; then
  csp_host="${DEPLOY_PORTAL_CSP_CHECK_HOST:-app.loopcom.net}"
  csp_url="https://${csp_host}/phone-setup/x"
  csp_tls=()
  [[ "${DEPLOY_PORTAL_PUBLIC_VERIFY_TLS_INSECURE:-0}" == "1" ]] && csp_tls=(-k)
  # Reuse the SAME loopback-preferred / DNS-fallback resolve logic the public verify
  # probe above uses, for the SAME reason (2026-08-21: a hairpin 403 on the server's
  # own public IP once rolled back a perfectly healthy deploy).
  csp_specs=()
  while IFS= read -r _spec; do csp_specs+=("$_spec"); done < <(deploy_portal_rollout_probe_resolve_specs "$csp_url")
  csp_ok=0
  csp_reached=0
  for spec in "${csp_specs[@]}"; do
    csp_resolve=()
    [[ -n "$spec" ]] && csp_resolve=(--resolve "$spec")
    csp_headers="$(curl "${csp_tls[@]}" "${csp_resolve[@]}" -sI --connect-timeout 3 --max-time 15 "$csp_url" 2>/dev/null || true)"
    [[ -n "$csp_headers" ]] && csp_reached=1
    if printf '%s' "$csp_headers" | grep -i '^content-security-policy:' | grep -qi 'wasm-unsafe-eval'; then
      csp_ok=1
      break
    fi
  done
  if [[ "$csp_ok" -ne 1 ]]; then
    if [[ "$csp_reached" -ne 1 ]]; then
      # ⛔ A probe that could not CONNECT proves nothing about the header, and rolling a
      # healthy portal back over a transient edge hiccup is the exact 2026-08-21 mistake.
      # Say it loudly; never fail the deploy on it.
      log "verify: WARNING could not reach ${csp_url} to check the CSP header (connection failure, not a bad status) — check 'curl -sI https://app.loopcom.net | grep -i content-security' by hand"
    else
      # The edge answered and the header is missing 'wasm-unsafe-eval': a real server-side
      # regression that silently kills the scan page. Fail loudly (rollback runs below) so
      # nobody reads "success" while customers cannot scan.
      log "verify: CSP script-src lacks 'wasm-unsafe-eval' — the customer scan page's on-device decoder cannot run (round 21, 2026-09-17); fix /etc/nginx/connectcomms/security-headers.conf"
      verify_ok=0
    fi
  fi
fi

deploy_common_log_timing "verify" "$(deploy_common_stopwatch_elapsed_ms "$VERIFY_START")"
if [[ "$verify_ok" -ne 1 ]]; then
  rollback
  fail "portal verification failed (commit and/or marker check)"
fi

trap - ERR
deploy_common_mark_deployed "$SERVICE" "$NEW_HEAD"
deploy_common_emit_stage "done"
deploy_common_log_timing "total" "$(deploy_common_stopwatch_elapsed_ms "$JOB_START_NS")"
log "done $(git rev-parse --short HEAD) requested_by=${REQ}"
