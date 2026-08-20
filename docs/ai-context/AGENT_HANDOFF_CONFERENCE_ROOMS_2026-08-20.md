# AGENT HANDOFF — Conference rooms: the backend is BUILT and DEPLOYED, the page awaits Izzy's mockup pick (2026-08-20)

**Commit `c80a585b` (merge `4f886830`) on `feat/ivr-migration-takeover`.** Izzy,
2026-08-20: *"I would like to create a call conferencing feature. There should be
a new page called Conference … a full-on voip conference module"* — and, mid-build:
*"If you are doing any UIs, I want to see [mockups] first."* So: **api + shared
are built; the portal page is deliberately NOT built.** Mockups (3 options + the
New-room dialog) are at
<https://claude.ai/code/artifact/203ce03b-3147-4036-9cd5-4ef919edb4d3>.

Deploy state at the end of the session: see §8 (filled in after the queue job).

## 1. The one-paragraph architecture

VitalPBX already ships everything conferencing needs: the **Conferences module
(module_id 8, multi-tenant)** stores rooms in `ombutel.ombu_conferences`, and the
Asterisk baseplan carries full **ConfBridge** support — per-tenant
`confbridge__50-<t>-profiles.conf` / `confbridge__40-<t>-menu.conf` files
already render for every tenant, recording is wired
(`extensions__20-baseplan.conf:526`), and the stock user/admin DTMF menus
(`confbridge__20-menu.conf`) give mute (1), lock (admin 2), kick-last (admin 3)
and leave (8) on the phone keypad for free. **Zero conference rooms existed
platform-wide on 2026-08-20** — this is a genuinely new surface, so there was no
rendered dialplan example and no captured panel contract. Connect reads rooms
from MySQL via `connect_read` and writes them by **panel replay**, the same road
as queues/ring groups.

## 2. What exists, file by file

- **`apps/api/src/pbxConferenceDirectory.ts`** — the read side.
  `listConferencesFromOmbutel(vitalTenantId, ombuMysqlUrlEncrypted)` on the
  `pbxQueueDirectory` model (same imported `connectOmbutelMysql`, every column
  probed via INFORMATION_SCHEMA, never throws — soft `skipReason`). Table is
  keyed **`conference_id`**, name is **`description`**, all 25 columns were read
  from the live PBX before writing this.
- **`apps/api/src/pbx/conferenceBuilder.ts`** — the write side.
  ⛔ **Unlike teamBuilder it hardcodes NO field list**: it loads the panel's own
  rendered form (`loadParsedForm(s, "conferences", "add"|"edit", id?)`) and
  re-posts it with `applyOverrides` — the pbxConsole discipline. That makes THE
  CHECKBOX RULE hold automatically. `buildConferenceOverrides()` routes each
  yes/no option through whatever control the form renders (checkbox → pair
  added/REMOVED; select → literal value). Fields the form doesn't offer land in
  `skippedFields` (logged), never in a blind post. Essential-field mismatch
  throws `conference_form_mismatch` naming the fields the form DID offer, so a
  panel upgrade self-diagnoses. Delete reuses pbxConsole's two-step
  `panelDelete`. ⛔ The builder never fires Apply Changes (guard test).
- **`apps/api/src/pbx/conferenceRoutes.ts`** — `/voice/conferences`
  GET/POST/PATCH/DELETE, wired in `server.ts` beside `registerTeamRoutes`.
  teamRoutes discipline throughout: panel row ids resolved server-side from the
  room number; number allocation from the live picture (flow-map used numbers
  **plus** existing conference rows — they live in their own table, invisible to
  `UsedNumbers`); every write verified by re-reading `ombu_conferences`
  afterwards ("believe the table, not the notification" — 3 re-reads, guard
  test); refuses when the tenant path is unresolved (⛔ stricter than teamRoutes,
  which tolerates it — a room filed under another company is worse than a retry).
  GET shares the queue feature's tenant resolver (`resolveQueueTenantContext`)
  including the super-admin `vpbx:` override. **Host PIN is masked (`•••`) for
  callers without manage rights.**
