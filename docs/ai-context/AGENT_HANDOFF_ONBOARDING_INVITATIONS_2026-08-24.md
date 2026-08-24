# Onboarding invitations + the step-by-step story (2026-08-24)

Commit `96cbb784` on `feat/ivr-migration-takeover`.
Mock-up Izzy approved: <https://claude.ai/code/artifact/4dbeb981-06ce-46b8-b743-2ec85f12a87d>
Mock-up-vs-built comparison: <https://claude.ai/code/artifact/361b80cd-d8c8-43df-95ed-84a3befb2059>

Izzy, 2026-08-24: *"I want to redesign the onboarding page where I can just enter
somebody's email and it would send him the link, or I should be able to generate
the link myself and send it to somebody."* Then: *"on each invitation, I should be
able to see exactly what the user did, step by step, in crazy detail, so we can
analyze it later."* Then, on the mock-up: *"Build it exactly, exactly, exactly
like the mock-ups."*

**No migration, no PBX write, no env change, no tenant row touched.** The only
new thing that leaves the platform is one email type.

---

## 1. What was actually wrong

The Onboarding screen had a **"Main Email"** box that reads exactly like it emails
the customer. It never did — it wrote the address onto the record so you could
tell whose link it was. Measured before building:

| | |
|---|---|
| sign-up links ever made | **23** |
| never opened by anyone | **11** |
| had an email on the record | 9 |
| **invitation emails ever sent by the platform** | **0** |

⛔ **`USER_INVITE` is a different email and is not this.** That one goes out much
later, once the tenant already exists, and is the "create your password" mail.
There has never been an onboarding-invite email anywhere in the codebase.

Most of those 11 dead links carry **no name and no email**, so there was nothing
to chase and no way to tell one from another. That is what the redesign is for.

---

## 2. ⛔⛔ THE FINDING THAT SHAPED THE WHOLE SECOND HALF

**The step-by-step detail was ALREADY being recorded, and had been since the
journey beacons shipped.** TYH Industries carries **98 events, to the second** —
every step with the seconds spent on the previous one, every validation message
that stopped them, every number search and what came back.

**Nobody could read it.** The old detail page printed all 98 as one unbroken
`<ul>` of raw ISO timestamps at the bottom of the screen.

⛔ **So the story screens add NO instrumentation.** `journeyStory.ts` is a pure
reader: raw rows in, story out. That is why it works **retroactively on every
sign-up that has ever happened**, including the ones that already went wrong.
Do not "add tracking" to make this page work — check what is already in
`OnboardingEvent` first.

### What the data said the moment it was readable

Computed from the real events, and reproduced by the shipped module running
inside `app-api-1`:

- **"Your number" takes a median of 398 seconds.** Every other step is 3–58s.
  It is ten times harder than the rest of the wizard put together.
- **15 of the 21 number searches ever run came back empty** — 718 ×6, 646 ×4,
  917 ×3, 347 ×1, 415 ×1. Every New York area code a customer asked for was
  sold out.
- **The most common thing that ever stopped anybody was "Please pick a number
  from the list." (5×)** — the same defect seen from the other side.

That is the TYH sign-up in one line: five area codes, thirteen searches, the
screen said nothing each time, and after six and a half minutes they took a 929
number they never asked for. ✅ **That bug was fixed on 2026-08-18** (the screen
now explains a sold-out area code) — but nobody could see the story until after
it had cost a customer.

---

## 3. What shipped

### API (`apps/api/src/onboarding/`)

| file | what it is |
|---|---|
| `inviteEmail.ts` | builds + queues the invitation |
| `journeyStory.ts` | **pure** — raw events → one sign-up's story |
| `journeyPatterns.ts` | **pure** — every sign-up → where people get stuck |
| `invitationList.ts` | **pure** — a row's state, story line, and whether to chase it |
| `invitationRoutes.ts` | the seven routes |

Plus `onboardingLinkOrigin()` / `onboardingLinkForToken()` in `publicOrigins.ts`.

**Routes** (all SUPER_ADMIN, gate handed in explicitly at registration):

