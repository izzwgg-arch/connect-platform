# ⛔⛔ AGENT HANDOFF — the pay line does Izzy's full spec now: matched caller-ID NEVER asks a PIN; unknown callers key the account number, then PIN-or-star; star sends a one-time code by PHONE CALL or TEXT to a number on the account (2026-09-17 evening) — READ FIRST for "it asked me for a PIN", "the code never came", "the code call has no audio", anything touching `payIvrCore.ts` / `payIvrRuntime.ts` / `payLineSms.ts` / `payPrompts.ts` / `connect-supermarket-pay.conf`

Full handoff: **`docs/ai-context/AGENT_HANDOFF_SUPERMARKET_MODE_2026-08-26.md` §16e** (§16d is the
morning's caller-ID rule this replaces; §16b the CURLOPT header trap; §16c the 09-09 decode).
Prior summary: `2026-09-17-pay-line-caller-id-rule.md` (still true for the register facts).

Izzy, 2026-09-17 ~13:20 ET, after calling from 845-782-3064 and hearing the PIN prompt:
*"The customer calls in. The phone number matches something in the system. Great, they can make a
payment, no problem. Shouldn't ask for a PIN at all. The customer calls in from a number not in the
system. It should ask for the phone number to look up the account. Found the account. Enter the PIN.
If they don't have a PIN, they have two options to get a code: by a phone call (make an IVR that will
deliver that code by phone call) or by text to any number. Only a phone number that is on the account
on file, and they can pick which number they want to get the text to, and they have to enter the code.
Create IVRs for all this and set it up end to end, stress-tested."* Then: *"Should come from their
phone number."* (the code call and the text both come from Gesheft's own 845-244-9666).

## What his 13:16 ET call actually did (measured)

- PBX log + `SupermarketPayCall` row: 845-782-3064 → register account **3762 JACOB WEINSTOCK**
  (1 Visa on file, on-account no), `callerIdMatched: true`, probe answered *"Invalid customer
  PIN."* = the POS HAS a PIN Loopcom never learned → the morning's "ask ONCE" branch played
  `01_welcome, 02_pin`; he hung up at 12 s with 0 attempts. The line did what was built on
  09-17 morning; what was built is what he is rejecting.
