#!/usr/bin/env bash
# ── Hidden menu dial codes for [connect-menu] ────────────────────────────────
#
# ⛔ PBX WRITE. Backup + idempotent + verify + auto-restore on failure.
#
# WHY: VitalPBX menus can carry multi-digit "secret" entries — B Visible's
# 0478 (Goto T9_app-disa,DISA-1,1) and 55648752 (Goto sub-extensions-vm,
# VM-101,1), Gesheft's 750/13132 (queue), etc. A Connect menu could not, so
# the IVR migration filed every one under "Connect can't reproduce these".
# Connect publishes them now (buildIvrKeys, 2026-08-25) into the per-menu
# AstDB family:
#
#   connect/t_<slug>/menu/<id>/code_<digits>/dest   Goto-able ref
#   connect/t_<slug>/menu/<id>/code_<digits>/type   destination type
#   connect/t_<slug>/menu/<id>/has_codes            "1" when any code exists
#
# This patch teaches [connect-menu] to consume them:
#
#   1. The existing _XXX/_XXXX direct-dial patterns check code_<EXTEN>/dest
#      FIRST — a hit routes through [connect-exit-router] to the stored
#      target (the identical Goto the PBX menu's own literal exten used); a
#      miss falls through to direct dial exactly as before. Codes beating
#      extensions mirrors VitalPBX's own literal-exten-over-pattern rule.
#   2. New _XXXXX.._XXXXXXXX patterns (5–8 digits) do the code lookup only;
#      a miss is an invalid choice, so the caller is TOLD, never stranded.
#   3. TIMEOUT(digit) widens to 1s when the menu has codes, not only when
#      direct dial is on — at the 0.2s default an 8-digit code is untypeable.
#
# Menus with no codes published behave byte-identically: has_codes is empty
# or "0", every code_ lookup returns "", and the new patterns end at the same
# invalid handler an unmatched digit string reached before.
#
# ⛔ [connect-tenant-ivr]'s own _XXX/_XXXX patterns are deliberately NOT
# touched — codes ride the per-menu family, which only menus entered through
# [connect-menu] (i.e. every per-number/didmap menu, which is every migrated
# menu) can read.
#
set -euo pipefail

FILE="/etc/asterisk/extensions__60_custom.conf"
STAMP="$(date +%Y%m%dT%H%M%SZ)"
[ -f "$FILE" ] || { echo "FATAL: $FILE not found"; exit 1; }

if grep -q "connect-menu-codes-v1" "$FILE"; then
  echo "Already applied. Nothing done."
  exit 0
fi

BACKUP="$FILE.bak.menucodes.$STAMP"
cp -a "$FILE" "$BACKUP"
echo "Backup: $BACKUP"

python3 - "$FILE" <<'PY'
import io, re, sys
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()

# Work only inside the [connect-menu] section — [connect-tenant-ivr] has its
# own _XXX/_XXXX patterns that must not be touched. Headers are matched at
# line start so a comment MENTIONING a section name can't skew the slice.
m1 = re.search(r"(?m)^\[connect-menu\]\s*$", s)
m2 = re.search(r"(?m)^\[connect-menu-option-router\]\s*$", s)
assert m1 and m2 and m1.start() < m2.start(), "could not locate [connect-menu] section"
start, end = m1.start(), m2.start()
sec = s[start:end]

def must_replace(hay, old, new, what):
    n = hay.count(old)
    assert n == 1, f"expected exactly 1 occurrence of {what}, found {n}"
    return hay.replace(old, new)

