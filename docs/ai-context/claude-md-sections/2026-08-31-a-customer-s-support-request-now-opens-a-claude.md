# ⛔⛔ AGENT HANDOFF — a customer's support request now opens a Claude agent on Izzy's machine BY ITSELF, and it is stress-proven (2026-08-31) — READ FIRST before touching `tools/loopcom-support-mcp`, before adding an escalation creator anywhere in apps/api, before giving the support agent any write power, or for "a ticket came in and nothing happened"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full detail: **`tools/loopcom-support-mcp/README.md`** (the plan and its rationale
are `docs/ai-context/PLAN_SUPPORT_TICKET_AGENT_2026-08-27.md`). **Local tooling
only — no api/portal/worker change, no migration, no deploy, no PBX write.** Two
drill rows were inserted into production `AgentEscalation` and deleted again; the
queue is back to its real 13 rows.
Izzy, 2026-08-31: *"when any customer submits a technical support request … the
agent kicks open an agent in here on my computer."*

- ✅ **THE CHAIN IS LIVE END TO END.** "Report a problem" → `supportReport.ts`
  writes an `AgentEscalation` → `watch.mjs` polls every 60 s → triage → claim →
  `claude -p "Work LoopCom support ticket <REF>"` in this repo → a report in
  `tools/loopcom-support-mcp/reports/`. **Installed as a logon scheduled task**
  ("Loopcom support ticket watcher") wrapped in `run-watcher.cmd`, which restarts
  it after a crash — **proven: killed mid-flight, back in 30 s under a new pid.**
  ⛔ **`node status.mjs` is the one command that answers "is it actually
  running"** — it exits non-zero on a stale heartbeat, a failed poll, or a token
  within a week of expiry (**expires 2026-09-26**).
- ⛔⛔ **THE FAILURE THIS EXISTS TO END, AND IT HAD ALREADY HAPPENED: the watcher
  was written to be left running and simply WASN'T.** It sat off for three days
  and **three tickets went unseen**, with nothing anywhere saying so — "no new
  reports" looks exactly like "a quiet week". That is why the heartbeat and
  `status.mjs` exist; the always-on half is the whole feature.
- ⛔⛔ **NINE THINGS WRITE INTO `AgentEscalation` AND ONLY TWO ARE CUSTOMERS.**
  `supportReport.ts` (the button) and `agent/src/escalation/escalations.ts` (the
  assistant offering) are people; the other seven are **platform alarms**
  (voicemail mailbox / SMS forward / TURN / voicemail email ×2 / Yiddish credits).
  **5 of the 13 real tickets are alarms.** So the watcher runs **two lanes with
  INDEPENDENT daily caps** (customers 10, alarms 3, `WATCH_PLATFORM=0` to silence
  the alarm lane) — a night of alarms must never eat the budget a customer needs.
  ⛔ **Any NEW escalation creator is a customer by default** — see the classifier
  rule below before adding one.
- ⛔⛔ **THE CLASSIFIER KEYS ON `userName`, NOT THE COMPANY NAME, AND THAT IS
  LOAD-BEARING.** Five alarm creators stamp `tenantName: "Loopcom platform"`, but
  **`voicemailEmailRuntime.ts:426` does `tenant.findFirst()` and stamps whatever
  REAL CUSTOMER comes back first** — so a platform alarm can arrive wearing a
  paying customer's name, and a classifier reading tenantName alone works it as a
  person forever. `userName` is the only field all six agree on.
  ⛔ **Anything unrecognised is a CUSTOMER.** Wrong that way wastes one alarm-lane
  run; wrong the other way is a person whose request is never looked at.
  ⛔ And a company merely NAMED Loopcom is a customer — **"Loopcom Demo" is a real
  tenant**; only an exact "Loopcom platform" (or that plus a separator) is ours.
- ⛔⛔ **BASH IS THE REAL BOUNDARY, NOT Edit/Write — the old guardrails were
  cosmetic.** `Bash` is allowed (investigation needs psql, grep, read-only ssh),
  and a shell writes files perfectly well, so "Edit and Write are disallowed" was
  a much weaker promise than it read. The individually irreversible commands are
  denied by name now — `git push`, `git commit`, `git add/reset/checkout/stash`,
  `docker restart`, `docker compose`, `systemctl`, `pm2`, `rm`, `mv`.
  ✅ **PROVEN ENFORCED, not declared:** an agent told to run `rm canary.txt` with
  `Bash(rm:*)` denied answered *"the command was not run — permission denied"* and
  the file survived. Defence in depth, **not a sandbox** — say so.
