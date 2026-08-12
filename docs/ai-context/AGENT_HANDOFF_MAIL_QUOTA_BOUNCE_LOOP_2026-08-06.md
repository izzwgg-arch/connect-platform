# AGENT HANDOFF — "why do I keep getting these?" (2026-08-06)

**One mailbox sends everything Connect sends. Our own monitoring ate 80% of its
daily allowance, and a Postfix misconfiguration turned every refusal into an
infinite bounce storm.**

Engagement started from a screenshot of a Gmail bounce on Izzy's phone. Ended
with the loop dead, alerts silenced, and ~15 customer messages salvaged by hand.

Commit: `0197dd56` (`fix(alerts): our own monitoring was eating the mailbox
customers' email needs`) on `feat/ivr-migration-takeover` — **api DEPLOYED and
container-verified; worker NOT deployed.**

---

## 1. ⛔ THE RULE THIS SESSION EARNED — a quiet log is not a fixed bug

I declared the bounce loop fixed at 14:46 after seeing **four minutes of zero
bounces**. It was not fixed. It ran **135 more bounces** and I only found out
because a monitor fired on an unrelated failure.

The four quiet minutes were quiet because **no mail had been sent in them** —
zero voicemails were recorded fleet-wide in that window. I measured the symptom
during a period where the symptom could not appear, and reported the absence as
a cure.

**Before concluding a mail/telephony fix worked, prove there was TRAFFIC in the
window you measured.** The check that actually settles it:

```bash
# was there anything that COULD have failed?
awk '$0 >= "2026-08-06T15:00"' /var/log/mail.log | grep -c "status="
find /var/spool/asterisk/voicemail -name "msg*.txt" -newermt "15:00" | wc -l
```

The second attempt was verified properly — against a real Gesheft failure, by
following one message end to end and confirming the chain terminated.

---

## 2. The two causes, which are independent

### 2a. The mailbox is capped at 500/day and alerts took 402 of them

Everything Connect sends — invoices, invites, password resets, **and the PBX's
voicemail-to-email** — goes out as `support@connectcomunications.com` through
`smtp.gmail.com`. Measured over the 24h to 2026-08-06 15:00:

| source | count |
|---|---|
| Connect app — **ADMIN_ALERT** | **402** |
| Connect app — real customer email | 8 |
| PBX — voicemail notifications | 89 |
| **total** | **499** (cap: 500) |

Once exhausted, Google refuses everything with `550-5.4.5 Daily user sending
limit exceeded`. ⛔ **It is a ROLLING 24-hour window, not a midnight reset** —
capacity returns hour by hour as old sends age out. (I projected relief at
~22:00 from the hourly histogram; it actually arrived ~15:30, because with the
loop dead and alerts capped almost nothing was consuming the allowance. **The
projection is only as good as its assumption about the ongoing send rate.**)

Hourly histogram recipe (both halves, normalised to Eastern) is in §7.

### 2b. Every refusal spawned an infinite bounce chain

`/etc/postfix/sender_canonical_maps` on the PBX contained:

```
/.*/ support@connectcomunications.com
```

with `sender_canonical_classes = envelope_sender`. A bounce notification is
supposed to carry a **blank** envelope sender precisely so it can never bounce
again. This rewrote the blank sender to `support@`, so each bounce was an
ordinary message → relayed to Gmail → refused → bounced → forever.

**2,409 bounces from 66 real emails in one day.** Each nested the previous, so
they grew (one queued message reached **452 KB**). The storm also tripped
Gmail's `454-4.7.0 Too many login attempts`, which then blocked *legitimate*
mail — the loop was actively causing the refusals it fed on.

#### ⛔ The obvious fix DOES NOT WORK

Changing the rule to `/^.+$/` (require at least one character, so a blank sender
matches nothing) **is a no-op**. Verified two ways:

```bash
postmap -q "" regexp:/etc/postfix/sender_canonical_maps   # → empty, rule is correct
```

…and bounces created *after* the change still logged
`from=<support@connectcomunications.com>` at `qmgr` time. **Postfix does not
query the map with an empty key**, so no regexp change can exempt the null
sender. Do not retry this.

#### The fix that works — break the loop at delivery, not at rewriting

```
/etc/postfix/transport:  support@connectcomunications.com discard:bounce-loop-2026-08-06
transport_maps = hash:/etc/postfix/transport
```

A bounce is still created, is routed to `discard:`, and dies there. Proven live
on a real failure:

```
15:11:53.178  Gesheft email refused by Google
15:11:53.184  postfix/bounce: sender non-delivery notification: 2BB471AEE20F
15:11:53.192  postfix/discard: 2BB471AEE20F ... status=sent (bounce-loop-2026-08-06)
15:11:53.192  removed
```

