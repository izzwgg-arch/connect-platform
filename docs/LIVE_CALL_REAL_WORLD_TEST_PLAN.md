# Live Call Engine — Real-World Test Plan

**Purpose**: Prove that the custom dashboard matches real PBX behavior during actual live calls.  
**Scope**: Read-only verification; no dialplan/trunk/route/IVR/queue or call-control changes.

---

## PREPARATION

### 1. Environment (staging/dev only)

- [ ] Set `ENABLE_TELEPHONY_DEBUG=true` in telephony service env (e.g. `.env` or deployment config).
- [ ] Restart telephony service so debug logs are active.
- [ ] Ensure `LOG_LEVEL=debug` or `trace` so `live_call:*` messages appear in logs.
- [ ] Note telephony base URL and JWT for API capture (e.g. `TELEPHONY_URL`, token with optional `tenantId`).

### 2. Capture tools

- **PBX**: Use VitalPBX/Asterisk UI or CLI to read “active calls” count (e.g. `asterisk -rx "core show channels"` or PBX dashboard).
- **Custom dashboard**: Browser on dashboard page; note KPI “Active Calls” and live calls table row count.
- **API**: Use `scripts/capture-telephony-state.sh` or manual curl (see below) for `/telephony/calls`, `/telephony/health`, `/diagnostics`.
- **WebSocket**: Browser DevTools → Network → WS → filter by telephony path; inspect frames for `telephony.call.upsert`, `telephony.call.remove`, `telephony.snapshot`, `telephony.health`.

**Capture script (from repo root):**
```bash
export TELEPHONY_URL="https://telephony.example.com"   # or http://localhost:3003
export TOKEN="<jwt from portal login; include tenantId in payload for tenant-scoped calls>"
bash scripts/capture-telephony-state.sh
```
**Manual curl:** `curl -sS -H "Authorization: Bearer $TOKEN" "$TELEPHONY_URL/telephony/health" | jq .` — same for `/telephony/calls`. For `/diagnostics`: `curl -sS "$TELEPHONY_URL/diagnostics" | jq .` (no auth when ENABLE_TELEPHONY_DEBUG=true).

### 3. Test run header (fill at start)

| Field | Value |
|-------|--------|
| **Date** | |
| **Time (start)** | |
| **Environment** | staging / dev |
| **PBX** | host / version |
| **Telephony service** | version / commit |
| **Portal** | version / commit |

---

## CAPTURE TEMPLATE (use per test step)

Copy this block for each capture point; add **Test #** and **Step** (e.g. “Test 2 – after call rings”).

```
--- CAPTURE ---
Test: ___
Step: ___
Time (UTC): ___

PBX active call count: ___
Custom dashboard KPI: ___
Live calls table row count: ___
Table sample (one row): { id, tenantId, direction, state, from, to, durationSec } = ___

GET /telephony/calls (tenantId if scoped):
___

GET /telephony/health:
___

GET /diagnostics (if ENABLE_TELEPHONY_DEBUG):
___

Relevant debug log lines (event_received, call_created, call_hungup, call_removed, snapshot_active_count, websocket_*):
___
--- END CAPTURE ---
```

---

## TEST MATRIX

### TEST 1 — Idle state

**Precondition**: No active calls in PBX (confirm via PBX UI or `core show channels`).

**Steps**:
1. Open custom dashboard (master or a tenant).
2. Capture using template above.

**Expected**:
- PBX active calls = 0
- Custom KPI = 0
- Live calls table empty
- `/telephony/calls` returns `[]` or no active rows
- `/diagnostics` → `calls.derivedActiveCount` = 0

**Pass / Fail**: ___

**Notes**: ___

---

### TEST 2 — One inbound call ringing

**Steps**:
1. Place one real inbound call to a known tenant (e.g. DID → tenant A).
2. Before answer, capture PBX count, dashboard KPI, table, API, diagnostics, and debug logs.

**Expected**:
- Exactly one row in live calls table
- Direction = inbound
- Duration sane (e.g. 0 or low seconds)
- Tenant = correct tenant or unresolved (if unresolved, row must appear only in master/admin view, not in tenant A view)
- No duplicate row

**Pass / Fail**: ___

**Notes**: ___

---

### TEST 3 — Answer inbound call

**Steps**:
1. Answer the inbound call from Test 2.
2. After answer, capture again (table, KPI, PBX count, duration).

**Expected**:
- Still exactly one row
- Status reflects talking (e.g. “Talking” or state `up`)
- Duration increments over time (e.g. 5s later, duration ~5s more)
- KPI remains aligned with PBX (e.g. 1)

**Pass / Fail**: ___

**Notes**: ___

---

### TEST 4 — Hang up inbound call

**Steps**:
1. Hang up the call (either party).
2. Capture immediately, then at 5s, 15s, 30s.

**Expected**:
- Row disappears quickly (within debounce + network, typically &lt; 1–2s)
- KPI decrements to 0 immediately after row disappears
- No ghost row at 5s, 15s, 30s
- `/diagnostics` → `calls.derivedActiveCount` = 0

**Pass / Fail**: ___

**Notes**: ___

---

### TEST 5 — One outbound call

**Steps**:
1. Place one real outbound call from a tenant extension (e.g. tenant A extension to external number).
2. Capture while call is active (ringing or answered).

**Expected**:
- Exactly one row
- Destination correct (to number)
- Tenant = tenant A (or unresolved only in master)
- No separate row for Local/ or helper channel
- PBX active count and dashboard KPI match (e.g. 1)

**Pass / Fail**: ___

**Notes**: ___

---

### TEST 6 — One internal extension-to-extension call

