# ⛔⛔ AGENT HANDOFF — every sidebar page has its OWN permission key now, and the "Owner only" lift is GONE (2026-09-02) — READ FIRST before adding a nav item, before reusing a permission key on a second page, before adding a `backendJwtRole` force line, or for "I granted the permission and they don't see it"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_ONE_KEY_PER_PAGE_2026-09-02.md`**
(`37f7e0f3` on `feat/ivr-migration-takeover`. ✅ **api + portal DEPLOYED and
container-verified** — both at `24a41e26` ⊇ `37f7e0f3`, 0 restarts, 200 on both
hostnames. Two additive, backed-up data changes: 8 custom roles gained the new
per-page keys for pages they already showed, and Ezra got an additive role with
Direct + Meetings.) Memory: [[every-sidebar-page-has-its-own-key]].
Izzy: *"I gave Ezra permission, and he doesn't see it in the sidebar … some
toggles are connected together … Every toggle should be individual … bring the
proof that each and every one is working 100% and they're all separated."*

- ⛔⛔ **THE RULE: a nav item has a permission key NO OTHER nav item uses.**
  Sixteen rows shared a sibling's key (Direct rode Chat's, Meetings Overview's,
  Install Contacts', five Store pages one key, four assistant pages one key,
  seven platform pages `can_manage_global_settings`) — so one toggle moved its
  siblings on BOTH editors. 22 new keys live in shared `SIDEBAR_ITEMS`; navConfig
  is 96 items / 96 keys and `permissionToggleCoverage.test.ts` fails on any
  reuse. ⛔ A new page needs its key IN THE SHARED CATALOG — the POST normalizer
  silently drops unknown keys, so a toggle on an unlisted key saves nothing
  (guard-tested).
- ⛔⛔ **THE KEY IS THE LAUNCH GATE — NEVER A jwt FORCE LINE ON A CUSTOMER PAGE.**
  Direct and Meetings hid behind `backendJwtRole !== "SUPER_ADMIN"` that only the
  "Owner only" switch on a second screen could lift; that is exactly why the key
  Izzy granted showed nothing. `OWNER_ONLY_LIFTABLE_NAV_ITEMS` is `[]` on purpose
  (do not repopulate), the two force lines are gone, and both keys are in NO
  default bucket — granting one in a role IS the launch, one person at a time.
  The Meetings page gates on the key, and `requireMeetingCreator` accepts
  SUPER_ADMIN or a holder of it (`deps.mayStartMeeting`, default fails CLOSED).
  A page that must stay platform-internal goes in `OWNER_ONLY_FIXED_NAV_ITEMS`
  (Locked on both editors); `admin.remote_support_controls` joined it because its
  api is `requireSuperAdmin` — the four EZra-role holders lost a link that
  always refused, the only visible change for any existing holder.
- ⛔ **Store pages: page key ≠ data capability, and both are needed.** Each of the
  five has its own nav/page key; the `/supermarket` api prefix still demands
  `can_view_supermarket_orders`. The custom-role editor notes it on every Store
  row. Existing holders were migrated to hold all six.
- ⛔ **An action key drawn as a sidebar row is drawn ONCE** — the Action
  Permissions panel skips `NAV_BOUND_ACTION_KEYS` (Desk Phones, Remote Support).
  Two toggles bound to one key flip together; that is the coupling he ruled out.
- ✅ **PROVEN LIVE, all 96 pages**: a DISABLED probe user + throwaway role on
  Loopcom Demo, one `[section, item]` grant per page through the DEPLOYED
  resolver, rendered with the real navConfig — **96 OK, 0 leaks, 0 dead** (Locked
  pages show nothing to a non-super jwt and leak nothing). All 18 custom-role
  holders' sidebars diffed before/after: **identical**, except Ezra (+Direct
  +Meetings) and the dead Remote Support Controls link. Routes driven: Ezra
  `GET /meetings` **200** (was 403 for every non-super), key-less user **403**;
  one real In-sidebar hide/unhide round trip with bucket sets byte-identical.
  ⛔ That round trip was the FIRST permissions save since 2026-07-06 — the
  snapshot row now carries `knownKeys` and `updatedAt 2026-09-02`; the old
  "no toggle has ever been saved" line below is history.
- ⛔⛔ **THE EZra ROLE IS HELD BY FOUR PEOPLE IN THREE TENANTS** (Ezra, two Ribit
  Capital users, Izzy's Landau Home login). Ezra got Direct + Meetings through an
  ADDITIVE second role (`Direct + Meetings — Ezra`) assigned to him alone —
  editing EZra would have launched both for Ribit Capital. Run
  `GET /admin/custom-roles/:id/users` before editing ANY custom role.
- ⛔ **Deploy trap, hit again: the server clone cannot fetch GitHub (HTTPS 401).**
  Bundle → bare mirror → `set-url origin <mirror>` → deploy → **restore origin
  and delete the mirror** (done). Check the mirror branch's tip contains your
  commit before trusting the deploy — it can already hold another session's
  commits that GitHub does not.
- ⏳ **NOT PROVEN: nobody has opened either editor in a browser since**, and Ezra
  has not signed in. Acceptance: Ezra reloads (desktop: full close + reopen) →
  Direct and Meetings in Workspace, `/meetings` renders. ⚠️ Another session is
  adding `workspace.remote_desktop` on `can_use_remote_desktop` — covered by the
  uniqueness + dedupe guards once that key is in `ACTION_PERMISSION_KEYS`.
