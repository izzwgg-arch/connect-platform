# Live Call Mismatch — Forensic Runbook

Use this when **PBX active count ≠ dashboard active count** to find the exact overcount source and patch only that logic.

**Prereqs:** Telephony service running. `GET /forensic` and `GET /diagnostics` are always available (no debug flag). For verbose AMI logs, set `ENABLE_TELEPHONY_DEBUG=true`.

**PBX access:** Read-only SSH `cursor-audit@209.145.60.79` runs a forced audit snapshot script. Do not modify anything on the PBX. No write, reload, config edit, or shell escape.

---

## Workflow summary (Phases 1–5)

1. **Establish ground truth** — PBX snapshot + dashboard KPI/rows + GET /forensic, /diagnostics, /telephony/calls, /telephony/health at same moment → comparison table.
2. **Find exact mismatches** — Use forensic `activeCallsForensic` and `bucketCounts`; for every bad row: why counted, why it should not be, file/function responsible.
3. **Patch only proven leaks** — Minimal app-only fixes; every change maps to a specific mismatch.
4. **Re-test** — Re-run PBX snapshot + forensic; compare before/after.
5. **Continue** until: dashboard KPI ≈ PBX, rows ≈ PBX, no duplicate/helper/stale inflation, tenant scoping correct, no reconnect ghosts.

**Deliverables per cycle:** PBX count, dashboard KPI, dashboard rows, backend derived count, bucket counts, exact bug, files changed, before vs after.

---

## PHASE 1 — Live mismatch snapshot

**While live traffic is present**, at one timestamp capture:

1. **PBX active call count** — Run read-only SSH: `ssh cursor-audit@209.145.60.79`. If the script reports "Could not get active channel count", use VitalPBX UI or count from snapshot logs.
2. **Dashboard KPI** — number shown in the dashboard “Active Calls” KPI.
3. **Dashboard live rows** — number of rows in the live calls table.
4. **GET /telephony/calls** — count of items in the JSON array (or use forensic response).
5. **GET /telephony/health** — `activeCalls` value.
6. **GET /diagnostics** or **GET /forensic** — full response (rawChannelCount, derivedActiveCount, bucketCounts, activeCallsForensic).
7. **Debug logs** — from telephony service for the same ~10s window (grep `live_call:`).

**One-shot comparison (PBX + backend):** `TELEPHONY_URL=<url> PBX_COUNT=2 KPI=7 ROWS=7 ./scripts/compare-pbx-dashboard.sh` — writes to `docs/audit/`.

**Forensic-only capture (scripts):**

PowerShell (Windows / cross-platform):

```powershell
# From repo root. Set TELEPHONY_URL if telephony is not on localhost:3003.
$env:TELEPHONY_URL = "http://your-telephony-host:3003"   # optional
.\scripts\capture-forensic.ps1
# Writes forensic_capture.json and diagnostics_capture.json
```

Then analyze (derivedActiveCount, bucketCounts, every non-legitimate call):

```bash
node scripts/analyze-forensic.js [path/to/forensic_capture.json]
```

Bash (if capture-live-mismatch.sh exists):

```bash
TELEPHONY_URL=http://localhost:3003 ./scripts/capture-live-mismatch.sh 2 7 7
```

Or with query params only (no script):

```bash
curl -sS "http://localhost:3003/forensic?pbx=2&kpi=7&rows=7" | jq . > forensic-$(date +%H%M%S).json
```

**Manual:** Note PBX count, KPI, row count; then open:

- `GET /forensic?pbx=<PBX>&kpi=<KPI>&rows=<ROWS>`

The response is your **mismatch report**: `timestamp`, `mismatchSnapshot`, `telephonyHealth`, `telephonyCallsSample`, `diagnostics`, `forensic`.

---

## PHASE 2 — Actual derived calls

The **forensic** object in the response contains:

- **activeCallsForensic** — every derived active call with:
  - **callId**, **linkedId**, **uniqueIds**, **bridgeIds**, **channels**
  - **from**, **to**, **state**, **tenantId**
  - **startedAt**, **answeredAt**
  - **whyActive** — why it passed getActive() (state, hasValidChannel, !isLocalOnlyCall)
  - **whyNotMerged** — why it wasn’t merged (e.g. “canonical for bridge” vs “same bridge as callId X”)
  - **traceNote** — short hint for investigation

Use this to see exactly which calls exist and why each is considered active and not merged.

---

## PHASE 3 — Overcount buckets

**forensic.bucketCounts** gives a count per bucket:

| Bucket | Meaning |
|--------|--------|
| **legitimate** | Single call for its bridge(s); no other call shares a bridgeId. |
| **duplicateLeg** | At least one other derived call shares a bridgeId → merge should have run. |
| **staleOrphan** | state is `unknown` (should be filtered out by getActive()). |
| **helperArtifact** | isLocalOnly or !hasValidChannel but still in list (filter bug). |
| **unresolvedBridgeMerge** | Same as duplicateLeg (two calls for one bridge). |
| **wrongTenantDuplication** | Same from/to and close startedAt as another call (different callId). |
| **unknown** | Fallback. |

**Interpretation:**

