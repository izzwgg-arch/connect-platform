#!/usr/bin/env bash
# ── Make a number play THE MENU IT IS ASSIGNED ───────────────────────────────
#
# ⛔ PBX WRITE. Run on the PBX host (209.145.60.79) as root.
#
# THE BUG THIS FIXES (proven live 2026-08-06):
#   The IVR Studio is built around "this number plays this menu" — it is the
#   first line of the UI. Connect publishes that assignment to
#   connect/didmap/<did>/profile_id on every DID publish/switch.
#   The runtime dialplan NEVER READ IT. `grep -c profile_id` on the live
#   custom dialplan returned 0. Every call for a tenant played ONE
#   tenant-global menu (connect/t_<slug>/active_prompt) chosen by the tenant's
#   business-hours schedule, whatever the number was assigned.
#
#   So for A plus center: the Home number was assigned "Home Main", the owner
#   re-recorded Home Main's greeting (DB + published family both correct), and
#   callers kept hearing "After hours main" — because that was the tenant-wide
#   active menu. Every "I changed it and nothing changed" report had this one
#   cause: recordings, keys, and menu choice are all per-menu, and the runtime
#   was reading a different menu.
#
# THE FIX: after the existing channel setup (language, MOH, hold vars, Answer,
# pre-announce) the entry checks the number's assigned menu and, when that menu
# has a published family, enters it through [connect-menu] — the per-menu
# engine that already reads greeting/invalid/timeout/retry/keys/exits from
# connect/t_<slug>/menu/<profileId>/*.
#
# Deliberately additive and fail-safe:
#   • no existing line is modified — the block is INSERTED before the (prompt)
#     label, so every legacy path still exists
#   • no assignment, or an unpublished menu → falls through to the legacy
#     tenant-global behavior, byte-identical to today
#   • pre-announce still plays first (the insert is after it)
#   • Answer() already happened, so [connect-menu]'s Background() is on an
#     answered channel
#
# Discipline: timestamped backup, idempotent, verified after reload, restores
# the backup if the context does not come back. `dialplan reload` only.
set -euo pipefail

FILE="/etc/asterisk/extensions__60_custom.conf"
STAMP="$(date +%Y%m%dT%H%M%SZ)"

[ -f "$FILE" ] || { echo "FATAL: $FILE not found"; exit 1; }

if grep -q "DID_MENU=" "$FILE"; then
  echo "Already applied — $FILE reads the per-number menu. Nothing done."
  exit 0
fi

grep -q "^\[connect-menu\]" "$FILE" || {
  echo "FATAL: [connect-menu] engine missing — run patch-connect-menu.sh first"; exit 1; }

# Anchor: the (prompt) label inside [connect-tenant-ivr]. Six-space indent is
# unique to that context (the fallback context indents four).
ANCHOR=' same =>      n(prompt),'
grep -q "$ANCHOR" "$FILE" || { echo "FATAL: (prompt) anchor not found — layout changed, refusing to patch blind"; exit 1; }

cp -a "$FILE" "$FILE.bak.per-number-menu.$STAMP"
echo "Backup: $FILE.bak.per-number-menu.$STAMP"

python3 - "$FILE" <<'PY'
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8", errors="replace") as fh:
    lines = fh.read().splitlines()

block = [
    " ; ── Per-number menu (2026-08-06) ─────────────────────────────────────────",
    " ; The number's assigned menu is authoritative: it is what the IVR Studio",
    " ; shows the owner, so it must be what callers hear. Falls through to the",
    " ; legacy tenant-global menu when the number has no assignment or the menu",
    " ; has not been published yet.",
    " same =>      n,Set(DID_MENU=${DB(connect/didmap/${IVR_DID}/profile_id)})",
    ' same =>      n,GotoIf($["${DID_MENU}" = ""]?prompt)',
    " same =>      n,Set(DID_MENU_PROMPT=${DB(connect/t_${TENANT_SLUG}/menu/${DID_MENU}/prompt)})",
    ' same =>      n,GotoIf($["${DID_MENU_PROMPT}" = ""]?prompt)',
    " same =>      n,NoOp(Connect per-number menu tenant=${TENANT_SLUG} did=${IVR_DID} menu=${DID_MENU})",
    " same =>      n,Goto(connect-menu,m${DID_MENU},1)",
]

anchor = " same =>      n(prompt),"
out, inserted = [], False
for line in lines:
    if not inserted and line.startswith(anchor):
        out.extend(block)
        inserted = True
    out.append(line)

if not inserted:
    sys.stderr.write("FATAL: anchor vanished mid-write\n")
    sys.exit(1)

with open(path, "w", encoding="utf-8", newline="\n") as fh:
    fh.write("\n".join(out) + "\n")
print("inserted %d lines before the (prompt) label" % len(block))
PY

echo "Reloading dialplan…"
asterisk -rx "dialplan reload" >/dev/null

# This box takes ~9s to surface dialplan changes; a 1s check self-rolled back
# on a false negative twice this week.
OK=""
for attempt in 1 2 3 4; do
  sleep 3
  if asterisk -rx "dialplan show connect-tenant-ivr" 2>/dev/null | grep -q "DID_MENU"; then OK=yes; break; fi
  echo "verify attempt $attempt: not visible yet…"
done

if [ "$OK" = "yes" ]; then
  echo "OK: per-number menu lookup is live in [connect-tenant-ivr]."
else
  echo "FATAL: patch not visible after reload — RESTORING BACKUP."
  cp -a "$FILE.bak.per-number-menu.$STAMP" "$FILE"
  asterisk -rx "dialplan reload" >/dev/null
  exit 1
fi
