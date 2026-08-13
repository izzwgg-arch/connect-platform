# AGENT HANDOFF — voicemail-to-email lives on the PBX, not in Connect (2026-08-09)

**Read this before ANY "customer didn't get their voicemail email" report.**

Investigation run 2026-08-09 (evidence current to that day); the alert-email and
Connect-sender numbers in §7 were re-verified 2026-08-12. **Read-only throughout
— nothing was written to the PBX, Connect, or any config.**

Trigger: Izzy reported Gesheft was again missing voicemail emails, and asked
whether 845-274-6215 left a voicemail and whether its email was delivered.

---

## 1. ⛔ THE RULE THIS SESSION EARNED

**The voicemail emails customers actually receive are sent BY THE PBX. Connect
has nothing to do with them.** I opened this investigation inside Connect —
found Connect's own voicemail-to-email job, found it had never processed a
single row, and was about to report that as the cause. It is not the cause. It
is a *different, unshipped feature*. Izzy had to redirect me: *"you're supposed
to look inside the PBX. Are you looking inside the PBX? Not inside Connect."*
He was right.

Two independent systems can email the same voicemail. Know which one the
customer is actually receiving before you diagnose anything:

| | Sender | Status |
|---|---|---|
| **What customers get today** | Asterisk `app_voicemail` on the PBX → postfix → Gmail relay | **LIVE, and reliable** |
| Connect's own sender (`apps/agent/src/notify/voicemailEmailJob.ts`) | agent container poller | **NEVER been switched on** (§7) |

## 2. The live chain, end to end

```
caller leaves message
  └─ Asterisk app_voicemail writes  /var/spool/asterisk/voicemail/<context>/<ext>/INBOX/msgNNNN.{txt,wav}
  └─ reads the mailbox's email address from
       /etc/asterisk/vitalpbx/voicemail__50-<pbxTenantNum>-main.conf
       line format:  <ext> => <pin>,<Display Name>,<EMAIL>,,attach=yes|...
                                                    ^^^^^^^ 3rd comma field
  └─ pipes the message to  mailcmd = /usr/share/vitalpbx/scripts/voicemail2email
  └─ postfix picks up as uid=105 (asterisk)
  └─ sender_canonical_maps  /^.+$/ → support@connectcomunications.com
  └─ relayhost smtp.gmail.com:587, SASL authenticated
  └─ Gmail answers 250 OK
```

⛔ **If the 3rd comma field is EMPTY, no email is ever generated.** No error, no
log line, nothing to find later. The voicemail is recorded and saved perfectly
and simply never notifies anybody. This is by far the most common cause of
"missing voicemail email" — see §5.

⛔ `/usr/share/vitalpbx/scripts/voicemail2email` is **ionCube-encrypted PHP** and
cannot be read. Do not waste a round trying. Judge it by its output in
`/var/log/mail.log`.

## 3. ⛔ THE DIAGNOSTIC — reconcile the spool against the mail log

The only honest way to answer "was it emailed". Both halves are read-only.

```bash
# (a) every voicemail left in a window, with its true origtime + caller
for f in $(find /var/spool/asterisk/voicemail -name "msg*.txt" -newermt "2026-08-08 00:00" | sort); do
  ctx=$(echo "$f" | sed -E 's|.*/voicemail/([^/]+)/([0-9]+)/([A-Za-z]+)/.*|\1|')
  ext=$(echo "$f" | sed -E 's|.*/voicemail/([^/]+)/([0-9]+)/([A-Za-z]+)/.*|\2|')
  echo "$(grep -m1 ^origtime= "$f" | cut -d= -f2)|$ctx|$ext|$(basename $f .txt)|$(grep -m1 ^duration= "$f" | cut -d= -f2)|$(grep -m1 ^callerid= "$f" | cut -d= -f2-)"
done | sort -n

# (b) every delivery attempt today, by recipient and status
grep -oE 'to=<[^>]+>.*status=[a-z]+' /var/log/mail.log \
  | sed -E 's/.*to=<([^>]+)>.*status=([a-z]+).*/\2 \1/' | sort | uniq -c | sort -rn

# (c) anything that did NOT succeed
grep 'status=' /var/log/mail.log | grep -v 'status=sent'

# (d) which mailboxes can never email (empty 3rd field), platform-wide
for f in /etc/asterisk/vitalpbx/voicemail__50-*-main.conf; do
  num=$(basename "$f" | sed -E 's/voicemail__50-([0-9]+)-main\.conf/\1/')
  awk -v N="$num" '
    /^\[[a-z_0-9]+-voicemail\]/ { ctx=$0; gsub(/[\[\]]/,"",ctx); next }
    /^[0-9]+ =>/ { split($0,a,","); e=a[3]; gsub(/ /,"",e);
                   if (e=="") print N "|" $1 "|" ctx "|" a[2] }' "$f"
done | sort -t'|' -k1,1n -k2,2n
```

