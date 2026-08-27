# AGENT HANDOFF — 7-day audit of voicemail-to-email and SMS forwarding, both directions (2026-08-27)

**Read-only investigation — no code change, no deploy, no migration, no PBX write,
no data change, no email sent, no mailbox flag altered.** Every number below was
measured live on 2026-08-27 against the production database, the running agent
container and (read-only) the PBX spool.

Izzy, 2026-08-27: *"Audit Loopcom voicemail and SMS forwarding back and forth to
see if there were any failures in the past week."*

Window: **2026-08-20 17:44Z → 2026-08-27 17:44Z**.

---

## 0. The answer in one line

**Nothing is broken and both guardrails are alive — but THREE voicemails were
permanently skipped by a real race condition, and 15 more reached nobody because
five mailboxes have no email address configured.**

| Lane | Volume (7d) | Failures |
|---|---|---|
| Voicemail to email (Connect, 26 tenants) | 64 emailed, 132 processed | **3 lost to a race** (section 2) |
| Voicemail to email (Gesheft, PBX path) | 287 voicemails | not measurable from Connect (section 5) |
| SMS to email (forward) | 349 inbound, 349 stamped, 126 emailed | **0** |
| Email to SMS (reply) | 0 customer replies | **0** — poller proven alive (section 4) |
| Outbound SMS | 37 sent | **0** |

---

## 1. Voicemail to email: healthy, with one exception

Authoritative single-moment census, non-Gesheft (`emailSkipReason`):

| Outcome | Count |
|---|---|
| EMAILED | 64 |
| `too_short` (0-1 s hang-ups) | 50 |
| `no_recipient` (mailbox has no address) | 15 |
| `no_recording` | **3** |

- **`EmailJob` type `VOICEMAIL_NOTIFICATION`: 64 rows, ALL `SENT`.** Zero FAILED,
  zero non-SENT, zero `Voicemail.emailError` rows in the window.
- **Zero silent gaps** — emails landed on all 8 calendar days
  (7 / 8 / 2 / 3 / 17 / 9 / 14 / 4).
- Do not judge this from `status='FAILED'`. **The check that matters is whether a
  job was created at all**, judged from the `Voicemail` table:
  **132 non-Gesheft voicemails, 132 stamped, ZERO unstamped.** Nothing aged out.
- **285 unstamped rows are ALL Gesheft**, the excluded tenant, by design.
- Guardrails alive: `voicemail_email.sweep_heartbeat` current to the second
  (10,282 runs), `watchdog_heartbeat` 739 runs, `recipient_coverage` 221 runs.
  **No voicemail-email escalation fired in the window.**

---

## 2. THE ONE REAL FAILURE — an audio-copy race stamps a good voicemail `no_recording`, permanently

**Three voicemails with real audio and real content were skipped and can never be
retried.** All three still have their audio; two carry a real business message.

| Received (UTC) | Tenant | Ext | Len | Caller | Content |
|---|---|---|---|---|---|
| 2026-08-23 14:58:56 | A plus center | 108 | 14 s | 845-842-1374 | Yiddish |
| 2026-08-24 17:57:52 | Yossis Wood Works | 102 | 11 s | 212-222-9200 | "Hi, this is Mati with Global Offering from the Tec..." (sales) |
| 2026-08-24 20:49:09 | Trust Bookkeepings | 106 | 14 s | 212-516-5469 | Yiddish, a real customer |

### The mechanism, proven by timing

`hasAudio` is derived at `voicemailEmailSender.ts:138` as
`Boolean(vm.localAudioPath) && !vm.audioGoneAt`, and
`voicemailEmail.ts:112` turns a false into a **final** `no_recording` stamp.

The arrival path is a **fire-and-forget** audio copy —
`void copyFreshVoicemailAudioToStore(...)` (`server.ts:30905`) — an HTTP fetch to
the PBX helper that takes a couple of seconds. The email sweep is an
**independent 60-second timer** (`server.ts:5534`). Nothing sequences them.

**So if the sweep tick lands in the 1-3 second window between row insert and the
copy completing, the voicemail is stamped `no_recording` forever.**

