# Connect PBX Observability & Diagnostics Platform — Architecture Plan

> **Status:** Design / architecture only. Nothing here is implemented. This plan
> describes a **strictly read-only** diagnostics system. It must never write to
> VitalPBX, AstDB, the `ombutel` MariaDB, generated Asterisk config, or trigger
> reloads/provisioning. Any future fix/apply path is explicitly out of scope and
> must require human approval.
>
> **Companion docs:** `docs/pbx/connect-pbx-control-plane-plan.md`,
> `docs/pbx/vitalpbx-native-object-lifecycle-investigation.md`,
> `docs/ai-context/TELEPHONY.md`, `docs/ai-context/WEBRTC_DIAGNOSTICS.md`,
> `docs/pbx-brain/PBX_ARCHITECTURE_PLAN.md`.
>
> **Design principle:** *reuse before you build.* Connect already has most of the
> raw signal sources (AMI, ARI, CDR, host metrics, WebRTC black-box). This plan
> mostly **persists, indexes, correlates, and surfaces** signals that are
> currently live-only or fire-and-forget.

---

## 1. Executive Summary

### What we are building
A long-term, **read-only** PBX observability layer inside Connect that ingests
every available telephony signal, normalizes it into a **single correlated call
timeline**, indexes it for fast multi-axis search, classifies failures, and
presents it through admin diagnostics screens. It records and explains:
inbound/outbound/failed/missed calls, voicemail routing, ring groups, queues,
IVRs, WebRTC/mobile behavior, extension registrations, trunk issues, tenant/DID
routing, caller-ID issues, VitalPBX *Apply Changes*/lifecycle changes, `ombutel`
object changes, Asterisk runtime events, generated-config changes, and
logs/errors.

### Why it is needed
Today the signal is **fragmented and ephemeral**:
- Live call state exists only in memory via `AriBridgedActivePoller`
  (`apps/telephony/src/telephony/ari/AriBridgedActivePoller.ts`) and
  `TelephonyService` (`apps/telephony/src/telephony/services/TelephonyService.ts`);
  it is not a queryable history.
- CDRs are persisted (`ConnectCdr` in `packages/db/prisma/schema.prisma`, ingested
  at `POST /internal/cdr-ingest` in `apps/api/src/server.ts`), but they are a
  **summary per call**, not a step-by-step trace. There is **no CEL ingestion**.
- AMI events are mapped (`apps/telephony/src/telephony/ami/AmiEventMapper.ts`) and
  acted on, then **discarded** — never stored for forensics.
- Registration/trunk state is **live-only** (ARI `/ari/endpoints`, AMI
  `PeerStatus`/`ContactStatus`); nothing is persisted.
- Asterisk full logs are reachable only via PBX-host shell scripts
  (`scripts/pbx/diag-*.sh`, `docs/pbx-audit/`), not in-app.

When a call fails, an operator currently cannot answer "what happened to *this*
call?" without SSH and manual log spelunking. This platform makes that a search.

### Why it must be read-only first
The native-object investigation
(`docs/pbx/vitalpbx-native-object-lifecycle-investigation.md`) proved that
VitalPBX's create/apply logic is ionCube-encoded and that direct writes risk
DB-vs-runtime drift. Diagnostics must therefore be **provably incapable of
mutation**: a dedicated read-only DB user, no AstDB `DBPut`, no `ombutel` writes,
no `asterisk -rx` reloads, no config edits. Observability earns the trust and the
evidence base required *before* any control-plane automation is even considered.

### How it helps future AI diagnostics
Every signal is normalized into citable, append-only events and timelines. A
future AI layer reads those normalized records to: summarize *why* a call failed,
compare expected vs actual route, detect drift, and **propose** (never apply)
fixes — always citing the exact `PbxEvent`/`PbxLogEvent` rows behind a finding.
The AI is a reader and recommender, gated behind human approval for any action.

---

## 2. Core Architecture

```
                         ┌───────────────────────── Connect (existing) ─────────────────────────┐
  VitalPBX / Asterisk    │                                                                       │
  ───────────────────    │   apps/telephony (collectors)            apps/api (ingest + read)     │
  AMI  ──────────────────┼─► AmiClient ─► AmiEventMapper ─► [NEW] PbxEventCollector ──┐          │
  ARI (REST) ────────────┼─► AriClient / AriBridgedActivePoller ─► [NEW] AriCollector ┤          │
  /var/log/asterisk ─────┼─► [NEW host-side read-only tail] ──────► /internal/pbx-log-ingest ────┼─► Postgres
  CDR (AMI Cdr) ─────────┼─► CdrNotifier ─► /internal/cdr-ingest ─► ConnectCdr (exists) ──┐       │   (hot store,
  AstDB (DBGet only) ────┼─► AmiClient.dbGet / astdb-read-family ─► [NEW] AstDbSnapshotter ┤      │    read-only
  ombutel (read SELECT) ─┼─► pbxOmbutel*Sync (exists) ─► [NEW] OmbuChangeWatcher ──────────┤      │    user for
  generated config ──────┼─► [NEW host-side hash/stat] ───────────► /internal/pbx-config-ingest ──┼─► queries)
  host metrics ──────────┼─► hostMetrics.collectHostMetrics (exists) ► serverHealthCache ─────────┤
                         │                                                                       │
                         │   apps/worker: deletion worker, disk monitor, aggregation (setInterval)│
                         └───────────────────────────────────────────────────────────────────────┘
```

