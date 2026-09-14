# ⛔ AGENT HANDOFF — wake-and-wait FLEET ROLLOUT (2026-08-05) — READ FIRST for wake enrollment, extension dial strings, or "phone didn't ring while asleep" work

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_WAKE_DIAL_FLEET_2026-08-05.md`**

- **Wake-and-wait is LIVE FLEET-WIDE and self-maintaining** (deployed `68fc38b5`,
  2026-08-05, Izzy's mandate). 12 extensions enrolled (10 new + Simon T5_101 +
  T102_101); the worker's 5-min cycle auto-enrolls any future device once its
  user has a fresh active MobileDevice (Android AND iOS), and re-heals VitalPBX
  panel edits that revert the dial key.
- ⛔ **Never hand-edit extension dial keys for wake enrollment — the worker
  re-asserts every 5 min and will fight you.** Use
  `POST /telephony/internal/wake-dial-publish` (`enable:"0"` to unenroll) or the
  gates `WAKE_AUTOENROLL_ENABLED` / `WAKE_DIAL_AUTOENROLL_ENABLED` in
  `/opt/connectcomms/env/.env.platform`. Pre-rollout snapshot of all 120 dial
  keys: loopcom `/root/dialkeys-pre-wake-rollout-20260805.txt`.
- The route rewrites ONLY the exact token `PJSIP/T<t>_<e>_1` ↔
  `Local/T<t>_<e>_1@connect-mobile-wake-dial/n`, discovers the tenant AstDB
  hash itself (read-only `database showkey dial` via AMI Command), and fails
  closed on anything unrecognized. No mapping state lives on the PBX.
- ⛔ **T34_101 (RSBK "Appointments" — NOT Fixup Group; T31 is Fixup Group with
  only ext 103) is skipped and worse than a wake gap:** its dial key rings only
  the dead base endpoint, so calls never reach the app AT ALL. Fix = add
  `&PJSIP/T34_101_1` (PBX write, needs mandate; task session running). Its DND
  has been ON since ~Jul 6 — check before promising it will ring.
- The disabled iOS VoIP prewake in `apps/api/src/server.ts` **stays disabled**
  (duplicate-CallKit-call bug); iOS wakes via its normal INCOMING_CALL VoIP
  push at hold start.
- Deploy-queue job statuses are `success`/`failed` — not `succeeded`; PBX SSH
  writes are classifier-blocked here even with verbal OK (the AMI route IS the
  way); local `git push` blocked → bundle route.
