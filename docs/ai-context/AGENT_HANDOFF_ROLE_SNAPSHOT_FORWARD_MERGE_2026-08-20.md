# AGENT HANDOFF — the role snapshot forward-merge: new default keys now reach tenant admins (2026-08-20)

**Branch `claude/snapshot-forward-merge` (worktree hopeful-pasteur), built on the
`feat/ivr-migration-takeover` tip `b688b175`. ⏳ NOT MERGED, NOT DEPLOYED —
awaiting Izzy's sign-off, because deploying it changes what live tenant admins
can do the moment the api restarts.**

## 1. The problem, measured on the live row

`PlatformRolePermissionSnapshot` (id `default`, version 2) is read LITERALLY for
bucket roles by `apps/api/src/platformRolePermissions.ts` — the only exceptions
were the SUPER_ADMIN force-add and a narrow `can_view_admin_*` back-merge. The
live row was verified 2026-08-20:

- **Last saved 2026-07-06 14:15 UTC.** Stored lists: END_USER 54 keys,
  TENANT_ADMIN 92, SUPER_ADMIN 121. Today's key inventory is **166**.
- Every default key born after that save never reached a real tenant admin:
  the four **Queues** keys (2026-08-16), both **Conference** keys (2026-08-20),
  all **Tracking** keys (incl. its whole new sidebar section), and
  `can_use_yiddish`.
- 9 active tenant-admin-bucket users exist; **5 ride the bucket path** (no
  active custom roles) and were missing all of the above. The other 4 have
  authoritative custom roles, which this change deliberately does NOT touch
  (see [[custom-roles-are-authoritative]] — updating a custom role means
  rebuilding its full key list in the role editor).

## 2. Why the snapshot goes stale by design

The ONLY writer is `POST /admin/role-permissions` (SUPER_ADMIN, full replace).
The editor page (`apps/portal/app/(platform)/admin/permissions/page.tsx`)
renders toggles **only for sidebar sections and items — action keys never
appear in the UI**; they survive a save only because GET seeds the page's state
with the normalized stored lists. So the snapshot is a frozen photograph of the
key inventory on the day of the last save, and nothing refreshes it until a
super admin happens to press Save again.

## 3. The fix: a write-time key inventory, and a forward-merge on read

Everything is in `apps/api/src/platformRolePermissions.ts`:

- **`knownKeys`** — POST now stores `{version: 2, roles, knownKeys:
  [...PORTAL_PERMISSION_KEYS]}`: the set of keys that EXISTED at save time.
- **Legacy rows have an inventory too**: POST has always force-stored
  SUPER_ADMIN as the complete inventory of its day
  (`normalizeRolePermissionSet` force-add), and the table's migration seeds no
  row — so every row alive was born through POST, and the stored SUPER_ADMIN
  list doubles as the write-time inventory (`writeTimeKeyInventory`, explicit
  `knownKeys` wins when present). Verified on the live row: all 121 stored
  SUPER_ADMIN keys are still-valid keys, i.e. exactly the 2026-07-06 inventory.
- **`forwardMergeNewDefaultKeys`** (runs for v2+ snapshots, non-SUPER buckets,
  inside `normalizeStoredRoleList`): a DEFAULT key for the bucket that is
  **outside the inventory** could not have been deliberately removed → grant
  it. A default key **inside the inventory** but absent from the bucket's list
  WAS deliberately removed → never resurrected.
- **The section gate** (same discipline as the existing `can_view_admin_*`
  back-merge, which is unchanged): a sidebar-ITEM key only merges if its
  section key is effectively granted. New SECTION keys merge first, so a
  genuinely new section (Tracking) brings its own pages. A new page inside a
  section the admin closed (PBX, since 2026-07-06 — see §5) stays hidden.
- No inventory derivable (no knownKeys, no stored SUPER_ADMIN list) → strictly
  literal, exactly today's behavior. v1 snapshots keep the legacy-expansion
  path untouched.

## 4. Dry-run against the REAL live row (what deploy will change)

- **END_USER: +1** — `can_use_yiddish`. Nothing lost.
- **TENANT_ADMIN: +23, nothing lost** — the 4 queues action keys, both
  conference action keys, `can_use_yiddish`, and all 16 tracking keys
  (section + 9 page keys + 6 action keys). ⛔ **`can_view_pbx_queues` and
  `can_view_pbx_conference` are correctly NOT added** — they are nav items
  under `can_view_section_pbx`, which the 2026-07-06 save deliberately removed.
- SUPER_ADMIN unchanged (already force-add).

## 5. ⛔ What this does NOT fix — Izzy's July-06 section choices stand

The 2026-07-06 save removed whole sections from TENANT_ADMIN
(**pbx, apps, settings, admin**; billing invoices/payments/receipts;
`can_manage_crm`) and from END_USER (pbx, apps, settings; recordings — the
carve-out [[custom-roles-are-authoritative]] already records). The section
model existed since May, so these were real editor toggles, and this change
treats them as law. Consequences to put in front of Izzy:

- Bucket tenant admins get the queues/conference **capability** keys (API
  routes open; the pages load if reached by URL, e.g. `/queues`), but **no nav
  entry** — the PBX section is off. If Izzy wants Queues/Conference visible in
  the sidebar for tenant admins, that is one deliberate act in
  Admin → Permissions: switch the PBX section on for Tenant Admin and tick the
  Queues/Conference items, then Save (which also bakes in `knownKeys`).
- The 4 custom-role tenant admins (ezra@, sales@iniimini, golda@, lea@) see
  none of this — their roles are authoritative and need their own edit.

## 6. Proof

- **`apps/api/src/platformRolePermissions.forwardMerge.test.ts` — 11/11 green**:
  new action keys granted; new section rides in whole; new page under a
  removed section stays hidden; deliberate removals never resurrected;
  END_USER only gets END_USER defaults; no inventory → literal; explicit
  knownKeys beats the SUPER_ADMIN inference; SUPER_ADMIN full; v1 untouched;
  POST stores knownKeys; **round-trip stability** (reading back a fresh save
  changes nothing — the merge only ever bridges the gap between saves).
- Neighboring suites green: portalPermissionQueryCount 5, adminRouteTenantScope,
  customRolesGrantability.tenantComm, portalCrmPermissionsAuthoritative,
  smsSharedInbox 9.
- api typecheck: 97 errors before AND after (zero delta; the branch-tip
  baseline, cf. the 75 of the earlier conference commit).
- Dry-run in §4 executed against the actual production JSON (read-only pull).

## 7. Deploy notes (AFTER sign-off)

- api-only; **no migration** (JSON payload gains an optional field old readers
  ignore). The snapshot read is cached (`permissionCache.ts` TTL) and every
  restart clears it — no invalidation step needed for deploy itself.
- After deploy, verify: `GET /admin/role-permissions` as super admin shows
  TENANT_ADMIN with the queues/conference/tracking/yiddish keys; a bucket
  tenant-admin login can hit `GET /voice/queues`-family routes without 403.
- The first post-deploy **Save** on Admin → Permissions writes `knownKeys` and
  bakes the forward-merged keys into the stored lists (GET seeds the editor
  with the merged lists) — after that the merge is a no-op until the next new
  feature ships keys.
