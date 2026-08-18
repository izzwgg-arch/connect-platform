# ⛔⛔ AGENT HANDOFF — voicemail email was DEAD platform-wide for ~20 hours: the cutover erased Connect's own recipients, Gesheft blocked the sweep, and the watchdog had never run (2026-08-18) — FIXED the same day

**Status at the end of 2026-08-18: ✅ FIXED, DEPLOYED and PROVEN LIVE.**
`6961ea9e` (sweep + watchdog select) and `47c3ff45` (watchdog grace) on
`feat/ivr-migration-takeover`; **api container-verified**; **53 recipient
addresses restored into Connect** from the PBX backup; **9 voicemail emails
SENT / 0 failed within an hour of the deploy, 11 by 18:10Z**. No PBX write, no migration.
§§1–5 below are the morning's read-only diagnosis, kept verbatim because the
mechanism is the lesson; **§6 is what was done and how it was proven.**

Triggered by Izzy, twice: *"I don't see any voicemail emails in the outgoing
inbox that were sent emails today from Connect."* — and again that afternoon,
*"check if it is broken or there were just no voicemails?"*

**He was right, and it was worse than it looked: NOBODY on the platform received
a voicemail email between 21:25 UTC on 08-17 and 17:38 UTC on 08-18 — not from
Connect, and (Gesheft aside) not from the PBX either.**

Companions: `AGENT_HANDOFF_VOICEMAIL_EMAIL_CUTOVER_2026-08-17.md` (the change
that caused this) and `AGENT_HANDOFF_VOICEMAIL_EMAIL_PBX_2026-08-09.md`.

---

## 1. The answer to the question asked

**Not "no voicemails" — there were 158 in 48 hours.** Today alone, 33 by
16:42 UTC.

| | |
|---|---|
| Last voicemail email actually SENT | **2026-08-17 21:25 UTC** |
| Voicemail emails sent today (2026-08-18) | **ZERO** |
| `VOICEMAIL_NOTIFICATION` EmailJobs, 7 days | **13 — all on 08-17, all SENT, 0 failed** |

⛔ **The send door is NOT the problem.** All 13 jobs ever created were delivered
first attempt. Nothing is failing — **nothing is being created.**

## 2. Three independent faults, stacked. Each alone would stop the emails.

### ⛔⛔ Fault 1 — THE CUTOVER ERASED THE RECIPIENTS IT DEPENDED ON

Yesterday's cutover switched the PBX off **by blanking
`ombutel.ombu_extensions.email`** for every non-Gesheft tenant (55 rows → 0).
That field is the address the PBX emailed.

**It is also the address CONNECT emails.** `pbxExtensionSync.ts:497/502` copies
it into `Extension.pbxUserEmail` on an `upsert`, and the `update:` branch writes
`pbxUserEmail` **unconditionally** — including `null`. The sync runs
continuously, so over the following hours it faithfully mirrored the blanking
into Connect and **is still re-writing NULL every few minutes** (extension rows
observed with `updatedAt` seconds old).

So the switch that turned the PBX off **also turned Connect off.** Both senders
are now silent for the same reason.

⛔ **Proven, not inferred — the same extensions, one day apart:**

| Extension | 2026-08-17 | 2026-08-18 |
|---|---|---|
| Trust Bookkeepings 105 | emailed `fhalpert@trustbookkeepingny.com` **4×** | `no_recipient` |
| Trust Bookkeepings 101 | emailed `vigdor@trustbookkeepingny.com` | recipient NULL |
| Trimpro 103 / 105 / 108 | emailed shlomie@ / shia@ / yitz@ | recipient NULL |
| B Visible 101 | emailed `sales@bvisible.us` | recipient NULL |
| Create A Box 102 | emailed `senderweiss@gmail.com` | recipient NULL |
| ADDB Builders 203 | emailed `fishi@addbbuilders.com` | recipient NULL |
| Solidify Concrete 101 | emailed `sstern@solidifyconcrete.com` | recipient NULL |