All collectors **emit to a single ingest surface** following the existing
secret-authenticated `/internal/*` pattern (`/internal/cdr-ingest` with
`x-cdr-secret` + `timingSafeEqual` in `apps/api/src/server.ts`). Each ingest
endpoint writes only to the Connect Postgres diagnostics tables — never back to
the PBX.

### Collector designs

| Collector | Source / reuse | New work | Output table |
|-----------|----------------|----------|--------------|
| **AMI events** | `AmiClient` + `AmiEventMapper.mapAmiFrame` (already maps `Newchannel`, `DialBegin/End`, `BridgeEnter/Leave`, `Hangup`, `Cdr`, `QueueCaller*`, `ExtensionStatus`, `DeviceStateChange`, `PeerStatus`, `ContactStatus`, transfers, `MessageWaiting`) | A `PbxEventCollector` that fans mapped events to a batched, redacted ingest POST | `PbxAmiEvent`, `PbxEvent` |
| **ARI events** | `AriBridgedActivePoller.tick()` + `computeBridgedActiveCalls` | Persist poll deltas (channel/bridge create/destroy) instead of memory-only | `PbxAriEvent`, `PbxEvent` |
| **Asterisk logs** | none in-app today (greenfield) | Host-side read-only `tail -F /var/log/asterisk/full` shipper → `/internal/pbx-log-ingest`; classify level/module | `PbxLogEvent` |
| **CDR** | `CdrNotifier` → `ConnectCdr` (exists) | Link `ConnectCdr.linkedId` into the trace via `PbxCallTrace` | `ConnectCdr` (exists) + `PbxCallTrace` |
| **CEL** | none today (greenfield) | Optional: read-only CEL CSV/AMI `CEL` event shipper for fine-grained leg steps | `PbxCallRouteStep` |
| **PJSIP registration / contact status** | AMI `PeerStatus`/`ContactStatus`, ARI `getEndpointRegistrationCounts()` | Persist transitions (Reachable/Unreachable, contact add/remove) | `PbxRegistrationEvent`, `PbxDeviceState` |
| **Endpoint state** | ARI `getEndpoints()`, AMI `ExtensionStatus`/`DeviceStateChange` | Snapshot + change events | `PbxDeviceState` |
| **Bridge/channel lifecycle** | AMI `Newchannel`/`Newstate`/`BridgeEnter`/`BridgeLeave`/`Hangup`; ARI bridges | Persist as route steps + participants | `PbxCallRouteStep`, `PbxCallParticipant` |
| **Queue events** | AMI `QueueCallerJoin/Leave`, `QueueMemberStatus/Paused` | Persist join/leave/answer/abandon | `PbxEvent` (category=queue) + route steps |
| **Voicemail events** | AMI `MessageWaiting`; `Voicemail` model + `voicemailSyncCycle.ts`; `VoicemailIngestIncident` | Persist "reached voicemail" route step | `PbxEvent` (category=voicemail) |
| **MariaDB ombutel changes** | `pbxOmbutelInboundDidSync.ts`, `pbxOmbutelMohClassSync.ts` (read-only `SELECT` pattern) | Periodic read-only snapshot → row-level diff (hash per row) | `PbxDbChangeEvent` |
| **AstDB key changes** | `AmiClient.dbGet`, `/telephony/internal/astdb-read-family` (read), family-scope guard | Periodic read-only family snapshot → diff (NO `DBPut`) | `PbxDbChangeEvent` (source=astdb) |
| **VitalPBX GUI/API access logs** | none in-app (greenfield) | Host-side read-only shipper of VitalPBX/nginx access logs (who hit which module/`apply_changes`) | `PbxLogEvent` (category=access) |
| **Generated config file changes** | none in-app (greenfield) | Host-side read-only `sha256` + `stat` of `/etc/asterisk/vitalpbx/*.conf` → diff | `PbxConfigFileChange` |
| **System health** | `hostMetrics.collectHostMetrics()`, `HealthService.getHealth()`, `HealingEngine.getStatus()`, `serverHealthCache.ts` | Persist periodic samples + alert thresholds | `PbxEvent` (category=health) |

