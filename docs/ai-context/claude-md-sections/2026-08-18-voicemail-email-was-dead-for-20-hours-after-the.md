# ⛔⛔ AGENT HANDOFF — voicemail email was DEAD for ~20 hours after the PBX cutover, FIXED and proven 2026-08-18 — READ FIRST for ANY "no voicemail emails today", before touching the voicemail-email sweep/watchdog, before "restoring" an address to the PBX, and before treating `Extension.pbxUserEmail` as a recipient

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full detail: **`docs/ai-context/AGENT_HANDOFF_VOICEMAIL_EMAIL_DEAD_2026-08-18.md`**
(§1–5 = the morning's read-only diagnosis by one session; **§6 = the fix, by a
second session the same afternoon.** `6961ea9e` + `47c3ff45` on
`feat/ivr-migration-takeover`; **api DEPLOYED and container-verified
(`d2b35642` ⊇ both); one live data write: 53 rows into
`VoicemailEmailRecipient`; 9 no_recipient stamps cleared.** No PBX write, no
migration.) Memory: [[voicemail-email-recipients-live-in-connect-now]].

- ✅✅ **THE ANSWER TO "no voicemail emails today": it was BROKEN, not quiet.**
  158 voicemails in 48 h, **zero** emails from 21:25Z 08-17 to 17:38Z 08-18.
  ⛔ Nothing FAILED — nothing was CREATED. `VOICEMAIL_NOTIFICATION` jobs were
  13 SENT / 0 failed all week; the tell was `docker logs app-api-1 | grep
  voicemail-email` reading **`skipped: {excluded_tenant: 50}, considered: 50`**
  once a minute. **Now:** the first sweep after the deploy queued 5, all SENT in
  15 s; **9 SENT / 0 failed** in the hour after. ⛔ Re-verify live before
  repeating any of this: `select max("createdAt") from "EmailJob" where type =
  'VOICEMAIL_NOTIFICATION'` — a timestamp within the hour means it works now.
- ⛔⛔ **THREE FAULTS STACKED, each alone enough.** (1) **The cutover erased
  Connect's own recipients**: switching the PBX off = blanking
  `ombu_extensions.email`; the extension sync MIRRORS that field into
  `Extension.pbxUserEmail`, so within hours Connect had no address either.
  **When you disable a system by emptying a field, check who else reads that
  field.** (2) **Gesheft blocked the sweep**: excluded tenants are never
  stamped (correct), so their rows are permanently the OLDEST, so they filled
  the whole ascending batch of 50, forever — ~50 Gesheft voicemails/day inside
  a 7-day window. **A post-batch filter on a bounded ordered batch is a
  head-of-line block waiting to happen — filter in the query.** (3) **The
  watchdog had NEVER run**: it selected `tenant: {select:{name}}` on
  `Voicemail`, which has a `tenantId` column and NO relation → Prisma
  validation error on every 15-min tick since deploy, a `level:40` warn nobody
  read. **A safety net with a typo is decoration; the first thing to check
  about a watchdog is whether it has ever completed once.**
- ⛔⛔ **WHERE RECIPIENTS LIVE NOW: `VoicemailEmailRecipient`, Connect's own
  list (Settings page, `server.ts:25340`).** For every cut-over tenant
  `Extension.pbxUserEmail` is **null BY DESIGN** — it is a mirror of a PBX
  field that is now legitimately blank. ⛔ **Do NOT put addresses back on the
  PBX** (duplicate emails resume — the thing the cutover removed) and ⛔ **do
  NOT make the sync keep a stale `pbxUserEmail`** (the mirror would lie, and
  the sync auto-creates users from it). The morning plan proposed that guard;
  ⛔ **SUPERSEDED 2026-09-02: Gesheft is on Connect's voicemail email now — see the section at the TOP of this file.**
  it was deliberately not done. Gesheft (PBX tenant 8) keeps its PBX mirror.
- ✅ **The restore was gated on a dry-run, not optimism:** 55 non-Gesheft rows
  in `/root/vm-email-switchoff-20260817-173339/ombu_extensions_emails.tsv` (on
  the PBX) → mapped via `TenantPbxLink.pbxTenantId` (live tenants only) →
  ACTIVE extension → **55/55 matched, 0 unresolved/removed/ambiguous.**
  Written **53** across 21 tenants; **Loopcom Demo's two `@example.com`
  addresses skipped on purpose** (fake — they would only feed the watchdog).
  ⛔ `a plus center` (lowercase) is a DIFFERENT tenant from `A plus center`.
- ✅ **Sweep now filters in the query** (`buildVoicemailSweepWhere`, `tenantId:
  {not: null, notIn: excluded}`); the no-stamp rule for excluded tenants is
  unchanged. ✅ **Watchdog select fixed** (names via a separate
  `tenant.findMany`) and given a **10-min `NEVER_PROCESSED_GRACE_MS`** so a
  voicemail the once-a-minute sweep simply hasn't reached yet cannot text Izzy
  as a loss. `no_recipient` still does not alert. Tests: 5 new (all 5 fail on
  the pre-change file), voicemail suite 61/61.
- ⛔ **A `no_recipient` stamp is FINAL** — `emailedAt` is set, so it is never
  retried; today's 9 were released by hand (`emailedAt`/`emailSkipReason` →
  null). 4 then emailed; **5 re-stamped: Trimpro 102 ×2, Trimpro 104, A plus
  center 108 ×2 — mailboxes that had no address on the PBX either.** Not a
  regression; they need an address added in Settings.
- ⏳ **STILL OPEN:** **onboarding writes `email: person.email` onto the PBX
  extension** (`pbxTenantBuild.ts:313`), so a NEW sign-up gets PBX + Connect
  duplicates until it sends `""` and writes `VoicemailEmailRecipient` instead;
  the 5 blind mailboxes above; and no human has opened one of today's emails —
  proven SENT by the outbox (**11 SENT / 0 failed** by 18:10Z, including one
  fresh voicemail emailed by the final `d2b35642` container), not by an inbox.
  ⛔ Deploy trap re-hit here: a waiter loop that counts `ps | grep
  deploy-direct.sh` never reaches 0 while OTHER sessions' `until pgrep -f
  deploy-direct.sh` waiters exist — their command lines contain the string.
  Two such waiters (PIDs 1873319, 2429874) have sat on loopcom for 6–14 h.
