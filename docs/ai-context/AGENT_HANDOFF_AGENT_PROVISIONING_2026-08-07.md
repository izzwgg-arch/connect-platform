# AGENT HANDOFF — the assistant can add billable things (2026-08-07)

An admin can now tell the assistant *"I want to add an extension"*, *"activate
SMS"*, or *"I want another phone number"*, and it happens end to end: the agent
quotes the account's real price, asks the questions, and after the admin
re-enters **their own account password** the thing is created and next month's
invoice reflects it.

**Deployed and container-verified**: api `e338d0ab`, portal (price line
grep-verified inside the live `.next`), agent rebuilt (manual compose — the
agent is not in the deploy queue). Commits `4badbf06` → `c6f60f99` →
`c8041a4b` → `8bf17ab2` → `e338d0ab` on `feat/ivr-migration-takeover`.

⏳ **Never walked in a browser.** Every hop is proven with live data (agent
container → api door → invoice engine → real prices for a real tenant), but no
human has had the conversation and watched an extension appear. Acceptance test
in §8.

---

## 1. ⛔ THE BILLING RULE — read this before adding any "charge them" step

**Next month's invoice does not store quantities. It recounts them live every
cycle** — `resolveBillingQuantities` → `calculateTenantBillingUsage` reads
Extension rows, PhoneNumber rows and the SMS flag at the moment the invoice is
built.

**So creating the extension IS the billing update.** Code that also adds a line,
bumps a counter, or writes a charge would bill the customer **twice** for one
extension. This was the single biggest finding of the engagement and it inverted
the obvious design.

What was actually missing is *proof the money moved*.
`apps/api/src/agentProvisioning/billingReconcile.ts` snapshots the monthly total
**before**, provisions, snapshots **after**, and refuses to report success if it
did not rise.

### The three ways a real thing is silently free

All three were live; all three are now closed.

1. **A manual quantity override.** The tenant is pinned to a frozen number, so
   usage moves and the invoice never does. `reconcileBillingAfterAddition` bumps
   the override by one. ⛔ It never silently switches them back to `auto` —
   someone chose manual deliberately and it may hold a negotiated quantity.
2. **An extension number that is not EXACTLY three digits.** Usage counts
   billable extensions with `/^\d{3}$/`, so a 2- or 4-digit line works on the
   phone and is charged nothing. Refused at parse time now
   (`isBillableExtensionNumber` in `@connect/shared`). Same family as the 1-digit
   bug that made extensions invisible platform-wide.
3. **A phone number that never lands in the `phoneNumber` table.** The plan's
   per-number line counts that table; onboarding DIDs live only in
   `PbxTenantInboundDid`. See §6 — this one is **still open as a fleet-wide
   undercharge.**

### ⛔ Prices come from the tenant, never the sign-up constants

`resolveTenantBillingPricing` gives the effective `extensionPriceCents` /
`smsPriceCents` / `additionalPhoneNumberPriceCents` for **that** account. The
`ONBOARDING_PRICES` constants ($30 an extension, $10 texting) are what a NEW
customer is quoted; an existing account may be on a different plan or a
negotiated rate. Quoting a figure their invoice then contradicts is the one
billing mistake customers never forget.

The agent has **no price constants of its own** — it reads them over
`/internal/agent/account-setup-info`.

---

## 2. Architecture — one set of gates, four capabilities

`apps/api/src/agentConfirmations.ts` owns everything security-relevant, once:
the password check, the single-use atomic claim, the params hash, tenant
scoping, rate limiting and audit. Capabilities plug in through
`ConfirmCapability`.

⛔ **Adding a capability must never mean restating a gate.** If you find
yourself re-checking a password or re-writing the claim, you are in the wrong
file.

Registered in `agentGrantRoutes.ts`:

| capability | id | work |
|---|---|---|
| permission grant | `action.grant_permission` | DB only |
| add extension | `action.add_extension` | PBX + email |
| enable SMS | `action.enable_sms` | VoIP.ms |
| add phone number | `action.add_phone_number` | VoIP.ms + PBX panel |

### ⛔ `transactional` is a real distinction, not a style choice

- **`true`** — pure DB. Claim and work share one transaction, so a failure rolls
  the approval back and the customer simply tries again.
