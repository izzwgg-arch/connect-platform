# AGENT HANDOFF — Onboarding audit round 2: merge, deploy & repo-wide worktree cleanup (2026-08-05)

Session scope: implement the 7 remaining wizard-audit findings, then merge FIVE
parallel sessions' commits into one line, deploy api+portal, and audit/clear
~20 git worktrees. Everything below is DONE and verified unless marked open.

## What is live in production

Deployed tip **`7f3c7970`** on branch `feat/ai-agent` (= `feat/ivr-migration-takeover`
at deploy time). API deploy job `1ba4879a` (blue-green rollout, health check passed,
**container commit verified = 7f3c7970**, migration `20260804090000_onboarding_invoice_unique`
applied — confirmed in the deploy log). Portal deploy `d0cca625` succeeded after it.

The merge contains six pieces, all built on audit round 1 (`a34dc379`):

1. **`cf16ab12` — wizard audit round 2** (this session's own work, all in
   `apps/portal/app/onboarding/[token]/page.tsx`, `onboarding.css`, plus api):
   - Autosave failures visible: 3 retries w/ backoff, red "Not saved" indicator,
     `beforeunload` warning while `unsavedRef` is dirty. A `/save` **409** now
     shows a blocking "already submitted in another tab" screen (finding 7).
   - Payment-step dead-end fixed: `checkoutFired` resets on `pageshow`
     (bfcache restore from the pay page) and whenever `step != 6`; a manual
     "Continue to payment" button always renders under the spinner.
   - Review step shows the money: new **`GET /onboarding/:token/quote`**
     (publicRoutes.ts) prices via the same `quoteOnboarding` code as the
     invoice. Pure derivation lives in **`apps/api/src/onboarding/quoteInput.ts`**
     (pre-submit counts `answers.extensions` rows that have BOTH name+number;
     post-submit counts `requestedExtensions`; SMS same split — the column is
     false until submit stamps it). The wizard passes live `?extensions=&sms=`
     because autosave is debounced 900 ms. Porting customers see the 3–5-day
     temporary-number note on review.
   - **Double-invoice now impossible at the DB**: `BillingInvoice.onboardingSubmissionId`
     UNIQUE column (migration backfills from metadata preferring PAID-then-oldest;
     duplicates keep NULL). `prepareOnboardingCheckout` looks up by the column,
     stamps it on create, catches the P2002 race and re-reads; checkout POST
     client timeout raised to 30 s (the 10 s default + retry was the double-charge).
   - Storage-blocked browsers (Safari "Block All Cookies") no longer die as
     "This onboarding link is not active": every localStorage/sessionStorage
     touch in `apiClient.ts`, `session.ts`, `useAppContext.tsx`,
     `portalPermissionHydration.ts` is guarded.
   - Mobile: extensions table stacks into cards ≤640 px (labels via
     `td[data-label]::before`), ALL wizard inputs 16 px (iOS zoom trap).
2. **`6f5644f2`** — provisioning identities unique per submission
   (`provisioningIdentity.ts`; same-named companies can no longer hijack each
   other's VoIP.ms subaccount / PBX tenant).
3. **`3a099489`** — port-in retry safety, bounded number purchases, provider
   outage handling in `voipMsProvisioning.ts`.
4. **`100a5071`** — `setupWatchdog.ts`: 60 s sweep resumes paid sign-ups whose
   build stalled; admin page shows it.
5. **`32696a85`** — IVR Studio first-run hardening (portal only).
6. **`4fb512ed`** — the api error handler no longer gates on NODE_ENV (the
   container doesn't set it) and never leaks raw internals on 5xx. This was
   RESCUED from an uncommitted edit in a dead worktree.

## Lessons that must not be re-learned

- **Merging parallel sessions: run the tests after EVERY merge.** The identity
  fix (2) and port-in fix (3) auto-merged cleanly but conflicted SEMANTICALLY:
  3's new "guard is exact" test asserted old company-name-only subaccount names.
  Fixed in `110786d4` — the fixture now uses per-submission names
  (`BobsPlumsub1` vs `BobsPlumsub10`) so the substring trap still bites.
  `git merge` succeeding proves nothing.
- **SSH host alias is `connect`, NOT `loopcom`** in `~/.ssh/config` on Izzy's
  machine (`ssh connect` → root@45.14.194.179). Older docs say "ssh loopcom" —
  that hostname does not resolve here.
- Deploy queue (works, verified twice):
  `ssh connect`, token = `DEPLOY_QUEUE_TOKEN` in `/opt/connectcomms/env/.env.platform`,
  `POST http://127.0.0.1:3910/ops/deploy/enqueue` body
  `{"service":"api|portal","branch":"feat/ai-agent"}`, header `x-deploy-queue-token`.
  Poll `GET /ops/deploy/jobs` — terminal status is the string **`success`**
  (not "succeeded"). Deploy api BEFORE portal; api runs `prisma migrate deploy`
  itself when schema/migrations changed. Logs: `/var/log/connect-deploys/<job>.log`.
  The job JSON's `deployed_commit` + the log's "container commit … matches
  target" line are the proof a deploy really shipped.
- The api `server.ts` has ~30 pre-existing tsc errors (Timeout/number, dup
  identifier). They are environmental noise; the container runs tsx. Compare
  error SETS against the base before blaming new code — line numbers shift.

## Worktree cleanup (2026-08-05)

~20 worktrees audited file-by-file and removed. Branches all survive — only
folders were deleted, and only after every dirty file was rescued or proven junk.

- **Rescue branches on GitHub**:
  `rescue/cb-voicemail-apk-worktree` and `rescue/connect2build-apk-worktree` —
  APK-era working trees (~1,100 lines each) that matched NOTHING committed:
  incoming-call/SIP mobile edits, never-committed `IncomingCallUiModule.kt` /
  `IncomingCallUiPackage.kt`, and `patches/expo-av@14.0.7.patch` (absent from
  main). EAS uploads the working tree, so these may be exactly what shipped in
  the June voicemail APKs.
- **⛔ LOCAL-ONLY commit** on `cursor/cloud-agent-1773439170847-tqkex`
  (123 staged files, email-provider era): `docs/ARI_WEBSOCKET_ENABLE.md` and
  `test-ami.py` contain a **hardcoded AMI password** — deliberately NOT pushed.
  Scrub before any push.
- Confirmed junk, deleted uncommitted: `expo_runtime_version` build-stamp
  strings.xml diffs, CRLF-only phantom diffs, a `c2` symlink to the primary repo
  (removed the LINK only).
- Empty handle-locked dir husks remain (0 files each, verified): `/c/c2`,
  `/c/dnd`, `/c/dev/Connect2Build`, `Connect-2-apk-9255c0e`,
  `Connect2-ios-fg-active-fix`, plus 8 shells under `.claude/worktrees/`.
  They clear on reboot; git's worktree registry is already clean.
- Left alone on purpose: the primary checkout's dirty `apps/mobile` files
  (App.tsx / strings.xml / ship-proof.json — live mobile state), the active
  session worktrees (incl. `heuristic-easley` carrying the UNMERGED toll-free/
  vanity feature `73f990a0`), and 3 old stashes (June/July mobile edits).

## Open items

- Toll-free/vanity wizard feature (`73f990a0`, branch `claude/heuristic-easley-d05ffe`)
  was mid-flight in another session — NOT merged, NOT deployed by this session.
- The cursor local-only branch still needs a password scrub before it can be pushed.
- `ContactPicker` modal still has no `KeyboardAvoidingView` (known from the
  Android keyboard handoff; unrelated to this session's scope).
