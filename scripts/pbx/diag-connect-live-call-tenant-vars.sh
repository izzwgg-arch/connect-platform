#!/usr/bin/env bash
# diag-connect-live-call-tenant-vars.sh
# =============================================================================
# Read-only live-call introspection for the Connect canary-wrapper safety
# harness. Operator runs THIS while a tenant test call is actively up
# (e.g. T3 outbound to a known external number, kept on the line).
#
# Goal: identify which channel variable / channel attribute is a SAFE
# source of tenant identity that the wrapper could gate on. The user
# rule is: never trust ${TENANT} alone, because it can be empty or
# inherited from another tenant. This script collects evidence for an
# operator + architecture review to choose a safer source.
#
# Hard guarantees:
#   - NEVER edits /etc/asterisk/ or any service config.
#   - NEVER reloads / restarts asterisk, pjsip, dialplan.
#   - NEVER places or originates a call. Operator must already have a
#     live test call up before invoking.
#   - Issues only read-only `asterisk -rx "core show channel(s)"` and
#     `asterisk -rx "dialplan eval"` against the live channel.
#
# Usage (run as root on the PBX, READ-ONLY, with a live test call up):
#   sudo bash diag-connect-live-call-tenant-vars.sh [--tenant-id N] [--ext E]
#
# Defaults:
#   --tenant-id 3         (T3)
#   --ext       (none)    (optional further filter by extension)
#
# Exit codes (mirrors PROOF.SAFE_TENANT_SOURCE):
#   0  -> SAFE_TENANT_SOURCE != none (endpoint | channel | CALL_SOURCE)
#   1  -> SAFE_TENANT_SOURCE = none  (no safe tenant identity proven)
#   2  -> no candidate channel found (operator must place a call first)
# =============================================================================

set -uo pipefail

TENANT_ID="3"
EXT_FILTER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant-id) TENANT_ID="$2"; shift 2 ;;
    --ext)       EXT_FILTER="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,40p' "$0"; exit 0 ;;
    *)
      printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  printf 'must be run as root to call asterisk -rx.\n' >&2
  exit 2
fi

if [[ ! "$TENANT_ID" =~ ^[0-9]+$ ]]; then
  printf 'invalid --tenant-id: %s\n' "$TENANT_ID" >&2
  exit 2
fi

TENANT_PREFIX="T${TENANT_ID}_"

WORK="$(mktemp -d -t diag-live-call.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

step()   { printf '\n=== %s ===\n' "$*"; }
note()   { printf '  - %s\n' "$*"; }
warn()   { printf '  ! %s\n' "$*" >&2; }
indent() { sed 's/^/    /'; }

# -----------------------------------------------------------------------------
# 0. environment
# -----------------------------------------------------------------------------
step "0. environment"
note "tenant id     = $TENANT_ID"
note "tenant prefix = $TENANT_PREFIX"
note "ext filter    = ${EXT_FILTER:-(none)}"
note "asterisk      = $(asterisk -V 2>&1 | head -1)"

if ! asterisk -rx 'core show version' >/dev/null 2>&1; then
  warn "asterisk CLI unreachable"
  exit 2
fi

# -----------------------------------------------------------------------------
# 1. enumerate active channels (concise form)
# -----------------------------------------------------------------------------
step "1. active channels (concise)"
asterisk -rx 'core show channels concise' >"$WORK/concise.txt" 2>&1 || true

# Asterisk concise channel rows are pipe-delimited:
#   Channel!Context!Extension!Priority!State!Application!Data!CallerID!\
#   Duration!Accountcode!PeerAccount!BridgeID!Uniqueid!Linkedid|...
# Field 1 = Channel, field 2 = Context, field 3 = Extension.
awk -F'!' '
  NF >= 3 {
    # Skip the trailing summary line which has no `!`.
    if ($1 ~ /^[0-9]+ active|active channels?$/) next;
    printf "  %-50s | ctx=%-30s | ext=%s\n", $1, $2, $3;
  }
' "$WORK/concise.txt"

