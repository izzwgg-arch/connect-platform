# PLAN — a Claude agent that opens on each support ticket (2026-08-27)

**Status: SCOPE ONLY. Nothing built, nothing deployed, no code changed.**
Izzy, 2026-08-27: *"every time a support comes in through LoopCom support chat,
it would kick off an agent automatically that would take care of it"*, then
*"all agents should open up in this project and follow the project rules"*, and
on self-approval: *"I trust Claude enough by now to approve its own work, most
of it, but it would always be watched by a human."*

## 0. The correction that shapes everything else

An MCP server cannot be the trigger. MCP is pull-only: a client connects and
calls tools; nothing in the protocol wakes an idle agent. The trigger must be
something on LoopCom's side that STARTS an agent process. An MCP server is only
useful afterwards, as packaging for tools that already exist in `apps/agent`.

## 1. Most of this already runs

`EscalationService.research()` (`apps/agent/src/escalation/escalations.ts`)
already fires an LLM run with tools the moment a support chat produces an
escalation — `completeWithTools` on the `diagnostics` route, read-only
tenant-bound tools — and drafts ISSUE / FINDINGS / PROPOSED FIX. The api's
30-second sweeper (`agentEscalationDispatch.ts`) then texts Izzy, and where the
request maps to a safe capability `offerFixCode` attaches a one-time code so a
reply of `FIX <code>` executes it.

**The `AgentEscalation` row IS the ticket; its id is the reference to hand over.**

What is missing is not the trigger. It is that the researcher is read-only,
tenant-scoped, one-shot, and has no hands — it cannot read the repo, run a
command, or look at a live page.

## 2. Measured facts (loopcom, 2026-08-27)

- **Claude Code is NOT installed.** `which claude` → nothing. Node is v20.20.0
  (fine), 345 GB free.
- An `ANTHROPIC_API_KEY` already exists in `app-agent-1`, so a billing line
  exists. A SEPARATE key for ticket runs is still worth it, purely so the spend
  is attributable rather than mixed into chat.
- **`CLAUDE.md` is 1,219,928 bytes / 15,843 lines ≈ 305,000 tokens**, plus 172
  handoffs totalling 4.4 MB under `docs/ai-context/`. That is the rules load,
  per ticket. Prompt caching is not an optimisation here — it is the only thing
  that makes it affordable, and it means the ticket agent must reuse a STABLE
  prefix. A rules file rebuilt per run defeats the cache.

## 3. ⛔⛔ THE FINDING: three project rules are unsafe unattended

"Follow the project rules" is the right instinct — the rules that hold in this
codebase are the ones written down, and CLAUDE.md is where they are. But three
of them are written for a SUPERVISED session and are actively dangerous when
nobody is watching the keyboard:

1. **"every finished task ends: commit → push → deploy."** An unattended agent
   following this literally **ships code to production at the end of a support
   ticket.**
2. **"END of every task — UPDATE THE MD FILES, AUTOMATICALLY."** It would append
   to a 1.2 MB CLAUDE.md that live parallel sessions are also editing. The
   shared-worktree commit hazard is the single most-documented trap in this
   repo, and an unattended committer is precisely its shape.
3. **"THE WORK TREE MUST BE EMPTY BY THE END OF THE DAY."** CLAUDE.md itself
   warns that clearing the tree is a triage, never `git add -A`, and that a
   worktree file can be OLDER than HEAD. Done unattended, this reverts live work.

✅ **The fix: keep CLAUDE.md's SAFETY rules, replace its WORKFLOW rules.** A
scoped `CLAUDE.support-agent.md`, read INSTEAD of the ending rules, whose own
first line is: never commit, never push, never deploy, never edit a tracked file.

## 4. ⛔ It must not run in `/opt/connectcomms/app`

Deploys hard-reset that clone, so an agent working there loses its work
mid-ticket; and an untracked file there blocks the next deploy's
`git checkout -B`. It already carries three untracked files today
(`HANDOFF.md`, `HANDOFF-webrtc-ringtone-2026-07-22.md`,
`ops/deploy-queue/var/`). The ticket agent needs its own clone.

