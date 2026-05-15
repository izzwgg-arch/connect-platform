#!/usr/bin/env bash
# Blue/green API deploy helpers — sourced only from scripts/deploy-api.sh
# Depends: deploy-common.sh already sourced (deploy_common_log, stopwatch, …)
set -euo pipefail

deploy_api_rollout_upstream_file() {
  echo "${DEPLOY_NGINX_API_UPSTREAM_ACTIVE_FILE:-/opt/connectcomms/nginx/connect-api-upstream-active.conf}"
}

deploy_api_nginx_sudo() {
  if command -v sudo >/dev/null 2>&1 && [[ "${EUID:-$(id -u)}" != "0" ]]; then
    sudo -n "$@"
  else
    "$@"
  fi
}

# Parse host port from snippet line: server 127.0.0.1:3001;
deploy_api_rollout_read_active_port() {
  local f="$1"
  [[ -f "$f" ]] || { echo "3001"; return 0; }
  local p
  p="$(grep -oE '127\.0\.0\.1:[0-9]+' "$f" 2>/dev/null | head -1 | cut -d: -f2)"
  [[ -n "$p" ]] || p="3001"
  echo "$p"
}

deploy_api_rollout_write_upstream_port() {
  local port="$1"
  local file="$2"
  mkdir -p "$(dirname "$file")"
  umask 022
  printf 'server 127.0.0.1:%s;\n' "$port" >"${file}.tmp.$$"
  mv -f "${file}.tmp.$$" "$file"
}

deploy_api_rollout_backup_upstream() {
  local file="$1"
  local tag="${2:-bak}"
  [[ -f "$file" ]] || return 0
  cp -a "$file" "${file}.pre-${tag}"
}

deploy_api_rollout_nginx_test_reload() {
  local t0
  t0="$(deploy_common_stopwatch_start)"
  if ! deploy_api_nginx_sudo nginx -t >/dev/null 2>&1; then
    deploy_api_nginx_sudo nginx -t 2>&1 || true
    return 1
  fi
  if ! deploy_api_nginx_sudo nginx -s reload; then
    return 1
  fi
  deploy_common_log_timing "nginx_reload" "$(deploy_common_stopwatch_elapsed_ms "$t0")"
  return 0
}

