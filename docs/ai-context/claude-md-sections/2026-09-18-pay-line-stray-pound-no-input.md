# ⛔⛔ AGENT HANDOFF — the Gesheft pay line said "invalid PIN" before the caller keyed anything: the POUND KEY the prompt asks for lands on the NEXT prompt (2026-09-18) — READ FIRST for "it jumps ahead", "it says invalid before I type", "it keeps asking for a number in the card flow", "too long before the next prompt", or before changing ANY `maxDigits` / `Read()` / `GET DATA` on this line

Full handoff: **`docs/ai-context/AGENT_HANDOFF_SUPERMARKET_MODE_2026-08-26.md` §16i**.
The flow itself is unchanged from `2026-09-17-pay-line-final-flow.md` (rounds 3–5).

Izzy, 2026-09-18 (three symptoms): *"Sometimes when it's asking me for the PIN, it's saying
'invalid PIN' before I even have a chance to put in a PIN. It's jumping ahead."* · *"When I add
'I want to pay with a card,' it's looking for a number, or it's taking too long for the next
prompt to play after I hit a menu option."* · *"It would fast-forward and skip words sometimes."*

## What was actually wrong (read off the PBX log, three real calls, timestamps)

- ⛔⛔ **Every prompt says "followed by the pound key", but the fixed-length gathers close
  BEFORE the pound.** The 10-digit phone gather is `maxDigits 10`, so Asterisk's `Read()`
  returns on the 10th digit; the `#` the caller keys ~1.5 s later arrives while the NEXT
  prompt (`02_pin`) is already playing and is THAT `Read()`'s terminator → `User entered
  nothing.` → the api scored an empty PIN as **wrong** → `03_pin_wrong`. Call `C-00000024`
  (06:49 ET): `User entered '8457826775'` 06:49:59 → `02_pin` 06:50:00 → `DTMF end '#'` 06:50:01
  → `User entered nothing.` → `03_pin_wrong&02_pin`. Same shape on `C-0000122f` and
  `C-00001232` (01:56/01:58Z) — **3 of the last 4 real calls.** The 1-digit menus do it too
  (`1#` → the `#` hits whatever comes next).
- ⛔⛔ **The AGI card collector has the identical defect:** expiry is `GET DATA … 4` → returns
  on `1126`'s 4th digit; the `#` lands on the CVV prompt → empty → `45_card_invalid` → the
  caller keyed `#` again → three strikes → he hung up (`C-0000122f` 21:58:59–21:59:19). That is
  the "it's looking for a number". The zip (5) and a 4-digit Amex code do the same.
- **"Taking too long"** was not the api: door round-trips measured 0.04–0.62 s (register
  lookup/probe), PBX→api 0.4 s incl. TLS, first step ~2 s of dead air after pressing 0. The
  real waits: `GET_TIMEOUT_MS = 15000` is Asterisk's ONE timeout for first-digit AND
  inter-digit, so a 3-digit CVV or a 16-digit card number keyed WITHOUT a pound sat in
  15 s of silence; and a silence was answered with a WRONG-answer message, which reads as
  the line ignoring you.
