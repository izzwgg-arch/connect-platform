# ⛔⛔ AGENT HANDOFF — you can email a customer their sign-up link now, and read exactly what they did (2026-08-24) — READ FIRST before adding tracking to the onboarding wizard, before touching the invite email, before "resending" a sign-up link, or for "how far did that customer get?"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_ONBOARDING_INVITATIONS_2026-08-24.md`**
(`96cbb784` on `feat/ivr-migration-takeover`. **api DEPLOYED and container-verified**
— `.build-commit` = `96cbb7847460`; portal deploy state in §7 of the handoff. No
migration, no PBX write, no env change, no tenant row touched.)
Mock-up Izzy approved: <https://claude.ai/code/artifact/4dbeb981-06ce-46b8-b743-2ec85f12a87d>
Mock-up-vs-built: <https://claude.ai/code/artifact/361b80cd-d8c8-43df-95ed-84a3befb2059>
Izzy: *"just enter somebody's email and it would send him the link"*, then *"see
exactly what the user did, step by step, in crazy detail"*, then *"build it
exactly, exactly, exactly like the mock-ups."*

- ⛔⛔ **THE FINDING THAT MATTERS MOST, AND IT INVERTS THE OBVIOUS APPROACH: the
  step-by-step detail was ALREADY being recorded and had been since the journey
  beacons shipped.** TYH Industries carries **98 events, to the second** — every
  step with the seconds spent on the previous one, every validation message that
  stopped them, every number search and what came back. **Nobody could read it**:
  the old page printed all 98 as one unbroken `<ul>` of raw ISO timestamps.
  ⛔ **So `journeyStory.ts` adds NO instrumentation — it is a pure reader**, which
  is why it works **retroactively on every sign-up that has ever happened**.
  **Check `OnboardingEvent` before adding tracking to the wizard.**
- ⛔⛔ **AND THE DATA ANSWERED A PRODUCT QUESTION THE MOMENT IT WAS READABLE:
  "Your number" takes a MEDIAN of 398 seconds against 3–58s for every other
  step** — ten times the rest of the wizard put together — **15 of the 21 number
  searches ever run came back empty** (718 ×6, 646 ×4, 917 ×3, 347, 415: every NY
  area code a customer asked for is sold out), and the commonest blocker ever is
  **"Please pick a number from the list." (5×)**. That is the TYH sign-up in one
  line: five area codes, thirteen searches, silence each time, then a 929 number
  they never asked for. ✅ The silence itself was fixed 2026-08-18 — but nobody
  could see the story until after it had cost a customer.
- ⛔⛔ **`ONBOARDING_INVITE`, NEVER `ADMIN_ALERT`** — that type is SKIPPED at the
  send door by the platform-wide mute, so an invitation on it would build clean,
  log clean and reach nobody. Guard-tested. ⛔ **`USER_INVITE` is a DIFFERENT
  email** (create-your-password, sent much later once the tenant exists) — before
  this commit there was **no onboarding-invite email anywhere in the codebase**
  and the platform had sent **0 in 23 sign-ups**, while the screen's "Main Email"
  box read exactly like it emailed them.
- ⛔ **Resend reuses the STORED token and never mints a new one.** A fresh link
  per chase is exactly how this account got **11 orphaned links** (most with no
  name and no email, so nothing to chase and no way to tell them apart) — and it
  does not even invalidate the old one, so the customer holds two. Source guard,
  **proven by mutation.**
- ⛔ **Sending never hides the link** (Izzy's explicit ask — many of these
  customers are easier to reach on WhatsApp), and the screen **warns as you type**
  if the address already has a Loopcom login, because that silently kills their
  welcome email at the very END of sign-up. The check **never blocks** on failure.
- ⛔ **The link is absolute and says loopcom.net, but is NOT pinned there.**
  `onboardingLinkOrigin()` prefers `ONBOARDING_LINK_ORIGIN`, then the platform's
  canonical host **once one is actually chosen by env**, else loopcom. So the day
  `PUBLIC_PORTAL_URL` is set the invitations follow it and a future move cannot
  strand them. Same shape as `platformBillingContactEmail()`.
