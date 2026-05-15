#!/usr/bin/env bash
# Blue/green portal deploy helpers — sourced only from scripts/deploy-portal.sh
# Depends: deploy-common.sh already sourced
set -euo pipefail

deploy_portal_rollout_upstream_file() {
  echo "${DEPLOY_NGINX_PORTAL_UPSTREAM_ACTIVE_FILE:-/opt/connectcomms/nginx/connect-portal-upstream-active.conf}"
}

deploy_portal_nginx_sudo() {
  if command -v sudo >/dev/null 2>&1 && [[ "${EUID:-$(id -u)}" != "0" ]]; then
    sudo -n "$@"
  else
    "$@"
  fi
}

deploy_portal_rollout_read_active_port() {
  local f="$1"
  [[ -f "$f" ]] || { echo "3000"; return 0; }
  local p
  p="$(grep -oE '127\.0\.0\.1:[0-9]+' "$f" 2>/dev/null | head -1 | cut -d: -f2)"
  [[ -n "$p" ]] || p="3000"
  echo "$p"
}

deploy_portal_rollout_write_upstream_port() {
  local port="$1"
  local file="$2"
  mkdir -p "$(dirname "$file")"
  umask 022
  printf 'server 127.0.0.1:%s;\n' "$port" >"${file}.tmp.$$"
  mv -f "${file}.tmp.$$" "$file"
}

deploy_portal_rollout_backup_upstream() {
  local file="$1"
  local tag="${2:-bak}"
  [[ -f "$file" ]] || return 0
  cp -a "$file" "${file}.pre-${tag}"
}

deploy_portal_rollout_nginx_test_reload() {
  local t0
  t0="$(deploy_common_stopwatch_start)"
  if ! deploy_portal_nginx_sudo nginx -t >/dev/null 2>&1; then
    deploy_portal_nginx_sudo nginx -t 2>&1 || true
    return 1
  fi
  if ! deploy_portal_nginx_sudo nginx -s reload; then
    return 1
  fi
  deploy_common_log_timing "nginx_reload" "$(deploy_common_stopwatch_elapsed_ms "$t0")"
  return 0
}

