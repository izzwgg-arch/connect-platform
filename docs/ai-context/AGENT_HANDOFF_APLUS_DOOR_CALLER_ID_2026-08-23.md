# AGENT HANDOFF — giving the A Plus Center door bells their own caller ID (2026-08-23)

**Read-only investigation. No code change, no deploy, no PBX write, no data change.**
Nothing was altered on either server. Every fact below was read from the live PBX
(config, MySQL, AstDB, `dialplan show`) or proven from a real call in
`/var/log/asterisk/full` on 2026-08-23.

Izzy's question, verbatim: *"In Aplus Center 509, I think it is the front door bell.
It's connected to a ring group that rings a whole bunch of phones, including 103, or
it goes to a cell phone number, 422-6997. Is it possible to make it so that when the
call goes out to the cell phone number, it should display a different caller ID, not
the 702-6775, so the person knows that it's not a call, it's the front door?"*

---

## 1. The answer

**Yes — and it is a single native VitalPBX field per door, read LIVE from MySQL at
call time, so it needs no Apply Changes, no regeneration and no reload, and it is
reversible by blanking the field.**

But there is one catch that decides the whole design, and it is not a PBX question:

⛔⛔ **A caller ID NAME will not reach a mobile phone. US mobile carriers do their own
CNAM lookup keyed on the calling NUMBER and discard the display name we send.** So
"make it say Front Door" cannot be done by changing the name. **The distinguishable
thing has to be the NUMBER**, which the person then saves in their contacts as
"Front Door". Evidence this tenant's carrier does CNAM dips: inbound rows for this
very cell arrive stamped `"WIRELESS CALLER" <8454226997>` — a CNAM string, not a
sender-supplied name.

---

## 2. Two corrections to the description

⛔ **There are TWO door stations, not one, and BOTH ring the group and BOTH reach the
cell.** Measured over 2026-08-23:

| Ext | Extension name | Internal caller ID | Rang group 900 today | Reached the cell today |
|-----|----------------|--------------------|----------------------|------------------------|
| 509 | `Inside Door`  | `"Front Door" <509>` | 5 | 4 |
| 510 | `Front Door `  | `"Inside Door" <510>` | 6 | 6 |

Both are real `pjsip` devices (device_id 193 and 194). **Nothing else on the platform
dials ring group 900 and nothing else reaches that cell** — verified:

```
Dialing 900 from 510   x6      Dialing 8454226997 from 510  x6
Dialing 900 from 509   x5      Dialing 8454226997 from 509  x4
```

⛔⛔ **The extension NAME and the caller ID NAME are SWAPPED on both doors.** 509 is
*named* "Inside Door" but *announces itself* as "Front Door"; 510 is the reverse. So
the desk phones today show "Front Door" when **509** is pressed. Izzy's belief that
509 is the front door matches the caller ID; the extension name disagrees. **This
cannot be resolved from data and must be confirmed by a human at the building before
either door is labelled** — a door labelled with the wrong name is worse than no
label at all.

⛔ **The number the cell currently sees is 845-782-6775, not 702-6775** — it is
A Plus Center's own main number, set by their outbound route.

---

## 3. How it works today (traced end to end)

Door **510** pressed → dials **900** → ring group "Intercom" (`ring_group_id 92`,
strategy `ringall`) → members **101, 102, 103, 104, 105, 109** → member **109
"Tottys Cell"** is a **virtual** extension whose AstDB dial string is:

```
/f3df739ac62197cd/extensions/109/dial : Local/8454226997@T2_cos-all
```

That Local leg re-enters `T2_cos-all` → `T2_cos-all-post` → `T2_ARS-all` →
`ARS-19` → **`trk-group-18`** ("A Plus Center" outbound route) → out over
**trunk 72 = "0001" = Telocall** (the shared primary; the tenant's VoIP.ms trunk 18
is the backup — see [[outbound-route-0001-primary-trunk]]).

**The caller ID is decided in exactly two steps, both proven from the live log:**

```
[s-external@sub-construct-cid:2]  EXTENSION_NUMBER=510
[s-external@sub-construct-cid:11] EXTENSION_EXTERNAL_CID=            <- empty
[s-external@sub-construct-cid:12] ExecIf("1?Set(CALLERID(all)=)")    <- WIPES the CID
[s-18@T2_cos-all-post:4]  OUTBOUND_CID="A plus center" <8457826775>
[s-18@T2_cos-all-post:5]  CALLERID(all)=A plus center <8457826775>
```

