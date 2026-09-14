# ⛔⛔ AGENT HANDOFF — CONFERENCE ROOMS are LIVE end to end: backend + the Option-A page in Workspace, DEPLOYED and container-verified — but NO room has ever been created on the PBX (2026-08-20) — READ FIRST before touching /voice/conferences or /conference, or before creating the platform's FIRST conference room

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_CONFERENCE_ROOMS_2026-08-20.md`**
(`c80a585b` backend + `a863ca3b` page on `feat/ivr-migration-takeover`.
**api DEPLOYED `d3e4f911` + portal DEPLOYED `7f985399`, both container-verified**
— page chunk + `.cf-` styles grep in the shipped `.next` (by STRING, never a
function name), the re-homed permission catalog greps in `app-api-1`, live probe
`GET /voice/conferences` → 200 `ombutel_mysql` / no token → 401. No migration,
no PBX write, no tenant row touched — the panel form was captured READ-ONLY.)
Izzy, 2026-08-20: *"a full-on voip conference module"*; picked **mockup A (room
cards)**; placement: *"add the Conference option in workspace right before
install. And the sidebar."*

- ✅ **VitalPBX already carries conferencing** — Conferences module (module_id 8),
  `ombu_conferences`, per-tenant ConfBridge confs already rendered, recording +
  in-call DTMF menus (mute/lock/kick) in the baseplan. **Zero rooms existed
  platform-wide** — no rendered example, no captured panel contract.
- ⛔⛔ **THE BUILDER HARDCODES NO FIELD LIST.** `pbx/conferenceBuilder.ts` loads
  the panel's own rendered form and re-posts it with overrides (the pbxConsole
  discipline), so THE CHECKBOX RULE holds automatically — the live capture
  proved **all 8 yes/no options are CHECKBOXES, tick value "1"**. An option the
  form doesn't offer lands in `skippedFields`, never a blind post.
- **`/voice/conferences` GET/POST/PATCH/DELETE** (`pbx/conferenceRoutes.ts`):
  own keys `can_view_conferences` / `can_manage_conferences`; row ids resolved
  server-side; every write **verified by re-reading ombu_conferences**; host PIN
  masked for non-managers; refuses on unresolved tenant path. **700-series**
  numbering (`nextConferenceNumber` — existing rooms are a separate mandatory
  input, invisible to `UsedNumbers`).
- ⛔ **Apply: only a SUPER_ADMIN's explicit `applyNow`, only via
  `applyAndRebake`.** Everyone else gets the honest "goes live at the next
  apply" message, like teams.
- ✅ **The page (`/conference`, Option A room cards)**: self-gates on the view
  key; manage buttons follow the SERVER's `mayManage`; Join = the `crm:dial`
  bus; "N on the call" is an APPROXIMATION off the existing live-calls feed
  (never a second live source); `.cf-*` styles deliberately extend the queue
  primitives. **Sidebar: `workspace.conference`, immediately before Install**
  (a guard test pins the position). ⛔ The nav key was renamed
  `can_view_pbx_conference` → `can_view_workspace_conference` the same day —
  safe only because nothing had granted the hours-old key.
- ⛔⛔ **FOUND IN PASSING (chip filed): the live `PlatformRolePermissionSnapshot`
  (v2, read literally) never received `can_view_queues` either** — new action
  keys do NOT reach TENANT_ADMIN without a snapshot refresh, so real tenant
  admins have likely never seen Queues, and Conference inherits the gap.
  SUPER_ADMIN is unaffected (force-add). Do not "fix" by editing the live row
  without a forward-merge design + Izzy.
- ⛔ **`apps/api` now runs `"src/pbx/*.test.ts"`** — the glob was missing, so
  `teamBuilder.queue.test.ts` + `applyRegenRebake.test.ts` had NEVER run (both
  pass). 33 new tests across api/shared/portal; suites at their baselines.
- ⏳ **NOT PROVEN: no conference room has EVER been created on this PBX, and
  nobody has opened `/conference` in a browser.** Acceptance needs Izzy live
  (the first `applyNow` create fires a real whole-PBX Apply): create on Loopcom
  Demo → dial in from two phones → two-way audio → delete → byte-back. ⏳ Live
  mute/kick from the page = phase 2 (telephony ConfBridge AMI); routing a DID
  or IVR key INTO a room is not wired. ⚠ The same-day **video meetings**
  feature (LiveKit, `/meetings`) is a DIFFERENT parallel build — never merge
  the two by "simplification".
