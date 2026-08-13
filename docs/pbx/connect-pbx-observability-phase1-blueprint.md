# Connect PBX Observability Platform — Phase 1 Implementation Blueprint & Gap Analysis

> **Mode:** Architecture review, implementation blueprint, and code inventory
> **only.** No code, no migrations, no deployment instructions, no PBX/ombutel
> access, no repo changes. This document analyzes Phase 1 of
> `docs/pbx/connect-pbx-observability-diagnostics-platform.md` (the source of
> truth) and produces an execution blueprint.
>
> **Phase 1 boundary (unchanged):** strictly read-only; consume **only signals
> Connect already receives** (mapped AMI events flowing through `TelephonyService`,
> `AriBridgedActivePoller` deltas, existing `ConnectCdr`). No new AMI actions, no
> new sockets, no log tailing, no MariaDB diffing, no AstDB reads, no AI layer.
>
> **Evidence base:** verified directly against
> `apps/telephony/src/telephony/ami/AmiEventMapper.ts`,
> `apps/telephony/src/telephony/ami/AmiClient.ts`,
> `apps/telephony/src/telephony/ari/AriBridgedActivePoller.ts`,
> `apps/api/src/server.ts` (`/internal/cdr-ingest`), `packages/db/prisma/schema.prisma`
> (`ConnectCdr`, `PbxCallEvent`, `AuditLog`), `apps/worker/src/main.ts`
> (`runPbxActiveCallPollCycle`/`runPbxCdrSyncCycle`/`runPbxJobCycle`),
> `apps/api/src/utils/safeDiagnosticRedaction.ts`, `packages/shared/src/webrtcBlackbox.ts`,
> `packages/security/src/index.ts`.

---

## 1. Executive Summary

Phase 1 is **low-risk and largely an assembly/persistence exercise**, not a new
data-acquisition project. Connect already **receives and type-maps** every AMI
event needed for a call timeline (`AmiEventMapper.mapAmiFrame` handles 18 event
types including `Newchannel`, `DialBegin/End`, `BridgeEnter/Leave`, `Hangup`,
`Cdr`, all queue events, transfers, and `MessageWaiting`) — but
`TelephonyService` **acts on them in memory and discards them**. There is no
queryable event history. CDR is the only persisted call artifact
(`ConnectCdr`, one summary row per `linkedId`), and live call state exists only
in the in-memory `AriBridgedActivePoller`.

**The core Phase 1 work is therefore:** (a) fan the already-mapped events to a
secret-authenticated ingest endpoint (clone of `/internal/cdr-ingest`), (b)
persist them redacted into `PbxEvent`, (c) correlate by `linkedId` into
`PbxCallTrace`/`PbxCallRouteStep`/`PbxCallParticipant` via a worker cycle that
mirrors the existing `runPbxActiveCallPollCycle` pattern, and (d) expose two
read-only admin screens. Redaction, encryption, audit, tenant-isolation, and
worker scheduling are all **already-solved primitives** that can be reused
verbatim.

**Biggest caveats Phase 1 must respect up front:**
1. `linkedId` is a strong primary correlation key (it is already `ConnectCdr`'s
   unique dedupe key) **but it breaks across transfers** — attended/blind
   transfers join *two* `linkedId`s, and the mapper already exposes the cross-IDs
   to stitch them. The trace model must store a `linkedId` set / stitch table, not
   assume one-trace-one-linkedId.
2. Several proposed **failure-taxonomy categories cannot be populated in Phase 1**
   (anything needing SIP response codes, Asterisk logs, IVR overlay digits, or
   registration history is Phase 2/3). Phase 1 should ship a **reduced taxonomy**
   derivable from Q.850 hangup cause + `ConnectCdr.disposition` + route-step
   presence, and explicitly mark the rest as "deferred".
3. `PbxEvent` is the **high-volume** table and must have the **shortest
   retention** (7 d), or it dominates disk.

**Verdict:** proceed with Phase 1, in the safe sequence in §8, starting with the
ingest endpoint + collector behind a default-off flag. AI features are **not**
reliably supported by Phase 1 data alone (see §9).

---

## 2. Reuse Inventory

