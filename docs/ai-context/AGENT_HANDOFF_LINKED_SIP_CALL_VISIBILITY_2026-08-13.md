# AGENT HANDOFF — one phone, two companies: the owner can now see the linked extension's calls (2026-08-13)

**Commit `4ca72f44`** on `feat/ivr-migration-takeover`. **api + portal DEPLOYED
and container-verified**, one database migration applied. Live data change:
the switch is **ON for Trust Bookkeepings** and one custom role was created and
assigned. No PBX write, no deploy-queue job, no flag flipped anywhere else.

> ⛔ **Read §7 before you touch permissions for anybody.** Creating the role for
> this feature exposed a rule that can silently strip a user's whole portal:
> **an active custom role REPLACES the built-in role's permissions.** It is not
> additive.

---

## 1. What Izzy asked for, in his words

> *"I've got him. Actually, make it an option so I can activate it per tenant
> that has the scenario where I have registered one extension in Trust
> Bookkeeping with two SIP registrations: one from Trust Bookkeeping, one from
> TRiM Pro. What I would like is for the Trust Bookkeeping owner that has
> activated it to see everybody's phone calls and voicemails. He should also see
> call history for the one extension that's registered to TRiM Pro. He should
> see call history just from that extension, nothing else from the TRiM Pro
> extension that's registered to his company. When he sees the call history, he
> should also be able to listen to the call recordings just for that extension,
> nothing else from TRiM Pro."*

Decomposed into four requirements, all delivered:

| # | Requirement | Where it landed |
|---|---|---|
| 1 | Per-tenant switch, off by default, activatable per company | `Tenant.linkedSipCallVisibilityEnabled` + super-admin toggle |
| 2 | The owner sees **everybody's** calls and voicemails in his own company | Existing `can_view_tenant_call_history` / `can_view_tenant_voicemails` — he simply did not hold them (§6) |
| 3 | He also sees call history for the **one** linked TRiM Pro extension, **and nothing else from TRiM Pro** | New merged branch in `GET /calls/history` (§4) |
| 4 | He can **listen to the recordings for that extension only** | New linked-scope fallback in `streamCallRecording` (§5) |

⛔ **Voicemails were deliberately NOT extended across the tenant boundary.** He
asked for "everybody's phone calls and voicemails" (his own company) and then,
separately, for **call history + recordings** on the linked extension. Voicemail
is a mailbox that belongs to TRiM Pro; nothing in the request asked for TRiM
Pro's voicemails and the smaller reading is the safe one. If he wants that too
it is a deliberate follow-up, not a bug.

---

## 2. The live scenario this exists for

There is exactly **one** cross-tenant SIP link on the whole platform (verified
2026-08-13, read-only):

```
UserSipAccount cmsre9y4k2d65pg13aj7h3izx
  user      lschwartz@trustbookkeepingny.com  (tenant: Trust Bookkeepings)
  label     "Trim Pro"
  extension 102 "Mrs. Schwarts"               (tenant: Trimpro)
  crossTenant = true
```

Mrs. Schwartz sits in Trust Bookkeepings on ext 104 and **also** registers
Trimpro's ext 102 on the same phone (the "Add SIP account" button on
`/admin/users`). Her Trimpro calls are filed under **Trimpro's** tenant, so
before this change nobody in Trust Bookkeepings could see them at all.

Tenant ids worth having (do not re-derive them):

- Trust Bookkeepings `cmnlgrykx000fp9pa90gohk96`
- Trimpro `cmnlgryjk0003p9pabtu1z1oj`, whose CDR rows also appear as **`vpbx:trimpro`**

**Volume, 14 days to 2026-08-13:** Trimpro has **692** call records, of which
**52** involve ext 102 and **45** of those carry a real recording. So the
feature adds ~52 rows to Trust's history and ~45 playable recordings — and
correctly withholds the other **640** Trimpro calls.

---

## 3. The switch

`Tenant.linkedSipCallVisibilityEnabled Boolean @default(false)`
(migration `20260813120000_tenant_linked_sip_call_visibility`, applied — column
confirmed present in the production `Tenant` table).

Two ways to flip it:

- **Portal:** Admin → Tenants. Every tenant row now carries an **On/Off** button
  in a "Linked SIP call visibility" column. `PermissionGate can_view_admin`
  wraps the page and the route is super-admin only.
