# AGENT HANDOFF — "they left a voicemail and we never got it" (Gesheft, 2026-08-27)

**Read-only investigation — no code, no deploy, no PBX write, no data change, no
config touched.** Every fact below was measured on 2026-08-27 from the live
Connect database, the live PBX voicemail spool, the rendered dialplan and the
greeting audio itself.

Izzy, 2026-08-27: *"8454925429 / 8454225014 / 8455009518 — one of these three
numbers claims to have left a voicemail in the past 24 hours or two days ago,
and we didn't get it. Can you check if something like that exists and if it's
true?"*

---

## 1. The answer

**No voicemail was lost. One was never recorded — the caller hung up while the
24-second menu greeting was still playing, several seconds before the beep.**

The tenant is **Gesheft** (PBX tenant 8), DID **(845) 244-9666**.

- The most recent voicemail from ANY of the three numbers is **2026-08-04** (a
  0-second message from 845-422-5014). Nothing since — not in Connect, and not
  in the PBX spool, which is the source of truth.
- **845-500-9518 has called exactly once in its life** — 2026-06-21 — and has
  never left a voicemail. It is not the caller.
- The other two DID call inside the window:

| When (EDT) | From | Duration | What it touched |
|---|---|---|---|
| Tue 25 Aug **6:06 PM** | 845-422-5014 "WIRELESS CALLER" | **15 s** | inbound trunk only |
| Wed 26 Aug **6:05 PM** | 845-492-5429 **"JOSEPH FRAIDY"** | **20 s** | inbound trunk only |
| Thu 27 Aug 9:57 AM | 845-422-5014 | 8 m 28 s | Phone Orders queue — **answered by a person** |
| Thu 27 Aug 10:06 AM | 845-422-5014 | 1 m 11 s | Phone Orders queue — **answered** |

Both evening calls carry **exactly one channel** in `channelsSeen`
(`PJSIP/344022_gesheft-...`) — no queue leg, no extension leg, no agent. They
never left the IVR.

---

## 2. Why nothing was recorded

The DID goes straight into the main menu with no time condition:

```
exten => _8452449666 ... Goto(T8_app-ivr,IVR-23,1)     # extensions__50-8-dialplan.conf:1144
```

`IVR-23` answers immediately and plays the menu:

```
same => n,Answer()
same => n(retry-background),BackGround(/var/lib/vitalpbx/static/106048d48cb4ddf6/recordings/14bfa6bb14875e45bba028a21ed38046)
same => n,WaitExten(10)
```

⛔ **That greeting file is 23.98 seconds long** (`soxi -D`). Measured, not
estimated.

So the two calls ended **at 15 s and 20 s — while the menu was still playing.**
They never pressed a key, never reached a mailbox, never heard a beep.
`VoiceMail()` runs on the inbound channel, so a real voicemail would still show
one leg — but it would also leave a `msg*.txt` in the spool, and there is none.

### The control that proves the system is healthy

Same DID, same evenings, same after-hours path — callers who stayed longer got
through fine:

| Call | Duration | Voicemail written |
|---|---|---|
| Wed 26 Aug 6:12 PM, 845-604-0342 | 34 s | ✅ `101/INBOX/msg9695` — 6 s, recorded at 6:13:23 PM (**+27 s**) |
| Tue 25 Aug 6:38 PM, 718-782-3437 | 249 s | ✅ `101/INBOX/msg9643` — 157 s, recorded at 6:38:53 PM (**+30 s**) |

⛔ **~27–30 seconds elapse between the call connecting and the recording
starting.** A 15-second and a 20-second call cannot possibly have produced a
message. `BackGround` is interruptible, so a caller who knows the menu and
presses a digit early gets there much faster — which is exactly why these two
comparison calls worked and ours did not.

### Voicemail delivery is not broken either

- Gesheft took **292 voicemails in the last 7 days**, the newest at **11:32 AM
  today**, still arriving while this was being written.
- All 16 live tenants have voicemail landing within the last 5 days.
- A full grep of the **entire** `gesheft-voicemail` spool (every mailbox, every
  folder including `Deleted` and `Old`) for the three numbers returns **11
  files, all dated 2 Jul – 4 Aug** — matching the 11 rows in Connect exactly.
  Nothing was ingested-and-lost; nothing was recorded-and-deleted.

---

## 3. What to tell the customer

They rang at **6:05–6:06 PM, right after closing**, listened to part of the
recorded menu and hung up before it finished. Nothing reached us because nothing
was recorded. They got through to a person this morning and spoke for 8½
minutes.

⛔ **Do not tell them "the system dropped it"** — it did not, and the two
comparison calls above are the proof.

---

## 4. ⚠ THE REAL FINDING — 11.7% of Gesheft's callers hang up inside the greeting

This is not a one-off. Over the last 7 days, of **1,167 inbound calls** to
Gesheft:

- **424** touched the inbound trunk and nothing else (single leg)
- **136 of those ended at ≤25 s — inside the 24-second greeting**
- = **11.7% of every caller**, roughly **19 people a day**, who reach the
  system, hear a menu, and leave without reaching a person, a queue or a
  mailbox.

**A 24-second menu is the cause, and it is a product decision, not a bug.**
Shortening it (or putting the most-used option in the first few seconds, since
`BackGround` accepts a keypress from the first moment) would recover most of
them. ⏳ **Deliberately NOT changed — it is a customer-facing recording and
Izzy's call.**

---

## 5. ⛔⛔ URGENT, FOUND IN PASSING — ext 101's mailbox is ~6 days from full

`voicemail show users for gesheft-voicemail` reads **9,770 messages on ext 101
"Phone Orders"**, against `maxmsg=9999` in
`/etc/asterisk/vitalpbx/voicemail__10-general.conf`.

**That is 229 slots left.** Measured fill rate over the last 10 days:
18 / 29 / 34 / 55 / 18 / 34 / 41 / 29 / 52 / 42 → **~35 per day**.

**≈ 6–7 days of runway, i.e. around 2–3 September.**

⛔ **When it hits the cap, Asterisk plays "mailbox full" and DOES NOT RECORD THE
MESSAGE AT ALL** — no voicemail, no email, no Connect row, nothing in any log.
It will present as *"we stopped getting voicemails"* and it will look exactly
like the complaint above, except it will be real and it will affect everyone.

This was flagged on 2026-08-09 (`AGENT_HANDOFF_VOICEMAIL_EMAIL_PBX_2026-08-09.md`
§9) as "3–4 weeks away". **That clock has almost run out.** Ext 102 is at 2,728,
not yet a concern.

The fix is Izzy's call and needs a mandate — the mailbox needs clearing or
archiving, or `maxmsg` raising. **Nothing was changed here.**

---

## 6. ⚠ Noticed, NOT investigated

- **IVR option 2 ("Order Tracking") points at `T8_cos-all,898`, and there is no
  `exten => 898` in the T8 dialplan** and no mailbox 898 in the 17 loaded
  voicemail users. Whether a caller pressing 2 reaches anything at all is
  unproven. (Consistent with the 2026-08-23 note that Gesheft 898 is the one
  deliberately disabled mailbox — but the dialplan side was never checked.)
- **10 of Gesheft's 17 mailboxes still carry no email address** (103–108, 112,
  116–118) — pre-existing, unchanged.

---

## 7. Traps paid for in this investigation

- ⛔ **The Gesheft voicemail context is `gesheft-voicemail`, NOT `8`.**
  `/var/spool/asterisk/voicemail/8/` exists, is a leftover, and is **empty** — a
  search there returns "0 messages in the last 3 days" and reads exactly like a
  dead voicemail system. Find the real one with
  `du -s /var/spool/asterisk/voicemail/*/ | sort -rn | head`.
- ⛔ **`ConnectCdr.disposition = "answered"` on all four calls, including the two
  where nobody and nothing answered** — the PBX's own `Answer()` at the top of
  the IVR sets it. The honest signal is **`channelsSeen`**: one leg = the caller
  never got past the IVR. This is the documented trap in a new costume.
- ⛔ **`ConnectCdr.startedAt` is UTC, the PBX is EDT (UTC-4).** Confirmed against
  `recordingPath`, which embeds local time (`.../100634-IN-Q750-...` for a
  `14:06:34` UTC row). A 4-hour error here turns a 6 PM after-hours call into a
  2 PM business-hours call and inverts the whole diagnosis.
- ⛔ **`/var/log/asterisk/full` holds TODAY ONLY** — no `full.1`, no rotation.
  The two evening calls were already unrecoverable from the log; the CDR
  `channelsSeen`, the spool and the greeting file are what settled it.
- ⛔ The `ConnectCdr` id column is **`linkedId`**, not `pbxCallId`.
- ⛔ Quoting SQL through nested ssh mangles single quotes — write the `.sql`
  locally, `scp` it, `docker cp` it into `connectcomms-postgres`, run with
  `psql -f`.

---

## 8. Re-run recipes

```sql
-- did a given number ever leave a voicemail?
select v."receivedAt", t.name, v.extension, v."callerNumber", v."durationSec"
from "Voicemail" v left join "Tenant" t on t.id = v."tenantId"
where regexp_replace(coalesce(v."callerNumber",''), '[^0-9]', '', 'g') ~ '<10 digits>$'
order by v."receivedAt" desc;

-- did the caller ever get past the IVR?  one leg = no.
select "startedAt", "fromNumber", disposition, "durationSec",
       jsonb_array_length(coalesce("channelsSeen",'[]'::jsonb)) as legs, "queueId"
from "ConnectCdr" where "fromNumber" like '%<digits>%' order by "startedAt" desc;
```