| # | Component | File path | Purpose | Reuse suitability | Required changes |
|---|-----------|-----------|---------|-------------------|------------------|
| 1 | **AMI event mapper** | `apps/telephony/src/telephony/ami/AmiEventMapper.ts` | Maps raw `AmiFrame` → 18 typed events (verified) | **Direct reuse** — already produces exactly the timeline inputs | None to the mapper. Add a *consumer* downstream. |
| 2 | **AMI client (read surface)** | `apps/telephony/src/telephony/ami/AmiClient.ts` | TCP AMI, `dbGet`/`getVar`, `CoreShowChannels`; health fields (`lastEventAt`, `connectedSince`) | **Direct reuse, read-only** | None. Phase 1 must NOT call `sendAction("DBPut"/"Originate"/…)`. |
| 3 | **Telephony service (event hub)** | `apps/telephony/src/telephony/services/TelephonyService.ts` | Single place AMI frames are interpreted (`handleAmiFrame`); confirmed it does **not** persist events | **Hook point** for the new collector | Add a fan-out call to the collector; no behavior change. |
| 4 | **ARI bridged poller** | `apps/telephony/src/telephony/ari/AriBridgedActivePoller.ts` + `ariBridgedActiveCalls.ts` | Polls `/ari/bridges`+`/ari/channels`, emits `update`; `computeBridgedActiveCalls` derives active calls | **Direct reuse** — subscribe to `update` for live-state deltas | None to poller; add a delta subscriber (optional in Phase 1). |
| 5 | **CDR ingestion path** | `CdrNotifier.ts` → `POST /internal/cdr-ingest` (`apps/api/src/server.ts`) → `ConnectCdr` | Authoritative per-call summary; tenant resolution; `:out` leg split; `recordingPath` | **Direct reuse as a trace input** — link by `linkedId` | None. Trace assembly *reads* `ConnectCdr`; reuse `deriveDisposition`/`normalizeDirection`. |
| 6 | **Ingest endpoint pattern** | `/internal/cdr-ingest` secret-auth (`x-cdr-secret` + `timingSafeEqual`) | Proven internal, nginx-blocked, secret-authed write surface | **Template** for `/internal/pbx-event-ingest` | Clone the auth guard; new handler inserts `PbxEvent` only. |
| 7 | **Host metrics / disk** | `apps/api/src/ops/hostMetrics.ts` (`collectHostMetrics`), `ops/storageMaintenance/*`, `serverHealthCache.ts` | CPU/RAM/disk sampling | **Direct reuse** for the disk guardrail | None; read `df`/cgroup values for high-water-mark check. |
| 8 | **WebRTC diagnostics (pattern)** | `apps/api/src/voice/webrtcCallDiagnostics.ts`, `packages/db/src/webrtcCallingIncidentService.ts`, `apps/portal/.../admin/call-timeline` | Existing diagnostics ingest + incident + timeline UI patterns | **Pattern reuse** (not data) — model the timeline UI + finding shape on these | None in Phase 1 (WebRTC events are a Phase ≥2 timeline input). |
| 9 | **Audit system** | `AuditLog` model (`schema.prisma`) | Generic actor/action/entity/tenant audit | **Direct reuse** for "who viewed diagnostics" | Add `action="pbx_diag_view"` rows from the read API; no schema change. |
| 10 | **Redaction** | `apps/api/src/utils/safeDiagnosticRedaction.ts` (`redactSecrets`, `redactBearerTokens`, `redactUrlsWithCredentials`); `packages/shared/src/webrtcBlackbox.ts` (`redactSecretsDeep`, `redactSdpForDebug`) | Strip secrets/tokens/creds before storage | **Direct reuse** — run on every payload pre-insert | None; compose both before insert. |
| 11 | **Encryption** | `packages/security/src/index.ts` (`encryptJson`/`decryptJson`, AES-256-GCM) | Envelope for credentials | **Reuse if needed** (e.g. ingest secret handling) | Phase 1 stores no secrets, so mostly N/A. |
| 12 | **Worker patterns** | `apps/worker/src/main.ts` — `runPbxActiveCallPollCycle` (597), `runPbxJobCycle` (635), `runPbxCdrSyncCycle` (959); `setInterval` loops with overlap guards | DB-polled background cycles, no BullMQ | **Direct reuse** — clone the cycle shape for assembly + retention | Add `runPbxTraceAssemblyCycle` + `runPbxDiagRetentionCycle` in the same style. |
| 13 | **DB-polled job table pattern** | `PbxJob` (`schema.prisma`, `PbxJobStatus`, `nextRunAt`, `attempts`) | Proven status/next-run polling | **Pattern reuse** if assembly needs durable cursors | Optional: a cursor like `PbxCdrCursor` for assembly progress. |
| 14 | **Admin UI patterns** | `apps/portal/app/(platform)/admin/call-timeline`, `admin/incidents`, `calls/health/page.tsx`; `apps/portal/services/pbxLive.ts` | Admin-gated, tenant-aware list/timeline screens + client service | **Direct reuse** for the two Phase 1 screens | Add Call Trace Search + Single Call Timeline pages following these. |
| 15 | **Tenant isolation** | family-scope guard in `apps/telephony/src/routes/telephony.ts`; `TenantResolver` + `PbxTenantMapCache`; `connect/t_<slug>` convention; `tenantId` + `@@index` on every call model | Tenant scoping for events/queries | **Direct reuse** — set `tenantId` at ingest/assembly via `TenantResolver`; scope all reads | None; apply the existing convention to new tables. |

