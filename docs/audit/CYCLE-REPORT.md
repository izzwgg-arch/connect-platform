# Live Call Engine — Forensic Cycle Report

**PBX:** 209.145.60.79 (read-only SSH `cursor-audit`)  
**Snapshot time:** Tue 17 Mar 14:36:35 EDT 2026

---

## OUTPUT FORMAT (THIS CYCLE)

| # | Field | Value |
|---|--------|--------|
| 1 | **PBX real call count (from bridges)** | **UNKNOWN** — Audit script returns "Asterisk command failed" / "Could not get bridges". cursor-audit cannot run Asterisk CLI. Only log tail is available; no point-in-time channel/bridge list. |
| 2 | **Backend derivedActiveCount** | **N/A** — Requires GET /forensic from a machine that can reach the telephony service. |
| 3 | **Dashboard KPI** | **N/A** — Requires manual note or capture at same moment. |
| 4 | **Dashboard rows** | **N/A** — Requires manual note or capture at same moment. |
| 5 | **forensic.bucketCounts** | **N/A** — Requires GET /forensic response. |
| 6 | **Identified bug** | **None** — No forensic evidence captured; cannot identify a specific bug without /forensic data. |
| 7 | **Files changed** | **None** — No patch without evidence. |
| 8 | **Before vs After** | **N/A** — No patch or re-test this cycle. |

---

## PBX AUDIT PIPELINE FIX (READ-ONLY)

The audit script currently returns "Asterisk command failed" / "Could not get bridges" because the script or sudoers on the PBX do not allow running Asterisk CLI (see root cause in `docs/pbx-audit/ROOT-CAUSE.md`).

**Fix artifacts (for a PBX admin to deploy on 209.145.60.79):**

| Item | Location |
|------|----------|
| Root cause | `docs/pbx-audit/ROOT-CAUSE.md` |
| Audit script | `docs/pbx-audit/pbx_audit_snapshot.sh` → install as `/usr/local/bin/pbx_audit_snapshot` |
| Sudoers fragment | `docs/pbx-audit/sudoers.d-cursor-audit` → install as `/etc/sudoers.d/cursor-audit` |
| Deploy and verify | `docs/pbx-audit/DEPLOY.md` |

**Verification (after deploy):** Run `ssh cursor-audit@209.145.60.79`. Success = output includes real channel list, bridge list, and counts (not "Asterisk command failed" / "Could not get bridges"). Then proceed with the forensic comparison cycle (same-moment PBX + dashboard + GET /forensic + GET /diagnostics).

---

## PHASE 1 — CAPTURE REAL STATE

### 1.1 SSH audit (done)

```
ssh cursor-audit@209.145.60.79
```

**Result:**

| Section | Content |
|---------|---------|
| ACTIVE CHANNELS | Asterisk command failed |
| ACTIVE CHANNEL COUNT | Could not get active channel count |
| ACTIVE BRIDGES | Could not get bridges |
| SYSTEM LOAD | 0.25, 0.27, 0.27 |
| MEMORY | 47Gi total, 16Gi used |
| LAST ASTERISK LOGS | VERBOSE/SECURITY/NOTICE lines (see below) |

**Inference from logs (not ground truth):**  
- One bridge `9f345044-ac59-41fe-866c-723319dfd52d` had two channels leave at 14:36:29 (call ended).  
- One channel `PJSIP/344022_gesheft-00002488` was playing a file at 14:36:20.  
- Log tail does not provide a current channel or bridge count.

### 1.2 Frontend/backend (not captured here)

To build the comparison table you must capture **at the same moment**:

- Dashboard KPI count (from UI)
- Dashboard visible row count (from UI)
- `GET /forensic` (requires ENABLE_TELEPHONY_DEBUG=true)
- `GET /diagnostics`
- `GET /telephony/calls`
- `GET /telephony/health`

From a host that can reach your telephony service, run for example:

```bash
TELEPHONY_URL=https://<your-telephony-host> ./scripts/compare-pbx-dashboard.sh
```

Or manually:

```bash
curl -sS "$TELEPHONY_URL/forensic?pbx=<PBX>&kpi=<KPI>&rows=<ROWS>" | jq . > forensic.json
```

Then fill:

| Source | Count |
|--------|--------|
| PBX active calls (from bridges) | _Use VitalPBX UI or fix audit script to run read-only Asterisk_ |
| Backend derivedActiveCount | _from forensic.derivedActiveCount_ |
| Dashboard KPI | _you noted_ |
| Dashboard table rows | _you noted_ |

---

## PHASE 2 — REAL CALL COUNT (GROUND TRUTH)

**REAL_CALL_COUNT = number of bridges with real endpoints.**

- **From this SSH audit:** Not available. The forced script does not run Asterisk CLI; we get no channel or bridge list.
- **Options to get ground truth:**
  1. Use VitalPBX (or another UI) to read active call/bridge count at the same moment you capture /forensic.
  2. Or have a PBX admin add a read-only Asterisk command to the cursor-audit script (e.g. `asterisk -rx "bridge show all"` or `core show channels count`) and re-run the audit.

---

## PHASE 3 — FORENSIC ANALYSIS

**Requires:** The JSON response from `GET /forensic` (with ENABLE_TELEPHONY_DEBUG=true).

Until that is provided:

- Cannot list each active call’s callId, linkedId, bridgeIds, channels, state, tenantId, whyActive, whyNotMerged, bucket.
- Cannot group non-legitimate calls into duplicateLeg, unresolvedBridgeMerge, helperArtifact, staleOrphan, wrongTenantDuplication.
- Cannot name the exact file/function responsible for each bad call.

**Next step:** Run GET /forensic at a moment when you also have PBX count (from UI) and dashboard KPI/rows, then paste the forensic JSON (or bucketCounts + activeCallsForensic) so we can do Phase 3 and then Phase 4 (minimal patch) and Phase 5 (re-test).

---

## PHASE 4 — PATCH

**No patch this cycle.** No forensic evidence yet. Patching only after a specific bug is identified from /forensic (and, if possible, PBX ground truth).

---

## PHASE 5 — RE-TEST

After a patch is applied: re-run SSH audit and GET /forensic, then compare counts again and document in this file or a new cycle report.

---

## PHASE 6 — SUCCESS CRITERIA

Success when **all** are true:

- PBX real calls ≈ dashboard KPI (±1 max)
- PBX real calls ≈ dashboard table rows
- No duplicateLeg or unresolvedBridgeMerge in forensic.bucketCounts
- No helperArtifact counted
- No ghost calls after hangup
- Tenant view shows only that tenant’s calls

**Current status:** Blocked on (1) PBX real call count and (2) forensic/dashboard capture at the same moment.

---

## SAFETY (CONFIRMED)

- PBX: read-only SSH only; no commands other than the forced audit script; no config, dialplan, trunks, routes, queues, IVRs, or restarts.
- App: no code changes until a bug is identified from forensic evidence.