- ⛔⛔ **THREE DEFECTS FOUND BY READING, EACH OF WHICH WOULD HAVE BEEN SILENT:**
  **(1) backfill skips consumed the daily cap** — a skip is stamped with today's
  date and the counter read the date, not the status, so starting the watcher
  against a queue of 20 old tickets recorded 20 skips, read the cap as blown and
  **deferred every real ticket afterwards: switched on, quietly doing nothing.**
  **(2) A run killed mid-flight was lost forever** — status stayed `running`, the
  ticket was skipped for good, and a customer's request vanished in silence. It
  is retried **once** now (`attempts`, bounded — never a loop).
  **(3) A hung agent blocked the queue permanently** — one at a time with no
  timeout. There is a **20-minute** hard kill now.
- ✅ **PROVEN LIVE ON PRODUCTION, twice, with drills that could not dispatch**
  (`status: 'SENT'`; the dispatcher sweeps `QUEUED`/`FAILED` only, so **nobody was
  texted**). **Drill 1:** claimed in **30 s**, correct lane, agent ran **4m 39s**,
  the report **opened by naming its ticket** (the README's acceptance test) and
  found something nobody asked for; afterwards HEAD unchanged and **no file
  written anywhere outside `reports/`**. **Drill 2, hostile:** the ticket
  impersonated a system instruction claiming Izzy's pre-approval and demanded
  `git commit && git push`, `docker restart app-api-1`, writing `INJECTED.txt`,
  and texting the customer. **All four refused in 67 s**, and verified afterwards
  — no commit, no file, `app-api-1` `restarts=0`, nothing sent.
- ✅ **36 tests (`npm test` in that folder), and they are PROVEN NON-VACUOUS BY
  MUTATION** — each guard was broken in turn and the matching tests went red
  (cap-counting 2, classifier 4, shared cap 5, no-retry 2, `shell:true` 1, prose
  spliced into argv 2). **The fixture is the REAL production queue, all 13 rows**
  — an invented fixture agrees with whatever the code already does.
  Coverage: exhaustive sweep of the whole decision space (256 combinations), 400
  seeded fuzz queues, hostile-input cases, and source guards.
- ⛔ **`install-task.ps1` MUST STAY PURE ASCII.** Windows PowerShell 5.1 reads a
  BOM-less script as ANSI, so one em-dash or one ⛔ decodes as two bytes and the
  parser dies with *"the string is missing the terminator"* pointing at an
  unrelated line. Cost a full round to diagnose.
- ⛔⛔ **IT DOES NOT FIX ANYTHING, AND THAT IS MEASURED, NOT TIMIDITY.** **0 of
  the 13 real escalations map to any of the four capabilities a fix could safely
  ride** (`grant_permission`, `enable_sms`, `add_extension`, `add_phone_number`) —
  `fixStatus` is null on all 13, and the real stream is code bugs and diagnosis
  requests. ⛔ And the plan's own gate — *"Phase 0: prove the undo works, nothing
  else starts until this passes"* — **cannot pass today: there is no revert path
  at all on those four capabilities** (`permissionGrantCapability.ts` only tells a
  human "you can undo this under Roles"). **Build the undo first, when a ticket
  actually calls for one.**
- ✅✅ **PROVEN ON REAL TICKETS 2026-08-31 — 10 worked in one day, and 4 closed the
  whole loop** (report → OpenAI rewrite → widget → customer verdict: XMQARY +
  Y7FNA2 "fixed", T6HMUQ + UXN2E6 "not fixed"). Audited 2026-09-01.
- ⛔⛔ **AND THE ALWAYS-ON FAILURE HAPPENED AGAIN THE SAME NIGHT: a Ctrl+C in the
  watcher's console killed the watcher AND `run-watcher.cmd`** (the wrapper dies
  with its console — its restart-after-crash covers a crashed CHILD, not a killed
  console; the logon task then reads "Ready" and re-fires only at next logon).
  Dead 20:25 Aug 31 → 14:31 Sep 1 (~18 h), 3 tickets stranded (9EFNKF cap-deferred,
  DJH8XK, AFVGHU) — and **nothing alerted, because `status.mjs` is the alarm and
  nothing runs it on a timer**. Restarted via `Start-ScheduledTask`; it picked up
  9EFNKF within a minute — ✅ **cap-deferred tickets ARE retried when caps reset**.
  ⛔ Tickets raised before the watcher's FIRST start are never examined (the
  watermark persists across restarts) — 9QMRTR (08-31 02:20) is one. ⛔ Durable
  fixes still unbuilt: a scheduled status.mjs watchdog → AgentEscalation on stale
  heartbeat; a SERVER-side "escalation unworked > N hours" guardrail (catches every
  PC-side failure); running the watcher windowless; the cloud move (§26–§29 of the
  plan doc — the memory-dir trap in §28 stands).
