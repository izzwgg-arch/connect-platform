#!/usr/bin/env bash
# diag-connect-pjsip-append.sh
# =============================================================================
# Diagnostic-only probe for the Connect tenant MOH caller-leg layer.
#
# Prove (or disprove) on THIS specific VitalPBX/Asterisk build:
#   1. Whether /etc/asterisk/pjsip.conf actually #includes the file
#      family the tenant-MOH installer writes to (pjsip__65_*.conf).
#   2. Whether `[endpoint](+)` flat-file append is honored at all for
#      the configured endpoint backend (config_file vs realtime/
#      sorcery wizard).
#   3. Which candidate include filename — if any — actually causes a
#      `set_var` line to surface in `pjsip show endpoint <ep>` output
#      after `module reload res_pjsip.so`.
#
# Side effects, scoped & reverted:
#   - Temporarily writes ONE probe file per candidate path to
#     /etc/asterisk/, runs `module reload res_pjsip.so`, then deletes
#     the probe file and reloads again before moving to the next
#     candidate. If a real file already exists at that path, it is
#     backed up (cp -a) before the probe and restored after.
#   - A trap ensures the probe files are removed on Ctrl-C / error.
#   - This script must NOT be run while the Connect tenant MOH
#     installer's PJSIP layer is currently installed; rerun the
#     installer in --rollback mode first if so.
#
# Usage (as root on the PBX):
#   sudo bash diag-connect-pjsip-append.sh [endpoint] [class]
#
# Defaults:
#   endpoint = T3_103
#   class    = moh8
#
# Output: human-readable. Look for the RESULT block at the bottom
# and the section-2 endpoint backend dump.
# =============================================================================

set -uo pipefail

EP="${1:-T3_103}"
CLASS="${2:-moh8}"
MARKER="connect_diag_$$_$(date +%s)"

# Candidate include paths the installer might use, plus paths that
# VitalPBX is known to ship as user-customisable include points.
CAND=(
  "/etc/asterisk/pjsip__65_connect_tenant_moh.conf"
  "/etc/asterisk/pjsip__95_connect_tenant_moh.conf"
  "/etc/asterisk/pjsip_custom.conf"
  "/etc/asterisk/pjsip_custom_post.conf"
  "/etc/asterisk/pjsip_endpoint_custom_post.conf"
)

PROBE_ACTIVE=""
RESULTS=()

