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
#       AstDB-driven resolver. Reads connect/pbx_tenant_map/<id>/slug to
#       recover the canonical Connect tenant slug from a numeric VitalPBX
#       tenant id, then reads connect/t_<slug>/{moh_class,active_moh_class}
#       and Sets CHANNEL(musicclass) on the current leg. Returns unchanged
#       if anything is missing -> fail-safe to existing PBX behavior.
#
#   [global-before-bridging-call-hook]
#       Argument-mode-agnostic wrapper invoked by VitalPBX's generated
#       [sub-before-bridging-call] (extensions__20-baseplan.conf). Forwards
#       (TENANT, CALLER, CALLEE) to [sub-connect-tenant-moh] using ARG1..3
#       when passed positionally, falling back to ${TENANT}/${CALLER}/${CALLEE}
#       channel variables otherwise.
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
# VitalPBX baseplan hooks, but our resolver is no longer wired in.
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

  resolver_ok=0
  hook_ok=0
  if echo "$RESOLVER_OUT" | grep -q "Connect tenant MOH resolver"; then
    resolver_ok=1
  fi
  if echo "$HOOK_OUT" | grep -q "Connect global before-bridging hook"; then
    hook_ok=1
  fi
  [[ $resolver_ok -eq 1 && $hook_ok -eq 1 ]]
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
 same => n,Set(TENANT_RAW=${ARG1})
 same => n,GotoIf($["${TENANT_RAW}" = ""]?done)
 ; Normalize "T3" → "3"; leave bare numerics (or unknown shapes) alone.
 same => n,Set(TENANT_ID=${IF($["${TENANT_RAW:0:1}" = "T"]?${TENANT_RAW:1}:${TENANT_RAW})})
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
[global-before-bridging-call-hook]
exten => s,1,NoOp(Connect global before-bridging hook arg1=${ARG1} tenant=${TENANT} caller=${CALLER} callee=${CALLEE})
 same => n,Set(T=${IF($["${ARG1}" != ""]?${ARG1}:${TENANT})})
 same => n,Set(FROM=${IF($["${ARG2}" != ""]?${ARG2}:${CALLER})})
 same => n,Set(TO=${IF($["${ARG3}" != ""]?${ARG3}:${CALLEE})})
 same => n,Gosub(sub-connect-tenant-moh,s,1(${T},${FROM},${TO}))
 same => n,Return()
CONNECT_TENANT_MOH_EOF

# ── 4. Install + permissions ────────────────────────────────────────────────
step "[3/6] Install include + set permissions"
mv "$TMP_NEW" "$DIALPLAN_FILE"
chown asterisk:asterisk "$DIALPLAN_FILE"
chmod 0644 "$DIALPLAN_FILE"
echo "  ↳ wrote $DIALPLAN_FILE ($(wc -l < "$DIALPLAN_FILE" | tr -d ' ') lines)"

# ── 5. Reload Asterisk dialplan ────────────────────────────────────────────
step "[4/6] Reload Asterisk dialplan"
RELOAD_OUT="$(asterisk -rx 'dialplan reload' 2>&1 || true)"
echo "  ↳ $RELOAD_OUT"

# ── 6. Verify both contexts loaded; bridge through __60_custom if needed ────
step "[5/6] Verify [sub-connect-tenant-moh] + [global-before-bridging-call-hook] are loaded"
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

Wired in via VitalPBX-generated [sub-before-bridging-call] (extensions__20-baseplan.conf),
which Gosubs [global-before-bridging-call-hook] — defined by THIS include.

Verify on a live call:
  • From a Connect-managed extension (e.g. T<N>_<ext>), dial out and put the call on hold.
  • In another shell: asterisk -rx "core show channels concise" → find the channel
                       asterisk -rx "core show channel <CHAN>"  → look at "MusicClass:"
  • Expected: the moh class published by Connect for that tenant.

If MusicClass is still wrong:
  • Confirm Connect API published the reverse map:
        asterisk -rx "database show connect/pbx_tenant_map"
    Expect connect/pbx_tenant_map/<id>/slug = <tenant-slug> and
           connect/pbx_tenant_map/<id>/moh_class = <effective-class>
  • If those keys are missing, run a MOH publish for that tenant in Connect.
  • If keys exist but MusicClass is unchanged, confirm
        asterisk -rx "dialplan show sub-before-bridging-call" | grep -i hook
    contains a Gosub line that lands in [global-before-bridging-call-hook].

Rollback (instant):
  sed -i '/^#include extensions__65_connect_tenant_moh\.conf$/d' $CUSTOM_FILE
  rm -f $DIALPLAN_FILE
  asterisk -rx "dialplan reload"

============================================================================
DONE