**Net:** of the 15 reusable components, **11 are direct reuse**, 4 are
pattern/hook reuse. Phase 1 introduces **one** new PBX-adjacent code path (the
telephony collector), and it is a **pure read consumer** behind a flag.

---

## 3. Event Coverage Matrix

Source = "mapped today by `AmiEventMapper`" unless noted. "Stored today?" reflects
the verified fact that `TelephonyService` consumes mapped events in memory and
does **not** persist them; only end-of-call `ConnectCdr` is stored.

| Signal source | Event | Existing mapping | Stored today? | Needed for timeline? | Gap |
|---------------|-------|------------------|---------------|----------------------|-----|
| AMI | `Newchannel` | ✅ `AmiNewchannel` (uniqueid, linkedid, callerid, context, exten) | ❌ (memory only) | ✅ call start, caller, entry context | **Persist** |
| AMI | `Newstate` | ✅ `AmiNewstate` | ❌ | ◑ ringing/up transitions | Persist (low priority) |
| AMI | `DialBegin` | ✅ `AmiDialBegin` (dest, destUniqueid, dialString) | ❌ | ✅ legs rung, ring-group fan-out | **Persist** |
| AMI | `DialEnd` | ✅ `AmiDialEnd` (dialStatus) | ❌ | ✅ which leg answered/failed | **Persist** |
| AMI | `BridgeEnter` | ✅ `AmiBridgeEnter` (bridgeUniqueid, type) | ❌ | ✅ answer/talk, who connected | **Persist** |
| AMI | `BridgeLeave` | ✅ `AmiBridgeLeave` | ❌ | ✅ talk end | **Persist** |
| AMI | `Hangup` | ✅ `AmiHangup` (`cause`, `causeTxt`) | ❌ (cause only on `ConnectCdr.hangupCause`) | ✅ failure/terminal cause | **Persist per-channel** |
| AMI | `Cdr` | ✅ `AmiCdr` → drives `CdrNotifier` | ✅ `ConnectCdr` | ✅ authoritative summary | **None** (reuse) |
| AMI | `QueueCallerJoin`/`Leave` | ✅ typed | ❌ | ✅ queue enter/abandon | **Persist** |
| AMI | `QueueMemberStatus`/`Paused` | ✅ typed | ❌ | ◑ agent availability context | Persist (P1.5) |
| AMI | `ExtensionStatus` | ✅ `AmiExtensionStatus` (hint/status) | ❌ | ◑ device/hint state | Persist as device-state (Phase 2 deeper) |
| AMI | `DeviceStateChange` | ✅ `AmiDeviceStateChange` | ❌ | ◑ device state (noisy) | **Sample/aggregate** (Phase 2 deeper) |
| AMI | `PeerStatus` | ✅ `AmiPeerStatus` (registration up/down) | ❌ | ◑ registration history | Phase 2 (registration monitor) |
| AMI | `ContactStatus`/`Detail` | ✅ `AmiContactStatus` (reachable/RTT) | ❌ | ◑ registration/reachability | Phase 2 |
| AMI | `AttendedTransfer` | ✅ carries **orig+second transferer linkedids + transferee linkedid** | ❌ | ✅ **stitch two linkedIds** | **Persist + stitch (critical)** |
| AMI | `BlindTransfer` | ✅ carries transferer+transferee linkedids, target ext | ❌ | ✅ **stitch two linkedIds** | **Persist + stitch (critical)** |
| AMI | `MessageWaiting` | ✅ `AmiMessageWaiting` (mailbox, new/old) | ❌ | ◑ "reached voicemail" hint | Persist (weak signal; pairs with context) |
| ARI | bridge/channel poll deltas | ✅ `AriBridgedActivePoller`/`computeBridgedActiveCalls` | ❌ (memory only) | ◑ live monitor + bridge corroboration | Persist deltas (optional P1) |
| CDR | end-of-call summary | ✅ `ConnectCdr` | ✅ | ✅ summary, tenant, recordingPath | **None** |
| WebRTC/mobile | session/black-box/flight events | ✅ `CallFlightSession`, WebRTC diag endpoints | ✅ (separate stores) | ◑ client-leg correlation | Phase ≥2 (link by number/time/linkedId) |
| Ring group | (no dedicated AMI event) | derived from `DialBegin/End` fan-out + dialplan context | ❌ | ✅ ring-group leg set | **Derive** from Dial events (no native event) |
| Voicemail | (no dedicated "entered VM" event) | inferred from `context`/`MessageWaiting`/`Voicemail` model | partial (`Voicemail`) | ✅ VM route step | **Derive** (weak in Phase 1) |
| Registration | (see PeerStatus/ContactStatus) | ✅ mapped | ❌ | ◑ | Phase 2 |
| SIP response codes | — | ❌ not in AMI map (lives in Asterisk logs) | ❌ | ✅ for `sip_4xx/5xx` | **Phase 2 (log shipper)** — NOT Phase 1 |

