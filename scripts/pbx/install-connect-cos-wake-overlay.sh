#!/usr/bin/env bash
# ============================================================================
# install-connect-cos-wake-overlay.sh — Install the Connect cold-mobile
#   cos-all interception overlay on a VitalPBX host.
#
# MODEL (this version): KEY-DRIVEN PATTERN GATE for ALL Connect-known tenants.
#
#   The overlay is now a STATIC, per-tenant pattern gate. It is installed ONCE
#   and never needs regeneration/reload when a mobile extension is added or
#   removed. The SINGLE runtime control point is the Connect-owned AstDB key
#
#       connect/wake_canary/T<tid>_<ext> = 1
#
#   which the [connect-dial-with-wake] IVR gate ALREADY reads. This overlay
#   makes the NATIVE call path (internal ext→ext, ring group, queue, IVR-only,
#   parking timeout — everything that funnels through [T<tid>_cos-all]) read
#   the very same key. So one key now controls BOTH surfaces for an endpoint.
#
#   How it works:
#     • This writes a SEPARATE, Connect-owned dialplan file
#         /etc/asterisk/extensions__66_connect_cos_wake.conf
#       that declares the SAME-NAMED context [T<tid>_cos-all] with numeric
#       extension-length PATTERNS (default _XXX and _XXXX). Asterisk merges
#       same-named contexts across files, and a context's OWN pattern is
#       matched BEFORE its generated `include => T<tid>_cos-all-init`, so this
#       pattern intercepts every local numeric dial at the earliest chokepoint.
#     • The pattern reads connect/wake_canary/T<tid>_${EXTEN}:
#         - value != "1"  → immediate Goto(T<tid>_cos-all-init,${EXTEN},1)
#                           (BYTE-IDENTICAL to today's native include path).
#         - value == "1"  → Gosub(connect-wake-core,...) (the PROVEN wake/grace
#                           engine — probe/UserEvent/ringback/grace, ALWAYS
#                           Return()s) then the SAME handback to init.
#     • Desk-only extensions, ring groups, queues, parking numbers, etc. never
#       get a key, so they always hand back = ZERO behavior change.
#
#   It NEVER edits any VitalPBX-generated file. It survives "Apply Changes"
#   because the generated extensions__50-*.conf is rewritten but our separate
#   __66 file is not, and Asterisk re-merges the contexts on reload.
#
#   Safety guards baked into every stanza:
#     • __CONNECT_WAKE_DONE one-shot guard (no re-entry / no Local-channel loop)
#     • paging/intercom bypass (FORCE_INTERCOM / SRC_APP=PAGING / SKIP_CONTACT_SERVICES)
#     • DIALPLAN_EXISTS(connect-wake-core) guard — engine absent ⇒ native dial.
#     • NO Answer(), NO Dial(), NO Local/ channel — the stanza only reads the
#       key, optionally Gosubs the engine, and hands back. No duplicate legs.
#
#   This installer does NOT write any connect/wake_canary/* keys. Enabling and
#   disabling extensions is owned by the reconciler:
#       scripts/pbx/wake-canary-reconcile.mjs
#   Installing this overlay is inert until the reconciler publishes keys.
#
# REQUIREMENT: [connect-wake-core] must already be installed (it ships in
#   extensions__60_custom.conf via install-connect-wake-dialplan.sh). This
#   script verifies it and refuses to install if it is missing.
#
# TENANT DISCOVERY: tenant ids come from the Connect-owned AstDB reverse map
#   connect/pbx_tenant_map (same source the MOH installer uses). One stanza is
#   generated per numeric tenant id that also has a live [T<id>_cos-all-init].
#
# This script is IDEMPOTENT — safe to re-run.
#
# Usage:
#   chmod +x install-connect-cos-wake-overlay.sh
#   sudo ./install-connect-cos-wake-overlay.sh            # install
#   sudo ./install-connect-cos-wake-overlay.sh --check    # read-only health probe
#   sudo ./install-connect-cos-wake-overlay.sh --rollback # remove Connect-owned overlay
#   ./install-connect-cos-wake-overlay.sh --help
#
# Rollback (removes the native gate for ALL tenants; runtime keys are left to
# the reconciler and, with the overlay gone, become inert for the native path):
#   sudo rm -f /etc/asterisk/extensions__66_connect_cos_wake.conf \
#     && asterisk -rx 'dialplan reload'
# ============================================================================