- ⛔⛔ **Re-proven from inside `app-api-1` with the real key: the register refuses a CHARGE on a
  no-PIN account with `"Customer PIN required."` with NO header and with `X-Customer-Pin: 0`**
  (probe on Izzy's own card-less 1001021 with a bogus card id — nothing could move). So "no PIN
  in the POS" = unservable by anyone, and "PIN in the POS" = servable only when Loopcom holds
  that PIN. No code we write changes that; only the store (POS PIN) or POS with Logic (an API
  bypass or a PIN read — the open 08-25 ask) can.
- ⛔ **"Stephen" is Amazon Polly NEURAL, not ElevenLabs** (Kristen is the ElevenLabs one; Izzy's
  pick B, "Stephen = neural, always"). ElevenLabs being unpaid does NOT block new Stephen
  prompts — the morning's belief that it did was wrong.

## What is built (api `payIvrCore.ts` / `payIvrRuntime.ts` / `payLineSms.ts` / `payPrompts.ts` / `payIvrDialplan.ts` / `payAmount.ts`)

- **Rule 1 — matched caller, NEVER a PIN prompt.** Enrolled PIN → silent verify → `22_main_menu`.
  Nothing enrolled → silent probe: *served* → menu; *PIN required* → person at once (`status
  no_pin`, `blockedReason pin_not_set`, unchanged); *invalid* → **person, `status
  pin_not_enrolled`** and a `warn` log naming the account — the desk enrolls the customer's POS
  PIN from the Orders screen ("Phone PIN", verify-before-store) and every later call is silent.
  ⛔ `SUPERMARKET_PAY_MATCHED_PIN_POLICY=ask_once` (api env, read per call; also
  `deps.matchedPinPolicy`) restores the morning's ask-once-then-enrol behaviour. It is an
  operator switch; the default is Izzy's rule.
- **Rule 2 — unknown caller keys the account phone** (10 digits; 7 digits get 845; a leading 1 is
  dropped). Lookup = register exact match, then the mirror (`resolveCallerAccount`, so a second
  number on the record and a register outage both still find the account).
- **Rule 3 — found → silent probe FIRST**: *PIN required* → person at once (no futile PIN or code);
  *invalid* → **`23_pin_or_star`** ("enter your PIN … if you do not have a PIN, press star"); a
  probe that happens to PASS never serves a foreign caller — they still key the PIN. A keyed PIN
  is verified by the register and NEVER enrolled; 3 wrong → `15_too_many_tries` + person.
- **Rule 4 — star → the one-time code.** `24_code_channel_menu` (1 = phone call, 2 = text) →
  `list_numbers` = the register record's `phones[]` ∪ the mirror's `phonesText`, ≤4, in record
  order; 0 numbers → person; 1 → sent at once; 2+ → `25_code_number_intro` + "`26_press` num_N
  `27_for_number_ending_in` d d d d" per number (**last four only, never a full number**) → pick.
  - **Text**: `payLineSms.sendPayLineSms` — synchronous, from the tenant's default texting number
    (Gesheft +18452449666, VoIP.ms, on the platform's "default" account) via
    `resolvePlatformSmsSender(thatNumber)`; body "Gesheft: your one-time phone payment code is
    123456. It expires in 10 minutes…". A number on another carrier/account answers
    `not_configured` → person (never silent).
  - **Phone call**: the step result carries `dial` (ten digits) + `dialPrompts`
    (`28_code_call_intro`, six `num_X`, `29_code_again`, six `num_X`, `10_thanks_bye`); the
    dialplan view joins them to `dialPlayback`. **The PBX places the call** — there is NO api-side
    originate path in this repo (the vm greeting "call-to-record" goes through the PBX helper's
    `asterisk -rx`; nothing dials a PSTN number). The pay dialplan runs
    `Originate(Local/${PAY_DIAL}@${PAY_CODE_CTX}/n,exten,connect-pay-code-say,s,1,45,ac(${PAY_CODE_CID})v(PAY_DIALPLAY=…^__PAY_CODE_CID=…))`
    asynchronously; `[connect-pay-code-say]` = Wait(1) + Playback + Hangup, never a Read();
    `[connect-pay-code-dial-gesheft]` = `CALLERID(num)=8452449666`, `Dial(PJSIP/${EXTEN}@344022_gesheft,40)`
    — the same trunk string a real Gesheft outbound call used at 12:50 ET.
  - After sending: `31_code_call_sent` / `32_code_text_sent`, gather 6 digits. Empty reads (the
    caller waiting for the call/text) replay `30_enter_code` up to 8×; wrong → `33_code_wrong`,
    3 wrong → person; expired (10 min) → `33_code_wrong` + the channel menu if a send remains;
    `*` = resend; **≤2 sends per call** (the text-flood bound).
  - Correct code → `ownerVerified` → the vault is read AT THAT MOMENT: enrolled PIN → silent
    verify → menu (balance/payment exactly as before); none → person `pin_not_enrolled`. A
    verified owner is NEVER enrolled (nothing is keyed that could be).
  - ⛔ The code never exists in clear after generation: the session row holds
    `hashOtpCode(code, sessionRowId)` (the sign-in code's helper) + expiry; logs carry `…last4`
    only; the reducer sees only `code_sent`/`code_result`.
- `normalizePayIvrState()` reads every older row shape. Session statuses: `open | done | failed
  | no_pin | pin_not_enrolled`.
- **Prompts**: `payPrompts.ts` is the manifest (01–22 paraphrased from the handoffs — the
  recordings are the authority; 23–33 verbatim). `apps/api/scripts/cut-pay-prompts.ts` cuts the
  09-17 eleven through Polly Stephen/neural (`polly.ts` gained `ssml: true` for the IPA
  "Gesheft" phoneme) at 8 kHz mono 16-bit — run inside `app-api-1`, output
  `loopcom:/root/stephen-neural-v2/` and appended to the canonical `loopcom:/root/stephen-neural/`
  (52 → 63).

## PBX writes (pay-line mandate; both backed up)

- `/etc/asterisk/extensions__60_custom.conf`: the pay blocks spliced from the repo conf
  (`splice-pay-dialplan.py`, markers = the header comment → the Gesheft dial-out `Hangup()`),
  backup **`.bak.paycode.20260917T175136Z`**, `dialplan reload` OK, verified: `connect-pay-code-say`
  (Playback + Hangup), `connect-pay-code-dial-gesheft` (CALLERID + Dial), 1 Originate in
  `connect-supermarket-pay`, `PAY_CODE_CTX`/`PAY_CODE_CID` set in `connect-pay-gesheft`. The
  Originate only fires when a step carries `dial`, so the block was inert until the api deploy.
- `/var/lib/asterisk/sounds/connect-pay/en-male/`: the 11 new WAVs added (**52 → 63**), owner/mode
  matched to `01_welcome.wav`, md5 = the loopcom copies; listing before the change in
  `pbx:/root/payline-en-male-listing-before-paycode-*.txt`. Nothing overwritten.

## Verification

- **Tests (`TESTS_RUN.md` 2026-09-17 evening): the whole `src/supermarket/*.test.ts` glob → 224/224**,
  incl. `payLineCode.test.ts` NEW 13/13 (a 500-account × call/text × 1–3 numbers × 5-behaviour
  stress: code never persisted, only account numbers contacted, ≤2 sends per call, every failure on a
  person, exactly one charge per payer; source guards: the reducer imports only `./payAmount`, the
  runtime never logs the code), `payIvrDialplan` 10/10 (conf guards), `supermarketCore` 37/37,
  `payLineStress` 9/9, `supermarketStress` 28/28. `tsc` 0 errors in supermarket/*.
- **Deploy + live door proof: see "Deployed + proven" at the bottom of this file** (written by the
  docs follow-up commit right after the code commit, with the exact hash).

## Round 2 (same evening, ~19:00Z) — a matched caller whose OWN account can't be served is asked for another account, not handed off

Izzy called from his cell (562-209-6644 → 1001021, NO POS PIN) right after the deploy: *"it took me
to the phone orders menu … It should have asked me for the phone number in the account I want to
make a payment on. Or hear balance."* Under round 1 that case (and the "POS PIN not enrolled" case)
went to a person at once.

- **Built (`redirectToLookup` in `payIvrCore.ts`):** a caller-ID-MATCHED caller whose own account
  cannot be served (register "PIN required", or a POS PIN Loopcom does not hold under the default
  "never" policy, or a stale stored PIN refused) now hears **`34_enter_account_phone`** ("We cannot
  take a phone payment on the account for the number you are calling from. Please enter the phone
  number on the account you would like to pay or hear the balance of, followed by the pound key")
  and continues exactly like an unknown caller: lookup → silent probe → `23_pin_or_star` → PIN or
  star → code. State: `ownAccountBlocked: pin_not_set | pin_not_enrolled` (desk-visible; the session
  row keeps the own account id it wrote first), `blockedReason` cleared, `callerIdMatched` false.
  **Once per call**: a second unservable account, a looked-up account, or an owner-verified account
  still ends at `20_connect_person` with `status no_pin` / `pin_not_enrolled` as before. A warn
  log names the own account and the reason. `ask_once` still asks `02_pin` for the POS-PIN case.
- Useful side effect: a matched caller on a PIN-having un-enrolled account can pay by keying their
  own number + their POS PIN on the looked-up path (never enrolled, never asked without keying).
- Prompt `34_enter_account_phone` cut (Polly Stephen/neural, 9.5 s, 8 kHz) and installed —
  `en-male` **63 → 64**, canonical `loopcom:/root/stephen-neural/` 64. No dialplan change.
- **Round 2 — tested / deployed / proven (~19:55Z):** tests — the supermarket glob all green
  (`payLineCode` 16/16 with 3 new redirect cases, `supermarketCore` 37/37, `payLineStress` 9/9,
  `supermarketStress` 28/28; 81/81 re-run by hand); **api `528bf977` deployed direct**, container
  `.build-commit` = 528bf977, healthy, `/ready` 200, prompt 34 named in the container's reducer.
  **Live door proof `/root/payline-live-proof3.sh`** (real register, probes only, no text, no charge):
  1. Izzy's cell (1001021, no POS PIN) → `01_welcome, 34_enter_account_phone`, gather phone → keys
     8457823064 → `23_pin_or_star` (row: own account first, then 3762, `ownAccountBlocked pin_not_set`,
     `status done` on hangup, never `no_pin`).
  2. 845-782-3064 (3762, POS PIN not enrolled) → `34_enter_account_phone` → keys its OWN number →
     `23_pin_or_star` (`ownAccountBlocked pin_not_enrolled`) — the caller can pay by keying the POS PIN.
  3. Izzy's cell → asked → keys 5622096644 again → `20_connect_person`, `status no_pin` — the
     redirect fires once. Warn log per redirect names the own account + reason; vault still 0 rows.
  ⏳ NOT proven by a human: hearing prompt 34 on a real call; the rest of the round-1 ⏳ list stands.

## Sola vs the POS (Izzy, same evening: "if we can put it through the POS system straight, that would be more efficient" → "The PoS is way better")

- **The pay line already goes straight through the POS**: `POST /customers/id/{id}/charges` with
  the card id the REGISTER holds (`listCustomerCards` → first card) — no Sola anywhere in
  `payIvrRuntime.ts`. That was Izzy's own 08-25 directive ("never direct Sola for Gesheft — the
  POS charge keeps their books/balance in sync and uses their Sola underneath").
- **Where Sola still is: the Orders desk only** (`customerCards.ts`): a rep saving a NEW card
  through Sola iFields (→ xToken on the tenant's own Sola key, `SmCustomerCard`) and charging a
  phone ORDER against that Sola token (`chargeCardForDraft`). Those Sola-saved cards are
  invisible to the register, so the pay line cannot use them — two card vaults today.
- **Can the desk go POS-direct too?** Their API has `POST /customers/id/{id}/cards` — but it
  takes the FULL card number + cvv in OUR request (tokenized by their gateway after). Moving
  new-card capture there puts raw card numbers through the rep's browser and Loopcom's server
  (PCI scope lands on Loopcom); Sola iFields exist precisely so the raw number never leaves
  Sola's iframes. Charging an order via the POS `/charges` endpoint would also require the
  customer's POS PIN (same X-Customer-Pin rule). ⛔ Not switched in this task — it is a
  separate build and Izzy's explicit sign-off on the PCI trade-off (or a hosted-field
  equivalent from POS with Logic) is the gate.

## Deployed + proven (2026-09-17 ~18:45Z)

- **api `50f57f76` deployed direct** (`/root/deploy-api-payline-code.log`, `done 50f57f76`,
  container `.build-commit` = 50f57f76, healthy, `/ready` 200, `payLineSms.ts` present,
  `23_pin_or_star` ×2 in the container's `payIvrCore.ts`). Another session's `f3c818b0` (Yiddish)
  had landed at 17:31Z between the morning's e6875027 and this — `50f57f76` is on top of it.
- **Live door proof `/root/payline-live-proof2.sh`** (loopcom, real register, real api door;
  read-only on the register except one credit per probe; NO charge; one REAL text):
  1. matched 562-209-6644 → `01_welcome, 20_connect_person`, transfer, `status no_pin` — no PIN.
  2. matched 845-782-3064 (3762, POS has a PIN) → `01_welcome, 20_connect_person`, transfer,
     **`status pin_not_enrolled`, `02_pin` NEVER played** (the warn line names the account).
  3. foreign 212-555-0100 keys 5622096644 (no-PIN account) → probed → `20_connect_person` at
     once, no PIN prompt.
  4. foreign keys 8457823064 → `23_pin_or_star` → `*` → `24_code_channel_menu` → `1` →
     `31_code_call_sent` with **`dial=8457823064`** + `dialPlayback=…/28_code_call_intro&…`
     (the say-list) → empty read → `30_enter_code` → `000000` → `33_code_wrong, 30_enter_code`;
     session `codeChannel call`, `codeSentTo 8457823064`, hash present, sends 1, attempts 1.
     (The door does not place calls — the PBX does — so no call rang here.)
  5. same → `2` → **`32_code_text_sent`: a REAL text left 845-244-9666 for …3064** (api log
     "one-time code sent", ~14 s for the VoIP.ms send), session `codeChannel text`, sends 1.
  Across all five: **0 persisted states contain a 6-digit code (hash only); the PIN vault
  stayed at 0 rows.**
- ⏳ **NOT proven by a human:** hearing the new prompts; the outbound code CALL actually ringing
  (the dialplan Originate has never fired on a real call — first real star+1 proves it; if it
  does not ring, read the PBX log for `connect-pay-code-dial-gesheft` / `ORIGINATE_STATUS`);
  keying a received code back; a real charge. Acceptance (Izzy): from a phone NOT on any
  Gesheft account call 845-244-9666, press 0, hear "we do not recognize…", key 8457823064, hear
  "enter your PIN… or press star", press star, press 1 → 845-782-3064 rings from 845-244-9666
  and Stephen reads six digits twice; key them → because 3762's PIN is not enrolled, a person
  (enroll 3762's POS PIN on the Orders desk first and the same call ends at the main menu).

## What the store must do (the part no code can do)

- Enroll each phone-paying customer's POS PIN on the Orders desk ("Phone PIN") — until then a
  matched caller on a PIN-having account lands on a person with `pin_not_enrolled`, and an
  owner-verified foreign caller does too. Set a POS PIN for every on-account customer who should
  pay by phone (12/15 sampled on-account accounts already have one). Izzy's own test accounts:
  1001021 (cell) has NO POS PIN and no card; 3762 (845-782-3064) HAS a POS PIN + a Visa — to
  make the 3064 line pay silently, enroll its PIN on the desk (or flip `ask_once` and key it once).
- The 08-25 asks to POS with Logic stand: PIN read/provisioning via API, or trusted-caller-ID
  enforcement. Either one would make Rule 1 work for EVERY account with no desk work.
