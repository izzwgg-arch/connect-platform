# AGENT HANDOFF — overdue-account service interruption, and native emergency calling (2026-08-17)

**Status: LIVE on two tenants — rendered, reloaded, and confirmed in Asterisk.
Nothing is deployed (no api/portal change is needed for this part).**

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