**Highlighted missing observability coverage (Phase 1):**
- **No SIP response codes** (need Asterisk full-log; Phase 2). Limits failure
  taxonomy precision.
- **No native ring-group/voicemail events** — must be *derived* from Dial events
  and dialplan context; will be approximate until log/IVR-overlay instrumentation.
- **Transfer stitching** is the single most important non-obvious requirement and
  is fully supported by data already mapped — must not be skipped.
- **Registration history** persistence is Phase 2, so "extension can't register"
  diagnostics are not yet answerable.

---

## 4. LinkedId Correlation Design Review

**Is `linkedId` sufficient as the primary correlation key?**
**Mostly yes, with one structural exception (transfers).** `linkedId` is already
Asterisk's intended "same call" identifier and is `ConnectCdr.linkedId @unique`.
For a simple inbound/outbound call — including ring-group fan-out and queue
delivery — all legs share one `linkedId`, so it is a sound primary key. **But a
single logical call can span multiple `linkedId`s after a transfer**, so the trace
model must treat `linkedId` as a **set with a stitch table**, not a 1:1 key.

**Where `linkedId` can be lost or change:**
- **Attended/blind transfers** create a new call segment; the bridged-to call has
  a different `linkedId`. The `AttendedTransfer`/`BlindTransfer` events expose both
  sides' linkedids (verified in mapper) — these are the stitch edges.
- **Local channel optimization** (`Local/...@ctx`) used by ring groups, queues,
  follow-me: legs normally inherit the parent `linkedId`, but `/n` (no-optimize)
  vs optimized collapse changes channel/uniqueid topology and can momentarily
  reparent.
- **Originate** (click-to-call, mobile push-wake via `CallInvite`): the originated
  channel may start with its own `linkedId` before being bridged to the target.
- **`:out` forwarded legs** (find-me/follow-me to external): `ConnectCdr` already
  splits these into `:out` rows under the same `linkedId` — trace must represent
  them as participants, not separate traces.
- **Parking / retrieval**: park-and-retrieve can re-bridge under a different
  `linkedId`.
- **Asterisk restart**: `uniqueid` (`epoch.seq`) namespace resets; cross-restart
  `linkedId` collisions are possible — disambiguate by `startedAt` window.

**Where call forks occur:** ring groups and queues (one caller → many simultaneous
`DialBegin` legs/Local channels); find-me/follow-me (sequential external legs);
simultaneous mobile + desk ring.

**Queue transfers:** caller `linkedId` is preserved into the agent leg
(`DialBegin` → Local/queue-member); the agent's device leg is a child channel
under the same `linkedId`. Abandonment = `QueueCallerLeave` without a `BridgeEnter`.

**Attended transfers:** two independent calls exist (A↔B, then B↔C) each with its
own `linkedId`; `AttendedTransfer` ties `OrigTransfererLinkedid` +
`SecondTransfererLinkedid` + `TransfereeLinkedid`. Trace = union of both linkedIds
joined by the transfer edge.

**Blind transfers:** transferer parks/redirects transferee to a new extension;
`BlindTransfer` carries `TransfererLinkedid` + `TransfereeLinkedid` + target
`Extension`. Same stitch requirement.

**Ring groups create additional legs:** each member rung = a `DialBegin`/`DialEnd`
pair (+ child `Newchannel`) under the parent `linkedId`; the winner gets
`BridgeEnter`, losers get `Hangup` cause 26 (`ANSWERED_ELSEWHERE`) / 16. These are
**participants of one trace**, not separate traces.

### Correlation risk table

| Scenario | Likelihood | Impact on timeline | Mitigation (Phase 1) |
|----------|-----------|--------------------|----------------------|
| Attended transfer splits `linkedId` | Medium | High (call appears as 2 disjoint traces) | Persist `AttendedTransfer`; store stitch edges; trace = linkedId set |
| Blind transfer splits `linkedId` | Medium | High | Persist `BlindTransfer`; same stitch model |
| Ring-group fan-out misread as many calls | High | Medium | Group child legs by parent `linkedId`; mark as participants |
| Local channel optimization reparents | Medium | Medium | Key on `linkedId` first; keep `uniqueid` + channel for fallback join |
| Originate `linkedId` differs pre-bridge | Medium | Medium | Correlate via `CallInvite`/originate actionId + time + number |
| `:out` follow-me leg double-counts | Medium | Low | Reuse `ConnectCdr` `:out`/`isForwarded` semantics |
| Cross-restart `linkedId` collision | Low | Low | Disambiguate by `startedAt` window + instance id |
| Missing events during AMI reconnect | Medium | Medium | Tolerate gaps; reconcile from `ConnectCdr` at call end; mark `partial` |
| Clock skew telephony↔api | Low | Low | Use Asterisk event time as authoritative; store ingestedAt separately |

