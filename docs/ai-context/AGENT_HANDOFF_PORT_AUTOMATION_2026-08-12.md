# AGENT HANDOFF — number ports land themselves now (2026-08-12)

Commits `c5dc0f7a` → `76a0bfbf` → `5330620d` on `feat/ivr-migration-takeover`,
all **api DEPLOYED and container-verified** the same evening. Proven live the
same day: the watchdog's very first sweep landed inii mini's port end-to-end
(including retiring the temporary number) with zero human input. **Matamim
(port order 217946) is fully staged as the first start-to-finish live test.**

## 1. Why this exists

inii mini's port (order 217760) completed into silence on 2026-08-12: the
number arrived on the MASTER VoIP.ms account with SMS off, no PBX inbound
route, no Connect mapping, no notification to anyone. A human (this session)
had to notice and do six manual steps. Izzy's directive: the whole port
lifecycle is automated, 100%, including retiring the temporary number back to
the master account's spare pool once the port completes.

## 2. The three pieces

**A. The build prepares BOTH numbers (`pbxTenantBuild.ts`).** When a sign-up
chose a port, `PbxBuildJob.portedDid` carries the customer's real number and
the build: puts both numbers in the tenant's number list, creates TWO inbound
routes ("Main" for the temp, "Main ported" for the real number — descriptions
must differ, the panel rejects duplicates), and uses the REAL number as the
outbound route's `cid_number` (callers see the number the customer is known
by from day one; ⛔ mildly weaker STIR/SHAKEN attestation until the port
lands is the accepted trade). `setupOrchestrator.ts` derives `portedDid` from
`answers.phone.details.numbers` when choice = port.

**B. The port watchdog (`apps/api/src/onboarding/portWatchdog.ts`).** VoIP.ms
has NO webhook for ports — SMS only — so this polls every 15 min
(`PORT_WATCHDOG_INTERVAL_MS`), registered in server.ts next to the setup
watchdog. Two signals per open port: `getLNPStatus {portid}` (status
transitions → sign-up timeline; rejections email the admin immediately;
"completed" is the retirement gate) and `getDIDsInfo {did}` (the number
EXISTING on the account — VoIP.ms adds it around FOC, routed to the master
account, before the order reads completed; arrival is the actionable
moment). Sweep filter: paid, not canceled, choice=port (column OR
answers.phone.choice), `provisioning.portFiled`, and no
`portLanding.completedAt`. Repeated landing failures alert ONCE at the 8th
attempt and keep retrying. ⛔ **`getLNPList` exists** (undocumented in our
code before): returns every order with portid/numbers/foc_date/port_status —
it's how Matamim's real order was found.

**C. The landing routine (`apps/api/src/onboarding/portLanding.ts`).** Staged,
idempotent, every stage persisted the moment it succeeds
(`answers.provisioning.portLanding` — the 2026-08-05 "persist each
irreversible success immediately" lesson):
1. `setDIDRouting` → the submission's stored subaccount, **verified by
   re-read** (a VoIP.ms success status is not a result).
2. Texting: `enableSmsOnDid` (carrier refusal leaves the stage open for next
   sweep — the flag can lag right after FOC), claim the `TenantSmsNumber`
   row, COPY the assignment (user/ext/multi-user join rows) from the temp
   number's row, make the real number tenant default. Skipped cleanly when
   the account has no texting.
3. `DidRouteMapping` created mirroring the temp number's (menu, MOH, hold,
   pbxInstance). When the temp number is on Connect (`routingMode connect`):
   book an immediate switch via **`DidSwitchSchedule`** — the scheduler tick
   drives the REAL `/voice/did/:id/switch-to-connect` with its own retries
   and failure alerts (one code path with a manual flip).
4. When the temp number is NOT on Connect: **copy the temp route's PBX
   destination** onto the ported route — extension, ring group, PBX IVR,
   outside number's custom app — via helper `tenant-catalog` decode +
   `agentSetPbxRouteDestinationV2` by target type+id. ⛔ **Never copy the raw
   `ombu_destinations` row id** (first version did): two routes sharing one
   row means deleting the temp route later cascades the row away and
   silently breaks the ported route (the renumbering-saga trap). Fixed in
   `5330620d`. Drift guard: if the temp route's PBX render enters the
   doorway while Connect says "pbx", refuse to copy — that world belongs to
   the switch path.
