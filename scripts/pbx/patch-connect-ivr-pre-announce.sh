#!/usr/bin/env bash
# ── Teach [connect-tenant-ivr] to play a pre-menu announcement ───────────────
#
# ⛔ PBX WRITE. Run only with Izzy's explicit go-ahead, on the PBX host
#    (209.145.60.79), as root. The PBX is read-only for agents otherwise.
#
# What it does, and why it is safe to hold back:
#   Connect's scheduler writes one AstDB key — connect/t_<slug>/pre_announce —
#   when a customer books an announcement ("we're closed Thursday"). This patch
#   makes the dialplan READ that key: if set and the file exists, Playback() it
#   once, then fall into the normal menu. Until this patch is applied the key
#   is written but never read, so the whole feature is inert — that is the
#   deliberate rollout order.
#
# Discipline (same as every dialplan touch on this box):
#   • timestamped backup next to the file
#   • idempotent — refuses to double-apply
#   • verifies the context parses before AND after
#   • `dialplan reload` only, never a full restart, never Apply Changes
#
set -euo pipefail

FILE="/etc/asterisk/extensions__60_custom.conf"
STAMP="$(date +%Y%m%dT%H%M%SZ)"
MARK="Connect pre-menu announcement"

[ -f "$FILE" ] || { echo "FATAL: $FILE not found"; exit 1; }

if grep -q "pre_announce" "$FILE"; then
  echo "Already applied — $FILE mentions pre_announce. Nothing done."
  exit 0
fi

# The insertion point: the line after Answer()/Wait(1), immediately before the
# (prompt) label. On retries the dialplan jumps straight to (prompt), so the
# announcement plays once per call, never per retry loop.
grep -n 'same =>      n,Wait(1)' "$FILE" >/dev/null || { echo "FATAL: anchor Wait(1) not found — layout changed, do not patch blind"; exit 1; }

cp -a "$FILE" "$FILE.bak.pre-announce.$STAMP"
echo "Backup: $FILE.bak.pre-announce.$STAMP"

python3 - "$FILE" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()
anchor = " same =>      n,Wait(1)\n"
assert s.count(anchor) >= 1, "anchor missing"
block = anchor + """ same =>      n,Set(PRE_ANNOUNCE=${DB(${FAMILY}/pre_announce)})   ; Connect pre-menu announcement
 same =>      n,GotoIf($["${PRE_ANNOUNCE}" = ""]?prompt)
 same =>      n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${PRE_ANNOUNCE}.wav)}" = "1"]?play_pre)
 same =>      n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${PRE_ANNOUNCE}.ulaw)}" = "1"]?play_pre)
 same =>      n,NoOp(Connect pre-announce file missing ref=${PRE_ANNOUNCE} — skipping)
 same =>      n,Goto(prompt)
 same =>      n(play_pre),Playback(${PRE_ANNOUNCE})
"""
# Only the FIRST occurrence — that's the connect-tenant-ivr entry sequence.
s = s.replace(anchor, block, 1)
io.open(p, "w", encoding="utf-8").write(s)
print("patched")
PY

asterisk -rx "dialplan reload" >/dev/null
sleep 1
if asterisk -rx "dialplan show connect-tenant-ivr" | grep -q "pre_announce"; then
  echo "OK — pre_announce live in connect-tenant-ivr."
else
  echo "FATAL: patch not visible after reload — restoring backup"
  cp -a "$FILE.bak.pre-announce.$STAMP" "$FILE"
  asterisk -rx "dialplan reload" >/dev/null
  exit 1
fi
