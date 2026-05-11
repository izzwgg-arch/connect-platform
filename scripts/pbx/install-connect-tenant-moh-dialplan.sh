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
# Caller-leg coverage on outbound trunk dials
# -------------------------------------------
# On VitalPBX builds where [sub-before-connecting-call] is NOT invoked
# from the per-trunk caller dial path (verified on 2026-05-10 against
# trk-33-dial — that context only contains a Dial(... U(...)) line and
# never Gosubs into sub-before-connecting-call), the dialplan-side
# connect-leg shim is unreachable for outbound calls. To cover the
# caller leg without editing a single VitalPBX-generated file, this
# installer also writes a Connect-owned PJSIP include:
#
#   /etc/asterisk/pjsip__65_connect_tenant_moh.conf
#
# The PJSIP include uses Asterisk's `[name](+)` append syntax to add a
# `set_var = CHANNEL(musicclass)=<class>` line to each Connect-known
# tenant's `T<id>_*` extension endpoints. PJSIP applies set_var via
# pbx_builtin_setvar_helper on every channel created from the endpoint,
# which honors function-call syntax in the variable name — so the
# CHANNEL function fires at channel-creation time, BEFORE any dialplan
# runs, and the caller leg has the right musicclass from the moment
# the INVITE hits Asterisk. Trunk endpoints are NOT touched here; the
# trunk leg is still covered by the existing called-leg U-flag hook.
#
# Hard rules
# ----------
#   * NEVER edits VitalPBX-generated extensions__*.conf or pjsip__*.conf files.
#   * NEVER touches musiconhold__*.conf, queues, or parking config.
#   * NEVER touches PJSIP transports, AORs, registrations, or templates —
#     only `[<existing-endpoint>](+)` append blocks, never new endpoints.
#   * Idempotent. Safe to re-run.
#   * Backs up any existing same-named includes before writing.
#   * Backs up `extensions__60_custom.conf` before adding the sentinel include,
#     if this host needs the bridge.
#   * Reloads dialplan AND pjsip, and verifies all required contexts and a
#     sample PJSIP set_var are present afterwards.
#   * On verification failure, restores the backups and aborts.
#
# Usage
# -----
#   chmod +x install-connect-tenant-moh-dialplan.sh
#   sudo ./install-connect-tenant-moh-dialplan.sh                # install (default)
#   sudo ./install-connect-tenant-moh-dialplan.sh --check        # read-only health check
#   sudo ./install-connect-tenant-moh-dialplan.sh --rollback     # uninstall (Connect-owned only)
#   ./install-connect-tenant-moh-dialplan.sh --help              # usage + mode summary
#
# --check is the on-call probe: it never writes, never reloads, and exits
# non-zero only when a HARD probe fails. The hard probes are: dialplan
# include present, resolver/global-hook/connect-shim contexts loaded,
# AstDB reverse-map has at least one tenant, and (when the canary
# wrapper is present) the trk-33-dial invariants + wrapper sentinel.
#
# The two PJSIP-dependent probes (PJSIP include file present, sample
# T<id>_* endpoint carries CHANNEL(musicclass)) are now SOFT/WARN-only
# because PJSIP `[endpoint](+)` append does NOT reliably propagate
# set_var = CHANNEL(musicclass) on this VitalPBX/Asterisk build
# (verified 2026-05-10 against canary PBX 209.145.60.79). The supported
# caller-leg coverage on this build is the canary outbound trunk
# wrapper (`--enable-trk-wrapper=33`), not PJSIP append. The installer
# still ATTEMPTS the PJSIP append in install mode for forwards-
# compatibility with future builds where it might work, and on
# verification failure rolls back ONLY the PJSIP layer; the dialplan
# layer survives. --check therefore emits `[WARN]` for the two PJSIP
# probes and prints a `(W deprecated-PJSIP warning(s))` suffix on the
# RESULT line; exit code stays 0 unless a HARD probe fails.
#
# --rollback removes only Connect-owned files and the sentinel
# `#include` line, then reloads dialplan + pjsip; it never touches
# VitalPBX-generated config.
#
# Rollback (run on PBX as root) — equivalent to `--rollback`:
# ----------------------------------------------------------
#   sed -i '/^#include extensions__65_connect_tenant_moh\.conf$/d' /etc/asterisk/extensions__60_custom.conf
#   rm -f /etc/asterisk/extensions__65_connect_tenant_moh.conf
#   rm -f /etc/asterisk/pjsip__65_connect_tenant_moh.conf
#   asterisk -rx "dialplan reload"
#   asterisk -rx "module reload res_pjsip.so"   # NOT `pjsip reload` — see pjsip_reload() below
#
# After rollback the PBX behavior is byte-identical to pre-install: the
# generated [sub-before-bridging-call] still calls the (no-op) FreePBX/
# VitalPBX baseplan hooks, the generated [sub-before-connecting-call]
# still does its DIALPLAN_EXISTS GosubIf which then no-ops because the
# T<id>_before-connecting-call-hook contexts only existed inside our
# (now-removed) include, the PJSIP endpoints lose only the Connect-added
# set_var lines (their original VitalPBX-generated config is intact),
# and our resolver is no longer wired in.
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

# Reload PJSIP using a CLI variant that exists on this Asterisk build.
# `pjsip reload` is the convenient one-liner introduced in newer
# Asterisk, but is NOT shipped on every VitalPBX/Asterisk build — on
# affected builds `asterisk -rx "pjsip reload"` returns
# "No such command 'pjsip reload'" and silently leaves PJSIP at its
# previous config (verified 2026-05-10 against the canary PBX).
#
# Try the canonical module-reload form first since `module reload
# res_pjsip.so` has been part of Asterisk since 12 and is what `pjsip
# reload` is aliased to internally on builds that do ship it. Fall
# back to `core reload` only as a last resort because it reloads every
# reloadable module on the box.
#
# Returns 0 if either command was accepted by the CLI; emits the
# Asterisk CLI's own output on stdout for the caller to log. Detect
# rejection by grepping the output for "No such command" /
# "command not found" rather than relying on exit codes — Asterisk's
# `-rx` returns 0 even when the inner command was unknown.
pjsip_reload() {
  local out
  out="$(asterisk -rx 'module reload res_pjsip.so' 2>&1 || true)"
  if echo "$out" | grep -qiE 'no such command|command not found'; then
    out="$(asterisk -rx 'core reload' 2>&1 || true)"
  fi
  printf '%s' "$out"
}

