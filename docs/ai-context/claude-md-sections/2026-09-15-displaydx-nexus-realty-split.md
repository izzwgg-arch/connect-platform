# ⛔ AGENT HANDOFF — Display Decks SPLIT: existing tenant → NEXUS REALTY (Michael owner), new billing-only tenant DISPLAYDX (Ellie); $90 of missed cycles invoiced, NOT charged; ⛔ PHONES NOT MOVED (2026-09-15) — READ FIRST before touching either tenant's billing, moving their phones, or "why does Eli's portal say Nexus Realty"

Full handoff: **`docs/ai-context/AGENT_HANDOFF_DISPLAYDX_NEXUS_SPLIT_2026-09-15.md`**
(backup `loopcom:/root/displaydx-split-backup-20260915.json`; script
`loopcom:/root/displaydx-split.ts`, run live 2026-09-15, Connect DB only — no charge, no
Sola write, no PBX write, no email). Memory: [[displaydx-nexus-realty-split]].

- ✅ **Old tenant `cmnlgryom001fp9paw7le6582` renamed "Nexus Realty"**, Michael
  (`michael@nexusrealtyad.com`) → TENANT_ADMIN, default card → his Amex ····1005. The rename
  HEALED the §5 Secro-handoff mis-map: the "Nexus Realty" link's companyName now matches its
  tenant.
- ✅✅ **2026-09-16 — NEXUS IS OFF SOLA AND ON CONNECT AUTOPAY (Izzy: "stop it there, switch it
  over to Connect, same payment date").** Sola schedule `c112585121_s11766473` **disabled at
  Sola** (live read-back: `IsActive:false`, Revision 24→25, ModifiedDate 2026-09-15 22:10:37),
  Connect autopay ON, **day 28 → 26**, flat rate **$6500** ("Monthly service"), first Connect
  charge **Sep 26** on the same Amex ····1005. ⛔⛔ THE TRAP, and it cost a month if unseen:
  `takeOverBillingFromSola` assumes Sola ALREADY charged the current period, so it set
  `nextConnectChargeAt` = **Oct 26** — but Sola was stopped BEFORE its Sep 26 run, so Sep would
  have gone uncollected ($65, free month). **BOTH guards had to be moved to Sep 26**: the link's
  `nextConnectChargeAt` AND `metadata.billingScheduleOverride.nextPaymentDate` (event
  `billing.sola_cutover_next_charge_adjusted`). ⛔ The dormant profile "Nexus Realty" ($60,
  `autoBillingEnabled:true`) was turned **OFF first** — `runBillingProfilesForTenant` runs for
  every autopay tenant, so flipping tenant autopay on would have added a SECOND $60 invoice and
  charged it. ⛔ Pricing was Izzy's call: the engine computed **$30** (extensions pinned to a
  manual quantity of 1 while 4 are active) vs Sola's **$65** — he chose $65, so a flat rate is
  used and the manual-1 override is now irrelevant. Proven by replaying the deployed worker
  decisions at Sep 23 / Sep 26 / Oct 26: T-3 invoice Sep 26→Oct 26, `due` true, no
  activeSola / cutover / override / paid-coverage block. Backup
  `loopcom:/root/nexus-cutover-backup-20260916.json`. **Nothing charged, invoiced or emailed at
  cutover time** (0 tx, 0 EmailJobs, invoice list unchanged). ⛔ Michael now receives Connect
  invoice + T-3 reminder + receipt emails at `Michael@nexusrealtyad.com` — he got none of that
  from Sola; the first reaches him **Sep 23**.
- ✅ **New tenant DisplayDX `cmu31fp430000pfje5qh86dja`** (billing-only, YS-Plumbing pattern):
  Ellie's Visa ····0213 default, $30/mo (manual qty 1 extension, same as always), day 28,
  terms 15, **autopay ON**, billingEmail eli@displaydex.com. The inert CUTOVER_COMPLETE
  displaydex Sola link moved with the card.
- ✅ **Ellie's last charge before the split was 2026-05-28 ($30)** — Sola's own schedule died
  at the May cutover (live-probed IsActive false) and Jun/Jul/Aug 28 were block-eaten.
- ✅✅ **COLLECTED 19:19Z on Izzy's GO ("send it out to him by email before you charge"):**
  the 3 invoice emails SENT to eli@displaydex.com FIRST, then all 3 charges on Visa ····0213
  APPROVED — CC-202609-00007 ref 11050937980, -00008 ref 11050938015, -00009 ref 11050938046,
  $90 total, all PAID, 3 receipts SENT. Script `loopcom:/root/displaydx-collect.ts`.