## 5. Build order

**Phase 0 — prove the undo.** Does `grant_permission` actually revert?
`resultSnapshot` / `revertOfId` / `revertAt` are in the schema; whether the path
works has never been exercised. **Auto-approval is safe exactly in proportion to
how good the undo is.** Nothing else starts until this passes.

**Phase 1 — the runner.** A sweeper in the **api**, not the agent container (the
agent is a manual rebuild and in no deploy queue — which is why the escalation
dispatcher already lives in the api). Atomic claim (`updateMany` guarded on a
null column, the pattern used everywhere here) so one ticket can never be picked
up twice; a daily ceiling like the 40/day SMS cap; an env kill switch.

**Phase 2 — the session.** Claude Code headless on loopcom, cwd = its own clone,
handed the escalation id and nothing else. Reads the scoped rules file.

**Phase 3 — auto-approval.** A third credential kind on `applyConfirmedAction`
— it REPLACES the credential and skips no gate, exactly as the SMS one-time code
already does (capability authorisation, tenant scoping, params hash, atomic
single-use claim, audit all run identically). **No second apply path.**
Auto: `grant_permission` (transactional, pure DB), `enable_sms` (one reversible
flag). Not auto: `add_extension` (Izzy's call). **Never** `add_phone_number` —
real money at VoIP.ms, `transactional: false`, and a number cannot be un-bought.

## 6. What "watched by a human" has to mean mechanically

Watched-AFTER only survives if undo works (§5 Phase 0). Then: it texts what it
**did**, not what it wants to do, with a one-word undo; applied actions already
surface on the support desk; and the caps are code, not instructions.

⛔ The remaining exposure, stated plainly and not as an objection: the ticket
text is written by a customer, so auto-approval means a stranger's words can
cause a write. That is not a question about trusting Claude's judgment — it is
that the input is not from us. It is bounded by the four capabilities being the
only writes that exist, and by the undo.

## 7. Open decisions (Izzy's)

- Where runs live: a second clone on loopcom, or a git worktree.
- May it write files at all, or read-only + propose?
- The daily ceiling. Volume is **7 escalations in 30 days (~2/week)**, so 5/day
  is generous.

---

# Round 2 (same day) — the cloud half, and where the MCP finally belongs

Izzy: *"we should be able to do it in the cloud as well"*, and then
*"I want to make it so it syncs. I should be able to enable in the MCP if I
should see live the technical support come in locally or not."*

## 8. ⛔ CORRECTION to §2 — I was wrong about prompt caching

§2 said caching is "what makes it affordable". That is true **within one
ticket's run** and false **across tickets**. Cache TTL is **5 minutes by
default, 1 hour maximum**. Tickets arrive ~2 a week, so the cache is always
cold when a ticket starts — every ticket pays a fresh cache WRITE (~1.25×), not
a read.

Corrected shape, at Opus 5 input $5.00/MTok:

- turn 1 of a run: ~305k tokens written to cache ≈ **$1.90**
- every turn after, within the run (seconds apart, cache warm): ~0.1× ≈ **$0.15**
- a 20-turn run ≈ **$5 in input**, plus output

So ~$5–10 a ticket, and at 2/week that is noise. **Caching still matters — it
is what stops a 20-turn run costing $30 — but it never amortises across
tickets.** Do not plan as if it does.

## 9. ✅ The better answer to the size problem: don't carry the rules, READ them

At 1.2 MB, CLAUDE.md should not be a prompt the agent carries — it should be a
file the agent opens. That is literally what the project rule already says
("READ THE MD FILES FIRST"). So the ticket agent gets a SHORT scoped rules file
(one page) that points at the CLAUDE.md sections and handoffs worth reading for
this ticket, and reads them on demand. Cheaper, and it is the behaviour the
repo already asks for.

## 10. The cloud shape: Managed Agents

Four ways to build an agent; only one supplies BOTH the harness and the
deployment:

| Approach | Harness | Deployment |
|---|---|---|
| Claude API manual loop | you | you |
| Tool Runner | SDK | you |
| **Managed Agents (CMA)** | **Anthropic** | **Anthropic** |
| Claude Agent SDK | SDK (Claude Code harness) | you |

So: **cloud = Managed Agents. On loopcom = Claude Agent SDK.** Same ticket
queue, two workers.

**And this is the trigger, plainly:** the flow is `POST /v1/agents` **once**
(model, system, tools, mcp_servers, skills live here) and `POST /v1/sessions`
**per run** (a pointer to the agent id — nothing else). **`sessions.create` IS
"kick off an agent."** That is the call LoopCom's sweeper fires with the
escalation id. There is no MCP in that sentence.

⛔ Pitfalls that would cost a day each: the agent is created **once** and
versioned (`POST /v1/agents/{id}` bumps a version; sessions pin to one) — never
`agents.create()` in the hot path; `model`/`system`/`tools` on a session body is
rejected; archiving is **permanent, no unarchive**.

### Two CMA features that directly answer the risks in §5–§6

- **Session budgets** — a hard, dollar-denominated cap on one session, enforced
  by the platform. It pauses at `stop_reason: budget_reached`. That is a better
  runaway guard than anything we would write, and it is a platform primitive.
- **Vault `environment_variable` credentials** — secrets stored by Anthropic and
  **substituted at egress, never visible in the sandbox.** Given that the ticket
  text is customer-written (§6), a secret the sandbox cannot read is a secret a
  prompt-injection attempt cannot exfiltrate. MCP auth goes through vaults too;
  the agent's `mcp_servers` array carries `{type, name, url}` and no auth.

## 11. ✅ WHERE THE MCP ACTUALLY BELONGS — the local/live switch

Izzy's newest ask is the first thing in this conversation that MCP is genuinely
the right tool for. It is not the trigger; it is the **view and control surface**
his own Claude Code attaches to.

Tools the LoopCom MCP server exposes: `list_tickets`, `get_ticket`,
`claim_ticket`, `get_routing_mode`, `set_routing_mode`.

Remote MCP is supported by URL, so it can be hosted next to the api and used by
both the cloud agent and his local session. ⛔ **The MCP connector needs BOTH
halves** — `mcp_servers=[{type:"url", url, name}]` **and**
`tools=[{type:"mcp_toolset", mcp_server_name:<same name>}]`, with beta
`mcp-client-2025-11-20`. Declaring only the server is a validation error.

### ⛔⛔ The sync rule: ONE queue, ONE atomic claim, never two workers

`routing_mode` is `cloud` | `local` | `both`, and it must be **enforced
server-side in the claim**, never as a local preference. The cloud sweeper's
atomic claim (`updateMany` guarded on a null column) reads the mode before it
claims: in `local` mode it does not claim at all and the ticket sits for his
session to pick up through the MCP; in `both` it claims only what a local
session has not.

If the flag lives on the client, a ticket gets worked twice — by the cloud agent
and by him — and with auto-approval on (§5 Phase 3) that means two grants, two
extensions, or two of anything else. **The flag IS the claim, or it is nothing.**

⛔ "Live" is still pull: MCP clients poll, servers do not push into a local
Claude Code session. So local-live means his session polls the MCP on a loop.
That is fine — it just must not be described as a push.

## 12. Revised build order

Unchanged: **Phase 0 is still proving the revert.** Then:

1. `routing_mode` + the atomic claim in the api (the sync rule, §11).
2. The LoopCom MCP server — read tools + the routing switch. Useful on its own:
   it gives him a live ticket view from his own Claude before any agent runs.
3. The cloud worker: one CMA agent config (versioned, created once), a session
   per ticket, session budget set, vault credentials, repo mounted, short scoped
   rules file.
4. Auto-approval (§5 Phase 3) last — after the revert is proven.

Step 2 is worth doing even if he never turns the automation on.

---

# Round 3 (same day) — OpenAI keeps the customer, Claude does the work

Izzy: *"I would also like the agent in LoopCom … we'll just leave in LoopCom the
openai agent. The openai agent will communicate with claude through the MCP on
what needs to be done, or what the problem is, and then OpenAI would communicate
with the customer."*

## 13. ✅ The split already exists — read `llm/router.ts` before building it

`DEFAULT_ROUTES` (`apps/agent/src/llm/router.ts:63`):

- `support_chat` → **openai** (`OPENAI_MODEL`), Anthropic as fallback
- `diagnostics` → **anthropic** (`ANTHROPIC_MODEL_HEAVY`), OpenAI as fallback

So "OpenAI talks to the customer, Claude does the technical work" is the routing
table as shipped. The escalation researcher already runs on `diagnostics`, i.e.
already on Claude. **This proposal is ~80% built; do not rebuild it.**

## 14. What is genuinely new — and it is worth more than the plumbing

**Today the loop does not close.** Claude researches, the api texts Izzy, and the
customer is told "I've passed this to the team" and then hears nothing until a
human acts. Nothing returns Claude's answer to the conversation.

Izzy's design closes it: Claude writes the answer onto the ticket, and the
OpenAI agent — which owns the customer relationship — reads it and speaks. That
is the feature. The MCP question is secondary to it.

## 15. Make the handoff EXPLICIT — this deletes a known-fragile mechanism

Escalation is currently detected by regex-matching the assistant's **own reply**
(`ESCALATION_RE`, `escalation/escalations.ts`). The file's own comments record
that the model free-forms its phrasing and that the first pattern set matched
**5 of 48** real promises before it was widened to the idiom.

If the OpenAI agent instead **calls a tool** to hand off — `hand_to_claude(problem)`
— the regex is not needed at all. A tool call is a fact; a phrase match is a
guess about one. Keep the regex only as a safety net for a model that promises
without calling the tool.

## 16. ⛔ It should NOT be MCP — and the reason is the boundary

MCP is a protocol for reaching **across a process boundary**. It earns its place
where the client is OUTSIDE LoopCom:

- Izzy's local Claude Code (§11, the live/local switch) — **yes, MCP**
- the cloud CMA agent reaching back into LoopCom (§10) — **yes, MCP**
- **OpenAI → Claude, both inside `apps/agent`** — **no.** The agent already has
  `toolRegistry.ts` + `completeWithTools`, already on OpenAI `/v1/responses`
  with tools. Adding one gated tool is a normal tool. Routing it through MCP is
  a second implementation of a thing that already works, with its own auth,
  transport and failure modes.

## 17. ⛔⛔ THE DESIGN TRAP: a handoff tool must NOT block

A Claude investigation takes minutes. If `hand_to_claude` blocks until Claude
finishes, the OpenAI request times out and the customer is abandoned mid-sentence
— the worst possible failure for the one surface the customer can see.

**It returns a REFERENCE immediately**, and the answer arrives later. Which is
exactly the ticket queue in §5: the tool writes the `AgentEscalation` row and
returns its ref; the sweeper picks it up; the answer comes back onto the ticket.
`my_requests` (already built) is how the customer asks where it got to.

## 18. ⛔ Two audiences on the way back, or the translation loses it

Claude's output must carry BOTH:

- a **technical report** — for Izzy, the existing ISSUE / FINDINGS / PROPOSED FIX
- a **customer-safe sentence** — which OpenAI relays **verbatim**, not paraphrased

Without the second, OpenAI paraphrases a technical finding and
*"T7_102_1 has no contact on the AOR"* reaches a customer as *"your phone is
broken"*. The standing-knowledge docs already split exactly this way with
`<!-- internal -->` markers (`knowledge/standingKnowledge.ts`) — reuse that rule
rather than inventing a second one.

## 19. The unstated argument FOR this design

Keeping OpenAI as the mouth preserves the customer-facing half **exactly as it
is** — the Yiddish Labs bridge in both directions, the degraded fallbacks, the
tone, the `fallbackReply("yi")` behaviour. That half is tuned and proven, and
this change does not touch it. Claude gets the hands; OpenAI keeps the voice.

---

# Round 4 (same day) — MCP to Izzy's OWN Claude, as the temporary shape

Izzy: *"I would prefer the MCP just because Claude over here already has all the
memory and knows the system. The system over there is a new memory, and it's not
even working properly … at least temporary until the internal Loopcom works."*

## 20. ⛔ §16 ("it should NOT be MCP") DOES NOT SURVIVE THIS — and that is correct

§16 argued against MCP because OpenAI and Claude were both inside `apps/agent`,
so there was no boundary to cross. **Izzy has moved the boundary.** In this
design the Claude doing the work is his own Claude Code session — a different
machine, a different process, holding knowledge LoopCom does not have. That is a
real boundary, and MCP is the right tool for it. §16 applies only to the case it
described; it is not a general rule against MCP here.

## 21. ✅ The premise checks out — measured on production 2026-08-27

| | LoopCom's internal agent | This repo / a Claude Code session |
|---|---|---|
| Knowledge docs | **46** (16 hand-written with real content, 30 auto-generated tenant facts) | CLAUDE.md **1.2 MB** + **172** handoffs (4.4 MB) |
| KB articles (`AgentKbArticle`) | **0** | — |
| Memories (`AgentMemory`) | **0** | the memory dir + index |

The two stores that would make the internal agent "know the system" are
**literally empty**. He is right, and the hand-written docs are the only real
knowledge it has. ⚠️ They have grown 6 → 16 since 2026-08-16, so the internal
one IS being filled in — just not far enough to rely on. Escalations are
**10 in 30 days** now (~2.3/week), up from 7.

## 22. ⛔⛔ THE OPERATIONAL TRAP: his laptop becomes production

If tickets route to a local Claude Code session, support works only while his
machine is on, awake, and holding a session. A ticket at 2am reaches nobody, and
the customer has already been told someone is looking.

**So `routing_mode: "local"` MUST carry a timeout that falls back.** Unclaimed
after N minutes → the existing SMS-to-Izzy path, which already works and is
already capped. That single addition to the claim is what makes "temporary"
safe rather than a hole that opens every night.

## 23. ✅ THE PAYOFF: this takes the dangerous half OFF the critical path

Auto-approval, the revert proof (Phase 0), CMA session budgets and vault
credentials all exist for one reason — **nobody is watching.** If Izzy drives
each ticket from his own session, he approves as himself through the
password-gated `applyConfirmedAction` that already works and is already audited.

So for v1: **no auto-approval, no cloud, no revert proof needed.** He gets this
sooner, and the risky machinery waits until it is actually load-bearing.

## 24. ✅ It has a clean exit, and the knowledge is portable

The MCP server is the same one whichever Claude holds the other end — him today,
the cloud CMA agent later, the internal LoopCom agent once its knowledge is real.
**LoopCom's side never changes**, so building the temporary version now does not
cost the permanent one.

⛔ And the knowledge he is relying on is **in this repo** — CLAUDE.md, the 172
handoffs — not locked inside a Claude. A cloud agent can mount the same files
and read the same rules (§9). What is genuinely local-only is his own memory dir
and the live session context. The eventual migration is therefore much smaller
than it feels today.

## 25. v1, concretely

MCP server exposing `list_tickets`, `get_ticket`, `claim_ticket`, `post_answer`,
`get_routing_mode` / `set_routing_mode`. He says *"work ticket Q2FJRK"* in his
own Claude; it does what it already does well (repo + handoffs + SSH + memory);
it posts a technical report and a customer-safe sentence (§18) back onto the
ticket; the OpenAI agent relays the second one to the customer.

Nothing on that list needs the cloud, auto-approval, or a proven revert path.
