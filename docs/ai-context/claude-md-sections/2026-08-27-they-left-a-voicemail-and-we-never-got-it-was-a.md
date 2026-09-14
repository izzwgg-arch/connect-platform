# ⛔⛔ AGENT HANDOFF — "they left a voicemail and we never got it" was a caller hanging up inside a 24-SECOND greeting, and 11.7% of that customer's callers do the same (2026-08-27) — READ FIRST for ANY "we never got their voicemail", before trusting `disposition: "answered"`, and before telling a customer we lost anything

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_GESHEFT_MISSING_VOICEMAIL_2026-08-27.md`**
(**Read-only investigation — no code, no deploy, no PBX write, no data change, no
config touched.**) Memory:
[[one-leg-in-channelsseen-means-they-never-passed-the-ivr]].
Izzy, 2026-08-27: *"one of these three numbers claims to have left a voicemail in
the past 24 hours … can you check if something like that exists and if it's true?"*

- ✅ **THE ANSWER: nothing was lost — nothing was ever recorded.** Tenant
  **Gesheft**, DID **(845) 244-9666**. The last voicemail from any of the three
  numbers is **2026-08-04**; **845-500-9518 has called ONCE in its life
  (2026-06-21)** and is not the caller. The other two rang **Tue 25 Aug 6:06 PM
  (15 s)** and **Wed 26 Aug 6:05 PM (20 s)**, right after closing — and the main
  menu greeting is **23.98 seconds long** (`soxi -D`, measured). **They hung up
  while the menu was still playing**, before any beep. Both got through to a
  person this morning and talked for 8½ minutes.
- ⛔⛔ **`ConnectCdr.disposition` READ "answered" ON ALL FOUR CALLS, INCLUDING THE
  TWO WHERE NOTHING ANSWERED** — the PBX's own `Answer()` at the top of the IVR
  sets it. **The honest signal is `channelsSeen`: ONE leg
  (`PJSIP/<trunk>-…` only) = the caller never left the IVR.** ⛔ But one leg does
  **not** by itself mean "no voicemail" — `VoiceMail()` runs **on the inbound
  channel**, so a real message also shows one leg. **The spool is what separates
  them**, and a full grep of every mailbox and every folder (`INBOX`/`Old`/
  `Deleted`) returned only the 11 old files, matching Connect exactly.
- ⛔ **MEASURE THE GREETING — it is the step people skip and it was the whole
  answer.** Controls from the same evening, same DID: a **34 s** call produced a
  6 s message (**+27 s**), a **249 s** call produced a 157 s message (**+30 s**).
  So **~27–30 seconds elapse before recording starts**, and a 15–20 s call
  cannot have produced one. ⛔ `BackGround` is interruptible, so a caller who
  knows the menu and presses a digit immediately gets there fast — which is why
  some short calls DO leave messages. **Never reason from duration alone; find a
  control call in the same window.**
- ✅ **Voicemail is healthy and that was proven, not assumed:** Gesheft took
  **292 voicemails in 7 days**, newest **11:32 AM the same day**, and all 16 live
  tenants have voicemail landing within 5 days.
- ⚠⚠ **THE FINDING WORTH ESCALATING IS THE GREETING, NOT THE COMPLAINT: over 7
  days, 136 of 1,167 Gesheft inbound calls (11.7%, ~19 people a day) ended at
  ≤25 s with a single leg** — reaching no person, no queue and no mailbox. A long
  menu is a silent daily customer-loss channel. ⏳ **Deliberately NOT changed** —
  it is a customer-facing recording and Izzy's call.
- ⛔⛔ **URGENT, FOUND IN PASSING: `voicemail show users` reads 9,770 messages on
  Gesheft ext 101 against `maxmsg=9999` — 229 slots, ~35/day, ≈6–7 days (about
  2–3 September).** At the cap Asterisk plays "mailbox full" and **does not
  record the message at all** — no voicemail, no email, no Connect row, nothing
  in any log. It will be reported as "we stopped getting voicemails" and will
  look exactly like this complaint, except real and affecting everyone. Flagged
  2026-08-09 as "3–4 weeks"; that clock has run out. Needs Izzy's mandate
  (clear/archive, or raise `maxmsg`). See [[gesheft-101-mailbox-nearly-full]].
- ⛔ **THE SPOOL PATH TRAP THAT NEARLY PRODUCED A FALSE OUTAGE: the context is
  `gesheft-voicemail`, NOT `8`.** `/var/spool/asterisk/voicemail/8/` exists, is a
  leftover, and is **empty** — searching it answers "0 messages in the last 3
  days" and reads exactly like a dead voicemail system. Find the real one with
  `du -s /var/spool/asterisk/voicemail/*/ | sort -rn | head`.
- ⛔ **`ConnectCdr.startedAt` is UTC and the PBX is EDT (UTC-4)** — confirm
  against `recordingPath`, which embeds local time; a 4-hour error turns a 6 PM
  after-hours call into a 2 PM business-hours call and inverts the diagnosis.
  ⛔ **`/var/log/asterisk/full` holds TODAY ONLY** (no `full.1`), so anything
  older than midnight must be settled from `channelsSeen`, the spool and the
  audio file. ⛔ The `ConnectCdr` id column is **`linkedId`**, not `pbxCallId`.
  ⛔ Nested-ssh quoting mangles SQL — write the `.sql` locally, `scp`, `docker cp`
  into `connectcomms-postgres`, run `psql -f`.
- ⚠ **Noticed, NOT investigated:** IVR option 2 ("Order Tracking") points at
  `T8_cos-all,898`, and there is **no `exten => 898` in the T8 dialplan** and no
  mailbox 898 among the 17 loaded voicemail users — whether pressing 2 reaches
  anything is unproven.

- ✅✅ **FOLLOW-UP, SAME DAY — "did that Tuesday 157-second voicemail go out as an
  email?" ANSWER: unprovable directly (the record was destroyed), but three
  ⛔ **SUPERSEDED 2026-09-02: Gesheft is on Connect's voicemail email now — see the section at the TOP of this file.**
  independent lines say yes.** ⛔ **Gesheft is the ONE tenant still on the PBX's
  own voicemail-to-email path**, so this is an Asterisk/postfix question, and
  Connect's `Voicemail.emailedAt` is **null BY DESIGN** for Gesheft — never read
  that null as a failure. (1) Ext 101 is configured
  `Orders@gesheftkosher.com` with `attach=yes`. (2) ⛔⛔ **THE REUSABLE TRICK:
  `maximal_queue_lifetime` is `5d` and the postfix queue is EMPTY** (0 files in
  deferred/active/incoming/bounce/corrupt) — **so any email from the last five
  days that failed on a temporary error would STILL be sitting there. An empty
  queue rules out every deferral even with no log at all.** (3) The pipeline
  reconciles **1:1 today**: ext 101 **28 recorded / 29 sent**, ext 102 **3 / 3**,
  **32 sends, all `status=sent` with Gmail's `250 ... gsmtp`, 0 deferred, 0
  bounced**. Size was never a risk (2.5 MB wav, 157 s). ⚠ **The one gap, stated
  honestly: a hard 5xx would bounce, and bounces to `support@` are DELIBERATELY
  DISCARDED here by the 2026-08-06 bounce-loop fix, so that failure mode is
  invisible from the server.** ✅ **The check that settles it is Izzy's**, in
  Orders@gesheftkosher.com incl. Spam/Trash:
  `from:support@connectcomunications.com after:2026/08/25 before:2026/08/26`.
- ⛔⛔ **AND LOGROTATE LIES ABOUT MAIL RETENTION ON THE PBX — this is WHY the
  question had no definitive answer.** `/etc/logrotate.d/rsyslog` says `weekly` +
  `rotate 4` and `/var/lib/logrotate/status` last rotated `mail.log` on
  **2026-08-23**, so by config it should hold days. It holds **ONE DAY**:
  `/var/log/mail.log` contains only today, 26 KB, no rotated siblings, no NUL
  padding — emptied in place near midnight by something that is **NOT**
  `/etc/cron.daily/vpbx_clean_old_logs` (that only touches
  `/var/log/vitalpbx/log_*.log`). journald is **volatile** (no `/var/log/journal`),
  so `journalctl --since` two days back returns **"No entries"**. ⏳ **Mechanism
  not pinned down; fixing retention was already the highest-value follow-up in
  `AGENT_HANDOFF_VOICEMAIL_EMAIL_PBX_2026-08-09.md` and is still not done.**
