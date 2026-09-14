# ⛔⛔ AGENT HANDOFF — 7-day audit of voicemail + SMS forwarding: both lanes CLEAN, but an audio-copy RACE permanently killed 3 voicemail emails and 5 mailboxes email NOBODY (2026-08-27) — READ FIRST before answering "did any voicemail/text fail", before reading `no_recording` as a real skip, or before proving the SMS reply half is alive

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_VOICEMAIL_SMS_AUDIT_2026-08-27.md`**
(**Read-only audit — no code, no deploy, no migration, no PBX write, no data
change, no email sent.** Window 2026-08-20 17:44Z → 2026-08-27 17:44Z.)

- ✅ **THE HEADLINE: nothing is broken and both guardrails are alive.** Voicemail
  email — **64 `VOICEMAIL_NOTIFICATION` jobs, ALL `SENT`**, 0 FAILED, 0
  `emailError`, deliveries on **all 8 calendar days**, and **132 non-Gesheft
  voicemails / 132 stamped / ZERO unstamped**. SMS forward — **349 inbound, 349
  stamped, 0 lost, 0 errors that were not the deliberate skip**; the
  `sms_forward.guardrail` ran **456 times, every one clean**. Outbound SMS — 37
  sent, 0 errors. **No voicemail/SMS escalation fired.**
- ⛔⛔ **THE ONE REAL FAILURE, AND IT IS A RACE NOBODY HAD SPOTTED: three good
  voicemails were stamped `no_recording` and can NEVER be retried.**
  `hasAudio` is `Boolean(localAudioPath) && !audioGoneAt`
  (`voicemailEmailSender.ts:138`), and a false makes `voicemailEmail.ts:112`
  write a **FINAL** skip. But the arrival audio copy is **fire-and-forget**
  (`void copyFreshVoicemailAudioToStore(...)`, `server.ts:30905`, an HTTP fetch to
  the PBX helper taking ~2 s) while the email sweep is an **independent 60-second
  timer** (`server.ts:5534`). **Nothing sequences them**, so a sweep tick landing
  in that 1–3 s window kills the email forever.
  ⛔⛔ **THE PROOF IS THE TIMING, AND IT IS THE REUSABLE TRICK: compare
  `createdAt` → `emailedAt` per outcome.** EMAILED avg **31.2 s**, `too_short`
  **28.3 s**, `no_recipient` **29.8 s** — and `no_recording` **0.4 s** (0.2 /
  0.3 / 0.7). That is not a different verdict on the same data, it is the
  decision running **before the data existed**. All three rows carry a
  `localAudioPath` and a null `audioGoneAt` **today**, and all 132 non-Gesheft
  voicemails have local audio, so the skip was never true about the voicemail.
  **Casualties:** A plus center 108 (08-23, Yiddish), Yossis 102 (08-24, sales),
  **Trust Bookkeepings 106 (08-24, a real customer in Yiddish)**. Size: **~2/week
  (2 the week of 08-24, 2 the week of 08-17), ≈2% of eligible** — matching the
  mechanism (~2 s copy ÷ 60 s sweep ≈ 3%).
  ✅✅ **FIXED THE SAME DAY (`6136f462`) — Izzy: *"There can never, ever, ever,
  ever be a situation where emails don't arrive."*** Two changes, and **the
  BOUNDS are the safety, not the behaviour.** (a) Missing audio on a
  just-arrived voicemail is now `awaiting_recording` carrying `retry: true`,
  which the sender deliberately does NOT stamp, so the next sweep judges it
  again — bounded by **`AUDIO_ARRIVAL_GRACE_MS` = 5 min**, which ⛔ **MUST stay
  under `NEVER_PROCESSED_GRACE_MS` (10 min)** or a voicemail legitimately
  waiting for audio gets reported as stranded, and ⛔ **MUST be finite** or the
  row is permanently eligible, permanently the OLDEST, and fills the sweep's
  ascending batch of 50 — **the 2026-08-18 outage exactly**. ⛔ A row with no
  `receivedAt`, or one dated in the FUTURE, takes the FINAL branch: an unknown
  age must never buy an unbounded retry. (b) Watchdog **self-heal 3** re-opens a
  `no_recording` stamp whose audio has SINCE arrived, so a grace that expires
  during a wedged helper is still recoverable.
  ⛔⛔ **THE TERMINATION ARGUMENT MUST BE RE-DERIVED IF THAT QUERY IS EVER
  WIDENED:** a row is re-opened only while stamped `no_recording` AND its audio
  is present, then re-judged WITH audio — so it can only reach send / `too_short`
  / `no_recipient` / `disabled` / `already_queued`, none of which the query
  matches, so it re-opens at most once. **Matching a reason the re-decision can
  produce again is an infinite re-open/re-email loop that mails a customer every
  watchdog tick**; a test enumerates every reachable outcome to pin it.
  ⛔ **Do NOT "fix" the original race by awaiting the copy inline** — that puts a
  PBX HTTP fetch back on the ingest path, the 2026-08-12 helper FD-exhaustion
  class. ✅ **19 tests, 12 of which FAIL replayed against `HEAD`** (all three
  source guards + the behavioural no-stamp test); voicemail suite **101/101**;
  api typecheck **76 = the exact baseline**, none in a voicemail file.
  ✅✅ **DEPLOYED AND PROVEN ON PRODUCTION 2026-08-27 18:19Z — and the proof is
  the EMAILS, not the greps.** api container `1eed0444` (⊇ `6136f462`; all four
  fix markers grepped INSIDE the running container, 0 restarts, 0 error lines,
  health 200 both hostnames). The boot watchdog fired 90 s after start and the
  recovery ran end to end in **16 seconds**: **Trust Bookkeepings 106 `SENT`
  18:20:13** to cspilman@trustbookkeepingny.com (*"New voicemail from LINX ·
  2125165469"* — the real customer), **Yossis 102 `SENT` 18:20:10** to
  lea@yossiswoodworx.com, and **A plus center 108 correctly reclassified to
  `no_recipient`** with no email and — the check that matters — **no
  escalation**, because that is exactly the case `gapsWorthAlerting` filters.
  **`no_recording` rows still holding audio: 0.** Both guardrail heartbeats
  current afterwards.
  ⏳ **NOT PROVEN: no NEW voicemail has taken the retry path yet.** The recovery
  half is proven by two delivered emails; the grace half is proven by 19 tests
  and by the code in the container. ⛔ It is **unobservable when it works** — the
  tell is a `no_recording`-with-audio count that STAYS at 0 while voicemails keep
  flowing, so re-run the handoff's §7 queries in a week rather than expecting a
  log line.
- ⚠️⚠️ **FIVE BLIND MAILBOXES TOOK 15 VOICEMAILS THAT REACHED NOBODY, AND THE LIST
  IN THIS FILE WAS OUT OF DATE.** Now: **A plus center 108 (10)**, **B Visible 105
  (2)**, **B Visible 106 (1)**, **Create A Box 105 (1)**, **Landau Home 101 (1)** —
  ⛔ B Visible 105/106 and Create A Box 105 are **NEW and were recorded nowhere**;
  Trimpro 104 did not recur. All five confirmed truly unconfigured
  (`Extension.pbxUserEmail` NULL **and** zero `VoicemailEmailRecipient` rows).
  ⚠️ **The single most valuable loss of the week is Create A Box ext 105 — a
  3 m 42 s voicemail that notified nobody.** ⛔ `no_recipient` deliberately never
  escalates (it is a standing condition, not a fault), so **only an audit finds
  this**; the fix is one address each in Settings and is Izzy's call.
- ⛔⛔ **AND THE ALARMS THEMSELVES COULD EACH FIRE ONCE, EVER — FIXED
  (`c5670bbb`). This is the most serious thing the audit found.**
  `raiseGuardrailEscalation` suppressed on **any OPEN escalation with the same key
  prefix, with NO time bound**, and **`AgentEscalationStatus` has no RESOLVED
  value** — so a delivered alarm ends at `SENT` and nothing ever moves it.
  **All six keys protecting the email pipeline were one-shot, and one was already
  burned** (`Voicemail email watchdog has stopped`, 2026-08-21). The sweep dying
  today would page; **dying again next month would be silent.** ✅ Bounded to
  **`ESCALATION_REDUPE_WINDOW_MS` = 6 h**, restoring the STATED intent ("a
  persistent fault texts once, not every tick") — the sibling
  `voicemailMailboxGuardrail` already used 24 h for the same reason. ⛔ **The
  burned key re-arms itself** (the row is days old); no data change was needed.
  ⛔ A future-dated row cannot suppress forever. ⛔ Never go back to an unbounded
  de-dupe, and never drop this to minutes — an alarm that texts through the night
  gets muted, which is the same as no alarm.
  ⛔⛔ **The fake db now stamps `createdAt` like Prisma's `@default(now())`, and
  that is NOT a test convenience** — the new de-dupe READS that field, and a fake
  missing a field the code depends on exercises a shape production never produces
  (the turn-health class). **The one pre-existing test that failed was asserting
  the OLD unbounded behaviour; it was read before it was made to pass.**
- ✅✅ **A MAILBOX GOING BLIND IS NO LONGER SILENT (`c5670bbb`).** The addresses
  still need Izzy, **but the silence did not** — three of the five appeared during
  the audit week with no signal anywhere. `runBlindMailboxCheck` +
  `decideNewlyBlindMailboxes` (hourly + a 4-min boot kick) escalate **once when a
  mailbox JOINS the blind set**, never for one already in it.
  ⛔ **Edge-triggered on purpose, not a nag** — `no_recipient` stays filtered out
  of `gapsWorthAlerting`, because paging every 15 min about a standing condition
  is how an alarm gets muted; what is worth hearing is a mailbox that has JUST
  gone quiet. ⛔ **The FIRST run is a baseline and raises nothing**, so deploying
  it does not page about the five already known (the payment-alert cutover
  reasoning). ✅ **It re-arms by itself** — a mailbox leaves the set once it stops
  producing `no_recipient` voicemails inside the 7-day window, so a later relapse
  is genuinely new. State in `AgentAuditLog` (`voicemail_email.blind_mailboxes`),
  written on EVERY run including clean ones — the row IS the state, and a run that
  writes nothing leaves the next run unable to tell new from old.
  ✅ **16 tests, 14 of which FAIL replayed against `HEAD`**; voicemail suite
  **117/117**; api typecheck **76 = the exact baseline**.
- ⛔⛔ **THE SMS REPLY HALF HAS NO HEARTBEAT, so "4 quiet days" and "the poller is
  dead" look IDENTICAL in the database — it took three checks to tell them
  apart.** Proven alive: `app-agent-1` up since 08-24 21:23 with **0 restarts**
  and **`grep -c "sms reply pass failed"` over all 16,302 log lines = 0** (the
  45 s IMAP poll has not thrown once), plus a **read-only IMAP probe** (connect +
  `STATUS`, no fetch, so no `\Seen` change) reading `sms@loopcom.net` INBOX
  **12 messages, 0 unseen** in 1.3 s. Nothing is sitting unprocessed; nobody has
  replied since 08-23. ⏳ **Worth building: an `sms.reply_heartbeat` audit row per
  pass** — every other sweep here has one.
- ✅ **The Gmail lower-cased-`Delivered-To` bug is CONFIRMED DEAD.** The last
  `ambiguous_reply_address` refusal is **2026-08-21**, before the 08-23 fix
  (`6d9b9f33`); **none since.**
- ⚠️ **ONE INVISIBLE FAILURE MODE, SEEN ONCE: a text-forward email BOUNCED after
  Google had accepted it.** `sms.reply_ignored no_reply_address` from
  `mailer-daemon@googlemail.com`, 2026-08-23 21:12 — and **no Connect `EmailJob`
  was sent anywhere near that time** (the only rows are 8 `ADMIN_ALERT`s, all
  `SKIPPED ALERTS_MUTED`), so it is a bounce of an email the **agent** sent as
  `sms@loopcom.net`. ⛔ **`emailForwardedAt` is stamped on SMTP acceptance, so a
  post-acceptance bounce leaves the row looking perfectly delivered** — `SENT`
  means the provider took it, never that a human got it.
- ⛔ **Gesheft's 287 voicemails are OUT OF SCOPE BY DESIGN and their null
  ⛔ **SUPERSEDED 2026-09-02: Gesheft is on Connect's voicemail email now — see the section at the TOP of this file.**
  `emailedAt` is NOT a failure** — they are the one tenant still on the PBX's own
  voicemail-to-email, so Connect never stamps them. Their delivery is a postfix
  question on the PBX, where **`mail.log` holds ONE DAY**, so six of the seven
  days are unavailable at any price.
- ⚠️ Noticed, not acted on: **Hanna has SMS-to-email OFF** (schema default — she
  post-dates the 08-20 backfill), so her one inbound text on 08-23 emailed nobody;
  `voicemail.transcribe_failed` ×15 (a different lane, not investigated); and
  B Visible still gets carrier-side text emails via VoIP.ms `sms_email` +
  `sms_forward` regardless of the Connect switch.
- ⛔ **The four one-line queries that reproduce this whole audit are in §7 of the
  handoff.** The two that matter most: a non-Gesheft voicemail with
  `emailedAt is null` older than the grace = a lost notification; an INBOUND
  `ConnectChatMessage` with `emailForwardedAt is null` older than 35 min = a lost
  text email. **Both read 0 today.**
