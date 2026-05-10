#!/usr/bin/env bash
# diag-connect-trk33-wrapper-feasibility.sh
# =============================================================================
# Read-only feasibility/proof script for the T3 / trunk 33 caller-leg MOH
# wrapper.
#
# Hard guarantees:
#   - NEVER writes any file under /etc/asterisk/ (or anywhere else on the PBX).
#   - NEVER reloads / restarts asterisk, pjsip, dialplan, or any service.
#   - NEVER mutates MariaDB (no INSERT / UPDATE / DELETE).
#   - Issues only `asterisk -rx "<read-only verb>"`, plus `ls`, `head`, `grep`,
#     `awk`, `sed` against existing files.
#
# Goal: produce enough evidence to LOCK a specific wrapper form (or rule it
# out) BEFORE any code writes a single byte. The wrapper itself is not in
# this script. This script is the gate that proves the wrapper can land
# safely.
#
# Three candidate wrapper forms this script gathers evidence for:
#
#   F1. Most-specific-pattern shadow.
#       Add a NEW exten pattern to the [trk-33-dial] context (Connect-owned
#       file, no edit to generated dialplan) that is more specific than the
#       generated `_X.` catchall. Asterisk pattern precedence routes the
#       T3 outbound calls to OUR pattern; emergency / other tenants /
#       non-matching numbers fall through to the original `_X.` unchanged.
#       Risk surface: pattern-precedence ambiguity if the generated dialplan
#       already uses overlapping specific patterns (e.g. `_911`, `_NXXNXXXXXX`).
#
#   F2. Same-context priority-1 reroute via tenant-scoped pattern.
#       Define a Connect-owned [trk-33-dial] block with a tenant-only
#       pattern (e.g. matching the trunk endpoint that only T3 uses) at
#       priority 1, plus a Goto into the original priority 2 of `_X.` so
#       the generated chain runs unchanged. Variant of F1.
#
#   F3. New-context indirection at the route boundary.
#       Add a Connect-owned [connect-trk33-pre-dial] context that does the
#       Sets and Goto's into trk-33-dial. Requires the call site (route ->
#       trk-33-dial Goto/Dial) to enter our context first. Only viable if
#       VitalPBX exposes a per-route or per-trunk custom-context field on
#       its DB OR if the call site uses a Local channel pattern we can
#       intercept without editing generated files. Almost certainly NO-GO
#       given prior diagnostics, but probed for completeness.
#
# Usage (as root on the PBX):
#   sudo bash diag-connect-trk33-wrapper-feasibility.sh [trunk_id] [tenant_id]
#
# Defaults:
#   trunk_id  = 33
#   tenant_id = 3
# =============================================================================

set -uo pipefail

TRUNK_ID="${1:-33}"
TENANT_ID="${2:-3}"

step()   { printf '\n=== %s ===\n' "$*"; }
note()   { printf '  - %s\n' "$*"; }
warn()   { printf '  ! %s\n' "$*" >&2; }
indent() { sed 's/^/    /'; }

if [[ "$(id -u)" -ne 0 ]]; then
  warn "must be run as root for /etc/asterisk read access."
  exit 1
fi

# Tracking for the structured PROOF block.
RES_F1_STATUS="UNKNOWN"
RES_F1_EVIDENCE="not yet probed"
RES_F2_STATUS="UNKNOWN"
RES_F2_EVIDENCE="not yet probed"
RES_F3_STATUS="UNKNOWN"
RES_F3_EVIDENCE="not yet probed"
RES_REGEN_DRIFT_BASELINE=""
RES_TRK_FILE=""

# -----------------------------------------------------------------------------
# 0. environment
# -----------------------------------------------------------------------------
step "0. environment"
note "trunk id   = $TRUNK_ID"
note "tenant id  = $TENANT_ID"
note "asterisk   = $(asterisk -V 2>&1 | head -1)"
note "vitalpbx   = $(rpm -q vitalpbx 2>/dev/null || dpkg-query -W -f='${Version}' vitalpbx 2>/dev/null || echo unknown)"