**Match (a) to (b) by minute.** Asterisk hands the message to postfix within
~1–3 seconds of the recording ending, so a voicemail at `11:43` and a send at
`11:43:47` are the same event. A voicemail in (a) with no send in (b) is either
in the (d) list (no address — expected) or a genuine loss (never seen yet).

## 4. What 2026-08-09 actually showed — the mechanism is healthy

Reconciled every voicemail on the box for that day:

- **33 voicemails** left platform-wide (00:00–13:40 EDT)
- **29** were in mailboxes that have an email address → **29 emails sent**
- **4** were in mailboxes with NO address → no email, by configuration
- **30 postfix deliveries, every one `status=sent`, zero failures, zero deferrals**
  (the 30th was a local cron message to `root`, not a voicemail)
- Postfix `deferred` / `bounce` / `corrupt` / `hold` / `incoming` / `maildrop`
  queues: **all empty**
- `/var/mail/root` holds **381 daily cron mails and not one** undeliverable /
  bounce / delay notice, going back over a year

Gesheft specifically: **12 voicemails on ext 101 → 12 emails to
`Orders@gesheftkosher.com`, 100%.** So on the day of the complaint the PBX was
emailing that mailbox perfectly.

Deliverability is sound and should not be re-litigated: every recipient domain
(`gesheftkosher.com`, `pileupny.com`, `apluscenterinc.org`,
`connectcomunications.com`) is **Google Workspace** with
`v=spf1 include:_spf.google.com ~all`, and we relay **through authenticated
Gmail SMTP**, so SPF passes and a `250 OK ... gsmtp` means Google has taken the
message into its own system. After that it is inbox-or-spam on the customer
side, not a transport problem.

**Email size is a non-issue.** Measured ratio is a very consistent
**~4.3 KB of email per second of audio** (the script compresses; it does not
attach the raw 16 KB/s wav). A 97-second message makes ~420 KB against
postfix's `message_size_limit` of **10 MB**. Do not chase size.

## 5. ⛔ 58 mailboxes can never email — this is the real "missing emails"

`108 of 2,674` voicemails in the trailing 30 days (**4%**) landed in a mailbox
with an empty email field, so no email was ever generated. Worst offenders:

| Count | Mailbox | Last | Longest |
|---:|---|---|---|
| 45 | **A Plus Center ext 108 "Home"** | 2026-08-09 | 77s |
| 11 | **Gesheft ext 112 "Yossef Friedman"** | 2026-08-06 | 41s |
| 8 | Create A Box ext 101 "Blimie Weiss" | 2026-08-05 | **255s** |
| 6 | **Gesheft ext 108 "Office 2"** | 2026-08-02 | 9s |
| 5 | Create A Box ext 105 "Home Line 2" | 2026-08-09 | 112s |
| 5 | Trimpro ext 104 | 2026-08-07 | 20s |
| 1 | **Gesheft ext 106 "Register 4"** | 2026-07-23 | **400s** (maxsecs cap) |

Gesheft's email-less mailboxes: **103, 104, 105, 106, 108, 112, 116, 117, 118,
897**. Its working ones: 101→`Orders@gesheftkosher.com`,
109→`contact@gesheftkosher.com`, 111+115→`scn@gesheftkosher.com`,
114→`ap@gesheftkosher.com`, 107→`tod10950@gmail.com`.

⛔ **Gesheft ext 102 "Customer Service" emails to `Orders@pileupny.com`** — a
different company's domain. It delivers fine (2 sends on Aug 9). **Needs Izzy's
confirmation that this is intentional**; if Gesheft staff expect ext 102
messages, this is exactly a "we're missing voicemail emails" report with a
correct-looking log.

## 6. ⛔ THE OBSERVABILITY GAP — no mail history past the current day

**This is why the question that opened the session has no hard answer.** Every
record covering a moment before midnight is destroyed:

| Source | Retention |
|---|---|
| `/var/log/mail.log` | current day only; `mail.log.1` is **1 byte** |
| systemd journal | **runtime-only** (`/run/log/journal`, no `/var/log/journal`) — earliest entry `00:00:01` |
| `/var/log/asterisk/full` | earliest entry `00:00:01`, **no `full.1`** |
| `/var/log/syslog` | `mail.*` is routed only to `mail.log`, so no copy here |
| remote syslog | **none configured** |