```
GET    /admin/onboarding/invitations              list + filter counts
POST   /admin/onboarding/invitations              create a link, optionally email it
POST   /admin/onboarding/submissions/:id/resend   the SAME link again
GET    /admin/onboarding/email-check?email=       is this address already a login?
GET    /admin/onboarding/submissions/:id/story    the step-by-step story
GET    /admin/onboarding/submissions/:id/story.csv export it
GET    /admin/onboarding/patterns                 across every sign-up
```

### Portal (`apps/portal/app/(platform)/admin/onboarding/`)

`page.tsx` (list) · `[id]/page.tsx` (story) · `patterns/page.tsx` ·
`onboarding-admin.css`.

---

## 4. ⛔ The rules that are load-bearing

**⛔⛔ The email type is `ONBOARDING_INVITE`, NEVER `ADMIN_ALERT`.** Every
ADMIN_ALERT job is marked SKIPPED at the send door by the platform-wide alert
mute, so an invitation on that type would build clean, log clean and **reach
nobody at all**. Guard-tested.

**⛔ It rides the hardened billing shell** (`emailShell` + the VML `roundrect`).
A hand-rolled invitation looks perfect in Gmail and arrives in Outlook as bare
blue text, and nobody finds out for weeks. This is a customer's **first** sight
of Loopcom.

**⛔ Resend reuses the stored token and never mints a new one.** A fresh link per
chase is exactly how this account ended up with eleven orphans — and it does not
even invalidate the old one, so the customer ends up holding two. A source guard
fails if `secureToken()` or `onboardingSubmission.create` ever appears in that
handler; **proven by mutation**, not just written.

**⛔ Sending never hides the link.** Plenty of these customers are easier to
reach on WhatsApp than by email, so the confirmation keeps the link on screen
with a Copy button. That was Izzy's explicit ask and there is a guard on it.

