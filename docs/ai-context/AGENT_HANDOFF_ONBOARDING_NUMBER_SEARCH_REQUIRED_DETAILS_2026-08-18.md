# AGENT HANDOFF — a blank number search, a 911 address that belonged to somebody else, and a second "a plus center" (2026-08-18)

**Commit:** `7ab03778` on `feat/ivr-migration-takeover` (rebuilt onto origin with a
private index — see §9). **api DEPLOYED and container-verified** (`0b28b348`,
which carries it); **portal DEPLOYED**. No migration, no PBX write, no nginx
change, no env change, no tenant row edited, no E911 record changed.

Everything below started from one report — *"if they put in something that's not
available, nothing shows up"* — and one live submission,
**`cmsyuwds40w8sqo132jep3wlb`**, which turned out to be a recording of that exact
bug doing real damage.

---

## 1. What the customer actually experienced

The submission's own timeline, verbatim:

```
16:11:29  Searched numbers for "415 (starts)" — 0 results
16:11:45  Searched numbers for "718 (starts)" — 0 results
16:11:48  Stuck on "Your number" — the wizard said: Please pick a number from the list.
16:12:00  Searched numbers for "718 (starts)" — 0 results
16:12:30  Searched numbers for "718 (starts)" — 0 results
16:12:34  Stuck on "Your number" — ... Please pick a number from the list.
16:12:38  Stuck on "Your number" — ... Please pick a number from the list.
16:12:41  Stuck on "Your number" — ... Please pick a number from the list.
16:12:49  Searched numbers for "718 (starts)" — 0 results
16:13:06  Searched numbers for "646 (starts)" — 0 results
...
16:14:51  Searched numbers for "917 (starts)" — 0 results
16:15:20  Searched numbers for "347 (starts)" — 0 results
16:15:56  Searched numbers for "(blank) (starts)" — 10 results
16:15:57  Searched numbers for "929 (starts)" — 12 results
16:16:15  Reached "Extensions" after 155s on "Your number"
```

**Thirteen searches over five minutes across every New York area code, each one a
blank screen.** The only feedback on the page was the Continue button's *"Please
pick a number from the list."* They gave up and took a **929** number they had
not asked for.

⛔ **Nothing was broken.** VoIP.ms genuinely has no stock in 718 / 646 / 917 / 347.
Nobody told them.

---

## 2. Why it rendered nothing (three layers, all silent)

1. **The wizard had no empty branch.** The results grid is gated on
   `numbers.length > 0`; the only other branch was `numbersError`, which is set
   solely from a thrown request. A successful search returning `[]` rendered
   **nothing at all** — not a message, not an empty state.
2. **The API could not tell "found nothing" from "the search broke."** Both
   collapsed into `{ numbers: [] }`, because the provider call ended in
   `.catch(() => [])`.
3. **The provider turned a normal empty result into a thrown error.**
   `runSearch` treats any non-`success` status as a throw unless it matches
   `/no_did|no_number|not_found|no_result/`.

### ⛔ The live finding that ties it together: `unavailable_info`

Probed **read-only** against the real VoIP.ms API on 2026-08-18 (`searchDIDsUSA`,
no purchase, no write):

| query | type | status | rows |
|---|---|---|---|
| 305 | starts | `unavailable_info` | 0 |
| 212 | starts | `unavailable_info` | 0 |
| 786 | starts | `unavailable_info` | 0 |
| 555 | starts | `unavailable_info` | 0 |
| 999 | starts | `unavailable_info` | 0 |
| 311 | starts | `unavailable_info` | 0 |
| **845** | **starts** | **success** | **5000** |
| **562** | **starts** | **success** | 12 (after filtering) |
| **929** | **starts** | **success** | 12 |
| 98765 | contains | success | 254 |
| 1234 | ends | success | 87 |
| 00000 | ends | `unavailable_info` | 0 |

`unavailable_info` is VoIP.ms saying **"no stock for that query"** — not "the
search failed". It was being thrown, then swallowed, so **every sold-out area
code reached the browser looking exactly like a provider outage**, and the
browser had no branch for either.

