# M3 — Inbound Route Destination Change — SPEC v1 for Izzy sign-off

_2026-07-23 · Roadmap: `../ACTIONS_V2_ROADMAP.md` · Prereqs: X1 ✅ X2 ✅ · Needs: **H2 helper enhancement** · Status: **AWAITING SIGN-OFF**_

_Repo: https://github.com/izzwgg-arch/connect-platform_

## 0a. ARCHITECTURE CORRECTION (Izzy, 2026-07-23) — reshapes M3

Izzy: "All phone numbers and trunks live in the MAIN tenant. Calls come into
Connect; from Connect they are assigned to the tenant they belong to."

Confirmed in code (`server.ts` §DID-level routing): **Connect owns every inbound
DID.** `DidRouteMapping` pins each number to a tenant + an `IvrRouteProfile` +
MOH profile, published as AstDB `connect/didmap/<e164>/*` keys consumed by the
shared `[connect-tenant-ivr]` dialplan. The helper's "connect mode" is not a
corruption risk — it IS the production dispatch mechanism.

## 0a-bis. FURTHER CORRECTION (Izzy, 2026-07-23) — the LIVE layer is native VitalPBX, and the agent is the ONLY change surface

Izzy: "Today I do it manually on VitalPBX — Connect's routing isn't working
properly right now. I don't want to change it from app UI pages. I want the
CUSTOMER to change it through the agent. If I need to change something, I go into
VitalPBX directly. So we do NOT need an app-UI path — only the agent path."

Decisions locked:
1. **Live routing = native VitalPBX `ombu_inbound_routes`** (what Izzy edits by
   hand). Connect's `DidRouteMapping`/didmap layer is NOT the operational
   dispatcher today ⇒ **M3a (Connect-layer change) is DROPPED** — building it
   would change a layer that doesn't govern live calls ("agent says done, calls
   don't change" trap).
2. **No app-UI work.** The agent is the sole Connect-side change surface for
   customers. Izzy retains direct VitalPBX for his own changes.
3. **M3 = the native-route retarget** (formerly "M3b"): change
   `ombu_inbound_routes.destination_id` for a tenant's DID, among the tenant's
   PROVEN in-use destinations (Option A), via a small DEDICATED helper endpoint
   that does NOT touch `current_connect_destination_id` (Izzy installs).
4. **Correctness guard for build:** before live-cert, confirm read-only that the
   target DID's routing is native (`mode: "pbx"`), i.e. actually governed by the
   route the agent edits — the op's connect-mode fence already enforces this.

**EVIDENCE (read-only, 2026-07-23) — settles the layer question:** T21's real
customer DIDs route DIRECTLY to native destinations — DID 8455577768 → dest 456
→ extension 101; DID 8452510249 → dest 642 → extension 101. Across all tenants,
inbound-route targets are native objects (ivr ×14, ring_group ×11,
time_conditions ×10, extensions ×8, queues ×1, …). So the LIVE routing layer is
native `ombu_inbound_routes` — confirming Izzy's "I do it manually on VitalPBX."
**M3 targets the native layer; the Connect `DidRouteMapping` path is confirmed
NOT live for these numbers and stays dropped.** "m3a go" (2026-07-23) is
therefore built as the native-route change (below), not a Connect-layer change.

Honest limitation of Option A (unchanged): the agent can route a number to a
destination ALREADY used by one of the tenant's numbers. Routing to a
destination NO number currently uses ("route to anything he set up") stays
deferred until a vendor-safe destination-resolver exists — never guessed.

## 0. DECISION (Izzy, 2026-07-23): OPTION A — route among the tenant's PROVEN destinations (applies to M3b)

The DB destination model is genuinely ambiguous (multiple/duplicate
`ombu_destinations` rows per target; the vendor API cannot WRITE inbound routes),
so computing a destination value for a brand-new target cannot be done without
guessing. **Rejected.** Instead, M3 ships the rock-solid subset:

**M3 retargets a DID only to a destination VALUE the tenant is already using**
— i.e. one of the `destination_id`s currently bound to that tenant's own inbound
routes. "Point this number where another of your numbers already goes." Every
target is a real, proven, tenant-owned route value (tenant scoping is authoritative
via `ombu_inbound_routes.tenant_id`). No ambiguous resolution, no destination
creation, no guessing.

