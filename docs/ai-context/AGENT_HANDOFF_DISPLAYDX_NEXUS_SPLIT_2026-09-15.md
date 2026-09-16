# AGENT HANDOFF — Display Decks split into NEXUS REALTY (Michael, existing tenant renamed) + DISPLAYDX (Ellie, new billing-only tenant); Ellie's 3 missed cycles invoiced, NOT charged; ⛔ PHONES NOT MOVED YET (2026-09-15)

Izzy, 2026-09-15: *"Display Decks is made out of two different companies, and I want to split
them up … The existing Display Decks account should be changed to Nexus Realty, and the owner
is going to become Michael. Ellie is Displaydex, Quicksat Rental, and the other one … Everything
else is going to become a new account called DisplayDX … Michael stays on that credit card,
Ellie on his credit card … check Sola. When was the last time Ellie was charged, and create
invoices from then till now? … don't move any phones yet."*

Related: `AGENT_HANDOFF_SECRO_FIXUP_SOLA_MISMAP_2026-09-09.md` (§5 predicted exactly this tenant's
blocked autopay), `AGENT_HANDOFF_YS_PLUMBING_BILLING_ONLY_TENANT_2026-08-31.md` (billing-only
tenant pattern). Memory: [[displaydx-nexus-realty-split]], [[autopay-blocked-by-a-mis-mapped-sola-link]].

## 1. What was true before (all proven live 2026-09-15)

- Tenant `cmnlgryom001fp9paw7le6582` "Displaydex" (PBX tenant 6) held BOTH companies:
  exts 101 Eli Lovi / 102 Michael Fromowitz / 103 Micheal Cell / 104 Yehuda Tyberg; numbers
  (212) 888-0885, (845) 200-3535 (texting DID, assigned ext 101), (845) 364-7474, (845) 414-3736.
