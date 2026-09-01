# AGENT HANDOFF — the support loop closes BOTH ways now (2026-09-01)

Commits `58ed5a24` (the build) + `28ec7d47` (installer fixes) on
`feat/ivr-migration-takeover`. Deploy state is recorded in CLAUDE.md's support
sections — verify the containers before believing this file's deploy claims.

Izzy's mandate, verbatim shape: *"in the visibility screen, can I see more
detail, like what the agent is working on… Can the agent send points and
updates? Also, I should be able to open any ticket and message back to the
customer. I tried it before, and it didn't work… we should get a pop-up
notification right next to the widget… Yep, fix everything you mentioned. Do
it. This needs to work end-to-end and sustainably."*

## 0. What the audit that morning established (all verified live)

- The watcher died at **20:25 Aug 31 to a Ctrl+C in its console** (the `^C` is
  literally the last bytes of `logs/watcher.log`) — the wrapper dies with its
  console, the logon task reads "Ready" and refires only at logon. Dead 18h,
  3 tickets stranded, **no alarm anywhere** because `status.mjs` is the alarm
  and nothing runs it.
- The live view (Agent runs tab, `727a4d18`) **already existed and was
  deployed the same morning** — an earlier claim of "no screen exists" was
  wrong; the grep had searched for `SupportUpdate` and the screen is named
  `SupportAgentRuns` / `agent-runs`. **Search by the feature's routes AND its
  component names before declaring a screen unbuilt.**
- 4 tickets closed the whole loop Aug 31 (delivered → read → verdict); 3 were
  worked before the hand-back shipped and the customer was **never told**; 2
  verdicts were "not fixed" and the route replied *"We've reopened it and
  someone will pick it up"* — **false**: `recordVerdict` only stamped the row.
- The desk's "reply" posted into the assistant CONVERSATION
  (`/admin/support/conversations/:id/message`) which **nothing ever notified
  the customer about** — and Report-a-problem tickets have no conversation at
  all. That is exactly what Izzy hit when "the customer didn't get it".

## 1. SupportMessage — the notified admin↔customer channel

`packages/db` model `SupportMessage` (migration `20260901170000`), routes in
`apps/api/src/support/supportMessageRoutes.ts`:

- `POST /admin/support/escalations/:reference/message` — requireSuper; refuses
  a platform alarm (409, no person on the other end); **mirrors into the
  assistant conversation best-effort** when one exists so an actively-chatting
  customer sees it inline. ⛔ The SupportMessage row is the channel that
  notifies; the mirror may fail silently and loses nothing.
- `GET /admin/support/escalations/:reference/messages` — the thread; **reading
  it marks `from_customer` rows read**, which is what stops the guardrail's
  unread-reply clock.
- `GET /support/messages` — the widget's poll (piggybacked on the existing
  2-minute updates tick — ⛔ never faster; the voicemail-flood lesson).
  Serving stamps `deliveredAt`. ⛔ Explicit field projection: `sentByUserId`,
  `escalationId`, `conversationId` never reach a customer; test-pinned.
- `POST /support/messages/:id/read`, `POST /support/messages/reply` — reply is
  capped `CUSTOMER_REPLIES_PER_DAY` (20) with the phone number in the refusal,
  and a `replyToId` inherits ticket linkage **only when the parent is the
  caller's own row** — a foreign replyToId threads onto nothing (test-pinned).

⛔ **An admin message deliberately does NOT go through the OpenAI rewrite or
the safety gate** — those exist because a model's rewrite cannot be trusted; a
person signing their own words can be. `sentByUserId` is the audit.

Portal:
- **FloatingAssistant** polls `/support/messages`, renders a thread card with
  a reply box in the panel, marks unread ones read when the panel opens, and —
  the ask itself — shows **`.fa-nudge`**, a pop-up beside the bubble
  ("Loopcom support sent you a message — tap to read and reply") whenever an
  unread `to_customer` row exists. The badge counts unanswered updates +
  unread messages.
