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

if [[ "${FORCE_REBUILD:-0}" == "1" ]]; then
  log "FORCE_REBUILD=1 -> compose up --build"
  run_heavy "deploy:${REQ_TAG}:compose-build" docker compose -f docker-compose.app.yml up -d --build api portal worker realtime
else
  log "restart only api/portal/worker/realtime"
  run_heavy "deploy:${REQ_TAG}:compose-restart" docker compose -f docker-compose.app.yml restart api portal worker realtime
fi

log "check migrations"
./scripts/check-migrations.sh

log "run smoke:fast"
pnpm smoke:fast

log "done commit=$(git rev-parse --short HEAD) tag=${REQ_TAG}"
