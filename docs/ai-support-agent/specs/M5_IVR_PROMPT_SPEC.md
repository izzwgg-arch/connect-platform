# M5 — IVR Greeting / Recording Selection — SPEC v1 for Izzy sign-off

_2026-07-23 · Roadmap: `../ACTIONS_V2_ROADMAP.md` · Prereqs: X1 ✅ X2 ✅ M4 ✅ (IVR door + publish) · Status: **AWAITING SIGN-OFF**_

_Repo: https://github.com/izzwgg-arch/connect-platform_

## 1. What M5 does

Change **which recording an IVR profile plays** — the greeting, and (optionally)
the wrong-key ("invalid"), timeout, and retry prompts — picking from the tenant's
OWN synced VitalPBX recordings. And revert. The recording sibling of M4 (which
changes destinations); M5 changes the audio.

**NOT in M5:** menu digit destinations (M4), timeout/invalid *destinations* (M6),
uploading/deleting recordings, creating profiles.

## 2. Why M5 is the same safe class as M4 (study already done)

The `[connect-tenant-ivr]` custom context reads the greeting LIVE from AstDB:
`GREETING=${DB(connect/t_<slug>/active_prompt)}` (and `active_prompt_invalid` /
`_timeout` / `_retry`). Those keys are published from the profile's
`pbxPromptRef` / `pbxInvalidPromptRef` / `pbxTimeoutPromptRef` / `pbxRetryPromptRef`.
So M5 = patch one profile prompt field + republish AstDB — **live, no dialplan
regen, no PBX install, M1-safety-class.** Reuses the M4 door + `publishIvrForTenant`.

## 3. The one correctness guard — no dead-air

A greeting pointed at a missing recording = **silent dead-air on live calls**.
So M5 REQUIRES the chosen recording to exist in the tenant's Connect prompt
catalog (`TenantPbxPrompt`) before it will set + publish — the same check the
portal publish already enforces (`ivrResolveMissingPromptRefs`). Clearing a slot
back to default (null) is always allowed.

## 4. Execution path

`apps/api`: extend the M4 IVR door with `action: "set_prompt"`
`{ profileId, promptSlot: "greeting"|"invalid"|"timeout"|"retry", promptRef|null }`.
Validates: profile owned by tenant; if promptRef non-null, it must be in the
tenant's catalog AND well-formed (`ivrValidatePromptRef`). Patches the profile
field, then `publishIvrForTenant`. Attribution `agent:<actionId>`.

`apps/agent`: `pbx.M5` op (kind `ivr_prompt`, feasibility `astdb`): snapshot the
profile's 4 prompt refs → dispatch set_prompt → verify the field + publish
success → revert restores the snapshotted ref. Scope fence: `ivr_prompt` mapping
= profile belongs to tenant (same as M4's `ivr_option`).

## 5. SEBA

Touches: one `IvrRouteProfile` prompt field (this tenant/profile) + the AstDB
`active_prompt*` key + `IvrPublishRecord`. Other readers: callers hitting that
IVR (in-progress callers keep the old greeting; next caller gets the new one).
Dead-air prevented by the catalog check. Dies halfway: field patched, publish
failed ⇒ verify fails ⇒ auto-revert. Fan-out: one profile, one slot; no bulk.
**Worst case: one IVR plays the wrong (but tenant-owned, catalog-verified)
greeting until one-click revert — seconds.**

## 6. Test plan

- **UNIT (api):** slot validation; missing-recording refused; clear-to-default
  allowed; foreign profile refused.
- **UNIT (agent op):** schema; snapshot/dispatch/verify/revert vs a fake door;
  each of the 4 slots; publish-fail ⇒ auto-revert; timeout ⇒ zero retries.
- **SIM-CERT:** full chain + zero-api tripwire; catalog M1–M5 contract holds.
- **RED-TEAM:** approve-then-mutate promptRef (G8); foreign profile (G3).
- **SUPER-STRESS:** rapid greeting swaps across all 4 slots + volume; no corruption.
- **LIVE-CERT (T21, Izzy approving):** set greeting to a synced recording → CALL,
  hear it → set invalid/timeout prompts → hear on wrong-key/timeout → revert →
  hearing check → missing-recording attempt refused.

## 7. Decisions Izzy makes

1. M5 covers all 4 prompt slots (greeting/invalid/timeout/retry) in one capability
   — OK, or greeting-only in v1?
2. Requesters: tenant owner + Izzy (tenant-wide), like M3/M4? Recommended yes.