**⛔ The link is absolute and says loopcom.net — but it is not pinned there.**
`onboardingLinkOrigin()` prefers `ONBOARDING_LINK_ORIGIN`, then the platform's
canonical host **if one has actually been chosen by env**, and only falls back
to loopcom when nothing has. So today it says Loopcom (Izzy's call), and the day
`PUBLIC_PORTAL_URL` is set the invitation follows it — a future move can never
strand invitation links at a dead host. Same shape as
`platformBillingContactEmail()`.

**⛔ The email-already-exists warning is not cosmetic.** An onboarding address
must be unique across the whole platform, so inviting an address that already
has a login runs the entire sign-up and then **silently fails to send that
person their welcome email at the very end**. The screen asks as you type. It
**never blocks** on a failed check — a lookup problem must not stop you inviting
somebody.

**⛔ Paying is the CUSTOMER's last step, not the first thing we did.** It lives
in the customer lane with its duration derived from reached-Payment → paidAt
(nothing downstream ever measures the last step). A **declined card is flagged
as a problem on that step** — it is the single most common place a sign-up dies.

**⛔ Medians, not averages, on the patterns screen.** With this few sign-ups one
tab left open overnight would drag a mean into nonsense and invent a problem
that is not there. Guard-tested with exactly that outlier.

---

## 5. ⛔ Traps hit while building

**⛔⛔ A mechanical class rename can silently merge two different classes.**
Prefixing the mock-up's CSS turned `.ob-act.link` (a borderless action) and
`.ob-link` (the URL display box) into the same `.oi-link`, so an "Open" action
would have inherited `flex:1`, a mono font and a panel background. Caught by
checking the rename output, now pinned by a test. **Diff the class list after
any mechanical rename.**

**⛔ `.tab` and `.tabs` already exist in globals.css, and the customer wizard
owns the `.ob-` prefix.** Every class in the ported sheet is `oi-` prefixed and
every rule is scoped under `.oi-root`; a test fails on any selector that escapes.

**⛔ A NUL byte in source makes git treat the whole file as BINARY** — no diff,
no review, ever. `journeyPatterns.ts` was written with `${step}\0${message}` as a
map key and committed as `Bin 0 -> 4404 bytes` on the first attempt. It is
`JSON.stringify([step, message])` now. **Check `git show --stat` for `Bin` on a
new source file.**

**⛔ Strip comments before any negative source match** — the stylesheet's own
header explains why `.tab`/`.tabs`/`.ob-` were renamed away, so the first version
of the prefix guard reported them as live offenders. Fourth time in this repo.

**⛔ `border-color: var(--warning)` contains the string `color: var(--warning)`.**
The "no display colour as text" guard reported 14 false failures until it grew a
lookbehind. Borders and fills are exactly where the display colour belongs.

**⛔ `git commit -- <path>` does not work on an UNTRACKED file** — it errors with
`pathspec did not match any file(s) known to git` and commits nothing. Stage the
new files with an explicit `git add` first, then commit with the full pathspec
(the pathspec is still what protects you from another session's staged work).

**⛔⛔ `git stash` was used in this shared tree by mistake and must not be.**
It captured only this session's five untracked files and was popped immediately
with nothing lost, but the rule exists for a reason and this was a near miss.

**⛔ apps/api tests need `--experimental-test-module-mocks`** or every
`mock.module` file dies and reads as a mass regression.

---

## 6. Proof

- **55 tests** — 40 api (`journeyStory` 15, `inviteEmail` 15, `invitationList` 13
  … all registered by the existing `src/onboarding/*.test.ts` glob) + 15 portal
  (registered explicitly in `apps/portal/package.json`).
- **The story tests run on the REAL TYH event stream**, copied out of production
  verbatim — it contains shapes a synthetic fixture never would: a step visited
  twice, a "Reached" line arriving after a later step was already blocked, and
  thirteen empty searches.
- **Both source guards proven by MUTATION**: removing one route's admin gate
  fails the gate guard and nothing else; making resend mint a fresh token fails
  the resend guard and nothing else.
- **Typecheck**: api **76 = the exact baseline**, 0 in any edited file; portal **0**.
- **Suites**: portal **338/340** (the two documented pre-existing failures);
  onboarding 317 pass / 49 fail — ⛔ **all 49 are the pre-existing
  `resolvePbxRouteHelperConfig is not a function` breakage** in
  setupOrchestrator/setupWatchdog/voipMsProvisioning, none of which reference
  anything in this commit (verified by grep).
- ✅ **The pure modules were re-run inside `app-api-1` against the real
  production database** and reproduced the analysis exactly (398s median, 15 of
  21 empty, 5× "Please pick a number", TYH's 98 events → 7/7 steps).
- ✅ **Every route probed live on production** with a 60-second self-signed
  token: SUPER_ADMIN **200**, an ordinary USER **403**, no token **401**, an
  unknown submission **404**, and `email-check` correctly reporting
  `izzywgg@gmail.com` as taken by Connect Communications — which is the exact
  warning case.

---

## 7. Deploy state

- **api DEPLOYED and container-verified** — `app-api-1` `.build-commit` =
  `96cbb7847460`, `verify: container commit 96cbb7847460 matches target`.
- **portal** — see the deploy log; verify by grepping the shipped `.next` for the
  STRING `Just make me a link` (⛔ never a function name — minification renames
  it and a 0-hit grep reads exactly like a failed deploy).

---

## 8. ⏳ NOT PROVEN

**Nobody has opened these screens in a browser, and no invitation email has ever
been sent to a human.** Everything above is tests, live route probes and the
shipped stylesheet — not a person using it.

**Acceptance, about five minutes:**

1. Open **Admin → Onboarding**. The list should show 23 invitations with plain-
   English states, and 10 unnamed unopened links folded away behind a line.
2. Type an address that already has a login (e.g. `izzywgg@gmail.com`) — the
   amber warning must appear as you type.
3. Type a spare address, press **Send the invitation**. The confirmation must
   name the address **and still show the link with a Copy button**.
4. **Check the inbox.** This is the half nothing else can prove — the email has
   never been seen by a person. ⛔ Outlook is structurally hardened but has never
   been rendered.
5. Open **TYH Industries** → the story should read 7 of 7 steps, 7 blocks, 15
   empty searches, with "Your number" flagged red.
6. **Where sign-ups get stuck** → "Your number" at 6m 38s against everything else.

**The negatives that matter most:**
- Pressing **Resend** must NOT create a second row in the list.
- An ordinary (non-super-admin) login must not see the screen at all.

⛔ An already-open portal tab or desktop window keeps the OLD bundle until it is
reloaded.

---

## 9. ⏳ Deliberately not built

Izzy chose "exactly like the mock-ups", and the mock-up does not draw these:

- **Texting the link.** Recommended and not built — it would be a second button
  beside the email one, using `resolveBillingSmsSender` from (845) 723-1213.
- **The four extra things worth recording** (phone-or-computer and which
  browser — **not captured at all today**; when they walked away; which box they
  were typing in; clicking a greyed-out button). The first is the most useful
  single addition: we currently cannot tell whether the number step is painful
  for everyone or only on a phone.
- **An automatic reminder** if a link goes unopened.

---

## 10. Stress test (2026-08-24, Izzy: *"Stress test the fuck out of it"*)

Commit `d937a36e`. **Three real defects, none of which review or the green suite
had found**, plus two of my own assertions that were wrong.

### ⛔⛔ The threat model, which is sharper than it looks

`POST /onboarding/:token/track` is a **PUBLIC** route — it is the customer's own
wizard reporting what they did — and `publicTrackSchema` bounds only the LENGTH
of what it accepts (`step` 60, `detail` 300). So the **text inside these events
is arbitrary and attacker-controlled** by anyone holding a sign-up link, and it
flows into the story an admin reads, the CSV an admin opens in Excel, and the
patterns screen.

### Defect 1 — ⛔⛔ our own failures were being blamed on the customer

The lane rule was **inverted**: a prefix allowlist decided what counted as
"platform", and anything unmatched was attributed to the **CUSTOMER**.

Replaying all 23 real sign-ups showed **23 distinct lines WE wrote sitting in the
customer's own steps** — the entire porting family, every VoIP.ms error, tenant
linking, even the bill they uploaded. inii mini's story literally read
**"Port-in needs manual follow-up: addLNPPort failed"** as something the customer
did on the Payment step.

⛔ **The cause is the lesson: the allowlist had been built from ONE sign-up's
events (TYH) and could only ever describe that one.**

✅ Customer beats are now recognised **positively** — `journeyTracking.ts` writes
exactly those shapes and nothing else does — and everything else defaults to the
platform lane, which is true by construction. **The direction of that default is
the whole point**: a beacon added later lands in the wrong lane, which is
visible and harmless; the old default quietly blamed a customer for our porting
failure. ⛔ Provisioning failures also stay **with their phase** now rather than
being swept into a separate "problems" bucket three phases from their context —
"Could not make X the default 911 number" *is* the interesting part of getting
their number.

### Defect 2 — ⛔ the routes validated nothing

Fuzzing the real endpoint through Fastify, measured not theorised:

| body | what it did |
|---|---|
| `{email:{}}` | stored the literal `"[object Object]"` |
| `{email:123}` / `{email:true}` | coerced to `"123"` / `"true"` |
| `{email:"@"}` / `{email:"a@b"}` | accepted — `includes("@")` was the whole check |
| `{companyName:"x".repeat(50000)}` | 50,000 characters into the DB **and into an email** |
| `{email:"a".repeat(5000)+"@b.com"}` | a 5 KB address accepted |
| `{companyName:{toString:"x"}}` | **500** — `String()` throws on an object whose `toString` is not a function |
| `{email:"a@b.com\r\nBcc: victim@example.com"}` | **stored verbatim in `toEmail`** |

⛔ **That last one is NOT safe merely because nodemailer happens to flatten
CR/LF** — a mail header must not depend on a downstream library to be well
formed. All of it was SUPER_ADMIN-only, so none was reachable by a customer; it
is hygiene on the one screen that creates customer records and sends the first
email a customer ever sees. ✅ Now a zod schema mirroring the existing
`createPublicLinkSchema`, refusing in plain English rather than dumping zod.

### Defect 3 — ⛔ one bad date took out the whole screen

`shortDate` / `gapWords` / `agoWords` asserted non-null on a parsed date
(`d(v)!`), and they run while building **every** row — so a single unreadable
value threw out of `buildInvitationRow` and **500'd the entire list**, making
twenty-two healthy invitations unreachable. They fail soft now: one row reading
*"an unknown date"* beats a blank page.

### Defect 4 — ⛔ a phase full of failures was labelled "clean"

Found by **reading a real story on production after deploying the lane fix**:
inii mini's "Getting their phone number" reported **clean** while holding four
`VoIP.ms provisioning error: …` lines.

⛔ **Same root cause as defect 1, one layer along**: the tone matcher was a
prefix list written from the one sign-up that happened to be open, so it knew
`Could not` / `Setup failed` / `Watchdog ` and nothing else. It is matched on
the **words a failure uses** now (failed / error / could not / turned off /
needs manual follow-up / declined), so a message nobody has seen is flagged the
first time it appears. ⛔ `skipped` is deliberately NOT a failure word — several
skips here are intentional (the free-account billing stamp, a bill attachment).

**The phase flag is how an admin decides where to look, so getting it wrong is
worse than showing no flag at all.** Two tests pin it, both built from the real
production message families: eight real failures that must never read clean, and
nine ordinary progress lines that must never cry wolf.

### ⛔ The pattern across all four defects

Every one is the same shape: **a rule written from a single example, applied to
a population it had never seen.** The lane allowlist, the tone matcher, the
missing body validation and the non-null date assertion were all correct for the
sign-up in front of me and wrong for the other twenty-two.

**Replaying the real population is what found them — not review, and not a green
suite.** The suite was green for all four.

### ⛔ Two of MY OWN assertions were wrong, both documented shapes

- **"the html contains no `<img>`"** fails on the shell's own **logo**, and an
  escaped `&lt;img … onerror=…&gt;` still contains the substring `onerror=`
  while being harmless text. **Count tags against a benign baseline** instead.
- **`/color: var\(--warning\)/`** matches the tail of **`border-color`**, which
  is correct usage — borders and fills are exactly where a display colour
  belongs. Needed a lookbehind; it reported 14 false failures first.

### ⛔ The control-character trap bit FOUR more times

A literal NUL or CR/LF written through a shell heredoc lands in the file as a
real byte, and **git then treats the whole source file as binary — no diff, no
review, ever.** It hit `journeyPatterns.ts` (a NUL map-key separator), both
stress files (`"\0nul"` as test data), and `invitationRoutes.ts` twice (a regex
character class, and a `\r\n` inside a doc comment).

⛔ **Write anything containing escapes through the editor, not a heredoc.** Test
data may legitimately contain a NUL — write it `" nul"` so the string still
holds one and the file stays text. ⛔ And a naive control-char scan that counts
`c < 9` **misses CR (13) entirely**; a scan that counts CR flags every CRLF line
ending in this repo. Strip `\r\n` first, then look.

### What the stress suite actually does

**72 tests across 5 files.** `onboardingInvitations.stress.test.ts` (13) and
`invitationRoutes.stress.test.ts` (12) are the new ones:

- **7,680 exhaustive** row-state combinations — every status × 4 opened times ×
  4 activity times × 4 paid times × 4 emails × 3 names — asserting no crash, no
  leaked enum, no `NaN`/`Invalid Date`, no resend offered where it cannot work,
  and **no false "nobody has ever opened it"**.
- **400 seeded random event streams** (out of order, duplicate timestamps,
  hostile payloads) with every invariant re-checked; the seed is in the failure
  message, so any failure is reproducible.
- **~280 hostile strings** through every beacon shape; **ReDoS** probes at 5,000
  characters; **5,000-event** and **20,000-event** runs for time and loss.
- **The median brute-forced** against a naive implementation over 300 rounds.
- **30 concurrent creates** (30 distinct tokens) and **25 concurrent resends**
  (one token, one sign-up, one link).
- **An RFC4180 CSV reader** proving every exported record still parses to
  exactly three fields when the customer's search box contained quotes, commas
  and newlines.
- Every hostile body through **real Fastify**, and every route refusing a
  non-super-admin.

### Proof it is not decorative

- **The route fuzz FAILS replayed against the pre-validation handler** and
  passes after — the one test, nothing else moving.
- ✅ **The shipped modules were re-run inside `app-api-1` over all 23 real
  sign-ups and 486 real events**, asserting every invariant on each. Before the
  fix: one flagged failure (inii mini's porting line in the customer lane) and
  23 misclassified message shapes. After: **"OK — no invariant broken on any
  real sign-up"**, and the only line left in the customer lane that is not
  beacon-shaped is `uploaded Invoice_14945-2026-08-01.pdf`, which belongs there.
- api typecheck **76 = the exact baseline**, 0 in an edited file; portal
  **338/340** (the two documented pre-existing).