**The timing is the proof, and it is unambiguous** — `createdAt` to `emailedAt`:

| Outcome | Count | Avg gap | Min gap |
|---|---|---|---|
| EMAILED | 64 | 31.2 s | 1.7 s |
| `too_short` | 50 | 28.3 s | 1.3 s |
| `no_recipient` | 15 | 29.8 s | 2.2 s |
| **`no_recording`** | **3** | **0.4 s** | **0.2 s** |

The three losers were decided at **0.2 s / 0.3 s / 0.7 s**. Every other outcome
averages about 30 s. That is not a different verdict on the same data — it is the
decision running *before the data existed*.

**All three rows now carry a `localAudioPath` and a null `audioGoneAt`**, i.e. the
very field the decision read is populated today. **All 132 non-Gesheft voicemails
in the window have local audio; zero are marked gone.** The skip was never true
about the voicemail — only about the instant it was read.

**The audio is also still on the PBX** (verified read-only: 243 KB / 178 KB /
277 KB). That check is weaker than it looks and must be quoted with the caveat:
**voicemail spool paths are POSITIONAL** (`msgNNNN.wav` renumbers on every
delete), so the file at that path today is not provably the same message.
**`localAudioPath` in Connect's own store is the honest evidence** — it is keyed
by voicemail id.

### Size

`no_recording` rows that DO have local audio, by week: **2 (w/c 08-24), 2 (w/c
08-17)** — about 2/week, roughly 2% of eligible voicemails. Small, constant,
unrecoverable. The expected rate matches the mechanism: ~2 s copy over a 60 s
sweep is about 3%.

### FIXED the same day — Izzy: *"There can never, ever, ever, ever be a situation where emails don't arrive"*

Commit `6136f462`. Two changes, and **the bounds on each are the safety, not the
behaviour** — get either wrong and this becomes a worse bug than the one it fixes.

**(a) Missing audio on a just-arrived voicemail is now a RETRY, not a stamp.**
`decideVoicemailEmail` returns a new `awaiting_recording` reason carrying
`retry: true`, and the sender deliberately does **not** call `markProcessed` for
it, so the next sweep judges it again once the copy has landed. Bounded by
**`AUDIO_ARRIVAL_GRACE_MS` = 5 minutes**, and both bounds are load-bearing:

- ⛔ **It MUST stay under `NEVER_PROCESSED_GRACE_MS` (10 min)** or a voicemail
  legitimately waiting for its audio starts being reported by the watchdog as
  stranded — a guard test asserts the inequality rather than the constant, so it
  survives either being retuned.
- ⛔ **It MUST be finite.** An unstamped row is permanently eligible, permanently
  the OLDEST, and fills the sweep's ascending batch of 50 — **that is the
  2026-08-18 outage exactly**, and the sweep's own header warns about it.
- ⛔ A row with **no `receivedAt`, or one in the future** (clock skew), takes the
  FINAL branch: an unknown age must never buy an unbounded retry.

**(b) A `no_recording` stamp whose audio has SINCE arrived is re-opened.**
Watchdog self-heal 3 (`buildNoRecordingReopenWhere` + `reopenRecoveredNoRecordings`)
clears `emailedAt`/`emailSkipReason` so the next sweep emails it. This is what
makes the promise true when the grace legitimately expires — a wedged PBX helper
delays the audio past 5 minutes, the row stamps, and without this it is lost.
Bounded to `REOPEN_BATCH` (50) per pass, scoped to the 7-day window, excluded
tenants filtered in the query, and the `updateMany` is conditioned on the reason
still being `no_recording` so a blue/green pair cannot re-open twice.

⛔⛔ **THE TERMINATION ARGUMENT IS THE THING TO RE-DERIVE IF YOU EVER WIDEN THAT
QUERY.** A row is re-opened only while stamped `no_recording` **and** its audio is
present. It is then re-judged **with** audio, so it can only reach `send`,
`too_short`, `no_recipient`, `disabled` or `already_queued` — none of which the
query matches. A row therefore re-opens at most once. Matching a reason the
re-decision can produce again is an infinite re-open/re-email cycle that mails a
customer on every watchdog tick; a test enumerates every reachable outcome and
asserts none is `no_recording`.