set -euo pipefail

step() { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '\nWARN: %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

OVERLAY_FILE="/etc/asterisk/extensions__66_connect_cos_wake.conf"
CUSTOM_DIALPLAN="/etc/asterisk/extensions__60_custom.conf"
INCLUDE_LINE="#tryinclude extensions__66_connect_cos_wake.conf"

# Extension-number-length patterns generated per tenant. VitalPBX extensions are
# 3–4 numeric digits; feature codes (*NN / #NN) and outbound numbers never match
# these, so the gate only ever intercepts local numeric extension dials. Each
# pattern carries its OWN inline body (ending in a hand-back to the native init
# context) so there is never a Goto back into this context (no loop).
PATTERNS="_XXX _XXXX"

# ── Per-tenant stanza generator ─────────────────────────────────────────────
# Emits the key-driven gate for one numeric tenant id. Asterisk ${...} refs are
# kept LITERAL by using single-quoted printf format strings; only %s (the tid /
# the pattern token) is substituted by the shell.
emit_cos_wake_stanza() {
  local tid="$1"
  local pat
  printf '[T%s_cos-all]\n' "$tid"
  for pat in $PATTERNS; do
    printf 'exten => %s,1,NoOp(Connect cos-wake gate tid=%s ext=${EXTEN} done=${__CONNECT_WAKE_DONE} src=${SRC_APP} intercom=${FORCE_INTERCOM})\n' "$pat" "$tid"
    printf ' same => n,GotoIf($["${__CONNECT_WAKE_DONE}" = "1"]?handback)\n'
    printf ' same => n,GotoIf($[$["${FORCE_INTERCOM}" = "yes"] | $["${SRC_APP}" = "PAGING"] | $["${SKIP_CONTACT_SERVICES}" = "TRUE"]]?handback)\n'
    printf ' same => n,GotoIf($[${DIALPLAN_EXISTS(connect-wake-core,s,1)} != 1]?handback)\n'
    printf ' same => n,Set(WAKE_CANARY=${DB(connect/wake_canary/T%s_${EXTEN})})\n' "$tid"
    printf ' same => n,GotoIf($["${WAKE_CANARY}" != "1"]?handback)\n'
    printf ' same => n,Set(__CONNECT_WAKE_DONE=1)\n'
    printf ' same => n,Gosub(connect-wake-core,s,1(%s,${EXTEN},1))\n' "$tid"
    printf ' same => n(handback),Goto(T%s_cos-all-init,${EXTEN},1)\n' "$tid"
  done
  printf '\n'
}

# ── CLI mode dispatch (must precede any root/asterisk preflight) ────────────
MODE="install"
case "${1:-}" in
  ""|install)                      MODE="install" ;;
  -h|--help|help)                  MODE="help" ;;
  --check|-n|--dry-run|check)      MODE="check" ;;
  --rollback|--uninstall|rollback|uninstall) MODE="rollback" ;;
  *) printf 'Unknown option: %s\n' "$1" >&2; printf 'Try: %s --help\n' "$0" >&2; exit 64 ;;
esac

if [[ "$MODE" = "help" ]]; then
  cat <<HELP
install-connect-cos-wake-overlay.sh — Connect cold-mobile cos-all key-driven gate

Modes:
  install      (default) Write the Connect-owned pattern overlay for every
               Connect-known tenant, ensure it is #tryinclude'd, reload dialplan,
               and verify the merge. Writes NO AstDB keys (reconciler owns those).
  --check      Read-only health probe: overlay file present, include line
               present, [connect-wake-core] loaded, sample [T<id>_cos-all]
               shows the gate pattern AND the native include. PASS/FAIL only.
  --rollback   Remove ONLY the Connect-owned overlay file + its #tryinclude line
               and reload. Leaves all VitalPBX-generated files untouched. With
               the overlay gone, the native path reverts to stock behavior for
               every tenant (runtime keys become inert for the native path).
  --help       This text.

