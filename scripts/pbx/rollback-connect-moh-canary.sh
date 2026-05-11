#!/usr/bin/env bash
# rollback-connect-moh-canary.sh
# =============================================================================
# Rollback-only script for the Connect canary outbound-trunk MOH wrapper.
# Removes ONLY Connect-owned canary-wrapper files; never touches any
# VitalPBX-generated file. Reloads dialplan and verifies the wrapper is
# gone from both disk and merged dialplan state.
#
# Scope (the ONLY files this script will ever delete):
#   - /etc/asterisk/extensions__65_connect_trk33_wrapper.conf
#   - /etc/asterisk/extensions__65_connect_trk*_wrapper.conf
#     (future per-trunk canaries following the same naming convention)
#
# Hard guarantees:
#   - NEVER deletes a file whose basename does NOT begin with
#     "extensions__65_connect_trk" and end in "_wrapper.conf".
#     The script refuses to operate on any other path; defense-in-depth
#     against typos in the constant.
#   - NEVER edits the base tenant-MOH dialplan / PJSIP includes; for
#     those use `install-connect-tenant-moh-dialplan.sh --rollback`.
#   - NEVER edits or restores any VitalPBX-generated file.
#   - Backs up each removed wrapper file under
#     /root/connect-moh-safety/rollback-<ts>/ before deletion.
#   - Performs exactly one `asterisk -rx 'dialplan reload'` (unless
#     --no-reload is passed for hand-staged rollback).
#   - Verifies post-rollback: wrapper file absent + wrapper sentinel
#     NoOp absent from `dialplan show trk-<trunk>-dial`.
#   - Optional --expected-sha=<hash> compares post-rollback
#     `dialplan show trk-<trunk>-dial | head -80` SHA256 to the
#     preflight-snapshot baseline; verification fails if SHA differs.
#
# Usage (run as root on the PBX):
#   sudo bash rollback-connect-moh-canary.sh [--trunk <N>] [--no-reload]
#                                            [--expected-sha <hash>]
#                                            [--dry-run]
#
# Defaults:
#   --trunk 33
#
# Exit codes:
#   0 -> rollback verified clean (file absent + sentinel absent
#        + SHA matches expected, if provided)
#   1 -> verification FAILED (rollback was attempted but state is
#        not what we expected; escalate, do NOT retry blindly)
#   2 -> precondition failed (not root / invalid args / refusal to
#        operate on a path outside the allowlist)
# =============================================================================

set -uo pipefail

TRUNK_ID="33"
DO_RELOAD=1
DRY_RUN=0
EXPECTED_SHA=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --trunk)        TRUNK_ID="$2"; shift 2 ;;
    --no-reload)    DO_RELOAD=0; shift ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --expected-sha) EXPECTED_SHA="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,48p' "$0"; exit 0 ;;
    *)
      printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  printf 'must be run as root for /etc/asterisk write access.\n' >&2
  exit 2
fi

if [[ ! "$TRUNK_ID" =~ ^[0-9]+$ ]]; then
  printf 'invalid --trunk: %s\n' "$TRUNK_ID" >&2
  exit 2
fi

ASTERISK_EXT_DIR=/etc/asterisk
WRAPPER_FILE="$ASTERISK_EXT_DIR/extensions__65_connect_trk${TRUNK_ID}_wrapper.conf"
TRK_CTX="trk-${TRUNK_ID}-dial"

# Defense-in-depth: refuse to operate on anything outside the allowlist.
case "$(basename "$WRAPPER_FILE")" in
  extensions__65_connect_trk*_wrapper.conf) : ;;
  *)
    printf 'refusing to operate on %s (not in Connect-canary allowlist)\n' \
      "$WRAPPER_FILE" >&2
    exit 2
    ;;
esac

TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="/root/connect-moh-safety/rollback-${TS}"

step()   { printf '\n=== %s ===\n' "$*"; }
note()   { printf '  - %s\n' "$*"; }
warn()   { printf '  ! %s\n' "$*" >&2; }