**H2 (Option A) — the READ path is install-free; the WRITE path needs a small
dedicated helper endpoint (CORRECTION 2026-07-23):**
- **Target menu (install-free):** built by inspecting the tenant's own DIDs via
  the EXISTING read-only helper `/inspect` (Connect already knows the DIDs via
  `PbxTenantInboundDid`). Each returns `{did, description, destination_id, mode}`.
  Menu = the distinct `destination_id`s in use (pbx-mode only), labeled by the
  DID(s) that use them. Pure fold + fence unit-tested (`agentRouteAction.ts`).
- **Retarget fence:** a chosen `destination_id` is accepted ONLY if it is in that
  tenant's in-use set (proven-owned). Anything else ⇒ REFUSE.
- **WRITE needs a NEW dedicated helper endpoint (verified 2026-07-23):** the
  EXISTING `/retarget` CANNOT be reused — it sets `current_connect_destination_id
  = target`, and `/inspect` computes `mode = "connect" if destination_id ==
  current_connect_destination_id`. So reusing it would FALSELY mark an M3-changed
  DID as Connect-managed, corrupting the connect/pbx signal Connect relies on and
  tripping M3's own connect-mode fence. Rock-solid fix: a small, ISOLATED helper
  endpoint (`/route-set-destination` + `/route-restore-destination`) with its OWN
  snapshot table, NOT touching `current_connect_destination_id`. This is a small
  helper install — prepared in the repo installer, **installed by Izzy**. My
  earlier "no install" statement was wrong; corrected here.
- Connect-mode DIDs hard-refused throughout.

Deferred (Option B, brand-new targets) until a vendor-supported inbound-route
write / destination-resolve path exists — never guessed.

## 0c. INSTALL PERMISSION (Izzy, 2026-07-23)

Izzy granted a one-time explicit permission for the agent to install the M3
helper endpoint directly on the PBX (as with X4). Discipline: apply M3 changes
to the CURRENTLY-INSTALLED helper only (NOT the repo's full copy, which also
carries a never-deployed transport-wss cert-fix — must NOT be installed as a
side effect); timestamped backup; checksum + venv syntax check; diff must show
ONLY the M3 additions; service health-check + new-endpoint probe after restart.

## 1. What M3 does

Point an existing phone number (DID) at a **different destination** — e.g. change
"+1 845-555-7768" from ringing the Main IVR to ringing the Sales Queue — and
change it back. The permanent sibling of the temporary A3 IVR-switch.