- **API:** `POST /admin/tenants/:id/linked-sip-call-visibility` `{ "enabled": true }`
  — `requireSuperAdmin`, writes an `AuditLog` row
  `TENANT_LINKED_SIP_VISIBILITY_UPDATED` with the new value in `metadata`.

The flag is also returned by `GET /admin/tenants` (it had to be added to the row
projection — ⛔ **a new Tenant column does not appear in that payload unless you
add it there**, the list is hand-built, not a `select: *`).

⛔ **That Tenants page had never written anything before this.** It was a
read-only three-column table; `PATCH /admin/tenants/:id` and the
number-purchase toggle both exist in the API with **no portal caller at all**.
This is the first mutation on that screen — if you add a second, copy the
pattern here (optimistic-free: POST, then bump a refresh key so the list
re-reads the truth from the server).

---

## 4. Call history — how the merge works

`GET /calls/history` had exactly two modes. There is now a third.

```
extension-scoped   (no can_view_tenant_call_history)
  → own tenant, filtered in memory to the user's OWN extensions

tenant-wide        (has the key, switch OFF or no links)   ← unchanged
  → own tenant, plain paged SQL

tenant-wide + linked  (has the key, switch ON, ≥1 cross-tenant link)  ← NEW
  → own tenant window  ∪  each foreign tenant's window filtered to the linked extensions
```

The scopes come from `resolveLinkedSipCallScopes(homeTenantId)` in `server.ts`:

1. Read the tenant's flag. **Off → return `[]` immediately**, so a tenant
   without the switch pays one cheap indexed lookup and nothing else.
2. `userSipAccount.findMany({ where: { user: { tenantId }, NOT: { tenantId } } })`
   — rows whose **owning user** is in this tenant but whose **extension** is
   not. ⛔ `UserSipAccount.tenantId` is the **extension's** tenant, not the
   user's; getting that backwards returns nothing and reads like "no links".
3. Group by foreign tenant, dropping same-tenant rows, non-`ACTIVE` extensions
   and blank numbers (`groupLinkedSipAccountRows`).
4. Expand each foreign tenant through the existing `resolveTenantIdFilterSet`
   so **both** the cuid and `vpbx:{slug}` forms are matched.

⛔ **The whole function is wrapped so that any failure returns `[]`.** No extra
visibility is the safe answer; a 500 on the call-history page is not.

### ⛔ Why the foreign rows are filtered in memory and not in SQL

A SQL `OR fromNumber/toNumber IN (...)` **misses queue and ring-group calls
entirely** — on those, the extension appears only inside `channelsSeen`
(`PJSIP/T11_102_1-0000abcd`) or the dialplan context, never in from/to. So the
foreign window is fetched (same 5000-row cap the extension-scoped path already
uses) and passed through `cdrRowMatchesExtensionNumbers`, which is a faithful
copy of the matcher `/calls/history` has always used for extension-scoped
viewers: exact digits on from/to, else a **digit-boundary** regex over
channels + contexts.

The digit boundary is the part that matters and it is unit-tested: `102` must
match `PJSIP/T11_102_1-…` and must **not** match the phone number `845-102-5555`.

Own rows and foreign rows are merged, de-duplicated by row id, re-sorted by
`startedAt` desc, and then paged — so paging, totals and the per-direction
counters all stay honest across the join.

---

## 5. Recordings — the tenant check now has a second door

`streamCallRecording` used to refuse outright when the recording's tenant was
not one of the user's own tenant-id forms. It now takes one more step before
the 403:

```
row's tenant is not mine
  → load the linked scopes
  → cdrRowInLinkedSipScopes(rec, scopes)?     ← foreign tenant AND a linked extension
       no  → 403 forbidden          (unchanged for everybody else)
       yes → allowed, but ONLY with can_view_tenant_call_recordings
```

To make that decision the recording resolver had to start carrying the
evidence: `resolveRecordingForUser` now also selects `fromNumber`, `toNumber`,
`channelsSeen`, `dcontextsSeen` and `dcontext`. ⛔ **Without those fields the
scope check silently answers "no" for every queue/ring-group recording** — the
derived single `extension` field is not enough.

⛔ **The owner carve-out is switched OFF for linked recordings, deliberately.**
Everywhere else in that function, "this is my own extension" lets you play a
recording without holding a recordings permission. Owned extension numbers are
**home-tenant** numbers, so a Trust user who happens to own ext 102 in Trust
would otherwise be handed Trimpro's ext 102 recordings by pure number
coincidence. A linked recording is an extension of the **tenant-wide** view and
requires the tenant-wide key outright — for listening and for downloading.

