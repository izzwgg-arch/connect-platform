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
- The watchdog could use `getLNPList` (one call for all orders) instead of
  per-portid `getLNPStatus`; with ports this rare it doesn't matter yet.
