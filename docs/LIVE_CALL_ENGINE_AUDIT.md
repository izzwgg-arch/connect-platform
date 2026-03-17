# Live Call Engine — Phase 1 Audit Report

## 1. Where live calls are tracked

| Location | Role |
|----------|------|
| **apps/telephony/src/telephony/state/CallStateStore.ts** | Primary in-memory store. Map key = `linkedId`. Secondary index: `channelIndex` (uniqueid → linkedId). |
| **apps/telephony/src/telephony/services/TelephonyService.ts** | Wires AMI events → CallStateStore (Newchannel, Newstate, DialBegin, BridgeEnter/Leave, Hangup, Cdr, QueueCallerJoin, transfer). |
| **apps/telephony/src/telephony/websocket/TelephonyBroadcaster.ts** | Subscribes to store `callUpsert` / `callRemove`; debounces and broadcasts to WebSocket clients. |
| **apps/telephony/src/telephony/services/SnapshotService.ts** | `getActive()` → filters `state !== "hungup"`; used for initial snapshot and health. |
| **apps/telephony/src/telephony/services/HealthService.ts** | `activeCalls: this.calls.getActive().length` — same source. |
| **apps/portal/hooks/useTelephonySocket.ts** | Client: maintains `Map<string, LiveCall>` from snapshot + upsert/remove. |
| **apps/portal/contexts/TelephonyContext.tsx** | `activeCalls = socket.calls.values().filter(c => c.state !== "hungup")`; `callsByTenant(tenantId)` for scoping. |
| **apps/api (server.ts)** | Separate path: ARI polling for PBX live; `normalizePbxActiveCall`, `activeCallsList`. Dashboard uses WebSocket when live, else API fallback. |

## 2. Events listened to (AMI)

- **Newchannel** — create/update call by linkedId; add channel; set state from ChannelState.
- **Newstate** — update channel state (ringing, up, etc.).
- **DialBegin** — set direction (internal/outbound), state dialing.
- **DialEnd** — logged only.
- **BridgeEnter** — add bridge; if bridgeNumChannels >= 2 set state=up, answeredAt=now.
- **BridgeLeave** — remove bridge from call.
- **Hangup** — remove channel from call; when channels.length === 0 set state=hungup, endedAt, durationSec, schedule evict in 30s.
- **Cdr** — update durationSec/billableSec from CDR.
- **QueueCallerJoin**, **AttendedTransfer**, etc.

No ARI event subscription for call state (ARI used for REST actions only). No clear-state on AMI disconnect.

## 3. How calls are counted

- **Store:** `getActive()` = `calls.values().filter(c => c.state !== "hungup")`.
- **Health / snapshot:** Same.
- **Frontend:** `activeCalls = socket.calls.values().filter(c => c.state !== "hungup")`; count = length.
- **KPI:** Dashboard uses `liveCalls.length` when WebSocket live, else API `activeCallsList.length`. Single source when WS connected.

## 4. Why duplicates / stale calls may be happening

1. **Empty or missing Linkedid**  
   If AMI sends empty `Linkedid`, `g("Linkedid")` is `""`. All such channels share one call id `""`, merging unrelated channels; or per-channel behaviour depends on order. Using `linkedId || uniqueid` avoids empty key and prevents merging unrelated channels.

2. **No clear on AMI disconnect**  
   On reconnect we do not clear the store. Hangup events during disconnect are lost, so calls that ended while disconnected remain in the store until eviction (30s after last seen hangup), or forever if we never got Hangup. Result: ghost calls and inflated count.

3. **Hungup calls still broadcast**  
   When a call goes to `state=hungup` we emit `callUpsert` and 30s later `callRemove`. The broadcaster sends the hungup call to clients; they filter with `state !== "hungup"` so count is correct, but we could send `callRemove` immediately and not broadcast upsert for hungup to avoid stale entries and reduce traffic.

4. **ChannelState mapping**  
   `channelStateToCallState` only handles numeric `"0"`–`"7"`. If Asterisk sends text (`Down`, `Ringing`, `Up`), we map to `unknown`, which can confuse display but does not by itself create duplicates.