`/etc/logrotate.d/rsyslog` claims `rotate 4 weekly compress` for `mail.log`, and
yet the previous copy is 1 byte and everything reset at 00:00 — the policy on
paper is not what the box is doing. **Anything older than "today" is
unanswerable, and every day at midnight the evidence for the previous day is
lost.** Fixing this is the highest-value follow-up in this document: without it,
the next identical complaint gets the same non-answer.

## 7. Connect's own voicemail-to-email has NEVER run

`apps/agent/src/notify/voicemailEmailJob.ts` is complete, tested-looking code
gated on one env var:

```ts
if (process.env.AGENT_VOICEMAIL_EMAIL === "1") { … }   // apps/agent/src/server.ts:1028
```

⛔ **`AGENT_VOICEMAIL_EMAIL` is set nowhere** — not in the running `app-agent-1`
container, not in `/opt/connectcomms/env/.env.platform`, not in
`docker-compose.agent.yml`. `AGENT_VOICEMAIL_TRANSCRIBE=1` **is** set, which is
why transcripts land on every voicemail while no Connect email ever does. Same
"config, not code" shape as the worker's dead FCM sender.

**Proof it has never processed anything:** `Voicemail.emailedAt` is stamped
exactly once per row after the sender handles it — *including* the skip reasons
`no_extension` / `disabled` / `no_address`. Across **289 voicemails from
2026-08-09 to 2026-08-13, `emailedAt` is null on every single one** (and on all
918 in the preceding 10 days). Not one row has ever been touched.

⛔ **Two design traps to fix BEFORE anyone turns this on:**

1. **A failed send is a silent permanent loss.** `processOne` returns `false`
   *without stamping* when the notifier fails, so the row is retried only while
   it stays inside `FRESH_WINDOW_MIN` (**30 minutes**) and then drops out of
   scope forever — no `emailError`, no alert, no trace. `emailedAt=null` +
   `emailError=null` is therefore ambiguous: it means *either* "never ran" *or*
   "tried and silently gave up".
2. **The agent's notifier has no SMTP configured at all** —
   `[notifier] SMTP not configured — mail "…" recorded to audit only` appears
   throughout `docker logs app-agent-1`. Enabling the flag today would send
   nothing and, per trap 1, would quietly consume each voicemail's 30-minute
   window doing it.

## 8. Timestamp facts (verified, do not re-derive)

- The **PBX runs America/New_York (EDT)**; loopcom runs Europe/Berlin (CEST).
- `Voicemail.receivedAt` **is exactly** the spool's `origtime` epoch —
  confirmed **40/40** over Aug 8–9. It is absolute UTC, not a skewed local
  string. `pbxMessageId` = `<pbxTenantNum>|<ext>|<origtime>|<caller10>`.
- **Connect's voicemail ingest is reliable.** 40 spool messages ↔ 40 Connect
  rows, 1:1 on extension, duration, caller and origtime. Nothing "failed to
  save". Do not suspect ingest without re-running this diff.
- PBX tenant number → voicemail context comes from the conf filenames:
  `2=a_plus_center 3=secro_selution 5=luxure_management 6=displaydex
  7=create_a_box 8=gesheft 9=b_visible 11=trimpro 18=trust_bookkeepings
  21=test 25=relax_tires 34=rsbk 35=connect_communications 102=loopcom_demo
  105=inii_mini`.

## 9. ⛔ Gesheft ext 101 is 853 messages from a hard wall

```
maxmsg=9999                        (/etc/asterisk/vitalpbx/voicemail__10-general.conf)
gesheft-voicemail/101/INBOX  9,146 messages     ← 91.5% full
gesheft-voicemail/102/INBOX  2,612
a_plus_center-voicemail/108    600
```

At the observed **~35 voicemails/day** on Gesheft 101, the INBOX reaches
`maxmsg` in roughly **three to four weeks**. When it does, Asterisk plays
"mailbox full" and **the message is not recorded at all** — no voicemail, no
email, no Connect row, and nothing in the mail log to find. That is a genuine
future outage for the busiest mailbox on the platform, and it will present
exactly as "we stopped getting voicemail emails".

`moveheard=yes`, so INBOX = *unheard*: all 9,146 are unlistened, consistent with
Gesheft working entirely from email. Cleanup is a customer decision, not ours.
(The same two mailboxes are the ones flagged for cleanup in the voicemail
preload-flood handoff — 9,200 and 2,600 — so this is the same debt seen from the
capacity side.)