# ── 0. Mode + flag parsing ──────────────────────────────────────────────────
# Default mode is "install" (preserves original behavior). --check and
# --rollback are explicit operator subcommands; --help prints usage and
# exits. Unknown args exit 64 (EX_USAGE) before any preflight or write.
#
# --enable-trk-wrapper=<id> is an additive flag, NOT a mode. Currently the
# only accepted value is 33 (canary scope: trunk 33 only, tenant T3 only).
# Anything else is rejected. Default off — the existing install/check/rollback
# paths behave byte-identically when the flag is absent.
MODE=""
ENABLE_TRK_WRAPPER=""
for arg in "$@"; do
  case "$arg" in
    ""|install)
      MODE="${MODE:-install}"
      ;;
    -h|--help|help)
      MODE="help"
      ;;
    --check|-n|--dry-run|check)
      MODE="check"
      ;;
    --rollback|--uninstall|rollback|uninstall)
      MODE="rollback"
      ;;
    --enable-trk-wrapper=*)
      val="${arg#*=}"
      if [[ "$val" != "33" ]]; then
        printf 'ERROR: --enable-trk-wrapper only accepts value 33 (canary scope); got %q\n' "$val" >&2
        exit 64
      fi
      ENABLE_TRK_WRAPPER="$val"
      ;;
    *)
      printf 'ERROR: unknown arg %q (try --help)\n' "$arg" >&2
      exit 64
      ;;
  esac
done
MODE="${MODE:-install}"

if [[ "$MODE" = "help" ]]; then
  cat <<'HELP'
install-connect-tenant-moh-dialplan.sh — Connect tenant MOH enforcement layer
=============================================================================

Modes:
  install        (default) Write Connect-owned dialplan + PJSIP includes,
                 reload dialplan and pjsip, verify all required contexts
                 and a sample endpoint carry CHANNEL(musicclass). Backs
                 up any prior same-named includes; rolls back on failure.

  --check        Read-only. Probes the live PBX state and prints PASS / WARN
                 / FAIL per probe:
                   1. dialplan include file present                  [HARD]
                   2. resolver + global hook + shim contexts loaded  [HARD]
                   3. PJSIP include file present                     [SOFT]
                   4. AstDB reverse-map has at least one tenant      [HARD]
                   5. sample T<id>_* endpoint carries CHANNEL(musicclass)
                                                                    [SOFT]
                   6. canary trk-33 wrapper invariants (when present) [HARD]
                 Exits 0 only when all HARD probes pass. SOFT probes (3, 5)
                 are emitted as `[WARN]` because PJSIP `[endpoint](+)` append
                 does not reliably set CHANNEL(musicclass) on this VitalPBX
                 build (caller-leg coverage is supplied by the canary trunk
                 wrapper instead — see `--enable-trk-wrapper=33`). Never
                 writes files, never reloads asterisk.

  --rollback     Removes only Connect-owned files:
                   - /etc/asterisk/extensions__65_connect_tenant_moh.conf
                   - /etc/asterisk/pjsip__65_connect_tenant_moh.conf
                   - sentinel "#include extensions__65_connect_tenant_moh.conf"
                     line in /etc/asterisk/extensions__60_custom.conf (only
                     that one line — backs up first)
                   - /etc/asterisk/extensions__65_connect_trk33_wrapper.conf
                     (canary outbound caller-leg MOH wrapper, when present)
                 Reloads dialplan and pjsip. Verifies the contexts are no
                 longer loaded. Never touches VitalPBX-generated config.

  --enable-trk-wrapper=33
                 Additive install flag (canary scope, OFF by default). When
                 set during `install`, also writes the Connect-owned canary
                 outbound caller-leg MOH wrapper for trunk 33 / tenant T3:
                   - /etc/asterisk/extensions__65_connect_trk33_wrapper.conf
                 Refuses to install if any generated [trk-33-dial] invariant
                 differs (baseline SHA, pattern shape, priorities 21/22/44).
                 Only the value `33` is accepted in this canary release.

  --help         Print this message and exit 0.

All modes require root. The script is idempotent in every mode and safe
to re-run after every Connect MOH publish (which writes the AstDB
reverse-map keys the install path enumerates).
HELP
  exit 0
fi

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

PJSIP_FILE="/etc/asterisk/pjsip__65_connect_tenant_moh.conf"
PJSIP_BACKUP_FILE="${PJSIP_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
PJSIP_TMP_NEW="/tmp/connect-tenant-moh-pjsip-new.$$.conf"

# ── Canary outbound caller-leg MOH wrapper (trunk 33 / tenant T3) ──────────
# Connect-owned include that shadows priority 1 of [trk-33-dial] using the
# EXACT generated pattern '_[-+*#0-9a-zA-Z].'. Default OFF — only written when
# the operator passes --enable-trk-wrapper=33 to install mode. Lives next to
# the other Connect-owned __65_* includes so VitalPBX-generated files are
# never touched.
TRK_WRAPPER_TARGET_TRUNK="33"
TRK_WRAPPER_TARGET_TENANT="3"
TRK_WRAPPER_PATTERN='_[-+*#0-9a-zA-Z].'
TRK_WRAPPER_FILE="/etc/asterisk/extensions__65_connect_trk33_wrapper.conf"
TRK_WRAPPER_BACKUP_FILE="${TRK_WRAPPER_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
TRK_WRAPPER_TMP_NEW="/tmp/connect-trk33-wrapper-new.$$.conf"
# Baseline drift hash captured by scripts/pbx/diag-connect-trk33-wrapper-feasibility.sh
# from `asterisk -rx "dialplan show trk-33-dial" | head -80 | sha256sum`. Used as
# a pre-install gate so we refuse to ship the wrapper if VitalPBX has regenerated
# trk-33-dial between feasibility capture and install.
TRK_WRAPPER_BASELINE_SHA256="9636ed092f6f8154deae751d199574c2cf7e3dd29eb00a263be5ae7b6f250695"

trap 'rm -f "$TMP_NEW" "$PJSIP_TMP_NEW" "$TRK_WRAPPER_TMP_NEW"' EXIT

# Skipped-tenant rollup (install mode only). Each entry is "T<id>: <reason>".
# Initialized to the empty list so `set -u` is happy when nothing was skipped.
SKIPPED_TENANTS=()

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