Runtime control point (managed by scripts/pbx/wake-canary-reconcile.mjs):
  connect/wake_canary/T<tid>_<ext> = 1   → wake-canary path
  (absent / != 1)                        → stock VitalPBX behavior
HELP
  exit 0
fi

# ── do_rollback ─────────────────────────────────────────────────────────────
do_rollback() {
  [[ $EUID -eq 0 ]] || die "Run as root (sudo)."
  command -v asterisk >/dev/null 2>&1 || die "asterisk binary not found in PATH"
  local removed=0
  if [[ -f "$OVERLAY_FILE" ]]; then
    printf '[REMOVE] %s\n' "$OVERLAY_FILE"
    rm -f "$OVERLAY_FILE"
    removed=1
  else
    printf '[SKIP] overlay already absent: %s\n' "$OVERLAY_FILE"
  fi
  if [[ -f "$CUSTOM_DIALPLAN" ]] && grep -qxF "$INCLUDE_LINE" "$CUSTOM_DIALPLAN"; then
    local rb="${CUSTOM_DIALPLAN}.bak.connect-cos-wake-rollback.$(date +%Y%m%d-%H%M%S)"
    cp -a "$CUSTOM_DIALPLAN" "$rb"
    sed -i '/^#tryinclude extensions__66_connect_cos_wake\.conf$/d' "$CUSTOM_DIALPLAN"
    printf '[REMOVE] #tryinclude line from %s (backup %s)\n' "$CUSTOM_DIALPLAN" "$rb"
    removed=1
  else
    printf '[SKIP] #tryinclude line already absent\n'
  fi
  if [[ "$removed" -eq 1 ]]; then
    asterisk -rx 'dialplan reload' >/dev/null 2>&1 || true
    printf '  ↳ dialplan reloaded\n'
  fi
  printf 'RESULT: rollback complete\n'
  return 0
}

# ── do_health_check (read-only) ─────────────────────────────────────────────
do_health_check() {
  command -v asterisk >/dev/null 2>&1 || die "asterisk binary not found in PATH"
  local checks=0 fail=0
  checks=$((checks + 1))
  if [[ -f "$OVERLAY_FILE" ]]; then
    printf '[PASS] overlay file present: %s\n' "$OVERLAY_FILE"
  else
    printf '[FAIL] overlay file missing: %s\n' "$OVERLAY_FILE"; fail=$((fail + 1))
  fi
  checks=$((checks + 1))
  if [[ -f "$CUSTOM_DIALPLAN" ]] && grep -qxF "$INCLUDE_LINE" "$CUSTOM_DIALPLAN"; then
    printf '[PASS] #tryinclude line present in %s\n' "$CUSTOM_DIALPLAN"
  else
    printf '[FAIL] #tryinclude line missing in %s\n' "$CUSTOM_DIALPLAN"; fail=$((fail + 1))
  fi
  checks=$((checks + 1))
  if asterisk -rx 'dialplan show connect-wake-core' 2>&1 | grep -q "PJSIP_DIAL_CONTACTS"; then
    printf '[PASS] [connect-wake-core] engine loaded\n'
  else
    printf '[FAIL] [connect-wake-core] engine NOT loaded\n'; fail=$((fail + 1))
  fi
  # Sample one Connect-known tenant and confirm the merged context shows both
  # the gate pattern and the native include.
  local sample_tid
  sample_tid="$(asterisk -rx 'database show connect/pbx_tenant_map' 2>/dev/null \
    | awk -F'/' '/^\/connect\/pbx_tenant_map\//{print $4}' | grep -E '^[0-9]+$' | sort -un | head -n1 || true)"
  checks=$((checks + 1))
  if [[ -n "$sample_tid" ]]; then
    local show
    show="$(asterisk -rx "dialplan show T${sample_tid}_cos-all" 2>&1 || true)"
    if echo "$show" | grep -q "cos-all-init" && echo "$show" | grep -Eq "_XXX"; then
      printf '[PASS] sample [T%s_cos-all] shows gate pattern AND native include\n' "$sample_tid"
    else
      printf '[FAIL] sample [T%s_cos-all] missing gate pattern or native include\n' "$sample_tid"; fail=$((fail + 1))
    fi
  else
    printf '[SKIP] no Connect-known tenant in connect/pbx_tenant_map to sample\n'
  fi
  printf '\n====================================================\n'
  if [[ $fail -eq 0 ]]; then
    printf 'RESULT: PASS (%s/%s checks healthy)\n' "$checks" "$checks"; return 0
  else
    printf 'RESULT: FAIL (%s/%s checks failed)\n' "$fail" "$checks"; return 1
  fi
}

