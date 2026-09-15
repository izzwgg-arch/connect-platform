# ⛔ AGENT HANDOFF — Display Decks SPLIT: existing tenant → NEXUS REALTY (Michael owner), new billing-only tenant DISPLAYDX (Ellie); $90 of missed cycles invoiced, NOT charged; ⛔ PHONES NOT MOVED (2026-09-15) — READ FIRST before touching either tenant's billing, moving their phones, or "why does Eli's portal say Nexus Realty"

Full handoff: **`docs/ai-context/AGENT_HANDOFF_DISPLAYDX_NEXUS_SPLIT_2026-09-15.md`**
(backup `loopcom:/root/displaydx-split-backup-20260915.json`; script
`loopcom:/root/displaydx-split.ts`, run live 2026-09-15, Connect DB only — no charge, no
Sola write, no PBX write, no email). Memory: [[displaydx-nexus-realty-split]].

- ✅ **Old tenant `cmnlgryom001fp9paw7le6582` renamed "Nexus Realty"**, Michael
  (`michael@nexusrealtyad.com`) → TENANT_ADMIN, default card → his Amex ····1005, **autopay
  OFF** — Michael pays $65/mo via his LIVE Sola schedule `c112585121_s11766473` (ran Aug 26,
  next **Sep 26**). The rename HEALED the §5 Secro-handoff mis-map: the "Nexus Realty" link's
  companyName now matches its tenant. Cutover to Connect billing = later decision (dormant
  TenantBillingProfile "Nexus Realty" = 2 ext @ $30 + DID 8453647474 documents his side).
- ✅ **New tenant DisplayDX `cmu31fp430000pfje5qh86dja`** (billing-only, YS-Plumbing pattern):
  Ellie's Visa ····0213 default, $30/mo (manual qty 1 extension, same as always), day 28,
  terms 15, **autopay ON**, billingEmail eli@displaydex.com. The inert CUTOVER_COMPLETE
  displaydex Sola link moved with the card.
- ✅ **Ellie's last charge ever was 2026-05-28 ($30)** — Sola's own schedule died at the May
  cutover (live-probed IsActive false) and Jun/Jul/Aug 28 were block-eaten. **Three OPEN
  invoices created on DisplayDX: CC-202609-00007/8/9, $30 each, $90 total — NOT charged, NOT
  emailed** (0 EmailJobs). ⏳ Collect on Izzy's GO (charge / payment link / email).
- ✅ **Worker resumes Ellie's normal billing by itself: T-3 invoice Sep 25, charge Sep 28** on
  the Visa. ⛔ Don't hand-create the Sep 28 invoice; the worker never charges the 3 late ones.
- ⛔⛔ **PHONES/EXTENSIONS/NUMBERS/USERS NOT MOVED — Izzy's explicit "don't move any phones
  yet."** Later: DisplayDX gets ext 101 (Eli) + 104 (Yehuda, ⚠️ his email is
  @nexusrealtyad.com — confirm side) + numbers 212-888-0885 / 845-200-3535 / 845-414-3736;
  Nexus keeps ext 102 + 103 + 845-364-7474. **Eli's login still sits on the renamed tenant, so
  his portal shows "Nexus Realty" until his user moves with the phones** — moving it early
  breaks his working softphone.
- No Quicksat Rental exists at Sola or in Connect — Ellie's whole billing footprint was the
  one $30 schedule.
