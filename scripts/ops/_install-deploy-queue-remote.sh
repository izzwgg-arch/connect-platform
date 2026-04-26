#!/usr/bin/env bash
set -euo pipefail
APP=/opt/connectcomms/app
cd "$APP"
echo "=== before ==="
git rev-parse --short HEAD
git remote -v

if ! git remote | grep -q '^izzwgg$'; then
  git remote add izzwgg https://github.com/izzwgg-arch/connect-platform.git
fi
git fetch izzwgg

git checkout main 2>/dev/null || git checkout -B main "izzwgg/main"
git merge --ff-only izzwgg/main

echo "=== after ==="
git rev-parse --short HEAD
test -f ops/deploy-queue/ecosystem.config.cjs && echo "ecosystem: OK" || { echo "ecosystem: MISSING"; exit 1; }

corepack enable 2>/dev/null || true
pnpm install --frozen-lockfile

# pnpm 10+ skips better-sqlite3 postinstall unless allowlisted; allowlisting breaks typical Windows dev installs.
# On Linux production, compile via npm in the resolved package dir (prebuild or node-gyp).
ensure_better_sqlite3_native() {
  shopt -s nullglob
  local dirs=( "$APP"/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 )
  shopt -u nullglob
  if ((${#dirs[@]} == 0)); then
    echo "better-sqlite3: package dir not found" >&2
    return 1
  fi
  local bs="${dirs[0]}"
  if [[ -f "$bs/build/Release/better_sqlite3.node" ]]; then
    echo "better-sqlite3: native binary OK"
    return 0
  fi
  echo "better-sqlite3: building native addon in $bs"
  (cd "$bs" && npm run install)
}
ensure_better_sqlite3_native
pnpm --filter connect-deploy-queue run build

ENV_FILE=/opt/connectcomms/env/.env.deploy-queue
LOG_DIR=/var/log/connect-deploys
mkdir -p "$LOG_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
  install -m 600 /dev/null "$ENV_FILE"
  echo "DEPLOY_QUEUE_TOKEN=$(openssl rand -hex 32)" >> "$ENV_FILE"
  echo "DEPLOY_REPO_ROOT=$APP" >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE" 2>/dev/null || true

if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

pm2 delete connect-deploy-worker 2>/dev/null || true
pm2 start "$APP/ops/deploy-queue/ecosystem.config.cjs" --only connect-deploy-worker
pm2 save

sleep 2
echo "=== health ==="
curl -sS http://127.0.0.1:3910/health && echo

echo "=== dry-run enqueue ==="
curl -sS -X POST "http://127.0.0.1:3910/ops/deploy/enqueue" \
  -H "Content-Type: application/json" \
  -H "x-deploy-queue-token: ${DEPLOY_QUEUE_TOKEN}" \
  -d '{"service":"api","branch":"main","requestedBy":"agent-fix","dryRun":true}' && echo

echo "=== pm2 status ==="
pm2 status connect-deploy-worker
