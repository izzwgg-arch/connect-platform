# AGENT HANDOFF — "VoIP.ms was down, reset all registrations" → two trunks cannot register because VoIP.ms holds DUPLICATE subaccount rows (2026-09-02)

Izzy, 2026-09-02 ~16:15 UTC: *"Voip.ms was down for a few minutes. It's back up. Reset all
registrations to make sure everything is registered."*

**Scope of what was done:** read-only on the PBX except `pjsip send register` (Izzy's
mandate) and one watcher loop that only re-sends REGISTER; one carrier write was
ATTEMPTED at VoIP.ms (`setSubAccount` on the junk duplicate rows only, with a root-only
backup first) and **did not land** — VoIP.ms's write path is timing out today. No code,
no deploy, no migration, no PBX config change, no tenant row touched.

## 1. The answer to the request

All **63** VoIP.ms trunk registrations on the PBX were already `Registered` when asked
(every one at `exp. ~2718s`, i.e. they all re-registered together ~16:05 UTC when VoIP.ms
came back — the PBX logged **zero** registration failures during the outage itself).
Phone side: **149 contacts**, 7 live calls. `pjsip send register *all` was then sent on
Izzy's instruction; **61 of 63 re-registered cleanly**.

## 2. What the forced re-register exposed

`344022_Matamih8gmrh` (Matamim, 929-359-8299) and `344022_iniimi92gh2m` (inii mini,
646-984-6023) answer **`403 Forbidden` AFTER a valid digest** (401 challenge → REGISTER
with Authorization → 403). Captured on the wire with `pjsip set logger host
208.100.60.66`. Not transient — a retry minutes later got the same 403.

**Cause — VoIP.ms holds DUPLICATE subaccounts with the same login name** (read-only
`getSubAccounts`):

| account | ids | password hash (sha256[0:12]) | note |
|---|---|---|---|
| 344022_Matamih8gmrh | **836852** | `e29dcc32695f` | the real row — matches the PBX trunk auth, carries `default_e911 = 9293598299` |
| | 836853, 836854 | `f198a569ccee` | duplicates |
| 344022_iniimi92gh2m | **837032** | `eac2287db3f6` | the real row — matches the PBX trunk auth |
| | 837033 | `fe38c72df0f0` | duplicate |

The PBX sends the lowest-id row's password (compared by hash on both sides; nothing
printed in clear). Before the outage VoIP.ms's registrar resolved the login to that row;
after their recovery it resolves to one of the duplicates, so the same credentials now
fail. Both DIDs route `account:344022_<name>` **by name**, so the ambiguity is entirely
inside VoIP.ms.

**Where the duplicates came from — proven from `OnboardingEvent`:** the 2026-08-05
VoIP.ms write-path degradation. `createSubAccount` timed out on our side but LANDED at
the carrier (consecutive ids = the retry burst), then `reuseSubaccount` found the
FIRST match and rotated only its password — that is the row the PBX got. The other rows
kept their create-time passwords. `findExistingSubaccount` uses `.find()` (first match),
so the duplicates were invisible to every later read.

## 3. Impact, sized

- Inbound to **929-359-8299** and **646-984-6023**: dead while the subaccount has no
  registration (VoIP.ms `getRegistrationStatus` → `registered: no`). VoIP.ms's own CDR
  for 2026-09-02 shows exactly ONE call to either DID (15:44 UTC, before the outage,
  answered) — nothing lost yet.
- **911 from Matamim (T104) and inii mini (T105)** rides the tenant's OWN VoIP.ms trunk
  (`provisionTenantEmergency`), whose INVITE auth resolves the same way — very likely
  refused right now. Ordinary outbound is unaffected (Telocall `0001` is primary).
- Every other tenant: untouched.
- ⛔ The forced re-register did not CAUSE this — at the next refresh (~17:05 UTC) both
  would have hit the same 403 on their own.

## 4. What is running unattended right now

- **PBX** `/root/reregister-voipms-dups-20260902.sh` (log `…log` beside it): every 5 min,
  re-sends REGISTER for the two trunks ONLY while they read Rejected; exits when both are
  Registered; 24 h cap. Needed because Asterisk gave up after `max_retries 10`.
