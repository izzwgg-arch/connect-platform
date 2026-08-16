# AGENT HANDOFF — "Fix it!" by text, and the assistant's per-tenant knowledge (2026-08-16)

Two halves of one owner directive, built the same day on
`feat/ivr-migration-takeover`:

1. **Knowledge** — `4c6f26a0` (+ `140dec3e` path fix): the assistant reads a
   system document plus THIS company's document before every answer.
2. **Approval by text** — `242d1a40`: the escalation SMS carries a one-time
   code; replying `FIX <code>` carries the fix out.

Izzy's words: *"By the time the fix comes, he already knows everything, and he
sends me permission. I say 'Fix it!' and he fixes it!"*

---

## 1. What already existed and did NOT need building

Check this before "building" any of it again — it cost nothing to verify and
would have cost a day to rebuild:

- **Opus 5 already does the fixing/reasoning.** `diagnostics`,
  `report_writing`, `security_analysis` route to `ANTHROPIC_MODEL_HEAVY`
  (`claude-opus-5`) in `apps/agent/src/llm/router.ts`. The escalation
  researcher calls `completeWithTools("diagnostics", …)` — already Opus.
- **Customer chat already runs on OpenAI gpt-5** (`support_chat`).
- **Yiddish already rides Yiddish Labs both ways.** Language is
  `ctx.preferredLanguage` (`User.uiLanguage`), falling back to a
  Hebrew-character ratio (`detectLanguage`, threshold 0.2). When bridging, the
  model reasons in English and YL does both translation legs, so the customer
  never sees model-generated Yiddish.

## 2. Knowledge: one file per tenant, plus one system file

**Files** — `docs/agent-knowledge/system.md` + `tenants/<slug>.md` (29
companies, generated from live data by `scripts/agent-knowledge/`).

⛔ **These are NOT the `docs/ai-context/` handoffs.** Those are written for
Claude sessions and are full of other tenants' failures, credential paths and
money. Feeding them to a customer-facing model is the thing this design exists
to prevent.

**Who publishes** — the **API**, at boot (`apps/api/src/agentKnowledgeSync.ts`),
reading the files out of its own image (`COPY . .` puts `/app/docs` inside it)
and upserting `AgentKnowledgeDoc` rows. The **agent only reads** those rows
(`apps/agent/src/knowledge/standingKnowledge.ts`). That split is the whole
design: the agent is a manual container rebuild, so knowledge baked into its
image would need a hand-built container per wording change. **Edit a file →
deploy the api → the assistant knows it.**

⛔ **`process.cwd()` is `/app/apps/api`, not the repo root.** The first deploy
published nothing and logged `missingDir`. It deleted nothing, because deletion
is gated on having actually read a directory. The resolver walks up now;
`AGENT_KNOWLEDGE_DIR` overrides.

**Two audiences, one file.** Outside `<!-- internal -->` is customer-safe;
inside reaches only the escalation researcher (`audience: "internal"`). The
parser **fails closed** on an unbalanced marker: the staff text goes to the
internal half AND the file is refused. `scripts/agent-knowledge/check-docs.ts`
greps the customer half for password/ssh/AMI/key/`/root/` — run it after any
edit (30 documents, ~1 s).

**Refusals, not guesses.** A tenant document must resolve to a real tenant
(`tenantId:` preferred; a bare name only when exactly one live tenant matches).
A file that fails to parse is skipped and its last good published version is
left alone. An empty or unreadable directory deletes nothing.

⛔ **Two live tenants are both named "Connect Communications"** — name-derived
filenames collided and the second silently overwrote the first. `buildSlugMap`
suffixes the tenant-id tail for **both** of any duplicated name.

**Cost** — two documents, each capped (12k chars, `AGENT_KNOWLEDGE_MAX_CHARS`)
and cut on a section boundary, behind a 60 s cache. Failure-safe throughout: no
knowledge must never mean no reply.

**Proven live** (Gesheft, through the running agent): customer block 7,080
chars including "two locations"; staff block 9,116 chars including the
mailbox-limit warning; neither leaks another company. 30 rows published.

## 3. "Fix it!" by text

**The loop.** The assistant PREPARES a draft during the chat (the existing
`prepare_add_extension` / `prepare_enable_sms` / `prepare_add_phone_number` /
permission-grant tools) → the escalation links it → the dispatcher mints a
6-digit code at SEND time and appends *"Reply FIX 481203 to approve this fix.
Nothing happens until you do."* → the owner replies from his own phone → a 60 s
sweep reads the reply, spends the code, runs the action, and texts back the
outcome.