- **`false`** — reaches the PBX, a carrier, or an email queue. The approval is
  claimed FIRST (status `EXECUTING`) and **stays spent on failure**, because
  re-running half a purchase is worse than not finishing it.

⛔ A capability in the external path that refuses with its own message MUST keep
it. Out there the work is half-done by definition, and *"extension 105 was
created, but the welcome email couldn't be set up — finish adding them under
Users"* is the entire value. An early version swallowed that into a generic
"something went wrong", which hides a half-built state someone has to clean up.

### ⛔ Provisioning REPLAYS real routes, it does not reimplement them

Adding an extension injects `POST /pbx/extensions` then `POST /admin/users`,
signed as the admin who actually confirmed. So the PBX work, the SIP device, the
invite token, the welcome email with the APK link and the audit rows are
byte-identical to a human clicking the same buttons — and a fix to those paths
reaches this one for free.

⛔ **`POST /pbx/extensions` stamps `ownerUserId` with whoever created it, and
`POST /admin/users` then refuses that extension** (409
`extension_already_assigned`). The capability hands ownership back in between.
Leaving it set is also exactly the state that makes PBX sync skip an extension
forever (see `pbx-sync-skips-owned-extensions`).

### The password never touches the agent

The agent writes a DRAFT `AgentAction` and nothing more. The password goes to
`/api/admin/agent-confirmations/:id/apply` and **never** `/agent-api/*` —
anything the agent receives passes through a language model, a transcript and an
audit log. The dialog shows a summary **rebuilt from the verified params**, not
stored prose, so what the admin reads is what the API will act on.

---

## 3. ⛔ Every new `/internal/agent/*` door must be added to the JWT bypass

**This has now shipped broken twice.** The global JWT preHandler runs *before*
routing, so a door missing from `shouldSkipJwtVerification` answers **401** and
its own shared-secret check never runs. The agent then reports a vague "I
couldn't retrieve that right now" forever, and nothing in the api logs looks
wrong.

- First time: `account-setup-info` — blocked the trainer's extension request in
  production.
- Second time: `search-phone-numbers` — caught here only by **probing the live
  route**, not by reading code.

**⛔ Tell them apart by the status: 403 means the handler ran. 401 means you
never reached it.**

Guard: `apps/api/src/agentProvisioning/internalDoorBypass.test.ts` reads the
route module's **source**, extracts every path it registers, and asserts each is
bypassed in both the bare and `/api`-prefixed spellings. A unit test of the door
itself passes straight through this defect — the bug is in the list, not the
handler. It also asserts the list stays a **list**: a blanket `/internal/agent/*`
prefix would open every future door before anyone reviewed it.

---

## 4. Turning texting on — what the runbook corrected

Built against `AGENT_HANDOFF_SMS_ACTIVATION_2026-08-07.md`, which caught a real
error mid-build:

- ⛔ **`tenant.smsSendMode` stays `TEST`.** An earlier version of this capability
  flipped it to `LIVE`. LIVE belongs to the old SMS-campaign path, which reads
  the `phoneNumber` table and 10DLC approval — onboarding tenants have zero rows
  there, so flipping it would demand a sender number that does not exist and
  break campaign sends **without helping texting**.
