#!/usr/bin/env bash
# diag-connect-trk33-drift-compare.sh
# =============================================================================
# Read-only drift comparison for [trk-33-dial] vs the captured baseline that
# `scripts/pbx/install-connect-tenant-moh-dialplan.sh --enable-trk-wrapper=33`
# refuses to install against.
#
# Context (2026-05-10/11):
#   Canary wrapper install was attempted with --enable-trk-wrapper=33 and was
#   correctly refused because the live `dialplan show trk-33-dial | head -80`
#   hash differs from the installer's captured baseline. The wrapper was NOT
#   installed; the PBX is unchanged. Before any human decides to re-baseline
#   the constant in the installer, we need PROOF that:
#     1. the structural invariants the wrapper depends on still hold,
#     2. ${TENANT} is still definitely available inside trk-33-dial,
#     3. trunk 33 is not silently shared by multiple tenants (which would
#        break the trunk-wide assumption the wrapper relies on).
#
# Hard guarantees:
#   - NEVER writes any file under /etc/asterisk/, /var/lib/asterisk/, or any
#     service config. The only files this script creates are read-only working
#     scratch files under $TMPDIR (or /tmp) which are removed on exit.
#   - NEVER reloads / restarts asterisk, pjsip, dialplan, or any service.
#   - NEVER mutates MariaDB (no INSERT / UPDATE / DELETE / TRUNCATE / DROP).
#   - Issues only `asterisk -rx "<read-only verb>"` plus `grep`, `awk`, `sed`,
#     `sha256sum`, `head`, `ls`, `cat` against existing files.
#   - Does not place test calls, originate channels, or wake any service.
#
# Usage (run as root on the PBX, READ-ONLY):
#   sudo bash diag-connect-trk33-drift-compare.sh [trunk_id] [tenant_id]
#
# Defaults:
#   trunk_id  = 33
#   tenant_id = 3
#
# Exit codes (mirrors the PROOF.REBASE_SAFE field):
#   0  -> REBASE_SAFE=yes
#   1  -> REBASE_SAFE=no
#   2  -> REBASE_SAFE=unknown (insufficient evidence)
#
# This script does NOT change the installer's baseline SHA. Re-baselining is
# a separate architecture-review activity. This script produces evidence; a
# human decides.
# =============================================================================

set -uo pipefail

TRUNK_ID="${1:-33}"
TENANT_ID="${2:-3}"

# Constants -- MUST stay in sync with the installer.
EXPECTED_BASELINE_SHA="9636ed092f6f8154deae751d199574c2cf7e3dd29eb00a263be5ae7b6f250695"
EXPECTED_PATTERN='_[-+*#0-9a-zA-Z].'

# Asterisk extension config files we may grep over for upstream sites.
ASTERISK_EXT_GLOB="/etc/asterisk/extensions*.conf"

step()   { printf '\n=== %s ===\n' "$*"; }
note()   { printf '  - %s\n' "$*"; }
warn()   { printf '  ! %s\n' "$*" >&2; }
indent() { sed 's/^/    /'; }

if [[ "$(id -u)" -ne 0 ]]; then
  warn "must be run as root for /etc/asterisk read access."
  exit 2
fi

WORK="$(mktemp -d -t diag-trk33-drift.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# Tracking for the structured PROOF block.
CURRENT_BASELINE_SHA="(unknown)"
PATTERN_PRESENT="unknown"
PRI21_OK="unknown"
PRI22_OK="unknown"
PRI44_OK="unknown"
TENANT_GUARD_SAFE="unknown"
TRUNK_SHARED_RISK="unknown"
REBASE_SAFE="unknown"
REASON=""

TRK_CTX="trk-${TRUNK_ID}-dial"

# -----------------------------------------------------------------------------
# 0. environment
# -----------------------------------------------------------------------------
step "0. environment"
note "trunk id            = $TRUNK_ID"
note "tenant id           = $TENANT_ID"
note "trk context         = [$TRK_CTX]"
note "expected baseline   = $EXPECTED_BASELINE_SHA"
note "expected pattern    = '$EXPECTED_PATTERN'"
note "asterisk            = $(asterisk -V 2>&1 | head -1)"
note "vitalpbx            = $(rpm -q vitalpbx 2>/dev/null || dpkg-query -W -f='${Version}' vitalpbx 2>/dev/null || echo unknown)"
note "scratch dir         = $WORK (auto-removed on exit)"

# -----------------------------------------------------------------------------
# A. current `dialplan show trk-33-dial` (full)
# -----------------------------------------------------------------------------
step "A. dialplan show $TRK_CTX (full, all priorities)"
asterisk -rx "dialplan show $TRK_CTX" >"$WORK/dialplan-show.txt" 2>&1 || true

