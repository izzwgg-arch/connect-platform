# AGENT HANDOFF — overdue-account service interruption, and native emergency calling (2026-08-17)

**Status (2026-08-18): the whole overdue-account cutoff is WIRED END TO END —
`2c8cc04e` — sweep timer, admin routes, inbound busy in the doorway (helper
`2026.08.18.1` installed), onboarding hook, portal card. Cutover set in
`.env.platform` at `2026-08-18T12:01:07Z`. api deploy queued as job
`7771b6cf`; see §10 for what is and is not proven.**

Commits on `feat/ivr-migration-takeover`: `c7c1df00`, `8671b2f0`, `b8e5bf1c`.
69 tests, registered in the api test script.

---

## 1. What the owner asked for

A per-tenant switch: when a payment fails, remind the customer daily for seven
days, then interrupt service until they pay, then restore automatically.

- Inbound: the call reaches the Connect doorway and gets a **busy signal** —
  not the IVR, and never dead air.
- Outbound: **deactivate every outbound route**; if they have several,
  deactivate all of them. Reactivate on payment.
- ⛔ **911 and 845-783-1212 (local EMS and fire) must keep working.**
- Emails approved 2026-08-17: banner with days left, one sentence, the amount,
  the button. Deliberately short — do not pad them back out.

## 2. ⛔⛔ THE TRAP: those two instructions cancel each other out

911 leaves the building **through an outbound route**. "Deactivate all the
outbound routes" therefore silently disconnects emergency calling for a
customer who is merely late paying a phone bill.

**Resolved by using VitalPBX's native emergency feature, which bypasses route
selection entirely.** Proven by reading the live dialplan
(`extensions__50-8-dialplan.conf`, context `T8_cos-all-init`):

```
NoOp(Check if is an Emergency Call)
GotoIf(DIALPLAN_EXISTS(T8_emergency-calls,${EXTENSION},1)=1 ? T8_emergency-calls)
...
Set(OUTBOUND_PROFILE=${DB(.../outbound_profile)})
GotoIf(OUTBOUND_PROFILE="disabled" ? post-dialing)
```

The emergency check runs **before** `OUTBOUND_PROFILE` is read. So configured
emergency numbers survive every outbound route being off, and survive the
extension's profile being set to `disabled`.

⛔ **An earlier design in this same session built a custom `connect-emergency-only`
outbound route per customer. It is superseded — do not resurrect it.**
`serviceInterruptionPlan.ts` still carries that shape and needs simplifying now
that the native path is proven.

## 3. What is LIVE on the PBX (two writes, both under an explicit mandate)

### 3a. A panel permission was changed
The automation account **`lOOPCOMAGENT7548`** (user 45, role 9 "LOOPCOM AGENT")
was denied both emergency modules — every field read returned
*"You don't have access"*. Granted **view/add/edit** (not delete) on:

| module_id | name |
|---|---|
| 119 | `emergency_numbers` |
| 138 | `emergency_locations` |

Applied from a file on the PBX (`/root/grant-emergency-20260817.sql`, log
beside it). Verified: role 9 still has **134** privilege rows total, and roles
1/4/5/6 (which already had access) were untouched.
**Rollback** is the commented block at the bottom of that .sql.

### 3b. Emergency calling configured for two tenants
Owner's instruction: Matamim and inii mini now; all future clients through
onboarding; the other 27 later, when he has their addresses.

| | Matamim (T104) | inii mini (T105) |
|---|---|---|
| tenant path | `4de9a88870cd2add` | `4982a063ce6b75a8` |
| address | 15 Van Buren Dr, Monroe, NY 10950 | 16 Depalma Dr, Highland Mills, NY 10930 |
| presents | `9293598299` | `6469846023` |
| trunk | 129 | 130 |
| notifies | izzywgg@gmail.com + office@matamimweekly.com | izzywgg@gmail.com + sales@iniimini.com |

Both carry **911** and **8457831212**. Verified by reading the database, not
by trusting the panel's response. `emergency locations on other tenants: 0`.

⛔ **`izzywgg@gmail.com` was read from the database, not assumed** — the
session context showed `izzywkg@gmail.com`, one letter different. Check it.

## 4. ✅ RENDERED AND LIVE — and the apply DID wipe a doorway

Applied per tenant. ⛔ **The tenant cookie must be set before Apply Changes** —
a first attempt fired it in the robot's home tenant, returned `success` in
0.7 s and regenerated **nothing** (no file mtime moved). `setTenant(path)`
first, then `applyChanges`.