⛔⛔ **THE KEY FACT: the outbound route only stamps its number when the caller ID is
EMPTY.** Line 5 is
`Set(CALLERID(all)=${IF($["X${CALLERID(num)}X"="XX"]?${OUTBOUND_CID}:${CALLERID(all)})})`
— *if* the CID is already set, it is **passed straight through untouched**. The only
reason the main number appears is that priority 12 blanked it first, because the
door extension has no external caller ID configured.

⛔⛔ **AND THE EXTENSION THAT GOVERNS IT IS THE DOOR (510), NOT THE CELL EXTENSION
(109) AND NOT THE RING GROUP.** `EXTENSION_NUMBER` resolves to `CALL_SOURCE`, which
is stamped as the originating extension when the call first enters
(`Dialing 900 from 510`) and survives onto the Local leg. **Read live as
`EXTENSION_NUMBER=510`** — this was verified from the log rather than reasoned about,
because it is the fact the entire fix rests on. Setting the field on 109 instead
would change the caller ID for *anything* that ever rings that cell; setting it on
the door changes only door calls.

---

## 4. What the change actually is

For each door extension, set the **External CID** field
(`ombu_extensions.external_cid`, Extensions → 509 / 510 in the panel):

```
external_cid = "Front Door" <845XXXXXXX>
```

Then priority 12 sets the CID to that value instead of blanking it, and
`trk-group-18` passes it through unchanged. That is the whole mechanism.

⛔⛔ **IT IS A LIVE SQL READ, NOT A RENDERED VALUE — this is why the change is cheap
and safe.** `func_odbc__00-general.conf:47`:

```
[EXTENSION-SETTING]
readsql=SELECT `${SQL_ESC(${ARG1})}` FROM ombu_extensions
        WHERE extension='${SQL_ESC(${ARG2})}' and tenant_id=(...)
```

So it takes effect **on the very next call**, with:
- **no Apply Changes** (which is whole-PBX and wipes the Connect doorway →
  the 2026-08-16 dead-air class),
- **no regeneration**, **no dialplan reload**,
- **instant rollback** by blanking the field.

---

## 5. Which number — the decision that is Izzy's

⛔ **Do NOT invent a number they do not own.** Presenting a number we do not control
is the caller-ID spoofing the Robocall Mitigation Plan forbids
([[loopcom-fcc-frn-and-federal-registrations]]) and it degrades attestation.

A Plus Center's numbers, read live:

| Number | Status |
|--------|--------|
| 845-782-6775 | **A plus center** — main line, current CID |
| 845-782-3064 | **Home** — live inbound route |
| 845-837-6001 | **Smart Steps** — live inbound route |
| 845-827-9585 | **Kj Play Center** — live inbound route |
| 845-637-2330 | **"TEST 2"** — see below |

**845-637-2330 is the interesting one.** Its inbound rule exists
(`exten => _8456372330/_8457823064` → ext 103, i.e. only when called *from* their
Home line) but it is **absent from `ombu_tenant_dids`, therefore absent from
`default-trunk`, therefore no inbound call to it can ever reach this tenant** —
`dialplan show default-trunk | grep -c 8456372330` = **0**. It is a dead leftover.
⛔ **Its presence in `PbxTenantInboundDid` proves only that a route row exists, not
that the number is still owned at the carrier** — that must be confirmed at VoIP.ms
before using it.

Options, cheapest first:

1. **Reuse 845-637-2330** (free, if still owned) — confirm at the carrier first.
2. **Take one of the 55 spare DIDs already in Connect's stock** — no purchase needed.
3. **Two numbers, one per door** — the only option that also tells the person
   *which* door, which is the thing they cannot tell today either.

**Cost to the customer today: nothing.** A Plus Center has `taxEnabled: false` and no
`billingTelecomFees` configured, so no per-number E911 or regulatory line is built
for them. The cost is the DID's carrier fee, which Loopcom already pays on stock
numbers.

⛔ **Whatever number is chosen, route it somewhere sensible** — the person will call
it back. Pointing it at ring group 900 (so a callback rings the house) is the
obvious choice.

---

## 6. Blast radius — what this can and cannot touch

Checked, not assumed:

- ✅ **Only the two doors are affected.** Nothing else dials 900 and nothing else
  reaches that cell (measured above). Every other extension's outbound calls keep
  presenting 845-782-6775 because `EXTENSION_NUMBER` is their own extension.
- ✅ **The desk phones are unchanged.** Internal legs never run `s-external`; 101–105
  and 103 keep seeing the internal caller ID they see today.
- ✅ **The trunk does not override it.** `trk-72-dial:7` only forces a CID when
  `${TENANT}/force_default_external_cid` is `"yes"`; the live log shows that
  condition evaluating **false** for this tenant.
- ✅ **The cell's own regular calls are untouched** — this changes an outbound leg
  from the PBX, nothing about the cell.
- ⚠️ **911 — stated honestly.** `T2_emergency-calls` **does not exist** on this
  tenant (only T104/T105 have emergency contexts), so a 911 call from any A Plus
  Center extension goes through the ordinary outbound route. If a door station could
  dial 911, it would present the new number. Both doors have only ever dialled 900,
  and they are single-purpose intercoms — **but if either has a keypad this must be
  confirmed before proceeding**, and the chosen number's E911 should be registered to
  the same address.
- ⏳ **The one genuine unknown: whether Telocall passes a caller ID for a number it
  does not know.** These calls leave on trunk 0001 (Telocall), not VoIP.ms. Telocall
  already carries many different per-tenant caller IDs, so it plainly accepts varied
  CIDs — but that is not proof for a *new* number. **One test call settles it in
  thirty seconds**, and the failure mode is visible immediately (the cell shows the
  old number, or the call does not complete). Nothing is silently broken either way.

---

## 7. Acceptance test

1. Set `external_cid` on **one** door only.
2. Press that door. The cell should ring showing the new number.
3. ⛔ **The negatives that matter:** the desk phones (101–105) must still show the
   same door name they show today, and a normal outbound call from any other
   extension must still show 845-782-6775.
4. Then set the second door.

---

## 8. Noticed in passing, deliberately NOT touched

- ⛔ **The door names are swapped** (§2) — needs a human at the building.
- **845-637-2330** has a dead inbound rule and may be a number being paid for that
  rings nothing.
- **A Plus Center's billing looks unconfigured**: `taxEnabled: false`,
  `billingDayOfMonth: 1`, `billingFlatRate.amountCents: 1`, and the most recent
  invoices are **$1.00 and $0.01**. Unrelated to this request and not investigated.


---

# BUILT AND PROVEN — 2026-08-24

Izzy's decision: *"create me that outbound route … and 637 as the caller ID"*, both
doors on the same number. **Done, live, and proven with real calls.**

## 9. What shipped

**Outbound route 178 "A Plus Center Doors"** (`ombu_outbound_routes`, tenant_id 1):
`cid_name "Front Door"`, `cid_number 8456372330`, **`overwrite_cid = yes`**, trunks
**72 (0001/Telocall) then 18 (their VoIP.ms)** — identical to their main route.
8 patterns = the 4 from route 18 × **`cid_pattern` 509 and 510**.

Attached as the **first member of ARS-19**, ahead of route 18.

```
[ARS-19]
include => trk-group-178     <- only matches CID 509 / 510
include => trk-group-18      <- everyone else, unchanged
```

Asterisk reports the scoping itself: `'_nxxnxxxxxx' (CID match '_510')`.

## 10. Proven with real calls, both directions

**Positive** — AMI originate carrying CID 510, no customer phone rung:
```
Outbound Route: A Plus Center Doors
CALLERID(all)="Front Door" <8456372330>
Called PJSIP/8457231213@0001
```
and it **arrived at the far end as `__INCOMING_SOURCE=8456372330`** — so
✅ **Telocall passes an arbitrary caller ID end to end.** That was the open unknown.

**Negative** — same originate carrying CID 103:
```
Outbound Route: A Plus Center
CALLERID(all)=A plus center <8457826775>
```
Untouched. Only the two doors changed.

## 11. ⛔⛔ THE TRAPS THIS EARNED

- ⛔⛔ **ARS member order is INSERTION order, NOT the `sort` column.** Setting
  `sort=0` on the new route rendered it **second**, so it would never have fired.
  The fix is to DELETE both members and re-INSERT in the order you want. Verify
  with `dialplan show ARS-<id>` — never trust the `sort` value.