5. **Re-publish** through the real `POST /voice/ivr/publish` as a service
   principal (`injectAsService` grew an optional payload param), wired in
   server.ts. Runs only after the pointing is final; a refused publish (e.g.
   `no_active_menu_for_mode`) stalls the landing loudly instead of retiring
   the temp number under a half-pointed replacement.
6. ⛔ **Retirement gates on the ORDER reading completed, never on arrival** —
   the number can appear at FOC days early; cutting over then strands the
   customer. Retirement: temp DID `setDIDRouting` → `account:<master>`
   (derived `sub.username.split("_")[0]`; rejoins the spare pool), temp
   `TenantSmsNumber` un-claimed, pending switches canceled, temp
   `DidRouteMapping` DELETED (unique e164 would block a future customer
   claiming the recycled number).
7. One plain-English completion email. ⛔ **It rides the ADMIN_ALERT EmailJob
   channel, which is MUTED by owner directive 2026-08-12 (`ALERTS_MUTED`)**
   — the email queues and is skipped. Port REJECTION alerts are muted the
   same way. Until the mute lifts, the sign-up timeline is the record.

Tests: `portLanding.test.ts` (14 — stage machine, both gates, idempotency,
sweep filtering/alerting) + 3 porting-build tests in `pbxTenantBuild.test.ts`.
All deps injectable; no module-mock of the helpers needed.

## 3. Live proof — inii mini, first sweep after deploy

`portWatchdog {scanned:1, landedOrProgressed:1, failed:0}` ~20 min after
deploy. Verified after: temp 845-260-5692 reads `routing: account:344022` at
VoIP.ms, its TenantSmsNumber un-claimed, its mapping gone, timeline reads
"Temporary number 8452605692 retired… Port landing complete." The completion
email row sits `SKIPPED lastErrorCode ALERTS_MUTED` — expected. Leftover per
retired port: the temp number's old PBX inbound route stays (panel deletes
have no captured contract and a wrong delete kills a live route) — it counts
$3/mo E911 until someone deletes it in the panel; the completion email says
so each time.

## 4. Matamim — staged as the first start-to-finish test

⛔ **The wizard had recorded the WRONG number.** `answers.phone.details.numbers`
said 8456282646 (a stale port step; choice ended "new"), but the only active
port on the account is **order 217946 → 929-359-8299, FOC 2026-08-17,
foc_received** (from `getLNPList`). The port was filed MANUALLY at VoIP.ms,
so none of the system's prep existed. Backfilled this session:

- **PBX tenant 104** (`matamim_h8gmrh`, path `4de9a88870cd2add`, one
  extension 101 "Joel"): ported number added to the tenant's
  `inbound_numbers`; inbound route **241 "Main ported"** 9293598299 → ext
  101 (own destination row 912 — no sharing with the temp route's 899);
  outbound route `cid_number` 7244198226 → 9293598299. All via panel
  automation mirroring `pbxTenantBuild` patterns, verified by reading
  `ombu_*` + the rendered dialplan (`Goto(T104_cos-all,101,1)`).
- **Submission `cmsey1yel0002o4xoogh8gmrh`**: `phoneNumberChoice` → "port",
  `answers.phone.details.numbers` corrected → 9293598299
  (`portNumberCorrectedFrom: 8456282646`), `provisioning.portFiled: true`,
  `portId: "217946"`, `portFiledManually: true`. Timeline documents it.
- **Watchdog confirmed tracking**: first sweep stamped
  `lastPortStatus: foc_received`.
- Around Aug 17: number arrives → routed to `Matamih8gmrh` subaccount → SMS
  wired (billing already on, NO temp TenantSmsNumber exists, so the ported
  number becomes a **shared-inbox** tenant default — flip to a personal
  assignment for Joel afterwards if wanted) → destination copy (both routes
  point at ext 101 → no-op confirm) → publish → on "completed": temp
  724-419-8226 retired to the master pool.

### 4b. ✅ IT RAN. Verified 2026-08-17 — arrival→completion, zero human input

**This is the "not proven" item in §6 closing.** The prediction above is what
happened, to the stage. No human touched anything after the 2026-08-12 backfill.

- **Arrival, 2026-08-13 00:06** — one sweep walked every stage in **31
  seconds**: `routedAt 00:06:39` → `smsAt 00:06:46` → mapping created
  `00:06:46.9` → `destCopiedAt 00:06:47` → `publishedAt 00:06:49`.
  ⛔ **The number arrived FOUR DAYS before the order read completed** — exactly
  the gap the retirement gate exists for. Gating on arrival would have cut the
  customer over on Aug 13 and stranded them.
- **Completion, 2026-08-17 18:24:30Z** — `getLNPStatus` flipped to
  `completed`, and **11 seconds later** the temp number was retired
  (`tempRetiredAt 18:24:41.816`, `completedAt 18:24:41.859`).
- **Verified at the carrier, not from our own flags** (`getDIDsInfo`, this
  session): ported **9293598299 → `account:344022_Matamih8gmrh`, sms_enabled 1**;
  temp **7244198226 → `account:344022`** (master spare pool). Order 217946 →
  `post_status: completed`.
- **Verified on the PBX** (read-only, `extensions__50-104-dialplan.conf:378`):
  `exten => _9293598299` renders `Goto(T104_cos-all,101,1)` — the ported number
  really rings ext 101. The temp route at :370 renders identically (see the
  leftover below).
- **Verified by real traffic**: two inbound calls to 9293598299 on 2026-08-17
  18:11 from 213-935-1789, both `answered`. ⛔ Both were **0–1 s** — that is a
  robocall/wardialer signature, not a proof of conversation. It proves the
  number rings and connects; it does not prove anyone has held a call on it.
- **The watchdog stood down by itself.** Sweeps logged `scanned:1` every 15 min
  through 18:24:41Z and **nothing since** — the sweep filter drops any row with
  `portLanding.completedAt`, so silence after completion is the correct
  behaviour, not a stalled watchdog. ⛔ The log line only fires when the sweep
  *acts*; absence of the line is not absence of the sweep.
- **The completion email queued and was SKIPPED**, exactly as designed while the
  mute stands: `[Connect] Port complete: Matamim — 9293598299 is live`,
  `ADMIN_ALERT / SKIPPED / ALERTS_MUTED`, 18:24:41.852Z. **Nobody was told.** The
  timeline is the only record a human can read.
- ⛔ **A `DidRouteMapping.e164` of `+9293598299` is NOT malformed** — it is
  missing the country code and it is *supposed* to be. **All 29 mapping rows on
  the platform are `+<10 digits>`**, human-created and machine-created alike.
  This was investigated as a suspected bug this session and is house convention.
  Don't "fix" it; a lone `+1`-prefixed row is what would break lookups.
  (`TenantSmsNumber.phoneE164` **is** full E.164 — `+19293598299`. The two
  tables genuinely differ.)

### 4c. ✅ The customer is told now (2026-08-17, `32dfccfb`, api DEPLOYED)

Matamim's landing exposed the gap: **the customer was told nothing.** The
completion mail is an `ADMIN_ALERT` to the owner, the send door drops every one
of those, so the person whose number moved found out by dialling it.

- **`apps/api/src/onboarding/portCompleteEmail.ts`** — `buildPortCompleteEmail()`
  + the new type **`PORT_COMPLETE`**. Queued in `portLanding.ts` §6b beside the
  owner alert, `toEmail` = `mainEmail || billingEmail`, `tenantId` = the
  customer's own tenant.
- ⛔⛔ **THE TYPE IS THE WHOLE FEATURE.** On `ADMIN_ALERT` this email would be
  built, log nothing, and never arrive — the most expensive shape of bug in this
  repo. `portCompleteEmail.test.ts` asserts the type can never be that.
  **The owner's alert is deliberately untouched and still muted**: muting his
  must not mute theirs, and vice versa.
- ⛔ **Failure modes are all recorded, never silent** — no contact email, or an
  insert that throws, each write a timeline line ("the customer was NOT told" /
  "tell them by hand"), and **neither can block the landing**. Silence would be
  indistinguishable from a delivered email.
- ⛔ **The temp-number paragraph drops out when there was no temp number.**
  Telling a customer to stop using a number they never had is worse than saying
  nothing.
- **Copy is option C of three mockups**, Izzy's pick:
  <https://claude.ai/code/artifact/6cc32750-47dc-401c-a466-b3bb1f15f6b5>.
  Four sentences, no button, no support card — **"reply to this email" is the
  whole support path**, which is what keeps it working without depending on a
  mailbox nobody has created. Replies land at the platform sender,
  `support@connectcomunications.com` (`EmailProviderConfig.replyTo` is null).
- ⛔ **The billing shell is now reusable rather than copied a third time.**
  `emailShell` is exported from `billing/emailTemplates.ts` with `eyebrow` /
  `footerNote` / `includeSupportBlock`, **every one defaulting to the billing
  behaviour**; all **eight** billing emails were verified **byte-identical**
  against `git show HEAD:` of the pre-change file. `billingEmailTemplates.test.ts`
  guards the defaults. The invite shell in `userEmailTemplates.ts` stays separate
  as before.
- ✅ **WHO IT GOES TO, and the gap that audit closed** (`20fb2416`, deployed).
  The chain is `mainEmail → billingEmail → the tenant's OLDEST TENANT_ADMIN`.
  The admin fallback is not a nicety: a sign-up with no contact fields would
  otherwise mean the person whose number just moved is the one person nobody
  tells. ⛔ It never reaches for an ordinary `USER`, never crosses a tenant
  boundary, and a DB failure returns nobody rather than throwing into the middle
  of a port. Proven against the live database, not just the fake one.
- ⛔⛔ **"EVERY PORT GETS THE EMAIL" IS TRUE ONLY FOR PORTS THE WATCHDOG CAN
  SEE — and two shapes are invisible to it.** Audited 2026-08-17; state these
  plainly rather than implying blanket coverage:
  **(1) A port filed BY HAND at VoIP.ms.** The sweep requires
  `answers.provisioning.portFiled` + `portId` on a paid submission. **Matamim's
  port was exactly this shape** and only entered the pipeline because a session
  hand-backfilled those fields. File a port outside the wizard and set nothing,
  and there is no landing, no retirement and no email — silently.
  **(2) A port for an EXISTING customer.** The whole pipeline is
  sign-up-scoped: the only filing path is `voipMsProvisioning.ts:672` inside
  onboarding, and the only caller of `runPortLanding` is the watchdog sweep over
  `OnboardingSubmission`. An established tenant porting a number later has no
  submission, so nothing tracks it at all.
  ⛔ Both are structural, not bugs in this email. Closing them means giving
  ports a home outside onboarding — real work, not yet started.
- **Live audit at the time of writing:** 2 paid submissions ever, both ports,
  both landed, both with contact emails; `getLNPList` shows **0 open orders**, so
  nothing is currently untracked.
- ⏳ **NOT PROVEN: nobody has received it.** 11 builder tests + 5 caller tests
  (⛔ the caller ones matter most — a builder-only test passes straight through a
  wiring bug, which is how the APK link went missing from every self-service
  sign-up), onboarding suite 174/174, api typecheck 75 errors = the exact
  pre-existing baseline, and the deployed container rendering the real email.
  **The next real port is the acceptance test** — Matamim's is already complete
  and will not re-fire.
- ⚠️ Suite note: the api suite now shows a flaky **`userEmailTemplates.invite`**
  failure that passes in isolation and is **not** from this work (it fails with
  these files removed too). The documented 7 `pbxTenantDirectorySync` failures
  are still there. Totals fluctuate 8–9 between runs.

### 4d. ✅ The temp number leaves the PBX too (2026-08-17, `ed3c561f`, DEPLOYED)

⛔ **This was a customer overcharge, not housekeeping.** Retirement routed the
temp DID back to the master VoIP.ms account, but the customer's tenant kept its
inbound route. `pbxTenantInboundDidSync` reads **`ombu_inbound_routes`** to fill
`PbxTenantInboundDid`, and `invoiceEngine.ts:447` counts that table
(`active: true`) for the **`per_phone_number`** E911 fee — so **every ported
customer kept paying $3/month for a number they no longer owned.**

- **`apps/api/src/onboarding/retireTempPbxRoute.ts`**, called from
  `portLanding.ts` §5b right after the carrier-side retirement.
- ⛔⛔ **VITALPBX CASCADES `ombu_destinations` WHEN YOU DELETE A ROUTE POINTING
  AT IT.** Ports built before `5330620d` gave the temp route and the real route
  the SAME row — **inii mini's 239 and 240 both point at row 907**, so deleting
  their leftover cascades 907 and **kills 646-984-6023, their live number.**
  `decideTempRouteDeletion` is pure and refuses: a shared destination row
  (checked **across every tenant** — nothing scopes a destination row to one), a
  route with no destination row, the ported number's own route, and any case
  with two routes on the temp number. 9 tests, written from both real shapes.
- ⛔ **Apply Changes is never fired.** It wipes the Connect doorway off every
  route of every tenant with pending changes — an outage risk out of all
  proportion to a $3 cleanup. The stale dialplan exten it leaves behind is
  **inert**: the number is already on the master account, so no call can arrive
  on it, and the next legitimate regen clears it.
- ⛔ **Attempted once, never looped, and never fatal.** A refusal is stamped
  (`portLanding.pbxRouteRetireSkipped`) and written on the sign-up timeline in
  plain words — retrying could never make a shared row unshared, and a port must
  not stay open over a cleanup.
- ✅ **Proven live on Matamim** under Izzy's go-ahead (the PBX is otherwise
  read-only). Backup `/root/matamim-route-backup-20260817-165444/` (route rows,
  destination rows, tenant DID list, dialplan). Route **237 deleted**,
  destination row **899 cascaded**, route **241 "Main ported" and row 912
  untouched**, and the live number still renders
  `exten => _9293598299 … Goto(T104_cos-all,101,1)`. `PbxTenantInboundDid` went
  **2 active → 1**, so their **E911 drops $6 → $3**.
