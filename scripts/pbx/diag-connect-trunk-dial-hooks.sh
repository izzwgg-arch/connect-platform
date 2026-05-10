#!/usr/bin/env bash
# diag-connect-trunk-dial-hooks.sh
# =============================================================================
# Read-only diagnostic for the caller-leg MOH problem on outbound trunk calls.
#
# PJSIP endpoint append is proven impossible on this build (VitalPBX 4.5.3-1 /
# Asterisk 20.18.2 — endpoints are sorcery-wizard-driven and ignore flat-file
# `[endpoint](+)` everywhere). The next-best injection point is somewhere in
# the dialplan path the caller's leg traverses BEFORE `trk-33-dial` priority
# 21 runs:
#
#   exten => _X.,21,ExecIf($["${TRUNK_MOH_SET}"!="yes"]?Set(CHANNEL(musicclass)=default):)
#   exten => _X.,22,Set(__TRUNK_MOH_SET=yes)
#
# If we can land a Set(CHANNEL(musicclass)=<tenant_class>) + Set(TRUNK_MOH_SET=yes)
# anywhere upstream of priority 21, the ExecIf becomes a no-op and our value
# survives the Dial.
#
# This script:
#   - locates every VitalPBX-generated dialplan file under /etc/asterisk/
#   - dumps the FULL dialplan listing for trk-33-dial
#   - dumps the calling extension's `context` (T3_cos-all) and the chain of
#     contexts it Goto/Gosub's into
#   - greps the generated config for hookable patterns the user listed:
#       start-trunk-dialing-hook
#       before-trunk-dialing-hook
#       trunk-dialing-hook
#       ${TENANT_PREFIX}.*trunk-related-hook
#       TRUNK_MOH_SET assignments and reads
#       CHANNEL(musicclass)= (any value) — find every site that touches it
#       DIALPLAN_EXISTS(...) — every conditional hook gosub VitalPBX exposes
#   - lists every per-tenant T<id>_* context name so we know which ones
#     already exist and are safe to (+) extend
#
# No writes, no reloads, no service restarts. Asterisk CLI is queried through
# `asterisk -rx` exactly the way the prior diagnostic did.
#
# Usage (as root on the PBX):
#   sudo bash diag-connect-trunk-dial-hooks.sh [tenant_id] [calling_ext]
#
# Defaults:
#   tenant_id   = 3
#   calling_ext = 103   (used to derive expected context name T<id>_cos-all
#                       and the trunk dial group from `pjsip show endpoint`)
# =============================================================================

set -uo pipefail

TID="${1:-3}"
EXT="${2:-103}"