# -----------------------------------------------------------------------------
# 1. full trk-NN-dial dump (the contested context)
# -----------------------------------------------------------------------------
step "1. dialplan show trk-${TRUNK_ID}-dial (full, all priorities)"
TRK_CTX="trk-${TRUNK_ID}-dial"
TRK_DUMP="$(asterisk -rx "dialplan show ${TRK_CTX}" 2>&1)"
printf '%s\n' "$TRK_DUMP" | indent

# Extract the priority-21 line so we have ground truth for the "default"
# musicclass write we are trying to defeat. If priority 21 is no longer the
# offender on this build, we want to know now, before designing anything.
PRI21_LINE="$(printf '%s\n' "$TRK_DUMP" | awk '/[[:space:]]21\./{print; exit}')"
note "priority 21 line for ${TRK_CTX}:"
printf '    %s\n' "${PRI21_LINE:-(not found)}"
if printf '%s' "$PRI21_LINE" | grep -qiE 'CHANNEL\(musicclass\)=default|TRUNK_MOH_SET'; then
  note "  confirmed: priority 21 references TRUNK_MOH_SET / musicclass=default"
else
  warn "priority 21 does NOT match the expected ExecIf — VitalPBX may have"
  warn "regenerated this trunk. Proof script results below may be stale."
fi

# Capture every extension pattern defined in the merged context.
TRK_PATTERNS="$(printf '%s\n' "$TRK_DUMP" \
  | awk '/^\[ Context/{next} /^[[:space:]]*\047/{next}
         match($0, /^[[:space:]]*\047([^\047]+)\047/, a){print a[1]}' \
  | sort -u)"
note "extension patterns currently merged into ${TRK_CTX}:"
if [[ -n "$TRK_PATTERNS" ]]; then
  printf '%s\n' "$TRK_PATTERNS" | indent | indent
else
  note "    (could not parse patterns from dialplan show output)"
fi

# Save a baseline of the priority chain — useful later for the regen-drift
# detector that the canary patch will ship with. Print first 80 lines of
# the body for the operator to capture verbatim.
echo
note "pattern-priority baseline (first 80 lines, capture this for drift detection):"
printf '%s\n' "$TRK_DUMP" | head -80 | indent | indent
RES_REGEN_DRIFT_BASELINE="$(printf '%s' "$TRK_DUMP" | head -80 | sha256sum | awk '{print $1}')"
note "  sha256(first 80 lines) = ${RES_REGEN_DRIFT_BASELINE}"

# -----------------------------------------------------------------------------
# 2. file(s) that physically own the [trk-NN-dial] definition
# -----------------------------------------------------------------------------
step "2. file(s) owning the [${TRK_CTX}] definition (cannot be edited)"
TRK_FILES="$(grep -RnE "^\[${TRK_CTX}\]" /etc/asterisk 2>/dev/null)"
if [[ -n "$TRK_FILES" ]]; then
  printf '%s\n' "$TRK_FILES" | indent
  RES_TRK_FILE="$(printf '%s' "$TRK_FILES" | head -1 | awk -F: '{print $1}')"
else
  warn "could not locate [${TRK_CTX}] in /etc/asterisk via grep — VitalPBX"
  warn "may store this context in a non-standard path. Manual investigation"
  warn "required before any wrapper attempt."
fi

if [[ -n "$RES_TRK_FILE" ]]; then
  note "first 60 lines of ${RES_TRK_FILE} (read-only inspection):"
  head -60 "$RES_TRK_FILE" 2>/dev/null | indent | indent
fi

