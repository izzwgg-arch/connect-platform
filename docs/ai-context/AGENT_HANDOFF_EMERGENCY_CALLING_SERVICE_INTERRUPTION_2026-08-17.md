# AGENT HANDOFF — overdue-account service interruption, and native emergency calling (2026-08-17)

**Status: config landed on two tenants, NOT yet rendered into the dialplan.
No customer behaviour has changed. Nothing is deployed.**

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

## 4. ⏳ NOT DONE — the dialplan is not rendered

`grep "^\[T104_emergency-calls\]"` returns **nothing**. The rows exist; the
context does not. **So emergency calling via this feature does not work yet.**
It needs a per-tenant regeneration.

⛔ **The panel's Apply Changes is the dangerous way to do it**: it wipes the
Connect doorway off every route of the tenant AND flushes other tenants'
pending changes. **inii mini is one of only three Connect-mode numbers on the
platform** (with A plus center and Connect Communications), so an apply can put
those numbers on dead air until the reconciler heals them — up to ~10 minutes.
The mitigation already exists: `rebakeConnectRoutesAfterRegen`
(`apps/api/src/pbx/applyRegenRebake.ts`), which `POST /voice/forwards` calls.

⛔ **The helper has no standalone "regenerate this tenant" endpoint.**
`/retarget`, `/restore` and `/sync-tenant-moh` each run a per-tenant regen as a
side effect of doing something else. Using one of those for an unrelated
purpose is a hack and was deliberately not done.

**Acceptance test, once rendered:** dial 911 from a Matamim extension with
every outbound route deactivated and confirm it still goes out on trunk 129 —
and that the notification email arrives.

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

1. Render the dialplan for T104/T105 (§4) and prove a real 911 call.
2. Simplify `serviceInterruptionPlan.ts` — drop the custom-route carve-out.
3. Wire emergency setup into `onboarding/pbxTenantBuild.ts` so every new
   customer gets it. ⛔ Use the **sweep** pattern, not a creation hook: five
   code paths create a tenant.
4. Build the per-tenant switch, the daily sweep, and the reconnect-on-payment
   hook. None of these exist yet — only the pure policy and plan do.
5. The other 27 customers, once the owner has their addresses.
