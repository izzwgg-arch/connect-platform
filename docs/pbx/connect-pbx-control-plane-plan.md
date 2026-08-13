# Connect as the VitalPBX Control Plane — Architecture & Phasing Plan

> **Status:** Audit / research only. No deploy, no PBX writes, no schema changes,
> no AstDB writes proposed by this document. This is a map of what exists today,
> what is safe to control, and a phased plan to get there.
>
> **Method:** Evidence gathered from `docs/pbx-brain/` (read-only PBX knowledge
> bundle), the Connect monorepo (`apps/api`, `apps/telephony`, `apps/portal`,
> `packages/integrations`, `packages/db`), and existing `docs/pbx/` runbooks.
> Every claim below is tagged **[proven]**, **[likely]**, **[unknown]**, or
> **[unsafe-until-tested]** and cites the file(s) it came from.

---

## 1. Executive Summary

### Is this possible?

**Yes — partially today, and the rest is reachable — but only along one specific
architecture.** Connect already operates as a working, audited control plane for
the call-flow objects it owns: **IVR routing, Music-on-Hold, hold announcements,
and DID → tenant routing**. It does this not by mutating native VitalPBX objects,
but by writing **tenant-scoped Asterisk AstDB keys** that a small set of shared,
hand-installed dialplan contexts read at call time (the "Option A" overlay model).
That path already has desired-state tables, publish, pre-publish snapshots,
rollback, drift detection, an audit trail, and a tenant-isolation guard. **[proven]**

The hard constraint that shapes everything: **the documented VitalPBX v4 REST API
does not expose write endpoints for extensions, trunks, outbound/inbound routes,
ring groups, or native IVRs.** The Connect adapter explicitly throws
`NOT_SUPPORTED` for every one of those writes. **[proven —
`packages/integrations/src/vitalpbx/client.ts:471-514`]** So "Connect controls the
full PBX lifecycle" can only mean one of:

1. **Overlay control** (proven, low risk) — Connect owns routing/behaviour via
   AstDB + shared contexts and never touches native VitalPBX objects. This is the
   current architecture and should be the backbone.
2. **REST control where VitalPBX allows it** (medium risk) — tenants, queues,
   tenant inbound-number routing, account/auth/AI codes. These have real write
   endpoints. **[proven — `endpointRegistry.ts`]**
3. **Direct datastore control** (high risk, not yet done for native objects) —
   writing `ombutel` MariaDB or generating VitalPBX config for extensions/trunks/
   routes. Today Connect only **reads** `ombutel` and uses a **narrow, snapshotted
   PBX-host helper** to flip a single `destination_id` column. **[proven —
   `apps/api/src/pbxOmbutelInboundDidSync.ts`, `docs/pbx/inbound-route-helper.md`]**

### What parts are low risk

- **Read-only inventory of everything** (tenants, extensions, trunks, routes,
  queues, MOH classes, inbound DIDs, live channels). Most of this is already
  built. **[proven]**
- **IVR / MOH / hold / DID-routing control via AstDB overlay** — already in
  production with snapshot + rollback + audit. **[proven]**
- **Tenant enable/disable and queue CRUD via REST** — documented endpoints exist
  and the client wraps them. **[proven]**

### What parts are medium / high risk

- **Extension lifecycle (create/disable/credentials)** — no REST write path;
  requires either VitalPBX GUI, `ombutel` writes, or a new PBX-host helper.
  **Medium-high.**
- **Trunks, outbound routes, inbound routes (native), caller-ID/CNAM,
  STIR/SHAKEN** — no REST write path, carriage-affecting, emergency-call
  implications. **High.**
- **Native IVRs / ring groups / time conditions as VitalPBX objects** — no REST
  write path. Connect's *own* IVR overlay is the safer substitute. **Medium.**
- **Emergency / 911 routing** — must be treated as **do-not-touch** until a
  dedicated, separately-reviewed workstream exists. **Highest.**

### What should be controlled first

Extend what already works: **Phase 0 read-only inventory + drift detection**,
then deepen the **already-proven overlay** (IVR/MOH/DID). Do **not** start with
extensions, trunks, or routes.

### What should not be touched yet

Trunks, outbound routes, native inbound routes, caller-ID/STIR/SHAKEN/CNAM, and
**anything 911/emergency**. Also: never write `ombutel` tables directly for
native objects, and never bypass the telephony service to write AstDB. **[proven
rule — `docs/ai-context/ASTDB_KEYS.md`, `AGENTS.md`]**

