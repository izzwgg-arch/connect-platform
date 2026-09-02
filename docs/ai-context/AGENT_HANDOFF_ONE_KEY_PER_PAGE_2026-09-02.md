# AGENT HANDOFF — every sidebar page has its OWN permission key; the "Owner only" lift is retired (2026-09-02)

Izzy, 2026-09-02, verbatim: *"permission toggles are still not working properly.
For example, one that I noticed is direct and meetings. I gave Ezra permission,
and he doesn't see it in the sidebar. Also, some toggles are connected to
toggles together, but they should also never be. Every toggle should be
individual, so go through the whole toggle page, test each and every one, and
bring the proof that each and every one is working 100% and they're all
separated."*

Commit **`37f7e0f3`** on `feat/ivr-migration-takeover` (25 files: shared + api +
portal + tests). ✅ **api + portal DEPLOYED and container-verified 2026-09-02** —
both `.build-commit` read `24a41e26` (another session's docs commit on top of
`37f7e0f3`; ancestry verified with `merge-base --is-ancestor`), 0 restarts on
either, `/admin/permissions`, `/admin/roles` and `/api/health` answer **200 on
both hostnames**. No migration (the new keys are catalog entries; the snapshot
row's JSON carries them). No PBX write, no env change. **Two production data
changes**, both additive and backed up (§6).

## §1 — What was actually wrong (both complaints, one cause)

`isNavItemVisibleForUser` renders a page when the holder has `sectionPermission`
AND `permission`. Sixteen sidebar rows carried a permission that **another row
already used**:

| page(s) | rode this key | owned by |
| --- | --- | --- |
| Direct | `can_view_workspace_chat` | Chat |
| Meetings | `can_view_workspace_overview` | Overview |
| Install | `can_view_workspace_contacts` | Contacts |
| Orders, Deliveries, Drivers, Specials, Teach the Agent | `can_view_supermarket_orders` | each other |
| IVR Migration | `can_view_pbx_ivr_routing` | IVR Studio |
| CRM Diagnostics | `can_view_crm_settings` | CRM Settings |
| SignalWire | `can_view_apps_voip_ms` | VoIP.ms |
| Support Desk, AI Trainer, ElevenLabs, Amazon Polly | `can_view_admin_assistant` | AI Assistant |
| Compliance, PBX Console, Trunks & Routing, Ring Groups & Queues, Remote Support Controls, Integrations, Voice Agent | `can_manage_global_settings` | each other |

So on BOTH editors (`/admin/permissions` role columns and `/admin/roles/[id]`)
a toggle for one of those rows flipped its siblings — the "connected toggles".
The rows even said so ("shares access with …"), which is a description of the
defect, not a fix.

And Direct + Meetings had a **second lever**: a `backendJwtRole !==
"SUPER_ADMIN"` force line that only the "Owner only" switch on
`/admin/permissions` could lift. Izzy edited the **EZra** role at 10:46 that
morning (107 keys, incl. Chat and Overview) and Ezra — a TENANT_ADMIN — still saw
neither, because the force line ran after the permission check. **A granted
key that shows nothing is the exact thing he reported.**

## §2 — The fix: one key per page, the key IS the launch gate

**22 new keys** in `packages/shared/src/portalPermissions.ts` `SIDEBAR_ITEMS`
(the shared catalog is what makes a key "real" — the POST normalizer silently
DROPS unknown keys, so a nav item on an unlisted string would be a toggle that
saves nothing):

`can_view_workspace_direct`, `can_view_workspace_meetings`,
`can_view_workspace_install`, `can_view_store_{orders,deliveries,drivers,specials,teach}`,
`can_view_pbx_ivr_migration`, `can_view_crm_diagnostics`,
`can_view_apps_signalwire`, `can_view_admin_{support,compliance,pbx_console,pbx_routing,pbx_teams,remote_support_controls,integrations,voice_agent,ai_trainer,elevenlabs,polly}`.

`apps/portal/navigation/navConfig.ts` now has **96 items, 96 distinct keys**
(guard-tested). Where the keys land by default, and why:

- **Direct, Meetings, all Store pages, every platform-internal page: NO default
  bucket.** SUPER_ADMIN holds every key via the force-add bucket, so nothing
  changed for Izzy; nobody else has them until a role grants them. **Granting
  the key is the launch.** That replaces the "Owner only" lift entirely.
- **`can_view_workspace_install` → `END_USER_ACTIONS`** (so END_USER and
  TENANT_ADMIN). Every ordinary user could download the desktop app via the
  Contacts key; the forward-merge (`forwardMergeNewDefaultKeys`) hands a NEW
  default key to the live buckets, so no customer lost the link — measured:
  END_USER 55 → 56 keys, TENANT_ADMIN 116 → 117, each gaining exactly Install.
  ⛔ Deliberately NOT added to the `can_view_contacts` legacy expansion —
  `backfillLegacyPageVisibility` would then re-derive the Contacts page key
  from an Install-only grant.
- **`can_view_crm_diagnostics` → the `can_manage_crm_admin` expansion** (CRM
  admins saw diagnostics via CRM Settings; CRM managers never did and still do
  not). `CRM_PORTAL_PERMISSION_KEYS` derives from that expansion, so it is
  stripped for users without CrmUserAccess like every CRM key. The page's own
  admin-jwt check is unchanged and the editor still notes it on the row.

**The "Owner only" lift is retired.** `OWNER_ONLY_LIFTABLE_NAV_ITEMS` is `[]`
(kept exported, documented as retired, ⛔ do not repopulate — a page that must
stay platform-internal belongs in `OWNER_ONLY_FIXED_NAV_ITEMS`). The
Meetings/Direct force lines are deleted. `/admin/permissions` draws that column
as "Platform only": a **Locked** chip or a dash, never a toggle.
`ownerOnlyLifted` stays in the stored record/normalizer (tolerated, inert).

**`admin.remote_support_controls` joins the Locked list** — its api
(`remoteSupport/controlRoutes.ts`) is `requireSuperAdmin` on every handler, so
a granted key could only ever draw a door that refuses. This is the one
**visible** change for existing custom-role holders: the four people on the
EZra role (which carries `can_manage_global_settings` + the Admin section)
used to see a "Remote Support Controls" link that 403'd on open. It is gone.

## §3 — Every gate now agrees with the sidebar

- **Meetings**: `/meetings` page → `PermissionGate can_view_workspace_meetings`
  (was `backendJwtRole !== "SUPER_ADMIN"`). `requireMeetingCreator` in
  `meetingRoutes.ts` → SUPER_ADMIN **or** the new injectable
  `deps.mayStartMeeting(user)`, whose default asks
  `hasEffectivePortalPermission(user, "can_view_workspace_meetings")` inside a
  try/catch that answers **false** (an unknown answer never opens the door —
  test-pinned). Join routes were never gated and are untouched.
- **Direct**: `/direct` prefix rule + page gate → `can_view_workspace_direct`.
- **Store**: the five page gates → their own keys. ⛔ The `/supermarket` api
  prefix rule KEEPS `can_view_supermarket_orders` as the **data capability** —
  a page key shows the page, the capability loads its data. Both are needed
  and the custom-role editor says so on every Store row (`STORE_DATA_NOTE`).
  Existing holders (EZra, Gesheft) were migrated to hold all five page keys
  beside the capability, so nothing moved for them.
- **Custom-role editor**: an action key that is ALSO a sidebar row
  (`can_setup_desk_phones` → Desk Phones, `can_remote_support` → Remote
  Support) is no longer drawn a second time in Action Permissions
  (`NAV_BOUND_ACTION_KEYS`) — one key, one toggle.
- Locked platform pages (compliance, console, integrations, voice agent,
  support desk, signalwire, ivr migration, remote-support controls) keep
  their **page gates and api rules on `can_manage_global_settings` /
  `requireSuperAdmin`**. Only their NAV key became per-page. Unobservable
  either way: they are SUPER_ADMIN-forced and Locked on both editors.

## §4 — Tests (all replayed against HEAD)

New/changed, all registered in the runners' explicit file lists:

- `apps/portal/navigation/permissionToggleCoverage.test.ts` +4: **no two nav
  items share a key**; the Action panel skips nav-bound keys (source guard);
  the lift is retired and Direct/Meetings show for a key-holding USER and
  TENANT_ADMIN; and the exhaustive separation property — for every one of the
  96 items × 3 jwt roles, granting `[section, item]` reveals exactly that item
  and nothing else (Locked items may show nothing to a non-super jwt).
- `apps/portal/navigation/navVisibility.test.ts`: the liftable test now asserts
  the list is empty and the two pages need no lift.
- `packages/shared/src/portalPermissions.individualPages.test.ts` (new, 7):
  every split page is in `SIDEBAR_ITEMS` with a real key; no two catalog
  entries share a key (the three legacy tracking aliases exempted); Direct /
  Meetings / Store / platform keys in no customer bucket; Install is an
  END_USER default; Diagnostics stays a CRM key; the Store capability is
  untouched.
- `apps/api/src/meetings/meetings.test.ts` +2: a key-holding TENANT_ADMIN may
  create + list; the real default `mayStartMeeting` fails CLOSED against a db
  that cannot answer. `meetingInvite.test.ts` harness stubs the check.
- Updated pins: `loopcomDirect.test.ts` (own key, no force line, key in no
  bucket), `directRoutes.test.ts` (prefix rule), `supermarketPortal.test.ts`
  (per-page keys + page gates), `complianceCalendar.test.ts`,
  `consoleNavGuard.test.ts` (per-page keys, none in a customer bucket, api
  rule + force line unchanged), `voiceAgentNav.test.ts`.

✅ **Non-vacuity**: the 5 new portal guards were replayed against HEAD's
`navConfig.ts` + a `git archive HEAD` of the page sources
(`PORTAL_GUARD_ROOT`) — **all 5 fail there, all pass here**.
Suites: shared **562/562**, portal **491/493** (the two documented pre-existing:
campaigns index layout, webrtc SDP codec), api meetings/direct/roles/supermarket
**128/128**. Typechecks: shared 0, portal 0, api unchanged in every touched file.

## §5 — LIVE PROOF on production (the part Izzy asked for)

**(a) One grant reveals one page — 96 of 96, on the deployed resolver.**
`scratchpad/probe-stage1.ts` ran inside `app-api-1`: a throwaway **DISABLED**
probe user on Loopcom Demo + a throwaway role, and for each of the 96 nav items
the role was set to EXACTLY `[sectionPermission, permission]`, the resolver
cache cleared, and the effective set resolved as a USER jwt and as a
TENANT_ADMIN jwt. `probe-stage2.ts` (local, the REAL `navConfig`) then computed
the visible sidebar for each set:

- **96 OK, 0 LEAK, 0 DEAD.** Every togglable page shows for both jwt roles and
  reveals **no other page**. The 11 Locked pages correctly show nothing to a
  non-super jwt and still reveal nothing else; `crm.diagnostics` is hidden for a
  USER jwt (its admin-jwt rule, noted on the row) and shown for TENANT_ADMIN.
- Cleanup verified: `roles: 0, users: 0` left behind.

**(b) No customer lost a page.** Effective sets for all **18 custom-role
holders** were captured BEFORE any change (`effsets-before-20260902.json`) and
AFTER deploy + migration, and rendered through the OLD rules (old keys + old
force lines) vs the NEW `navConfig`:

- 14 holders: **identical** sidebar before and after (8–28 pages each).
- Ezra: 54 → 55 — `lost=[admin.remote_support_controls]`,
  `gained=[workspace.direct, workspace.meetings]`.
- The other three EZra-role holders (avillalobos@, cservidad@ — Ribit Capital;
  izzwgg@gmail.com — Izzy's Landau Home login): 54 → 53, lost ONLY the
  Remote Support Controls door that always refused.
- Buckets: END_USER 18 visible pages, TENANT_ADMIN 32, **Install present in
  both**.

**(c) The routes, driven with 60-second self-signed tokens against
`127.0.0.1:3001`:** as Ezra (TENANT_ADMIN) `/me` carries
`can_view_workspace_direct` + `can_view_workspace_meetings`, **`GET /meetings`
→ 200** (403 for every non-super before today), `GET /direct/threads` → 200.
As `loopcom.review@example.com` (no key): neither key in `/me`, `/meetings` →
**403**, `/direct/threads` → **403**, and `can_view_workspace_install` present
(the bucket forward-merge working).

**(d) The In-sidebar switch, one real round trip through the real save route:**
`POST /admin/role-permissions` with `hidden: ["store.specials"]` → `/me` reads
it hidden → POST with `hidden: []` → `/me` clean. Effective bucket sets
**byte-identical** before and after (END_USER 56, TENANT_ADMIN 117). ⛔ Side
effect to know: that was the **first permissions save since 2026-07-06** — the
snapshot row now reads `updatedAt 2026-09-02T12:09:31Z` and carries
`knownKeys`, exactly as the forward-merge handoff says the first save would.
The stored lists are the merged effective lists (round-trip stability is
tested), so nothing moved.

## §6 — Production data changes (both additive, both backed up)

Backups on loopcom, root-only: `/root/custom-roles-backup-20260902.json`
(9 roles), `/root/user-custom-roles-backup-20260902.json` (21 assignments).

1. **`migrate-roles.sql`** (guarded `UPDATE … WHERE NOT permissions @> add`,
   re-run = no-op) — every role holding the OLD shared key gained the NEW page
   key(s) so its holders see exactly what they saw:
   Install → 8 roles (Barish, EZra, Gesheft, Lea Yossis ww, Owner, Owner —
   company-wide…, Rob, S m Weiss); Store ×5 → EZra, Gesheft; Diagnostics →
   EZra, Rob; AI Trainer/ElevenLabs/Polly → EZra.
2. **New additive role `Direct + Meetings — Ezra`** (`cmtk1gdrn0001o57ush8z6ne9`,
   tenant `connect-admin-tenant-v1`, exactly the two keys) assigned to
   **ezra@connectcomunications.com only**: 134 → 136 keys, `gained` exactly the
   two, `lost: []`.
   ⛔⛔ **WHY NOT THE EZra ROLE IZZY EDITED: it is held by FOUR people in THREE
   tenants** (Ezra; two Ribit Capital users; Izzy's own Landau Home login).
   Adding the keys there launches Direct and Meetings for Ribit Capital too.
   Roles union per user, so a second role reaches Ezra alone
   ([[custom-role-s-m-weiss-is-shared-across-three-companies]]). If Izzy wants
   Ribit on it, that is one toggle each in the EZra role now that the rows exist.

Order used, and why: **api deploy → migration → portal deploy.** The old
portal reads old keys, so migrating between the two deploys meant no window in
which a custom-role holder lost Install; old api code ignores unknown keys on
read but `PUT /admin/custom-roles/:id` normalizes them AWAY on write, so
migrating BEFORE the api deploy risked a role save dropping them.

## §7 — Deploy trap re-hit: the server clone cannot fetch GitHub

`deploy-direct.sh`'s git-sync died on `fatal: could not read Username for
'https://github.com'` — the HTTPS credential is gone (the other session's
7b6b2ce2 handoff recorded the same 401). Recipe that worked, same as theirs:
`git bundle create <new>.bundle <server-tip>..<branch>` locally → `scp` → bare
mirror `git clone --bare /opt/connectcomms/app /root/connect-mirror.git` +
`git fetch <bundle> branch:branch` → `git remote set-url origin
/root/connect-mirror.git` → deploy → ⛔ **`git remote set-url origin
https://github.com/izzwgg-arch/connect-platform.git` and `rm -rf` the mirror
afterwards** (done; verified). ⛔ When the mirror is built from the app clone it
can already hold commits GitHub does not — check `git log` on the mirror branch
and `merge-base --is-ancestor <yours> <tip>` before trusting what will deploy.

## §8 — NOT PROVEN / open

- ⏳ **No human has opened either editor since the deploy.** Proven by tests,
  by the deployed resolver, by the shipped bundle strings ("Platform only" ×1,
  `setOwnerOnly` ×0, `can_view_workspace_direct` ×3, the store note ×1) and by
  driving the routes — not by a person clicking a toggle. ⛔ An open tab or
  desktop window keeps the OLD bundle; Ezra needs a reload (desktop: full
  close + reopen) before Direct and Meetings appear.
- ⏳ Ezra has not opened Meetings or Direct. The acceptance test is his next
  sign-in: both links in Workspace; `/meetings` renders (no "Not available").
- ⚠️ Another session is adding `workspace.remote_desktop` to `navConfig`
  (uncommitted at the time of writing) on the action key
  `can_use_remote_desktop` — the Desk Phones pattern. The uniqueness guard and
  the nav-bound dedupe already cover it; the "every nav key is a real
  PortalPermissionKey" guard will fail until that key is in
  `ACTION_PERMISSION_KEYS`, which is that session's job.
- Cosmetic leftover: the custom-role editor still carries the (now dead)
  `LAUNCH_GATED_NAV_ITEMS` note text mentioning "Owner only"; it renders for
  nothing because the list is empty. Reword when that file is next touched.
- The server clone is behind GitHub again (`9c892bf4` on GitHub vs
  `24a41e26` deployed); the next session that deploys will hit the same 401
  and needs §7.