**NOT in M3:** creating DIDs/routes (that's E2/E3), deleting routes, changing
anything other than one existing route's destination.

## 2. Why M3 is a real step up (read-only PBX findings, 2026-07-23)

Confirmed on the live box (vmi2718844):
- A DID's destination is `ombu_inbound_routes.destination_id` → a row in
  `ombu_destinations`. Example T21: DID 8455577768 → destination 456.
- **`ombu_destinations` has NO tenant column.** It's `(id, category_id,
  module_id, index)`. A destination's OWNER is only knowable by following
  module_id → the object table (e.g. module 29 = extensions) and looking up
  `index` there (dest 456 → extension_id 107 → tenant 21). Different
  destination types (IVR, queue, ring group, extension, time condition) live in
  different tables.
- **The existing route helper already retargets + snapshots + restores** — its
  `/retarget` writes `destination_id`, snapshots `original_destination_id` (and
  the full original row), and `/restore` puts it back. `/inspect` reads current
  state. It even accepts an arbitrary `connectDestinationId` in the body.
- **But its validation only checks the destination EXISTS globally
  (`destination_exists`), NOT that it belongs to the same tenant.** Pointing
  T21's DID at T8's destination would currently be accepted. That cross-tenant
  gap is the single most important thing M3 must close.

## 3b. H2 DESIGN PIVOT (2026-07-23) — use VitalPBX's own authoritative API, NOT hand-rolled joins

**Read-only investigation finding:** VitalPBX's destination resolver + API
routing (`www/api_v2/destinations/read.php`, `routes.php`) are **ionCube-
encrypted** — the exact resolution logic cannot be read. The DB schema is also
genuinely ambiguous: a destination row carries BOTH `category_id` (→ a module,
e.g. "extensions") AND its own `module_id` (e.g. 29 "inbound_route"), and which
one drives the target object is not self-evident. Reverse-engineering the
module→object→tenant joins by hand would be fragile and could silently drift on
a VitalPBX upgrade — unacceptable for a rock-solid, long-term capability.

**Authoritative alternative (RECOMMENDED):** VitalPBX exposes a **read-only
`destinations` API** (confirmed in `PBX_AUDIT.md`: destinations = list/get) —
the SAME tenant-aware resolver its own GUI uses, maintained by the vendor across
versions. Connect already has an authenticated `VitalPbxClient`. So H2 becomes:

1. **List/validate via the vendor API (Connect-side, read-only):** `GET
   /api/v2/destinations` scoped to the tenant returns that tenant's valid
   destinations with labels + types. Tenant-ownership is proven by the vendor's
   own tenant scoping — NOT by our guessed joins.
2. **Retarget target validation:** M3 accepts a `destinationId` ONLY if it
   appears in that tenant's authoritative destination list; otherwise REFUSE.
3. **The write stays the existing helper `/retarget` + `/restore` + snapshot**
   (already built, already installed).

**Consequences (all safety wins):**
- H2 needs **NO new PBX-host helper install** — the resolver is a read-only
  vendor-API call from Connect. Removes an entire risk + install category.
- Rock-solid + upgrade-safe: we defer to VitalPBX's own authoritative,
  tenant-scoped resolver instead of a hand-maintained join map.
- Fail-closed completeness is automatic: if the vendor API doesn't list a
  destination for the tenant, it's unroutable-by-agent, full stop.

**First build step (needs a read-only confirmation):** verify the
`/api/v2/destinations` response shape + tenant scoping against T21 on the live
box (read-only), then build the Connect-side list/validate around it.

**DECISION FOR IZZY:** adopt this vendor-API design for H2 (recommended) instead
of the hand-rolled helper joins described in §3 below? The §3 approach is kept
for the record but is NOT recommended given the encryption + drift risk.

## 3. (SUPERSEDED by §3b) Original hand-rolled-join approach — kept for the record

The Connect/Postgres side does not mirror `ombu_destinations`, so the
tenant-ownership join must happen where ombutel lives — in the helper. **H2**
adds two capabilities to the existing helper (same regen-free, snapshot,
tenant-scoped discipline as X4):

1. **`/list-destinations` (read):** given a tenant, return its valid inbound-
   route destinations as `{ destinationId, type, label, tenantVerified:true }`,
   resolved by the module→object→tenant join. Powers (a) the agent choosing a
   target, (b) the approval email showing "from 'Main IVR' → to 'Sales Queue'".
2. **`/retarget` tenant fence:** before switching, resolve the TARGET
   destination's owner via the same join and **refuse if it is not the DID's
   tenant.** Belt-and-suspenders with a Connect-side check where possible.

Delivery discipline: H2 ships as an update to
`scripts/pbx/install-vitalpbx-inbound-route-helper.sh`, reviewed by Izzy, and
**installed by Izzy** (the X4 direct-install permission was one-time for X4
only; M3/H2 returns to the standard "Izzy installs" rule unless Izzy grants a
fresh explicit permission). Repo-side unit tests cover the join + fence on
fixture data before any install.

## 4. Execution path

`apps/api` gains an internal action (extending the agent door or a sibling
internal route): `route_inspect` / `route_list_destinations` / `route_retarget`
/ `route_restore`, each calling the existing helper client
(`inspectPbxInboundRoute`, new `listPbxRouteDestinations`, `retargetPbxInboundRoute`
with an explicit `destinationId`, `restorePbxInboundRoute`), attributed
`agent:<actionId>`.

`apps/agent` adds `pbx.M3` (kind `inbound_route`, feasibility `helper`):
- **snapshot:** `/inspect` the DID → capture current `destination_id` + full
  original row (the helper already persists a durable snapshot too).
- **dispatch:** `/retarget` to the chosen tenant-verified `destinationId`.
- **verify:** re-`/inspect`; the route's `destination_id` must equal the target,
  AND the target must have been tenant-verified. Mismatch ⇒ auto-revert.
- **revert:** `/restore` (helper restores `original_destination_id`).

Scope fence (`inbound_route` mapping in scopeCheck): the DID must belong to the
requester's tenant (via `PbxTenantInboundDid`/`PhoneNumber`, already mapped as
`inbound_did` in X2) AND the chosen destination must be tenant-verified (H2).

## 5. SEBA — Side-Effect & Blast-Radius Analysis

**(a) Touched on execute:** one row of `ombu_inbound_routes` (this DID,
`destination_id` only), the helper's durable snapshot store, one scoped apply
(`dialplan reload` — NOT a full regen). No other route, no other tenant.
**(b) Other readers — the Connect-routing interaction (IMPORTANT):** Connect's
MOH-enforcement + tenant-routing relies on DIDs that are pointed at the Connect
router destination. M3 must therefore:
  - refuse to retarget a DID that is currently in "connect" mode (would break
    Connect routing/MOH for that number) unless Izzy explicitly overrides;
  - `/inspect` already reports `mode: "connect"|"pbx"` — M3 reads it and blocks
    the connect-mode case by default. (Documented decision below.)
**(c) Calls in flight:** a call already routed is unaffected; the next inbound
call to that DID follows the new destination (per-call evaluation).
**(d) Dies halfway:** DB switched, apply failed ⇒ helper reports nonzero exit ⇒
verify fails ⇒ auto-revert (`/restore`) + owner alert; helper timeout ⇒ outcome
UNKNOWN, no blind retry.
**(e) Fan-out proof:** one DID (tenant-owned), one destination (tenant-verified
by H2), one route row updated `WHERE inbound_route_id=? AND tenant_id=?`. No bulk
shape. **Worst case ceiling:** one number rings the wrong (but same-tenant)
destination until one-click revert — seconds to minutes.

## 6. Test plan

- **UNIT (helper, repo-side):** destination→tenant join across each module type
  (extension/IVR/queue/ring group/time condition) on fixture rows; cross-tenant
  target refused; list-destinations labels + tenantVerified.
- **UNIT (agent op):** schema; snapshot/dispatch/verify/revert vs a fake helper;
  connect-mode DID refused; foreign-tenant DID (G3) and foreign destination refused.
- **SIM-CERT:** full G0–G11 + revert for pbx.M3; zero-helper-contact tripwire in
  simulate; catalog now M1+M2+M3, contract holds.
- **RED-TEAM:** approve-then-mutate destinationId (G8); cross-tenant destination;
  connect-mode bypass attempt; replayed approval.
- **STRESS:** rapid A→B→A retargets (sim); helper apply-fail ⇒ auto-revert;
  timeout ⇒ zero retries; live budget cap holds under concurrency (already fixed).
- **LIVE-CERT (T21 ONLY, Izzy approving each step):** list T21 destinations →
  retarget a throwaway DID from one dest to another → **call the DID, hear/reach
  the new destination** → one-click revert → hearing check → attempt a
  connect-mode DID (must refuse) → attempt a cross-tenant destination (must refuse).
- **REVERT-DRILL:** the restore step, executed live.

## 7. Decisions — ANSWERED (Izzy, 2026-07-23) → SPEC SIGNED OFF

1. **H2 install:** standard rule — H2 prepared + unit-tested in the repo,
   **installed by Izzy**. ✅
2. **Connect-mode DIDs:** **hard-refuse** retargeting any DID currently in
   Connect-routing mode. ✅
3. **Requesters:** tenant owner (TENANT_ADMIN) + Izzy only. ✅
4. **Build-now scope:** build + certify the Connect-side M3 in **simulate only**
   now; live path structurally fenced until H2 is installed and verified. ✅

## 8. SCOPE EXPANSION (Izzy, 2026-07-23): route to ANYTHING the tenant has

"The tenant should be able to route to anything he has set up in his system —
if he has an IVR he can route there. Technically the agent has to be able to
route to anything the PBX lists as a suitable inbound routing destination."

Design consequences (rock-solid, long-term, triple-checked mandate):
- **H2's destination resolver must cover EVERY destination module type** the
  PBX supports as an inbound-route target (extensions, IVRs, queues, ring
  groups, time conditions, voicemails, conferences, custom destinations, …),
  each resolved to its owning tenant via that module's own table.
- **Fail-closed completeness rule:** any destination whose module type the
  resolver does not have a PROVEN tenant-join for is (a) never offered in
  `/list-destinations`, and (b) REFUSED as a retarget target — even if it
  exists. Unknown ⇒ unroutable-by-agent. New module types are added one at a
  time with their own join + tests, never guessed.
- The full module→table map is documented from the live PBX source (read-only
  audit) and pinned in this spec's companion H2 section, with a fixture-based
  unit test per module type.
- **Super-duper stress mandate:** M3+H2 get the same super-stress treatment as
  M1/M2 (volume, true concurrency, cross-tenant isolation, adversarial fuzz)
  PLUS destination-type coverage fuzzing (every module type × wrong-tenant ×
  malformed index) before live-cert.