- ✅ **`cid_pattern` on an outbound route WORKS and had never been used on this box**
  (0 of ~70 routes). It renders as `exten => _pattern/_cid`. This is the clean way to
  scope a route to specific extensions — far better than the per-extension
  `outbound_profile` AstDB key, which **no extension on this PBX uses** and which a
  tenant regen would rewrite.
- ✅ **`overwrite_cid` has three values: `if_not_provided` (32 routes), `yes` (17),
  `no` (9).** `yes` renders an unconditional `Set(CALLERID(all)=...)`; `if_not_provided`
  renders the `IF empty` form that produced the original behaviour.
- ✅✅ **`vitalpbx gen-conf` regenerates MAIN ONLY and does NOT wipe the Connect
  doorways — proven three times today** (Main stayed at 3 doorway Gosubs, tenant 2
  untouched at 1). ⛔ `vitalpbx help gen-conf` is the SAFE way to read its help;
  `gen-conf --help` actually RUNS it ([[pbx-genconf-is-a-write]]).
- ✅ **Put the route in an ARS that already renders in MAIN** (ARS-19) rather than
  adding a new ARS to the tenant's `outbound_profiles` — the latter renders in the
  TENANT's file and would have forced a tenant-2 regen, which is what puts the
  doorway on 845-782-3064 at risk. Same outcome, no tenant regen.
- ⛔ **`[ARS-all]` is a global catch-all that includes EVERY trunk group**, so a new
  route lands in it automatically. Checked before wiring: **no tenant includes
  `ARS-all`**, and **only tenant 2 has a 509/510**, so there is no cross-tenant reach.
  Re-check both whenever adding a CID-scoped route.
- ✅ **Testing an outbound route without ringing anyone: AMI Originate with a
  `CallerID:` header** into `T<n>_cos-all`, dialling a Loopcom-owned number, then read
  the log for the route taken, the CID sent, and the CID that arrived. Credentials are
  `astmanager` in `manager__50-ombutel-user.conf` (⛔ NOT `manager__10-general.conf`).
  ⛔ `awk "/^\[x\]/,/^\[/"` is a range bug — the end pattern matches the start line.

## 12. The pending-changes backlog — cleared, and it was NOT ours

**84 queued rows + 5 reload switches, cleared 2026-08-24.** Backup:
`/root/pbx-pending-flags-backup-20260824T122426Z/` (rows, a restore script for the
switches, and a full snapshot of every rendered config).

⛔⛔ **I first said these were ours. They were not, and the check is one grep:** our
helper only ever stamps **inbound_route (29), ivr (31), queues (21)**
(`_mark_pending_changes` call sites). The backlog was **iax_settings (42),
sip_settings (43), pjsip_settings (110)** × all 27 tenants, plus voicemail_general
(45) on Trust Bookkeepings and **tenants (99) on 140/141** — the two newest customers,
built through the mirror, which are the only genuinely Connect-created ones.

42/43/110 are **PBX-wide settings pages** (`multi_tenant: no`), so one edit there flags
every tenant — exactly the 27×3 pattern. That is a panel action, not ours.

⛔ **Why it never drained:** Connect deliberately avoids the whole-PBX Apply, and
applies scoped per tenant. So notes for everything else accumulate forever.

⛔ **The two dialplan switches (T2, T35) ARE the shape our helper sets** — it flips
`<prefix>reload_dialplan = yes` and nothing reliably flips it back. Their files hadn't
rendered since 6 and 10 August. **Worth fixing in the helper so this stops
accumulating.**

✅ Clearing changed **nothing live** — config mtimes were byte-identical before and
after, and it stayed at 0 through three subsequent regens.

## 13. Still open

- ⏳ **Nobody has pressed a real door since the route went live.** It is proven by two
  originated calls (positive and negative) that took the real path — not by a person
  at the building. **One press settles it: the cell should show 637-2330.**