- **loopcom** `/root/voipms-dup-fix-retry-20260902.sh` (log `…log`): every 10 min re-runs
  the guarded fix `app-api-1:/app/apps/api/fix-dups.ts` — clones the real row's settings
  + password (+ `default_e911` for Matamim) onto each duplicate id via `setSubAccount`,
  refuses to write if the lowest-id row's hash ≠ the PBX's; exits when every row of both
  names carries the real hash. Reads `read-dups.ts` (hashes only) to decide.
- **Backup for reversal:** `/root/voipms-dup-subaccounts-backup-20260902T163107Z.json`
  on loopcom (600, root) — all 5 rows in full.

## 5. What Izzy should do

1. **VoIP.ms support ticket** (the durable fix): delete subaccount ids **836853, 836854,
   837033** (keep 836852 and 837032). Their API's `delSubAccount` is a write and is
   timing out today like every other write; and deleting the row their DID routing
   internally binds to is their risk to judge, not ours.
2. Until then the loops above try the reversible fix (make every duplicate an exact
   clone, so any resolution succeeds). Check:
   `cat /root/voipms-dup-fix-retry-20260902.log` (loopcom) and
   `cat /root/reregister-voipms-dups-20260902.log` (PBX). Success = "rows aligned" then
   "both Registered".
3. After they register: one real call to each DID, and `getRegistrationStatus` reads
   `registered: yes`.

## 6. Also seen, NOT changed

- **Telocall `0001`** registration is `Rejected` / "no response" since ~Aug 30 and gave up
  (`Maximum retries reached`): its `server_uri` is `sip:us-east.telocall.com:700` while the
  working contact and identify are on port **7000** — a config typo in
  `pjsip__50-1-trunks.conf`. Traffic is unaffected (659 outbound dial lines + 2,375
  inbound lines today — Telocall is IP-auth). A panel edit to 7000, Izzy's call.
- `apps/api/src/onboarding/voipMsProvisioning.ts` `findExistingSubaccount` should refuse
  (or at least log) when more than one row shares the name — not done.

## 7. Traps paid for in this session

- **`pgrep`/`grep` self-match inside `docker exec sh -c`**: a check like
  `sh -c '... | grep -q "tsx fix-dups"'` matches its OWN `sh` command line → always
  "running". Both my poll loops waited on nothing for 20+ minutes. Exclude the checker
  (`grep -v "for p in"`) or match a substring that only the target carries.
- **`pkill -f "<script name>"` over ssh kills the ssh session itself** (its `bash -c`
  carries the pattern) → exit 255 with no output. Use `pkill -f "name-2026090[2].sh"`.
- **`vms()` is 3 attempts × the timeout**, so one `setSubAccount` at 120 s is up to
  ~6 min and the 3-row fix up to ~18 min; a 2-minute tool timeout kills the ssh client
  but the container process keeps running — and its stdout is gone. Run long carrier
  scripts detached with a log from the start.
- "Healthy reads prove nothing about writes" (2026-08-05 rule) held again today.

## 8. 2026-09-04 — "inii mini gets a busy signal" (read-only re-check; nothing written)

Izzy: *"inii mini is complaining that when they call in their number, they're going to get a
busy signal."* Every probe below was read-only (PBX CLI/MySQL, VoIP.ms `get*`, Connect
Postgres). The one staged action was NOT run.

**State found**
- PBX: `344022_iniimi92gh2m-oauth` and `344022_Matamih8gmrh-oauth` both `Rejected`;
  `/var/log/asterisk/full` ends the story at **2026-09-03 12:48:33 EDT** — *"Fatal response
  '403' … stopping outbound registration"* (`max_retries` reached). Nothing has tried since.
- PBX watcher `/root/reregister-voipms-dups-20260902.sh`: sent REGISTER every 5 min until
  `2026-09-03T16:51:53Z 24h cap reached - exiting`.