- If **duplicateLeg** or **unresolvedBridgeMerge** > 0 → bridge merge is not running or order is wrong.
- If **staleOrphan** > 0 → unknown state is passing the active filter.
- If **helperArtifact** > 0 → Local/helper filter or hasValidChannel is wrong.
- If **wrongTenantDuplication** > 0 → same call keyed twice (e.g. linkedId vs uniqueId) or tenant split.

---

## PHASE 4 — Trace why each bad call survived

For every call **not** in bucket **legitimate**:

1. **bucket** + **traceNote** — already in the forensic payload.
2. **Event sequence** — we don’t store event history; use **channels**, **bridgeIds**, **linkedId**, **uniqueIds** to infer:
   - Newchannel created this call (linkedId or uniqueId as key).
   - BridgeEnter should have merged it if another call already had that bridgeId → **mergeCallInto** or **bridgeIndex** is the leak.
3. **Rule that failed** — from traceNote:
   - “BridgeEnter merge should have merged…” → **CallStateStore.onBridgeEnter** / **mergeCallInto** / **bridgeIndex**.
   - “State is unknown; getActive() should exclude…” → **getActive()** ACTIVE_STATES or filter.
   - “Should be excluded by getActive(); hasValidChannel…” → **isLocalOnlyCall** / **hasValidChannel** or **isHelperChannel**.
   - “Possible duplicate by from/to/time…” → **effectiveLinkedId** or key choice (linkedId vs uniqueId).
4. **Exact file/function** — traceNote and this runbook point to the area; use the code to find the exact branch that allowed the call to stay active.

---

## PHASE 5 — Patch only the proven leak

Do **not** rewrite the engine. Patch only what the evidence shows:

- **duplicateLeg / unresolvedBridgeMerge** → Fix bridge merge: ensure every BridgeEnter uses the same canonical call for that bridge; fix order (e.g. merge the later call into the first); or ensure bridgeId is always present and used.
- **staleOrphan** → Tighten getActive(): ensure `unknown` is never returned (already in ACTIVE_STATES check; if still present, add an explicit `c.state !== 'unknown'` or fix the state source).
- **helperArtifact** → Tighten isHelperChannel / hasValidChannel / isLocalOnlyCall, or ensure no path adds a call with only helper channels to getActive().
- **wrongTenantDuplication** → Same logical call with two callIds: fix effectiveLinkedId so both legs get the same key, or merge by (from, to, time window) when linkedId is empty.

Re-run the same snapshot after the patch (Phase 6).

---

## PHASE 6 — After patch: repeat snapshot

Capture again with the **same kind** of live traffic:

1. PBX active count  
2. Dashboard KPI  
3. Dashboard table rows  
4. GET /forensic (or /diagnostics) — rawChannelCount, derivedActiveCount, overcountSuspected  
5. forensic.bucketCounts and forensic.activeCallsForensic  

Then answer:

- **Before patch mismatch:** e.g. “PBX=2, dashboard=7, derived=7, duplicateLeg=5”.
- **After patch mismatch:** e.g. “PBX=2, dashboard=2, derived=2, duplicateLeg=0”.
- **Exact bug that caused it:** e.g. “Two legs of same bridge had different linkedIds; BridgeEnter only merged when bridgeId was set; second leg’s BridgeEnter ran before first, so first became canonical and second was never merged.”
- **Counts now align:** Yes/No.

---

## Quick reference

| Endpoint | When | Purpose |
|----------|------|--------|
| `GET /forensic?pbx=&kpi=&rows=` | Always | Full mismatch snapshot + forensic report |
| `GET /diagnostics` | Always | rawChannelCount, derivedActiveCount, activeCallSummary |
| `GET /telephony/health` | Always | activeCalls (same as getActive().length) |
| `GET /telephony/calls` | With JWT | Active calls list (tenant-scoped if tenantId in JWT) |

**Scripts:**
- `scripts/capture-forensic.ps1` — fetches GET /forensic and GET /diagnostics; writes `forensic_capture.json`, `diagnostics_capture.json`. Set `TELEPHONY_URL` if not localhost:3003.
- `scripts/analyze-forensic.js` — reads forensic_capture.json; prints derivedActiveCount, bucketCounts, and every non-legitimate activeCallsForensic entry with full fields. Usage: `node scripts/analyze-forensic.js [path]`.
- `scripts/compare-pbx-dashboard.sh` — runs PBX SSH snapshot + GET /forensic; writes `docs/audit/`. Requires TELEPHONY_URL and SSH to cursor-audit@209.145.60.79.
- `scripts/capture-live-mismatch.sh` — forensic-only (bash); run with PBX count, KPI, rows; writes a markdown report with full JSON.

---

## Cycle deliverable template (per Phase 1–5 cycle)

For each investigation/patch cycle, fill:

| # | Field | Value |
|---|--------|--------|
| 1 | PBX count | _(from audit snapshot or VitalPBX UI)_ |
| 2 | Dashboard KPI count | _(number shown in UI)_ |
| 3 | Dashboard row count | _(live calls table rows)_ |
| 4 | Backend derived count | _(forensic.derivedActiveCount)_ |
| 5 | Mismatch bucket counts | _(forensic.bucketCounts)_ |
| 6 | Exact bug identified | _(from traceNote + evidence)_ |
| 7 | Files changed | _(list)_ |
| 8 | Before vs after | _(after re-test)_ |

**Success:** Dashboard KPI and rows closely match PBX; no duplicate/helper/stale inflation; tenant scoping correct; no reconnect ghosts.
