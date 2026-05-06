#!/usr/bin/env bash
# Read-only voicemail "Call to Record" diagnostics for VitalPBX/Asterisk.
# Does not modify config, reload dialplan, or restart services.
set -euo pipefail

LOG="/tmp/vm-record-diagnose-$(date +%Y%m%d-%H%M%S).log"

{
  echo "========================================"
  echo "vm-record-diagnose (read-only)"
  echo "========================================"
  date -Is 2>/dev/null || date
  hostname -f 2>/dev/null || hostname
  echo "log: $LOG"
  echo

  echo "=== asterisk -rx \"pjsip show contacts\" ==="
  asterisk -rx "pjsip show contacts" 2>&1 || echo "(asterisk command failed — run as user with CLI access)"
  echo

  echo "=== asterisk -rx \"database show connect_vm_dial\" ==="
  asterisk -rx "database show connect_vm_dial" 2>&1 || true
  echo

  echo "=== asterisk -rx \"core show channels concise\" ==="
  asterisk -rx "core show channels concise" 2>&1 || true
  echo

  echo "=== asterisk -rx \"dialplan show connect-vm-greeting-record\" ==="
  asterisk -rx "dialplan show connect-vm-greeting-record" 2>&1 || true
  echo

  echo "=== asterisk -rx \"dialplan show connect-vm-greeting-dispatch\" ==="
  asterisk -rx "dialplan show connect-vm-greeting-dispatch" 2>&1 || true
  echo

  echo "=== connect-pbx-helper journal (last 20 min, lines matching vm record / originate) ==="
  if command -v journalctl >/dev/null 2>&1; then
    _j="$(journalctl -u connect-pbx-helper --since "20 min ago" --no-pager 2>&1 || true)"
    if echo "$_j" | grep -Ei 'voicemail/greeting|record-call|poll_pjsip|originate|connect_vm_dial|asterisk'; then
      :
    else
      echo "(no matching lines or journal empty / unit missing)"
    fi
  else
    echo "(journalctl not available)"
  fi
  echo
  echo "=== done ==="
} 2>&1 | tee "$LOG"

echo "Wrote: $LOG"