Confirmed in Asterisk, not just on disk (`dialplan show T104_emergency-calls`):

```
'_8457831212' => NoOp(Emergency Call to: Local EMS and fire department)
                 ...
                 System(... NotifyEmergencyCall ... "izzywgg@gmail.com,office@matamimweekly.com" ...)
                 Gosub(trk-129,${EXTEN},1(from-trk-grp))
```

⛔ **`Gosub(trk-<id>)` is the whole point** — it goes straight to the trunk. No
outbound route, no ARS, no class of service. That is why the overdue cutoff can
switch every outbound route off and 911 still leaves the building.

✅ **THE DOORWAY WIPE IS REAL, NOT THEORETICAL — it happened here and was
caught.** Applying in inii mini's context produced:

```
WARN [APPLY_REBAKE] Apply Changes had wiped this number's doorway routing —
re-baked {"e164":"+6469846023","changed":1}
```

`rebakeConnectRoutesAfterRegen` repaired it inside the same 2.4 s run.
⛔ **It only repairs numbers Connect tracks.** inii mini has TWO doorway routes;
the second (8452605692, the retired temp) was left wiped and was healed by the
drift reconciler ~40 s later. Verified back to baseline afterwards:
T2 1 doorway/0 dead-air, T35 1/0, T105 **2/0**.
⛔ **So the apply must be fired per tenant with the re-bake immediately after,
and the doorway counts checked before AND after** — a count taken 30 s after
the apply can read mid-repair and look like an outage that is already healing.

⏳ **NOT PROVEN: nobody has dialled 911 from either tenant**, and no
notification email has been received. That is the acceptance test, and it
should be done with the carrier warned or by dialling 8457831212 rather than
911 so nobody wastes a dispatcher's time.

## 5. Facts worth keeping

- `ombu_tenant_settings(name='outbound_profiles').value` → `ombu_ars.ars_id`.
  ⛔ **NOT `ombu_ars.tenant_id`** — every real ARS row and every outbound route
  lives under `tenant_id 1`. A first attempt joined on tenant_id and concluded
  26 customers had no outbound routes, which is absurd on its face: they make
  calls all day. **If a query says most of the fleet is broken, the query is.**
- `ombu_ars_members.sort` is the ordering column — "last on the bottom" is real.
- **Several customers run multiple businesses off one account**, each an
  outbound profile with its own caller ID: Trust Bookkeepings **9**,
  A plus center 4, Displaydex 3, Secro 2. Anything per-customer must be
  per-profile or it misses most of their extensions.
- ⛔ **Four customers' first profile carries another company's caller ID** —
  Displaydex→"Nexus Realty", Trust→"Avenue Filing", RSBK→"Rebbe", and
  Landau Home→`8455577768`, a number that was taken off them. Inheriting a
  caller ID by position would have sent dispatch to the wrong address.
- `states.id` **3956** = New York; `country_id` **231** = United States.
- The api's MySQL user is **`connect_read`** — writes fail. PBX writes must run
  on the PBX itself, from a file (`mysql < file.sql`).
- `ombu_emergency_trunks` is the "merge the trunk" step and is part of the
  `emergency_numbers` category form (`trunks[]`), not a separate module.

## 6. What remains

1. Prove a real emergency call — dial **8457831212** (not 911) from a Matamim
   extension and confirm it goes out on trunk 129 and the email arrives.
2. Simplify `serviceInterruptionPlan.ts` — drop the custom-route carve-out.
3. Wire emergency setup into `onboarding/pbxTenantBuild.ts` so every new
   customer gets it. ⛔ Use the **sweep** pattern, not a creation hook: five
   code paths create a tenant.
4. Build the per-tenant switch, the daily sweep, and the reconnect-on-payment
   hook. None of these exist yet — only the pure policy and plan do.
5. The other 27 customers, once the owner has their addresses.

## 7. The cutoff lever, and the one thing still unknown (2026-08-17, later)

✅ **THE LEVER IS `ombu_ars_members.enabled`, NOT THE ROUTE.**
`ombu_outbound_routes` has **no enabled column**. A route can also be
referenced by more than one tenant's selection, so switching the ROUTE off
could take out somebody else. Disabling the tenant's ARS *members* is
per-tenant, per-profile and precisely reversible. Built and tested in
`serviceInterruptionPlan.ts` (67 tests across the module).