- **Two imported cards:** Visa ····0213 exp 10/28 = Sola customer `c112244410` "displaydex corp."
  (**Ellie's**, was tenant default) and Amex ····1005 exp 10/30 = Sola customer `c112585121`
  "Nexus Realty" (**Michael's**).
- **Ellie's last charge ever = 2026-05-28, $30** (invoice CC-202605-00035, PAID, Visa ····0213,
  the tenant's only invoice). Sola's own displaydex schedule `c112244410_s11674189` was disabled
  at cutover 05-28 (live probe: IsActive false, last ran Apr 28). **Jun 28 / Jul 28 / Aug 28
  cycles were all lost** to the mis-mapped Nexus link blocking autopay (294
  `billing.autopay_skipped_active_sola_schedule` events) — $90 uncollected, exactly as the
  Secro handoff §5 predicted.
- **Michael IS paying:** Sola schedule `c112585121_s11766473` "Nexus Realty" $65/mo is LIVE at
  Sola — ran 2026-08-26 Approved, next run **2026-09-26**, card Amex ····1005. Never cut over
  (TOKEN_LINKED).
- A dormant `TenantBillingProfile` "Nexus Realty" already described Michael's side:
  **2 extensions @ $30 + DID 8453647474 @ $0**, Amex, billingEmail Michael@nexusrealtyad.com —
  i.e. Michael = exts 102 + 103 + the ····7474 number, matching Izzy's instruction.
- No Quicksat Rental (or any other Ellie company) exists anywhere at Sola or in Connect —
  Ellie's whole billing footprint is the one $30 displaydex schedule.

## 2. What was DONE (script `displaydx-split.ts`, run live 2026-09-15 ~21:00Z inside app-api-1; Connect DB ONLY — no card charge, no Sola write, no PBX write, no email)

Backup of every touched row: `loopcom:/root/displaydx-split-backup-20260915.json` (600).
Script source kept at `loopcom:/root/displaydx-split.ts` (removed from the container after run).

| Step | Result |
|---|---|
| N1 | New tenant **DisplayDX `cmu31fp430000pfje5qh86dja`** (CUSTOMER, approved, billing-only — no PBX link, no extensions, no users yet; YS Plumbing pattern) |
| N2 | Ellie's Visa ····0213 moved to DisplayDX, default there |
| N3 | DisplayDX billing settings: **$30/mo (manual quantity 1 extension — byte-identical to the old pricing)**, day 28, terms 15, **autopay ON**, billingEmail `eli@displaydex.com`, taxEnabled false |
| N4 | The displaydex Sola link (CUTOVER_COMPLETE, inert) re-pointed to DisplayDX — books follow the card |
| N5 | Old tenant renamed **"Nexus Realty"** — which also HEALS the mis-map: the Nexus link's companyName now matches its tenant |
| N6 | Nexus Realty billing: default card → Michael's Amex ····1005, **autopay OFF** (Michael pays via his live Sola schedule; Connect must not double-bill, and the Sep 25/28 block-alarm will no longer fire) |
| N7 | Michael (`michael@nexusrealtyad.com`) → **TENANT_ADMIN** (account owner) |
| N8 | **3 OPEN invoices on DisplayDX, $30 each, $90 total, NOT charged, NOT emailed** (skipInvoiceEmail; EmailJob count for the tenant = 0): CC-202609-00007 (Jun 28→Jul 28, due Jul 13), CC-202609-00008 (Jul 28→Aug 28, due Aug 12), CC-202609-00009 (Aug 28→Sep 28, due Sep 12) — dueDate = period start + the tenant's 15-day terms, 23:59:59 NY |

All eight steps container-verified by direct SQL afterwards (tenants, cards, settings, link,
role, line items "Billable extensions 1 × $30", zero EmailJobs).

## 3. What happens next BY ITSELF

- **DisplayDX (autopay ON, Visa ····0213 default): the worker creates the Sep 28→Oct 28 invoice
  at T-3 (Sep 25) and charges Ellie's Visa on Sep 28.** Normal billing is restored from that
  cycle on. ⛔ Do not hand-create the Sep 28 invoice.
- The 3 back invoices stay OPEN — the worker never charges late by design
  (`autopay_charge_window_missed`); they are collected by hand or payment link only.
- ~~**Nexus Realty: Sola charges Michael's Amex $65 on Sep 26**~~ — **NO LONGER TRUE as of
  2026-09-16, see §3c.** Sola is disabled; **Connect** charges the $65 on Sep 26.

## 3b. ✅ COLLECTED 2026-09-15 19:19Z (Izzy: "Charge his card for all those invoices. Send it out to him by email before you charge the card, then charge it.")

Script `loopcom:/root/displaydx-collect.ts` (guards → emails → wait for SENT → charge, oldest
first, STOP on first non-approval, never retries a charge). All three invoice emails were
**SENT to eli@displaydex.com BEFORE any charge**, then all three charges on Visa ····0213
**APPROVED**: CC-202609-00007 ref 11050937980, CC-202609-00008 ref 11050938015,
CC-202609-00009 ref 11050938046 — $90 total, all three invoices PAID balance 0, and all three
BILLING_RECEIPT emails SENT. Container-verified by SQL afterwards.

## 4. ⏳ NOT DONE — needs Izzy / a later task
2. **⛔ PHONES/EXTENSIONS/NUMBERS/USERS NOT MOVED — Izzy's explicit instruction.** The later
   move: DisplayDX gets ext 101 (Eli) + ext 104 (Yehuda) + (212) 888-0885 + (845) 200-3535 +
   (845) 414-3736; Nexus Realty keeps ext 102 + 103 + (845) 364-7474. ⚠️ Yehuda's login email
   is `yehuda@nexusrealtyad.com` — confirm with Izzy which side Yehuda really belongs to (the
   Nexus billing profile counts only 2 extensions, so he is presumed Ellie's).
3. **Eli's and Yehuda's logins still sit on the renamed tenant** — Eli will see "Nexus Realty"
   as his company name in the portal/app until his user moves with the phones. Moving his user
   row early would break his working softphone (ext 101 + webrtc config live on the old
   tenant), so it was deliberately left.
   ⛔⛔ **THE APP-SWITCH TRAP (traced 2026-09-15 for the planned move):** the login token
   bakes `tenantId` in at sign-in (`issueLoginSession`, `server.ts` ~6316), sessions never
   expire, the preHandler trusts the claim (`jwtVerify` only — no per-request user-row read),
   and the mobile app has NO token-refresh path — a QR scan while logged in only redeems SIP
   provisioning, it does NOT replace the session token (`QrProvisionScreen.tsx:73` logged-in
   branch). So moving Eli's User row alone leaves his live app operating on the OLD tenant's
   data indefinitely. Zero-downtime options: (a) a token tenant-migration shim in the
   preHandler (explicit sub→newTenant map, override `req.user.tenantId` after verify;
   MUST deploy BEFORE the row moves — every ownership guard compares resources to the
   effective tenant, so claim-override + moved rows stay consistent), or (b) accept a
   ~1-minute sign-out/sign-in (needs his password; SIP keeps ringing through the move since
   PBX tenant 6 registration is untouched by the Connect-side split).
4. ~~**Nexus Realty's move onto Connect billing**~~ — ✅ **DONE 2026-09-16, see §3c** ($65 flat,
   day 26, Sola disabled). The admin tenant's "coat one" link is still open, same shape.
5. When phones move, extension quantity overrides on BOTH tenants need Izzy's pricing call
   (today: DisplayDX bills a manual quantity of 1 @ $30; 4 real extensions exist on the old
   tenant and 3000-series manual counts were never per-extension-accurate).

## 3c. ✅✅ NEXUS CUT OVER TO CONNECT BILLING — 2026-09-16 02:10–02:11Z (Izzy: "stop it there, switch it over to Connect (same payment date as it is in Sola)")

Backup of every touched row first: `loopcom:/root/nexus-cutover-backup-20260916.json` (600).

| # | Step | Proof |
|---|---|---|
| 1 | **Dormant billing profile "Nexus Realty" `autoBillingEnabled` → false** (route `PUT …/billing-profiles/:id`) | 200; `billing.profile_updated`; profiles-with-autopay count = 0 |
| 2 | **`billingDayOfMonth` 28 → 26 + flat rate $65.00** ("Monthly service", `appliesTo:extensions`), one `PUT /admin/billing/tenants/:id/settings` | 200; Oct preview = **6500**, single line + 4 numbers at $0 |
| 3 | **Cutover** `POST …/billing-cutover/take-over` (3 confirm flags) | 200 `{nextConnectChargeAt:"2026-10-26T04:00:00.000Z"}`; events started → disabled → autopay_enabled → completed |
| 4 | **Both charge guards moved Oct 26 → Sep 26** | link `nextConnectChargeAt` = 2026-09-26 04:00; `billingScheduleOverride.nextPaymentDate` = "2026-09-26"; event `billing.sola_cutover_next_charge_adjusted` |
| 5 | **Live Sola read-back** (read-only `GetSchedule`) | `IsActive:false`, Revision 24→**25**, ModifiedDate `2026-09-15 22:10:37.144`, Amount still 65, LastRunTime Aug 26 |
| 6 | **Nothing fired** | 0 PaymentTransactions, 0 EmailJobs, invoice list unchanged (still only the old `CC-202605-00035`) |

**⛔⛔ THE TRAP — `takeOverBillingFromSola` assumes Sola ALREADY charged the current period.**
It computes `nextConnectChargeAt` as the start of the *next* period from `buildBillingSchedule`.
Nexus was stopped at Sola **before** its Sep 26 run, so the helper handed back **Oct 26** and
September would simply have gone uncollected — no invoice, no charge, no alarm, a free month for
the customer and $65 gone. Anyone cutting a tenant over BEFORE its next Sola run must move **two**
guards, not one: the link's `nextConnectChargeAt` **and**
`TenantBillingSettings.metadata.billingScheduleOverride.nextPaymentDate`. Both are "do not charge
before this date" gates and either one alone still skips.

**⛔ The second landmine: `TenantBillingProfile`.** Nexus carried a dormant profile
(2 ext @ $30 = $60, `autoBillingEnabled:true`) that had never fired *because the tenant's own
autopay was off* — `runBillingProfilesForTenant` is called only inside the autopay-tenant loop.
Enabling tenant autopay would have armed it, producing a second invoice and a second charge on
the same Amex on the same day. The cutover route does **not** check for this. It was turned off
in step 1, before autopay existed on the tenant.

**⛔ Pricing was a real fork, and it was Izzy's call.** Connect's engine computed **$30** for
Nexus (extensions pinned to `billingQuantityOverrides.extensions = manual 1` while **4** are
ACTIVE), the dormant profile said **$60**, and Sola actually billed **$65**. Izzy chose "$65 —
same as Sola", implemented as `metadata.billingFlatRate` so the price is immune to the manual-1
override and to the coming phone split. ⛔ Do not "fix" the manual-1 override expecting the bill
to change — with a flat rate enabled it no longer feeds the total.

**Replayed against the DEPLOYED code before calling it done** (read-only, real settings row):

| Worker run | Result |
|---|---|
| Sep 23 07:15Z | `reminderDue:true` → creates invoice **Sep 26 → Oct 26**, reminder email to Michael; charge correctly blocked |
| Sep 26 07:15Z | `due:true`, activeSola **none**, cutover block **none**, override **charge**, paid-coverage **none** → **$65 charged on Amex ····1005** |
| Oct 26 07:15Z | `due:true`, all clear → next $65 |

⏳ **NOT PROVEN: no charge has actually run on this rail yet** — the first one is **Sep 26**.
Sola is already off, so if that charge fails there is no fallback; it needs eyes on the 26th.
⛔ Michael starts receiving Connect emails (invoice, T-3 reminder, receipt) at
`Michael@nexusrealtyad.com`, first one **Sep 23** — Sola never emailed him anything.
Rollback if ever needed: re-enable schedule `c112585121_s11766473` at Sola, set
`autoBillingEnabled=false`, restore the settings row from the backup JSON.

## 4b. ⛔⛔ THE PHONE/IVR MOVE WAS STOPPED BEFORE ANY LIVE WRITE (2026-09-15 evening)

Izzy asked to move Eli's app + voicemails/calls/texts to DisplayDX with zero downtime and to
migrate his IVRs from the original Displaydex. **Nothing was moved** — tracing proved the only
design that keeps Eli on PBX tenant 6 (a second `TenantPbxLink` from DisplayDX → T6) breaks
live call paths. Every item below was verified in code or on the live PBX (read-only).

**Who owns what on the PBX — proven from the RENDERED dialplan
(`/etc/asterisk/vitalpbx/extensions__50-6-dialplan.conf:718-751`), not table decoding:**

| DID | PBX route label | Rendered Goto | Rings |
|---|---|---|---|
| 845-200-3535 | Displaydex | `T6_app-ivr,IVR-16` ("Displaydex": 1→rg 802 DD Sales, 2→801 DD Customer Support, 3→800 DD Accounting; invalid/timeout → VM 101) | ext 101 |
| 212-888-0885 | Quick Sat Rental | `T6_app-ivr,IVR-17` ("Quick sat main": 1→807 Bookings, 2→806 Customer service, 3→805 Tech support, 4→804 Billing, 0→803 Other; invalid/timeout → VM 101) | ext 101 |
| 845-364-7474 | Nexus | `T6_app-time-condition,TC-3` ("Nexus Realty", Mon–Sat 9–5; open → IVR-18, closed → pre-announcement 6) | Nexus |
| **845-414-3736** | **Nexus 2** | `T6_app-ivr,IVR-18` ("Nexus Main": 1→808 nexus sales, 2→809 NXR Inquiries, 0→900 NXR Receptionist, 102→ext 102, **104→ext 104**; invalid/timeout → ext 103) | Michael/Yehuda |

Ring groups 800–807 ring only ext 101 (pbx extension_id 33); 808/809/900 ring only ext 102
(id 34). Recordings: 32 "Displaydex main", 33 "Quick sat main", 34 "Mexus Main", 35 "nexus after
hours". No queues. Dial-by-extension (`freedial`) is ON for IVR 16 only.
⛔ **So 845-414-3736 and ext 104 (Yehuda) are MICHAEL'S side, contradicting §4.2's earlier
presumption.** Ellie's side = ext 101 + 845-200-3535 + 212-888-0885 + IVRs 16/17 + rg 800–807.
Izzy said Ellie has three companies — only two exist on the PBX; the third is unconfirmed.

**Connect rows that are Ellie's (read-only census):** all 1,289 contacts (created by eli@);
all 8 SMS threads (+18452003535, inbox owner Eli); voicemails ext 101 = 15; CDRs 62 Eli /
39 Nexus / 37 no owner marker (0 touch both sides); MobileDevice ×2 (iOS + Android, ext 101);
VoicemailEmailRecipient for 101; 1 UserCustomRole + 1 CrmUserAccess (both tenant-scoped).

**⛔⛔ WHY TWO CONNECT TENANTS ON ONE PBX TENANT IS UNSAFE — the platform assumes one Connect
tenant per VitalPBX tenant, resolved by last-wins maps or unordered `findFirst`:**
- **Ringing:** `resolvePbxEventTarget` (`server.ts:~4320`) does
  `tenantPbxLink.findFirst({ pbxTenantId })` then looks up the extension inside THAT tenant —
  if it picks Nexus after 101 moved, it returns null → **no CallInvite, no INCOMING_CALL push,
  Eli's app does not ring.** Same `findFirst` in the invite lookup (`~4481`) and
  `/internal/pbx/wake-extension` (`~36739`). VERIFIED.
- **Call history:** `pbxTenantResolve.ts` returns on the `T6_` marker via last-wins
  `connectByVital` before any DID lookup → every T6 call files under one tenant. VERIFIED.
- **IVR import:** `POST /voice/ivr/migration/import` picks its target with an unordered
  `tenantPbxLink.findFirst({ pbxTenantId })` (`server.ts:~27045`) — cannot target DisplayDX,
  and upserts a DidRouteMapping for EVERY DID reaching the menu. VERIFIED.
- Also (agent trace, not individually re-verified): telephony live-call tagging, extension
  sync (only one tenant per PBX tenant synced per run), `PbxTenantInboundDid.connectTenantId`
  sync rewrites all T6 DIDs to one tenant, IVR publish top-level AstDB keys
  `connect/t_<slug>/*` shared (the two reconcilers would ping-pong + alert), prompt/MOH catalog
  sync, `connect/t_<slug>/interrupted` shared, worker active-call/CDR polls run T6 twice.

**Mobile app facts (traced for zero-downtime):** the login token bakes `tenantId`, never
expires, and the app has NO refresh path. SIP creds are cached on device (registration
survives). Incoming-call pushes (`INCOMING_CALL`) are NOT tenant-filtered in the app
(`NotificationsContext.tsx:~150` returns before the guard); voicemail / missed-call / SMS
alert banners ARE (`isNotificationForCurrentUser`, positive tenant mismatch → dropped).
The telephony WebSocket trusts the token's tenant directly (`TelephonySocketServer.ts:~189`).
`MobileDevice.tenantId` must move with the user or pushes find no device.

**A session-tenant shim was written, tested (20/20) and then REMOVED unshipped:** a preHandler
that rewrote `req.user.tenantId` from the user row (cached 60s, fail-open, SUPER_ADMIN exempt)
plus a sync guard skipping extensions claimed by another tenant. They only serve the unsafe
two-links design; under a real PBX split Eli's SIP identity changes anyway (T6_101 → new
tenant), so a one-time re-sign-in is unavoidable and the shim would add per-request DB reads
for nothing. Recreate from this description if a future move needs it — it also needs the
same lookup in telephony (WS connect + `getTenantId`) to be complete.

**Options put to Izzy:**
- **A (recommended): real PBX split** — a new VitalPBX tenant for DisplayDX built through
  Connect's sanctioned PBX-tenant build path (PBX write → needs Izzy's approval), replicate
  ext 101, rg 800–807, IVRs 16/17 + recordings 32/33, repoint the two DIDs' inbound routes;
  then link DisplayDX to it, move Connect rows (user, devices, voicemails, CDRs, SMS threads,
  contacts, custom role, CRM access), import IVRs from the NEW tenant, publish. Eli signs in
  once (~1 min); numbers flip at night (~35–40 s each).
