# ⛔⛔ AGENT HANDOFF — the SMS↔email bridge is CODE-COMPLETE: texts email out from sms@loopcom.net and REPLYING to that email texts back, one email thread per phone number (2026-08-20) — READ FIRST before touching `apps/agent/src/notify/smsEmail*`, before pointing anything at the sms@loopcom.net mailbox, or for "I replied to the text email and nothing was sent"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_SMS_EMAIL_BRIDGE_2026-08-20.md`**
(`d0d4f861` on `feat/ivr-migration-takeover`. **agent REBUILT + container-verified
AND ARMED LIVE 2026-08-20** — Izzy supplied the sms@loopcom.net app password in
chat, the 8 `AGENT_SMS_*` env lines are live in `.env.platform` (backups
`.bak.*.smsbridge-*`), boot audit rows `sms.email_enabled` + `sms.reply_enabled`
confirmed, and a live probe proved the WHOLE loop: SMTP send as sms@loopcom.net
(250 OK) → Gmail plus-address delivery → IMAP read → address parsed → a FORGED
signature refused (`sms.reply_ignored bad_signature`) → marked seen. Google's own
"app password created" alert was correctly ignored as `no_reply_address`.
No migration, no PBX write, no api/portal change.)
Izzy, 2026-08-20: *"every time they get an SMS, the system will send it to them via
email … When somebody replies to that email, it would reply to it as a text message
and make sure the email stays in one thread … one thread per phone number."*

- ⛔⛔ **MOST OF IT ALREADY EXISTED, DORMANT SINCE 2026-07-26 — check before
  rebuilding any half.** The per-user switch (`User.smsEmailForwardEnabled`, the
  Quick Controls "SMS to Email" toggle), the forward job
  (`smsEmailForwardJob.ts`, fresh-window + `emailForwardedAt` stamps so the SMS
  backlog can never be blast-emailed), the one-thread-per-number design (stable
  subject `Text with <name>` + `References` pinned to
  `<sms-thread-<threadId>@domain>` — the subject stability is HALF the threading,
  never "improve" it), and the signed reply address
  `sms+<threadId>.<sig>@<domain>` were all built. **What was missing was Part 3
  only**: nothing read the mailbox, verified the address, or sent the SMS.
- ✅ **Part 3 is built now**: `smsEmailReply.ts` (shared mint/verify — the forward
  job now mints through the SAME helper so mint/verify can never drift; quoted-
  reply stripping; auto-reply detection), `smsEmailReplyJob.ts` (decision layer),
  `smsImapSource.ts` (IMAP via imapflow/mailparser — new agent deps). A verified
  reply is sent by minting a **2-minute JWT for the REPLYING USER** and driving
  the REAL `POST /chat/threads/:id/messages` route — ⛔ never a parallel send
  path: participant checks, `can_send_sms`, segmenting, MMS fallback and
  delivery tracking all stay in the one implementation, and the app attributes
  the reply to the person.
- ⛔ **The bridge has its OWN mail identity** (`AGENT_SMS_SMTP_*` → its own
  Notifier instance) — configuring it must NOT arm the shared agent notifier
  (digests/incidents), and it must send AS the mailbox that receives replies or
  DKIM alignment and reply routing both break. Brand on this surface is
  **"Loopcom"**.
- ⛔ **Failure directions are the feature**: a STRANGER's reply gets silence (no
  oracle, no backscatter); a KNOWN user whose text can't go out gets a THREADED
  notice email (they believe they just texted a customer — silence is a lie);
  a send is CLAIMED in `AgentAuditLog` before the POST and **never auto-retried**
  (duplicate text > failed text); OOO/auto-generated mail is never texted;
  ⛔ the reply-text extractor's attribution join spans only CONSECUTIVE NON-EMPTY
  lines — joining across a blank line ate a real message starting "On my way".
