#!/usr/bin/env bash
# diag-connect-moh-preflight-snapshot.sh
# =============================================================================
# Read-only PBX-state snapshot for the Connect tenant-MOH / canary-wrapper
# safety harness. Run BEFORE any wrapper install attempt to capture a
# forensic baseline; run AGAIN AFTER any rollback to prove byte-identical
# revert.
#
# Hard guarantees:
#   - NEVER edits /etc/asterisk/, /etc/connect/, MariaDB, or any service
#     config. The only writes this script performs are under
#     /root/connect-moh-safety/<timestamp>/, which Asterisk does not read.
#   - NEVER reloads / restarts asterisk, pjsip, dialplan, or any service.
#   - Issues only `asterisk -rx "<read-only verb>"` plus `sha256sum`, `ls`,
#     `cat`, `find`, `grep`, `awk`, `sed` against existing files.
#   - Does not place calls or wake any service.
#
# Usage (run as root on the PBX, READ-ONLY):
#   sudo bash diag-connect-moh-preflight-snapshot.sh [--tag <label>]
#
# Outputs:
#   /root/connect-moh-safety/<timestamp>[-<label>]/
#     env.txt
#     dialplan-trk-33-dial.txt
#     dialplan-sub-before-bridging-call.txt
#     dialplan-sub-before-connecting-call.txt
#     dialplan-show-global.txt          (top-level contexts)
#     database-show-connect.txt
#     moh-classes.txt
#     moh-files.txt
#     pjsip-show-endpoints.txt
#     connect-owned-includes.txt
#     generated-file-hashes.txt
#     wrapper-presence.txt
#     pjsip-include-presence.txt
#     trk-33-dial-head80.sha256
#     PROOF.txt
#
# Exit codes:
#   0  -> snapshot succeeded; PROOF.WRAPPER_INSTALLED=no (expected baseline)
#   1  -> snapshot succeeded but PROOF.WRAPPER_INSTALLED=yes (canary IS live)
#   2  -> snapshot failed (asterisk CLI unreachable, or write failed)
# =============================================================================

set -uo pipefail

TAG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,40p' "$0"; exit 0 ;;
    *)
      printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  printf 'must be run as root for /etc/asterisk read access.\n' >&2
  exit 2
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -n "$TAG" ]]; then
  SAFETAG="$(printf '%s' "$TAG" | tr -c 'A-Za-z0-9._-' '_')"
  OUT="/root/connect-moh-safety/${TS}-${SAFETAG}"
else
  OUT="/root/connect-moh-safety/${TS}"
fi

mkdir -p "$OUT" || { printf 'failed to create %s\n' "$OUT" >&2; exit 2; }

step()   { printf '\n=== %s ===\n' "$*"; }
note()   { printf '  - %s\n' "$*"; }
warn()   { printf '  ! %s\n' "$*" >&2; }

ASTERISK_EXT_DIR=/etc/asterisk

# -----------------------------------------------------------------------------
# 0. environment
# -----------------------------------------------------------------------------
step "0. environment"
{
  printf 'timestamp_utc = %s\n' "$TS"
  printf 'tag           = %s\n' "${TAG:-(none)}"
  printf 'hostname      = %s\n' "$(hostname)"
  printf 'asterisk      = %s\n' "$(asterisk -V 2>&1 | head -1)"
  printf 'vitalpbx      = %s\n' \
    "$(rpm -q vitalpbx 2>/dev/null \
       || dpkg-query -W -f='${Version}' vitalpbx 2>/dev/null \
       || echo unknown)"
  printf 'output_dir    = %s\n' "$OUT"
} | tee "$OUT/env.txt"

# Helper: run an asterisk -rx capture and save to a file. Returns non-zero
# only if asterisk itself failed; empty output is recorded as-is.
ast_capture() {
  local verb="$1"; local dest="$2"
  if ! asterisk -rx "$verb" >"$dest" 2>&1; then
    warn "asterisk -rx \"$verb\" failed"
    return 1
  fi
  return 0
}

ASTERISK_OK=1
if ! asterisk -rx 'core show version' >/dev/null 2>&1; then
  warn "asterisk CLI unreachable (asterisk -rx returned error)"
  ASTERISK_OK=0
fi