**Collector safety contract (applies to all):** input-only. AMI usage is limited
to read/inspection actions (`DBGet`, `Getvar`, `CoreShowChannels`,
`ExtensionStateList`, `PJSIPShowContacts`, `CEL`) — **never** `DBPut`, `Originate`,
`Hangup`, `Redirect`, `Setvar`. See §7 for the enforced allowlist.

---

## 3. Call Timeline Model

A single call is identified by Asterisk `linkedid` (already the join key for
`ConnectCdr`). The timeline is `PbxCallTrace` (one per `linkedid`) with ordered
children `PbxCallRouteStep` and `PbxCallParticipant`, assembled by correlating
AMI/ARI/CDR/log events that share the `linkedid`/`uniqueid`.

**Timeline stages captured (each = one `PbxCallRouteStep` with `stepType`,
`occurredAt`, `details` JSON, and source event ids):**

| Stage | Source signal | Notes |
|-------|---------------|-------|
| Call start | AMI `Newchannel` | `uniqueid`, channel, callerid |
| DID matched | inbound `did` + `TenantResolver.getInboundDid` / `ConnectCdr` context | from `PbxTenantInboundDid` / `CdrTenantRule` |
| Tenant resolved | `TenantResolver.resolve` + `ConnectCdr.tenantResolutionSource` | records *how* tenant was derived |
| IVR entered | AMI `Newexten`/context = IVR; AstDB IVR keys | overlay IVR via `connect/t_<slug>` |
| Digit pressed | AMI `DTMFEnd` / `VarSet` | captured read-only |
| Ring group / queue entered | AMI `QueueCallerJoin`, dialplan context | `PbxEvent` category |
| Extensions rung | AMI `DialBegin` per leg | one participant per leg |
| Device states | AMI `DeviceStateChange`/`ExtensionStatus`, ARI endpoints | `PbxDeviceState` |
| Answered by which ext/device | AMI `DialEnd` (ANSWER) + `BridgeEnter` | winning leg |
| Voicemail reached | AMI context=voicemail / `MessageWaiting` | route step |
| Hangup cause | AMI `Hangup` (`Cause`/`Cause-txt`) | Q.850 cause code |
| Bridge events | AMI `BridgeEnter`/`BridgeLeave`, ARI bridges | `computeBridgedActiveCalls` logic reused |
| Recording path | `VarSet` (recording filename, already intercepted) / `ConnectCdr.recordingPath` | path only; see §7 recordings |
| CDR result | `ConnectCdr` disposition/direction | authoritative summary |
| SIP response codes | AMI `Hangup`/PJSIP logs, log shipper | `PbxSipEvent` |
| Trunk used | outbound leg channel (`PJSIP/<trunk>`), `ConnectCdr` `:out` legs | trunk attribution |
| Failure reason | classifier (§4) over hangup cause + SIP code + route gap | `PbxDiagnosticFinding` |

**Assembly:** a worker correlation cycle (mirroring the existing `setInterval`
cycles in `apps/worker/src/main.ts`, e.g. `runPbxActiveCallPollCycle`) groups
buffered `PbxEvent` rows by `linkedid`, upserts `PbxCallTrace`, and appends route
steps idempotently. Late events (log lines arriving after CDR) reconcile by
`linkedid`. The mobile-side analogue already exists and can be mirrored:
`CallFlightSession` (`apps/mobile/src/diagnostics/CallFlightRecorder.ts`) and
`CallWakeEvent` — those feed the same `PbxCallTrace` where a mobile leg is present.

---

## 4. Search / Categorization Model

`PbxCallTrace` carries denormalized, indexed search columns; `PbxEvent` carries
fine-grained per-event indexes. All search is Postgres-native (GIN/btree), no new
search engine required for MVP.

**Search axes → backing column/index:**

| Axis | Column(s) | Index |
|------|-----------|-------|
| tenant | `PbxCallTrace.tenantId` | `@@index([tenantId, startedAt])` |
| extension | `PbxCallParticipant.extension` | `@@index([extension])` |
| phone number | `PbxCallTrace.callerNumber` / `connectedNumber` | btree |
| DID | `PbxCallTrace.did` | btree |
| trunk | `PbxCallTrace.trunk` | btree |
| SIP username | `PbxCallParticipant.sipUsername` | btree |
| callId / linkedid / uniqueid | `PbxCallTrace.linkedId`, `PbxEvent.uniqueId` | unique / btree |
| device | `PbxCallParticipant.deviceName`, `PbxDeviceState.deviceName` | btree |
| queue | `PbxCallRouteStep.queueName` | btree |
| ring group | `PbxCallRouteStep.ringGroup` | btree |
| IVR | `PbxCallRouteStep.ivrName` | btree |
| route | `PbxCallRouteStep.routeRef` | btree |
| failure type | `PbxCallTrace.failureType` (enum) | btree |
| hangup cause | `PbxCallTrace.hangupCause` (Q.850) | btree |
| date/time | `PbxCallTrace.startedAt` | btree (range) |
| caller ID | `PbxCallTrace.callerIdName`/`callerNumber` | btree / trigram |
| destination number | `PbxCallTrace.destinationNumber` | btree |