- **Proven as**: 31 new tests (all 5 source guards fail replayed against HEAD),
  agent suite **695/697** (the 2 pre-existing transcription failures), typecheck
  at the agent's exact 14-error baseline — **plus the live probe above** (SMTP,
  IMAP, parse and refuse all exercised against the real mailbox).
- ✅✅ **ROLLED OUT 2026-08-20 (Izzy: "Turn it on for everybody but gesheft"):
  79 of 85 users have the toggle ON — every user EXCEPT Gesheft's 6**
  (tenant `cmnlgnumu0001p9g6xyl1pbdd`, 0 on; bulk DB update, so no per-user
  `SMS_TO_EMAIL_ENABLED` audit rows exist for this wave — the two pre-existing
  ONs were Ezra's test accounts). ⛔ **Gesheft is excluded on purpose — never
  "complete" the rollout by flipping them on**: they are the busiest inbound-SMS
  tenant on the platform (~174 texts/wk vs ~98/wk for everyone else combined).
  Volume for everyone else ≈ **14 emails/day** — nowhere near Gmail's cap.
  ⛔ **A NEW user starts OFF** (schema default false) — "everybody" was a
  one-time backfill, not a changed default; changing the default is Izzy's call.
- ✅ **B VISIBLE IS SWITCHED OFF (2026-08-24, Izzy: "turn off SMS to email for
  all users in B Visible") — all 5 ACTIVE users, tenant `cmnlgryp8001lp9pajhatv3t9`.**
  Platform-wide ON went **79 → 74** (66 ACTIVE), so exactly those five moved and
  nobody else was touched. ⛔ **No deploy and no agent rebuild were needed** —
  `smsEmailForwardJob.ts:140` reads the flag in a LIVE per-message query, so the
  next inbound text simply stamps `no_opted_in_recipients`. **The text is never
  lost, only the email is skipped.** Backup of the prior state:
  `/root/bv-sms-email-backup-20260824.json` on loopcom (600, root-only); reversal
  is setting those five ids back to true. ⛔ Unlike the 08-20 wave this one DOES
  carry per-user `SMS_TO_EMAIL_DISABLED` audit rows (5, `metadata.source =
  admin_bulk`). ⛔ Each user can still flip it back themselves in Quick Controls —
  it is a per-user preference, not a tenant lock.
- ⛔⛔ **AND TURNING THE CONNECT TOGGLE OFF DOES NOT STOP B VISIBLE'S TEXT EMAILS —
  THE CARRIER SENDS ITS OWN, AND THAT IS THE THING MOST LIKELY TO READ AS "the fix
  didn't work".** Verified live at VoIP.ms the same day (read-only `getDIDsInfo`):
  **845-238-0478 still has `sms_email: sales@bvisible.us` with
  `sms_email_enabled: "1"`**, which is a VoIP.ms-side forward Connect does not
  touch. So four mailboxes go quiet and **sales@bvisible.us keeps getting an email
  per text.** ⛔ **Also found and NOT previously recorded anywhere:
  `sms_forward: 8456626794`** — the carrier additionally forwards every inbound
  text as a TEXT to that number. **Both are carrier writes (`setSMS`), both are
  customer-facing, and both are Izzy's call — deliberately left alone.**
- ✅✅ **THE FORWARD HALF IS PROVEN IN PRODUCTION (2026-08-20 evening, measured
  read-only) — the acceptance test PASSED and a human answered one.** Since the
  bridge armed at **11:36Z**, **27 inbound texts arrived and 0 were unhandled**:
  **10 emailed**, 17 correctly skipped `no_opted_in_recipients` (all Gesheft, by
  design). Real recipients: `sales@iniimini.com`,
  `cspilman@trustbookkeepingny.com`, `senderweiss@gmail.com`,
  `ezra@connectcomunications.com`. ⛔ **Delivery is proven, not inferred:** a
  human at Trust Bookkeepings **hit reply 3 minutes after** the 15:30Z emails —
  which is only possible if the mail reached a real inbox and was read. No
  bounce has come back to sms@loopcom.net since (the reply job reads that
  mailbox and audits everything it sees).
- ✅✅ **THE TEXT EMAIL IS A LOOPCOM EMAIL NOW — one shell, shared by api and
  agent (`dc95a1d0`, agent container REBUILT and verified 2026-08-20 22:49Z).**
  Izzy: *"It's not sending the correct email. We made a different one."* He was
  right. `smsEmail.ts` was written **2026-07-26**, three weeks BEFORE the
  rebrand, and was the ONLY commit that file ever had — so when Part 3 shipped
  it rewrote the SENDER and left the template alone. Every text email, including
  all 10 that day, went out in the old Connect-blue design with **no logo**. It
  was the last customer-facing email still pre-rebrand.
  ⛔⛔ **THE CAUSE WAS STRUCTURAL, NOT COSMETIC, AND IT IS THE REUSABLE LESSON:
  `loopComShell` lived in `apps/api` and the bridge lives in `apps/agent`, so
  the agent COULD NOT REACH the look the rebrand had settled on.** A design that
  one app physically cannot import will drift, silently, forever. The renderer
  now lives in **`packages/shared/src/loopcomEmailShell.ts`** and both apps use
  it: api keeps `loopComShell()` as a thin wrapper, agent gains
  `loopcomShellForAgent()`. ⛔ **Never copy the shell into an app** — that
  recreates exactly this.
  ⛔ **The logo stays resolved at each app's BOUNDARY, never as a builder
  input.** The shared renderer takes `logoUrl` because a shared package cannot
  read an app's env; each app supplies it in ONE wrapper. A guard test fails if
  any email builder grows a `logoUrl` parameter — that shape is how the Android
  APK link went missing from every self-service invite once already.
  ✅ **The invite and voicemail emails are untouched, and that was PROVEN, not
  assumed:** the pre-move implementation was kept temporarily and compared
  against the shared one across three input shapes (escaping, absent subtitle) —
  **byte-identical to the character** — then deleted.
  ✅ **Also fixed: right-to-left is now decided PER MESSAGE.** The old code
  sniffed only the newest message and then applied the result to nothing at all,
  so Yiddish texts rendered with the punctuation on the wrong end.
  ⛔ **A guard was caught being DECORATIVE by the HEAD replay** — it tested
  lowercase `<!doctype html>` while the old file opened with uppercase
  `<!DOCTYPE html>`, so it passed against both trees and guarded nothing. It is
  case-insensitive now and also checks `<html`/`<body`. **Replay every source
  guard against HEAD; this is the third time in this repo that caught a fake.**
  **Proven:** 10 new shared tests (registered), all 6 guards non-vacuous,
  shared 384/384, agent SMS suites 31/31, api voicemail-email 55/55, agent
  typecheck at its exact 14-error baseline and api at its exact 75, none in an
  edited file; then **inside the running container**: the email rendered with
  the Loopcom card, the logo URL, the RTL bubble, and **zero** hits for the old
  "New text message" banner — and the logo itself answers **200 (34,458 b,
  image/png) on BOTH hostnames**.
  ⛔ **The api half is committed but NOT deployed** — its output is
  byte-identical, so the running image is correct either way; it rides the next
  api deploy.
  ⏳ **NOT PROVEN: no human has seen the new email in a real inbox.** The next
  real inbound text to a non-Gesheft tenant is the acceptance test. The last old
  design went out at 22:28:47Z; the bridge re-armed at 22:49:12Z.
- ✅✅ **THE REPLY HALF WORKS, AND IT IS PROVEN WITH TWO LIVE ROUND TRIPS
  (2026-08-21, `2000c817` + `f31f990a`; agent REBUILT, api DEPLOYED and
  container-verified).** ⛔ Everything the older bullets here said about
  `sms.reply_sent` being 0 for all time, and about a six-gate ladder ending in a
  From-address match, is HISTORY — read this bullet, not them.
  **What changed: a reply is routed by the THREAD, never by who the email came
  from.** The signature already pinned WHICH conversation; a conversation knows
  its phone number, and that number's SMS routing knows the inbox it lands in. So
  the sender comes from `ConnectChatThread.smsInboxOwnerUserId` and the From
  header decides nothing — a reply now works from a forward, a phone, or a
  personal account. **Proven on a thread between two of OUR OWN numbers**
  (Connect Communications, +18455577768 ↔ +18457231213 — no customer touched):
  **owner-routed** OUT 11:48:23.516 → **IN 11:48:34.078** (VoIP.ms id 110175261);
  **shared inbox, sent with NO NAME** OUT 12:16:26.722 → **IN 12:16:44.210**
  (id 110176076). Both were emailed in from `sms@loopcom.net`, which is **not a
  Connect user** — the exact shape that was silently dropped the day before.
- ⛔⛔ **THE TENANT-LEAK LOCK IS THE LOAD-BEARING PART: the resolved sender MUST be
  ACTIVE and MUST be in the THREAD'S OWN tenant.** Measured 2026-08-21 across all
  616 live SMS threads: **0 owners in another tenant, 0 inactive, 0 threads
  missing a number.** The check exists to keep that 0 when somebody is moved,
  disabled or offboarded — **never delete it because it currently refuses
  nothing.**
  ⛔ **`smsInboxOwnerUserId` is `''` (EMPTY STRING), not NULL, on a shared inbox —
  315 of 616 live threads.** `is not null` reads every one of those as owned (it
  produced a wrong count in this very session); truthiness is the correct test.
- ⛔ **A reply can only ever WRITE into one thread, and learns nothing back.**
  Failure notices go ONLY to the address WE hold in our own database, never to the
  email's From — so a leaked reply address cannot become an oracle. A shared-inbox
  send has no verified address, so it notifies nobody at all. Other guards: a mail
  carrying TWO different signed addresses is **refused, never resolved**; **20
  sends per thread per hour**; and every send records the routed sender AND the
  address that actually replied.
- ⛔ **Shared inboxes go out with NO NAME (`senderUserId: null`)** — the schema's
  normal shape (that column is nullable and goes NULL whenever a rep is
  offboarded). Attributing a shared inbox's text to one of its several people
  would itself be wrong. That is the ONLY reason the new door exists:
  **`POST /internal/chat/sms-system-reply`** takes a thread id and a message and
  **nothing else — ⛔ the tenant is derived FROM THE THREAD, so there is none in
  the request to forge** (the `inbound-crm-match` lesson), and it **refuses a
  thread that HAS an owner with 409**, so it can never strip attribution off an
  owned inbox. ⛔ It is on the JWT bypass list AND in `internalSecret.test.ts`'s
  guarded list — a missing bypass entry answers 401 and the door's own secret
  check never runs. **Proven live: outside → 403 at nginx, no secret → 401, wrong
  secret → 403, an owned thread → 409 with no send.**
- ⛔⛔ **A BUG THIS WORK FOUND IN ITS OWN FIRST COMMIT, and the rule it re-earns:
  the flood cap queried `createdAt`, and `AgentAuditLog` has `ts`.** Prisma threw,
  a `.catch(() => 0)` swallowed it, `sentLastHour` was always 0 and the cap never
  fired — **with a green suite, because the fake `count` ignored its where
  clause.** The fake now parses AgentAuditLog's real columns out of
  `schema.prisma` and throws on an unknown one (reintroducing `createdAt` fails
  the suite), and the catch audits `sms.reply_rate_check_failed` rather than being
  silent. **A swallowed catch on a query that DECIDES something is how a guard
  becomes decoration.**
- ⛔ **Testing this by emailing the bridge FROM `sms@loopcom.net` works — but read
  the mail flags correctly.** The job marks a message `\Seen` AFTER it handles it,
  so a mail you find already-seen was most likely PROCESSED, not skipped. This
  session misread that as "Gmail auto-reads self-sent mail", re-fed an
  already-handled message, and the exactly-once claim correctly refused it
  (`already_claimed`, still exactly 1 outbound row) — which is itself the best
  proof that guard works. ⛔ And do not wait on `event like 'sms.reply%'`: it
  matches the pre-existing `sms.reply_enabled` row and returns instantly.
- ✅✅ **FIXED 2026-08-23 (`6d9b9f33`, agent REBUILT + container-verified) — AND THE
  BUG WAS THE 08-21 AMBIGUITY GUARD ITSELF, NOT the customers' mail.**
  ⛔⛔ **THE MECHANISM: the guard counted RAW ADDRESS STRINGS before verifying any
  of them, and Gmail carries the reply address TWICE** — once as sent (`To:`) and
  once with the whole local part **LOWER-CASED** (`Delivered-To:`). The signature
  is base64url, so the two strings differ, so **ONE conversation read as TWO and
  every real reply was refused** from 2026-08-21 until this fix.
  ⛔ **It hid for three days because the only replies that ever worked were sent
  FROM the bridge mailbox to itself** — Gmail does not stamp a self-send that way,
  so the two 08-21 "PROOF A/PROOF B" round trips passed while the path every
  customer uses was dead. **A test that dodges the delivery path it is meant to
  prove passes for the wrong reason.**
  ⛔⛔ **AND THE FIRST DIAGNOSIS IN THIS FILE WAS WRONG, WRITTEN HOURS EARLIER THE
  SAME DAY:** it read the audit payload's `count: 2` as "their mail named two
  different conversations — a quoted or forwarded chain". It named **ONE, twice**.
  **A count in an audit payload is a fact about the counting code, not about the
  world** — the check that settled it was reading the real message headers out of
  the mailbox (headers only, never the body).
- ✅ **THE FIX: `resolveSmsReplyTarget` VERIFIES BEFORE IT COUNTS**, and ambiguity
  is stated in terms of proven **CONVERSATIONS**, never strings. Three deliberate
  consequences: unverified junk can no longer **veto** a genuine reply (anyone
  could previously have killed a customer's replies forever by CC'ing a made-up
  `sms+…@loopcom.net`); **`References`/`In-Reply-To` breaks a tie between two
  ALREADY-PROVEN conversations** instead of refusing, and can never route on its
  own; and `verifySmsReplySignature` also accepts the all-lower-case form of that
  exact signature, so a reply whose only surviving copy is the MTA-stamped one is
  not dropped as forged. ⛔ `findSmsReplyAddress` / `findAllSmsReplyAddresses` are
  **DELETED, not left unused** — first-match-wins and count-then-verify are the two
  bugs, and a dead helper with a security-shaped name invites them back.
- ✅✅ **PROVEN FOUR WAYS, ENDING IN A REAL TEXT ON THE WIRE.** 54 unit/route tests
  (**12 fail replayed against `HEAD`**, incl. the customer-visible one); a stress
  suite sweeping **8,192 exhaustive resolutions + 300 seeded chaos emails** through
  the real job against 7 invariants (**6/6 fail against a mutant** that puts either
  half of the bug back); **the two REAL refused customer emails replayed through
  the DEPLOYED code** against the real secret and database with every write
  intercepted — both now resolve to the right thread and would send, nothing
  written; and finally a Gmail-shaped reply put into the LIVE mailbox by **IMAP
  APPEND**, picked up by the real 45 s timer, **sent as a real text and received
  back — OUT 23:13:07.189 → IN 23:13:20.629, VoIP.ms id 110280535**, between two of
  Connect's own numbers (+18455577768 ↔ +18457231213), quoted block and "Sent from
  my iPhone" correctly stripped. Agent typecheck **14 = the exact baseline**, none
  in an edited file; agent suite 757/759 (the 2 documented transcription failures).
  ⛔ **Read-through / stub-the-writes is how you prove a mail or sweep fix on live
  data; IMAP APPEND is how you exercise the real job with a mail shape you cannot
  otherwise produce.**
- ⚠️ **WHAT THE OUTAGE COST, AND IT NEEDS IZZY: the message stuck in iniimini's
  refused reply was "Please stop these emails"** — a customer asking to be switched
  off, unheard for two days. ⛔ **And it was aimed at US, not at the person on the
  other end of the text** — so had it gone through, it would have been TEXTED to
  their customer. **Replying to a text-email is the only control a recipient has,
  and there is no "turn this off" path in it**; the toggle lives in the app. Worth
  a line in the forward email, and worth switching that user off if they meant it.
  ⛔ The forward half was never affected and stayed busy throughout (70+
  `sms.emailed`; the only `emailForwardError` in 5 days is
  `no_opted_in_recipients` × 72 = Gesheft, by design).
- ✅✅ **THE FORWARD HALF IS NOW STRESS-TESTED TOO — AND IT HAD ZERO TESTS UNTIL
  2026-08-23 (`3d85f968` + `8951f825`).** `buildSmsEmail` and
  `SmsEmailForwardJob` — the path carrying **100% of the live traffic** — had
  none at all, while the reply half had 54. ⛔ **Check WHICH HALF of a feature
  the tests cover before reading a green suite as coverage.** Now 14 in
  `smsEmailForward.stress.test.ts`: a hostile sweep (16 message bodies × 9
  contact names = 144 emails), 1,500 fuzz iterations and 200 seeded chaos passes
  through the real job, against 7 invariants — the Subject never carries CR/LF,
  nothing from a body or a contact name becomes markup, no inbound text is
  silently lost, none is emailed twice, only opted-in ACTIVE participants are
  recipients, the Reply-To verifies for that thread only, every message of one
  thread shares a root id AND a subject, an SMTP failure leaves the row for
  retry, and **the backlog guard lives in the QUERY**. Three mutations
  (unsanitised subject, unescaped body, backlog guard removed) each fail the
  matching invariant.
- ⚠️ **ONE REAL DEFECT IT FOUND: the contact display name went STRAIGHT into the
  Subject, and 18 of 12,160 live contacts carry a control character in their
  name.** ⛔ **NOT an exploitable header injection — measured, not assumed:
  nodemailer flattens CR/LF to a space** (a real MIME message was built; no
  `Bcc:` header appeared). But a mail header must not depend on a downstream
  library to be well formed, and the subject is HALF of the
  one-thread-per-number promise. **`headerSafeName()` in `smsEmail.ts`** strips
  control characters, collapses whitespace and caps at 120 (longest real name is
  78, so it moves nobody today), applied at **both** subject sites — the forward
  template and the reply job's failure notice.
- ⛔⛔ **TWO TESTING TRAPS EARNED HERE, both of which leave assertions LOOKING
  fine while guarding NOTHING.** (1) **Backslash escapes do not survive a shell
  heredoc — `\b` became a literal BACKSPACE (0x08)**, so three
  `<script|img|iframe>` regexes matched nothing, *and* the file committed as
  **BINARY** (one NUL from a control-char fixture). This file already records the
  heredoc trap; the new rule is **write any test file containing regexes through
  the editor, never a heredoc, and check `git show --stat` for `Bin` on a new
  source file.** (2) **"the html contains no `<img>`" is the WRONG assertion** —
  the shared shell contributes ONE legitimate `<img>` (the brand logo, which
  lives in `loopcomShell.ts`, so grepping `smsEmail.ts` finds nothing and the
  check reads as a real failure). **Count against a benign baseline instead.**
- ✅ **Forwarding measured healthy the same day: 13 emailed / 35 correctly skipped
  (`no_opted_in_recipients` = Gesheft, by design) / 0 inbound texts left
  unstamped in 24 h.** ⛔ **The one-query health check for "did anyone lose a
  text":**
  `select count(*) from "ConnectChatMessage" where direction='INBOUND' and "emailForwardedAt" is null and "createdAt" between now() - interval '24 hours' and now() - interval '5 minutes';`
  — anything above 0 is a text nobody was told about.
- ⛔⛔ **LOAD-STRESSING THE FORWARD HALF (2026-08-24, `b5d6a2b1`) FOUND TWO MORE
  REAL DEFECTS — BOTH IN WHAT HAPPENS AFTER THE EMAIL HAS GONE OUT.**
  **(1) `stamp()` SWALLOWED ITS OWN ERRORS, AND AN UNSTAMPED ROW IS RE-SELECTED
  ON EVERY PASS — so ONE failed database write emailed the SAME text once per
  pass until it aged out: UP TO 60 COPIES of one text** at a 30 s poll across the
  30-minute window. Measured across a full simulated window, not theorised.
  ⛔ The stamp being written AFTER the send is deliberate and STAYS (a crash must
  duplicate, never lose); what was missing is that the retry must retry the
  **STAMP**, not the send. `emailedThisProcess` (pruned to one window of
  throughput) does that: **60 passes → 1 email**, and the failure is audited as
  `sms.email_stamp_failed` instead of vanishing.
  **(2) A REFUSED SMTP SEND RETURNED SILENTLY** — `if (!res.sent) return false;`
  with no stamp, no audit and no log line. With the fresh window that means **an
  SMTP outage longer than 30 minutes loses every text's email PERMANENTLY**, and
  the only trace is `emailForwardedAt` staying null. Now `sms.email_send_failed`
  once per **PASS** — ⛔ never per message, or an outage writes ~960 audit rows an
  hour.
- ⛔⛔ **THE THROUGHPUT CEILING, MEASURED AND NOW WRITTEN DOWN: 480 texts per
  30-minute window** (`MAX_BATCH` 8 × 60 passes at the 30 s poll). A burst past
  that **ages out of the fresh window and is never emailed AND never stamped** —
  silently. **Nothing alerts on it**; the detector is the unstamped-count query
  above. Real volume is ~13/day so this is headroom, not a live problem — but it
  is a cliff, not a slope, and it is the shape a marketing blast or an SMS flood
  would hit. ⚠️ **Closer than it looks: 400 skipped (no-recipient) texts queued
  ahead of 20 real ones take 53 passes ≈ 26 minutes to clear**, against that same
  30-minute window. Skipped rows only fail to block because they ARE stamped —
  the 2026-08-18 voicemail head-of-line bug was exactly this shape with the stamp
  missing. ⛔ **Never add a skip path to this job that does not stamp.**
- ✅ **Other shapes measured and healthy:** 200 participants + case-variant
  duplicates + blank/null/malformed addresses → **201 unique recipients, ONE
  email**; 40 × 10,000-character texts → the email caps at **90 KB** (the
  8-message context window bounds it); overlapping passes never double-send (the
  `running` guard holds); one poisoned row never kills its batch; processing is
  strictly oldest-first. ✅ Message times render **America/New_York** because the
  agent container sets `TZ` — **checked, not assumed**. ⛔ That is a latent
  dependency: with `TZ` unset every bubble would silently show UTC to every
  customer.
- ✅ **Forward-half coverage is now 26 tests** — 14 content
  (`smsEmailForward.stress.test.ts`) + 12 load/failure
  (`smsEmailForwardLoad.stress.test.ts`). Both proven non-vacuous by mutation:
  removing the dedupe guard, the outage audit, the re-entrancy guard, the subject
  sanitiser, the body escaping or the backlog guard each fails exactly the
  matching invariant.
- ✅✅ **THE FORWARD HALF HAS AN ALARM NOW — `apps/api/src/sms/smsForwardGuardrail.ts`
  (2026-08-24, `ea8509c6`).** It closes the gap the load-stress opened: a text
  could be lost three ways (job stopped, SMTP outage past the window, burst past
  the 480-per-window ceiling) and **every one was invisible** — the only trace was
  `emailForwardedAt` staying null and nothing read it.
  ⛔ **It watches the OUTCOME, not the machinery: a text that aged out unsent is a
  customer who was never told someone messaged them.** Three alarms, split on
  purpose — **aged-out** (damage report, those texts are gone), **send failures**
  (EARLY warning, ~28 min before the window destroys them), **stamp failures**
  (a database problem, one duplicate each). Kill switch
  `SMS_FORWARD_GUARDRAIL_DISABLED=1`; alert window `SMS_FORWARD_ALERT_WINDOW_MS`.
- ⛔ **It follows the guardrail shape this repo has already paid for:** an
  **AgentEscalation and NEVER an `ADMIN_ALERT`** (muted at the send door — an alarm
  there reaches nobody); **de-duped over a 6 h WINDOW, deliberately NOT
  `raiseGuardrailEscalation`** (that de-dupes on any open escalation with no time
  bound, and `AgentEscalationStatus` has no RESOLVED value, so each key would fire
  exactly ONCE, EVER — the open one-shot problem recorded in the voicemail
  section); an **audit row on EVERY run including clean ones, with `actor` AND
  `hash`**; and a **boot kick beside the interval**.
  ⛔ **THE CUTOVER IS LOAD-BEARING AND WAS MEASURED:** 1,374 inbound texts predate
  the bridge and are permanently unstamped. Run against production with the
  guardrail's exact query: **0 would alarm WITH the cutover, 1,374 WITHOUT.**
  ⛔ `apps/api` names test files explicitly and **`src/sms/*.test.ts` was missing
  from the list** — the suite would never have run. Registered. 20 tests; five
  mutations each fail the matching guard.
- ⛔⛔ **A SHARED-WORKTREE NEAR-MISS, AND THE RULE IT EARNS: with `commit-tree`,
  THE TREE AND THE PARENT MUST COME FROM THE SAME HEAD.** The private-index recipe
  in this file protects against another session's *staged* work — it does NOT
  protect against HEAD moving between `write-tree` and `commit-tree`. That happened
  here: another session committed in the gap, and `commit-tree $TREE -p HEAD`
  produced a commit that **reverted their `server.ts` work and DELETED their
  brand-new test file**, because the tree predated their commit. ⛔ **My
  HEAD-moved check was worthless — it compared HEAD against a value captured in the
  same command, not against the head the TREE was read from.**
  ✅ **Caught by reading `git show --stat` BEFORE pushing** (it said
  `server.ts | 23 +-` and a 173-line deletion where it should have said `+2`);
  recovery was `git update-ref HEAD <parent>`, rebuild from the current head,
  re-verify, push. **Pin the base sha explicitly in BOTH `read-tree <sha>` and
  `-p <sha>`, and read the stat line before every push.**
- ⏳ **STILL NOT PROVEN: no CUSTOMER has replied since the fix.** It is proven by
  the four routes above — including a real SMS — but not by a person in their own
  mail client. **Acceptance: one reply to any text-email, then**
  `select event, count(*) from "AgentAuditLog" where event like 'sms.reply%' group by 1;`
  — `sms.reply_sent` should climb past 3.
- ⛔ **"I didn't get any SMS emails" is usually NOT a bridge fault — check
  whether the person is a PARTICIPANT on a thread that received a text.** Izzy
  reported this on 2026-08-20 and the bridge was healthy: his SUPER_ADMIN and
  Landau Home accounts both have the toggle ON, but the **newest inbound on any
  thread he is on was 1.9 days old**, so there was nothing to send him. The
  emails go to the thread's participants — not to admins, and not to the
  platform owner. Greppable: `sms.emailed` / `sms.reply_sent` in the agent
  audit; the per-message verdict is `ConnectChatMessage.emailForwardError`.
