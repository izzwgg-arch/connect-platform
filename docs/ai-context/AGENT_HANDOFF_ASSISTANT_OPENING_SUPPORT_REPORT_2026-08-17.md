# AGENT HANDOFF — the assistant panel's opening screen, and a customer's own way to reach a person (2026-08-17)

Commit **`b33d2e72`** on `feat/ivr-migration-takeover`.
**api + portal DEPLOYED and container-verified.** No migration, no PBX write, no
flag flipped, no tenant row changed, no customer contacted.

Mockups shown to Izzy before any code:
<https://claude.ai/code/artifact/66ba46a5-01a1-4b88-b199-a476c49c2e2a>
(three options; he picked **A**, plus "the report opens a text thread too").

---

## 1. What was asked for

> "Opening up the agent chat inside Connect, so the chat still has a little bit
> of an older look. The initial opening, I want to redesign it a little better.
> Keep it consistent with the Connect theme. Show me mockups before you do
> anything." — Izzy, 2026-08-17

Then, after the first round of mockups:

> "There should also be an option to let them, if they have any technical
> support issues."

**Scope was the FIRST SCREEN only** — what the panel shows before anyone types.
The conversation itself, the microphone, attachments, uploads and the Yiddish
bridge are untouched.

## 2. ⛔ The half that matters more than the redesign

**Until this commit, the ONLY route from a customer to a person ran through the
assistant deciding, of its own accord, to say it was passing something along.**