**Categorization (failure taxonomy)** — computed at assembly time and stored on
`PbxCallTrace.failureType` + `PbxDiagnosticFinding`:
`answered`, `missed_no_answer`, `busy`, `rejected`, `congestion`,
`no_route_did`, `tenant_unresolved`, `ivr_timeout`, `ivr_invalid`,
`queue_abandoned`, `queue_timeout`, `registration_failed`, `trunk_unreachable`,
`sip_4xx`, `sip_5xx`, `caller_id_mismatch`, `voicemail`, `unknown`. The classifier
reuses `CdrNotifier.deriveDisposition`/`normalizeDirection` and the WebRTC
incident heuristics in `packages/db/src/webrtcCallingIncidentService.ts`.

---

## 5. Storage Strategy

Goal: **never fill the disk.** Hot, searchable data lives in Postgres with tight
retention; raw bulk events are compressed/optional; a disk guardrail can hard-stop
ingestion.

- **Hot searchable tier (Postgres):** `PbxCallTrace`, `PbxCallParticipant`,
  `PbxCallRouteStep`, `PbxDiagnosticFinding`, plus recent `PbxEvent`/`PbxLogEvent`.
  This is what the UI and AI query.
- **Raw event archive (optional, compressed):** high-volume raw AMI/ARI/log lines
  written as gzip NDJSON to a capped local volume or object store, keyed by
  `linkedid`/day. Off by default; enabled per-instance. Never required for search.
- **Retention:** default **30 days**, configurable **60/90** via
  `PbxStorageRetentionPolicy` (admin screen). Per-event-type overrides (see §6).
- **Automatic deletion job:** a worker cycle (same `setInterval` pattern as
  `apps/worker/src/main.ts`) deletes rows past retention in batches, oldest-first,
  with a row-count cap per run to avoid long locks.
- **Disk usage guardrail:** reuse `hostMetrics.collectHostMetrics()` +
  `apps/api/src/ops/storageMaintenance/` (`df`/docker analysis). A monitor cycle
  records disk %; thresholds drive behavior.
- **Emergency stop:** when disk ≥ a hard threshold (e.g. 85%), ingestion endpoints
  return `503 ingest_paused_storage` and collectors buffer/drop with a counter; an
  `AuditLog` + incident is raised. Search/read stays available. Resumes when disk
  recovers below a low-water mark.
- **Sampling/aggregation for noisy events:** `DeviceStateChange`, `ContactStatus`
  qualify pings, and `VarSet` are high-frequency. Strategy: keep per-call
  correlated copies but **roll up** standalone churn into N-minute aggregates
  (count + last state) before storage; keep only state *transitions*, not repeats.
- **Secret redaction before storage:** every ingest path runs payloads through
  redaction (`apps/api/src/utils/safeDiagnosticRedaction.ts`
  `redactSecrets`/`redactBearerTokens`, and `packages/shared/src/webrtcBlackbox.ts`
  `redactSdpForDebug`/`redactSecretsDeep`) **before** the insert. SIP passwords are
  never accepted into any column (see §7).

---

## 6. Data Retention

Centralized in `PbxStorageRetentionPolicy` (one row per instance, plus optional
per-event-type rows). Defaults chosen to be safe on a small VM.

| Data class | Default | Configurable | Backing table(s) |
|------------|---------|--------------|------------------|
| Call timeline (traces/steps/participants) | 30 d | 60/90 d | `PbxCallTrace`, `PbxCallRouteStep`, `PbxCallParticipant` |
| Raw AMI/ARI events | 7 d | up to 30 d | `PbxAmiEvent`, `PbxAriEvent`, `PbxEvent` |
| Raw logs | 7 d | up to 30 d | `PbxLogEvent` |
| SIP events | 14 d | up to 60 d | `PbxSipEvent` |
| Registration/device state | 30 d | up to 90 d | `PbxRegistrationEvent`, `PbxDeviceState` |
| DB/object change events | 90 d | up to 365 d | `PbxDbChangeEvent` (low volume, high value) |
| Config file changes | 90 d | up to 365 d | `PbxConfigFileChange` |
| Diagnostic findings (summaries) | 90 d | up to 365 d | `PbxDiagnosticFinding` |
| Audit/event summary | 365 d | — | `AuditLog` (exists) |
| Compressed raw archive | off | 30 d cap | local gzip / object store |

