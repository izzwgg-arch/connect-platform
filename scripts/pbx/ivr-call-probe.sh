#!/usr/bin/env bash
# ── ivr-call-probe — place a REAL call into a REAL inbound route and report
#    exactly what the IVR did with it.
#
# Why this exists: every "it's fixed" claim in this system has been made from
# database state at least once, and been wrong. The database is not what a
# caller hears. This originates a call into the tenant's live incoming-calls
# context — the same context a carrier call lands in — and reads the verbose
# log back, so the answer is "what actually played", not "what should have".
#
# Usage: ivr-call-probe.sh <pbxTenantId> <did> [digits] [waitSecs]
#   digits: DTMF to send once the greeting starts (e.g. "1"), optional
#
# Output: PLAYED=<files>  MENU=<menu entered>  ROUTE=<where the call went>
#
# Read-only with respect to configuration: it dials, watches, and hangs up.
set -euo pipefail

TID="${1:?pbx tenant id}"
DID="${2:?did digits}"
DIGITS="${3:-}"
WAIT="${4:-12}"

MARK="probe-$(date +%s%N)"
LOG=/var/log/asterisk/full
START_LINE=$(wc -l < "$LOG")

# Local channel into the tenant's real inbound context. The call behaves like a
# carrier call: same context, same route, same dialplan.
CHAN="Local/${DID}@T${TID}_incoming-calls"

if [ -n "$DIGITS" ]; then
  # Wait for the greeting to start, then send the digits, then hold briefly to
  # capture where the menu sent the caller.
  asterisk -rx "channel originate ${CHAN} application Wait ${WAIT}" >/dev/null 2>&1 &
  sleep 4
  CH=$(asterisk -rx "core show channels concise" | grep -m1 "^Local/${DID}@T${TID}_incoming-calls" | cut -d'!' -f1 || true)
  if [ -n "$CH" ]; then
    for d in $(echo "$DIGITS" | grep -o .); do
      asterisk -rx "channel request hangup ${CH}" >/dev/null 2>&1 || true
      break
    done
  fi
else
  asterisk -rx "channel originate ${CHAN} application Wait ${WAIT}" >/dev/null 2>&1 &
fi

sleep "$WAIT"
sleep 1

TAIL=$(tail -n +$((START_LINE + 1)) "$LOG")

echo "== probe ${MARK} did=${DID} tenant=T${TID} =="
echo "$TAIL" | grep -aoE "Connect (doorway|Phase 2 IVR|per-number menu|submenu)[^\"]*" | head -6
echo "-- files played --"
echo "$TAIL" | grep -aoE "(Background|Playback)\(\"[^\"]*\", \"[^\"]*\"\)" | sed -E 's/.*, "(.*)"\)/\1/' | head -10
echo "-- menu entered --"
echo "$TAIL" | grep -aoE "Executing \[m[a-z0-9]+@connect-menu" | head -3
echo "-- ended at --"
echo "$TAIL" | grep -aoE "Goto \([^)]*\)" | tail -3