⛔⛔ **`members[N][enabled]` IS A CHECKBOX. To disable, OMIT THE FIELD.**
Read off the live form:
```
<input type="checkbox" value="1" name="members[0][enabled]" checked="checked">
```
The panel reads *field present* as *ticked*, whatever the value — so sending
`enabled=0` would **enable** it. This is the identical trap already recorded
for `autofill`/`autopause` in `pbx/teamBuilder.ts:228` ("that is how a trunk
got disabled during onboarding"), and there is a `checkbox()` helper there to
copy. ⛔ Getting this backwards means the cutoff silently does nothing while
reporting success.

⛔⛔ **THE ARS EDIT FORM WILL NOT LOAD A ROW, AND THIS IS THE BLOCKER.**
`class=ars, method=getContent, mode=edit, id=<ars_id>` (also tried `ars_id`)
returns a **blank `mode=add` form** with an empty description. In the CUSTOMER's
tenant context the route select has 1 option; in the **main tenant** context it
correctly has **56** — so ARS editing must happen in the main tenant (ARS rows
live under `tenant_id 1`), but the row-selecting parameter is still unknown.

⛔ **DO NOT GUESS IT.** The ARS form is a **FULL REPLACE**: every member must
be posted back or it is deleted. A wrong post wipes a customer's outbound
routing entirely — an outage, on a customer whose only problem was an unpaid
bill. Capture the real parameter first, the way the onboarding contract was
captured (watch what the panel itself sends when a human opens a route
selection and presses Update).

**Reading the members needs no panel at all** — `ombu_ars_members` gives
`ars_id, outbound_route_id, time_group_id, enabled, sort` directly, and that is
already how the sweep should load them. Only the WRITE needs the form.

## 8. The cutoff, proven live — and the two regen traps (2026-08-18)

✅ **DISCONNECT AND RESTORE PROVEN IN ASTERISK, 12/12.** Three cycles each on
Loopcom Demo (T102, ars 210, route 123) and Landau Home (T21, ars 83, route 65).
Every transition asserted against the running dialplan, not the database:

```
disconnected -> "There is no existence of 8455551234@T102_ARS-all extension"
                ARS-210 has only its invalid-destination handler
restored     -> ARS-210: Include => 'trk-group-123', number resolves again
```

~5 s per transition (the regen dominates; the DB flip alone is ~700 ms).

⛔⛔ **TRAP 1 — REGENERATE THE MAIN TENANT, NOT THE CUSTOMER'S.** `ARS-<id>` and
`trk-group-<id>` render into **`extensions__50-1-dialplan.conf`** (tenant 1),
because every outbound route and route selection lives under `tenant_id 1`.
The obvious move — regenerate the customer's tenant — rewrote their file and
left the routing untouched: the customer could still dial out while the
database said "disabled". A cutoff that reports success and does nothing.
File mtimes are what exposed it. Use `applyArsRegen()`.

✅ **TRAP 2, AND IT IS GOOD NEWS: this regen does NOT wipe the Connect doorway.**
`doorwaysRepaired=0` on all 12 transitions, because the doorway renders into
each customer's own file and this only regenerates tenant 1. So the cutoff is
materially safer than the emergency provisioning was — but keep the re-bake
call anyway, since an apply also flushes other tenants' pending changes.

⏳ **Still untested live: multi-profile tenants.** Both test tenants had one
profile with one member. Trust Bookkeepings' **nine** profiles exist only in
unit tests. That is the next thing to exercise.

## 9. The inbound busy signal — designed, NOT built

The doorway (`extensions__96-connect-doorway.conf`) resolves the tenant then
jumps straight to the IVR:

```
Set(DOORWAY_DID_TENANT=${DB(connect/didmap/${CONNECT_DOORWAY_DID}/tenant)})
Goto(connect-tenant-ivr,${CONNECT_DOORWAY_DID},1)
```

**So busy is a two-line insert immediately after that Set:**

```
same => n,GotoIf($["${DB(connect/interrupted/${DOORWAY_DID_TENANT})}" = "yes"]?busy)
...
same => n(busy),Busy()
```

✅ **AstDB is read at CALL time, so flipping a tenant between busy and normal
needs NO regeneration** — unlike the outbound half. Connect already writes
AstDB through AMI `dbPut` (the wake-dial work does exactly this).

⛔ **BUT the doorway file is owned by the helper and self-installs**, so the
change belongs in `scripts/pbx/vitalpbx-inbound-route-helper.py` AND its copy
embedded in `install-vitalpbx-inbound-route-helper.sh` — they must stay in
sync, and the 33-case drift guard
(`install-vitalpbx-inbound-route-helper.test.ts`) must pass before installing.
Editing the live file alone would be silently reverted at the next install.

⛔ Deliberately not started with low context remaining: a half-edited helper
that gets installed is worse than no inbound busy at all.

## 10. Wired end to end (2026-08-18) — what runs, what is proven, what is not

`2c8cc04e`. Everything from "payment fails" to "service restored" is now
connected. Read this section before believing anything above about "not built".

**Runs at boot** (`serviceInterruptionBoot.ts`, 1 import + 2 calls in
`server.ts`): a daily sweep (first run 5 min after boot), and admin routes
under `/admin/billing/tenants/:tenantId/service-interruption` — `GET`, `PUT`
(switch / graceDays), `POST …/restore`, `POST …/interrupt` (reason ≥ 8 chars).
**SUPER_ADMIN only** via `canAccessPlatformAdminBillingRoutes` — a customer's
own admin must not be able to restore themselves. Every manual action writes a
`BillingEventLog` row (`SERVICE_INTERRUPTION_*`).

⛔⛔ **THE SWEEP IS ARMED THE MOMENT THE CONTAINER SEES
`SERVICE_INTERRUPTION_CUTOVER_AT`.** Set in `.env.platform` at
`2026-08-18T12:01:07Z` (backup `.env.platform.bak.<ts>.service-interruption-cutover`,
diff = 3 added, 0 removed). Any payment failure older than that is **never**
acted on — checked before the countdown even starts, so an old invoice never
gets a start date a later change could act on. To disarm everything at once:
blank the variable and restart api. To disarm one customer: the switch.

**Inbound busy is REAL, with one limit.** The doorway now reads
`connect/t_<slug>/interrupted` right after resolving the tenant and returns
`Busy(10)`. Rendered and confirmed in Asterisk (`dialplan show
connect-doorway` carries the GotoIf + Busy). AstDB is read at call time, so
flipping it needs no regen. Written through the telephony `ivr-publish` door
(family `connect/t_<slug>` is on its allowlist).
⛔ **It only reaches numbers ON the doorway** — Connect-mode today = T2 A plus
center, T35 Connect Communications, T105 inii mini. Loopcom Demo and Landau
Home never enter the doorway; their inbound keeps ringing during a cutoff. The
runner logs `no Connect-mode number — inbound callers will NOT hear busy` per
tenant. Closing that means switching the number to Connect first (the existing
DID switch route) — not done.

**New sign-ups**: `setupOrchestrator` now passes the customer's address (via
`buildE911Address`, state resolved to `ombutel.states.id` by
`emergencyStateId.ts` — never guessed) so `buildPbxTenant` provisions
emergency calling; and `ensureOnboardingBillingDefaults` stamps the switch
**ON**. Existing accounts are untouched by both.

