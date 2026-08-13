# AGENT HANDOFF — billing looked wrong because it ignored the app's theme, and 22 tenants deleted on the PBX were still alive in Connect (2026-08-12)

Commit `438a5e2e` on `feat/ivr-migration-takeover`. **api + portal DEPLOYED and
container-verified**, including a database migration. The first tenant sweep was
run live with Izzy's explicit go-ahead: **21 companies closed out, none erased.**

---

## 1. Why billing "didn't look right" — it was never following Connect

`.cbill` carried its own private palette and switched it on
`@media (prefers-color-scheme: dark)`. That is the **operating system's**
setting. Connect's theme comes from a user preference written to
`<html data-theme="light|dark">` by `useAppContext.tsx:390`.

So the two only agreed by luck. Proven live in Izzy's browser: with the app
flipped to dark, the sidebar and top bar went dark while the whole billing area
stayed a **white slab**, and the "This month" heading turned dark-on-dark and
disappeared. His OS happened to be light, so he had never seen the dark half —
he was seeing the *other* symptom, a section that simply didn't match.

⛔ **THE RULE: never give a section its own palette.** Everything structural now
aliases the app's tokens (`--panel`, `--panel-2`, `--text`, `--text-dim`,
`--border`, `--accent`, `--success`, `--warning`, `--danger`), so billing follows
the toggle for free and cannot drift again.

⛔ **Connect's convention is that bare `:root` is DARK and light is opt-in.** The
dark overrides are therefore written `:root:not([data-theme="light"]) .cbill`,
not `[data-theme="dark"]`, so the first paint is correct before hydration stamps
the attribute.

The one thing still set by hand is **status text colour**. The app's raw
`--success` (#22c55e) and `--warning` (#f59e0b) are display colours and fail
contrast as 11px pill text on white. Those are tuned per theme; the soft
background fills still alias the app's hues via `color-mix`.

## 2. Screens that were stating things that were not true

- **Every failed payment read "Customer — payment failed."** Six identical rows
  on the two most important screens, naming nobody. `/admin/billing/overview`
  does not carry the tenant name in `recentFailures`. No API change was needed —
  the tenant list is already loaded on the same page; both screens now join
  against it.
- ⛔ **The billing-day column was calling unconfigured accounts healthy.** A
  tenant with no `billingSettings` row reported day `0`, and `ordinal(0)` does
  `Number(n) || 1` → "1st". So **19 accounts with no billing setup at all** drew
  a calm, unstyled "1st" while **15 genuine day-1 accounts** got a red pill. The
  banner said 15; the truth was 34. `billingDayOf()` now lives at module scope
  and returns `null` for absent — **never infer a date from a falsy value.**
- **`JSON.stringify(r.totals).slice(0, 120)`** was printed on the front page —
  five identical truncated records, cut mid-word, from an hourly sweep that
  almost always has nothing to do. Now `runOutcome()` → "7 invoices created" /
  "Nothing was due".
- **The customer page said "Unsaved changes" on arrival.** `dirty` ended
  `|| savedAt === ""` and `savedAt` starts empty, so "No changes" was
  unreachable. It now compares a snapshot taken once the load settles, and the
  metadata-backed fields are part of that comparison (they never were).
- ⛔ **Three controls on the customer page were decorative.** Timezone, 911 fee
  and regulatory fee were rendered as live inputs, marked the page dirty, and
  were dropped on save. **Two separate server-side gaps caused it:**
  `billingTimeZone` was **not in the PUT's zod schema at all** (zod strips
  unknown keys silently), and `per_phone_number` was **missing from the fee
  `basis` enum** while being a perfectly valid basis everywhere else — and the
  exact one onboarding stamps for E911, because `per_did` counts only *billable*
  numbers (zero for a one-number tenant on first-number-free). Both fixed.
  ⛔ `billingTimeZone` must be **destructured out** of the route input: `...pricing`
  is spread straight into the Prisma upsert and it is not a column.
  ⛔ The fee validator requires the **whole item** (`enabled`, `customerVisible`,
  `label`, `mode`, `amountCents`, `basis`) — a partial object 400s and takes the
  entire save down with it.
- **"Needs you" ran 57 rows over 6.5 screens**, with the least urgent group (33
  missing billing emails) the longest and burying the six real failures above
  it. Long groups now arrive folded with counts; the tab carries the number.
- **Refunds ran through `window.confirm` + `window.prompt`** — real money, in an
  unstyled box that cannot bold the customer's name and that browsers suppress
  after repeated use. Now an in-page `<dialog>`. There was also **no destructive
  button style at all**, so "Refund" looked identical to "Cancel".
- **Nav was plain `<a href>`**, reloading the entire portal on every tab click.
  Now `next/link`. This was most of why the section felt bolted on.

Also: real search inputs instead of the reused right-aligned money field;
"Showing 57 of 57" filler tiles dropped; Catalog's eleven identical buttons
grouped into view / download / old-screen (the last five jump into the legacy
nine-tab chrome, now labelled); payment rows reachable by keyboard.

## 3. Tenants deleted on the PBX stayed alive in Connect

⛔ **Deleting a tenant on VitalPBX did exactly one thing in Connect** — the
`PbxTenantDirectory` row disappeared on the next sync (`pbxTenantDirectorySync.ts`
already pruned it). The Connect `Tenant` survived with its users, extensions,
numbers, call history, voicemail, contacts, chats, billing settings and
invoices; and its `TenantPbxLink` stayed **`LINKED`**, still pointing at a PBX
tenant id that no longer existed. Only a human clicking unlink ever changed it.