- **"Fast-forward / skipped words"**: nothing new found. Any keypress cuts the prompt
  mid-sentence by design (`Read()` is interruptible so a caller can key through); the stray
  pound made that happen at the START of the PIN prompt ("Please en—"); and the 09-17
  platform finding (PBX→VoIP.ms Lumen path 5–24 % loss, Izzy's remedy) is still open —
  these calls carry no `rtpStats` samples, so per-call loss is unmeasurable here.
- ⛔⛔ **FOUND IN PASSING — a PCI leak the 09-17 secrecy proof missed:** VitalPBX's
  `logger__50-files.conf` puts `dtmf` on the `full`, `console` AND `fail2ban` channels, so
  **every keyed card number and PIN is in `/var/log/asterisk/full` digit by digit** (`DTMF
  end '4' received on PJSIP/…` × 16, timestamps 21:58:31–21:58:46) — the 09-17 "0 occurrences
  in the PBX full log" grepped for the CONTIGUOUS number. The AGI kept the digits out of
  dialplan args as designed; the channel-level DTMF logger is a different door. Fix =
  drop `dtmf` from those channels + `logger reload` — a PBX logger change OUTSIDE the
  pay-line mandate, and it also removes the DTMF trace that diagnosed today's bug.
  **Izzy's call; NOT done.** (A VitalPBX update may regenerate that file too.)

## What is built (api + dialplan + AGI, three layers, each safe alone)

1. **api `payIvrCore.ts` — an EMPTY answer is "no input", never a wrong one.** New
   `noInputAttempts` (state + `normalizePayIvrState`, `PAY_MAX_NO_INPUT_ATTEMPTS = 3`).
   `reducePayIvr` handles `digits: ""` before the phase switch: `replayForNoInput()` replays
   exactly the prompt the phase asks with (37 / 38 / 02 / 22 / 21 / 05 / 07 / card menu / 46 /
   40), no "wrong" prefix, no effect, no `pinAttempts`/`lookupAttempts`/`amountAttempts`/
   `choiceAttempts` spent; the 3rd consecutive empty → `20_connect_person` (no "too many
   tries" — nothing was tried). Any keyed answer resets the count. Phases not waiting for
   keyed digits keep their own branch (probe in flight ignores; `card_entry` re-runs the
   collector; `human`/`done` unchanged; `card_choice` with no cards unchanged).
2. **dialplan `connect-supermarket-pay.conf` — an EARLY empty `Read()` is re-asked locally,
   once.** `gather` → `Set(PAY_REREAD=0)` → `read: Set(PAY_T0=${EPOCH})` → `Read(…,1,10)` →
   `GotoIf($["${PAY_DIGITS}" = "" & ${PAY_REREAD} = 0 & $[${EPOCH} - ${PAY_T0}] < 6]?stray)`
   → `stray: Set(PAY_REREAD=1)`, `Goto(read)`. A real timeout is prompt (≥2.3 s) + 10 s, so
   an empty inside 6 s can only be a stray terminator: the prompt plays again with no round
   trip and nothing counted. A second empty goes to the api (rule 1). **And the post-AGI step
   posts `PAY_DIGITS=${PAY_CARD}` (ok|fail|error)** instead of "" so it never reads as a
   silence (the api treats the word as an unknown key → replays 46, as before).
3. **AGI `connect-pay-card.py` — same two rules + `GET_TIMEOUT_MS 15000 → 10000`.**
   `collect()` counts `wrong` and `empty` apart (either reaching 3 gives up as before); an
   empty inside `STRAY_WINDOW_S = 6.0` is re-asked once uncounted; a later empty replays the
   field's prompt silently — `45_card_invalid` only ever follows a keyed wrong answer.
   `connect-pay-card.selftest.py` (fake AGI pipe + fake clock) proves 9 scenarios.
- ⛔ `maxDigits` stays fixed-length on purpose (instant when no pound is keyed); "wait for the
  pound" (maxDigits+1) was rejected — it turns every no-pound caller into a 10 s wait.
- No new prompts, no schema migration (state is JSON), no PBX change outside the pay block +
  the AGI file.

## Verification

- Tests: `payLineNoInput.test.ts` NEW 7/7 (the real 06:49 call replayed through the real
  runtime; caps; interleaving; every gathering phase; non-gather phases untouched; legacy
  rows; 800-call stress) · `payIvrDialplan.test.ts` 13/13 (3 NEW guards — **all 3 replay-FAIL
  against HEAD's conf/AGI**) · the supermarket glob **248/248** · AGI self-test 9/9 · api `tsc`
  0 errors in supermarket/*. Recorded in `TESTS_RUN.md`.
- ✅ **DEPLOYED 2026-09-18 ~11:32Z: api `816e5b00`** (origin tip; fix `a3cacc2b` is an ancestor —
  merge-base checked), direct blue/green `direct-api-20260918T112739Z.log` `done 816e5b00`,
  container `.build-commit` = 816e5b00, healthy, `/ready` 200. **Live door proof against the real
  register** (`stray-*` sessions): cell presses 2 → 8457823064 → EMPTY → `02_pin` only (not
  `03_pin_wrong`) → PIN 3064 → `22_main_menu`, row `pinAttempts 0, noInputAttempts 0, pinVerified
  true`; 3064 presses 1 → three EMPTY → `20_connect_person`, `pinAttempts 0, noInputAttempts 3`;
  EMPTY at the which-account menu → `37_which_account` replayed, `choiceAttempts 0`.
- ✅ **PBX (under the standing pay-line mandate, both backed up):** the `[connect-supermarket-pay]`
  block spliced (live block diffed IDENTICAL to repo HEAD first; `cat >` keeps inode 15731699 +
  ACLs; backup `extensions__60_custom.conf.bak.paystray.20260918T112759Z`), `dialplan reload`, read
  back: `[gather] 29 … [read] 31 Set(PAY_T0) 32 Read() 33 GotoIf(…?stray) … [stray] 35–37`, card
  block `45. Set(PAY_DIGITS=${PAY_CARD})`, 0 Originate/Dial, 2 header Sets in `s`, 0 in `h`. AGI
  installed `md5 124741e0…` (old copy `/root/connect-pay-card.py.bak.paystray.<ts>`), self-test 9/9
  on the PBX.
- ✅ **LIVE PROOF ON A REAL PBX CALL** (`/root/paystray-call.py`: AMI originate of
  `Local/799@T8_app-custom-application/n` as Izzy's cell, digits injected with `PlayDTMF` on the
  `;1` leg, ⛔ hangs up on exit so a silent leg can never reach Gesheft's after-hours voicemail —
  the first attempt sat in `Wait` and was hung up by hand). Call `C-00000029` / `1789731224.70`
  07:33 ET, the exact shape of Izzy's 06:49 call: `2` → `38_enter_phone` → 10 digits → `User
  entered '8457823064'` → `02_pin` starts 07:34:01 → `#` 07:34:02 → `User entered nothing.` →
  **`GotoIf(1?stray)` → `pay-by-phone: stray terminator, prompt again` → `02_pin` replays** (no
  api call) → `3064#` → `User entered '3064'` → `22_main_menu`. Zero `03_pin_wrong`.
- ✅ **The INSTALLED AGI through the fake pipe** (`/root/agi-harness-stray.py`): an instantly-empty
  CVV answer was re-asked with NO `45_card_invalid` between, then `123` accepted; the whole card
  collected; the door answered no-session (unknown call id) → `PAY_CARD fail` as on 09-17; the test
  PAN appears 0× contiguously in the full log (⛔ but see the DTMF-logger finding above — a REAL
  call's digits DO land there one per line).
- ⏳ **NOT proven by a human:** Izzy keying `10 digits + #` and hearing only the PIN prompt; the
  card flow keying `MMYY + #` and hearing the CVV prompt once. Acceptance: call 845-244-9666, press
  0, 2, key a number + `#`, hear "please enter your PIN" ONCE (maybe a clipped half-syllable first),
  key the PIN + `#` → menu.

## What the store must do — unchanged

Set a POS PIN for every customer who should pay by phone. Izzy's test accounts: 1001021
(cell) no PIN/no card; 3762 (3064 line) PIN + Visa; 3049 (845-782-6775) PIN 6775 (served
06:49 ET, balance $0).
