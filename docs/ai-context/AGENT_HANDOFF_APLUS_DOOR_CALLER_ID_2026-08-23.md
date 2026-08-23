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