⛔ **Do not "fix" this by retrying or by re-checking credentials.** 845 answering
5,000 rows in the same minute is the proof the account and the wire are fine.

---

## 3. What was changed

**`packages/integrations/src/index.ts`** — `unavailable_info` joins the
empty-result list instead of throwing.

**`apps/api/src/onboarding/publicRoutes.ts`** — a `searchFailed` flag replaces the
blanket `.catch(() => [])`; a genuine failure with nothing to show now answers
`{ numbers: [], error: "number_search_failed" }`. ⛔ The error is reported **only
when the list is empty** — if spares filled it, the failure cost the customer
nothing and must not raise a banner over good numbers.

**`apps/portal/lib/numberSearchMessage.ts`** (new) — the copy, as a pure function.

- 3 digits + "starts" → *"Area code 718 is not available right now. Try a
  different area code."* (a three-digit starts search **is** an area-code search
  and is worth naming as one)
- longer patterns → *"No numbers starting with / containing / ending in 4155 are
  available right now…"*
- blank → *"No numbers are available right now. Try searching for an area code,
  like 845."*
- toll-free and vanity get their own wording; a vanity word is quoted back.
- Every message ends with a next step. A test asserts that.

**`apps/portal/app/onboarding/[token]/page.tsx`** — new `numbersNone` state, kept
**separate from `numbersError`**, rendered in a real `.ob-num-empty` panel where
the grid would be.

⛔ **THE SPLIT IS THE POINT.** The endpoint answers **200 either way**, so the
**body** is the only thing that distinguishes an outage from empty stock. Saying
*"not available"* during a VoIP.ms outage tells a customer a perfectly buyable
number does not exist — the same class of lie as telling someone their 911
address is registered when it is not.

⛔ `.ob-num-empty` is deliberately **not** `.ob-field-hint` (12px muted). The
thing it replaces was a blank screen; a quieter font is the same bug.

---

## 4. The second half — how one person's address reached another company's 911

The same submission carried **company "a plus center", `izzywgg@gmail.com`,
`5622096644` and `13 koznitz rd, monroe NY 10950`** — Izzy's own test data — while
the extension it built was for a **real customer, Golda Moldavsky
(golda@cannvestments.com)**, who was sent a real invitation.

**The mechanism, confirmed against the code and the timeline:** two browsers were
open on the **same sign-up link** — the customer's, and Izzy's when he opened it
to see why the number search looked broken. The wizard autosaves into one shared
`answers` record per token, **last write wins**, and the fields the customer left
blank kept Izzy's values straight through her submit.

⛔ **A SECOND VISIT TO A LINK LEAVES NO TRACE, which is why the timeline reads as
one session.** `recordLinkOpened` (`journeyTracking.ts:52`) writes the "opened"
event **only when there is no prior one**, and logs a return visit **only if more
than 10 minutes** have passed. Both visits were inside that window. **Do not
conclude "only one person used this link" from a single opened event.**

⛔ **And the server would not have stopped it.** `publicSubmitSchema` had
`address`, `addressCity`, `addressState` and `addressZip` **every one of them
`.optional()`**, and `companyName` only `min(1)`. The wizard checked them in the
browser; nothing checked them at `/submit`.

### The gate

`apps/api/src/onboarding/requiredSignupDetails.ts` (new), called from `/submit`.

⛔ **It asks the SAME question `buildE911Address` will ask at provisioning time**,
so a sign-up cannot pass validation and then fail to register 911. It requires a
company name (at least 2 characters), a street line **containing a number**
(VoIP.ms answers `missing_street_number` otherwise), a city, a real state, and a
5-digit ZIP.

⛔ **Legacy one-line drafts still pass.** Drafts saved before the split fields
existed carry the whole address in `address`; `parseServiceAddressLine` reads it
and provisioning accepts it. Refusing those would turn an old-but-finishable
draft into a dead link.

---

## 5. ⛔ Found while building the gate: a street suffix was being registered as the STATE

