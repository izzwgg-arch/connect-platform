# M2 — Music-on-Hold Selection (Extension) — SPEC v1 for Izzy sign-off

_2026-07-23 · Roadmap: `../ACTIONS_V2_ROADMAP.md` · Prereqs: X1 ✅ X2 ✅ M1 ✅(built) · Status: **AWAITING SIGN-OFF**_

_Repo: https://github.com/izzwgg-arch/connect-platform_

## 1. What M2 does (and only this)

Set (or clear) the hold music for **one specific extension**, overriding the
tenant default just for that extension — the per-extension sibling of M1.
Two actions:
- **set** — point extension N at one of the tenant's own MOH profiles.
- **clear** — remove the override so the extension goes back to inheriting the
  tenant's hold music (M1's territory).

**NOT in M2:** tenant-wide MOH (that's M1), creating/deleting profiles,
uploading audio, queues (an extension override never touches queue music),
schedules.

## 2. Why M2 is simpler than M1

- **No queue coverage (X4) needed** — a per-extension override changes only that
  one extension's hold music; queues are unaffected, so there is no queue
  evidence to check.
- **Object type already scope-mapped** — M2's object is `extension`, which X2's
  scope resolver already proves ownership for. No new mapping.
- **Protected-extension gate already applies** — G5 blocks ext 101 (and the
  `AGENT_PBX_PROTECTED_EXTS` list) automatically. Harmless-but-fenced by design.

## 3. Execution path — the portal's own extension-override routes, unchanged

The portal already does this daily via `PUT /voice/moh/extension-overrides`
(upsert) and `DELETE` (clear), which validate the extension exists for the
tenant, validate the MOH class, confirm the profile belongs to the tenant, then
`upsertExtensionOverride` → the standard publish carries the per-extension AstDB
keys (`connect/t_<slug>/extensions/<ext>/{moh_class,active_moh_class}`).

M2 adds:
1. **`apps/api`: two more actions on the existing internal door**
   `POST /internal/agent/moh/override` gains `action: "ext_set" | "ext_clear"`
   with `{ extension, profileId? }`, driving the SAME upsert/delete + publish the
   portal routes use. Attribution `agent:<actionId>` as in M1.
2. **`apps/agent`: second `MODIFY_CATALOG` op** (`pbx.M2`, kind `extension`,
   feasibility `astdb`): snapshot current extension override → dispatch set/clear
   → verify the override row + publish reflect intent → revert restores the prior
   override (or clears it if none existed).
3. **Manifest** `pbx.M2` (status `built`, `liveEnabled` false until T21 live-cert).

Scope fence: object is the extension number; must belong to the requester's
tenant (existing `extension` mapping) AND, when a profile is named, the profile
must belong to that tenant (checked in snapshot + api, as M1).

## 4. Who can ask, who approves

- **Request:** the extension's own user may request their OWN extension; tenant
  admins/owner may request any extension in their tenant; Izzy always. (This is
  narrower-friendly than M1: a regular user changing THEIR OWN extension's hold
  music is in-scope per X2 standing.)
- **Approve:** every live execution requires Izzy's bound single-use approval
  (X1). All X1 fences apply (T21-only during cert, budget, protected exts,
  snapshot-or-refuse, verify-or-revert).

## 5. SEBA — Side-Effect & Blast-Radius Analysis

**(a) Touched on execute:** `MohExtensionOverride` (1 row, this tenant+ext),
`MohPublishRecord` (+1), the per-extension AstDB keys for that ONE extension.
No queues, no other extensions, no tenant-default keys.
**(b) Other readers:** live calls to/for that extension resolve hold music from
those keys; the reconcile worker; the portal MOH extension-overrides page. Wrong
value = wrong hold music **for one extension only**. Routing/registration/dialing
untouched.
**(c) Calls in flight:** an active hold keeps its stream; next hold uses the new
class (portal's existing behavior).
**(d) Dies halfway:** override upserted, publish failed ⇒ reconcile worker heals;
api timeout ⇒ outcome UNKNOWN + alert, no blind retry (G10).
**(e) Fan-out proof:** tenant pinned by X2 + G6; extension validated to exist in
that tenant; AstDB key path includes the tenant slug AND the single ext number;
op schema has no bulk shape. **Worst case ceiling:** one extension plays the
wrong hold music until one-click revert — seconds.

## 6. Test plan

- **UNIT** — op schema (set requires profileId; clear form; objectId == extension);
  snapshot/dispatch/verify/revert vs a fake internal endpoint; foreign-profile
  and foreign-extension refusal; protected-ext (101) refused at G5; api action
  validation (unknown ext ⇒ 404; profile not in tenant ⇒ 400).
- **SIM-CERT** — harness: full G0–G11 + revert for pbx.M2; catalog now has M1+M2,
  contract holds; zero-network tripwire.
- **RED-TEAM** — approve-then-mutate extension/profile (G8); foreign tenant (G6/G3);
  another tenant's extension number (G3); replayed approval (single-use).
- **STRESS** — 25 rapid set→clear→set flips (sim); publish-fail ⇒ auto-revert;
  timeout ⇒ zero retries; live budget cap holds.
- **LIVE-CERT (T21 "Landau Home" ONLY, Izzy approving each step)** — set a
  throwaway extension's hold music → hear it → clear → hear inheritance restored →
  attempt ext 101 (must refuse at G5) → attempt another tenant's ext (must refuse).
- **REVERT-DRILL** — the clear/restore step, executed live.

## 7. Decisions Izzy makes on this spec

1. **Requesters:** allow a regular user to change THEIR OWN extension's hold
   music (still Izzy-approved to execute), while tenant-wide M1 stays
   owner-only? Recommended yes (it's their own extension). OK?
2. **Timer:** offer the same optional auto-restore expiry as M1 for temporary
   per-extension changes? Recommended yes. OK?
