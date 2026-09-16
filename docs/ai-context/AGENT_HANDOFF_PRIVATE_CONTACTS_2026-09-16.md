# AGENT HANDOFF — contacts are PRIVATE to the person who saved them (2026-09-16)

Izzy, 2026-09-16: *"Relax Tires 101 told me yesterday that two other extensions that
signed up got all of his personal contacts into their app. This should never, ever
happen. Please, if he can, remove all of his contacts from there, only leave their own
contacts, and make sure there is a safeguard so even if it's in the same company,
different extensions shouldn't get other people's contacts."*

Commit **`2acf52b8`** (api + worker + agent code, schema, migration).

---

## 1. What was actually wrong (read off the live DB, not guessed)

- `Contact` had **no owner concept**. `GET /contacts` returned every contact where
  `tenantId = X`. The mobile app, portal and desktop all read that list.
- Relax Tires (`cmnlgryme000up9paz1w40fg0`): **4,250 active contacts, every one
  `createdBy` = ext 101 (`relaxtires@gmail.com`, user `cmnmjhlu3004xp96hv4g49htg`)**,
  `source = MANUAL` (the phone-book import writes MANUAL too — `source` can NOT tell an
  import from a hand-typed contact). Alex (102) and Felix (103) created **zero**.
  Alex signed in 09-16 01:33 and got all 4,250; Felix had never signed in.