# -----------------------------------------------------------------------------
# 1. dialplan captures
# -----------------------------------------------------------------------------
step "1. dialplan captures"
if [[ $ASTERISK_OK -eq 1 ]]; then
  ast_capture 'dialplan show trk-33-dial'                 "$OUT/dialplan-trk-33-dial.txt"               || true
  ast_capture 'dialplan show sub-before-bridging-call'    "$OUT/dialplan-sub-before-bridging-call.txt"  || true
  ast_capture 'dialplan show sub-before-connecting-call'  "$OUT/dialplan-sub-before-connecting-call.txt" || true
  ast_capture 'dialplan show'                             "$OUT/dialplan-show-global.txt"               || true
  note "saved dialplan-trk-33-dial.txt $(wc -l <"$OUT/dialplan-trk-33-dial.txt" 2>/dev/null || echo 0) lines"
else
  note "(skipped: asterisk CLI unreachable)"
fi

# First-80-lines SHA of trk-33-dial (matches the installer's gate hash)
if [[ -s "$OUT/dialplan-trk-33-dial.txt" ]]; then
  TRK33_HEAD80_SHA="$(head -n 80 "$OUT/dialplan-trk-33-dial.txt" | sha256sum | awk '{print $1}')"
  printf '%s\n' "$TRK33_HEAD80_SHA" >"$OUT/trk-33-dial-head80.sha256"
  note "trk-33-dial head80 sha256 = $TRK33_HEAD80_SHA"
else
  TRK33_HEAD80_SHA="(unknown)"
  printf '%s\n' "$TRK33_HEAD80_SHA" >"$OUT/trk-33-dial-head80.sha256"
  note "trk-33-dial head80 sha256 = (unknown)"
fi

# -----------------------------------------------------------------------------
# 2. AstDB (Connect tree)
# -----------------------------------------------------------------------------
step "2. AstDB connect/* tree"
if [[ $ASTERISK_OK -eq 1 ]]; then
  ast_capture 'database show connect' "$OUT/database-show-connect.txt" || true
  note "saved $(wc -l <"$OUT/database-show-connect.txt" 2>/dev/null || echo 0) AstDB entries under connect/"
fi

# -----------------------------------------------------------------------------
# 3. MOH classes + files
# -----------------------------------------------------------------------------
step "3. moh show classes / moh show files"
if [[ $ASTERISK_OK -eq 1 ]]; then
  ast_capture 'moh show classes' "$OUT/moh-classes.txt" || true
  ast_capture 'moh show files'   "$OUT/moh-files.txt"   || true
fi

# -----------------------------------------------------------------------------
# 4. PJSIP endpoints (top-level enumeration only)
# -----------------------------------------------------------------------------
step "4. pjsip show endpoints"
if [[ $ASTERISK_OK -eq 1 ]]; then
  ast_capture 'pjsip show endpoints' "$OUT/pjsip-show-endpoints.txt" || true
fi

# -----------------------------------------------------------------------------
# 5. Connect-owned include enumeration
# -----------------------------------------------------------------------------
step "5. Connect-owned includes in $ASTERISK_EXT_DIR"
{
  find "$ASTERISK_EXT_DIR" -maxdepth 1 -type f \
       \( -name 'extensions__65_connect_*.conf' \
       -o -name 'pjsip__65_connect_*.conf' \) \
       -printf '%p %s bytes %TY-%Tm-%TdT%TH:%TM:%TSZ\n' 2>/dev/null \
       | sort \
       || true
} | tee "$OUT/connect-owned-includes.txt"

# -----------------------------------------------------------------------------
# 6. sha256 of generated dialplan + PJSIP files (so a later snapshot can
#    prove VitalPBX did NOT regenerate them between snapshots).
# -----------------------------------------------------------------------------
step "6. sha256 of generated dialplan + PJSIP files"
{
  find "$ASTERISK_EXT_DIR" -maxdepth 1 -type f \
       \( -name 'extensions__*.conf' -o -name 'pjsip__*.conf' \) \
       -print0 2>/dev/null \
       | xargs -0 -r sha256sum \
       | sort -k2 \
       || true
} | tee "$OUT/generated-file-hashes.txt" >/dev/null
note "wrote $(wc -l <"$OUT/generated-file-hashes.txt" 2>/dev/null || echo 0) file hashes"