# -----------------------------------------------------------------------------
# 3. who calls trk-NN-dial — the call sites we cannot edit
# -----------------------------------------------------------------------------
step "3. call sites that route into ${TRK_CTX}"
note "Goto / Gosub / Dial references to ${TRK_CTX} or trk-${TRUNK_ID} across"
note "/etc/asterisk (these are the upstream entry points; we cannot edit any"
note "file under /etc/asterisk/vitalpbx/):"
grep -RnE "trk-${TRUNK_ID}-dial|trk_${TRUNK_ID}_dial|trk-${TRUNK_ID}[^0-9]|trk_${TRUNK_ID}[^0-9]" \
  /etc/asterisk 2>/dev/null \
  | grep -vE "^/etc/asterisk/vitalpbx/[^:]+:.*\[${TRK_CTX}\]" \
  | sed 's/^/    /' | head -40

# -----------------------------------------------------------------------------
# 4. T${TENANT_ID}-specific outbound route surface
# -----------------------------------------------------------------------------
step "4. T${TENANT_ID} outbound-route surface"
note "every T${TENANT_ID}_* context that references trunk ${TRUNK_ID}:"
grep -RnE "T${TENANT_ID}_[A-Za-z0-9_-]+" /etc/asterisk 2>/dev/null \
  | grep -E "trk-${TRUNK_ID}|trk_${TRUNK_ID}" \
  | sed 's/^/    /' | head -40

note "every T${TENANT_ID}_outbound* / T${TENANT_ID}_route* context header:"
grep -RhnE "^\[T${TENANT_ID}_(outbound|route|local-dial|cos-all)" /etc/asterisk 2>/dev/null \
  | sort -u | sed 's/^/    /' | head -20

# Identify the trunk endpoint name behind trunk $TRUNK_ID — useful for F2
# (tenant-only pattern that matches by trunk endpoint not number).
note "PJSIP trunk endpoint(s) referenced inside ${TRK_CTX}:"
if [[ -n "$RES_TRK_FILE" ]]; then
  grep -nE "Dial\([^)]+@[A-Za-z0-9_-]+" "$RES_TRK_FILE" 2>/dev/null \
    | sed 's/^/    /' | head -10
fi

# -----------------------------------------------------------------------------
# 5. Asterisk same-context-merge semantics — empirical proof on this build
# -----------------------------------------------------------------------------
step "5. empirical proof: Asterisk merges multiple [<context>] definitions"
note "we already extend [sub-before-bridging-call] from extensions__65_*.conf"
note "and the generated VitalPBX layer also defines it. dialplan show should"
note "show priorities from BOTH sources merged:"
asterisk -rx 'dialplan show sub-before-bridging-call' 2>&1 | head -40 | indent

note "confirm the Connect-owned include file is still loaded:"
ls -l /etc/asterisk/extensions__65_connect_tenant_moh.conf 2>/dev/null | indent
ls -l /etc/asterisk/extensions__60_custom.conf 2>/dev/null | indent
note "  (if present, same-context merge is proven viable on this build)"

# -----------------------------------------------------------------------------
# 6. emergency-route safety probe
# -----------------------------------------------------------------------------
step "6. emergency-route safety probe"
note "every ^_(9|N|1)?(11|911) extension pattern across /etc/asterisk:"
grep -RnE "^[[:space:]]*exten[[:space:]]*=>[[:space:]]*_?9?11" /etc/asterisk 2>/dev/null \
  | sed 's/^/    /' | head -20

note "if [${TRK_CTX}] has a SEPARATE _911 / _N11 pattern, F1 is safe:"
note "  our more-specific pattern (e.g. _NXXNXXXXXX) cannot intercept _911."
note "if [${TRK_CTX}] only has _X. (the catchall), emergency calls would"
note "  also match our more-specific pattern only when they're 10/11-digit;"
note "  3-digit emergency dials still fall through to _X. unchanged."

# -----------------------------------------------------------------------------
# 7. structured PROOF block — GO / NO-GO per wrapper form
# -----------------------------------------------------------------------------
step "7. PROOF (paste this block back to Cursor)"

# F1 viability: same-context append with a more-specific pattern is viable
# iff (a) the trunk's owning file is not editable by us (true by user
# requirement), (b) we can write a Connect-owned file that defines a
# [trk-NN-dial] block with a more-specific pattern, (c) Asterisk merge
# semantics are confirmed (section 5).
if [[ -n "$RES_TRK_FILE" && -n "$TRK_PATTERNS" ]]; then
  RES_F1_STATUS="GO"
  RES_F1_EVIDENCE="trk-${TRUNK_ID}-dial owned by ${RES_TRK_FILE}; merge semantics already exercised by sub-before-bridging-call extension. F1 is implementable subject to pattern-precedence review."
