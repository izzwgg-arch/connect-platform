#!/usr/bin/env bash
# Full-stack release: wraps scripts/release/deploy-tag.sh (same as manual tag deploy).
# Intended to be invoked ONLY via ops/deploy-queue (enqueue service `full-stack`).
# Sets DEPLOY_QUEUE_ACK=1 so deploy-tag.sh does not print the bypass warning.
#
# For this target, set DEPLOY_BRANCH to the git TAG name (e.g. v2.1.65), not a branch.
#
# Env:
#   DEPLOY_REPO_ROOT, DEPLOY_BRANCH (= tag), DEPLOY_DRY_RUN, DEPLOY_REQUESTED_BY
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib/deploy-common.sh"

ROOT="${DEPLOY_REPO_ROOT:-$ROOT}"
TAG="${DEPLOY_BRANCH:-}"
REQ="${DEPLOY_REQUESTED_BY:-manual}"

log() { echo "[deploy-full-stack] $*"; }
fail() { echo "[deploy-full-stack] FAIL: $*" >&2; exit 1; }

[[ -n "$TAG" ]] || fail "DEPLOY_BRANCH must be set to the release tag for full-stack deploys"

cd "$ROOT"
[[ -f scripts/release/deploy-tag.sh ]] || fail "scripts/release/deploy-tag.sh missing"

if [[ "${DEPLOY_DRY_RUN:-0}" == "1" ]]; then
  log "DRY RUN — no git/docker/migrate/smoke"
  log "Would: export DEPLOY_QUEUE_ACK=1 && bash scripts/release/deploy-tag.sh \"$TAG\""
  log "(requested_by=${REQ})"
  exit 0
fi

export DEPLOY_QUEUE_ACK=1
log "running deploy-tag.sh $TAG (requested_by=${REQ})"
bash "$ROOT/scripts/release/deploy-tag.sh" "$TAG"
