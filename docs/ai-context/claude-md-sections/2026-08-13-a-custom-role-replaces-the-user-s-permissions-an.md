# ⛔⛔ AGENT HANDOFF — a custom role REPLACES the user's permissions; and one phone's second company is now visible in call history (2026-08-13) — READ FIRST before granting ANYONE a custom role, before touching /calls/history scoping or recording auth, or for "one extension, two companies"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_LINKED_SIP_CALL_VISIBILITY_2026-08-13.md`**
(`4ca72f44` on `feat/ivr-migration-takeover`. **api + portal DEPLOYED and
container-verified**, one migration applied, and a live data change: the switch
is ON for Trust Bookkeepings and one custom role was created + assigned. No PBX
write.)

- ⛔⛔ **A CUSTOM ROLE IS NOT ADDITIVE — IT REPLACES THE BUILT-IN ROLE ENTIRELY.**
  `computeAuthoritativePortalPermissions` (`crm/portalCrmPermissions.ts:26`):
  any non-SUPER_ADMIN with ≥1 ACTIVE custom role gets **exactly** that role's
  keys, literally, no legacy expansion — the bucket then grants nothing. **So a
  role containing only the keys you want to ADD deletes the user's whole
  portal.** To add a capability, build the role as
  `their current effective set + the additions`.
  ⛔ **And the "current effective set" is NOT `DEFAULT_ROLE_PERMISSIONS` in the
  code — it is the ONE live row `PlatformRolePermissionSnapshot(id="default")`,
  version 2, read literally.** Proven live: END_USER there is **54 keys and does
  NOT contain `can_view_recordings` / `can_download_recordings`** (ordinary users
  reach their own recordings only via the owner carve-out). Building from the
  code defaults would have handed the owner two keys he never had.
  ⛔ Assignments are looked up by **userId only** — never filter by the user's own
  tenantId (rows live under the assigning admin's tenant; that is the historic
  "custom role does nothing" bug). See [[custom-roles-are-authoritative]].
- ⛔ **REQUIREMENT 2 LOOKED ALREADY-TRUE AND WAS FALSE.** Izzy asked for the
  owner to "see everybody's calls and voicemails" as if he already could. All
  five Trust Bookkeepings users are `role = USER` with **zero** custom roles, so
  every one of them — owner included — was **extension-scoped and saw only their
  own extension**. Shipping only the cross-tenant half would have been a feature
  hung on a view that did not exist. **Check what the customer can see today
  before building on top of it.**
- **What shipped:** `Tenant.linkedSipCallVisibilityEnabled` (default **false**),
  flipped per tenant from the **Admin → Tenants** page (⛔ that screen had never
  written anything before — first mutation on it) or
  `POST /admin/tenants/:id/linked-sip-call-visibility` (super-admin + audit
  `TENANT_LINKED_SIP_VISIBILITY_UPDATED`). ⛔ **A new Tenant column does NOT
  appear in `GET /admin/tenants` unless you add it to the hand-built row
  projection.** When ON, holders of `can_view_tenant_call_history` also see, in
  `/calls/history`, the calls of foreign extensions attached to this tenant's
  users via **`UserSipAccount`** — **those extensions only**; and may play/download
  those recordings with `can_view_tenant_call_recordings`.
- ⛔ **`UserSipAccount.tenantId` is the EXTENSION's tenant, not the user's.**
  The cross-tenant query is `{ user: { tenantId }, NOT: { tenantId } }`; getting
  it backwards returns nothing and reads exactly like "no links exist".
- ⛔ **THE FOREIGN ROWS MUST BE FILTERED IN MEMORY, NOT IN SQL.** A
  `fromNumber/toNumber IN (...)` clause **misses every queue and ring-group
  call** — on those the extension appears only in `channelsSeen`
  (`PJSIP/T11_102_1-…`) or the dialplan context. Reuses the same
  digit-boundary matcher the extension-scoped path has always used, so `102`
  matches the channel but **not** the phone number `845-102-5555`.
- ⛔ **The recording resolver had to start selecting `fromNumber`, `toNumber`,
  `channelsSeen`, `dcontextsSeen`, `dcontext`** — without them the linked-scope
  check silently answers "no" for every queue/ring-group recording; the single
  derived `extension` field is not enough.
- ⛔ **THE OWNER CARVE-OUT IS DELIBERATELY DISABLED FOR LINKED RECORDINGS.**
  Everywhere else, "it's my own extension" lets you listen without a recordings
  key — but owned numbers are HOME-tenant numbers, so a Trust user owning ext 102
  in Trust would be handed **Trimpro's** ext 102 audio by pure number
  coincidence. A linked recording requires the tenant-wide key outright.
- **The live case (the only cross-tenant link on the platform):**
  lschwartz@trustbookkeepingny.com (Trust Bookkeepings) carries **Trimpro ext
  102 "Mrs. Schwarts"**. 14 days: Trimpro had **692** calls, **52** involve 102
  (**45** with real audio) — so 52 rows are added and the other **640** are
  correctly withheld. Owner `vigdor@trustbookkeepingny.com` holds the new role
  **"Owner — company-wide calls & voicemails"** (59 keys); the other four users
  were not touched.
- ⛔ **Voicemails were NOT extended across the tenant boundary** — he asked for
  his own company's voicemails, then separately for call history + recordings on
  the linked extension. Deliberate, not an omission.
- **Fixed in passing:** `/calls/history` **overwrote** `where.AND` when a search
  term was present, silently dropping the `hasRecording` filter — and the
  Recordings + PBX Call Recordings pages send **both** whenever anyone types in
  the search box. Now merged.
- ⛔ **`git log --oneline` does NOT show `4ca72f44`** — this branch's clock skew
  sinks it below newer commits. It IS in HEAD and on origin (`merge-base
  --is-ancestor`, `ls-tree`, `branch -r --contains` all confirm). Do not read the
  log as a lost commit or a rollback.
- ⏳ **NOT PROVEN: nobody has signed in and looked.** vigdor's `lastLoginAt` is
  **2026-08-04**, before any of this existed. Proven as tests (15 new + 6
  existing), typecheck (72 errors = the exact pre-existing baseline, none in the
  edited ranges), container greps, the migration, and live data — **not** by a
  human seeing a Trimpro call in Trust's list. **Acceptance in §10 of the
  handoff, and the negative matters most: the 640 non-102 Trimpro calls must be
  ABSENT, and flipping the switch off must remove the 102 rows and nothing else.**
- ⏳ **Also open, deliberately:** Mrs. Schwartz still cannot see her own Trimpro
  line in her personal history (this extends the TENANT-WIDE view, not a user's
  own scope), and the dashboard KPI tiles / `/dashboard/call-traffic` do **not**
  include linked calls — so those counts will not match the list for a tenant
  with the switch on.