## 5. Why durations may be wrong

1. **Store sets durationSec only at hangup**  
   `durationSec = (endedAt - startedAt) / 1000`. We do not use `answeredAt`; spec says use answeredAt when present. So we should use `(endedAt - (answeredAt || startedAt))`.

2. **No live duration refresh**  
   For active calls we never update durationSec in the store; frontend computes from `answeredAt`/`startedAt` vs now. If frontend ever used `call.durationSec` from payload for an active call, it would show 0 or stale.

3. **Stale calls with old startedAt**  
   If a call is not removed (e.g. missed Hangup after disconnect), `duration = now - startedAt` can grow to absurd values (e.g. 8343 minutes). Need to remove stale calls and/or cap duration for display.

## 6. Where tenant filtering is broken or missing

- **TenantResolver** uses: channel PJSIP @domain, context map, extension prefix; else `null` (admin sees all).
- **SnapshotService.getSnapshot(tenantId)** filters calls/extensions/queues by tenant.
- **Broadcaster** uses `tenantFilter(call.tenantId)` so only relevant clients get the event.
- **Portal** `callsByTenant(tenantId)`: if `tenantId === null` return all; else filter `c.tenantId === null || c.tenantId === tenantId`. So unresolved (`null`) appear for everyone; tenant view shows that tenant + unresolved. Spec says unresolved should appear only in master/diagnostics. So we should filter tenant view to strict `c.tenantId === tenantId` (exclude null) unless we want admin to see “unresolved” in tenant view. Current behaviour: tenant view shows tenant + unresolved; master shows all. That can look like “wrong tenant” if many calls are unresolved.

---

## Summary of root causes (pre-fix)

| Issue | Likely cause |
|-------|----------------|
| Inflated count | Empty linkedId merging channels; no store clear on AMI disconnect (ghost calls). |
| Wrong duration | durationSec only at hangup and using startedAt instead of answeredAt; stale calls with old startedAt. |
| Duplicates | Same linkedId used for multiple logical calls (PBX) or empty linkedId; no dedup by channel. |
| Stale rows | callRemove 30s after hangup; no immediate remove; no clear on disconnect. |
| Tenant bleed | Unresolved (tenantId null) shown in tenant view; no strict tenant-only filter. |

---

# Phase 13 — Final Report (Post-Fix)

## 1. What was causing inflated active call counts

- **Empty `Linkedid`**: When AMI sent empty or missing `Linkedid`, the store used `""` as the call key. Multiple unrelated channels could merge into one call, or (depending on order) each channel could create separate calls keyed by empty string, leading to inconsistent duplication.
- **No clear on AMI disconnect**: After reconnect, the in-memory store was not cleared. Hangup events that occurred while disconnected were never received, so those calls stayed in the store until the 30s eviction timer (or forever if the timer didn’t run), appearing as ghost active calls.
- **Hungup calls still sent as upserts**: The broadcaster sent every `callUpsert`, including `state === "hungup"`. Clients kept these in their map until `callRemove` (up to 30s later), so the list could show recently ended calls until the remove arrived.

## 2. What was causing bad durations

- **Duration only at hangup and wrong reference**: `durationSec` was set only when the call hung up, using `endedAt - startedAt` instead of `endedAt - answeredAt`, so talk time was wrong when the call was answered.
- **No live duration for active calls**: For active calls, `durationSec` was not updated; the frontend had to compute from timestamps. The normalizer now computes live duration (answeredAt or startedAt → now) for active calls so the payload is correct.
- **Stale calls**: Ghost calls that were never removed (e.g. after disconnect) kept old `startedAt` values, so “now - startedAt” could become huge (e.g. 8343 minutes). Clearing state on disconnect and capping duration in the normalizer prevents this.

## 3. How deduplication now works

