#!/usr/bin/env bash
# SSH wrapper: run scripts/deploy-direct.sh on the Connect app host.
# Push your branch/commit to origin before running.
#
# Usage:
#   bash scripts/release/deploy-direct.sh api --branch main
#   bash scripts/release/deploy-direct.sh portal --commit <sha> --dry-run
#
# Env:
#   DEPLOY_SSH_TARGET   default: connect (ssh config alias) or root@45.14.194.179
#   DEPLOY_SSH_KEY      optional path to private key
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE=""
REMOTE_ARGS=()

usage() {
  echo "Usage: bash scripts/release/deploy-direct.sh <api|portal> (--branch NAME | --commit SHA) [--dry-run]" >&2
  exit 1
}

[[ $# -ge 1 ]] || usage
SERVICE="$1"
shift
[[ "$SERVICE" == "api" || "$SERVICE" == "portal" ]] || usage

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch|--commit|--dry-run|--skip-queue-check)
      REMOTE_ARGS+=("$1")
      if [[ "$1" == "--branch" || "$1" == "--commit" ]]; then
        REMOTE_ARGS+=("${2:?$1 requires a value}")
        shift
      fi
      ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
  shift
done

SSH_TARGET="${DEPLOY_SSH_TARGET:-connect}"
SSH_KEY="${DEPLOY_SSH_KEY:-}"

ssh_cmd=(ssh -o ConnectTimeout=20 -o BatchMode=yes)
if [[ -n "$SSH_KEY" && -f "$SSH_KEY" ]]; then
  ssh_cmd+=(-i "$SSH_KEY")
fi

REMOTE_CMD="cd /opt/connectcomms/app && git fetch origin --prune && bash scripts/deploy-direct.sh ${SERVICE}"
for arg in "${REMOTE_ARGS[@]}"; do
  REMOTE_CMD+=" $(printf '%q' "$arg")"
done

echo "[deploy-direct-ssh] target=${SSH_TARGET} service=${SERVICE}"
echo "[deploy-direct-ssh] remote: ${REMOTE_CMD}"
"${ssh_cmd[@]}" "$SSH_TARGET" "$REMOTE_CMD"
