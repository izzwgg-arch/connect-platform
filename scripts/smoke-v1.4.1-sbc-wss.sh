#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR_LOCAL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_QUIET_SH="${SCRIPT_DIR_LOCAL}/ops/run-quiet.sh"
SCRIPT_BASENAME="$(basename "$0" .sh)"
LOG_DIR="${OPS_LOG_DIR:-/opt/connectcomms/ops/logs}"
LOG_TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_FILE_DEFAULT="${LOG_DIR}/${SCRIPT_BASENAME}-${LOG_TIMESTAMP}.log"

if [[ "${_QUIET_WRAPPED:-0}" != "1" ]]; then
  mkdir -p "$LOG_DIR"
  LOG_FILE="${LOG_FILE:-$LOG_FILE_DEFAULT}"
  export LOG_FILE
  exec "$RUN_QUIET_SH" "$SCRIPT_BASENAME" -- env _QUIET_WRAPPED=1 LOG_FILE="$LOG_FILE" bash "$0" "$@"
fi



DOMAIN="app.connectcomunications.com"
URL="https://${DOMAIN}/sip"

echo "[v1.4.1] starting SBC WSS smoke"

fail=0

for container in sbc-kamailio sbc-rtpengine; do
  if docker ps --format '{{.Names}}' | grep -qx "$container"; then
    echo "[v1.4.1] container OK: $container"
  else
    echo "[v1.4.1] container MISSING: $container"
    fail=1
  fi
done

resp="$(curl -i -sS -N --max-time 20 \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  -H "Host: ${DOMAIN}" \
  -H "Origin: https://${DOMAIN}" \
  -H 'Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==' \
  -H 'Sec-WebSocket-Version: 13' \
  "$URL" || true)"

echo "[v1.4.1] handshake response (first lines):"
echo "$resp" | sed -n '1,30p'

if echo "$resp" | grep -Eiq '101|websocket'; then
  echo "[v1.4.1] websocket route check OK"
else
  echo "[v1.4.1] websocket route check FAILED: expected HTTP 101 or websocket indicator"
  fail=1
fi

if [[ $fail -eq 0 ]]; then
  echo "[v1.4.1] PASS: nginx /sip proxies websocket traffic to Kamailio and SBC containers are running"
  exit 0
fi

echo "[v1.4.1] FAIL: SBC WSS smoke failed"
exit 1