# Roll back ONLY the PJSIP include — the dialplan layer above is already
# verified loaded and covers the trunk/called-leg path on its own. Restore
# any prior PJSIP include from $PJSIP_BACKUP_FILE if it existed before this
# run, otherwise remove the new include outright. Reload pjsip after the
# restore so Asterisk drops the failed config from its working set.
rollback_pjsip_and_warn() {
  local msg="$1"
  warn "$msg"
  if [[ -s "$PJSIP_BACKUP_FILE" ]]; then
    warn "Restoring PJSIP include backup: $PJSIP_BACKUP_FILE"
    cp -a "$PJSIP_BACKUP_FILE" "$PJSIP_FILE"
    chown asterisk:asterisk "$PJSIP_FILE" 2>/dev/null || true
    chmod 0644 "$PJSIP_FILE" 2>/dev/null || true
  else
    warn "Removing failed PJSIP include: $PJSIP_FILE"
    rm -f "$PJSIP_FILE"
  fi
  pjsip_reload >/dev/null 2>&1 || true
  warn "PJSIP caller-leg MOH layer rolled back. Trunk/called-leg dialplan layer remains active."
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

# ── Health-check mode (read-only) ──────────────────────────────────────────
# Probes the running PBX and prints PASS/FAIL for each of the five hardening
# checks the requirements call out:
#   1. dialplan include file present at the expected path           [HARD]
#   2. resolver + global hook + shim contexts loaded                [HARD]
#   3. PJSIP include file present                                   [SOFT]
#   4. AstDB reverse-map has at least one tenant                    [HARD]
#   5. sample T<id>_* endpoint carries CHANNEL(musicclass)=<class>  [SOFT]
# Exits 0 when all HARD probes pass. SOFT probes (3, 5) emit `[WARN]`
# instead of `[FAIL]` because PJSIP `[endpoint](+)` append is
# unreliable on this VitalPBX build; caller-leg MOH coverage is the
# canary outbound trunk wrapper (`--enable-trk-wrapper=33`), not PJSIP
# append. Hard rule: never writes a file, never reloads asterisk. The
# only allowed asterisk CLI verbs in here are read-only "show"/"get".
do_health_check() {
  local fail=0
  local warns=0
  local checks=0
  local sample_tid="" sample_class="" sample_ep=""
  local out tenant_map_raw tenant_ids_list ep_count

  printf '\n[CHECK] Connect tenant MOH enforcement health check\n'
  printf '====================================================\n'

  # 1. dialplan include file present
  checks=$((checks + 1))
  if [[ -f "$DIALPLAN_FILE" ]]; then
    printf '[PASS] dialplan include present: %s\n' "$DIALPLAN_FILE"
  else
    printf '[FAIL] dialplan include missing: %s\n' "$DIALPLAN_FILE"
    fail=$((fail + 1))
  fi

  # 2. resolver + global hook + shim contexts loaded
  for pair in \
    "sub-connect-tenant-moh|Connect tenant MOH resolver" \
    "global-before-bridging-call-hook|Connect global before-bridging hook" \
    "connect-tenant-moh-connect-shim|Connect tenant MOH connect-leg shim"; do
    local ctx="${pair%%|*}"
    local sentinel="${pair#*|}"
    checks=$((checks + 1))
    out="$(asterisk -rx "dialplan show $ctx" 2>&1 || true)"
    if echo "$out" | grep -q "$sentinel"; then
      printf '[PASS] dialplan context [%s] loaded\n' "$ctx"
    else
      printf '[FAIL] dialplan context [%s] not loaded\n' "$ctx"
      fail=$((fail + 1))
    fi
  done

  # 3. PJSIP include file present (SOFT — deprecated on this build).
  # PJSIP `[endpoint](+)` append does not reliably set CHANNEL(musicclass)
  # on this VitalPBX build, so the installer's install-mode rolls back
  # this file on verification failure. A missing PJSIP include is therefore
  # treated as an informational warning, NOT a failure: caller-leg coverage
  # for the canary tenant/trunk is supplied by the trunk wrapper.
  checks=$((checks + 1))
  if [[ -f "$PJSIP_FILE" ]]; then
    printf '[PASS] PJSIP include present: %s\n' "$PJSIP_FILE"
  else
    printf '[WARN] PJSIP caller-leg append not installed; deprecated/unsupported on this build: %s\n' "$PJSIP_FILE"
    printf '       Caller-leg MOH on this build is delivered by the canary trunk wrapper (--enable-trk-wrapper=33).\n'
    warns=$((warns + 1))
  fi

  # 4. AstDB reverse-map has at least one tenant
  checks=$((checks + 1))
  tenant_map_raw="$(asterisk -rx 'database show connect/pbx_tenant_map' 2>/dev/null || true)"
  tenant_ids_list="$(printf '%s\n' "$tenant_map_raw" \
    | awk -F'/' '/^\/connect\/pbx_tenant_map\//{print $4}' \
    | grep -E '^[0-9]+$' \
    | sort -un \
    || true)"
  if [[ -n "$tenant_ids_list" ]]; then
    local tenant_count
    tenant_count="$(printf '%s\n' "$tenant_ids_list" | wc -l | tr -d ' ')"
    printf '[PASS] AstDB reverse-map has %s tenant(s): %s\n' \
      "$tenant_count" "$(printf '%s ' $tenant_ids_list)"
    sample_tid="$(printf '%s\n' "$tenant_ids_list" | head -n1)"
  else
    printf '[FAIL] AstDB reverse-map has no tenants — Connect MOH publish has not run yet\n'
    fail=$((fail + 1))
  fi

  # 5. sample T<id>_* endpoint carries CHANNEL(musicclass)=<class>
  checks=$((checks + 1))
  if [[ -n "$sample_tid" ]]; then
    sample_class="$(asterisk -rx "database get connect/pbx_tenant_map/${sample_tid} moh_class" 2>/dev/null \
      | awk -F': ' '/^Value:/{print $2}' | tr -d '[:space:]' || true)"
    local endpoints_raw
    endpoints_raw="$(asterisk -rx 'pjsip show endpoints' 2>/dev/null || true)"
    sample_ep="$(printf '%s\n' "$endpoints_raw" \
      | awk '/^[[:space:]]*Endpoint:[[:space:]]/ {n=$2; sub("/.*", "", n); print n}' \
      | grep -E "^T${sample_tid}_[A-Za-z0-9._-]+$" \
      | sort -u \
      | head -n1 \
      || true)"
    if [[ -n "$sample_ep" && -n "$sample_class" ]]; then
      local ep_show
      ep_show="$(asterisk -rx "pjsip show endpoint $sample_ep" 2>&1 || true)"
      if echo "$ep_show" | grep -Eiq "set_var[[:space:]]*[:=].*CHANNEL\(musicclass\)=${sample_class}|musicclass[[:space:]]*[:=].*${sample_class}"; then
        printf '[PASS] sample endpoint %s carries CHANNEL(musicclass)=%s\n' "$sample_ep" "$sample_class"
      else
        # SOFT — see note on probe 3. PJSIP append is unreliable on this build.
        printf '[WARN] sample endpoint %s missing CHANNEL(musicclass)=%s — PJSIP append unreliable on this build\n' \
          "$sample_ep" "$sample_class"
        printf '       Caller-leg MOH for trunk 33 / tenant T3 is delivered by the canary trunk wrapper (--enable-trk-wrapper=33).\n'
        warns=$((warns + 1))
      fi
    else
      printf '[WARN] could not pick a sample endpoint to probe (tid=%s class=%s ep=%s) — PJSIP append unreliable on this build\n' \
        "$sample_tid" "$sample_class" "$sample_ep"
      warns=$((warns + 1))
    fi
  else
    printf '[SKIP] sample endpoint check (no tenants in reverse-map)\n'
  fi

  # Canary trk-33 wrapper checks (additive — only contribute failures when
  # the wrapper file is actually present; absent file is reported [INFO]).
  local wrapper_fail=0
  trk_wrapper_check || wrapper_fail=$?
  if [[ -f "$TRK_WRAPPER_FILE" ]]; then
    # Each wrapper sub-check we want counted in the totals.
    checks=$((checks + 2))
    fail=$((fail + wrapper_fail))
  fi

  printf '\n====================================================\n'
  if [[ $fail -eq 0 ]]; then
    if [[ $warns -gt 0 ]]; then
      printf 'RESULT: PASS (%s checks healthy; %s deprecated-PJSIP warning(s))\n' "$checks" "$warns"
      printf 'Note: PJSIP `[endpoint](+)` append is unreliable on this VitalPBX build.\n'
      printf '      Caller-leg MOH coverage for trunk 33 / tenant T3 is provided by the canary\n'
      printf '      trunk wrapper (--enable-trk-wrapper=33). The dialplan + AstDB layers above\n'
      printf '      are healthy and trunk/called-leg MOH on hold is unaffected.\n'
    else
      printf 'RESULT: PASS (%s/%s checks healthy)\n' "$checks" "$checks"
    fi
    return 0
  else
    printf 'RESULT: FAIL (%s/%s checks failed; %s warning(s))\n' "$fail" "$checks" "$warns"
    printf 'Hint: re-run Connect MOH publish then "%s" (no flag) to reinstall.\n' "$0"
    return 1
  fi
}

# ── Rollback mode (Connect-owned only) ──────────────────────────────────────
# Removes ONLY Connect-authored MOH enforcement files and the sentinel
# #include line in extensions__60_custom.conf, then reloads dialplan +
# pjsip. Never edits any VitalPBX-generated file. Idempotent — running it
# twice is safe; running it on a host where enforcement was never installed
# is also safe.
do_rollback() {
  local removed=0 skipped=0
  local custom_rollback_backup=""

  printf '\n[ROLLBACK] Connect tenant MOH enforcement uninstall\n'
  printf '====================================================\n'

  if [[ -f "$DIALPLAN_FILE" ]]; then
    rm -f "$DIALPLAN_FILE"
    printf '[REMOVE] %s\n' "$DIALPLAN_FILE"
    removed=$((removed + 1))
  else
    printf '[SKIP]   %s already absent\n' "$DIALPLAN_FILE"
    skipped=$((skipped + 1))
  fi

  if [[ -f "$PJSIP_FILE" ]]; then
    rm -f "$PJSIP_FILE"
    printf '[REMOVE] %s\n' "$PJSIP_FILE"
    removed=$((removed + 1))
  else
    printf '[SKIP]   %s already absent\n' "$PJSIP_FILE"
    skipped=$((skipped + 1))
  fi

  # Sentinel #include line in extensions__60_custom.conf — Connect-owned, but
  # the file as a whole is shared with other Connect customizations, so we
  # only strip our exact line. Always back up before mutating.
  if [[ -f "$CUSTOM_FILE" ]] && grep -Fxq "$INCLUDE_LINE" "$CUSTOM_FILE"; then
    custom_rollback_backup="${CUSTOM_FILE}.bak.connect-rollback.$(date +%Y%m%d-%H%M%S)"
    cp -a "$CUSTOM_FILE" "$custom_rollback_backup"
    sed -i '/^#include extensions__65_connect_tenant_moh\.conf$/d' "$CUSTOM_FILE"
    printf '[REMOVE] sentinel include from %s (backup: %s)\n' \
      "$CUSTOM_FILE" "$custom_rollback_backup"
    removed=$((removed + 1))
  else
    printf '[SKIP]   no sentinel include in %s\n' "$CUSTOM_FILE"
    skipped=$((skipped + 1))
  fi

  # Canary trk-33 wrapper — remove the Connect-owned include if present.
  # Connect-owned only; never touches /etc/asterisk/vitalpbx/.
  if [[ -f "$TRK_WRAPPER_FILE" ]]; then
    trk_wrapper_rollback
    removed=$((removed + 1))
  else
    printf '[SKIP]   %s already absent\n' "$TRK_WRAPPER_FILE"
    skipped=$((skipped + 1))
  fi

  asterisk -rx "dialplan reload" >/dev/null 2>&1 || true
  printf '[RELOAD] asterisk -rx "dialplan reload"\n'
  pjsip_reload >/dev/null 2>&1 || true
  printf '[RELOAD] asterisk -rx "module reload res_pjsip.so" (via pjsip_reload)\n'

  # Best-effort verification: contexts should no longer be loaded. Asterisk
  # may keep a context cached in memory until the affected source file is
  # actually unread (rare on `dialplan reload`); warn rather than fail so
  # the operator knows to investigate without the script appearing to fail.
  local resolver_after
  resolver_after="$(asterisk -rx 'dialplan show sub-connect-tenant-moh' 2>&1 || true)"
  if echo "$resolver_after" | grep -q "Connect tenant MOH resolver"; then
    printf '[WARN]   [sub-connect-tenant-moh] still loaded after reload — investigate manually.\n'
  else
    printf '[OK]     [sub-connect-tenant-moh] no longer loaded\n'
  fi

  printf '\n====================================================\n'
  printf 'RESULT: rollback complete (%s removed, %s already absent)\n' "$removed" "$skipped"
  printf 'PBX behavior is now byte-identical to pre-install for the MOH enforcement layer.\n'
  printf 'Reverse-map AstDB keys (connect/pbx_tenant_map/*) are inert without the resolver;\n'
  printf 'clear with `asterisk -rx "database deltree connect/pbx_tenant_map"` if desired.\n'
  return 0
}

# ── Canary trk-33 wrapper helpers ──────────────────────────────────────────
# Verify the four proven invariants of generated [trk-33-dial]:
#   - exact pattern '_[-+*#0-9a-zA-Z].' present (shape we shadow)
#   - priority 21 still sets CHANNEL(musicclass)=default
#   - priority 22 still sets __TRUNK_MOH_SET=yes
#   - priority 44 still invokes U(sub-before-bridging-call^${TENANT}^...)
# If $strict=1 (default), also require head-80 SHA256 to match the captured
# baseline. The strict form is used at pre-install time. Post-install --check
# runs with $strict=0 because the merged dialplan dump legitimately differs
# once our wrapper is loaded (priority-1 shadow + extra NoOps), but the
# generated priorities 21/22/44 must still be present in the dump.
trk_wrapper_verify_invariants() {
  local strict="${1:-1}"
  local ctx="trk-${TRK_WRAPPER_TARGET_TRUNK}-dial"
  local dump pri21 pri44 actual_sha rc=0

  dump="$(asterisk -rx "dialplan show ${ctx}" 2>&1 || true)"

  if ! printf '%s\n' "$dump" | grep -F "'${TRK_WRAPPER_PATTERN}'" >/dev/null; then
    printf 'INVARIANT-FAIL: generated pattern %q not found in [%s]\n' \
      "$TRK_WRAPPER_PATTERN" "$ctx" >&2
    rc=1
  fi

  pri21="$(printf '%s\n' "$dump" | awk '/[[:space:]]21\./{print; exit}')"
  if ! printf '%s' "$pri21" | grep -q 'CHANNEL(musicclass)=default'; then
    printf 'INVARIANT-FAIL: priority 21 missing CHANNEL(musicclass)=default. Got: %s\n' \
      "${pri21:-<empty>}" >&2
    rc=1
  fi

  if ! printf '%s\n' "$dump" | awk '/[[:space:]]22\./{print; exit}' \
       | grep -q '__TRUNK_MOH_SET=yes'; then
    printf 'INVARIANT-FAIL: priority 22 missing __TRUNK_MOH_SET=yes\n' >&2
    rc=1
  fi

  pri44="$(printf '%s\n' "$dump" | awk '/[[:space:]]44\./{print; exit}')"
  if ! printf '%s' "$pri44" | grep -q 'U(sub-before-bridging-call\^\${TENANT}'; then
    printf 'INVARIANT-FAIL: priority 44 missing U(sub-before-bridging-call^${TENANT}^...). Got: %s\n' \
      "${pri44:-<empty>}" >&2
    rc=1
  fi

  if [[ "$strict" = "1" ]]; then
    actual_sha="$(printf '%s\n' "$dump" | head -80 | sha256sum | awk '{print $1}')"
    if [[ "$actual_sha" != "$TRK_WRAPPER_BASELINE_SHA256" ]]; then
      printf 'INVARIANT-FAIL: trk-%s-dial baseline drift\n  expected: %s\n  actual:   %s\n' \
        "$TRK_WRAPPER_TARGET_TRUNK" "$TRK_WRAPPER_BASELINE_SHA256" "$actual_sha" >&2
      rc=1
    fi
  fi

  return $rc
}

trk_wrapper_restore_backup() {
  warn "Restoring trk-${TRK_WRAPPER_TARGET_TRUNK} wrapper backup: $TRK_WRAPPER_BACKUP_FILE"
  if [[ -s "$TRK_WRAPPER_BACKUP_FILE" ]]; then
    cp -a "$TRK_WRAPPER_BACKUP_FILE" "$TRK_WRAPPER_FILE"
  else
    rm -f "$TRK_WRAPPER_FILE"
  fi
  asterisk -rx 'dialplan reload' >/dev/null 2>&1 || true
}

trk_wrapper_install() {
  step "[trk-wrapper] Install canary outbound caller-leg MOH wrapper (trunk ${TRK_WRAPPER_TARGET_TRUNK} / tenant T${TRK_WRAPPER_TARGET_TENANT})"

  step "[trk-wrapper 1/5] Verify generated [trk-${TRK_WRAPPER_TARGET_TRUNK}-dial] invariants + baseline drift"
  if ! trk_wrapper_verify_invariants 1; then
    die "Refusing to install canary wrapper: generated dialplan invariants or baseline differ. Investigate before retrying."
  fi
  echo "  ↳ OK — pattern, priorities 21/22/44, baseline SHA all match"

  step "[trk-wrapper 2/5] Snapshot existing wrapper (if any)"
  if [[ -f "$TRK_WRAPPER_FILE" ]]; then
    cp -a "$TRK_WRAPPER_FILE" "$TRK_WRAPPER_BACKUP_FILE"
    echo "  ↳ backed up to $TRK_WRAPPER_BACKUP_FILE"
  else
    : > "$TRK_WRAPPER_BACKUP_FILE"
    echo "  ↳ no prior wrapper — fresh install"
  fi

  step "[trk-wrapper 3/5] Write wrapper include"
  cat > "$TRK_WRAPPER_TMP_NEW" <<'CONNECT_TRK33_WRAPPER_EOF'
; ============================================================================
; Connect canary outbound caller-leg MOH wrapper
; (Auto-installed by scripts/pbx/install-connect-tenant-moh-dialplan.sh
;  with --enable-trk-wrapper=33 — DO NOT HAND-EDIT.)
;
; Scope (HARD-CODED, canary):
;   - trunk 33 only          (context [trk-33-dial])
;   - tenant T3 only         (TENANT == "T3" gate at priority 2)
;   - any other tenant       -> immediate Goto into generated priority 2
;
; Mechanism: same-context, same-pattern shadow of the generated priority 1.
; The shadow pattern is the EXACT generated form '_[-+*#0-9a-zA-Z].' — we do
; NOT introduce a broader or narrower pattern (no `_X.`, no F1 specific-shadow).
; The wrapper resolves the tenant's MOH class from AstDB, sets
; CHANNEL(musicclass) + __TRUNK_MOH_SET=yes (so generated priority 21 sees
; the gate already tripped), then Gotos generated priority 2. Priorities
; 2..end of the generated chain run byte-for-byte unchanged.
;
; Read-only consumer of these AstDB keys (published by Connect API on every
; MOH publish/rollback — see apps/api/src/server.ts publishMohToAstDb):
;   connect/pbx_tenant_map/3/slug
;   connect/t_<slug>/moh_class            (primary)
;   connect/t_<slug>/active_moh_class     (fallback)
;
; Fail-safe: any missing key, non-T3 tenant, or empty class -> straight
; Goto into priority 2. NEVER hangs up, redirects, alters CDR/recording.
; ============================================================================

[trk-33-dial]
exten => _[-+*#0-9a-zA-Z].,1,NoOp(connect-trk33-wrapper enter exten=${EXTEN} tenant=${TENANT})
 same => n,GotoIf($["${TENANT}" != "T3"]?passthrough)
 same => n,Set(SLUG_LOCAL=${DB(connect/pbx_tenant_map/3/slug)})
 same => n,GotoIf($["${SLUG_LOCAL}" = ""]?passthrough)
 same => n,Set(CLS_LOCAL=${DB(connect/t_${SLUG_LOCAL}/moh_class)})
 same => n,ExecIf($["${CLS_LOCAL}" = ""]?Set(CLS_LOCAL=${DB(connect/t_${SLUG_LOCAL}/active_moh_class)}))
 same => n,GotoIf($["${CLS_LOCAL}" = ""]?passthrough)
 same => n,Set(CHANNEL(musicclass)=${CLS_LOCAL})
 same => n,Set(__TRUNK_MOH_SET=yes)
 same => n,NoOp(connect-trk33-wrapper applied tenant=T3 class=${CLS_LOCAL})
 same => n,Goto(trk-33-dial,${EXTEN},2)
 same => n(passthrough),NoOp(connect-trk33-wrapper passthrough tenant=${TENANT})
 same => n,Goto(trk-33-dial,${EXTEN},2)
CONNECT_TRK33_WRAPPER_EOF
  mv "$TRK_WRAPPER_TMP_NEW" "$TRK_WRAPPER_FILE"
  chown asterisk:asterisk "$TRK_WRAPPER_FILE"
  chmod 0644 "$TRK_WRAPPER_FILE"
  echo "  ↳ wrote $TRK_WRAPPER_FILE ($(wc -l < "$TRK_WRAPPER_FILE" | tr -d ' ') lines)"

  step "[trk-wrapper 4/5] Reload dialplan"
  local reload_out
  reload_out="$(asterisk -rx 'dialplan reload' 2>&1 || true)"
  echo "  ↳ $reload_out"

  step "[trk-wrapper 5/5] Verify wrapper loaded + invariants preserved"
  local show_out
  show_out="$(asterisk -rx "dialplan show trk-${TRK_WRAPPER_TARGET_TRUNK}-dial" 2>&1 || true)"
  if ! printf '%s\n' "$show_out" | grep -q 'connect-trk33-wrapper enter'; then
    trk_wrapper_restore_backup
    die "Wrapper sentinel NoOp not found after dialplan reload. Backup restored."
  fi
  # Post-install invariant check: strict=0 because the merged dialplan dump
  # legitimately differs once our wrapper is loaded. We only require that
  # the generated priorities 21/22/44 and pattern are still present.
  if ! trk_wrapper_verify_invariants 0; then
    trk_wrapper_restore_backup
    die "Generated dialplan invariants no longer match after wrapper load. Backup restored."
  fi
  echo "  ↳ OK — wrapper sentinel loaded; generated invariants preserved"
}

trk_wrapper_check() {
  local fail=0
  printf '\n[CHECK] Canary outbound caller-leg MOH wrapper (trunk %s / tenant T%s)\n' \
    "$TRK_WRAPPER_TARGET_TRUNK" "$TRK_WRAPPER_TARGET_TENANT"
  if [[ ! -f "$TRK_WRAPPER_FILE" ]]; then
    printf '[INFO] wrapper include absent — canary disabled: %s\n' "$TRK_WRAPPER_FILE"
    return 0
  fi
  printf '[PASS] wrapper include present: %s\n' "$TRK_WRAPPER_FILE"

  if trk_wrapper_verify_invariants 0 2>/dev/null; then
    printf '[PASS] generated [trk-%s-dial] invariants present (pattern + pri 21/22/44)\n' \
      "$TRK_WRAPPER_TARGET_TRUNK"
  else
    printf '[FAIL] generated [trk-%s-dial] invariants broken — re-run with diagnostic detail:\n' \
      "$TRK_WRAPPER_TARGET_TRUNK"
    trk_wrapper_verify_invariants 0 || true
    fail=$((fail + 1))
  fi

  local show_out
  show_out="$(asterisk -rx "dialplan show trk-${TRK_WRAPPER_TARGET_TRUNK}-dial" 2>&1 || true)"
  if printf '%s\n' "$show_out" | grep -q 'connect-trk33-wrapper enter'; then
    printf '[PASS] wrapper sentinel loaded in [trk-%s-dial]\n' "$TRK_WRAPPER_TARGET_TRUNK"
  else
    printf '[FAIL] wrapper sentinel not loaded in [trk-%s-dial]\n' "$TRK_WRAPPER_TARGET_TRUNK"
    fail=$((fail + 1))
  fi

  return $fail
}

trk_wrapper_rollback() {
  if [[ ! -f "$TRK_WRAPPER_FILE" ]]; then
    printf '[SKIP]   %s already absent\n' "$TRK_WRAPPER_FILE"
    return 0
  fi
  rm -f "$TRK_WRAPPER_FILE"
  printf '[REMOVE] %s\n' "$TRK_WRAPPER_FILE"
  return 0
}

# ── Mode dispatch ──────────────────────────────────────────────────────────
# install mode falls through to the existing step-by-step body below.
case "$MODE" in
  check)
    do_health_check
    exit $?
    ;;
  rollback)
    do_rollback
    exit $?
    ;;
  install)
    : # fall through
    ;;
