# M7 — Time-Condition / IVR Schedule Edit — SPEC v1 for Izzy sign-off

_2026-07-23 · Roadmap: `../ACTIONS_V2_ROADMAP.md` · Prereqs: X1 ✅ X2 ✅ M4–M6 ✅ · Status: **AWAITING SIGN-OFF**_

_Repo: https://github.com/izzwgg-arch/connect-platform_

## 0. STUDY RESULT (2026-07-23) — Connect's IVR schedule IS the live scheduler

An **IVR schedule worker** (`apps/worker/src/main.ts:1733`) continuously reads
each tenant's `IvrScheduleConfig`, computes the current mode (business /
after-hours / holiday) via `computeCurrentMode`, and republishes the active
profile's AstDB keys on a mode change. So the live "time condition" for a tenant
is **Connect's `IvrScheduleConfig`**, not native `ombu_time_conditions`. ⇒ M7 =
edit that config + republish — **live, no dialplan regen, no PBX install,
M1-safety-class** (same as M4–M6). The roadmap's "Helper-NEW / native" note is
superseded by this study.

## 1. What M7 does

Edit a tenant's IVR schedule: **timezone**, **business-hours rules**
(per-weekday open/close), **holiday dates**, and which IVR profile serves each
mode (**default / after-hours / holiday**). And revert. This is the "when does
the menu change" control.

**NOT in M7:** the profiles themselves (M4–M6 edit those), the override toggle
(A4 temporary), retry counts.

## 2. Execution path

`apps/api`: extend the IVR door with `action: "set_schedule"` carrying the full
schedule payload (mirrors `PUT /voice/ivr/schedule`). Validates: shape
(weekday 0-6, `HH:MM` times, `YYYY-MM-DD` holidays), and every referenced
profileId (default/after-hours/holiday) belongs to the tenant. Upserts
`IvrScheduleConfig`, then `publishIvrForTenant` (immediate effect; the worker
also reconciles). Attribution `agent:<actionId>`.

`apps/agent`: `pbx.M7` op (kind `ivr_schedule`, objectId = tenantId): snapshot
the current schedule config → dispatch set_schedule → verify config matches →
revert restores the snapshot. Scope fence `ivr_schedule` = objectId == the
verified tenant; profile refs verified in the door.

## 3. Approval-email safety touch

The approval email renders the **resulting open/closed calendar for the next 7
days** (from the proposed rules + timezone) so Izzy sees in plain English what
the schedule will actually do — including a warning when the edit flips the
tenant's CURRENT mode the moment it publishes.

## 4. SEBA

Touches: one `IvrScheduleConfig` row (this tenant) + the AstDB active-profile
keys (via publish) + IvrPublishRecord. Other readers: the IVR schedule worker
(reconciles from the same row), the portal schedule page. Calls in flight
unaffected; the next mode evaluation uses the new schedule. Dies halfway: config
written, publish failed ⇒ verify fails ⇒ auto-revert; the worker would also
re-publish. Fan-out: one tenant's one schedule row; no bulk. **Worst case: a
tenant switches business/after-hours at the wrong time until one-click revert.**

## 5. Test plan

Unit (op + schedule shape validator: bad weekday/time/holiday refused; foreign
profile ref refused) · SIM-CERT (zero-api tripwire; catalog M1–M7) · RED-TEAM
(approve-then-mutate schedule G8; foreign tenant G3; foreign profile ref) ·
SUPER-STRESS (rapid schedule swaps + volume) · LIVE-CERT on T21 (set a schedule
whose "now" is after-hours → confirm the after-hours profile answers a test call
→ revert → confirm business profile). 7-day calendar preview verified.

## 6. Decisions Izzy makes

1. M7 edits the whole schedule (hours + holidays + per-mode profiles) in one
   capability — OK, or split holidays out?
2. Requesters: tenant owner + Izzy — recommended yes.
