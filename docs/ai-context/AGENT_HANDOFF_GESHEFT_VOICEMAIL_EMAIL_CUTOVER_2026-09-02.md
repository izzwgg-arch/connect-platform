# AGENT HANDOFF — Gesheft's voicemail-to-email moved from the PBX to Connect, and the old domain is gone (2026-09-02)

Izzy, 2026-09-02: *"change ext 102's voicemail email to orders@gesheftkosher.com — only if
voicemail emails from Loopcom have been working flawlessly, none of them failed to send, then
you can flip the switch for their voicemail to email to Loopcom as well. Leave both of them on
for like 15 minutes to make sure none of them gets lost in the switch."*

All three done. **No voicemail was lost** — proven by counting both sides during the overlap.
Gesheft was the LAST tenant on the PBX's own voicemail-to-email; **the exclusion list is now
empty and the PBX emails nobody.**

## 1. The gate — was Connect's voicemail email flawless?

Measured, not assumed. The window that matters is since `6136f462` (2026-08-27 18:19Z), the
fix that closed the audio-copy race:

| check | result |
|---|---|
| `VOICEMAIL_NOTIFICATION` jobs since the fix | **55, all SENT, 0 FAILED, 0 error codes** |
| non-Gesheft voicemails never stamped past the 10-min grace | **0** |
| `no_recording` rows that still have audio (the race) | **0** |
| delivery on every calendar day since the fix | **7 of 7** (11/14/3/5/6/12/4) |
| distinct recipients served | 18 |
| all-time FAILED voicemail emails | **0 of 165** |
| guardrail heartbeats | sweep 41 s old, watchdog 8 min, coverage + blind-mailbox hourly, all fresh |
| alarms ever fired | 1 — the 2026-08-21 watchdog false alarm (deploy churn, documented) |

⛔ **One pre-fix casualty exists and it is stated here, not hidden: B Visible ext 111,
2026-08-19 17:10, a 10-second voicemail stamped `no_recording` 14.5 s after arrival, audio present
today, never emailed.** It is 8 days BEFORE the fix that closed exactly that hole, and it was
already outside the 7-day self-heal window when the fix deployed, so the self-heal could never
reach it. It is evidence the fix was needed, not evidence the mechanism is failing now. **Gate:
PASS.**

## 2. ext 102 → `Orders@gesheftkosher.com`

The old domain lived in exactly one live place: `ombutel.ombu_extensions.email` (tenant 8,
ext 102) + the generated `voicemail__50-8-main.conf`. **14 emails had been delivered to
`Orders@pileupny.com` in the preceding 24 h**; ext 102 takes 235 voicemails / 30 days.

Changed BOTH halves (the DB is what a regen reads; the conf is what Asterisk loads), then
`voicemail reload`. ⛔ The conf carries panel ACLs (`+` in `ls -l`), so it was written
`sed > tmp; cat tmp > file` — inode `15730784` and the ACL mask verified identical before and
after. A bare `sed -i` here replaces the inode and locks the panel out (documented).

Afterwards: `grep -r pileupny /etc/asterisk/` → **0**, `ombu_extensions` on pileupny → **0**.

## 3. The cutover

### 3a. The trap that would have flooded the platform — found BEFORE flipping