esac

# ── 2. Snapshot existing include (if any) ───────────────────────────────────
step "[1/8] Snapshot any existing include"
if [[ -f "$DIALPLAN_FILE" ]]; then
  cp -a "$DIALPLAN_FILE" "$BACKUP_FILE"
  echo "  ↳ backed up to $BACKUP_FILE"
else
  echo "  ↳ no existing $DIALPLAN_FILE — fresh install"
  : > "$BACKUP_FILE"
fi

# ── 3. Write new include ────────────────────────────────────────────────────
# Heredoc literal — no shell interpolation, no per-tenant data baked in.
step "[2/8] Write Connect tenant MOH dialplan include"
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
step "[3/8] Discover Connect-known tenants from AstDB and generate per-tenant connect-leg hooks"
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
step "[4/8] Install include + set permissions"
mv "$TMP_NEW" "$DIALPLAN_FILE"
chown asterisk:asterisk "$DIALPLAN_FILE"
chmod 0644 "$DIALPLAN_FILE"
echo "  ↳ wrote $DIALPLAN_FILE ($(wc -l < "$DIALPLAN_FILE" | tr -d ' ') lines, $PER_TENANT_COUNT per-tenant connect-leg stanzas)"

# ── 5. Reload Asterisk dialplan ────────────────────────────────────────────
step "[5/8] Reload Asterisk dialplan"
RELOAD_OUT="$(asterisk -rx 'dialplan reload' 2>&1 || true)"
echo "  ↳ $RELOAD_OUT"

