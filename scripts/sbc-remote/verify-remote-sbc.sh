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

echo "[verify-remote-sbc] checking SSH connectivity"
ssh_remote "echo ok >/dev/null"

kam_ok="$(ssh_remote "docker ps --filter name=sbc-kamailio --filter status=running --format '{{.Names}}' | awk 'NF{c++} END{print (c>0)?"yes":"no"}'")"
rtp_ok="$(ssh_remote "docker ps --filter name=sbc-rtpengine --filter status=running --format '{{.Names}}' | awk 'NF{c++} END{print (c>0)?"yes":"no"}'")"
tcp_ok="$(ssh_remote "ss -lntup 2>/dev/null | awk '/:5060|:5061|:7443/ {c++} END{print (c>0)?"yes":"no"}'")"
udp_ok="$(ssh_remote "ss -lunp 2>/dev/null | awk '/:2223|rtpengine/ {c++} END{print (c>0)?"yes":"no"}'")"

ws_probe="$(curl -ksS -m 8 -i -N   -H 'Connection: Upgrade'   -H 'Upgrade: websocket'   -H "Host: ${REMOTE_HOST}"   -H 'Origin: https://app.connectcomunications.com'   -H 'Sec-WebSocket-Key: U2JjUmVtb3RlVmVyaWZ5'   -H 'Sec-WebSocket-Version: 13'   "https://${REMOTE_HOST}:7443" || true)"

if awk 'BEGIN{IGNORECASE=1} /101|websocket|sec-websocket/{f=1} END{exit f?0:1}' <<<"$ws_probe"; then
  ws_ok="yes"
else
  ws_ok="no"
fi

echo "RESULT kamailio_running=${kam_ok} rtpengine_running=${rtp_ok} tcp_listeners=${tcp_ok} udp_ctrl=${udp_ok} wss_probe=${ws_ok}"

if [[ "$kam_ok" == "yes" && "$rtp_ok" == "yes" && "$tcp_ok" == "yes" && "$udp_ok" == "yes" && "$ws_ok" == "yes" ]]; then
  echo "PASS"
  exit 0
fi

echo "FAIL"
exit 1
