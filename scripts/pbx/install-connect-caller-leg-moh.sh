#!/usr/bin/env bash
# ============================================================================
# install-connect-caller-leg-moh.sh — Install the Connect caller-leg MOH hook
#   into VitalPBX [sub-local-dialing] on a VitalPBX host.
#
# WHY THIS EXISTS (production-proven 2026-07-01):
#   Inbound hold music is rendered from the *caller/Local* leg that executes
#   [sub-local-dialing] — for a direct DID this is the inbound trunk channel;
#   for IVR / ring group / queue post-answer it is the
#   `Local/<ext>@T<tid>_<ctx>;2` leg. Asterisk plays that held leg's OWN
#   CHANNEL(musicclass). VitalPBX only sets that leg's musicclass for hotdesk
#   (`sub-set-moh`) or queue-with-FORCE_QUEUE_MOH, so a normal inbound extension
#   hold plays `default`.
#
#   Connect's EXISTING MOH hooks all run on the CALLED PJSIP endpoint leg:
#       b(sub-before-connecting-call)  → ${TENANT_PREFIX}before-connecting-call-hook
#       U(sub-before-bridging-call)    → ${TENANT_PREFIX}before-bridging-call-hook
#                                        + global-before-bridging-call-hook
#   Those cover OUTBOUND (held trunk = called leg) but NEVER the inbound
#   caller/Local held leg. Endpoint `moh_suggest` was tested and did NOT drive
#   the held peer (Candidate B, disproven). The proven fix is to set
#   CHANNEL(musicclass) on the leg executing [sub-local-dialing], before Dial().
#
# WHAT THIS DOES:
#   1. Inserts ONE guarded line into the VitalPBX-core [sub-local-dialing]
#      context, immediately AFTER the unique
#          Set(DIAL_OPTIONS=...U(sub-before-bridging-call...))
#      anchor and BEFORE the Dial(${DIAL_STRING}...):
#          same => n,GosubIf($[${DIALPLAN_EXISTS(${TENANT_PREFIX}before-local-dial-moh-hook,s,1)}=1]?${TENANT_PREFIX}before-local-dial-moh-hook,s,1)
#      The GosubIf is guarded by DIALPLAN_EXISTS, so it is a NO-OP for any tenant
#      that does not have a generated hook context. It changes no Dial/Answer/
#      Playback/Local/route/queue/trunk/extension — it is a single metadata Gosub.
#   2. Writes a SEPARATE, Connect-owned file
#          /etc/asterisk/extensions__67_connect_localdial_moh.conf
#      containing one [T<tid>_before-local-dial-moh-hook] context per Connect
#      tenant that has PUBLISHED MOH (connect/pbx_tenant_map/<tid>/{slug,moh_class}).
#      Each hook is self-contained and fail-safe: it reads the tenant's slug-pinned
#      AstDB class and, only if present, sets CHANNEL(musicclass) + __CONNECT_MOH.
#      Missing slug/class ⇒ bare Return() (musicclass untouched).
#   3. #tryinclude's the __67 file from the Connect include hub
#      extensions__60_custom.conf (optional include — a rolled-back/absent file
#      never errors; the baseplan GosubIf still no-ops via DIALPLAN_EXISTS).
#   4. Reloads dialplan and verifies the patch line + a sample tenant hook.
#
# IDEMPOTENT + RE-APPLY-SAFE:
#   Safe to re-run. If the baseplan already carries the marker it is left as-is.
#   VitalPBX "Apply Changes"/upgrade rewrites extensions__20-baseplan.conf and
#   will DROP the inserted line (the __67 file + #tryinclude survive). Re-running
#   this installer restores the line. Consider wiring it into the post-apply hook
#   (see README) so inbound coverage is never silently lost.
#
# NEVER edits any pjsip__*.conf, musiconhold__*.conf, extensions__50-*.conf, or
# any tenant route/queue/IVR/ring-group config. The ONLY VitalPBX-generated file
# it touches is extensions__20-baseplan.conf, and ONLY to insert the single
# guarded GosubIf line (with a timestamped backup + surgical rollback).
#
# This installer writes NO AstDB keys.
#
# Usage:
#   chmod +x install-connect-caller-leg-moh.sh
#   sudo ./install-connect-caller-leg-moh.sh            # install / re-apply
#   sudo ./install-connect-caller-leg-moh.sh --check    # read-only health probe
#   sudo ./install-connect-caller-leg-moh.sh --rollback # remove Connect-owned patch
#   ./install-connect-caller-leg-moh.sh --help
# ============================================================================