Chain length **1** instead of infinite. Queue went from 645 KB of nested
bounces to empty and stayed empty.

⛔ **Before adding that discard rule, prove nothing legitimate is addressed to
support@ from this box.** It was checked three ways and all three agreed:

```bash
# every message delivered to support@ today — was any of them from Asterisk?
grep "to=<support@connectcomunications.com>.*status=sent" /var/log/mail.log   # 24, all bounce-daemon
grep -c "support@connectcomunications.com" /etc/asterisk/vitalpbx/voicemail__*.conf
#   ^ the ONLY hit is `serveremail=` in voicemail__10-general.conf — the FROM
#     address, not a recipient. No mailbox notifies support@.
```

**Backups:** `/root/sender_canonical_maps.bak-20260806-bounceloop`,
`/root/main.cf.bak-20260806-bounceloop`.

---

## 3. Why the six-hour alert cooldown never worked

`sendAdminAlert()` (apps/api) and `queueAdminAlertEmail()` (apps/worker) both
had a per-key cooldown — **in a `Map`**. The API restarted **56 times** that day
(deploys), and every restart wiped the map and re-armed every alert. That is how
a six-hour gap still produced a message every ~25 minutes.

**Fix — `packages/shared/src/adminAlertBudget.ts`**, root-exported, used by both
api and worker. Two rules, and both matter:

1. **The cooldown is read from the DATABASE**, so a restart cannot re-arm an
   alert. The in-memory map stays as a fast path, never the authority. Identity
   is the alert's **subject**, because that is what survives in `EmailJob`.
2. **A hard ceiling of 40 alert emails per rolling 24h across every key.** Rule 1
   assumes a stable identity; an alert whose text carries a changing count
   ("3 records failed" → "4 records failed") slips past it every time. The
   ceiling is what makes the guarantee hold regardless of future callers.

Replaying the real 451-alert day collapses it to under 40. 12 tests in
`adminAlertBudget.test.ts`, plus all 343 shared tests and 57 api email tests.

⛔ **UNEXPLAINED, DO NOT ASSUME THE CAP WORKS.** Four api-side alerts were still
created at 15:08–15:09, *after* the new container was up and while
`sentLast24h` was ~453 (way over the cap of 40). The container demonstrably runs
the new code (`start` is `tsx src/server.ts`, and `grep -c decideAdminAlert
/app/apps/api/src/server.ts` → 2). The cap should have suppressed them and did
not. **Find this before re-enabling alerts.** Candidate leads not yet chased:
other ADMIN_ALERT creators that bypass `sendAdminAlert` entirely
(`billingEmailLifecycle.ts`, `receiptReconciliation.ts`, `adminSignupReport.ts`,
`journeyTracking.ts`, `setupWatchdog.ts` all create `EmailJob` rows directly),
and boot-ordering around the DB read.

---

## 4. ⛔ LIVE STATE — an alert kill switch is running on loopcom

At Izzy's instruction ("stop alerts emails for now"):

```
/root/alert-email-killswitch.sh      logs to /var/log/alert-killswitch.log
```

Every 5 s it marks any `ADMIN_ALERT` job not already SENT/FAILED as FAILED with
`lastErrorCode: ALERTS_PAUSED`, so alerts never reach the sender. It touches
**only** `type = ADMIN_ALERT`; customer email is never inspected.
**It self-expires 8 hours after ~15:41 ET on 2026-08-06.**

**ALERTING IS THEREFORE OFF.** Nothing is watching for device-registration
failures, wake health, PBX sync failures, or unassigned call records by email
until either it expires or someone stops it (`pkill -f alert-email-killswitch`).
Re-enable deliberately, and only after §3's unexplained gap is understood.

---

## 5. ⛔ Deploy traps that cost most of an hour

- **`deploy-direct.sh` hard-resets the checkout to `origin/<branch>`.** Our
  branch tip lived only locally, so `--branch feat/ivr-migration-takeover`
  silently rolled the checkout back to GitHub's older tip and reported
  `skip=no_changes` / `success`. Use **`--commit <full-sha>`** for anything not
  pushed. (Getting the commit onto the server: incremental `git bundle` from the
  commit the server already has → `scp` → `git fetch <bundle>`; the full-history
  bundle is 653 MB, the incremental one was **6.7 KB**.)
- **`deploy-direct.sh` only accepts `api|portal`.** `worker` is not a valid
  argument — it fails `unknown argument: worker`. The worker goes through the
  **queue** (`POST /ops/deploy/enqueue`), whose field is **`service`** (not
  `target`) and which **requires `branch`** — so a commit-only worker deploy has
  no path, and the worker was left undeployed this session.
- The heavy-build lock is separate from `runningCount`. A parallel session's
  portal build blocked the api deploy for ~17 attempts with
  `HEAVY JOB ALREADY RUNNING`. Wait it out; never `--skip-queue-check`.