⛔ **Do NOT "fix" the original race by awaiting the audio copy inline** — that
puts a PBX HTTP fetch back on the ingest path, which is exactly what the
fire-and-forget shape avoids (the 2026-08-12 helper FD-exhaustion class).

**Proven:** 19 tests in `voicemailAudioRace.test.ts`, **12 of which fail replayed
against `HEAD`** — including all three source guards and the behavioural "the
sender does not stamp" test. Voicemail suite **101/101**; api typecheck **76 = the
exact baseline**, none in a voicemail file.

**The three lost ones are recovered by (b) rather than by a hand edit** — the
system heals itself, which is the point. Previewed read-only before deploying, so
the outcome was known rather than discovered: **2 emails actually send** (Trust
Bookkeepings 106 and Yossis 102, both have a recipient) and **A plus center 108
correctly reclassifies to `no_recipient`** — its true reason — which
`gapsWorthAlerting` never escalates, so no spurious page.

---

## 3. Five mailboxes email NOBODY — 15 voicemails reached no one

Not a fault; a standing configuration gap that `no_recipient` reports and the
alarm deliberately never escalates. **The list has CHANGED since CLAUDE.md last
recorded it** (which named A plus 108 and Trimpro 104):

| Tenant | Ext | Missed (7d) | Longest |
|---|---|---|---|
| A plus center | 108 | **10** | 38 s |
| B Visible | 105 | 2 | 15 s |
| B Visible | 106 | 1 | 8 s |
| **Create A Box** | **105** | 1 | **222 s (3m 42s)** |
| Landau Home | 101 | 1 | 2 s |

**B Visible 105/106 and Create A Box 105 are NEW and were not recorded anywhere.**
Trimpro 104 did not recur in this window (Trimpro 102 was fixed 2026-08-20).

**Confirmed truly unconfigured** — all five have `Extension.pbxUserEmail` NULL
**and** zero `VoicemailEmailRecipient` rows.

**The most valuable single loss of the week is Create A Box ext 105: a
3-minute-42-second voicemail that notified nobody.** A caller does not talk for
nearly four minutes to leave nothing.

**The fix is one address each in Settings, and it is Izzy's call, not an
engineering one.** The `voicemail_mailbox.sweep` guardrail is a different check
(mailboxes disabled on the PBX) and correctly reads `offenders: []`.

---

## 4. SMS forwarding, both directions: zero failures

### Forward half (text to email) — clean

- **349 inbound messages, 349 stamped, 0 unstamped past the 35-minute window.**
  Nothing aged out, nothing lost.