# ── 6. Verify all required contexts loaded; bridge through __60_custom if needed ────
step "[6/8] Verify [sub-connect-tenant-moh] + [global-before-bridging-call-hook] + [connect-tenant-moh-connect-shim] are loaded"
if verify_contexts_loaded; then
  print_context_verification
else
  print_context_verification
  warn "The new include file was written, but Asterisk did not load it directly."
  warn "This VitalPBX install likely does not wildcard-include extensions__*.conf."
  [[ -f "$CUSTOM_FILE" ]] || restore_backups_and_die "$CUSTOM_FILE is missing; cannot bridge include safely."

  step "[6b/8] Bridge new include through already-loaded Connect custom dialplan"
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

# ── 7. PJSIP caller-leg musicclass append ──────────────────────────────────
# Why this exists: on this VitalPBX build, [sub-before-connecting-call] is
# NOT invoked from the per-trunk caller dial path (verified 2026-05-10 —
# trk-33-dial only contains a Dial(... U(...)) line that fires the
# called-leg hook), so the dialplan-side connect-leg shim is unreachable
# for outbound calls. Cover the caller leg by setting
# CHANNEL(musicclass) at PJSIP channel-creation time via `set_var` on
# each Connect-known tenant's `T<id>_*` extension endpoint, using the
# `[name](+)` append syntax so we never re-declare the endpoint and never
# touch any VitalPBX-generated pjsip__*.conf file.
#
# Trunk endpoints are intentionally NOT touched here. The trunk leg is
# already covered by the dialplan-side called-leg U-flag hook above.
step "[7/8] Build + install PJSIP caller-leg musicclass append, reload PJSIP, verify"