if [[ ! -s "$WORK/dialplan-show.txt" ]] \
   || grep -qiE 'no such context|there is no context' "$WORK/dialplan-show.txt"; then
  warn "asterisk returned no output for [$TRK_CTX] (CLI unreachable or context missing)"
  REASON="dialplan show $TRK_CTX produced no usable output"
  cat "$WORK/dialplan-show.txt" | indent || true
  REBASE_SAFE="unknown"
  # Fall through to print the PROOF block, then exit 2.
else
  cat "$WORK/dialplan-show.txt" | indent
fi

# -----------------------------------------------------------------------------
# B. current first-80-lines hash
# -----------------------------------------------------------------------------
step "B. current first-80-lines hash"
if [[ -s "$WORK/dialplan-show.txt" ]]; then
  CURRENT_BASELINE_SHA="$(head -n 80 "$WORK/dialplan-show.txt" | sha256sum | awk '{print $1}')"
  note "current  = $CURRENT_BASELINE_SHA"
  note "expected = $EXPECTED_BASELINE_SHA"
  if [[ "$CURRENT_BASELINE_SHA" == "$EXPECTED_BASELINE_SHA" ]]; then
    note "MATCH -- live trk-${TRUNK_ID}-dial matches installer baseline"
  else
    note "MISMATCH -- live trk-${TRUNK_ID}-dial has DRIFTED from installer baseline"
  fi
else
  note "(skipped: dialplan show produced no output)"
fi

# -----------------------------------------------------------------------------
# C. invariant checks (pattern + pri 21 / 22 / 44)
# -----------------------------------------------------------------------------
step "C. structural invariants required by the wrapper"

if [[ -s "$WORK/dialplan-show.txt" ]]; then
  # Pattern
  if grep -F -- "'$EXPECTED_PATTERN'" "$WORK/dialplan-show.txt" >/dev/null; then
    PATTERN_PRESENT="yes"
    printf '  [PASS] exact pattern present: %s\n' "'$EXPECTED_PATTERN'"
  else
    PATTERN_PRESENT="no"
    printf '  [FAIL] exact pattern NOT present: %s\n' "'$EXPECTED_PATTERN'"
    printf '         (patterns actually merged into [%s]):\n' "$TRK_CTX"
    awk '
      match($0, /^[[:space:]]*\047([^\047]+)\047/, a){print "           " a[1]}
    ' "$WORK/dialplan-show.txt" | sort -u || true
  fi

  # Priority 21
  PRI21_LINE="$(awk '/[[:space:]]21\./{print; exit}' "$WORK/dialplan-show.txt")"
  if printf '%s' "$PRI21_LINE" | grep -qF 'CHANNEL(musicclass)=default'; then
    PRI21_OK="yes"
    printf '  [PASS] priority 21 contains CHANNEL(musicclass)=default\n'
  else
    PRI21_OK="no"
    printf '  [FAIL] priority 21 does NOT contain CHANNEL(musicclass)=default\n'
    printf '         pri 21 line: %s\n' "${PRI21_LINE:-(not found)}"
  fi

  # Priority 22
  PRI22_LINE="$(awk '/[[:space:]]22\./{print; exit}' "$WORK/dialplan-show.txt")"
  if printf '%s' "$PRI22_LINE" | grep -qF '__TRUNK_MOH_SET=yes'; then
    PRI22_OK="yes"
    printf '  [PASS] priority 22 contains __TRUNK_MOH_SET=yes\n'
  else
    PRI22_OK="no"
    printf '  [FAIL] priority 22 does NOT contain __TRUNK_MOH_SET=yes\n'
    printf '         pri 22 line: %s\n' "${PRI22_LINE:-(not found)}"
  fi

  # Priority 44 (U-flag hook with ${TENANT})
  PRI44_LINE="$(awk '/[[:space:]]44\./{print; exit}' "$WORK/dialplan-show.txt")"
  if printf '%s' "$PRI44_LINE" | grep -qF 'U(sub-before-bridging-call^${TENANT}'; then
    PRI44_OK="yes"
    printf '  [PASS] priority 44 contains U(sub-before-bridging-call^${TENANT}...\n'
  else
    PRI44_OK="no"
    printf '  [FAIL] priority 44 does NOT contain U(sub-before-bridging-call^${TENANT}...\n'
    printf '         pri 44 line: %s\n' "${PRI44_LINE:-(not found)}"
  fi
else
  note "(skipped: no dialplan output to evaluate)"
fi

# -----------------------------------------------------------------------------
# D. upstream call sites into trk-33-dial
# -----------------------------------------------------------------------------
step "D. upstream call sites that route into [$TRK_CTX]"
UPSTREAM_HITS_FILE="$WORK/upstream-hits.txt"
: >"$UPSTREAM_HITS_FILE"

