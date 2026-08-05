#!/usr/bin/env bash
# ── Teach the Connect IVR a "play a recording" menu key ──────────────────────
#
# ⛔ PBX WRITE. Run only with Izzy's explicit go-ahead, on the PBX host
#    (209.145.60.79), as root. The PBX is read-only for agents otherwise.
#
# What it does, and why it is safe to hold back:
#   The IVR Studio can now point a menu key at a recording: it plays, then the
#   caller either hears the menu again (default), lands in a voicemail, or the
#   call ends. Connect publishes two AstDB keys per digit for this —
#   connect/t_<slug>/opt_<digit>/announce and .../after — and stores the key's
#   destination as Goto(connect-play-prompt,s,1). Until this patch is applied
#   that context doesn't exist, so the whole feature is inert: nothing written,
#   nothing read. That is the deliberate rollout order.
#
# Two changes:
#   1. [connect-tenant-ivr] entry saves the dialed number in IVR_DID, so the
#      new context can send the caller BACK to the same menu afterwards.
#   2. New [connect-play-prompt] context: play the digit's recording (skipped
#      safely if the file is missing), then Goto the after-destination, or
#      jump back to the menu's (prompt) label when none is set.
#
# Discipline (same as every dialplan touch on this box):
#   • timestamped backup next to the file
#   • idempotent — refuses to double-apply
#   • verifies the context is visible after reload, restores backup if not
#   • `dialplan reload` only, never a full restart, never Apply Changes
#
set -euo pipefail

FILE="/etc/asterisk/extensions__60_custom.conf"
STAMP="$(date +%Y%m%dT%H%M%SZ)"

[ -f "$FILE" ] || { echo "FATAL: $FILE not found"; exit 1; }

if grep -q "connect-play-prompt" "$FILE"; then
  echo "Already applied — $FILE mentions connect-play-prompt. Nothing done."
  exit 0
fi

# Anchor: the entry sequence's Wait(1) — six spaces, which only
# [connect-tenant-ivr] has (the fallback context indents four). Same anchor
# the pre-announce patch used, so it holds whether or not that one is applied.
grep -n ' same =>      n,Wait(1)' "$FILE" >/dev/null || { echo "FATAL: anchor Wait(1) not found — layout changed, do not patch blind"; exit 1; }

cp -a "$FILE" "$FILE.bak.play-prompt.$STAMP"
echo "Backup: $FILE.bak.play-prompt.$STAMP"

python3 - "$FILE" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()

anchor = " same =>      n,Wait(1)\n"
assert s.count(anchor) >= 1, "anchor missing"
entry = " same =>      n,Set(IVR_DID=${EXTEN})   ; Connect play-prompt return point\n" + anchor
# Only the FIRST occurrence — that's the connect-tenant-ivr entry sequence.
s = s.replace(anchor, entry, 1)

context = """

[connect-play-prompt]
; Connect "play a recording" menu key. Reads what to play and where to go
; after from the same per-digit AstDB family the option router used:
;   connect/t_<slug>/opt_<digit>/announce → recording ref (under sounds/)
;   connect/t_<slug>/opt_<digit>/after    → Goto target after playback;
;                                           empty = replay the caller's menu
; Jumping back targets the (prompt) label so the greeting replays without
; re-running Answer/Wait or the once-per-call pre-announce.
exten => s,1,NoOp(Connect play-prompt — tenant=${TENANT_SLUG} digit=${OPT_DIGIT} did=${IVR_DID})
 same =>    n,Set(PP_REF=${DB(connect/t_${TENANT_SLUG}/opt_${OPT_DIGIT}/announce)})
 same =>    n,Set(PP_AFTER=${DB(connect/t_${TENANT_SLUG}/opt_${OPT_DIGIT}/after)})
 same =>    n,GotoIf($["${PP_REF}" = ""]?back)
 same =>    n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${PP_REF}.ulaw)}" = "1"]?play)
 same =>    n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${PP_REF}.wav)}" = "1"]?play)
 same =>    n,NoOp(Connect play-prompt file missing ref=${PP_REF} — returning to menu)
 same =>    n,Goto(back)
 same =>    n(play),Playback(${PP_REF})
 same =>    n,GotoIf($["${PP_AFTER}" = ""]?back)
 same =>    n,NoOp(Connect play-prompt after — dest=${PP_AFTER})
 same =>    n,Goto(${PP_AFTER})
 same =>    n(back),GotoIf($[$["${IVR_DID}" = ""] | $["${IVR_DID}" = "s"]]?bye)
 same =>    n,Set(RETRIES=0)
 same =>    n,Goto(connect-tenant-ivr,${IVR_DID},prompt)
 same =>    n(bye),Goto(connect-default-fallback,s,1)
"""
s = s.rstrip("\n") + "\n" + context
io.open(p, "w", encoding="utf-8").write(s)
print("patched")
PY

# APPLIED LIVE 2026-08-05 (backup extensions__60_custom.conf.bak.play-prompt2.20260805T195557Z).
# The first run's 1s post-reload sleep raced the reload and self-rolled-back on a
# false negative; give the reload room before declaring failure.
asterisk -rx "dialplan reload" >/dev/null
sleep 3
if asterisk -rx "dialplan show connect-play-prompt" | grep -q "play-prompt" \
   && asterisk -rx "dialplan show connect-tenant-ivr" | grep -q "IVR_DID"; then
  echo "OK — connect-play-prompt live, IVR_DID saved on menu entry."
else
  echo "FATAL: patch not visible after reload — restoring backup"
  cp -a "$FILE.bak.play-prompt.$STAMP" "$FILE"
  asterisk -rx "dialplan reload" >/dev/null
  exit 1
fi
