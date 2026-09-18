# ⛔ AGENT HANDOFF — Yossis Wood Works is ON CONNECT IVR (full migration, real-call-proven) + the closed-Monday-Sep-21 pre-menu announcement is BOOKED (2026-09-17) — READ FIRST before touching Yossis' routing, the announcement, or any migration of a menu whose only recording is the "instructions" message

Done in one session, 2026-09-17 night (api commit `3049fd53`, deployed +
container-verified `/app/.build-commit`; probe calls PASSED).

## The migration (Izzy's order: migrate first, then the announcement)

- **Yossis Wood Works** = Connect tenant `cmnlgrynd0013p9pa1rq8ofnv`, PBX T28
  (`yossis_wood_works`), ONE number **845-827-9500** (mapping
  `cmsj7odr37yqrqn13m8kesg95`). PBX IVR-42 "Main": greeting = recording 89
  (26s, **instructions slot, welcome_msg_id NULL**), key 0 → Hours
  announcement (announcement-36, returns to menu), keys 1–5 → ring groups
  800 Estimates / 801 Customer service / 802 Billing / 803 Drafting /
  804 Scheduling, dial-by-extension ON, timeout/invalid ×3 → VM-102.
- ⛔⛔ **THE PLANNER BUG THIS FOUND — a menu whose ONLY recording is the
  VitalPBX "instructions" message migrated SILENT.** `buildImportPlan` read
  `ivr.welcome` alone; VitalPBX plays instructions as the menu prompt when
  there is no welcome. Yossis' plan carried `promptRef: null` +
  `requiredRecordings: []` while the live menu greets with a real recording.
  ✅ Fixed in `3049fd53` (`ivrMigration.ts`: `ivr.welcome ?? ivr.instructions`,
  welcome still wins when both exist; 2 tests, the fallback one FAILS replayed
  against pre-fix source). Check `promptRef` in every future plan before
  importing — null + a menu that talks = this bug's shape.
- Migration ran through the product doors: plan (clean, 0 problems) → import
  (profile `cmu67d91000sers12b070ba2h`, 6 keys, greeting copied to PBX 1/1) →
  publish (125 keys, record `cmu67dh1w00z0rs12rml7t4mt`) → switch-to-connect
  (destination 577 snapshotted for one-click rollback via
  `POST /voice/did/cmsj7odr37yqrqn13m8kesg95/switch-to-pbx`; route re-baked
  `Goto(connect-doorway,s,1)`, verified in the RENDERED dialplan).
- ⛔ `audioSync.missingAudio` on publish listed the greeting — **that is NOT a
  missing file for an import-sourced prompt** (Connect holds no bytes; the
  import's `/recording-export` put the WAV on the PBX directly). Verified on
  the PBX: `sounds/custom/yossis_wood_works_vpbx89.wav`, 25.9s 8k mono.
- ✅ **PROVEN WITH REAL CALLS** (`/root/ivr-e2e.sh` on the PBX): bare call →
  `connect-menu,mcmu67d91000sers12b070ba2h` playing
  `custom/yossis_wood_works_vpbx89`; press 0 →
  `Goto(T28_app-announcement,announcement-36,1)` and its recording played.
  Keys 1–5 were NOT probed (2 AM — they ring real ring groups); their AstDB
  opt keys are verbatim the PBX's own Gotos. No IvrScheduleConfig row was
  created (no PBX time condition) — the no-schedule publish falls back to the
  main menu, and the didmap-override defect
  ([[migrated-ivr-schedule-overrides-per-number-menus]]) cannot bite.

## The announcement (Tiffany, closed Monday Sep 21)

- Recording generated through `POST /voice/ivr/prompts/generate-polly`:
  **Amazon Polly "Tiffany", generative engine**, 11s, prompt row
  `cmu67h70g01k2rs121zyz55f9`, ref
  **`custom/closed_monday_september_21_notice_4ff878`**, pushed to the PBX
  (verified on disk). Text: "Thank you for calling Yossi's Wood Works. Please
  note that we will be closed on Monday, September 21st. We apologize for any
  inconvenience, and we look forward to serving you when we reopen."
- Booked `IvrAnnouncementSchedule` **`cmu67hen801u9rs12hka1dtcj`**, status
  pending: **starts Sun 2026-09-20 08:00 ET (12:00Z), ends Tue 2026-09-22
  00:00 ET (04:00Z)** — the 60s DID-switch tick sets/clears
  `connect/t_yossis_wood_works/pre_announce`; dialplan plays it ONCE before
  the menu (verified the block STAT-checks the exact WAV that is on disk and
  falls into `(permenu)` — the same path the probe calls took). Failures
  retry 30 min then alert ADMIN_ALERT_EMAIL.
- ⛔ To pull it early: `POST /voice/ivr/announcement/cmu67hen801u9rs12hka1dtcj/stop`.
  Booking ANY new announcement for Yossis cancels this pending one (replace,
  don't stack, by design).

## ⏳ NOT PROVEN

- Sunday's automatic start + Tuesday's automatic stop (future firings of a
  live-proven tick — A plus's 2026-08-05 booking proved the mechanism both
  directions). Check Sunday morning: `database get connect/t_yossis_wood_works
  pre_announce` on the PBX should return the ref, and a real call should hear
  Tiffany before the greeting.
- No HUMAN has dialled 845-827-9500 since the flip (probes only). Keys 1–5
  and direct dial unprobed by a real call.
- The catch-up: keys 1–5 still hand back to PBX ring groups by design (hybrid
  flow) — moving ring groups into Connect teams was NOT asked for and NOT done.
