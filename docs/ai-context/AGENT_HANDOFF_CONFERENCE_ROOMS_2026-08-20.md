# AGENT HANDOFF — Conference rooms: BUILT AND DEPLOYED end to end (backend + Option-A page in Workspace); no room has ever been created on the PBX (2026-08-20)

**Commits `c80a585b` (backend) + `a863ca3b` (page) on `feat/ivr-migration-takeover`.**
Izzy, 2026-08-20: *"I would like to create a call conferencing feature. There
should be a new page called Conference … a full-on voip conference module"* —
then *"If you are doing any UIs, I want to see [mockups] first"* — then picked
**mockup A (room cards)** and placed the nav item: *"add the Conference option
in workspace right before install. And the sidebar."*
Mockups (kept for reference):
<https://claude.ai/code/artifact/203ce03b-3147-4036-9cd5-4ef919edb4d3>.

**Deploy state, verified in the containers 2026-08-20:** portal
`.build-commit 7f985399` — the page chunk
(`app/(platform)/conference/page-4ca9a915….js`, verified by the STRING
"dial to join", never a function name) and the `.cf-` styles are in the shipped
`.next`; api `.build-commit d3e4f911` (⊇ `a863ca3b` by merge-base), the
re-homed permission catalog greps in the container, health 200 on both
hostnames. Live read-only probe: `GET /voice/conferences` as a service token →
**200 `source:"ombutel_mysql"`**, unauthenticated → **401**. ⛔ An already-open
portal tab/desktop window keeps the OLD bundle until reloaded.

## 1. The one-paragraph architecture

VitalPBX already ships everything conferencing needs: the **Conferences module
(module_id 8, multi-tenant)** stores rooms in `ombutel.ombu_conferences`, and
the Asterisk baseplan carries full **ConfBridge** support — per-tenant
`confbridge__50-<t>-profiles.conf` / `confbridge__40-<t>-menu.conf` files
already render for every tenant, recording is wired
(`extensions__20-baseplan.conf:526`), and the stock user/admin DTMF menus
(`confbridge__20-menu.conf`) give mute (1), lock (admin 2), kick-last (admin 3)
and leave (8) on the phone keypad for free. **Zero conference rooms existed
platform-wide on 2026-08-20** — a genuinely new surface: no rendered dialplan
example, no captured panel contract. Connect reads rooms from MySQL via
`connect_read` and writes them by **panel replay**, the same road as
queues/ring groups.

## 2. What exists, file by file

Backend:

- **`apps/api/src/pbxConferenceDirectory.ts`** — the read side.
  `listConferencesFromOmbutel(vitalTenantId, ombuMysqlUrlEncrypted)` on the
  `pbxQueueDirectory` model (same imported `connectOmbutelMysql`, every column
  probed via INFORMATION_SCHEMA, never throws — soft `skipReason`). Table keyed
  **`conference_id`**, name is **`description`**; all 25 columns were read from
  the live PBX before this was written.
- **`apps/api/src/pbx/conferenceBuilder.ts`** — the write side.
  ⛔ **Unlike teamBuilder it hardcodes NO field list**: it loads the panel's own
  rendered add/edit form (`loadParsedForm(s, "conferences", …)`) and re-posts
  it with `applyOverrides` — the pbxConsole discipline, so THE CHECKBOX RULE
  holds by construction. `buildConferenceOverrides()` routes each yes/no option
  through whatever control the form renders (checkbox → pair added/REMOVED;
  select → literal value). Fields the form doesn't offer land in
  `skippedFields` (logged), never in a blind post; essential-field mismatch
  throws `conference_form_mismatch` naming the fields the form DID offer.
  Delete reuses pbxConsole's two-step `panelDelete`. ⛔ The builder never fires
  Apply Changes (guard test).
