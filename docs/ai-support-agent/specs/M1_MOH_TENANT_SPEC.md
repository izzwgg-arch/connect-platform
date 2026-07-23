# M1 — Music-on-Hold Selection (Tenant) — SPEC v1 for Izzy sign-off

_2026-07-23 · Roadmap: `../ACTIONS_V2_ROADMAP.md` · Prereqs: X1 ✅ X2 ✅ · Status: **AWAITING SIGN-OFF — no code until approved**_

_Repo: https://github.com/izzwgg-arch/connect-platform_

## 1. What M1 does (and only this)

Switch which hold-music **profile** a tenant is currently playing, among that
tenant's OWN existing profiles (`MohProfile` rows — e.g. "Default", "Holiday
Jazz"), optionally with an expiry ("until tomorrow 9am"), and switch back
(deactivate → the tenant's normal schedule resumes).

**"All hold music" means ALL of it (Izzy, 2026-07-23): inbound, outbound, AND
every queue of the tenant change together in the same publish.** No separate
manual queue step, ever. This requires roadmap item **X4** (queue coverage for
Connect-uploaded classes in the publish path — today an explicit no-op) to be
DONE first; **M1 is blocked on X4**, and M1's verify step and live-cert must
include per-queue evidence that the queues now carry the new class.

**Explicitly NOT in M1:** creating/deleting/renaming profiles, uploading audio,
extension-level MOH (that's M2), flipping a tenant between Connect-managed and
native-PBX MOH control, touching schedules or schedule rules.

## 2. Execution path — the portal's own daily code path, unchanged

The Connect portal already does this every day:
`MohOverrideState` upsert → `doMohPublish` → `publishMohToAstDb` → telephony
service internal endpoint → AstDB keys for that one tenant (plus, for native
classes, the existing route-helper `music_group_id` write — same as every
portal click). Publish history (`MohPublishRecord`) already snapshots the
previous AstDB state, and `/voice/moh/rollback/:publishId` already exists.
A 1-minute reconcile worker already self-heals a failed publish.

**M1 adds NO new PBX-touching code.** It adds:

1. **`apps/api`: one narrow internal endpoint** `POST /internal/agent/moh/override`
   (shared-secret header, same pattern as the existing `x-cdr-secret` internal
   endpoints), accepting `{ tenantId, action: "activate"|"deactivate",
   profileId?, reason, expiresAt?, agentActionId }` and calling the SAME
   functions the portal routes call (`mohOverrideState` upsert + `doMohPublish`).
   `activatedBy` records `agent:<actionId>` — every change is attributable.
   No synthetic user JWTs; this endpoint can do MOH override and nothing else.
2. **`apps/agent`: the first `MODIFY_CATALOG` entry** (`pbx.M1`, kind
   `moh_tenant`, feasibility `astdb`) whose four op functions are:
   - `snapshot`: read current `MohOverrideState` + active profile + latest
     `MohPublishRecord` id for the tenant (via the internal endpoint, read mode).
   - `dispatch`: call the internal endpoint (activate/deactivate).
   - `verify`: re-read override state + confirm the publish result reports the
     expected VitalPBX class; mismatch ⇒ X1 auto-revert.
   - `revert`: restore the snapshot (re-activate the previous profile, or
     deactivate if none was active). The existing AstDB-level rollback endpoint
     remains a second, manual safety net.
3. **`scopeCheck`: the `moh_tenant` mapping** — objectId must equal the (already
   verified) vital tenant AND the requested `profileId` must belong to that
   tenant's Connect mirror (`MohProfile.tenantId` match). Ownership is checked
   again inside the api endpoint (belt and suspenders).
4. **Manifest entry** `pbx.M1` (status `planned` → promoted only by
   certification; `liveEnabled` stays false until live-cert passes on T21).

## 3. Who can ask, who approves

- **Request:** tenant admins and Izzy. Regular users are politely redirected to
  their admin (X2 standing). Per-tenant policy can tighten further.
- **Approve:** EVERY live execution requires Izzy's bound, single-use approval
  (X1). No exceptions, including Izzy-requested changes. The approval email
  shows: tenant, current profile → requested profile, reason, expiry.
- All X1 fences apply: T21-only allow-list during cert, 10 live writes/hour
  global budget, max 3 pending per tenant, kill switch, snapshot-or-refuse.

## 4. SEBA — Side-Effect & Blast-Radius Analysis

**(a) Everything touched on execute:** `MohOverrideState` (1 row, this tenant),
`MohPublishRecord` (+1 row), AstDB keys under this tenant's own prefix
(`connect/t_<slug>/…`) via the telephony service, and — only when the chosen
profile maps to a native VitalPBX class — the existing helper's
`music_group_id` update for this tenant's own routes/extensions/queues
(identical writes to a portal click today).
**(b) Other readers of those locations:** live calls resolve hold music from
those AstDB keys; the MOH reconcile worker; the portal MOH pages. A wrong value
changes HOLD MUSIC ONLY — routing, registration, dialing, voicemail are
untouched by these keys.
**(c) Calls in flight:** a call already listening to hold music keeps its
current stream; the next hold uses the new class (exactly the portal's existing
behavior).
**(d) Dies halfway:** override row updated but publish failed ⇒ the existing
1-minute worker reconciles (proven path); api timeout ⇒ action outcome
UNKNOWN + owner alert, NO blind retry (X1 G10 contract).
**(e) Fan-out proof:** tenant is pinned by X2 identity + G6 allow-list; every
AstDB key carries the tenant's own slug prefix; profileId ownership is verified
in scopeCheck AND in the endpoint. No bulk shape exists in the op schema.
**Worst case ceiling:** one tenant hears the wrong (or default) hold music
until one-click revert / rollback — seconds, not an outage.

## 5. Test plan

- **UNIT** — op schema (activate requires profileId; expiry parsing; deactivate
  form); snapshot/dispatch/verify/revert against a fake internal endpoint;
  foreign-profile refusal; endpoint auth (missing/wrong secret ⇒ 403);
  endpoint refuses profile not owned by tenant.
- **SIM-CERT** — harness: full G0–G11 + revert for pbx.M1 with a simulated
  endpoint; catalog static guard still holds; manifest gate keeps pbx.M1
  un-offerable until certified.
- **RED-TEAM** — approve-then-mutate profileId (G8); foreign tenant (G6/G3);
  regular-user request (policy refusal); replayed approval (single-use);
  profileId of another tenant with correct-looking ids.
- **STRESS** — 25 rapid A→B→A flips (sim): state machine + rate caps hold;
  publish failure injected ⇒ verify mismatch ⇒ auto-revert fires; endpoint
  timeout ⇒ UNKNOWN outcome recorded, zero retries; concurrent duplicate
  requests ⇒ pending-cap + single-use hold.
- **LIVE-CERT (T21 "Landau Home" ONLY, Izzy approving every step)** —
  1. read-only: list T21's profiles + current state;
  2. activate profile B (Izzy approves) → verify AstDB publish result + portal
     shows override active → **Izzy hears it** (test call, hold);
  3. one-click revert (Izzy approves) → verify original state + hearing check;
  4. expiry drill: activate with 1-hour expiry → confirm auto-restore;
  5. protected checks: attempt against tenant 8 → must refuse at G6 (logged).
- **REVERT-DRILL** — step 3 above is the drill, executed live.

## 6. Decisions

1. **Requesters — ANSWERED (Izzy, 2026-07-23): full-tenant changes may be
   requested ONLY by the tenant OWNER (TENANT_ADMIN role) or Izzy.** Managers,
   admins, and regular users are redirected to the tenant owner. Izzy still
   approves every live execution.
2. **Temporary switches — ANSWERED (Izzy, 2026-07-23): YES.** Timed changes
   with auto-restore are approved (existing override-expiry machinery).
3. **Live-cert prerequisites on T21:** (a) at least 2 MOH profiles to flip
   between; (b) at least one QUEUE — **Izzy is creating the Landau queue now
   (2026-07-23)**.

**SPEC STATUS: SIGNED OFF by Izzy 2026-07-23 — build blocked only on X4.**
