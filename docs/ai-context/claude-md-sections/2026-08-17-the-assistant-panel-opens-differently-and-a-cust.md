# ⛔⛔ AGENT HANDOFF — the assistant panel opens differently, and a customer can now reach a PERSON without the model volunteering (2026-08-17) — READ FIRST before touching `FloatingAssistant.tsx`, before adding anything that pages the owner, or for "the customer says nobody got back to them"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_ASSISTANT_OPENING_SUPPORT_REPORT_2026-08-17.md`**
(`b33d2e72` on `feat/ivr-migration-takeover`. **api + portal DEPLOYED and
container-verified** — api `36047c2c`, portal reads `.build-commit b33d2e72`.
No migration, no PBX write, no flag, no tenant row, no customer contacted.)
Mockups Izzy chose from: <https://claude.ai/code/artifact/66ba46a5-01a1-4b88-b199-a476c49c2e2a>
(Option **A**, plus "the report opens a text thread too"). Memory:
[[customer-can-reach-a-person-directly]].

- ⛔⛔ **THE HALF THAT MATTERS: until this commit the ONLY route from a customer
  to a person ran through the assistant DECIDING, of its own accord, to say it
  was passing something along.** `apps/agent/src/escalation/escalations.ts`
  matches the assistant's **reply text** against a regex of escalation
  phrasings. Model volunteers → Izzy's phone rings. Model doesn't → **nothing
  happens and nobody is told.** A customer whose phones were dead had to phrase
  the problem well enough to talk the assistant into escalating — and that regex
  is already known-fragile (the first live test after it shipped escaped it).
  **"Something not working?" now writes the escalation itself.** What the
  customer typed IS the report; no model in the path, nothing to match.
- ⛔ **IT GROWS NO SECOND DELIVERY PATH — everything ends at a QUEUED
  `AgentEscalation` row**, which `agentEscalationDispatch.ts` already turns into
  the SMS to (562) 209-6644 + (845) 723-1213 and the `AGENT_ESCALATION` email
  (the one category the platform-wide mute lets through). A test asserts
  `apps/api/src/supportReport.ts` never grows its own `resolvePlatformSmsSender`
  or `emailJob.create`. **Do not add one.**
- ⛔⛔ **THE ROW AND ITS TEXT ARE WRITTEN IN ONE `$transaction`, AND THAT IS NOT
  OPTIONAL.** The reference the customer quotes back is derived from the row's
  own id, so a placeholder exists for an instant — and **the dispatcher sweeps
  QUEUED rows every 30 s**, so outside a transaction it texts Izzy a report
  reading `…` with no company, no problem and no number.
- ⛔ **FAILURE DIRECTION: the escalation is written FIRST; the text thread, the
  customer's confirmation and the audit row are ALL best-effort after it**, each
  wrapped, each allowed to fail. Confirming to a customer and then failing to
  record it tells someone their dead phone system was reported when it was not.
  A test asserts the transaction's index is before the send's.
- ⛔ **THE CUSTOMER'S TEXT THREAD LIVES ON THE ADMIN TENANT that owns
  (845) 557-7768 — never their own.** A thread on their tenant sends from THEIR
  number (the customer texting themselves) into an inbox their colleagues read.
  This one lands where every escalation reply already lands. ⛔ And never an
  admin from a different tenant — the send path scopes thread + participants to
  one tenant and refuses in a way that reads like a broken feature.
- ⛔ **Rate limits count EVERY escalation from that person, chat ones included**
  (3/user/hour, 12/tenant/day) — the limit protects one phone and that phone does
  not care which door the message came through. ⛔ **The refusal is never a bare
  429**: whoever hits it already has a problem we know about, so it gives them
  (845) 723-1213 instead.
- ⛔ **The SMS is plain ASCII on purpose** — one emoji flips the whole message to
  UCS-2, cutting a segment from 160 chars to 70, so a two-segment report arrives
  as five texts on every report forever. Each line is capped **individually then
  joined**: passing the joined text through `truncateSms` works and **collapses
  every newline into a space** (that helper flattens whitespace by design).
  `Ref XXXXXX` is last and shortest so it survives any clipping, and the
  reference drops **I/L/O/S/1/0/5** because it gets read down a phone line.
- ⛔ **The unheard-voicemail count on the opening screen is fetched as a COUNT**
  — `GET /voice/voicemail?folder=inbox&pageSize=1`, read from `unreadTotal`.
  Asking for a page here would be the voicemail flood again, on every page, for
  every customer. A failure is swallowed; the row just reads differently.