- **SupportDesk** case view: the composer is ALWAYS present now and posts to
  the new route; both dead-end states ("no chat to reply into" / "take over
  first") are gone; the thread renders with read receipts ("read" / "not read
  yet"). Take-over still exists and still governs whether the assistant keeps
  answering the live chat.
- **SupportAgentRuns**: per-run customer chips (delivered / read / confirmed
  working / still not right / **customer never told** / held), a
  **Needs a person** rail fed by `GET /admin/support/loop-health`, and a
  message composer right in the run detail.

## 2. "No, still not right" goes somewhere now

`apps/api/src/support/customerUpdate.ts`:
- `decideVerdictFollowUp` (pure): first not_fixed → **reinvestigate** (a
  follow-up `AgentEscalation` is created: dispatcher texts Izzy, watcher
  re-works it in the customer lane — it copies the ORIGINAL customer's
  `userName`, which is what the triage classifies on). A not_fixed on a ticket
  that WAS the re-investigation → **needs_person**: the escalation is created
  with the **`[needs a person]` marker**, so Izzy is texted but the watcher
  skips it. **One automatic loop, then a human — the cap is the marker.**
- The follow-up's `report` carries the customer's note AND the previous
  technical report, so the agent starts from evidence.
- ⛔ Fails soft: a failed follow-up never fails the verdict, and the route's
  wording degrades honestly (`followUp: "failed"` → plain "Thanks for telling
  us."). **Every sentence the route sends is now keyed on what actually
  happened** — the old "We've reopened it" sentence is guard-tested gone.
- ⛔ `proposedFix: ""` — the column is REQUIRED, and `null` is a swallowed
  PrismaClientValidationError (see §4).

Watcher (`tools/loopcom-support-mcp/triage.mjs`): `NEEDS_PERSON_MARKER`
tickets → `skip_needs_person`, noted once (⛔ excluded from `startedToday` —
the backfill-skip cap bug shape), and `"support loop guardrail"` joined
`PLATFORM_MONITOR_USERNAMES` as the belt to that brace.

## 3. The server watches the watcher — supportLoopGuardrail

`apps/api/src/support/supportLoopGuardrail.ts`, armed in server.ts beside the
SMS guardrail (`SUPPORT_LOOP_GUARDRAIL_ARMED` boot line, 15-min interval +
5-min boot kick, kill switch `SUPPORT_LOOP_GUARDRAIL_DISABLED=1`, cutover
`2026-09-01T12:00Z` so the pre-existing backlog cannot page).

Five checks, all OUTCOME-side so every PC failure mode looks the same:
watcher heartbeat stale ≥30 min (the beat arrives every ~60s incl. during
runs); escalations >3h old with **no SupportAgentRun at all** (started-but-
failed is a different problem and not this alarm); held updates >30 min;
`from_customer` messages unread >2h; token expiry ≤7 days (its OWN 3-day
de-dupe window — a 6h nag about a monthly chore teaches people to ignore
alarms).

⛔ Escalation-only (never ADMIN_ALERT — muted at the send door), windowed
de-dupe via `contains` (⛔ not startsWith — the summary opens with the
needs-person marker), audit row `support_loop.sweep` on EVERY pass with
`actor` + `hash`, and its own alarms are excluded from the unworked query —
the circularity brace.

## 4. Drive-by: two sibling guardrails could never fire

`smsForwardGuardrail.ts` and `voicemailMailboxGuardrail.ts` both passed
`proposedFix: null` into a **required** column — a PrismaClientValidationError
their own catch swallowed into "could not raise escalation". **Neither alarm
has ever fired live, and neither COULD.** Both now pass `""`; a source guard in
`supportLoopGuardrail.test.ts` fails if `proposedFix: null` returns.
⛔ **The rule: when copying an escalation-create, copy `supportReport.ts`'s
shape (a proven-live creator), never another guardrail's.**

## 5. The watcher survives its console now

- Task action is `wscript.exe //B run-watcher-hidden.vbs` — **no window, so no
  Ctrl+C and nothing to close**. ⛔ The VBS's final `True` (wait) is
  load-bearing: without it the task exits instantly, `MultipleInstances
  IgnoreNew` stops preventing DOUBLE watchers, and Stop-ScheduledTask cannot
  kill the tree. Both bugs were hit live installing it.
- New task **"Loopcom support watcher watchdog"**: `watchdog.mjs` every 10 min
  — heartbeat fresh → exits silently; stale ≥10 min → Stop + Start the watcher
  task, logged to `logs/watchdog.log`. ⛔ 10 min because beats continue DURING
  runs; restarting sooner could kill a healthy investigation.
- ⛔ `install-task.ps1` stays PURE ASCII, and **`[TimeSpan]::MaxValue` as a
  RepetitionDuration is REJECTED by PS 5.1's task XML validator**
  (`P99999999DT23H59M59S`) — the watchdog silently never registers. It is
  `New-TimeSpan -Days 3650` now. The failure printed an error AND the
  installer's own "Installed" line — do not trust that line; check
  `Get-ScheduledTask` shows BOTH tasks.

## 6. One-time cleanup done

K3JG3K, ARH3P6, YACZXD (worked 08-31 pre-hand-back, customer never told) were
re-posted from `reports/` via `postAgentReport` — all three came back
`status: "ready"`, so the rewrite + gate passed and the widget badges them.
9QMRTR (raised before the watcher's first start; the watermark persists) is a
blind-mailbox alarm whose only fix is Izzy adding an address — left surfaced,
not agented.

## 7. Proven / not proven

Proven: 130 api support tests + 47 watcher tests + portal 481/483 (the two
documented pre-existing); **all 10 new source guards replayed against HEAD and
fail there**; typechecks — 0 errors in any touched file (api total 80, all
pre-existing elsewhere; portal 0); one hidden watcher process with the task
showing **Running** and the watchdog registered; the three re-posts accepted
by the LIVE route.

⏳ NOT proven until after deploy (see CLAUDE.md for the current state): the
migration applied; a real admin message popping up beside a real customer's
widget; a real not_fixed spawning a follow-up run; the guardrail's first
audit row; the watchdog reviving a killed watcher (kill the hidden node
process and watch `logs/watchdog.log` within 10 min — that is the acceptance
test for §5).