**Design recommendation:** `PbxCallTrace` should carry a **`rootLinkedId`** plus a
**`linkedIds string[]`** (or a `PbxCallTraceLink` stitch table) and a
`completeness` flag (`complete` / `partial` / `stitched`). Assembly keys on
`linkedId`, then merges via transfer edges.

---

## 5. Timeline Storage Strategy Review

**Scaling assumptions (stated, adjustable):** mid-scale Connect platform ≈ **10,000
calls/day** across all tenants; average **~30 AMI events/call** (ring-group/queue
calls higher), **~12 route steps/call**, **~4 participants/call**. Standalone
device/registration churn is **excluded from Phase 1** (Phase 2), so noise is
bounded. These are planning figures; instrument and re-measure after Step 1.

| Table | Purpose | Est. daily rows | Read freq | Retention | Indexes | Partitioning |
|-------|---------|-----------------|-----------|-----------|---------|--------------|
| `PbxEvent` | Raw normalized event log (assembly input + audit) | ~300k | Low (assembly worker + rare drill-down) | **7 d** (shortest) | `[linkedId]`, `[tenantId, occurredAt]`, `[source, eventType]` | **Recommended** — daily/weekly range partition or BRIN on `occurredAt` |
| `PbxCallTrace` | One row per logical call (search + UI) | ~10k (+ stitched merges) | **High** (every search/UI) | 30 d (→60/90) | every §4 axis (`tenantId,startedAt`; `linkedId` unique; `did`; `callerNumber`; `trunk`; `failureType`; `hangupCause`) | Not yet (small); revisit at 90 d |
| `PbxCallRouteStep` | Ordered timeline steps | ~120k | Medium (open one trace) | 30 d | `[traceId, seq]`, `[stepType]`, `[queueName]`, `[ringGroup]` | Optional at 90 d (BRIN on `occurredAt`) |
| `PbxCallParticipant` | Legs per call | ~40k | Medium | 30 d | `[traceId]`, `[extension]`, `[sipUsername]`, `[deviceName]` | No |
| `PbxStorageRetentionPolicy` | Config (one row/instance + per-class) | ~tens total | Low | n/a | `[pbxInstanceId, dataClass]` | No |

**Volume estimates (steady state):**

| Horizon | `PbxEvent` (7 d cap) | `PbxCallTrace` | `PbxCallRouteStep` | `PbxCallParticipant` |
|---------|---------------------|----------------|--------------------|----------------------|
| Daily | ~300k rows | ~10k | ~120k | ~40k |
| 30-day | **~2.1M** (7 d retention) | ~300k | ~3.6M | ~1.2M |
| 90-day | **~2.1M** (still 7 d) | ~900k | ~10.8M | ~3.6M |

**Disk (order-of-magnitude):** `PbxEvent` row w/ redacted JSON payload ≈ 1–2 KB →
**~2.1M × 1.5 KB ≈ 3–4 GB** steady-state at 7 d. Traces/steps/participants are
narrow rows (~0.2–0.5 KB) → **~3–6 GB** at 90-day trace retention. **Total Phase 1
hot footprint ≈ 6–10 GB** — comfortably within guardrail. **Sensitivity:** at
50,000 calls/day, multiply ×5 (~30–50 GB) — at which point `PbxEvent` retention
should drop to 3 d and partitioning becomes mandatory.

**Recommendations:**
- Give `PbxEvent` the **shortest retention (7 d, configurable down to 3 d)**; it is
  an assembly buffer + forensic tail, not long-term search.
- **Partition `PbxEvent` by time** (or BRIN index on `occurredAt`) before any
  scale beyond ~25k calls/day; cheap deletes via partition drop.
- Keep `PbxCallTrace` lean and fully indexed — it is the only **high-read** table.
- Do **not** store raw JSON on `PbxCallTrace`; keep JSON on `PbxEvent`/steps.
- Enforce **redaction-before-insert** on `PbxEvent` (largest secret-exposure
  surface).

---

## 6. Admin UI Gap Analysis

Phase 1 ships **2 screens**; the rest are listed for completeness with phase
ownership.