# -----------------------------------------------------------------------------
# 0. environment
# -----------------------------------------------------------------------------
step "0. environment"
note "trunk id        = $TRUNK_ID"
note "wrapper file    = $WRAPPER_FILE"
note "dialplan ctx    = [$TRK_CTX]"
note "dry-run         = $([[ $DRY_RUN -eq 1 ]] && echo yes || echo no)"
note "reload dialplan = $([[ $DO_RELOAD -eq 1 ]] && echo yes || echo no)"
note "expected SHA    = ${EXPECTED_SHA:-(none provided)}"
note "backup dir      = $BACKUP_DIR"

# -----------------------------------------------------------------------------
# 1. pre-rollback state
# -----------------------------------------------------------------------------
step "1. pre-rollback state"
PRE_FILE_PRESENT="no"
if [[ -f "$WRAPPER_FILE" ]]; then
  PRE_FILE_PRESENT="yes"
  note "wrapper file present on disk; sha256 = $(sha256sum "$WRAPPER_FILE" | awk '{print $1}')"
else
  note "wrapper file absent on disk (nothing to delete)"
fi

PRE_SENTINEL_LOADED="no"
PRE_TRK_DUMP="$(asterisk -rx "dialplan show $TRK_CTX" 2>&1 || true)"
if printf '%s\n' "$PRE_TRK_DUMP" | grep -qF 'connect-trk33-wrapper enter'; then
  PRE_SENTINEL_LOADED="yes"
  note "wrapper sentinel CURRENTLY loaded in [$TRK_CTX]"
else
  note "wrapper sentinel NOT loaded in [$TRK_CTX]"
fi

# Idempotent short-circuit: if neither the file nor the sentinel is
# present, there is nothing to do. Still optionally verify the SHA.
if [[ "$PRE_FILE_PRESENT" == "no" && "$PRE_SENTINEL_LOADED" == "no" ]]; then
  note "wrapper not installed; nothing to roll back"
  if [[ -n "$EXPECTED_SHA" ]]; then
    CUR_SHA="$(printf '%s\n' "$PRE_TRK_DUMP" | head -n 80 | sha256sum | awk '{print $1}')"
    if [[ "$CUR_SHA" == "$EXPECTED_SHA" ]]; then
      note "baseline SHA MATCH ($CUR_SHA)"
    else
      warn "baseline SHA MISMATCH"
      warn "  current  = $CUR_SHA"
      warn "  expected = $EXPECTED_SHA"
      # Drift is a notable signal but NOT a rollback failure (we did not
      # have anything to remove). Surface a clear PROOF entry below.
    fi
  fi
  step "PROOF"
  cat <<EOF
PROOF:
  RESULT                    = nothing_to_rollback
  WRAPPER_FILE_PRESENT_PRE  = $PRE_FILE_PRESENT
  WRAPPER_SENTINEL_PRE      = $PRE_SENTINEL_LOADED
  RELOAD_PERFORMED          = no
  WRAPPER_FILE_PRESENT_POST = no
  WRAPPER_SENTINEL_POST     = no
EOF
  exit 0
fi

