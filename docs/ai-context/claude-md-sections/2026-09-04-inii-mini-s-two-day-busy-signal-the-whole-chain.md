# ⛔⛔ AGENT HANDOFF — inii mini's two-day busy signal: the whole chain, both customers FIXED, and the SAFEGUARDS that make it impossible to recur silently (2026-09-04) — READ FIRST before retrying ANY VoIP.ms write, before trusting a first-match subaccount lookup, before hand-running a watcher script inside a container, or for ANY "callers get a busy signal" report

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_VOIPMS_DUPLICATE_SUBACCOUNTS_2026-09-02.md` §8–§10**
(`74d10754` + `edf36905` on `feat/ivr-migration-takeover` — api only. ✅ **api DEPLOYED and container-verified 2026-09-04 17:16Z**: `app-api-1` `.build-commit` = `edf36905`, 0 restarts, boot line `VOIPMS_TRUNK_GUARDRAIL_ARMED {intervalMs:1800000, bootDelayMs:180000}`, health 200 on both hostnames, and the FIRST LIVE SWEEP wrote its audit row at 17:34:10Z — `checked:60, duplicates:[], unregisteredNow:[344022_fox], firstSweep:true, alerted:false` — i.e. the two-sweep rule held and the orphan toll-free is queued to text once on the next pass. ⛔ The first deploy attempt died in BuildKit (`frontend grpc server closed unexpectedly`) with no rollout; the retry succeeded. ⛔ A full sweep takes ~15 min (sequential carrier reads) — fine at a 30-min interval, but do not shorten the interval below that. No migration, no PBX config change beyond the two trunk secrets, no env change.)
Memory: [[voipms-duplicate-subaccounts-403]], [[a-creating-write-is-sent-exactly-once]],
[[voipms-trunk-guardrail-watches-the-carrier]].
Izzy, 2026-09-04: *"i want to know how when where why this happened and put safeguard and blockers that
something like this can never happen again and fix all others affected."*

- ⛔⛔ **HOW/WHEN/WHERE/WHY, five gaps in one chain (full table in §10.1):** (1) **2026-08-05 17:52Z**
  `vms()` retried a timed-out `createSubAccount` 3× and EVERY attempt landed at VoIP.ms — Matamim got
  rows 836852/3/4 under one login, inii mini 837032/3 (proven from `OnboardingEvent` + consecutive
  ids); (2) `findExistingSubaccount` was `.find()` (first match) so the duplicates were invisible for
  four weeks; (3) **2026-09-02 ~16:05Z** VoIP.ms's outage + recovery made their registrar refuse the
  PBX's password for both logins (403 after a valid digest); (4) the 09-02 interim fix (clone the
  password onto the duplicates) was IMPOSSIBLE by VoIP.ms policy — every attempt `used_password` —
  and both watcher scripts died the next day (a deploy recreated `app-api-1` and deleted the
  `docker cp`'d script; the PBX loop hit its 24 h cap) with NO alarm; (5) Asterisk hit `max_retries`
  at **09-03 16:48Z** and stopped REGISTERing silently, and **nothing on the platform ever asked the
  carrier whether a live number's trunk was registered**. Result: **~146 busy-signal calls on
  646-984-6023** (30/71/45 per day) until the customer called. Matamim lost 1.
- ⛔⛔ **DELETING THE JUNK ROWS IS NOT ENOUGH — ROTATE.** Proven twice (inii mini §9, Matamim §10.2):
  with only the real row left and its password hash matching the PBX exactly, REGISTER still 403s.
  What works: `setSubAccount` the surviving row to a NEW password (full update, carry
  `default_e911`), write it to `ombu_trunk_parameters` `outgoing_remotesecret` + the conf
  `password=` line (`cat tmp > file`, ACL mask `rw-` preserved), `module reload res_pjsip.so`,
  `pjsip send register <bare name>`, store it on the submission's `voipmsSubaccountEncrypted`. Both
  numbers proven with a real originated call + carrier CDR `ANSWERED`. Backups on the PBX:
  `/root/inii-trunk130-backup-20260904T155412Z/`, `/root/matamim-trunk129-backup-20260904T163314Z/`.
- ✅ **THE SAFEGUARDS (§10.4):** (1) `vms()` **never retries a creating write** —
  `NON_IDEMPOTENT_METHODS` (`createSubAccount`, `orderDID`, `orderTollFree`, `orderVanity`,
  `addLNPPort`, `addLNPFile`, `e911Provision`, `delSubAccount`, …) get ONE attempt and a timeout
  throws `provider_unreachable_write_uncertain`; ⛔ never add one of those to a retry loop, and
  never "fix" a timed-out create by calling it again — re-list and adopt. (2) `findSubaccountRows`
  + `chooseSubaccountRow`: every row is read, the **lowest id** is adopted, duplicates are named on
  the customer's timeline. (3) **`apps/api/src/onboarding/voipMsTrunkGuardrail.ts`** — every 30 min
  (boot kick 3 min) asks VoIP.ms `getRegistrationStatus` for every subaccount holding a live
  number; **unregistered (or `invalid_account`) on two consecutive sweeps, or a login name held
  twice, raises an `AgentEscalation`** (texts Izzy; ⛔ never `ADMIN_ALERT`), 6 h de-dupe per key,
  audit row `voipms_trunk.sweep` every run; kill switch `VOIPMS_TRUNK_GUARDRAIL_DISABLED=1`. The
  proof it runs is the audit row, never the ARMED line:
  `select ts, payload from "AgentAuditLog" where event='voipms_trunk.sweep' order by ts desc limit 3;`
- ⛔ **A watcher that lives inside a container dies at the next deploy** — `docker cp` a script into
  `app-api-1` and it is gone when the container is recreated (that is what killed the 09-02 loop).
  Long-running probes stay on the HOST and are copied in per run; anything that must survive goes
  into the api as a real guardrail with a boot kick.
- ⛔ **`getCDR` returns two rows per inbound call** (a `"+1…" <…>` display-form row and a bare one);
  count only the bare rows. ⛔ `pjsip send register <name>-oauth` answers "Unable to retrieve
  registration" — the object is the bare `344022_<name>`. ⛔ An inbound VoIP.ms call may arrive on
  ANY VoIP.ms trunk's `trk-N-in` (all share newyork1's IP) — harmless, `default-trunk` routes by DID.
- ⏳ **FLEET SWEEP (§10.3): 61 subaccounts, 0 duplicates; 59 of 60 number-holding subaccounts
  registered.** The one exception is toll-free **877-220-5058 → `344022_fox`, a subaccount that no
  longer exists** — an orphan (no PBX route, no tenant, 0 calls), affects nobody, needs Izzy's call
  (release or route); **the guardrail will text about it once.** Also NOT touched: the orphan
  845-288-0994 / `344022_iniimini` / trunk 64 (Izzy: "supposed to be removed a long time ago"),
  inii mini's `e911 0` on the ported number, and inii mini's own unregistered phone (last login
  08-06 — callers reach the menu/voicemail).