**Steps**:
1. Call from extension X to extension Y (same or same-tenant).
2. Capture while ringing and/or answered.

**Expected**:
- Exactly one row
- Direction = internal
- Correct tenant
- No double-leg duplication (two rows for one logical call)

**Pass / Fail**: ___

**Notes**: ___

---

### TEST 7 — Two simultaneous calls

**Steps**:
1. Establish two different active calls (e.g. one inbound answered, one outbound, or two internals).
2. Capture PBX count, dashboard KPI, table row count, API, diagnostics.

**Expected**:
- PBX count = 2 and dashboard KPI = 2 (or tenant-scoped count matches)
- Table shows exactly 2 rows (or tenant-scoped 2)
- No duplicate inflation (e.g. 3+ rows for 2 calls)

**Pass / Fail**: ___

**Notes**: ___

---

### TEST 8 — Tenant switching during live calls

**Steps**:
1. With at least one live call in tenant A (and optionally one in tenant B), open dashboard.
2. View as **master** → capture row count and which tenants appear.
3. Switch to **tenant A** → capture row count (expect only tenant A calls).
4. Switch to **tenant B** → capture row count (expect only tenant B calls).
5. Switch back to master → confirm no stale rows from previous tenant view.

**Expected**:
- Master sees all resolved calls (and unresolved if any)
- Tenant A sees only tenant A calls
- Tenant B sees only tenant B calls
- No stale rows after switching (e.g. tenant A row when viewing tenant B)
- Unresolved calls do not appear in tenant A or tenant B view

**Pass / Fail**: ___

**Notes**: ___

---

### TEST 9 — AMI reconnect scenario

**Steps** (staging/dev only; use safe method):
1. Trigger AMI disconnect (e.g. restart Asterisk AMI, or restart telephony service, or network blip if reproducible).
2. Confirm reconnect (telephony logs: “AMI connected”).
3. Check dashboard: expect 0 active calls immediately after reconnect (clearAll).
4. Place a new call after reconnect; capture PBX count, dashboard KPI, table.

**Expected**:
- clearAll fires (debug: `live_call: disconnect_clearAll_triggered` and `call_removed_clearAll` if there were calls).
- No stale ghost rows after reconnect.
- New live calls repopulate cleanly (one row per call, correct counts).
- No duplicate listeners or reconnect storm (check logs for repeated “AMI scheduling reconnect” without backoff).

**Pass / Fail**: ___

**Notes**: ___

---

### TEST 10 — API fallback consistency

**Steps**:
1. If the frontend has a mode that uses REST/snapshot instead of WebSocket (e.g. WS disconnected, or explicit fallback), trigger it.
2. With a known tenant and known active call count, open dashboard and capture KPI and table source (e.g. “Live via WS” vs “API”).
3. Verify tenant scope: switch to tenant A; confirm only tenant A calls and no unresolved in tenant view.

**Expected**:
- Counts still match tenant scope (no global count in tenant view).
- Unresolved does not leak into tenant view.
- Table and KPI use same source when WS is used; when on API fallback, both should reflect same snapshot/calls response.

**Pass / Fail**: ___

**Notes**: ___

---

## DEBUG OUTPUT FOR FAILED TESTS

For any failed test, capture:

1. **PBX count** (exact number and source, e.g. “VitalPBX dashboard = 2”).
2. **Dashboard KPI count** and **table row count**.
3. **Sample row payload**: one full JSON object from the table (or from `/telephony/calls`).
4. **Full `/diagnostics` response** (when debug enabled).
5. **Last relevant debug log lines** (grep or search for):
   - `live_call: event_received`
   - `live_call: tenant_resolved` / `live_call: tenant_unresolved`
   - `live_call: call_created`
   - `live_call: call_merged_deduped`
   - `live_call: call_hungup`
   - `live_call: call_removed`
   - `live_call: snapshot_active_count`
   - `live_call: websocket_upsert_broadcast`
   - `live_call: websocket_remove_broadcast`

Attach or paste into the test report under “Exact mismatches / debug capture”.

---

## BUG-FIX RULES (if live tests reveal issues)

- Only patch bugs **directly revealed** by these live tests.
- Keep changes **minimal and targeted** (no architecture rewrite).
- Do **not** touch unrelated UI, dialplans, trunks, routes, IVRs, queues, or call control.
- Preserve **read-only monitoring** design.

---

## FINAL TEST REPORT TEMPLATE

Fill after completing all tests.

### 1. Pass/fail summary

| Test | Description | Pass / Fail |
|------|-------------|-------------|
| 1 | Idle state | ___ |
| 2 | One inbound ringing | ___ |
| 3 | Answer inbound | ___ |
| 4 | Hang up inbound | ___ |
| 5 | One outbound | ___ |
| 6 | One internal ext-to-ext | ___ |
| 7 | Two simultaneous calls | ___ |
| 8 | Tenant switching | ___ |
| 9 | AMI reconnect | ___ |
| 10 | API fallback consistency | ___ |

### 2. Exact mismatches found

- _(List any mismatch: e.g. “Test 4: row remained visible for 45s”; “Test 7: table showed 4 rows for 2 calls”.)_

### 3. Minimal code fixes applied (if any)

- _(List file and change; e.g. “CallStateStore.ts: fixed eviction timer not firing when …”.)_

### 4. Final judgment

- [ ] **Production-ready** — All tests passed; no blocking issues.
- [ ] **Not yet** — _(List blocking issues and required fixes.)_

### 5. Remaining risk areas

- _(e.g. “Unresolved tenant resolution under context X”; “API fallback path rarely exercised”.)_

---

**Tester sign-off**: _________________ **Date**: _________________
