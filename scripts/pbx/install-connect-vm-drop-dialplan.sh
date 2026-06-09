#!/usr/bin/env bash
# ============================================================================
# install-connect-vm-drop-dialplan.sh
#
# Installs the Connect CRM "Voicemail Drop" dialplan plugin on a VitalPBX host.
#
# >>> THIS SCRIPT IS NOT RUN AS PART OF ANY DEPLOY. It is a one-time, manual,
# >>> human-approved PBX change (per AGENTS.md). Cursor agents MUST NOT run it
# >>> against the live PBX. It lives in the repo so the exact dialplan, install
# >>> path, verification, and rollback are reviewable BEFORE anyone installs it.
#
# What this plugin does
# ---------------------
# The CRM Voicemail Drop feature must play a pre-recorded message into the live
# customer (PSTN/trunk) leg of an answered call, release the agent, and hang up.
#
# ARI media playback (POST /ari/channels/{id}/play) is NOT usable on this build:
# Connect's telephony service runs a REST-only ARI client and never registers a
# Stasis application, so GET /ari/applications == [] and live dialplan channels
# are never in Stasis. ARI refuses to play media on a non-Stasis channel (409).
# (Verified live 2026-06-09; see docs/ai-context/TELEPHONY.md § Voicemail Drop.)
#
# The supported, working path on this build is the same one every other Connect
# overlay uses (MOH enforcement, VM-greeting recorder): pure dialplan driven by
# AMI. Connect, over its existing AMI user (connectcommsgefenu, originate/call/
# dialplan perms, permitted from the app host 45.14.194.179):
#
#   1. AMI Setvar  VMDROP_FILE=<base>   on the customer/trunk channel
#        <base> = the System-Recordings basename Connect already pushed to
#        /var/lib/asterisk/sounds/custom/<base>.wav via the route-helper
#        /upload-prompt endpoint (apps/api/src/pbxPromptPushClient.ts).
#        Do NOT include the "custom/" prefix or file extension.
#      (Optionally also Setvar VMDROP_WAIT / VMDROP_STRATEGY — see "Wait
#       strategy" below.)
#   2. AMI Redirect the customer/trunk channel:
#        Channel = <customer leg channel name, e.g. PJSIP/344022_Vaddb-00000a93>
#        Context = connect-vm-drop
#        Exten   = s
#        Priority= 1
#      The Redirect tears down the agent<->customer bridge (frees the agent).
#      Connect ALSO sends an explicit AMI Hangup on the agent leg so the agent
#      softphone UI is released immediately.
#   3. This context Answers (if needed), runs the pluggable wait strategy, plays
#      custom/${VMDROP_FILE}, then hangs up the customer leg. Connect infers
#      "playback complete" from the trunk-leg Hangup AMI event for that linkedid
#      (there is no Stasis PlaybackFinished event on this build).
#
# Install location (the SAFE additive point)
# -------------------------------------------
# Primary: /etc/asterisk/vitalpbx/extensions__96-connect-vm-drop.conf
#   The top-level /etc/asterisk/extensions.conf line 1 is:
#       #include vitalpbx/extensions__*.conf
#   so any vitalpbx/extensions__*.conf is auto-loaded on `dialplan reload`.
#   This is exactly how the existing Connect-owned, route-helper-managed
#   extensions__95-connect-vm-greeting.conf is loaded today. Prefix __96 sits
#   above VitalPBX's generated __20/__50 range and is uniquely named, so
#   VitalPBX config regeneration never clobbers or collides with it.
#
# Fallback (only if the wildcard include is somehow inactive on this host):
#   bridge via one sentinel line appended to the already-loaded Connect overlay
#   /etc/asterisk/extensions__60_custom.conf:
#       #include extensions__96-connect-vm-drop.conf
#   (mirrors install-connect-tenant-moh-dialplan.sh). Backed up before edit.
#
# SAFETY
#   * Adds ONE new context [connect-vm-drop]. Modifies NO existing context,
#     route, IVR, queue, trunk, or PJSIP config. Regression risk to live calls
#     from the dialplan itself is therefore minimal.
#   * Pure dialplan at call time: in-memory only, no HTTP/ARI/CURL.
#   * If VMDROP_FILE is empty or the file is missing on disk, hangs up cleanly
#     instead of playing dead air — Connect records this as a failed drop.
#   * NEVER edits VitalPBX-generated extensions__*.conf / pjsip__*.conf files.
#   * Idempotent. Backs up before writing. Reloads dialplan, verifies the
#     context loaded, restores backup + aborts on verification failure.
#   * Connect MUST refuse the drop (never issue the AMI Redirect) unless it has
#     confirmed this context is installed (`dialplan show connect-vm-drop`).
#     Redirecting a live customer call into a missing context would drop it.
#
# Wait strategy (pluggable — see docs/pbx/connect-voicemail-drop-plugin-design.md)
#   VMDROP_STRATEGY selects the pre-play wait, set per-drop by Connect via AMI
#   Setvar (default "fixed" when unset):
#     fixed       -> Wait(${VMDROP_WAIT})            (default; VMDROP_WAIT=2s)
#     waitsilence -> WaitForSilence(${VMDROP_SILENCE_MS},1,${VMDROP_SILENCE_MAXMS})
#     amd         -> AMD() then branch on ${AMDSTATUS} (app_amd.so is loaded)
#   app_amd.so and app_waitforsilence.so are BOTH loaded on this build (verified
#   in asterisk-cli/modules.txt), so the non-fixed strategies are available for
#   later validation. The default ships as "fixed" (manual: the agent confirms
#   voicemail was reached before clicking Drop). True beep detection (amd/
#   waitsilence) is a separate, individually-validated rollout. Documented limit.
#
# Usage
# -----
#   chmod +x install-connect-vm-drop-dialplan.sh
#   sudo ./install-connect-vm-drop-dialplan.sh                # install (default)
#   sudo ./install-connect-vm-drop-dialplan.sh --check        # read-only health check
#   sudo ./install-connect-vm-drop-dialplan.sh --dry-run      # print actions, write nothing
#   sudo ./install-connect-vm-drop-dialplan.sh --rollback     # uninstall (Connect-owned only)
#        ./install-connect-vm-drop-dialplan.sh --help         # usage
#
# Rollback (manual equivalent of --rollback):
#   sed -i '/^#include extensions__96-connect-vm-drop\.conf$/d' /etc/asterisk/extensions__60_custom.conf
#   rm -f /etc/asterisk/vitalpbx/extensions__96-connect-vm-drop.conf
#   asterisk -rx "dialplan reload"
# ============================================================================