# ── 1+2. code lookup ahead of direct dial on _XXX and _XXXX ──────────────────
for pat in ("_XXX", "_XXXX"):
    old = (
        f"exten => {pat},1,NoOp(Connect menu direct dial exten=${{EXTEN}} allowed=${{M_DIRECT_DIAL}})\n"
        " same =>       n,GotoIf($[\"${M_DIRECT_DIAL}\" != \"1\"]?i,1)\n"
    )
    new = (
        f"exten => {pat},1,NoOp(Connect menu entry exten=${{EXTEN}} direct_dial=${{M_DIRECT_DIAL}})\n"
        " same =>       n,Set(M_CODE_DEST=${DB(${MENU_FAMILY}/code_${EXTEN}/dest)})\n"
        " same =>       n,GotoIf($[\"${M_CODE_DEST}\" = \"\"]?dd_ext)\n"
        " same =>       n,Set(EXIT_TYPE=${DB(${MENU_FAMILY}/code_${EXTEN}/type)})\n"
        " same =>       n,Set(EXIT_DEST=${M_CODE_DEST})\n"
        " same =>       n,Set(M_RETRIES=0)\n"
        " same =>       n,NoOp(Connect menu code menu=${CUR_MENU} code=${EXTEN} type=${EXIT_TYPE})\n"
        " same =>       n,Goto(connect-exit-router,s,1)\n"
        " same =>       n(dd_ext),GotoIf($[\"${M_DIRECT_DIAL}\" != \"1\"]?i,1)\n"
    )
    sec = must_replace(sec, old, new, f"{pat} direct-dial head")

# ── 2. code-only patterns for 5–8 digit codes ────────────────────────────────
codeonly = []
for n in (5, 6, 7, 8):
    pat = "_" + "X" * n
    codeonly.append(
        f"exten => {pat},1,NoOp(Connect menu code candidate exten=${{EXTEN}})\n"
        " same =>       n,Set(M_CODE_DEST=${DB(${MENU_FAMILY}/code_${EXTEN}/dest)})\n"
        " same =>       n,GotoIf($[\"${M_CODE_DEST}\" = \"\"]?i,1)\n"
        " same =>       n,Set(EXIT_TYPE=${DB(${MENU_FAMILY}/code_${EXTEN}/type)})\n"
        " same =>       n,Set(EXIT_DEST=${M_CODE_DEST})\n"
        " same =>       n,Set(M_RETRIES=0)\n"
        " same =>       n,NoOp(Connect menu code menu=${CUR_MENU} code=${EXTEN} type=${EXIT_TYPE})\n"
        " same =>       n,Goto(connect-exit-router,s,1)\n"
    )
anchor = "; Connect submenu engine"
assert sec.count(anchor) == 1, "submenu engine comment anchor not found"
sec = sec.replace(anchor, "; connect-menu-codes-v1 — 5-8 digit hidden codes\n" + "\n".join(codeonly) + "\n" + anchor)

# ── 3. inter-digit timeout: codes need 1s just like direct dial ──────────────
old_t = " same =>       n,Set(TIMEOUT(digit)=${IF($[\"${M_DIRECT_DIAL}\" = \"1\"]?1:0.2)})\n"
new_t = (
    " same =>       n,Set(M_HAS_CODES=${DB(${MENU_FAMILY}/has_codes)})\n"
    " same =>       n,Set(TIMEOUT(digit)=${IF($[\"${M_DIRECT_DIAL}\" = \"1\" | \"${M_HAS_CODES}\" = \"1\"]?1:0.2)})\n"
)
sec = must_replace(sec, old_t, new_t, "TIMEOUT(digit) line")

s = s[:start] + sec + s[end:]
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("patched OK")
PY

# ── verify: Asterisk PARSED the new file (a parse error silently keeps the ──
# old dialplan, so the only honest check is the new patterns showing up in
# the loaded dialplan).
asterisk -rx "dialplan reload" >/dev/null
sleep 1
LOADED="$(asterisk -rx "dialplan show connect-menu")"
ok=1
echo "$LOADED" | grep -q "_XXXXXXXX" || ok=0
echo "$LOADED" | grep -q "code_" || ok=0
echo "$LOADED" | grep -q "M_HAS_CODES" || ok=0
if [ "$ok" != "1" ]; then
  echo "VERIFY FAILED — restoring backup"
  cp -a "$BACKUP" "$FILE"
  asterisk -rx "dialplan reload" >/dev/null
  exit 1
fi
echo "Applied and verified: connect-menu now matches 3-8 digit hidden codes."
