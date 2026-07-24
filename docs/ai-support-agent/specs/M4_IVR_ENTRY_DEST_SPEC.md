# M4 — IVR Menu Digit Destination Change — SPEC v2 (post-study) for Izzy sign-off

_2026-07-23 · Roadmap: `../ACTIONS_V2_ROADMAP.md` · Prereqs: X1 ✅ X2 ✅ M1-pattern ✅ · Status: **STUDY DONE — approach confirmed; awaiting sign-off to build+harden**_

_Repo: https://github.com/izzwgg-arch/connect-platform_

## 0. STUDY RESULT (read-only PBX + code, 2026-07-23) — Izzy was right

The live IVR is Connect's **custom-context** engine, NOT native compiled IVRs:
- Inbound routes hand calls to the `[connect-tenant-ivr]` custom context.
- That context + `[connect-option-router]` resolve EVERYTHING live from AstDB:
  a pressed digit reads `DB(connect/t_<slug>/opt_<digit>/dest)` and `.../type`
  and dispatches by type (extension / external_number / terminate / Goto-context).
- Connect ALREADY has the full machinery: `IvrRouteProfile`, `IvrOptionRoute`
  (`optionDigit`, `destinationType` ∈ extension|queue|ring_group|voicemail|ivr|
  announcement|external_number|terminate|custom, `destinationRef`, `enabled`),
  `IvrOverrideState`, `IvrPublishRecord`, publish code writing the `opt_<digit>`
  AstDB keys, and portal routes (`/voice/ivr/route-profiles`, `/voice/ivr/publish`).

**Consequences (all wins):**
- **M4 = change an `IvrOptionRoute` + publish AstDB keys.** Live, instant, **NO
  dialplan regen, NO PBX-host install, NO June-incident risk** — same safety
  class as M1 (MOH). The earlier "compiled dialplan / regen" risk is OFF THE
  TABLE for the Connect IVR (it only applied to native `ombu_ivrs`, which is not
  the live layer here).
- **"Route a digit to ANYTHING" is achievable** — the destination is a clean
  typed `(destinationType, destinationRef)` in Connect's own model, not an
  ambiguous `ombu_destinations` id. No Option-A restriction needed.
- **Most of it is already built** — M4 wraps the EXISTING publish path in the
  agent's approval/snapshot/verify/revert pipeline; it does not reinvent IVR.

## 1. What M4 does

Change which destination a **digit** in a tenant's IVR profile points at (any of
the supported types), and revert. Menu-level sibling of M1/M3.

**NOT in M4:** greeting (M5), timeout/invalid destinations (M6 — separate AstDB
keys `dest_timeout`/`dest_invalid`), creating IVR profiles (E4).

## 2. Execution path — the portal's own IVR publish, wrapped

`apps/api`: internal door action(s) on the agent route/MOH pattern —
`ivr_list` (profiles + options for a tenant), `ivr_set_option`
(upsert one `IvrOptionRoute` digit → type+ref), `ivr_clear_option`, each driving
the SAME `IvrOptionRoute` upsert + `/voice/ivr/publish` path the portal uses,
attributed `agent:<actionId>`. Publish history + override snapshot already exist.

`apps/agent`: `pbx.M4` op (kind `ivr_option`, feasibility `astdb`): snapshot the
profile's current option set → dispatch the one digit change → verify the
`IvrOptionRoute` row + publish record reflect it → revert restores the snapshot.

## 3. THE HARDENING MANDATE (Izzy: "every type must work, nothing contradicts or breaks; super-duper stress test")

Per-destination-type correctness is the heart of M4. Each type has a distinct
`destinationRef` shape and validation:

| Type | destinationRef | Validation (tenant-owned + well-formed) |
|---|---|---|
| extension | tenant extension number | exists for tenant (X2 `Extension`); protected-ext aware |
| queue | tenant queue | exists for tenant |
| ring_group | tenant ring group | exists for tenant |
| voicemail | tenant mailbox | exists for tenant |
| ivr | another tenant IVR profile | profile belongs to tenant; **loop guard** (no self / cycle) |
| announcement | tenant prompt ref | prompt exists |
| external_number | E.164 | strict E.164; spoof-safe (tenant-verified caller-id policy) |
| terminate | (none) | ref empty |
| custom | context,exten,priority | allow-listed safe contexts only; NEVER arbitrary dialplan |

**Hard rules:** unknown/unsupported type ⇒ REFUSE. Malformed ref for a type ⇒
REFUSE. `custom` restricted to an allow-list (never arbitrary Goto). Digit must
be 0-9/star/hash. Every change tenant-pinned (X2) + Izzy-approved + snapshot +
verify + auto-revert. Connect-mode/native-layer question does not apply (this IS
the Connect layer).

## 4. SEBA

Touches: one `IvrOptionRoute` row (this tenant/profile/digit) + the AstDB
`opt_<digit>` keys for that profile + `IvrPublishRecord`. Other readers: callers
in that IVR (in-progress callers keep their menu; next caller gets the new map).
Dies halfway: row updated, publish failed ⇒ verify fails ⇒ auto-revert +
reconcile worker. Fan-out: one digit of one profile of one tenant; no bulk.
**Worst case: one menu digit rings the wrong (but tenant-owned) place until
one-click revert — seconds.** No regen, no tenant-wide blast radius.

## 5. Test plan — exhaustive, per Izzy's mandate

- **UNIT:** op schema; snapshot/dispatch/verify/revert vs a fake IVR door; the
  FULL per-type matrix (§3) — each type: valid ref passes, malformed ref refused,
  cross-tenant ref refused, wrong-type-for-ref refused; loop guard (ivr→self,
  ivr→cycle); custom allow-list enforced; protected-extension aware; digit
  validation (0-9/star/hash only).
- **SIM-CERT:** full G0–G11 + revert for pbx.M4; zero-IVR-door tripwire in sim;
  catalog M1–M4 contract holds.
- **RED-TEAM:** approve-then-mutate (digit / type / ref) at G8; foreign tenant;
  cross-tenant destination of each type; custom-context escape attempt; external
  number spoof attempt.
- **SUPER-DUPER STRESS:** every type set→change→revert in rapid succession; all 12
  digits of one profile churned concurrently; interleaved type changes on the same
  profile (no contradiction/last-writer corruption); publish-fail ⇒ auto-revert;
  budget cap under concurrency; 500-op volume; adversarial ref fuzz per type.
- **LIVE-CERT (T21, Izzy approving each):** on a throwaway IVR profile — point a
  digit at an extension → CALL, press it, reach it → repeat for a queue, an
  external number, terminate → each heard/verified → revert each → loop attempt
  refused → cross-tenant refused.
- **REVERT-DRILL** live.

## 6. Decisions Izzy makes

1. Confirm the **Connect custom-context / AstDB approach** (this spec) is the one
   to build — NOT native `ombu_ivrs`. (Study says yes; your recollection was right.)
2. `custom` type: ship with an **allow-list of safe contexts only** (recommended),
   or exclude `custom` entirely in M4 v1? Recommended: allow-list, or exclude and
   add later.
3. Live-cert prerequisite: you create a throwaway IVR profile on T21 before
   live-cert. OK?