`apps/agent/src/escalation/escalations.ts` matches the assistant's **reply
text** against a regex of escalation phrasings ("passed to our team", "I've
passed along", …). When the model volunteers, an `AgentEscalation` row is
written and `agentEscalationDispatch.ts` texts Izzy's phones and emails the
report. **When the model does not volunteer, nothing happens and nobody is
told.** A customer whose phones were dead had to phrase the problem well enough
to talk the assistant into escalating.

That regex is already documented as fragile: the very first live test after it
shipped escaped it ("I've passed along: **…**", no team named — CLAUDE.md, the
escalations section).

**The report button removes the gamble.** It writes the escalation itself, from
what the customer typed. No model in the path, nothing to match.

⛔ **It reuses the existing delivery half rather than growing a second one.**
Everything ends at a **QUEUED `AgentEscalation` row**, which the existing
dispatcher turns into an SMS to (562) 209-6644 + (845) 723-1213 and an
`AGENT_ESCALATION` email — the one mail category the platform-wide alert mute
still lets through. A second delivery path would be a second thing to keep
working and the first one to rot. `supportReport.test.ts` asserts this file
never grows its own `resolvePlatformSmsSender` or `emailJob.create`.

## 3. What shipped

### 3a. The opening screen (Option A)

`apps/portal/components/FloatingAssistant.tsx`.

**Gone:** the second header band (`👁 Viewing with you: Dashboard`), the green
`Online — here to help` dot, the centred "Hi! How can I help?" line, the three
word-sized chips, and ~300px of empty middle.

**Now:** one header line (spark mark, "Assistant", *"Looking at Dashboard with
you"*), a greeting, and four full-width suggestion rows:

| Row | Sends |
|---|---|
| Catch me up on voicemail — *"3 unheard"* | `Summarize my new voicemails` |
| Change my phone menu | `I want to change my phone menu` |
| Explain this page | `What can I do on the <page> page?` |
| רעד צו מיר אידיש | `רעד צו מיר אידיש` |

⛔ **The unheard count is fetched as a COUNT, not a page:**
`GET /voice/voicemail?folder=inbox&pageSize=1` and read from `unreadTotal`.
Asking for a full page here would be the voicemail flood again — 100 rows
fetched every time anyone opens the panel, on every page, for every customer
(see `AGENT_HANDOFF_MINI_DIALER_BLANK_VOICEMAIL_PRELOAD_2026-08-17.md`). It is
fetched once per panel-open and a failure is swallowed: the row simply reads
"Read out what's waiting".

⛔ **The greeting cannot print an email address.** The portal's `user.name`
falls back to the email when no display name is set (`useAppContext`), so
greeting blindly produces *"Good afternoon, izzy@gmail.com."* — worse than no
greeting. `assistantGreetingLine()` in `packages/shared/src/assistantGreeting.ts`
refuses anything email-shaped, refuses the literal "User", and uses only the
first word. **The time of day comes from the BROWSER's clock, never the
server's** — Connect's server is in France, so a New York customer opening the
panel at 4pm would otherwise be told "Good evening".

⛔ **The corner bubble was deliberately NOT changed.** Izzy's answer to
"should the bubble get the spark mark too" selected both that option *and*
"keep the robot bubble". It is still the `Bot` icon, unchanged, pending his word.

### 3b. "Something not working?"

A dashed-outline bar above the typing box → a short form → a confirmation.

⛔ **It is rendered on EVERY screen of the panel, not only the opening one.**
Someone who has been going back and forth with the assistant for five minutes
without getting anywhere is exactly who needs a person.
`floatingAssistantOpening.test.ts` asserts it is not inside the
`messages.length === 0` branch.

⛔ **It is styled apart from the assistant's own suggestions** (dashed border,
grey icon, not the accent) so nobody reads it as another thing to ask the AI.

**The form is three questions and one switch:**

- *What's happening?* — free text, 10–2000 chars, **verbatim, never summarised
  by a model**.
- *Where?* — `Calls / Voicemail / Texting / The app / Billing / Something else`,
  from **one shared list** (`SUPPORT_REPORT_AREAS`) so the portal and the API's
  enum cannot drift.
- *Best number to reach you* — prefilled from `User.phone` via
  `GET /support/context` (fetched only when the report screen opens, not on
  panel open).
- **"Our phones are down right now"** — a real switch. It puts
  `** PHONES DOWN **` at the front of the SMS, so a dead phone system cannot
  read like a billing question in a list of notifications.

## 4. The route — `apps/api/src/supportReport.ts`

`POST /support/report` and `GET /support/context`, both behind the ordinary
portal JWT hook. ⛔ **Neither is in `jwtPublicRouteBypass.ts`, and a test asserts
it** — these carry a customer's words and ring the owner's phone.

⛔ **Tenant and identity come from the token, never the body.** A test asserts
the zod schema contains no `tenantId` / `userName`.

### 4a. ⛔ The transaction, and why it is not optional

The reference the customer quotes back is derived from the escalation row's own
id (`supportReportReference`), so the row must exist before its own SMS text can
be composed. Both writes run in **one `db.$transaction`**.

**Outside a transaction this is a live race:** the dispatcher sweeps `QUEUED`
rows every 30 s and would happily text Izzy the placeholder — a report reading
`…` with no company, no problem and no number.

### 4b. ⛔ Failure direction

**The escalation is written FIRST. Everything after it is best-effort:** the
text thread, the customer's confirmation text, the note folded back into the
email, the audit row. Each is wrapped and each may fail without losing the
report.

The reverse order — confirming to the customer and then failing to record it —
would tell someone their dead phone system had been reported when it had not.
`supportReport.test.ts` asserts the index of the transaction is before the index
of the send.

The one cost: if the dispatcher gets to the row before the thread note is folded
in, the email simply lacks that one line. **A late note is worth having; a
delayed report is not.**

### 4c. ⛔ The text thread lives on the ADMIN tenant, never the customer's

`resolveSupportDesk()` finds the `TenantSmsNumber` row for
`AGENT_ESCALATION_SMS_FROM` (**(845) 557-7768**), takes its tenant, and picks
that tenant's oldest active SUPER_ADMIN (falling back to TENANT_ADMIN).

A thread created on the **customer's** tenant would send from **their** number —
the customer texting themselves — and would sit in an inbox their colleagues can
read. This one lands in the same admin inbox as every reply to an escalation,
which is where Izzy already looks, and where the `FIX <code>` sweep already
reads from.

⛔ **Never an admin from a different tenant.** The send path scopes the thread
and its participants to one tenant; a cross-tenant sender is refused at the
participant check in a way that reads like a broken feature.

Returns `null` rather than throwing — no support desk means no text thread, and
the report is still filed.

### 4d. Rate limits

3 per user per hour, 12 per tenant per day
(`SUPPORT_REPORT_USER_HOURLY_LIMIT` / `SUPPORT_REPORT_TENANT_DAILY_LIMIT`).

⛔ **They count EVERY escalation from that person, including ones the assistant
raised.** The limit protects one phone, and that phone does not care which door
the message came through.

⛔ **The refusal is never a bare 429.** Someone hitting this limit is someone
with a problem we have already been told about, so the message is *"We already
have your last report and we're on it. If it's urgent, call us on
(845) 723-1213."* A test asserts the number is in that string.

### 4e. Customer-facing wording

⛔ **`safeParse`, not `parse`.** This is the one screen a customer reaches when
something is already broken; a raw zod throw renders as a slug. Every failure
path returns a plain-English `message`, and the portal reads it from
**`e.body`** — ⛔ **never `.payload`, which has never existed on `ApiError`** and
silently falls through to the bare error code (CLAUDE.md, the `.payload` trap).
Both are asserted by tests.

⛔ **The confirmation only promises a text when the text actually went.** If
`confirmationTexted` is false the screen says *"We'll be in touch on …"* rather
than *"We'll text you back on …"*. A small lie there is how "nobody ever got
back to me" starts.

### 4f. ⛔ The SMS is plain ASCII on purpose

One emoji switches the whole message to UCS-2, which cuts a segment from 160
characters to 70 — a two-segment report would arrive as five texts, on every
report, forever. A test asserts `/^[\x20-\x7E\n]*$/`.

Each line is capped **individually and then joined**. Passing the joined text
through `truncateSms` would work and would **collapse every newline into a
space**, because that helper flattens whitespace by design. `Ref XXXXXX` is last
and shortest so that whatever else is clipped, the number the customer quotes
back survives — asserted with a 5,000-character problem.

The reference itself drops **I, L, O, S, 1, 0, 5** — it gets read down a phone
line, and "was that an O or a zero?" wastes exactly the minute this feature
exists to save.

## 5. Files

| File | What |
|---|---|
| `packages/shared/src/supportReport.ts` | area list, reference, SMS/email builders (pure) |
| `packages/shared/src/assistantGreeting.ts` | `greetingName` / `timeGreeting` / `assistantGreetingLine` |
| `apps/api/src/supportReport.ts` | `POST /support/report`, `GET /support/context` |
| `apps/api/src/server.ts` | +4 lines: import + `registerSupportReportRoutes(app, { smsQueue })` |
| `apps/portal/components/FloatingAssistant.tsx` | the opening screen, the help bar, the report + sent views |

**Tests: 38 new, all passing.** 13 shared (report builders) + 7 shared
(greeting) + 10 api + 8 portal.

⛔ **All four new test files were registered in their runners' explicit file
lists in the same commit** — `packages/shared/package.json` and
`apps/portal/package.json` name every file, and an unregistered test has never
run once (three were found in that state on 2026-08-16).

⛔ **The api and portal guards read SOURCE, not behaviour.** Every defect in this
area has been a caller-side omission — a button that stopped being rendered, a
route module nobody registered, an error read off a field that does not exist.
A unit test of a helper passes straight through all three.

**Suites:** shared 334 pass / 0 fail. api 2129 tests, 8 fail — **7 are the
documented pre-existing `pbxTenantDirectorySync` failures and the 8th
(`androidApkInviteUrl`) belongs to another session's in-flight edit of that
file**, which is modified in the shared tree and not by this work. portal 133
tests, 2 fail — `campaignsIndexLayout` and `webrtcSdpDiagnostics`, **both in
files this commit does not touch and which are unmodified in the tree**.

Typecheck: portal **0 errors**; api **75**, its exact pre-existing baseline,
none in the new files.

## 6. Deploy

- api: `deploy-direct.sh api --branch feat/ivr-migration-takeover` →
  container **`36047c2c`**, verified: `supportReport.ts` present,
  `registerSupportReportRoutes` ×2 in `server.ts`.
- portal: **already carried by another session's concurrent portal deploy** —
  `app-portal-1` reads `.build-commit b33d2e72` (exactly this commit) and the
  shipped bundle greps 4 for the new markers and **0 for both retired strings**.
- ✅ **Live read-only probe:** a 60-second self-signed SUPER_ADMIN token against
  `http://127.0.0.1:3001/support/context` returned **200 `{"callbackPhone":null}`**
  — routing, auth and the handler all proven end to end on the running
  container. (Null is correct: the probe subject is not a real user.)

⛔ **The first api attempt failed with `HEAVY JOB ALREADY RUNNING:
deploy-queue:portal:compose-build-portal`** — the documented trap. The deploy
queue's `runningCount: 0` does **not** mean you can build; the heavy lock is
separate. Wait for `ps -eo cmd | grep -c "[d]eploy-direct.sh\|[r]un-heavy"` to
read 0.

⛔ **Committing in this shared tree needed the private-index technique.** Four
files this work touches were simultaneously being edited by other sessions
(`apps/api/src/server.ts`, `packages/shared/src/index.ts`, and both
`package.json` test lists). ⛔ **`git commit -F - -- <paths>` would NOT have been
enough here: a pathspec commit takes WORKING-TREE content**, which would have
swept another session's `server.ts` edit into this commit. The safe method is
the one in `AGENT_HANDOFF_WORKTREE_SWEEP_FCM_WIRING_2026-08-06.md` §4: build a
temp index with `GIT_INDEX_FILE` + `read-tree HEAD`, stage each path's blob
explicitly (a **surgical** blob = HEAD content + only your own edit, for
contested files), `write-tree`, `commit-tree`, then `update-ref` — after
re-checking that HEAD has not moved. Verified afterwards: the commit's
`server.ts` diff is exactly the 4 lines of this work.

## 7. ⏳ NOT PROVEN — the honest list

- **Nobody has opened the new panel in a browser.** It is proven as tests, a
  clean typecheck, and the shipped bundle inside `app-portal-1` — **not** by a
  human seeing the greeting draw. ⛔ **An already-open desktop app or browser tab
  keeps the OLD bundle** until it is closed and reopened (the reload banner
  appears within ~5 min).
- **No report has ever been filed.** The write path is proven by tests and by
  the module living in the running container; it has never been exercised
  against the real database, the real carrier or the real thread. **A live test
  texts Izzy's two phones, emails him and sends a confirmation SMS — it was
  deliberately not run without his word.**
- **The customer confirmation text has never been sent**, so
  `resolveSupportDesk()` has never resolved against real data. If (845) 557-7768
  has no `TenantSmsNumber` row with a tenant, or that tenant has no active
  admin, the report still files and `confirmationTexted` comes back false —
  which the screen already words honestly.
- **The unheard count has never been seen with a real number.** Proven only as
  the request shape.

## 8. Acceptance test (5 minutes, needs Izzy)

1. Close and reopen the desktop app / reload the browser tab.
2. Open the corner bubble. Expect: one header line reading *"Looking at
   Dashboard with you"*, a greeting by first name, four rows, and the voicemail
   row carrying a real count.
3. Tap **Something not working?**, type a sentence, leave *Calls* selected,
   check the number is prefilled, and send.
4. **Izzy's phone should receive** `Loopcom support - <company>` with the
   problem, the callback number and `Ref XXXXXX`; **the callback number should
   receive** a confirmation naming the same reference.
5. **The negative that matters most:** open Chat → the admin inbox on
   (845) 557-7768 should now hold a thread with that customer's number, and
   replying in it should reach their phone.
6. Tick **"Our phones are down right now"** on a second report and confirm the
   SMS starts `** PHONES DOWN **`.

## 9. Open, needing Izzy

- **The corner bubble.** Spark mark or keep the robot — his answer selected both.
- **Whether to run the live acceptance test**, which texts him.
- The mockups also offered Options **B** (capability tiles) and **C** (quiet
  composer); A is what shipped and the other two are still drawn if he wants to
  compare against the real thing.

---

## 10. "Suggest a feature" beside "Report a problem" (2026-08-20)

Izzy, 2026-08-20: *"Right when you open it up, right next to where it says
'Report a problem', there should be 'Suggest a feature'. When they suggest a
feature, it goes to … actually, it should go to info@loopcom.net."*

**What shipped.** The single dashed help bar became a `fa-help-row` with two
side-by-side dashed buttons — **Report a problem** (the existing escalation
flow, wording shortened from "Something not working?" to match its own dialog
title and fit half-width) and **Suggest a feature** (new). Both stay rendered on
every screen of the panel, outside the `messages.length === 0` branch, exactly
like the report button always was. The suggestion opens its own full-panel form
(one textarea + send) and a thank-you screen, mirroring the report views.

**⛔ The two doors deliberately have different destinations.** A problem pages
the owner's phone through the `AgentEscalation` dispatcher; a suggestion is an
**EMAIL to info@loopcom.net and nothing else** — nobody's phone rings at 2am
for an idea.

**The route: `POST /support/feature-suggestion`** in its own module
`apps/api/src/featureSuggestion.ts` — ⛔ NOT in `supportReport.ts`, because
`supportReport.test.ts` pins that the report module never grows an
`emailJob.create`; merging them would break that contract. Authenticated (not
in the JWT bypass, test-pinned), identity from the token never the body,
`safeParse` with plain-English refusals.

- **Email type `FEATURE_SUGGESTION`** — a new string on the plain-string
  `EmailJob.type` column, so **no migration**. ⛔ Never `ADMIN_ALERT` (muted at
  the send door); same rule as `PORT_COMPLETE`, and a comment-stripped source
  guard asserts the muted type appears nowhere in executable code.
- **Recipient: `FEATURE_SUGGESTION_EMAIL` env, default `info@loopcom.net`** —
  a literal on purpose: it is a mail RECIPIENT, not a platform link, so it must
  not follow `PLATFORM_MAIL_DOMAIN` (which still defaults to the old domain).
  ⚠️ **Whether the `info@loopcom.net` MAILBOX exists in Google Workspace is
  unverified** — the domain being verified proves nothing (the billing@ lesson);
  a send to a non-existent user bounces. Check before trusting delivery.
- **The email job and its audit row (`FEATURE_SUGGESTION_SENT`) are created in
  ONE transaction** — the audit row is what the per-user rate limit counts
  (`EmailJob` has no user column), so it must never over- or under-count.
  Limits: 5/user/day + 15/tenant/day (env-overridable), protecting the shared
  mailbox's 500/day allowance; the 429 is friendly, never bare.
- **The builder is pure and shared** (`packages/shared/src/featureSuggestion.ts`):
  subject carries the first 60 chars of the idea, the body carries the company,
  the person (with reply-to line when we have their email), the page they were
  on, and the suggestion **verbatim, HTML-escaped, never model-summarised**.

**Tests:** 12 api (`src/featureSuggestion.test.ts`, picked up by the existing
glob — registration guard, ADMIN_ALERT guard with comments stripped, recipient
default, bypass-list absence, token-not-body, transaction, limits, builder
units incl. escaping) + 2 portal added to the already-registered
`floatingAssistantOpening.test.ts` (both doors in the row outside the opening
branch; the send posts to the API and reads errors from `.body`). All existing
guards in both files still pass; api typecheck 75 = the exact baseline, portal
and shared 0.

**⏳ NOT PROVEN:** no suggestion has been sent by a human, and no email has
arrived at info@loopcom.net — including whether that mailbox exists at all.
Acceptance: open the panel, tap Suggest a feature, send one, then check
`select * from "EmailJob" where type = 'FEATURE_SUGGESTION'` reads SENT and the
mail is in the info@ inbox.