# Grep across /etc/asterisk extension config files (NOT pjsip files; PJSIP
# does not reference dialplan contexts directly). Two passes so the operator
# can see both Goto-style and Dial-style entries side by side.
if compgen -G "$ASTERISK_EXT_GLOB" >/dev/null 2>&1; then
  grep -rEn '(Goto|GotoIf|Dial|Local)[^,]*trk-?'"$TRUNK_ID" $ASTERISK_EXT_GLOB \
    2>/dev/null >>"$UPSTREAM_HITS_FILE" || true
  grep -rEn "\[$TRK_CTX\]" $ASTERISK_EXT_GLOB \
    2>/dev/null >>"$UPSTREAM_HITS_FILE" || true
fi

if [[ -s "$UPSTREAM_HITS_FILE" ]]; then
  sort -u "$UPSTREAM_HITS_FILE" | indent
else
  note "(no upstream Goto/Dial/Local references to trk-${TRUNK_ID} found in $ASTERISK_EXT_GLOB)"
fi

# Also surface every Set(TENANT=...) in the same files; the wrapper assumes
# ${TENANT} is bound on the caller channel BEFORE trk-${TRUNK_ID}-dial runs.
step "D'. Set(TENANT=...) writers across $ASTERISK_EXT_GLOB"
TENANT_SETS_FILE="$WORK/tenant-sets.txt"
: >"$TENANT_SETS_FILE"
if compgen -G "$ASTERISK_EXT_GLOB" >/dev/null 2>&1; then
  grep -rEn 'Set\([[:space:]]*TENANT[[:space:]]*=' $ASTERISK_EXT_GLOB \
    2>/dev/null >>"$TENANT_SETS_FILE" || true
fi
if [[ -s "$TENANT_SETS_FILE" ]]; then
  sort -u "$TENANT_SETS_FILE" | indent
else
  note "(no Set(TENANT=...) writers found in $ASTERISK_EXT_GLOB)"
fi

# -----------------------------------------------------------------------------
# E. T*_* contexts/routes that reference trunk 33
# -----------------------------------------------------------------------------
step "E. distinct tenant prefixes (T<n>_*) referencing trk-${TRUNK_ID}"
TENANT_PREFIXES_FILE="$WORK/tenant-prefixes.txt"
: >"$TENANT_PREFIXES_FILE"

if [[ -s "$UPSTREAM_HITS_FILE" ]]; then
  # Extract T<digits>_ prefixes from upstream hit lines.
  awk '{
    while (match($0, /T[0-9]+_/)) {
      print substr($0, RSTART, RLENGTH);
      $0 = substr($0, RSTART + RLENGTH);
    }
  }' "$UPSTREAM_HITS_FILE" | sort -u >"$TENANT_PREFIXES_FILE"
fi

DISTINCT_TENANT_COUNT=0
if [[ -s "$TENANT_PREFIXES_FILE" ]]; then
  DISTINCT_TENANT_COUNT="$(wc -l <"$TENANT_PREFIXES_FILE" | tr -d ' ')"
  note "distinct T<n>_ prefixes referencing trk-${TRUNK_ID}: $DISTINCT_TENANT_COUNT"
  cat "$TENANT_PREFIXES_FILE" | indent
else
  note "(no T<n>_ prefixes found in upstream hits)"
fi

case "$DISTINCT_TENANT_COUNT" in
  0)
    TRUNK_SHARED_RISK="unknown"
    note "TRUNK_SHARED_RISK = unknown (no tenant-prefixed callers seen at all)"
    ;;
  1)
    TRUNK_SHARED_RISK="no"
    note "TRUNK_SHARED_RISK = no (exactly one tenant prefix references trk-${TRUNK_ID})"
    ;;
  *)
    TRUNK_SHARED_RISK="yes"
    note "TRUNK_SHARED_RISK = YES ($DISTINCT_TENANT_COUNT distinct tenant prefixes share trk-${TRUNK_ID})"
    ;;
esac

# -----------------------------------------------------------------------------
# F. ${TENANT} availability before pri 21 / 44 in [trk-33-dial]
# -----------------------------------------------------------------------------
step "F. \${TENANT} availability inside [$TRK_CTX] before priority 21/44"