- **B:** make the platform support per-extension/per-DID ownership inside one PBX tenant —
  ~25 code sites on the live call path, multi-day, high regression risk.
- **C:** leave phones where they are; the billing split (the money) is already done.

## 6. ✅ THE REAL PBX SPLIT IS PREPPED — NOTHING LIVE (2026-09-15 evening, Izzy: "do a real PBX split, but don't make it live yet. Just prep everything for a quick switch.")

Every PBX write went through Connect's sanctioned writers (PBX Console routes → mirror tenant
create / panel replay + `applyAndRebake`), each verified afterwards against `ombutel` rows AND the
rendered config — never the route's own 200. **After every one of the 20 applies:** the doorway
lines stayed at T1:3 / T2:1 / T105:2, the re-bake reported 2/2 tenants, `linesChanged 0`,
`failed 0`, and tenant 6 stayed at 4 extensions / 11 ring groups / 5 routes / 3 IVRs / DIDs
8452003535, 2128880885, 8453647474.

**Built (live on the PBX, reachable by NO number):**
| Piece | Result |
|---|---|
| PBX tenant | **142 `displaydx` "DisplayDX"**, path `73eb959f065ba613`, 13 rendered files, outbound profiles **26 Displaydex + 27 Quick Sat Rental** (Ellie's own caller-ID routes; 24 = Nexus, CID 845-414-3736), recordings allowed, retention copied |
| Connect link | DisplayDX → **T142** linked in the SAME script milliseconds after create (the 5-min auto-sync would otherwise mint a duplicate Connect tenant — none appeared). T6's Connect telephony fields (webrtc/sip/dtmf/media/sms) copied onto DisplayDX first |
| ext 101 "Eli Lovi" | PBX ext id **668**; desk `T142_101` (device 1272) + app `T142_101_1` (device 1273, WebRTC, 5 contacts); every general field byte-matches T6 ext 101 (both CIDs, feature PIN, rec in/out, call waiting, cid_on_diversions, language, VM pwd + attach/saycid/sayduration/envelope). Both render `dtmf_mode=rfc4733` (the writer's WebRTC default rendered `auto`; corrected via the console edit route with both devices passed explicitly). Connect synced an unowned DisplayDX ext 101 row (link has a SIP password, PENDING) |
| Ring groups 800–807 | 8 groups, ids 125–132, field-for-field equal to T6's 13–20: ringall, ringtime 0, music 1, prefix = name, **tenant's own CoS 143**, answered_elsewhere + allow_diversions ON (renders `_IGNORE_DIVERSIONS=no` ×16), member ext 668, no-answer → vm_direct 668. ⛔ The create writer never sets those two switches or the CoS — each group is create THEN edit |
| Connect IVR drafts (DisplayDX) | "Displaydex" `cmu37n6900oduqk13av09dvqy` (prompt `custom/displaydx_main_vpbx32`, 10 s, 3 tries, **dial-by-extension ON**, keys 1→802, 2→801, 3→800) and "Quick sat main" `cmu37n6f10oe2qk13trwrbpqq` (prompt `custom/displaydx_quicksat_vpbx33`, 10 s, 3 tries, OFF, keys 1→807, 2→806, 3→805, 4→804, 0→803); invalid + timeout → `sub-extensions-vm,VM-101,1` on both; values from the read-only `POST /voice/ivr/migration/plan` of T6 IVR 16/17 (no problems/warnings/codes), refs `T6_`→`T142_`. Schedule: Displaydex for every mode (the numbers pick their own menu per DID). Prompts catalogued with the byte-identical PBX recordings (sha256 `8c01f0e6…`, `f0b82a24…`) and pushed to `/var/lib/asterisk/sounds/custom/`. **0 publishes, 0 number mappings, no `connect/t_displaydx` or didmap AstDB keys** |

**Known differences, deliberately left (decide on switch night or later):**
- ⚠️ **Eli's own hold music:** T6 ext renders `moh_suggest=moh3` (group 3 "main", 16 custom tracks); T142 renders `default`. The panel form on T142 offers only "Default"/"None", so the sanctioned writer cannot set it. T6's inbound routes also use music group 3; `createInboundRoute` posts music group "" (default).
- Desk device `mobile_client` is OFF on T142 (ON on T6): the VitalPBX Connect app is unused platform-wide and each ON device spends a licence slot.
- `VM-101` needs no tenant prefix — `sub-send-voicemail` reads `DB(${TENANT}/extensions/101/voicemail)`, so a call entering T142 reaches `101@displaydx-voicemail`. ⏳ Prove with a real call.

**Staged on loopcom `/root` (600), NOT run:** `displaydx-switch-pbx.ts` (dry run clean: T6 keeps
only 8453647474; T142 gets exactly the two numbers — the dry run first caught an empty-form blank
row that would have posted an empty number, fixed), `displaydx-connect-move.ts` (dry run clean,
census below). Already run, kept as the record: `displaydx-pbx-prep.ts`, `displaydx-rg-prep.ts`,
`displaydx-ivr-prep.ts`; recordings in `/root/displaydx-prompts/`. Container copies removed.
Scripts run inside `app-api-1` via `docker cp` → `npx tsx <file>` → `rm`.

**Connect move census (dry run 2026-09-15):** user 1, MobileDevice 2 (tenant + extension), CrmUserAccess
1, outbound permission 1 (Nexus route "QSR" prefix 99 copied to DisplayDX), contacts 1,289 (all
created by Eli, 0 others), SMS threads 8 (dedupeKey `sms:<tenant>:…` rewritten) / messages 29 /
participants 16, Nexus group-chat membership 1 (removed), voicemails 15 (13 `6|101|…` keys →
`142|101|…`, else the T142 sync re-ingests the copied spool as duplicates; 2 legacy-format keys
untouched), VoicemailEmailRecipient 1, ConnectCdr 62 (desk `T6_101-` AND app `T6_101_1-` channels,
or Ellie's DIDs; 0 touch both sides), CallRecord 15 (toNumber 101), CallInvite 37. History tables
stay (AuditLog, VoiceDiagEvent, CallWakeEvent, …). The "Owner" custom role is platform-scoped and
travels with the user.

### 6a. SWITCH-NIGHT RUNBOOK — ✅ EXECUTED 2026-09-16 (see §8: steps 2, 4 and 5 were WRONG or INCOMPLETE as written — read §8a before re-using this for any other split)

0. **Pre-check:** 0 live calls on the two numbers; `displaydx-connect-move.ts` and
   `displaydx-switch-pbx.ts` dry runs still clean; tell Eli he will sign in to the app once.
   Back up every row the move touches (pg `COPY` of the census rows) to `/root`.
1. **Voicemail spool DELTA (PBX, copy never move — the full copy was done 22:16Z 2026-09-15, §7):**
   `for f in INBOX Old Urgent; do cp -an /var/spool/asterisk/voicemail/displaydex-voicemail/101/$f/. /var/spool/asterisk/voicemail/displaydx-voicemail/101/$f/; done && chown -R asterisk:asterisk /var/spool/asterisk/voicemail/displaydx-voicemail`
   (`-n` never clobbers). The T6 original stays until cleanup.
2. **PBX number move:** `displaydx-switch-pbx.ts --live` — T6 number list minus the two, T142 list
   gets them, `createInboundRoute` ×2 on T142 → ext 668, ONE `applyAndRebake`. ⛔ ~1–2 min of no
   answer on those two numbers between the T6 save and the apply. Verify: rendered
   `extensions__50-142-dialplan.conf` has `_8452003535` and `_2128880885`; they are gone from
   `extensions__50-6-dialplan.conf`; doorway counts unchanged; `_8453647474` still on T6.
3. **Connect sync:** refresh tenant DIDs (so `PbxTenantInboundDid.connectTenantId` → DisplayDX) and
   extensions for T142.
4. **Connect re-sync + move (the backfill already copied the history, §7):** `docker cp
   /root/displaydx-connect-move.ts app-api-1:/app/apps/api/` and `docker cp
   /root/displaydx-backfill-map.json app-api-1:/tmp/` → dry run (re-sync plan + move census) →
   `--live` (ONE transaction: PHASE 1 re-sync of anything changed since 22:15Z — edited/new/deleted
   contacts, new SMS threads/messages, voicemail state, voicemails that arrived since (MOVED with
   key rewrite); PHASE 2 move — ConnectCdr, CallRecord to 101, CallInvite, User, ext owner +
   PROVISIONED, devices, CRM access, QSR route copy + permission, texting number, VM email
   recipient, Nexus group-chat membership) → verify Eli's app/portal on DisplayDX →
   `--remove-originals` (dry: writes `/tmp/displaydx-nexus-originals-backup.json`; `docker cp` it
   out to `/root`) → `--remove-originals --confirm` (deletes the Nexus originals the map covers —
   Izzy: "remove it from Nexus"; refuses any original without its DisplayDX copy).
5. **IVR go-live:** `GET /voice/ivr/numbers?tenantId=cmu31fp430000pfje5qh86dja` (mints the two
   mappings) → `POST /voice/ivr/numbers/:mappingId/assign` 200-3535 → Displaydex menu,
   212-888-0885 → Quick sat main → `POST /voice/ivr/publish {tenantId}` → `POST
   /voice/did/:id/switch-to-connect` for each. Verify the rendered T142 route Goto is
   `connect-doorway,s,1`.
6. **Eli signs out and back in** (new SIP identity `T142_101_1`; provisioning then fetches fresh).
7. **Acceptance = real calls, never DB reads:** each number answers with its own greeting; every key
   rings ext 101; no key → voicemail after 3 tries; dialling 101 at the Displaydex menu; a voicemail
   lands under DisplayDX and emails eli@; outbound from Eli shows 845-200-3535 (route 26) / Quick Sat
   route 27 (`overwrite_cid=yes`); a text in and out on 200-3535.
8. **Cleanup — a separate, later task, only after days of clean calls:** T6 routes 30/31 (check
   `ombu_destinations` sharers across ALL tenants first — a route delete cascades its destination
   row), IVRs 16/17, ring groups 800–807, ext 101 on T6 (then `module reload res_pjsip.so` +
   `app_voicemail.so`), the old Connect ext 101 row, T6 spool copy.

**Rollback (any step):** PBX — `saveTenant` the two numbers back onto T6 (routes 30/31 and IVRs
16/17 are untouched there) → apply + rebake. Connect — restore the census rows from the step-0
backup. The prepped T142 objects are harmless to leave in place.

## 7. ✅ FULL BACKFILL DONE BEFORE THE SWITCH — COPIES, ORIGINALS UNTOUCHED (2026-09-15 22:15–22:21Z, Izzy: "do the full backfill before the switch")

**Copy, never move:** Eli's live app stays on Nexus until switch night, so every original stayed
exactly where it was. DisplayDX has no users, so nobody sees the copies until Eli moves.

**Copied in ONE committed transaction (22:15Z):** 1,289 contacts (1,364 phones, 89 emails), 8 SMS
threads (29 messages, 16 participants, 3 attachments as real file copies under
`<DisplayDX>/<newThread>/f_…` — the download route refuses a key that doesn't embed the thread's
tenant + id), 13 voicemails (the 2 legacy msg_id-keyed rows duplicate a pipe row and were skipped;
the 4 with local audio got their own `<copyId>.wav`). **Voicemail spool copied 22:16:17Z**
(INBOX 14 files + Old 4 = 18, sha256 identical, `asterisk:asterisk`) into
`displaydx-voicemail/101`. Id map (original → copy) at loopcom
`/root/displaydx-backfill-map.json` (600).

**Field settings the traced job audit required (each prevents a real side effect):**
- Voicemail key `6|101|X` → `142|101|X` = exactly what the T142 helper-spool sync computes
  (helper rows drop `msg_id`) → **PROVEN: the sync scanned the copied mailbox, 9 messages, 9
  upserts onto the copies, 0 new rows**.
- Voicemail `emailSkipReason` = `predates_feature` when null (a set `emailedAt` + null reason + no
  EmailJob = watchdog `job_missing` → owner SMS); `transcriptError = migrated_copy` when no
  transcript; callback-reminder fields cleared; `pbxRecfile` context → `displaydx-voicemail`
  (playback scans that context).
- ⛔ ORDER: rows first, spool IMMEDIATELY after. Spool first → the 60-s sync ingests bare
  duplicates; rows long without spool → any playback stamps `audioGoneAt` permanently.
- SMS: original `createdAt`/`lastMessageAt` kept (outside the 30-min reconciler + forward windows);
  `emailForwardedAt` stamped when null (the SMS-forward guardrail escalates null post-Aug-20
  messages); participant `lastReadAt = now` (the dashboard unread count selects participants by
  userId with NO tenant filter); `smsProviderMessageId` kept (dedupes the post-switch re-import).
- ⛔ NOT copyable: **ConnectCdr** (`linkedId` globally unique; the app reads history per tenant →
  MOVED at switch), CallRecord (invisible while ConnectCdr rows exist), CallInvite (a PENDING copy
  expires into a MISSED_CALL push to Eli). ⛔ Never run `/admin/cdr/repair-recent` after the CDR
  move — it re-resolves and rewrites `tenantId`.

**Proof nothing fired (baseline 22:14:49Z → 22:20:56Z):** DisplayDX EmailJobs 6 → 6 (tonight's
invoices), AgentEscalations 178 → 178 (latest still 21:03), Eli's NotificationLedger 22 → 22,
`audioGoneAt` 0 on both tenants, every copied message stamped, every copied voicemail
email-safe, Nexus still 1,289 contacts / 15 ext-101 voicemails. Switch-night script dry run:
**nothing to re-sync yet** (0 edited/new/deleted contacts, 0 new threads/messages, 0 new
voicemails); move census 62 CDRs (0 on both sides) / 15 CallRecords / 37 invites / 2 devices.

**Lessons (both bit during this run):**
- ⛔ **A deploy recreates `app-api-1` and wipes every `docker cp`'d script** (22:09:57Z, another
  session's build `7d93d23a`). Re-copy immediately before each run, and put long writes in ONE
  transaction so a mid-run recreation rolls back clean.
- ⛔ **`process.exit()` right after `console.log` of a large JSON truncates it on the
  `docker exec` pipe (cut at ~64 KB)** — the backfill's id map was lost that way. Write big output
  to a file inside the container and `docker cp` it out; the map was rebuilt exactly from the data
  (`displaydx-backfill-map-rebuild.ts`, refuses any ambiguous match).

Scripts on loopcom `/root` (600): `displaydx-backfill.ts` (ran), `displaydx-backfill-map-rebuild.ts`
(ran), `displaydx-backfill-run.log`, `displaydx-connect-move.ts` (REWRITTEN: re-sync + move +
remove, dry run clean), `displaydx-switch-pbx.ts` (unchanged). Container copies removed.

## 8. ✅✅ THE SWAP IS LIVE — 2026-09-16 10:34–11:01Z (06:34–07:01 ET), Izzy: "Do the full swap and end-to-end test it. Make sure everything is working 100%."

**Result, proven by REAL CARRIER CALLS, not DB reads:** 845-200-3535 and 212-888-0885 enter from
VoIP.ms → Main `default-trunk` → **`Forwarding call to DisplayDX tenant` → `T142_default-trunk`** →
T142 inbound routes 318/319 → `Goto(connect-doorway,s,1)` → the Connect menus: 200-3535 plays
`custom/displaydx_main_vpbx32`, 212-888-0885 plays `custom/displaydx_quicksat_vpbx33`. Every key was
probed live and lands on the same ring group T6 used (Displaydex 1→802, 2→801, 3→800; Quick Sat
0→803, 1→807, 2→806, 3→805, 4→804); timeout/invalid → `sub-extensions-vm,VM-101` — **identical to
T6's rendered IVR-16/17**. Every ring group dials `Local/101@T142_ring-group-dial` →
`PJSIP/T142_101&PJSIP/T142_101_1`. 845-364-7474 still → `T6_default-trunk` → "Nexus" (proven by
carrier call); 845-414-3736 untouched on T6. Doorway counts elsewhere unchanged (T1:3, T2:1, T105:2);
T142 now has 2. Reconciler quiet 15 min after go-live.

**Connect move (ONE transaction, `displaydx-connect-move.ts --live`):** Eli's user → DisplayDX; new
ext 101 (`T142_101_1`) owned + PROVISIONED; old Nexus ext 101 unowned; iPhone + moto MobileDevice →
DisplayDX/new ext; texting number +18452003535 → DisplayDX/new ext; VM email recipient
eli@displaydex.com → new ext; QSR outbound route copied + permission; CrmUserAccess; 65 ConnectCdr,
15 CallRecord, 37 CallInvite moved; Nexus group-chat membership removed. **Verified through Eli's own
session** (hand-minted JWT): `/me` = DisplayDX, `/voice/me/extension` = `T142_101_1`,
`/voice/me/calls` 38, voicemail inbox 5 (== what he saw on Nexus — the list hides 0-second
recordings; 10 rows, 8 inbox / 2 old, exact parity with the originals), chat 9, outbound route QSR.
Ring target replayed read-only: PBX tenant 142 → only link DisplayDX → ext 101 owner Eli; T6 ext 101
owner null (a straggler to T6_101 pushes nobody). `wake_canary` is set for both T6_101 and T142_101.
Yehuda (Nexus USER) sees 0 of Eli's calls; Michael (Nexus admin) sees 0 of Eli's voicemails / calls /
texts.

**Originals removed from Nexus (`--remove-originals --confirm`):** 1,289 contacts (ALL `createdBy`
Eli — Nexus had no other contacts, so Nexus now correctly shows 0) and 8 SMS threads HARD-deleted;
15 ext-101 voicemails **SOFT-deleted** (trap 5). Backup
`loopcom:/root/displaydx-nexus-originals-backup-20260916.json` (980 KB).

**Backups on loopcom `/root` (all 600):** `displaydx-premove-snapshot-20260916.json` (every row the
move rewrote), `displaydx-nexus-originals-backup-20260916.json`,
`displaydx-ivrschedule-before-20260916.json`, `displaydx-probe-cdrs-backup-20260916.json`; logs
`displaydx-switch-pbx-live.log`, `displaydx-connect-move-{dry,live}.log`,
`displaydx-remove-{dry,confirm}.log`. PBX: `/root/displaydx-probe-voicemails-20260916/` (the 8
quarantined probe voicemails), `/root/displaydx-carrier-probe.sh`.

### 8a. ⛔⛔ THE FIVE THINGS THE RUNBOOK GOT WRONG — each one would have left it broken

1. ⛔⛔ **Apply in the T142 context does NOT regenerate Main's DID→tenant dispatch.** After
   `displaydx-switch-pbx.ts --live` (saveTenant ×2 + routes + `applyAndRebake(T142_PATH)`),
   `ombu_tenant_dids` correctly said 142 and the T142 + T6 files re-rendered — but
   `extensions__50-1-dialplan.conf` kept its 09-15 17:39 mtime and **still forwarded both numbers to
   `T6_default-trunk`**. The tenant number list is saved THROUGH Main, so Main's config must be
   generated too: `applyAndRebake(s, MAIN_TENANT_PATH_DEFAULT /* 2dc3974017c1bc65 */)`
   (`loopcom:/root/displaydx-apply-main.ts`). Verify with `dialplan show <did>@default-trunk` →
   `Goto(T<n>_default-trunk`, never with the DB.
2. ⛔⛔ **The migrated IVR schedule overrode per-number menus 24/7.** DisplayDX's `IvrScheduleConfig`
   was `isActive:true`, `businessHoursRules: []`, `afterHours/holidayProfileId = Displaydex`. No
   business hours → mode is ALWAYS `afterhours` → `didBuildPublishValues` → `resolveDidmapProfileId`
   swaps EVERY number's `connect/didmap/<did>/profile_id` to the after-hours menu → **212-888-0885
   played the Displaydex greeting** (caught only by the real carrier call; the DB mapping said Quick
   Sat). T6 IVR 16/17 had no time condition. Fix: `afterHoursProfileId = null, holidayProfileId =
   null` (`displaydx-ivr-schedule-fix.ts`, audit `DISPLAYDX_SPLIT_IVR_SCHEDULE_POINTERS_CLEARED`) →
   republish → didmap 2128880885 = Quick Sat. Traced first: the tenant-level fallback
   (`ivrFindActiveProfile`) still resolves to `defaultProfileId`; the worker's schedule cycle picks
   menus by TYPE; the other `afterHoursProfileId` readers are the HOLD-MUSIC schedule (different
   table). ⛔ Any other tenant migrated the same way with ≥2 numbers on different menus has the same
   defect.
3. **`DidRouteMapping.e164` is `+` + 10 digits (e.g. `+8452003535`), not `+1…`.** The go-live script
   keyed on `+1…` and found nothing; its GET-list parser also returned `[]`. Read mappings from the DB.
4. **Verification calls leave real artifacts.** A key pressed into a ring group whose extension has no
   owner/registration fails over to voicemail → 8 silent voicemails (0–1 s) landed in DisplayDX 101
   and were ingested (emails skipped `too_short`; no owner, so no push) → quarantined + 8 rows deleted.
   The probe calls also wrote 18 ConnectCdr rows that showed in Eli's recents ("QSR Billing →
   2128880885*4") → backed up + deleted. The 2 T6-era baseline probes (caller ID 845-364-7474 → Eli's
   numbers) tripped the move's "call touches both companies" stop → allowed by exact id
   (`BOTH_TO_DDX`). ⚠️ **The first T6 baseline carrier call (10:39:32Z) sent Eli's iPhone ONE
   `INCOMING_CALL_WAKE` push.**
5. ⛔⛔ **`--remove-originals` must SOFT-delete voicemails while the old spool exists.** The script
   hard-deleted; T6's `displaydex-voicemail/101` spool still holds the 9 messages (cleanup is a later
   task), and the worker voicemail sync upserts by `pbxMessageId` → a hard delete would be re-created
   under Nexus next cycle. The upsert's `update` never touches `deletedAt` and nothing sweeps
   soft-deleted voicemails, so `deletedAt = now` hides them permanently. Patched before `--confirm`.

### 8b. Method that worked — the REAL-CARRIER probe

`pbx:/root/displaydx-carrier-probe.sh <did> "<a>&&&<b>&&&<c>" "<forbidden-regex>" <waitSecs>` drops a
call FILE into `/var/spool/asterisk/outgoing/` (`Channel: PJSIP/1<did>@344022_eli`, `CallerID:
<8453647474>`), so the call leaves through VoIP.ms and comes back in exactly like a customer's (it
arrived on trunk 37 `344022_Comfortcont`), then asserts the ordered trace for THAT linkedid.
⛔ `channel originate` with no caller ID gets **VoIP.ms 503** (seen with `pjsip set logger host`).
`/root/ivr-e2e.sh` (`[connect-probe]`) only works once a number has a Connect didmap — use the carrier
probe for the PBX leg. ⛔ A deploy recreated `app-api-1` THREE times during the swap — `docker cp` and
`npx tsx` must be in the SAME ssh command.