set -euo pipefail

step() { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '\nWARN: %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

BASEPLAN="/etc/asterisk/vitalpbx/extensions__20-baseplan.conf"
HOOK_FILE="/etc/asterisk/extensions__67_connect_localdial_moh.conf"
CUSTOM_DIALPLAN="/etc/asterisk/extensions__60_custom.conf"
INCLUDE_LINE="#tryinclude extensions__67_connect_localdial_moh.conf"

# Unique anchor inside [sub-local-dialing]. The U-flag before-bridging line
# appears exactly once in the baseplan; we insert immediately after it, which is
# after VitalPBX's own MOH_CLASS/hotdesk/queue logic (priorities ~210-216) and
# before the Dial(${DIAL_STRING}...) at ~230, so Connect's class wins on the
# executing (held) leg without touching the Dial.
ANCHOR_SUBSTR='U(sub-before-bridging-call'
MARKER="before-local-dial-moh-hook"
# NOTE: single-quoted so every ${...} stays LITERAL for Asterisk to expand.
GOSUB_LINE=' same => n,GosubIf($[${DIALPLAN_EXISTS(${TENANT_PREFIX}before-local-dial-moh-hook,s,1)}=1]?${TENANT_PREFIX}before-local-dial-moh-hook,s,1)'

# ── Per-tenant hook generator ───────────────────────────────────────────────
# Emits one fail-safe, metadata-only caller-leg MOH hook for a tenant. The slug
# is pinned per tenant (proven on the Local leg where context-var tenant
# resolution is unreliable). ${...} refs are kept LITERAL via single-quoted
# printf format strings; only %s (tid / slug) is substituted by the shell.
emit_localdial_moh_hook() {
  local tid="$1" slug="$2"
  printf '[T%s_before-local-dial-moh-hook]\n' "$tid"
  printf 'exten => s,1,NoOp(Connect caller-leg MOH hook tid=%s slug=%s preset=${CHANNEL(musicclass)})\n' "$tid" "$slug"
  # (0) Admin multi-tenant schedule overlay (HIGHEST priority). Slug-pinned
  #     tenant-scope admin takeover — beats the tenant default while active. When
  #     the admin window ends Connect tombstones this key ("") so the reads below
  #     restore the exact prior tenant state.
  printf ' same => n,Set(CONNECT_MOH_CLASS=${DB(connect/t_%s/admin_moh_class)})\n' "$slug"
  # (1) Tenant default → alias fallback.
  printf ' same => n,ExecIf($["${CONNECT_MOH_CLASS}" = ""]?Set(CONNECT_MOH_CLASS=${DB(connect/t_%s/moh_class)}))\n' "$slug"
  printf ' same => n,ExecIf($["${CONNECT_MOH_CLASS}" = ""]?Set(CONNECT_MOH_CLASS=${DB(connect/t_%s/active_moh_class)}))\n' "$slug"
  printf ' same => n,GotoIf($["${CONNECT_MOH_CLASS}" = ""]?done)\n'
  printf ' same => n,Set(CHANNEL(musicclass)=${CONNECT_MOH_CLASS})\n'
  printf ' same => n,Set(__CONNECT_MOH=${CONNECT_MOH_CLASS})\n'
  printf ' same => n(done),Return()\n'
  printf '\n'
}

# ── CLI mode dispatch (must precede any root/asterisk preflight) ────────────
MODE="install"
case "${1:-}" in
  ""|install)                                MODE="install" ;;
  -h|--help|help)                            MODE="help" ;;
  --check|-n|--dry-run|check)                MODE="check" ;;
  --rollback|--uninstall|rollback|uninstall) MODE="rollback" ;;
  *) printf 'Unknown option: %s\n' "$1" >&2; printf 'Try: %s --help\n' "$0" >&2; exit 64 ;;
esac

if [[ "$MODE" = "help" ]]; then
  cat <<HELP
install-connect-caller-leg-moh.sh — Connect caller-leg MOH hook for [sub-local-dialing]

Modes:
  install      (default) Insert the single guarded GosubIf into [sub-local-dialing]
               (idempotent, re-apply-safe), write per-tenant hook contexts for
               tenants with PUBLISHED Connect MOH, #tryinclude the hook file,
               reload dialplan, verify. Writes NO AstDB keys.
  --check      Read-only health probe: baseplan patched exactly once, anchor
               unique, hook file + #tryinclude present, sample tenant hook loaded.
  --rollback   Surgically remove ONLY the Connect-owned patch line from the
               baseplan + the hook file + its #tryinclude line, then reload.
  --help       This text.

