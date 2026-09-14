# ⛔ AGENT HANDOFF — onboarding E2E payment proof, journey tracking, auto-ban fix (2026-08-04→05) — READ FIRST for the sign-up wizard, public pay page, sign-up report emails, "link stopped working" reports, or ElevenLabs Make One

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_ONBOARDING_E2E_PAYMENT_2026-08-04.md`**

- **The whole paid path is PROVEN with a real card** ($33: declined → retried →
  approved → build → wiped). Five dead-code bugs were stacked behind the
  never-reachable checkout; ⛔ the recurring lesson is **never invent an
  event/enum value — grep the Prisma enum first** (an invalid
  OnboardingEventType silently ate the paid-marker: money taken, build never
  started). Declined cards are retryable forever (`allowRetry: true` in the
  public pay route); APPROVED still replays, PENDING still 409s.
- **First extension = Owner → TENANT_ADMIN** (movable radio in the wizard,
  owner must have an email). Before this, fresh accounts had NO admin at all.
- **Every sign-up emails tod10950**: on first link-open and on finish/failure
  (plain-English report with a play-by-play). Journey beacons record steps,
  time-per-step, exact stuck-messages, searches, card declines
  (`journeyTracking.ts`, `adminSignupReport.ts`, `POST /onboarding/:token/track`).
- ⛔ **Sign-up links NEVER expire** — "the link stopped working" = check the
  nginx auto-ban FIRST (`monitor.sh` bans 60 min on >30×401/5min; a signed-out
  portal tab used to 401 every 2.5s and self-ban customers — fixed `cdb88fdf`
  via `hasBrowserAuthToken()` gate + backoff). Matamim's office IP is
  allowlisted; customer links: `9lHaW…` unused, `Ic6…` = Matamim mid-wizard
  (porting a Verizon number).
- ElevenLabs Make One: /status now carries the voice list (one round-trip) and
  **preview audio is reused on save** (10-min cache — no second synthesis, half
  the character spend). AuthGate keeps query strings on login redirect —
  dropping `?firstrun=1` had made the IVR walkthrough unreachable.
- Resume works (currentStep is a STRING column — `Number()` it), /progress
  self-heals paid-but-unmarked submissions, the E911 address + `language` are
  no longer stripped by the submit schema.