Components:
- **Deletion worker:** batched, per-class, oldest-first; respects per-type policy;
  runs hourly. Modeled on `apps/worker/src/main.ts` cycles.
- **Disk monitor:** periodic `collectHostMetrics()` sample → `PbxEvent`
  (category=health) + guardrail state machine (§5 emergency stop).
- **Admin settings page:** "Storage / Retention Settings" (see §9) writes
  `PbxStorageRetentionPolicy` only (a Connect-owned table — *not* a PBX write).

---

## 7. Safety Guardrails

These are **hard, enforced constraints**, not guidelines.

1. **Read-only DB user (ombutel):** the `ombuMysqlUrlEncrypted` credential on
   `PbxInstance` must point to a MySQL account with `SELECT`-only grants. The
   change-watcher uses the same bounded `SELECT` pattern already proven in
   `apps/api/src/pbxOmbutelInboundDidSync.ts` / `pbxOmbutelMohClassSync.ts`. No
   `INSERT`/`UPDATE`/`DELETE` code paths exist in the watcher.
2. **No writes to ombutel:** enforced by (a) read-only grant, (b) code review ban
   on any non-`SELECT` SQL in collectors, (c) a unit test asserting the watcher
   SQL matches `^\s*select`.
3. **No AstDB writes:** collectors may call `AmiClient.dbGet` / the
   `/telephony/internal/astdb-read-family` read route only. **`DBPut` is
   forbidden** in all diagnostics code. (The existing `DBPut` at
   `/telephony/internal/ivr-publish` is *not* part of this platform.)
4. **No config edits / no reloads:** the platform never writes
   `/etc/asterisk/**` and never runs `asterisk -rx "... reload"`,
   `module reload`, `moh reload`, or `dialplan reload`. Config collection is
   `sha256`/`stat`/read only.
5. **No CLI commands unless allowlisted and read-only:** a single allowlist
   governs every host/AMI/ARI command. Allowed examples: AMI `CoreShowChannels`,
   `ExtensionStateList`, `PJSIPShowContacts`, `DBGet`, `Getvar`, `CEL`; ARI
   `GET /channels|/bridges|/endpoints|/asterisk/info`; host `df`, `tail -F` (read),
   `sha256sum`, `stat`. Everything else is denied by default.
6. **Secrets redacted:** all ingest runs `redactSecrets`/`redactBearerTokens`/
   `redactSdpForDebug`/`redactSecretsDeep` before insert.
7. **SIP passwords never stored:** `ombu_devices.secret` and any `password=` field
   from PJSIP config are dropped at the collector boundary; columns to hold them
   do not exist. Generated-config collection stores **hashes/diff metadata only**, and
   any line matching a secret pattern is redacted to `***` before storage.
8. **Tokens masked:** API/JWT/bearer tokens masked via existing redactors.
9. **Recordings handled carefully:** store the **path/reference only**
   (`ConnectCdr.recordingPath` already does this). No audio is copied into the
   diagnostics store. Playback (if ever added) goes through existing
   access-controlled recording routes, audited, tenant-scoped.
10. **Tenant isolation enforced:** every trace/event row carries `tenantId`;
    queries are tenant-scoped using the existing `connect/t_<slug>` convention and
    `TenantResolver`. Cross-tenant reads require super-admin and are audited. The
    family-scope guard pattern from `apps/telephony/src/routes/telephony.ts` is the
    reference model.
11. **Admin-only access:** diagnostics UI/API gated to admin/super-admin roles
    (same gating as `admin/incidents`, `admin/server-health`).
12. **Audit log for who viewed diagnostics:** every diagnostics query/trace view
    writes an `AuditLog` row (actor, action=`pbx_diag_view`, entity=trace id,
    tenant). Reuses the existing `AuditLog` model.

---

## 8. AI-Ready Diagnostic Layer (future)

The AI layer is a **reader and recommender only**. It is built last (Phase 5) on
top of the normalized store.

- **Reads normalized call timelines:** AI consumes `PbxCallTrace` + ordered
  `PbxCallRouteStep` + `PbxDiagnosticFinding`, never raw PBX.
- **Summarizes why a call failed:** produces a natural-language explanation tied to
  `failureType`, hangup cause, SIP code, and the missing/last route step.
- **Compares expected vs actual route:** "expected" derived from Connect's desired
  state (overlay AstDB keys, `DidRouteMapping`, `PbxTenantInboundDid`, queue/ring
  membership) vs "actual" from the trace. Divergence = drift.
- **Detects drift:** correlates `PbxDbChangeEvent` / `PbxConfigFileChange` /
  *Apply Changes* events with subsequent failure spikes.
