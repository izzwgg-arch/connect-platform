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

- ⏳ **Tests / deploy / live proof: "Round 3 — tested / deployed / proven" at the bottom (filled by the
  docs follow-up commit).**

## What the store must do

- Set a POS PIN for every customer who should pay by phone, and tell them the PIN — the line
  asks for it on every call. Accounts without one hear the "visit the store" sentence.
- Izzy's test accounts: 1001021 (cell) has no POS PIN and no card; 3762 (3064 line) has a PIN
  and a Visa — key that PIN and it pays.