set -euo pipefail

step() { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '\nWARN: %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

CONTEXT_NAME="connect-vm-drop"
DIALPLAN_DIR="/etc/asterisk/vitalpbx"
DIALPLAN_FILE="${DIALPLAN_DIR}/extensions__96-connect-vm-drop.conf"
CUSTOM_FILE="/etc/asterisk/extensions__60_custom.conf"
INCLUDE_LINE="#include extensions__96-connect-vm-drop.conf"
BACKUP_FILE="${DIALPLAN_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
CUSTOM_BACKUP_FILE="${CUSTOM_FILE}.bak.connect-vm-drop.$(date +%Y%m%d-%H%M%S)"
TMP_NEW="/tmp/connect-vm-drop-new.$$.conf"

trap 'rm -f "$TMP_NEW"' EXIT

# ── The dialplan body. Single source of truth; also mirrored (for review only)
#    in docs/pbx/connect-voicemail-drop-context.conf. Heredoc is fully literal —
#    every ${...} below is an Asterisk runtime variable, NOT shell. ────────────
emit_dialplan() {
  cat <<'CONNECT_VM_DROP_EOF'
; ============================================================================
; Connect — CRM Voicemail Drop dialplan plugin
; (Auto-installed by scripts/pbx/install-connect-vm-drop-dialplan.sh —
;  DO NOT HAND-EDIT THIS FILE. Re-run the installer to update.)
;
; Single additive context. Driven entirely by Connect over AMI:
;   Setvar VMDROP_FILE=<basename>   (required; no "custom/" prefix, no extension)
;   Setvar VMDROP_STRATEGY=<fixed|waitsilence|amd>  (optional; default fixed)
;   Setvar VMDROP_WAIT=<seconds>    (optional; default 2; used by "fixed")
;   Redirect <customer-leg-channel> -> connect-vm-drop,s,1
;
; Fail-safe: empty/missing file => clean Hangup (no dead air). Never touches
; any other context, CDR, or recording behavior.
; ============================================================================

[connect-vm-drop]
exten => s,1,NoOp(Connect VM drop file=${VMDROP_FILE} strategy=${VMDROP_STRATEGY} linkedid=${LINKEDID} chan=${CHANNEL(name)})
 ; ── Defaults ────────────────────────────────────────────────────────────────
 same => n,ExecIf($["${VMDROP_STRATEGY}" = ""]?Set(VMDROP_STRATEGY=fixed))
 same => n,ExecIf($["${VMDROP_WAIT}" = ""]?Set(VMDROP_WAIT=2))
 same => n,ExecIf($["${VMDROP_SILENCE_MS}" = ""]?Set(VMDROP_SILENCE_MS=2500))
 same => n,ExecIf($["${VMDROP_SILENCE_MAXMS}" = ""]?Set(VMDROP_SILENCE_MAXMS=12000))
 ; ── Validate file present (no dead air) ──────────────────────────────────────
 same => n,GotoIf($["${VMDROP_FILE}" = ""]?nofile)
 same => n,Set(VMDROP_OK=0)
 same => n,ExecIf($["${STAT(e,/var/lib/asterisk/sounds/custom/${VMDROP_FILE}.wav)}" = "1"]?Set(VMDROP_OK=1))
 same => n,ExecIf($["${STAT(e,/var/lib/asterisk/sounds/custom/${VMDROP_FILE}.ulaw)}" = "1"]?Set(VMDROP_OK=1))
 same => n,ExecIf($["${STAT(e,/var/lib/asterisk/sounds/custom/${VMDROP_FILE}.gsm)}" = "1"]?Set(VMDROP_OK=1))
 same => n,GotoIf($["${VMDROP_OK}" != "1"]?nofile)
 ; ── Ensure media path is up ──────────────────────────────────────────────────
 same => n,ExecIf($["${CHANNEL(state)}" != "Up"]?Answer())
 ; ── Pluggable wait strategy (Choice B: fixed default; amd/waitsilence ready) ──
 same => n,Goto(wait_${VMDROP_STRATEGY},1)
 ; (fall-through guard if an unknown strategy slips through)
 same => n,Goto(play,1)

; --- fixed: deterministic pre-play delay; agent confirmed VM before drop -------
exten => wait_fixed,1,NoOp(Connect VM drop wait=fixed secs=${VMDROP_WAIT})
 same => n,Wait(${VMDROP_WAIT})
 same => n,Goto(play,1)

; --- waitsilence: wait for the greeting to stop, then play (beep-ish) ----------
;     app_waitforsilence.so is loaded on this build. WaitForSilence(silence_ms,
;     iterations, timeout_ms): returns when `silence_ms` of silence is seen or
;     timeout. Followed by a tiny settle wait. Pluggable — not the default.
exten => wait_waitsilence,1,NoOp(Connect VM drop wait=waitsilence ms=${VMDROP_SILENCE_MS} max=${VMDROP_SILENCE_MAXMS})
 same => n,WaitForSilence(${VMDROP_SILENCE_MS},1,${VMDROP_SILENCE_MAXMS})
 same => n,Wait(1)
 same => n,Goto(play,1)

; --- amd: answering-machine detection, then drop on machine/notsure -----------
;     app_amd.so is loaded on this build. AMD() sets ${AMDSTATUS}
;     (MACHINE|HUMAN|NOTSURE|HANGUP). For a voicemail drop we proceed on
;     MACHINE/NOTSURE; on HUMAN we still drop (operator-initiated) but tag it.
;     Pluggable — not the default; requires its own live validation pass.
exten => wait_amd,1,NoOp(Connect VM drop wait=amd)
 same => n,AMD()
 same => n,NoOp(Connect VM drop AMD status=${AMDSTATUS} cause=${AMDCAUSE})
 same => n,ExecIf($["${AMDSTATUS}" = "MACHINE"]?Wait(1))
 same => n,Goto(play,1)

; --- play + end ----------------------------------------------------------------
exten => play,1,NoOp(Connect VM drop playing custom/${VMDROP_FILE})
 same => n,Playback(custom/${VMDROP_FILE})
 same => n,NoOp(Connect VM drop playback complete file=${VMDROP_FILE} linkedid=${LINKEDID})
 same => n,Hangup()

; --- abort: missing/empty file -------------------------------------------------
exten => s,n(nofile),NoOp(Connect VM drop ABORTED missing file '${VMDROP_FILE}')
 same => n,Hangup()
CONNECT_VM_DROP_EOF
}

# ── Mode parsing ────────────────────────────────────────────────────────────
MODE="install"
for arg in "$@"; do
  case "$arg" in
    ""|install)               MODE="install" ;;
    -h|--help|help)           MODE="help" ;;
    --check|-c|check)         MODE="check" ;;
    --dry-run|-n|dry-run)     MODE="dry-run" ;;
    --rollback|--uninstall|rollback|uninstall) MODE="rollback" ;;
    *) printf 'ERROR: unknown arg %q (try --help)\n' "$arg" >&2; exit 64 ;;
  esac