case "$MODE" in
  check)    do_health_check; exit $? ;;
  rollback) do_rollback;     exit $? ;;
  install)  : # fall through
esac

# ── 1. Preflight ────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "Run as root (sudo)."
command -v asterisk >/dev/null 2>&1 || die "asterisk binary not found in PATH"
asterisk -rx "core show channels count" >/dev/null 2>&1 || die "asterisk -rx not responsive — is Asterisk running?"

BACKUP_FILE="${OVERLAY_FILE}.bak.$(date +%Y%m%d-%H%M%S)"

# ── 2. Verify the canonical engine is present ───────────────────────────────
step "[1/7] Verify [connect-wake-core] engine is loaded"
CORE_OUT="$(asterisk -rx 'dialplan show connect-wake-core' 2>&1 || true)"
if ! echo "$CORE_OUT" | grep -q "PJSIP_DIAL_CONTACTS"; then
  warn "[connect-wake-core] not found. Output was:"
  echo "$CORE_OUT" | head -20
  die "Install the wake engine first (install-connect-wake-dialplan.sh)."
fi
echo "  ↳ OK — [connect-wake-core] present"

# ── 3. Enumerate Connect-known tenant ids ───────────────────────────────────
step "[2/7] Enumerate Connect-known tenant ids from connect/pbx_tenant_map"
TENANT_IDS="$(asterisk -rx 'database show connect/pbx_tenant_map' 2>/dev/null \
  | awk -F'/' '/^\/connect\/pbx_tenant_map\//{print $4}' \
  | grep -E '^[0-9]+$' | sort -un || true)"
if [[ -z "$TENANT_IDS" ]]; then
  warn "No tenants found in connect/pbx_tenant_map AstDB family."
  warn "Publish Connect tenant map first, then re-run this installer."
  die "Refusing to install an empty overlay."
fi
echo "  ↳ tenant ids: $(printf '%s ' $TENANT_IDS)"

# Keep only tenant ids that actually have a live native hand-back target.
KEPT_IDS=""
SKIPPED_IDS=""
for tid in $TENANT_IDS; do
  if asterisk -rx "dialplan show T${tid}_cos-all-init" 2>&1 | grep -q "Context 'T${tid}_cos-all-init'"; then
    KEPT_IDS="${KEPT_IDS}${tid} "
  else
    SKIPPED_IDS="${SKIPPED_IDS}T${tid} "
  fi
done
if [[ -z "$KEPT_IDS" ]]; then
  die "No Connect-known tenant has a live [T<id>_cos-all-init] — refusing to install."
fi
echo "  ↳ will generate gate for: $KEPT_IDS"
[[ -n "$SKIPPED_IDS" ]] && warn "skipped (no cos-all-init yet): $SKIPPED_IDS"

# ── 4. Snapshot any existing overlay + write the new one ────────────────────
step "[3/7] Write Connect cos-all key-driven pattern overlay"
if [[ -f "$OVERLAY_FILE" ]]; then
  cp -a "$OVERLAY_FILE" "$BACKUP_FILE"
  echo "  ↳ backed up existing overlay to $BACKUP_FILE"
fi

{
  cat <<'HDR'
; ============================================================================
; Connect cold-mobile cos-all interception overlay (KEY-DRIVEN PATTERN GATE)
; (Auto-installed by install-connect-cos-wake-overlay.sh — DO NOT HAND-EDIT.)
;
; One stanza per Connect-known tenant. Each declares the SAME-NAMED context
; [T<tid>_cos-all] as the VitalPBX-generated one and adds numeric extension
; patterns that read the SINGLE runtime control key:
;     connect/wake_canary/T<tid>_<ext> = 1  → connect-wake-core wake path
;     (absent / != 1)                       → immediate native hand-back
; No VitalPBX-generated file is touched. Enabling/disabling extensions is owned
; by scripts/pbx/wake-canary-reconcile.mjs (this file writes NO AstDB keys).
; ============================================================================
HDR
  printf '\n'
  for tid in $KEPT_IDS; do
    emit_cos_wake_stanza "$tid"
  done
} > "$OVERLAY_FILE"

