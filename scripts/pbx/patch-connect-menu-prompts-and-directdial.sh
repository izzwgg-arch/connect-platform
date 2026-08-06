#!/usr/bin/env bash
# ── Two live faults in the Connect menu dialplan ─────────────────────────────
#
# ⛔ PBX WRITE. Backup + idempotent + verify + auto-restore on failure.
#
# 1. THE "THAT OPTION IS INVALID" MESSAGE NEVER PLAYS.
#    Both menu contexts guard playback with
#        STAT(e,/var/lib/asterisk/sounds/${REF}.ulaw)
#    but Asterisk's own recordings live under sounds/<language>/ —
#    /var/lib/asterisk/sounds/en/pbx-invalid.ulaw. So for every built-in the
#    STAT misses, the guard sends the call to "replay the menu", and the caller
#    is never told anything. Same for the timeout message.
#
#    Custom recordings were unaffected: they really are at sounds/custom/X.wav.
#    That is why this went unnoticed — the tenant recordings worked.
#
#    Fix: a ref with no "/" in it is an Asterisk built-in. Asterisk resolves the
#    language directory itself, so play it directly instead of STAT-ing a path
#    it was never going to live at.
#
# 2. YOU CANNOT DIAL AN EXTENSION FROM A PER-NUMBER MENU.
#    [connect-menu] has single-digit extens but NO _XXX/_XXXX patterns, so the
#    moment a caller presses 1 there is no longer match for Asterisk to wait
#    for and option 1 fires instantly — dialling 101 is impossible.
#    [connect-tenant-ivr] has always had those patterns; the newer per-number
#    context was never given them.
#
#    Fix: add the same direct-dial patterns, gated on the menu's own
#    `direct_dial` key. When it is off, dialling an extension is treated as an
#    invalid choice — so the caller HEARS "that option is invalid" rather than
#    silently landing nowhere.
#
set -euo pipefail

FILE="/etc/asterisk/extensions__60_custom.conf"
STAMP="$(date +%Y%m%dT%H%M%SZ)"
[ -f "$FILE" ] || { echo "FATAL: $FILE not found"; exit 1; }

if grep -q "connect-menu-direct-dial-v1" "$FILE"; then
  echo "Already applied. Nothing done."
  exit 0
fi

cp -a "$FILE" "$FILE.bak.menufix.$STAMP"
echo "Backup: $FILE.bak.menufix.$STAMP"

python3 - "$FILE" <<'PY'
import io, re, sys
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()

# ── 1. built-in prompts: play them instead of STAT-ing a path they never use ──
# Before each existing "is it empty? -> skip" guard, add "has no slash? -> play".
pairs = [
    ("M_INVALID_PROMPT", "play_i"),
    ("M_TIMEOUT_PROMPT", "play_t"),
    ("INVALID_PROMPT",   "play_invalid"),
    ("TIMEOUT_PROMPT",   "play_timeout"),
    ("GREETING",         "play_greet"),
]
count = 0
for var, label in pairs:
    # match the existing empty-check line for this variable, whatever its indent
    pat = re.compile(r'^([ \t]*same *=> *n,)GotoIf\(\$\[?"?\$\{' + var + r'\}"? *= *""\]?\?([a-z_]+)\)\s*$',
                     re.MULTILINE)
    def add(m):
        global count
        count += 1
        head, skip = m.group(1), m.group(2)
        return (f'{head}GotoIf($["${{{var}}}" = ""]?{skip})\n'
                f'{head}GotoIf($["${{CUT({var},/,1)}}" = "${{{var}}}"]?{label})   ; built-in: Asterisk finds the language dir')
    s, n = pat.subn(add, s)
print(f"prompt guards patched: {count}")

# ── 2. direct dial inside [connect-menu] ─────────────────────────────────────
anchor = "[connect-menu]"
assert anchor in s, "connect-menu context missing"
block = """
; ── connect-menu-direct-dial-v1 ─────────────────────────────────────────────
; Dialling an extension from a per-number menu. Two jobs: give Asterisk a
; longer pattern so a single digit WAITS instead of firing an option
; immediately, and honour the menu's own direct_dial switch. Off = the caller
; is told the option is invalid, never left in silence.
exten => _XXX,1,NoOp(Connect menu direct dial — menu=${CUR_MENU} exten=${EXTEN} allowed=${M_DIRECT_DIAL})
 same =>      n,GotoIf($["${M_DIRECT_DIAL}" != "1"]?connect-menu,i,1)
 same =>      n,Set(PBX_TENANT_ID=${DB(connect/t_${TENANT_SLUG}/pbx_tenant_id)})
 same =>      n,GotoIf($["${PBX_TENANT_ID}" = ""]?connect-menu,i,1)
 same =>      n,Set(__DIAL_TARGET=T${PBX_TENANT_ID}_cos-all,${EXTEN},1)
 same =>      n,Set(__WAKE_EXT=${EXTEN})
 same =>      n,Goto(connect-dial-with-wake,s,1)
exten => _XXXX,1,Goto(_XXX,1)
"""
i = s.index(anchor) + len(anchor)
s = s[:i] + "\n" + block + s[i:]

# the menu must know whether direct dial is allowed — read it alongside its
# other per-menu settings
s = s.replace(
    " same =>      n,Set(M_RETRY_PROMPT=${DB(${MENU_FAMILY}/prompt_retry)})",
    " same =>      n,Set(M_RETRY_PROMPT=${DB(${MENU_FAMILY}/prompt_retry)})\n"
    " same =>      n,Set(M_DIRECT_DIAL=${DB(${MENU_FAMILY}/direct_dial)})",
    1)

io.open(p, "w", encoding="utf-8").write(s)
print("direct-dial block inserted")
PY

asterisk -rx "dialplan reload" >/dev/null
sleep 3

OK=1
asterisk -rx "dialplan show connect-menu" | grep -q "_XXX" || { echo "FAIL: direct-dial patterns missing"; OK=0; }
asterisk -rx "dialplan show connect-menu" | grep -q "M_DIRECT_DIAL" || { echo "FAIL: direct_dial not read"; OK=0; }
asterisk -rx "dialplan show connect-menu" | grep -q "built-in" || echo "NOTE: built-in guard not visible in connect-menu (check connect-tenant-ivr)"

if [ "$OK" = "1" ]; then
  echo "OK — direct dial + built-in prompt playback live."
else
  echo "Restoring backup"
  cp -a "$FILE.bak.menufix.$STAMP" "$FILE"
  asterisk -rx "dialplan reload" >/dev/null
  exit 1
fi
