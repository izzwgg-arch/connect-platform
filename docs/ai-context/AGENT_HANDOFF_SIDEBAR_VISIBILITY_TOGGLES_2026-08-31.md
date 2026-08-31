# AGENT HANDOFF — per-page sidebar visibility toggles on the Permissions screen (2026-08-31)

Izzy, 2026-08-31, verbatim intent: *"all the new options in the sidebar … I have
permissions toggles in the custom roles for it, but not for the sidebar. Even if
I do flip the custom role, I still don't see it in the sidebar. There should be
separate toggles … Add the store section … every single page, I should have a
toggle on and off for view in the sidebar, aside from the custom role
permission."*

Commit: one portal+api+shared commit on `feat/ivr-migration-takeover` (see git
log for the sha; deploy state recorded in CLAUDE.md's section for this work).
No migration — the setting rides the existing `PlatformRolePermissionSnapshot`
row's JSON. No PBX interaction, no tenant row, no env change.

## §1 — What was actually wrong (two separate gaps)

1. **The Permissions screen rendered the WRONG catalog.** It drew
   `SIDEBAR_ITEMS` from `@connect/shared`, which had drifted far behind the
   real sidebar (`apps/portal/navigation/navConfig.ts`): the whole **Store
   section** (Orders / Deliveries / Drivers / Specials / Teach the Agent),
   Conference, Direct, Meetings, Desk Phones, Install, Queues' PBX entry and a
   dozen admin pages (Support Desk, Compliance, PBX Console, Integrations,
   Voice Agent, Trunks & Routing, Ring Groups & Queues, AI Trainer, ElevenLabs,
   Polly) had **no row on the screen at all** — nothing to toggle.
2. **Even with the custom-role permission granted, several pages could not be
   revealed**, because `workspace.meetings` and `workspace.direct` carry a
   hard `backendJwtRole !== "SUPER_ADMIN"` force line in
   `isNavItemVisibleForUser` — the permission toggle was real and the force
   line silently overrode it. That is the "I flip the custom role and still
   don't see it" half of the complaint.

And the inverse gap: several sidebar entries deliberately SHARE one permission
key (Direct rides Chat's key, Meetings rides Overview's, Install rides
Contacts', all five Store pages ride `can_view_supermarket_orders`), so the
permission could never be a per-page hide switch — hiding one would hide its
siblings.

## §2 — The design: a separate, subtract-only visibility layer

New shared module **`packages/shared/src/portalNavVisibility.ts`**:

- `PortalNavVisibility = { hidden: string[], ownerOnlyLifted: string[] }` —
  nav-item IDs, not permission keys, which is what makes per-page control of
  shared-key siblings possible.
- ⛔ **SUBTRACT-ONLY.** `isNavItemVisibleForUser` checks `hidden` FIRST and
  then still requires the section permission + item permission + every
  SUPER_ADMIN force line. No stored value can reveal a page the permissions
  refuse — guard-tested with a lift-everything/hide-nothing record.
- ⛔ **FAILS OPEN.** Unreadable/absent setting = nothing hidden. A DB hiccup
  must never empty every customer's sidebar
  (`getPortalNavVisibility` catches and answers empty; guard-tested with a
  throwing db).
- ⛔ **`admin.permissions` can NEVER be hidden** (`NAV_ITEMS_ALWAYS_VISIBLE`).
  PageShell denies the ROUTE for a hidden item (`routeAllowed` uses the same
  function), so hiding the Permissions page would lock the owner out of the
  only screen that can undo it. The normalizer strips it on read AND write, so
  even a hand-edited row cannot cause the lockout.

### The owner-only split — liftable vs fixed

The force lines in navConfig are now classified, exported from navConfig:

- **`OWNER_ONLY_LIFTABLE_NAV_ITEMS`** = `workspace.meetings`,
  `workspace.direct` — finished customer-facing features held back for a first
  look. The Permissions screen shows an **"Owner only"** toggle; switching it
  off writes the id into `ownerOnlyLifted` and the force line stands down, so
  a permission grant then actually reveals the page. ⛔ **Lifting one IS that
  page's launch** — deliberate, labelled, never a side effect.
- **`OWNER_ONLY_FIXED_NAV_ITEMS`** = the platform-internal family
  (pbx.ivr_migration, apps.signalwire, admin.pbx_console, admin.integrations,
  admin.voice_agent, admin.pbx_routing, admin.pbx_teams, admin.support,
  admin.compliance, admin.billing). These show a **"Locked"** chip and ignore
  `ownerOnlyLifted` entirely — they show or change every customer's data and
  no stored value may open them (guard-tested).
- ⛔ A source-reading test asserts **every** `backendJwtRole !== "SUPER_ADMIN"`
  force line in navConfig is in one of the two lists — a new force line added
  without classification is a red test, not a switchless hidden page.

## §3 — Storage: the snapshot row, and the preserve-on-omit rule

The record rides the existing `PlatformRolePermissionSnapshot(id="default")`
JSON as a `navVisibility` key beside `roles`/`knownKeys`. Same row on purpose:
same platform-wide navigation configuration, same hot path, same cache
(`withCachedRoleSnapshot`), zero migration.

- `GET /admin/role-permissions` returns `navVisibility`.
- `POST /admin/role-permissions` accepts an OPTIONAL `navVisibility`.
  ⛔⛔ **An omitted field PRESERVES the stored value, never clears it** — an
  older portal build (or any caller that only means to change permissions)
  must not silently un-hide every page the owner switched off. Guard-tested.
- `GET /me` now returns `navVisibility` for every signed-in user — it rides
  the cached snapshot read (`getPortalNavVisibility`), zero extra queries on
  the hot path.

## §4 — Portal wiring

- `useAppContext` exposes `navVisibility` (hydrated from `/me`, sessionStorage
  cache `cc-portal-nav-visibility-v1` in `portalPermissionHydration.ts` so the
  first paint doesn't flash hidden pages, cleared on sign-out). An older api
  that omits the field leaves the previous value alone — a miss must mean
  "nothing hidden", never an empty sidebar.
- `PageShell` and `AppSidebar` pass it as `isNavItemVisibleForUser`'s new
  optional 4th argument. Omitting the argument = exact previous behaviour
  (pinned by test), so every existing caller/test was untouched.
- The save on the Permissions screen already dispatches
  `cc-portal-permissions-saved`, whose handler in useAppContext refetches
  `/me` — so the saving window's own sidebar updates immediately.

## §5 — The rebuilt Permissions screen

`apps/portal/app/(platform)/admin/permissions/page.tsx`:

- ⛔ **The sidebar itself is the catalog now** — the screen renders `navItems`
  from navConfig, NOT the drifted shared `SIDEBAR_ITEMS`. A page can never
  again exist in the sidebar and be missing from this screen. Sections not in
  `NAV_SECTION_ORDER` (Tracking) are appended and labelled "access only".
- Per row: **In sidebar** toggle (accent-coloured, applies to everybody) ·
  **Owner only** toggle / Locked chip / dash · the three role columns
  (unchanged behaviour). Section headers get a master In-sidebar toggle that
  sweeps the group.
- Rows whose permission key is shared print "Shares its access with …" so the
  moving-together role toggles read as deliberate, and point at the In-sidebar
  switch as the per-page lever.
- ⛔ A test pins that every navItems permission key passes
  `isPortalPermissionKey` — the POST normalizer silently DROPS unknown keys,
  so a nav item keyed on an unknown string would render a toggle that saves
  nothing.

## §6 — Tests (and two registration finds)

- `apps/portal/navigation/navVisibility.test.ts` — 10 tests. Replayed against
  HEAD's navConfig: **4 fail there** (hide-for-everyone, liftable-lifts,
  fixed-ignores-lift, force-lines-classified), proving non-vacuity.
- `apps/api/src/platformRolePermissions.forwardMerge.test.ts` + 4: normalized
  store, ⛔ preserve-on-omit, GET round-trip + old-row default, fail-open.
- ⛔ **`navAuthoritativeWiring.test.ts` had NEVER RUN** — it was not in the
  portal package.json test list (the documented unregistered-test trap). It
  passes and is registered now, alongside the new file.
- `lib/loopcomDirect.test.ts`'s source guard was updated: the Direct force
  line is now multi-line (it consults `isNavItemOwnerOnlyLifted`), so the
  guard regex allows up to 220 chars between the id match and the SUPER_ADMIN
  check. The guarded property (a gate exists; removing it is the launch) is
  unchanged — lifting via the Permissions screen is now the sanctioned launch
  path and the guard message says so.

Suites: portal 433/435 (the two documented pre-existing failures), shared
555/555, api forwardMerge 15/15; typechecks portal 0, shared 0, api 76 = the
exact baseline with none in an edited file.

## §7 — Shared-tree note

The index held a STALE CLAUDE.md (pre-`4dc33be5`, staging deletions of
sections HEAD already has) — the stale-index bucket. Committed by pathspec
(`git commit -F - -- <paths>`), which takes worktree content and is immune to
it. The CLAUDE.md worktree carried another session's finished +4/−2 wording
correction (SignalWire group-MMS verified-no), knowingly carried along.

## §8 — NOT PROVEN / acceptance

⏳ Nobody has flipped a toggle in a browser. Acceptance (2 min, Izzy's login):
open Admin → Permissions — every Store page, Conference, Meetings, Direct,
Desk Phones and the admin pages each have their own row; switch a Store page
off, Save, refresh — it leaves the sidebar (including for SUPER_ADMIN); switch
it back on. Then the negatives that matter most: the **admin.permissions row's
In-sidebar toggle is disabled**; hiding a page does NOT hide its shared-key
siblings; and a page revealed by "Owner only → off" still refuses anyone whose
role permission is off. ⛔ An already-open portal tab or desktop window keeps
the OLD bundle until reloaded.