- ⛔ **The greeting CANNOT be built from `user.name` directly** — it falls back to
  the email address, so a customer with no display name would read *"Good
  afternoon, izzy@gmail.com."* Use `assistantGreetingLine()`
  (`packages/shared/src/assistantGreeting.ts`), which refuses email-shaped names
  and the literal "User". ⛔ **The time of day comes from the BROWSER's clock**
  — the server is in France, so a New York customer at 4pm would be told "Good
  evening".
- ⛔ **The report button is rendered on EVERY screen of the panel, not only the
  opening one** — someone five minutes deep in a going-nowhere conversation is
  exactly who needs a person. A test asserts it is outside the
  `messages.length === 0` branch. It is also styled apart from the assistant's
  own suggestions (dashed, grey) so nobody reads it as another thing to ask the AI.
- ⛔ **Customer-facing wording is `safeParse` + `e.body`, never `parse` + `.payload`.**
  This is the one screen someone reaches when something is already broken; a raw
  zod throw renders as a slug and `.payload` has never existed on `ApiError`.
  Both asserted. ⛔ **The confirmation only promises a text when the text actually
  went** (`confirmationTexted` false → "We'll be in touch on …").
- ⛔ **Committing this needed the PRIVATE-INDEX technique, not `git commit -- <paths>`.**
  Four touched files were being edited by other sessions at the same time
  (`server.ts`, `shared/src/index.ts`, both `package.json` test lists).
  ⛔⛔ **A pathspec commit takes WORKING-TREE content**, so it would have swept
  another session's `server.ts` edit in. Use `GIT_INDEX_FILE` + `read-tree HEAD`
  + explicit `update-index` blobs (surgical = HEAD + only your edit, for
  contested files) + `write-tree` + `commit-tree` + `update-ref`, re-checking
  HEAD has not moved. Recipe in §6 of the handoff.
- ⛔ **The first api deploy failed `HEAVY JOB ALREADY RUNNING` while the queue read
  `runningCount: 0`** — the heavy build lock is separate from the queue. Poll
  `ps -eo cmd | grep -c "[d]eploy-direct.sh\|[r]un-heavy"` until 0.
- ✅ **Proven live, read-only:** a 60-second self-signed SUPER_ADMIN token against
  `127.0.0.1:3001/support/context` returned **200 `{"callbackPhone":null}`** —
  routing, auth and handler all real on the running container. 38 new tests
  (13+7 shared, 10 api, 8 portal), all registered in their runners' explicit
  file lists in the same commit.
- ⏳ **NOT PROVEN: nobody has opened the new panel in a browser and NO REPORT HAS
  EVER BEEN FILED.** ⛔ An already-open desktop app or tab keeps the OLD bundle
  until it is closed and reopened. **A live test texts Izzy's two phones, emails
  him and sends a confirmation SMS — deliberately not run without his word.**
  Acceptance test in §8 of the handoff; the negative that matters most is that
  the admin inbox on (845) 557-7768 should hold a thread with the customer's
  number afterwards.
- ⏳ **Open, needs Izzy:** the corner bubble is **unchanged** (still the robot) —
  his answer selected both "spark mark on the bubble" and "keep the robot", so
  nothing was touched. Options **B** (capability tiles) and **C** (quiet
  composer) are still drawn in the mockups if he wants to compare.
- ✅✅ **"SUGGEST A FEATURE" SITS BESIDE "REPORT A PROBLEM" NOW (2026-08-20,
  Izzy's ask — handoff §10).** The dashed help bar is a two-button `fa-help-row`
  on every screen of the panel; the report button's label shortened to "Report a
  problem" to match its own dialog. ⛔ **The two doors have DIFFERENT
  destinations on purpose:** a problem still pages Izzy's phones via
  `AgentEscalation`; a suggestion is an **EMAIL to `info@loopcom.net` and
  nothing else** (`POST /support/feature-suggestion` →
  `apps/api/src/featureSuggestion.ts` → `EmailJob` type **`FEATURE_SUGGESTION`**
  — ⛔ never `ADMIN_ALERT`, which is muted; ⛔ NOT added to `supportReport.ts`,
  whose guard test forbids it growing an `emailJob.create`). Recipient is
  env-overridable (`FEATURE_SUGGESTION_EMAIL`); job + audit row land in one
  transaction (the audit row IS the 5/user/day counter; 15/tenant/day guards the
  shared mailbox's 500/day allowance). No migration — `EmailJob.type` is a plain
  string. ⚠️ **Whether the `info@loopcom.net` MAILBOX exists in Google Workspace
  is unverified** — the billing@ lesson; a missing user bounces. ⏳ **NOT
  PROVEN:** no human has sent one and no email has been seen in that inbox.