PJSIP_PER_TENANT_COUNT=0
PJSIP_TOTAL_ENDPOINT_COUNT=0
PJSIP_SAMPLE_ENDPOINT=""
PJSIP_SAMPLE_CLASS=""

if [[ -z "$TENANT_IDS" ]]; then
  warn "No tenants in connect/pbx_tenant_map AstDB family — skipping PJSIP caller-leg append."
  warn "Caller-leg MOH coverage will be missing for outbound holds until Connect publishes"
  warn "MOH at least once and this installer is re-run."
else
  if [[ -f "$PJSIP_FILE" ]]; then
    cp -a "$PJSIP_FILE" "$PJSIP_BACKUP_FILE"
    echo "  ↳ backed up existing $PJSIP_FILE to $PJSIP_BACKUP_FILE"
  else
    : > "$PJSIP_BACKUP_FILE"
  fi

  {
    echo "; ============================================================================"
    echo "; Connect tenant MOH — PJSIP caller-leg musicclass append"
    echo "; (Auto-installed by scripts/pbx/install-connect-tenant-moh-dialplan.sh —"
    echo ";  DO NOT HAND-EDIT THIS FILE. Re-run the installer to refresh.)"
    echo ";"
    echo "; Each section below uses Asterisk's [name](+) append syntax to add a single"
    echo "; set_var line to a VitalPBX-generated PJSIP extension endpoint. set_var fires"
    echo "; via pbx_builtin_setvar_helper at channel-creation time and accepts the"
    echo "; CHANNEL(musicclass) function-call syntax, so the caller leg has the right"
    echo "; musicclass before any dialplan runs."
    echo ";"
    echo "; Tenant scope: only T<id>_* extension endpoints for tenants present in the"
    echo "; connect/pbx_tenant_map AstDB family at install time. Trunk endpoints are"
    echo "; never touched — the trunk leg is covered by the dialplan-side U-flag hook."
    echo "; ============================================================================"
    echo ""
  } > "$PJSIP_TMP_NEW"

  for tid in $TENANT_IDS; do
    SLUG="$(asterisk -rx "database get connect/pbx_tenant_map/${tid} slug" 2>/dev/null \
      | awk -F': ' '/^Value:/{print $2}' | tr -d '[:space:]' || true)"
    CLASS="$(asterisk -rx "database get connect/pbx_tenant_map/${tid} moh_class" 2>/dev/null \
      | awk -F': ' '/^Value:/{print $2}' | tr -d '[:space:]' || true)"

    if [[ -z "$CLASS" ]] || [[ "$CLASS" != "${CLASS//[^A-Za-z0-9_-]/}" ]]; then
      warn "Tenant T${tid}: missing or non-printable connect/pbx_tenant_map/${tid}/moh_class — skipping."
      SKIPPED_TENANTS+=("T${tid}: missing or non-printable moh_class in connect/pbx_tenant_map/${tid}")
      continue
    fi

    # `pjsip show endpoints` lines start with leading whitespace, e.g.
    #   "  Endpoint:  T3_302/T3_302                       Not in use    0 of inf"
    # Some builds emit "<endpoint>/<auth>" in field 2 — strip everything from
    # the first slash onward to get the bare endpoint name.
    ENDPOINTS_RAW="$(asterisk -rx 'pjsip show endpoints' 2>/dev/null || true)"
    ENDPOINTS="$(printf '%s\n' "$ENDPOINTS_RAW" \
      | awk '/^[[:space:]]*Endpoint:[[:space:]]/ {n=$2; sub("/.*", "", n); print n}' \
      | grep -E "^T${tid}_[A-Za-z0-9._-]+$" \
      | sort -u \
      || true)"

    if [[ -z "$ENDPOINTS" ]]; then
      warn "Tenant T${tid}: no PJSIP endpoints matched ^T${tid}_ — skipping (slug=${SLUG} class=${CLASS})."
      SKIPPED_TENANTS+=("T${tid}: no PJSIP endpoints matched ^T${tid}_ (slug=${SLUG} class=${CLASS})")
      continue
    fi

    EP_COUNT="$(printf '%s\n' "$ENDPOINTS" | wc -l | tr -d ' ')"
    PJSIP_PER_TENANT_COUNT=$((PJSIP_PER_TENANT_COUNT + 1))
    PJSIP_TOTAL_ENDPOINT_COUNT=$((PJSIP_TOTAL_ENDPOINT_COUNT + EP_COUNT))
    echo "  ↳ T${tid} (slug=${SLUG} class=${CLASS}): appending set_var to ${EP_COUNT} endpoint(s)"

    {
      echo "; --- T${tid} (slug=${SLUG}, class=${CLASS}) -------------------------------"
      while IFS= read -r ep; do
        [[ -z "$ep" ]] && continue
        echo "[${ep}](+)"
        echo "set_var = CHANNEL(musicclass)=${CLASS}"
        echo ""
      done <<< "$ENDPOINTS"
    } >> "$PJSIP_TMP_NEW"

    if [[ -z "$PJSIP_SAMPLE_ENDPOINT" ]]; then
      PJSIP_SAMPLE_ENDPOINT="$(printf '%s\n' "$ENDPOINTS" | head -n1)"
      PJSIP_SAMPLE_CLASS="$CLASS"
    fi
  done

  if [[ $PJSIP_TOTAL_ENDPOINT_COUNT -eq 0 ]]; then
    warn "No PJSIP T<id>_* extension endpoints matched any Connect-known tenant — skipping PJSIP install."
    rm -f "$PJSIP_TMP_NEW"
  else
    mv "$PJSIP_TMP_NEW" "$PJSIP_FILE"
    chown asterisk:asterisk "$PJSIP_FILE"
    chmod 0644 "$PJSIP_FILE"
    echo "  ↳ wrote $PJSIP_FILE ($(wc -l < "$PJSIP_FILE" | tr -d ' ') lines, ${PJSIP_PER_TENANT_COUNT} tenant(s), ${PJSIP_TOTAL_ENDPOINT_COUNT} endpoint append(s))"

    # Use pjsip_reload(): some builds ship `pjsip reload` and some only
    # `module reload res_pjsip.so`. The helper picks the working one and
    # returns the asterisk CLI output verbatim so the operator log shows
    # exactly which form succeeded.
    PJSIP_RELOAD_OUT="$(pjsip_reload)"
    echo "  ↳ pjsip reload: $PJSIP_RELOAD_OUT"

    SAMPLE_ENDPOINT_OUT="$(asterisk -rx "pjsip show endpoint ${PJSIP_SAMPLE_ENDPOINT}" 2>&1 || true)"
    SAMPLE_HAS_MUSICCLASS=0
    if echo "$SAMPLE_ENDPOINT_OUT" | grep -Eiq "set_var[[:space:]]*[:=].*CHANNEL\(musicclass\)=${PJSIP_SAMPLE_CLASS}"; then
      SAMPLE_HAS_MUSICCLASS=1
    elif echo "$SAMPLE_ENDPOINT_OUT" | grep -Eiq "musicclass[[:space:]]*[:=].*${PJSIP_SAMPLE_CLASS}"; then
      SAMPLE_HAS_MUSICCLASS=1
    fi

    if [[ $SAMPLE_HAS_MUSICCLASS -eq 1 ]]; then
      echo "  ↳ OK — PJSIP endpoint ${PJSIP_SAMPLE_ENDPOINT} carries CHANNEL(musicclass)=${PJSIP_SAMPLE_CLASS}"
    else
      warn "Sample endpoint ${PJSIP_SAMPLE_ENDPOINT} did not show set_var/musicclass=${PJSIP_SAMPLE_CLASS} after pjsip reload."
      echo "$SAMPLE_ENDPOINT_OUT" | head -40
      rollback_pjsip_and_warn "PJSIP caller-leg musicclass verification failed for ${PJSIP_SAMPLE_ENDPOINT}."
      PJSIP_PER_TENANT_COUNT=0
      PJSIP_TOTAL_ENDPOINT_COUNT=0
    fi
  fi
