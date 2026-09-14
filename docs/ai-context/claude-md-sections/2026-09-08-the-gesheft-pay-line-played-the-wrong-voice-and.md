# ⛔⛔ AGENT HANDOFF — the Gesheft pay line played the WRONG VOICE and threw every caller to a person at its SECOND step: `CURLOPT(httpheader)` STACKS on the channel (2026-09-08) — READ FIRST before adding a `Set(CURLOPT(httpheader)=…)` to ANY dialplan loop, before touching `/var/lib/asterisk/sounds/connect-pay/`, or for "press 0 says we don't recognize your number and dumps me on the menu"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_SUPERMARKET_MODE_2026-08-26.md` §16b**
(repo: `scripts/pbx/supermarket/connect-supermarket-pay.conf` + a source guard in
`payIvrDialplan.test.ts`. **PBX writes under the standing pay-line mandate, both
backed up:** the `[connect-supermarket-pay]` block in `extensions__60_custom.conf`
(backup `.bak.payheaders.20260909T003957Z`) + `dialplan reload`, and the prompt
folders (old set at `pbx:/root/payline-prompts-backup-20260909T003957Z/en-male`).
**No api/portal deploy** — nothing runtime-side changed. Memory:
[[asterisk-curlopt-httpheader-accumulates-per-channel]].)
Izzy, 2026-09-08: *"The voice is not the voice that we selected. It's supposed to be
the Stephen voice… When I press 0, it says 'We do not recognize the number you're
calling from,' and it took me to the main menu."*

- ⛔⛔ **THE 403: Asterisk's `CURLOPT(httpheader)` ADDS a header to the channel every
  time it is set — its own doc says "Multiple calls add multiple headers".** The pay
  dialplan set `Content-Type` + `x-cdr-secret` INSIDE the step loop, so the SECOND
  request of every call carried the secret twice, Node joined them as `S, S`, the
  door answered `{"error":"forbidden"}`, and the dialplan bailed to
  `T8_app-time-condition,TC-4` (Phone Orders → IVR-22 "Orders" in hours). **That is
  the "took me to the main menu."** Proven three ways: nginx shows the same
  `200 → 403` pair on EVERY pay call since 08-26 (01:13/01:14, 01:50/01:51, 02:14 ×2);
  a curl to `127.0.0.1:3001` with the header ONCE → 200, TWICE → 403; and after the
  fix an originated call ran step 1 **200** → step 2 **200** (`19_lookup_not_found`
  + `13_not_recognized`) → hangup **200**. ⛔ The 09-08 "proven on the wire" only ever
  looked at the FIRST step — a one-request proof cannot see a per-channel
  accumulation. **Rule: set CURL headers ONCE per channel, before any loop, never in
  `h`** (the channel datastore still carries them there). Guard:
  `payIvrDialplan.test.ts` reads the conf — exactly two header `Set()`s, both before
  `n(step)`, none after `exten => h` — and fails against HEAD (4, all in the loop).
- ⛔⛔ **THE VOICE: the `en-male` set on the PBX matched NONE of the stashes on
  loopcom** — welcome 1.76 s and prompt 13 **2.28 s** ("we do not recognize…" with
  no lookup offer) vs the canonical Stephen-NEURAL set (`loopcom:/root/stephen-neural/`,
  52 files, Izzy's pick B on 08-25) at 2.29 s / **9.12 s**. The 08-26 dialplan session
  installed "51 male prompts" from an unrecorded source. **`en-male` is now the
  Stephen-neural set byte-for-byte** (md5 `59f44048…` on `01_welcome`), and
  `en-female` holds the Kristen assembly (v1 + v2 05/13/19/20 + numbers + 21/22, 52
  files) for the "two voices to choose from" decision. ⛔ The prompt dir is ONE global
  (`SUPERMARKET_PAY_PROMPT_DIR`, default `en-male`) — per-line voice choice is NOT
  built. ⛔ Verify a prompt set by DURATION/md5 against `/root/stephen-neural`, never
  by "51 files are there".
- ✅ **The press-0 flow is now the flow Izzy specced on 08-25:** unknown caller-ID →
  welcome + "we don't recognize this number, enter the phone number on the account,
  then #" → lookup → PIN → 1 balance / 2 payment. His 20:14 calls came from
  **845-557-7768 (Connect's own admin number)**, which is not a Gesheft account, so
  "not recognized" was CORRECT for that number; his 19:50 call from the Gesheft DID
  matched and went straight to PIN — then died on the same 403 at hangup.
- ⏳ **NOT PROVEN by a human since the fix** — nobody has keyed a phone number, a PIN
  or an amount; the greeting still does not say "press 0 to pay". Acceptance: call
  845-244-9666, press 0, hear STEPHEN, key a real account's 10 digits + PIN, hear the
  balance.

- ✅ **2026-09-09 "it asked me for a PIN" — both calls decoded, nothing broken (handoff §16c).** Izzy's cell 562-209-6644 IS on Gesheft's register (`PosCustomer 1001021 IZZY WEIN`), so the line recognised him and skipped the lookup correctly; 845-782-3064 = `3762 JACOB WEINSTOCK`. Both asked a PIN because **`SupermarketPhonePin` has 0 rows — the agreed rule is PIN-ONCE enrollment** (the register demands `X-Customer-Pin` on every balance/charge and its customer record carries no PIN), and nobody has ever keyed one. Both calls hung up at the prompt. Never asking even once needs Gesheft/POS with Logic — the open 08-25 ask.