The exclusion is `VOICEMAIL_EMAIL_EXCLUDED_TENANT_IDS` in `.env.platform` (line 111), read at
call time by `voicemailEmailExcludedTenantIds()`. An excluded tenant's voicemails are
**deliberately never stamped** (the code said so — "so they stay eligible the day they are
un-excluded"). The sweep window is **7 days**.

Measured: **334 unstamped Gesheft voicemails inside the window** (272 on ext 101, 59 on 102).
Un-excluding without doing anything else would have emailed **all 334 in the first seven
sweeps** — a week of duplicates the customer already received from the PBX, and roughly two
thirds of the platform's shared **500/day Gmail allowance** spent in seven minutes, which is the
2026-08-06 outage shape (invoices, password resets and pay links refused for the rest of the day).

**Fix: stamp the backlog first.** All **699** unstamped Gesheft rows (334 in-window + 365
older) → `emailedAt = now()`, `emailSkipReason = 'predates_feature'`. That reason is in the
watchdog's `DELIBERATE_SKIPS` list, so it can never raise an alarm, and it is the honest label:
Connect did not email these, the PBX did. Ids backed up to
`loopcom:/root/gesheft-backlog-ids-20260902.txt`. Reversal is `emailedAt = null` on those ids —
⛔ but never do that while the tenant is un-excluded, or the flood happens.

Verified after stamping: `would_flood_on_unexclusion = 0`, and 0 rows of any other tenant touched.

### 3b. Recipients before the switch, not after

Connect resolves recipients as `Extension.pbxUserEmail` (a mirror of the PBX) **plus**
`VoicemailEmailRecipient` rows, de-duplicated by address. Gesheft had **0** recipient rows. The
2026-08-18 outage was exactly "blank the PBX, the mirror blanks, nobody has a recipient".

Created **7** `VoicemailEmailRecipient` rows, one per addressed mailbox, copied from the PBX as it
stood after the ext 102 change:

| ext | address |
|---|---|
| 101 | Orders@gesheftkosher.com |
| 102 | Orders@gesheftkosher.com |
| 107 | tod10950@gmail.com (⚠️ that is Izzy's alert address, on a Gesheft mailbox named "Customer Phone 2" — copied faithfully, flagged) |
| 109 | contact@gesheftkosher.com |
| 111 | Scn@Gesheftkosher.com |
| 114 | ap@gesheftkosher.com |
| 115 | scn@gesheftkosher.com |

All 7 have `vmEmailEnabled = true`.

### 3c. The switch

`.env.platform:111` → `VOICEMAIL_EMAIL_EXCLUDED_TENANT_IDS=` (empty). Backup
`.env.platform.bak.20260902T153841Z.gesheft-vm-cutover`; diff = exactly one line. ⛔ Rule 10
puts that file behind a human go-ahead; Izzy's "flip the switch" IS that go-ahead — the env line
is the switch.

An env-only change never rebuilds (`skip=unrelated_paths`), so it rode a real `apps/api/`
commit: `8188ff36` corrects the two comments that named Gesheft as "still emailed by the PBX"
and records the backlog trap in `buildVoicemailSweepWhere`. Comment-only; voicemail suite
117/117; 0 typecheck errors in the touched files.

⛔ **GitHub 401'd the server's fetch** (the documented per-IP throttling). Route: incremental
`git bundle` → scp → `git fetch <bundle>` into the app clone → bare mirror
`/root/connect-mirror.git` → `set-url origin <mirror>` → `deploy-direct.sh api` → **`set-url`
back to GitHub + mirror removed** (done, verified). Deploy `8188ff36`: blue/green, 0 restarts,
`VOICEMAIL_EMAIL_EXCLUDED_TENANT_IDS=[]` read from the running container.

⚠️ **The deploy also shipped `53fb9c52`** (another session's manual-pay invoice automation).
Checked before deploying: it is opt-in per tenant and exactly ONE tenant has the flag — Yossis
Wood Works, the tenant that commit was written for, billing day 4, autopay off. That session set
the flag deliberately; deploys here ship the branch tip. Stated so nobody is surprised.

### 3d. The overlap — 15:53:01Z → 16:11Z (18 minutes)

Three voicemails arrived while BOTH systems were on:

| ext | arrived | length | Connect | PBX |
|---|---|---|---|---|
| 101 | 15:53:23 | 14 s | SENT 15:54:47 | sent |
| 102 | 15:53:42 | 4 s | SENT 15:54:47 | sent |
| 101 | 15:58:25 | 143 s | SENT 16:01:47 | sent |

Connect: 3 jobs, 3 SENT, 0 errors. PBX `mail.log`: 3 × `status=sent` to Orders@gesheftkosher.com.
**Every voicemail in the window was delivered by both sides. Nothing lost.**

⛔ **The first Connect email went to BOTH `orders@pileupny.com,orders@gesheftkosher.com`.** The
5-minute PBX auto-sync (`pbx_auto_sync_scheduled, intervalMs 300000`) ran at 15:53:17 — the
api's first minutes after the deploy — and wrote `pbxUserEmail = orders@pileupny.com` back onto
ext 102, even though the PBX database had held `gesheftkosher` for 18 minutes and a
whole-database sweep of `ombutel` found zero pileupny anywhere. **The VitalPBX REST layer
serves cached extension data** — the tenant-list staleness this repo already records, extended
to extensions. Corrected the mirror by hand at 15:58; watched **three further sync cycles**
(16:02, 16:03, 16:07) leave it on `gesheftkosher`, so the cache had refreshed. One duplicate to
the old domain, no loss.

### 3e. Switching the PBX off

Regenerated `RESTORE.sql` to the post-102-change addresses FIRST (the original backup would have
restored pileupny), then blanked the 3rd comma field for all 7 mailboxes in BOTH
`ombu_extensions.email` (0 rows with an address after) and the conf (0 lines with `@` after),
inode-preserving, then `voicemail reload`. Backups:
`pbx:/root/gesheft-vm-email-cutover-20260902T153346Z/` — original conf, pre-blank conf,
`ombu_extensions_emails_tenant8.tsv`, `RESTORE.sql`.

⛔ **`preserveBlankedPbxEmail` would have made pileupny PERMANENT** had it been left in the
mirror: it takes the CURRENT `pbxUserEmail` and, when the PBX goes blank, upserts it into
`VoicemailEmailRecipient`. That is precisely why the mirror was corrected and watched stable
before blanking. Verified after: recipients unchanged (7 rows, 0 pileupny).

⚠️ The mirror had NOT blanked 8 minutes after the switch-off — the same REST cache. Harmless:
Connect dedupes, so a stale `gesheftkosher` mirror beside a `gesheftkosher` recipient row is one
email. When the cache refreshes, the promotion upserts `gesheftkosher` (already present → no-op).

## 4. Proof of the end state

- PBX: `grep -rE "^[0-9]+ => [0-9]+,[^,]*,[^,]+@" voicemail__50-8-main.conf` → **0**; DB → **0**.
- Connect: 7 recipient rows, all correct; `pileupny` in recipients/mirrors → **0**.
- Exclusion list: **empty** in the running container.
- **Post-switch-off delivery: see §4a below** (filled in once the first voicemail after the PBX
  went quiet landed).

### 4a. First voicemail after the switch-off

✅ **PROVEN.** ext 101, received **16:35:07Z** (144 s, from 8453253408) — 24 minutes after the PBX went
quiet. Connect's sweep logged `queued: 1`; `EmailJob` created **16:37:48**, **SENT 16:37:59** to
`orders@gesheftkosher.com`, no error. The PBX's `mail.log` shows **0** voicemail sends for Gesheft
after 12:11 local. **Connect alone delivers; the PBX is off.**

⛔ Method note: a query at 16:37:44 found the `Voicemail` row EMAILED but NO `EmailJob` — the job
was created at 16:37:48, four seconds later. `markProcessed` and `queueEmail` are two writes in one
sweep pass; read both again before calling an EMAILED-without-a-job a fault.

## 5. What is deliberately NOT changed

- The Connect **login** `orders@pileupny.com` (ACTIVE, created 2026-04-06 by the PBX sync, never
  invited, never signed in, owns ext 102). ⛔ Never `resend-invite` it — that mails a
  create-your-password link to the old domain. Rename/reassign is Izzy's call.
- `pileupny.com` still has live Google MX; nothing was done to that domain.
- Gesheft's 10 blind mailboxes (103,104,105,106,108,112,116,117,118,897) stay blind — same as on
  the PBX. Only 1 of their last 273 voicemails landed on one.
- ext 107's recipient is `tod10950@gmail.com` — copied from the PBX, flagged, not changed.

## 6. Rollback

1. Re-exclude in `.env.platform` + api deploy (needs a real apps/api commit) — Connect stops.
2. `mysql ombutel < RESTORE.sql` + `cat voicemail__50-8-main.conf.pre-blank > <conf>` +
   `voicemail reload` — PBX resumes. ⛔ `cat`, never `cp` (ACLs).
3. ⛔ Do NOT un-stamp the 699 rows unless the tenant is excluded again first.

## 7. Lessons that outlive this tenant

- **Un-excluding a tenant from Connect's voicemail email must be preceded by stamping its
  backlog.** The code comment said the opposite ("so they stay eligible") and is wrong at any
  real volume. Fixed in the comments (`8188ff36`).
- **The VitalPBX REST layer caches extension records** — after a direct MySQL edit, expect the
  api's 5-minute sync to write the OLD value once or twice before it catches up. Check
  `Extension.updatedAt` against the sync interval before concluding a write "didn't take".
- **Before blanking a PBX email, make sure the Connect mirror holds the value you want
  promoted** — `preserveBlankedPbxEmail` promotes whatever is there.
- **A cutover's backup must be regenerated after any intermediate change** — the first
  `RESTORE.sql` here would have restored the old domain.
