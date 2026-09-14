# ⛔⛔ AGENT HANDOFF — the WhatsApp numbers are "Pending" because the review NEVER STARTED, and the Meta portfolio's legal name is wrong (2026-08-24) — READ FIRST for ANY "Meta/WhatsApp has been pending for days", before telling anyone to wait for Meta, and before clicking Start verification

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_PLATFORM_AUTH_PROGRAM_2026-08-21.md` §7**
(**Read-only investigation in Izzy's real Chrome — no Meta setting changed, no
document uploaded, no verification submitted, no code, no deploy.**)
Memory: [[whatsapp-numbers-pending-business-verification]].

- ⛔⛔ **THE MECHANISM, AND IT INVERTS THE INTUITION — Meta's own words:
  *"Your requested display name becomes eligible for review once your business
  becomes eligible for higher messaging limits."***
  (<https://www.facebook.com/business/help/338047025165344>) So the display-name
  review is **not a queue Meta drains on its own schedule** — it does not ENTER
  the queue until the business qualifies. WhatsApp Manager's Business Status
  panel names the only two paths and reports both unmet: **"Verify your
  business → Get Started"** (never started) and **"Send high-quality messages →
  0 conversations started / 30d"**. **Nothing is being reviewed; waiting cannot
  help.** ⛔ **Never answer this symptom with "give Meta a few more days"** —
  read the Business Status panel and Security Center first (the latter shows
  **"Eligible for verification" + a "Start verification" button**, i.e. never
  submitted).
- **Measured: TWO WABAs, TWO numbers, BOTH Pending, both added 2026-08-16**
  (portfolio **Loopcom**, `business_id 1679921306977288`): **+1 845-723-1213**
  (`loopcom`, WABA 1349133117379462) requested 1:11 PM ET, and **+1 845-557-7768**
  (`Connect comunications`, WABA 1437420911538490) requested 11:37 AM ET. Each
  activity log reads `Added` → `Updated Business Profile` → **`Name verification
  requested`** inside one minute. **8 days, zero movement**, 0 messages sent.
- ⛔ **BOTH ARE LIVE PRODUCTION SMS SENDERS** — (845) 723-1213 is the billing /
  pay-link / 2FA / compliance sender and (845) 557-7768 is the agent-escalation
  number, the Loopcom Direct verification sender and the admin shared SMS inbox.
  WhatsApp registration does not remove SMS (separate transports), but **never
  delete and re-add these numbers to "retry" a review.**
- ⛔ **They were NOT waiting on an OTP** — both render the full tab set
  (Insights / Profile / Automations / Message links / Two-step verification /
  Call settings / Call logs), which an unverified number does not get, and the
  Profile tab shows the display name with no "pending review" badge.
- ⛔⛔ **AND SUBMITTING VERIFICATION TODAY WOULD BE REJECTED — the portfolio's
  own details are wrong.** `Settings → Business info` reads **legal business name
  `Connect comunications`** (misspelled, one `m`, and **not the legal entity**,
  which is **`Loopcom LLC`**), **address `United States of America`** with no
  street/city/state/ZIP, **no business phone**, **Primary Page: None**. Meta
  matches documents against the portfolio's **name + address + phone
  character-for-character**. **Fix Business info BEFORE clicking Start
  verification** — a rejected verification is slower to unwind than getting it
  right once.
- ⛔ **This is exactly the systemic risk the platform-auth handoff's §0 flagged.**
  It listed three spellings in circulation (`LoopCom, LLC` USAC, `loopcom llc.`
  FCC FRN, `Loopcom` brand); **the Meta portfolio is a FOURTH, and it is the one
  gating this.**
- ✅ **Nothing is blocked on Loopcom code** (`apps/api` still has no WhatsApp
  transport at all), and ✅ **he is not blocked from building** — Meta: *"You
  don't need to complete a WhatsApp display name review or account checks to get
  started... You can begin sending messages to customers immediately."* Pending
  affects the **name customers see**, not API access.
- **The fix, in order, all Izzy's:** (1) Business info → real legal name, street
  address, phone; (2) Security Center → Start verification with matching
  documents; (3) add a payment method (a standing alert reads *"Missing valid
  payment method"*); (4) ⛔ **expect `Connect comunications` to be DECLINED even
  after verification** — misspelled and unrelated to "Loopcom LLC"; settle the
  customer-facing name first; (5) ⏳ **open question: why two WABAs at all?**
- ⏳ **NOT PROVEN: nothing has been submitted, so no verification outcome exists.**
  Acceptance is the "Verify your business" step turning green, then both numbers
  moving off **Pending** — Meta says that lands 1–2 days after verification
  completes.

- ✅✅ **UPDATE 2026-08-25 — FIXED AND SUBMITTED; the bullets above are now
  HISTORY.** Legal business name corrected to **`Loopcom LLC`**, address to
  **`33 Route 17M, Harriman, New York 10926`**, phone **`+18457231213`**, website
  **`https://loopcom.net/`**, and Izzy entered the EIN himself — ⛔ the agent
  deliberately does NOT type a government-issued tax ID into a form, and the field
  is optional anyway ("used to find potential matching business records").
  **Business verification now reads `In review`.** ⛔⛔ **Documents are
  CONDITIONAL** — the wizard says *"you may need to upload accepted documents …
  **if your business is not found**"*; Meta matches the legal name against official
  records first. ⚠️ **Correction to the advice above:** "get a real website up
  before submitting verification" was over-cautious — BV turns on the documents and
  the record match, not the website. ✅ The Meta app **`Loopcom` (`1027780856754202`)**
  already exists with the WhatsApp use case customised, Facebook Login for Business
  present and a **"Become a Tech Provider"** card — but is still **Unpublished**.
  ⛔⛔ **The long pole for the partnership is a BUILD, not paperwork: App Review
  needs ≥1 successful API call per permission in the 30 days before submitting, and
  `apps/api` has no WhatsApp transport at all.**