- ⛔ **Paying is the CUSTOMER's last step, not the first thing we did** — it sits
  in the customer lane, its duration derived from reached-Payment → paidAt
  (nothing downstream measures the last step), and **a declined card is flagged as
  a problem there**, since that is where sign-ups most often die.
- ⛔ **Medians, not averages** on the patterns screen: with this few sign-ups one
  tab left open overnight drags a mean into nonsense and invents a problem.
- ⛔⛔ **A MECHANICAL CLASS RENAME CAN SILENTLY MERGE TWO CLASSES — caught for
  real here.** Prefixing the mock-up's CSS turned `.ob-act.link` (a borderless
  action) and `.ob-link` (the URL box) both into `.oi-link`, so "Open" would have
  inherited `flex:1`, a mono font and a panel background. **Diff the class list
  after any mechanical rename.** ⛔ `.tab`/`.tabs` already exist in globals.css
  and the customer wizard owns `.ob-`, so everything is `oi-` prefixed and scoped
  under `.oi-root`, with a test failing on any selector that escapes.
- ⛔⛔ **A NUL BYTE IN SOURCE MAKES GIT TREAT THE FILE AS BINARY — no diff, no
  review, ever.** `journeyPatterns.ts` used a NUL as a map-key separator and first
  committed as `Bin 0 -> 4404 bytes`; it is `JSON.stringify([...])` now.
  **Check `git show --stat` for `Bin` on any new source file.**
- ⛔ **`git commit -- <path>` does NOTHING for an UNTRACKED file** — it errors
  `pathspec did not match any file(s) known to git` and commits nothing at all.
  `git add` the new paths first, then commit with the full pathspec (the pathspec
  is still what protects you from another session's staged work).
  ⛔⛔ **`git stash` was used in this shared tree by mistake this session.** It
  caught only this session's own five untracked files and was popped immediately
  with nothing lost — but the standing rule is never to stash here, and this was
  a near miss.
- ✅ **Proven: 55 tests** (40 api, driven on the **REAL TYH event stream** copied
  from production — it carries shapes a synthetic fixture never would; 15 portal
  guards, registered). **Both source guards fail under mutation.** api typecheck
  **76 = the exact baseline**, 0 in an edited file; portal **0**; portal suite
  338/340 (the two documented pre-existing). ⛔ The 49 failures in the onboarding
  suite are **all** the pre-existing `resolvePbxRouteHelperConfig is not a
  function` breakage — none of those three files reference anything in this commit.
  ✅ **The pure modules were re-run inside `app-api-1` against the real database**
  and reproduced the analysis exactly, and **every route was probed live**:
  SUPER_ADMIN 200 / USER 403 / no token 401 / unknown submission 404, with
  `email-check` correctly reporting `izzywgg@gmail.com` as taken.
- ⛔⛔ **STRESS-TESTED 2026-08-24 (`d937a36e` + `43fc907c`, api DEPLOYED) AND IT
  FOUND FOUR REAL DEFECTS — ALL FOUR ARE THE SAME SHAPE: A RULE WRITTEN FROM ONE
  EXAMPLE, APPLIED TO A POPULATION IT HAD NEVER SEEN.** Handoff §10.
  **(1) OUR OWN FAILURES WERE BLAMED ON THE CUSTOMER.** The lane rule was
  INVERTED: a prefix allowlist decided what counted as "platform" and anything
  unmatched was attributed to the CUSTOMER. Replaying all 23 real sign-ups
  showed **23 distinct lines WE wrote sitting in the customer's own steps** —
  the whole porting family, every VoIP.ms error, tenant linking, the bill they
  uploaded. inii mini's story literally read *"Port-in needs manual follow-up:
  addLNPPort failed"* as something the customer did on the Payment step. The
  allowlist had been built from ONE sign-up's events (TYH). ✅ Customer beats
  are recognised **positively** now (journeyTracking.ts writes exactly those
  shapes) and **everything else defaults to the platform lane, which is true by
  construction** — a new beacon lands in the wrong lane, visible and harmless,
  where the old default quietly blamed a customer for our porting failure.
  ⛔ Failures stay **with their phase**, never swept into a separate bucket.
  **(2) THE ROUTES VALIDATED NOTHING** — measured by fuzzing the live handler:
  `{email:{}}` stored the literal `"[object Object]"`, `{email:123}` became
  `"123"`, `"a@b"` passed (`includes("@")` was the whole check), a
  **50,000-character company name** went into the DB and into an email, a 5 KB
  address was accepted, `{companyName:{toString:"x"}}` **500'd**, and
  `a@b.com\r\nBcc: victim@example.com` was **stored verbatim in `toEmail`**.
  ⛔ That last is NOT safe merely because nodemailer flattens CR/LF — a mail
  header must not depend on a downstream library to be well formed. All
  SUPER_ADMIN-only, so unreachable by a customer; fixed with a zod schema
  mirroring `createPublicLinkSchema`.
  **(3) ONE BAD DATE 500'd THE WHOLE LIST** — `shortDate`/`gapWords`/`agoWords`
  asserted non-null on a parsed date and run while building EVERY row, so one
  unreadable value made 22 healthy invitations unreachable. They fail soft now.
  **(4) A PHASE FULL OF FAILURES READ "clean"** — found by reading a real story
  on production AFTER deploying (1): inii mini's number phase reported clean
  while holding four `VoIP.ms provisioning error` lines, because the tone
  matcher was the same one-example prefix list. Matched on the WORDS a failure
  uses now. ⛔ `skipped` is deliberately not a failure word.
- ⛔ **Two of MY OWN assertions were wrong, both already-documented shapes:**
  *"the html contains no `<img>`"* fails on the email shell's own **logo** (and
  an escaped `&lt;img … onerror=…&gt;` still contains `onerror=` harmlessly) —
  **count tags against a benign baseline**; and `/color: var\(--warning\)/`
  matches the tail of **`border-color`**, which is correct usage — it reported
  14 false failures before it grew a lookbehind.
