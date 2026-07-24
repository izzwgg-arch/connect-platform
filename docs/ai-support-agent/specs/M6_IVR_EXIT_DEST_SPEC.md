# M6 — IVR Timeout / Invalid-Input Destination — SPEC v1 for Izzy sign-off

_2026-07-23 · Roadmap: `../ACTIONS_V2_ROADMAP.md` · Prereqs: X1 ✅ X2 ✅ M4 ✅ M5 ✅ · Status: **AWAITING SIGN-OFF**_

_Repo: https://github.com/izzwgg-arch/connect-platform_

## 1. What M6 does

Change where a caller goes when they **don't choose** — the **timeout**
destination (they stay silent) and the **invalid** destination (they press a key
with nothing on it, after retries) — for an IVR profile. And revert. The
"fall-through" sibling of M4 (per-digit destinations).

**NOT in M6:** menu digit destinations (M4), greeting/prompt recordings (M5),
timeout seconds / retry counts (those are simple profile numbers, a separate
smaller item).

## 2. Same safe class (study done)

`[connect-tenant-ivr]` reads these live from AstDB:
`EXIT_DEST=${DB(<family>/dest_timeout)}` + `dest_timeout_type` (and the invalid
pair), dispatched by `[connect-exit-router]` (terminate / external_number /
extension / Goto-context). They publish from the profile's
`timeoutDestinationType/Ref` + `invalidDestinationType/Ref`. So M6 = patch those
fields + republish — **live, no dialplan regen, no PBX install, M1-safety-class.**
Reuses the M4 IVR door + `publishIvrForTenant`.

## 3. Validation — reuse M4's hardening matrix

The exit destination uses the SAME typed `(destinationType, destinationRef)` as a
menu digit, so M6 reuses `validateAgentIvrOption` verbatim: per-type ref shape,
`custom` allow-list, sub-menu loop guard (an exit pointing back at its own IVR),
and tenant ownership of a sub-menu target. Clearing an exit slot (null) is
allowed — the dialplan falls through to its safe default.

## 4. Execution path

`apps/api`: extend the IVR door with `action: "set_exit"`
`{ profileId, exitSlot: "timeout"|"invalid", destinationType?, destinationRef? }`
(both null ⇒ clear). Validates via `validateAgentIvrOption`, patches the two
profile fields for that slot, then `publishIvrForTenant`. Attribution `agent:<actionId>`.

`apps/agent`: `pbx.M6` op (kind `ivr_exit`): snapshot the profile's 2 exit
destination pairs → dispatch set_exit → verify field + publish → revert restores
the snapshot. Scope fence `ivr_exit` = profile belongs to tenant (as M4/M5).

## 5. SEBA

Touches: one IvrRouteProfile exit field-pair (this tenant/profile) + the AstDB
`dest_timeout`/`dest_invalid` keys + IvrPublishRecord. Callers already in the IVR
keep the old behavior; the next timeout/wrong-key uses the new one. Dies halfway:
verify fails ⇒ auto-revert. Fan-out: one profile, one slot; no bulk. **Worst
case: one IVR sends timeout/invalid callers to the wrong (tenant-owned) place
until one-click revert.**

## 6. Test plan

Unit (op + reused validator) · SIM-CERT (zero-api tripwire; catalog M1–M6) ·
RED-TEAM (approve-then-mutate G8; foreign profile G3; custom escape; loop) ·
SUPER-STRESS (rapid timeout/invalid swaps + volume) · LIVE-CERT on T21 (set a
timeout dest → **let it time out on a call, confirm it lands there** → set an
invalid dest → press a wrong key → confirm → revert).

## 7. Decisions Izzy makes

1. Both slots (timeout + invalid) in one capability — OK?
2. Requesters: tenant owner + Izzy — recommended yes.