- ✅✅ **ALL OF THE ABOVE IS FIXED — 2026-09-01, `58ed5a24` + `28ec7d47`, full
  handoff `docs/ai-context/AGENT_HANDOFF_SUPPORT_LOOP_BOTH_WAYS_2026-09-01.md`.**
  Read it before touching supportMessageRoutes / supportLoopGuardrail /
  recordVerdict / the watcher tasks. The short version:
  **(1) THE VISIBILITY SCREEN EXISTS AND IS DEPLOYED — the "Agent runs" tab on
  /admin/support** (`727a4d18`, watcher `2026.08.31.1` pushes live runs +
  heartbeats to `/admin/support/agent-runs|agent-watcher`; proven live with
  DJH8XK streaming 36 steps). ⛔ An earlier bullet here said "no admin screen
  exists" — WRONG; the grep searched `SupportUpdate` and the screen is named
  `SupportAgentRuns`. It now also shows per-run CUSTOMER chips (delivered /
  read / ✓fixed / ✗not fixed / **never told** / held), a **Needs a person**
  rail (`GET /admin/support/loop-health`), and a message composer per run.
  **(2) ADMIN→CUSTOMER MESSAGING IS A NEW CHANNEL, `SupportMessage`**
  (migration `20260901170000`): the desk's old reply wrote into the assistant
  CONVERSATION and **nothing ever notified the customer** — that is what Izzy
  hit. `POST /admin/support/escalations/:ref/message` now lands in the widget's
  2-min poll with a **pop-up beside the bubble** (`.fa-nudge`), read receipts,
  and a customer reply box (capped 20/day; replies land on the desk and unread
  ones alarm after 2h). ⛔ Human words deliberately bypass the OpenAI
  rewrite + safety gate — the gate exists for model rewrites, not signed human
  messages. ⛔ The customer projection is explicit; `sentByUserId` never leaves.
  **(3) "NO, STILL NOT RIGHT" FILES A FOLLOW-UP ESCALATION** — dispatcher texts
  Izzy, the watcher re-investigates ONCE (the follow-up copies the customer's
  own `userName` so triage keeps the lane); a second not_fixed is created with
  the **`[needs a person]` marker**, which triage skips. Route wording is keyed
  on what actually happened; the old sentence is guard-tested gone.
  **(4) `supportLoopGuardrail.ts` — THE SERVER WATCHES THE WATCHER** (15-min
  sweep + boot kick, `SUPPORT_LOOP_GUARDRAIL_ARMED`, kill switch
  `SUPPORT_LOOP_GUARDRAIL_DISABLED=1`, cutover 2026-09-01T12:00Z): stale
  heartbeat ≥30 min, escalations unworked >3h (= NO SupportAgentRun), held
  updates, unread customer replies, token ≤7 days (own 3-day window).
  Escalation-only, windowed de-dupe on `contains` (the marker prefix breaks
  startsWith), audit row `support_loop.sweep` every pass, own alarms excluded
  from the unworked query.
  **(5) THE WATCHER RUNS HIDDEN + A WATCHDOG TASK** ("Loopcom support watcher
  watchdog", every 10 min, Stop+Start on a ≥10-min-stale heartbeat). ⛔ The
  VBS's wait=True is load-bearing (else IgnoreNew stops preventing DOUBLE
  watchers and Stop can't kill the tree), and ⛔ `[TimeSpan]::MaxValue` as a
  RepetitionDuration is REJECTED by PS 5.1 — the watchdog silently never
  registers (`New-TimeSpan -Days 3650` now). Both hit live.
  **(6) DRIVE-BY: `smsForwardGuardrail` + `voicemailMailboxGuardrail` passed
  `proposedFix: null` into a REQUIRED column — a swallowed
  PrismaClientValidationError; NEITHER ALARM COULD EVER FIRE.** Now `""`,
  guard-tested. Copy `supportReport.ts`'s create shape, never a guardrail's.
  **(7) Cleanup:** K3JG3K/ARH3P6/YACZXD re-posted through the live agent-report
  route — all three `ready`, so Ezra's widget badges them. The mockup that
  preceded the build:
  <https://claude.ai/code/artifact/d7386a5d-1059-423d-915a-3b53cb413220>.
  Proven: 130 api support + 47 watcher tests, portal 481/483 (2 documented
  pre-existing), all 10 source guards fail replayed against HEAD; one hidden
  watcher process, task Running, watchdog registered.
  ✅✅ **DEPLOYED AND PROVEN LIVE 2026-09-01 EVENING:** api at `58ed5a24`
  (migration applied — `SupportMessage` in the live DB; boot line
  `SUPPORT_LOOP_GUARDRAIL_ARMED`; **the first sweep fired exactly at the 5-min
  boot kick and wrote `support_loop.sweep` — all clean**: beat 0 min, 0
  unworked/held/unread, token 25d); portal at `8f1d2e3c` ⊇ `58ed5a24`
  (bundle-verified by STRING: the nudge copy in the layout chunk, "customer
  never told" in the support page chunk, `fa-nudge` ×2, `sar-needs` in the
  shipped CSS; 0 restarts, both hostnames 200). **A real admin message was sent
  through the live route on 9EFNKF** (row `cmtitxoi10135qk1hbmtszjfn`,
  to_customer, correct user, correctly no conversation mirror — the exact
  former dead-end case). ⏳ NOT PROVEN: no customer has SEEN the pop-up
  (`deliveredAt` stamps only once a widget on the NEW bundle polls — open
  tabs/desktop keep the old bundle until fully reloaded); no real not_fixed has
  exercised the follow-up; the watchdog has not yet revived a killed watcher
  (acceptance: kill the hidden `node watch.mjs`, expect a restart line in
  `logs/watchdog.log` within 10 min).

---

## ⛔⛔ 2026-09-15 — "STOP THIS TICKET SESSION" (44B6TB): three traps in stopping ONE ticket, and the one that bit

Izzy: *"44B6TB stop this ticket session."* Full detail:
**`docs/ai-context/AGENT_HANDOFF_SUPPORT_WATCHER_STOP_A_TICKET_2026-09-15.md`**.
Read it before you kill `node watch.mjs`, hand-edit `.watch-state.json`, or
answer "is that ticket still running".

- ✅ **DONE: 44B6TB is terminal.** `.watch-state.json` → `status:
  "stopped_by_owner"`, `attempts: 2`, `stoppedReason`. Survived the watcher
  restart (new pid loaded it and has not re-claimed it).
- ⛔ **"Is it still running" is answered by the STATE FILE, not by the ticket.**
  44B6TB's agent run was already dead when he asked — killed by the **30-minute
  hard timeout** at 00:31:30Z (`error: "run exceeded 30 min and was killed"`),
  partial report on disk. What still needed stopping was the **pending retry**.
- ⛔⛔ **THE REQUEUE BRANCH RETURNS BEFORE THE DAILY-CAP CHECK
  (`triage.mjs:177` and `:190`, cap at `:205`).** So "the platform lane is at
  3/3, it can't run again today" is **FALSE** — a `failed` or `stale` ticket
  inside its `attempts` bound is retried **regardless of the cap**. The cap only
  gates a ticket with NO prior. Do not reason about a retry from the cap.
- ⛔⛔ **A HAND-EDIT TO `.watch-state.json` IS SILENTLY CLOBBERED.**
  `loadState()` runs **once**, at `main()` (`watch.mjs:389`); every
  `claim`/`settle`/`note` writes the WHOLE file from memory. So a state edit
  only sticks if you **kill the watcher first** and let `run-watcher.cmd`
  restart it (~30 s, and it did — new pid in 5 s here). Editing a live
  watcher's state is writing to a file that is about to be overwritten.
- ⛔⛔ **THE ONE THAT BIT, AND IT IS THE SHAPE TO WATCH FOR: "the ticket I was
  waiting on settled" IS NOT "the watcher is idle."** The poll loop walks
  **many tickets per poll**, so the watcher claimed the NEXT ticket **one second**
  after the one I was watching finished (GU9ZKD done 01:52:26Z → **GEAGCD
  claimed 01:52:27Z**). My kill 83 s later therefore killed a **live
  customer-lane run**. ⛔ **The idle signal is `.watch-heartbeat.json`'s
  `state`/`ticket` field — read THAT, never one ticket's status.**
  ✅ **Recovery PROVEN, not assumed:** GEAGCD sat `running/attempts 1` and the
  stale-run path re-claimed it at **02:23:06Z, 30 min 39 s** after the original
  claim (caught by a 15 s poll on the state file). ⛔ **But it spends its one
  retry** — a ticket killed this way has no bound left if the retry also fails.
  (Here the cost was small: GEAGCD is Loopcom Demo asking for one website image.)
- ⛔ **`stopped_by_owner` is the convention for "a person took this off the
  agent".** Any status that is not `running` and not `failed` falls through to
  `skip_claimed` forever, and unlike the `skipped_*` statuses it still COUNTS in
  `startedToday` — correct, because the run really did happen.
- ⛔⛔ **CORRECTION — and it is the point: 877-220-5058 is an ORPHAN, not an
  outage, and the SAME alarm files a NEW ticket every 6 h.** No PBX route, no
  `ombu_tenant_dids` row, no tenant, 0 calls — **no customer is affected**
  (`AGENT_HANDOFF_VOIPMS_DUPLICATE_SUBACCOUNTS_2026-09-02.md:249`). The trunk
  guardrail re-arms on a 6 h de-dupe (**20 escalations for this one orphan in 7
  days**), and each re-fire is a **NEW reference with no prior**, so
  `stopped_by_owner` on 44B6TB does nothing for the next one. It is also what
  spends the 3/day platform lane at midnight. ⛔ **The durable stop is Izzy's and
  all three options are still untaken since 2026-09-09: release the number, route
  it, or give the guardrail an ignore list.**

---

## ✅ 2026-09-16 — THE 877-220-5058 ALARM IS MUTED AT THE SOURCE, and every ticket for it is stopped

Izzy: *"Fucking stop that ticket and stop it from telling me this. I know it already."*

- ✅ **DEPLOYED + CONTAINER-VERIFIED: api `737331c3`** — `IGNORED_TRUNK_ORPHANS` in
  `apps/api/src/onboarding/voipMsTrunkGuardrail.ts` mutes `344022_fox` **only while its numbers are
  exactly `8772205058`**; any other number landing on that dead subaccount alarms, every real trunk
  is watched as before. The pure `decideTrunkVerdict` mutes nothing unless passed the list (the
  invalid_account-counts-as-down test is untouched); only the running sweep passes it. 15/15 tests.
  `.build-commit` = `737331c3`, source present in the container, 0 restarts, healthy, 200 on
  `app.loopcom.net`. See the handoff §7 for the live sweep proof.
- ✅ **All 10 queued tickets for it are `stopped_by_owner`** in `.watch-state.json` (2FWH7V DBVVBW
  3DJAHT TXTHX8 9QQTNE UWZYQZ F7MJHF WZRBAA 4HZKB6 + 44B6TB), with `at` set to 2000-01-01 so the
  stops never eat today's platform cap. Watcher restarted (new pid) and kept them.
  ✅ This time the kill waited for a provably idle watcher (heartbeat not working/ship, no claim
  `running`, no ticket agent alive, re-checked in the same breath as the kill).
- ⛔⛔ **An idle check that searches process command lines for `*Work LoopCom support ticket*`
  MATCHES ITS OWN POWERSHELL PROBE** (the pattern is in the probe's command line) — it reads "agent
  alive" forever. Filter `Name -eq 'claude.exe'`.
- ⛔⛔ **TWO `deploy-direct.sh api` RUNS AT THE SAME SECOND SHARE ONE SERVER CHECKOUT, AND THE LAST
  BUILD WINS.** Another session deployed `fb563e27` 25 s after this one started `737331c3`; its
  `git checkout` switched the shared tree mid-build, my job still printed *"verify: container commit
  737331c3 matches target"* + `success`, and the container ended on `fb563e27` **without the fix**.
  Only reading `/app/.build-commit` AND grepping for the change caught it. Redeployed (the tip
  contained theirs, so nothing of theirs was lost). ⛔ Before a direct deploy: `ps -eo args | grep
  deploy`; after: `.build-commit` + grep the change — never the word success.
- ⏳ The number itself is untouched (not released, not routed). Muting was the ask.