done

if [[ "$MODE" = "help" ]]; then
  cat <<'HELP'
install-connect-vm-drop-dialplan.sh — Connect CRM Voicemail Drop dialplan plugin
================================================================================
Modes:
  install     (default) Write the Connect-owned [connect-vm-drop] include to
              /etc/asterisk/vitalpbx/extensions__96-connect-vm-drop.conf,
              reload dialplan, verify the context loaded (bridge via
              extensions__60_custom.conf only if the wildcard include is
              inactive), restore backup + abort on failure. Idempotent.
  --check     Read-only. PASS/FAIL: file present, [connect-vm-drop] loaded.
              No writes, no reloads.
  --dry-run   Print the exact file path and dialplan body that WOULD be written.
              Writes nothing, reloads nothing.
  --rollback  Remove only Connect-owned file + sentinel include, reload dialplan.
  --help      This message.

All modes except --check/--dry-run/--help require root.
HELP
  exit 0
fi

# ── dry-run: print intended actions, touch nothing ──────────────────────────
if [[ "$MODE" = "dry-run" ]]; then
  printf '[DRY-RUN] Would write context [%s] to:\n  %s\n' "$CONTEXT_NAME" "$DIALPLAN_FILE"
  printf '[DRY-RUN] Auto-loaded via extensions.conf line 1: #include vitalpbx/extensions__*.conf\n'
  printf '[DRY-RUN] Fallback bridge (only if not auto-loaded): append to %s\n  %s\n' "$CUSTOM_FILE" "$INCLUDE_LINE"
  printf '[DRY-RUN] Would then run: asterisk -rx "dialplan reload"\n'
  printf '[DRY-RUN] Would verify:  asterisk -rx "dialplan show %s"\n' "$CONTEXT_NAME"
  printf '\n[DRY-RUN] ----- file body begin -----\n'
  emit_dialplan
  printf '[DRY-RUN] ----- file body end -------\n'
  exit 0