fi

# ── 8. AstDB smoke output ───────────────────────────────────────────────────
step "[8/8] AstDB reverse-tenant-map smoke output"
echo "  ↳ connect/pbx_tenant_map family (populated by Connect MOH publish + rollback):"
asterisk -rx 'database show connect/pbx_tenant_map' 2>&1 | sed 's/^/      /' \
  || echo "      (no reverse-tenant-map keys yet — run a MOH publish from Connect to populate)"

# Skipped-tenant rollup. Each loop above appends a single line per tenant it
# could not cover with full reasoning (missing/non-printable moh_class,
# no T<id>_* PJSIP endpoints, etc.). Reporting in one place at the end is
# easier to scan than digging back through the per-loop WARN: lines.
SKIPPED_COUNT="${#SKIPPED_TENANTS[@]}"
if [[ $SKIPPED_COUNT -gt 0 ]]; then
  printf '\n[%s] Skipped tenants this run (%s):\n' "$(date +%H:%M:%S)" "$SKIPPED_COUNT"
  for s in "${SKIPPED_TENANTS[@]}"; do
    printf '  - %s\n' "$s"
  done
  printf '  Hint: re-run Connect MOH publish for these tenants, then re-run this installer.\n'
fi

# ── 9. Optional canary trk-33 wrapper (additive, off by default) ───────────
# Only runs when the operator passes --enable-trk-wrapper=33. Self-contained:
# verifies generated [trk-33-dial] invariants + baseline SHA, writes one
# Connect-owned include, reloads dialplan, verifies the wrapper loaded and
# generated invariants are still preserved, restores backup + dies on any
# failure. No effect on any other tenant or trunk.
if [[ "$ENABLE_TRK_WRAPPER" = "33" ]]; then
  trk_wrapper_install
