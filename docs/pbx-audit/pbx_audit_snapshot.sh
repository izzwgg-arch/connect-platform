#!/bin/bash
# Read-only PBX audit snapshot for cursor-audit@209.145.60.79
# Forced-command only; no shell. Uses full paths and sudo.
# Install as: /usr/local/bin/pbx_audit_snapshot (chmod 755).

# Do not use set -e; one failing Asterisk command must not stop the rest
ASTERISK=/usr/sbin/asterisk
TAIL=/usr/bin/tail
LOG=/var/log/asterisk/full

run_asterisk() {
  sudo "$ASTERISK" -rx "$1"
}

echo "=============================="
echo " PBX AUDIT SNAPSHOT"
echo "=============================="
echo "Time: $(date)"
echo ""

echo "----- CORE SHOW VERSION -----"
run_asterisk "core show version" || echo "Asterisk command failed"
echo ""

echo "----- ACTIVE CHANNELS -----"
run_asterisk "core show channels" || echo "Asterisk command failed"
echo ""

echo "----- ACTIVE CHANNELS CONCISE -----"
run_asterisk "core show channels concise" || echo "Asterisk command failed"
echo ""

echo "----- ACTIVE BRIDGES -----"
run_asterisk "bridge show all" || echo "Could not get bridges"
echo ""

echo "----- PJSIP SHOW CHANNELS -----"
run_asterisk "pjsip show channels" || echo "Asterisk command failed"
echo ""

echo "----- QUEUE SHOW -----"
run_asterisk "queue show" || echo "Asterisk command failed"
echo ""

echo "----- PJSIP SHOW ENDPOINTS -----"
run_asterisk "pjsip show endpoints" || echo "Asterisk command failed"
echo ""

echo "----- SYSTEM LOAD -----"
uptime
echo ""

echo "----- MEMORY -----"
free -h 2>/dev/null || true
echo ""

echo "----- LAST ASTERISK LOGS -----"
sudo "$TAIL" -n 100 "$LOG" 2>/dev/null || echo "Could not read Asterisk log"
echo ""

echo "=============================="
echo " END OF SNAPSHOT"
echo "=============================="