| Screen | Existing reusable components | Existing tables | Existing filters/search | Missing components | Priority |
|--------|------------------------------|-----------------|-------------------------|--------------------|----------|
| **Single Call Timeline** | `admin/call-timeline` page, `CallFlightSession` viewer, incident evidence panels | `ConnectCdr`, (new) `PbxCallTrace`/`RouteStep`/`Participant` | linkedId lookup | Step renderer for new route-step types; transfer-stitch view | **P0** |
| **Call Trace Search** | `admin/incidents` list pattern, `services/pbxLive.ts`, `calls/health` filters | (new) `PbxCallTrace` | tenant/date filters exist in calls UI | Multi-axis filter bar (DID/trunk/number/failureType) | **P0** |
| **PBX Live Monitor** | `AriBridgedActivePoller` snapshot, `HealthService`, `calls/health/page.tsx` | live (no table) | — | Live registration list | P1 |
| **Tenant Diagnostics** | tenant cards, incident banners | `PbxCallTrace`, `ConnectCdr` | tenant scoping via `TenantResolver` | Failure-mix charts | P1 |
| **Extension Diagnostics** | extension lists (`pbx/extensions`) | `PbxExtensionLink`, (new) participant | — | Per-ext registration history (needs Phase 2) | P1 |
| **DID Diagnostics** | `admin/cdr-tenant-map`, phone-numbers screens | `PbxTenantInboundDid`, `DidRouteMapping` | DID lookup | Inbound route trace join | P1 |
| **Trunk Diagnostics** | — | `ConnectCdr` `:out` legs | — | SIP-code join (Phase 2) | P2 |
| **Device Registration Monitor** | ARI endpoints, `ContactStatus` | (new, Phase 2) | — | Registration history store (Phase 2) | P2 |
| **PBX Object Lifecycle Recorder** | — | (new, Phase 3) | — | ombutel/config watchers (Phase 3) | P2 |
| **Error Explorer** | — | (new, Phase 2) | — | Log shipper (Phase 2) | P2 |
| **Storage / Retention Settings** | server-health/storage-health pages, `storageMaintenance/*` | `PbxStorageRetentionPolicy` | — | Settings form | P1 (needed once data flows) |
| **AI Diagnosis View** | incident evidence UI | (new, Phase 5) | — | AI layer | P2 |

**Phase 1 UI scope = the two P0 screens.** Both reuse existing admin-gating,
`pbxLive.ts`-style services, and the `admin/call-timeline` rendering pattern. The
only genuinely new component is a **multi-axis filter bar** and a **route-step/
transfer-stitch renderer**.

---

## 7. Failure Taxonomy Review

**Proposed (source doc):** `answered, missed_no_answer, busy, rejected, congestion,
no_route_did, tenant_unresolved, ivr_timeout, ivr_invalid, queue_abandoned,
queue_timeout, registration_failed, trunk_unreachable, sip_4xx, sip_5xx,
caller_id_mismatch, voicemail, unknown`.

**Problems found:**
- **Conflates two axes.** `answered`/`voicemail` are *terminal dispositions*, not
  failures. `caller_id_mismatch` is a *quality finding*, not a call outcome.
- **Not Phase-1-derivable:** `sip_4xx`, `sip_5xx`, `registration_failed`,
  `trunk_unreachable`, `ivr_timeout`, `ivr_invalid` need SIP/log/overlay signals
  absent in Phase 1.
- **Overlaps/duplicates:** `busy` ⊂ Q.850 cause 17; `rejected` ⊂ `sip_4xx` ⊂ cause
  21; `congestion` ⊂ cause 34/42; `missed_no_answer` overlaps `ConnectCdr.disposition="missed"`.
- **Missing:** `canceled` (caller hung up pre-answer — distinct from missed),
  `blocked` (blacklist), `no_agents_available`, `max_queue_full`,
  `transfer_failed`, `early_media_no_answer`.

**Final recommended taxonomy — two axes:**

**Axis A — `terminalDisposition`** (always set; Phase-1-derivable from
`ConnectCdr.disposition` + Q.850 cause):
`answered` · `voicemail` · `missed` · `busy` · `canceled` · `failed` · `unknown`

**Axis B — `failureClass`** (set only when not `answered`/`voicemail`; tagged by
the **earliest phase** that can populate it):

| failureClass | Source phase | Signal |
|--------------|-------------|--------|
| `no_answer_timeout` | **P1** | `DialEnd` NOANSWER + no `BridgeEnter` |
| `busy` | **P1** | cause 17 / `DialEnd` BUSY |
| `congestion` | **P1** | cause 34/42 |
| `caller_canceled` | **P1** | caller `Hangup` before `BridgeEnter` |
| `no_route_did` | **P1** | inbound with unresolved destination / no route step |
| `tenant_unresolved` | **P1** | `ConnectCdr.tenantResolutionSource` empty/`unknown` |
| `queue_abandoned` | **P1** | `QueueCallerLeave` before bridge |
| `queue_timeout` | **P1** | queue exit by timeout context |
| `ring_group_no_answer` | **P1** | all members NOANSWER/26 |
| `rejected` | **P2** | SIP 4xx (logs) |
| `trunk_error` | **P2** | SIP 5xx / `PeerStatus` Unreachable |
| `registration_failed` | **P2** | `ContactStatus`/`PeerStatus` history |
| `ivr_timeout` / `ivr_invalid` | **P2/3** | IVR overlay/dialplan instrumentation |
| `blocked_blacklist` | **P3** | dialplan/log |
| `unknown` | any | fallback |