if [[ -s "$WORK/dialplan-show.txt" ]]; then
  # Extract lines for priorities 1..20 (best-effort awk on " <N>. " marker).
  awk '
    /[[:space:]][0-9]+\./ {
      pri=$0; sub(/^[^0-9]*/, "", pri); sub(/\..*$/, "", pri); p=pri+0;
      if (p>=1 && p<=20) print $0;
    }
  ' "$WORK/dialplan-show.txt" >"$WORK/pri-1-20.txt"

  TENANT_INLINE_SET="no"
  TENANT_REFERENCED="no"
  if grep -qF 'Set(TENANT=' "$WORK/pri-1-20.txt" 2>/dev/null; then
    TENANT_INLINE_SET="yes"
  fi
  if grep -qF '${TENANT}' "$WORK/pri-1-20.txt" 2>/dev/null; then
    TENANT_REFERENCED="yes"
  fi

  note "Set(TENANT=...) in pri 1..20 of [$TRK_CTX]: $TENANT_INLINE_SET"
  note "\${TENANT} referenced in pri 1..20 of [$TRK_CTX]: $TENANT_REFERENCED"

  if [[ "$TENANT_INLINE_SET" == "yes" ]]; then
    TENANT_GUARD_SAFE="yes"
    note "TENANT_GUARD_SAFE = yes (TENANT_AVAILABLE_INLINE)"
  elif [[ "$PRI44_OK" == "yes" && -s "$TENANT_SETS_FILE" ]]; then
    # Pri 44 reads ${TENANT}, AND we found at least one Set(TENANT=...)
    # upstream in extensions*.conf. Channel inherits TENANT from caller.
    TENANT_GUARD_SAFE="yes"
    note "TENANT_GUARD_SAFE = yes (TENANT_AVAILABLE_INHERITED; pri 44 reads \${TENANT} and upstream Set(TENANT=...) writers exist)"
  elif [[ "$PRI44_OK" == "yes" && ! -s "$TENANT_SETS_FILE" ]]; then
    TENANT_GUARD_SAFE="no"
    note "TENANT_GUARD_SAFE = NO (pri 44 reads \${TENANT} but NO Set(TENANT=...) writers found upstream)"
  else
    TENANT_GUARD_SAFE="unknown"
    note "TENANT_GUARD_SAFE = unknown (cannot prove \${TENANT} is bound when wrapper would run)"
  fi
else
  note "(skipped: no dialplan output to evaluate)"
fi

# -----------------------------------------------------------------------------
# REBASE_SAFE decision
# -----------------------------------------------------------------------------
if [[ "$PATTERN_PRESENT" == "yes" \
   && "$PRI21_OK" == "yes" \
   && "$PRI22_OK" == "yes" \
   && "$PRI44_OK" == "yes" \
   && "$TENANT_GUARD_SAFE" == "yes" \
   && "$TRUNK_SHARED_RISK" != "yes" ]]; then
  REBASE_SAFE="yes"
  REASON="all structural invariants hold, TENANT bound, trunk not visibly shared; re-baseline candidate after architecture review"
elif [[ "$PATTERN_PRESENT" == "no" \
     || "$PRI21_OK" == "no" \
     || "$PRI22_OK" == "no" \
     || "$PRI44_OK" == "no" \
     || "$TENANT_GUARD_SAFE" == "no" \
     || "$TRUNK_SHARED_RISK" == "yes" ]]; then
  REBASE_SAFE="no"
  if [[ "$TRUNK_SHARED_RISK" == "yes" ]]; then
    REASON="trunk ${TRUNK_ID} is shared across multiple tenant prefixes; trunk-wide wrapper assumption is unsafe"
  elif [[ "$TENANT_GUARD_SAFE" == "no" ]]; then
    REASON="\${TENANT} cannot be proven bound on the caller channel when wrapper runs"
  else
    REASON="one or more structural invariants (pattern / pri 21 / pri 22 / pri 44) are broken on the live PBX"
  fi
else
  REBASE_SAFE="unknown"
  if [[ -z "$REASON" ]]; then
    REASON="insufficient evidence to decide (one or more probes returned unknown)"
  fi
fi

# -----------------------------------------------------------------------------
# G. PROOF block (machine-readable)
# -----------------------------------------------------------------------------
step "G. PROOF"
cat <<EOF
PROOF:
  CURRENT_BASELINE_SHA256  = $CURRENT_BASELINE_SHA
  EXPECTED_BASELINE_SHA256 = $EXPECTED_BASELINE_SHA
  PATTERN_PRESENT          = $PATTERN_PRESENT
  PRI21_OK                 = $PRI21_OK
  PRI22_OK                 = $PRI22_OK
  PRI44_OK                 = $PRI44_OK
  TENANT_GUARD_SAFE        = $TENANT_GUARD_SAFE
  TRUNK_SHARED_RISK        = $TRUNK_SHARED_RISK
  REBASE_SAFE              = $REBASE_SAFE
  reason                   = "$REASON"
EOF

case "$REBASE_SAFE" in
  yes)     exit 0 ;;
  no)      exit 1 ;;
  *)       exit 2 ;;
esac
