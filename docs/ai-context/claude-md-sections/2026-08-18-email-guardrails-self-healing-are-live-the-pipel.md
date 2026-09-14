# ⛔⛔ AGENT HANDOFF — email guardrails + self-healing are LIVE (2026-08-18): the pipeline repairs itself, and the alarm has an alarm — READ FIRST before adding ANY email path, before touching the voicemail sweep/watchdog, before muting an escalation, or for "did the guardrails fire?"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Izzy's standing rule (2026-08-18, after the outage below): **"What happened today
could never, ever happen again. Emails cannot stop working ever, especially
voicemail. Put self-healing on this."** Memory: [[emails-must-never-stop-silently]].
Built as **`apps/api/src/voicemail/voicemailEmailGuardrails.ts`** (`9ae26e04` on
`feat/ivr-migration-takeover`; **api DEPLOYED and container-verified
(`9ae26e04bd54`), heartbeats and the coverage baseline (55 of 103) watched
landing on the live container, zero escalations**). No migration, no PBX
write, no env change.
Full detail: `docs/ai-context/AGENT_HANDOFF_VOICEMAIL_EMAIL_DEAD_2026-08-18.md` §7.

- ⛔⛔ **THE SHAPE, and it is the rule for ANY new email path:** a PURE decision
  function with a threshold test → a thin runner against the db → an
  **ESCALATION** when it fires (SMS to (562) 209-6644 + (845) 723-1213 and the
  `AGENT_ESCALATION` email — the ONLY alarm channel that reaches a person;
  ⛔ never `ADMIN_ALERT`, which is muted at the send door and would build clean
  and reach nobody) → **de-duplicated on an open escalation with the same summary
  prefix** (a persistent fault texts once) → **state in `AgentAuditLog`, never a
  module variable** (the api restarts dozens of times a day). ⛔ And a **SOURCE
  guard test proving the guard is actually CALLED** — the old watchdog existed,
  was wired, and had thrown on every run since deploy; a guard nobody calls is the
  failure shape itself.
- ✅ **SELF-HEALING (three repairs, each maps to a fault from the outage):**
  (1) **the watchdog REPAIRS, not just reports** — any voicemail the sweep never
  reached (older than the 10-min grace) is processed BY THE WATCHDOG through its
  own query, same sender, same stamps; a blocked or dead sweep can no longer
  strand anything. (2) **dead voicemail email jobs are re-queued** once the
  outbox has proven it can send again (a SENT job newer than the failure), not
  before an hour, **at most twice per job** (`decideRequeue`, counted in
  `AgentAuditLog voicemail_email.job_requeued`). (3) **the extension sync can no
  longer erase an address**: `preserveBlankedPbxEmail` runs BEFORE the extension
  upsert; a PBX email going value → blank is promoted into
  `VoicemailEmailRecipient` first, so the mirror stays honest and the customer
  keeps getting emailed. Only a human removing it in Settings takes it away.
  The exact 2026-08-17 cutover mechanism is inert.
- ✅ **ALARMS:** **liveness** — the sweep and the watchdog write a heartbeat
  (`voicemail_email.sweep_heartbeat` / `watchdog_heartbeat`) on EVERY completed
  pass including empty ones; a separate 5-min check escalates when a heartbeat
  is stale (**sweep 10 min, watchdog 45 min**, boot grace 20 min so a fresh
  container is not judged before its first tick — but a heartbeat already very
  old from a previous process still counts). **Watchdog failing** — 3 consecutive
  throws escalate the error text. **Recipient coverage** — hourly count of
  ACTIVE non-excluded mailboxes with any address (mirror OR `VoicemailEmailRecipient`);
  a drop of **≥ 3 AND ≥ 20 %** (the cutover shape, 55 → 0) escalates by company;
  one customer removing one address does not. **Outbox health, EVERY email type
  except ADMIN_ALERT** (5-min): a due job unsent for **20 min** = "Email outbox
  is not sending"; **≥ 5 FAILED in an hour** = "Emails are failing to send" with
  the top cause (a Gmail 550 quota burst will name itself).
- ⛔ **`no_recipient` still does not alert on its own** — it is a standing
  condition (5 blind mailboxes today); the coverage DROP is what alerts. Add an
  address in Settings; do not "fix" it by widening the alarm.
- ⛔ **Escalation summary prefixes are the de-dupe keys** (`ALARM_PREFIX`):
  "Voicemail email sweep has stopped", "Voicemail email watchdog has stopped",
  "Voicemail email watchdog is failing", "Voicemail email addresses disappeared",
  "Email outbox is not sending", "Emails are failing to send". **Resolving the
  escalation row (status not QUEUED/SENT) re-arms it.** Renaming a prefix
  orphans the de-dupe.