---

## 2. Current-State Map

Legend for "How to write":
`REST` = documented VitalPBX `api_v2` endpoint · `AstDB` = AMI `DBPut` via
telephony service · `Helper` = PBX-host loopback Python helper · `MySQL(ro)` =
read-only `ombutel` query · `GUI/Manual` = VitalPBX web UI or SSH ·
`None` = no safe path proven.

| Object | Lives in (VitalPBX/Asterisk) | Connect reads? | Connect writes? | Safe API path | Write mechanism required | Proof |
|--------|------------------------------|----------------|-----------------|---------------|--------------------------|-------|
| **Tenants** | `ombu_tenants` (MariaDB) + `T{n}_` runtime prefix | **Yes** → `PbxTenantDirectory` | **Yes** (create/update/delete/enable/disable/apply) | REST | REST `tenants.*` | `pbxTenantDirectorySync.ts`; `client.ts:410-430`; `endpointRegistry.ts:98-107` |
| **Extensions** | `ombu_pjsip_devices` / extensions module | **Yes** → `Extension`+`PbxExtensionLink` (incl. enc. SIP pw, WebRTC device) | **No** (PBX side) | **None (REST)** | GUI/Manual or future Helper/MySQL | `pbxExtensionSync.ts`; `client.ts:471-485` throws `NOT_SUPPORTED` |
| **Devices / SIP creds** | `ombu_pjsip_devices`, device profiles | **Yes** (device list, secret, profile, WebRTC) | **No** to PBX; **Yes** Connect-side (`sipPasswordEncrypted`) | None (REST) | GUI/Manual or Helper | `pbxExtensionSync.ts:186-225`; `client.ts:483` |
| **Trunks** | `ombu_trunks`, `pjsip__50-*-trunks.conf` | **Yes** (`trunks.list/get`) | **No** | None (REST) | GUI/Manual | `client.ts:488-497` throws on create/update/delete |
| **Inbound routes (native)** | `ombu_inbound_routes` | **Yes** via `MySQL(ro)` → `PbxTenantInboundDid` | **Indirect** (flip `destination_id` only) | Helper | Helper (snapshotted) or REST `tenants.addInboundNumbers` | `pbxOmbutelInboundDidSync.ts:28-37`; `docs/pbx/inbound-route-helper.md` |
| **Inbound routing (Connect overlay)** | AstDB `connect/didmap/<e164>/*` + `[connect-tenant-ivr]` | **Yes** (`DidRouteMapping`) | **Yes** (publish + snapshot + rollback) | AstDB | AMI `DBPut` via telephony | `schema.prisma:3516-3563`; `telephony.ts:589-659` |
| **Outbound routes** | `ombu_outbound_routes` + members/patterns | **Yes** (`outboundRoutes.list`) | **No** (PBX); Connect has own `OutboundRoute` perms model | None (REST) | GUI/Manual | `client.ts:499-505`; `schema.prisma:2263` |
| **IVRs (native VitalPBX)** | `ombu_ivrs`, `ombu_ivr_entries` | **No** (no list endpoint) | **No** | None (REST) | n/a — superseded by overlay | `client.ts:511-514` throws |
| **IVRs (Connect overlay)** | AstDB `connect/t_<slug>/*` + `[connect-tenant-ivr]` | **Yes** (`IvrRouteProfile`, `IvrOptionRoute`) | **Yes** (publish/rollback/schedule/override) | AstDB | AMI `DBPut` | `schema.prisma:3094-3217`; `pbx/ivr-routing/page.tsx` |
| **Ring groups** | `ombu_ring_groups` | Partial (read attempt via MySQL list helper) | **No** | None (REST) | GUI/Manual | `client.ts:507-510` throws; `pbxOmbutelRingGroupList.ts` (read) |
| **Queues** | `ombu_queues`, `queues__50-*.conf`, runtime `T{n}_Q…` | **Yes** (`queues.list`) | **Yes** (create/update/delete) | REST | REST `queues.*` | `client.ts:517-530`; `endpointRegistry.ts:79-85` |
| **Voicemail** | `voicemail.conf`, `ombu_*`, spool | **Yes** (records per ext) | **Partial** (delete / mark-listened) | REST | REST `voicemail.delete/markListened` | `client.ts:451-470`; `endpointRegistry.ts:120-121` |
| **Recordings** | CDR-referenced WAV on PBX host | **Yes** (via CDR + media sync) | No (read) | REST/CDR | — | `client.ts:731-746` |
| **MOH (music on hold)** | `ombu_music_groups`, `/var/lib/asterisk/moh/*` | **Yes** → `PbxMohClass` (`MySQL(ro)`) | **Yes** (class assignment via AstDB + file sync via cron) | AstDB + Helper/cron | AMI `DBPut` + `connect-media-sync.sh` | `schema.prisma:3609-3636`; `mohReverseMapPublish.ts`; `docs/pbx/connect-media-sync-install.md` |
| **Time conditions** | `ombu_time_conditions` | Read (route-selections) | **No** (PBX); Connect has own schedule (`IvrScheduleConfig`) | None (REST) | n/a — overlay schedule used | `schema.prisma:3161-3178`; `TENANT_MODEL.md` |
| **Emergency / 911 routes** | trunks + outbound routes + `shared_trunks` setting | No (not modelled) | **No** | **None — do not build yet** | — | `TENANT_MODEL.md:53-57` (`emergency_trunks`→`shared_trunks`) |
| **Caller ID rules** | outbound routes / trunk rules / device | Partial (Connect `OutboundRoute.callerId*`) | **No** to PBX | None (REST) | GUI/Manual | `schema.prisma:2263-2281` |
| **WebRTC / VitXi / mobile** | PJSIP wss transport, device profiles, `ombu_mobile_devices` | **Yes** (WebRTC profile detection, mobile devices) | **Yes** Connect-side (`Tenant.webrtcEnabled`, SIP creds, QR pairing) | REST(read) + Connect DB | — | `pbxExtensionSync.ts:324-354`; `VITALPBX_STRUCTURE.md:156-162` |
| **Permissions / audit** | — | n/a | **Yes** (Connect-owned) | Connect DB | — | `schema.prisma:2248` (`AuditLog`), per-domain publish records |
| **Push-wake (mobile)** | `T25_push_wake_extension` custom context | n/a | **Yes** (`connect/system/wake_*` keys) | AstDB | AMI `DBPut` | `docs/pbx/connect-push-wake-T25.md`; `CONNECT_INTEGRATION_POINTS.md:124-135` |