Net effect: **it is impossible to reach a foreign recording without both** the
tenant switch being on **and** the user holding `can_view_tenant_call_recordings`
**and** the row genuinely involving a linked extension.

---

## 6. ⛔ Nobody in Trust Bookkeepings could see anybody else's calls

Requirement 2 read like it was already true. It was not — and this is the kind
of thing that turns "I shipped the feature" into "he opened it and nothing
changed."

All five Trust Bookkeepings users are `role = USER`, and on 2026-08-13 the
tenant had **zero** custom roles and **zero** custom-role assignments. So every
one of them — the owner included — was **extension-scoped**: each saw only their
own extension's calls. Shipping only the cross-tenant half would have given the
owner a company-wide feature he had no company-wide view to hang it on.

So the second half of the job was granting the owner the view he was assumed to
already have. `vigdor@trustbookkeepingny.com` (the Owner row on the Users
screen) now holds the custom role **"Owner — company-wide calls & voicemails"**
(`cmsrfv3ix0001o4e23pnuoa2r`, 59 keys, active), which adds five keys on top of
what he already had:

- `can_view_tenant_call_history` — everybody's calls
- `can_view_tenant_voicemails` — everybody's voicemails
- `can_view_tenant_call_recordings` — and the linked TRiM Pro recordings
- `can_view_recordings`, `can_download_recordings` — the action keys for
  playback/download (see the trap in §7 — the live END_USER bucket does **not**
  contain these)

**The other four users were not touched.** They stay extension-scoped and gain
nothing from the switch.

---

## 7. ⛔⛔ THE RULE THIS SESSION PAID FOR: a custom role REPLACES, it does not add

`computeAuthoritativePortalPermissions`
(`apps/api/src/crm/portalCrmPermissions.ts:26`): for any non-SUPER_ADMIN user
with **one or more active custom roles**, the effective permission set is
**exactly** the union of those roles' keys — the built-in role bucket then
grants **nothing**. It is literal, with no legacy expansion, because the role
editor must be deterministic (ON = visible, OFF = hidden).

**So a role containing only the new keys would have deleted the owner's entire
portal.** To ADD a capability you must build the role as
`current effective set + additions`.

⛔ **And "current effective set" is NOT `DEFAULT_ROLE_PERMISSIONS` in the
code.** The authority is the single live row
`PlatformRolePermissionSnapshot(id="default")`, version 2, which is read
**literally**. Reading the code defaults instead would have been wrong here:
the live END_USER list is **54** keys and **does not include
`can_view_recordings` or `can_download_recordings`** — ordinary users reach
their own recordings only through the owner carve-out described in §5. Had the
role been built from the code defaults, the owner would have kept two keys he
never had and, worse, the method would have been silently wrong for the next
person who copies it.

Recipe, exactly as run:

```
1. read PlatformRolePermissionSnapshot(id="default").roles.END_USER   → 54 keys
2. union with the 5 additions                                        → 59 keys
3. customRole.create({ tenantId, name, active: true, permissions })
4. userCustomRole.create({ tenantId, userId, customRoleId })
```

⛔ Assignments are scoped by **userId only** at runtime — the row is stored
under the assigning admin's tenantId and cross-tenant assignments are normal.
Never filter assignments by the user's own tenantId (that is the historic
"custom role does nothing" bug, documented in `platformRolePermissions.ts:129`).

---

## 8. A bug fixed in passing: search silently killed the recordings filter

In `GET /calls/history`, the `hasRecording` filter writes into `where.AND`, and
the search-term block then did `where.AND = andClauses` — **assignment, not
merge**. Any request carrying **both** a search term and `hasRecording=yes`
therefore lost the recordings condition entirely.

The Recordings page and the PBX Call Recordings page both send exactly that
combination whenever anyone types in their search box — so searching on those
screens has always been able to return calls with no recording at all. Now
merged instead of overwritten.

---

## 9. Files

| File | What |
|---|---|
| `packages/db/prisma/schema.prisma` | `Tenant.linkedSipCallVisibilityEnabled` |
| `packages/db/prisma/migrations/20260813120000_tenant_linked_sip_call_visibility/migration.sql` | the column |
| `apps/api/src/linkedSipVisibility.ts` | **new** — all the pure logic |
| `apps/api/src/linkedSipVisibility.test.ts` | **new** — 15 cases |
| `apps/api/src/server.ts` | loader, history merge branch, recording fallback, toggle route, list projection, AND-merge fix |
| `apps/portal/app/(platform)/admin/tenants/page.tsx` | the On/Off toggle |

