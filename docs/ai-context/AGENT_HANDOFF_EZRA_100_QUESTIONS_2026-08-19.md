# AGENT HANDOFF — Ezra's 2026-08-18 trainer session, all 135 questions worked

Izzy, 2026-08-19: *"ezra on the training account yesterday, with the agent logged,
100 questions. He asked the agent. Please go over all of it and make sure the
agent can execute all of them."*

Commit `ce9f2318` on `feat/ivr-migration-takeover`. **Agent container rebuilt and
verified — see §9.** No migration, no PBX write, no api/portal change, no env
change, no tenant row touched.

---

## 1. The session, and where to find it

It was **135 messages**, not 100, in **7 conversations** on 2026-08-18 between
14:39 and 16:56 UTC, all from `ezra@connectcomunications.com`
(`cmqzfih1x4bt8mw13a0occvsy`) on tenant **Connect Communications**
(`cmqzfigij4bt0mw13u2ulpd0t`, kind CUSTOMER — ⛔ *not* `connect-admin-tenant-v1`,
there are two tenants with that name).

Conversation ids, in order: `…1qtq1q`, `…ve83rl`, `…6qzjye`, `…qpq4ka`,
`…bfyo1x` (the long one, 112 messages), `…owh1xi`, `…45eh7s`.

Pull it back with `agentConversation` + `agentMessage` joined on
`conversationId`, reading **`contentEn ?? content`** (the English mirror, in case
a future session is bridged).

⛔ **Read the whole thing before judging any single answer.** Three of the worst
replies are only explicable from the message *before* them — they are stuck
states, not bad answers.

## 2. ⛔⛔ THE HEADLINE: the assistant promised 48 times to pass a request to the Connect team, and NOT ONE reached anybody

Measured, not inferred: **48 escalation promises in that session, 0
`AgentEscalation` rows.** The only escalation created anywhere on 2026-08-18 came
from a Trimpro customer at 20:46, in a different conversation.

Widened to the whole platform: **93 promises in admin-mode conversations since
2026-08-06, 0 rows**, across Connect Communications (90), the admin tenant (2)
and Matamim (1).

Two independent faults had to line up, and **each alone was enough to lose every
one of them**:

### 2a. The gate — the word "owner" means two different things

`EscalationService.considerTurnInner` opened with:

```ts
// The owner chatting with the assistant escalating to... the owner, is noise.
if (ctx.role === "owner") return;
```

That comment is about the **platform** owner (Izzy). But `ctx.role` is the
**agent's admin MODE**, and `mapUserRole` has promoted **TENANT_ADMIN → "owner"**
since 2026-08-06 — a deliberate, correct fix so a customer's own administrator
gets admin-grade capabilities in the agent.

So from that day, **the single likeliest person to ask for a change — the
customer's own admin — was the one person who could never reach anybody.** All 7
of Ezra's conversations are `role=owner`; every promise was discarded before the
phrasing check ever ran.

✅ **Fixed:** suppression now hangs off **`isPlatformStaff()`** (`authRoles.ts`),
which is **SUPER_ADMIN only**, carried from the raw JWT role as
`AgentIdentity.platformRole`. ⛔ **It fails TOWARD escalating** — an unknown or
missing role is *not* staff, so the request reaches a person. A spurious
escalation is a text somebody reads and corrects; a dropped one is silence, and
silence is the bug.

⛔ **The rule to carry: `mapUserRole` answers "does this person get admin mode?"
and `isPlatformStaff` answers "is this person US?" Never use the first to decide
the second.**

### 2b. The phrasing — the model says "the **Connect** team"

`ESCALATION_RE` accepted `to our/the [human] [support] team`. The model's actual
words in this session:

| phrasing | times |
|---|---|
| "I've passed this to the Connect team" | 22 |
| "I've passed this request to the Connect team" | 6 |
| "…to the Connect team as a routing request" | 2 |
| "…to the Connect team to configure" | 2 |
| eleven more one-off variants naming the Connect team | 11 |
| "I've flagged this for our team" (the only shape that matched) | 5 |

