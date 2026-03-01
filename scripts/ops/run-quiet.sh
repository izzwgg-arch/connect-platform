#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: run-quiet.sh <label> -- <command>" >&2
  exit 2
fi

LABEL="$1"
shift
if [[ "$1" != "--" ]]; then
  echo "Usage: run-quiet.sh <label> -- <command>" >&2
  exit 2
fi
shift

LOG_DIR="${OPS_LOG_DIR:-/opt/connectcomms/ops/logs}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
SAFE_LABEL="$(echo "$LABEL" | tr ' /' '__' | tr -cd '[:alnum:]_.-')"
LOG_FILE="${LOG_FILE:-${LOG_DIR}/${SAFE_LABEL}-${TS}.log}"

mkdir -p "$LOG_DIR"

if "$@" >"$LOG_FILE" 2>&1; then
  echo "PASS: ${LABEL} log=${LOG_FILE}"
  exit 0
fi

echo "FAIL: ${LABEL} log=${LOG_FILE}" >&2
tail -n 80 "$LOG_FILE" >&2 || true
exit 1