- **126 emailed, 223 skipped `no_opted_in_recipients`, ZERO other errors.**
- Skips by tenant: **Gesheft 214** (excluded by design), **B Visible 11**
  (switched off 2026-08-24 on Izzy's instruction), **Hanna 1** (section 6).
- Emailed by tenant: inii mini 47, Relax Tires 22, Connect Communications 13,
  B Visible 11, Trust 9, Create A Box 8, Fixup 7, Luxure 4, Displaydex 3.
- **`sms_forward.guardrail` ran 456 times, every single one clean**:
  `agedOut 0, alarmed [], stampFailures 0, sendFailurePasses 0`.

### Reply half (email to text) — alive, and idle for an honest reason

- 3 `sms.reply_sent` in the window, **all on 08-21 and 08-23, all bridge probes**.
  **No customer has replied to a text-email since.**
- **The reply half has NO heartbeat** — it writes an audit row only when it SEES
  mail, so four silent days are indistinguishable from a dead poller from the
  database alone. **It was therefore proven two other ways:**
  1. `app-agent-1` up since 2026-08-24 21:23, **0 restarts**, and
     `grep -c "sms reply pass failed"` over all 16,302 log lines = **0** — the
     45 s IMAP poll has not thrown once in three days.
  2. A **read-only IMAP probe** of the live mailbox (connect + `STATUS`, no fetch,
     so no `\Seen` change): `sms@loopcom.net`, connect **1.3 s**, INBOX
     **12 messages, 0 unseen**. Nothing is sitting unprocessed.
- **Worth building: a `sms.reply_heartbeat` audit row per pass.** Every other
  sweep on this platform has one; this one does not, and that is the only reason
  proving it took three separate checks.

### The two `sms.reply_ignored` rows, both correct

- **2026-08-21 14:21 — `ambiguous_reply_address` from sales@iniimini.com.**
  **This is the known Gmail lower-cased-`Delivered-To` bug, and it is on the RIGHT
  side of the fix** — repaired 2026-08-23 in `6d9b9f33`. It is the last known
  instance; **no ambiguous refusal has occurred since the fix.**
- **2026-08-23 21:12 — `no_reply_address` from `mailer-daemon@googlemail.com`.**
  A bounce, correctly ignored. Worth knowing what it means: no Connect `EmailJob`
  was sent anywhere near that time (the only rows are 8 `ADMIN_ALERT`s, all
  `SKIPPED ALERTS_MUTED`), so **the bounce is of an email the AGENT sent as
  `sms@loopcom.net`** — i.e. a text-forward email that Google accepted (SMTP 250)
  and later refused. **`emailForwardedAt` is stamped for such a message, so a
  post-acceptance bounce is invisible in the database.** Exactly one in the
  window. Reading the bounce body would name the address; not done, it needs the
  mailbox.

### Outbound SMS — clean

37 outbound messages, **all `deliveryStatus: sent`, zero `deliveryError`.**

---

## 5. What this audit structurally CANNOT see

- **Gesheft's 287 voicemails.** They ride the **PBX's own** voicemail-to-email
  (the one tenant still on it), so Connect never stamps them and
  `Voicemail.emailedAt` is null **by design** — never read that null as a failure.
  Their delivery is a postfix question on the PBX, and **`/var/log/mail.log` holds
  ONE DAY**, so six of the seven days are unavailable at any price.
- **`status = SENT` means the provider ACCEPTED the message, not that a human
  received it.** The one bounce above is the proof that the two differ.
- Bounces of Connect's own `support@connectcomunications.com` mail land in a
  mailbox this audit cannot read.

## 6. Noticed in passing, not acted on

- **Hanna (free tenant) has SMS-to-email OFF** — `chaniweb16@gmail.com`,
  `smsEmailForwardEnabled = false`. One inbound text (2026-08-23, *"Confirmed I
  got both the picture and the message"*) was skipped. **This is the schema
  default working as documented** (the 2026-08-20 rollout was a one-time backfill,
  not a default change) — she was created afterwards. One toggle if he wants her
  included.
- **`voicemail.transcribe_failed` x15** in the window — a separate lane
  (transcription, not delivery) and outside this audit's scope. Not investigated.
- **B Visible still gets text emails from the carrier** regardless of the Connect
  switch: VoIP.ms holds `sms_email: sales@bvisible.us` **and**
  `sms_forward: 8456626794` on 845-238-0478. Already recorded; untouched.

## 7. The queries, so nobody re-derives them

Did any voicemail reach nobody? (0 = clean; Gesheft excluded by design)

    select count(*) from "Voicemail" v join "Tenant" t on t.id=v."tenantId"
    where v."receivedAt" > now() - interval '7 days' and t.name <> 'Gesheft'
      and v."emailedAt" is null;

Did any text lose its email? (0 = clean)

    select count(*) from "ConnectChatMessage"
    where direction='INBOUND' and "emailForwardedAt" is null
      and "createdAt" between now() - interval '7 days' and now() - interval '35 minutes';

The race: `no_recording` rows whose audio actually exists

    select id, "receivedAt", "localAudioPath", "audioGoneAt",
           extract(epoch from ("emailedAt" - "createdAt")) as decided_after_sec
    from "Voicemail" where "emailSkipReason"='no_recording'
      and "localAudioPath" is not null and "audioGoneAt" is null;

Are both guardrails alive?

    select event, max(ts) from "AgentAuditLog"
    where event in ('voicemail_email.sweep_heartbeat','voicemail_email.watchdog_heartbeat',
                    'sms_forward.guardrail') group by 1;

**Proving the reply half is alive needs the agent log plus an IMAP probe** — there
is no database signal. Recipe in section 4.