⛔ **A text may only ever say YES to something already written down.** This path
never composes an action from the report's prose. `findPreparedFix` links a
draft only when it is from the SAME conversation, the same tenant, still
`DRAFT`, recent, and **the only candidate** — two drafts means "the fix" is
ambiguous and the owner decides on screen instead.

**The four checks before anything runs** (`applyFixByCode`):
1. the sender is one of `AGENT_ESCALATION_SMS_TO`;
2. the code matches by **hash** — the code itself is never stored, so the SMS is
   the only place it exists in the clear;
3. unexpired (24 h) and unclaimed;
4. the claim is atomic (`updateMany … where fixCodeUsedAt: null`), so a second
   text updates 0 rows and acts zero times.

Then `applyConfirmedAction` runs with **every one of its own gates intact** —
role, tenant scoping, params hash, the capability's own authorisation, the
atomic action claim, the audit. ⛔ **The password is not skipped, it is
REPLACED** by a secret of equal single-use standing; that is why `credential`
is a union inside the one apply path rather than a second apply path. A second
path is how the two would drift.

**Deliberate behaviours, each with a test:**
- ⛔ **"ok" is not an approval.** The parser demands the word AND a 6-digit
  code. `ok`, `yes`, `do it`, `approved`, a bare number, and "can you fix this"
  are all refused. Those are what people type by reflex into a thread that also
  carries ordinary conversation.
- ⛔ **A refusal or a failure leaves the code SPENT.** A re-usable code turns a
  rate limit into a retry loop over SMS, and re-running half-done external work
  is worse than not finishing it — the same rule as `transactional: false`.
- ⛔ **An unknown sender is told nothing** (no reply at all) and the code is not
  burned — otherwise a stranger could both probe for live codes and destroy
  them.
- ⛔ **The code TTL and the draft's approvable age are the SAME NUMBER**
  (`apps/api/src/agentFixPolicy.ts`). The on-screen draft TTL is 30 minutes; a
  code that outlived its draft would answer "expired" exactly when the owner
  finally replied in the morning. `maxAgeMs` is passed only by this path.
- **With several SUPER_ADMINs and no `AGENT_FIX_APPROVER_EMAIL`, it refuses**
  rather than pick one — the audit trail would otherwise name the wrong person.
  Today there is exactly one (izzywgg@gmail.com), so no config is needed.

**Where the reply is read.** Inbound texts land as `ConnectChatMessage` rows on
the admin tenant's thread for (845) 557-7768 via the worker's VoIP.ms poll
(~2.5 min). The sweep reads only that number's threads, only from allow-listed
senders, over a 30-minute window.

## 4. Not proven

- ⏳ **No customer question has yet been answered from a knowledge document**,
  and **no code has yet been texted back.** Both are proven as plumbing (78 api
  tests, 52 agent, 24 shared; two migrations applied; documents published and
  the loader exercised against real data) — not by a human.
- ⏳ **Only 6 of 29 company documents carry hand-written knowledge** (Gesheft,
  Create A Box, Trust Bookkeepings, Displaydex, inii mini, Landau Home). The
  rest are live facts with an empty "What we have learned about them".
- ⏳ The acceptance test: from a tenant admin login, ask the assistant for an
  extension. Check the escalation SMS carries a `FIX` line, reply with it, and
  confirm the extension exists, the welcome email lands, and the reply text says
  "Done for <company>".

## 5. Environment

- `AGENT_ESCALATION_SMS_TO` — the phones that may approve (also the recipients).
- `AGENT_ESCALATION_SMS_FROM` — (845) 557-7768; both the sender and the thread
  the sweep reads.
- `AGENT_FIX_CODE_TTL_MS` (24 h), `AGENT_FIX_REPLY_LOOKBACK_MS` (30 min),
  `AGENT_FIX_APPROVER_EMAIL` (only needed with more than one SUPER_ADMIN).
- `AGENT_KNOWLEDGE_DIR`, `AGENT_KNOWLEDGE_MAX_CHARS`, `AGENT_KNOWLEDGE_CACHE_MS`.
- ⛔ The agent container is a manual rebuild:
  `docker compose -f docker-compose.app.yml -f docker-compose.agent.yml up -d --build agent`.