- ⏳ **inii mini is deliberately NOT done** (Izzy's call, 2026-08-17): their live
  route 240 needs its own destination row first. Until then they keep paying the
  extra $3 and the guard correctly refuses — which is the guard working, not a
  bug.
- ⏳ The temp DID also remains in **`ombu_tenant_dids`** for tenant 104. That is a
  different table from the routes and **does not drive billing**; left alone
  rather than widening a mandated single-route delete.
- ⏳ **NOT PROVEN: the automation has never run itself.** Matamim's was driven by
  hand through the same deployed functions. The next real port exercises the
  wired path.

**Left open by design, both needing Izzy:**
1. The temp number's PBX inbound route (**899, "Main", 7244198226 on tenant
   104**) is still there and still renders — the documented per-retirement
   leftover, +$3/mo E911 until someone deletes it in the panel. The DID itself
   is back in the spare pool, so the route points at a number the tenant no
   longer owns.
2. Texting on the ported number is a **shared inbox** (`isTenantDefault: true`,
   `assignedUserId`/`assignedExtensionId` both null) because there was no temp
   `TenantSmsNumber` row to copy an assignment from. Predicted in §4; flip it to
   Joel personally if that's what he wants.

## 5. Traps this session paid for (don't re-pay)

- ⛔ **The tenant EDIT form has no `name` input** (name is fixed after
  creation, rendered as a label) and legacy builds carry the PLAIN company
  name as description ("Matamim", not "Matamim h8gmrh"). Identity checks on
  a parsed tenant form: `tenant_id` + `inbound_numbers[0][did]` (+ the slug
  present in the HTML), not name/label equality.