- ⛔ The leak was bigger than the contact list. Every one of these also read the whole
  tenant's contacts:
  - the **incoming-call and missed-call caller NAME** (`matchTenantContactByPhone` on the
    ring path) — Alex's phone would ring showing names from 101's phone book;
  - the **duplicate check** on save ("already saved under «Name»" named 101's contact);
  - the **phone-book import MERGE** — Alex importing his own phone book would have ADDED
    his numbers onto 101's contacts;
  - **global search**, the **assistant's `list_contacts` tool**, the chat CRM decoration,
    the **SMS→email** subject name, CRM SMS hooks, CRM import matching, supermarket blasts.
- Same shape on other tenants (one creator, several users): Trimpro 857/4 users,
  Landau Home 571 personal/2, A plus center, Trust Bookkeepings, Ribit.
- ✅ Nothing was written into anyone's PERSONAL phone address book. `saveContactToDevice`
  only fires when a user creates a contact in the app; there is no bulk Connect→phone sync.

## 2. The fix (one rule, `apps/api/src/contactVisibility.ts`)

- **`Contact.ownerUserId`**: set = PRIVATE to that one user; `null` = SHARED company
  contact (CRM leads, website submissions, seed data).
  ⛔ **Deliberately NOT a foreign key.** A `SetNull` on user delete would turn a deleted
  user's private phone book into a company-wide one. A dead owner id stays invisible.
- ⛔ **No admin bypass.** A tenant admin, and platform staff inside a tenant context, do
  not see a colleague's private contacts either.
- ⛔ **No viewer known = SHARED ONLY, never everything** (`contactVisibleToUserWhere(null)`).
- **Migration `20260916200000_contact_owner_private`**: adds the column + index and
  backfills `ownerUserId = createdBy` for every contact that has a creator and **no
  `CrmContactMeta`**. CRM contacts stay shared (CRM already has per-user access rules);
  creator-less rows (Loopcom Demo's 12) stay shared.
- New contacts (`POST /contacts`) and phone-book imports (`POST /contacts/import`) are
  private to whoever saved them — **including contacts added from the portal Contacts page**.

| Path | Now |
|---|---|
| `GET /contacts` list + all counts | shared + mine (ANDed, so the search `OR` cannot widen it) |
| `GET/PATCH/DELETE /contacts/:id`, avatar get/post/delete | 404 for a colleague's private contact |
| duplicate check, import merge | only against contacts I can see |
| ring-path + missed-call caller name | the RUNG user's visible contacts (`viewerUserId` is a REQUIRED param now — the compiler finds any new caller) |
| global search | shared + mine |
| assistant `list_contacts` | shared + the asker's (`ctx.clientUserId`, server-verified) |
| chat CRM decoration | shared + mine |
| SMS→email name | a private contact only when its owner is the SOLE recipient |
| CRM gate (`assertCrmContactAllowed`), CRM GET/PATCH/merge/lookup, import matcher, bulk email explicit list, both CRM SMS hooks, supermarket blasts | shared only |

## 3. Proof

- `apps/api/src/contactVisibility.test.ts` — 7 tests; **5 source guards FAIL replayed
  against pre-fix HEAD** (`PORTAL_GUARD_ROOT=<worktree at HEAD>` → 2 pass / 5 fail), 7/7 on
  the fix.
- api crm + supermarket + agentProvisioning + globalSearch suites: **1016/1016** after
  fixing one fixture (`supermarketStress` STRESS 19 seeded contacts without
  `ownerUserId`; the fake DB treats a missing field as not-null — the real column
  defaults to null, so the fixture now says so).
- `inboundCallerMatch.test.ts` ring-path guard updated to the new signature.
- agent `smsEmail*` + `contactsTools*` **88/88**.
- tsc: no errors in any touched file (api's 49 / server.ts's 6 are pre-existing, unrelated
  lines; worker + agent clean in touched files).

## 4. Deploy + live verification (✅ DEPLOYED, container-verified)

- **Migration applied** on the live DB (`20260916200000_contact_owner_private`, in the first
  api deploy's migrate stage). Relax Tires now reads: 4,250 contacts, owner
  `relaxtires@gmail.com`, 0 shared.
- ⛔⛔ **My first api deploy FAILED at boot and prod stayed on `42cccd3a` (blue/green did
  its job).** `2acf52b8` had staged `apps/api/src/server.ts` from the shared worktree
  while ANOTHER session had just added `import ./textingRegistration/wire` + its call —
  a module they had not committed. Candidate died `MODULE_NOT_FOUND`. `5f279499` removed
  exactly those 6 lines (their worktree untouched). Lesson: `git diff HEAD --stat` of a
  file RIGHT before staging, compared to your own edit size — mine was 43 lines at edit
  time and 55 at commit time and I did not look. Stage your hunks, not the file.
- **api** `done 5f279499`, then the other session's `34ff3aae` (my commits are ancestors —
  merge-base checked); `contactVisibleToUserWhere` grepped in the running container
  (server.ts 10, inboundCallerMatch.ts 3, globalSearchRoutes.ts 2). 0 restarts.
- **worker** `done e0e1ef28` (`DEPLOY_FORCE_RESTART=1`, twice blocked by other sessions'
  heavy builds first); `tenantId, ownerUserId: null` grepped in the container. 0 restarts.
- **agent** rebuilt at `e0e1ef28` via `run-heavy.sh … up -d --build agent` after resetting
  the clone to origin; `clientUserId` + `owners.length === 1` grepped in the container;
  healthy, 0 restarts.
- **LIVE PROOF through the deployed code** (HS256 tokens minted inside `app-api-1`,
  `GET /contacts`):

  | user | status | stats.external | total |
  |---|---|---|---|
  | 101 relaxtires@gmail.com | 200 | **4,250** | 4,253 |
  | 102 Alex | 200 | **0** | 3 (the 3 extensions) |
  | 103 Felix | 200 | **0** | 3 |

  Assistant door `/internal/agent/contacts-info`: 101 → 4250, 102 → **0**, no user → **0**.
- ✅ Nothing to delete: 102/103 never OWNED any of 101's contacts — they were reading 101's
  rows. Those rows stay with 101. The phone app keeps contacts in memory only (no
  persisted query cache), so Alex's list empties on the next refresh/reopen.
- ⏳ **NOT PROVEN by a human:** nobody has opened the app on 102 since the deploy; no real
  inbound call to 102 from a number in 101's phone book has been placed to see the name
  NOT appear; no SMS→email or CRM path exercised live.
- ⏳ Behaviour change to tell customers about: a contact added on the portal Contacts page
  is now private to whoever added it. Companies that WANT a shared directory
  (most tenants' contacts come from one person; Ribit, A plus center and Trust have two
  creators each) would need a
  "share with company" switch, which is not built.

## 5. ⛔ Traps for the next agent

- ⛔ **Never read Contact / ContactPhone / ContactEmail without the owner rule.** Anything
  that puts a name or number in front of a person must use `contactVisibleToUserWhere`
  (or `ownerUserId: null` for machine paths). The guard test reads the callers' source.
- ⛔ `source` does not distinguish an import from a hand-typed contact — do not build
  logic on it.
- ⛔ A contact that is someone's private contact can not be enrolled into CRM (the import
  matcher and PATCH refuse it). If a customer wants a personal contact in CRM, that is a
  new, explicit "share with company" action — not built.
- ⛔ A deploy of `packages/db/prisma/schema.prisma` while another session has uncommitted
  schema edits: commit ONLY your hunks (private index + `git hash-object` of HEAD-plus-
  your-hunk), exactly as done here — the 10DLC `TextingRegistration` model was in the
  worktree, unmigrated.
