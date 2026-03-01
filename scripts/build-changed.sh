#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log(){ echo "[build:changed] $*"; }

normalize_pkg() {
  local v="${1,,}"
  case "$v" in
    api|@connect/api) echo "api" ;;
    portal|@connect/portal) echo "portal" ;;
    worker|@connect/worker) echo "worker" ;;
    mobile|@connect/mobile) echo "mobile" ;;
    db|@connect/db) echo "db" ;;
    integrations|@connect/integrations) echo "integrations" ;;
    *) echo "" ;;
  esac
}

declare -A wanted=()

if [[ -n "${CHANGED_PKGS:-}" ]]; then
  log "using CHANGED_PKGS override: ${CHANGED_PKGS}"
  IFS=',' read -r -a items <<< "$CHANGED_PKGS"
  for item in "${items[@]}"; do
    n="$(normalize_pkg "$item")"
    [[ -n "$n" ]] && wanted["$n"]=1
  done
else
  base_ref="${BASE_REF:-}"
  if [[ -z "$base_ref" ]]; then
    if git describe --tags --abbrev=0 >/dev/null 2>&1; then
      base_ref="$(git describe --tags --abbrev=0)"
    elif git rev-parse --verify origin/main >/dev/null 2>&1; then
      base_ref="origin/main"
    else
      base_ref="$(git rev-list --max-parents=0 HEAD)"
    fi
  fi

  log "detecting changed files since: ${base_ref}"
  changed="$(git diff --name-only "${base_ref}...HEAD" || true)"
  if [[ -z "$changed" ]]; then
    changed="$(git diff --name-only || true)"
  fi

  if [[ -z "$changed" ]]; then
    log "no changed files detected"
  else
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      case "$f" in
        apps/api/*) wanted[api]=1 ;;
        apps/portal/*) wanted[portal]=1 ;;
        apps/worker/*) wanted[worker]=1 ;;
        apps/mobile/*) wanted[mobile]=1 ;;
        packages/db/*) wanted[db]=1 ;;
        packages/integrations/*) wanted[integrations]=1 ;;
        package.json|pnpm-lock.yaml|pnpm-workspace.yaml|turbo.json)
          wanted[api]=1
          wanted[portal]=1
          wanted[worker]=1
          wanted[mobile]=1
          wanted[db]=1
          wanted[integrations]=1
          ;;
      esac
    done <<< "$changed"
  fi
fi

if [[ ${#wanted[@]} -eq 0 ]]; then
  log "no buildable packages selected"
  exit 0
fi

run_build() {
  local short="$1"
  local filter="$2"
  log "building ${filter}"
  /opt/connectcomms/ops/run-heavy.sh "build:changed:${short}" -- pnpm --filter "$filter" build
}

for p in api worker portal mobile db integrations; do
  [[ -n "${wanted[$p]:-}" ]] || continue
  case "$p" in
    api) run_build api @connect/api ;;
    worker) run_build worker @connect/worker ;;
    portal) run_build portal @connect/portal ;;
    mobile) run_build mobile @connect/mobile ;;
    db) run_build db @connect/db ;;
    integrations) run_build integrations @connect/integrations ;;
  esac
 done

log "done"
