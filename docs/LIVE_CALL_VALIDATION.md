# Live Call Engine — Validation / Verification

## PHASE A — Active Call Path Trace

### 1. Event source → store

```
AMI (AmiClient)  →  "event" with AmiFrame
  →  TelephonyService.handleAmiFrame()
  →  mapAmiFrame(frame) → typed event
  →  effectiveLinkedId(linkedid, uniqueid) for call key
  →  CallStateStore: upsertFromNewchannel / updateChannelState / onDialBegin / onBridgeEnter / onBridgeLeave / onHangup / onCdr / onQueueJoin / onTransfer
```

- **ARI**: Not used for live call state (read-only REST/actions only). No ARI event stream for channels.
- **Single source of truth**: CallStateStore (keyed by effective linkedId).

### 2. Store → broadcast / health / snapshot

```
CallStateStore
  ├── getActive()  =  calls.values().filter(c => c.state !== "hungup" && !isLocalOnlyCall(c))
  │
  ├── "callUpsert"  →  TelephonyBroadcaster.debouncedCallUpsert()
  │     └── if state === "hungup"  →  treat as remove only (pendingRemovals + scheduleFlushRemovals)
  │     └── else  →  debounce  →  socket.broadcast("telephony.call.upsert", normalizeCallForClient(call), tenantFilter)
  │
  ├── "callRemove"  →  TelephonyBroadcaster: cancel pending upsert, pendingRemovals.add, scheduleFlushRemovals
  │     └── flush  →  socket.broadcast("telephony.call.remove", { callId })
  │
  ├── HealthService.getHealth()  →  activeCalls: this.calls.getActive().length
  │
  └── SnapshotService.getSnapshot(tenantId)  →  calls = this.calls.getActive(); filter by tenant; map(normalizeCallForClient)
```

### 3. Snapshot on WS connect

```
Client connects with JWT (optional tenantId)
  →  TelephonySocketServer.sendSnapshot(client)
  →  snapshot.getSnapshot(client.tenantId)
  →  WS send "telephony.snapshot" with { calls, extensions, queues, health }
```

### 4. Frontend

```
useTelephonySocket:
  - snapshot  →  setCalls(new Map(snap.calls.map(c => [c.id, c])))
  - telephony.call.upsert  →  next.set(call.id, call)
  - telephony.call.remove  →  next.delete(callId)

TelephonyContext:
  - activeCalls  =  socket.calls.values().filter(c => c.state !== "hungup")
  - callsByTenant(tenantId)  =  tenantId === null ? activeCalls : activeCalls.filter(c => c.tenantId === tenantId)
```

### 5. Dashboard KPI and table

```
Dashboard page:
  - liveCalls  =  telephony.callsByTenant(isGlobal ? null : tenantId)   ← same list
  - wsActiveCalls  =  telephony.isLive ? liveCalls.length : null         ← KPI when WS live
  - displayActiveCount  =  wsActiveCalls ?? activeCallCount (API fallback)
  - Table  =  liveCalls
```
→ When WebSocket is live, **KPI and table use the same list** (liveCalls). Single truth.

### 6. Where active calls can still diverge

| Source | Derivation | Can diverge? |
|--------|------------|--------------|
| **WebSocket table** | Client Map from snapshot + upsert/remove; filtered by callsByTenant; display = liveCalls | No — same as KPI when WS live. |
| **Snapshot (on connect)** | getSnapshot(tenantId) → getActive() then tenant filter | **Yes** — SnapshotService used `c.tenantId === null \|\| c.tenantId === tenantId` for tenant scope, so tenant clients received unresolved calls in snapshot; UI then hid them via callsByTenant. Snapshot and table could show different counts until next event. **Fix**: SnapshotService strict tenant filter when tenantId set. |
| **KPI** | When WS live: liveCalls.length (same as table). When WS down: API activeCallCount. | Only if WS vs API are out of sync (expected when fallback). |
| **Health** | getHealth().activeCalls = calls.getActive().length (global, no tenant filter) | No — server truth. Admin telephony-status shows health.activeCalls (global) and activeCalls.length (context = client Map filtered by state). Both from same server store; client Map is replica. |
| **Diagnostics** | getDiagnostics().calls.derivedActiveCount = getActive().length | No — same getActive(). |

**Conclusion**: Snapshot and REST /telephony/calls now use strict tenant filter when tenantId set; getActive() excludes Local-only calls so all metrics are user-facing.

---

## PHASE B — Temporary Debug Logging (ENABLE_TELEPHONY_DEBUG=true)

Structured debug logs added; they run only when `ENABLE_TELEPHONY_DEBUG` is true:

| Log message | Location | Data |
|-------------|----------|------|
| `live_call: event_received` | TelephonyService.handleAmiFrame | event, linkedid, uniqueid |
| `live_call: tenant_resolved` / `tenant_unresolved` | TelephonyService (Newchannel) | linkedId, channel, tenantId |
| `live_call: disconnect_clearAll_triggered` | TelephonyService (AMI disconnected) | reason |
| `live_call: call_created` | CallStateStore.upsertFromNewchannel | callId, channel, tenantId |
| `live_call: call_merged_deduped` | CallStateStore.upsertFromNewchannel | callId, channel |
| `live_call: call_marked_ringing_or_talking` | CallStateStore.updateChannelState | callId, state |
| `live_call: call_marked_talking` | CallStateStore.onBridgeEnter | callId |
| `live_call: call_hungup` | CallStateStore.onHangup | callId, cause |
| `live_call: call_removed` | CallStateStore.emitCallRemove | callId |
| `live_call: call_removed_clearAll` | CallStateStore.clearAll | count, callIds |
| `live_call: call_removed_stale_cleanup` | CallStateStore.runStaleCleanup | callId |
| `live_call: snapshot_active_count` | TelephonyBroadcaster (snapshot timer) | snapshotActiveCount, wsClients |
| `live_call: websocket_upsert_broadcast` | TelephonyBroadcaster (debounced upsert) | callId, wsClients, snapshotActiveCount |
| `live_call: websocket_remove_broadcast` | TelephonyBroadcaster (flush removals) | removeCount, callIds, snapshotActiveCount |

---

## PHASE C — Verification Cases (Code-Level)

| Case | Expected | How the code satisfies it |
|------|----------|----------------------------|
| **1. No active calls** | Table empty, KPI 0, diagnostics derived active = 0 | getActive() returns []; snapshot/health/diagnostics all use getActive().length; frontend liveCalls = callsByTenant(...) from same Map; KPI = liveCalls.length. |
| **2. One inbound ringing** | One row, correct direction, sane duration, correct tenant or unresolved in admin only | Newchannel + Newstate set direction (inferDirection from context), state ringing; duration from normalizer (now - startedAt); tenant from TenantResolver; tenant view filters to c.tenantId === tenantId so unresolved only in master. |
| **3. One answered inbound** | Still one row, status talking, duration increments | BridgeEnter with bridgeNumChannels >= 2 sets state=up, answeredAt; normalizer computes duration from answeredAt → now; single call keyed by linkedId. |
| **4. One outbound** | One row, no duplicate helper/Local channels | effectiveLinkedId groups by linkedId; getActive() and broadcaster exclude isLocalOnlyCall(call); upsert for Local-only non-hungup is skipped in broadcaster. |
| **5. One internal ext-to-ext** | One row, direction internal, correct tenant | inferDirection returns "internal" for short exten/callerId; TenantResolver from context/exten. |
| **6. End the call** | Row disappears quickly, KPI decrements, no ghost | onHangup emits callRemove immediately; broadcaster sends remove only for hungup (no upsert); client deletes by callId; getActive() excludes state===hungup; runStaleCleanup evicts old hungup. |
| **7. Reconnect AMI** | clearAll runs, no stale, repopulate on new events | AMI "disconnected" handler calls calls.clearAll(); all callIds get callRemove; client state clears; new Newchannel/etc. repopulate. |
| **8. Switch tenant** | Only matching tenant visible; unresolved not in tenant view; master sees all | callsByTenant(tenantId): tenantId === null → activeCalls; else activeCalls.filter(c => c.tenantId === tenantId). Snapshot and GET /telephony/calls use same strict filter when tenantId set. |

---

## PHASE D — Local/Helper Channel Leakage

- **Check**: Calls whose channels are all `Local/*` were keyed by uniqueid when linkedid empty and could appear as separate rows.
- **Patch**: `isLocalOnlyCall(call)` in normalizers; `getActive()` excludes `isLocalOnlyCall(c)` so health, snapshot, KPI, diagnostics all count user-facing only. TelephonyBroadcaster skips debouncedCallUpsert for Local-only non-hungup (so they never appear in client Map); callRemove still sent when they hang up.

---

## PHASE E — Hungup Retention Safety

- **Check**: Do hungup-retained records affect getActive(), KPI, snapshot, diagnostics?
- **Result**: No. `getActive()` filters `c.state !== "hungup"`. Health, snapshot, diagnostics all use getActive() (or the same filter). Hungup calls are evicted after HANGUP_RETAIN_MS and emit callRemove; runStaleCleanup removes any that outlive the timer. Only true active calls affect visible metrics.

---

## PHASE F — Final Validation Output