### How AstDB writes actually happen today (the proven control path)

```
Portal (pbx/ivr-routing, moh-scheduling, did-routing)
  → Connect API (apps/api/src/server.ts: publish endpoints, publishMohToAstDb @ ~21625)
    → snapshot prior keys via POST /telephony/internal/astdb-read-family (AMI DBGet)
    → POST /telephony/internal/ivr-publish  (apps/telephony/src/routes/telephony.ts:589)
      → family-scope guard (connect/t_<slug> | connect/didmap/<e164> | connect/system | connect/pbx_tenant_map/<id>)
      → telephony.ami.sendAction("DBPut", {Family, Key, Val})   (AmiClient.ts:87)
  → record IvrPublishRecord / MohPublishRecord / DidRouteSwitchLog (keysWritten + previousKeys snapshot)
```

This is the single most important existing asset: **a real desired-state → plan →
apply → snapshot → rollback pipeline already runs in production for the overlay
objects.** **[proven — `telephony.ts:589-659`, `AmiClient.ts:87-206`,
`schema.prisma:3200-3217 / 3401-3424 / 3571-3589`]**

---

## 3. Risk Matrix

| Feature | Business value | Technical complexity | Blast radius | Risk level | Recommended phase | Required guardrails |
|---------|----------------|----------------------|--------------|------------|-------------------|---------------------|
| Read-only inventory (all objects) | High (visibility, drift) | Low | None (read) | **Low** | **Phase 0** | Read-only creds; never poll at call rate; cache in Connect DB |
| Drift detection / unknown-object surfacing | High | Low-Med | None (read) | **Low** | **Phase 0** | Snapshot-compare only; alert, never auto-correct |
| IVR routing (overlay) | High | Med (built) | Single tenant call flow | **Low-Med** | **Phase 3** (deepen existing) | Family-scope guard; snapshot+rollback; per-tenant test |
| MOH / hold (overlay) | Med | Med (built) | Single tenant hold audio | **Low** | **Phase 3** (deepen) | Same guard + `moh reload` scoped cron |
| DID → tenant routing (overlay + helper) | High | Med (built) | Inbound delivery for one DID | **Med** | **Phase 2-3** | Snapshot `originalPbx*`; drift guard; one-DID scope |
| Tenant create/enable/disable (REST) | High | Low-Med | Whole tenant | **Med** | **Phase 2** | Dry-run; human approval; `applyChanges` discipline |
| Extension create/disable/credentials | High | High (no REST) | Tenant users' phones | **Med-High** | **Phase 1** (Connect-side) / later (PBX-side) | New snapshotted helper; never auto-delete; credential safety |
| Queue CRUD (REST) | Med | Low-Med | Tenant queue behaviour | **Med** | **Phase 3** | Dry-run + plan; verify after apply |
| Voicemail delete / mark-listened (REST) | Low-Med | Low | One mailbox | **Med** | **Phase 3** | Soft-confirm; never bulk-delete |
| Trunks (create/update/delete) | High | Very High (no REST) | **All tenants on trunk** | **High** | **Phase 4** | Elevated approval; emergency-route check; no auto-apply |
| Outbound routes | High | Very High (no REST) | Carriage / billing / 911 | **High** | **Phase 4** | Elevated approval; STIR/SHAKEN/CNAM review |
| Inbound routes (native rewrite) | Med | High | Inbound delivery | **High** | **Phase 4** | Prefer overlay; helper w/ drift guard only |
| Caller ID / CNAM / STIR/SHAKEN | High (compliance) | High | Carrier-facing identity | **High** | **Phase 4** | Separate compliance review |
| Emergency / 911 routing | Critical | High | **Life-safety** | **Highest** | **Not scheduled** | Dedicated workstream; out of scope until separately approved |
| Self-service tenant changes | High | High | Tenant-controlled | **High** | **Phase 5** | Risk-tiered approval; full audit/rollback |