- ⛔ **A killed panel run (exit 137) can land its post anyway.** The tenant
  edit had landed (both DIDs in `ombu_tenant_dids`) while the exec died
  during Apply Changes. Panel prep scripts must be idempotent
  (they are — resume guards) and the re-run is the fix; ALWAYS read the PBX
  DB to learn what actually happened before re-running.
- ⛔ **Blue/green api deploys run TWO api containers, each with a full Prisma
  pool** — Postgres (max 100) hit "too many clients" and even one-off
  scripts were refused for ~5 min mid-cutover. Transient; wait it out —
  don't "fix" anything.
- The parsed tenant edit form carries correct hidden `class/method/mode`
  (`tenants/put/edit`) — `parseFormPairs` + `upsertPair` + full-PUT is the
  same proven shape as `addDevice`.
- `getLNPStatus` without a portid answers `invalid_portingid`;
  `getLNPList` (no args) is the enumerator.

## 6. Open / follow-ups

- ✅ **The Matamim test is DONE and passed — see §4b** (2026-08-17). A port has
  now gone arrival→completion under the watchdog with no human input, verified
  at the carrier, on the PBX and by real inbound calls.
  ⏳ **Still unexercised: the build-side dual-number path.** Matamim was
  hand-backfilled, so `pbxTenantBuild`'s "prepare BOTH numbers" code has never
  run for real — only a future SYSTEM-filed port does that. **§2A remains
  unproven**; don't read §4b as covering it.