### 1. Validation results per test case

- **1–8**: Satisfied by code paths above. Live PBX testing (place real calls, reconnect AMI, switch tenant) should be run in staging to confirm.

### 2. PBX count vs dashboard count

- **Single source**: When WebSocket is live, dashboard KPI and table both use `liveCalls` (callsByTenant of socket.calls filtered by state !== "hungup"). Server-side getActive() excludes hungup and Local-only; health.activeCalls and snapshot use it. After patch: effectiveLinkedId prevents empty-key merge; clearAll on disconnect prevents ghosts; immediate callRemove on hangup and no upsert for hungup keep client in sync. PBX and dashboard should align closely when AMI event flow is complete and tenant resolution matches.

### 3. Duplicates

- **Addressed**: Dedup by effectiveLinkedId; one row per linkedId; Local-only excluded from getActive() and from broadcaster upsert; hungup → remove only.

### 4. Tenant resolution failures

- **Unresolved** (tenantId null) still occur when TenantResolver cannot map context/channel/exten. They appear only in master view (tenantId === null). No random assignment to wrong tenant. Improving resolution (DID/trunk/context or VitalPBX metadata) is a future enhancement.

### 5. Code patches made during validation

| File | Change |
|------|--------|
| SnapshotService.ts | Strict tenant filter when tenantId set (c.tenantId === tenantId). |
| routes/telephony.ts | GET /telephony/calls strict tenant filter when tenantId set. |
| CallStateStore.ts | getActive() excludes isLocalOnlyCall(c). getDiagnostics() uses getActive(). Added emitCallRemove() and debug logs (ENABLE_TELEPHONY_DEBUG). |
| TelephonyService.ts | Debug logs for event_received, tenant_resolved/unresolved, disconnect_clearAll. |
| TelephonyBroadcaster.ts | Skip debouncedCallUpsert for isLocalOnlyCall(call) when not hungup. Debug logs for snapshot_active_count, websocket_upsert/remove_broadcast. |
| normalizers/normalizeCallEvent.ts | isLocalOnlyCall() exported; used by store and broadcaster. |

### 6. Production safety

- **Safe to deploy** from a live-call-engine perspective: no dialplan/trunk/route/IVR/queue changes; read-only monitoring; clearAll on disconnect may briefly show 0 calls until new events; ENABLE_TELEPHONY_DEBUG is off by default.
- **Recommend**: Run staging tests for cases 1–8 (real calls, reconnect, tenant switch). If API fallback is used when WS is down, ensure API active-calls endpoint uses the same tenant/strict logic so counts don’t diverge when switching between WS and API.

---

## Overcount fix (post real-world testing)

**Issue**: PBX showed ~2 active calls, dashboard showed ~7 (over-counting).

**Changes**:

1. **Bridge-based grouping (Phase 2)**  
   `CallStateStore` maintains `bridgeIndex: Map<bridgeId, canonicalCallId>`. On `BridgeEnter`, if another call already owns that bridge, the current call is merged into the canonical one (`mergeCallInto`). Ensures two legs of the same bridge = one row. `bridgeIndex` is cleared when a call is evicted or on `clearAll` / `runStaleCleanup`.

2. **Strict active filter (Phase 3)**  
   `getActive()` now only returns calls with:  
   - `state` in `["ringing", "dialing", "up", "held"]` (excludes `unknown`), and  
   - `!isLocalOnlyCall(c)` and `hasValidChannel(c)` (at least one non-helper channel).

3. **Helper channel filter (Phase 4)**  
   - `isHelperChannel(channel)`: `Local/`, `mixing/`, `Multicast/`, `ConfBridge/`.  
   - `isLocalOnlyCall(c)` uses `isHelperChannel` for every channel.  
   - `hasValidChannel(c)`: at least one channel is not helper.  
   - **TelephonyService**: when `linkedId` is empty and channel is helper, skip `upsertFromNewchannel` so helper-only legs with no linkedId never create a call.

4. **Instrumentation and sanity check (Phases 1, 6, 7)**  
   - `getDiagnostics()` returns: `rawChannelCount`, `derivedActiveCount`, `overcountSuspected` (true when derived > raw or derived > ceil(raw/2)+1), and when `ENABLE_TELEPHONY_DEBUG`: `activeCallSummary` (per-call callId, linkedId, uniqueIds, channels, bridgeIds, tenantId, state, isLocalOnly), `sampleMergedCall`, `sampleLocalIgnoredCall`.  
   - When `overcountSuspected` and debug on, log `live_call: overcount_suspected`.

5. **Phase 5 (single source)**  
   No change: dashboard already uses WS-only when `telephony.isLive` and API only when not; no merge of two sources.
