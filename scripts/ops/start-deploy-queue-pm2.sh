#!/usr/bin/env bash
# Load deploy-queue secrets then start (or restart) the PM2 process.
# Usage on server:
#   bash scripts/ops/start-deploy-queue-pm2.sh
#
# Requires: /opt/connectcomms/env/.env.deploy-queue with at least DEPLOY_QUEUE_TOKEN=...
set -euo pipefail
ENV_FILE="${DEPLOY_QUEUE_ENV_FILE:-/opt/connectcomms/env/.env.deploy-queue}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ECO="$ROOT/ops/deploy-queue/ecosystem.config.cjs"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE (create it; see docs/safe-deploy-queue.md)" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -z "${DEPLOY_QUEUE_TOKEN:-}" ]]; then
  echo "DEPLOY_QUEUE_TOKEN must be set in $ENV_FILE" >&2
  exit 2
fi

cd "$ROOT"
pnpm --filter connect-deploy-queue run build
pm2 startOrReload "$ECO" --only connect-deploy-worker
pm2 save