---

## 4. Recommended Architecture

Adopt the pattern Connect **already partially implements**, and make it uniform
across all object types.

### Core principle

```
Connect = source of DESIRED state.
VitalPBX/Asterisk = the RUNTIME TARGET (actual state).
A Sync Engine diffs desired vs actual, compiles a CHANGE PLAN,
and only an approved plan is APPLIED — then VERIFIED — with full AUDIT + ROLLBACK.
```

This is exactly the shape of `DidRouteMapping` (desired) → `DidRouteSwitchLog`
(plan/snapshot/result) → `originalPbx*` (rollback) that exists today; generalise it.

### Layers

1. **Desired-state store (Connect DB)** — one table family per object type
   (see §7). Tenant-scoped, the only thing humans/UX edit.
2. **PBX Adapter / service layer** — a single typed boundary to the PBX. It must
   route each object to its **only safe mechanism**:
   - `VitalPbxClient` (REST) — tenants, queues, tenant inbound numbers, codes,
     voicemail delete/mark. **[proven `client.ts`]**
   - Telephony AstDB proxy (`/telephony/internal/ivr-publish`, AMI `DBPut`) —
     overlay routing/IVR/MOH/DID/wake. **[proven `telephony.ts:589`]**
   - PBX-host helper (loopback HTTP, narrow MySQL grants, snapshotting) — native
     inbound-route `destination_id` flips, MOH file sync. **[proven
     `docs/pbx/inbound-route-helper.md`]**
   - `MySQL(ro)` reader — discovery only. **[proven `pbxOmbutelInboundDidSync.ts`]**
   - The adapter **must refuse** (`NOT_SUPPORTED`) any write that has no proven
     safe mechanism, exactly as `client.ts` does today.
3. **Sync worker** — runs discovery (read actual), reconciliation (diff), and—
   only when a plan is approved—apply + verify. Model on the existing worker
   cycles (`apps/worker/src/main.ts` `runIvrScheduleCycle`,
   `PBX_TENANT_SYNC_INTERVAL_MS`). **[proven — `docs/ai-context/TELEPHONY.md`]**
4. **Modes** (must be first-class flags on every operation):
   - **Discovery (read-only)** — populate actual-state cache. Always safe.
   - **Dry-run** — compile a plan and diff; write nothing. (Mirrors AGENTS.md
     deploy `dryRun`.)
   - **Apply** — execute an approved plan through the adapter.
   - **Verify** — re-read actual state and assert it matches desired.
5. **Drift detection** — compare last-applied snapshot vs current actual. On
   drift: **alert + mark, never silently overwrite** (a manual PBX change is a
   signal, not garbage). The DID helper already implements a drift guard
   (refuses restore if `destination_id` changed). **[proven —
   `docs/pbx/inbound-route-helper.md`, `did-takeover.md`]**