`parseServiceAddressLine("30 Robert Pitt Dr")` returns
`{ address1: "30 Robert Pitt", state: "DR" }` — it reads the **"Dr"** as the
state and **cuts the suffix off the street name**. `buildE911Address`'s legacy
fallback fires on any truthy parsed state, so:

```
BEFORE: ok=true   state="DR"  street="30 Robert Pitt"
AFTER : ok=false  state=""    street="30 Robert Pitt Dr"
```

**`ok=true` is the dangerous part** — that is an address it would really have sent
to VoIP.ms for a live 911 registration. Same hazard for St / Ln / Rd / Ct / Pl.

Fixed with `isUsStateCode` in `e911Address.ts` (the real 50 states + DC +
territories + military codes); a parsed state is trusted only if it is one.
Explicit `addressState` values are unaffected.

---

## 6. Duplicate company names are numbered now

A second tenant named **"a plus center"** was created 2026-08-18 16:17:16Z beside
the real one from **2026-04-05**. Duplicate names are not cosmetic here:
`docs/agent-knowledge` filenames derive from the tenant name (so the second
tenant's document **overwrites** the first's — `buildSlugMap` already carries a
special case for exactly this), every name lookup becomes ambiguous, and the
tenant switcher shows two identical rows.

`apps/api/src/onboarding/uniqueTenantName.ts` (new): the newcomer becomes
**"a plus center 2"**, then 3, 4… **The first holder is never renamed** — changing
what an existing customer is called is worse than the duplicate.

⛔ **Both tenant-creation paths go through it** — `onboardingPayment.ts:89`
(checkout) and `setupOrchestrator.ts:296` (PBX build). Fixing one of two paths is
the recurring defect shape in this repo (two IVR publish paths, two invite paths,
two SMS ingest paths); a test reads **both** call sites' source.

⛔ Comparison is case-insensitive (the live rows were "A plus center" and
"a plus center") and **removed tenants still count** — a `pbxRemovedAt` tenant
still answers a name lookup.

---

## 7. ⛔ `ep3wlb` on the end of the PBX names is DELIBERATE — do not remove it

Izzy asked about `a plus center ep3wlb` / `344022_apluscep3wlb`. That tag is
`identitySuffix()` — the last 6 characters of the submission id — and it is the
**collision guard**, documented at the top of `provisioningIdentity.ts`:

> when every name is just the company name, the second sign-up ADOPTS the first
> customer's objects: its VoIP.ms subaccount password gets rotated (customer A
> loses dial tone and customer B's number lands in A's account) and B's
> extensions get built inside A's PBX tenant (cross-customer exposure).

**Today is exactly that case.** Two tenants are now called "a plus center";
without the suffix the August sign-up would have taken over the April customer's
VoIP.ms subaccount and PBX tenant.

It is load-bearing in three places, and **`pbxLabel` is one of them** —
`findPbxDirectoryEntry` (`setupOrchestrator.ts:220`) matches a tenant by
**slug OR displayName**, with the comment *"matching by company name here adopted
the wrong customer's tenant when two sign-ups shared a name."*

✅ **No customer ever sees it.** The Connect tenant is named from
`sub.companyName` (clean: "a plus center"), which is what the portal, emails and
invoices show. The suffix appears only in the **VitalPBX panel** and the
**VoIP.ms subaccount list** — staff surfaces.

**Removing it needs a different uniqueness key first. It is not a cosmetic
cleanup.**

---

## 8. Tests

| Suite | Result |
|---|---|
| `apps/portal/lib/numberSearchMessage.test.ts` (new, 15) | 15/15 |
| `apps/api/src/onboarding/requiredSignupDetails.test.ts` (new, 17) | 17/17 |
| apps/api onboarding suite | **280 / 280** |
| apps/portal `npm test` | 171 / 173 — the two pre-existing (`campaignsIndexLayout`, `webrtcSdpDiagnostics`) |
| portal typecheck | **0 errors** |
| apps/api typecheck | 76 total, **0 in any edited file** |

