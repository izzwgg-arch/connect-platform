# M11 — Extension Feature Toggles (DND / Call-Forward) — SPEC v1 (post-study) for Izzy sign-off

_2026-07-23 · Roadmap: `../ACTIONS_V2_ROADMAP.md` · Prereqs: X1 ✅ X2 ✅ · Needs: **H-series helper endpoint** · Status: **STUDY DONE — awaiting sign-off**_

_Repo: https://github.com/izzwgg-arch/connect-platform_

## 0. STUDY RESULT (read-only, 2026-07-23) — buildable and SAFE (no regen)

The permanent, real DND / call-forward toggles are **live AstDB keys** the
dialplan reads at call time — **no compiled config, NO regen**:
`<tenantPath>/diversions/<ext>/<FEATURE>/{enable,destination,time_group}`, where
FEATURE ∈ `DND`, `CFU` (unconditional), `CFB` (busy), `CFN` (no-answer), `CFI`.
`enable` = `yes|no`.

Two things the study nailed down:
1. **The scrambled tenant hash = `ombu_tenants.path`** (16-hex), queryable by
   `tenant_id`. Confirmed: tenant 14 → `03efa0395977e053`; T21 (Landau) →
   `a70274ea0f143ca0`. So the namespace is fully derivable from ombutel.
2. **The safe write = `asterisk -rx "database put <path>/diversions/<ext>/<F> enable <v>"`**
   — a live AstDB write, **NOT gen-conf**, no dialplan reload needed (the
   dialplan reads `DB(...)` live). Snapshot via `database get`.

**Trap avoided:** Connect's existing `dnd-publish` is a DIFFERENT thing — a
mobile-app softphone DND signal for the wake system, NOT the native call-blocking
DND. M11 must NOT use it (it would say "DND on" while calls keep ringing).

## 1. What M11 does

Permanently set/clear an extension's **DND** and **call-forward** (unconditional
/ busy / no-answer), with a destination for the forward. The permanent sibling of
the temporary A2/A7 actions. Own extension (user) or any tenant extension (owner).

## 2. Mechanism — a new helper endpoint (H-series), Izzy-installed

The tenant-path lookup + `database put/get` both need ombutel + asterisk CLI,
which live on the PBX. So M11 adds a small dedicated helper endpoint (same proven
pattern as M3's route endpoints, X4's queue patch):
- `/get-diversion` `{ tenantId, extension, feature }` → resolve `ombu_tenants.path`,
  `database get <path>/diversions/<ext>/<F>/{enable,destination}` (snapshot).
- `/set-diversion` `{ tenantId, extension, feature, enable, destination? }` →
  resolve path, `database put …` (live). Tenant-scoped, protected-ext aware.

Delivery discipline: helper source in the repo installer, reviewed + installed by
Izzy (or a one-time direct-install like X4/M3). **No gen-conf, ever** — pure
AstDB `database put`.

`apps/api`: internal door `/internal/agent/extfeature/action` calling the helper.
`apps/agent`: `pbx.M11` op (kind `extension_feature`): snapshot the ext's current
DND/CF state → dispatch set → verify `database get` matches → revert restores the
snapshot. Scope fence: extension belongs to tenant (X2 `extension` mapping);
protected-ext (101) gate (G5) applies; forward destination validated.

## 3. Interaction with temporary A2/A7 (hard rule)

M11 is the PERMANENT toggle; A2/A7 are the temporary auto-revert ones. If a
temporary A2/A7 override is active on the same extension, M11 must surface it and
the spec's deterministic rule applies: **the most recent explicit set wins, and
M11 clears any conflicting temporary auto-revert timer** (documented in the op).
Revert uses a three-way check: if the ext's live DND/CF was changed by someone
else (GUI/feature code) since our snapshot, revert refuses + alerts (X1 rule).

## 4. SEBA

Touches: the AstDB `<path>/diversions/<ext>/<F>/*` keys for ONE extension. Read
live by the dialplan; no regen, no reload. Other readers: inbound calls to that
ext. Dies halfway: put succeeded, verify mismatch ⇒ auto-revert; helper timeout
⇒ UNKNOWN, no retry. Fan-out: one ext, one feature; path is tenant-scoped. **Worst
case: one extension wrongly forwards/DNDs until one-click revert — seconds.**

## 5. Test plan

Unit (op + feature/destination validation) · helper repo-side unit (path lookup,
db put/get fixture) · SIM-CERT (zero-helper tripwire) · RED-TEAM (approve-then-
mutate G8; protected ext G5; foreign ext G3; A2/A7 conflict) · SUPER-STRESS
(rapid DND/CF toggles + volume) · LIVE-CERT on T21 (set DND on ext → CALL it,
confirm blocked → clear → confirm rings; set CFU to a cell → call, confirm
forwarded → revert). REVERT-DRILL live.

## 6. Decisions Izzy makes

1. Helper install: standard (you install) or one-time direct-install (X4/M3)?
2. Features in v1: DND + CFU/CFB/CFN — OK, or DND-only first?
3. Requesters: user for THEIR OWN ext; owner for any — OK?