**32 of 157 ACTIVE extensions still hold an address, and 7 of those are
Gesheft** — the one tenant deliberately not blanked. The rest are dormant
test/demo tenants. **`VoicemailEmailRecipient` holds 0 rows platform-wide**, so
there is no second source to fall back on.

⛔ **The cutover's own safety check could not have caught this.** It asked "is
there a mailbox the PBX emails that Connect would not?" and answered honestly
against the state **before** the blanking. The blanking is what invalidated the
answer, and the sync applied it minutes later. **When you disable a system by
emptying a field, check who else reads that field.**

### ⛔⛔ Fault 2 — GESHEFT PERMANENTLY BLOCKS THE QUEUE (head-of-line)

`runVoicemailEmailSweep` (`voicemailEmailRuntime.ts:81`):

```
where:   { emailedAt: null, receivedAt: { gte: now-7d }, deletedAt: null }
orderBy: { receivedAt: "asc" }
take:    50            // SWEEP_BATCH
```

An excluded tenant is **deliberately never stamped** (`processVoicemailForEmail`
returns `excluded_tenant` before `markProcessed`, so it stays eligible if it is
ever un-excluded — correct in itself). But that makes Gesheft's rows
**permanently `emailedAt: null`**, therefore permanently the **oldest**,
therefore permanently first in an ascending batch of 50.

Gesheft produces ~40–50 voicemails a day and the window is 7 days, so its
unstamped count is **structurally always over 50**. It is **53 right now**.

Every sweep for the last ~100 minutes has logged, once a minute:

```
"voicemail-email: sweep complete"  considered: 50  queued: 0
skipped: { excluded_tenant: 50 }
```

**50 of 50 — the batch never contains anything else.** Nothing behind Gesheft is
ever looked at. ⛔ **This can never self-heal and it gets worse, not better.**

**5 non-Gesheft voicemails are stuck unprocessed right now** (Yossis Wood Works
105 · 35 s, B Visible 101 ×2, A plus center 101, Matamim 101). The last message
the sweep ever reached was **15:00 UTC today**.

### ⛔ Fault 3 — THE WATCHDOG HAS NEVER RUN. That is why nobody was told.

`runVoicemailEmailWatchdog` throws every 15 minutes:

```
Invalid `voicemail.findMany()` … voicemailEmailRuntime.ts:142
Unknown field `tenant` for select statement on model `Voicemail`
```

`Voicemail` has a `tenantId` column but **no `tenant` relation**, so the select
is invalid — it has failed on every single run since deploy. The component whose
entire job is *"reconcile what happened against what should have happened and
escalate any real loss"* has **never completed once**, and its failure is a
`level:40` warn nobody reads.

⛔ **Fault 1 and Fault 2 are exactly what it was built to catch.** A safety net
with a typo in it is not a safety net.

## 3. Nothing is lost — recovery is fully available

- **Voicemails themselves are unaffected.** All recorded, all in Connect, all
  with audio (`localAudioPath` set), all visible in the app. **Only the email
  notification stopped.**
- **The addresses are backed up on the PBX:**
  `/root/vm-email-switchoff-20260817-173339/ombu_extensions_emails.tsv` —
  **62 of 62 rows carry a real address**, plus `RESTORE.sql`. Verified present
  and intact today.
- Voicemails stay eligible for **7 days** (`SWEEP_WINDOW_MS`), so anything
  unstamped inside that window still emails once the blockage clears.
  ⛔ **But a voicemail stamped `no_recipient` is finished** — `emailedAt` is set,
  so it will never be retried. Every one of today's skips needs its stamp
  cleared by hand if those customers are to be notified at all.

## 4. The fix — three parts, and part 1 needs Izzy's decision

⛔ **Do NOT fix this by putting the addresses back on the PBX.** That restores
duplicate emails, which is the thing yesterday's work removed.

1. **Give Connect its own copy of the address, and stop the sync erasing it.**
   `pbxExtensionSync` must never overwrite a non-empty `Extension.pbxUserEmail`
   with `null` — an absent PBX field is now the NORMAL state, not a deletion.
   Then restore the 62 addresses from the backup TSV into Connect.
   ⛔ This is a live data write across 26 tenants; it is Izzy's call.