The pure logic lives in its own module on purpose: `groupLinkedSipAccountRows`,
`cdrRowMatchesExtensionNumbers` and `cdrRowInLinkedSipScopes` are testable with
no database, which is how the digit-boundary and the
"foreign-tenant-membership-alone-is-never-enough" rules are pinned.

---

## 10. Proof — what is verified, and how

✅ **Tests.** 15 new cases pass; the existing `tenantCommScope.calls` /
`tenantCommScope.recordings` suites (6 cases) still pass. Run them with
`node --experimental-test-module-mocks --import tsx --test src/linkedSipVisibility.test.ts`
from `apps/api`.

✅ **Typecheck.** `apps/api` reports **72** errors — byte-identical to the
documented pre-existing baseline, with **none** in the edited line ranges and
none in the new module. Portal typecheck clean for these files.

✅ **Deployed and container-verified.**
`docker exec app-api-1 grep -c resolveLinkedSipCallScopes /app/apps/api/src/server.ts` → **3**,
`linkedSipVisibility.ts` present inside the container, and the portal `.next`
build contains the `linked-sip-call-visibility` route string in **2** chunks.
Re-verified after later unrelated deploys moved both containers forward
(api `2c7657f3`, portal `307cecc6`) — the feature is still in both.

✅ **Migration applied** — the column is in the production `Tenant` table
(`information_schema` read).

✅ **Live state, re-read 2026-08-13:** exactly one tenant has the flag on
(Trust Bookkeepings); the role exists, is active, and carries 59 keys; the
assignment to vigdor exists.

⛔ **The commit reads as missing from `git log --oneline`** — this branch has the
known clock skew, so `4ca72f44` sinks below newer commits. It **is** in HEAD and
on origin: verified with `git merge-base --is-ancestor`, `git ls-tree` and
`git branch -r --contains`. Do not conclude it was lost or rolled back from the
log.

⏳ **NOT PROVEN: nobody has signed in and looked.** `vigdor`'s
`lastLoginAt` is **2026-08-04**, i.e. before any of this existed. Everything
above is proven as plumbing, live data and container contents — **not** by a
human seeing a TRiM Pro call in Trust's list.

### Acceptance test (5 minutes, needs Izzy or vigdor)

1. Sign in as `vigdor@trustbookkeepingny.com`. If a portal window is already
   open, **reload it** — an open window keeps the old bundle.
2. Open **Call History**, widen the date range to the last few days.
3. Expect: calls for **all five** Trust extensions (101, 104, 105, 106, 107),
   **plus** calls involving ext **102** whose company is Trimpro.
4. Press play on one of the ext-102 rows — it should stream. ~45 of the last 14
   days' ext-102 calls have real audio.
5. Confirm the negative, which matters more than the positive: Trimpro calls
   that do **not** involve 102 (there were **640** of them in 14 days) must be
   **absent**.
6. Flip the switch **off** on Admin → Tenants and reload — the ext-102 rows must
   disappear while everything else stays. That is the cleanest single proof the
   gate is the gate.

---

## 11. Open items / deliberate non-goals

- ⏳ **Mrs. Schwartz herself still cannot see her Trimpro line in her own
  login.** This feature extends the **tenant-wide** view; she is
  extension-scoped and her owned extensions are Trust's. Making a user's own
  linked lines appear in their personal history is a separate, defensible
  change — `getUserExtensionNumbers` would have to consult `UserSipAccount` —
  and was not asked for.
- ⏳ **Voicemails are not extended across the boundary** (§1). Deliberate.
- ⏳ **The dashboard KPI tiles and `/dashboard/call-traffic` do not include
  linked calls** — only the call-history list and recording playback do. Counts
  on the dashboard will therefore not match the list for a tenant with the
  switch on. Not asked for; flagged because it will look like a discrepancy.
- ⛔ **The 5000-row cap is per source.** Own tenant and each foreign tenant each
  fetch up to 5000 rows for the selected window before merging. That is the
  same ceiling the extension-scoped path has always had, but with the switch on
  a very wide date range costs one extra query per linked tenant.
- **Scale today is trivial** — one link, platform-wide. If cross-tenant links
  ever become common, the in-memory merge is the first thing to revisit.
