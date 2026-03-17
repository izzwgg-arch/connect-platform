#!/usr/bin/env bash
# Phase 1: Establish ground truth by capturing PBX snapshot + backend/dashboard in one run.
# READ-ONLY: no changes on PBX. Only SSH runs the forced audit script; only curl hits our APIs.
#
# Usage:
#   TELEPHONY_URL=https://your-telephony.example.com ./scripts/compare-pbx-dashboard.sh
#   PBX_COUNT=2 KPI=7 ROWS=7 TELEPHONY_URL=http://localhost:3003 ./scripts/compare-pbx-dashboard.sh
#
# Optional: PBX_COUNT, KPI, ROWS (dashboard values you see at capture time).
# Optional: SSH_TARGET=cursor-audit@209.145.60.79 (default)
# Output: comparison table + saved artifacts in docs/audit/
set -euo pipefail

BASE="${TELEPHONY_URL:-}"
SSH_TARGET="${SSH_TARGET:-cursor-audit@209.145.60.79}"
PBX="${PBX_COUNT:-}"
KPI="${DASHBOARD_KPI:-}"
ROWS="${DASHBOARD_ROWS:-}"
AUDIT_DIR="${AUDIT_DIR:-docs/audit}"
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p "$AUDIT_DIR"

echo "========== PBX vs Dashboard comparison — $TS =========="
echo ""

# --- 1. PBX snapshot (read-only SSH)
echo "[1/4] PBX audit snapshot (read-only)..."
PBX_OUT="$AUDIT_DIR/pbx-snapshot-$TS.txt"
if command -v ssh >/dev/null 2>&1; then
  ssh -o ConnectTimeout=10 -o BatchMode=yes "$SSH_TARGET" 2>&1 | tee "$PBX_OUT" || true
  if grep -q "Could not get active channel count" "$PBX_OUT" 2>/dev/null; then
    PBX_COUNT_RAW="(audit script could not get count — check VitalPBX UI or logs)"
  elif grep -q "ACTIVE CHANNEL COUNT" "$PBX_OUT" 2>/dev/null; then
    PBX_COUNT_RAW=$(grep -A1 "ACTIVE CHANNEL COUNT" "$PBX_OUT" | tail -1 | tr -d ' ')
  else
    PBX_COUNT_RAW="(see $PBX_OUT)"
  fi
else
  echo "  (ssh not available; skip PBX snapshot)"
  PBX_COUNT_RAW="(skipped)"
fi
echo "  Saved: $PBX_OUT"
echo ""

# --- 2. Backend forensic/health/calls (if TELEPHONY_URL set)
if [ -z "$BASE" ]; then
  echo "[2/4] TELEPHONY_URL not set; skipping backend capture."
  echo "      Set TELEPHONY_URL to the telephony service base URL (e.g. http://localhost:3003)"
  HEALTH_ACTIVE="—"
  CALLS_COUNT="—"
  DERIVED="—"
  RAW_CHANNELS="—"
  BUCKETS="—"
else
  echo "[2/4] Backend capture..."
  QS=""
  [ -n "$PBX" ] && QS="${QS}pbx=${PBX}&"
  [ -n "$KPI" ] && QS="${QS}kpi=${KPI}&"
  [ -n "$ROWS" ] && QS="${QS}rows=${ROWS}&"
  QS="${QS%&}"
  [ -n "$QS" ] && URL="${BASE}/forensic?${QS}" || URL="${BASE}/forensic"

  FORENSIC_JSON="$AUDIT_DIR/forensic-$TS.json"
  curl -sS --connect-timeout 5 "$URL" 2>/dev/null | tee "$FORENSIC_JSON" | jq . >/dev/null 2>&1 || true

  if [ -f "$FORENSIC_JSON" ] && head -1 "$FORENSIC_JSON" | grep -q "{"; then
    HEALTH_ACTIVE=$(jq -r '.mismatchSnapshot.telephonyHealthActiveCalls // "—"' "$FORENSIC_JSON")
    CALLS_COUNT=$(jq -r '.mismatchSnapshot.telephonyCallsCount // "—"' "$FORENSIC_JSON")
    DERIVED=$(jq -r '.forensic.derivedActiveCount // "—"' "$FORENSIC_JSON")
    RAW_CHANNELS=$(jq -r '.forensic.rawChannelCount // "—"' "$FORENSIC_JSON")
    BUCKETS=$(jq -r '.forensic.bucketCounts | to_entries | map("\(.key)=\(.value)") | join(", ")' "$FORENSIC_JSON" 2>/dev/null || echo "—")
    echo "  Saved: $FORENSIC_JSON"
  else
    HEALTH_ACTIVE="(forensic unavailable — is ENABLE_TELEPHONY_DEBUG=true?)"
    CALLS_COUNT="—"
    DERIVED="—"
    RAW_CHANNELS="—"
    BUCKETS="—"
  fi
fi
echo ""

# --- 3. Comparison table
echo "[3/4] Comparison table"
REPORT="$AUDIT_DIR/comparison-$TS.md"
{
  echo "# PBX vs Dashboard comparison — $TS"
  echo ""
  echo "## Ground truth (same moment)"
  echo ""
  echo "| Source | Value |"
  echo "|--------|-------|"
  echo "| PBX active (audit or manual) | ${PBX:-$PBX_COUNT_RAW} |"
  echo "| Dashboard KPI (manual) | ${KPI:-—} |"
  echo "| Dashboard visible rows (manual) | ${ROWS:-—} |"
  echo "| GET /telephony/health activeCalls | $HEALTH_ACTIVE |"
  echo "| GET /telephony/calls length | $CALLS_COUNT |"
  echo "| forensic derivedActiveCount | $DERIVED |"
  echo "| forensic rawChannelCount | $RAW_CHANNELS |"
  echo "| Bucket counts | $BUCKETS |"
  echo ""
  echo "## Mismatch?"
  echo "- PBX vs derived: _compare first row with derivedActiveCount_"
  echo "- KPI/rows vs derived: _should match if dashboard uses WS telephony_"
  echo ""
  echo "## Artifacts"
  echo "- PBX snapshot: \`$PBX_OUT\`"
  if [ -n "$BASE" ]; then
    echo "- Forensic JSON: \`$FORENSIC_JSON\`"
  fi
} | tee "$REPORT"
echo "  Saved: $REPORT"
echo ""

echo "[4/4] Done. Next: open $REPORT and forensic JSON; use bucket counts and activeCallsForensic to find exact mismatches (see docs/LIVE_CALL_FORENSIC_RUNBOOK.md)."
echo "========== End comparison =========="
