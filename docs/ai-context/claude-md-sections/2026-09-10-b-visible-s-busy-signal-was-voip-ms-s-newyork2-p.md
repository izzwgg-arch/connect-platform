# ⛔⛔ AGENT HANDOFF — B Visible's busy signal was VoIP.ms's newyork2 POP refusing REGISTRATIONS; trunk 30 moved to newyork1 (2026-09-10) — READ FIRST for ANY "callers get a busy signal", before trusting a clean CDR, before pressing Apply Changes, or before setting `inbound_calls_limit` on any tenant

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_BVISIBLE_BUSY_NEWYORK2_2026-09-10.md`**
(**PBX trunk write under Izzy's explicit "trunk only" mandate — no Apply Changes, no
carrier write, no code, no deploy.** Backups `/root/bvb2-nypop-move-20260910T192136Z/`
on the PBX.) B Visible `cmnlgryp8001lp9pajhatv3t9`, PBX **T9**, DID **(845) 238-0478**,
subaccount **`344022_bvb2`**, trunk **30**.

- ⛔⛔ **THE ANSWER: `newyork2.voip.ms` stopped answering SIP registrations. The trunk
  was homed there, so when the registration lapsed VoIP.ms had nowhere to deliver the
  call — and the DID's `failover_busy` is `none`, so the caller hears BUSY.**
  Proof, today's Asterisk log: `Endpoint 344022_bvb2 is now Unreachable` at 00:46 and
  14:28, then `No response received from 'sip:newyork2.voip.ms' on registration
  attempt`. ⛔ **It is the POP, not the customer** — the same failure hit **11
  subaccounts on newyork2** and 2 on newyork3 in the SAME three seconds, while
  **newyork1 had ZERO**. That contrast is the whole diagnosis.
- ⛔⛔ **A CLEAN CDR IS NOT EVIDENCE THERE IS NO BUSY SIGNAL, AND THIS COST MOST OF THE
  INVESTIGATION.** A call refused at the POP never reaches the PBX (**no CDR row** — B
  Visible had 2 BUSY on 09-02 and none since) **and VoIP.ms does not log it either**
  (`getCDR` showed **147 calls in 5 days, 100% ANSWERED**, zero busy/failed). ⛔ The
  trunk guardrail also misses it — it samples every 30 min and named only
  `344022_fox` all day; **a flap between samples is invisible.** **The Asterisk log's
  registration warnings are the only witness. Grep ALL trunks for
  `No response received` — it separates "this customer is broken" from "this POP is
  broken" in one command.**
- ✅ **FIXED (PBX side): trunk 30 moved newyork2 → newyork1 in BOTH places** — the 5
  `ombu_trunk_parameters` rows (`outgoing_host`/`match`/`fromdomain`/`client_uri`/
  `server_uri`) **and** the 5 lines in the bvb2 block of `pjsip__50-1-trunks.conf`
  (776–823), then `module reload res_pjsip.so`. ⛔ **The DB half is the durability
  half** — it is what the panel shows and what any future regen renders; changing only
  the conf is reverted by the next Apply. ⛔ The conf was written **inode-preserving**
  (`awk > tmp; cat tmp > file`) — a bare `sed -i` replaces the inode and strips the
  panel's ACLs (verified after: inode unchanged, `mask::rw-` intact). Now
  **Registered on newyork1, Avail, RTT 27–49 ms**, DB and conf MATCH.
- ⛔⛔ **APPLY CHANGES WAS DELIBERATELY NOT PRESSED, AND MUST NOT BE.** The change needs
  no Apply (DB + conf already agree, pjsip reloaded). And `ombu_queued_changes` holds
  **pre-existing pending rows for tenants 2, 9, 25** that are not ours — **tenant 2
  (A plus center) has a Connect doorway**, which VitalPBX's generator cannot render, so
  an Apply would wipe it and send **(845) 782-3064 to dead air**. Doorways are live on
  tenants 1, 2, 35, 105. If an Apply is ever truly needed, use `applyAndRebake()`.
- ⛔ **The busy branch is real and one setting away: `default-trunk` ends the call with
  `Gosub(sub-hangup-cause,s,1(17))` — cause 17 = USER_BUSY — when the tenant's inbound
  simultaneous-call cap is exceeded.** B Visible's `inbound_calls_limit` is **empty**
  (renders `MAX_INBOUND_TENANT_CALLS=0` = unlimited) and no tenant has a non-zero
  value. **Setting it arms a busy signal for real callers.**
- ⛔ Ruled out with evidence, do not re-derive: DID routing correct
  (`account:344022_bvb2`); **no `interrupted` flag anywhere** (the overdue-cutoff
  busy); `ombu_blacklist` **empty**; DID renders in `default-trunk`; VoIP.ms balance
  $29.76.
- ✅✅ **RESOLVED — AND THE DID POP WAS THE BINDING HALF, NOT THE TRUNK.** Moving the
  trunk to newyork1 did NOT restore service; only moving the **DID's own POP** did.
  **First inbound in 88 minutes at 19:40:21 UTC, answered, 123 s.** ⛔ So for this
  failure the lever is **`setDIDPOP`** — a number is anchored at a POP independently of
  where its account registers, and if that POP refuses, inbound dies however healthy the
  trunk is. Verified `setDIDPOP` touches ONLY the POP (routing, `failover_*`,
  `sms_enabled`, `e911`, `dialtime` all byte-identical after).
- ✅ **THE WHOLE PLATFORM IS OFF NEW YORK 2** (Izzy: *"Get them all back up and running
  right now"*). **9 DIDs** moved to pop 35 — B Visible's toll-free 866-579-7575, Gesheft
  845-305-0021, Displaydex 845-364-7474, Trust Bookkeepings 845-288-2287, Smooth Leasing
  845-252-1213, ADDB 845-243-3057, Secro 845-637-2329, plus 323-616-0463 and
  845-288-2286 (no tenant row) — and **11 trunks** moved in BOTH `ombu_trunk_parameters`
  (51 rows) and `pjsip__50-1-trunks.conf` (50 refs), inode-preserving, then
  `module reload res_pjsip.so`. **Final: 0 DIDs on pop 82, 0 trunks/rows/conf refs on
  newyork2, 70 DIDs on New York 1, 66 registrations — the same count as before.**
  Backups `/root/ny2-trunk-move-20260910T204025Z/`; rollback = those 9 were pop 82.
- ⛔⛔ **`Newyork2.voip.ms` WITH A CAPITAL N HID FROM A CASE-SENSITIVE SWEEP.** Trunk 61
  (Relax Tires) carried it in `outgoing_match` while its conf and live registration were
  already newyork1 — so a case-sensitive `REPLACE`/`grep` reported "0 left" while one row
  survived, and **the next regen would have pushed Relax Tires back onto the dead POP.**
  Match this hostname case-insensitively.
- ⛔ **Run a carrier batch DETACHED with its log on the HOST** (`> /root/x.log`). The api
  container was recreated mid-run by another session's deploy, killing the first attempt
  and taking the `docker cp`'d script and its backup file with it. ⛔ **Then check whether
  a PARTIAL write landed** — here nothing had moved, but it could have been 4 of 9.
- ⏳ **NOT touched, flagged only:** **newyork3 (pop 83) still carries 3 numbers and had 2
  registration failures in the same 14:49 window** (`trustSGE`, `solidefyc`).
  ⚠️ The **Telocall** trunk `0001` is still `Rejected` (the documented port-700 typo,
  should be 7000) — pre-existing, unrelated, calls flow via IP auth.
  ⚠️ **Smooth Leasing 845-252-1213 has taken ZERO inbound in 7 days** — that line looks
  dead and nobody has noticed; separate from this outage.