Runtime source of truth (published by the Connect MOH publish path):
  connect/t_<slug>/moh_class          → tenant class (primary)
  connect/t_<slug>/active_moh_class   → fallback alias
  connect/pbx_tenant_map/<tid>/{slug,moh_class} → tenant enumeration
HELP
  exit 0
fi

# ── anchor helpers (shared by install/check/rollback) ───────────────────────
anchor_count() { grep -cF "$ANCHOR_SUBSTR" "$BASEPLAN" 2>/dev/null || true; }
is_patched()   { grep -qF "$MARKER" "$BASEPLAN" 2>/dev/null; }

# ── do_rollback ─────────────────────────────────────────────────────────────
do_rollback() {
  [[ $EUID -eq 0 ]] || die "Run as root (sudo)."
  command -v asterisk >/dev/null 2>&1 || die "asterisk binary not found in PATH"
  local removed=0 ts
  ts="$(date +%Y%m%d-%H%M%S)"
  if [[ -f "$BASEPLAN" ]] && is_patched; then
    cp -a "$BASEPLAN" "${BASEPLAN}.bak.connect-localdial-moh-rollback.${ts}"
    # Remove ONLY our inserted line (the unique MARKER appears only there).
    grep -vF "$MARKER" "$BASEPLAN" > "${BASEPLAN}.tmp.${ts}" && mv "${BASEPLAN}.tmp.${ts}" "$BASEPLAN"
    chown asterisk:asterisk "$BASEPLAN"; chmod 0644 "$BASEPLAN"
    printf '[REMOVE] baseplan GosubIf line (backup ${BASEPLAN}.bak.connect-localdial-moh-rollback.%s)\n' "$ts"
    removed=1
  else
    printf '[SKIP] baseplan not patched\n'
  fi
  if [[ -f "$HOOK_FILE" ]]; then
    rm -f "$HOOK_FILE"; printf '[REMOVE] %s\n' "$HOOK_FILE"; removed=1
  else
    printf '[SKIP] hook file already absent: %s\n' "$HOOK_FILE"
  fi
  if [[ -f "$CUSTOM_DIALPLAN" ]] && grep -qxF "$INCLUDE_LINE" "$CUSTOM_DIALPLAN"; then
    cp -a "$CUSTOM_DIALPLAN" "${CUSTOM_DIALPLAN}.bak.connect-localdial-moh-rollback.${ts}"
    sed -i '/^#tryinclude extensions__67_connect_localdial_moh\.conf$/d' "$CUSTOM_DIALPLAN"
    printf '[REMOVE] #tryinclude line from %s\n' "$CUSTOM_DIALPLAN"; removed=1
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
  local checks=0 fail=0 cnt
  [[ -f "$BASEPLAN" ]] || die "baseplan not found: $BASEPLAN"

  cnt="$(anchor_count)"
  checks=$((checks + 1))
  if [[ "$cnt" = "1" ]]; then
    printf '[PASS] anchor unique in baseplan (1)\n'
  else
    printf '[FAIL] anchor count=%s (need exactly 1)\n' "$cnt"; fail=$((fail + 1))
  fi

  checks=$((checks + 1))
  if is_patched; then
    printf '[PASS] baseplan carries the caller-leg GosubIf\n'
  else
    printf '[FAIL] baseplan NOT patched\n'; fail=$((fail + 1))
  fi

  checks=$((checks + 1))
  if [[ -f "$HOOK_FILE" ]]; then
    printf '[PASS] hook file present: %s\n' "$HOOK_FILE"
  else
    printf '[FAIL] hook file missing: %s\n' "$HOOK_FILE"; fail=$((fail + 1))
  fi

  checks=$((checks + 1))
  if [[ -f "$CUSTOM_DIALPLAN" ]] && grep -qxF "$INCLUDE_LINE" "$CUSTOM_DIALPLAN"; then
    printf '[PASS] #tryinclude present in %s\n' "$CUSTOM_DIALPLAN"
  else
    printf '[FAIL] #tryinclude missing in %s\n' "$CUSTOM_DIALPLAN"; fail=$((fail + 1))
  fi

  # Sample a Connect-known tenant with published MOH and confirm its hook loaded
  # AND that the GosubIf is visible in the live [sub-local-dialing].
  local sample_tid
  sample_tid="$(asterisk -rx 'database show connect/pbx_tenant_map' 2>/dev/null \
    | awk -F'/' '/^\/connect\/pbx_tenant_map\//{print $4}' | grep -E '^[0-9]+$' | sort -un | head -n1 || true)"
  checks=$((checks + 1))
  if [[ -n "$sample_tid" ]]; then
    if asterisk -rx "dialplan show T${sample_tid}_before-local-dial-moh-hook" 2>&1 | grep -q "CONNECT_MOH_CLASS" \
       && asterisk -rx "dialplan show sub-local-dialing" 2>&1 | grep -q "$MARKER"; then
      printf '[PASS] sample T%s hook loaded AND GosubIf visible in sub-local-dialing\n' "$sample_tid"
    else
      printf '[FAIL] sample T%s hook or GosubIf not visible\n' "$sample_tid"; fail=$((fail + 1))
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
[[ -f "$BASEPLAN" ]] || die "baseplan not found: $BASEPLAN"

# ── 2. Verify the anchor is present and UNIQUE (refuse otherwise) ───────────
step "[1/6] Verify [sub-local-dialing] anchor is present and unique"
CNT="$(anchor_count)"
if [[ "$CNT" != "1" ]]; then
  die "Anchor '$ANCHOR_SUBSTR' count=$CNT in $BASEPLAN (need exactly 1). Refusing to patch."
fi
echo "  ↳ OK — anchor unique"

# ── 3. Patch [sub-local-dialing] (idempotent) ───────────────────────────────
step "[2/6] Insert the guarded caller-leg GosubIf (idempotent)"
if is_patched; then
  echo "  ↳ already patched — leaving baseplan unchanged"
else
  BACKUP_BP="${BASEPLAN}.bak.connect-localdial-moh.$(date +%Y%m%d-%H%M%S)"
  cp -a "$BASEPLAN" "$BACKUP_BP"
  LN="$(grep -nF "$ANCHOR_SUBSTR" "$BASEPLAN" | head -1 | cut -d: -f1)"
  TMP_BP="${BASEPLAN}.tmp.$$"
  awk -v n="$LN" -v ins="$GOSUB_LINE" 'NR==n{print; print ins; next}{print}' "$BASEPLAN" > "$TMP_BP"
  mv "$TMP_BP" "$BASEPLAN"
  chown asterisk:asterisk "$BASEPLAN"; chmod 0644 "$BASEPLAN"
  echo "  ↳ inserted GosubIf after baseplan line $LN (backup $BACKUP_BP)"
fi

# ── 4. Enumerate Connect tenants with PUBLISHED MOH + write hook file ───────
step "[3/6] Generate per-tenant hook contexts for tenants with published MOH"
TENANT_IDS="$(asterisk -rx 'database show connect/pbx_tenant_map' 2>/dev/null \
  | awk -F'/' '/^\/connect\/pbx_tenant_map\//{print $4}' \
  | grep -E '^[0-9]+$' | sort -un || true)"
[[ -n "$TENANT_IDS" ]] || die "No tenants in connect/pbx_tenant_map — publish Connect MOH first."

if [[ -f "$HOOK_FILE" ]]; then
  cp -a "$HOOK_FILE" "${HOOK_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
fi

KEPT=""; SKIPPED=""
{
  cat <<'HDR'
; ============================================================================
; Connect caller-leg MOH hooks for [sub-local-dialing]
; (Auto-installed by install-connect-caller-leg-moh.sh — DO NOT HAND-EDIT.)
;
; One [T<tid>_before-local-dial-moh-hook] per Connect tenant with PUBLISHED MOH.
; Invoked ONLY by the guarded GosubIf inserted into VitalPBX [sub-local-dialing]
; (DIALPLAN_EXISTS gate ⇒ tenants without a hook here are a pure no-op).
; Fail-safe + metadata-only: reads the tenant's slug-pinned AstDB class and, only
; if present, sets CHANNEL(musicclass) + __CONNECT_MOH. Missing class ⇒ Return().
; No Answer/Dial/Playback/Local/route/queue/trunk/extension changes.
; ============================================================================
HDR
  printf '\n'
  for tid in $TENANT_IDS; do
    slug="$(asterisk -rx "database get connect/pbx_tenant_map/${tid} slug" 2>/dev/null \
      | awk -F': ' '/^Value:/{print $2}' | tr -d '[:space:]' || true)"
    class="$(asterisk -rx "database get connect/pbx_tenant_map/${tid} moh_class" 2>/dev/null \
      | awk -F': ' '/^Value:/{print $2}' | tr -d '[:space:]' || true)"
    # Requirement 6: only tenants with PUBLISHED MOH (slug AND class present).
    if [[ -z "$slug" || -z "$class" ]]; then
      SKIPPED="${SKIPPED}T${tid} "
      continue
    fi
    # Defensive: slug must be a safe AstDB path token.
    if [[ "$slug" != "${slug//[^A-Za-z0-9_-]/}" ]]; then
      SKIPPED="${SKIPPED}T${tid}(bad-slug) "
      continue
    fi
    KEPT="${KEPT}T${tid} "
    emit_localdial_moh_hook "$tid" "$slug"
  done
} > "$HOOK_FILE"
chown asterisk:asterisk "$HOOK_FILE"; chmod 0644 "$HOOK_FILE"
echo "  ↳ wrote $HOOK_FILE (kept: ${KEPT:-none})"
[[ -n "$SKIPPED" ]] && warn "skipped (no published MOH / bad slug): $SKIPPED"
if [[ -z "$KEPT" ]]; then
  warn "No tenant had published MOH — hook file has no contexts (baseplan GosubIf stays a no-op)."
fi

# ── 5. Ensure the hook file is #tryinclude'd ────────────────────────────────
step "[4/6] Ensure ${CUSTOM_DIALPLAN##*/} #tryinclude's the hook file"
if [[ ! -f "$CUSTOM_DIALPLAN" ]]; then
  warn "$CUSTOM_DIALPLAN not found — install-connect-wake-dialplan.sh must run first."
else
  if grep -qxF "$INCLUDE_LINE" "$CUSTOM_DIALPLAN"; then
    echo "  ↳ already present"
  else
    cp -a "$CUSTOM_DIALPLAN" "${CUSTOM_DIALPLAN}.bak.$(date +%Y%m%d-%H%M%S)"
    printf '\n%s\n' "$INCLUDE_LINE" >> "$CUSTOM_DIALPLAN"
    echo "  ↳ appended '$INCLUDE_LINE'"
  fi
fi

# ── 6. Reload + verify ──────────────────────────────────────────────────────
step "[5/6] Reload dialplan"
RELOAD_OUT="$(asterisk -rx 'dialplan reload' 2>&1 || true)"
echo "  ↳ $RELOAD_OUT"

step "[6/6] Verify GosubIf in [sub-local-dialing] + a sample tenant hook"
if ! asterisk -rx "dialplan show sub-local-dialing" 2>&1 | grep -q "$MARKER"; then
  warn "GosubIf not visible in live sub-local-dialing after reload."
fi
SAMPLE_TID="$(printf '%s' "$KEPT" | tr ' ' '\n' | sed 's/^T//' | head -n1)"
if [[ -n "$SAMPLE_TID" ]]; then
  SHOW_OUT="$(asterisk -rx "dialplan show T${SAMPLE_TID}_before-local-dial-moh-hook" 2>&1 || true)"
  echo "$SHOW_OUT" | sed 's/^/      /'
  if echo "$SHOW_OUT" | grep -q "CONNECT_MOH_CLASS"; then
    echo "  ↳ OK — sample T${SAMPLE_TID} caller-leg hook loaded"
  else
    warn "Sample hook T${SAMPLE_TID} not visible — check reload output above."
  fi
fi

cat <<DONE

============================================================================
CALLER-LEG MOH HOOK INSTALLED.

Baseplan patch:   $BASEPLAN  (single guarded GosubIf in [sub-local-dialing])
Hook file:        $HOOK_FILE
Tenants gated:    ${KEPT:-none}
Runtime source:   connect/t_<slug>/moh_class (+ active_moh_class fallback)

Behavior:
  • inbound direct / IVR / ring group / queue POST-answer bridge hold on the
    held caller/Local leg now uses the tenant's published MOH class.
  • queue WAITING music (pre-answer) is native (queue music_group_id) — unchanged.
  • outbound (held trunk = called leg) unchanged (global-before-bridging hook).
  • tenants without a published class / hook context → pure no-op (DIALPLAN_EXISTS).

Re-apply after VitalPBX "Apply Changes"/upgrade (idempotent):
  sudo $0

Health check:
  sudo $0 --check

Rollback (surgical — removes only the Connect-owned patch line + hook file + include):
  sudo $0 --rollback
============================================================================
DONE