- `TenantBillingSettings.smsBillingEnabled = true` is the whole billing switch
  (proven live: inii mini's next invoice moved $35 → $45).
- ⛔ Most `TenantSmsNumber` rows sit **unclaimed** (`tenantId: null`). A company
  that has never texted usually has no row of its own, so `findTextableNumber`
  falls back to the company's own DIDs and claims a matching row — **only ever a
  `tenantId: null` one**, because claiming another company's row would hand them
  someone else's texts.
- `isTenantDefault` is the real "text from this number" setting;
  `defaultSmsFromNumberId` stays null and `smsPrimaryProvider` stays TWILIO.

---

## 5. Buying a phone number — the strictest capability

It is the only one that spends money outside Connect.

- **Stock first.** The master VoIP.ms account holds dozens of already-purchased
  spare DIDs; handing one out costs nothing new. A fresh `orderDID` only happens
  when there is no suitable spare — the rule onboarding already follows.
- **A number that does not RING is worse than no number**, so the PBX inbound
  route is part of the operation, not a follow-up. It reuses onboarding's
  `createInboundRoute` through the **same single robot-account pool**
  (`acquireAccount`/`releaseAccount`, now exported), so two provisioning jobs can
  never drive one panel login at once.
- If the route fails, the refusal **names the number** — someone has to finish it
  by hand and a vague error would lose it.
- **Refuses outright** for accounts with no VoIP.ms subaccount (only the sign-up
  flow creates one). Older hand-built tenants go to a human rather than being
  half-provisioned. ⛔ The refusal deliberately names none of our plumbing.
- **Toll-free is rejected at `parseParams`** — $15 and a different purchase
  method, so letting one through as "local" would undercharge.

---

## 6. ⛔ OPEN — the additional-number fee is not being charged on 11 of 29 tenants

Found by probing the live door with a real tenant. inii mini has **two** phone
numbers, and the door reported `additionalNumberPrice: $0.00,
firstNumberFree: true` — so the assistant would have told a company with two
numbers that their next one was free, then bought it.

**Cause:** the plan's per-number line counts `phoneNumber` rows, but accounts the
sign-up flow built have their DIDs only in `PbxTenantInboundDid`. The engine
therefore believes they have **no numbers at all**.

**Scope, measured 2026-08-07: 11 of 29 live tenants.** inii mini's $48 is one
extension + texting + fees + E911 for two numbers, with **no $10 second-number
line**. (E911 is unaffected — that fee already uses `max(table total, active PBX
DIDs)`.)

**What shipped:** `isNumberBillingTrustworthy` refuses to add a number when the
real DID count exceeds the billed count, and the pricing door now judges "your
first number is included" against the numbers the company **actually** has.
Verified live after deploy: inii mini now reads `$10.00 / firstNumberFree:
false`.

⛔ **Deliberately NOT fixed: the underlying count.** Backfilling `phoneNumber`
rows would start billing 11 customers for numbers they have had for months. That
is a decision for a human, not a side effect of shipping a chat feature. **This
is the top open item.**

---

## 7. Traps that cost time here

- ⛔ **The shared working tree.** Commits `9f181e39`/`a81fbc48`/`4badbf06` were
  absorbed into another session's commit and orphaned; the branch history was
  rebuilt around them. Stage explicit paths, never `git add -A`, and re-check
  `git log` before claiming a commit is yours. Their edits also **fixed a real
  bug of mine** — `db.billingTenantSettings` where the Prisma model is
  `tenantBillingSettings`, which would have thrown on the first SMS activation.
- ⛔ **A deployed container is not proof of intent.** This work reached
  production before it was finished, swept in by another session's deploy. Check
  `docker inspect` for bind mounts before concluding whether source files in a
  container are actually running: `/app` here is **baked**, not mounted.
- Billing is **injected** into capabilities (`ConfirmDeps.billing`) so tests
  never stand up the invoice engine; `defaultBillingDeps` is the one place the
  real engine is wired in.
- New test dirs need adding to the apps/api `test` glob —
  `src/agentProvisioning/*.test.ts` was invisible to `npm test` until added.

---

## 8. Acceptance test — do this before trusting it with a customer

1. In the portal chat as an admin: *"I want to add an extension."*
2. The assistant should quote **that account's** price and ask for the number,
   name and email. Give it a free three-digit number.
3. The password dialog should appear **with the price on it**.
4. Confirm. Expect: the extension exists, a welcome email arrives, and the reply
   states the new monthly total.
5. Check next month's invoice preview moved by exactly the quoted amount.
6. Repeat once with a deliberately wrong password — nothing should be created.

Then the same for texting. For a number, pick a tenant whose `phoneNumber` rows
match their real DIDs, or it will (correctly) refuse.

---

## 9. Also in this engagement

- **Permission-grant-by-chat** (§7 of `PLAN_SELF_IMPROVING_CONNECT_2026-08-06.md`)
  was completed and became the first capability on the shared core. Its 43 stress
  tests pass unchanged through the refactor, which is what makes the refactor
  safe to believe.
- **The price line on the confirmation dialog** — before this, admins typed a
  password into a screen that never stated the charge.
- ⚠️ **7 tests are red on the branch and are not from this work** —
  `pbxTenantDirectorySync`, failing `db.pbxTenantDirectory.count is not a
  function`. Another session's module.
