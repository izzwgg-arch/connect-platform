# ⛔ AGENT HANDOFF — the desk-phone wizard lets the person PICK which phones to set up; an unticked phone is never touched and never blocks "done" (2026-09-02) — READ FIRST before touching the found/match screens, any `summarizeRun` call in `deskPhoneRoutes.ts`, the driver's skip line, or before "simplifying" `skippedAt`

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_DESK_PHONE_SETUP_WIZARD_2026-08-21.md` §19**
(`1193a07a` on `feat/ivr-migration-takeover` — api + portal + one migration.
Deploy state at the end of this section. No PBX write, no env change, no tenant
row.) Memory: [[desk-phone-wizard-pick-which-phones]].
Izzy, 2026-09-02, testing on ONE factory-reset T53W (ext 103) at A plus center:
*"I want to be able to select the phone to provision. It is only letting me
provision all at once … it should pick up 'Not Connected' automatically."*

- ⛔⛔ **WHY IT WAS ALL-AT-ONCE, three places:** discovery pre-assigns every phone
  the PBX records name (§14 — that is what puts names + photos on the list), the
  driver advanced every assigned phone, and **`summarizeRun` counted EVERY row of
  the run** — so un-assigning a phone (the old "leave it blank to skip") kept
  `finished` false forever. The §18 "the assignment step already existed" note
  was true and was not the answer: match says WHO, not WHETHER.
- ✅ **THE CHOICE LIVES ON THE ROW: `DeskPhoneSetupPhone.skippedAt`** (migration
  `20260902140000_desk_phone_selection`, one nullable column, null = in the
  setup). `POST /desk-phones/runs/:id/selection { phoneIds }` — ownRun →
  permission → body (the route-order guard passes untouched), **REPLACES the
  whole pick**, 400 `phone_list_mismatch` on an id outside the run, audited
  `DESK_PHONE_SELECTION_SET`. The customer view carries `selected`; `inSetup()`
  feeds every summary (run GET, `/state`, admin view) so one ticked phone
  registering finishes the run. ⛔ **`advance` on a skipped phone answers
  `do_nothing, skipped:true` from the ROW** before the registration question and
  the reset gate — no reset can be spent on it whatever a driver sends.
- ⛔ **The driver skips `selected === false` ONLY** — an older api that sends no
  flag drives everything as before; never tighten it to `!== true`.
- ✅ **The screen:** every found row is one big tick target (the clearing
  screen's shape). **Default: Not connected / Found ticked, Connected left
  alone.** Three links — *Only the ones not connected · Select all · Select
  none*. Button reads **"Set up this phone" / "Set up these N phones"**,
  disabled with nothing ticked; the pick is saved server-side BEFORE the match
  screen; match/ready/live/done iterate the CHOSEN phones only and say how many
  were left as they are.
- ⛔ **Deliberately unchanged:** an ASSIGNED, un-skipped phone that is never
  advanced still holds `finished` open (pre-existing; the driver always advances
  every in-setup assigned phone, so it does not bite).
- ✅ **Proven:** api desk-phone suites 88/88 (3 new), portal wizard + driver +
  select-sweep 44/44 (2 new), **all 5 new source guards fail replayed against
  HEAD**, portal tsc 0, api tsc 81 = baseline with none in a touched file.
- ✅ **api + portal DEPLOYED and container-verified 2026-09-02 (both `app-api-1` and
  `app-portal-1` at `0dbad8a8` ⊇ `1193a07a`, 0 restarts, health + `/settings/desk-phones`
  200 on both hostnames).** Migration `20260902140000_desk_phone_selection` applied by
  the api deploy and read back (`skippedAt timestamp NULL`, 14 rows, 0 skipped); the
  selection route + `skippedAt` grepped in the running api; the shipped portal CSS
  carries `dps-linkbtn`/`dps-unpicked` and the chunks carry "Set up this phone",
  "Only the ones not connected", "Tick the phones you want set up" and `/selection`.
  Live probe inside `app-api-1`: no token → 401, SUPER_ADMIN on an unknown run → 404,
  nothing written. ⛔ GitHub 401'd the server's fetch AGAIN (bundle → bare mirror →
  deploy → origin restored + mirror removed, verified).
- ✅✅ **PROVEN BY IZZY THE SAME HOUR (21:34Z): he restarted the app and ran it on A plus
  center — `DESK_PHONE_SELECTION_SET {selected: 1, skipped: 12}`, only Jacob 103 in the
  setup, twelve rows skipped and untouched, the screen reading "0 of 1 phones ready".**
- ✅ **THE NEXT WALL IT FOUND IS CLOSED THE SAME DAY (`ba20d717`, the section above):
  a factory-reset phone used to sit on "Preparing" forever because the ladder's rung-3
  instruction `set_provisioning` had NO EXECUTOR (recorded as a gap on 2026-08-22, Part 4
  §7). The desktop's sixth op now hands the phone its folder over Yealink PnP. ⛔ Until
  rc.7 is on the office machine the OLD app still stalls there — **by hand today:** set
  `https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/` in the phone's Auto
  Provision menu and press Autoprovision Now; once `T2_103` registers the row flips to
  REGISTERED and the wizard goes Ready by itself.