```bash
# the spool is the source of truth — search EVERY folder
grep -rl --include="msg*.txt" -E "<number>" /var/spool/asterisk/voicemail/<slug>-voicemail

# how long is the greeting they have to sit through?
soxi -D /var/lib/vitalpbx/static/<tenant-hash>/recordings/<file>

# mailbox cap runway
asterisk -rx "voicemail show users for <slug>-voicemail"
grep -r maxmsg /etc/asterisk/vitalpbx/voicemail__*.conf
```

---

## 9. Follow-up: "did the Tuesday 157-second voicemail go out as an email?"

Izzy, same day. **Gesheft is the ONE tenant still on the PBX's own
voicemail-to-email path** (the 2026-08-17 cutover moved the other 26 to Connect
and deliberately left Gesheft behind), so this is an Asterisk/postfix question,
not a Connect one. ⛔ Connect's `Voicemail.emailedAt` is **null by design** for
Gesheft and says nothing either way — do not read it as a failure.

**Answer: it cannot be proven directly — the record was destroyed — but three
independent lines of evidence say it went, and the queue evidence is strong.**

### It was destroyed, not missing

- `/var/log/mail.log` contains **only `2026-08-27`**. 25,990 bytes, no rotated
  siblings, no NUL padding — it is emptied in place daily around midnight.
- ⛔⛔ **And logrotate LIES about this.** `/etc/logrotate.d/rsyslog` says
  `weekly` + `rotate 4` and `/var/lib/logrotate/status` last rotated it
  **2026-08-23** — so by config it should hold 4 days plus 4 weekly archives.
  It holds **one day**. Something else empties it; `/etc/cron.daily/vpbx_clean_old_logs`
  is NOT the culprit (it only touches `/var/log/vitalpbx/log_*.log`). ⏳ **The
  exact mechanism was not pinned down.**
- journald is **volatile** (no `/var/log/journal`); `--list-boots` shows one
  boot beginning `2026-08-27 00:00:02`. `journalctl --since "2026-08-25"` for
  postfix returns **"No entries"**.

### Why the answer is still "yes, almost certainly"

1. **It was configured to send.** `voicemail__50-8-main.conf`:
   `101 => <pin>,Phone Orders,Orders@gesheftkosher.com,,attach=yes|...`
   — a real address with the recording attached.
2. ⛔ **THE STRONGEST SIGNAL: `postconf maximal_queue_lifetime` = `5d`, and the
   postfix queue is EMPTY** (`mailq` → "Mail queue is empty"; 0 files across
   `deferred`/`active`/`incoming`/`bounce`/`corrupt`). Tuesday was **2 days
   ago**. Had that email failed on a temporary (4xx) error, postfix would
   **still be retrying it right now**. It is not there. **This is the reusable
   trick: for any "did an email from the last 5 days go out", an empty queue
   rules out every deferral, even with no log at all.**
3. **The pipeline reconciles 1:1 today.** Recorded vs emailed, same day:
   **ext 101 → 28 recorded / 29 sent** to `Orders@gesheftkosher.com` (the +1 is
   a late-night message emailed at `00:00:08`), **ext 102 → 3 recorded / 3
   sent** to `Orders@pileupny.com`. **32 sends today, every one `status=sent`
   with Gmail's `250 ... gsmtp`, zero deferred, zero bounced.**
4. **Size was never a risk:** `msg9643.wav` is **2,505,644 bytes (2.5 MB)** for
   157 s at `format=wav`, far under any limit. `.wav` written 18:41, `.txt`
   18:42 — the `.txt` is written last, at which point `mailcmd` fires.

### ⚠ The one gap, stated honestly

A **hard 5xx rejection** would produce a bounce — and bounces to
`support@connectcomunications.com` are **deliberately DISCARDED** on this box by
the 2026-08-06 bounce-loop fix (`support@… discard:` in `transport_maps`). So
that one failure mode is invisible here. It is unlikely (the same address took
29 emails today), but it cannot be excluded from the server side.

### ✅ The check that settles it, and only Izzy can run it

In **Orders@gesheftkosher.com**, including Spam and Trash:

```
from:support@connectcomunications.com after:2026/08/25 before:2026/08/26
```

Expect a message around **6:41 PM**, caller **718-782-3437**, duration **157**,
with a ~2.5 MB `.wav` attached.

⏳ **Worth fixing regardless:** one day of mail retention is why this question
has no definitive answer. Restoring real rotation (or shipping mail.log
off-box) would make the next "did that email go out?" answerable in one grep.
This was already flagged on 2026-08-09 as the highest-value follow-up in
`AGENT_HANDOFF_VOICEMAIL_EMAIL_PBX_2026-08-09.md` and is still not done.
