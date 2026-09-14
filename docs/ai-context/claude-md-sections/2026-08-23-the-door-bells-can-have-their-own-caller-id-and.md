# ⛔ AGENT HANDOFF — the door bells can have their own caller ID, and it is ONE live-read field (2026-08-23) — READ FIRST for any "show a different caller ID for X", before touching `external_cid`, or before assuming a caller-ID NAME reaches a mobile

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_APLUS_DOOR_CALLER_ID_2026-08-23.md`**
(**Read-only investigation — no code, no deploy, no PBX write, no data change.**
Every fact traced from the live PBX and from real calls in `/var/log/asterisk/full`
on 2026-08-23.) Izzy: *"when the call goes out to the cell phone number, it should
display a different caller ID … so the person knows that it's not a call, it's the
front door."*

- ⛔⛔ **THE MECHANISM, and it generalises to every "different caller ID" request:
  the outbound route only stamps its number when the caller ID is EMPTY.**
  `trk-group-N`'s line is
  `Set(CALLERID(all)=${IF($["X${CALLERID(num)}X"="XX"]?${OUTBOUND_CID}:${CALLERID(all)})})`
  — an already-set CID is **passed straight through**. The reason a tenant's main
  number appears is that `sub-construct-cid,s-external` priority 12 **BLANKS** the CID
  first when the extension's `external_cid` is empty (`ExecIf("1?Set(CALLERID(all)=)")`
  — ODBCSTATUS is SUCCESS because the row exists, the column is just empty). Fill
  `external_cid` and the route leaves it alone. **Proven from a live call, not read
  off the config.**
- ⛔⛔ **IT IS A LIVE SQL READ — no Apply Changes, no regen, no reload, instant
  rollback.** `func_odbc__00-general.conf:47` `[EXTENSION-SETTING]` does
  `SELECT <col> FROM ombu_extensions WHERE extension=... AND tenant_id=...` **at call
  time**. So this class of change never needs the whole-PBX Apply that wipes the
  Connect doorway (the 2026-08-16 dead-air class). Blanking the field reverts it.
- ⛔⛔ **THE GOVERNING EXTENSION IS THE ORIGINATOR, NOT THE DESTINATION.**
  `EXTENSION_NUMBER` resolves to `CALL_SOURCE` — the extension the call STARTED at —
  and survives onto the Local leg that dials out. Live read: a door press at ext 510
  → ring group 900 → virtual ext 109 (`Local/8454226997@T2_cos-all`) → out, with
  **`EXTENSION_NUMBER=510`**. So set it on the DOOR (affects only door calls); setting
  it on the cell-forward extension would change the CID for anything that ever rings
  that cell.
- ⛔⛔ **A CALLER-ID NAME DOES NOT REACH A US MOBILE — this kills the obvious
  answer.** Mobile carriers do their own CNAM dip keyed on the NUMBER and discard the
  display name we send. Evidence on this very tenant: inbound rows from that cell
  arrive stamped `"WIRELESS CALLER" <8454226997>`, a CNAM string. **So "make it say
  Front Door" must be a different NUMBER**, which the person saves as a contact.
  Setting the name too costs nothing, but never promise it.
- ⛔ **A Plus Center (PBX tenant 2) has TWO door stations, not one, and BOTH ring the
  group and BOTH reach the cell** — 509 and 510, measured 5 and 6 presses on
  2026-08-23. ⛔⛔ **Their extension NAMES and caller-ID NAMES are SWAPPED**: 509 is
  named "Inside Door" but announces "Front Door"; 510 is the reverse. **A human at the
  building must settle which is which before either is labelled** — a door labelled
  with the wrong name is worse than no label.
- ⛔ **The number the cell sees is 845-782-6775** (their main line), not "702-6775".
  ⛔ **Never present a number the customer does not own** — that is the caller-ID
  spoofing the Robocall Mitigation Plan forbids. They own 5 numbers; four are live
  business lines. **845-637-2330 ("TEST 2") is a dead leftover** — its inbound rule
  exists but it is absent from `ombu_tenant_dids`, so absent from `default-trunk`, so
  **no inbound call can reach it** (`dialplan show default-trunk | grep -c` → 0).
  ⛔ Its row in `PbxTenantInboundDid` proves a route row exists, **not** carrier
  ownership — confirm at VoIP.ms before reusing it. 55 spare DIDs are also in stock.
- ⛔ **The one unknown, stated rather than guessed: these calls leave on trunk 0001
  (Telocall), not VoIP.ms**, and whether Telocall passes a CID for a number it does
  not know is unproven. Telocall already carries many per-tenant caller IDs, so it
  accepts varied CIDs — but **one test call settles it**, and the failure is visible
  immediately (old number shown, or call does not complete). Nothing breaks silently.
- ⚠️ **911 exposure, honestly:** `T2_emergency-calls` **does not exist** (only
  T104/T105 have emergency contexts), so 911 from any A Plus Center extension rides
  the ordinary outbound route and would present the new CID. The doors are
  single-purpose intercoms that have only ever dialled 900 — **confirm neither has a
  keypad before proceeding**, and register the chosen number's E911 to that address.
- ✅✅ **BUILT AND PROVEN 2026-08-24 (Izzy's mandate: "create me that outbound route
  … and 637 as the caller ID", both doors on one number).** Outbound route **178
  "A Plus Center Doors"** — `cid_number 8456372330`, **`overwrite_cid = yes`** (forces
  it), trunks 72 then 18 like their main route, and 8 patterns = route 18's four ×
  **`cid_pattern` 509 / 510**. Attached as the **FIRST member of ARS-19**, ahead of
  route 18. Asterisk reports the scoping itself: `'_nxxnxxxxxx' (CID match '_510')`.
  ✅ **Proven with two real originated calls, no customer phone rung:** CID 510 →
  *"Outbound Route: A Plus Center Doors"* → `CALLERID(all)="Front Door" <8456372330>`
  → out via Telocall → **arrived at the far end as `__INCOMING_SOURCE=8456372330`**
  (so Telocall passes an arbitrary CID end to end — the open unknown, now closed);
  and the negative, CID 103 → *"Outbound Route: A Plus Center"* → unchanged
  `<8457826775>`.
- ⛔⛔ **ARS MEMBER ORDER IS INSERTION ORDER, NOT THE `sort` COLUMN — and getting
  this wrong makes the route silently never fire.** `sort=0` on the new route still
  rendered it SECOND, so route 18 matched first and won. **DELETE both members and
  re-INSERT in the order you want**, then confirm with `dialplan show ARS-<id>`.
- ✅ **`cid_pattern` on an outbound route WORKS and had never been used here** (0 of
  ~70 routes). It renders `exten => _pattern/_cid`. **This is the clean way to scope a
  route to specific extensions** — far better than the per-extension `outbound_profile`
  AstDB key, which **no extension on this PBX uses** and which a tenant regen rewrites.
  ⛔ `overwrite_cid` values in use: `if_not_provided` (32, the "only if empty" form),
  `yes` (17, unconditional `Set(CALLERID(all)=…)`), `no` (9).
- ✅✅ **`vitalpbx gen-conf` REGENERATES MAIN ONLY AND DOES NOT WIPE THE CONNECT
  DOORWAYS — proven three times on 2026-08-24** (Main held at 3 doorway Gosubs,
  tenant 2 untouched at 1). That materially narrows the "any regen is dangerous" fear.
  ⛔ Read its help as `vitalpbx help gen-conf`; `gen-conf --help` actually RUNS it.
  ✅ **So put a new route in an ARS that already renders in MAIN (ARS-19)** rather than
  adding a new ARS to the tenant's `outbound_profiles` — the latter renders in the
  TENANT's file and forces a tenant regen, which is what risks the doorway on
  845-782-3064.
- ⛔ **`[ARS-all]` is a global catch-all including EVERY trunk group**, so a new route
  joins it automatically. Checked before wiring: **no tenant includes `ARS-all`** and
  **only tenant 2 has a 509/510**, so no cross-tenant reach. Re-check both.
- ✅ **Test an outbound route without ringing anyone: AMI Originate with a `CallerID:`
  header** into `T<n>_cos-all` dialling a Loopcom number, then read the log for the
  route taken, the CID sent and the CID that arrived. Creds are `astmanager` in
  **`manager__50-ombutel-user.conf`** (⛔ not `manager__10-general.conf`).
- ✅✅ **THE 84-ROW PENDING BACKLOG IS CLEARED (2026-08-24) — and it was NOT ours.**
  ⛔⛔ I first said Connect stamped them; **the one-grep check disproves it** — our
  helper's `_mark_pending_changes` only ever stamps **inbound_route (29), ivr (31),
  queues (21)**. The backlog was **iax_settings (42) / sip_settings (43) /
  pjsip_settings (110) × all 27 tenants** (PBX-wide settings pages, `multi_tenant: no`,
  so one panel edit flags every tenant — exactly the 27×3 shape), plus
  voicemail_general on Trust Bookkeepings and **tenants (99) on 140/141**, the two
  mirror-built customers — the only genuinely Connect-created rows.
  ⛔ **Why it never drained:** Connect deliberately avoids the whole-PBX Apply and
  applies per tenant, so everyone else's notes accumulate forever.
  ⛔ **The two dialplan switches (T2, T35) ARE our shape** — the helper flips
  `<prefix>reload_dialplan = yes` and **nothing reliably flips it back**; their files
  hadn't rendered since 6 and 10 Aug. **Fix that in the helper or this re-accumulates.**
  ✅ Clearing changed **nothing live** (config mtimes byte-identical) and stayed at 0
  through three later regens. Backup + full config snapshot:
  `/root/pbx-pending-flags-backup-20260824T122426Z/`.
- ⏳ **NOT PROVEN: nobody has pressed a real door since it went live.** Proven by two
  originated calls on the real path, not by a person at the building. **One press
  settles it — the cell should show 637-2330.**
- ⛔ **Rollback is one statement + a regen:**
  `DELETE FROM ombutel.ombu_ars_members WHERE outbound_route_id=178;` then
  `vitalpbx gen-conf`. Full pre-state in `outbound-routing-before.sql` in that backup.
- ⚠️ **Correction to the number caveat above:** `344022_Comfortcont` is **Connect
  Communications' own inbound trunk** (T35's inbound arrived on it during the test),
  not an outside customer's — so the earlier "an erased tenant's live subaccount"
  framing was wrong. 845-637-2330 is still on master account **344022** while their
  trunk dials out as **355362_apluscenter**, so a callback still goes nowhere and the
  rare VoIP.ms fallback may refuse or replace the CID. Izzy chose it knowing that.
- ⚠️ **Noticed, NOT touched:** A Plus Center's billing looks unconfigured —
  `taxEnabled: false` (so no per-number E911 fee is billed to them at all),
  `billingDayOfMonth: 1`, `billingFlatRate.amountCents: 1`, and their two most recent
  invoices are **$1.00 and $0.01**.
