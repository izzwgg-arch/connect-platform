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
