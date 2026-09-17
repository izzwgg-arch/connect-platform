# ⛔⛔ AGENT HANDOFF — the pay line's CALLER-ID RULE is built: a matched caller keys NO PIN; "PIN required" means the POS has no PIN on that account and NOBODY can be served until the store sets one (2026-09-17) — READ FIRST for "it asked me for a PIN", "it says we don't recognize the number", "the pay line is dummy", or anything touching `SupermarketPhonePin` / `payIvrCore.ts`

Full handoff: **`docs/ai-context/AGENT_HANDOFF_SUPERMARKET_MODE_2026-08-26.md` §16d**.
Prior sections of this story: `2026-09-08-the-gesheft-pay-line-played-the-wrong-voice-and.md`
(the CURLOPT header stacking + the Stephen voice), handoff §16b/§16c.

Izzy, 2026-09-17: *"Payment system is still not working properly the way we set it up …
When somebody calls in, it should just match the phone caller ID to the account. If they
want to enter a different account, they need to have a PIN. That wasn't working last time.
Right now, it's kind of dummy … Stress test the fuck out of it to prove that it's working."*

## What was actually wrong (measured, not inferred)

- ⛔⛔ **The register (POS with Logic) has TWO different PIN refusals, and the old code
  treated both as "wrong PIN — try again".** Proven by read-only balance probes from
  inside `app-api-1` with the real key:
  - `401 {"error":"Customer PIN required."}` → **the account has NO PIN set in Gesheft's
    POS.** Every value AND no value is refused identically. No amount of keying can ever
    pass — only the store can set a PIN, and there is **no API to set or read one**
    (`/customers/id/{id}/pin` → 404; the printed docs' "Customer PIN" section is still
    missing).
  - `401 {"error":"Invalid customer PIN."}` → the account HAS a PIN and ours was wrong.
- **Both numbers Izzy has been calling from are no-PIN accounts:** his cell 562-209-6644 →
  `1001021 IZZY WEIN` and 845-238-0884 → `4322 Y. HORWITZ`. Today's 12:01 ET call from
  4322 keyed three PINs, got "Customer PIN required." three times, hit the cap and landed
  on a person. Every PIN anyone has ever keyed on this line went to a no-PIN account.
  `SupermarketPhonePin` still has **0 rows** — nothing was ever enrollable.
- **Coverage (mirror of 13,836 register customers + 40 live probes):** 979 (7%) have a card
  on file; 326 are on-account, 168 of those with a card. Random accounts: 4/25 have a PIN.
  **On-account accounts: 12/15 have a PIN** — the population that pays by phone is mostly
  PIN-ready. Neither of Izzy's test accounts has a card either (`customerCreditCards: []`),
  so even a served call from them would end at `12_no_card`.

## What is built (api `payIvrCore.ts` / `payIvrRuntime.ts` / `posWithLogic.ts`)

- **Caller-ID match → the caller is never asked for a PIN by our choice.** With an enrolled
  PIN: silent verify, straight to `22_main_menu`. With none: a silent one-credit **probe**
  (`PAY_PROBE_PIN = "0"`) makes the register say which case applies:
  - served → main menu, nothing keyed;
  - **"PIN required" → `20_connect_person` at once**, session `status: "no_pin"`,
    `state.blockedReason: "pin_not_set"`, a `warn` log line — the desk can see WHY;
  - "invalid" → the store set a PIN Loopcom does not know: `02_pin` **once, ever**
    (the probe is not an attempt), enrolled on success, every later matching call silent.
- **A looked-up (foreign) account keys the PIN every time, is never enrolled, never probed,
  never reads the vault;** a "PIN required" there lands on a person immediately instead of
  three futile tries.
- **Vault is per ACCOUNT** (`findStoredPin` by tenant+posCustomerId, phone kept as
  provenance): a PIN enrolled from the account's first number serves a call from its
  second number. Stale (invalid/not_set) stored PIN → the account's rows are purged.