2. **Unblock the sweep.** Filter excluded tenants out **in the query**
   (`tenantId: { notIn: excluded }`) rather than after the batch is chosen, so an
   excluded tenant can never consume the batch. Keep the no-stamp rule.
3. **Fix the watchdog's select** (drop `tenant`, look the name up separately) so
   the next occurrence raises an escalation instead of a silent warn.

Then clear `emailedAt` on today's `no_recipient` rows so those customers finally
get their notification.

## 5. ⏳ (historical) NOT PROVEN — as of the morning diagnosis

*(Superseded by §6. Kept so the shape of the morning's report survives.)*
Nothing was fixed at that point — diagnosis only.

---

## 6. ✅ THE FIX — done, deployed, proven (2026-08-18 afternoon, second session)

### 6a. Re-verified live before touching anything

The morning's finding was a fact about the past, so it was re-read at
17:05 UTC from the DB and the running container: **0** `VOICEMAIL_NOTIFICATION`
jobs today, last one 21:25Z 08-17; **37** voicemails today (14 non-Gesheft);
sweep logging `skipped: {excluded_tenant: 50}` of 50 once a minute; watchdog
throwing `Unknown field tenant`; 5 non-Gesheft voicemails sitting unstamped
behind Gesheft's 55; PBX backup TSV present, 62 rows, all with an address.

### 6b. Where the addresses now live — and why NOT the sync guard

The morning plan (§4 part 1) was "stop the sync erasing `pbxUserEmail`, restore
into it". **That was deliberately NOT done.** `Extension.pbxUserEmail` is a
MIRROR of the PBX field, and the PBX field is now legitimately blank for every
cut-over tenant — making the sync keep a stale value would make the mirror lie,
and the sync also auto-creates Connect users from that field.

Connect already had its own recipient list: **`VoicemailEmailRecipient`**
(per extension, admin-editable in the portal Settings page, routes at
`server.ts:25340`, unique on `(extensionId, email)`), which the decision layer
already merges with the mirror (`resolveVoicemailRecipients`). So the 55
non-Gesheft addresses were restored **there**. Result: for a cut-over tenant
`pbxUserEmail` is null BY DESIGN and `VoicemailEmailRecipient` is the ONLY
source; Gesheft keeps its PBX mirror. Rule 2 in `voicemailEmail.ts` now says so.

⛔ **Never "fix" a null `pbxUserEmail` by putting the address back on the PBX**
(duplicate emails resume) **and never make the sync keep a stale one.**

**The restore, exactly:** the TSV is `pbx_tenant_id <TAB> ext <TAB> email`. Each
row was mapped `TenantPbxLink.pbxTenantId == pbx_tenant_id` (only tenants with
`pbxRemovedAt IS NULL`), then `Extension {tenantId, extNumber, status ACTIVE}`,
then `voicemailEmailRecipient.upsert` (create-only). Dry-run first: **55 rows →
55 live tenant + ACTIVE extension matches, 0 unresolved, 0 removed, 0
ambiguous, mirror null on every one.** Applied: **53 created across 21
tenants**; Gesheft's 7 skipped (excluded tenant); **Loopcom Demo's 2 skipped
on purpose** — `loopcom.review@example.com` / `loopcom.maya@example.com` are
fake, and restoring them would produce failed sends the now-working watchdog
would text Izzy about.
⛔ The two "live" non-Gesheft extensions that still held a `pbxUserEmail`
(`a plus center` 101 — lowercase, a DIFFERENT tenant from `A plus center` — and
Comfort control 101) are not on the PBX backup and were left alone.
**Rollback** = delete the `VoicemailEmailRecipient` rows created 2026-08-18
~17:20Z with `createdById IS NULL` (nothing else has ever written that table —
it held 0 rows before).

### 6c. Code — `6961ea9e` + `47c3ff45`

1. **Sweep** (`voicemailEmailRuntime.ts`): new pure `buildVoicemailSweepWhere`
   puts `tenantId: { not: null, notIn: [...excluded] }` **in the query**. An
   excluded tenant can no longer occupy the batch; the no-stamp rule for
   excluded tenants is unchanged (they stay eligible the day they are
   un-excluded). `notIn` is only added when non-empty; `not: null` always.
2. **Watchdog select** — dropped `tenant: { select: { name } }` (no such
   relation on `Voicemail`); names looked up in one separate `tenant.findMany`.
3. **Watchdog grace** (`47c3ff45`, `voicemailEmailWatchdog.ts`):
   `NEVER_PROCESSED_GRACE_MS = 10 min`. Now that the watchdog runs, a voicemail
   received seconds before a tick — which the once-a-minute sweep had not
   reached yet — would otherwise be reported (and escalated = texted) as a loss
   that emailed thirty seconds later. A row with no `receivedAt` is still
   reported. ⛔ `no_recipient` still does not alert (standing condition).
4. `voicemailEmail.ts` Rule 2 comment rewritten (where recipients live).

**Tests:** `voicemailEmailRuntime.test.ts` (5, new — a faked db that throws on
an unknown `select` key like Prisma, plus two SOURCE guards, CRLF-normalised):
**all 5 fail replayed against the pre-change file.** Watchdog: two cases in
`voicemailEmailSender.test.ts` updated/added. Voicemail suite **61 / 61**.
apps/api typecheck adds 0 in edited files (the extra server.ts count belongs to
the MFA session's uncommitted work).

### 6d. Proven live — the numbers

- Deploy: `6961ea9e` rode another session's `deploy-direct api` of the branch
  tip; container `0b28b348` (contains `6961ea9e`, verified with
  `merge-base --is-ancestor` and `grep -c buildVoicemailSweepWhere` = 2 in the
  container). `47c3ff45` then shipped in the docs-tip deploy: **container
  `d2b35642`, `verify: container commit d2b35642dc7d matches target`,
  `NEVER_PROCESSED_GRACE_MS` grep = 2 inside it**; health 200; a fresh
  voicemail was emailed by that container (`queued: 1`) within its first
  two minutes.
- **First sweep on the new container, 17:38:38Z: 5 queued → 5 SENT within
  15 s** (bianca@yossiswoodworx.com, leahw@apluscenterinc.org,
  sales@bvisible.us, office@matamimweekly.com,
  fhalpert@trustbookkeepingny.com). Unstamped-by-tenant afterwards: **Gesheft
  only** (56).
- **9 post-cutover `no_recipient` stamps cleared** (`emailedAt`/`emailSkipReason`
  → null, rows received ≥ 2026-08-17T17:00Z). Next sweep: `considered: 9,
  queued: 4, skipped: {no_recipient: 5}`. The 4 SENT (Relax Tires 101,
  A plus center 105 ×2, Trust 105). The 5 re-stamped are **Trimpro 102 ×2,
  Trimpro 104, A plus center 108 ×2 — mailboxes with NO address on the PBX
  either** (the cutover doc already listed Trimpro 102 and A plus 108 as blind).
  Not a regression; **those customers can add an address in Settings**, or
  we can for them.
- Since 17:30Z: **9 VOICEMAIL_NOTIFICATION jobs, 9 SENT, 0 failed.** 36
  non-Gesheft voicemails since the cutover: 17 emailed, 14 `too_short`, 5
  `no_recipient` (above).

### 6e. ⏳ Still open

- **Onboarding still writes the person's email onto the PBX extension**
  (`onboarding/pbxTenantBuild.ts:313`, `email: person.email`), so a NEW sign-up
  will get PBX + Connect duplicates until that path sends `""` and writes the
  address into `VoicemailEmailRecipient` instead. Not done.
- The 5 already-blind mailboxes above (Trimpro 102/104, A plus 108).
- No human has opened one of today's Connect voicemail emails and pressed
  play on the attachment; proven as SENT by the outbox, not by an inbox.

---

## 7. ✅ GUARDRAILS + SELF-HEALING (2026-08-18, evening) — `9ae26e04`

Izzy, after reading §6: *"What happened today could never, ever happen again. We
need to have safeguards and guardrails. Emails cannot stop working ever,
especially voicemail or SMS emails. You need to put self-healing on this."*

Everything lives in **`apps/api/src/voicemail/voicemailEmailGuardrails.ts`**
(pure decisions + runners + timers), wired from `voicemailEmailRuntime.ts`
(heartbeats, watchdog self-heal, watchdog failure escalation),
`pbxExtensionSync.ts` (preserve-before-null) and one line in `server.ts`
(`startEmailGuardrails(app.log)`).

| Fault from §2 | Self-heal | Alarm |
|---|---|---|
| 1 — recipients erased by a config change | sync promotes a blanked PBX email into `VoicemailEmailRecipient` BEFORE nulling the mirror (`preserveBlankedPbxEmail`) | hourly recipient-coverage count; drop ≥ 3 and ≥ 20 % escalates by company |
| 2 — sweep head-of-line blocked | the watchdog re-processes any voicemail unprocessed > 10 min through its OWN query (same sender, same stamps); dead voicemail jobs re-queued (≤ 2×, ≥ 1 h old, only after a newer SENT proves the outbox works) | sweep heartbeat every pass; liveness check escalates when > 10 min stale |
| 3 — watchdog never ran | — | watchdog heartbeat every pass (> 45 min stale escalates); 3 consecutive throws escalate the error text |
| (new) the outbox itself | — | every 5 min, EVERY type except ADMIN_ALERT: a due job unsent 20 min = "not sending"; ≥ 5 FAILED/hour = "failing" + top cause |

Design rules (all in the file header): escalation never ADMIN_ALERT; de-dupe on
an open escalation with the same `ALARM_PREFIX`; state in `AgentAuditLog`
(`voicemail_email.sweep_heartbeat`, `.watchdog_heartbeat`,
`.recipient_coverage`, `.job_requeued`), never a module variable; a fresh
container gets 20 min before its heartbeats are judged.

**Tests:** `voicemailEmailGuardrails.test.ts` — 15: every threshold pinned
(staleness incl. fresh-process/very-old-heartbeat, coverage 55→0 vs 55→53 vs
10→7 vs 100→97, preserve value→blank vs change, outbox stall/failure, requeue
cap/age/proof-of-recovery), fake-db runners (de-dupe, third-failure escalation
+ reset, preserve writes the row, outbox queries all carry `type: {not:
ADMIN_ALERT}`, requeue capped at 2, liveness mature-vs-fresh), and four SOURCE
guards (runtime records both heartbeats and escalates in its catch; watchdog
processes stranded + requeues; sync calls the guard BEFORE the upsert;
server.ts starts the timers). Runtime tests updated: the 2-day-old
never_processed voicemail is now RESCUED (job queued, stamped, no longer a gap)
and the empty sweep still heartbeats. Voicemail + sync suites **87/87**;
typecheck **75 = baseline**, 0 in `voicemail/`.

**Deployed and container-verified:** `verify: container commit 9ae26e04bd54
matches target`, `startEmailGuardrails` present in the container's server.ts,
health 200. **Watched alive on the real container within its first 5 minutes:**
sweep heartbeats once a minute (8 rows), the first `recipient_coverage` row
written 3 min after boot — **55 of 103 ACTIVE non-Gesheft mailboxes have a
recipient** (`previous: null`, so no comparison yet, `dropped: false`), listing
per company (A plus center 6, Yossis Wood Works 7, B Visible 5, Trust
Bookkeepings 5, Trimpro 4 …) — **zero escalations raised**, 12 voicemail
emails SENT since 17:30Z. The watchdog heartbeat lands on its first 15-min tick.
That 55 is the baseline the hourly drop check now compares against.

⏳ **NOT PROVEN: no guardrail has fired for real.** The acceptance test is the
first real fault or a deliberate one (which texts both phones — ask first).
