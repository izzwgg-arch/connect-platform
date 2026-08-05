#!/usr/bin/env bash
# ============================================================================
# fix-t7-desk-aor-expiry.sh
#
# Caps SIP registration expiry at 120 s for the SEVEN Create A Box (tenant T7)
# DESK-PHONE aors (T7_101..T7_107) on the VitalPBX host, so a GL.iNet/NAT
# state wipe at the office becomes a ~2-minute blip instead of an hour-long
# "every desk phone goes straight to voicemail" outage.
#
# >>> THIS SCRIPT IS NOT RUN AS PART OF ANY DEPLOY. It is a one-time, manual,
# >>> human-approved PBX change (per AGENTS.md). Agents MUST NOT run it
# >>> against the live PBX. It lives in the repo so the exact edit,
# >>> verification, and rollback are reviewable BEFORE anyone installs it.
#
# Background (incident 2026-08-05, ~12:57 EDT)
# --------------------------------------------
# T7 desk phones register through the office GL.iNet router's NAT and the
# loopcom WireGuard tunnel. When the GL box's NAT ledger was wiped, every
# stored contact port went dead; the PBX's OPTIONS qualifies got no replies,
# contacts flipped Unavailable, and Dial(PJSIP/T7_10x) failed instantly to
# voicemail. Each phone stayed dark until its NEXT re-register — and the
# tenant's registration grants were default 3600 s / max 7200 s, which IS the
# ~1 h outage window. Capping expiry at 120 s bounds any repeat to ~2 min.
#
# What it edits
# -------------
# /etc/asterisk/vitalpbx/pjsip__50-7-extensions.conf — adds, immediately
# under each of the seven desk aor section headers [T7_101](…-aor) ..
# [T7_107](…-aor):
#
#     minimum_expiration=60
#     default_expiration=120
#     maximum_expiration=120
#
# It NEVER touches the mobile-app aors (T7_10x_1) — the app relies on push
# wake, not short registration, and short expiry there would hurt battery.
#
# KNOWN CAVEAT — VitalPBX regeneration
# ------------------------------------
# pjsip__50-7-extensions.conf is VitalPBX-GENERATED. Any T7 extension edit in
# the VitalPBX panel regenerates the file and silently reverts this fix. The
# DURABLE home for this setting is the extension profile's registration
# max-expiration in the VitalPBX UI; this script is the immediate stopgap.
# Re-run `--check` after any panel work on tenant T7.
#
# SAFETY
#   * Aborts unless it finds EXACTLY 7 desk aor sections and 0 already-set
#     expiration lines (idempotent: re-run reports "already applied").
#   * Backs up the file first; hard-aborts and restores the backup unless the
#     resulting diff is EXACTLY 21 added lines and 0 removed lines.
#   * `pjsip reload` only after the diff check passes; then verifies every
#     aor reports max-expiration 120 via `pjsip show aor`, restoring the
#     backup + reloading again if verification fails.
#
# Usage (on the VitalPBX host, as root):
#   bash fix-t7-desk-aor-expiry.sh --check    # read-only: show current state
#   bash fix-t7-desk-aor-expiry.sh --apply    # perform the edit
#
# Rollback:
#   cp <backup printed at apply time> /etc/asterisk/vitalpbx/pjsip__50-7-extensions.conf
#   asterisk -rx 'pjsip reload'
# ============================================================================
set -euo pipefail

CONF="/etc/asterisk/vitalpbx/pjsip__50-7-extensions.conf"
AORS=(T7_101 T7_102 T7_103 T7_104 T7_105 T7_106 T7_107)
# Desk aor headers look like [T7_101](p7-aor). The literal "]" right after the
# extension number is what excludes the app legs ([T7_101_1](...)).
HDR_RE='^\[T7_10[1-7]\]\([^)]*-aor\)'

fail() { echo "ABORT: $*" >&2; exit 1; }

MODE="${1:-}"
[[ "$MODE" == "--check" || "$MODE" == "--apply" ]] || \
  fail "usage: $0 --check | --apply"

command -v asterisk >/dev/null || fail "asterisk CLI not found — run this ON the PBX host"
[[ -f "$CONF" ]] || fail "$CONF not found"

show_state() {
  echo "--- desk aor expiration state (pjsip show aor) ---"
  for a in "${AORS[@]}"; do
    line=$(asterisk -rx "pjsip show aor $a" | grep -iE 'maximum_expiration|default_expiration' | tr -s ' ' || true)
    echo "$a: ${line:-<aor not found>}"
  done
  echo "--- contacts ---"
  asterisk -rx "pjsip show contacts" | grep -E 'T7_10[1-7]/' || echo "(no desk contacts registered)"
}

hdr_count=$(grep -cE "$HDR_RE" "$CONF" || true)
echo "[info] $CONF: $hdr_count desk aor section(s) matched (expect 7)"

if [[ "$MODE" == "--check" ]]; then
  show_state
  exit 0
fi

# ---- apply ----
[[ "$hdr_count" -eq 7 ]] || fail "expected exactly 7 desk aor sections, found $hdr_count — file layout changed, do not edit blind"

# Idempotency / partial-state guard: none of the desk sections may already
# carry an expiration override.
already=$(awk -v hdr="$HDR_RE" '
  $0 ~ hdr {in_desk=1; next}
  /^\[/ {in_desk=0}
  in_desk && /^(minimum|default|maximum)_expiration=/ {n++}
  END {print n+0}' "$CONF")
if [[ "$already" -gt 0 ]]; then
  echo "[info] $already expiration line(s) already present in desk aor sections — nothing to do."
  show_state
  exit 0
fi

TS=$(date +%Y%m%d-%H%M%S)
BACKUP="${CONF}.bak-${TS}"
cp -p "$CONF" "$BACKUP"
echo "[info] backup: $BACKUP"

TMP=$(mktemp)
awk -v hdr="$HDR_RE" '
  {print}
  $0 ~ hdr {
    print "minimum_expiration=60"
    print "default_expiration=120"
    print "maximum_expiration=120"
  }' "$CONF" > "$TMP"

added=$(diff "$BACKUP" "$TMP" | grep -c '^>' || true)
removed=$(diff "$BACKUP" "$TMP" | grep -c '^<' || true)
if [[ "$added" -ne 21 || "$removed" -ne 0 ]]; then
  rm -f "$TMP"
  fail "diff check failed (added=$added removed=$removed, expected 21/0) — file NOT modified"
fi

cp "$TMP" "$CONF"
rm -f "$TMP"
echo "[info] edit written (21 lines added). Reloading pjsip..."
asterisk -rx "pjsip reload" >/dev/null
sleep 2

bad=0
for a in "${AORS[@]}"; do
  if ! asterisk -rx "pjsip show aor $a" | grep -qE 'maximum_expiration[[:space:]]*:[[:space:]]*120'; then
    echo "[verify] $a: maximum_expiration is NOT 120" >&2
    bad=1
  fi
done

if [[ "$bad" -ne 0 ]]; then
  echo "[verify] FAILED — restoring backup and reloading" >&2
  cp -p "$BACKUP" "$CONF"
  asterisk -rx "pjsip reload" >/dev/null
  fail "verification failed; original config restored from $BACKUP"
fi

echo "[done] all 7 desk aors now cap registration at 120 s."
echo "[done] phones pick up the new expiry on their next re-register (worst case ~2 h under the old grant; reboot/power-cycle a phone to force it now)."
show_state