- loopcom watcher `/root/voipms-dup-fix-retry-20260902.sh`: from **16:55Z 09-02 to ~05:00Z
  09-03 every run got `setSubAccount … used_password (This password has been used previously
  by this account.)` on all three duplicate ids** — so §4's "make every duplicate an exact
  clone" is impossible by VoIP.ms policy, not by outage. After the `app-api-1` recreation on
  09-03 (deploy) the loop died `ERR_MODULE_NOT_FOUND /app/apps/api/fix-dups.ts` every 10 min
  until its cap at `16:58:18Z`. Lesson: a `docker cp` into the api container does not survive
  a deploy — keep the script on the host and copy it in per run.
- VoIP.ms (read-only): `getRegistrationStatus` → `registered: no` for both names; rows
  unchanged (837032/837033, 836852/836853/836854, same hashes as §2). `getDIDsInfo 6469846023`:
  `routing account:344022_iniimi92gh2m`, `sms 1`, **`e911 0`**, all failovers `none`.
- Carrier CDR 09-02→09-04 (one row per call after dropping the duplicated `"+…"` CID rows):
  **646-984-6023: 09-02 → 30 `NO ANSWER 0s` + 1 ANSWERED (11:44 EDT, the last good call);
  09-03 → 71 NO ANSWER; 09-04 → 45 NO ANSWER by 11:00 EDT.** 929-359-8299: 1 NO ANSWER (09-04).
  An unregistered subaccount with no failover = busy tone to the caller.
- Connect: the only inii mini user `sales@iniimini.com` last signed in **2026-08-06**;
  `PbxEndpointRegistration` reads `T105_101_1 UNREGISTERED` since **2026-08-18**; 0
  `MobileDevice` rows; T105 has no contact in Asterisk. So the customer's app has been off
  for weeks; calls were reaching the PBX (menu/voicemail) until the trunk died on 09-02.
- Connect `ConnectCdr` for inii mini: 4 inbound on 09-01, 1 on 09-02, none since — consistent.

**The clean landing spot (blast radius traced)**
- `344022_iniimini` = VoIP.ms id **802609, a single row**, `registered: yes` (New York 1);
  PBX trunk **64** "iniimini", `trk-64-in` → `Goto(default-trunk,${DID},1)`, and
  `default-trunk` maps `_6469846023` → "Inii Mini tenant" (T105, inbound route 240) **by
  number, whatever trunk the call arrives on**.
- Its only DID **845-288-0994** is an orphan: `PbxTenantInboundDid` says `T27`, PBX tenant 27
  no longer exists, no `ombu_inbound_routes` / `ombu_tenant_dids` row, `TenantSmsNumber`
  unassigned, 0 calls today; no ARS references `trk-group-59`. Nothing live rides that
  subaccount.
- Therefore `setDIDRouting 6469846023 → account:344022_iniimini` is ONE reversible carrier
  write that restores inbound immediately. SMS polling is per-DID (`sms_enabled`) — unaffected.
  CDR `trunk` attribution changes from 130 to 64 — cosmetic.
- Staged on loopcom as `/root/reroute-inii-did.ts` (600, root) and copied into
  `app-api-1:/app/apps/api/`; dry-run output `BEFORE routing: account:344022_iniimi92gh2m` /
  `dry run — pass 'apply' to write`. Apply:
  `docker exec -w /app/apps/api app-api-1 npx tsx reroute-inii-did.ts apply`; rollback:
  the same command with a third argument `344022_iniimi92gh2m`.

**What the reroute does NOT fix**
- 911 from inii mini: `T105_emergency-calls` still `Gosub(trk-130,…)` and trunk 130 cannot
  authenticate. Matamim (`T104`, trunk 129 → its own duplicated name) has the same hole.
  Durable fix is still deleting **837033 / 836853 / 836854** (`delSubAccount` — VoIP.ms's
  write path answers today, see the `used_password` refusals — or a VoIP.ms ticket), after
  which both trunks register on their existing credentials and 911 rides them again.
- The ported number has no E911 registration at the carrier (`e911 0`) — the 2026-08-17 E911
  work covered new sign-ups and Matamim; inii mini's landed port was never registered.
- The customer's phone: until `sales@iniimini.com` signs in on a device again, a restored
  line rings only the PBX menu/voicemail.