- **Suggests fixes:** emits a `PbxDiagnosticFinding` of kind `recommendation`
  with a structured, **non-executable** proposal.
- **Cannot apply fixes without approval:** there is no write path. Any future
  apply path is a separate, human-gated system (see control-plane plan) and out of
  scope here.
- **Citations required:** every AI finding must reference exact event/log row ids
  (`PbxEvent.id`, `PbxLogEvent.id`, `linkedId`) so a human can verify. This mirrors
  the existing incident services
  (`packages/db/src/webrtcCallingIncidentService.ts`) which already attach evidence
  to incidents.

---

## 9. UI Design (proposed Connect screens)

All under `apps/portal/app/(platform)/` (admin-gated), reusing patterns from the
existing `admin/incidents`, `admin/call-timeline`, `admin/server-health`,
`pbx/*` screens and `apps/portal/services/pbxLive.ts`.

| Screen | Purpose | Reuses |
|--------|---------|--------|
| **PBX Live Monitor** | real-time active calls, registrations, AMI/ARI health | `AriBridgedActivePoller` snapshot, `HealthService`, `calls/health/page.tsx` |
| **Call Trace Search** | multi-axis search (§4) over `PbxCallTrace` | new; `pbxLive.ts` |
| **Single Call Timeline** | full step-by-step trace for one `linkedId` | extends `admin/call-timeline`, `CallFlightSession` view |
| **Tenant Diagnostics** | per-tenant call volume, failure mix, drift | `TenantResolver`, incident cards |
| **Extension Diagnostics** | per-extension calls, registration history, device state | `PbxExtensionLink`, `PbxDeviceState` |
| **DID Diagnostics** | per-DID inbound routing + failures | `PbxTenantInboundDid`, `DidRouteMapping` |
| **Trunk Diagnostics** | trunk reachability, outbound success/failure, SIP codes | `ConnectCdr` `:out` legs, `PbxSipEvent` |
| **Device Registration Monitor** | live + historical registration transitions | ARI endpoints, AMI `ContactStatus` |
| **PBX Object Lifecycle Recorder** | timeline of `ombutel`/config/Apply-Changes changes | `PbxDbChangeEvent`, `PbxConfigFileChange` |
| **Error Explorer** | searchable logs/errors with classification | `PbxLogEvent` |
| **Storage / Retention Settings** | configure retention, view disk usage | `PbxStorageRetentionPolicy`, `storageMaintenance/` |
| **AI Diagnosis View** | AI summaries + cited evidence (read-only) | `PbxDiagnosticFinding` |

---

## 10. MVP Plan (phased)

**Phase 1 — Call timeline from signals we already have (highest value, lowest risk)**
- Add `PbxEventCollector` fan-out from existing `AmiEventMapper` output (no new PBX
  access — events already flow through `TelephonyService`).
- Persist ARI poll deltas from `AriBridgedActivePoller`.
- Link existing `ConnectCdr` ingest into `PbxCallTrace`.
- Build assembly worker + `PbxCallTrace`/`PbxCallRouteStep`/`PbxCallParticipant`.
- Search by tenant/extension/DID/number; Single Call Timeline + Call Trace Search.
- 30-day retention + deletion worker + disk guardrail.
- **No MariaDB diffing, no log tailing, no config watcher yet.**

**Phase 2 — Logs + SIP/hangup classification + registration**
- Host-side read-only Asterisk log shipper → `/internal/pbx-log-ingest` →
  `PbxLogEvent`.
- SIP response/hangup-cause classification → `failureType` + `PbxSipEvent`.
- Device Registration Monitor (`PbxRegistrationEvent`, `PbxDeviceState`).

**Phase 3 — Change detection**
- Read-only `ombutel` change watcher (row-hash diff) → `PbxDbChangeEvent`.
- VitalPBX GUI/API access-log watcher (who ran *Apply Changes*) → `PbxLogEvent`.
- Generated config file watcher (sha/stat diff) → `PbxConfigFileChange`.

**Phase 4 — Object lifecycle recorder**
- Correlate change events into a per-object lifecycle view (manual PBX changes
  surfaced and attributable).

**Phase 5 — AI diagnosis summaries**
- `PbxDiagnosticFinding` generation, expected-vs-actual route comparison, cited
  summaries. Read-only.

**Phase 6 — Human-approved fix planning (still no auto-apply)**
- AI produces structured fix *plans*; a human approves; apply remains a separate,
  out-of-scope system requiring its own review.

---

## 11. Data Model Proposal (tables only — no migration here)

> Names follow existing Connect Prisma conventions (`packages/db/prisma/schema.prisma`):
> `cuid()` ids, `tenantId` FK with `onDelete: Cascade`, `createdAt`,
> `@@index` on hot search columns. **Proposal only — not to be migrated yet.**

