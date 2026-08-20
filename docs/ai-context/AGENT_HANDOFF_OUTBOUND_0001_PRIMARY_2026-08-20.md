# AGENT HANDOFF — the shared "0001" trunk is the PRIMARY on every outbound route; VoIP.ms is the backup (2026-08-20)

Izzy, 2026-08-20: *"the voip.ms outbound routes are being filtered by carriers, so
I'm only using them as a backup. There is an outbound route called 0001. It's a
trunk called 0001… always the trunk on top, the first one in the row in the
outbound route, and the voip.ms trunk that you created should always be the
secondary, which is a backup. I forgot to put it into the thing… make that a new
rule and backfill the ones that we created and don't have it yet."*

## The rule

Every tenant's outbound route lists the shared **"0001" trunk FIRST** (trunk_id
72 on the live PBX — a **Telocall** trunk: `us-east.telocall.com:7000`,
`connect.sip.telocall.com`) and the tenant's own **VoIP.ms trunk SECOND** as the
backup. Carriers filter/mislabel VoIP.ms-originated calls — they were not
reaching cell phones — so VoIP.ms is never the primary carrier.

- ⛔ **ORDER IS THE FEATURE.** The panel assigns `ombu_outbound_route_members.index`
  from posted `trklist[]` order, and the rendered dialplan dials trunks in that
  order — `Gosub(trk-72,…)` first, falling through to the tenant trunk only on
  real trunk failure (hangup causes 16/17/19 finish without failover, so a busy
  or no-answer never re-dials over VoIP.ms).
- ⛔ **Matched by exact trimmed NAME "0001", never a pinned id** —
  `SHARED_PRIMARY_TRUNK_NAME` in `apps/api/src/onboarding/pbxTenantBuild.ts`.
  Pinned ids are the doorway-destination trap (a panel delete/re-create moves the
  id and every build silently degrades).
- ⛔ **Emergency calling stays on the tenant's OWN VoIP.ms trunk**
  (`provisionTenantEmergency` still gets `trunkIds: [trunkId]`). That is the
  account carrying the number's E911 registration — never add 0001 there.
- **Failure direction:** a PBX with no "0001" trunk still builds (a paid customer
  with no phone system is worse than backup-only outbound), but the build log —
  which lands on the sign-up timeline — says
  `⛔ shared primary trunk "0001" not found on the PBX…` in plain words.

## The code change (`apps/api/src/onboarding/pbxTenantBuild.ts`)

- `createOutboundRoute()` now takes `trunkIds: string[]` and posts one
  `trklist[]` pair per trunk in order.
- New `findSharedPrimaryTrunkId(s)` resolves "0001" from the outbound-route
  form's trunk select (`TRUNK_SELECT`), exact match after `trim()` (live panel
  names carry stray spaces — "Kj Play Center ").
- `buildPbxTenant()` builds `[primary, voipms]` when 0001 exists, `[voipms]` with
  the loud log line when it does not.
- This is the ONE outbound-route creation site (mirror builds use the same
  function — the mirror replaces only tenant-create), so the rule covers panel
  and mirror builds alike.
- Tests: 3 new in `pbxTenantBuild.test.ts` (order asserted with `deepEqual` on
  `getAll(trklist[])`; exact-name matching; missing-0001 degradation + log).
  **Replayed against HEAD's source: all 3 fail there** — non-vacuous. Suite
  40/40; api typecheck 75 = the exact baseline.

## The backfill — DONE and verified live (2026-08-20, ~07:00 EDT)

Every hand-built route already had 0001 first; the onboarding-created ones
(identity-suffix labels) had only their VoIP.ms trunk. Backfilled via panel
replay (the proven route-edit shape: `loadParsedForm("trunk_group","edit",id)` →
`applyOverrides({multi:{"trklist[]":[72, vm]}})` → post → verify re-read), then
**ONE Apply in Main via the console's `applyAndRebake`** (doorway re-bake: 3
Connect-mode tenants, 0 lines changed — nothing wiped). Script ran inside
`app-api-1`; copy kept at `/root/backfill-0001-primary-trunk.ts` on loopcom.

| route | label | tenant | trunks now (in order) |
|---|---|---|---|
| 122 | Ezra stress test 1 | T101 | 72 (0001), 126 |
| 125 | Matamim h8gmrh | T104 | 72 (0001), 129 |
| 126 | inii mini 92gh2m | T105 | 72 (0001), 130 |
| 128 | a plus center ep3wlb (TYH Industries) | T106 | 72 (0001), 131 |
| 161 | Loopcom Demo 2 (mirror test tenant) | T140 | 72 (0001), 165 |

Verified three ways: `ombu_outbound_route_members` reads index 0 = 72 on all
five; the rendered `extensions__50-1-dialplan.conf` shows `dial-trk-72` before
`dial-trk-<vm>` in each `s-<route>`; **live Asterisk** (`dialplan show
trk-group-<n>`) shows `Gosub(trk-72` first on all five. Doorways intact after
the apply (T2 1, T35 1, T105 2 — baseline counts; `connect-doorway` loaded).

**Rollback:** `/root/outbound-route-0001-backfill-backup-20260820T105929Z.sql`
on the PBX (the five routes' `ombu_outbound_routes` + members rows pre-change).
Restoring it needs the queued-changes + Main Apply dance — a direct DB write is
not a pending change.

## ⛔ Deliberately NOT touched

- **Route 123 "Loopcom Demo" stays trunk 132 (SignalWire) ONLY** — that is
  Izzy's SignalWire outbound test bed (2026-08-18/19); adding 0001 or VoIP.ms
  back would corrupt the A/B test.
- **Route 59 "iniimini" (trunk 64, no 0001)** — a pre-onboarding-era hand object;
  the live inii mini tenant uses route 126, which is fixed. Flagged, not edited.
- Other hand-era routes without 0001 (36 Kitchens of Usa, 37 Silver Birch,
  40 Onveo on the anveoO trunk, 41 Actual Home Care, 52 Slim Business Funding,
  53 Care Meals, 54 spam test, 74 Agent, 75 j&j Plumbing, 80 ploly) — not
  onboarding-created, not in the mandate; whether they should carry 0001 is
  Izzy's call.
- Emergency trunks (per-tenant trunks 129/130/131 on `ombu_emergency_trunks`
  paths) — untouched by design, see the rule above.

## Trunk 0001 health notes

- `pjsip show registrations` reads **`0001/sip:us-east.telocall.com:700 …
  Rejected`** — that is the inbound REGISTRATION leg only (note the `:700`
  server_uri, likely a typo of `:7000` in the trunk config) and does NOT affect
  outbound INVITEs, which use the static contact `sip:us-east.telocall.com:7000`.
  Proven: Gesheft T8_105 completed a call through `trk-72-dial` →
  `Dial(PJSIP/…@0001)` at 00:08 EDT on 2026-08-20, and every hand-built customer
  route has dialed 0001 first for weeks. Do not "fix" the registration as part
  of any outbound investigation without checking whether inbound over 0001 is
  even used.

## ⏳ NOT PROVEN

- No outbound call has been placed from the five backfilled tenants since the
  change. Acceptance: one call from any of them (e.g. Ezra's training tenant) to
  a cell phone — the Asterisk log must show `Gosub(trk-72,…)` before any
  `trk-<vm>` attempt, and the callee's phone must not label it spam.
- No new tenant has been built since the code change deployed — the next real
  sign-up's build log should read `outbound route ok (… trunks 0001→VoIP.ms)`.
