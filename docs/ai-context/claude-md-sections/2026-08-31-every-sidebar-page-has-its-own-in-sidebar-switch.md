# ⛔ AGENT HANDOFF — every sidebar page has its own “In sidebar” switch on /admin/permissions now, SEPARATE from the role permission (2026-08-31) — READ FIRST before adding a nav item, before adding a SUPER_ADMIN force line to isNavItemVisibleForUser, or for “I granted the permission and it still doesn’t show in the sidebar”

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_SIDEBAR_VISIBILITY_TOGGLES_2026-08-31.md`**
(one commit on `feat/ivr-migration-takeover` — shared + api + portal. **No migration**
— the setting rides the existing `PlatformRolePermissionSnapshot` row’s JSON as a
`navVisibility` key. Deploy state at the end of this section.) Izzy, 2026-08-31:
*“every single page, I should have a toggle on and off for view in the sidebar,
aside from the custom role permission.”*

- ⛔⛔ **TWO GAPS, and the first is the trap to remember: the Permissions screen
  rendered the shared `SIDEBAR_ITEMS` catalog, which had drifted FAR behind the
  real sidebar** — the whole Store section, Conference, Direct, Meetings, Desk
  Phones, Queues and a dozen admin pages had NO row on the screen at all. **The
  screen renders `navItems` from navConfig now** (the sidebar itself is the
  catalog), so a page can never again exist in the sidebar and be missing from
  the editor. The second gap: `workspace.meetings`/`workspace.direct` carry a
  hard SUPER_ADMIN force line, so a granted permission was silently overridden
  — the literal complaint.
- ⛔⛔ **THE VISIBILITY LAYER IS SUBTRACT-ONLY AND FAILS OPEN**
  (`packages/shared/src/portalNavVisibility.ts`): `hidden` ids are checked FIRST
  in `isNavItemVisibleForUser` (new optional 4th arg — omitted = exact old
  behaviour, test-pinned), but every permission check and every force line still
  runs after it, so **no stored value can reveal a page the permissions refuse**;
  and any read failure answers “nothing hidden” — a DB hiccup must never empty
  every customer’s sidebar. It keys on NAV IDS, not permission keys, which is
  what makes per-page hiding of shared-key siblings possible (Direct rides
  Chat’s key, the five Store pages share one key…).
- ⛔ **`admin.permissions` can NEVER be hidden** (`NAV_ITEMS_ALWAYS_VISIBLE`) —
  PageShell denies the ROUTE for a hidden item, so hiding that page would lock
  the owner out of the only screen that can undo it; the normalizer strips it on
  read AND write, so a hand-edited row cannot cause the lockout.
- ⛔⛔ **THE OWNER-ONLY FORCE LINES ARE CLASSIFIED NOW, and a source guard makes
  an unclassified one a red test**: `OWNER_ONLY_LIFTABLE_NAV_ITEMS` (Meetings,
  Direct — an “Owner only” toggle on the screen lifts the force line, and
  ⛔ **lifting one IS that page’s launch**, deliberate and labelled) vs
  `OWNER_ONLY_FIXED_NAV_ITEMS` (the console family, Support Desk, Compliance,
  Migration, SignalWire, Admin Billing — a “Locked” chip, and they IGNORE the
  lift entirely: platform-internal screens no stored value may open).
- ⛔ **POST /admin/role-permissions: an OMITTED `navVisibility` PRESERVES the
  stored value, never clears it** — an older portal build saving permissions
  must not silently un-hide every page the owner switched off. Guard-tested.
  GET returns it; **GET /me carries it to every user** off the cached snapshot
  read (zero extra queries); the portal caches it in sessionStorage so the
  first paint doesn’t flash hidden pages.
- ⛔ **`navAuthoritativeWiring.test.ts` HAD NEVER RUN** — absent from the portal
  package.json test list (the documented unregistered-test trap). Registered
  now, beside the new `navigation/navVisibility.test.ts` (10 tests, **4 fail
  replayed against HEAD’s navConfig**) and 4 new api snapshot tests. Suites:
  portal 433/435 (the two documented pre-existing), shared 555/555; typechecks
  portal 0, shared 0, api **76 = the exact baseline**.
- ✅ **DEPLOYED AND CONTAINER-VERIFIED 2026-08-31** — api + portal BOTH at
  `4f03b006` (contains `06e699ba`), 0 restarts, /admin/permissions 200 on both
  hostnames. Proven INSIDE the containers, never off a deploy log: the api
  carries `portalNavVisibility.ts` + 10 `navVisibility` refs; the portal's
  SHIPPED CLIENT chunk carries “In sidebar” + `ownerOnlyLifted`; and the page's
  chunk graph pulls navConfig (`6051`/`4427`, the chunks holding
  `workspace.conference`) — ⛔ **that last check is the one that matters: it is
  the proof the screen renders the REAL sidebar catalog and not the stale
  `SIDEBAR_ITEMS` list.** Grepping the page chunk alone for a nav id reads 0 and
  looks like a failed deploy; navConfig lives in a SHARED chunk, so verify via
  `.next/app-build-manifest.json` → the page's chunk list.
- ⛔⛔ **NO TOGGLE HAS EVER BEEN SAVED: `PlatformRolePermissionSnapshot` still
  reads `updatedAt = 2026-07-06` and has NO `navVisibility` key at all** — so no
  permissions save of ANY kind has reached the server since July. That is the
  correct inert state (subtract-only + fails open ⇒ nothing hidden), but it also
  means a toggle someone flipped and saved **did not land**. ⛔ Read that row's
  `updatedAt` before believing any save; it is the cheapest check there is:
  `select id, "updatedAt", (roles ? 'navVisibility') from "PlatformRolePermissionSnapshot";`
  ⛔ The table has columns `id` / `roles` / `updatedAt` ONLY — there is no
  `version` and no `permissions` column; querying those errors out and reads like
  the feature is missing.
- ⛔ **“I changed it and I don't see the fixes” was asked 14 minutes after the
  portal container rebuilt (2026-08-31 14:20Z, asked 14:34Z).** The deploy was
  fine; the likeliest answer is a STALE BUNDLE in an already-open tab/window.
  ⏳ Not confirmed by the reporter at the time of writing. **Judge this class by
  the container's `StartedAt` vs when the tab was opened, before touching code.**
  ⛔ The desktop app needs a full close + reopen, not a reload. ⛔ And check WHICH
  SCREEN: the In-sidebar switches are on `/admin/permissions` (built-in roles),
  **not** `/admin/roles/[id]` (custom roles), which never got them.
- ⏳ **NOT PROVEN: nobody has flipped a toggle in a browser.** Acceptance:
  /admin/permissions shows a row for EVERY sidebar page incl. all five Store
  pages; hide one Store page → Save → it leaves the sidebar for everybody and
  its siblings stay; the admin.permissions row’s In-sidebar toggle is disabled;
  “Owner only → off” on Meetings reveals it ONLY to roles whose permission is
  on. ⛔ An open tab/desktop window keeps the OLD bundle until reloaded.