**`caller_id_mismatch` is removed from failure taxonomy** and becomes a
`PbxDiagnosticFinding` (quality), Phase ≥2.

**Phase 1 ships:** full Axis A + the 9 **P1** `failureClass` values, with the rest
present in the enum but documented as "not yet populated".

---

## 8. Phase 1 Build Sequence

Ordered so **each step is independently deployable and safe to ship alone** (even
though deploys may be bundled nightly). Every step is reversible and, until the
final UI step, **invisible to users and inert toward the PBX**.

> Note on migrations: per `AGENTS.md`, schema changes ship **only** via the API
> deploy path's `prisma migrate deploy`. The sequence specifies *order*; it does
> not generate or run migrations here.

| Step | Goal | Dependencies | Risk | Validation | Rollback |
|------|------|--------------|------|-----------|----------|
| **0. Schema (additive)** | Add `PbxEvent`, `PbxCallTrace`, `PbxCallParticipant`, `PbxCallRouteStep`, `PbxStorageRetentionPolicy` (only FK = `Tenant`) | none | **Low** (purely additive, no reads/writes yet) | `prisma validate`; shadow-DB diff; tables empty | Tables unused; drop in a later additive migration |
| **1. Ingest endpoint** | `POST /internal/pbx-event-ingest` (secret-auth clone of `/internal/cdr-ingest`), redaction-before-insert, disk-guard short-circuit, writes `PbxEvent` only | Step 0 | **Low** (no caller yet; nginx-blocked; insert-only) | Staging curl with secret → row appears redacted; bad secret → 401 | Feature flag / remove route; no data dependency |
| **2. Telephony collector (flag OFF)** | `PbxEventCollector` subscribes to already-mapped events in `TelephonyService`, batches, POSTs to Step 1; env flag default off; **read-only** (no new AMI actions) | Step 1 | **Low–Med** (touches telephony, but pure consumer behind flag) | Enable in staging; confirm `PbxEvent` fills; confirm zero new AMI actions emitted; AMI health unchanged | Set flag off → collector inert; no PBX impact |
| **3. Assembly worker** | `runPbxTraceAssemblyCycle` (clone of `runPbxActiveCallPollCycle`): group `PbxEvent` by `linkedId`, upsert trace/steps/participants, **stitch transfers**, link `ConnectCdr` | Steps 0–2 + data flowing | **Med** (correlation logic) | Compare trace count & dispositions vs `ConnectCdr` for same window (±tolerance); spot-check transfers | Disable cycle; traces stale but harmless; raw `PbxEvent` retained |
| **4. Retention + disk guardrail** | `runPbxDiagRetentionCycle` (batched, per-class, oldest-first) + disk high-water-mark stop using `collectHostMetrics` | Steps 0–3 | **Low–Med** (deletes data) | Dry-run counts before delete; verify guardrail flips ingest to 503 in staging | Disable deletion; raise threshold; data simply grows (monitored) |
| **5. Read API + 2 screens** | Tenant-scoped read endpoints + Call Trace Search + Single Call Timeline; `AuditLog action=pbx_diag_view` on every view | Steps 0–4 | **Low** (read-only, admin-gated) | Visual QA; tenant-isolation test (cross-tenant denied); audit rows written | Hide nav entry / disable routes |

**Independence rationale:** Steps 0–1 ship value-neutral plumbing. Step 2 is the
only telephony change and is a flagged pure consumer. Steps 3–4 operate entirely
on Connect-owned Postgres data. Step 5 is read-only UI. Any single step can land
in a nightly bundle without requiring the next.

---

## 9. AI Readiness Assessment

| AI capability | Supported by Phase 1 data? | Why / what's missing |
|---------------|---------------------------|----------------------|
| **Call explanation** ("what happened to this call") | **Yes (good)** | Full `linkedId` timeline (start → dial → bridge → hangup) + `ConnectCdr` summary is sufficient to narrate a call. |
| **Failure explanation** | **Partial** | Axis-A disposition + Q.850 cause + route-gap covers the **P1** failure classes. **Missing SIP response codes, registration state, IVR digits** → cannot explain rejects, trunk/registration failures, or IVR mis-routes. Needs Phase 2 logs. |
| **Drift detection** | **No** | Requires `PbxDbChangeEvent` / `PbxConfigFileChange` / *Apply Changes* correlation (Phase 3) and a desired-state baseline. Phase 1 has no change feed. |
| **Configuration recommendation** | **No** | Requires native-object state (ombutel read, Phase 3) + the lifecycle evidence the native-object investigation called for. Not present. |
| **Tenant health scoring** | **Partial** | Call success/abandon/missed rates per tenant are derivable from `PbxCallTrace`. **Missing** registration health, trunk health, and config-change context for a *trustworthy* score. Ship as a provisional "call-outcome score" only. |