- The shared tree moved under us three times (`d30ae026` → `14b1207b` →
  `5486746a` → `d30ae026`). Stage explicit paths; verify with
  `git merge-base --is-ancestor <yours> HEAD` afterwards.

---

## 6. Customer damage, and what was salvaged

**15 messages reached nobody.** Every voicemail RECORDING is safe — there is no
`delete=yes` anywhere in `/etc/asterisk`, and 136 voicemails reached the Connect
app in the same 24h. Only the notification was lost.

| who | lost |
|---|---|
| Gesheft Kosher (ext 101, 102, 114) | 10 voicemails |
| RSBK — Appointments (ext 101) | 1 voicemail |
| Trust Bookkeeping — Mrs. Halpert (ext 105) | 1 voicemail |
| inii mini | 1 voicemail (0 sec, empty) |
| Create A Box | 2 invoices, $130 each |
| McNamara Lion | 1 payment link, $46.65 |

- Both Create A Box invoices **delivered on their own at 15:29** once capacity
  returned. The McNamara Lion payment link (`CC-202608-00006`,
  judaposner@yahoo.com, job `cmsh3bw4f00zho612yw684vey`) was **still FAILED at
  handoff** — requeue it, capacity exists now.
- Two zips were hand-built onto Izzy's desktop for Gesheft:
  `Gesheft voicemails - Aug 6 2026.zip` (6 over 5 seconds) and
  `... - batch 2.zip` (4 more, incl. one in the **Urgent** folder). Each carries
  a `READ ME FIRST.txt` written for the customer — no mention of mail servers or
  sending limits.
- ⛔ **A failed email is NOT retried later.** `550` is permanent: the job goes
  straight to FAILED. Nothing self-heals when quota returns — every one of these
  had to be re-fired or hand-delivered.
- Data-entry bug spotted in passing: Gesheft has a voicemail address
  `Rosnfeld.yoel@gmail.com×` — a stray `×` character. It can never deliver.

---

## 7. Recipes worth keeping

```bash
# Which real voicemail emails failed, mapped to queue time and final outcome.
# (uid=105 = Asterisk. Bounce traffic is noise — exclude it.)
for id in $(grep "^2026-08-06" /var/log/mail.log \
    | grep -oP 'postfix/qmgr\[\d+\]: \K[A-F0-9]+(?=:)' | sort -u); do
  last=$(grep "$id:.*status=" /var/log/mail.log | tail -1)
  echo "$last" | grep -q "status=sent" && continue
  echo "$(grep -m1 "$id:.*from=<" /var/log/mail.log | cut -c1-19) | $last"
done
```

⛔ Take the outcome from the message's **last** log line, not the first — a
message can defer several times and then bounce, so an early `deferred` and a
late `bounced` are the same message, not two.

```bash
# Match a failed email to its recording (caller, length, mailbox).
for f in $(find /var/spool/asterisk/voicemail/<ctx>-voicemail -name "msg*.txt" \
           -newermt "14:00"); do
  echo "$(stat -c %y "$f" | cut -c1-19) | $(grep -m1 ^duration= "$f" | cut -d= -f2)s \
| $(grep -m1 ^callerid= "$f" | cut -d= -f2-) | $f"
done | sort
```

⛔ Messages are **not** all in `INBOX` — one Gesheft casualty was in
`101/Urgent/`. Search the mailbox root, not `*/INBOX/*`.

- Mailbox → email address mapping lives in
  `/etc/asterisk/vitalpbx/voicemail__50-<tenant>-main.conf`
  (`<ext> => <ext>,<label>,<email>,...`).
- Queue ids in `mailq` carry a trailing `*` (active) or `!` (hold).
  `postsuper -d` rejects them — strip with `sub(/[*!]$/,"",id)`.
- The mail log is **local time with an ISO stamp**; the Connect DB is **UTC**.
  Normalise before building any histogram or you will misread a whole day.

---

## 8. Open at handoff

1. ⛔ **The worker is undeployed** — still runs the old in-memory cooldown. It is
   the source of every "Device not registered" alert. Needs the branch pushed to
   GitHub, then a queue deploy.
2. ⛔ **§3's unexplained cap bypass.** Do not turn alerts back on until it is
   understood.
3. **The kill switch expires ~23:41 ET 2026-08-06** and alerting silently
   returns to its old behaviour at that moment unless the worker is deployed.
4. **The McNamara Lion payment link is still unsent.**
5. **The real fix was never done:** alerts and customer mail still share one
   mailbox and one 500/day allowance. Izzy was offered a second mailbox as the
   sending account for voicemail (fresh 500/day, permanent separation) and
   never supplied the address. Until they are separated, any future noisy day
   silently stops customers' invoices and voicemails again.