- Completion/rejection emails are ALERTS_MUTED — decide whether ports
  deserve an unmuted channel (they're rare and actionable).
- Retired temp numbers leave their PBX inbound route behind (+$3/mo E911
  until panel cleanup): inii mini's "Main" 8452605692 route on tenant 105 is
  the first one.
- ✅ **DONE 2026-08-21 — the watchdog now reads `getLNPList` once per sweep**
  and falls back to per-portid `getLNPStatus` only for an order the list did
  not name. It turned out to matter for a reason that had nothing to do with
  call volume: **the FOC date exists ONLY on the list**, and that date is the
  one thing a customer actually asks for. See §7.

## 7. The customer can ASK now — `port_status` in the assistant (2026-08-21)

Izzy: *"The agent assistant on LoopCom should be able to check phone number
port statuses."* He was right that it could not: until this commit there was
**no route, no screen and no tool** anywhere in the product that answered
"where is my number transfer up to?". The only record was the sign-up timeline
(`OnboardingEvent`), which nobody outside admin can read.

⛔ **So the question was being ESCALATED.** The assistant's catch-all is
*"EVERYTHING ELSE … warmly say the request has been passed to the human team"*,
and since 2026-08-19 that phrasing writes an `AgentEscalation` and **texts
Izzy's two phones**. Every customer asking about their own port — the most
anxious, most repeated question in a sign-up — paged a human for an answer
already sitting in our own database.

### 7a. What shipped

**`apps/agent/src/tools/portStatusTools.ts`** — one read tool, `port_status`,
`minRole: "customer"`, no parameters. It reads **Connect's own Postgres
mirror** (`OnboardingSubmission.answers.provisioning`), scoped by
`createdTenantId` = the verified `ctx.tenantId`.

⛔ **It never touches the carrier, on purpose, and a guard test enforces it**
(the file's own source is read and refused if it ever mentions `voip.ms`,
`getLNPStatus`, `getLNPList`, `loadMasterCreds` or `fetch(`). Three reasons:
the agent holds no VoIP.ms credentials and must not start; VoIP.ms's READ path
degrades independently of its write path (§10 of the automation lesson,
2026-08-05), so a chat question must never be able to hang on it; and a
customer asking three times in a minute must not become three carrier calls.
The cost is up to ~15 minutes of staleness, which is why every answer carries
`asOf`.

The pure summariser `summarisePort()` maps a row to a `stage` and ONE
plain-English sentence the model can say almost verbatim:
`filed` → `scheduled` → `overdue` → `moving` → `live`, plus `stopped`.

### 7b. The three things the wording is built to prevent

1. ⛔ **"You have no transfer in progress" — the confident falsehood.** Connect
   can only see ports filed through the sign-up wizard: that is the only filing
   path, and the watchdog sweeps `OnboardingSubmission`. **A port arranged by
   hand for an EXISTING customer is structurally invisible** — the carrier
   account carries 30+ such historical orders (read live 2026-08-21:
   8457761765, 8452441708, 8453647474 …). So an empty result reports *"Connect
   has no number transfer on record for this account … one arranged directly
   with the Connect team may not show up"* and offers to fetch a person.
   Telling someone whose number really is moving that nothing is happening is
   the worst answer this tool could give.
2. ⛔ **A promised date.** The FOC date belongs to the LOSING carrier and slips.
   Every sentence says so; the tool description and the system prompt both say
   *NEVER promise a date*.
3. ⛔ **A carrier order id in a customer's hands.** `portId` is our VoIP.ms
   relationship, not their reference — `carrierOrderRef` is emitted only when
   `ctx.role !== "customer"`.

Also: `classifyCarrierStatus()` matches **only tokens proven against the live
API** (`completed`, `cancelled` seen 2026-08-21; `foc_received` from §2B) and
otherwise falls through to VoIP.ms's own `port_status_description`. Inventing a
mapping for an unseen status is how a rejected transfer gets reported as fine.

### 7c. ⛔ The FOC date was recorded NOWHERE — the watchdog change

Probed read-only against the live API, 2026-08-21:

```
getLNPStatus {portid} → {"status":"success","post_status":"completed",
                         "post_status_description":"Completed"}
getLNPList {}         → {"status":"success","list":[
    {"portid":"217946","numbers":"9293598299","foc_date":"2026-08-17",
     "port_status":"completed","port_status_description":"Completed"}, …]}
```

**The per-order endpoint the watchdog was using does not return a date at
all.** So the mirror could not answer the customer's actual question. The sweep
now reads `getLNPList` **once** (it already only runs when open ports exist),
indexes by `portid`, and falls back to `getLNPStatus` for any order the list
did not name — ⛔ that fallback is load-bearing: without it, a truncated list
would mean a completed port is never detected and the temporary number never
retires.

New keys on `answers.provisioning`, alongside the untouched `lastPortStatus`:
`portFocDate`, `portStatus`, `portStatusText`, `portStatusCheckedAt`.
⛔ **A blank never overwrites a known `portFocDate`** — the fallback carries no
date, so a sweep that misses the list must not erase what the last list read
told us. ⛔ `portStatusCheckedAt` is stamped on **every** successful read, not
only on a change: "as of" is a promise to the customer, and a status unchanged
for a week is not the same as one we stopped checking. The timeline still gets
exactly one line per real change.

### 7d. Proven / not proven

✅ 19 agent tests + 3 watchdog tests, all registered. **All 5 source guards
fail when replayed against `HEAD`** (server wiring ×2, prompt ×3). agent
typecheck **14 = its exact baseline**, api **75 = its exact baseline**, none in
an edited file. agent suite **719/721** (the 2 pre-existing transcription
failures); api onboarding **266/290** (the 24 pre-existing
`setupOrchestrator` failures from `c2d9fdd9`).
✅ **The tenant link is proven against LIVE data, not just fixtures**: the
tool's exact query run read-only in `app-api-1` resolves Matamim
(`cmsgdq0zi1998td13u964b88l` → 9293598299, completed) and inii mini
(`cmsgkl4y95grttd13yqhyf1gd` → 6469846023, completed), and a tenant with no
sign-up port (Gesheft) returns zero rows → the honest "nothing on record"
answer. The summariser is unit-tested against those two real row shapes.

⏳ **NOT PROVEN: nobody has asked the assistant about a port.** And there is
**no open port on the account right now** — both real ports completed in
August — so `portFocDate` will stay null on every existing row (the sweep drops
completed ports). Every stage is written to work with a null date; the first
port filed after this deploy is what proves the date half.
**Acceptance:** ask the assistant "when does my number transfer?" from a
tenant with a filed port. ⛔ **The negative matters most: ask from a tenant
with NO port and confirm it says Connect has none ON RECORD and offers a
person — not "you have no transfer".**