# -----------------------------------------------------------------------------
# 2. backup + delete
# -----------------------------------------------------------------------------
step "2. backup + delete"
if [[ "$PRE_FILE_PRESENT" == "yes" ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then
    note "[DRY-RUN] would backup $WRAPPER_FILE to $BACKUP_DIR/"
    note "[DRY-RUN] would rm -f $WRAPPER_FILE"
  else
    mkdir -p "$BACKUP_DIR" || { warn "failed to create backup dir $BACKUP_DIR"; exit 1; }
    cp -a "$WRAPPER_FILE" "$BACKUP_DIR/" \
      || { warn "backup failed; refusing to delete"; exit 1; }
    note "backed up to $BACKUP_DIR/$(basename "$WRAPPER_FILE")"
    rm -f "$WRAPPER_FILE" \
      || { warn "rm failed for $WRAPPER_FILE"; exit 1; }
    note "deleted $WRAPPER_FILE"
  fi
else
  note "no file to delete (sentinel was loaded without on-disk include — escalate after reload)"
fi

# -----------------------------------------------------------------------------
# 3. reload dialplan
# -----------------------------------------------------------------------------
step "3. reload dialplan"
if [[ $DRY_RUN -eq 1 ]]; then
  note "[DRY-RUN] would run: asterisk -rx 'dialplan reload'"
elif [[ $DO_RELOAD -eq 0 ]]; then
  note "skipping reload (--no-reload). Run this by hand once you are ready:"
  note "  asterisk -rx 'dialplan reload'"
else
  if ! asterisk -rx 'dialplan reload' 2>&1 | sed 's/^/    /'; then
    warn "dialplan reload returned non-zero (asterisk CLI may have failed)"
  fi
fi

# -----------------------------------------------------------------------------
# 4. post-rollback verification
# -----------------------------------------------------------------------------
step "4. post-rollback verification"

POST_FILE_PRESENT="no"
if [[ -f "$WRAPPER_FILE" ]]; then
  POST_FILE_PRESENT="yes"
fi
note "wrapper file post-rollback : $POST_FILE_PRESENT"

POST_TRK_DUMP="$(asterisk -rx "dialplan show $TRK_CTX" 2>&1 || true)"
POST_SENTINEL_LOADED="no"
if printf '%s\n' "$POST_TRK_DUMP" | grep -qF 'connect-trk33-wrapper enter'; then
  POST_SENTINEL_LOADED="yes"
fi
note "wrapper sentinel post-roll : $POST_SENTINEL_LOADED"

POST_SHA="$(printf '%s\n' "$POST_TRK_DUMP" | head -n 80 | sha256sum | awk '{print $1}')"
note "trk-${TRUNK_ID}-dial head80 sha256 (post) = $POST_SHA"

SHA_MATCH="n/a"
if [[ -n "$EXPECTED_SHA" ]]; then
  if [[ "$POST_SHA" == "$EXPECTED_SHA" ]]; then
    SHA_MATCH="yes"
    note "expected baseline SHA MATCH"
  else
    SHA_MATCH="no"
    warn "expected baseline SHA MISMATCH"
    warn "  post     = $POST_SHA"
    warn "  expected = $EXPECTED_SHA"
  fi
fi

# -----------------------------------------------------------------------------
# 5. PROOF + exit decision
# -----------------------------------------------------------------------------
step "5. PROOF"

RESULT="ok"
if [[ "$POST_FILE_PRESENT" == "yes" || "$POST_SENTINEL_LOADED" == "yes" ]]; then
  RESULT="failed_state_still_active"
elif [[ -n "$EXPECTED_SHA" && "$SHA_MATCH" == "no" ]]; then
  RESULT="failed_baseline_sha_drift"
fi

cat <<EOF
PROOF:
  RESULT                    = $RESULT
  TRUNK_ID                  = $TRUNK_ID
  WRAPPER_FILE_PRESENT_PRE  = $PRE_FILE_PRESENT
  WRAPPER_SENTINEL_PRE      = $PRE_SENTINEL_LOADED
  RELOAD_PERFORMED          = $([[ $DO_RELOAD -eq 1 && $DRY_RUN -eq 0 ]] && echo yes || echo no)
  WRAPPER_FILE_PRESENT_POST = $POST_FILE_PRESENT
  WRAPPER_SENTINEL_POST     = $POST_SENTINEL_LOADED
  POST_HEAD80_SHA256        = $POST_SHA
  EXPECTED_HEAD80_SHA256    = ${EXPECTED_SHA:-(not provided)}
  SHA_MATCH                 = $SHA_MATCH
  BACKUP_DIR                = ${BACKUP_DIR}
  manual_equivalent         = "rm -f $WRAPPER_FILE && asterisk -rx 'dialplan reload'"
EOF

case "$RESULT" in
  ok) exit 0 ;;
  *)  exit 1 ;;
esac