**Traps**
- `getCDR` returns two rows per inbound call (one with the `"+1…" <…>` display form, one bare);
  count only the bare rows or every figure doubles.
- `ombu_outbound_route_trunks` does not exist; find a trunk's users by grepping the rendered
  Main dialplan for `Gosub(trk-<id>,` and reading the enclosing `[trk-group-N]`.

## 9. 2026-09-04 — 646-984-6023 FIXED (Izzy's mandate: "Run it, and delete the junk rows" → "only the 646 number, focus on one thing")

**Sequence, with what each step proved**
1. `delSubAccount 837033` → `{"status":"success"}`; `getSubAccounts` then lists only
   `837032:eac2287db3f6`. Routing re-asserted `setDIDRouting 6469846023 → account:344022_iniimi92gh2m`
   (→ `success`; read back). ⛔ The reroute onto `344022_iniimini` was **withdrawn** — Izzy:
   845-288-0994 "was supposed to be removed a long time ago"; the number must run on its own
   subaccount. `/root/reroute-inii-did.ts` on loopcom is inert.
2. `pjsip send register 344022_iniimi92gh2m` (⛔ not `…-oauth`, which answers "Unable to retrieve
   registration") → **still 403**, again after 45 s. The PBX secret's hash (`eac2287db3f6`) equals the
   surviving row's; `auth_type 1`, `enable_ip_restriction 0`, `enable_pop_restriction 0`, codecs, nat,
   protocol all identical to two working subaccounts. So the 09-02 "registrar resolves to the
   duplicate" theory was at best half of it — VoIP.ms's registrar did not accept the old credential
   even with one row left.
3. **Rotation is what worked.** `setSubAccount` on 837032 with a fresh 20-char password (generated
   in-container, `reuseSubaccount`'s exact full-update shape) → `success`, read back `8feee72bf2b3`.
   Stored on the submission (`voipmsSubaccountEncrypted`, `cmsey1ydz0000o4xoxu92gh2m`) so a future
   `applyOnboardingNumber` retry reuses it instead of rotating again.
4. PBX (Izzy's mandate): backup `/root/inii-trunk130-backup-20260904T155412Z/` (conf + old secret,
   600); `update ombu_trunk_parameters … trunk_id=130 and param='outgoing_remotesecret' and
   value=<old>` (1 row); `password=` line in `[344022_iniimi92gh2m-oauth]` of
   `pjsip__50-1-trunks.conf` replaced via `cat tmp > file` (owner `www-data:www-data`, ACL mask
   `rw-` preserved — verified after); `module reload res_pjsip.so`; `pjsip send register
   344022_iniimi92gh2m` → **Registered (exp. 3585s)** within 10 s. 64/64 VoIP.ms trunks registered,
   150 phone contacts Avail (149 before the reload).
5. Proof: `channel originate Local/6469846023@T102_cos-all application Wait 10` → arrived
   `trk-37-in` (Comfort Control — any VoIP.ms trunk's identify can match; irrelevant) →
   `default-trunk` "Forwarding call to Inii Mini tenant" → `T105_incoming-calls` "Main ported" →
   `connect-doorway` → `connect-menu,mcmsgxycu3019ns1139yvetiih`. Carrier CDR: `2026-09-04 12:55:09
   ANSWERED 11s` — the first answered call on the number since 09-02 11:44. VoIP.ms
   `getRegistrationStatus` → `registered: yes` on New York 1.
6. Cleanup: every staged `.ts` removed from `app-api-1`; the password transit file shredded on
   loopcom and the PBX; no password ever printed.

**Not touched, on purpose** — Matamim's 836853/836854 and 929-359-8299 (still Rejected), the orphan
845-288-0994 / `344022_iniimini` / trunk 64, `e911 0` on the ported number, and inii mini's own
unregistered phone. T105's 911 route (`Gosub(trk-130)`) works again as a side effect of the trunk
authenticating.

**If Matamim is ever asked for:** expect the same shape — delete 836853/836854, and if REGISTER
still 403s on the unchanged password, rotate 836852 (⛔ carry `default_e911 = 9293598299` in the
full update) and apply it to trunk 129 the same way.

## 10. 2026-09-04 — how, when, where, why; Matamim fixed; the safeguards (Izzy: "put safeguards and blockers that something like this can never happen again, and fix all others affected")

### 10.1 The full chain, with the evidence for each link

| When (UTC) | What | Where it is written down |
|---|---|---|
| **2026-08-05 17:52 → 18:29** | Matamim's paid sign-up hit VoIP.ms's write-path degradation. `createSubAccount` "failed: provider_unreachable (timeout)" — but `vms()` retried transport failures **3×** and each timed-out create **LANDED** at VoIP.ms: ids **836852, 836853, 836854**, all named `344022_Matamih8gmrh`. The watchdog re-ran twice; `findExistingSubaccount` used `.find()` (first match), `reuseSubaccount` rotated only **836852**'s password. The other two kept their create-time password. | `OnboardingEvent` for `cmsey1yel0002o4xoogh8gmrh`; ids consecutive at VoIP.ms |
| **2026-08-05 21:04 → 22:37** | Same for inii mini: ids **837032, 837033** under `344022_iniimi92gh2m` (`used_username` on the later attempt is why only two). | `OnboardingEvent` for `cmsey1ydz0000o4xoxu92gh2m` |
| 2026-08-05 → 09-02 | Both trunks registered fine for four weeks — VoIP.ms's registrar happened to resolve each login to the row whose password the PBX held. **Nothing on the platform could see the duplicates** (first-match lookup) and nothing watched carrier-side registration. | §2 |
| **2026-09-02 ~16:05** | VoIP.ms outage + recovery. Their registrar now refuses the PBX's password for both logins: `401 → digest → 403 Forbidden`. Izzy asked for "reset all registrations"; the forced re-register **exposed** it (the hourly refresh would have hit it anyway). | §1–§2, wire capture |
| 2026-09-02 15:49 EDT | **First lost call** on 646-984-6023 (`NO ANSWER 0s` at the carrier = busy tone). | carrier CDR |
| 2026-09-02 16:55 → 09-03 ~05:00 | The interim fix ("clone the real password onto the duplicates") ran every 10 min and **every attempt was refused `used_password`** — VoIP.ms forbids reusing a password on a login name, so the fix was impossible by policy. | `/root/voipms-dup-fix-retry-20260902.log` |
| **2026-09-03 12:48:33 EDT** | Asterisk: *"Fatal response '403' … stopping outbound registration"* — `max_retries` reached. **The PBX stopped trying, silently.** | `/var/log/asterisk/full` |
| 2026-09-03 ~12:05Z | An api deploy recreated `app-api-1` and deleted `fix-dups.ts` (a `docker cp` into the container); the loopcom loop died `ERR_MODULE_NOT_FOUND` every 10 min. | `/root/voipms-dup-fix-retry-20260902.log` |
| 2026-09-03 16:51Z / 16:58Z | Both watchers hit their 24 h caps and exited. **No alarm anywhere.** | both logs |
| 2026-09-04 ~15:00Z | inii mini complains. ~**146** calls to 646-984-6023 had been busy (30 / 71 / 45 per day). Matamim: 1 lost call (their volume is low). | carrier CDR |

**Why, in one paragraph:** a non-idempotent carrier write was retried on timeout (created the duplicates); the lookup that should have seen them was first-match (hid them for a month); the 09-02 fix rested on a VoIP.ms policy nobody had checked (impossible); the two watchers were hand-run scripts with 24 h caps and no alarm on their own death (died the next day); and no monitor on the platform ever asked the carrier whether a number's trunk was registered (two days of busy signals until the customer called). Five gaps, one outcome.

### 10.2 Matamim fixed the same way (Izzy's mandate)

`delSubAccount 836853` + `836854` → success, only **836852** (`e29dcc32695f`, `default_e911 9293598299`) left; `setDIDRouting 9293598299 → account:344022_Matamih8gmrh` re-asserted. `pjsip send register 344022_Matamih8gmrh` → **still 403** after the delete (same as inii mini — deleting alone never clears it). Rotated 836852 to a new password (full-update shape **carrying `default_e911`**), read back `3cbf8647717a`; stored on `cmsey1yel0002o4xoogh8gmrh`; trunk **129** `outgoing_remotesecret` + conf `password=` line replaced (backup `/root/matamim-trunk129-backup-20260904T163314Z/`, ACL mask `rw-` preserved); `module reload res_pjsip.so`; register → **Registered**. 65/65 VoIP.ms trunks up, 150 contacts. Proof: `channel originate Local/9293598299@T102_cos-all` → out via Telocall (`trk-72-dial`) → back in → `default-trunk` "Forwarding call to Matamim tenant" → `T104_incoming-calls` "Main ported" → `T104_cos-all,101`; carrier CDR `ANSWERED 11s`. Password transit file shredded on both boxes.

### 10.3 Fleet sweep (read-only, `getSubAccounts` + `getDIDsInfo` + `getRegistrationStatus` on every subaccount holding a number)

61 subaccounts, **0 duplicate names**; 74 DIDs, 60 on subaccounts, 8 on the master spare pool; **59 of 60 registered**. The one exception: toll-free **877-220-5058** routes to `344022_fox`, which VoIP.ms answers `invalid_account` for (the subaccount no longer exists). It is an orphan — no PBX inbound route, no `ombu_tenant_dids` row, no Connect tenant, `TenantSmsNumber` unassigned, 0 calls — so no customer is affected; it needs a decision (release it, or route it) and the guardrail below will text about it once.

### 10.4 The safeguards (`74d10754` + `edf36905`, api)

1. **`vms()` never retries a creating write.** `NON_IDEMPOTENT_METHODS` (`createSubAccount`, `delSubAccount`, `orderDID`, `orderTollFree`, `orderVanity`, `backOrderDID`, `cancelDID`, `addLNPPort`, `addLNPFile`, `e911Provision`, `sendSMS`, `sendMMS`) get ONE attempt; a transport failure throws `provider_unreachable_write_uncertain` ("the write may have landed; re-list before trying again"). Reads and full-update writes keep the 3× outage retry. The test that used to pin the 3× createSubAccount retry now pins ONE.
2. **Duplicates can no longer hide.** `findSubaccountRows` reads every row for a login; `chooseSubaccountRow` adopts the **lowest id** (the row the PBX trunk was built against) and names the duplicates; `findExistingSubaccount` writes that onto the customer's timeline (`⚠ VoIP.ms holds N subaccount rows … duplicate id(s) … must be deleted`) and to the api log.
3. **`voipMsTrunkGuardrail.ts`** — every 30 min (boot kick 3 min; `VOIPMS_TRUNK_GUARDRAIL_DISABLED=1` kills it): `getSubAccounts` → any login name held twice is an alarm on the spot; `getDIDsInfo` → every subaccount holding a live number → `getRegistrationStatus`; **unregistered (`no`, or `invalid_account`) on two consecutive sweeps = alarm**. Alarms are `AgentEscalation` rows (SMS to Izzy's two phones + the escalation email — the only channel that reaches a person; ⛔ never `ADMIN_ALERT`), de-duped over a 6 h window per key, naming the number, the company, and the repair recipe. State = the previous sweep's audit row (`voipms_trunk.sweep`, written every run with `actor` + `hash`); a carrier outage logs `sweep FAILED` and writes nothing (an outage at VoIP.ms is not "every trunk is down"). Armed in `server.ts`; boot line `VOIPMS_TRUNK_GUARDRAIL_ARMED`.
4. **Tests:** 14 guardrail (`voipMsTrunkGuardrail.test.ts`, incl. the real incident as a fixture, the two-sweep rule, the window re-arm, provider-outage silence, the `invalid_account` case, and a source guard that `server.ts` actually arms it) + 5 new/rewritten provisioning tests (write-once, the lowest-id adoption with the duplicate named). Onboarding suite 405 pass; the 25 failures are the documented pre-existing `resolvePbxRouteHelperConfig` orchestrator mock breakage. api typecheck 81 = baseline.

### 10.5 Deploy state

See the CLAUDE.md section for the container verification recorded at deploy time.