- **`PbxEvent`** — normalized superset event. Fields: `id`, `tenantId?`,
  `pbxInstanceId`, `source` (ami/ari/log/cdr/astdb/ombu/config/health),
  `eventType`, `linkedId?`, `uniqueId?`, `occurredAt`, `severity`,
  `payload` JSON (redacted), `ingestedAt`. Indexes: `[linkedId]`,
  `[tenantId, occurredAt]`, `[source, eventType]`.
- **`PbxCallTrace`** — one row per `linkedId`. Denormalized search columns:
  `did`, `callerNumber`, `callerIdName`, `destinationNumber`, `connectedNumber`,
  `trunk`, `direction`, `disposition`, `failureType`, `hangupCause`,
  `answeredByExtension?`, `startedAt`, `answeredAt?`, `endedAt?`,
  `recordingPath?`, `cdrId?`. Indexes on every §4 axis.
- **`PbxCallParticipant`** — legs of a trace: `traceId`, `role`
  (caller/callee/trunk/queue_member), `extension?`, `deviceName?`,
  `sipUsername?`, `channel`, `uniqueId`, `connectedAt?`, `hangupCause?`.
- **`PbxCallRouteStep`** — ordered timeline steps: `traceId`, `seq`, `stepType`
  (did_matched/tenant_resolved/ivr/dtmf/queue/ringgroup/dial/bridge/voicemail/
  hangup), `occurredAt`, `ivrName?`, `queueName?`, `ringGroup?`, `routeRef?`,
  `details` JSON, `sourceEventId?`.
- **`PbxSipEvent`** — `traceId?`, `linkedId?`, `method?`, `responseCode?`,
  `reason?`, `peer?`, `occurredAt`. (From logs/AMI.)
- **`PbxAmiEvent`** — raw-ish mapped AMI event: `pbxInstanceId`, `event`,
  `linkedId?`, `uniqueId?`, `occurredAt`, `fields` JSON (redacted).
- **`PbxAriEvent`** — ARI poll delta: `pbxInstanceId`, `kind`
  (channel_up/down/bridge_create/destroy/registration_count), `channelId?`,
  `bridgeId?`, `occurredAt`, `snapshot` JSON.
- **`PbxLogEvent`** — `pbxInstanceId`, `category` (asterisk/access/error),
  `level`, `module?`, `linkedId?`, `message` (redacted), `occurredAt`,
  `sourceFile`, `lineHash`.
- **`PbxDeviceState`** — current/last state per device: `pbxInstanceId`,
  `tenantId?`, `deviceName`, `extension?`, `state`
  (reachable/unreachable/unknown), `contactUri?` (redacted), `changedAt`.
- **`PbxRegistrationEvent`** — append-only transitions: `pbxInstanceId`,
  `tenantId?`, `deviceName`, `extension?`, `transition`
  (registered/unregistered/reachable/unreachable), `occurredAt`, `details` JSON.
- **`PbxDbChangeEvent`** — `pbxInstanceId`, `source` (ombutel/astdb), `table?`,
  `keyOrPk`, `changeType` (insert/update/delete), `tenantId?`, `beforeHash?`,
  `afterHash?`, `redactedDiff` JSON, `detectedAt`.
- **`PbxConfigFileChange`** — `pbxInstanceId`, `path`, `sha256`, `prevSha256?`,
  `sizeBytes`, `mtime`, `changeType`, `detectedAt`. (No file contents stored if
  they may contain secrets; store redacted diff metadata only.)
- **`PbxDiagnosticFinding`** — `tenantId?`, `traceId?`, `kind`
  (failure_explanation/drift/recommendation), `severity`, `summary`,
  `evidenceEventIds` JSON (citations), `createdBy` (rule/ai), `createdAt`,
  `acknowledgedBy?`. **No executable action field.**
- **`PbxStorageRetentionPolicy`** — `pbxInstanceId`, `dataClass`, `retentionDays`,
  `archiveEnabled`, `diskHighWatermarkPct`, `diskLowWatermarkPct`, `updatedBy`,
  `updatedAt`.

---

## 12. Final Recommendation

**Should we build this before native provisioning? Yes — emphatically.** The
native-object investigation concluded NO-GO on provisioning until VitalPBX's
create/apply behavior is proven by observation. This platform *is* the observation
engine: it produces the evidence (object lifecycle, config diffs, Apply-Changes
correlation, failure causation) that any future control-plane work depends on.
Observability is the prerequisite, not a parallel track.

**Safest first deploy:** **Phase 1 only**, and only the parts that consume signals
Connect *already* receives — `AmiEventMapper` output, `AriBridgedActivePoller`
deltas, and existing `ConnectCdr`. This adds **zero new PBX access** (no new AMI
actions, no MariaDB watcher, no log shipper, no config reader) and is therefore
the lowest-risk increment. It ships a searchable call timeline with 30-day
retention, a deletion worker, and a disk guardrail.