- ⛔ **Read the heartbeat before diagnosing "did it run":**
  `select event, max(ts) from "AgentAuditLog" where event like 'voicemail_email.%' group by 1`.
  Both heartbeats within their thresholds = the timers are alive; the coverage
  row (`voicemail_email.recipient_coverage`, hourly, `payload.covered`) is the
  count to compare against.
- ✅✅ **A GUARDRAIL HAS NOW FIRED FOR REAL (2026-08-21) — and it caught a defect
  in ITSELF, not in the pipeline. Full detail: handoff §8.** The liveness check
  texted Izzy *"Voicemail email watchdog has stopped — last heartbeat 67 min
  ago"* at 12:09:38Z. **True, and the email pipeline was perfectly healthy**:
  sweep heartbeat 26 s old with 1,506 in 24 h and not one minute missed, 21
  `VOICEMAIL_NOTIFICATION` jobs SENT / 0 FAILED in 48 h, 0 FAILED of ANY type,
  coverage flat at 55 of 107 `dropped: false`.
  ⛔⛔ **THE CAUSE: the watchdog was armed with a bare `setInterval(15 min)` and
  NO boot run, so every api restart put its clock back to zero.** Five api
  rollouts from other sessions recreated the container **ten times** between
  11:07 and 11:54 (stable + candidate per rollout), longest quiet stretch
  ~12 min — so it never ran once for 67 minutes. The sweep survived the identical
  churn **because it has a 45 s boot kick**; the watchdog was the only timer in
  the file without one (coverage kicks at 3 min, outbox at 2 min, liveness at
  grace + 1 min). ✅ Fixed: `VOICEMAIL_EMAIL_WATCHDOG_BOOT_DELAY_MS = 90_000`,
  a `setTimeout` **beside** the interval (⛔ an addition, never a replacement — a
  source guard asserts both, and it reads 0 against `HEAD`). ⛔ **90 s is
  deliberately AFTER the sweep’s 45 s** so the sweep gets first refusal on fresh
  voicemail and the rescue path stays the exception.
  ⛔⛔ **THE REUSABLE TRICK, worth more than the fix: the recipient-coverage check
  kicks 3 minutes after boot, so every coverage row NOT on the hourly metronome
  marks an api boot 3 minutes earlier.** That is how the ten restarts were
  established — `docker logs` is wiped by each recreation and `docker events`
  had already rolled over. ⛔ **And 186 unstamped voicemails in the 7-day window
  is CORRECT, not a block — all 186 are Gesheft**, the excluded tenant, which is
  never stamped by design; zero non-Gesheft rows were unstamped.
  ⛔ **The lesson: a guard that cries wolf on every busy deploy day is a guard
  people learn to click past, and the next one — the real one — goes with it.**
  ✅✅ **THE BOOT KICK IS PROVEN ON A REAL CONTAINER (2026-08-23) — this closes
  the acceptance test that stood open since 08-21.** `app-api-1` started
  **21:23:55Z** and wrote a `watchdog_heartbeat` at **21:25:49Z — 114 s later**
  (the 90 s kick plus its own run time), then resumed the ordinary 15-minute
  metronome (21:39 / 21:54 / 22:09 / 22:24). Before the fix that first row would
  not have landed for 15 minutes, and on a churny deploy day never at all.
  ⛔ **The 21:24:14Z row one minute earlier is the OUTGOING container during the
  blue/green overlap — do not read it as the kick.** Recipe to re-verify after any
  api deploy: `docker inspect -f '{{.State.StartedAt}}' app-api-1` against
  `select ts from "AgentAuditLog" where event='voicemail_email.watchdog_heartbeat'
  order by ts asc` in that window. ⏳ The other half of the acceptance test — that
  a busy deploy day now raises no "watchdog has stopped" text — still needs a busy
  day to pass; there has been no such text since 08-21.
  ⛔⛔ **AND IT EXPOSED A ONE-SHOT ALARM — NOT FIXED, IZZY’S CALL (handoff §8.6).**
  `raiseGuardrailEscalation` de-dupes on `status in (QUEUED, SENT)` **with no
  time bound**, and `AgentEscalationStatus` has **no RESOLVED value** — a
  delivered alarm ends at SENT and nothing ever moves it. **So each of the six
  alarm keys can fire ONCE, ever.** ⛔ The §7 line "resolving the escalation row
  re-arms it" is true and unreachable — there is no resolve action.
  **1 of 6 keys is now burned** (`Voicemail email watchdog has stopped`, row
  `cmt2wpqlz030jln12zxw1lhpw`); the other five are armed. Not acute — the boot
  kick makes that condition unlikely and the five that watch the email pipeline
  still work — but it is a hole in the net. **Recommended: bound the de-dupe to
  the last ~6 h**, which restores the stated intent ("a persistent fault texts
  once, not every tick") rather than changing policy. ⛔ Deliberately NOT changed
  here: it decides how often Izzy’s phone rings.
  ⏳ Still open from the outage: onboarding writes the email onto the PBX
  extension (new sign-ups get duplicates); and **mailboxes that email nobody**
  — `no_recipient` is deliberately never escalated (a standing condition);
  **the fix is one address each in Settings and it is Izzy’s call, not an
  engineering one.** ✅ **Trimpro 102 was FIXED on 2026-08-20 16:17** —
  `ap@trimprony.com` added to `VoicemailEmailRecipient`, 1 h 34 m after its last
  miss; ⛔ **it is configured but UNEXERCISED — no voicemail has landed on that
  mailbox since**, so it is proven as a row, not as a delivered email.
  ⏳ **Still blind as of 2026-08-23: A plus center 108 "Home" (9 missed
  voicemails in 7 days and GROWING — it was 6 on 08-21) and Trimpro 104
  "Shamshon Wertzberger" (1, on 08-17).** The heartbeat's `gaps` counter now
  reads **13**, up from 10, and ⛔ **that number is a 7-day running total of
  missed voicemails, NOT a count of blind mailboxes** — it climbs on its own
  while an address stays unset, so a rising `gaps` is not a new fault.

- ✅✅ **AUDITED 2026-08-23 (Izzy: "check if any voicemail emails failed to go out
  from Loopcom in the past week") — NOTHING FAILED, and the send door has never
  been the problem.** Read-only, no change made. **64 `VOICEMAIL_NOTIFICATION`
  jobs over 7 days, ALL `SENT`, 0 FAILED, 0 with an `emailError`** — and **0
  failures of ANY email type platform-wide** in the window (the only non-SENT
  rows are the 275 `ADMIN_ALERT`s the deliberate mute SKIPs). 22 distinct
  recipients across 12 companies.
  ⛔⛔ **THE CHECK THAT MATTERS IS NOT `status='FAILED'` — IT IS WHETHER A JOB WAS
  CREATED AT ALL.** The 08-18 outage had a perfect send-door record while nobody
  on the platform received anything for 20 hours. **Judge it from the `Voicemail`
  table** (`emailSkipReason` + unstamped `emailedAt`), never from `EmailJob`
  alone. The 7-day outcome census: 301 emailed/none, 53 `too_short` (0–1 s
  hang-ups), 45 `predates_feature`, 13 `no_recipient`, 3 `no_recording`.
  ⛔ **And check for a SILENT GAP, not just a failure count** — emails landed on
  **every one of the 7 days** (13/17/13/9/8/2/2). The two thin days are Fri–Sat
  (2026-08-22 had **2** non-Gesheft voicemails all day) — **a Shabbos dip on this
  customer base is the expected shape, not an outage.**
  ✅ **237 unstamped voicemails, and ALL 237 are Gesheft** — the excluded tenant,
  never stamped by design; **zero non-Gesheft rows unstamped**, exactly as on
  08-21. ✅ **Gesheft's PBX side is healthy**: 35 voicemail emails delivered today
  (33 `Orders@gesheftkosher.com` + 2 `Orders@pileupny.com`), **0 bounced, 0
  deferred, mail queue empty**. ⛔ The PBX keeps **one day** of `mail.log`, so the
  other six days of its delivery history are structurally unavailable — say so
  rather than implying they were checked.
  ⛔ **10 of Gesheft's 17 mailboxes carry NO address** (103, 104, 105, 106, 108,
  112, 116, 117, 118, 897) — but that cost them almost nothing this week:
  **exactly 1 of their 273 voicemails landed on a blind mailbox** (ext 108,
  08-20). 220 went to ext 101 and 41 to ext 102, both addressed. **Size a blind
  mailbox by the traffic it actually takes, not by the count of blind rows.**
  ✅ Recipient coverage flat at **55** all week (a brief 55→53 dip across
  08-19/08-20 that recovered on its own — under the alarm's ≥3-AND-≥20 %
  threshold, correctly silent). Sweep heartbeat current to the second (7,643
  runs), watchdog 494 runs. **One escalation fired all week and it was the 08-21
  false alarm above** — no voicemail alarm has fired since.