## 10. The case that opened this: 845-274-6215

- **The voicemail is NOT lost.**
  `gesheft-voicemail/101/INBOX/msg9132.{txt,wav}`, **1,563,884 bytes**, intact.
- **97 seconds**, caller `"WIRELESS CALLER" <8452746215>`,
  `origtime=1786244800` = **Sat 2026-08-08 23:06:40 EDT**, mailbox
  **101 Phone Orders**, `context=sub-vm`, `msg_id=1786244800-00000909`.
- Saved into Connect correctly (`cmsl83ilealfdqn1313zni9az`), so it plays in the
  app and portal right now.
- **It did not leave a voicemail "today".** On Aug 9 at 11:06:42 the same number
  called again (`C-00009608`), went DID `8452449666` → `IVR-23` → key 1 → time
  condition `TC-4` (open) → `IVR-22` → key 1 → queue `750 Phone Orders`, and
  **ext 102 answered at 11:07:00 and talked until 11:13:43** — a 6m43s real
  conversation. No voicemail was needed. Establish this before hunting.
- **Whether its email was sent cannot be proven**, for the §6 reason: 23:08 on
  Aug 8 is behind the midnight wall in all four log sources.
- Everything measurable points to it having gone out: the mailbox has a valid
  address, the mechanism was 12-for-12 on that mailbox the next morning, Aug 8
  was a Saturday with only **2** voicemails to ext 101 all day (so no send-limit
  pressure), the size would have been ~420 KB, and no bounce or stuck message
  exists anywhere.
- **The one check that settles it** is in the customer's own mailbox, and only
  Izzy can run it — search `Orders@gesheftkosher.com`, including Spam and Trash:
  `from:support@connectcomunications.com after:2026/08/08 before:2026/08/10`.
  Sender displays as **`Connect <support@connectcomunications.com>`**
  (`fromstring=Connect`, `serveremail=support@…`).

## 11. Corrections to earlier handoffs

⛔ **"ALERT EMAILS ARE CURRENTLY OFF" is STALE — alerting is back ON.** The
kill switch expired exactly as its own note predicted (~23:41 ET 2026-08-06) and
nothing replaced it. `ps -eo pid,etime,cmd | grep "[a]lert-email-killswitch"`
→ **not running**; the script is still on disk at
`/root/alert-email-killswitch.sh`, inert. Izzy confirmed on 2026-08-12 that he
is still receiving these emails. `ADMIN_ALERT` per day (ET), from `EmailJob`:

```
08-05  sent=187          08-09  sent=40
08-06  sent=399 (+52)    08-10  sent=40
08-07  sent=45           08-11  sent=40
08-08  sent=40           08-12  sent=6  skipped=34   ← ceiling now skipping
```

The good news: the **40-per-rolling-24h ceiling** from `adminAlertBudget.ts`
(`0197dd56`) **is holding** — four consecutive days pinned at exactly 40, down
from 399, and on 08-12 the surplus is being `SKIPPED` rather than sent. The
open item is unchanged and now measured: **40 alert emails a day still come out
of the same 500/day mailbox that carries customer invoices and every voicemail
notification.** A second sending mailbox remains the real fix.

⛔ Do not use `pgrep -f` to check for the kill switch **or anything else** over
ssh — it matches its own command line and reports the process as alive. Use
`ps -eo pid,etime,cmd | grep "[a]lert-email-killswitch"`. This trap is already
documented three times in CLAUDE.md and it still cost a wrong reading here.

## 12. Still open

1. **Mail-log retention on the PBX** (§6) — the blocker on ever answering this
   class of question. Nothing else in this list matters as much.
2. **Gesheft 101 heading for `maxmsg`** (§9) — ~3–4 weeks of headroom.
3. **Confirm Gesheft ext 102 → `Orders@pileupny.com`** is intentional (§5).
4. **Decide about the 58 email-less mailboxes** (§5) — at minimum A Plus "Home"
   (45 in 30 days) and Gesheft 112 (11), which look like oversights rather than
   choices.
5. **Connect's own sender** (§7) — fix both traps before enabling, and give the
   agent SMTP. Enabling it as-is would send nothing.
6. **A second sending mailbox** so monitoring can never starve customer mail
   (§11).
7. Nobody has confirmed whether msg9132's email is sitting in
   `Orders@gesheftkosher.com` (§10). That answer costs ten seconds and closes
   the original complaint.