- **Effective call key**: For every AMI event that carries `linkedid` and `uniqueid`, we use `effectiveLinkedId(linkedid, uniqueid)`: if `linkedid` is non-empty (after trim), we use it; otherwise we use `uniqueid`. So we never key calls by `""`. Multiple legs of the same call still group by `linkedid`; single-legged or early events without `linkedid` get a per-channel key so they don’t merge incorrectly.
- **One row per call**: The store continues to group by this key (linkedId). Multiple channels with the same linkedId are one call; when all channels hang up, we mark the call hungup, emit `callRemove` immediately, and evict after 30s.
- **Hungup not broadcast as upsert**: The broadcaster treats `callUpsert` with `state === "hungup"` as a remove only: it cancels any pending upsert for that call and adds the id to removals, so clients never add/update with a hungup row; they only receive `telephony.call.remove`.

## 4. How tenant scoping now works

- **Portal `callsByTenant(tenantId)`**: If `tenantId === null` (master view), return all active calls. If `tenantId` is set (tenant view), return only calls where `c.tenantId === tenantId`. Unresolved calls (`tenantId === null`) no longer appear in tenant view; they appear only in master.
- **Backend**: SnapshotService and Broadcaster already filter by tenant for snapshots and broadcasts; no change. Tenant resolution (TenantResolver) is unchanged; only the portal filter was made strict for tenant view.

## 5. Files changed

| File | Change |
|------|--------|
| **apps/telephony/src/telephony/state/CallStateStore.ts** | Duration at hangup uses answeredAt when present; emit `callRemove` immediately when all channels hang up; added text ChannelState support (Down, Ringing, Up, etc.); `clearAll()` on disconnect; `runStaleCleanup()` and channelIndex cleanup on evict; `getDiagnostics()`. |
| **apps/telephony/src/telephony/services/TelephonyService.ts** | `effectiveLinkedId(linkedid, uniqueid)` for all call events; on AMI `disconnected` call `calls.clearAll()`. |
| **apps/telephony/src/telephony/websocket/TelephonyBroadcaster.ts** | For `callUpsert` with `state === "hungup"`, broadcast remove only (no upsert); call `calls.runStaleCleanup()` in snapshot timer. |
| **apps/telephony/src/telephony/normalizers/normalizeCallEvent.ts** | Live duration for active calls (answeredAt or startedAt → now); cap duration at 24h; null-safe from/to → "Unknown". |
| **apps/portal/contexts/TelephonyContext.tsx** | `callsByTenant(tenantId)`: tenant view strict `c.tenantId === tenantId` (exclude unresolved). |
| **apps/telephony/src/telephony/services/HealthService.ts** | `getDiagnostics()` for admin (calls + last AMI event). |
| **apps/telephony/src/routes/health.ts** | GET `/diagnostics` when `ENABLE_TELEPHONY_DEBUG=true`. |
| **docs/LIVE_CALL_ENGINE_AUDIT.md** | Phase 1 audit + Phase 13 final report. |

## 6. Risks that remain

- **ARI and API fallback**: The dashboard can use the API’s active-calls list when WebSocket is not connected. That path is separate; if the API returns a different set or count, the UI can still show a mismatch when switching between WS and API. Prefer a single source (WebSocket) when possible.
- **Tenant resolution**: Unresolved calls (tenantId null) still exist when context/channel/extension don’t match TenantResolver rules. Improving resolution (e.g. DID/trunk/context mapping or VitalPBX metadata) would reduce unresolved; not changed in this task.
- **Reconnect gap**: After AMI disconnect we clear all call state. Until the next Newchannel (or other) events, the dashboard shows 0 calls. Brief undercount is acceptable and preferable to ghost calls.

## 7. Whether the UI still needs later cleanup

- **No UI redesign**: No changes to dashboard layout or components; only data correctness and filtering.
- **Optional**: If the dashboard shows “Active Calls” from a different source (e.g. API) when WS is disconnected, consider unifying on one source or clearly labelling the source so admins know when they’re seeing telephony-engine vs API counts.
- **Duration display**: The payload now includes correct `durationSec` for active calls (and capped for ended). If the UI was computing duration client-side from timestamps, it can continue to do so or switch to `durationSec`; both should now match.
