# ⛔⛔ AGENT HANDOFF — the Gesheft pay line, FINAL FLOW (2026-09-17, late evening): "your account or a different one?" → PIN → menu; the one-time code by call/text and the caller-ID no-PIN rule are GONE — READ FIRST for anything touching `payIvrCore.ts` / `payIvrRuntime.ts` / `payPrompts.ts` / `connect-supermarket-pay.conf`, or for "it asked me for a PIN" (it is supposed to)

Full handoff: **`docs/ai-context/AGENT_HANDOFF_SUPERMARKET_MODE_2026-08-26.md` §16f**.
Earlier the same day, superseded but kept as history: `2026-09-17-pay-line-caller-id-rule.md`
(morning: matched = probe, ask once) and `2026-09-17-pay-line-code-by-call-or-text.md` (afternoon:
matched = never a PIN, star → one-time code by call/text, then the "own account unservable →
ask for another account" redirect). The register facts in both are still true.

Izzy, ~20:20Z, after two calls from his own numbers hit the afternoon's rules: *"remove the
verification code by text and call. Phone call, then it's going to go like this: 1. When they
come into the payment system, ask them, 'Do you want to make a payment on the account, phone
number, the [one you're calling] from, or a different one?' 2. Whichever they select, if they
select the one they're calling from, ask for the PIN. If they select a different one, ask for
the phone number, then ask for the PIN. 3. From there on, it now goes to the system."* Plus,
from minutes earlier: *"if they don't have a PIN, they should go down to the store and create
one."*

## The flow (api `payIvrCore.ts`, pure reducer)

1. **Known caller** (their number is on a register account, register exact match then the
   mirror): `01_welcome` + **`37_which_account`** — "To make a payment or hear a balance on the
   account for the number you are calling from, press 1. For a different account, press 2."
   **Unknown caller**: `01_welcome` + `13_not_recognized` → enter the phone number.
2. **1** → silent probe of their own account → **`02_pin`**. **2** → **`38_enter_phone`** →
   lookup (register, then mirror; 7 digits get 845) → silent probe → `02_pin`. Wrong choice ×3,
   bad/not-found number ×3, wrong PIN ×3 → `20_connect_person`. Every caller keys the PIN;
   nothing is enrolled, nothing is remembered, the `SupermarketPhonePin` vault is never read
   by the line (the desk "Phone PIN" routes still exist, unused by the call).
3. Then `22_main_menu` (1 balance, 2 payment) exactly as before.
- ⛔ **No PIN in the POS** (register "Customer PIN required." — proven for balance AND charge
  2026-09-17): the silent probe catches it BEFORE any PIN prompt → **`36_no_pin_visit_store`**
  ("This account does not have a PIN set up yet. To pay by phone, please visit the store to set
  one up.") + `20_connect_person`, `blockedReason pin_not_set`, `status no_pin`. Izzy's own
  cell (1001021) is such an account; his 845-782-3064 line (3762) has a PIN and gets `02_pin`.
- Session row: `posCustomerId` = the account served, else the caller's own account.
  `normalizePayIvrState` maps any legacy phase (the day's earlier shapes) to `human`.
- Prompts 36/37/38 cut in Stephen (Polly neural) and installed (`en-male` 64 → 67; the retired
  23–35 WAVs stay on the PBX, harmless). Dialplan: the round-1 `Originate` + the two code-call
  contexts REMOVED from the repo conf and from the live PBX (`.bak.paycode-removed.20260917T204449Z`,
  reload clean, `Originate` count 0, `connect-pay-code-say` gone); guard test now asserts the pay
  conf never `Originate()`s or `Dial()`s. `payLineSms.ts` + `payLineCode.test.ts` deleted.

## Verification

- **Tests:** the whole `src/supermarket/*.test.ts` glob → **208/208** (`payLineStress` 8/8: a 2,000-account
  matrix × {own #1, own #2 self-lookup, foreign} × {no PIN, right PIN, wrong ×3} — served ⇒ keyed the PIN,
  no-PIN accounts hear exactly 36 then 20, vault touched 0×; `supermarketCore` 37/37; `supermarketStress`
  28/28; `payIvrDialplan` 10/10 incl. the no-Originate/Dial guard). `tsc` 0 errors in supermarket/*.
- **Deployed:** commit `25ef3d12` (code) — the direct deploy shipped the branch tip **`64746df2`**
  (two other sessions' commits on top; 25ef3d12 is an ancestor, merge-base checked); container
  `.build-commit` = 64746df2, healthy, `/ready` 200, `37_which_account` in the container's reducer,
  `payLineSms.ts` gone. ⛔⛔ **Two deploy attempts before it FAILED at `candidate_start`:
  `failed to bind host port 127.0.0.1:3004/tcp: address already in use`** — not a listener
  (`ss -ltnp` shows nothing): an nginx keepalive to telephony (:3003) had been given the ephemeral
  SOURCE port 3004, because the 08-23 perf tuning lowered `ip_local_port_range` to 1024 with no
  reserved ports. The live api was never touched (upstream stayed on 3001). Fixed at the root:
  `net.ipv4.ip_local_reserved_ports=3000-3010` (runtime + `/etc/sysctl.d/zz-connectcomms-reserved-ports.conf`),
  the one socket killed with `ss -K "sport = :3004"`, third attempt clean. Memory
  [[blue-green-deploy-ports-must-be-reserved]].
- **Live door proof `/root/payline-live-proof4.sh`** (real register, probes only, no charge), all as
  designed: (1) 845-782-3064 (3762, POS PIN) presses 1 → `02_pin`; wrong PIN → `03_pin_wrong, 02_pin`;
  (2) Izzy's cell (1001021, no POS PIN) presses 1 → `36_no_pin_visit_store, 20_connect_person`, `status
  no_pin`, no PIN asked; (3) his cell presses 2, keys 8457823064 → `02_pin`; (4) unknown 212-555-0100 →
  `13_not_recognized` → keys a no-PIN account → 36 + person; (5) bad choice replays 37; 7 digits get 845.
  Vault 0 rows. **Izzy's own real calls right after the deploy (21:26–21:31Z): three accounts reached with
  the PIN accepted** (`pinVerified true`), two of them ending at `12_no_card` + a person — which is
  what prompted his next ask (key a card by phone; see the POS-API and Sola-PhonePay handoffs).

## Round 4 (same night, ~22:30Z) — PAY WITH A KEYED CARD, one-time or saved to the account

Izzy, after his own calls ended at "no card on file": *"It should give me the option to pay with
another card, even if there isn't a card on file, by typing in the card number … give them the
option to make this payment method a one-time thing or add it to the account as well and make it
the default payment."* Told once, plainly, that keyed digits put Loopcom in PCI scope
(transmission/processing; [[dtmf-masking-cannot-be-self-administered]]) — he had chosen the DIY
path on 08-16 and said **"Go, build it."** Sola is NOT involved: Gesheft's register takes the card
directly (its charge body takes `cardId` XOR an inline `card`; `POST /customers/id/{id}/cards`
stores one, tokenized by their gateway). Field names read off their validator on Izzy's own
card-less account: **`CardNumber` (Luhn-checked), `ExpMonth` 1–12, `ExpYear` 0–99, `CVV`,
`ZipCode`, `HouseNumber`**; unknown fields are ignored. Their docs are not published anywhere.

- **Flow:** the confirm step now says `39_confirm_choice_card` ("1 confirm, 2 different amount,
  **3 pay with a different card**"). No card on file → `12_no_card` + `40_card_offer` ("1 pay with a
  card now, 2 someone"). Card entry → the AGI collects number / expiry MMYY / CVV / ZIP (3 tries
  each, `45_card_invalid` between) → `46_card_save_choice` ("1 this payment only, 2 save it to your
  account as the card on file") → charge: **once** = inline card on `/charges`; **save** =
  `POST /cards` first, then charge by the new card id. Keyed card refused → `11_declined` +
  `47_card_declined_offer`; amount kept. Caps: collector restarted at most 2× per call.
- ⛔⛔ **Where the card number may exist and where it may NOT.** Asterisk writes every dialplan
  step to the full log WITH substituted arguments, so a card in a channel variable would be
  printed in clear. Therefore the digits are collected by an **AGI**
  (`scripts/pbx/supermarket/connect-pay-card.py` → `pbx:/var/lib/asterisk/agi-bin/`, owner
  asterisk 755) on its own pipe (`GET DATA`, not logged), Luhn/expiry-checked there, and POSTed
  once over HTTPS to the api's **card door** `POST /internal/supermarket/pay-ivr/card` (same
  shared secret as `/step`). The api validates again, keeps the card in a **process-memory vault**
  (`payCardVault.ts`, keyed by session row id, TTL 15 min, deleted on charge/hangup/decline) and
  advances the reducer with `card_entered {ok, last4}`. The reducer state, the session row and
  every log line carry at most `cardLast4`. The dialplan's `card` label runs
  `AGI(connect-pay-card.py,${PAY_URL_CARD},${PAY_TENANT},${PAY_CALL},${PAY_CID})` (the secret is
  read from AstDB by the script; `PAY_URL_CARD` from `DB(connect/system/pay_api_card_url)` with
  the app.loopcom.net default) and returns to the step loop with empty digits — the api already
  knows the outcome. An api restart between the door and the charge loses the vault entry → the
  caller keys the card again (never a charge on a card we don't hold). The pay-line leg is NOT
  recorded (0 MixMonitor on a real call), so no DTMF lands in a recording.
- Prompts `39–47` cut (Polly Stephen/neural) + installed (`en-male` 67 → **76**); conf spliced on
  the PBX (`.bak.paycard.20260917T221133Z`, reload clean, `AGI(` present, still 0 Originate/Dial,
  2 CURL steps). Inert until the api with the `card` action is deployed.
- **Round 4 — tested / deployed / proven (~22:50Z).** Tests: the supermarket glob → **229/229**
  (`payLineCard` 19 NEW incl. a 500-session stress and a secrecy sweep over door responses, step
  results, persisted rows, every log call and the register's own 400 body; the wiring guard pins
  that the raw keyed card is used only at its four sanctioned call sites). Deployed **`d2bf48ee`**,
  then **`f238b0bf`** — ⛔ the first deploy proved a miss live: the card door was not on the JWT
  public-route bypass (`jwtPublicRouteBypass.ts` allowlists `/step` by exact path), so the AGI's
  POST answered **401 with the correct secret**; 401 = the handler was never reached, and the
  route-level test registers routes without the JWT hook so it could not see it. Fixed + pinned by
  `supermarketWiring.test.ts`. **Live proof after the fix** (`/root/payline-live-proof5.sh`): wrong
  secret → 403; no session → `no_session`; bad Luhn → `invalid`, session unchanged; a valid test
  card → `ok:true`, vaulted, ignored outside card entry, no digits in the session row, 0 occurrences
  in the api log. `pbx:/root/agi-harness.py` drove the INSTALLED AGI through a fake AGI pipe: GET
  DATA ×5 (one `45_card_invalid` replay for month 13), one HTTPS POST to the live door,
  `PAY_CARD=fail` for the unknown call id, 0 occurrences of the test number in the PBX full log.
  ⏳ **NOT proven: a real keyed charge.** The inline-`card` shape on `/charges` is inferred from
  the add-card validator (the two share field names); the first real one-time payment proves it —
  if the register answers 400 naming a field, the api logs that field name (never the number) as
  "keyed-card charge refused". Acceptance (Izzy): call, reach an account with the PIN, press 2 to
  pay, key an amount, press 3 at the confirm prompt (or press 1 at "no card on file"), key a real
  card / MMYY / CVV / ZIP, press 1 (this payment only) — hear "approved" and the new balance; a
  second call pressing 2 (save it) should then show the card in the account's cards list.

## Round 5 (~23:20Z) — CHOOSE THE CARD BEFORE CHARGING; a decline offers the other cards or a new one

Izzy's real call on round 4: the line charged the card on file straight away ("your card on file
was declined") and the decline fell into the OLD "enter a different amount" branch — no card
option. His spec: *"If there are multiple cards … name me the last 4 digits of each card … press 1
to use the card ending in 6666, press 2 … If a card was declined, ask, do you want to use a
different card on file or enter a card number? … Before [charging] ask, do you want to use the
card on file, or put in a new card? If they put in a new card, ask if … default or one-time."*

- **Built:** confirm is back to `07_confirm_choice`; "1" → silent `list_cards` (the register's
  `/cards`, mapped by `cardsOnFile()` to id + last four, ≤4) → **`card_choice`**: "`48_to_use_card_ending`
  9 6 0 3 `49_press` 1 … `50_new_card_press_9`" — pick 1–N charges THAT card id (`performCharge`
  never lists or picks a first card any more); 9 → the AGI card entry; 3 bad keys → person. No card
  on file → `12_no_card` then card entry. **Declined — on file or keyed — → `11_declined` + the cards
  re-read + the same menu**, amount kept; the amount-attempt cap (3) ends at a person. Keyed card →
  `46_card_save_choice` (this payment only / save it as the card on file) unchanged. `39`/`40`/`47`
  and the `card_offer` phase are retired (WAVs stay).
- Prompts 48/49/50 cut + installed (`en-male` 76 → **79**). No dialplan change.
- **Round 5 — tested / deployed / proven (~00:20Z 09-18):** the supermarket glob → **238/238**
  (`payLineCard` 22: a 500-session stress over {0,1,2,4 cards} × {pick ok / declined then other / 9
  new once / 9 new save} asserts the charged id is ALWAYS the picked one; `supermarketCore` 43;
  ⛔ STRESS 4's seeded balance was 1 cent over `PAY_MAX_CENTS` — a latent test-data bug, fixed).
  **api `af23a052` deployed direct**, container `.build-commit` = af23a052, healthy, `/ready` 200,
  `50_new_card_press_9` + `cardsOnFile` in the container. Live regression: the final-flow proof
  (`proof4`) and the card-door proof (`proof5`) both unchanged and green on the deployed container.
  ⏳ **NOT proven: a real pick-a-card charge and a real keyed charge** (both need a caller with an
  account PIN and a card). Acceptance (Izzy): reach the account with the PIN, press 2, key an amount,
  press 1 to confirm → hear "to use the card ending in … press 1 … to enter a new card press 9";
  press 1 → "approved" + balance, or "declined" + the same menu; press 9 → key a card, MMYY, CVV,
  ZIP → "this payment only press 1 / save it press 2" → "approved".

## What the store must do

- Set a POS PIN for every customer who should pay by phone, and tell them the PIN — the line
  asks for it on every call. Accounts without one hear the "visit the store" sentence.
- Izzy's test accounts: 1001021 (cell) has no POS PIN and no card; 3762 (3064 line) has a PIN
  and a Visa — key that PIN and it pays.