# Filter T<id> candidates by channel-name prefix OR by context prefix.
# Channel-name prefix is the SAFER signal (it is the SIP endpoint name as
# Asterisk created the channel from), context prefix is a fallback for
# legacy from-internal-T<id>-* contexts.
awk -F'!' -v pfx="$TENANT_PREFIX" -v ctxpfx="T${TENANT_ID}_" -v ext="$EXT_FILTER" '
  NF >= 3 {
    if ($1 ~ /^[0-9]+ active|active channels?$/) next;
    chan = $1; ctx = $2; xt = $3;
    keep = 0;
    if (index(chan, "PJSIP/" pfx) == 1)                keep = 1;
    if (substr(ctx, 1, length(ctxpfx)) == ctxpfx)      keep = 1;
    if (ctx ~ /^from-internal-T[0-9]+/)                keep = 1;
    if (ext != "" && xt != ext)                        keep = 0;
    if (keep) print chan;
  }
' "$WORK/concise.txt" | sort -u >"$WORK/candidates.txt"

CAND_COUNT="$(wc -l <"$WORK/candidates.txt" | tr -d ' ')"
note "T${TENANT_ID} candidate channels: $CAND_COUNT"
if [[ "$CAND_COUNT" -eq 0 ]]; then
  warn "no candidate channels found. Place an active T${TENANT_ID} call and re-run."
  exit 2
fi

# Also surface candidate trunk-leg channels so the operator can see the
# called/trunk leg (PJSIP/<trunk-endpoint>-XXX). We will not gate any
# decision on the trunk leg, but it is useful to print.
awk -F'!' '
  NF >= 3 {
    if ($1 ~ /^[0-9]+ active|active channels?$/) next;
    chan = $1; ctx = $2;
    # Heuristic: trunk-leg channels usually have Context = trk-<id>-dial
    # or =macro-dial-one, and Channel does NOT have a T<id>_ endpoint
    # prefix.
    if (ctx ~ /^trk-[0-9]+-dial$/ || ctx ~ /^macro-dial-one$/) print chan;
  }
' "$WORK/concise.txt" | sort -u >"$WORK/trunk-candidates.txt"

# -----------------------------------------------------------------------------
# 2. for each candidate channel, read variables
# -----------------------------------------------------------------------------
step "2. per-channel variable dump"

# Vars the wrapper might gate on. ${TENANT} is included for visibility
# only; it is explicitly NOT a SAFE source.
VARS=(
  TENANT
  TENANT_PREFIX
  CALL_SOURCE
  ORIGINATOR
  __TRUNK_MOH_SET
  CONNECT_MOH
)

# Helper: read a single CHANNEL variable via dialplan eval. Empty / unset
# vars come back as the literal string "" or "(null)" depending on build;
# we normalize to "(empty)".
read_chan_var() {
  local chan="$1" var="$2"
  local raw
  raw="$(asterisk -rx "dialplan eval CHANNEL(chanvar:${var})@${chan}" 2>&1 || true)"
  # The output is typically: '<value>' or just <value>
  raw="$(printf '%s' "$raw" | head -1 | sed -e 's/^Result: //' -e "s/^'//; s/'$//")"
  if [[ -z "$raw" || "$raw" == "(null)" || "$raw" == 'No such function' ]]; then
    printf '(empty)'
  else
    printf '%s' "$raw"
  fi
}

# Helper: read a CHANNEL() function field (e.g. name, endpoint).
read_chan_func() {
  local chan="$1" field="$2"
  local raw
  raw="$(asterisk -rx "dialplan eval CHANNEL(${field})@${chan}" 2>&1 || true)"
  raw="$(printf '%s' "$raw" | head -1 | sed -e 's/^Result: //' -e "s/^'//; s/'$//")"
  if [[ -z "$raw" || "$raw" == "(null)" ]]; then
    printf '(empty)'
  else
    printf '%s' "$raw"
  fi
}

# Tracking for PROOF.
T_CALLER_LEG_FOUND="no"
T_CALLER_CHANNEL="n/a"
T_CALLER_ENDPOINT="n/a"
T_CALLER_MUSICCLASS="n/a"
T_CALLER_TENANT_CHANVAR=""
T_CALLER_CALL_SOURCE=""
TRUNK_LEG_FOUND="no"
TRUNK_CHANNEL="n/a"
TRUNK_MUSICCLASS="n/a"
TRUNK_MOH_SET_CHANVAR=""
CONNECT_MOH_CHANVAR=""

