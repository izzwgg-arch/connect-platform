# ⛔⛔ AGENT HANDOFF — Hanna "couldn't call Israel": NOTHING blocked her, and `011` is the ONLY international prefix this platform accepts (2026-09-01) — READ FIRST for ANY "international calling is blocked for me" report, before unlocking anything at a carrier, or before trusting a number a phone shows you

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_HANNA_INTERNATIONAL_DIAL_2026-09-01.md`**
(**Read-only investigation — no code, no deploy, no PBX write, no carrier write, and NO
test call placed.**) Memory: [[011-is-the-only-international-prefix]].
Izzy, 2026-09-01: *"She is in the UK. She was trying to call to Israel, dialing 011.
They didn't let her make the call."*

- ⛔⛔ **THE ANSWER: she never sent a complete number, and our side refused nothing.**
  Four attempts on T141 ext 101 between 13:06 and 13:12 EDT, read from
  `/var/log/asterisk/full`: **`97229993371`** (correct digits, **no `011`**) → matched
  no pattern → *"cannot be completed as dialed"*; **`029993371`** (Israeli domestic
  form) → same; then **`01129993371`** twice — `011` present but **the country code
  `972` is missing**. She got each half right once and never both together. The string
  that works is **`011 972 2 999 3371` = `01197229993371`**.
- ⛔ **The two `011` attempts DID leave the building, so "they didn't let her" is
  backwards.** Route 162 matched `_011.`, dialled trunk **72 "0001" (Telocall)** →
  `Hangup Cause: 38, CHANUNAVAIL`, **failed over correctly** to trunk **166 (her own
  VoIP.ms)** → `Hangup Cause: 34, CONGESTION`. Both carriers were handed a number with
  no country code, **so neither refusal says anything about whether international is
  permitted** — do not read cause 38/34 here as a carrier block.
- ✅ **Our configuration was verified healthy, not assumed.** Read-only
  `getSubAccounts`: `344022_Hannaeneh5c` still reads **`lock_international: "0"`,
  `international_route: "1"`** — the 2026-08-23 unlock is intact. And
  `dialplan show 01197229993371@T141_cos-all-post` matches **`_011.` → Outbound Route:
  Hanna eneh5c**. Nothing needs changing on the account.
- ⛔⛔ **THE REAL BUG THIS FOUND, AND IT IS PLATFORM-WIDE: THE MOBILE APP DELETES THE
  `+`.** She is on the **iOS app** (`MobileDevice` IOS / iPhone 14 Pro, last seen
  17:05:54Z — the registration immediately before these calls), and
  `normalizeMobileDialTarget` (`apps/mobile/src/sip/mobileOutboundDial.ts:38`) strips
  `+` along with brackets and spaces. So **`+972 2 999 3371` — the way every phone
  saves a number — arrives as `97229993371`**, which is attempt #1 exactly, and which
  routes nowhere. **Tapping a contact saved in E.164 form cannot place an
  international call**; the customer just hears "cannot be completed as dialed" and
  concludes they are blocked. ⛔ The portal is no better: it KEEPS the `+`
  (`normalizeDialTargetForSip`, `apps/portal/hooks/useSipPhone.ts:481`) and
  **`+97229993371` matches no extension at all.**
- ⛔ **`011` is the ONLY accepted prefix — `+` and `00` both fail**, proven against the
  live dialplan. That matters for a customer sitting in the UK, where `00` is the
  prefix they have used their whole life. **Never tell an overseas user to "dial it
  the normal way".**
- ⏳ **NOT PROVEN, and it is the honest gap: no correctly-formatted international call
  has EVER been placed on this platform.** `asterisk.cdr` over 45 days holds exactly
  **four** `dst LIKE '011%'` rows — Hanna's two calls and their trunk legs, nothing
  from any other tenant, ever. So routing, failover and the carrier unlock are all
  proven, but **whether `01197229993371` actually completes is not.** The acceptance
  test is one real call, watched in the log; it spends money and is a live action, so
  it was deliberately not run.
- ⏳ **Two things need Izzy:** (1) tell Hanna to dial `011 972 2 999 3371` and to save
  the contact as `01197229993371` rather than `+972…`; (2) decide the `+` fix —
  convert a leading `+` to `011` in the client (a mobile build), or add `_+.`/`_00.`
  rewrite patterns on every tenant's route (larger, PBX-wide). ⛔ **Do NOT "fix" this
  by unlocking something at the carrier** — it is already unlocked.
