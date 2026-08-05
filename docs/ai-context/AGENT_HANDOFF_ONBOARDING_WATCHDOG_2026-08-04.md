# AGENT HANDOFF — stranded paid sign-up watchdog + honest progress (2026-08-04)

Engagement: close the audit finding that a PAID onboarding submission stuck in
`pbxSetupStatus` `building`/`syncing`/`inviting` after an api restart never
recovers — nothing re-calls `runOnboardingSetup` (the orchestrator's stale-run
detection at `setupOrchestrator.ts` only fires when something invokes it), the
customer's success page polls "Setting up your phone system" forever, and no
failure report email fires.

Commit: **`100a5071`** (authored on `claude/gracious-agnesi-940029`, based on
`origin/feat/ai-agent` `a34dc379`). Merged into `feat/ai-agent` +
`feat/ivr-migration-takeover` and **DEPLOYED in the round-2 merged tip
`7f3c7970`** (see `AGENT_HANDOFF_ONBOARDING_ROUND2_DEPLOY_2026-08-05.md`).

## 1. The watchdog sweep — `apps/api/src/onboarding/setupWatchdog.ts`

Started at server boot (`server.ts`, next to the invoice-overdue timer):
`sweepStalledOnboardingSetups()` every **60 s**, `registerShutdownTimer` +
`unref`, in-process `sweepRunning` guard (a resumed PBX build can outlive many
intervals — cycles never overlap).

A row is swept when ALL of:
- `paidAt != null` — unpaid rows are never touched; nothing is owed.
- `status != CANCELED`.
- `pbxSetupStatus` ∈ { `null`, `queued`, `building`, `syncing`, `inviting`,
  `failed` } — i.e. anything that isn't `done`/`dry_run_done`. `null` matters:
  paid but the pipeline never started is also a stranding.
- `updatedAt` older than `ONBOARDING_INFLIGHT_STALE_MS` (default **15 min**).
  Any live run bumps `updatedAt` constantly, so "untouched past the window"
  ⇒ no run is alive.

Per swept row: log an `OnboardingEvent` (`STATUS_CHANGED`,
"Watchdog resumed a stalled setup (stuck in "X" for N min) — attempt K of 5"),
then `applyOnboardingNumber` → `runOnboardingSetup`, each `.catch`ed so one
poisoned row never blocks the rest of the sweep. Both calls are idempotent and
resume where they left off. `take: 20` per cycle, oldest first.

### The retry counter IS the event timeline
`priorResumes = count(OnboardingEvent where message startsWith
"Watchdog resumed a stalled setup")`. That's why the counter survives api
restarts and why the admin page shows every attempt for free.

⛔ **Never reword the `WATCHDOG_RESUME_MESSAGE` prefix** (exported constant) —
the count is a `startsWith` match on stored rows. Renaming it resets every
in-flight row's attempt count to zero and restarts the retry storm.

### The 5-resume cap → ONE admin email
At ≥5 prior resumes the row is skipped and escalated instead: a
"Watchdog gave up after 5 automatic resumes" event + ONE plain-English
`ADMIN_ALERT` EmailJob (same channel/pattern as `adminSignupReport.ts`:
tenantId `connect-admin-tenant-v1`, recipient `ADMIN_ALERT_EMAIL` default
tod10950@gmail.com). Dedupe = existence of a "Watchdog gave up…" event, so the
admin is alerted once per stuck sign-up, not once per minute.

⛔ Deleting a submission's events (admin delete does this) resets BOTH the
attempt counter and the alert dedupe — that's acceptable (fresh retries after a
human intervened) but know it's the mechanism.

The pacing is self-limiting without any backoff bookkeeping: each resume bumps
`updatedAt` (status writes inside the orchestrator), so the row leaves the
stale window for another 15 min. ~5 attempts ≈ 75+ min before escalation.

## 2. Honest customer progress — `GET /onboarding/:token/progress`

`isSetupStalled(row)` (exported from setupWatchdog.ts — the shared definition
of "stuck") now drives the public progress endpoint: a paid, unfinished,
un-failed build past the stale window reports `failed: true` with the friendly
"We hit a snag finishing your setup. Our team has been notified and is on it…"
instead of spinning forever. "We're on it" is literally true — the sweep is
already re-kicking it.

A genuine `pbxSetupStatus="failed"` still surfaces `setupError` as before;
the stalled branch only covers the states that used to spin.

## 3. Admin Retry — `apps/portal/app/(platform)/admin/onboarding/[id]/page.tsx`

New "Phone System Setup" card (the page previously rendered NONE of this):
paid (+amount), provisioned number + `numberStatus`, `pbxSetupStatus`,
`setupError`, and a **Retry setup** button →
`POST /admin/onboarding/submissions/:id/retry-setup` (endpoint pre-existed in
`provisioningRoutes.ts`; gate = paid + not-done, 409 `setup_in_progress` only
while a run is genuinely in flight inside the stale window). The detail API
already returned all fields (`readAdminSubmissionDetail` spreads the row) —
this was portal-only.

## 4. Tests — `apps/api/src/onboarding/setupWatchdog.test.ts`

21 tests, same `mock.module` db-mock pattern as `setupOrchestrator.test.ts`,
runner `node --experimental-test-module-mocks --import tsx --test`. Covers:
which rows are swept vs left alone (fresh / unpaid / done / dry_run_done /
CANCELED), per-row error isolation, the 5-cap + single-alert dedupe, the
"attempt 5 of 5" boundary, `ADMIN_ALERT_EMAIL` override, and `isSetupStalled`
across every status × fresh/stale × env-window override. All 106 onboarding
tests green at commit time.

## 5. Traps / invariants

- `ONBOARDING_INFLIGHT_STALE_MS` is now read in FOUR places with the same
  meaning: orchestrator stale-run resume, retry-setup 409 gate, the watchdog
  query, and the public progress "stalled" branch. Change it via env, never by
  editing one call site.
- The sweep intentionally does NOT call `syncOnboardingSms` (the retry endpoint
  does). If an SMS-sync-only stranding ever shows up, add it there too — it's
  idempotent.
- server.ts pre-existing type noise: `registerShutdownTimer(setInterval(...))`
  trips the repo-wide `number` vs `Timeout` tsc complaint (72 baseline errors;
  the watchdog timer adds the same class). Not a code bug; every neighboring
  timer has it.
- ⛔ Worktree trap (cost this session an hour): fresh `claude/*` worktree
  branches spawn from LOCAL `main`, which is months stale — the whole
  onboarding module "doesn't exist" there. First move in any worktree:
  `git fetch origin && git reset --hard origin/feat/ai-agent` (or the current
  integration branch) before concluding files are missing.
