#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-}"
REMOTE_USER="${REMOTE_USER:-root}"
REMOTE_PORT="${REMOTE_PORT:-22}"
REMOTE_DIR="${REMOTE_DIR:-/opt/connectcomms-sbc}"
REMOTE_SSH_KEY="${REMOTE_SSH_KEY:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) REMOTE_HOST="${2:-}"; shift 2 ;;
    --user) REMOTE_USER="${2:-}"; shift 2 ;;
    --port) REMOTE_PORT="${2:-}"; shift 2 ;;
    --dir) REMOTE_DIR="${2:-}"; shift 2 ;;
    --key) REMOTE_SSH_KEY="${2:-}"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 --host <remote-host> [--user root] [--port 22] [--dir /opt/connectcomms-sbc] [--key /path/key]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$REMOTE_HOST" ]]; then
  echo "REMOTE_HOST is required (or use --host)." >&2
  exit 2
fi

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=8 -p "$REMOTE_PORT")
if [[ -n "$REMOTE_SSH_KEY" ]]; then
  SSH_OPTS+=(-i "$REMOTE_SSH_KEY")
fi

ssh_remote(){
  ssh "${SSH_OPTS[@]}" "${REMOTE_USER}@${REMOTE_HOST}" "$@"
}

echo "[rollback-remote-sbc] checking SSH connectivity"
ssh_remote "echo ok >/dev/null"

echo "[rollback-remote-sbc] stopping remote SBC stack"
ssh_remote "cd '$REMOTE_DIR' && docker compose -f docker-compose.sbc.yml down >/dev/null 2>&1 || true"

echo "[rollback-remote-sbc] removing remote rollout contents from ${REMOTE_DIR}"
ssh_remote "bash -s" <<REMOTE_CLEAN
set -euo pipefail
if [[ -d "$REMOTE_DIR" ]]; then
  rm -rf "$REMOTE_DIR"/* "$REMOTE_DIR"/.[!.]* "$REMOTE_DIR"/..?* 2>/dev/null || true
fi
REMOTE_CLEAN

echo "PASS"
