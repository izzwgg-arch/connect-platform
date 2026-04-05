#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: scripts/release/deploy-tag.sh <tag>" >&2
  exit 2
fi

REQ_TAG="$1"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ "${_DEPLOY_LOCKED:-0}" != "1" ]]; then
  exec /opt/connectcomms/ops/run-heavy.sh "deploy-tag:${REQ_TAG}" -- env _DEPLOY_LOCKED=1 bash "$0" "$REQ_TAG"
fi

log(){ echo "[deploy-tag] $*"; }
fail(){ echo "[deploy-tag] FAIL: $*" >&2; exit 1; }


run_heavy() {
  local label="$1"
  shift
  if [[ "${_DEPLOY_LOCKED:-0}" == "1" ]]; then
    "$@"
  else
    /opt/connectcomms/ops/run-heavy.sh "$label" -- "$@"
  fi
}

git diff --quiet || fail "working tree has unstaged changes"
git diff --cached --quiet || fail "working tree has staged changes"

git fetch --tags --quiet

git rev-parse -q --verify "refs/tags/${REQ_TAG}" >/dev/null || fail "tag not found: ${REQ_TAG}"

target_commit="$(git rev-list -n1 "refs/tags/${REQ_TAG}")"
current_commit="$(git rev-parse HEAD)"

current_lock_hash="$(sha256sum pnpm-lock.yaml 2>/dev/null | awk '{print $1}' || true)"

if [[ "$current_commit" != "$target_commit" ]]; then
  log "checking out tag ${REQ_TAG} (detached HEAD)"
  git checkout --detach "refs/tags/${REQ_TAG}" >/dev/null
else
  log "already at requested tag commit ${REQ_TAG}"
fi

new_lock_hash="$(sha256sum pnpm-lock.yaml 2>/dev/null | awk '{print $1}' || true)"
if [[ "${current_lock_hash}" != "${new_lock_hash}" ]]; then
  log "lockfile changed -> running pnpm install"
  run_heavy "deploy:${REQ_TAG}:pnpm-install" pnpm install --frozen-lockfile
else
  log "lockfile unchanged -> skipping pnpm install"
fi

DB_URL_FILE="/opt/connectcomms/env/.env.platform"
if [[ -f "$DB_URL_FILE" ]]; then
  raw_db_url="$(awk -F= '/^DATABASE_URL=/{print $2; exit}' "$DB_URL_FILE")"
  if [[ -n "$raw_db_url" ]]; then
    export DATABASE_URL="${raw_db_url//connectcomms-postgres/127.0.0.1}"
  fi
fi

log "running prisma migrate deploy"
run_heavy "deploy:${REQ_TAG}:prisma-migrate" pnpm --filter @connect/db exec prisma migrate deploy --schema prisma/schema.prisma

if [[ "${FORCE_REBUILD:-1}" == "1" ]]; then
  log "rebuilding api/portal/worker/realtime images"
  run_heavy "deploy:${REQ_TAG}:compose-build" docker compose -f docker-compose.app.yml up -d --build api portal worker realtime
else
  log "FORCE_REBUILD=0 -> restart only (no image rebuild)"
  run_heavy "deploy:${REQ_TAG}:compose-restart" docker compose -f docker-compose.app.yml restart api portal worker realtime
fi

# nginx returns 502 if clients hit during tsx/next startup — wait until localhost accepts traffic before smoke.
wait_http() {
  local url="$1"
  local label="$2"
  local attempts="${3:-45}"
  local delay="${4:-2}"
  local n=0
  while [[ "$n" -lt "$attempts" ]]; do
    if curl -sfS --connect-timeout 2 --max-time 15 "$url" >/dev/null 2>&1; then
      log "${label} accepting HTTP (${n}s after compose)"
      return 0
    fi
    n=$((n + 1))
    sleep "$delay"
  done
  fail "${label} did not become ready (${attempts} attempts, ${url})"
}

wait_http "http://127.0.0.1:3001/health" "api"
# Next may reset a few early connections; retry until /login returns 2xx/3xx.
wait_portal() {
  local attempts="${1:-60}"
  local n=0
  while [[ "$n" -lt "$attempts" ]]; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 25 \
      -H 'Host: app.connectcomunications.com' 'http://127.0.0.1:3000/login' 2>/dev/null || echo 000)"
    if [[ "$code" =~ ^(200|301|302|303|307|308)$ ]]; then
      log "portal accepting HTTP (${code}, ${n}s after compose)"
      return 0
    fi
    n=$((n + 1))
    sleep 2
  done
  fail "portal did not become ready (${attempts} attempts, http://127.0.0.1:3000/login)"
}
wait_portal

log "check migrations"
./scripts/check-migrations.sh

log "run smoke:fast"
pnpm smoke:fast

log "done commit=$(git rev-parse --short HEAD) tag=${REQ_TAG}"