⛔ **Proven non-vacuous**, replayed against the pre-change blobs from `HEAD`:
**all five portal source guards fail**, **all four api source guards fail**, and
the old `buildE911Address` is shown returning `state: "DR"` where the new one
refuses.

⛔ Both new test files are **registered** — portal in its explicit `test` script,
api via the existing `src/**/*.test.ts` glob.

⛔ **Run apps/api tests with the module-mocks flag** or every `mock.module` file
dies with `mock.module is not a function` and reads as a mass regression:
`node --experimental-test-module-mocks --import tsx --test src/onboarding/*.test.ts`

⛔ **`setupOrchestrator.test.ts`'s tenant double needed a real `findFirst`.** It
was added rather than making `uniqueTenantName` tolerant of a missing accessor —
a forgiving helper plus an agreeing mock is exactly how the
`billingTenantSettings` transposition shipped green for six days.

---

## 9. Committing this in a shared tree

⛔ HEAD moved **three times** while this was being built, another session had a
large **MFA changeset staged in the shared index**, and `apps/portal/package.json`
was contested — their broad `git add` had already swept this session's one-line
test registration into `8818cadf`.

What was done, and why each step:

1. `git commit -F - -- <13 explicit paths>` — the pathspec makes the rest of the
   index irrelevant, so their staged MFA work could not be swept in. Verified
   afterwards: the commit holds exactly 13 files and their staging survived.
2. Origin had diverged (they rebased). A plain push would have published **their
   unpushed MFA commit** and a duplicate voicemail commit.
3. So the commit was **rebuilt onto `origin/…` with a private index**
   (`GIT_INDEX_FILE` + `read-tree origin` + `update-index` of only these 13 blobs
   + `commit-tree` + push the resulting SHA directly to the branch ref). **This
   touched no working-tree file**, which matters because upstream's changes
   overlapped files other sessions had dirty (`server.ts`, `loginRequest.ts`,
   `CLAUDE.md`).

⛔ **Two stale deploy waiters are sitting on loopcom** (PIDs 1873319 and 2429874,
13h and 5.5h old). **Neither can ever fire** — each polls with a pattern that
matches **its own `ps` line**, the self-match trap CLAUDE.md already records for
`pgrep -f`. Harmless, but they should be killed.

⛔ A foreground `deploy-direct.sh` over ssh **survived two connection resets** here
(the process kept running). Don't re-fire a deploy after a dropped ssh — check
`ps` for it first.

---

## 10. ⏳ NOT PROVEN — and the live items that still need Izzy

⏳ **Nobody has run a sign-up through the new screen.** All of it is proven by 32
tests, the non-vacuity replay, container greps and a live read-only API probe —
**not** by a human watching the message appear.

**Acceptance test (5 minutes, no card needed):** open a sign-up link, go to the
number step, search **718** — it must now say *"Area code 718 is not available
right now. Try a different area code."* instead of nothing. Then search **845**
and confirm numbers still appear. Then, at the Review step, blank the company
name and submit — the server must refuse with a plain-English reason.

### ⛔ Live items deliberately NOT changed — they need Izzy's decision

1. **E911 for (929) 852-4026 is registered at `13 koznitz rd, Monroe NY 10950`**,
   status `provisioned`, and the PBX emergency location carries it. **Dial 911
   from that account today and dispatch is sent to that address.** Correcting it
   is a billable, safety-critical write (`e911Update`) and needs the real
   Cannvestments service address.
2. **The tenant is named "a plus center"** (`cmsyv8mlb0yheqo13t7u7x1fe`), a
   duplicate of the real April customer. Renaming is a live-customer write.
3. **Golda Moldavsky received a real invitation** to an account named after
   another company.
4. **$45 was really charged**, and the "your E911 is set" email went to
   `izzywgg@gmail.com`.

### ⏳ Known gap this does not close

**Two browsers on one sign-up link still share one `answers` record, last write
wins.** The submit gate now stops a *blank* field inheriting someone else's
value, but two people who both fill a field in still overwrite each other. A real
fix means either per-visitor drafts or a "this link is already open elsewhere"
warning. **Not built — it is a product decision.**
