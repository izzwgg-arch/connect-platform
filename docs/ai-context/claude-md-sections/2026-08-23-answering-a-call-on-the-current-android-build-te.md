# ⛔⛔ AGENT HANDOFF — answering a call on the CURRENT Android build tears the call down: the warm answer gets 500 ms instead of 4 s (2026-08-23) — READ FIRST for ANY "I answered and it didn't connect" on Android, before touching `MOBILE_SIP_ANSWER_PRECLAIM_WAIT_MS` or `backendClaimed`, and before telling anyone to install the latest APK

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_WARM_ANSWER_DEADLINE_2026-08-23.md`**
(**Read-only investigation — no code change, no deploy, no build, no PBX write, no
data change.** Izzy, 2026-08-23: *"Create a box extension. 102 is on the latest APK.
I tried to call him. He tried to answer. I tried multiple times, and he was not able
to answer the call."*) Memory: [[warm-answer-deadline-regression]].

- ⛔⛔ **IT IS A REGRESSION AND IT IS IN EVERY ANDROID BUILD PUBLISHED SINCE
  2026-08-22 22:18** — `1.0.0+20260823-113754`, `-132318` and `-152650` are all
  descendants of `83a5728c` (verified `git merge-base --is-ancestor`). **The advice
  in the 2026-08-17 section below — "he needs the current APK" — is now the thing
  that breaks him. He installed it at 19:59Z and the next three calls all failed.**
- ⛔⛔ **THE CAUSE IS ONE LINE, AND IT IS NOT THE LINE THAT LOOKS WRONG.**
  `83a5728c` (the client half of the Hanna fix) made the warm answer path claim in
  the background and set **`backendClaimed = true`**. That flag is correct for the
  claim — but ~200 lines further down it is also **the flag that decides whether the
  answer deadline is extended**: `if (!backendClaimed) { … extend(+16 s) … } else
  { answer without extending }`. The warm path now takes the `else`, which is the
  COLD path and is only safe there because the cold path already extended earlier.
  So the warm answer runs on the **pre-claim** deadline.
- ⛔ **Measured against the real constants** (simulation driving the actual
  `createSipAnswerDeadline`): warm path today = deadline **tap + 150 ms**,
  first-attempt cap **500 ms**, **1 attempt**. Before `83a5728c` = tap + 16,000 ms,
  4,000 ms, 3 attempts. `MOBILE_SIP_ANSWER_PRECLAIM_WAIT_MS` is 150 ms on purpose —
  it is a grace window before claiming, **never an answer budget** — and it collapses
  `max(500, min(4000, remaining))` to its 500 ms floor.
- ⛔⛔ **AND ON FAILURE THE APP HANGS THE CALL UP:** `if (!answered) {
  rejectIncomingInvite(); hangup(); endNativeCall(); }`. So a tap now DESTROYS the
  call ~1 s later on any link slower than ~500 ms round trip. His measures
  **303.8 ms** (desk phone on the same tunnel: 236.0 ms) — before the device's own
  createAnswer/ICE work, which must finish before the 200 OK is even sent.
- ⛔⛔ **CALL 2 IS THE PROOF THIS IS A BUDGET BUG, NOT A TRANSPORT BUG: THE ANSWER
  WORKED.** Asterisk bridged it (`PJSIP/T7_102_1-00001b93 answered`,
  `extensionAnsweredAt 20:02:00.982Z`) — and the app, having already declared failure
  at ~500 ms, tore down its own live call 280 ms later. All three blackboxes carry the
  identical fingerprint: **`answerAttempts: 1, pollIterations: 1,
  durationUntilFailureMs: 641 / 745 / 694`**, candidate JsSIP **`status: 5`**
  (STATUS_ANSWERED — still building SDP, 200 OK not yet sent).
- ⛔ **His two most recent SUCCESSFUL answers would both fail on this build:**
  2026-08-19 tap→connected **2,644 ms**; 2026-08-21 **636 ms**. Both over 500 ms.
- ⛔ **The `answered_elsewhere` → `INVITE_CANCELED` race (the Hanna shape) DID fire
  on call 2 and is NOT the cause — check the order.** The call was already dead at
  20:02:01.263/.278 (telephony hangup + DialEnd); the push was only queued at .344 and
  delivered at .439, **176 ms too late**. On calls 1 and 3 no cancel push was sent at
  all (`INVITE_CLAIMED` fan-out logged `afterExclude: 0`). The server race is still
  open and still worth closing — it just did not do this.
- ⛔ **Ruled out with evidence, do not re-investigate:** the telephony requeue (every
  one correctly **skipped**, "extension leg already ringing/live"); the wake-dial
  dialplan (`Dial(${CONTACTS})` at `extensions__60_custom.conf:417` has **no
  timeout**, so the cut-off was the app hanging up — `(1:0/0/0)` is
  `numlines:busy/congestion/nochan`, i.e. a normal clearing from the far end); and the
  app version (`1.0.0+20260823-152650+1787513210`, matching `ship-proof.json`).
- ⛔⛔ **WHY THE GREEN SUITE COULD NOT SEE IT:**
  `apps/mobile/src/sip/answerAttemptBudget.test.ts` builds every deadline from
  `MOBILE_SIP_ANSWER_INITIAL_WAIT_MS` (8 s) — one test is even named *"more than one
  attempt fits in the pre-claim budget"* while constructing it from `INITIAL_WAIT_MS`.
  **`MOBILE_SIP_ANSWER_PRECLAIM_WAIT_MS` appears in NO test in the repo**, and it is the
  only value the warm answer path actually runs on. Any fix must add a test anchored on
  that constant plus a source guard that the warm branch extends before answering.
- ✅ **THE FIX IS ONE LINE** — `answerDeadline.handle.extend(MOBILE_SIP_ANSWER_POST_ACCEPT_EXTRA_MS)`
  on the warm branch before `answerIncomingInvite`. ⛔ **Do NOT "fix" it by reverting
  `backendClaimed = true`** — that flag is what stops the `answered_elsewhere` sweep
  cancelling a call this device is on. Keep the background claim; extend the deadline.
- ✅✅ **FIXED, BUILT, PUBLISHED AND VERIFIED IN THE SHIPPED BYTES (2026-08-23, Izzy's
  go-ahead).** `8c78b2c0` reverts the `83a5728c` block and nothing else — 15 lines of
  code out, none in. Fleet APK **`1.0.0+20260823-175041`** (63,419,846 b) is live on
  the download page, smoke-tested 200, and `/api/mobile/android/latest` reports it.
  ⛔⛔ **PROVEN BY OPENING BOTH BUNDLES, NOT BY THE PUBLISH LOG:** the live
  `connectcomms-latest.apk` greps **0** for `background_claim_failed` (the block that
  broke answering) and **1** for `ANSWER_UNACKED_REQUEUE` (the rescue that came back);
  the previously published build greps **1** and **1**. That A/B is the check to repeat.
- ⛔ **The blast radius was TRACED before the edit, per the standing rule** — the two
  other readers of `backendClaimed` (`backendAccept:` telemetry and the
  `rejectIncomingInvite` release) sit on the invite-never-arrived path, reachable only
  when `inviteReady` is false, and the reverted block only fired when it was **true**.
  Net effect: the warm path is byte-identical to the code that ran 2026-06-19 →
  2026-08-22. Only delta vs the broken build is that the background claim is a single
  POST again rather than 3 retries — and that retry demonstrably never won its race.
- ✅ **6 tests, registered as `test:warm-answer`** — the first in this repo anchored on
  `MOBILE_SIP_ANSWER_PRECLAIM_WAIT_MS`. **Proven non-vacuous: the flag guard FAILS
  replayed against the broken tree** via `MOBILE_GUARD_PIPELINE`. Mobile typecheck 0.
- ⏳ **iOS build 57 is IN PROGRESS** (EAS `8a0b65e8-2e30-4b6f-8aa3-ee4eadf62373`,
  `2ce97a7a`). ⛔ On iOS the bug only ever bit when the app was **already open on
  screen** — the cold/lock-screen path sets `earlyColdAcceptSent`, which gated the
  broken block out. Builds 53–56 all carry it for the app-open case.
- ⏳⏳ **STILL NOT PROVEN AND THIS IS THE ONLY THING THAT COUNTS: nobody has answered a
  call on the fixed build.** It is proven as shipped bytes and tests, never as a
  conversation. **Acceptance: Sender installs the new APK, Izzy calls, he taps Answer,
  they talk.** ⛔ Nothing pushes the APK — he must install it himself.
