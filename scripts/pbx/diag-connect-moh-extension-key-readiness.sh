#!/usr/bin/env bash
# diag-connect-moh-extension-key-readiness.sh
# =============================================================================
# Read-only PBX-state probe that proves the AstDB per-extension MOH override
# family (Phase 3A writer, resolver planned for Phase 3B) is structurally
# sound on this host BEFORE any resolver install/edit ships.
#
# Hard guarantees:
#   - NEVER edits /etc/asterisk, MariaDB, the AstDB, or any service config.
#     The only writes are to an operator-owned snapshot dir under
#     /root/connect-moh-safety/<timestamp>-ext-key-readiness/ for forensics.
#   - NEVER reloads / restarts asterisk, pjsip, dialplan, or any service.
#   - NEVER places a call.
#   - Issues only read-only asterisk -rx verbs:
#       "database show connect"
#       "moh show classes"
#       "core show function CHANNEL"
#       "core show version"
#     Plus local `awk`, `grep`, `sort`, `wc` against the captured output.
#
# Usage (run as root on the PBX):
#   sudo bash diag-connect-moh-extension-key-readiness.sh [--tag <label>]
#
# Probes:
#   1. asterisk -rx responsive                                        [HARD]
#   2. connect/pbx_tenant_map has >=1 tenant                          [HARD]
#   3. Every mapped tenant has non-empty connect/t_<slug>/moh_class   [HARD]
#   4. Enumerate connect/t_*/extensions/*/moh_class families          [INFO]
#   5. Every per-extension family's slug is in the reverse-map        [HARD]
#   6. Every per-extension moh_class value is in `moh show classes`   [HARD]
#   7. Every per-extension family has matching active_moh_class       [SOFT]
#   8. Empty-string moh_class tombstones are counted, not failed      [INFO]
#   9. CHANNEL(pjsip,endpoint) availability on this Asterisk build    [SOFT]
#  10. `moh show classes` returned at least one class                 [HARD]
#
# Exit codes:
#   0   all HARD probes passed. Phase 3B resolver may proceed to install gate.
#   1   one or more HARD probes FAILED. Do NOT install the Phase 3B resolver.
#   2   the script itself could not run (asterisk CLI unreachable, not root,
#       snapshot dir not creatable).
#
# The snapshot dir written by this script is informational only. Asterisk
# does not read it and it is safe to remove.
# =============================================================================

set -uo pipefail

TAG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,46p' "$0"
      exit 0
      ;;
    *)
      printf 'unknown arg: %s (try --help)\n' "$1" >&2
      exit 2
      ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  printf 'must be run as root (asterisk -rx + /root/connect-moh-safety write)\n' >&2
  exit 2
fi

command -v asterisk >/dev/null 2>&1 || {
  printf 'asterisk binary not in PATH\n' >&2
  exit 2
}

if ! asterisk -rx 'core show channels count' >/dev/null 2>&1; then
  printf 'asterisk -rx unresponsive — is Asterisk running?\n' >&2
  exit 2
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -n "$TAG" ]]; then
  SAFETAG="$(printf '%s' "$TAG" | tr -c 'A-Za-z0-9._-' '_')"
  OUT="/root/connect-moh-safety/${TS}-${SAFETAG}-ext-key-readiness"
else
  OUT="/root/connect-moh-safety/${TS}-ext-key-readiness"
fi
mkdir -p "$OUT" || { printf 'failed to create %s\n' "$OUT" >&2; exit 2; }

# ── Counters ───────────────────────────────────────────────────────────────
HARD_FAIL=0
SOFT_WARN=0
CHECKS=0

pass() { printf '[PASS] %s\n' "$*"; CHECKS=$((CHECKS + 1)); }
fail() { printf '[FAIL] %s\n' "$*"; CHECKS=$((CHECKS + 1)); HARD_FAIL=$((HARD_FAIL + 1)); }
warn() { printf '[WARN] %s\n' "$*"; CHECKS=$((CHECKS + 1)); SOFT_WARN=$((SOFT_WARN + 1)); }
info() { printf '[INFO] %s\n' "$*"; }

printf '\n[CHECK] Connect per-extension MOH AstDB key readiness (Phase 3B preflight)\n'
printf '==========================================================================\n'
printf 'snapshot dir: %s\n' "$OUT"