- **`packages/shared/src/teamNumbering.ts`** — conference rooms get the
  **700-series** (`nextConferenceNumber`): 700–709 then 7000–7099, widening like
  the team series (ring groups 8xx, queues 9xx). Cross-series rule holds, and
  the existing-conference list is a separate mandatory input.
- **`packages/shared/src/portalPermissions.ts`** — `can_view_conferences` +
  `can_manage_conferences` action keys; SIDEBAR_ITEMS `pbx.conference`
  (`/conference`, key `can_view_pbx_conference`); the nav key rides
  `can_view_conferences` via LEGACY_PERMISSION_EXPANSIONS so nav and page can
  never disagree; TENANT_ADMIN holds both by default, END_USER neither,
  SUPER_ADMIN automatic (no snapshot migration).

## 3. ⛔ Apply Changes — the deliberate split

A saved room is rows in the panel DB; it answers callers only after Apply
renders it. The routes accept **`applyNow` from a SUPER_ADMIN only** (anyone
else's flag is silently ignored), and then go through **pbxConsole's
`applyAndRebake`** — Apply is whole-PBX and wipes the Connect doorway bake, so
the platform-wide re-bake sweep is not optional (guard test pins that no bare
`applyChanges` exists in the routes). For tenant admins the response says
plainly: *"It goes live the next time changes are applied to the phone system"*
— the teams behavior. ⛔ Do not widen `applyNow` past SUPER_ADMIN without
Izzy's word; the 2026-08-06 rule ("Apply is Izzy's click") still governs, and
this is its sanctioned console-shaped exception.

## 4. ✅ The panel form was captured READ-ONLY before any of this could run

A throwaway script inside `app-api-1` (robot login → `getContent mode=add` →
`parseForm`; **no write of any kind**, script removed after) captured the real
"Add Conference" form on 2026-08-20:

- **All 8 option fields are CHECKBOXES** (`record_conference`, `startmuted`,
  `quiet`, `announce_user_count`, `announce_join_leave`,
  `music_on_hold_when_empty`, `wait_marked`, `end_marked`) — tick value **"1"**,
  which the builder takes from the parsed form (never assumes "yes").
- Checked by default: `music_on_hold_when_empty`, `announce_only_user`,
  `dsp_drop_silence`. Scalar defaults: `language=en`, `video_mode=none`,
  `announcement_id=1`, `music_group_id=1`, `class_of_service_id=1`.
- The form carries its own envelope (`class=conferences, method=put, mode=add`)
  and a fresh `csfr_token`.
- ⚠ One fleet-wide quirk seen in the capture: the tenant `music_group_id`
  option list includes OTHER tenants' MOH groups when loaded from the robot's
  home context ("Secro" showed). The builder never touches that field (panel
  default), but if a "hold music per room" picker is ever added, load the form
  in the TENANT's context and scope the options — the `findOptionInSelect`
  cross-tenant lesson.

## 5. Tests (58 relevant, all green) and the dead glob that came alive

- `apps/api/src/pbx/conferenceBuilder.test.ts` — 12: real parse+override chain
  against a synthetic mixed checkbox/select form (checkbox off = pair REMOVED,
  never `=no`; unoffered fields → skippedFields; PIN clear = empty string;
  blank maxMembers = `""` never `"0"`), plus source guards (no Apply in the
  builder; applyNow gated to super via applyAndRebake; 3 verify re-reads;
  tenant-path refusal; server.ts wiring on the right keys — the wiring guard
  fails against the pre-change tree).
- `packages/shared/src/portalPermissions.conference.test.ts` — 7, the queues
  template (no visible door that doesn't open, bucket defaults, revocability).
- `packages/shared/src/teamNumbering.conference.test.ts` — 7 (series shape,
  cross-series collisions, the mandatory existing-conference input).
- ⛔ **`apps/api` now runs `"src/pbx/*.test.ts"`** — that glob was MISSING from
  the package.json test script, so `teamBuilder.queue.test.ts` and
  `applyRegenRebake.test.ts` had NEVER run under `npm test`. Both pass; they
  were verified BEFORE registering the glob.
- Full suites at commit time: shared **374/374**; api **2623 pass / 33 fail,
  every failure pre-existing or another live session's in-flight work** (~24 ×
  the documented `setupOrchestrator` mock drift, 7 × `pbxTenantDirectorySync`,
  1 × the elevenLabs stress load-flake, 1 × a parallel session's
  `registerMeetingRoutes` guard). api typecheck **75 = the exact baseline**;
  shared typecheck 0.

## 6. ⏳ NOT DONE / NOT PROVEN — the honest list

- **The portal page does not exist.** No `/conference` route, no nav rendering
  (the shared nav item is data; the portal navConfig.ts entry is NOT added), no
  CSS. **Blocked on Izzy picking mockup A, B or C** (artifact link above). The
  page must: gate itself with PermissionGate on `can_view_conferences`, check
  `can_manage_conferences` for exactly the buttons the routes gate, register
  UI_PHRASES, stay OFF the `.console-content:has()` list, use theme tokens, and
  join via the `crm:dial` window event (the FloatingDialer bus).
- **No conference room has ever been created** — by this code or by anyone,
  ever, on this PBX. The first create is the acceptance test (below).
- **Live participant state / mute / kick from the page is NOT built.** The
  telephony service has no ConfBridge AMI handling; the DTMF menus cover it
  in-call. Phase 2 = `/telephony/internal/conference/*` routes issuing
  ConfbridgeList/Mute/Kick (telephony deploy — pending-gated, 0-active-calls
  window). Until then the page can only show approximate occupancy from the
  existing live-calls feed (`useTelephony()` — match `destination_extension`).
- **Outside callers can't reach a room yet** — that needs a DID (or IVR key)
  pointed at the conference (destination module_id 8). Not wired; a natural
  follow-up in the DID-routing / IVR Studio surface.
- **VitalPBX's first-render trap is UNTESTED for conferences**: the mirror work
  proved a tenant's FIRST generation doesn't happen via Apply for tenant
  baselines. Whether an incremental Apply renders a tenant's FIRST conference
  (expected — the per-tenant confbridge files already exist) is unproven until
  the acceptance run listens to a real call.

## 7. Acceptance recipe (needs Izzy live — PBX write + Apply)

On **Loopcom Demo (T102)**: create a room from the deployed api (or the page
once built) with `applyNow` as SUPER_ADMIN → confirm `ombu_conferences` has the
row and the response says live → dial the room number from ext 101 → hear the
ConfBridge join → second phone dials in → two-way audio → `confbridge list` on
the PBX shows both → delete the room → verify byte-back (0 rows, doorways
0 cc-wipes — applyAndRebake reports the sweep in the api log:
`[PBX_CONSOLE] apply + doorway re-bake complete`). ⛔ Do NOT run the first
Apply-carrying create without Izzy's live in-chat go — the 2026-08-20 standing
rule after the geo lockout.

## 8. Deploy state (end of session)

- api: **deploy queue job `b78bc0eb` enqueued for the branch tip `4f886830`**
  (carries this backend + other sessions' committed work; ⛔ NO migrations ride
  along — checked `git diff --name-only 36043a3b..4f886830 -- packages/db/prisma/`
  = empty). Verify after: `/app/.build-commit`, then grep the container for
  `registerConferenceRoutes` in `server.ts` and probe
  `GET 127.0.0.1:3001/voice/conferences` with a short-lived service token
  (expect 200 with a conferences array, or the honest skip body).
- portal: **nothing to deploy — nothing built.**
- ⚠ A parallel session is building a separate **video meetings** feature
  (LiveKit, `apps/api/src/meetings/`, a `video_meetings` Prisma migration,
  portal `/meetings` + `/meet`) in the same worktree, uncommitted at the time
  of writing. Audio conference rooms (this) and video meetings (theirs) are
  different features; don't merge them by "simplification".