while IFS= read -r chan; do
  [[ -z "$chan" ]] && continue
  printf '\n  -- channel: %s\n' "$chan"

  # Full human-readable dump (for the operator's eyes).
  asterisk -rx "core show channel ${chan}" >"$WORK/csc.txt" 2>&1 || true
  # Print only the most useful lines so the diagnostic is scannable.
  awk '
    /^[ \t]*Context:|^[ \t]*Extension:|^[ \t]*Priority:|^[ \t]*Application:|^[ \t]*Data:|MusicClass:|^[ \t]*State:|^[ \t]*BridgeID:|^[ \t]*Originating Channel|^[ \t]*Caller ID|^[ \t]*Connected Line/ {
      print "      " $0;
    }
  ' "$WORK/csc.txt"

  # Read channel function fields.
  CF_NAME="$(read_chan_func "$chan" "name")"
  CF_ENDPOINT="$(read_chan_func "$chan" "endpoint")"
  CF_MUSICCLASS="$(read_chan_func "$chan" "musicclass")"
  printf '      CHANNEL(name)      = %s\n' "$CF_NAME"
  printf '      CHANNEL(endpoint)  = %s\n' "$CF_ENDPOINT"
  printf '      CHANNEL(musicclass)= %s\n' "$CF_MUSICCLASS"

  # Read each tenant-relevant chanvar.
  declare -A V=()
  for v in "${VARS[@]}"; do
    V[$v]="$(read_chan_var "$chan" "$v")"
    printf '      %-18s = %s\n' "$v" "${V[$v]}"
  done

  # Leg classification:
  #   caller leg = channel name (PJSIP/<endpoint>-XXX) whose endpoint
  #               prefix matches T<id>_
  #   trunk leg  = context == trk-<id>-dial  OR  channel endpoint name
  #               does NOT match T<id>_ AND endpoint matches the trunk
  #               naming convention.
  IS_CALLER_LEG="no"
  IS_TRUNK_LEG="no"
  if [[ "$chan" == PJSIP/${TENANT_PREFIX}* || "$CF_ENDPOINT" == ${TENANT_PREFIX}* ]]; then
    IS_CALLER_LEG="yes"
  fi
  # Re-scan concise rows for THIS channel's context.
  CHAN_CTX="$(awk -F'!' -v c="$chan" '$1==c{print $2; exit}' "$WORK/concise.txt")"
  if [[ "$CHAN_CTX" =~ ^trk-[0-9]+-dial$ ]]; then
    IS_TRUNK_LEG="yes"
  fi
  printf '      classification     = caller_leg=%s trunk_leg=%s\n' \
    "$IS_CALLER_LEG" "$IS_TRUNK_LEG"

  if [[ "$IS_CALLER_LEG" == "yes" ]]; then
    T_CALLER_LEG_FOUND="yes"
    T_CALLER_CHANNEL="$chan"
    T_CALLER_ENDPOINT="$CF_ENDPOINT"
    T_CALLER_MUSICCLASS="$CF_MUSICCLASS"
    T_CALLER_TENANT_CHANVAR="${V[TENANT]}"
    T_CALLER_CALL_SOURCE="${V[CALL_SOURCE]}"
  fi
  if [[ "$IS_TRUNK_LEG" == "yes" ]]; then
    TRUNK_LEG_FOUND="yes"
    TRUNK_CHANNEL="$chan"
    TRUNK_MUSICCLASS="$CF_MUSICCLASS"
    TRUNK_MOH_SET_CHANVAR="${V[__TRUNK_MOH_SET]}"
    CONNECT_MOH_CHANVAR="${V[CONNECT_MOH]}"
  fi
done <"$WORK/candidates.txt"

# Also iterate trunk-leg candidates we found earlier but that are not in
# the T<id>_ caller-leg list (covers trunk leg even when its channel
# name does NOT include a tenant prefix, which is the common case).
while IFS= read -r chan; do
  [[ -z "$chan" ]] && continue
  # Skip if already processed above.
  if grep -qxF "$chan" "$WORK/candidates.txt"; then continue; fi
  printf '\n  -- trunk-leg channel: %s\n' "$chan"
  CF_MUSICCLASS="$(read_chan_func "$chan" "musicclass")"
  CF_ENDPOINT="$(read_chan_func "$chan" "endpoint")"
  TRUNK_MOH_SET_VAL="$(read_chan_var "$chan" "__TRUNK_MOH_SET")"
  CONNECT_MOH_VAL="$(read_chan_var "$chan" "CONNECT_MOH")"
  TENANT_VAL="$(read_chan_var "$chan" "TENANT")"
  printf '      CHANNEL(musicclass)= %s\n' "$CF_MUSICCLASS"
  printf '      CHANNEL(endpoint)  = %s\n' "$CF_ENDPOINT"
  printf '      TENANT             = %s\n' "$TENANT_VAL"
  printf '      __TRUNK_MOH_SET    = %s\n' "$TRUNK_MOH_SET_VAL"
  printf '      CONNECT_MOH        = %s\n' "$CONNECT_MOH_VAL"
  TRUNK_LEG_FOUND="yes"
  TRUNK_CHANNEL="$chan"
  TRUNK_MUSICCLASS="$CF_MUSICCLASS"
  TRUNK_MOH_SET_CHANVAR="$TRUNK_MOH_SET_VAL"
  CONNECT_MOH_CHANVAR="$CONNECT_MOH_VAL"