# ── 1. asterisk -rx responsive (already proven above; record for forensics) ─
pass "asterisk -rx responsive"
asterisk -rx 'core show version' > "$OUT/core-show-version.txt" 2>&1 || true

# ── 2. connect/pbx_tenant_map populated ────────────────────────────────────
DB_CONNECT_RAW="$(asterisk -rx 'database show connect' 2>&1 || true)"
printf '%s\n' "$DB_CONNECT_RAW" > "$OUT/database-show-connect.txt"

# Extract tenant ids from /connect/pbx_tenant_map/<id>/slug rows.
MAPPED_TENANT_IDS="$(printf '%s\n' "$DB_CONNECT_RAW" \
  | awk -F'[ :]+' '
      /^\/connect\/pbx_tenant_map\/[0-9]+\/slug[[:space:]]*:/ {
        split($1, a, "/")
        print a[4]
      }
    ' \
  | sort -un)"
# slug -> tenant-id map (for orphan detection). One line per mapped tenant.
MAPPED_SLUGS="$(printf '%s\n' "$DB_CONNECT_RAW" \
  | awk '
      /^\/connect\/pbx_tenant_map\/[0-9]+\/slug[[:space:]]*:/ {
        n = split($0, parts, ":")
        # "Value:" style is "Key: /connect/.../slug    : value"
        # awk split on ":" collapses consecutive; rebuild value robustly:
        sub(/^[^:]*:[[:space:]]*/, "", $0)
        print $0
      }
    ' \
  | awk '{print $NF}' \
  | sort -u)"

if [[ -z "$MAPPED_TENANT_IDS" ]]; then
  fail "connect/pbx_tenant_map is empty — Connect has never published MOH on this host"
  printf '\n------------------------------------------------------------------\n'
  printf 'RESULT: FAIL (%d HARD failures, %d warnings, %d checks)\n' \
    "$HARD_FAIL" "$SOFT_WARN" "$CHECKS"
  printf 'Run a Connect MOH publish for at least one tenant, then re-run this diagnostic.\n'
  exit 1
fi
MAPPED_TID_COUNT="$(printf '%s\n' "$MAPPED_TENANT_IDS" | wc -l | tr -d ' ')"
MAPPED_SLUG_COUNT="$(printf '%s\n' "$MAPPED_SLUGS" | wc -l | tr -d ' ')"
pass "connect/pbx_tenant_map has ${MAPPED_TID_COUNT} tenant id(s), ${MAPPED_SLUG_COUNT} slug(s)"
printf '%s\n' "$MAPPED_SLUGS"        > "$OUT/mapped-slugs.txt"
printf '%s\n' "$MAPPED_TENANT_IDS"   > "$OUT/mapped-tenant-ids.txt"

