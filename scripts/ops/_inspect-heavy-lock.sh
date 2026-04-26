#!/usr/bin/env bash
set -euo pipefail

LOCK="/opt/connectcomms/ops/.heavy.lock"
echo "=== heavy lock file ==="
ls -la "$LOCK" 2>/dev/null || echo "(no lock file)"
if [[ -f "$LOCK" ]]; then
  echo "--- contents ---"
  cat "$LOCK"
  echo
  LOCK_PID="$(awk -F= '/^pid=/{print $2}' "$LOCK" 2>/dev/null || true)"
  echo "--- pid check ---"
  echo "pid=$LOCK_PID"
  if [[ -n "$LOCK_PID" ]]; then
    if kill -0 "$LOCK_PID" 2>/dev/null; then
      echo "ALIVE"
      ps -p "$LOCK_PID" -o pid,ppid,etime,cmd
    else
      echo "DEAD"
    fi
  fi
fi
