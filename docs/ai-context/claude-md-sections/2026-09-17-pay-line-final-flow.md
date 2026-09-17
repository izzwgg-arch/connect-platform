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

## What the store must do

- Set a POS PIN for every customer who should pay by phone, and tell them the PIN — the line
  asks for it on every call. Accounts without one hear the "visit the store" sentence.
- Izzy's test accounts: 1001021 (cell) has no POS PIN and no card; 3762 (3064 line) has a PIN
  and a Visa — key that PIN and it pays.