# ── 3. Every mapped tenant has non-empty connect/t_<slug>/moh_class ────────
TENANT_DEFAULT_MISSING=0
TENANT_DEFAULT_EMPTY=0
while IFS= read -r slug; do
  [[ -z "$slug" ]] && continue
  val="$(printf '%s\n' "$DB_CONNECT_RAW" \
    | awk -v k="/connect/t_${slug}/moh_class" '
        $1 == k { sub(/^[^:]*:[[:space:]]*/, "", $0); print; exit }
      ')"
  # Strip trailing whitespace (AstDB dumps sometimes pad)
  val="${val%"${val##*[![:space:]]}"}"
  if [[ -z "$val" ]]; then
    # Distinguish "missing" vs "empty": `awk` above won't match a nonexistent key,
    # so empty $val can mean either. Treat as HARD fail either way — a mapped
    # tenant with no tenant-default key will break the resolver's fallback.
    fail "tenant-default missing/empty: connect/t_${slug}/moh_class"
    TENANT_DEFAULT_MISSING=$((TENANT_DEFAULT_MISSING + 1))
  fi
done <<< "$MAPPED_SLUGS"
if [[ $TENANT_DEFAULT_MISSING -eq 0 ]]; then
  pass "every mapped tenant has a non-empty connect/t_<slug>/moh_class"
fi

# ── 4. Enumerate per-extension families ────────────────────────────────────
# Lines look like:  "/connect/t_secro_selution/extensions/101/moh_class : moh8"
# We need slug + ext + value.
EXT_ROWS="$(printf '%s\n' "$DB_CONNECT_RAW" \
  | awk '
      /^\/connect\/t_[A-Za-z0-9_-]+\/extensions\/[A-Za-z0-9_-]+\/(moh_class|active_moh_class)[[:space:]]*:/ {
        key = $1
        sub(/^[^:]*:[[:space:]]*/, "", $0)
        val = $0
        # Trim trailing whitespace from val
        sub(/[[:space:]]+$/, "", val)
        # Parse key into slug + ext + field
        n = split(key, parts, "/")
        # parts[1]="" parts[2]="connect" parts[3]="t_<slug>" parts[4]="extensions"
        # parts[5]="<ext>" parts[6]="<field>"
        slug = parts[3]; sub(/^t_/, "", slug)
        ext  = parts[5]
        fld  = parts[6]
        printf "%s\t%s\t%s\t%s\n", slug, ext, fld, val
      }
    ' \
  | sort -u)"
printf '%s\n' "$EXT_ROWS" > "$OUT/extension-rows.tsv"

EXT_MOH_CLASS_COUNT="$(printf '%s\n' "$EXT_ROWS" \
  | awk -F'\t' '$3 == "moh_class" {n++} END {print n+0}')"
EXT_ACTIVE_COUNT="$(printf '%s\n' "$EXT_ROWS" \
  | awk -F'\t' '$3 == "active_moh_class" {n++} END {print n+0}')"

info "per-extension families found: moh_class=${EXT_MOH_CLASS_COUNT} active_moh_class=${EXT_ACTIVE_COUNT}"
if [[ $EXT_MOH_CLASS_COUNT -eq 0 ]]; then
  info "no per-extension overrides configured yet — probes 5-8 are vacuously true"
fi

# ── 5. Slug-orphan guard ───────────────────────────────────────────────────
# Every (slug, ext, moh_class) row must have its slug in MAPPED_SLUGS.
ORPHAN_SLUGS="$(printf '%s\n' "$EXT_ROWS" \
  | awk -F'\t' '$3 == "moh_class" {print $1}' \
  | sort -u \
  | comm -23 - <(printf '%s\n' "$MAPPED_SLUGS"))"
if [[ -n "$ORPHAN_SLUGS" ]]; then
  while IFS= read -r s; do
    [[ -z "$s" ]] && continue
    fail "orphan per-extension family under unmapped slug: connect/t_${s}/extensions/*"
  done <<< "$ORPHAN_SLUGS"
else
  pass "no orphan per-extension families (every slug is in connect/pbx_tenant_map)"
fi
printf '%s\n' "$ORPHAN_SLUGS" > "$OUT/orphan-slugs.txt"

# ── 6. Every moh_class value is a loaded Asterisk MOH class ────────────────
MOH_CLASSES_RAW="$(asterisk -rx 'moh show classes' 2>&1 || true)"
printf '%s\n' "$MOH_CLASSES_RAW" > "$OUT/moh-show-classes.txt"
# "moh show classes" format on this build:
#   Class: default
#       Mode: files
#       Directory: /var/lib/asterisk/moh
#   Class: moh3
#   ...
LOADED_CLASSES="$(printf '%s\n' "$MOH_CLASSES_RAW" \
  | awk '/^Class:[[:space:]]+/ {print $2}' \
  | sort -u)"
if [[ -z "$LOADED_CLASSES" ]]; then
  fail "'moh show classes' returned no classes — MOH subsystem not loaded?"
else
  CLASS_COUNT="$(printf '%s\n' "$LOADED_CLASSES" | wc -l | tr -d ' ')"
  pass "'moh show classes' returned ${CLASS_COUNT} loaded class(es)"
fi

MISSING_CLASSES=0
EMPTY_TOMBSTONES=0
# Iterate only moh_class rows (not active_moh_class alias; probe 7 pairs them).
while IFS=$'\t' read -r slug ext fld val; do
  [[ -z "${slug:-}" ]] && continue
  [[ "$fld" != "moh_class" ]] && continue
  if [[ -z "$val" ]]; then
    EMPTY_TOMBSTONES=$((EMPTY_TOMBSTONES + 1))
    continue
  fi
  if ! printf '%s\n' "$LOADED_CLASSES" | grep -Fxq "$val"; then
    fail "per-extension class not loaded: connect/t_${slug}/extensions/${ext}/moh_class=${val}"
    MISSING_CLASSES=$((MISSING_CLASSES + 1))
  fi
done <<< "$EXT_ROWS"
if [[ $EXT_MOH_CLASS_COUNT -gt 0 && $MISSING_CLASSES -eq 0 ]]; then
  pass "every per-extension moh_class value is a loaded Asterisk class"
fi

# ── 7. Alias-pair invariant (SOFT) ─────────────────────────────────────────
# For every (slug,ext) with moh_class, there should be active_moh_class with
# the same value. Drift indicates a write-side bug; SOFT because Phase 3B
# resolver reads moh_class first and only falls back to active_moh_class
# when moh_class is empty, so alias drift is audit-only.
MISMATCH=0
MISSING_ALIAS=0
while IFS=$'\t' read -r slug ext fld val; do
  [[ -z "${slug:-}" ]] && continue
  [[ "$fld" != "moh_class" ]] && continue
  alias_val="$(printf '%s\n' "$EXT_ROWS" \
    | awk -F'\t' -v s="$slug" -v e="$ext" '
        $1 == s && $2 == e && $3 == "active_moh_class" { print $4; exit }
      ')"
  if [[ -z "$alias_val" && -n "$val" ]]; then
    warn "missing active_moh_class alias for connect/t_${slug}/extensions/${ext}"
    MISSING_ALIAS=$((MISSING_ALIAS + 1))
  elif [[ -n "$alias_val" && "$alias_val" != "$val" ]]; then
    warn "alias drift: connect/t_${slug}/extensions/${ext}/moh_class=${val} active_moh_class=${alias_val}"
    MISMATCH=$((MISMATCH + 1))
  fi
done <<< "$EXT_ROWS"
if [[ $EXT_MOH_CLASS_COUNT -gt 0 && $MISMATCH -eq 0 && $MISSING_ALIAS -eq 0 ]]; then
  pass "alias-pair invariant holds for every per-extension family"
fi

# ── 8. Tombstone visibility (INFO) ─────────────────────────────────────────
if [[ $EMPTY_TOMBSTONES -gt 0 ]]; then
  info "empty-string moh_class tombstones present: ${EMPTY_TOMBSTONES} (expected after rollback)"
fi

# ── 9. CHANNEL(pjsip,endpoint) availability (SOFT) ─────────────────────────
CHANNEL_FN_RAW="$(asterisk -rx 'core show function CHANNEL' 2>&1 || true)"
printf '%s\n' "$CHANNEL_FN_RAW" > "$OUT/core-show-function-CHANNEL.txt"
if echo "$CHANNEL_FN_RAW" | grep -qi 'pjsip.*endpoint\|pjsip_endpoint'; then
  pass "CHANNEL(pjsip,endpoint) appears supported on this Asterisk build"
else
  warn "CHANNEL(pjsip,endpoint) not detected in 'core show function CHANNEL' — Phase 3B resolver must use the CHANNEL(name) regex fallback"
fi

# ── 10. MOH subsystem loaded (HARD — already asserted in #6 via class count) ─
# Counted in #6. No separate probe.

# ── Summary ────────────────────────────────────────────────────────────────
printf '\n------------------------------------------------------------------\n'
if [[ $HARD_FAIL -eq 0 ]]; then
  if [[ $SOFT_WARN -gt 0 ]]; then
    printf 'RESULT: PASS (%d checks; %d warning(s); 0 hard failures)\n' \
      "$CHECKS" "$SOFT_WARN"
    printf 'Phase 3B resolver install gate: OK. Warnings above are informational\n'
    printf 'or auditable; they do not block a resolver install, but the design\n'
    printf 'doc (docs/pbx/phase-3b-moh-extension-resolver-design.md) records\n'
    printf 'which fallbacks apply.\n'
  else
    printf 'RESULT: PASS (%d/%d checks healthy)\n' "$CHECKS" "$CHECKS"
    printf 'Phase 3B resolver install gate: OK.\n'
  fi
  printf 'Snapshot stored at: %s\n' "$OUT"
  exit 0
else
  printf 'RESULT: FAIL (%d HARD failures, %d warning(s), %d total checks)\n' \
    "$HARD_FAIL" "$SOFT_WARN" "$CHECKS"
  printf 'Do NOT install the Phase 3B resolver until the hard failures above are resolved.\n'
  printf 'Snapshot stored at: %s\n' "$OUT"
  exit 1
fi