done <"$WORK/trunk-candidates.txt"

# -----------------------------------------------------------------------------
# 3. SAFE_TENANT_SOURCE decision
# -----------------------------------------------------------------------------
step "3. SAFE_TENANT_SOURCE decision"

SAFE_TENANT_SOURCE="none"
SAFE_REASON=""

if [[ "$T_CALLER_LEG_FOUND" == "yes" ]]; then
  # 1. Prefer endpoint (pre-channel, not subject to chanvar inheritance).
  if [[ "$T_CALLER_ENDPOINT" == ${TENANT_PREFIX}* ]]; then
    SAFE_TENANT_SOURCE="endpoint"
    SAFE_REASON="CHANNEL(endpoint) is '${T_CALLER_ENDPOINT}' on caller leg; pre-channel value, not inheritable from another tenant"
  # 2. Fall back to channel name prefix.
  elif [[ "$T_CALLER_CHANNEL" == PJSIP/${TENANT_PREFIX}* ]]; then
    SAFE_TENANT_SOURCE="channel"
    SAFE_REASON="Channel name '${T_CALLER_CHANNEL}' starts with PJSIP/${TENANT_PREFIX}; channel-name is assigned at INVITE time"
  # 3. Fall back to an explicit CALL_SOURCE chanvar set by Connect-owned
  #    upstream dialplan.
  elif [[ -n "$T_CALLER_CALL_SOURCE" \
          && "$T_CALLER_CALL_SOURCE" != "(empty)" \
          && "$T_CALLER_CALL_SOURCE" =~ ^T${TENANT_ID}$|^tenant=${TENANT_ID}$|^T${TENANT_ID}_ ]]; then
    SAFE_TENANT_SOURCE="CALL_SOURCE"
    SAFE_REASON="CALL_SOURCE chanvar is '${T_CALLER_CALL_SOURCE}'; must be set by Connect-owned upstream dialplan only"
  else
    SAFE_REASON="caller leg found (${T_CALLER_CHANNEL}) but no safe tenant identity attribute matched"
  fi
else
  SAFE_REASON="no T${TENANT_ID} caller leg active during snapshot"
fi

# -----------------------------------------------------------------------------
# 4. PROOF block
# -----------------------------------------------------------------------------
step "4. PROOF"
cat <<EOF
PROOF:
  T${TENANT_ID}_CALLER_LEG_FOUND       = $T_CALLER_LEG_FOUND
  T${TENANT_ID}_CALLER_CHANNEL         = $T_CALLER_CHANNEL
  T${TENANT_ID}_CALLER_ENDPOINT        = $T_CALLER_ENDPOINT
  T${TENANT_ID}_CALLER_MUSICCLASS      = $T_CALLER_MUSICCLASS
  T${TENANT_ID}_CALLER_TENANT_CHANVAR  = ${T_CALLER_TENANT_CHANVAR:-(empty)}
  T${TENANT_ID}_CALLER_CALL_SOURCE     = ${T_CALLER_CALL_SOURCE:-(empty)}
  TRUNK_LEG_FOUND                      = $TRUNK_LEG_FOUND
  TRUNK_CHANNEL                        = $TRUNK_CHANNEL
  TRUNK_MUSICCLASS                     = $TRUNK_MUSICCLASS
  TRUNK_MOH_SET_CHANVAR                = ${TRUNK_MOH_SET_CHANVAR:-(empty)}
  CONNECT_MOH_CHANVAR                  = ${CONNECT_MOH_CHANVAR:-(empty)}
  SAFE_TENANT_SOURCE                   = $SAFE_TENANT_SOURCE
  reason                               = "$SAFE_REASON"
EOF

case "$SAFE_TENANT_SOURCE" in
  endpoint|channel|CALL_SOURCE) exit 0 ;;
  *)                            exit 1 ;;
esac