deploy_portal_rollout_wait_ready() {
  local url="$1"
  local attempts="${2:-120}"
  local delay="${3:-2}"
  local n=0
  local curl_tls=()
  local curl_resolve=()
  if [[ "${DEPLOY_PORTAL_PUBLIC_VERIFY_TLS_INSECURE:-0}" == "1" ]] && [[ "$url" =~ ^https:// ]]; then
    curl_tls=(-k)
  fi
  # Avoid hairpin probes: curl https://public-host/ from the app server may hit nginx deny rules
  # when the client address is the server's own public IP. Mapping the hostname to 127.0.0.1 keeps
  # the client as loopback while still exercising TLS + nginx + upstream (SNI unchanged).
  if [[ "${DEPLOY_PORTAL_PUBLIC_VERIFY_RESOLVE_LOCAL:-0}" == "1" ]] && [[ "$url" =~ ^https://([^/:?#]+) ]]; then
    curl_resolve=(--resolve "${BASH_REMATCH[1]}:443:127.0.0.1")
  fi
  while [[ "$n" -lt "$attempts" ]]; do
    if curl "${curl_tls[@]}" "${curl_resolve[@]}" -fsS --connect-timeout 2 --max-time 15 "$url" >/dev/null 2>&1; then
      return 0
    fi
    n=$((n + 1))
    sleep "$delay"
  done
  return 1
}

deploy_portal_rollout_recreate_stable() {
  local compose_file="$1"
  docker compose -f "$compose_file" up -d --no-deps --force-recreate portal
}

deploy_portal_rollout_stop_candidate() {
  local compose_file="$1"
  docker compose -f "$compose_file" --profile portal_rollout stop portal_candidate 2>/dev/null || true
  docker compose -f "$compose_file" --profile portal_rollout rm -sf portal_candidate 2>/dev/null || true
}

# $1 compose $2 ROOT $3 REQ $4 job tag for backup names
deploy_portal_rollout_run() {
  local COMPOSE="$1"
  local ROOT="$2"
  local REQ="$3"
  local JOB_TAG="${4:-job}"

  local UPSTREAM
  UPSTREAM="$(deploy_portal_rollout_upstream_file)"
  local STABLE_PORT="3000"
  local CAND_PORT="3005"
  local ACTIVE_BEFORE
  ACTIVE_BEFORE="$(deploy_portal_rollout_read_active_port "$UPSTREAM")"

  deploy_common_log "[deploy-portal-rollout] upstream_file=${UPSTREAM} active_port_before=${ACTIVE_BEFORE} candidate_port=${CAND_PORT} stable_port=${STABLE_PORT}"

  if [[ ! -f "$UPSTREAM" ]] && [[ "${DEPLOY_PORTAL_UPSTREAM_BOOTSTRAP:-0}" != "1" ]]; then
    echo "[deploy-portal] FAIL: nginx upstream active file missing: $UPSTREAM" >&2
    echo "  Install from docs/nginx/connect-portal-upstream-active.snippet (see docs/nginx/README.md)" >&2
    echo "  Or set DEPLOY_NGINX_PORTAL_UPSTREAM_ACTIVE_FILE." >&2
    echo "  One-time bootstrap: create 'server 127.0.0.1:3000;' + DEPLOY_PORTAL_UPSTREAM_BOOTSTRAP=1" >&2
    return 1
  fi

  if [[ ! -f "$UPSTREAM" ]] && [[ "${DEPLOY_PORTAL_UPSTREAM_BOOTSTRAP:-0}" == "1" ]]; then
    deploy_common_log "[deploy-portal-rollout] bootstrapping upstream file -> :${STABLE_PORT}"
    deploy_portal_rollout_write_upstream_port "$STABLE_PORT" "$UPSTREAM"
    if ! deploy_portal_rollout_nginx_test_reload; then
      echo "[deploy-portal] FAIL: nginx test/reload failed during portal upstream bootstrap" >&2
      return 1
    fi
  fi

  deploy_portal_rollout_backup_upstream "$UPSTREAM" "${JOB_TAG}"

  local t_cand
  t_cand="$(deploy_common_stopwatch_start)"
  deploy_common_log "[deploy-portal-rollout] starting portal_candidate on :${CAND_PORT}"
  docker compose -f "$COMPOSE" --profile portal_rollout up -d --force-recreate portal_candidate
  deploy_common_log_timing "portal_candidate_start" "$(deploy_common_stopwatch_elapsed_ms "$t_cand")"

  local t_ready
  t_ready="$(deploy_common_stopwatch_start)"
  if ! deploy_portal_rollout_wait_ready "http://127.0.0.1:${CAND_PORT}/ready"; then
    echo "[deploy-portal] FAIL: candidate /ready never became healthy http://127.0.0.1:${CAND_PORT}/ready" >&2
    docker logs --tail=200 app-portal-candidate-1 2>&1 || true
    deploy_portal_rollout_stop_candidate "$COMPOSE"
    return 1
  fi
  deploy_common_log_timing "portal_candidate_readiness" "$(deploy_common_stopwatch_elapsed_ms "$t_ready")"

  local t_nginx1
  t_nginx1="$(deploy_common_stopwatch_start)"
  deploy_portal_rollout_write_upstream_port "$CAND_PORT" "$UPSTREAM"
  if ! deploy_portal_rollout_nginx_test_reload; then
    deploy_common_log "[deploy-portal-rollout] nginx failed after pointing to candidate — restoring ${ACTIVE_BEFORE}"
    deploy_portal_rollout_write_upstream_port "${ACTIVE_BEFORE}" "$UPSTREAM"
    deploy_portal_rollout_nginx_test_reload || true
    deploy_portal_rollout_stop_candidate "$COMPOSE"
    return 1
  fi
  deploy_common_log_timing "portal_cutover_to_candidate" "$(deploy_common_stopwatch_elapsed_ms "$t_nginx1")"

  local verify_url="${DEPLOY_PORTAL_PUBLIC_VERIFY_URL:-}"
  if [[ -n "$verify_url" ]]; then
    if [[ "${DEPLOY_PORTAL_PUBLIC_VERIFY_RESOLVE_LOCAL:-0}" == "1" ]]; then
      deploy_common_log "[deploy-portal-rollout] public verify via loopback SNI (DEPLOY_PORTAL_PUBLIC_VERIFY_RESOLVE_LOCAL=1 curl --resolve host:443:127.0.0.1)"
    fi
    if ! deploy_portal_rollout_wait_ready "${verify_url}" 30 2; then
      echo "[deploy-portal] FAIL: DEPLOY_PORTAL_PUBLIC_VERIFY_URL not ready after cutover: ${verify_url}" >&2
      deploy_portal_rollout_write_upstream_port "${ACTIVE_BEFORE}" "$UPSTREAM"
      deploy_portal_rollout_nginx_test_reload || true
      deploy_portal_rollout_stop_candidate "$COMPOSE"
      return 1
    fi
  fi

  local t_stable
  t_stable="$(deploy_common_stopwatch_start)"
  deploy_common_log "[deploy-portal-rollout] recreating stable portal on :${STABLE_PORT} (traffic on candidate)"
  deploy_portal_rollout_recreate_stable "$COMPOSE"
  deploy_common_log_timing "portal_stable_recreate" "$(deploy_common_stopwatch_elapsed_ms "$t_stable")"

  local t_ready2
  t_ready2="$(deploy_common_stopwatch_start)"
  if ! deploy_portal_rollout_wait_ready "http://127.0.0.1:${STABLE_PORT}/ready"; then
    echo "[deploy-portal] FAIL: stable /ready failed after recreate — nginx back to candidate" >&2
    deploy_portal_rollout_write_upstream_port "$CAND_PORT" "$UPSTREAM"
    deploy_portal_rollout_nginx_test_reload || true
    return 1
  fi
  deploy_common_log_timing "portal_stable_readiness" "$(deploy_common_stopwatch_elapsed_ms "$t_ready2")"

  local t_nginx2
  t_nginx2="$(deploy_common_stopwatch_start)"
  deploy_portal_rollout_write_upstream_port "$STABLE_PORT" "$UPSTREAM"
  if ! deploy_portal_rollout_nginx_test_reload; then
    deploy_common_log "[deploy-portal-rollout] CRITICAL: nginx failed when normalizing to stable — leaving active on candidate :${CAND_PORT}; fix manually"
    return 1
  fi
  deploy_common_log_timing "portal_cutover_to_stable" "$(deploy_common_stopwatch_elapsed_ms "$t_nginx2")"

  if [[ -n "$verify_url" ]]; then
    if ! deploy_portal_rollout_wait_ready "${verify_url}" 30 2; then
      echo "[deploy-portal] FAIL: public verify after stable normalization: ${verify_url}" >&2
      return 1
    fi
  fi

  local t_drain
  t_drain="$(deploy_common_stopwatch_start)"
  deploy_portal_rollout_stop_candidate "$COMPOSE"
  deploy_common_log_timing "portal_candidate_drain_remove" "$(deploy_common_stopwatch_elapsed_ms "$t_drain")"

  deploy_common_log "[deploy-portal-rollout] done job=${JOB_TAG} nginx_active_port=${STABLE_PORT}"
  return 0
}

deploy_portal_rollout_dry_run_steps() {
  cat <<'EOF'
Blue/green portal deploy (when DEPLOY_PORTAL_BLUEGREEN=1 and upstream include exists):
  1. docker compose build portal + build portal_candidate
  2. docker compose --profile portal_rollout up -d portal_candidate -> host 127.0.0.1:3005
  3. wait http://127.0.0.1:3005/ready (lightweight Route Handler JSON)
  4. write DEPLOY_NGINX_PORTAL_UPSTREAM_ACTIVE_FILE -> server 127.0.0.1:3005;
  5. nginx -t && nginx -s reload
  6. (optional) DEPLOY_PORTAL_PUBLIC_VERIFY_URL — HTTPS after cutover; set DEPLOY_PORTAL_PUBLIC_VERIFY_RESOLVE_LOCAL=1 on origin hosts where hairpin public URL gets nginx 403
  7. docker compose up -d --no-deps --force-recreate portal -> 127.0.0.1:3000
  8. wait http://127.0.0.1:3000/ready
  9. write upstream -> server 127.0.0.1:3000; nginx -t && reload
 10. stop + rm portal_candidate
EOF
}
