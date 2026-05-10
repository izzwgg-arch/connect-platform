#!/usr/bin/env bash
# ============================================================================
# install-connect-tenant-moh-dialplan.sh
#
# Installs the Connect tenant MOH enforcement layer on a VitalPBX host.
#
# What this layer does
# --------------------
# VitalPBX's generated dialplan plays the **tenant default** music group on
# outbound / internal / bridge / hold legs (via `sub-local-dialing`,
# `trk-<id>-dial`, etc.). Connect's MOH publish updates the per-route /
# per-extension / per-queue `music_group_id` columns *and* the
# `connect/t_<slug>/moh_class` AstDB family, but neither of those overrides
# the channel `musicclass` value VitalPBX baked into the generated outbound /
# internal contexts. Result: a tenant who selects e.g. moh8 in Connect still
# hears moh3 (or whatever the historical default was) on outbound hold.
#
# This installer drops a Connect-owned include file:
#
#   /etc/asterisk/extensions__65_connect_tenant_moh.conf
#
# Some VitalPBX installs explicitly include only selected `extensions__*.conf`
# files instead of using a wildcard. If Asterisk does not load the new `__65`
# file after `dialplan reload`, the installer bridges it through the already
# loaded Connect-owned custom include:
#
#   /etc/asterisk/extensions__60_custom.conf
#
# by adding one sentinel line:
#
#   #include extensions__65_connect_tenant_moh.conf
#
# It still NEVER edits VitalPBX-generated baseplan / tenant / trunk files.
#
# It defines two contexts:
#
#   [sub-connect-tenant-moh]
#       AstDB-driven resolver. Recovers the numeric VitalPBX tenant id by
#       parsing "T<id>" from the existing channel context vars VitalPBX
#       sets on every per-tenant call (TRANSFER_CONTEXT, HINTS_CONTEXT,
#       FOLLOWME_CONTEXT, QUEUE_AGENTS_CONTEXT — all of the form
#       "T<id>_..."). Falls back to the ARG1 the bridging hook passed in
#       only when no channel-context prefix is parseable, and only when
#       ARG1 is purely numeric — VitalPBX builds vary in whether ARG1 to
#       [sub-before-bridging-call] is a numeric tenant id or an opaque
#       tenant hash, so accepting non-numeric ARG1 would publish bogus
#       AstDB lookups. Once a numeric tenant id is in hand, reads
#       connect/pbx_tenant_map/<id>/slug, then
#       connect/t_<slug>/{moh_class,active_moh_class}, and Sets
#       CHANNEL(musicclass) on the current leg. Returns unchanged if
#       anything is missing -> fail-safe to existing PBX behavior.
#
#   [global-before-bridging-call-hook]
#       Argument-mode-agnostic wrapper invoked by VitalPBX's generated
#       [sub-before-bridging-call] (extensions__20-baseplan.conf). Forwards
#       (TENANT, CALLER, CALLEE) to [sub-connect-tenant-moh] using ARG1..3
#       when passed positionally, falling back to ${TENANT}/${CALLER}/${CALLEE}
#       channel variables otherwise. Runs on the **called/trunk leg** per
#       Asterisk Dial U-flag semantics. Sets musicclass on that leg.
#
#   [connect-tenant-moh-connect-shim]
#       Shared shim invoked from per-tenant connect-leg hooks. Gosubs into
#       [sub-connect-tenant-moh] using the channel variables already set by
#       the [sub-before-connecting-call] preamble (TENANT/CALLER/CALLEE).
#       Runs on the **caller/originating leg** because VitalPBX's
#       [sub-before-connecting-call] is invoked via direct Gosub on the
#       caller channel before the Dial command's outbound INVITE goes out.
#       Sets musicclass on that leg.
#
#   [T<id>_before-connecting-call-hook]   (one per VitalPBX tenant)
#       Per-tenant connect-leg dispatch context. VitalPBX-baseplan
#       priority 16 of [sub-before-connecting-call] does:
#           GosubIf($[${DIALPLAN_EXISTS(${TENANT_PREFIX}before-connecting-call-hook,s,1)}=1]
#                   ?${TENANT_PREFIX}before-connecting-call-hook,s,1)
#       so each tenant we want to cover needs a context with the exact name
#       T<id>_before-connecting-call-hook to exist. Each per-tenant stanza
#       is just one `include => connect-tenant-moh-connect-shim` line; all
#       MOH logic lives in the shared shim + resolver. The set of tenant
#       ids is enumerated dynamically from the connect/pbx_tenant_map AstDB
#       family (populated by Connect API on every MOH publish/rollback) at
#       install time, NOT hand-edited.
#
# Why both legs need the hook
# ---------------------------
# Asterisk MOH-on-hold plays MOH **to the bridge peer** of whichever leg
# signaled HOLD, using **that peer's own** CHANNEL(musicclass). So if
# T3_302 holds, the trunk hears MOH from the trunk leg's musicclass; if
# the trunk holds, T3_302 hears MOH from the caller leg's musicclass.
# A single hook covering only the called/trunk leg (the U-flag path)
# handles only one direction. To play the tenant's selected class on
# hold regardless of which side initiates, both legs need their
# musicclass set.
#
# Hard rules
# ----------
#   * NEVER edits VitalPBX-generated extensions__*.conf files.
#   * NEVER touches musiconhold__*.conf, queues, or parking config.
#   * Idempotent. Safe to re-run.
#   * Backs up any existing same-named include before writing.
#   * Backs up `extensions__60_custom.conf` before adding the sentinel include,
#     if this host needs the bridge.
#   * Reloads dialplan and verifies BOTH contexts are present afterwards.
#   * On verification failure, restores the backup and aborts.
#
# Usage
# -----
#   chmod +x install-connect-tenant-moh-dialplan.sh
#   sudo ./install-connect-tenant-moh-dialplan.sh
#
# Rollback (run on PBX as root)
# -----------------------------
#   sed -i '/^#include extensions__65_connect_tenant_moh\.conf$/d' /etc/asterisk/extensions__60_custom.conf
#   rm -f /etc/asterisk/extensions__65_connect_tenant_moh.conf
#   asterisk -rx "dialplan reload"
#
# After rollback the PBX behavior is byte-identical to pre-install: the
# generated [sub-before-bridging-call] still calls the (no-op) FreePBX/
# VitalPBX baseplan hooks, the generated [sub-before-connecting-call]
# still does its DIALPLAN_EXISTS GosubIf which then no-ops because the
# T<id>_before-connecting-call-hook contexts only existed inside our
# (now-removed) include, but our resolver is no longer wired in.
#
# Operational note: re-run after publishing MOH for new tenants
# -------------------------------------------------------------
# The per-tenant T<id>_before-connecting-call-hook contexts are
# enumerated from AstDB at install time. If a tenant did not have a
# Connect MOH publish before this installer ran, their tenant id is
# not in connect/pbx_tenant_map and they will not have a connect-leg
# hook context. Re-run the installer after each new tenant's first
# successful MOH publish to add their stanza. The trunk-leg
# (called-leg) MOH continues to work via the U-flag global hook
# regardless of whether the per-tenant connect-leg stanza exists.
# ============================================================================

