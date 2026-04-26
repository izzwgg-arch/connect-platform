#!/usr/bin/env bash
set -euo pipefail

LOCK="/opt/connectcomms/ops/.heavy.lock"
for i in $(seq 1 200); do
  if [[ ! -f "$LOCK" ]]; then
    echo "iter=$i lock cleared"
    exit 0
  fi
  LOCK_PID="$(awk -F= '/^pid=/{print $2}' "$LOCK" 2>/dev/null || true)"
  if [[ -n "$LOCK_PID" ]] && ! kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "iter=$i lock holder $LOCK_PID is dead — removing stale lock"
    rm -f "$LOCK"
    exit 0
  fi
  if (( i % 6 == 0 )); then
    ELAPSED="$(ps -p "$LOCK_PID" -o etime= 2>/dev/null | tr -d ' ' || echo ??)"
    LABEL="$(awk -F= '/^label=/{print $2}' "$LOCK" 2>/dev/null || echo ?)"
    echo "iter=$i still holding pid=$LOCK_PID label=$LABEL elapsed=$ELAPSED"
  fi
  sleep 5
done
echo "TIMED OUT waiting for heavy lock"
exit 1