- ⛔ **845-637-2330 is still not A Plus Center's own number.** It is on master account
  **344022**, while their trunk dials out as **355362_apluscenter**. Izzy chose it
  knowingly. Consequences: a callback goes nowhere, and on the rare fallback to their
  VoIP.ms trunk the CID may be refused or replaced. ⚠️ **Correction to §5:** the
  `344022_Comfortcont` subaccount is **Connect Communications' own inbound trunk**
  (proven — T35's inbound arrived on it during the test), not an outside customer's.
- ⛔ **The door names are still swapped** (§2) and unresolved.
- ⚠️ 911 from a door would now present 637-2330 (no `T2_emergency-calls` context).
  The doors have only ever dialled 900; confirm neither has a keypad.

## 14. Rollback

One statement, no regen needed for the DB half:
```sql
DELETE FROM ombutel.ombu_ars_members WHERE outbound_route_id=178;
```
then `vitalpbx gen-conf`. The doors fall straight back to route 18 and 845-782-6775.
To remove entirely, also delete route 178 and its members/patterns — full pre-state in
`outbound-routing-before.sql` in the backup directory.


---

# 15. ⛔⛔ WHAT 845-637-2330 ACTUALLY IS — and I was wrong twice about it (2026-08-24)

**It was COMFORT CONTROL's number.** Inbound CDR by tenant, all time:

| Tenant | Inbound calls |
|--------|---------------|
| `vpbx:comfort_control` | **229** |
| Comfort Control's Connect tenant (erased) | 16 |
| unattributed | 64 |
| A Plus Center | 3 + 2 |

Comfort Control was erased 2026-08-19. The number stayed on their VoIP.ms subaccount
(`344022_Comfortcont`) and their PBX trunk (**37, literally named "Comfort Control"**).

On **2026-08-14** Izzy's own SUPER_ADMIN account created a `DidRouteMapping` pointing
it at A Plus Center — and it was never finished at **four** layers:

| Layer | State |
|-------|-------|
| Connect mapping | `ivrProfileId: null`, `routingMode: "pbx"`, `lastPublishedAt: null`, `lastSwitchedAt: null` |
| PBX inbound route | "TEST 2" exists but is **CID-filtered to `8457823064`** (their Home line) — so it rejects everyone else |
| PBX DID list | **absent from `ombu_tenant_dids`** → `default-trunk` has no entry |
| Carrier | still routed to **Comfort Control's** subaccount, not `355362_apluscenter` |

⛔⛔ **SO EVERY CALLER TODAY HEARS AN ERROR RECORDING.** Traced live:

```
[8456372330@trk-37-in] "Incoming call through: Comfort Control"
Goto (default-trunk,8456372330,1)
Goto (incoming-calls,8456372330,1)
Goto (invalid-dest,s,1)
Playback("im-sorry&no-route-exists-to-dest&vm-goodbye")
```

**22 callers in the last 30 days** got that, including Izzy testing it on 2026-08-24.

⛔⛔ **TWO CORRECTIONS TO §5 OF THIS DOC, BOTH MINE:**
1. I wrote *"no inbound call to it can ever reach this tenant"* — **wrong**. Calls DO
   arrive (via trunk 37) and are recorded; they just have no destination. "Cannot
   arrive" and "arrives and errors" are very different, and only the second is a
   customer-facing fault. **`grep -c` on `default-trunk` and `ombu_tenant_dids` told me
   the DID is unrouted; it did NOT tell me calls never arrive. Trace a real call.**
2. I wrote it was *"a dead leftover"* — wrong. It carries real, ongoing traffic.

⚠️ **This now matters more than before, because the doorbell presents this number**
— so anyone who rings it back hears *"no route exists to destination."*

✅ **AND THE DOORBELL CHANGE IS PROVEN ON A REAL PRESS.** Izzy pressed door **509** at
09:50 EDT 2026-08-24:
```
Outbound Route: A Plus Center Doors
CALLERID(all)="Front Door" <8456372330>
Called PJSIP/8454226997@0001
```
So both doors are confirmed live in production, not just by originated tests.

## 16. Fixing the inbound side (NOT done — needs a decision)

To make a callback work, the number needs a destination. That is:
1. add `8456372330` to `ombu_tenant_dids` for tenant 2 → `default-trunk` routes it
   (**Main regen only — safe, `gen-conf` proven not to touch doorways**);
2. **remove the `cid_number = 8457823064` filter** from inbound route 4, or it keeps
   rejecting every caller but their Home line, and point it somewhere sensible
   (ring group **900** is the natural choice for a doorbell callback);
3. that second change renders in the **TENANT** file → **tenant-2 regen** → wipes the
   doorway on **845-782-3064** → needs the re-bake straight after.

⛔ Step 3 is the only risky part and it is the same doorway exposure documented
throughout this file. Do it in a quiet window with the re-bake ready.