else
  step "[trk-wrapper] Skipped (no --enable-trk-wrapper=33 flag)"
fi

cat <<DONE

============================================================================
INSTALL COMPLETE.

Backup of previous dialplan include: $BACKUP_FILE
Backup of Connect custom dialplan (only if bridged): ${CUSTOM_BACKUP_FILE:-not-created}
Backup of previous PJSIP include: ${PJSIP_BACKUP_FILE:-not-created}
Per-tenant connect-leg dialplan hooks generated this run: ${PER_TENANT_COUNT:-0}
PJSIP caller-leg appends installed this run: ${PJSIP_TOTAL_ENDPOINT_COUNT:-0} endpoint(s) across ${PJSIP_PER_TENANT_COUNT:-0} tenant(s)
Tenants skipped (and why): ${SKIPPED_COUNT} (see "Skipped tenants this run" block above)

Wired in via:

  • [sub-before-bridging-call]   — Gosubs [global-before-bridging-call-hook]
                                   on the **called/trunk leg** (Dial U-flag).
  • [sub-before-connecting-call] — GosubIfs into
                                   [T<id>_before-connecting-call-hook]
                                   on the **caller/originating leg** when
                                   the build invokes it (some VitalPBX
                                   builds skip this for outbound trunk dials).
  • PJSIP set_var on T<id>_*     — sets CHANNEL(musicclass) at channel-
    extension endpoints           creation time on the **caller/originating
                                   leg** even when the connect-leg dialplan
                                   hook is unreachable.

The dialplan wrappers Gosub into the shared [sub-connect-tenant-moh] resolver
to set CHANNEL(musicclass) on the called/trunk leg. The PJSIP append covers
the caller leg. Both layers must end up agreeing on the same class for the
tenant — this is enforced because both read from the same Connect-published
AstDB / reverse-map values.

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

Health check (read-only, no writes, no reloads):
  sudo $0 --check

Rollback (preferred — Connect-owned files only, idempotent):
  sudo $0 --rollback

Rollback (manual equivalent, instant):
  sed -i '/^#include extensions__65_connect_tenant_moh\.conf$/d' $CUSTOM_FILE
  rm -f $DIALPLAN_FILE
  rm -f $PJSIP_FILE
  asterisk -rx "dialplan reload"
  asterisk -rx "module reload res_pjsip.so"   # NOT 'pjsip reload' — that
                                              # alias is missing on some
                                              # VitalPBX/Asterisk builds
                                              # (verified 2026-05-10).

============================================================================
DONE
