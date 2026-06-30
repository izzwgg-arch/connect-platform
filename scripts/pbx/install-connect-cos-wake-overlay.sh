#!/usr/bin/env bash
# ============================================================================
# install-connect-cos-wake-overlay.sh — Install the Connect cold-mobile
#   cos-all interception overlay on a VitalPBX host.
#
# CANARY SCOPE (this version): Tenant T2, extension 110 ONLY.
#
# What it does:
#   This writes a SEPARATE, Connect-owned dialplan file
#     /etc/asterisk/extensions__66_connect_cos_wake.conf
#   that declares the SAME-NAMED context [T2_cos-all] with a single explicit
#   `exten => 110`. Asterisk merges same-named contexts across all included
#   files, and an explicit extension (110) always wins over the VitalPBX-
#   generated `include => T2_cos-all-init` catch-all pattern. So a native call
#   to ext 110 is intercepted at the earliest dial chokepoint, runs the
#   canonical [connect-wake-core] wake/grace engine, and then hands back to the
#   native dialplan via Goto(T2_cos-all-init,110,1).
#
#   It NEVER edits any VitalPBX-generated file. It survives "Apply Changes"
#   because the generated extensions__50-*.conf is rewritten but our separate
#   __66 file is not, and Asterisk re-merges the contexts on reload.
#
#   Safety guards baked into the stanza:
#     • __CONNECT_WAKE_DONE one-shot guard (no re-entry / no loop)
#     • paging/intercom bypass (FORCE_INTERCOM / SRC_APP=PAGING / SKIP_CONTACT_SERVICES)
#     • DIALPLAN_EXISTS(connect-wake-core) guard — if the engine is absent, the
#       intercept degrades to plain native dialing (safe partial rollback).
#
# REQUIREMENT: [connect-wake-core] must already be installed (it ships in
#   extensions__60_custom.conf via install-connect-wake-dialplan.sh). This
#   script verifies it and refuses to install if it is missing.
#
# This script is IDEMPOTENT — safe to re-run.
#
# Usage:
#   chmod +x install-connect-cos-wake-overlay.sh
#   sudo ./install-connect-cos-wake-overlay.sh
#
# Rollback:
#   sudo rm -f /etc/asterisk/extensions__66_connect_cos_wake.conf \
#     && asterisk -rx 'dialplan reload'
# ============================================================================

set -euo pipefail

step() { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '\nWARN: %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# ── 1. Preflight ────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "Run as root (sudo)."
command -v asterisk >/dev/null 2>&1 || die "asterisk binary not found in PATH"
asterisk -rx "core show channels count" >/dev/null 2>&1 || die "asterisk -rx not responsive — is Asterisk running?"

OVERLAY_FILE="/etc/asterisk/extensions__66_connect_cos_wake.conf"
BACKUP_FILE="${OVERLAY_FILE}.bak.$(date +%Y%m%d-%H%M%S)"

# Canary scope — change ONLY these to widen scope in a later stage.
TENANT_ID="2"
EXT="110"
COS_CONTEXT="T${TENANT_ID}_cos-all"
INIT_CONTEXT="T${TENANT_ID}_cos-all-init"

# ── 2. Verify the canonical engine is present ───────────────────────────────
step "[1/6] Verify [connect-wake-core] engine is loaded"
CORE_OUT="$(asterisk -rx 'dialplan show connect-wake-core' 2>&1 || true)"
if ! echo "$CORE_OUT" | grep -q "PJSIP_DIAL_CONTACTS"; then
  warn "[connect-wake-core] not found. Output was:"
  echo "$CORE_OUT" | head -20
  die "Install the wake engine first (install-connect-wake-dialplan.sh)."
fi
echo "  ↳ OK — [connect-wake-core] present"

# ── 3. Verify the native hand-back target exists ────────────────────────────
step "[2/6] Verify native hand-back target [${INIT_CONTEXT}] exists"
INIT_OUT="$(asterisk -rx "dialplan show ${INIT_CONTEXT}" 2>&1 || true)"
if ! echo "$INIT_OUT" | grep -q "Context '${INIT_CONTEXT}'"; then
  warn "[${INIT_CONTEXT}] not found — VitalPBX may not have generated tenant T${TENANT_ID} yet. Output was:"
  echo "$INIT_OUT" | head -20
  die "Refusing to install: hand-back target missing."
fi
echo "  ↳ OK — [${INIT_CONTEXT}] present"

# ── 4. Snapshot any existing overlay + write the new one ────────────────────
step "[3/6] Write Connect cos-all overlay (${COS_CONTEXT} ext ${EXT})"
if [[ -f "$OVERLAY_FILE" ]]; then
  cp -a "$OVERLAY_FILE" "$BACKUP_FILE"
  echo "  ↳ backed up existing overlay to $BACKUP_FILE"
fi

cat > "$OVERLAY_FILE" <<COS_OVERLAY_EOF
; ============================================================================
; Connect cold-mobile cos-all interception overlay
; (Auto-installed by install-connect-cos-wake-overlay.sh — DO NOT HAND-EDIT.)
;
; CANARY SCOPE: Tenant T${TENANT_ID}, extension ${EXT} ONLY.
;
; This declares the SAME-NAMED context [${COS_CONTEXT}] as the VitalPBX-
; generated one. Asterisk merges them; the explicit \`exten => ${EXT}\` wins over
; the generated \`include => ${INIT_CONTEXT}\` pattern. The intercept runs the
; canonical [connect-wake-core] engine, then hands control back to the native
; dialplan unchanged. No VitalPBX-generated file is touched.
; ============================================================================

[${COS_CONTEXT}]
exten => ${EXT},1,NoOp(Connect cold-mobile intercept tid=${TENANT_ID} ext=${EXT} done=\${__CONNECT_WAKE_DONE} src=\${SRC_APP} intercom=\${FORCE_INTERCOM})
 same => n,GotoIf(\$["\${__CONNECT_WAKE_DONE}" = "1"]?handback)
 same => n,GotoIf(\$[\$["\${FORCE_INTERCOM}" = "yes"] | \$["\${SRC_APP}" = "PAGING"] | \$["\${SKIP_CONTACT_SERVICES}" = "TRUE"]]?handback)
 same => n,GotoIf(\$[\${DIALPLAN_EXISTS(connect-wake-core,s,1)} != 1]?handback)
 same => n,Set(__CONNECT_WAKE_DONE=1)
 same => n,Gosub(connect-wake-core,s,1(${TENANT_ID},${EXT},1))
 same => n(handback),Goto(${INIT_CONTEXT},${EXT},1)
COS_OVERLAY_EOF

chown asterisk:asterisk "$OVERLAY_FILE"
chmod 0644 "$OVERLAY_FILE"
echo "  ↳ wrote $OVERLAY_FILE ($(wc -l < "$OVERLAY_FILE" | tr -d ' ') lines)"

# ── 5. Reload + verify the merge ────────────────────────────────────────────
step "[4/7] Reload Asterisk dialplan"
RELOAD_OUT="$(asterisk -rx 'dialplan reload' 2>&1 || true)"
echo "  ↳ $RELOAD_OUT"

step "[5/7] Verify merged context [${COS_CONTEXT}]"
SHOW_OUT="$(asterisk -rx "dialplan show ${COS_CONTEXT}" 2>&1 || true)"
echo "$SHOW_OUT" | sed 's/^/      /'
if echo "$SHOW_OUT" | grep -qE "'?${EXT}'?" \
   && echo "$SHOW_OUT" | grep -q "${INIT_CONTEXT}"; then
  echo "  ↳ OK — explicit exten ${EXT} merged AND native include => ${INIT_CONTEXT} still present"
else
  warn "Merge verification failed — expected both 'exten ${EXT}' and 'include ${INIT_CONTEXT}'."
  warn "Rolling back overlay."
  rm -f "$OVERLAY_FILE"
  asterisk -rx "dialplan reload" >/dev/null 2>&1 || true
  die "Overlay merge failed — removed overlay and reloaded."
fi

# ── 6. Enable the canary in the AstDB allowlist ─────────────────────────────
# This is the SAME default-closed allowlist [connect-dial-with-wake] consults,
# so enabling the canary here flips BOTH surfaces for this endpoint to the new
# engine: the native cos-all interception (above) AND any IVR-routed wake to
# this extension. The key lives in the Connect-owned `connect/*` AstDB
# namespace (never a VitalPBX-owned key). Idempotent.
CANARY_FAMILY="connect/wake_canary"
CANARY_KEY="T${TENANT_ID}_${EXT}"
step "[6/7] Enable AstDB canary allowlist ${CANARY_FAMILY}/${CANARY_KEY}=1"
asterisk -rx "database put ${CANARY_FAMILY} ${CANARY_KEY} 1" >/dev/null 2>&1 || true
CANARY_GET="$(asterisk -rx "database get ${CANARY_FAMILY} ${CANARY_KEY}" 2>&1 || true)"
echo "  ↳ $CANARY_GET"
if ! echo "$CANARY_GET" | grep -q "1"; then
  warn "Canary allowlist key did not persist — IVR path will stay on LEGACY for ${CANARY_KEY}."
  warn "(Native cos-all interception is still active; only the IVR-routed new-path is gated by this key.)"
fi

# ── 7. Done ─────────────────────────────────────────────────────────────────
step "[7/7] Done"
cat <<DONE

============================================================================
COS-WAKE OVERLAY INSTALLED (canary: T${TENANT_ID} ext ${EXT}).

File:               $OVERLAY_FILE
AstDB canary key:   ${CANARY_FAMILY}/${CANARY_KEY} = 1

Scope of this canary (everything else stays on current production behavior):
  • Native calls to ${EXT}@${COS_CONTEXT} → [connect-wake-core] (UserEvent + grace)
  • IVR-routed wake to T${TENANT_ID} ext ${EXT} → [connect-wake-core] (allowlist key)
  • ALL other connect-dial-with-wake callers → LEGACY curl+Wait (unchanged)

Live verification:
  asterisk -rx 'dialplan show ${COS_CONTEXT}'
  asterisk -rx 'database get ${CANARY_FAMILY} ${CANARY_KEY}'
  asterisk -rvvv        # watch for "Connect cold-mobile intercept" + "connect-wake-core" NoOps on a test call

Rollback (removes the intercept AND the canary key; behavior returns to native/legacy):
  rm -f $OVERLAY_FILE \\
    && asterisk -rx 'database del ${CANARY_FAMILY} ${CANARY_KEY}' \\
    && asterisk -rx 'dialplan reload'
============================================================================
DONE
