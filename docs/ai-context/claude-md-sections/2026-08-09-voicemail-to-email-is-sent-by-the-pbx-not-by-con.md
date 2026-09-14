# ⛔⛔ AGENT HANDOFF — voicemail-to-email is sent BY THE PBX, not by Connect (2026-08-09) — READ FIRST for ANY "customer didn't get their voicemail email", and before looking inside Connect for it

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_VOICEMAIL_EMAIL_PBX_2026-08-09.md`**
(**Read-only investigation — no deploy, no code change, no PBX write.** Evidence
current to 2026-08-09; §7 and §11 re-verified 2026-08-12.)

> ⛔⛔ **SUPERSEDED FOR EVERY TENANT EXCEPT GESHEFT, 2026-08-17 — the title of
> this section is now TRUE ONLY FOR GESHEFT.** Connect's own voicemail email went
> live and the PBX's was switched off everywhere else, on Izzy's instruction
> ("switch it off. not gesheft"). Cutover handoff:
> **`docs/ai-context/AGENT_HANDOFF_VOICEMAIL_EMAIL_CUTOVER_2026-08-17.md`**.
> **So "the customer didn't get their voicemail email" is now a CONNECT question
> for 26 tenants and a PBX question for Gesheft (PBX tenant 8) only** — establish
> which before investigating, exactly as the rule below says.
> ⛔⛔ **AND THE CUTOVER BROKE CONNECT'S SIDE FOR ~20 HOURS** — the blanked PBX
> field is mirrored into `Extension.pbxUserEmail`, so Connect lost every
> recipient too. Fixed 2026-08-18; recipients now live in
> `VoicemailEmailRecipient`. See the dedicated section near the top of this file.
> ⛔ **The mechanism is the same either way: the address is the switch.** The 3rd
> comma field was emptied in BOTH `ombutel.ombu_extensions.email` (55 rows → 0)
> and the 26 generated confs, then `voicemail reload`. **Both halves are
> mandatory** — DB only and Asterisk keeps emailing; conf only and the next regen
> puts every address back. ⛔ **Apply Changes was deliberately NOT used** (it
> wipes the Connect doorway and sends live callers to dead air).
> ⛔ **It was gated on a coverage join, not on optimism**: all 53 PBX mailboxes
> that emailed were checked against Connect's recipients — **53 covered, 0 would
> go dark** — and each category where Connect stays silent was cleared
> individually (`too_short` = 0–1 s hang-ups; `no_recording` = all Loopcom Demo,
> whose PBX addresses are fake `@example.com`; `no_recipient` = mailboxes already
> blind on the PBX too). **Repeat that join before any similar cutover.**
> Rollback: `/root/vm-email-switchoff-20260817-173339/RESTORE.sql` + the conf
> tarball on the PBX. ⏳ **NOT PROVEN: no voicemail has arrived since the
> cutover.**

- ⛔ **THE RULE: the voicemail emails customers receive come from Asterisk on the
  PBX. Connect has nothing to do with them.** This session opened inside Connect,
  found Connect's own voicemail-email job had never processed a single row, and
  was about to report that as the cause. It is a *different, unshipped feature*.
  Izzy had to redirect: *"you're supposed to look inside the PBX."* **Two systems
  can email the same voicemail — establish which one the customer actually
  receives before diagnosing anything.**
- **The live chain:** `app_voicemail` → the mailbox's email address in
  `/etc/asterisk/vitalpbx/voicemail__50-<pbxTenantNum>-main.conf`
  (`<ext> => <pin>,<Name>,<EMAIL>,,attach=yes|…` — the **3rd comma field**) →
  `mailcmd=/usr/share/vitalpbx/scripts/voicemail2email` → postfix →
  `sender_canonical_maps /^.+$/` rewrites the sender to
  `support@connectcomunications.com` → authenticated `smtp.gmail.com:587`.
  ⛔ **An EMPTY 3rd field means no email is ever generated** — no error, no log
  line, nothing to find later. ⛔ `voicemail2email` is **ionCube-encrypted PHP**
  and cannot be read; judge it only by `/var/log/mail.log`.
- ⛔ **THE REAL "missing emails": 58 mailboxes platform-wide have no address**, so
  **108 of 2,674 voicemails in 30 days (4%) never notified anyone.** Worst: **A
  Plus ext 108 "Home" 45**, **Gesheft ext 112 11**, Create A Box ext 101 8 (one
  255s). Gesheft's blind mailboxes: **103,104,105,106,108,112,116,117,118,897**.
  ⛔⛔ **Gesheft ext 102 "Customer Service" STILL emails every voicemail to
  `Orders@pileupny.com` — the OLD domain, and it is LIVE, not a leftover string**
  (re-verified read-only 2026-09-02). It is the ONE place on the platform where the
  old domain survives: `ombu_extensions.email` for tenant 8 AND the generated
  `voicemail__50-8-main.conf` both carry it, Asterisk has the mailbox loaded, and
  **14 messages were delivered to it in the last 24 h (`status=sent`)**. Ext 102 takes
  **235 voicemails / 30 days (60 in the last 7)** — their second-busiest mailbox after
  101. ⛔ **It is live precisely BECAUSE Gesheft is the one tenant left on the PBX's
  own voicemail-to-email** (the 2026-08-17 cutover switched every other tenant off), so
  it was untouched by that pass and cannot be fixed from Connect — it is a PBX write.
  ✅ **The rest of Gesheft is CLEAN**: no `VoicemailEmailRecipient` row, no billing
  address, no `EmailJob` ever sent there (0, all time), and **texts never touch it** —
  all 6 Gesheft users have `smsEmailForwardEnabled = false` and the carrier's own
  `sms_email` on 845-244-9666 is `Orders@gesheftkosher.com`. A sweep of EVERY
  email-shaped column in the whole database returns exactly TWO pileupny hits, both
  inert mirrors of the PBX value: `User.email` and `Extension.pbxUserEmail`.
  ⚠ `pileupny.com` still has live Google MX, so the mail is landing somewhere —
  **needs Izzy's word on whether that mailbox is still read.**
  ⚠ There is also a Connect LOGIN `orders@pileupny.com` (ACTIVE, created 2026-04-06
  by the PBX sync, never invited, never signed in) owning ext 102 — the documented
  April-sync trap. ⛔ Do NOT "fix" it with `resend-invite`: that would send a
  create-your-password mail to the old domain.
- **The mechanism itself is healthy — do not re-litigate transport.** On
  2026-08-09: **33 voicemails → 29 in email-configured mailboxes → 29 sent, 30/30
  postfix deliveries `status=sent`, zero failures**, all queues empty, and
  `/var/mail/root` holds **381 cron mails and not one bounce** in over a year.
  Gesheft ext 101 was **12-for-12**. Every recipient domain is Google Workspace
  with `include:_spf.google.com` and we relay through authenticated Gmail, so
  `250 OK … gsmtp` means Google took it — after that it is inbox-or-spam on the
  customer side. **Size is a non-issue:** ~**4.3 KB of email per second of audio**
  (it compresses; it does not attach the raw 16 KB/s wav) against a **10 MB**
  limit.
- ⛔ **NO MAIL HISTORY SURVIVES PAST THE CURRENT DAY — this is why the question
  had no hard answer.** `mail.log.1` is **1 byte**; the journal is
  **runtime-only** (no `/var/log/journal`) and starts `00:00:01`;
  `/var/log/asterisk/full` starts `00:00:01` with **no `full.1`**; `mail.*` is
  routed nowhere but `mail.log`; **no remote syslog.** Every midnight the previous
  day's evidence is destroyed. **Fixing retention is the highest-value follow-up
  in the handoff** — without it the next identical complaint gets the same
  non-answer.
- ⛔ **Connect's own sender has NEVER run:** `AGENT_VOICEMAIL_EMAIL` is set
  **nowhere** (container, `.env.platform`, compose), while
  `AGENT_VOICEMAIL_TRANSCRIBE=1` **is** — which is why transcripts land and
  Connect emails never do. Proven, not inferred: `emailedAt` is stamped even for
  skips, and it is **null on all 289 voicemails 08-09→08-13**. ⛔ Before anyone
  enables it: a failed send returns **without stamping**, so the row silently
  ages out of the **30-minute** window forever with no `emailError` — and the
  agent's notifier has **no SMTP configured at all**, so today it would send
  nothing while burning each window.
- ⛔ **Gesheft ext 101 is 853 messages from a hard wall:** `maxmsg=9999` and its
  INBOX holds **9,146** (102 holds 2,612). At ~35/day that is **3–4 weeks** until
  Asterisk plays "mailbox full" and **the message is not recorded at all** — no
  voicemail, no email, no Connect row, nothing in the log. It will present as "we
  stopped getting voicemail emails".
- **Verified, do not re-derive:** the PBX runs **EDT**;
  `Voicemail.receivedAt` **is exactly** the spool `origtime` epoch (**40/40** over
  Aug 8–9, absolute UTC); **Connect's ingest is reliable** — 40 spool ↔ 40 rows,
  1:1 on ext/duration/caller/origtime, so nothing "failed to save".
- ⛔ **Alert emails: this bullet used to say "alerting is back ON" and that is now
  wrong twice over — see the `ALERTS_MUTED` section at the TOP of this file, which
  is the authority.** Short version: the 2026-08-06 kill switch expired, alerts ran
  five days at the ceiling's 40/day, then a **code-level mute landed 2026-08-11
  ~22:18 EDT** and they stopped. ⛔ The mistake worth avoiding: I read the
  `08-12 skipped=34` rows as the 40/day ceiling; they were the mute. **Tell them
  apart by `lastErrorCode`** (`ALERTS_MUTED` = mute, empty = ceiling), never by
  status. The mailbox-sharing problem outlives the mute: customer invoices and
  every voicemail notification still share one 500/day allowance.
- ⛔ **Never check for a process with `pgrep -f` over ssh** — it matched its own
  command line and reported the kill switch alive. Use
  `ps -eo pid,etime,cmd | grep "[a]lert-email-killswitch"`. Documented three times
  already and it still cost a wrong reading.
- **The 845-274-6215 case:** the voicemail is **NOT lost** —
  `gesheft-voicemail/101/INBOX/msg9132.wav`, 1,563,884 bytes, **97s**, left **Sat
  2026-08-08 23:06:40 EDT** into ext 101, and in Connect
  (`cmsl83ilealfdqn1313zni9az`). **It left no voicemail "today"** — on 08-09 at
  11:06:42 it called again and **ext 102 answered, talking 6m43s**. Whether its
  email sent is **unprovable** (behind the midnight wall). The check only Izzy can
  run, in `Orders@gesheftkosher.com` incl. Spam/Trash:
  `from:support@connectcomunications.com after:2026/08/08 before:2026/08/10`.