**Telemetry required before AI is reliable:** (1) **SIP response codes + Asterisk
logs** (Phase 2) — the single biggest unlock; (2) **registration/contact history**
(Phase 2); (3) **ombutel + generated-config change feed** (Phase 3) for drift/config
advice; (4) **IVR overlay digit/step events** for IVR diagnosis; (5) an explicit
**expected-route/desired-state** source to compare against actual. Until (1)–(2)
exist, constrain AI to **call/failure explanation over completed traces**, always
citing `PbxEvent.id`/`linkedId`, and **never** drift/config recommendations.

---

## 10. Final Recommendation

**Build Phase 1 as specified — it is low-risk, high-leverage, and almost entirely
reuse.** Connect already maps every required AMI event and already persists the
authoritative CDR; Phase 1 mostly stops *discarding* the mapped events and
correlates them. Reuse the proven `/internal/cdr-ingest` auth pattern, the
`setInterval` worker cycles, the redaction/audit/tenant-isolation primitives, and
the `admin/call-timeline` UI pattern.

**Three non-negotiables for Phase 1 to be correct:**
1. **Model `linkedId` as a set with transfer stitching** (not 1:1). The data to do
   this is already mapped (`AttendedTransfer`/`BlindTransfer`).
2. **Ship the reduced, two-axis failure taxonomy** — do not promise SIP/registration/
   IVR-derived classes Phase 1 can't populate.
3. **`PbxEvent` gets the shortest retention (7 d) + redaction-before-insert** and a
   path to time-partitioning before scale.

Defer AI to after Phase 2 (logs/SIP/registration). Phase 1's durable win is the
**searchable, transfer-aware call timeline** answering "what happened to this
call?" from data Connect already has — with zero new PBX access.

---

### Top 5 architectural risks
1. **Transfer `linkedId` splitting** silently fragments calls into disjoint traces if stitching is skipped. *(Mitigation: persist + stitch transfer events from day one.)*
2. **`PbxEvent` volume/retention** dominates disk if kept too long or un-partitioned. *(7 d + BRIN/partition; guardrail.)*
3. **Collector coupling to `TelephonyService`** — a bug or backpressure in the consumer must never degrade live call handling. *(Flag-gated, fire-and-forget, bounded queue, drop-on-pressure with a counter.)*
4. **Secret leakage via raw event payloads** (callerid, channel vars, SDP-ish fields). *(Mandatory `redactSecretsDeep`/`redactSecrets` before every insert; no password columns.)*
5. **Tenant misattribution** at event time (events arrive before tenant resolved). *(Resolve via `TenantResolver`/`ConnectCdr` at assembly; allow `tenantId=null` then backfill; scope reads defensively.)*

### Top 5 unknowns
1. **Real event volume per call** on this VitalPBX build (ring-group/queue multiplier) — estimates need live measurement after Step 1.
2. **Local-channel optimization behavior** here (does it reparent `linkedId`/collapse uniqueids?) — affects fan-out grouping.
3. **AMI event completeness during reconnects** — how many events are lost per `AmiClient` reconnect, and assembly's tolerance.
4. **Originate/push-wake correlation** — whether originated `linkedId` reliably matches the bridged call (ties to `CallInvite`).
5. **Voicemail/ring-group "entered" detection** accuracy from context alone without overlay/log signals.

### Top 5 easiest wins
1. **Persist + expose the call timeline** from already-mapped events (Steps 1–3) — the headline feature, minimal new code.
2. **Reuse `/internal/cdr-ingest` auth** verbatim for the new ingest endpoint.
3. **Link `ConnectCdr` into traces** by `linkedId` — instant summary + `recordingPath` + tenant on every trace.
4. **`AuditLog action=pbx_diag_view`** — diagnostics-access auditing with zero schema change.
5. **Disk guardrail from `collectHostMetrics`** — reuse existing host-metrics for the emergency stop.

### Recommended first implementation task
**Step 1 — the `POST /internal/pbx-event-ingest` endpoint** (secret-authed clone of
`/internal/cdr-ingest`, redaction-before-insert into `PbxEvent`, disk-guard
short-circuit), preceded by the additive Step 0 schema. It is independently
deployable, inert until a collector exists, touches neither the PBX nor live call
handling, and unblocks everything downstream.

### Recommended first nightly deploy bundle
**Steps 0 + 1 together** (additive schema + ingest endpoint, no caller yet), then
**Step 2 with the collector flag defaulted OFF**. This lands all plumbing with zero
behavioral change; the collector can then be enabled per-environment under
observation, and assembly/retention/UI (Steps 3–5) follow in subsequent nightly
bundles once `PbxEvent` flow is validated.