fi

context_loaded() {
  asterisk -rx "dialplan show ${CONTEXT_NAME}" 2>&1 | grep -q "Connect VM drop file="
}

# ── check: read-only health check ───────────────────────────────────────────
if [[ "$MODE" = "check" ]]; then
  command -v asterisk >/dev/null 2>&1 || die "asterisk binary not found in PATH"
  fail=0
  printf '\n[CHECK] Connect Voicemail Drop dialplan plugin\n'
  printf '================================================\n'
  if [[ -f "$DIALPLAN_FILE" ]]; then
    printf '[PASS] include present: %s\n' "$DIALPLAN_FILE"
  else
    printf '[FAIL] include missing: %s\n' "$DIALPLAN_FILE"; fail=$((fail+1))
  fi
  if context_loaded; then
    printf '[PASS] dialplan context [%s] loaded\n' "$CONTEXT_NAME"
  else
    printf '[FAIL] dialplan context [%s] not loaded\n' "$CONTEXT_NAME"; fail=$((fail+1))
  fi
  printf '================================================\n'
  if [[ $fail -eq 0 ]]; then printf 'RESULT: PASS\n'; exit 0; else printf 'RESULT: FAIL (%s)\n' "$fail"; exit 1; fi
fi

# ── Preflight (install / rollback) ──────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "Run as root (sudo)."
command -v asterisk >/dev/null 2>&1 || die "asterisk binary not found in PATH"
asterisk -rx "core show channels count" >/dev/null 2>&1 || die "asterisk -rx not responsive — is Asterisk running?"

# ── rollback ─────────────────────────────────────────────────────────────────
if [[ "$MODE" = "rollback" ]]; then
  removed=0
  printf '\n[ROLLBACK] Connect Voicemail Drop dialplan plugin\n'
  printf '================================================\n'
  if [[ -f "$DIALPLAN_FILE" ]]; then
    rm -f "$DIALPLAN_FILE"; printf '[REMOVE] %s\n' "$DIALPLAN_FILE"; removed=$((removed+1))
  else
    printf '[SKIP]   %s already absent\n' "$DIALPLAN_FILE"
  fi
  if [[ -f "$CUSTOM_FILE" ]] && grep -Fxq "$INCLUDE_LINE" "$CUSTOM_FILE"; then
    cp -a "$CUSTOM_FILE" "$CUSTOM_BACKUP_FILE"
    sed -i '/^#include extensions__96-connect-vm-drop\.conf$/d' "$CUSTOM_FILE"
    printf '[REMOVE] sentinel include from %s (backup: %s)\n' "$CUSTOM_FILE" "$CUSTOM_BACKUP_FILE"; removed=$((removed+1))
  else
    printf '[SKIP]   no sentinel include in %s\n' "$CUSTOM_FILE"
  fi
  asterisk -rx "dialplan reload" >/dev/null 2>&1 || true
  printf '[RELOAD] dialplan reload\n'
  if context_loaded; then
    printf '[WARN]   [%s] still loaded after reload — investigate manually.\n' "$CONTEXT_NAME"
  else
    printf '[OK]     [%s] no longer loaded\n' "$CONTEXT_NAME"
  fi
  printf '================================================\n'
  printf 'RESULT: rollback complete (%s removed)\n' "$removed"
  exit 0