**43 of 48 would have been missed even with the gate fixed.** The allow-list of
`human`/`support` was derived from a transcript months ago; the model free-forms.

✅ **Fixed:** the qualifier before "team" is now **open** (up to two words), so
"the Connect team", "the support team", "the Connect support team" and whatever
it says next month all match.

### 2c. …and the new half of that fix: an OFFER is not a promise

Widening the idiom surfaced 9 replies of the shape *"I **can** pass that to the
Connect team — which key should callers press?"* and *"**Once I have** those
details, I'll pass it on."* Those are the assistant asking for information.
Firing on them texts Izzy a half-formed request the customer never finished, and
trains everyone to ignore the alerts.

`isEscalationReply` now judges **sentence by sentence**, and a sentence carrying
a modal ("can/could/would pass"), a condition ("if you…", "once I…"), a
"before passing", a "must be", or a "please provide" is not a promise. A reply
that promises in one sentence and qualifies in the next is still a promise.

**Proven against the real corpus: 48/48 promises caught, 0 false positives among
the other 87 replies.**

## 3. ⛔ The hold-music clarify trap — eight consecutive questions swallowed

Q116 asked to change hold music. The agent asked *"Which hold music would you
like?"* From then on, **every message was answered with that same question** —
through the end of that conversation and into the next one:

- "Can you change the company's hold music without changing mine?" *(fair)*
- "Can you tell me where calls to my extension go when I don't answer?"
- "Can you temporarily forward my extension somewhere else?"
- "Can you remove the forwarding and restore my original setup?"
- "What happens if you try to route a call to an extension that doesn't exist?"
- …and three more.

**Mechanism, and it is self-sustaining by construction:** while the clarify
question is the last assistant message, `resumeMohClarification` treats anything
*scope-shaped* as the answer — and the scope test matches the bare words
**`extension`** and **`company`**. `MOH_DEACTIVATE_RE` also matches a bare
**`remove`**, which is how "remove the forwarding" read as "turn the hold music
off". The reply to each of those is that same clarify question, so the state
**re-armed itself every turn**. Once entered, there was no way out.

