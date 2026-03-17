#!/usr/bin/env bash
# Capture live mismatch snapshot for forensic investigation.
# Usage:
#   TELEPHONY_URL=http://localhost:3003 ./scripts/capture-live-mismatch.sh 2 7 7
#   (pbx_count=2, dashboard_kpi=7, dashboard_rows=7)
# Or with env:
#   PBX_COUNT=2 KPI=7 ROWS=7 TELEPHONY_URL=http://localhost:3003 ./scripts/capture-live-mismatch.sh
set -euo pipefail

BASE="${TELEPHONY_URL:-http://localhost:3003}"
PBX="${PBX_COUNT:-${1:-}}"
KPI="${DASHBOARD_KPI:-${2:-}}"
ROWS="${DASHBOARD_ROWS:-${3:-}}"
OUT="${MISMATCH_OUTPUT:-mismatch-report-$(date +%Y%m%d-%H%M%S).md}"

echo "Capturing live mismatch snapshot..."
echo "  TELEPHONY_URL=$BASE"
echo "  PBX active count (user): $PBX"
echo "  Dashboard KPI (user):    $KPI"
echo "  Dashboard rows (user):   $ROWS"
echo "  Output:                  $OUT"
echo ""

QS=""
[ -n "$PBX" ] && QS="${QS}pbx=${PBX}&"
[ -n "$KPI" ] && QS="${QS}kpi=${KPI}&"
[ -n "$ROWS" ] && QS="${QS}rows=${ROWS}&"
QS="${QS%&}"

if [ -n "$QS" ]; then
  URL="${BASE}/forensic?${QS}"
else
  URL="${BASE}/forensic"
fi

RESP=$(curl -sS "$URL" 2>/dev/null || true)
if ! echo "$RESP" | head -1 | grep -q "{"; then
  echo "Error: /forensic did not return JSON. Is ENABLE_TELEPHONY_DEBUG=true?"
  echo "$RESP" | head -5
  exit 1
fi

TS=$(echo "$RESP" | jq -r '.timestamp // "n/a"')
echo "Timestamp: $TS"
echo ""

# Write report
{
  echo "# Live Call Mismatch Report"
  echo ""
  echo "**Timestamp:** $TS"
  echo ""
  echo "## 1. Mismatch snapshot (same moment)"
  echo ""
  echo "| Source | Value |"
  echo "|--------|-------|"
  echo "| PBX active call count (you entered) | ${PBX:-—} |"
  echo "| Dashboard KPI (you entered) | ${KPI:-—} |"
  echo "| Dashboard live rows (you entered) | ${ROWS:-—} |"
  echo "| GET /telephony/health activeCalls | $(echo "$RESP" | jq -r '.mismatchSnapshot.telephonyHealthActiveCalls // "—"') |"
  echo "| GET /telephony/calls length | $(echo "$RESP" | jq -r '.mismatchSnapshot.telephonyCallsCount // "—"') |"
  echo "| diagnostics rawChannelCount | $(echo "$RESP" | jq -r '.mismatchSnapshot.diagnosticsRawChannelCount // "—"') |"
  echo "| diagnostics derivedActiveCount | $(echo "$RESP" | jq -r '.mismatchSnapshot.diagnosticsDerivedActiveCount // "—"') |"
  echo "| overcountSuspected | $(echo "$RESP" | jq -r '.mismatchSnapshot.overcountSuspected // false') |"
  echo ""
  echo "## 2. Bucket counts (classification)"
  echo ""
  echo "$RESP" | jq -r '.forensic.bucketCounts | to_entries | .[] | "- \(.key): \(.value)"' 2>/dev/null || echo "(none)"
  echo ""
  echo "## 3. Per-call forensic (why active, why not merged, bucket)"
  echo ""
  echo "$RESP" | jq -r '
    .forensic.activeCallsForensic[]?
    | "### Call \(.callId)\n- linkedId: \(.linkedId)\n- uniqueIds: \(.uniqueIds | join(", "))\n- bridgeIds: \(.bridgeIds | join(", ") // "[]")\n- channels: \(.channels | join(", "))\n- from: \(.from // "—") to: \(.to // "—")\n- state: \(.state) tenantId: \(.tenantId // "—")\n- startedAt: \(.startedAt) answeredAt: \(.answeredAt // "—")\n- **whyActive:** \(.whyActive)\n- **whyNotMerged:** \(.whyNotMerged)\n- **bucket:** \(.bucket)\n- **traceNote:** \(.traceNote)\n"
  ' 2>/dev/null || echo "(jq failed or no calls)"
  echo ""
  echo "## 4. Debug logs (paste from telephony service, same ~10s window)"
  echo ""
  echo "\`\`\`"
  echo "(Paste here: live_call: event_received, call_created, call_merged_by_bridge, call_hungup, call_removed, overcount_suspected)"
  echo "\`\`\`"
  echo ""
  echo "## 5. Full JSON (for automation)"
  echo ""
  echo "<details><summary>Expand</summary>"
  echo ""
  echo "\`\`\`json"
  echo "$RESP" | jq '.' 2>/dev/null || echo "$RESP"
  echo "\`\`\`"
  echo "</details>"
} > "$OUT"

echo "Report written to: $OUT"
echo "Next: paste debug logs into section 4, then use bucket counts and traceNote to identify the exact leak."