step() { printf '\n=== %s ===\n' "$*"; }
note() { printf '  - %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }

if [[ "$(id -u)" -ne 0 ]]; then
  warn "must be run as root for full /etc/asterisk read access."
  exit 1
fi

VPBX_DIR="/etc/asterisk/vitalpbx"
EXT_DIR="/etc/asterisk"

step "0. environment"
note "tenant id        = $TID"
note "calling ext      = $EXT"
note "asterisk         = $(asterisk -V 2>&1 | head -1)"
note "vitalpbx dialplan dir present? $([[ -d "$VPBX_DIR" ]] && echo yes || echo no)"
note "extensions custom file? /etc/asterisk/extensions__60_custom.conf $([[ -f /etc/asterisk/extensions__60_custom.conf ]] && echo yes || echo missing)"

# -----------------------------------------------------------------------------
# 1. inventory of every VitalPBX-generated dialplan file
# -----------------------------------------------------------------------------
step "1. dialplan file inventory"
note "files in $VPBX_DIR:"
ls -1 "$VPBX_DIR"/extensions*.conf 2>/dev/null | sed 's/^/    /' \
  || note "  (none)"
echo "----"
note "files in $EXT_DIR matching extensions__*:"
ls -1 "$EXT_DIR"/extensions__*.conf 2>/dev/null | sed 's/^/    /' \
  || note "  (none)"
echo "----"
note "main /etc/asterisk/extensions.conf #include lines:"
grep -nE '^\s*#include|^\s*#tryinclude' /etc/asterisk/extensions.conf 2>/dev/null \
  | sed 's/^/    /' || note "  (no #include lines or file unreadable)"

# -----------------------------------------------------------------------------
# 2. trk-33-dial — the contested context
# -----------------------------------------------------------------------------
step "2. dialplan show trk-33-dial (full)"
asterisk -rx 'dialplan show trk-33-dial' 2>&1 | sed 's/^/    /'

step "2b. which file defines trk-33-dial / TRUNK_MOH_SET / CHANNEL(musicclass)=default ?"
note "trk-33-dial section header:"
grep -RnE '^\[trk-33-dial\]' "$VPBX_DIR" "$EXT_DIR" 2>/dev/null | sed 's/^/    /'
note "TRUNK_MOH_SET assignments (read + write):"
grep -RnE 'TRUNK_MOH_SET' "$VPBX_DIR" "$EXT_DIR" 2>/dev/null | sed 's/^/    /'
note "every line that touches CHANNEL(musicclass):"
grep -RnE 'CHANNEL\(musicclass\)' "$VPBX_DIR" "$EXT_DIR" 2>/dev/null | sed 's/^/    /'

# -----------------------------------------------------------------------------
# 3. hookable trunk-dial patterns
# -----------------------------------------------------------------------------
step "3. hookable trunk-dial patterns the user enumerated"
for pat in \
  'start-trunk-dialing-hook' \
  'before-trunk-dialing-hook' \
  'trunk-dialing-hook' \
  'TENANT_PREFIX.*trunk' \
  'TENANT_PREFIX.*dial' \
  'before-trunk-dial' \
  'sub-before-trunk' \
  'pre-trunk-dial' \
  'trunk-pre-dial' \
  ; do
  echo
  note "pattern: $pat"
  hits="$(grep -RnE "$pat" "$VPBX_DIR" "$EXT_DIR" 2>/dev/null)"
  if [[ -n "$hits" ]]; then
    printf '%s\n' "$hits" | sed 's/^/    /' | head -40
  else
    note "  (no hits)"
  fi
done

step "3b. every DIALPLAN_EXISTS conditional in the dialplan"
note "any DIALPLAN_EXISTS gosub is a designed hook point — list every one:"
grep -RnE 'DIALPLAN_EXISTS\(' "$VPBX_DIR" "$EXT_DIR" 2>/dev/null \
  | sed 's/^/    /' | head -80

# -----------------------------------------------------------------------------
# 4. caller-leg context chain — T<id>_cos-all and what it Goto/Gosub's into
# -----------------------------------------------------------------------------
CTX="T${TID}_cos-all"
step "4. dialplan show $CTX (caller's endpoint context)"
asterisk -rx "dialplan show $CTX" 2>&1 | sed 's/^/    /' | head -120

step "4b. every T${TID}_* context defined in the generated dialplan"
note "these are candidates for safe Connect-owned (+) extension append:"
grep -RhE "^\[T${TID}_[a-zA-Z0-9_-]+\]" "$VPBX_DIR" "$EXT_DIR" 2>/dev/null \
  | sort -u | sed 's/^/    /'

# -----------------------------------------------------------------------------
# 5. trunk dial group — find the Dial() that uses trk-33-*
# -----------------------------------------------------------------------------
step "5. who calls trk-33-dial and what context invokes the Dial()?"
note "every line that references trk-33 (Goto/Gosub/Dial/Local target):"
grep -RnE 'trk-33|trk_33' "$VPBX_DIR" "$EXT_DIR" 2>/dev/null \
  | sed 's/^/    /' | head -60

step "5b. Dial( application calls in the generated dialplan that target a trunk"
note "any Dial(Local/...@trk-...) or Dial(SIP/.../@trk-...) is a caller-leg site:"
grep -RnE 'Dial\([^,)]+@trk-' "$VPBX_DIR" "$EXT_DIR" 2>/dev/null \
  | sed 's/^/    /' | head -40

# -----------------------------------------------------------------------------
# 6. Connect-owned contexts already loaded (sanity)
# -----------------------------------------------------------------------------
step "6. Connect-owned dialplan contexts currently loaded"
for ctx in \
  sub-connect-tenant-moh \
  global-before-bridging-call-hook \
  "T${TID}_before-connecting-call-hook" \
  ; do
  note "context: $ctx"
  asterisk -rx "dialplan show $ctx" 2>&1 \
    | grep -E "(created by|Context.*does not exist|extension)" \
    | sed 's/^/    /' | head -6
done

step "DONE — interpretation guide"
cat <<'TXT'

Read sections in this order:

  Section 2 (trk-33-dial full listing) — confirm priorities 21/22 still
    contain ExecIf(... CHANNEL(musicclass)=default) and Set(__TRUNK_MOH_SET=yes).
    Note the exact extension pattern (likely _X.) and the file:line that
    owns priority 1 (the head of the context). That is the file we are
    forbidden to edit but whose context we may (+) append to.

  Section 3 + 3b (hook patterns + DIALPLAN_EXISTS) — the cheapest win is
    any hit on `start-trunk-dialing-hook`, `before-trunk-dialing-hook`,
    `pre-trunk-dial`, etc., or any `DIALPLAN_EXISTS(${TENANT_PREFIX}...)`
    gosub firing in the trunk dial path. If any exist, the proposed fix
    is to drop a `[T<id>_<hookname>]` context into our existing
    extensions__65_connect_tenant_moh.conf with the two-line body:
      Set(CHANNEL(musicclass)=<class>)
      Set(__TRUNK_MOH_SET=yes)
    No changes to generated VitalPBX files required.

  Section 4 (T<id>_cos-all chain + every T<id>_* context) — if no
    explicit trunk hook exists, the next-cheapest injection point is a
    (+) extension append on a per-tenant context the caller's leg
    traverses BEFORE Goto/Dial into trk-33-dial. Look for a context like
    T<id>_outbound-routes / T<id>_local-dial / T<id>_dialout-* that
    pattern-matches the dialed number; we can add a Set() priority via
    `(+) exten => _X.,1,Set(...)` if and only if priority 1 is unused on
    that pattern in the original context (otherwise our (+) priorities
    would land at the end of the priority chain, AFTER the Goto, and be
    unreachable).

  Section 5 (trk-33-dial callers) — if section 4 doesn't expose a clean
    per-tenant pre-dial context, the operator-of-last-resort is to wrap
    `trk-33-dial` itself by inserting a Connect-owned wrapper context
    `[connect-trk-33-dial]` that does the two Sets and then Goto's into
    the original trk-33-dial,$EXTEN,1. The risk is that the wrap site
    is the caller's outbound-route Goto(trk-33-dial,...), which lives in
    a generated VitalPBX file. We do NOT edit that file; instead we
    rebind the destination by creating a [trk-33-dial-wrap] context and
    adding a one-line override in extensions__60_custom.conf. This is
    the highest-risk option and should only be considered if sections
    3+4 yield nothing.

  Section 6 (Connect contexts loaded) — sanity: confirms our existing
    dialplan layer is still installed and functioning so we can safely
    add new contexts to extensions__65_connect_tenant_moh.conf.

After you run this, send back at minimum sections 2, 3, 3b, 4, and 4b.
TXT