- **Caller-ID matching falls back to the mirror** (`resolveCallerAccount`): the register's
  lookup is exact on the record's phone; `PosCustomer.phonesText` knows every number on the
  record, and answers when the register is down — an outage no longer turns every known
  caller into a stranger.
- `PosApiError.pinReason` + `classifyPinRefusal()` (not_set / invalid / unknown; unknown
  fails toward ASKING). `normalizePayIvrState()` reads pre-09-17 session rows.
- `FakePos` in the test kit now answers exactly like the real register (two messages).
- **Desk PIN management** (routes `GET/PUT/DELETE /supermarket/customers/:id/phone-pin`,
  `POST …/phone-pin/check`; portal Orders desk "Phone PIN" control): a rep verifies a
  customer's POS PIN against the register and enrolls it, so caller-ID calls are silent
  from the first call — the operational path to "no PIN ever" for Gesheft's own customers.
- ⛔ **No PBX change.** The dialplan is unchanged (`connect-supermarket-pay.conf` at the
  09-08 state, headers set once). No new prompt: the no-PIN case reuses `20_connect_person`
  — ElevenLabs is dead (subscription unpaid, 09-16), so no new Stephen line can be cut.

## What the store must do (the part no code can do)

- ⛔ **Set a PIN in the POS for every on-account customer who should pay by phone**, and
  tell the customer. Until an account has a POS PIN, the line hands that caller to a person
  — correctly, and now on the first step. Izzy's own test accounts (1001021, 4322) need a
  POS PIN *and* a card on file before they can prove a payment.
- The two ask-Gesheft/POS-with-Logic items from 08-25 stand: PIN provisioning/read via API,
  or configurable enforcement for trusted caller-ID.

## Verification

- **Deployed 2026-09-17 ~16:45Z, commit `e6875027` on `feat/ivr-migration-takeover`**, direct
  blue/green: portal `direct-portal-20260917T163452Z.log` (`done e6875027`, `phone-pin/check`
  present in `.next` chunks), api `direct-api-…` (`done e6875027`, container greps:
  `resolveCallerAccount` ×2, `PAY_PROBE_PIN` ×4, `phone-pin/check` ×2, `/ready` 200).
- **Tests (all on this commit):** `supermarketCore` + all 25 `supermarketStress` +
  `supermarketWiring` + `payIvrDialplan` + `customerSync` + `customerPhoneMatch` →
  **105/105**; `phonePinRoutes.test.ts` (new) → **11/11**; api typecheck 0 errors in
  supermarket files (4 pre-existing elsewhere), portal typecheck 0. The new heavy pay-line
  suite `payLineStress.test.ts` is recorded in `TESTS_RUN.md`.
- ✅ **LIVE PROOF through the real door against the real register** (`/root/payline-live-proof.sh`
  on loopcom, `127.0.0.1:3001/internal/supermarket/pay-ivr/step` with the real secret, the
  route the PBX posts to; read-only on the register, nobody keyed "2"):
  1. matched 562-209-6644 → `01_welcome, 20_connect_person`, `action: transfer` on the FIRST
     step, session `status no_pin`, `blockedReason pin_not_set`, `pinAttempts 0`;
  2. matched 845-238-0884 (this morning's 3-refusal caller) → identical: a person at once;
  3. foreign 212-555-0100 keys 5622096644 → `02_pin` asked (maxDigits 8), keys a PIN →
     `20_connect_person` (no-PIN account), `callerIdMatched false`, nothing enrolled;
  4. matched 845-783-0728 → `3358`, an account the POS HAS a PIN for → `01_welcome, 02_pin`
     (asked once; the next call after a correct PIN is silent) — not a person.
  `SupermarketPhonePin` count 0 before and after.
- ⏳ **NOT proven by a human yet:** a real call keying a CORRECT POS PIN once and the second
  call going straight to `22_main_menu`, and a real charge — both need an account with a POS
  PIN *and* a card on file (Izzy's test accounts have neither). Acceptance: from a phone on
  a PIN-having on-account customer's record (e.g. 845-783-0728 → 3358, 2 cards), press 0,
  hear Stephen, key the POS PIN once, hear the balance; hang up, call again → no PIN.
