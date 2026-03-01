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

scp_remote(){
  scp "${SSH_OPTS[@]}" "$@"
}

echo "[deploy-remote-sbc] checking SSH connectivity"
ssh_remote "echo ok >/dev/null"

echo "[deploy-remote-sbc] preparing remote host"
ssh_remote "bash -s" <<'REMOTE_PREP'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

if ! command -v docker >/dev/null 2>&1; then
  apt-get update -y >/dev/null
  apt-get install -y ca-certificates curl gnupg >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
  fi
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y >/dev/null
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi

systemctl enable --now docker >/dev/null 2>&1 || true
if ! docker compose version >/dev/null 2>&1; then
  apt-get update -y >/dev/null
  apt-get install -y docker-compose-plugin >/dev/null
fi
REMOTE_PREP

echo "[deploy-remote-sbc] syncing SBC assets"
ssh_remote "mkdir -p '$REMOTE_DIR/infra/sbc'"
scp_remote docker-compose.sbc.yml "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/docker-compose.sbc.yml"
scp_remote -r infra/sbc/kamailio "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/infra/sbc/"
scp_remote -r infra/sbc/rtpengine "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/infra/sbc/"

for candidate in   .env.sbc.example   infra/sbc/.env.example   infra/sbc/kamailio/.env.example   infra/sbc/rtpengine/.env.example

do
  if [[ -f "$candidate" ]]; then
    target_dir="${REMOTE_DIR}"
    if [[ "$candidate" == infra/* ]]; then
      target_dir="${REMOTE_DIR}/$(dirname "$candidate")"
      ssh_remote "mkdir -p '$target_dir'"
    fi
    scp_remote "$candidate" "${REMOTE_USER}@${REMOTE_HOST}:${target_dir}/$(basename "$candidate")"
  fi
done

echo "[deploy-remote-sbc] starting remote SBC stack"
ssh_remote "cd '$REMOTE_DIR' && docker compose -f docker-compose.sbc.yml up -d >/dev/null"

cat <<EOF
NEXT STEPS
- Suggested remote SBC WSS URL: wss://${REMOTE_HOST}:7443 (or your remote nginx WSS path)
- Open UDP 35000-35199 on the REMOTE SBC server for RTPengine media
- Verify with: scripts/sbc-remote/verify-remote-sbc.sh --host ${REMOTE_HOST}
EOF