6. **Reconciliation** — convert (desired − actual) into ordered
   `PbxChangeOperation`s; never apply out of dependency order (tenant → extension
   → routing).
7. **Rollback** — every apply stores a pre-image snapshot (proven pattern:
   `IvrPublishRecord.previousKeys`, `MohPublishRecord.previousKeysSnapshot`,
   `DidRouteMapping.originalPbx*`). Rollback replays the pre-image. Records with
   no snapshot must **refuse** rollback (`409 no_snapshot_available`), as the IVR
   path already does. **[proven — `docs/pbx/option-a-runtime-keys.md`]**
8. **Tenant isolation** — keep the four-layer model already in place: API access
   check → DB profile-tenant validation → API→telephony `family_scope_mismatch`
   guard → AstDB per-tenant families. No cross-tenant references allowed in
   desired state. **[proven — `telephony.ts:647-654`, `ASTDB_KEYS.md`]**
9. **Permission model** — reuse Connect roles + per-capability flags
   (`can_publish_did_routing` exists). Add capabilities per object type and an
   **elevated** tier for trunk/route/emergency. **[proven pattern —
   `docs/pbx/did-takeover.md`]**

---

## 5. Minimal-Risk Phase Plan

### Phase 0 — Read-only inventory (DO THIS FIRST)
- Build/extend PBX **inventory readers only**. Much already exists: tenants
  (`pbxTenantDirectorySync.ts`), extensions (`pbxExtensionSync.ts`), inbound DIDs
  (`pbxOmbutelInboundDidSync.ts`), MOH classes (`PbxMohClass`), live channels
  (ARI helpers in `client.ts:922-1016`).
- **Add** read-only inventory for trunks, outbound routes, queues, and a
  best-effort native-IVR/ring-group/time-condition read (REST list where it
  exists; `MySQL(ro)` where it does not).
- Surface everything in a single **PBX Inventory** screen and a
  **Drift / Unknown-objects** view (objects on the PBX that Connect did not
  create).
- **No writes. No AstDB. No `applyChanges`.**
- Exit criteria: Connect can render full per-tenant inventory and flag drift /
  unmanaged objects.

### Phase 1 — Extension lifecycle (Connect-side first)
- Create/update/disable extensions **as desired state in Connect**, with
  dry-run and verify against the read sync.
- **PBX-side write is gated**: since there is **no REST write** for extensions
  (`client.ts:471-485`), the actual PBX mutation stays **manual / GUI** OR a new,
  separately-reviewed snapshotted PBX-host helper (mirroring the inbound-route
  helper's narrow-grant + snapshot design). Do **not** write `ombutel` ad hoc.
- No trunk/routing changes. Include rollback and credential safety (SIP passwords
  already encrypted: `PbxExtensionLink.sipPasswordEncrypted`). Never auto-delete —
  disable/archive only.

### Phase 2 — Tenant onboarding workspace
- Signup/onboarding flow creates the **Connect tenant record + provisioning
  checklist** (the onboarding wizard + VitalPBX CSV already exist:
  `apps/portal/app/onboarding/[token]`, `admin/onboarding/[id]/vitalpbx.csv`).
- Optionally prepare VitalPBX import files / REST `tenants.create` **as a dry-run
  plan**. Human approval before any PBX write.
- Tenant enable/disable/apply via REST `tenants.*` once approved. **[proven REST
  path — `client.ts:410-430`]**

### Phase 3 — Call-flow builder (read/write limited, overlay only)
- Manage **IVRs, ring groups (as overlay option-routes), queues, time
  conditions** through the **Connect overlay** — not native VitalPBX objects.
- IVR/MOH/DID already do this; extend coverage and uniformity. Queues may use
  REST CRUD (`queues.*`) behind a plan.
- Every change compiles into a `PbxChangePlan`; **no ad-hoc writes from the UI**
  (UI edits desired state; a publish action compiles + applies).

### Phase 4 — Trunks and inbound/outbound routes (high risk)
- Only after the adapter + plan engine are proven on Phases 0-3.
- **Stricter, elevated approval.** Include explicit emergency-route checks and
  caller-ID / STIR/SHAKEN / CNAM awareness review.
- Native objects have no REST write path → either snapshotted helper or remain
  manual with Connect tracking desired state + drift only. Prefer **tracking +
  guided manual** over automated writes here until proven.

### Phase 5 — Full self-service provisioning
- Tenants request changes; approval is **risk-tiered** (low-risk auto, high-risk
  admin-gated). Full audit/history/rollback for every change.

---

## 6. Safety Rules (hard rules)

These extend the existing, proven rules in `docs/ai-context/ASTDB_KEYS.md`,
`docs/ai-context/TELEPHONY.md`, and `AGENTS.md`:

1. **Never write to the PBX directly from the frontend.** UI edits desired state;
   a server-side publish compiles and applies. (Today the portal calls Connect
   API, which calls the telephony service — never AMI directly.)
2. **Never modify the PBX without a dry-run plan** first.
3. **Never allow cross-tenant references** in desired state; enforce the
   `family_scope_mismatch` guard for every AstDB write. **[proven `telephony.ts:651`]**
4. **Never delete PBX objects immediately** — disable/archive first; deletion is a
   separate, later, explicitly-approved action.
5. **Every PBX write must be idempotent** (re-applying the same desired state is a
   no-op). The overlay's fixed-size key set already guarantees this. **[proven
   `option-a-runtime-keys.md`]**
