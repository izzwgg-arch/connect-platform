# ⛔ AGENT HANDOFF — "VoIP.ms was down, reset all registrations" → two trunks CANNOT register because VoIP.ms holds DUPLICATE subaccount rows (2026-09-02) — READ FIRST for Matamim / inii mini "calls don't come in", before any subaccount write, or before trusting `findExistingSubaccount`

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_VOIPMS_DUPLICATE_SUBACCOUNTS_2026-09-02.md`**
(**No code, no deploy, no PBX config change.** PBX: `pjsip send register *all` under
Izzy's mandate + a REGISTER-only watcher loop. VoIP.ms: one `setSubAccount` attempt on
the junk duplicate rows — **did not land, their write path is timing out today**; backup
`/root/voipms-dup-subaccounts-backup-20260902T163107Z.json` on loopcom.)
Memory: [[voipms-duplicate-subaccounts-403]].

- ✅ **The request itself: all 63 VoIP.ms trunks were already Registered** (they all
  re-registered together ~16:05 UTC when VoIP.ms returned; the PBX logged no failure
  during the outage), 149 phone contacts up, and the forced `*all` re-register brought
  **61 of 63** back cleanly.
- ⛔⛔ **THE OTHER TWO — `344022_Matamih8gmrh` and `344022_iniimi92gh2m` — answer 403
  AFTER a valid digest, because VoIP.ms holds the SAME LOGIN 3× and 2×** (ids 836852 real
  / 836853+836854 junk; 837032 real / 837033 junk), each with a different password. The
  PBX sends the lowest-id row's password (hash-compared); after their outage the registrar
  resolves the name to a duplicate. Both DIDs route by NAME, so the ambiguity is theirs.
  Origin proven from `OnboardingEvent`: the 2026-08-05 `createSubAccount` timeouts that
  LANDED, then `reuseSubaccount` rotating only the first match. **Check `getSubAccounts`
  for duplicate names before any subaccount write** — `findExistingSubaccount` is a
  `.find()` and cannot see them.
- ⛔ **Impact NOW:** inbound to 929-359-8299 and 646-984-6023 dead (VoIP.ms CDR: one call
  today, 15:44 UTC, answered — nothing lost yet); **911 on T104/T105 rides that same
  trunk and is very likely refused**; outbound fine (Telocall primary). ⛔ The forced
  re-register did not cause it — the hourly refresh would have hit the same 403.
- ⏳ **Two watchers are running unattended**: PBX `/root/reregister-voipms-dups-20260902.sh`
  (re-sends REGISTER only while Rejected, exits when both Registered, 24 h cap) and loopcom
  `/root/voipms-dup-fix-retry-20260902.sh` (every 10 min re-runs the guarded clone-the-real-
  row fix until every row carries the real hash, 24 h cap). Logs sit beside each script.
  **Durable fix is a VoIP.ms ticket deleting 836853 / 836854 / 837033 — Izzy's.**
- ⛔⛔ **2026-09-04 — inii mini "busy signal" IS THIS, and BOTH watchers died two days ago. Full detail: handoff §8.**
  Read-only re-check: `344022_iniimi92gh2m` (id 837032 real / 837033 junk) and
  `344022_Matamih8gmrh` are still `Rejected`; Asterisk **gave up REGISTERing at 09-03 16:48Z**
  (`max_retries`), VoIP.ms `getRegistrationStatus` reads `registered: no` on both, and the
  carrier CDR shows **every call to 646-984-6023 since 09-02 15:49 EDT ending `NO ANSWER 0s`
  — 30 on 09-02, 71 on 09-03, 45 on 09-04 by 11:00 EDT** (last answered 09-02 11:44). With no
  registration and `failover_busy: none` VoIP.ms hands the caller a busy tone. Matamim's DID
  had 1 lost call in the window. ⛔ **The clone-the-real-password fix CAN NEVER WORK**: every
  `setSubAccount` on a duplicate answered `used_password` ("This password has been used
  previously by this account") — VoIP.ms forbids reusing a password on a login name, so two
  rows of one name can never share one. The loopcom retry loop then died `ERR_MODULE_NOT_FOUND`
  when a deploy recreated `app-api-1` and took `fix-dups.ts` with it (a `docker cp` into the
  container does not survive a deploy — keep long-running probes on the HOST and copy per
  run); the PBX loop hit its 24 h cap. ⛔ **The customer's own phone is ALSO gone**: `T105_101_1`
  unregistered since 2026-08-18, `sales@iniimini.com` last login 2026-08-06, 0 MobileDevice
  rows — so even a fixed trunk lands on voicemail/menu until they sign in again.
  ✅ **Clean landing spot found, blast radius traced**: `344022_iniimini` (id 802609, ONE row,
  `Registered`, PBX trunk 64 `trk-64-in` → `default-trunk`, which routes the DID to T105 route
  240 by NUMBER) is the leftover of deleted PBX tenant 27 — its only DID 845-288-0994 has no
  inbound route, no `ombu_tenant_dids` row, no ARS uses `trk-group-59`, 0 calls; nothing live
  shares it. `setDIDRouting 6469846023 → account:344022_iniimini` is ONE reversible carrier
  write. ⛔ **NOT USED — Izzy (2026-09-04): 845-288-0994 "was supposed to be removed a long
  time ago" and the 646 number must run on its OWN subaccount, the way it did before.** The
  staged `/root/reroute-inii-did.ts` on loopcom is inert; delete it rather than run it.
- ✅✅ **FIXED 2026-09-04 15:55Z UNDER IZZY'S MANDATE ("Run it, and delete the junk rows"; then
  "only the 646 number… focus on one thing") — 646-984-6023 IS BACK: first answered call since
  09-02 11:44 EDT, proven by the carrier CDR (`12:55:09 ANSWERED 11s`), VoIP.ms
  `getRegistrationStatus registered: yes`, PBX trunk 130 `Registered (exp. 3585s)`, 64/64 VoIP.ms
  trunks up, 150 phone contacts (149 before — none dropped), and a real originated call
  traced into `T105_incoming-calls` "Main ported" → `connect-doorway` → `connect-menu`.**
  ⛔⛔ **DELETING THE JUNK ROW WAS NOT ENOUGH — THE 09-02 THEORY WAS INCOMPLETE.** After
  `delSubAccount 837033` (`status: success`, only 837032 left, DID routing re-asserted to
  `account:344022_iniimi92gh2m`), REGISTER with the UNCHANGED password — whose hash
  `eac2287db3f6` matched the surviving row exactly, and whose every other field matched two
  healthy subaccounts — **still answered 403** after a 45 s wait. Whatever VoIP.ms's registrar
  holds for that login was not refreshed by the delete. **What worked: ROTATE the real row to
  a brand-new password** (`setSubAccount` on 837032, the exact `reuseSubaccount` shape) and put
  it on the PBX — `ombu_trunk_parameters` trunk 130 `outgoing_remotesecret` (guarded on the old
  value) + the `password=` line in `pjsip__50-1-trunks.conf` (`cat tmp > file`, owner
  `www-data:www-data` + ACL mask `rw-` preserved) + `module reload res_pjsip.so` +
  `pjsip send register 344022_iniimi92gh2m`. Registered within 10 s. The new password also
  went into `OnboardingSubmission.voipmsSubaccountEncrypted` for `cmsey1ydz0000o4xoxu92gh2m`
  (so a setup retry cannot rotate it back) and was never printed anywhere; the transit file
  was shredded on both boxes. Backup: PBX `/root/inii-trunk130-backup-20260904T155412Z/`
  (conf + old secret, 600). ⛔ The registration object is `344022_iniimi92gh2m` — `pjsip send
  register <name>-oauth` answers "Unable to retrieve registration" and reads like a broken
  trunk. ⛔ An inbound VoIP.ms call can arrive on ANY VoIP.ms trunk's `trk-N-in` (the test
  landed on `trk-37-in` Comfort Control — all share newyork1's IP and pjsip matches the first
  identify); harmless, `default-trunk` routes by DID. **Deliberately NOT touched (Izzy's
  "one thing"):** Matamim's 836853/836854 (929 still `Rejected`), the orphan 845-288-0994 /
  `344022_iniimini`, T105's `emergency-calls` (still `Gosub(trk-130)` — now WORKS again because
  trunk 130 authenticates), the ported number's `e911: 0`, and the customer's unregistered
  phone (`sales@iniimini.com` last login 08-06 — callers reach the menu/voicemail, not a person).
- ⚠️ **Seen, not changed:** Telocall `0001` registration has been Rejected/"no response"
  since ~Aug 30 and gave up — `server_uri` port **700** vs the working contact on
  **7000** (typo in `pjsip__50-1-trunks.conf`); calls flow both ways regardless (IP-auth).
- ⛔ **Traps re-earned:** a `grep -q "<name>"` inside `docker exec sh -c` matches its own
  `sh` command line (two poll loops waited on nothing); `pkill -f "<script>"` over ssh
  kills the ssh session (exit 255, no output) — use `name-2026090[2].sh`; `vms()` retries
  3× per call so a 120 s write is up to 6 min and the container process outlives a dead
  ssh client with its stdout gone — run carrier scripts detached with a log.