step() { printf '\n=== %s ===\n' "$*"; }
note() { printf '  - %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }

cleanup() {
  if [[ -n "$PROBE_ACTIVE" ]]; then
    rm -f "$PROBE_ACTIVE" 2>/dev/null || true
    if [[ -e "${PROBE_ACTIVE}.connectdiag.bak" ]]; then
      mv "${PROBE_ACTIVE}.connectdiag.bak" "$PROBE_ACTIVE" 2>/dev/null || true
    fi
    asterisk -rx 'module reload res_pjsip.so' >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

# Reload PJSIP using a CLI variant that actually exists on this build.
pjsip_reload() {
  local out
  out="$(asterisk -rx 'module reload res_pjsip.so' 2>&1 || true)"
  if echo "$out" | grep -qiE 'no such command|command not found'; then
    out="$(asterisk -rx 'core reload' 2>&1 || true)"
  fi
  printf '%s' "$out"
}

if [[ "$(id -u)" -ne 0 ]]; then
  warn "must be run as root (need write access to /etc/asterisk/)."
  exit 1
fi

if [[ -e "/etc/asterisk/pjsip__65_connect_tenant_moh.conf" ]]; then
  warn "pjsip__65_connect_tenant_moh.conf already exists — the Connect"
  warn "tenant MOH PJSIP layer appears to be installed. Run"
  warn "  sudo /root/install-connect-tenant-moh-dialplan.sh --rollback"
  warn "first, then re-run this diagnostic on a clean PBX."
  exit 2
fi

step "0. environment"
note "endpoint     = $EP"
note "class        = $CLASS"
note "probe marker = $MARKER"
note "asterisk     = $(asterisk -V 2>&1 | head -1)"
note "vitalpbx     = $(rpm -q vitalpbx 2>/dev/null || dpkg-query -W -f='${Version}' vitalpbx 2>/dev/null || echo unknown)"

# -----------------------------------------------------------------------------
# 1. include topology
# -----------------------------------------------------------------------------
step "1. /etc/asterisk/pjsip.conf #include topology"
if [[ -r /etc/asterisk/pjsip.conf ]]; then
  grep -nE '^\s*#include|^\s*#tryinclude' /etc/asterisk/pjsip.conf \
    || note "no #include / #tryinclude lines in pjsip.conf"
else
  warn "/etc/asterisk/pjsip.conf is not readable"
fi
echo "----"
note "pjsip__*.conf files present in /etc/asterisk:"
ls -1 /etc/asterisk/pjsip__*.conf 2>/dev/null | sed 's/^/    /' \
  || note "  (none)"
echo "----"
note "pjsip_custom*.conf / pjsip_endpoint*.conf files present:"
ls -1 /etc/asterisk/pjsip_custom*.conf \
       /etc/asterisk/pjsip_endpoint_custom*.conf 2>/dev/null \
  | sed 's/^/    /' || note "  (none)"
echo "----"
note "core show config mappings (sorcery / realtime hookup):"
asterisk -rx 'core show config mappings' 2>&1 | sed 's/^/    /' | head -40

# -----------------------------------------------------------------------------
# 2. T3_103 backend / current attributes
# -----------------------------------------------------------------------------
step "2. pjsip show endpoint $EP — current attributes (pre-probe)"
asterisk -rx "pjsip show endpoint $EP" 2>&1 | sed 's/^/    /' | head -80

# -----------------------------------------------------------------------------
# 3. write/check/revert probe per candidate include path
# -----------------------------------------------------------------------------
step "3. write/reload/check/revert probe for each candidate path"
for path in "${CAND[@]}"; do
  echo
  note "candidate: $path"
  if [[ -e "$path" ]]; then
    cp -a "$path" "${path}.connectdiag.bak"
    note "  (existing file backed up to ${path}.connectdiag.bak)"
  fi
  PROBE_ACTIVE="$path"
  cat >"$path" <<EOF
; connect-diag $MARKER (this file is removed at end of probe)
[$EP](+)
set_var = CHANNEL(${MARKER})=${CLASS}
EOF
  out="$(pjsip_reload)"
  first_line="$(printf '%s' "$out" | head -1)"
  note "  reload: $first_line"
  endpoint_out="$(asterisk -rx "pjsip show endpoint $EP" 2>&1)"
  if printf '%s' "$endpoint_out" | grep -q "$MARKER"; then
    RESULTS+=("PASS  $path  marker visible after reload")
    note "  PASS — marker $MARKER present in pjsip show endpoint output"
  else
    RESULTS+=("FAIL  $path  marker NOT visible after reload")
    note "  FAIL — marker $MARKER absent from pjsip show endpoint output"
  fi
  rm -f "$path"
  if [[ -e "${path}.connectdiag.bak" ]]; then
    mv "${path}.connectdiag.bak" "$path"
  fi
  pjsip_reload >/dev/null 2>&1 || true
  PROBE_ACTIVE=""
done

# -----------------------------------------------------------------------------
# 4. summary
# -----------------------------------------------------------------------------
step "4. RESULT (one line per candidate)"
printf '  %s\n' "${RESULTS[@]}"

cat <<'TXT'

Interpretation guide:
  * If ANY candidate is PASS, that path is the right include point —
    update the installer to write there instead of pjsip__65_*.conf.
  * If EVERY candidate is FAIL, flat-file `[endpoint](+)` append does
    NOT propagate to the runtime endpoint on this build. Re-read the
    section-2 dump for the endpoint's source / sorcery driver:
      - "config_file" + all FAIL  ->  glob include is not picking up
        ANY of the candidate filenames; check section-1 #include lines.
      - realtime/sorcery wizard   ->  flat-file append is impossible;
        the caller-leg MOH layer must be moved to a non-PJSIP-append
        mechanism (e.g. set CHANNEL(musicclass) in the very first
        dialplan context the leg traverses, or via an originate-time
        channel variable, or by extending the queued/native MOH path).
TXT