set -euo pipefail

step() { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '\nWARN: %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# ── 1. Preflight ────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "Run as root (sudo)."
command -v asterisk >/dev/null 2>&1 || die "asterisk binary not found in PATH"
asterisk -rx "core show channels count" >/dev/null 2>&1 \
  || die "asterisk -rx not responsive — is Asterisk running?"

DIALPLAN_FILE="/etc/asterisk/extensions__65_connect_tenant_moh.conf"
CUSTOM_FILE="/etc/asterisk/extensions__60_custom.conf"
BACKUP_FILE="${DIALPLAN_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
CUSTOM_BACKUP_FILE="${CUSTOM_FILE}.bak.connect-tenant-moh.$(date +%Y%m%d-%H%M%S)"
TMP_NEW="/tmp/connect-tenant-moh-new.$$.conf"
INCLUDE_LINE="#include extensions__65_connect_tenant_moh.conf"
trap 'rm -f "$TMP_NEW"' EXIT

restore_backups_and_die() {
  local msg="$1"
  warn "$msg"
  warn "Restoring include backup: $BACKUP_FILE"
  if [[ -s "$BACKUP_FILE" ]]; then
    cp -a "$BACKUP_FILE" "$DIALPLAN_FILE"
  else
    rm -f "$DIALPLAN_FILE"
  fi
  if [[ -f "$CUSTOM_BACKUP_FILE" ]]; then
    warn "Restoring custom dialplan backup: $CUSTOM_BACKUP_FILE"
    cp -a "$CUSTOM_BACKUP_FILE" "$CUSTOM_FILE"
  fi
  asterisk -rx "dialplan reload" >/dev/null 2>&1 || true
  die "Dialplan reload did not load both Connect tenant MOH contexts. Backups restored."
}

verify_contexts_loaded() {
  RESOLVER_OUT="$(asterisk -rx 'dialplan show sub-connect-tenant-moh' 2>&1 || true)"
  HOOK_OUT="$(asterisk -rx 'dialplan show global-before-bridging-call-hook' 2>&1 || true)"
  SHIM_OUT="$(asterisk -rx 'dialplan show connect-tenant-moh-connect-shim' 2>&1 || true)"

  resolver_ok=0
  hook_ok=0
  shim_ok=0
  if echo "$RESOLVER_OUT" | grep -q "Connect tenant MOH resolver"; then
    resolver_ok=1
  fi
  if echo "$HOOK_OUT" | grep -q "Connect global before-bridging hook"; then
    hook_ok=1
  fi
  if echo "$SHIM_OUT" | grep -q "Connect tenant MOH connect-leg shim"; then
    shim_ok=1
  fi
  [[ $resolver_ok -eq 1 && $hook_ok -eq 1 && $shim_ok -eq 1 ]]
}

print_context_verification() {
  if [[ ${resolver_ok:-0} -eq 1 ]]; then
    echo "  ↳ OK — [sub-connect-tenant-moh] loaded"
  else
    warn "[sub-connect-tenant-moh] not found after reload. Output was:"
    echo "$RESOLVER_OUT" | head -20
  fi
  if [[ ${hook_ok:-0} -eq 1 ]]; then
    echo "  ↳ OK — [global-before-bridging-call-hook] loaded"
  else
    warn "[global-before-bridging-call-hook] not found after reload. Output was:"
    echo "$HOOK_OUT" | head -20
  fi
  if [[ ${shim_ok:-0} -eq 1 ]]; then
    echo "  ↳ OK — [connect-tenant-moh-connect-shim] loaded"
  else
    warn "[connect-tenant-moh-connect-shim] not found after reload. Output was:"
    echo "$SHIM_OUT" | head -20
  fi
  if [[ ${PER_TENANT_COUNT:-0} -gt 0 ]]; then
    SAMPLE_TID="$(printf '%s\n' "$TENANT_IDS" | head -n1)"
    PER_TENANT_OUT="$(asterisk -rx "dialplan show T${SAMPLE_TID}_before-connecting-call-hook" 2>&1 || true)"
    if echo "$PER_TENANT_OUT" | grep -q "Include =>.*connect-tenant-moh-connect-shim"; then
      echo "  ↳ OK — [T${SAMPLE_TID}_before-connecting-call-hook] loaded (sample of $PER_TENANT_COUNT)"
    else
      warn "[T${SAMPLE_TID}_before-connecting-call-hook] sample did not show the expected include. Output was:"
      echo "$PER_TENANT_OUT" | head -20
    fi
  fi
}

# ── 2. Snapshot existing include (if any) ───────────────────────────────────
step "[1/6] Snapshot any existing include"
if [[ -f "$DIALPLAN_FILE" ]]; then
  cp -a "$DIALPLAN_FILE" "$BACKUP_FILE"
  echo "  ↳ backed up to $BACKUP_FILE"
else
  echo "  ↳ no existing $DIALPLAN_FILE — fresh install"
  : > "$BACKUP_FILE"
fi

# ── 3. Write new include ────────────────────────────────────────────────────
# Heredoc literal — no shell interpolation, no per-tenant data baked in.
step "[2/6] Write Connect tenant MOH dialplan include"
cat > "$TMP_NEW" <<'CONNECT_TENANT_MOH_EOF'
; ============================================================================
; Connect tenant MOH enforcement layer
; (Auto-installed by scripts/pbx/install-connect-tenant-moh-dialplan.sh —
;  DO NOT HAND-EDIT THIS FILE. Re-run the installer to update.)
;
; Read-only consumer of these AstDB keys (written by Connect API on every
; MOH publish + rollback):
;
;   connect/pbx_tenant_map/<numeric-vital-tenant-id>/slug      → tenant slug
;   connect/pbx_tenant_map/<numeric-vital-tenant-id>/moh_class → effective class
;   connect/t_<slug>/moh_class                                 → primary value
;   connect/t_<slug>/active_moh_class                          → fallback alias
;
; Wired in via the VitalPBX-generated [sub-before-bridging-call] in
; extensions__20-baseplan.conf, which Gosubs [global-before-bridging-call-hook]
; (defined below). The resolver Sets CHANNEL(musicclass) on the leg about to
; be bridged so when that leg is later put on hold, MoH plays the tenant's
; selected class.
;
; Fail-safe: any missing AstDB key, missing endpoint prefix, or non-numeric
; tenant id results in a bare Return() and leaves the channel's musicclass
; untouched. NEVER hangs up, redirects, or alters CDR/recording behavior.
; ============================================================================

[sub-connect-tenant-moh]
exten => s,1,NoOp(Connect tenant MOH resolver tenant=${ARG1} caller=${ARG2} callee=${ARG3} preset=${CHANNEL(musicclass)})
 ; Channel-context tenant identity (preferred). VitalPBX's per-tenant
 ; generated dialplan populates these *_CONTEXT vars on every channel
 ; routed through a tenant context (e.g. TRANSFER_CONTEXT=T<id>_cos-all
 ; on outbound trunk dial). ARG1 from [sub-before-bridging-call] in some
 ; VitalPBX builds is the tenant **hash** rather than a numeric tenant id,
 ; so the channel-context vars are the reliable source.
 same => n,Set(TENANT_CTX_RAW=${TRANSFER_CONTEXT})
 same => n,ExecIf($["${TENANT_CTX_RAW}" = ""]?Set(TENANT_CTX_RAW=${HINTS_CONTEXT}))
 same => n,ExecIf($["${TENANT_CTX_RAW}" = ""]?Set(TENANT_CTX_RAW=${FOLLOWME_CONTEXT}))
 same => n,ExecIf($["${TENANT_CTX_RAW}" = ""]?Set(TENANT_CTX_RAW=${QUEUE_AGENTS_CONTEXT}))
 ; First underscore-delimited segment, e.g. "T<id>" out of "T<id>_cos-all".
 same => n,Set(TENANT_CTX_PREFIX=${CUT(TENANT_CTX_RAW,_,1)})
 ; Accept the channel-context prefix only when it is "T<digits>".
 same => n,Set(TENANT_FROM_CTX=)
 same => n,ExecIf($["${TENANT_CTX_PREFIX:0:1}" = "T"]?Set(TENANT_FROM_CTX=${FILTER(0-9,${TENANT_CTX_PREFIX:1})}))
 ; ARG1-derived id (fallback). Accept only when purely numeric so opaque
 ; VitalPBX tenant hashes do not become bogus reverse-map lookups.
 same => n,Set(TENANT_RAW=${ARG1})
 same => n,Set(TENANT_FROM_ARG=${IF($["${TENANT_RAW:0:1}" = "T"]?${TENANT_RAW:1}:${TENANT_RAW})})
 same => n,ExecIf($["${TENANT_FROM_ARG}" != "${FILTER(0-9,${TENANT_FROM_ARG})}"]?Set(TENANT_FROM_ARG=))
 ; Prefer context-derived id; fall back to ARG1.
 same => n,Set(TENANT_ID=${IF($["${TENANT_FROM_CTX}" != ""]?${TENANT_FROM_CTX}:${TENANT_FROM_ARG})})
 same => n,GotoIf($["${TENANT_ID}" = ""]?done)
 same => n,Set(TENANT_SLUG_LOCAL=${DB(connect/pbx_tenant_map/${TENANT_ID}/slug)})
 same => n,GotoIf($["${TENANT_SLUG_LOCAL}" = ""]?done)
 same => n,Set(MOH_CLASS_LOCAL=${DB(connect/t_${TENANT_SLUG_LOCAL}/moh_class)})
 same => n,ExecIf($["${MOH_CLASS_LOCAL}" = ""]?Set(MOH_CLASS_LOCAL=${DB(connect/t_${TENANT_SLUG_LOCAL}/active_moh_class)}))
 same => n,GotoIf($["${MOH_CLASS_LOCAL}" = ""]?done)
 same => n,Set(CHANNEL(musicclass)=${MOH_CLASS_LOCAL})
 same => n,Set(__CONNECT_MOH=${MOH_CLASS_LOCAL})
 same => n,NoOp(Connect tenant MOH applied tenant_id=${TENANT_ID} slug=${TENANT_SLUG_LOCAL} class=${MOH_CLASS_LOCAL})
 same => n,Return()
 same => n(done),NoOp(Connect tenant MOH skipped tenant_id=${TENANT_ID} slug=${TENANT_SLUG_LOCAL} class=${MOH_CLASS_LOCAL})
 same => n,Return()

; Wrapper hook called by VitalPBX-generated [sub-before-bridging-call]. The
; baseplan in some VitalPBX builds forwards (TENANT, CALLER, CALLEE) as
; positional args; in others the values are only available as channel vars.
; The IF()-Set() pattern below works in both cases without a prior read of
; extensions__20-baseplan.conf — see scripts/pbx/install-connect-tenant-moh-dialplan.sh
; comment block for the contract notes.
;
; Runs on the **called/trunk leg** per Asterisk Dial U-flag semantics.
[global-before-bridging-call-hook]
exten => s,1,NoOp(Connect global before-bridging hook arg1=${ARG1} tenant=${TENANT} caller=${CALLER} callee=${CALLEE})
 same => n,Set(T=${IF($["${ARG1}" != ""]?${ARG1}:${TENANT})})
 same => n,Set(FROM=${IF($["${ARG2}" != ""]?${ARG2}:${CALLER})})
 same => n,Set(TO=${IF($["${ARG3}" != ""]?${ARG3}:${CALLEE})})
 same => n,Gosub(sub-connect-tenant-moh,s,1(${T},${FROM},${TO}))
 same => n,Return()

; Shared shim invoked by every per-tenant T<id>_before-connecting-call-hook
; context (defined dynamically below — see installer comment block). The
; per-tenant contexts use `include =>` to fall through to this single
; shim's `s,1`, so all MOH-resolution logic lives here and the per-tenant
; stanzas stay one line each.
;
; Runs on the **caller/originating leg**: VitalPBX-baseplan
; [sub-before-connecting-call] is invoked via direct Gosub on the caller
; channel before its outbound Dial command issues the INVITE, then at
; priority 16 GosubIfs into ${TENANT_PREFIX}before-connecting-call-hook.
; The TENANT/CALLER/CALLEE channel variables are set by priorities 2..4
; of [sub-before-connecting-call] before that GosubIf, so they are
; available here and the shim does not need positional args from the
; caller-side hook chain.
[connect-tenant-moh-connect-shim]
exten => s,1,NoOp(Connect tenant MOH connect-leg shim tenant=${TENANT} caller=${CALLER} callee=${CALLEE} preset=${CHANNEL(musicclass)})
 same => n,Gosub(sub-connect-tenant-moh,s,1(${TENANT},${CALLER},${CALLEE}))
 same => n,Return()
CONNECT_TENANT_MOH_EOF

# ── 3b. Append per-tenant connect-leg hook stanzas ──────────────────────────
# Asterisk does not pattern-match context names, so each tenant we want to
# cover on the caller leg needs an exact-named context — VitalPBX baseplan
# dispatches into ${TENANT_PREFIX}before-connecting-call-hook (e.g.
# T3_before-connecting-call-hook). Enumerate tenant ids from the
# connect/pbx_tenant_map AstDB family the API publishes on every MOH
# publish/rollback, and emit one `include =>` shim stanza per id. Numeric
# ids only — anything else is rejected so no unexpected family-key shape
# can sneak a context name in.
step "[3b/6] Discover Connect-known tenants from AstDB and generate per-tenant connect-leg hooks"
TENANT_MAP_RAW="$(asterisk -rx 'database show connect/pbx_tenant_map' 2>/dev/null || true)"
TENANT_IDS="$(printf '%s\n' "$TENANT_MAP_RAW" \
  | awk -F'/' '/^\/connect\/pbx_tenant_map\//{print $4}' \
  | grep -E '^[0-9]+$' \
  | sort -un \
  || true)"

if [[ -z "$TENANT_IDS" ]]; then
  warn "No tenants found in connect/pbx_tenant_map AstDB family."
  warn "The connect-leg shim is installed, but no T<id>_before-connecting-call-hook"
  warn "contexts will be defined this run. Outbound MOH on caller-leg-held calls will"
  warn "not change for any tenant until Connect publishes MOH at least once and this"
  warn "installer is re-run. The trunk-leg (called-leg) hook is unaffected."
  PER_TENANT_COUNT=0
else
  PER_TENANT_COUNT="$(printf '%s\n' "$TENANT_IDS" | wc -l | tr -d ' ')"
  echo "  ↳ found $PER_TENANT_COUNT tenant id(s): $(printf '%s ' $TENANT_IDS)"
  {
    echo ""
    echo "; ──────────────────────────────────────────────────────────────────────────"
    echo "; Per-tenant connect-leg hook contexts."
    echo "; Auto-generated at install time from the connect/pbx_tenant_map AstDB family."
    echo "; To add a new tenant: have Connect publish MOH for that tenant once (which"
    echo ";   populates connect/pbx_tenant_map/<new_id>/{slug,moh_class}), then re-run"
    echo ";   this installer."
    echo "; To remove a tenant: re-run this installer after the tenant's reverse-map"
    echo ";   keys have been cleared from AstDB."
    echo "; ──────────────────────────────────────────────────────────────────────────"
    echo ""
    for tid in $TENANT_IDS; do
      echo "[T${tid}_before-connecting-call-hook]"
      echo "include => connect-tenant-moh-connect-shim"
      echo ""
    done
  } >> "$TMP_NEW"
fi

# ── 4. Install + permissions ────────────────────────────────────────────────
step "[3/6] Install include + set permissions"
mv "$TMP_NEW" "$DIALPLAN_FILE"
chown asterisk:asterisk "$DIALPLAN_FILE"
chmod 0644 "$DIALPLAN_FILE"
echo "  ↳ wrote $DIALPLAN_FILE ($(wc -l < "$DIALPLAN_FILE" | tr -d ' ') lines, $PER_TENANT_COUNT per-tenant connect-leg stanzas)"

# ── 5. Reload Asterisk dialplan ────────────────────────────────────────────
step "[4/6] Reload Asterisk dialplan"
RELOAD_OUT="$(asterisk -rx 'dialplan reload' 2>&1 || true)"
echo "  ↳ $RELOAD_OUT"

# ── 6. Verify all required contexts loaded; bridge through __60_custom if needed ────
step "[5/6] Verify [sub-connect-tenant-moh] + [global-before-bridging-call-hook] + [connect-tenant-moh-connect-shim] are loaded"
if verify_contexts_loaded; then
  print_context_verification
else
  print_context_verification
  warn "The new include file was written, but Asterisk did not load it directly."
  warn "This VitalPBX install likely does not wildcard-include extensions__*.conf."
  [[ -f "$CUSTOM_FILE" ]] || restore_backups_and_die "$CUSTOM_FILE is missing; cannot bridge include safely."

  step "[5b/6] Bridge new include through already-loaded Connect custom dialplan"
  if ! grep -Fxq "$INCLUDE_LINE" "$CUSTOM_FILE"; then
    cp -a "$CUSTOM_FILE" "$CUSTOM_BACKUP_FILE"
    printf '\n; Connect tenant MOH enforcement include (auto-added by install-connect-tenant-moh-dialplan.sh)\n%s\n' "$INCLUDE_LINE" >> "$CUSTOM_FILE"
    chown asterisk:asterisk "$CUSTOM_FILE"
    chmod 0644 "$CUSTOM_FILE"
    echo "  ↳ added sentinel include to $CUSTOM_FILE"
    echo "  ↳ backed up custom dialplan to $CUSTOM_BACKUP_FILE"
  else
    echo "  ↳ sentinel include already present in $CUSTOM_FILE"
  fi

  RELOAD_OUT="$(asterisk -rx 'dialplan reload' 2>&1 || true)"
  echo "  ↳ $RELOAD_OUT"
  if verify_contexts_loaded; then
    print_context_verification
    echo "  ↳ OK — contexts loaded through $CUSTOM_FILE"
  else
    print_context_verification
    restore_backups_and_die "Verification failed even after bridging through $CUSTOM_FILE."
  fi
fi

# ── 7. AstDB smoke output ───────────────────────────────────────────────────
step "[6/6] AstDB reverse-tenant-map smoke output"
echo "  ↳ connect/pbx_tenant_map family (populated by Connect MOH publish + rollback):"
asterisk -rx 'database show connect/pbx_tenant_map' 2>&1 | sed 's/^/      /' \
  || echo "      (no reverse-tenant-map keys yet — run a MOH publish from Connect to populate)"

cat <<DONE

============================================================================
INSTALL COMPLETE.

Backup of previous include: $BACKUP_FILE
Backup of Connect custom dialplan (only if bridged): ${CUSTOM_BACKUP_FILE:-not-created}
Per-tenant connect-leg hooks generated this run: ${PER_TENANT_COUNT:-0}

Wired in via two VitalPBX-generated baseplan subroutines (extensions__20-baseplan.conf):

  • [sub-before-bridging-call]   — Gosubs [global-before-bridging-call-hook]
                                   on the **called/trunk leg** (Dial U-flag).
  • [sub-before-connecting-call] — GosubIfs into
                                   [T<id>_before-connecting-call-hook]
                                   on the **caller/originating leg** before
                                   the outbound INVITE goes out.

Both wrappers Gosub into the shared [sub-connect-tenant-moh] resolver so
both legs of the bridge end up with CHANNEL(musicclass) set to the
tenant-selected class — covering MOH-on-hold regardless of which side
initiates the hold.

Verify on a live call:
  • From a Connect-managed extension (e.g. T<N>_<ext>), dial out and answer.
  • In another shell while the call is up:
        asterisk -rx "core show channels"
    Find BOTH legs (PJSIP/T<N>_<ext>-... and PJSIP/<trunk_dial>-...).
  • For each leg:
        asterisk -rx "core show channel <CHAN>" | grep -i MusicClass
    Expected: MusicClass: <tenant moh class published by Connect>.
  • Then put the call on hold from EITHER side. The party who is held
    should audibly hear the tenant's MOH class.

If MusicClass is wrong on either leg:
  • Confirm Connect API published the reverse map:
        asterisk -rx "database show connect/pbx_tenant_map"
    Expect connect/pbx_tenant_map/<id>/slug = <tenant-slug> and
           connect/pbx_tenant_map/<id>/moh_class = <effective-class>.
  • If those keys are missing, run a MOH publish for that tenant in Connect.
  • If the **caller leg** has the right MusicClass but the **trunk leg**
    does not, the called-leg U-flag wiring did not fire. Confirm:
        asterisk -rx "dialplan show sub-before-bridging-call" | grep -i hook
  • If the **trunk leg** has the right MusicClass but the **caller leg**
    does not, the caller-leg connect hook did not fire. Confirm the per-
    tenant context exists:
        asterisk -rx "dialplan show T<id>_before-connecting-call-hook"
    If not, your tenant did not have a connect/pbx_tenant_map AstDB key
    when this installer last ran. Re-publish MOH in Connect (which writes
    the AstDB keys) and re-run this installer.

Rollback (instant):
  sed -i '/^#include extensions__65_connect_tenant_moh\.conf$/d' $CUSTOM_FILE
  rm -f $DIALPLAN_FILE
  asterisk -rx "dialplan reload"

============================================================================
DONE
