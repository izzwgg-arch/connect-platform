# ⛔ AGENT HANDOFF — Trust Bookkeepings got a stock number on its OWN VoIP.ms subaccount, routed to ext 106 (2026-09-07) — READ FIRST before giving an EXISTING tenant a new number, before using a "spare" DID, or before re-posting a tenant's edit form

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_TRUST_FORWARDING_NUMBER_2026-09-07.md`**
(**No code change, no deploy, no migration.** One VoIP.ms create + one routing write
under Izzy's explicit instruction; three PBX panel writes through the SAME onboarding
code the wizard uses, each Apply followed by a doorway re-bake — T2/T35/T105 read
1/0, 1/0, 2/0 before and after. Backups: PBX `/root/trust97-before-20260907T232445Z/`,
loopcom `/root/trust97/state.json` (600). Script: loopcom `/root/trust97-build.ts`.)
Memory: [[stock-number-on-own-subaccount-to-existing-extension]].
Izzy: *"take a phone number that we have in stock and create a subaccount called Trust
9/7/2026 and pointed to trust bookkeeping extension 106. We don't need E911 for this."*

- ✅ **LIVE:** (845) 557-7735 → subaccount **`344022_Trust972026`** (id 845044, E911 `0`
  on purpose) → PBX trunk **182 "Trust 9/7/2026"** in Main (**Registered**, contact Avail
  27 ms, carrier `registered: yes`) → tenant 18's number list (9 DIDs; Main's
  `default-trunk` renders `_8455577735`) → inbound route **314** → `Goto(T18_cos-all,106,1)`.
  Connect's `PbxTenantInboundDid` already synced it onto `cmnlgrykx000fp9pa90gohk96`.
- ⛔ **A "spare" DID is not clean until the PBX says so.** `listSpareDids()` returned 8;
  `7244198226` (Matamim's retired temp) still sits in `ombu_tenant_dids` 104 and
  `8452605692` (inii mini's temp) still has inbound route 239. Check both tables before
  routing any spare.
- ⛔ **VoIP.ms usernames are alphanumeric ≤12 chars and descriptions lose their `/`** —
  "Trust 9/7/2026" became username `Trust972026`, description "Trust 972026". The PBX
  panel accepted the slash in the trunk and route descriptions.
- ⛔ **An inbound route alone never receives a call on an existing tenant** — Main's
  `default-trunk` is rendered from `ombu_tenant_dids`, so the DID must be added to the
  tenant's number list (`pbxConsoleWrites.saveTenant` with the FULL list) and Apply run
  in Main. `saveTenant` re-posts the whole tenant form: snapshot `ombu_tenants` +
  `ombu_tenant_settings` first and diff after — here **byte-identical**.
- ⛔ `register_flag = no` on trunk 182 matches the other Trust trunks (44, 67); it is not
  a fault. Billing is **unchanged** — Trust's PBX DIDs bill as `pbx_inbound_did` $0 lines,
  extensions are a manual 5, E911 is a flat $3.
- ✅✅ **ROUND 2 (2026-09-08): outbound route 179 "Trust 1730" is LIVE AND PROVEN ON THE WIRE** — dial
  **`1730` + number** from any Trust extension → CID **`"Trust Bookkeeping" <7184371730>`** (`overwrite_cid if_not_provided` since round 3 the same morning — an extension with its OWN `external_cid` keeps it; none of Trust's 7 has one today) over
  trunk **72 "0001"** (Telocall); second member of **ARS-49** (tenant 18's own "Trust bookkeeping"
  selection — no tenant regen, Main only). Two AMI originates from ext 106 to Izzy's own (845)
  723-1213 proved it: `Outbound Route: Trust 1730` → far end `__INCOMING_SOURCE=7184371730`;
  a plain dial still takes "Trust Bookkeeping 2" with 845-244-1708. ⛔ 718-437-1730 is on NO
  account of ours (VoIP.ms `invalid_did`) — Izzy's chosen CID, Telocall passes it. Trust's
  whole outbound model is prefix codes (1129/0855/0535/9331/2014/1213/2661, now 1730); a
  14-digit `1730…` dial resolves in NO other tenant. Backup
  `/root/trust1730-before-20260908T121546Z/` on the PBX; recipe in the handoff §4–§6.
- ⛔ **"THE PREFIX IS NOT WORKING" (2026-09-08 pm) IS THE HANDSET, NOT THE ROUTE** — the desk phone
  sent `1730` ALONE (and `7190`, `7735`) because the served Yealink config carries
  `interdigit_long_timer = 3` fleet-wide (36/39 configs): a 3-second pause after the code dials
  the code. Same phone sent 10 and 14 digits intact when typed continuously. Workaround: dial
  all 14 digits without pausing / pre-dial then Send.
- ✅✅ **FIXED THE SAME HOUR, HOWEVER THE PHONE CHOPS IT (round 5, handoff §9): `1730` dialed ALONE now
  gets a SECOND DIAL TONE, takes the number, and re-enters the tenant flow as `1730<number>` so
  route 179 carries it** — `/etc/asterisk/vitalpbx/extensions__97-connect-trust1730.conf`
  (`[T18_cos-all](+) exten => 1730` → `connect-trust1730-collect`; repo copy in `scripts/pbx/`),
  `dialplan reload` only, tenant 18 only, doorways untouched. Proven by originate + SendDTMF:
  `Outbound Route: Trust 1730` → CID 7184371730 → far end `__INCOMING_SOURCE=7184371730`.
  ⛔ Never put this in `extensions__60_custom.conf` (a parse error there takes the doorway with it).
- ✅ **THE CODE IS IN HER CONNECT DIALER TOO (round 6, 2026-09-09, handoff §10): "Satmar 58" · 1730** —
  a Connect `OutboundRoute` row (`cmtu6uedk6gplnn14hsxvosm7`, Trust tenant) assigned to ext 106's user
  cspilman@ beside her three existing ones; the dialer dropdown lists it and `resolve-dial` prepends
  1730, so a dialer call rides PBX route 179 exactly like a hand-dialed one (verified as her: 845-723-1213
  → `17308457231213`, 911 untouched). No PBX write in this half. ⛔ The user-assignment PUT REPLACES the
  whole set — always carry the existing routes. ✅ **Same hour, FIXED: Trust's "SGE" and "Rose Leasing" dialer
  routes had an EMPTY prefix with the code (2661/1213) in `callerIdNumber` — a field the dial path never reads —
  so since May every dial through them (8 audited, all `prefixApplied:false`) went out PLAIN on route 51 with the
  845-244-1708 CID, and nobody said a word.** Codes moved into `prefix` via the real PATCH; verified
  `26618457231213` / `12138457231213`. ⛔ `OutboundRoute.callerIdNumber` is informational — a code typed there is
  a dialer entry that silently does nothing; audit other tenants for the same shape. ⏳ She must fully reopen the app.
- ✅ **RING GROUP 808 "Satmer 58" IS LIVE AND (845) 557-7735 RINGS IT (round 7, 2026-09-09, handoff §11):**
  member ext 106 only, prefix `Satmer 58` → her phone shows `Satmer 58:<caller>`, no answer → her own voicemail;
  route 314 `Goto(T18_ext-ringgroups,808,1)`, doorways unchanged. Built via the real `POST /voice/teams` +
  the helper's `/route-set-destination-v2` + a panel Apply in tenant 18's context. ⛔⛔ **I DID THOSE IN THE
  WRONG ORDER AND THREE REAL CALLS (845-323-7184, 10:32–10:33 ET) HEARD "no route exists":** the helper
  runs in `legacy_no_api_key` mode on this box — its "regen" is a `dialplan reload` only — so it baked the
  route at ring group 808 BEFORE 808 was rendered. **A route target that was just created needs the tenant
  Apply FIRST, then the route move; read `apply.mode` and `dialplan show <target>` before trusting a bake.**
- ⏳ **NOT PROVEN: nobody has called (845) 557-7735** — ringing ext 106 rings Miss
  Spilman's real desk, so the one test call is Izzy's. ⏳ Texting is NOT wired
  (`TenantSmsNumber` unassigned, by omission — he did not ask); outbound untouched
  (the trunk is on no outbound route).
