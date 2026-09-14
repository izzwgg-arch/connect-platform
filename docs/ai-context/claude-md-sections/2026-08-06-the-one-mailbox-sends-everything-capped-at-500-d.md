# ⛔⛔ THE ONE MAILBOX SENDS EVERYTHING, CAPPED AT 500/DAY (2026-08-06) — READ FIRST for ANY email/voicemail-notification report, before adding an ADMIN_ALERT, or before believing a mail fix worked

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


> ⛔ **ALERT EMAILS ARE OFF AGAIN — and this time it is CODE, not an expiring
> script.** History: the 2026-08-06 kill switch self-expired, so alerts ran for
> five days (`08-06 399` → `08-08…08-11` pinned at **40/day** by the
> rolling-24h ceiling). On **2026-08-11 ~22:18 EDT** a proper mute landed
> (Izzy's directive) and has held since — see the section below on the
> **ALERTS_MUTED send-door gate**, which is now the authority on this topic.
>
> ⛔ **Correction, so nobody repeats it:** an earlier pass of this file read the
> `08-12 skipped=34` rows as the **40/day budget ceiling** doing its job. That
> was wrong — those skips are the **new mute gate** (`lastErrorCode
> ALERTS_MUTED`). The ceiling and the gate produce similar-looking suppression;
> **tell them apart by `lastErrorCode` on the `EmailJob` row**, never by the
> status alone.

Full handoff: **`docs/ai-context/AGENT_HANDOFF_MAIL_QUOTA_BOUNCE_LOOP_2026-08-06.md`**
(commit `0197dd56` on `feat/ivr-migration-takeover` — **api DEPLOYED and
container-verified; ⛔ the WORKER half is committed and NOT deployed.**)

- ⛔ **THE RULE: a quiet log is not a fixed bug — prove there was TRAFFIC in the
  window you measured.** The bounce loop was declared fixed after **four minutes
  of zero bounces**. It was not fixed; it ran **135 more**. Those minutes were
  quiet because *no mail had been sent in them* — zero voicemails were recorded
  fleet-wide. Check `find /var/spool/asterisk/voicemail -name "msg*.txt"
  -newermt "<start>" | wc -l` before concluding anything about mail. Same trap in
  another costume: `postmap -q "" <map>` proves the RULE, never the BEHAVIOUR.
- ⛔ **ONE mailbox sends everything Connect sends** — invoices, invites, password
  resets **and the PBX's voicemail-to-email**, all as
  `support@connectcomunications.com` — and Google caps it at **500/day**. On
  2026-08-06 our own **ADMIN_ALERT emails took 402 of 499**, and every customer
  email for the rest of the day was refused. **15 messages reached nobody**: 10
  Gesheft voicemails, RSBK, Trust Bookkeeping, inii mini, two $130 Create A Box
  invoices, one payment link. ⛔ The limit is a **rolling 24h window, not a
  midnight reset**, and ⛔ **a 550 refusal is permanent — nothing is retried when
  capacity returns.** Recordings are always safe (`delete=yes` appears nowhere);
  only the notification is lost.
- ⛔ **HISTORICAL — the kill switch described here is DEAD; do not act on it.**
  `/root/alert-email-killswitch.sh` on loopcom marked every `ADMIN_ALERT` job dead
  before the sender saw it (customer email was never touched). **It self-expired
  ~23:41 ET 2026-08-06 and alerts silently ran for five more days** — the exact
  failure that motivated replacing it. The script still sits on disk, inert; there
  is nothing to `pkill` and nothing to lift. Alerts are now muted **in code** at
  the send door — see the `ALERTS_MUTED` section at the TOP of this file, which is
  the authority. **Lesson kept on purpose: a mitigation with a timer in it is not a
  fix, and its expiry will not announce itself.**
- ⛔ **The alert cooldown was in a `Map`.** The API restarted **56 times** that
  day and every restart re-armed every alert — that is how a six-hour cooldown
  sent one message every 25 minutes. Now `packages/shared/src/adminAlertBudget.ts`:
  the cooldown is read from the **database** (identity = the subject, since that
  is what survives in `EmailJob`), plus a **hard ceiling of 40 alert emails per
  rolling 24h across every key** — because a subject carrying a changing count
  defeats any per-key cooldown. ⛔ **UNEXPLAINED: four api alerts were still
  created while the count was ~453. Do not re-enable alerts until that is
  understood**, and remember several files create `ADMIN_ALERT` rows *without*
  going through `sendAdminAlert` (`billingEmailLifecycle`, `receiptReconciliation`,
  `adminSignupReport`, `journeyTracking`, `setupWatchdog`).
- ⛔ **The bounce loop: `sender_canonical_maps` was `/.*/ → support@`, which
  rewrites the BLANK sender that makes a bounce un-bounceable.** 2,409 bounces
  from 66 real emails, each nesting the last (one queued message hit **452 KB**),
  and the storm tripped Gmail's `454 Too many login attempts` — so the loop was
  causing the refusals it fed on. ⛔ **Changing the rule to `/^.+$/` IS A NO-OP —
  Postfix never queries the map with an empty key.** The fix that works breaks the
  loop at *delivery*: `support@connectcomunications.com discard:` in
  `transport_maps`. Safe only because **nothing legitimate is addressed to
  support@ from that box** — all 24 delivered that day were bounces, and the one
  config hit is `serveremail=` (the FROM address). Backups
  `/root/{sender_canonical_maps,main.cf}.bak-20260806-bounceloop`.
- ⛔ **Deploy traps:** `deploy-direct.sh` **hard-resets to `origin/<branch>`**, so
  a local-only commit is silently rolled back and reported `success` /
  `no_changes` — use `--commit <full-sha>` (ship it with an *incremental* `git
  bundle`: 6.7 KB vs 653 MB for full history). And `deploy-direct.sh` **does not
  accept `worker`** — that goes through `POST /ops/deploy/enqueue`, whose field is
  **`service`** (not `target`) and which **requires `branch`**, so a commit-only
  worker deploy has no path.
- **Still open:** the worker deploy; the unexplained cap bypass; the McNamara Lion
  payment link (`CC-202608-00006`) still unsent; and the real fix — **alerts and
  customer mail still share one mailbox and one 500/day allowance.** A second
  sending mailbox was offered and never supplied.
