# B Visible busy signal — the newyork2 POP stopped answering registrations (2026-09-10)

Izzy: *"why is B Visible's phone getting a busy signal?"* → *"busy signal usually
comes from voip.ms"* → *"it's 845-238-0478"* → *"inbound to that number"*.

Tenant **B Visible** (`cmnlgryp8001lp9pajhatv3t9`, PBX **T9**), DID
**(845) 238-0478**, subaccount **`344022_bvb2`**, PBX trunk **30**.

---

## 1. The answer in one line

**VoIP.ms's `newyork2.voip.ms` POP stopped answering SIP registrations. B
Visible's trunk was homed there, so when the registration lapsed VoIP.ms had
nowhere to deliver the call — and the DID's `failover_busy` is `none`, so the
caller hears a busy tone.**

## 2. Why it leaves NO record on our side — and that is the tell

A call refused this way never reaches the PBX, so there is **no CDR row**, and
VoIP.ms does not log a delivery attempt either. So:

- ⛔ **The absence of BUSY rows in `asterisk.cdr` does NOT mean there is no busy
  signal.** B Visible's PBX CDR shows **2 BUSY on 09-02 and none since**.
- ⛔ **The carrier CDR looked perfect too** — 147 calls to this DID over 5 days,
  **100% ANSWERED**, zero busy/failed/no-answer. `getCDR` only shows calls that
  were delivered; a call refused at the POP is invisible there.
- ⛔ **The trunk guardrail also missed it** — it sweeps every 30 min and reported
  `344022_fox` as the only offender all day. **A flap between samples is
  invisible to it.**

**The evidence is in the Asterisk log, which is the only witness.**

## 3. The proof (today's `/var/log/asterisk/full`, UTC)

```
[2026-09-10 00:46:14] Endpoint 344022_bvb2 is now Unreachable
[2026-09-10 14:28:44] Endpoint 344022_bvb2 is now Unreachable
[2026-09-10 14:49:12] WARNING res_pjsip_outbound_registration.c:
    No response received from 'sip:newyork2.voip.ms' on registration
    attempt to 'sip:344022_bvb2@newyork2.voip.ms', retrying in '60'
```

**It is the POP, not B Visible.** At 14:49:09–14:49:12 the SAME failure hit
**11 subaccounts on newyork2** (`lemmecheck, eli, relax2, giti, smartsteps,
Smooth2, Trusttrimpro, brightview, trimprotrust, Vaddb, bvb2`) and **2 on
newyork3** (`trustSGE, solidefyc`). **newyork1 had ZERO registration
timeouts.** That contrast is what makes newyork1 the right destination.

## 4. Ruled out first, with evidence — do not re-derive

| Suspect | Verdict |
|---|---|
| Trunk unregistered (the inii mini class) | Registered at check time; guardrail clean all day |
| DID routing wrong | `routing: account:344022_bvb2` — correct |
| Overdue-cutoff `Busy(10)` | **No `interrupted` flag anywhere on the platform** |
| Tenant simultaneous-call cap | `inbound_calls_limit` **empty** → renders `MAX_INBOUND_TENANT_CALLS=0` = unlimited |
| Caller blacklist | `ombu_blacklist` **empty** |
| DID missing from `default-trunk` | Renders correctly, `Goto(T9_default-trunk,...)` |
| VoIP.ms balance | $29.76, healthy |

⛔ **The busy branch itself is real and worth knowing**: `default-trunk` ends the
call with `Gosub(sub-hangup-cause,s,1(17))` — **cause 17 = USER_BUSY** — when the
tenant's inbound simultaneous-call cap is exceeded. It is disabled here (0), but
**setting `inbound_calls_limit` on any tenant arms a busy signal for callers.**

## 5. What was changed (PBX trunk only — Izzy's explicit scope)

Trunk **30** moved `newyork2.voip.ms` → `newyork1.voip.ms`, in **both** places:

1. **`ombu_trunk_parameters` (trunk_id=30)** — 5 rows: `outgoing_host`,
   `outgoing_match`, `outgoing_fromdomain`, `outgoing_client_uri`,
   `outgoing_server_uri`. ⛔ **This is the durability half** — the DB is what the
   panel shows and what any future regen renders.
2. **`pjsip__50-1-trunks.conf` lines 776–823** (the bvb2 block only) — 5 lines:
   `from_domain`, the AOR `contact`, `match`, `server_uri`, `client_uri`.
   ⛔ Written **inode-preserving** (`awk > tmp; cat tmp > file`) — a bare
   `sed -i` replaces the inode and strips the panel's ACLs (the lockout trap).
   Verified after: inode unchanged, `mask::rw-` and `user:www-data:rw-` intact.
3. `module reload res_pjsip.so`.

**Result:** `344022_bvb2/sip:newyork1.voip.ms — Registered`, contact **Avail,
RTT 27–49 ms**, endpoint `Not in use`. DB and rendered config **MATCH**.

Backups: **`/root/bvb2-nypop-move-20260910T192136Z/`** on the PBX
(`trunk30-params.sql` + `pjsip__50-1-trunks.conf.bak`).

## 6. ⛔⛔ Apply Changes was DELIBERATELY NOT pressed

The change needs no Apply — the DB and the rendered config already agree and
pjsip is reloaded. And pressing it would have caused an outage:

- `ombu_queued_changes` holds **pre-existing pending rows for tenants 2, 9, 25**
  (modules 42/43/110) that are **not ours**.
- **Tenant 2 (A plus center) has a Connect doorway baked into its dialplan**, and
  VitalPBX's generator cannot render the doorway — an Apply would wipe it and
  send **(845) 782-3064 to dead air**. Doorways are also live on tenants 1, 35
  and 105.