6. **Every write must verify actual PBX state after apply** (read-back).
7. **Every generated config / key set must be diffed against a pre-image
   snapshot before reload.**
8. **Every reload must be scoped and safe** (`moh reload`, scoped `dialplan
   reload`; never blanket `core reload`). Never restart unrelated services.
9. **Emergency / 911 routes are protected** — out of scope; no automated path may
   touch trunk/route objects that carry emergency traffic until a dedicated
   reviewed workstream exists.
10. **Trunk changes require elevated approval** and an emergency-route impact check.
11. **Manual PBX changes are detected as drift, not overwritten blindly.** The
    helper already refuses to restore a drifted route unless `force=true`. **[proven]**
12. **Never write `ombutel` MariaDB ad hoc**, never bypass the telephony service
    to call AMI, never invent VitalPBX REST endpoints (`NOT_SUPPORTED` is correct
    behaviour). **[proven — `vitalpbx-implementation-matrix.md`, `AGENTS.md`]**

---

## 7. Data Model Proposal (NOT implemented — proposal only)

Connect already has most of the "actual-state" + "audit" side. The proposal is to
add a **uniform desired-state + plan layer** that generalises the existing
IVR/MOH/DID pattern. **Nothing below is to be migrated by this document.**

Existing models to build on (do not duplicate): `PbxInstance`,
`PbxTenantDirectory`, `TenantPbxLink`, `Extension`/`PbxExtensionLink`,
`PbxTenantInboundDid`, `DidRouteMapping`/`DidRouteSwitchLog`, `IvrRouteProfile`/
`IvrOptionRoute`/`IvrPublishRecord`, `MohProfile`/`MohPublishRecord`/`PbxMohClass`,
`AuditLog`.

Proposed new (or generalised) entities:

| Entity | Purpose | Models existing pattern it copies |
|--------|---------|-----------------------------------|
| `PbxTenantDesiredState` | Desired tenant config (name, enabled, prefix, DID set) | `PbxTenantDirectory` (actual) |
| `PbxExtensionDesiredState` | Desired extension (number, display, device type, webrtc, status) | `Extension`/`PbxExtensionLink` (actual) |
| `PbxTrunkDesiredState` | Desired trunk config (read-only/tracked first) | `trunks.list` (actual) |
| `PbxInboundRouteDesiredState` | Desired DID → destination (extends `DidRouteMapping`) | `DidRouteMapping` |
| `PbxOutboundRouteDesiredState` | Desired outbound route + caller-ID (tracked first) | `OutboundRoute` |
| `PbxIvrDesiredState` | Desired IVR menu (already = `IvrRouteProfile` + `IvrOptionRoute`) | reuse existing |
| `PbxRingGroupDesiredState` | Desired ring group (as overlay option-routes) | `IvrOptionRoute` |
| `PbxQueueDesiredState` | Desired queue config | `queues.*` REST (actual) |
| `PbxChangePlan` | A compiled, approvable set of operations (status: draft/dry-run/approved/applied/failed/rolled-back) | `MohAssignmentJob`, `PbxJob` |
| `PbxChangeOperation` | One ordered op in a plan (object, verb, before/after, mechanism) | `keysWritten`/`previousKeys` JSON |
| `PbxDriftSnapshot` | Point-in-time actual-state capture for diff/drift | `originalPbx*`, helper `snapshots.sqlite3` |
| `PbxAuditLog` | Per-PBX-write audit (who/what/before/after/result) | `AuditLog`, `DidRouteSwitchLog`, `*PublishRecord` |