A second, related grab: `MOH_STATUS_Q_RE` is deliberately anaphoric ("which one
am I on right now?"), so it also matched *"**What** teams or ring groups are
**currently** configured?"* and answered it with the hold-music status.

✅ **Fixed, three ways:**
1. `MOH_NEW_REQUEST_RE` — a message that **opens like a fresh request** and never
   mentions hold music is a fresh request, however scope-shaped its wording.
   Genuine answers ("Jazz", "the whole company", "just mine", "back to the
   regular schedule") do not open with an interrogative, and a genuine
   hold-music question still resumes because it names the thing.
2. `MOH_OTHER_SUBJECT_RE` — the status detector no longer fires on a question
   that names a *different* subject (teams, ring groups, IVR, voicemail,
   forwarding, holidays…). ⛔ **`extension` and `schedule` are deliberately NOT
   in that list** — an extension is the *scope* of a hold-music setting, and
   "the regular schedule" is hold-music's own wording for its default state.
3. `MOH_MAX_CONSECUTIVE_CLARIFIES = 3` — belt to the braces. **No clarify state
   in this orchestrator may survive three unanswered asks.**

## 4. `my_requests` — "any pending request?" had no tool behind it

There was a way to **cancel** requests (`cancel_my_requests`) and no way to
**list** them, so Q3 was answered from the conversation dossier: it recited
extension requests from two weeks earlier and said *"I don't have a confirmed
update showing that these were completed."*

✅ New read-only tool `my_requests` (`selfServiceTools.ts`): the caller's own
escalations, newest first, with what each asked for and where it got to in plain
English. ⛔ `FAILED` is reported as **"still being sent to the team"**, not
"failed" — the dispatcher retries those, so from the customer's side it is still
on its way. ⛔ It reports that a request *reached the team*, never that it was
actioned.

## 5. ⛔ What the agent CAN execute today — the honest inventory

This is the answer to "make sure the agent can execute all of them". The doors
are `/internal/agent/*`; the extractor that drives them is
`triage/pbxCfgLlmExtract.ts`.

### ✅ Executes for real (proven in this session or by existing tests)

| capability | evidence from 2026-08-18 |
|---|---|
| Do Not Disturb on / off / status | **Q114 + Q115 really executed** — two `pbx.M11` rows, both EXECUTED |
| Extension registration status | Q112/Q113 answered from live data |
| Hold music — set, status, per-extension vs company | Q116 asked correctly (then trapped, §3) |
| Voicemail inbox + transcripts | Q2 answered with real counts |
| Call history / recent calls | used inside the Q134 audit |
| Contacts — **list** | Q11 |
| Where a number routes / restore a route | Q27, Q128 |
| Queue — status, add/remove member, hold music, announcements | Q110 |
| IVR — set/clear a key, swap the welcome greeting, upload a recording | *(untestable here: the account has no IVR menu)* |
| Screenshot understanding | Q13 read the Contacts page from a PNG |
| Account setup info, phone-number search, prepare add-extension / enable-SMS / add-number (password-gated) | — |
| Mark my chats read, cancel my requests, **list my requests** (new) | Q6/Q7 |

### ⛔ CANNOT execute — no door exists. These need building.

| what Ezra asked for | questions | what is missing |
|---|---|---|
| **Create an IVR menu** | ~15, incl. the fully-specified Q24 | the door has `set_entry`/`clear_entry`/`set_welcome` and **no create**. Q24 gave a complete spec (press 1 → Sales ext 101, 20 s, then voicemail; press 2 → Service; press 0 → operator; invalid → replay; no input → replay once then voicemail) and got the generic "I never guess with call routing" |
| **Submenus / menu-to-menu links** | Q36, Q37 | — |
| **IVR timeout / retries / invalid-key behaviour** | Q92–Q101 | ⛔ the **API has accepted `timeoutSeconds` (1–60) and `maxRetries` (1–10) since 2026-08-09** and the Studio has pickers — the agent simply has no operation for them. **Cheapest real win on this list.** |
| **Business hours — read or write** | Q48–Q57 (14) | no door at all. `set_schedule` exists on the IVR door and the extractor never emits it |
| **Holidays — read or write** | Q58–Q67 (10) | no door |
| **Create a greeting / recording** | Q68–Q81 | `native_upload_recording` exists (bytes in); nothing generates one from text, though ElevenLabs + Polly are wired in the API |
| **Ring groups — create, add/remove members** | Q102–Q108 | `POST /voice/teams` exists and creates queues + ring groups; the agent has no capability pointing at it |
| **Extension forwarding / no-answer destination** | Q88–Q90, Q118–Q120 | no door |
| **Add a contact** | Q12 | read-only today |
| **Read the CONTENTS of the page the user is on** | Q8, Q14, Q22 | it knows the page NAME and path only. Q22 ("read the 'Explain it to me' section") is the clearest ask |
| **Audit the call flow for loops / broken destinations** | Q133 | Q134/Q135 produced a genuinely good account audit; Q133 asked for a *routing* audit and got the route readout |

⛔ **A note on how this session reads worse than it is:** Ezra's account has **no
IVR menu, no schedule, no holidays, no teams and one extension (1101)**. Around
40 of the 135 questions are about objects that do not exist, so "Your phone
system doesn't have any IVR menus yet" is the *correct* answer. **Re-run the set
against a tenant that actually has a menu before drawing conclusions about the
IVR answers** — and note that the "no IVR" reply is itself a small defect when
the user is plainly asking to *create* one.

## 6. Two smaller things worth knowing

- **The LLM anchors on recent context.** Q78–Q81 asked about unanswered calls,
  Sales voicemail and reaching voicemail directly, and each got an answer about
  **holiday recordings** — the subject of Q75. Q82 in a *new* conversation asked
  Q78 verbatim and was answered correctly. Not a state machine bug; history
  contamination. Untouched here.
- **Q6/Q7 answered "there were no pending requests to cancel"** and that was
  literally true (the tool only cancels QUEUED/FAILED, and by then §2 meant
  nothing had ever been queued). With §2 fixed, `cancel_my_requests` also returns
  `alreadySentToOwner` — the model should say that number.

## 7. ⛔ What changes for Izzy the moment this deploys

**Tenant admins' requests start reaching your phone again.** That is the fix
working. Sizing, so it is not a surprise:

- **9 ACTIVE TENANT_ADMIN accounts** across the platform.
- Dedupe is **one escalation per conversation per 30 minutes**, so Ezra's 7
  conversations would have produced roughly 7–9 texts, not 48.
- The api-side ceiling of **40 escalation SMS per rolling 24 h** still applies.
- SMS goes to **(562) 209-6644 + (845) 723-1213** from (845) 557-7768, plus the
  `AGENT_ESCALATION` email.

⛔ **A trainer session now costs real texts.** If Ezra is going to run another
100 questions, either expect the texts or say so first.

## 8. Tests

**26 new**, in two files, both picked up by the existing `src/**/*.test.ts` glob:

- `escalation/escalationGate.test.ts` (11) — who is suppressed, what counts as a
  promise, the offer-vs-promise line, and **three SOURCE guards** on the wiring.
  ⛔ **The gate had NO test coverage at all before this, which is exactly how it
  shipped**: `escalations.test.ts` covers the SMS builder and never drove
  `considerTurn`, so the suite stayed green through two weeks of dropped
  escalations.
- `triage/mohClarifyTrap.test.ts` (14) — the eight swallowed questions verbatim,
  the genuine answers that must still resume, and the three-ask cap.
- plus one in `auth.test.ts` pinning that the raw platform role survives.

✅ **Every source guard replayed against `HEAD` and proven non-vacuous**, including
a direct proof that HEAD's regex misses "the Connect team"
(`scratchpad/replay.js` pattern — extract `ESCALATION_RE` from the HEAD blob and
run it against the real sentence).

Agent suite **643 tests, 641 pass**. The 2 failures are **pre-existing** in
`corpus/archive.test.ts` and `transcription/everett.test.ts`, neither touched
here (`git diff --name-only HEAD -- apps/agent/src/corpus apps/agent/src/transcription`
is empty). Typecheck at its **exact 15-error baseline**, none in an edited file.

## 9. Deploy

⛔ **The agent is a manual container rebuild — it is in NO deploy queue**, and it
builds the **server clone's working tree**, so `git fetch` alone does not move
it. Reset the clone first, and only when no deploy is running:

```
cd /opt/connectcomms/app && git fetch origin feat/ivr-migration-takeover \
  && git reset --hard origin/feat/ivr-migration-takeover
docker compose -f docker-compose.app.yml -f docker-compose.agent.yml up -d --build agent
```

⛔ **Verify the CONTAINER, never the build log** — grep the new symbols inside it
(`isPlatformStaff`, `MOH_NEW_REQUEST_RE`, `my_requests`).

## 10. ⏳ NOT PROVEN

- **No escalation has been created by a real tenant admin since the fix.** It is
  proven by 26 tests, by the 48/48-on-0-false-positives corpus replay, and by
  the symbols being in the running container — **not** by a text arriving on a
  phone. **The acceptance test is one message from a tenant-admin account that
  ends in "I've passed this to the Connect team", followed by a row in
  `AgentEscalation` and a text.** Ezra can do it in 30 seconds.
- **Nobody has re-run the hold-music flow in a real chat.** The trap is proven by
  the eight verbatim questions in a unit test against the real orchestrator.
- **The capability gaps in §5 are untouched.** Nothing there was built; the
  agent still cannot create an IVR menu, set business hours or holidays, make a
  greeting, or create a ring group. Those are Izzy's to prioritise — the
  IVR timeout/retries pair is the cheapest, because the API side already exists.
