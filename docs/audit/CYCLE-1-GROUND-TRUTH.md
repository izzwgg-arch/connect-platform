# Cycle 1 — Ground truth and comparison

**Purpose:** Establish PBX vs dashboard vs backend at one moment. Read-only PBX access only.

---

## 1. PBX snapshot (read-only SSH)

**Command run:** `ssh cursor-audit@209.145.60.79`

**Time (from snapshot):** Tue 17 Mar 14:11:59 EDT 2026

**Result:**

| Item | Value |
|------|--------|
| ACTIVE CHANNELS | Asterisk command failed |
| ACTIVE CHANNEL COUNT | Could not get active channel count |
| ACTIVE BRIDGES | Could not get bridges |

The restricted `cursor-audit` account runs a forced script that does **not** have permission to run Asterisk CLI (e.g. `core show channels`). So we cannot get an exact channel/call count from SSH alone.

**Inference from snapshot logs:** Recent Asterisk VERBOSE lines show bridge activity (e.g. `Channel Local/105@T18_ring-group-dial-... joined 'simple_bridge'`, `Channel PJSIP/... left 'simple_bridge'`). To get **PBX active call count** for the comparison table, use one of:

- VitalPBX/Asterisk UI on the PBX (if you have it).
- Manual count from the snapshot log section (channels/bridges mentioned in the last N lines).

**PBX count for comparison table:** _Fill when you have it from UI or manual count._

---

## 2. Dashboard and backend (same moment)

These must be captured **at the same time** as the PBX snapshot (or within a few seconds), from a machine that can reach your telephony service and dashboard.

**Options:**

- Run the comparison script (sets TELEPHONY_URL to your telephony base URL):
  ```bash
  TELEPHONY_URL=https://your-telephony.example.com PBX_COUNT=<n> KPI=<k> ROWS=<r> ./scripts/compare-pbx-dashboard.sh
  ```
- Or manually:
  1. Note dashboard KPI and live table row count.
  2. `curl -sS "$TELEPHONY_URL/forensic?pbx=<n>&kpi=<k>&rows=<r>" | jq . > docs/audit/forensic-<timestamp>.json`

**Requires:** `ENABLE_TELEPHONY_DEBUG=true` on the telephony service so `/forensic` is available.

---

## 3. Comparison table (fill from your capture)

| Source | Value |
|--------|--------|
| PBX active (audit or manual) | _e.g. 2_ |
| Dashboard KPI | _e.g. 7_ |
| Dashboard visible rows | _e.g. 7_ |
| GET /telephony/health activeCalls | _from forensic or /health_ |
| GET /telephony/calls length | _from forensic or /telephony/calls_ |
| forensic derivedActiveCount | _from forensic JSON_ |
| forensic rawChannelCount | _from forensic JSON_ |
| Bucket counts | _e.g. legitimate=2, duplicateLeg=5_ |

---

## 4. Next steps (Phase 2–5)

1. **Fill the table** using one run of the comparison script or manual capture with the same timestamp as the PBX snapshot.
2. **Identify mismatches** using `forensic.activeCallsForensic` and `forensic.bucketCounts` (see LIVE_CALL_FORENSIC_RUNBOOK.md).
3. **Patch only proven leaks** in the app codebase; re-run snapshot + forensic and document before/after in this file or a new cycle file.

---

## 5. Safety

- PBX access is **read-only**. No config, dialplan, routes, AMI/ARI config, or shell escape.
- Only the application codebase is modified, and only where evidence shows a bug.
