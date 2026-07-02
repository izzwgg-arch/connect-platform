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
# LONG-TERM HARDENING (2026-07-02): ONE generic runtime hook, not per-tenant.
#   Earlier revisions generated one [T<tid>_before-local-dial-moh-hook] context
#   per tenant that had PUBLISHED MOH at install time. That coupled coverage to
#   "did this tenant have MOH published when the installer last ran" — a tenant
#   who published (or was first mapped) later stayed a no-op until someone
#   re-ran the installer. This revision installs ONE Connect-owned context,
#   [connect-localdial-moh], that resolves the tenant at RUNTIME from
#   ${TENANT_PREFIX} and AstDB. Every current AND future tenant is covered the
#   moment its reverse-map + MOH keys exist — with NO PBX regeneration. The
#   dynamic-resolution technique is the same one proven in production by the
#   called-leg resolver [sub-connect-tenant-moh]
#   (scripts/pbx/install-connect-tenant-moh-dialplan.sh).
#
# WHAT THIS DOES:
#   1. Inserts ONE guarded line into the VitalPBX-core [sub-local-dialing]
#      context, immediately AFTER the unique
#          Set(DIAL_OPTIONS=...U(sub-before-bridging-call...))
#      anchor and BEFORE the Dial(${DIAL_STRING}...):
#          same => n,GosubIf($[${DIALPLAN_EXISTS(connect-localdial-moh,s,1)}=1]?connect-localdial-moh,s,1)
#      The GosubIf is guarded by DIALPLAN_EXISTS, so it is a NO-OP whenever the
#      Connect-owned context is absent (e.g. after --rollback). It changes no
#      Dial/Answer/Playback/Local/route/queue/trunk/extension — a single Gosub.
#      If a LEGACY per-tenant dispatch line
#      (${TENANT_PREFIX}before-local-dial-moh-hook) is found, it is migrated:
#      the legacy line is removed and replaced by the generic line.
#   2. Writes a SEPARATE, Connect-owned file
#          /etc/asterisk/extensions__67_connect_localdial_moh.conf
#      containing ONE [connect-localdial-moh] context. At call time it:
#        • derives the numeric PBX tenant id from ${TENANT_PREFIX} (T<id>_ →
#          <id>), with a TRANSFER_CONTEXT fallback;
#        • reads connect/pbx_tenant_map/<id>/slug — absent ⇒ safe no-op Return;
#        • reads connect/t_<slug>/admin_moh_class → moh_class → active_moh_class;
#          none present ⇒ safe no-op Return;
#        • else sets CHANNEL(musicclass) + __CONNECT_MOH and Returns.
#      No tenant-specific data is baked into the file — it is identical on every
#      host and never needs regeneration when tenants publish/change MOH.
#   3. #tryinclude's the __67 file from the Connect include hub
#      extensions__60_custom.conf (optional include — a rolled-back/absent file
#      never errors; the baseplan GosubIf still no-ops via DIALPLAN_EXISTS).
#   4. Reloads dialplan and verifies the patch line + the generic context.
#
# IDEMPOTENT + RE-APPLY-SAFE:
#   Safe to re-run. If the baseplan already carries the generic marker it is
#   left as-is (and any stale legacy per-tenant line is cleaned). VitalPBX
#   "Apply Changes"/upgrade rewrites extensions__20-baseplan.conf and will DROP
#   the inserted line (the __67 file + #tryinclude survive). Re-running this
#   installer restores the line. Consider wiring it into the post-apply hook
#   (see README) so inbound coverage is never silently lost.
#
# NEVER edits any pjsip__*.conf, musiconhold__*.conf, extensions__50-*.conf, or
# any tenant route/queue/IVR/ring-group config. The ONLY VitalPBX-generated file
# it touches is extensions__20-baseplan.conf, and ONLY to insert/migrate the
# single guarded GosubIf line (with a timestamped backup + surgical rollback).
#
# This installer writes NO AstDB keys.
#
# Usage:
#   chmod +x install-connect-caller-leg-moh.sh
#   sudo ./install-connect-caller-leg-moh.sh            # install / re-apply / migrate
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