Common fields every desired-state table should carry: `tenantId`,
`pbxInstanceId`, `revision`, `desiredHash`, `lastAppliedHash`, `lastAppliedAt`,
`driftDetected`, `managedByConnect` (so unmanaged PBX objects are never clobbered).

---

## 8. API Design Proposal (endpoints only — no implementation)

Generalise the existing `/voice/ivr/*`, `/voice/moh/*`, `/voice/did/*` shape into
an object-typed control API:

```
GET  /pbx/inventory?tenantId=&type=          # actual-state inventory (read-only)
GET  /pbx/{type}/desired?tenantId=           # desired state for an object type
PUT  /pbx/{type}/desired/:id                 # edit desired state (no PBX write)
POST /pbx/plan                               # compile desired vs actual → PbxChangePlan (dry-run)
GET  /pbx/plan/:id                           # inspect compiled plan + diff
POST /pbx/plan/:id/approve                   # approval gate (role/elevated)
POST /pbx/plan/:id/apply                     # execute approved plan via adapter
POST /pbx/plan/:id/verify                    # read-back actual, assert == desired
POST /pbx/plan/:id/rollback                  # replay pre-image snapshot
GET  /pbx/drift?tenantId=                    # drift + unmanaged-object report
GET  /pbx/audit?tenantId=&type=              # PBX write audit trail
```

Reuse existing internal boundaries unchanged: `/telephony/internal/ivr-publish`
(AMI `DBPut`) and `/telephony/internal/astdb-read-family` (AMI `DBGet`) remain the
**only** AstDB write/read path. **[proven `telephony.ts:589,672`]**

---

## 9. UI Proposal (portal screens)

Several already exist (listed with their current files); the rest are new:

| Screen | Status | File / note |
|--------|--------|-------------|
| **PBX Inventory** | New (Phase 0) | aggregate of existing read syncs |
| **Tenant Provisioning** | Partial | `app/onboarding/[token]`, `admin/onboarding/[id]` (CSV today) |
| **Extensions** | Exists | `app/(platform)/pbx/extensions/page.tsx` |
| **Call Flow Builder** | Exists (IVR) | `app/(platform)/pbx/ivr-routing/page.tsx` |
| **IVR Builder** | Exists | `pbx/ivr-routing`, `pbx/ivr` |
| **Ring Groups** | Stub→overlay | `pbx/ring-groups/page.tsx` (generic CRUD wrapper) |
| **Queues** | Exists | `pbx/queues/page.tsx` |
| **Routes (in/out)** | Stub | `pbx/inbound-routes`, `pbx/outbound-routes` (read first) |
| **Trunks** | Stub | `pbx/trunks/page.tsx` (read first) |
| **Change Plans** | New | plan compile/approve/apply/rollback UI |
| **Drift / Health** | New (Phase 0) | drift + unmanaged-object report |
| **Audit Logs** | Partial | per-domain publish history exists; unify |

---

## 10. Open Questions / Unknowns

| Question | Status | Basis |
|----------|--------|-------|
| Does the documented VitalPBX v4 REST API expose extension/trunk/route/ring-group/IVR **writes**? | **proven: NO** | `client.ts:471-514`, `vitalpbx-implementation-matrix.md` |
| Can Connect write AstDB safely, tenant-scoped, with rollback? | **proven: YES** | `telephony.ts:589-659`, `IvrPublishRecord` |
| Can Connect create/enable/disable tenants and CRUD queues via REST? | **proven: YES** | `client.ts:410-530`, `endpointRegistry.ts` |
| Can the inbound-route helper flip a single DID destination with snapshot+drift guard? | **proven: YES** | `docs/pbx/inbound-route-helper.md`, `did-takeover.md` |
| Live production `ombutel` row data (real tenants/trunks/IVR/queue values) | **unknown** | `pbx-brain` has DDL + diagnostics only, no MariaDB dump (`RISKS_AND_LIMITATIONS.md:7-25`) |
| VitalPBX REST auth rules / exact write payload schemas (ionCube `routes.php`) | **unknown** | `RISKS_AND_LIMITATIONS.md:29-45` |
| Whether a PBX-host helper can safely write extensions (`ombu_pjsip_devices` + config regen) | **unsafe-until-tested** | no helper exists; native config regen unproven |
| Native trunk/outbound-route write path | **unsafe-until-tested** | no REST, carriage/billing impact |
| Caller-ID / STIR/SHAKEN / CNAM enforcement point | **unknown** | not modelled in Connect; carrier-side |
| Emergency / 911 routing data + reload safety | **unsafe-until-tested** | `shared_trunks` setting only; life-safety |
| Does `tenants.applyChanges` reload safely without affecting other tenants? | **likely** (documented per-tenant) but **untested at scale** | `endpointRegistry.ts:104` |