⛔ If an Apply is ever genuinely needed here, it must go through
`applyAndRebake()`, never the panel button.

## 7. ⏳ NOT DONE — the carrier half is still on New York 2

**12 minutes after the move, VoIP.ms still reports the account and the DID on
POP 82 (New York 2):**

```
getRegistrationStatus 344022_bvb2 -> registered: yes,
    server: New York 2, NY (pop 82), rerouted: 0
getDIDsInfo 8452380478          -> pop: 82, failover_busy: none:344022
```

For comparison, sibling `344022_bvb3` reads **pop 35 (New York 1)**, matching its
registrar — so **this field does track where the account is homed**, and B
Visible's has not moved. Two possibilities, not yet separated: the old
registration binding has not expired (it was `expiration=3600`, so up to an
hour), or the subaccount's own POP setting must be changed at VoIP.ms.

**Needs Izzy's word — this is a carrier write, outside the PBX-trunk scope
granted:**
1. `setSubAccount` on `344022_bvb2` to move its POP 82 → 35.
   ⛔ **`setSubAccount` is a FULL UPDATE** — it must resend every existing field
   including the account's own password, then be re-read to prove it stuck. A
   partial update fails, and a wrong one breaks the trunk.
2. The **DID's** own `pop` (82) — anchoring the number at the flaky POP.

⏳ **NOT PROVEN: nobody has called the number since the change.** The fix is
proven as a registration on newyork1 with a healthy qualify, not as a caller
getting through.

## 8. The reusable lesson

**"No busy rows in the CDR" is not evidence there is no busy signal.** When the
carrier refuses a call before it reaches us, both CDRs are silent and the 30-min
guardrail can miss it. **The Asterisk log's registration warnings are the
witness** — and grepping *all* trunks for `No response received` immediately
separates "this customer is broken" from "this POP is broken".

---

# RESOLVED — everything is off New York 2 (2026-09-10, later the same day)

⛔ **§7 above is now HISTORY.** The carrier half was completed and the whole
platform was moved off the failing POP, on Izzy's instruction
(*"Get them all back up and running right now"*).

## What actually fixed B Visible

**It needed BOTH halves, and the DID POP was the binding one.** Moving the trunk
to newyork1 at 19:23 UTC did **not** restore service — inbound stayed dead. Only
when the **DID's own POP** moved to New York 1 (~19:38) did calls resume:
**first inbound call in 88 minutes at 19:40:21 UTC, answered, 123 seconds.**

⛔ **So `setDIDPOP` is the lever for this failure, not the trunk registration.**
The number is anchored at a POP independently of where the account registers;
if that POP is refusing, inbound dies no matter how healthy the trunk is.

## The platform-wide move

**Phase 1 — 9 DIDs** moved to POP 35 via `setDIDPOP {did, pop}`. Verified: every
`routing`, `failover_*`, `sms_enabled`, `e911` and `dialtime` byte-identical
afterwards — **the method touches only the POP**. Rollback: all 9 were pop 82.

| Customer | Number | Subaccount |
|---|---|---|
| B Visible | 866-579-7575 (toll-free) | brightview |
| Gesheft | 845-305-0021 | relax2 |
| Displaydex | 845-364-7474 | eli |
| Trust Bookkeepings | 845-288-2287 | trimprotrust |
| Smooth Leasing | 845-252-1213 | Smooth2 |
| ADDB Builders | 845-243-3057 | Vaddb |
| Secro Selutions | 845-637-2329 | giti |
| (no tenant row) | 323-616-0463 | lemmecheck |
| (no tenant row) | 845-288-2286 | Trusttrimpro |

**Phase 2 — 11 trunks** moved newyork2 → newyork1 in `ombu_trunk_parameters`
(51 rows) **and** `pjsip__50-1-trunks.conf` (50 refs), inode-preserving, then
`module reload res_pjsip.so`. Backups `/root/ny2-trunk-move-20260910T204025Z/`.

**Final state: 0 DIDs on pop 82, 0 trunks on newyork2, 0 DB rows, 0 conf refs.
70 DIDs now on New York 1. 66 registrations — the same count as before.**

## ⛔ Two traps this second pass earned

1. **A guard caught a real inconsistency: `Newyork2.voip.ms` with a CAPITAL N.**
   Trunk 61 (Relax Tires) carried it in `outgoing_match` while its config and
   live registration were already newyork1 — so a case-sensitive
   `REPLACE`/`grep` missed it and reported "0 left" while one row remained.
   **A regen would have pushed Relax Tires back onto the dead POP.** Always
   match this hostname case-insensitively.
2. **The api container was recreated mid-run by another session's deploy**,
   killing the first attempt and taking the `docker cp`'d script and its backup
   file with it. ⛔ **Check afterwards whether a partial write landed** — here
   nothing had moved, but it could have been 4 of 9. Run carrier batches
   detached with the log written to the HOST (`> /root/x.log`), never relying
   on the exec's stdout.

## ⛔ Still on other POPs — NOT touched

**newyork3 (pop 83) carries 3 numbers and had 2 registration failures today**
(`trustSGE`, `solidefyc`, at 14:49–14:52, same incident window as newyork2).
Nobody asked for those to move and they are working; flagged, not actioned.

⚠️ Unrelated and pre-existing: the **Telocall** trunk `0001` registration is
still `Rejected` (`us-east.telocall.com:700` — the documented port typo, should
be 7000). Calls flow both ways via IP auth. Not caused by this work.

⚠️ **Smooth Leasing's 845-252-1213 has taken ZERO inbound calls in 7 days.**
That line appears dead and nobody has noticed. Separate from today's outage.
