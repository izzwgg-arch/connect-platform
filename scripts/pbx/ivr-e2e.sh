#!/usr/bin/env bash
# ── ivr-e2e — assert what a CALLER actually gets, from a real call ───────────
#
# Places a real call into the tenant's live inbound route (optionally pressing
# keys with real DTMF) and asserts against the Asterisk log. Written because
# every "it works" claim in this system that was based on database state has
# been wrong at least once; this only reports what the switch actually did.
#
# Usage:
#   ivr-e2e.sh <did> <expect-regex> [keys] [waitSecs]
#
# <expect-regex> is matched against the call's trace (played files, menu
# entered, Goto targets). Exit 0 = PASS.
set -uo pipefail

DID="${1:?did}"
EXPECT="${2:?expected regex}"
KEYS="${3:-}"
WAIT="${4:-14}"
LOG=/var/log/asterisk/full

START=$(wc -l < "$LOG")
if [ -n "$KEYS" ]; then
  asterisk -rx "channel originate Local/${DID}*${KEYS}@connect-probe-press application Wait $((WAIT))" >/dev/null 2>&1 &
else
  asterisk -rx "channel originate Local/${DID}@connect-probe application Wait $((WAIT))" >/dev/null 2>&1 &
fi
sleep "$((WAIT + 2))"

# Isolate THIS call by its linkedid. Reading the whole log window mixes in any
# other call in flight — which made a passing test look like a failure while a
# second probe ran (2026-08-06). Both legs of a key-press probe share the
# linkedid, so this captures the full journey and nothing else.
WINDOW=$(tail -n +$((START + 1)) "$LOG")
LINK=$(echo "$WINDOW" | grep -a "Local/${DID}[*@]" | grep -aoE '\[C-[0-9a-f]+\]' | head -1)
if [ -n "$LINK" ]; then
  TRACE=$(echo "$WINDOW" | grep -aF "$LINK" | grep -a "Executing\|Spawn extension" | sed -E 's/.*Executing //; s/\("[^"]+", /(/')
else
  echo "FAIL  (no call appeared in the log — originate did not run)"
  exit 1
fi

PLAYED=$(echo "$TRACE" | grep -aoE '(BackGround|Background|Playback)\([^)]*\)' | sed -E 's/.*\((.*)\)/\1/' | tr '\n' ' ')
MENU=$(echo "$TRACE"   | grep -aoE '\[m[a-zA-Z0-9]+@connect-menu:1\]' | head -1)
ENDED=$(echo "$TRACE"  | grep -aoE 'Goto\([^)]*\)' | tail -1)

echo "PLAYED: ${PLAYED:-<none>}"
echo "MENU:   ${MENU:-<none>}"
echo "LAST:   ${ENDED:-<none>}"

# Case-insensitive: Asterisk logs the app as "BackGround", and a harness that
# fails on its own regex casing is how a working system gets reported broken.
if echo "$TRACE" | grep -qaiE "$EXPECT"; then
  echo "PASS  ($EXPECT)"
  exit 0
fi
echo "FAIL  (expected: $EXPECT)"
echo "---- trace ----"
echo "$TRACE" | tail -25
exit 1