deploy_api_rollout_wait_ready() {
  local url="$1"
  local attempts="${2:-120}"
  local delay="${3:-2}"
  local n=0
  local curl_tls=()
  local curl_resolve=()
  if [[ "${DEPLOY_API_PUBLIC_VERIFY_TLS_INSECURE:-0}" == "1" ]] && [[ "$url" =~ ^https:// ]]; then
    curl_tls=(-k)
  fi
  # Avoid hairpin probes: curl https://public-host/ from the app server may hit nginx deny rules
  # when the client address is the server's own public IP. Mapping the hostname to 127.0.0.1 keeps
  # the client as loopback while still exercising TLS + nginx + upstream (SNI unchanged).
  if [[ "${DEPLOY_API_PUBLIC_VERIFY_RESOLVE_LOCAL:-0}" == "1" ]] && [[ "$url" =~ ^https://([^/:?#]+) ]]; then
    curl_resolve=(--resolve "${BASH_REMATCH[1]}:443:127.0.0.1")
  fi
  while [[ "$n" -lt "$attempts" ]]; do
    if curl "${curl_tls[@]}" "${curl_resolve[@]}" -fsS --connect-timeout 2 --max-time 15 "$url" >/dev/null 2>&1; then
      return 0
    fi
    n=$((n + 1))
    sleep "$delay"
  done
  if [[ "$url" =~ ^https:// ]]; then
    local http_code=""
    http_code="$(curl "${curl_tls[@]}" "${curl_resolve[@]}" -o /dev/null -sS -w '%{http_code}' --connect-timeout 2 --max-time 15 "$url" 2>/dev/null || true)"
    [[ -z "$http_code" ]] && http_code="000"
    deploy_common_log "[deploy-api-rollout] public verify probe failed: url=${url} http_code=${http_code} resolve_local=${DEPLOY_API_PUBLIC_VERIFY_RESOLVE_LOCAL:-0} tls_insecure=${DEPLOY_API_PUBLIC_VERIFY_TLS_INSECURE:-0}"
  fi
  return 1
}

# Recreate stable api (port 3001) after a new image tag — no rm -sf; traffic may be on :3004 during this window.
deploy_api_rollout_recreate_stable() {
  local compose_file="$1"
  docker compose -f "$compose_file" up -d --no-deps --force-recreate api
}

# Remove candidate container after successful normalization.
deploy_api_rollout_stop_candidate() {
  local compose_file="$1"
  docker compose -f "$compose_file" --profile api_rollout stop api_candidate 2>/dev/null || true
  docker compose -f "$compose_file" --profile api_rollout rm -sf api_candidate 2>/dev/null || true
}

# $1 compose $2 ROOT $3 REQ $4 job id tag for backup names
deploy_api_rollout_run() {
  local COMPOSE="$1"
  local ROOT="$2"
  local REQ="$3"
  local JOB_TAG="${4:-job}"

  local UPSTREAM
  UPSTREAM="$(deploy_api_rollout_upstream_file)"
  local STABLE_PORT="3001"
  local CAND_PORT="3004"
  local ACTIVE_BEFORE
  ACTIVE_BEFORE="$(deploy_api_rollout_read_active_port "$UPSTREAM")"

  deploy_common_log "[deploy-api-rollout] upstream_file=${UPSTREAM} active_port_before=${ACTIVE_BEFORE} candidate_port=${CAND_PORT} stable_port=${STABLE_PORT}"

  if [[ ! -f "$UPSTREAM" ]] && [[ "${DEPLOY_API_UPSTREAM_BOOTSTRAP:-0}" != "1" ]]; then
    echo "[deploy-api] FAIL: nginx upstream active file missing: $UPSTREAM" >&2
    echo "  Install the snippet from docs/nginx/connect-api-upstream-active.snippet (see docs/nginx/README.md)" >&2
    echo "  Or set DEPLOY_NGINX_API_UPSTREAM_ACTIVE_FILE to the include path nginx reads." >&2
    echo "  One-time bootstrap: create the file with 'server 127.0.0.1:3001;' and set DEPLOY_API_UPSTREAM_BOOTSTRAP=1" >&2
    return 1
  fi

  if [[ ! -f "$UPSTREAM" ]] && [[ "${DEPLOY_API_UPSTREAM_BOOTSTRAP:-0}" == "1" ]]; then
    deploy_common_log "[deploy-api-rollout] bootstrapping upstream file -> :${STABLE_PORT}"
    deploy_api_rollout_write_upstream_port "$STABLE_PORT" "$UPSTREAM"
    if ! deploy_api_rollout_nginx_test_reload; then
      echo "[deploy-api] FAIL: nginx test/reload failed during upstream bootstrap" >&2
      return 1
    fi
  fi

  deploy_api_rollout_backup_upstream "$UPSTREAM" "${JOB_TAG}"

  local t_cand
  t_cand="$(deploy_common_stopwatch_start)"
  deploy_common_log "[deploy-api-rollout] starting api_candidate on :${CAND_PORT}"
  docker compose -f "$COMPOSE" --profile api_rollout up -d --force-recreate api_candidate
  deploy_common_log_timing "candidate_start" "$(deploy_common_stopwatch_elapsed_ms "$t_cand")"

  local t_ready
  t_ready="$(deploy_common_stopwatch_start)"
  if ! deploy_api_rollout_wait_ready "http://127.0.0.1:${CAND_PORT}/ready"; then
    echo "[deploy-api] FAIL: candidate /ready never became healthy http://127.0.0.1:${CAND_PORT}/ready" >&2
    docker logs --tail=200 app-api-candidate-1 2>&1 || true
    deploy_api_rollout_stop_candidate "$COMPOSE"
    return 1
  fi
  deploy_common_log_timing "candidate_readiness" "$(deploy_common_stopwatch_elapsed_ms "$t_ready")"

  local t_nginx1
  t_nginx1="$(deploy_common_stopwatch_start)"
  deploy_api_rollout_write_upstream_port "$CAND_PORT" "$UPSTREAM"
  if ! deploy_api_rollout_nginx_test_reload; then
    deploy_common_log "[deploy-api-rollout] nginx failed after pointing to candidate — restoring ${ACTIVE_BEFORE}"
    deploy_api_rollout_write_upstream_port "${ACTIVE_BEFORE}" "$UPSTREAM"
    deploy_api_rollout_nginx_test_reload || true
    deploy_api_rollout_stop_candidate "$COMPOSE"
    return 1
  fi
  deploy_common_log_timing "cutover_to_candidate" "$(deploy_common_stopwatch_elapsed_ms "$t_nginx1")"

  local verify_url="${DEPLOY_API_PUBLIC_VERIFY_URL:-}"
  if [[ -n "$verify_url" ]]; then
    if [[ "${DEPLOY_API_PUBLIC_VERIFY_RESOLVE_LOCAL:-0}" == "1" ]]; then
      deploy_common_log "[deploy-api-rollout] public verify via loopback SNI (DEPLOY_API_PUBLIC_VERIFY_RESOLVE_LOCAL=1 curl --resolve host:443:127.0.0.1)"
    fi
    if ! deploy_api_rollout_wait_ready "${verify_url}" 30 2; then
      echo "[deploy-api] FAIL: public verify URL not ready after cutover: ${verify_url}" >&2
      deploy_api_rollout_write_upstream_port "${ACTIVE_BEFORE}" "$UPSTREAM"
      deploy_api_rollout_nginx_test_reload || true
      deploy_api_rollout_stop_candidate "$COMPOSE"
      return 1
    fi
  fi

  local t_stable
  t_stable="$(deploy_common_stopwatch_start)"
  deploy_common_log "[deploy-api-rollout] recreating stable api on :${STABLE_PORT} (traffic still on candidate via nginx)"
  deploy_api_rollout_recreate_stable "$COMPOSE"
  deploy_common_log_timing "stable_recreate" "$(deploy_common_stopwatch_elapsed_ms "$t_stable")"

  local t_ready2
  t_ready2="$(deploy_common_stopwatch_start)"
  if ! deploy_api_rollout_wait_ready "http://127.0.0.1:${STABLE_PORT}/ready"; then
    echo "[deploy-api] FAIL: stable /ready failed after recreate — rolling nginx back to candidate" >&2
    deploy_api_rollout_write_upstream_port "$CAND_PORT" "$UPSTREAM"
    deploy_api_rollout_nginx_test_reload || true
    return 1
  fi
  deploy_common_log_timing "stable_readiness" "$(deploy_common_stopwatch_elapsed_ms "$t_ready2")"

  local t_nginx2
  t_nginx2="$(deploy_common_stopwatch_start)"
  deploy_api_rollout_write_upstream_port "$STABLE_PORT" "$UPSTREAM"
  if ! deploy_api_rollout_nginx_test_reload; then
    deploy_common_log "[deploy-api-rollout] CRITICAL: nginx failed when normalizing to stable — leaving active on candidate :${CAND_PORT}; fix nginx manually"
    return 1
  fi
  deploy_common_log_timing "cutover_to_stable" "$(deploy_common_stopwatch_elapsed_ms "$t_nginx2")"

  if [[ -n "$verify_url" ]]; then
    if ! deploy_api_rollout_wait_ready "${verify_url}" 30 2; then
      echo "[deploy-api] FAIL: public verify after stable normalization: ${verify_url}" >&2
      return 1
    fi
  fi

  local t_drain
  t_drain="$(deploy_common_stopwatch_start)"
  deploy_api_rollout_stop_candidate "$COMPOSE"
  deploy_common_log_timing "candidate_drain_remove" "$(deploy_common_stopwatch_elapsed_ms "$t_drain")"

  deploy_common_log "[deploy-api-rollout] done job=${JOB_TAG} nginx_active_port=${STABLE_PORT} (public path normalized to stable)"
  return 0
}

deploy_api_rollout_dry_run_steps() {
  cat <<'EOF'
Blue/green API deploy (when DEPLOY_API_BLUEGREEN=1 and upstream file exists):
  1. prisma migrate deploy (deploy-api.sh, only if schema/migrations changed)
  2. docker compose build api + build api_candidate
  3. docker compose --profile api_rollout up -d api_candidate  -> host 127.0.0.1:3004
  4. wait http://127.0.0.1:3004/ready
  5. write DEPLOY_NGINX_API_UPSTREAM_ACTIVE_FILE -> server 127.0.0.1:3004;
  6. nginx -t && nginx -s reload
  7. (optional) DEPLOY_API_PUBLIC_VERIFY_URL — curl GET; DEPLOY_API_PUBLIC_VERIFY_TLS_INSECURE=1 for https + -k; DEPLOY_API_PUBLIC_VERIFY_RESOLVE_LOCAL=1 to curl --resolve host:443:127.0.0.1 (hairpin nginx 403 from origin)
  8. docker compose up -d --no-deps --force-recreate api  -> 127.0.0.1:3001
  9. wait http://127.0.0.1:3001/ready
 10. write upstream file -> server 127.0.0.1:3001; nginx -t && reload
 11. stop + rm api_candidate
EOF
}