# -----------------------------------------------------------------------------
# 7. Wrapper presence detection (canary)
# -----------------------------------------------------------------------------
step "7. canary wrapper presence"
WRAPPER_FILE="$ASTERISK_EXT_DIR/extensions__65_connect_trk33_wrapper.conf"
if [[ -f "$WRAPPER_FILE" ]]; then
  WRAPPER_PRESENT="yes"
  {
    printf 'WRAPPER_PRESENT = yes\n'
    printf 'path            = %s\n' "$WRAPPER_FILE"
    printf 'size_bytes      = %s\n' "$(stat -c%s "$WRAPPER_FILE" 2>/dev/null || echo unknown)"
    printf 'sha256          = %s\n' "$(sha256sum "$WRAPPER_FILE" | awk '{print $1}')"
    printf 'mtime_utc       = %s\n' "$(stat -c%Y "$WRAPPER_FILE" 2>/dev/null | xargs -I{} date -u -d @{} +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
  } | tee "$OUT/wrapper-presence.txt"
else
  WRAPPER_PRESENT="no"
  {
    printf 'WRAPPER_PRESENT = no\n'
    printf 'path            = %s (absent)\n' "$WRAPPER_FILE"
  } | tee "$OUT/wrapper-presence.txt"
fi

# Wrapper sentinel runtime check (loaded vs file-on-disk are different things).
WRAPPER_SENTINEL_LOADED="no"
if [[ -s "$OUT/dialplan-trk-33-dial.txt" ]] \
   && grep -qF 'connect-trk33-wrapper enter' "$OUT/dialplan-trk-33-dial.txt"; then
  WRAPPER_SENTINEL_LOADED="yes"
fi
printf 'wrapper_sentinel_loaded = %s\n' "$WRAPPER_SENTINEL_LOADED" >>"$OUT/wrapper-presence.txt"
note "wrapper file on disk : $WRAPPER_PRESENT"
note "wrapper sentinel live: $WRAPPER_SENTINEL_LOADED"

# -----------------------------------------------------------------------------
# 8. PJSIP include presence
# -----------------------------------------------------------------------------
step "8. PJSIP caller-leg include presence"
PJSIP_INCLUDE="$ASTERISK_EXT_DIR/pjsip__65_connect_tenant_moh.conf"
if [[ -f "$PJSIP_INCLUDE" ]]; then
  PJSIP_INCLUDE_PRESENT="yes"
  {
    printf 'PJSIP_INCLUDE_PRESENT = yes\n'
    printf 'path                  = %s\n' "$PJSIP_INCLUDE"
    printf 'size_bytes            = %s\n' "$(stat -c%s "$PJSIP_INCLUDE" 2>/dev/null || echo unknown)"
    printf 'sha256                = %s\n' "$(sha256sum "$PJSIP_INCLUDE" | awk '{print $1}')"
  } | tee "$OUT/pjsip-include-presence.txt"
else
  PJSIP_INCLUDE_PRESENT="no"
  {
    printf 'PJSIP_INCLUDE_PRESENT = no\n'
    printf 'path                  = %s (absent)\n' "$PJSIP_INCLUDE"
  } | tee "$OUT/pjsip-include-presence.txt"
fi

# -----------------------------------------------------------------------------
# 9. PROOF summary
# -----------------------------------------------------------------------------
step "9. PROOF"
{
  printf 'PROOF:\n'
  printf '  TIMESTAMP_UTC             = %s\n' "$TS"
  printf '  SNAPSHOT_DIR              = %s\n' "$OUT"
  printf '  ASTERISK_REACHABLE        = %s\n' "$([[ $ASTERISK_OK -eq 1 ]] && echo yes || echo no)"
  printf '  WRAPPER_FILE_ON_DISK      = %s\n' "$WRAPPER_PRESENT"
  printf '  WRAPPER_SENTINEL_LOADED   = %s\n' "$WRAPPER_SENTINEL_LOADED"
  printf '  PJSIP_INCLUDE_ON_DISK     = %s\n' "$PJSIP_INCLUDE_PRESENT"
  printf '  TRK33_HEAD80_SHA256       = %s\n' "$TRK33_HEAD80_SHA"
} | tee "$OUT/PROOF.txt"

if [[ $ASTERISK_OK -ne 1 ]]; then
  warn "asterisk CLI was unreachable during snapshot; outputs may be incomplete"
  exit 2
fi
if [[ "$WRAPPER_PRESENT" == "yes" || "$WRAPPER_SENTINEL_LOADED" == "yes" ]]; then
  exit 1
fi
exit 0