### 8c. ⏳ NOT PROVEN — needs a human

- **Eli must sign out of the app and sign back in once** (new SIP identity `T142_101_1`; his cached
  provisioning is still `T6_101_1`). Until he does, calls still reach the IVR and voicemail and the
  push still targets his phones, but the app registers with the old identity. Portal: reload.
- A real answered call with audio on Eli's app; an inbound + outbound text on 845-200-3535; a real
  voicemail landing under DisplayDX and emailing eli@displaydex.com; outbound caller ID 845-200-3535 /
  the Quick Sat route.
- Known cosmetic diff (unchanged from §6): hold music T6 moh3 "main" vs T142 default.
- **Cleanup (§6a step 8) is still a separate later task** — T6 routes 30/31, IVRs 16/17, ring groups
  800–807, T6 ext 101, the old Connect ext 101 row, the T6 spool copy. Rollback until then: PBX
  `saveTenant` the two numbers back onto T6 **and apply in BOTH the T6 and Main contexts** +
  `displaydx-ivr-golive.ts unswitch <did>`; Connect from `displaydx-premove-snapshot-20260916.json`.

### 8d. ✅ Welcome email re-sent + account renamed "Displaydex" (2026-09-16 11:47–11:49Z)

Izzy: *"Send him out a new welcome email, and I will send him a message to create a new password"*,
then *"spell his company name right. There is an E in between the D and the X."* Read Eli's row first
(lastLoginAt 2026-08-26 → he HAS used the account, so resend-invite takes his old password away — what
Izzy asked for). `POST /admin/users/:id/resend-invite` → EmailJob SENT 11:47:47Z, but it read
"DisplayDX". Tenant `name` renamed **DisplayDX → Displaydex** (audit `TENANT_RENAMED`; Eli's own
branding: displaydex.com, the old PBX description, the IVR menu name). Traced first: nothing in api/worker
writes `Tenant.name` from PBX data; the IVR/AstDB slug comes from `PbxTenantDirectory.tenantSlug`
(`displaydx`, unchanged); the only Sola link on the tenant is CUTOVER_COMPLETE (no block). Resent →
EmailJob `cmu41fuob05esph13z59b7lbq` **SENT 11:49:32Z** to eli@displaydex.com; body checked:
"Displaydex", no "DisplayDX", no "Nexus", ext 101, create-password link, Play badge. Eli is now
`INVITED` + `forcePasswordReset` — his old password no longer signs in. ⚠️ Both invite links work
(resend does not revoke earlier tokens; each expires 2026-09-19). ⛔ Left as-is on purpose: PBX tenant
142's label "DisplayDX" and slug `displaydx` (internal; changing them is a PBX write + apply, never
customer-facing). Scripts `loopcom:/root/displaydx-welcome-resend.ts`, `displaydx-rename.ts`.

## 5. Rules this earned / reaffirmed

- ⛔ A tenant rename is a one-column Connect write; the PBX tenant name, doorway routing and
  Sola customers key on IDs and were untouched.
- ⛔ The blocking-link fix for a two-companies-one-tenant case can be THE RENAME ITSELF —
  once the tenant IS the company on the link, the "mis-map" is healed with zero Sola writes.
- ⛔ Splitting tenants: cards move by `tenantId` + `isDefault`, and the OLD tenant's
  `defaultPaymentMethodId` must be re-pointed in the same step or it references a card the
  tenant no longer owns.