**Portal**: `ServiceInterruptionCard` on `/admin/billing/customer/[tenantId]`,
left column under "Who gets the invoice". Shows a warning banner when the
server is not armed.

**Committed with a private index** — `server.ts` carries only the 3 new lines
at HEAD's mode; another session's staged mode flip and yiddish module were
left exactly as found. Verified: 10 files, `git ls-tree HEAD server.ts` =
100644.

### Proven
- 102 module tests; api typecheck at the 75 baseline; portal typecheck 0;
  onboarding suites 71/71 with the module-mock flag; helper drift guard 33/33.
- Outbound cutoff/restore: **12/12 transitions in Asterisk** (§8).
- Inbound busy: rendered and loaded in Asterisk.

### ⏳ NOT proven
- **No real sweep has run against production.** The api container is being
  deployed as this is written (job `7771b6cf`). Acceptance: `docker logs
  app-api-1 | grep SERVICE_INTERRUPTION` shows `sweep scheduled {armed:true}`
  and, 5 minutes later, `sweep complete` with `considered` = the number of
  tenants with the switch on (**0 today**, so it should be a no-op).
- **Nobody has clicked the card**, and the two manual routes have never been
  hit over HTTP.
- **Multi-profile tenants** (Trust Bookkeepings' 9) exist only in unit tests.
- **Nobody has heard busy** on a real call.
- **No new sign-up has driven the emergency hook** — first real sign-up is
  the acceptance test (timeline should read `emergency location ok`).