- ✅ **Worker resumes Ellie's normal billing by itself: T-3 invoice Sep 25, charge Sep 28** on
  the Visa. ⛔ Don't hand-create the Sep 28 invoice; the worker never charges the 3 late ones.
- ⛔ **The $65 flat rate is a BILLING fact, not a phone fact** — when the phones finally split,
  Nexus keeps billing $65 until someone changes it (a flat rate ignores extension count, which
  is exactly why it was chosen).
- ⛔⛔ **PHONES/EXTENSIONS/NUMBERS/USERS NOT MOVED — Izzy's explicit "don't move any phones
  yet."** Later: DisplayDX gets ext 101 (Eli) + 104 (Yehuda, ⚠️ his email is
  @nexusrealtyad.com — confirm side) + numbers 212-888-0885 / 845-200-3535 / 845-414-3736;
  Nexus keeps ext 102 + 103 + 845-364-7474. **Eli's login still sits on the renamed tenant, so
  his portal shows "Nexus Realty" until his user moves with the phones** — moving it early
  breaks his working softphone.
- ⛔⛔ **THE PHONE/IVR MOVE WAS STOPPED BEFORE ANY LIVE WRITE (handoff §4b).** Linking
  DisplayDX to the SAME PBX tenant 6 breaks ringing: `resolvePbxEventTarget` picks one link by
  unordered `findFirst({pbxTenantId})` → if Nexus, ext 101 isn't found → no invite, **Eli's app
  doesn't ring**. Also verified: T6 call history files under one tenant (last-wins map), and the
  IVR import can't target DisplayDX. The platform assumes ONE Connect tenant per PBX tenant.
- ⛔ **Rendered-dialplan ownership:** 200-3535 → IVR 16 Displaydex, 212-888-0885 → IVR 17 Quick
  sat (both ring only ext 101 via rg 800–807); 364-7474 → TC-3 Nexus Realty; **414-3736 "Nexus
  2" → IVR 18 Nexus Main (dials 102 + 104)** — so 414-3736 and Yehuda's 104 are Michael's side.
- ✅ A session-tenant shim was built + tested 20/20 then REMOVED unshipped (only serves the
  unsafe design; a real split changes Eli's SIP identity, so one re-sign-in is unavoidable).
  ✅ **Izzy chose A — real PBX split, PREP ONLY.**
- ✅✅ **REAL PBX SPLIT PREPPED, NOTHING LIVE (handoff §6):** PBX tenant **142 `displaydx`** linked
  to DisplayDX (same script, no duplicate shell), outbound profiles 26+27; **ext 101** (PBX id 668,
  `T142_101` + `T142_101_1`, every field = T6's, DTMF rfc4733 both); **ring groups 800–807**
  field-for-field = T6's (create THEN edit — the writer never sets answered_elsewhere /
  allow_diversions / own CoS); **Connect IVR drafts** "Displaydex" + "Quick sat main" from the
  read-only migration plan, prompts byte-identical, **0 publishes / 0 mappings**. All 20 applies
  re-baked clean; doorways + T6 untouched; Ellie's numbers still route to T6 IVR 16/17.
- ⏳ **Switch night = handoff §6a runbook**, staged on loopcom `/root`, dry runs clean:
  `displaydx-switch-pbx.ts` (DIDs → T142 + inbound routes) and `displaydx-connect-move.ts`
  (1,289 contacts, 8 threads, 15 voicemails w/ key rewrite, 62 CDRs, devices…). Eli signs in once.
  ⚠️ Known diffs: Eli's hold music (T6 moh3 "main" vs T142 default — form can't set it), desk
  mobile_client off.
- ✅✅ **FULL BACKFILL DONE BEFORE THE SWITCH (handoff §7) — COPIES, originals untouched so Eli's
  live app keeps working:** 1,289 contacts, 8 SMS threads / 29 messages / 3 attachment files, 13
  voicemails + the mailbox spool (18 files, sha256 identical) copied into DisplayDX; the T142
  sync scanned the copied mailbox and upserted 9/9 onto the copies (0 duplicates). **Proven nothing
  fired:** 0 new emails / escalations / pushes, 0 `audioGoneAt`. Id map
  `/root/displaydx-backfill-map.json`. ⛔ ConnectCdr can't be copied (global `linkedId`) → moved at
  switch. Switch-night Connect script rewritten to re-sync + move + `--remove-originals`
  (dry run: nothing to re-sync yet). ⛔ Lessons: a deploy recreates app-api-1 and wipes
  docker-cp'd scripts; `process.exit` truncates big stdout on the docker pipe.
- No Quicksat Rental exists at Sola or in Connect — Ellie's whole billing footprint was the
  one $30 schedule.