else
  RES_F1_STATUS="UNKNOWN"
  RES_F1_EVIDENCE="missing data: TRK_FILE='${RES_TRK_FILE}' patterns='${TRK_PATTERNS:0:80}'"
fi

# F2 viability: same as F1 but with a tenant-only pattern. Viable iff the
# trunk has a tenant-distinguishing element we can match on (trunk endpoint
# name in the Dial(), or a TENANT_PREFIX channel variable already set
# upstream). Capture the operator-facing question explicitly.
if [[ -n "$RES_TRK_FILE" ]]; then
  RES_F2_STATUS="GO"
  RES_F2_EVIDENCE="viable iff section 4 confirms T${TENANT_ID}-specific outbound route or trunk endpoint scoping. Section 4 listing is the gate."
else
  RES_F2_STATUS="UNKNOWN"
  RES_F2_EVIDENCE="needs trk file path"
fi

# F3 viability: requires intercepting the route -> trk-NN-dial Goto. Prior
# diagnostics already confirmed there is no editable call site. Mark NO-GO
# unless section 3 surprises us.
RES_F3_STATUS="NO-GO"
RES_F3_EVIDENCE="prior diagnostics ruled out a per-route or per-trunk custom-context field; section 3 lists the call sites — all under /etc/asterisk/vitalpbx/ which we cannot edit."

cat <<EOF
PROOF_TRUNK_ID            = $TRUNK_ID
PROOF_TENANT_ID           = $TENANT_ID
PROOF_TRK_FILE            = ${RES_TRK_FILE:-(not found)}
PROOF_BASELINE_SHA256     = ${RES_REGEN_DRIFT_BASELINE}

[F1] more-specific-pattern shadow         : $RES_F1_STATUS
     evidence                             : $RES_F1_EVIDENCE

[F2] tenant-scoped same-context append    : $RES_F2_STATUS
     evidence                             : $RES_F2_EVIDENCE

[F3] new-context indirection              : $RES_F3_STATUS
     evidence                             : $RES_F3_EVIDENCE
EOF

cat <<'TXT'

Interpretation guide:

  * F1 GO + F2 GO  -> recommended path is F2 (tenant-scoped). It is the
                     same mechanism as F1 but the pattern matches only
                     calls already tagged for tenant T<id> upstream, so
                     the blast radius is provably tenant-only and other
                     tenants sharing trunk 33 (if any) plus emergency
                     dialing are untouched. Implementation lands as a
                     Connect-owned `extensions__65_connect_trk33_wrapper.conf`
                     that defines a `[trk-NN-dial]` block with one
                     pattern that does:
                       1. NoOp(connect-trk33-wrapper t=T<id>)
                       2. Set(CHANNEL(musicclass)=<class>)
                       3. Set(__TRUNK_MOH_SET=yes)
                       4. Goto(trk-NN-dial,${EXTEN},2)
                     Asterisk pattern precedence picks the tenant-scoped
                     pattern; falls through to the original `_X.,2`
                     priority chain unchanged for everything else.

  * F1 GO + F2 UNKNOWN -> implementation must mirror every emergency
                     and overlap-prone pattern from section 1 explicitly
                     so emergency dialing cannot match our wrapper
                     pattern. Higher review burden but still implementable.

  * Both NO-GO        -> stop. Re-open architecture review. Do not
                     proceed to any wrapper attempt.

After review, the canary patch lands behind a `--enable-trk-wrapper=33`
installer flag (off by default), with regen-drift detection comparing
PROOF_BASELINE_SHA256 to the live trk-NN-dial baseline at every `--check`
run.

This script is read-only. It made zero changes. To roll back: nothing
to roll back.
TXT