fi

# ── install ──────────────────────────────────────────────────────────────────
step "[1/5] Snapshot any existing include"
if [[ -f "$DIALPLAN_FILE" ]]; then
  cp -a "$DIALPLAN_FILE" "$BACKUP_FILE"; echo "  ↳ backed up to $BACKUP_FILE"
else
  echo "  ↳ no existing $DIALPLAN_FILE — fresh install"; : > "$BACKUP_FILE"
fi

step "[2/5] Write Connect Voicemail Drop dialplan include"
[[ -d "$DIALPLAN_DIR" ]] || die "$DIALPLAN_DIR does not exist — is this a VitalPBX host?"
emit_dialplan > "$TMP_NEW"
mv "$TMP_NEW" "$DIALPLAN_FILE"
chown asterisk:asterisk "$DIALPLAN_FILE" 2>/dev/null || true
chmod 0644 "$DIALPLAN_FILE"
echo "  ↳ wrote $DIALPLAN_FILE ($(wc -l < "$DIALPLAN_FILE" | tr -d ' ') lines)"

step "[3/5] Reload Asterisk dialplan"
RELOAD_OUT="$(asterisk -rx 'dialplan reload' 2>&1 || true)"; echo "  ↳ $RELOAD_OUT"

step "[4/5] Verify [${CONTEXT_NAME}] loaded"
if context_loaded; then
  echo "  ↳ OK — [${CONTEXT_NAME}] loaded via wildcard include"
else
  warn "Context not loaded directly — this host likely does not wildcard-include vitalpbx/extensions__*.conf."
  [[ -f "$CUSTOM_FILE" ]] || { rm -f "$DIALPLAN_FILE"; die "$CUSTOM_FILE missing; cannot bridge include. Removed $DIALPLAN_FILE."; }
  step "[4b/5] Bridge include through $CUSTOM_FILE"
  if ! grep -Fxq "$INCLUDE_LINE" "$CUSTOM_FILE"; then
    cp -a "$CUSTOM_FILE" "$CUSTOM_BACKUP_FILE"
    printf '\n; Connect Voicemail Drop include (auto-added by install-connect-vm-drop-dialplan.sh)\n%s\n' "$INCLUDE_LINE" >> "$CUSTOM_FILE"
    chmod 0644 "$CUSTOM_FILE"
    echo "  ↳ added sentinel include to $CUSTOM_FILE (backup: $CUSTOM_BACKUP_FILE)"
  else
    echo "  ↳ sentinel include already present"
  fi
  RELOAD_OUT="$(asterisk -rx 'dialplan reload' 2>&1 || true)"; echo "  ↳ $RELOAD_OUT"
  if ! context_loaded; then
    warn "Verification failed even after bridging. Restoring backups."
    if [[ -s "$BACKUP_FILE" ]]; then cp -a "$BACKUP_FILE" "$DIALPLAN_FILE"; else rm -f "$DIALPLAN_FILE"; fi
    [[ -f "$CUSTOM_BACKUP_FILE" ]] && cp -a "$CUSTOM_BACKUP_FILE" "$CUSTOM_FILE"
    asterisk -rx "dialplan reload" >/dev/null 2>&1 || true
    die "[${CONTEXT_NAME}] did not load. Backups restored."
  fi
  echo "  ↳ OK — [${CONTEXT_NAME}] loaded through $CUSTOM_FILE"
fi

step "[5/5] Done"
cat <<DONE

============================================================================
INSTALL COMPLETE.
  Context:  [${CONTEXT_NAME}]
  File:     ${DIALPLAN_FILE}
  Backup:   ${BACKUP_FILE}

Connect drives it over AMI (no PBX-side config needed):
  Action: Setvar   Channel=<customer leg>  Variable=VMDROP_FILE  Value=<base>
  Action: Redirect Channel=<customer leg>  Context=${CONTEXT_NAME} Exten=s Priority=1
  Action: Hangup   Channel=<agent leg>

Verify:   sudo $0 --check
Rollback: sudo $0 --rollback
============================================================================
DONE
