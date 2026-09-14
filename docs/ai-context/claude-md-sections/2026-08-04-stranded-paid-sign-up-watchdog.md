# AGENT HANDOFF — stranded paid sign-up watchdog (2026-08-04) — READ FIRST for onboarding setup recovery, the progress page, or the admin Retry button

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_ONBOARDING_WATCHDOG_2026-08-04.md`**
(commit `100a5071`, deployed in the round-2 tip `7f3c7970`).

- **A paid sign-up can no longer strand silently.** `setupWatchdog.ts` sweeps
  every 60 s from api boot: paid + not CANCELED + `pbxSetupStatus` in
  {null, queued, building, syncing, inviting, failed} + `updatedAt` older than
  `ONBOARDING_INFLIGHT_STALE_MS` (15 min) → timeline event + re-kick
  (`applyOnboardingNumber` → `runOnboardingSetup`, both idempotent).
- ⛔ **The event timeline IS the retry counter** — `startsWith` on the exported
  `WATCHDOG_RESUME_MESSAGE` prefix. Never reword it (resets every counter);
  deleting a submission's events also resets the counter AND the alert dedupe.
- After **5** fruitless resumes: stop, log "Watchdog gave up", queue ONE
  plain-English `ADMIN_ALERT` EmailJob (adminSignupReport pattern). The
  give-up event is the dedupe — one email per stuck sign-up, ever.
- `GET /onboarding/:token/progress` now reports `failed:true` + a friendly
  "we hit a snag, we're on it" once a paid build is stalled past the window
  (shared `isSetupStalled`) — the infinite spinner is dead. Admin detail page
  gained the "Phone System Setup" card + Retry button (endpoint pre-existed).
- `ONBOARDING_INFLIGHT_STALE_MS` now has FOUR readers (orchestrator resume,
  retry-setup 409 gate, watchdog query, progress stalled-branch) — tune via
  env only.