---

## 11. Final Recommendation

**Should we do this?** Yes — but scoped honestly. Connect should be the **control
plane for the objects it can safely own via overlay + documented REST**, and the
**system of record + drift detector** for everything else. "Connect controls the
full native PBX lifecycle by mutating VitalPBX objects" is **not** achievable with
the documented API and should not be the goal; the overlay model is the
professional, sustainable architecture and it already works.

**Where should we start?** **Phase 0 — read-only inventory + drift detection.**
It is pure upside: zero blast radius, immediately useful, and it builds the
actual-state foundation every later phase diffs against. Most of the readers
already exist; the work is unifying them and adding trunk/route/queue reads + a
drift view.

**What is the lowest-risk first deploy?** A **read-only PBX Inventory + Drift
screen** backed by existing sync services and new read-only trunk/route/queue
inventory. No writes, no AstDB, no `applyChanges`, no schema migration required to
prove value (a thin desired-vs-actual diff can be computed in-memory first).

**What is the long-term professional architecture?**
Desired-state in Connect → Sync Engine diff → compiled, approved `PbxChangePlan`
→ adapter that routes each object to its *only* safe mechanism (REST / AstDB
proxy / snapshotted helper) → verify read-back → audit + rollback. Generalise the
already-proven IVR/MOH/DID pipeline so every object type flows through one plan/
apply/verify/rollback path, with elevated approval and emergency-route protection
guarding the high-blast-radius objects (trunks, routes, caller-ID, 911).

---

## Proposed next Cursor prompt — Phase 0 (read-only inventory)

> **Goal:** Implement Phase 0 of the Connect→VitalPBX control plane: a
> **read-only** PBX inventory + drift detection surface. No writes, no AstDB, no
> `applyChanges`, no schema-destructive changes.
>
> **Scope (read-only):**
> 1. Add read-only inventory readers for objects Connect does not yet cache:
>    **trunks** (`VitalPbxClient.listTrunks`), **outbound routes**
>    (`listRoutes`), **queues** (`listQueues`), and a best-effort
>    **ring-group / time-condition** read (REST where present, else
>    `MySQL(ro)` like `pbxOmbutelInboundDidSync.ts`). Reuse the existing
>    `VitalPbxClient` and `ombuMysqlUrlEncrypted` patterns.
> 2. Add a unified `GET /pbx/inventory?tenantId=&type=` API that returns
>    actual-state for tenants, extensions, inbound DIDs, MOH classes, trunks,
>    routes, queues — composed from existing sync tables
>    (`PbxTenantDirectory`, `Extension`/`PbxExtensionLink`,
>    `PbxTenantInboundDid`, `PbxMohClass`) plus the new read-only readers.
> 3. Add a `GET /pbx/drift?tenantId=` endpoint that compares last-synced actual
>    state against Connect-managed desired state (IVR/MOH/DID overlays) and
>    flags: (a) drift on managed objects, (b) **unmanaged** PBX objects Connect
>    did not create. Alert/mark only — never auto-correct.
> 4. Add portal screens **PBX Inventory** and **Drift / Health** under
>    `apps/portal/app/(platform)/pbx/` that render the above. Read-only UI.
>
> **Hard constraints:**
> - No `DBPut`, no `tenants.create/update/delete/applyChanges`, no queue/voicemail
>   writes, no helper writes, no `ombutel` writes. Reads only.
> - The PBX adapter must continue to throw `NOT_SUPPORTED` for any unsupported
>   write (do not add write endpoints).
> - Respect tenant isolation; never return cross-tenant rows.
> - Add tests for the new readers/diff using the existing test style
>   (`pbxTenantDirectorySync.test.ts`).
>
> **Deliverable:** read-only inventory + drift API and two portal screens, plus a
> short `docs/pbx/phase-0-inventory.md` describing what is read, from where, and
> the known gaps (live `ombutel` values, ionCube REST schemas) carried over from
> `connect-pbx-control-plane-plan.md`.
```