- ⛔⛔ **THE CONTROL-CHARACTER TRAP BIT FOUR MORE TIMES IN ONE SESSION.** A NUL
  or `\r\n` written through a shell heredoc lands as a REAL byte and **git then
  treats the whole source file as binary — no diff, no review, ever.** It hit
  `journeyPatterns.ts` (a NUL map-key separator), both stress files (`"\0nul"`
  as test data) and `invitationRoutes.ts` twice (a regex character class, and a
  `\r\n` inside a doc comment). **Write anything containing escapes through the
  editor, never a heredoc.** Test data may legitimately contain a NUL — write it
  `"\0nul"` so the string still holds one and the file stays text.
  ⛔ **And the obvious scan is wrong twice over:** counting `c < 9` **misses CR
  (13) entirely**, while counting CR flags every normal CRLF line ending in this
  repo. Strip `\r\n` first, then look.
- ✅ **The suite is 74 tests across 5 files**, incl. **7,680 exhaustive**
  row-state combinations, **400 seeded random** event streams, 20k-event
  aggregates, ReDoS probes at 5,000 chars, **30 concurrent creates / 25
  concurrent resends**, an **RFC4180 CSV reader** proving a hostile search box
  cannot break the export, and every hostile body through **real Fastify**.
  **The route fuzz FAILS replayed against the pre-validation handler.**
  ✅ **And the shipped modules were re-run inside `app-api-1` over all 23 real
  sign-ups / 486 real events** asserting every invariant: before, one flagged
  failure and 23 misclassified shapes; after, **"no invariant broken on any real
  sign-up"**. Every fix was then **re-verified live on production** — all six
  hostile bodies now answer 400 in plain English (including the CRLF injection
  and the former 500), the porting failure sits in the platform lane, and the
  count is still 23, so no refusal created anything.

- ⏳ **NOT PROVEN: nobody has opened the screens and NO INVITATION HAS EVER BEEN
  SENT TO A HUMAN.** Acceptance in §8 of the handoff — and **the negatives that
  matter most: Resend must NOT create a second row**, and an ordinary login must
  not see the screen at all. ⛔ Outlook is structurally hardened (it reuses the
  billing shell) but has never been rendered.
- ⏳ **Deliberately NOT built, because the mock-up does not draw them:** texting
  the link; the four extra things worth recording (**phone-or-computer and which
  browser is not captured AT ALL today** — so we cannot tell whether the number
  step is painful for everyone or only on a phone; when they walked away; which
  box they were typing in; clicking a greyed-out button); and an automatic
  reminder for an unopened link.