# The single generic Connect-owned context name. Also the baseplan-line marker:
# it appears in our inserted GosubIf and NOWHERE else in the baseplan. It uses
# HYPHENS (connect-localdial-moh); the __67 FILENAME uses UNDERSCORES
# (connect_localdial_moh), so the two never collide in a grep -F.
GENERIC_CTX="connect-localdial-moh"
MARKER="connect-localdial-moh"

# Legacy per-tenant dispatch marker (pre-hardening). Used to DETECT and MIGRATE
# an older install whose baseplan called ${TENANT_PREFIX}before-local-dial-moh-hook.
# Disjoint substring from MARKER ("local-dial" vs "localdial"), so the two
# markers never match the same line.
OLD_MARKER="before-local-dial-moh-hook"

# Sentinel emitted on the s,1 line of the generic context — used by --check to
# prove the OFFICIAL __67 context is the one Asterisk loaded.
HOOK_SENTINEL="Connect generic caller-leg MOH hook"

# NOTE: single-quoted so every ${...} stays LITERAL for Asterisk to expand.
GOSUB_LINE=' same => n,GosubIf($[${DIALPLAN_EXISTS(connect-localdial-moh,s,1)}=1]?connect-localdial-moh,s,1)'

# ── Generic runtime hook generator ──────────────────────────────────────────
# Emits the ONE fail-safe, metadata-only caller-leg MOH context. The body is
# fully static (no per-tenant data) — a heredoc kept LITERAL so every ${...}
# reaches Asterisk verbatim. Resolution priority (first non-empty wins):
#   admin_moh_class → moh_class → active_moh_class → no-op (native default).
emit_generic_localdial_moh_hook() {
  cat <<'HOOK'
[connect-localdial-moh]
exten => s,1,NoOp(Connect generic caller-leg MOH hook prefix=${TENANT_PREFIX} preset=${CHANNEL(musicclass)})
 same => n,Set(CONNECT_MOH_TID=${FILTER(0-9,${TENANT_PREFIX})})
 same => n,ExecIf($["${CONNECT_MOH_TID}" = ""]?Set(CONNECT_MOH_TID=${FILTER(0-9,${CUT(TRANSFER_CONTEXT,_,1)})}))
 same => n,GotoIf($["${CONNECT_MOH_TID}" = ""]?done)
 same => n,Set(CONNECT_MOH_SLUG=${FILTER(A-Za-z0-9_-,${DB(connect/pbx_tenant_map/${CONNECT_MOH_TID}/slug)})})
 same => n,GotoIf($["${CONNECT_MOH_SLUG}" = ""]?done)
 same => n,Set(CONNECT_MOH_CLASS=${DB(connect/t_${CONNECT_MOH_SLUG}/admin_moh_class)})
 same => n,ExecIf($["${CONNECT_MOH_CLASS}" = ""]?Set(CONNECT_MOH_CLASS=${DB(connect/t_${CONNECT_MOH_SLUG}/moh_class)}))
 same => n,ExecIf($["${CONNECT_MOH_CLASS}" = ""]?Set(CONNECT_MOH_CLASS=${DB(connect/t_${CONNECT_MOH_SLUG}/active_moh_class)}))
 same => n,GotoIf($["${CONNECT_MOH_CLASS}" = ""]?done)
 same => n,Set(CHANNEL(musicclass)=${CONNECT_MOH_CLASS})
 same => n,Set(__CONNECT_MOH=${CONNECT_MOH_CLASS})
 same => n,NoOp(Connect generic caller-leg MOH applied tid=${CONNECT_MOH_TID} slug=${CONNECT_MOH_SLUG} class=${CONNECT_MOH_CLASS})
 same => n(done),Return()
HOOK
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
               (idempotent, re-apply-safe; migrates a legacy per-tenant line),
               write the ONE generic [connect-localdial-moh] context, #tryinclude
               the hook file, reload dialplan, verify. Writes NO AstDB keys.
  --check      Read-only health probe: anchor unique, baseplan carries the generic
               GosubIf (no legacy line), hook file + #tryinclude present, exactly
               one on-disk definition of [connect-localdial-moh] owned by __67,
               no manual __66 patch / duplicate context, and the live dialplan
               shows the GosubIf + the loaded generic context.
  --rollback   Surgically remove ONLY the Connect-owned line(s) from the baseplan
               (generic + any legacy) + the hook file + its #tryinclude, reload.
  --help       This text.

Runtime source of truth (published by the Connect MOH publish path — read at
call time, so publishing/changing MOH later needs NO installer re-run):
  connect/pbx_tenant_map/<tid>/slug   → tenant slug (enumeration linchpin)
  connect/t_<slug>/admin_moh_class    → admin multi-tenant overlay (highest)
  connect/t_<slug>/moh_class          → tenant class (primary)
  connect/t_<slug>/active_moh_class   → fallback alias
HELP
  exit 0
fi

# ── anchor / marker helpers (shared by install/check/rollback) ──────────────
anchor_count()    { grep -cF "$ANCHOR_SUBSTR" "$BASEPLAN" 2>/dev/null || true; }
is_patched()      { grep -qF "$MARKER" "$BASEPLAN" 2>/dev/null; }
has_old_dispatch(){ grep -qF "$OLD_MARKER" "$BASEPLAN" 2>/dev/null; }

# ── do_rollback ─────────────────────────────────────────────────────────────
do_rollback() {
  [[ $EUID -eq 0 ]] || die "Run as root (sudo)."
  command -v asterisk >/dev/null 2>&1 || die "asterisk binary not found in PATH"
  local removed=0 ts
  ts="$(date +%Y%m%d-%H%M%S)"
  if [[ -f "$BASEPLAN" ]] && { is_patched || has_old_dispatch; }; then
    cp -a "$BASEPLAN" "${BASEPLAN}.bak.connect-localdial-moh-rollback.${ts}"
    # Remove ONLY our inserted line(s): the generic MARKER and any legacy
    # per-tenant OLD_MARKER line. Both are Connect-owned and appear nowhere else.
    grep -vF -e "$MARKER" -e "$OLD_MARKER" "$BASEPLAN" > "${BASEPLAN}.tmp.${ts}" && mv "${BASEPLAN}.tmp.${ts}" "$BASEPLAN"
    chown asterisk:asterisk "$BASEPLAN"; chmod 0644 "$BASEPLAN"
    printf '[REMOVE] baseplan Connect GosubIf line(s) (backup ${BASEPLAN}.bak.connect-localdial-moh-rollback.%s)\n' "$ts"
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
# Verifies the GENERIC hardened install end-to-end. No per-tenant sampling, so
# it cannot false-negative on an unpublished tenant (the pre-hardening bug:
# --check sampled the lowest tid in connect/pbx_tenant_map, which often had no
# generated hook, and reported FAIL even though the healthy tenants worked).
do_health_check() {
  command -v asterisk >/dev/null 2>&1 || die "asterisk binary not found in PATH"
  local checks=0 fail=0 cnt
  [[ -f "$BASEPLAN" ]] || die "baseplan not found: $BASEPLAN"

  # 1. anchor unique
  cnt="$(anchor_count)"
  checks=$((checks + 1))
  if [[ "$cnt" = "1" ]]; then
    printf '[PASS] anchor unique in baseplan (1)\n'
  else
    printf '[FAIL] anchor count=%s (need exactly 1)\n' "$cnt"; fail=$((fail + 1))
  fi

  # 2. baseplan carries the generic caller-leg GosubIf
  checks=$((checks + 1))
  if is_patched; then
    printf '[PASS] baseplan carries the generic caller-leg GosubIf\n'
  else
    printf '[FAIL] baseplan NOT patched with the generic GosubIf\n'; fail=$((fail + 1))
  fi

  # 2b. no stale legacy per-tenant dispatch left in the baseplan (migration done)
  checks=$((checks + 1))
  if has_old_dispatch; then
    printf '[FAIL] baseplan still calls the legacy per-tenant hook (%s) — re-run installer to migrate\n' "$OLD_MARKER"
    fail=$((fail + 1))
  else
    printf '[PASS] no legacy per-tenant dispatch line in baseplan\n'
  fi

  # 3. official hook file present
  checks=$((checks + 1))
  if [[ -f "$HOOK_FILE" ]]; then
    printf '[PASS] official hook file present: %s\n' "$HOOK_FILE"
  else
    printf '[FAIL] official hook file missing: %s\n' "$HOOK_FILE"; fail=$((fail + 1))
  fi

  # 4. hub #tryinclude present
  checks=$((checks + 1))
  if [[ -f "$CUSTOM_DIALPLAN" ]] && grep -qxF "$INCLUDE_LINE" "$CUSTOM_DIALPLAN"; then
    printf '[PASS] #tryinclude present in %s\n' "$CUSTOM_DIALPLAN"
  else
    printf '[FAIL] #tryinclude missing in %s\n' "$CUSTOM_DIALPLAN"; fail=$((fail + 1))
  fi

  # 5. exactly ONE on-disk definition of [connect-localdial-moh], owned by __67.
  #    Guards against a duplicate/hand-copied definition shadowing the official one.
  checks=$((checks + 1))
  local def_files def_count
  def_files="$(grep -lF '[connect-localdial-moh]' /etc/asterisk/extensions*.conf 2>/dev/null || true)"
  def_count="$(printf '%s' "$def_files" | grep -c . || true)"
  if [[ "$def_count" = "1" ]] && printf '%s\n' "$def_files" | grep -qxF "$HOOK_FILE"; then
    printf '[PASS] exactly one definition of [%s], owned by %s\n' "$GENERIC_CTX" "$HOOK_FILE"
  else
    printf '[FAIL] [%s] defined by %s file(s): %s (expected only %s)\n' "$GENERIC_CTX" "$def_count" "$(printf '%s ' $def_files)" "$HOOK_FILE"
    fail=$((fail + 1))
  fi

  # 5b. no leftover legacy per-tenant caller-leg hook contexts on disk (stale/dupe).
  checks=$((checks + 1))
  local legacy_ctx_files
  legacy_ctx_files="$(grep -lE '\[T[0-9]+_before-local-dial-moh-hook\]' /etc/asterisk/extensions*.conf 2>/dev/null || true)"
  if [[ -z "$legacy_ctx_files" ]]; then
    printf '[PASS] no legacy per-tenant caller-leg hook contexts on disk\n'
  else
    printf '[FAIL] legacy per-tenant caller-leg hook context(s) still defined in: %s\n' "$(printf '%s ' $legacy_ctx_files)"
    fail=$((fail + 1))
  fi

  # 5c. no manual __66 caller-leg MOH proof-patch owning the hook.
  checks=$((checks + 1))
  local manual66
  manual66="$(grep -lE 'before-local-dial-moh-hook|connect-localdial-moh' /etc/asterisk/extensions__66*.conf 2>/dev/null || true)"
  if [[ -z "$manual66" ]]; then
    printf '[PASS] no manual extensions__66*.conf caller-leg MOH patch on disk\n'
  else
    printf '[FAIL] manual __66 caller-leg MOH patch present (remove it; official __67 owns the hook): %s\n' "$(printf '%s ' $manual66)"
    fail=$((fail + 1))
  fi

  # 6. live: GosubIf visible in [sub-local-dialing] (format-tolerant single-token grep).
  #    Asterisk `dialplan show` may re-wrap app args; the context token is a single
  #    contiguous string, so grep -F on it survives spacing/formatting differences.
  checks=$((checks + 1))
  if asterisk -rx "dialplan show sub-local-dialing" 2>&1 | grep -qF "$GENERIC_CTX"; then
    printf '[PASS] live [sub-local-dialing] shows the %s GosubIf\n' "$GENERIC_CTX"
  else
    printf '[FAIL] live [sub-local-dialing] does NOT show the %s GosubIf\n' "$GENERIC_CTX"; fail=$((fail + 1))
  fi

  # 7. live: the generic hook context is loaded from the official file (sentinel).
  checks=$((checks + 1))
  if asterisk -rx "dialplan show $GENERIC_CTX" 2>&1 | grep -qF "$HOOK_SENTINEL"; then
    printf '[PASS] live [%s] loaded (official __67 sentinel present)\n' "$GENERIC_CTX"
  else
    printf '[FAIL] live [%s] not loaded / official sentinel absent\n' "$GENERIC_CTX"; fail=$((fail + 1))
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
step "[1/5] Verify [sub-local-dialing] anchor is present and unique"
CNT="$(anchor_count)"
if [[ "$CNT" != "1" ]]; then
  die "Anchor '$ANCHOR_SUBSTR' count=$CNT in $BASEPLAN (need exactly 1). Refusing to patch."
fi
echo "  ↳ OK — anchor unique"

# ── 3. Patch [sub-local-dialing] (idempotent + legacy migration) ────────────
step "[2/5] Insert the guarded generic caller-leg GosubIf (idempotent + migrate legacy)"
if is_patched; then
  if has_old_dispatch; then
    BACKUP_BP="${BASEPLAN}.bak.connect-localdial-moh.$(date +%Y%m%d-%H%M%S)"
    cp -a "$BASEPLAN" "$BACKUP_BP"
    grep -vF "$OLD_MARKER" "$BASEPLAN" > "${BASEPLAN}.tmp.$$" && mv "${BASEPLAN}.tmp.$$" "$BASEPLAN"
    chown asterisk:asterisk "$BASEPLAN"; chmod 0644 "$BASEPLAN"
    echo "  ↳ already patched; removed stale legacy per-tenant dispatch line (backup $BACKUP_BP)"
  else
    echo "  ↳ already patched — leaving baseplan unchanged"
  fi
else
  BACKUP_BP="${BASEPLAN}.bak.connect-localdial-moh.$(date +%Y%m%d-%H%M%S)"
  cp -a "$BASEPLAN" "$BACKUP_BP"
  # Migration: drop any legacy per-tenant dispatch line first so we converge to
  # exactly one generic GosubIf.
  if has_old_dispatch; then
    grep -vF "$OLD_MARKER" "$BASEPLAN" > "${BASEPLAN}.tmp.$$" && mv "${BASEPLAN}.tmp.$$" "$BASEPLAN"
    echo "  ↳ removed legacy per-tenant dispatch line (migrating to generic hook)"
  fi
  LN="$(grep -nF "$ANCHOR_SUBSTR" "$BASEPLAN" | head -1 | cut -d: -f1)"
  TMP_BP="${BASEPLAN}.tmp.$$"
  awk -v n="$LN" -v ins="$GOSUB_LINE" 'NR==n{print; print ins; next}{print}' "$BASEPLAN" > "$TMP_BP"
  mv "$TMP_BP" "$BASEPLAN"
  chown asterisk:asterisk "$BASEPLAN"; chmod 0644 "$BASEPLAN"
  echo "  ↳ inserted generic GosubIf after baseplan line $LN (backup $BACKUP_BP)"
fi

# ── 4. Write the ONE generic hook context (no per-tenant data) ──────────────
step "[3/5] Write the generic [connect-localdial-moh] context"
if [[ -f "$HOOK_FILE" ]]; then
  cp -a "$HOOK_FILE" "${HOOK_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
fi
{
  cat <<'HDR'
; ============================================================================
; Connect caller-leg MOH hook for [sub-local-dialing]  (GENERIC / runtime)
; (Auto-installed by install-connect-caller-leg-moh.sh — DO NOT HAND-EDIT.)
;
; ONE context, [connect-localdial-moh], resolves the tenant at RUNTIME from
; ${TENANT_PREFIX} + AstDB. It covers EVERY current and future tenant the
; moment its reverse-map + MOH keys exist — no per-tenant regeneration, no
; installer re-run when a tenant publishes/changes MOH later.
;
; Invoked ONLY by the guarded GosubIf inserted into VitalPBX [sub-local-dialing]
; (DIALPLAN_EXISTS gate ⇒ if this file is rolled back/absent the baseplan line
; is a pure no-op). Fail-safe + metadata-only: reads the tenant's slug-pinned
; AstDB class and, only if present, sets CHANNEL(musicclass) + __CONNECT_MOH.
; Missing tenant map / slug / class ⇒ bare Return() (musicclass untouched →
; native VitalPBX default). No Answer/Dial/Playback/Local/route/queue/trunk/
; extension changes. Writes NO AstDB keys.
;
; Runtime read order (first non-empty wins):
;   connect/pbx_tenant_map/<tid>/slug          (tenant identity; absent ⇒ no-op)
;   connect/t_<slug>/admin_moh_class           (admin multi-tenant overlay)
;   connect/t_<slug>/moh_class                 (tenant default)
;   connect/t_<slug>/active_moh_class          (tenant alias)
; ============================================================================
HDR
  printf '\n'
  emit_generic_localdial_moh_hook
} > "$HOOK_FILE"
chown asterisk:asterisk "$HOOK_FILE"; chmod 0644 "$HOOK_FILE"
echo "  ↳ wrote $HOOK_FILE (generic runtime context — covers all current + future tenants)"

# Informational only (read-only): how many tenants Connect currently maps. The
# generic hook does NOT depend on this — it is printed purely to help operators
# see coverage. A tenant with no reverse-map / no class is a safe no-op.
MAPPED_COUNT="$(asterisk -rx 'database show connect/pbx_tenant_map' 2>/dev/null \
  | awk -F'/' '/^\/connect\/pbx_tenant_map\//{print $4}' | grep -E '^[0-9]+$' | sort -un | grep -c . || true)"
echo "  ↳ (info) tenants currently in connect/pbx_tenant_map: ${MAPPED_COUNT:-0} — all covered dynamically"

# ── 5. Ensure the hook file is #tryinclude'd ────────────────────────────────
step "[4/5] Ensure ${CUSTOM_DIALPLAN##*/} #tryinclude's the hook file"
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
step "[5/5] Reload dialplan + verify GosubIf and generic context"
RELOAD_OUT="$(asterisk -rx 'dialplan reload' 2>&1 || true)"
echo "  ↳ $RELOAD_OUT"

if ! asterisk -rx "dialplan show sub-local-dialing" 2>&1 | grep -qF "$GENERIC_CTX"; then
  warn "GosubIf not visible in live sub-local-dialing after reload."
fi
SHOW_OUT="$(asterisk -rx "dialplan show $GENERIC_CTX" 2>&1 || true)"
echo "$SHOW_OUT" | sed 's/^/      /'
if echo "$SHOW_OUT" | grep -qF "$HOOK_SENTINEL"; then
  echo "  ↳ OK — generic [connect-localdial-moh] context loaded"
else
  warn "Generic context not visible — check reload output above."
fi

cat <<DONE

============================================================================
CALLER-LEG MOH HOOK INSTALLED (GENERIC / runtime).

Baseplan patch:   $BASEPLAN  (single guarded GosubIf in [sub-local-dialing])
Hook file:        $HOOK_FILE  (ONE generic context — no per-tenant data)
Runtime source:   connect/pbx_tenant_map/<tid>/slug →
                  connect/t_<slug>/{admin_moh_class,moh_class,active_moh_class}

Behavior:
  • inbound direct / IVR / ring group / queue POST-answer bridge hold on the
    held caller/Local leg now uses the tenant's published MOH class.
  • current AND future tenants are covered the moment their reverse-map + MOH
    keys exist — publishing/changing MOH later needs NO installer re-run.
  • queue WAITING music (pre-answer) is native (queue music_group_id) — unchanged.
  • outbound (held trunk = called leg) unchanged (global-before-bridging hook).
  • tenant with no map / slug / class → pure no-op (native default).

Re-apply after VitalPBX "Apply Changes"/upgrade (idempotent):
  sudo $0

Health check:
  sudo $0 --check

Rollback (surgical — removes only the Connect-owned line(s) + hook file + include):
  sudo $0 --rollback
============================================================================
DONE
