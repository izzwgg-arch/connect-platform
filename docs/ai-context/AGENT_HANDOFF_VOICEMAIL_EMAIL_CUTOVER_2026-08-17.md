# AGENT HANDOFF — voicemail email moved from the PBX to Connect for every tenant except Gesheft (2026-08-17)

**LIVE PBX CHANGE, applied 2026-08-17 17:34 EDT under Izzy's explicit
instruction** ("switch it off. not gesheft"). No code, no deploy, no Apply
Changes, no Connect data change. Read this before touching voicemail email,
before re-enabling anything on the PBX, or for "why did this customer stop
getting voicemail emails".

Companion: `AGENT_HANDOFF_VOICEMAIL_EMAIL_PBX_2026-08-09.md` (how the PBX chain
works and why the address field is the whole switch).

---

## 1. What changed

Until today **two systems emailed the same voicemail**. The PBX had been doing it
for years; Connect's own sender went live earlier this session. Customers were
getting doubles — proven, not inferred: on 2026-08-17
`fhalpert@trustbookkeepingny.com` received **6 emails from the PBX and 5 from
Connect** in the same day.

Now exactly one system emails each tenant:

| | sender |
|---|---|
| **Gesheft** (PBX tenant **8**) | **the PBX**, unchanged |
| every other tenant (26 confs) | **Connect** |

## 2. How it was switched off — and the two halves are both required

⛔ **The email address is the switch.** An empty 3rd comma field in
`voicemail__50-<pbxTenant>-main.conf` means Asterisk generates no email at all —
no error, no log line. Nothing else was touched: PIN, name, timezone, `attach`,
`emailbody` and every other option are byte-identical.

Both halves were done, and **each alone would have failed**:

1. **`ombutel.ombu_extensions.email` set to `""`** where `tenant_id <> 8`
   (55 rows → 0; Gesheft's 7 untouched). This is the source VitalPBX renders
   from. ⛔ Without this, the next tenant regen puts every address back and
   duplicate emails silently resume.
2. **The generated confs rewritten** (26 files, tenant 8 skipped) + `voicemail
   reload`. ⛔ Without this the DB is right but Asterisk keeps emailing, because
   it reads the conf, not the database.

⛔⛔ **Apply Changes was deliberately NOT used**, even though it is the "correct"
way to regenerate. It wipes the Connect doorway off every route of every tenant
with pending changes and sends live callers to dead air. Baking the conf directly
and reloading achieves the same result with no call-path risk.

⛔ Files were written with `cat tmp > file`, never `cp` — that directory carries
POSIX ACLs and is owned `www-data:www-data`; replacing the inode is how the panel
gets locked out of its own configs. Verified `-rw-rw-r--+ www-data:www-data`
after the change.

## 3. The safety check that gated this — repeat it before any similar cutover

The question is not "does Connect send emails", it is **"is there any mailbox the
PBX emails today that Connect would not"**. Once the PBX is off, every Connect
skip becomes a genuinely missed notification, and Izzy's standing rule is that a
voicemail email must *never* silently fail to go out.

All 53 PBX mailboxes that emailed (excluding Gesheft) were joined against
Connect's recipients: **53 covered, 0 would go dark.**

The three categories where Connect deliberately stays silent were each checked
and are all safe — ⛔ **do not assume this stays true**:

- **`too_short` (10 in 7 days)** — every one was **0 or 1 second**
  (`MIN_VOICEMAIL_SECONDS_FOR_EMAIL = 2`). Hang-ups with no message. The PBX used
  to email these; losing them is an improvement, but it *is* a behaviour change.
- **`no_recording` (6 in 7 days)** — **all on Loopcom Demo**, whose PBX addresses
  are `loopcom.review@example.com` / `loopcom.maya@example.com`. Fake addresses,
  so nothing real was ever delivered. ⛔ A 41-second voicemail reading
  `no_recording` is otherwise a red flag worth chasing.
- **`no_recipient` (3 in 7 days)** — Trimpro ext 102 and A plus center ext 108.
  ⛔ **Neither has an email on the PBX either**, so they were already blind and
  nothing regressed. A plus 108 is the known blind mailbox from the 2026-08-09
  handoff.

## 4. Rollback

Everything needed is on the PBX in **`/root/vm-email-switchoff-20260817-173339/`**:

- `ombu_extensions_emails.tsv` — all 62 address rows as they were
- `RESTORE.sql` — 62 ready-made `UPDATE` statements
- `voicemail-confs.tar.gz` — the 27 generated confs

To reverse: `mysql < RESTORE.sql`, untar the confs over
`/etc/asterisk/vitalpbx/`, then `asterisk -rx "voicemail reload"`. Customers
would immediately be back to receiving two emails per voicemail.

## 5. State at handoff

- ✅ 0 non-Gesheft mailboxes carry an address, in the DB **and** in the confs
- ✅ Gesheft: 7 addresses intact, still emailing
- ✅ 117 mailboxes still registered with Asterisk — **voicemail recording itself
  is unaffected**; only the notification changed
- ✅ Connect: `VOICEMAIL_EMAIL_ENABLED=1`, Gesheft excluded by tenant id
  `cmnlgnumu0001p9g6xyl1pbdd`, **13 emails SENT / 0 failed**, watchdog clean
  (0 open escalations)

## 6. ⏳ NOT PROVEN

**No voicemail has arrived since the cutover.** It is proven as configuration and
as Asterisk's own reloaded state — *not* by watching a real voicemail produce
exactly one email.

**The acceptance test**, on the next real non-Gesheft voicemail:
1. `grep "to=<" /var/log/mail.log` on the PBX shows **only** gesheftkosher /
   pileupny addresses after `2026-08-17 17:34 EDT`
2. the recipient gets **one** email, from Connect, with the recording attached
3. Gesheft still receives its PBX email as before

⛔ **Watch the `no_recording` reason.** It is the one skip that could hide a real
missed notification now that nothing else emails. If it starts appearing on a
real tenant, that customer is silently getting nothing.