chown asterisk:asterisk "$OVERLAY_FILE"
chmod 0644 "$OVERLAY_FILE"
echo "  ↳ wrote $OVERLAY_FILE ($(wc -l < "$OVERLAY_FILE" | tr -d ' ') lines)"

# ── 5. Ensure the overlay is actually #include'd ────────────────────────────
step "[4/7] Ensure ${CUSTOM_DIALPLAN##*/} includes the overlay"
if [[ ! -f "$CUSTOM_DIALPLAN" ]]; then
  warn "$CUSTOM_DIALPLAN not found — install-connect-wake-dialplan.sh must run first."
  rm -f "$OVERLAY_FILE"
  die "Connect include hub missing; removed overlay."
fi
if grep -qxF "$INCLUDE_LINE" "$CUSTOM_DIALPLAN"; then
  echo "  ↳ already present"
else
  cp -a "$CUSTOM_DIALPLAN" "${CUSTOM_DIALPLAN}.bak.$(date +%Y%m%d-%H%M%S)"
  printf '\n%s\n' "$INCLUDE_LINE" >> "$CUSTOM_DIALPLAN"
  echo "  ↳ appended '$INCLUDE_LINE'"
fi

# ── 6. Reload + verify the merge ────────────────────────────────────────────
step "[5/7] Reload Asterisk dialplan"
RELOAD_OUT="$(asterisk -rx 'dialplan reload' 2>&1 || true)"
echo "  ↳ $RELOAD_OUT"

SAMPLE_TID="$(printf '%s' "$KEPT_IDS" | awk '{print $1}')"
step "[6/7] Verify merged context [T${SAMPLE_TID}_cos-all]"
SHOW_OUT="$(asterisk -rx "dialplan show T${SAMPLE_TID}_cos-all" 2>&1 || true)"
echo "$SHOW_OUT" | sed 's/^/      /'
if echo "$SHOW_OUT" | grep -Eq "_XXX" \
   && echo "$SHOW_OUT" | grep -q "T${SAMPLE_TID}_cos-all-init"; then
  echo "  ↳ OK — gate pattern merged AND native include => T${SAMPLE_TID}_cos-all-init still present"
else
  warn "Merge verification failed — expected both the gate pattern and the native include."
  warn "Rolling back overlay."
  rm -f "$OVERLAY_FILE"
  asterisk -rx "dialplan reload" >/dev/null 2>&1 || true
  die "Overlay merge failed — removed overlay and reloaded."
fi

# ── 7. Done ─────────────────────────────────────────────────────────────────
step "[7/7] Done"
cat <<DONE

============================================================================
COS-WAKE KEY-DRIVEN OVERLAY INSTALLED.

File:              $OVERLAY_FILE
Tenants gated:     $KEPT_IDS
Runtime control:   connect/wake_canary/T<tid>_<ext> = 1   (managed by
                   scripts/pbx/wake-canary-reconcile.mjs — this installer
                   writes NO keys)

Behavior:
  • key = 1  → native call to that ext runs [connect-wake-core] then hands back
  • key ≠ 1  → immediate native hand-back (stock VitalPBX behavior, unchanged)
  • desk-only / ring group / queue / parking numbers with no key → unchanged

Live verification:
  asterisk -rx 'dialplan show T${SAMPLE_TID}_cos-all'
  asterisk -rx 'database show connect/wake_canary'
  asterisk -rvvv   # watch for "Connect cos-wake gate" + "connect-wake-core" on a test call

Rollback (removes native gate for ALL tenants; reconciler keys become inert
for the native path):
  sudo $0 --rollback
  # or manually:
  rm -f $OVERLAY_FILE \\
    && sed -i '/^#tryinclude extensions__66_connect_cos_wake\\.conf\$/d' $CUSTOM_DIALPLAN \\
    && asterisk -rx 'dialplan reload'
============================================================================
DONE