**Measured live (SSH, read-only):** 28 live PBX tenants (`ombu_tenants` on
209.145.60.79) vs **50 Connect tenants** → **22 ghosts** holding **22 user
accounts that could still sign in**. That is the whole reason billing counted 50
while the sidebar counted 28: `/admin/billing/platform/tenants` had
**no `where` clause at all**, while `/admin/tenant-options` has always filtered.

### The rule Izzy set

> Gone from the PBX → delete everything. Unless real money moved, in which case
> the billing records stay.

Built exactly that, with the PBX check first. ⛔ **The PBX check is doing the
real work; the money rule is the second lock, not the first** — Relax Tires,
RSBK and Fixup Group all have zero billing history and are real live customers.
They are safe only because they are still on the PBX (T25, T34, T31).

### Safety rails (`apps/api/src/pbxOrphanTenantSweep.ts`)

The trigger is a list fetched from the PBX, and a short list makes live
customers look deleted. So:

1. **Only tenants whose link points at a now-absent PBX tenant.** A
   never-linked tenant was never on the PBX, so this never happened to it. This
   is what keeps the second, never-linked **Connect Communications** (2 users, 1
   unpaid invoice, 1 saved card) out of the sweep — it needs a human decision.
2. **`isPbxAnswerHealthy()`** refuses an empty answer, and refuses any answer
   that lost more than half the known estate (the shape of a paginated or
   permission-filtered response).
3. **`MAX_AUTO_REMOVALS = 3`.** More than that in one pass does nothing and
   waits for a person. A sweep wanting to remove twenty companies is a bug
   until proven otherwise.
4. **Marking removed destroys nothing.** `pbxRemovedAt` + `isApproved: false` +
   `autoBillingEnabled: false` + link `UNLINKED`. Fully reversible.
5. **The erase is a separate confirmed call**, one tenant at a time, that
   **re-reads the money at the moment of deletion** rather than trusting the
   flag written by an earlier pass.

⛔ **`ConnectChatThread` was the only tenant relation in the schema without
`onDelete`**, so it defaulted to `Restrict` — one chat thread would have made
`tenant.delete()` fail with a foreign-key error. Every other tenant relation
(240 of them) cascades. Fixed in migration `20260808120000_tenant_pbx_removal`,
verified live (`confdeltype = 'c'`).

### What actually happened when it ran

Screen is **`/admin/pbx/removed-tenants`**. It found **21**, not 22 — the
never-linked Connect Communications correctly excluded. The over-cap banner
fired and it refused to act unattended. Izzy gave the word; all 21 were closed
out. **None erased.**

| | before | after |
|---|---|---|
| Companies in billing | 50 | **29** |
| Missing a card | 32 | **11** |
| No real billing day | 34 | **13** |
| "Needs you" items | 57 | **30** |

The 21: T47 Agent · T43 Sam's Cupcakes · T53 ploly · T45 KJFD · T27 Iniimini ·
T22 Slim Business Funding Group · T42 Bob's Plumbing · T41 Sam's Plumbing ·
T17 Actual Home Care · T33 R Shmial Binyuman · T30 Ribit Capital · T44 Agent ·
T38 rghyeazyhg · T61 Ezra store 8 · T36 agent test · T16 Carirent ·
T40 robot test · T46 KJFD · T59 Ezra store 6 · T56 Ezra's Store 2 ·
T48 j&j PLumbing. All zero invoices, zero cards, zero completed payments.

⛔ **Ezra stress test 1 (T101) and Loopcom Demo (T102) are still ON the PBX**, so
the rule correctly left them in Connect. Delete them on the PBX and the sweep
picks them up automatically next refresh (two is under the cap, so no screen
needed). "Connect" (T1) is VitalPBX's own system tenant appearing as a customer.

## 4. Environment notes

- **SSH works straight from the Bash tool here** (Git Bash), no sandbox hop:
  `install -m 600 .connect-ssh/connect2_server2_ed25519 /tmp/pbx_key` then
  `ssh -i /tmp/pbx_key -o IdentitiesOnly=yes root@209.145.60.79`. Same shape for
  loopcom with `connect2_ed25519`. **`git push` also works directly** from here —
  the bundle route was not needed.
- PBX tenant list: `mysql ombutel -N -B -e "select tenant_id, name, description,
  enabled from ombu_tenants"`. ⛔ The table is **`ombu_tenants`**, not `tenants`,
  and its key column is **`tenant_id`**, not `id`.
- ⛔ Deploy enqueue field is **`service`**, not `target` — `target` answers
  `invalid_service` with the allowed list, which reads like a broken route.
- ⛔ `PbxInstance` filters on **`isEnabled`**, not `enabled`.
- `apps/api` has **72 pre-existing typecheck errors** (Timeout/number lib
  mismatch, ops/, delivery/). This work adds none. `apps/portal` is clean.
  Billing suite: **408 pass, 0 fail** via
  `node --experimental-test-module-mocks --import tsx --test src/billing/*.test.ts`.
- `apps/portal/tsconfig.tsbuildinfo` is tracked and dirtied by `tsc` — restore
  it before committing.
- `docs/` is **gitignored**; this file needs `git add -f`.

## 5. Not yet proven

- ⏳ **No tenant has been permanently erased.** The delete path is proven by
  tests and by its guards, never by use. Do the first one watched.
- ⏳ **The customer page's save has not been exercised against a real customer.**
  The timezone and the two fees should stick now; change one and reload before
  trusting it.
- ⏳ **The sweep has never run unattended.** Every run so far has been over the
  cap and therefore hand-confirmed. The first automatic one will be whenever a
  single tenant is next deleted on the PBX.
- The 21 closed-out tenants are stamped `pbxRemovedAt = 2026-08-09T05:48Z`,
  which is when the confirm ran; all container and database clocks were verified
  correct and hourly billing runs are current. Noted only so the date is not
  mistaken for a clock fault.