- **`apps/api/src/pbx/conferenceRoutes.ts`** — `/voice/conferences`
  GET/POST/PATCH/DELETE, wired in `server.ts` beside `registerTeamRoutes`.
  teamRoutes discipline: panel row ids resolved server-side from the room
  number; number allocation from the live picture (flow-map used numbers
  **plus** existing conference rows — their table is invisible to
  `UsedNumbers`); every write **verified by re-reading ombu_conferences** ("the
  table, not the notification" — 3 re-reads, guard test); ⛔ refuses on an
  unresolved tenant path (stricter than teamRoutes on purpose — a room filed
  under another company is worse than a retry). GET shares
  `resolveQueueTenantContext` incl. the super-admin `vpbx:` override. **Host
  PIN masked (`•••`) for callers without manage rights.**
- **`packages/shared/src/teamNumbering.ts`** — rooms get the **700-series**
  (`nextConferenceNumber`): 700–709 then 7000–7099, widening like the team
  series (ring groups 8xx, queues 9xx); cross-series rule holds; the
  existing-conference list is a separate mandatory input.
- **`packages/shared/src/portalPermissions.ts`** — `can_view_conferences` +
  `can_manage_conferences` action keys; SIDEBAR_ITEMS **`workspace.conference`**
  (`/conference`, key **`can_view_workspace_conference`**); the nav key rides
  `can_view_conferences` via LEGACY_PERMISSION_EXPANSIONS so nav and page can
  never disagree; TENANT_ADMIN holds both by default, END_USER neither,
  SUPER_ADMIN automatic. ⛔ The key was born `can_view_pbx_conference` (PBX
  section) and renamed the same day when Izzy placed the item in Workspace —
  safe ONLY because nothing had granted the hours-old key; renaming a granted
  key silently strips it from every custom role.

Portal (Option A — room cards):

- **`apps/portal/app/(platform)/conference/page.tsx`** — gates itself with
  PermissionGate on `can_view_conferences`; manage buttons follow the SERVER's
  `mayManage` answer once loaded (the identical gate the routes run), local
  `can()` until then; room cards show dial number, PINs with reveal (host PIN
  arrives masked for non-managers), plain-language option chips, and an
  **approximate** "N on the call" derived from the existing `useTelephony()`
  live-calls feed (calls whose destination is the room number) — ⛔ never a
  second live REST source, and it is an occupancy hint, not a roster. **Join
  dispatches `crm:dial`** — the FloatingDialer bus, same as CRM click-to-call.
  Delete is a two-step confirm on the card, verified server-side.
- **`apps/portal/app/(platform)/conference/ConferenceDialog.tsx`** —
  create/edit; plain-language toggles; number blank = auto-allocated; PIN
  clearing = empty string → null; ⛔ **`applyNow` is rendered for SUPER_ADMIN
  only and defaults OFF** (the route ignores it from anyone else).
- **`apps/portal/navigation/navConfig.ts`** — `workspace.conference`,
  **immediately before `workspace.install`** (after the parallel session's
  `workspace.meetings`); a guard test pins the position.
- **`apps/portal/app/globals.css`** — `.cf-*` block, ⛔ deliberately built ON
  the queue primitives (`.qb-page/.qb-card/.qb-btn/.qb-modal` + `--qb-ink-*`
  tokens): Izzy approved A as "the Queues look applied to rooms", so the two
  screens are one visual system. Every colour aliases theme tokens; no
  `prefers-color-scheme` (the billing lesson); page stays OFF the
  `.console-content:has()` list.

## 3. ⛔ Apply Changes — the deliberate split

A saved room is rows in the panel DB; it answers callers only after Apply
renders it. The routes accept **`applyNow` from a SUPER_ADMIN only** (anyone
else's flag is silently ignored) and then go through **pbxConsole's
`applyAndRebake`** — Apply is whole-PBX and wipes the Connect doorway bake, so
the platform-wide re-bake sweep is not optional (a guard pins that no bare
`applyChanges` exists in the routes). Everyone else gets the honest *"goes live
the next time changes are applied"* message, like teams. ⛔ Do not widen
`applyNow` past SUPER_ADMIN without Izzy's word.

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
- ⚠ The `music_group_id` option list includes OTHER tenants' MOH groups when
  loaded outside the tenant's context ("Secro" showed from the robot's home).
  The builder never touches that field; if a per-room hold-music picker is ever
  added, load the form in the TENANT's context and scope the options
  (the `findOptionInSelect` cross-tenant lesson).

## 5. Tests (33 new across three packages, all green) and the dead glob

- `apps/api/src/pbx/conferenceBuilder.test.ts` — 12: real parse+override chain
  against a synthetic mixed checkbox/select form; source guards (no Apply in
  the builder; applyNow super-only via applyAndRebake; 3 verify re-reads;
  tenant-path refusal; server.ts wiring on the right keys).
- `packages/shared/src/portalPermissions.conference.test.ts` — 7 (workspace
  placement, no visible door that doesn't open, bucket defaults, revocability).
- `packages/shared/src/teamNumbering.conference.test.ts` — 7 (series shape,
  cross-series collisions, the mandatory existing-conference input).
- `apps/portal/components/conferencePage.test.ts` — 7 (self-gating, buttons
  match the route, crm:dial join, no second creation path, applyNow
  super-only, **nav position: Conference immediately before Install**, `.cf-*`
  present with comments stripped before the `prefers-color-scheme` negative —
  the quoted-in-comment guard trap was hit AGAIN writing it, by this feature's
  own CSS header). Registered in the portal test script.
- ⛔ **`apps/api` now runs `"src/pbx/*.test.ts"`** — the glob was MISSING, so
  `teamBuilder.queue.test.ts` + `applyRegenRebake.test.ts` had NEVER run under
  `npm test`. Both pass; verified BEFORE registering.
- Suites at ship time: shared **374/374**; portal **217/219** (the two
  documented pre-existing failures); api **2623/2659** with every failure
  pre-existing or a parallel session's in-flight work; api typecheck **75 = the
  exact baseline**; portal + shared typecheck 0.

## 6. ⛔ Found in passing: the TENANT_ADMIN permission-snapshot gap (chip filed)

The live `PlatformRolePermissionSnapshot` (id "default") is **version 2 and
read literally** for bucket roles; `normalizeStoredRoleList` back-merges only
missing `can_view_admin_*` keys. Verified live: TENANT_ADMIN's stored 92 keys
**do not include `can_view_queues`** (2026-08-16) — so real tenant admins have
likely never seen the Queues feature either — and the conference keys inherit
the same gap. SUPER_ADMIN is unaffected (force-add of every catalog key at
read time). ⛔ Deliberately NOT fixed here — it is a live-permissions data
change; a task chip ("Fix stale TENANT_ADMIN permission snapshot") was filed
for a forward-merge design + Izzy's sign-off.

## 7. ⏳ NOT DONE / NOT PROVEN — the honest list

- ⛔ **No conference room has EVER been created on this PBX** — by this code or
  anyone. The acceptance run needs Izzy live (the first `applyNow` create fires
  a real whole-PBX Apply; 2026-08-20 standing rule after the geo lockout):
  on **Loopcom Demo (T102)**, create a room from the page with "Turn it on
  now" → row in `ombu_conferences` + `live: true` → dial the room number from
  ext 101 → hear ConfBridge → second phone joins → two-way audio →
  `confbridge list` shows both → delete the room → verify gone, doorways
  0 cc-wipes (`[PBX_CONSOLE] apply + doorway re-bake complete` in the api log).
- **Nobody has opened `/conference` in a browser** — proven by bundle greps,
  container commits, tests and the live GET probe, not by a human clicking.
- **Live participant roster / mute / kick from the page** — needs telephony
  ConfBridge AMI (`ConfbridgeList/Mute/Kick` behind a
  `/telephony/internal/conference/*` group; telephony deploys are pending-gated
  on a 0-active-calls window). Until then the card's count is the approximate
  live-calls read; in-call DTMF menus already cover mute/lock/kick.
- **Outside callers can't reach a room directly** — needs a DID inbound route
  or IVR key pointed at the conference (destination module_id 8). Natural
  follow-up in DID routing / IVR Studio.
- Whether an incremental Apply renders a tenant's FIRST conference (expected —
  the per-tenant confbridge files already exist) is unproven until the
  acceptance run listens to a real call.
- ⚠ A parallel session shipped **video meetings** (LiveKit,
  `apps/api/src/meetings/`, portal `/meetings` + `/meet`) the same day. Audio
  conference rooms (this) and video meetings are DIFFERENT features — do not
  merge them by "simplification".