**What must not be built yet:**
- Any write/apply/fix path (Phase 6 apply is explicitly deferred and human-gated).
- AstDB `DBPut`, `ombutel` writes, config edits, or reloads — never in this system.
- The AI layer (Phase 5) until the normalized store and redaction are proven in
  production for ≥30 days.
- Host-side log/config shippers (Phase 2/3) until the read-only host access and
  redaction-before-storage are reviewed and the disk guardrail is validated.

**What data is most valuable first:** the **correlated call timeline keyed by
`linkedId`** (inbound/outbound/failed/missed with hangup cause + tenant/DID/trunk
attribution). It answers the single most common operator question — "what happened
to this call?" — using data Connect already has, and it is the substrate every
later phase (drift detection, AI diagnosis) builds on.

---

## Ready-to-run implementation prompt — Phase 1 ONLY

> Paste the block below as the next task. It is scoped to read-only, no-new-PBX-access work.

```
Implement Phase 1 of the Connect PBX Observability & Diagnostics Platform as
specified in docs/pbx/connect-pbx-observability-diagnostics-platform.md.

STRICT SCOPE — Phase 1 only. Read-only. No new PBX access.
Do NOT add AstDB DBPut, ombutel writes, config edits, reloads, log tailing,
MariaDB diffing, or the AI layer. Those are later phases.

Goal: persist a correlated, searchable call timeline from signals Connect ALREADY
receives (no new AMI actions, no new sockets).

1. Prisma (packages/db/prisma/schema.prisma): add ONLY these models exactly as
   proposed in section 11 — PbxEvent, PbxCallTrace, PbxCallParticipant,
   PbxCallRouteStep, PbxStorageRetentionPolicy. Follow existing conventions
   (cuid ids, tenantId FK onDelete Cascade, createdAt, @@index on search axes).
   Generate a migration but DO NOT deploy it (migrations run only via the api
   deploy path per AGENTS.md). Stop after `prisma generate` + migration file.

2. Collector (apps/telephony): add a PbxEventCollector that subscribes to the
   ALREADY-MAPPED events from AmiEventMapper.mapAmiFrame (via TelephonyService)
   and the AriBridgedActivePoller 'update' deltas. Batch + redact
   (apps/api/src/utils/safeDiagnosticRedaction.ts: redactSecrets/redactBearerTokens;
   packages/shared/src/webrtcBlackbox.ts: redactSecretsDeep) and POST to a new
   secret-authenticated ingest endpoint. Reuse the AmiClient READ surface only —
   never DBPut/Originate/Hangup/Redirect/Setvar.

3. Ingest (apps/api/src/server.ts): add POST /internal/pbx-event-ingest, secured
   exactly like /internal/cdr-ingest (x-*-secret header + timingSafeEqual). Insert
   into PbxEvent only. Reject if disk guardrail tripped (503 ingest_paused_storage).

4. Assembly worker (apps/worker/src/main.ts): add runPbxTraceAssemblyCycle()
   following the existing setInterval cycle pattern (like runPbxActiveCallPollCycle).
   Group buffered PbxEvent rows by linkedId, upsert PbxCallTrace, append
   PbxCallRouteStep + PbxCallParticipant idempotently, and link existing ConnectCdr
   by linkedId. Reuse CdrNotifier.deriveDisposition/normalizeDirection for
   direction/disposition.

5. Retention + guardrail: add runPbxDiagRetentionCycle() that deletes rows past
   PbxStorageRetentionPolicy (default 30d) oldest-first in capped batches, and a
   disk monitor using apps/api/src/ops/hostMetrics.ts collectHostMetrics() that
   sets the emergency-stop flag at the high-water mark.

6. UI (apps/portal/app/(platform)/): add admin-gated "Call Trace Search" and
   "Single Call Timeline" screens querying PbxCallTrace/PbxCallRouteStep, with
   search by tenant/extension/DID/number. Write an AuditLog row (action
   pbx_diag_view) on every trace view. Reuse patterns from admin/call-timeline and
   services/pbxLive.ts.

Guardrails (enforce + add tests):
- No DBPut anywhere in the new code. No ombutel write. No asterisk -rx. No config
  writes. SIP passwords never inserted (assert no password/secret columns).
- All ingest payloads pass through redaction before insert (unit test).
- Every trace/event row carries tenantId where derivable; queries tenant-scoped.

Deliver: schema models + migration file (not deployed), telephony collector, api
ingest endpoint, worker assembly + retention cycles, two portal screens, and tests
for redaction + read-only invariants. Run tsc/tests for changed packages. Do not
deploy.
```
